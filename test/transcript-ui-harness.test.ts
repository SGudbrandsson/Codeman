/**
 * Transcript view for codex / pi — drives the REAL app.js in a real browser.
 *
 * Covers: the capability-driven view gate (with the pre-/api/harnesses metadata race),
 * the keyboard-accessory toggle, the `thinking` (reasoning) renderer, seq-based recovery
 * dedup, and the codex/pi empty state.
 *
 * Sessions are client-side fakes inserted into app.sessions, and their transcript
 * endpoints are mocked with page.route — no harness binary is spawned.
 *
 * Port: 3264
 *
 * HOME ISOLATION: the real WebServer writes ~/.codeman/state.json (cleanupStaleSessions on
 * start) and several modules resolve ~/.codeman paths at IMPORT time (tmux-manager,
 * route-helpers, push-store…). So HOME, TMUX_TMPDIR, CODEX_HOME and PI_CODING_AGENT_DIR are
 * pointed at temp dirs and TMUX is unset BEFORE the server module is imported — a dynamic
 * import in beforeAll, never a static import here. Every variable is restored in afterAll.
 *
 * Run: npx vitest run test/transcript-ui-harness.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { WebServer } from '../src/web/server.js';

const PORT = 3264;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;

const ENV_KEYS = [
  'HOME',
  'TMUX_TMPDIR',
  'TMUX',
  'CODEX_HOME',
  'PI_CODING_AGENT_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
] as const;
const savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;
let tmpRoot = '';
let tmpHome = '';
let tmpTmux = '';

function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = any;

async function addFakeSession(id: string, mode: string): Promise<void> {
  await page.evaluate(
    ([sid, m]) => {
      (window as W).app.sessions.set(sid, { id: sid, mode: m, name: `fake-${m}`, status: 'idle', workingDir: '/tmp' });
      localStorage.removeItem('transcriptViewMode:' + sid);
    },
    [id, mode]
  );
}

async function mockTranscript(id: string, blocks: unknown[]): Promise<void> {
  await page.route(`**/api/sessions/${id}/transcript**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Total-Blocks': String(blocks.length) },
      body: JSON.stringify(blocks),
    })
  );
}

/**
 * Like mockTranscript, with an X-Transcript-Id header. `responses` are served in order (the last
 * one repeats); `delayMs` holds only the first response, to keep a load() in flight.
 */
async function mockTranscriptWithId(
  id: string,
  responses: Array<{ blocks: unknown[]; transcriptId?: string; total?: number }>,
  opts: { delayMs?: number } = {}
): Promise<{ calls: () => number }> {
  let n = 0;
  await page.unroute(`**/api/sessions/${id}/transcript**`);
  await page.route(`**/api/sessions/${id}/transcript**`, async (route) => {
    const r = responses[Math.min(n, responses.length - 1)];
    const first = n === 0;
    n++;
    if (first && opts.delayMs) await new Promise((res) => setTimeout(res, opts.delayMs));
    const headers: Record<string, string> = { 'X-Total-Blocks': String(r.total ?? r.blocks.length) };
    if (r.transcriptId) headers['X-Transcript-Id'] = r.transcriptId;
    await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(r.blocks) });
  });
  return { calls: () => n };
}

const tb = (seq: number, text: string, role = 'user') => ({
  type: 'text',
  role,
  text,
  timestamp: '2026-01-01T00:00:00Z',
  seq,
});

const domText = () => page.evaluate(() => document.getElementById('transcriptView')?.textContent ?? '');
const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

async function select(id: string): Promise<void> {
  await page.evaluate(async (sid) => {
    const app = (window as W).app;
    app.activeSessionId = null;
    await app.selectSession(sid);
  }, id);
  await page.waitForTimeout(600);
}

const transcriptVisible = () =>
  page.evaluate(() => document.getElementById('transcriptView')?.style.display !== 'none');

beforeAll(async () => {
  // Chromium lives under the REAL home's cache; pin it before HOME moves.
  if (!savedEnv.PLAYWRIGHT_BROWSERS_PATH && savedEnv.HOME) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(savedEnv.HOME, '.cache', 'ms-playwright');
  }
  tmpRoot = mkdtempSync(join(tmpdir(), 'tv-ui-home-'));
  tmpHome = join(tmpRoot, 'home');
  mkdirSync(tmpHome);
  tmpTmux = mkdtempSync(join(tmpdir(), 'tv-ui-tmux-'));
  process.env.HOME = tmpHome;
  process.env.TMUX_TMPDIR = tmpTmux;
  // A tmux client ignores TMUX_TMPDIR while TMUX is set (it is, inside a Codeman session).
  delete process.env.TMUX;
  // The codex / pi adapters honour these over homedir(); never let them see the real dirs.
  process.env.CODEX_HOME = join(tmpRoot, 'codex');
  process.env.PI_CODING_AGENT_DIR = join(tmpRoot, 'pi-agent');
  // os.homedir() only follows $HOME on the main thread of a process (vitest's default forks
  // pool); in a worker thread it keeps the original value. Refuse to start rather than touch
  // the user's real ~/.codeman.
  if (homedir() !== tmpHome) throw new Error(`HOME isolation failed: homedir() is ${homedir()}`);

  const { WebServer: Server } = await import('../src/web/server.js');
  server = new Server(PORT, false, true);
  const storePath = (server as unknown as { store: { filePath: string } }).store.filePath;
  if (!storePath.startsWith(tmpHome + '/')) throw new Error(`state store not isolated: ${storePath}`);
  await server.start();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  await page.route('**/api/sessions/fake-*/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 8000 });
  await page.waitForFunction(() => (window as W).app._harnesses.size > 0, { timeout: 8000 });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  restoreEnv();
  for (const d of [tmpRoot, tmpTmux]) if (d) rmSync(d, { recursive: true, force: true });
}, 30_000);

describe('test isolation', () => {
  it('the server state store lives under the temp HOME, not the real one', () => {
    const storePath = (server as unknown as { store: { filePath: string } }).store.filePath;
    expect(storePath).toBe(join(tmpHome, '.codeman', 'state.json'));
    if (savedEnv.HOME) expect(storePath.startsWith(savedEnv.HOME + '/')).toBe(false);
  });
});

describe('capability-driven transcript gate', () => {
  it('harnessHasTranscript: claude, codex, pi yes; shell, opencode no', async () => {
    const r = await page.evaluate(() => {
      const app = (window as W).app;
      return ['claude', 'codex', 'pi', 'shell', 'opencode', undefined].map((m) => app.harnessHasTranscript(m));
    });
    expect(r).toEqual([true, true, true, false, false, true]);
  });

  it('with caps empty (before /api/harnesses resolves) claude still has the transcript', async () => {
    const r = await page.evaluate(() => {
      const app = (window as W).app;
      const saved = new Map(app._harnesses);
      app._harnesses.clear();
      try {
        return [
          app.harnessHasTranscript('claude'),
          app.harnessHasTranscript(undefined),
          app.harnessHasTranscript('shell'),
        ];
      } finally {
        for (const [k, v] of saved) app._harnesses.set(k, v);
      }
    });
    expect(r).toEqual([true, true, false]);
  });

  for (const mode of ['codex', 'pi']) {
    it(`${mode}: selectSession shows the transcript view and the accessory toggle`, async () => {
      const id = `fake-${mode}-gate`;
      await addFakeSession(id, mode);
      await mockTranscript(id, [
        { type: 'text', role: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00Z', seq: 0 },
      ]);
      await select(id);
      expect(await transcriptVisible()).toBe(true);
      const toggleDisplay = await page.evaluate(
        () => (document.getElementById('accessoryViewModeBtn') as HTMLElement | null)?.style.display
      );
      expect(toggleDisplay).toBe('');
    });
  }

  for (const mode of ['shell', 'opencode']) {
    it(`${mode}: no transcript view and no toggle`, async () => {
      const id = `fake-${mode}-gate`;
      await addFakeSession(id, mode);
      await mockTranscript(id, []);
      await select(id);
      expect(await transcriptVisible()).toBe(false);
      const toggleDisplay = await page.evaluate(
        () => (document.getElementById('accessoryViewModeBtn') as HTMLElement | null)?.style.display
      );
      expect(toggleDisplay).toBe('none');
    });
  }
});

describe('rendering and recovery', () => {
  it('a thinking block renders its text, collapsed by default', async () => {
    const id = 'fake-pi-thinking';
    await addFakeSession(id, 'pi');
    await mockTranscript(id, [
      { type: 'text', role: 'user', text: 'why', timestamp: '2026-01-01T00:00:00Z', seq: 0 },
      { type: 'thinking', text: 'Let me consider the deep question.', timestamp: '2026-01-01T00:00:01Z', seq: 1000 },
    ]);
    await select(id);
    await page.waitForSelector('#transcriptView .tv-reasoning', { timeout: 5000 });
    const r = await page.evaluate(() => {
      const el = document.querySelector('#transcriptView .tv-reasoning') as HTMLElement;
      const preview = el.querySelector('.tv-reasoning-preview') as HTMLElement;
      const body = el.querySelector('.tv-reasoning-body') as HTMLElement;
      // Measure the collapsed state BEFORE clicking: opening the header hides the preview.
      const before = getComputedStyle(body).display;
      const previewVisible = preview.offsetWidth > 0;
      (el.querySelector('.tv-reasoning-header') as HTMLElement).click();
      return {
        preview: preview.textContent,
        previewVisible,
        before,
        after: getComputedStyle(body).display,
        body: body.textContent,
      };
    });
    expect(r.preview).toContain('Let me consider the deep question.');
    expect(r.previewVisible).toBe(true);
    expect(r.before).toBe('none');
    expect(r.after).toBe('block');
    expect(r.body).toBe('Let me consider the deep question.');
  });

  it.each([
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['pi', 'Pi'],
  ])('%s assistant bubbles are labelled "%s"', async (mode, expected) => {
    // The author label was hard-coded to "Claude", so codex and pi replies
    // were attributed to Claude in their own transcript.
    const id = `fake-${mode}-label`;
    await addFakeSession(id, mode);
    await mockTranscript(id, [
      { type: 'text', role: 'user', text: 'hi', timestamp: '2026-01-01T00:00:00Z', seq: 0 },
      { type: 'text', role: 'assistant', text: 'hello back', timestamp: '2026-01-01T00:00:01Z', seq: 1000 },
    ]);
    await select(id);
    await page.waitForSelector('#transcriptView .tv-assistant-dot', { timeout: 5000 });
    const label = await page.evaluate(() =>
      (document.querySelector('#transcriptView .tv-assistant-dot') as HTMLElement).parentElement!.textContent!.trim()
    );
    expect(label).toBe(expected);
  });

  it('two blocks sharing a timestamp both survive the periodic recovery dedup', async () => {
    const id = 'fake-codex-dedup';
    const b1 = { type: 'text', role: 'user', text: 'run it', timestamp: '2026-01-01T00:00:00Z', seq: 0 };
    const b2 = {
      type: 'tool_use',
      id: 'c1',
      name: 'exec',
      input: { input: 'ls' },
      timestamp: '2026-01-01T00:00:05Z',
      seq: 5000,
    };
    const b3 = {
      type: 'tool_result',
      toolUseId: 'c1',
      content: 'a.txt',
      isError: false,
      timestamp: '2026-01-01T00:00:05Z',
      seq: 5001,
    };
    await addFakeSession(id, 'codex');
    await mockTranscript(id, [b1, b2]);
    await select(id);
    await page.unroute(`**/api/sessions/${id}/transcript**`);
    await mockTranscript(id, [b1, b2, b3]);
    const count = await page.evaluate(async (sid) => {
      const TV = (window as W).TranscriptView;
      const state = TV._getState(sid);
      state.viewMode = 'web';
      state._sseBuffer = null;
      TV._periodicSync();
      for (let i = 0; i < 50 && state.blocks.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
      return state.blocks.map((b: { seq: number }) => b.seq);
    }, id);
    expect(count).toEqual([0, 5000, 5001]);
  });

  it('a missed transcript:clear (new file, seq restarts at 0) resyncs instead of dropping the new blocks', async () => {
    const id = 'fake-claude-newfile';
    const old1 = { type: 'text', role: 'user', text: 'old question', timestamp: '2026-01-01T00:00:00Z', seq: 0 };
    const old2 = { type: 'text', role: 'assistant', text: 'old answer', timestamp: '2026-01-01T00:00:01Z', seq: 90000 };
    const new1 = { type: 'text', role: 'user', text: 'new question', timestamp: '2026-01-01T00:10:00Z', seq: 0 };
    const new2 = { type: 'text', role: 'assistant', text: 'new answer', timestamp: '2026-01-01T00:10:01Z', seq: 1000 };
    await addFakeSession(id, 'claude');
    await mockTranscript(id, [old1, old2]);
    await select(id);
    await page.unroute(`**/api/sessions/${id}/transcript**`);
    await mockTranscript(id, [new1, new2]);
    const r = await page.evaluate(async (sid) => {
      const TV = (window as W).TranscriptView;
      const state = TV._getState(sid);
      state.viewMode = 'web';
      state._sseBuffer = null;
      TV._periodicSync();
      for (let i = 0; i < 60 && state.blocks[state.blocks.length - 1]?.text !== 'new answer'; i++) {
        await new Promise((res) => setTimeout(res, 50));
      }
      for (let i = 0; i < 20 && TV._loadFetchInProgress; i++) await new Promise((res) => setTimeout(res, 50));
      return {
        texts: state.blocks.map((b: { text: string }) => b.text),
        dom: document.getElementById('transcriptView')?.textContent ?? '',
      };
    }, id);
    expect(r.texts).toEqual(['new question', 'new answer']);
    expect(r.dom).toContain('new answer');
    expect(r.dom).not.toContain('old answer');
  });

  it('blocks without seq keep the timestamp comparison in the periodic sync', async () => {
    const id = 'fake-claude-noseq';
    const a = { type: 'text', role: 'user', text: 'first', timestamp: '2026-01-01T00:00:00Z' };
    const b = { type: 'text', role: 'assistant', text: 'second', timestamp: '2026-01-01T00:00:05Z' };
    await addFakeSession(id, 'claude');
    await mockTranscript(id, [a]);
    await select(id);
    await page.unroute(`**/api/sessions/${id}/transcript**`);
    await mockTranscript(id, [a, b]);
    const texts = await page.evaluate(async (sid) => {
      const TV = (window as W).TranscriptView;
      const state = TV._getState(sid);
      state.viewMode = 'web';
      state._sseBuffer = null;
      TV._periodicSync();
      for (let i = 0; i < 50 && state.blocks.length < 2; i++) await new Promise((res) => setTimeout(res, 50));
      return state.blocks.map((x: { text: string }) => x.text);
    }, id);
    expect(texts).toEqual(['first', 'second']);
  });

  it('codex with no transcript yet shows the "No transcript yet" empty state', async () => {
    const id = 'fake-codex-empty';
    await addFakeSession(id, 'codex');
    await mockTranscript(id, []);
    await select(id);
    await page.waitForSelector('#transcriptView .tv-empty-cta-title', { timeout: 5000 });
    const title = await page.textContent('#transcriptView .tv-empty-cta-title');
    expect(title).toBe('No transcript yet');
  });

  it('claude keeps its own empty state copy', async () => {
    const id = 'fake-claude-empty';
    await addFakeSession(id, 'claude');
    await mockTranscript(id, []);
    await select(id);
    await page.waitForSelector('#transcriptView .tv-empty-cta-title', { timeout: 5000 });
    const sub = await page.textContent('#transcriptView .tv-empty-cta-sub');
    expect(sub).toBe('Send a message to start a conversation with Claude.');
  });
});

describe('gate follow-ups: empty caps, loadHarnesses re-apply, Claude-only options tabs', () => {
  const toggleDisplay = () =>
    page.evaluate(() => (document.getElementById('accessoryViewModeBtn') as HTMLElement | null)?.style.display);

  it('with caps empty, codex and pi fall back to no transcript (only claude is assumed)', async () => {
    const r = await page.evaluate(() => {
      const app = (window as W).app;
      const saved = new Map(app._harnesses);
      app._harnesses.clear();
      try {
        return [app.harnessHasTranscript('codex'), app.harnessHasTranscript('pi')];
      } finally {
        for (const [k, v] of saved) app._harnesses.set(k, v);
      }
    });
    expect(r).toEqual([false, false]);
  });

  it('a codex session selected before /api/harnesses resolves gets its transcript once loadHarnesses re-applies the gate', async () => {
    const id = 'fake-codex-late-caps';
    await addFakeSession(id, 'codex');
    await mockTranscript(id, [
      { type: 'text', role: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00Z', seq: 0 },
    ]);
    await page.evaluate(() => (window as W).app._harnesses.clear());
    try {
      await select(id);
      expect(await transcriptVisible()).toBe(false);
      expect(await toggleDisplay()).toBe('none');

      await page.evaluate(async () => {
        await (window as W).app.loadHarnesses();
      });
      await page.waitForTimeout(600);
      expect(await transcriptVisible()).toBe(true);
      expect(await toggleDisplay()).toBe('');
    } finally {
      await page.evaluate(async () => {
        const app = (window as W).app;
        if (app._harnesses.size === 0) await app.loadHarnesses();
      });
    }
  });

  for (const [mode, hidden] of [
    ['codex', true],
    ['pi', true],
    ['claude', false],
  ] as const) {
    it(`${mode}: transcript shows, and the session options ${hidden ? 'hide' : 'show'} the Respawn and Ralph tabs`, async () => {
      const id = `fake-${mode}-tabs`;
      await addFakeSession(id, mode);
      await mockTranscript(id, [
        { type: 'text', role: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00Z', seq: 0 },
      ]);
      await select(id);
      expect(await transcriptVisible()).toBe(true);

      const r = await page.evaluate((sid) => {
        const app = (window as W).app;
        // No try/catch: if the options panel fails to open, page.evaluate rejects and the test fails.
        app.openSessionOptions(sid);
        const modal = document.getElementById('sessionOptionsModal');
        const tab = (t: string) => {
          const el = document.querySelector(
            `#sessionOptionsModal .modal-tab-btn[data-tab="${t}"][data-claude-only]`
          ) as HTMLElement | null;
          if (!el) return { inline: 'missing', visible: false };
          return {
            inline: el.style.display,
            visible: getComputedStyle(el).display !== 'none' && el.offsetWidth > 0 && el.offsetHeight > 0,
          };
        };
        const out = {
          opened: !!modal?.classList.contains('active'),
          editingSessionId: app.editingSessionId,
          respawn: tab('respawn'),
          ralph: tab('ralph'),
        };
        app.closeSessionOptions();
        return out;
      }, id);
      expect(r.opened).toBe(true);
      expect(r.editingSessionId).toBe(id);
      const expected = hidden ? { inline: 'none', visible: false } : { inline: '', visible: true };
      expect(r.respawn).toEqual(expected);
      expect(r.ralph).toEqual(expected);
    });
  }
});

describe('transcript identity reconciliation (X-Transcript-Id / SSE transcriptId)', () => {
  /** Wait inside the page until `cond` (a function source over TV/state) holds. */
  const settle = (sid: string) =>
    page.evaluate(async (id) => {
      const TV = (window as W).TranscriptView;
      const state = TV._getState(id);
      for (let i = 0; i < 80 && (TV._loadFetchInProgress || state._sseBuffer); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }, sid);

  const stateOf = (sid: string) =>
    page.evaluate((id) => {
      const state = (window as W).TranscriptView._getState(id);
      return {
        transcriptId: state.transcriptId,
        seqs: state.blocks.map((b: { seq: number }) => b.seq),
        texts: state.blocks.map((b: { text: string }) => b.text),
      };
    }, sid);

  it('a REST load adopts X-Transcript-Id', async () => {
    const id = 'fake-pi-adopt';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'hello')], transcriptId: 'A' }]);
    await select(id);
    expect((await stateOf(id)).transcriptId).toBe('A');
  });

  it('while load() is in flight, SSE blocks are buffered with their transcriptId', async () => {
    const id = 'fake-pi-buffer';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'x')], transcriptId: 'A' }]);
    await select(id);
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'x')], transcriptId: 'A' }], { delayMs: 400 });
    const buffered = await page.evaluate((sid) => {
      const TV = (window as W).TranscriptView;
      TV.load(sid);
      (window as W).app._onTranscriptBlock({
        sessionId: sid,
        block: { seq: 5000, type: 'text', text: 'b' },
        transcriptId: 'A',
      });
      return TV._getState(sid)._sseBuffer;
    }, id);
    expect(buffered).toEqual([{ block: { seq: 5000, type: 'text', text: 'b' }, transcriptId: 'A' }]);
    await settle(id);
  });

  it('visible view: a block with a different transcriptId is dropped and triggers load()', async () => {
    const id = 'fake-pi-visible-newid';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'OLD-visible')], transcriptId: 'A' }]);
    await select(id);
    const m = await mockTranscriptWithId(id, [{ blocks: [tb(0, 'NEW-visible')], transcriptId: 'B' }]);
    await page.evaluate((sid) => {
      (window as W).app._onTranscriptBlock({ sessionId: sid, block: tb2(), transcriptId: 'B' });
      function tb2() {
        return { type: 'text', role: 'user', text: 'SSE-visible', timestamp: '2026-01-01T00:00:00Z', seq: 9000 };
      }
    }, id);
    await page.waitForTimeout(300);
    await settle(id);
    const st = await stateOf(id);
    expect(m.calls()).toBeGreaterThanOrEqual(1);
    expect(st.transcriptId).toBe('B');
    expect(st.texts).toEqual(['NEW-visible']);
    const dom = await domText();
    expect(dom).toContain('NEW-visible');
    expect(dom).not.toContain('OLD-visible');
    expect(dom).not.toContain('SSE-visible');
  });

  it('visible view: replaying blocks from seq 0 after a REST load renders no duplicates', async () => {
    const id = 'fake-pi-replay-visible';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [
      { blocks: [tb(0, 'dup-v-one'), tb(1000, 'dup-v-two', 'assistant')], transcriptId: 'A' },
    ]);
    await select(id);
    await page.evaluate((sid) => {
      const app = (window as W).app;
      const mk = (seq: number, text: string, role: string) => ({
        type: 'text',
        role,
        text,
        timestamp: '2026-01-01T00:00:00Z',
        seq,
      });
      app._onTranscriptBlock({ sessionId: sid, block: mk(0, 'dup-v-one', 'user'), transcriptId: 'A' });
      app._onTranscriptBlock({ sessionId: sid, block: mk(1000, 'dup-v-two', 'assistant'), transcriptId: 'A' });
      app._onTranscriptBlock({ sessionId: sid, block: mk(2000, 'dup-v-three', 'user'), transcriptId: 'A' });
    }, id);
    await page.waitForTimeout(200);
    const st = await stateOf(id);
    expect(st.seqs).toEqual([0, 1000, 2000]);
    const dom = await domText();
    expect(occurrences(dom, 'dup-v-one')).toBe(1);
    expect(occurrences(dom, 'dup-v-two')).toBe(1);
    expect(occurrences(dom, 'dup-v-three')).toBe(1);
  });

  it('inactive view: replay from seq 0 adds no duplicates; a new transcriptId resets the stored blocks', async () => {
    const r = await page.evaluate(() => {
      const app = (window as W).app;
      const TV = (window as W).TranscriptView;
      const sid = 'fake-inactive-state';
      const mk = (seq: number, text: string) => ({
        type: 'text',
        role: 'user',
        text,
        timestamp: '2026-01-01T00:00:00Z',
        seq,
      });
      const state = TV._getState(sid);
      state.blocks = [mk(0, 'a'), mk(1000, 'b')];
      state.transcriptId = 'A';
      app._onTranscriptBlock({ sessionId: sid, block: mk(0, 'a'), transcriptId: 'A' });
      app._onTranscriptBlock({ sessionId: sid, block: mk(1000, 'b'), transcriptId: 'A' });
      app._onTranscriptBlock({ sessionId: sid, block: mk(2000, 'c'), transcriptId: 'A' });
      const afterReplay = state.blocks.map((b: { seq: number }) => b.seq);
      app._onTranscriptBlock({ sessionId: sid, block: mk(0, 'new-a'), transcriptId: 'B' });
      return {
        afterReplay,
        afterNewId: state.blocks.map((b: { text: string }) => b.text),
        id: state.transcriptId,
      };
    });
    expect(r.afterReplay).toEqual([0, 1000, 2000]);
    expect(r.afterNewId).toEqual(['new-a']);
    expect(r.id).toBe('B');
  });

  it('load() with a new transcriptId but identical count, last seq and type clears the DOM (no OLD left)', async () => {
    const id = 'fake-pi-domreuse';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'OLD-q'), tb(1000, 'OLD-a', 'assistant')], transcriptId: 'A' }]);
    await select(id);
    expect(await domText()).toContain('OLD-a');
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'NEW-q'), tb(1000, 'NEW-a', 'assistant')], transcriptId: 'B' }]);
    await page.evaluate((sid) => (window as W).TranscriptView.load(sid), id);
    await settle(id);
    const dom = await domText();
    expect(dom).toContain('NEW-q');
    expect(dom).toContain('NEW-a');
    expect(dom).not.toContain('OLD-q');
    expect(dom).not.toContain('OLD-a');
    expect((await stateOf(id)).transcriptId).toBe('B');
  });

  it('an in-flight load() whose stored transcriptId changes before it resolves discards its response and reloads', async () => {
    const id = 'fake-pi-inflight';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'first-load')], transcriptId: 'A' }]);
    await select(id);
    const m = await mockTranscriptWithId(
      id,
      [
        { blocks: [tb(0, 'STALE-inflight')], transcriptId: 'A' },
        { blocks: [tb(0, 'FRESH-inflight')], transcriptId: 'C' },
      ],
      { delayMs: 400 }
    );
    await page.evaluate((sid) => {
      const TV = (window as W).TranscriptView;
      TV.load(sid);
      // An SSE event (e.g. an inactive-path block or clear bookkeeping) changed the id meanwhile.
      TV._getState(sid).transcriptId = 'C';
    }, id);
    await page.waitForTimeout(700);
    await settle(id);
    const st = await stateOf(id);
    expect(m.calls()).toBe(2);
    expect(st.texts).toEqual(['FRESH-inflight']);
    expect(st.transcriptId).toBe('C');
    expect(await domText()).not.toContain('STALE-inflight');
  });

  it('load() replay, empty snapshot: skips stale-id entries and deduplicates', async () => {
    const id = 'fake-pi-replay-empty';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [{ blocks: [], transcriptId: 'A' }]);
    await select(id);
    await mockTranscriptWithId(id, [{ blocks: [], transcriptId: 'B' }], { delayMs: 300 });
    await page.evaluate((sid) => {
      const app = (window as W).app;
      const TV = (window as W).TranscriptView;
      const mk = (seq: number, text: string) => ({
        type: 'text',
        role: 'user',
        text,
        timestamp: '2026-01-01T00:00:00Z',
        seq,
      });
      TV._getState(sid).transcriptId = 'B';
      TV.load(sid);
      app._onTranscriptBlock({ sessionId: sid, block: mk(0, 'stale-empty'), transcriptId: 'A' });
      app._onTranscriptBlock({ sessionId: sid, block: mk(0, 'fresh-empty'), transcriptId: 'B' });
      app._onTranscriptBlock({ sessionId: sid, block: mk(0, 'fresh-empty'), transcriptId: 'B' });
    }, id);
    await page.waitForTimeout(500);
    await settle(id);
    const st = await stateOf(id);
    expect(st.texts).toEqual(['fresh-empty']);
    const dom = await domText();
    expect(occurrences(dom, 'fresh-empty')).toBe(1);
    expect(dom).not.toContain('stale-empty');
  });

  it('load() replay, non-empty snapshot: appends only entries newer than the current tail with the adopted id', async () => {
    const id = 'fake-pi-replay-nonempty';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'ne-0')], transcriptId: 'B' }]);
    await select(id);
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'ne-0'), tb(1000, 'ne-1')], transcriptId: 'B' }], {
      delayMs: 300,
    });
    await page.evaluate((sid) => {
      const app = (window as W).app;
      const TV = (window as W).TranscriptView;
      const mk = (seq: number, text: string) => ({
        type: 'text',
        role: 'user',
        text,
        timestamp: '2026-01-01T00:00:00Z',
        seq,
      });
      TV.load(sid);
      app._onTranscriptBlock({ sessionId: sid, block: mk(1000, 'ne-1'), transcriptId: 'B' });
      app._onTranscriptBlock({ sessionId: sid, block: mk(2000, 'ne-stale'), transcriptId: 'A' });
      app._onTranscriptBlock({ sessionId: sid, block: mk(2000, 'ne-2'), transcriptId: 'B' });
      app._onTranscriptBlock({ sessionId: sid, block: mk(2000, 'ne-2'), transcriptId: 'B' });
    }, id);
    await page.waitForTimeout(500);
    await settle(id);
    const st = await stateOf(id);
    expect(st.seqs).toEqual([0, 1000, 2000]);
    const dom = await domText();
    expect(occurrences(dom, 'ne-2')).toBe(1);
    expect(occurrences(dom, 'ne-1')).toBe(1);
    expect(dom).not.toContain('ne-stale');
  });

  it('periodic sync with a different X-Transcript-Id reloads instead of appending', async () => {
    const id = 'fake-pi-sync-newid';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'OLD-sync')], transcriptId: 'A' }]);
    await select(id);
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'NEW-sync'), tb(1000, 'NEW-sync-2')], transcriptId: 'B' }]);
    await page.evaluate((sid) => {
      const TV = (window as W).TranscriptView;
      const state = TV._getState(sid);
      state.viewMode = 'web';
      state._sseBuffer = null;
      TV._periodicSync();
    }, id);
    await page.waitForTimeout(400);
    await settle(id);
    const st = await stateOf(id);
    expect(st.transcriptId).toBe('B');
    expect(st.texts).toEqual(['NEW-sync', 'NEW-sync-2']);
    expect(await domText()).not.toContain('OLD-sync');
  });

  it('older-block pagination with a different X-Transcript-Id reloads instead of prepending', async () => {
    const id = 'fake-pi-page-newid';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [
      { blocks: [tb(3000, 'OLD-page-3'), tb(4000, 'OLD-page-4')], transcriptId: 'A', total: 5 },
    ]);
    await select(id);
    const fresh = [0, 1, 2, 3, 4].map((i) => tb(i * 1000, `NEW-page-${i}`));
    await mockTranscriptWithId(id, [{ blocks: fresh, transcriptId: 'B', total: 5 }]);
    await page.evaluate(async (sid) => {
      const TV = (window as W).TranscriptView;
      TV._renderedStartIdx = 0;
      TV._getState(sid).totalServerBlocks = 5;
      await TV._prependBatch();
    }, id);
    await page.waitForTimeout(300);
    await settle(id);
    const st = await stateOf(id);
    expect(st.transcriptId).toBe('B');
    expect(st.texts).toEqual(fresh.map((b) => b.text));
    expect(await domText()).not.toContain('OLD-page');
  });

  it('transcript:clear adopts the event transcriptId before reloading', async () => {
    const id = 'fake-pi-clear-adopt';
    await addFakeSession(id, 'pi');
    await mockTranscriptWithId(id, [{ blocks: [tb(0, 'before-clear')], transcriptId: 'A' }]);
    await select(id);
    const m = await mockTranscriptWithId(id, [{ blocks: [tb(0, 'after-clear')], transcriptId: 'D' }]);
    const idAtClear = await page.evaluate((sid) => {
      const app = (window as W).app;
      app._onTranscriptClear({ sessionId: sid, transcriptId: 'D' });
      return (window as W).TranscriptView._getState(sid).transcriptId;
    }, id);
    expect(idAtClear).toBe('D');
    await page.waitForTimeout(300);
    await settle(id);
    const st = await stateOf(id);
    expect(m.calls()).toBe(1);
    expect(st.texts).toEqual(['after-clear']);
    expect(st.transcriptId).toBe('D');
  });
});

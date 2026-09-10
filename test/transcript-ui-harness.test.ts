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

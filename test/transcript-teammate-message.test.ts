/**
 * Agent Teams peer messages in the transcript view — drives the REAL app.js in a real browser.
 *
 * Claude Code delivers peer messages as a user turn: "Another Claude session sent a message:"
 * + one or more <teammate-message teammate_id=… color=… summary=…> elements (idle
 * notifications carry a JSON body) + a fixed permission notice. The view folds each message
 * into a collapsed row instead of a full "You" bubble.
 *
 * Port: 3272. HOME / TMUX isolation copied from transcript-ui-harness.test.ts.
 *
 * Run: npx vitest run test/transcript-teammate-message.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { WebServer } from '../src/web/server.js';

const PORT = 3272;
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

beforeAll(async () => {
  // Chromium lives under the REAL home's cache; pin it before HOME moves.
  if (!savedEnv.PLAYWRIGHT_BROWSERS_PATH && savedEnv.HOME) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(savedEnv.HOME, '.cache', 'ms-playwright');
  }
  tmpRoot = mkdtempSync(join(tmpdir(), 'tv-tm-home-'));
  tmpHome = join(tmpRoot, 'home');
  mkdirSync(tmpHome);
  tmpTmux = mkdtempSync(join(tmpdir(), 'tv-tm-tmux-'));
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
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 8000 });
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

const NOTICE =
  '\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.';
const IDLE =
  'Another Claude session sent a message:\n<teammate-message teammate_id="server" color="blue">\n' +
  JSON.stringify({
    type: 'idle_notification',
    from: 'server',
    summary: '[to web] Answers',
    result: 'All **done**.\n\nDetails here.',
  }) +
  '\n</teammate-message>\n\n' +
  '<teammate-message teammate_id="web" color="green" summary="Web client done">\nWeb client is done.\nSecond line.\n</teammate-message>' +
  NOTICE;

/** Render a user text block and return what the DOM shows. */
async function render(text: string) {
  return page.evaluate((t) => {
    // TranscriptView is a top-level const in app.js (a classic script), not a window property.
    const tv = (0, eval)('TranscriptView') as W;
    const el = tv._renderTextBlock({ type: 'text', role: 'user', text: t }) as HTMLElement | null;
    if (!el) return null;
    document.body.appendChild(el);
    const rows = [...el.querySelectorAll('.tv-teammate-block')].map((r) => ({
      from: r.querySelector('.tv-teammate-from')?.textContent,
      summary: r.querySelector('.tv-teammate-summary')?.textContent,
      bodyHidden: getComputedStyle(r.querySelector('.tv-compact-body') as Element).display === 'none',
      body: r.querySelector('.tv-compact-body')?.textContent,
    }));
    const hdr = el.querySelector('.tv-compact-header') as HTMLElement | null;
    hdr?.click();
    const openAfterClick = hdr ? getComputedStyle(hdr.nextElementSibling as Element).display !== 'none' : null;
    const out = { className: el.className, text: el.textContent, rows, openAfterClick };
    el.remove();
    return out;
  }, text);
}

describe('teammate messages', () => {
  it('folds each peer message into a collapsed row', async () => {
    const r = await render(IDLE);
    expect(r?.className).toBe('tv-teammate-group');
    expect(r?.rows).toEqual([
      {
        from: 'server (idle)',
        summary: '[to web] Answers',
        bodyHidden: true,
        body: expect.stringContaining('All done.'),
      },
      { from: 'web', summary: 'Web client done', bodyHidden: true, body: expect.stringContaining('Second line.') },
    ]);
    expect(r?.openAfterClick).toBe(true);
  });

  it('drops the preamble, the permission notice and the raw JSON', async () => {
    const r = await render(IDLE);
    expect(r?.text).not.toContain('Another Claude session');
    expect(r?.text).not.toContain('not typed by your user');
    expect(r?.text).not.toContain('idle_notification');
  });

  it('falls back to the first body line when there is no summary', async () => {
    const r = await render(
      'Another Claude session sent a message:\n<teammate-message teammate_id="p3" color="purple">\n\nFirst real line\nmore\n</teammate-message>' +
        NOTICE
    );
    expect(r?.rows[0]).toMatchObject({ from: 'p3', summary: 'First real line' });
  });

  it('leaves user-typed text that quotes a teammate message as a normal bubble', async () => {
    const r = await render('Look at this:\n' + IDLE);
    expect(r?.className).toContain('tv-block--user');
    expect(r?.rows).toEqual([]);
  });
});

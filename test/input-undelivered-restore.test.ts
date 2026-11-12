/**
 * session:inputUndelivered in the real app.js: a message the server could not get into Claude
 * goes back into the compose box (or that session's draft), the optimistic bubble is flagged,
 * and the user is told. Port 3273; HOME/TMUX isolation copied from transcript-teammate-message.
 *
 * Run: npx vitest run test/input-undelivered-restore.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { WebServer } from '../src/web/server.js';

const PORT = 3273;
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'tv-und-home-'));
  tmpHome = join(tmpRoot, 'home');
  mkdirSync(tmpHome);
  tmpTmux = mkdtempSync(join(tmpdir(), 'tv-und-tmux-'));
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

describe('undelivered message restore', () => {
  it('puts the text back in an empty compose box, flags the bubble and shows an error toast', async () => {
    const r = await page.evaluate(async () => {
      const app = (0, eval)('app') as W;
      const ip = (0, eval)('InputPanel') as W;
      const tv = (0, eval)('TranscriptView') as W;
      ip._currentSessionId = 'S1';
      app.activeSessionId = 'S1';
      const ta = ip._getTextarea();
      ta.value = '';
      tv._sessionId = 'S1';
      if (!tv._container) {
        tv._container = document.createElement('div');
        document.body.appendChild(tv._container);
      }
      tv.appendOptimistic('what key is the insurance on?');
      app._onSessionInputUndelivered({ id: 'S1', text: 'what key is the insurance on?' });
      await new Promise((res) => setTimeout(res, 50));
      const bubble = tv._container.querySelector('[data-optimistic="true"]');
      const toasts = [...document.querySelectorAll('.toast, [class*="toast"]')].map((t) => t.textContent).join(' | ');
      return {
        value: ta.value,
        flagged: bubble?.classList.contains('tv-undelivered'),
        note: bubble?.querySelector('.tv-undelivered-note')?.textContent,
        toasts,
      };
    });
    expect(r.value).toBe('what key is the insurance on?');
    expect(r.flagged).toBe(true);
    expect(r.note).toContain('Not delivered');
    expect(r.toasts).toContain("didn't reach Claude");
  });

  it('keeps what the user typed since, and does not duplicate on a second event', async () => {
    const v = await page.evaluate(async () => {
      const app = (0, eval)('app') as W;
      const ip = (0, eval)('InputPanel') as W;
      ip._currentSessionId = 'S1';
      app.activeSessionId = 'S1';
      const ta = ip._getTextarea();
      ta.value = 'new draft';
      app._onSessionInputUndelivered({ id: 'S1', text: 'lost one' });
      app._onSessionInputUndelivered({ id: 'S1', text: 'lost one' }); // second open tab, same event
      return ta.value;
    });
    expect(v).toBe('lost one\n\nnew draft');
  });

  it("saves to another session's draft when that session isn't open", async () => {
    const d = await page.evaluate(async () => {
      const app = (0, eval)('app') as W;
      const ip = (0, eval)('InputPanel') as W;
      ip._currentSessionId = 'S1';
      app.activeSessionId = 'S1';
      ip._drafts.set('S2', { text: '', imagePaths: [] });
      await ip.restoreUndelivered('S2', 'for the other one');
      return { other: ip._drafts.get('S2').text, current: ip._getTextarea().value };
    });
    expect(d.other).toBe('for the other one');
    expect(d.current).not.toContain('for the other one');
  });
});

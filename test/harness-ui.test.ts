/**
 * Harness UI tests (Task 7)
 *
 * Drives the REAL `app.js` in a real browser against a real Codeman server, so
 * the assertions exercise the shipped dispatch rule rather than a local
 * re-implementation of it.
 *
 * Port: 3226 (harness-ui tests)
 *
 * Run: npx vitest run test/harness-ui.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3226;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];

interface AppWindow {
  app: {
    _harnesses: Map<string, unknown>;
    _runMode: string;
    harnessMeta(mode?: string): {
      id: string;
      label: string;
      shortLabel: string;
      available: boolean;
      installHint: string;
      caps: Record<string, boolean>;
    };
    runHarness(mode: string): Promise<void>;
    runClaude(): Promise<void>;
    run(): Promise<void>;
    _applyRunMode(): void;
    setRunMode(mode: string): void;
  };
}

beforeAll(async () => {
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 10_000 });
  // Harness metadata is fetched asynchronously at startup.
  await page.waitForFunction(() => ((window as unknown as AppWindow).app?._harnesses?.size ?? 0) >= 5, {
    timeout: 10_000,
  });
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.stop();
}, 30_000);

describe('harness metadata', () => {
  it('loads all five harnesses from /api/harnesses', async () => {
    const ids = await page.evaluate(() => [...(window as unknown as AppWindow).app._harnesses.keys()]);
    expect(ids.sort()).toEqual(['claude', 'codex', 'opencode', 'pi', 'shell']);
  });

  it('names the harness for the kill dialog', async () => {
    const label = await page.evaluate(() => (window as unknown as AppWindow).app.harnessMeta('codex').label);
    expect(label).toBe('Codex');
  });

  it('falls back safely for an unknown mode', async () => {
    const meta = await page.evaluate(() => {
      try {
        return { ok: true, meta: (window as unknown as AppWindow).app.harnessMeta('nonesuch') };
      } catch (err) {
        return { ok: false, meta: String(err) };
      }
    });
    expect(meta.ok).toBe(true);
  });

  it('does not offer pause for a non-pausable harness', async () => {
    const caps = await page.evaluate(() => ({
      codex: (window as unknown as AppWindow).app.harnessMeta('codex').caps.pausable,
      pi: (window as unknown as AppWindow).app.harnessMeta('pi').caps.pausable,
      claude: (window as unknown as AppWindow).app.harnessMeta('claude').caps.pausable,
    }));
    expect(caps.codex).toBe(false);
    expect(caps.pi).toBe(false);
    expect(caps.claude).toBe(true);
  });
});

describe('run() dispatch', () => {
  it.each(['codex', 'pi', 'opencode'])('routes %s to runHarness, not runClaude', async (mode) => {
    // Before this change run() special-cased only opencode, so codex and pi
    // silently launched Claude.
    const calls = await page.evaluate(async (m) => {
      const app = (window as unknown as AppWindow).app;
      const seen: { harness: string[]; claude: number } = { harness: [], claude: 0 };
      const origHarness = app.runHarness;
      const origClaude = app.runClaude;
      const origMode = app._runMode;
      app.runHarness = async (mode: string) => {
        seen.harness.push(mode);
      };
      app.runClaude = async () => {
        seen.claude += 1;
      };
      app._runMode = m;
      try {
        await app.run();
      } finally {
        app.runHarness = origHarness;
        app.runClaude = origClaude;
        app._runMode = origMode;
      }
      return seen;
    }, mode);
    expect(calls.harness).toEqual([mode]);
    expect(calls.claude).toBe(0);
  });

  it('still routes claude to runClaude', async () => {
    const calls = await page.evaluate(async () => {
      const app = (window as unknown as AppWindow).app;
      const seen: { harness: string[]; claude: number } = { harness: [], claude: 0 };
      const origHarness = app.runHarness;
      const origClaude = app.runClaude;
      const origMode = app._runMode;
      app.runHarness = async (mode: string) => {
        seen.harness.push(mode);
      };
      app.runClaude = async () => {
        seen.claude += 1;
      };
      app._runMode = 'claude';
      try {
        await app.run();
      } finally {
        app.runHarness = origHarness;
        app.runClaude = origClaude;
        app._runMode = origMode;
      }
      return seen;
    });
    expect(calls.claude).toBe(1);
    expect(calls.harness).toEqual([]);
  });
});

describe('run-mode selector markup', () => {
  it('offers codex and pi as run-mode options', async () => {
    const modes = await page.$$eval('#runModeMenu .run-mode-option', (els) =>
      els.map((el) => (el as HTMLElement).dataset.mode)
    );
    expect(modes).toContain('codex');
    expect(modes).toContain('pi');
  });

  it('offers codex and pi welcome buttons', async () => {
    const count = await page.$$eval('.welcome-btn-codex, .welcome-btn-pi', (els) => els.length);
    expect(count).toBe(2);
  });

  it('labels the run button from the harness shortLabel', async () => {
    const label = await page.evaluate(() => {
      const app = (window as unknown as AppWindow).app;
      const orig = app._runMode;
      app._runMode = 'codex';
      app._applyRunMode();
      const text = document.getElementById('runBtnLabel')?.textContent ?? '';
      app._runMode = orig;
      app._applyRunMode();
      return text;
    });
    expect(label).toBe('Run CX');
  });
});

describe('page health', () => {
  it('produced no console errors while loading and driving the UI', () => {
    expect(consoleErrors).toEqual([]);
  });
});

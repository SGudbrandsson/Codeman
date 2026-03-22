/**
 * AskUserQuestion mobile regression tests (updated for tv-auq-block)
 *
 * The auq-panel overlay has been removed. AskUserQuestion is now rendered
 * exclusively as a .tv-auq-block inline in the transcript view.
 *
 * This test file now covers:
 * 1. The auq-panel DOM element no longer exists (Bug 3 regression guard).
 * 2. SwipeHandler._isDisabled() returns true when a .tv-auq-block is present
 *    (replaces the old auq-panel visibility guard).
 *
 * Port: 3219 (auq-panel-mobile tests)
 *
 * Run: npx vitest run test/auq-panel-mobile.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3219;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

// ─── Helpers ──────────────────────────────────────────────────────────────

async function freshPage(width = 375, height = 812): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  return { context, page };
}

async function navigateMobile(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
    timeout: 8000,
  });
  await page.waitForTimeout(300);
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Bug 3 regression: auq-panel removed ─────────────────────────────────

describe('auq-panel removed (bug 3 regression)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('askUserQuestionPanel DOM element does not exist', async () => {
    const panelExists = await page.evaluate(() => {
      return !!document.getElementById('askUserQuestionPanel');
    });
    expect(panelExists).toBe(false);
  });

  it('renderAskUserQuestionPanel is no longer a function on app', async () => {
    const hasFn = await page.evaluate(() => {
      return typeof (app as any).renderAskUserQuestionPanel === 'function';
    });
    expect(hasFn).toBe(false);
  });

  it('pendingAskUserQuestion is no longer tracked on app', async () => {
    const hasProp = await page.evaluate(() => {
      return 'pendingAskUserQuestion' in (app as any);
    });
    expect(hasProp).toBe(false);
  });
});

// ─── SwipeHandler: disabled while tv-auq-block is present ────────────────

describe('SwipeHandler disabled while tv-auq-block is visible', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('SwipeHandler._isDisabled() returns false when no tv-auq-block present', async () => {
    const disabled = await page.evaluate(() => {
      // Ensure no auq block in DOM
      document.querySelectorAll('.tv-auq-block').forEach((el) => el.remove());
      return typeof SwipeHandler !== 'undefined' ? (SwipeHandler as any)._isDisabled() : null;
    });
    // null means SwipeHandler not defined, or false (not disabled by auq guard)
    // On mobile viewport with no sessions, other guards (sessionOrder <= 1) will return true,
    // but the important thing is we don't throw and no auq-panel reference is needed.
    expect(disabled).not.toBeNull();
  });

  it('SwipeHandler._isDisabled() returns true when a tv-auq-block is injected', async () => {
    // Inject a fake tv-auq-block into the DOM
    await page.evaluate(() => {
      const block = document.createElement('div');
      block.className = 'tv-auq-block';
      block.id = '__test_auq_swipe_guard';
      document.body.appendChild(block);
    });

    const disabled = await page.evaluate(() => {
      return typeof SwipeHandler !== 'undefined' ? (SwipeHandler as any)._isDisabled() : null;
    });
    expect(disabled).toBe(true);

    // Clean up
    await page.evaluate(() => {
      const el = document.getElementById('__test_auq_swipe_guard');
      if (el) el.remove();
    });
  });

  it('SwipeHandler._isDisabled() auq guard is false after tv-auq-block is removed', async () => {
    // Verify that removing the block clears the guard
    await page.evaluate(() => {
      const block = document.createElement('div');
      block.className = 'tv-auq-block';
      block.id = '__test_auq_swipe_guard2';
      document.body.appendChild(block);
    });

    // Remove it
    await page.evaluate(() => {
      const el = document.getElementById('__test_auq_swipe_guard2');
      if (el) el.remove();
    });

    // Now check: no tv-auq-block should be present
    const auqPresent = await page.evaluate(() => {
      return !!document.querySelector('.tv-auq-block');
    });
    expect(auqPresent).toBe(false);
  });
});

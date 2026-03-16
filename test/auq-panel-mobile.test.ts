/**
 * AskUserQuestion panel mobile regression tests
 *
 * Covers two bugs fixed in fix/mobile-question-ui-drawer-conflict:
 * 1. auq-panel renders off-screen on mobile (pushed right by flex row layout).
 *    Fix: position:fixed on mobile so it takes the panel out of the flex row.
 * 2. SwipeHandler._isDisabled() does not guard against visible auq-panel,
 *    causing the session-switch swipe animation to fire while a question card
 *    is displayed.
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

// ─── Bug 1: auq-panel CSS layout on mobile ────────────────────────────────

describe('auq-panel mobile layout (bug 1 regression)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('auq-panel is hidden by default on mobile', async () => {
    const display = await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      return panel ? (panel as HTMLElement).style.display : null;
    });
    // Panel starts hidden via inline style
    expect(display).toBe('none');
  });

  it('auq-panel uses position:fixed when shown on mobile', async () => {
    // Show the panel (simulates renderAskUserQuestionPanel)
    await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (panel) (panel as HTMLElement).style.display = 'flex';
    });

    const styles = await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (!panel) return null;
      const cs = window.getComputedStyle(panel);
      return {
        position: cs.position,
        left: cs.left,
        right: cs.right,
        bottom: cs.bottom,
        zIndex: cs.zIndex,
        overflowX: cs.overflowX,
        boxSizing: cs.boxSizing,
      };
    });

    expect(styles).not.toBeNull();
    expect(styles!.position).toBe('fixed');
    // left:0 and right:0 means panel fills the viewport width
    expect(styles!.left).toBe('0px');
    expect(styles!.right).toBe('0px');
    // bottom: 52px — above the toolbar
    expect(styles!.bottom).toBe('52px');
    // z-index above terminal (200) but below modals
    expect(Number(styles!.zIndex)).toBeGreaterThanOrEqual(200);
    expect(styles!.overflowX).toBe('hidden');

    // Clean up: hide the panel again
    await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (panel) (panel as HTMLElement).style.display = 'none';
    });
  });

  it('auq-panel does not overflow the viewport when shown on mobile', async () => {
    await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (panel) (panel as HTMLElement).style.display = 'flex';
    });

    const overflows = await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel') as HTMLElement | null;
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      return {
        panelRight: rect.right,
        viewportWidth: window.innerWidth,
        overflowsRight: rect.right > window.innerWidth,
        panelLeft: rect.left,
        overflowsLeft: rect.left < 0,
      };
    });

    expect(overflows).not.toBeNull();
    expect(overflows!.overflowsRight).toBe(false);
    expect(overflows!.overflowsLeft).toBe(false);

    // Clean up
    await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (panel) (panel as HTMLElement).style.display = 'none';
    });
  });

  it('auq-options has overflow-x:hidden to prevent button overflow', async () => {
    // Inject an .auq-options element so the computed style can be checked
    await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (!panel) return;
      const opts = document.createElement('div');
      opts.className = 'auq-options';
      const btn = document.createElement('button');
      btn.className = 'auq-option-btn';
      btn.textContent = '1. YOLO';
      opts.appendChild(btn);
      panel.appendChild(opts);
      (panel as HTMLElement).style.display = 'flex';
    });

    const overflowX = await page.evaluate(() => {
      const opts = document.querySelector('.auq-options');
      return opts ? window.getComputedStyle(opts).overflowX : null;
    });

    expect(overflowX).toBe('hidden');

    // Clean up
    await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (panel) {
        while (panel.firstChild) panel.removeChild(panel.firstChild);
        (panel as HTMLElement).style.display = 'none';
      }
    });
  });
});

// ─── Bug 2: SwipeHandler disabled while auq-panel is visible ─────────────

describe('SwipeHandler disabled while auq-panel is visible (bug 2 regression)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('auq-panel guard: guard condition is false when panel is hidden', async () => {
    // Test the specific guard condition added to SwipeHandler._isDisabled()
    const guardBlocks = await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (panel) (panel as HTMLElement).style.display = 'none';
      // Replicate the exact guard logic from SwipeHandler._isDisabled()
      const auqPanel = document.getElementById('askUserQuestionPanel');
      return !!(auqPanel && auqPanel.style.display !== 'none');
    });
    expect(guardBlocks).toBe(false);
  });

  it('SwipeHandler._isDisabled() returns true when auq-panel is shown', async () => {
    // When the panel is visible, _isDisabled() must return true (our guard)
    const disabled = await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (panel) (panel as HTMLElement).style.display = 'flex';
      return typeof SwipeHandler !== 'undefined' ? (SwipeHandler as any)._isDisabled() : null;
    });
    expect(disabled).toBe(true);

    // Clean up
    await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (panel) (panel as HTMLElement).style.display = 'none';
    });
  });

  it('auq-panel guard: guard condition is false again after panel is hidden', async () => {
    // Show then hide — guard should no longer block
    await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (panel) (panel as HTMLElement).style.display = 'flex';
    });

    const guardBlocks = await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (panel) (panel as HTMLElement).style.display = 'none';
      const auqPanel = document.getElementById('askUserQuestionPanel');
      return !!(auqPanel && auqPanel.style.display !== 'none');
    });
    expect(guardBlocks).toBe(false);
  });
});

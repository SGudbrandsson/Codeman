/**
 * Regression tests: Board view z-index and sidebar-pinned margin
 *
 * Bug 1 — The .work-item-panel (detail slide-in) and its overlay were rendered
 * behind the .session-drawer (z-index 9000) on desktop. Fixed by raising
 * .work-item-panel-overlay to 9001 and .work-item-panel to 9002.
 *
 * Bug 2 — When the sidebar is pinned on desktop, .board-view did not have a
 * matching margin-right: 300px rule, so the board content stretched behind the
 * sidebar. Fixed by adding the rule inside the @media (min-width: 1024px) block.
 *
 * Run: npx vitest run test/board-view-zindex.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3247;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

async function freshPage(width = 1280, height = 800): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  return { context, page };
}

async function navigateTo(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
    timeout: 8000,
  });
  await page.waitForTimeout(300);
}

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Gap 1: work-item-panel z-index above session-drawer ────────────────────

describe('Board view: .work-item-panel z-index above .session-drawer', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(1280, 800));
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('.work-item-panel z-index is greater than .session-drawer z-index', async () => {
    const zIndices = await page.evaluate(() => {
      const panel = document.createElement('div');
      panel.className = 'work-item-panel';
      document.body.appendChild(panel);

      const drawer = document.createElement('div');
      drawer.className = 'session-drawer';
      document.body.appendChild(drawer);

      const panelZ = parseInt(getComputedStyle(panel).zIndex, 10);
      const drawerZ = parseInt(getComputedStyle(drawer).zIndex, 10);

      document.body.removeChild(panel);
      document.body.removeChild(drawer);

      return { panelZ, drawerZ };
    });

    // Detail panel must stack ABOVE the session drawer
    expect(zIndices.panelZ).toBeGreaterThan(zIndices.drawerZ);
  });

  it('.work-item-panel-overlay z-index is greater than .session-drawer z-index', async () => {
    const zIndices = await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.className = 'work-item-panel-overlay';
      document.body.appendChild(overlay);

      const drawer = document.createElement('div');
      drawer.className = 'session-drawer';
      document.body.appendChild(drawer);

      const overlayZ = parseInt(getComputedStyle(overlay).zIndex, 10);
      const drawerZ = parseInt(getComputedStyle(drawer).zIndex, 10);

      document.body.removeChild(overlay);
      document.body.removeChild(drawer);

      return { overlayZ, drawerZ };
    });

    // The backdrop overlay must also stack above the sidebar
    expect(zIndices.overlayZ).toBeGreaterThan(zIndices.drawerZ);
  });

  it('.work-item-panel z-index is greater than .work-item-panel-overlay z-index', async () => {
    const zIndices = await page.evaluate(() => {
      const panel = document.createElement('div');
      panel.className = 'work-item-panel';
      document.body.appendChild(panel);

      const overlay = document.createElement('div');
      overlay.className = 'work-item-panel-overlay';
      document.body.appendChild(overlay);

      const panelZ = parseInt(getComputedStyle(panel).zIndex, 10);
      const overlayZ = parseInt(getComputedStyle(overlay).zIndex, 10);

      document.body.removeChild(panel);
      document.body.removeChild(overlay);

      return { panelZ, overlayZ };
    });

    // The panel itself must sit above its own backdrop overlay
    expect(zIndices.panelZ).toBeGreaterThan(zIndices.overlayZ);
  });
});

// ─── Gap 2: body.sidebar-pinned .board-view gets margin-right: 300px ────────

describe('Board view: body.sidebar-pinned applies margin-right: 300px on desktop', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    // Desktop viewport — triggers @media (min-width: 1024px)
    ({ context, page } = await freshPage(1280, 800));
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('body.sidebar-pinned .board-view has computed margin-right of 300px', async () => {
    const marginRight = await page.evaluate(() => {
      const boardView = document.createElement('div');
      boardView.className = 'board-view';
      document.body.appendChild(boardView);

      document.body.classList.add('sidebar-pinned');

      const computed = getComputedStyle(boardView).marginRight;

      document.body.classList.remove('sidebar-pinned');
      document.body.removeChild(boardView);

      return computed;
    });

    expect(marginRight).toBe('300px');
  });

  it('body WITHOUT sidebar-pinned has no margin-right on .board-view', async () => {
    const marginRight = await page.evaluate(() => {
      const boardView = document.createElement('div');
      boardView.className = 'board-view';
      document.body.appendChild(boardView);

      // Ensure sidebar-pinned is NOT set
      document.body.classList.remove('sidebar-pinned');

      const computed = getComputedStyle(boardView).marginRight;

      document.body.removeChild(boardView);

      return computed;
    });

    // Without sidebar-pinned, board-view should have no right margin
    expect(marginRight).toBe('0px');
  });
});

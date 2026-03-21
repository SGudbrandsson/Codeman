/**
 * Regression test: Desktop close-session dialog z-index
 *
 * Bug: On desktop, clicking × to close a session activates #closeConfirmModal
 * (.modal class, z-index 1000), which renders BEHIND .session-drawer (z-index 9000)
 * and its overlay (z-index 8999), making the dialog invisible and unclickable.
 *
 * Fix: Raise .modal z-index above 9000 (to 10000) so it paints above the drawer.
 *
 * Run: npx vitest run test/close-session-dialog-zindex.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3214;
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

describe('Desktop close-session dialog: z-index above session drawer', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    // Desktop viewport: width >= 1024 so getDeviceType() !== 'mobile'
    ({ context, page } = await freshPage(1280, 800));
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('#closeConfirmModal element exists in the DOM', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('closeConfirmModal'));
    expect(exists).toBe(true);
  });

  it('.modal z-index is greater than .session-drawer z-index', async () => {
    const zIndices = await page.evaluate(() => {
      // Create a temporary .modal element (not active) to read its computed z-index
      const modal = document.createElement('div');
      modal.className = 'modal';
      document.body.appendChild(modal);

      const drawer = document.createElement('div');
      drawer.className = 'session-drawer';
      document.body.appendChild(drawer);

      const modalZ = parseInt(getComputedStyle(modal).zIndex, 10);
      const drawerZ = parseInt(getComputedStyle(drawer).zIndex, 10);

      document.body.removeChild(modal);
      document.body.removeChild(drawer);

      return { modalZ, drawerZ };
    });

    // The modal must stack ABOVE the session drawer
    expect(zIndices.modalZ).toBeGreaterThan(zIndices.drawerZ);
  });

  it('.modal z-index is greater than .session-drawer-overlay z-index', async () => {
    const zIndices = await page.evaluate(() => {
      const modal = document.createElement('div');
      modal.className = 'modal';
      document.body.appendChild(modal);

      const overlay = document.createElement('div');
      overlay.className = 'session-drawer-overlay';
      document.body.appendChild(overlay);

      const modalZ = parseInt(getComputedStyle(modal).zIndex, 10);
      const overlayZ = parseInt(getComputedStyle(overlay).zIndex, 10);

      document.body.removeChild(modal);
      document.body.removeChild(overlay);

      return { modalZ, overlayZ };
    });

    // The modal must stack ABOVE the blur overlay
    expect(zIndices.modalZ).toBeGreaterThan(zIndices.overlayZ);
  });

  it('#closeConfirmModal computed z-index is greater than .session-drawer z-index', async () => {
    const zIndices = await page.evaluate(() => {
      const modal = document.getElementById('closeConfirmModal');
      const drawer = document.createElement('div');
      drawer.className = 'session-drawer';
      document.body.appendChild(drawer);

      // #closeConfirmModal is display:none when inactive — read via class .modal
      // We temporarily make it visible to get computed style
      const prevDisplay = modal?.style.display ?? '';
      if (modal) modal.style.display = 'flex';

      const modalZ = modal ? parseInt(getComputedStyle(modal).zIndex, 10) : NaN;
      const drawerZ = parseInt(getComputedStyle(drawer).zIndex, 10);

      if (modal) modal.style.display = prevDisplay;
      document.body.removeChild(drawer);

      return { modalZ, drawerZ };
    });

    expect(zIndices.modalZ).toBeGreaterThan(zIndices.drawerZ);
  });

  it('session drawer and overlay are dismissed when requestCloseSession is called', async () => {
    // Regression: clicking × in the open session drawer must close the drawer before
    // showing the confirmation modal — so the two are never visible simultaneously.
    const result = await page.evaluate(() => {
      const drawer = document.getElementById('sessionDrawer');
      const overlay = document.getElementById('sessionDrawerOverlay');
      if (!drawer) return { drawerOpen: null, overlayOpen: null, modalActive: null };

      // Simulate the drawer being open
      drawer.classList.add('open');
      if (overlay) overlay.classList.add('open');

      // Inject a minimal fake session so requestCloseSession proceeds past the guard
      const fakeId = '__test_close_dialog__';
      window.app.sessions.set(fakeId, {
        id: fakeId,
        name: 'test',
        mode: 'claude',
        worktreeBranch: null,
        worktreeOriginId: null,
      } as any);

      window.app.requestCloseSession(fakeId);

      const drawerOpen = drawer.classList.contains('open');
      const overlayOpen = overlay ? overlay.classList.contains('open') : false;
      const modalActive = document.getElementById('closeConfirmModal')?.classList.contains('active') ?? false;

      // Clean up
      window.app?.cancelCloseSession?.();
      window.app.sessions.delete(fakeId);

      return { drawerOpen, overlayOpen, modalActive };
    });

    // Drawer and overlay must be closed before the modal appears
    expect(result.drawerOpen).toBe(false);
    expect(result.overlayOpen).toBe(false);
    // Modal must have been shown
    expect(result.modalActive).toBe(true);
  });
});

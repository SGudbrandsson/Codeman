// Port 3208 - Plus button / file upload tests for mobile compose panel.
//
// Covers: fix/mobile-plus-button-upload
//   - Plus button works when keyboard is hidden (keyboard-closed path)
//   - Plus button works when keyboard is visible (keyboard-open regression guard)
//   - Tapping an action sheet option triggers the correct file input click
//   - Tapping the backdrop closes the action sheet

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Page, BrowserContext } from 'playwright';
import { PORTS, WAIT } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, getBrowser, closeAllBrowsers } from './helpers/browser.js';
import { showKeyboardViaMock, hideKeyboardViaMock } from './helpers/keyboard-sim.js';

import { REPRESENTATIVE_DEVICES } from './devices.js';
import type { WebServer } from '../src/web/server.js';

const PORT = PORTS.MOBILE_COMPOSE_UPLOAD;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Force KeyboardHandler.keyboardVisible to the given value via page.evaluate.
 *  KeyboardHandler is a `const` in app.js — not on window — so we use the
 *  string form of evaluate which runs in the page's global lexical scope. */
async function setKeyboardVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate(`
    if (typeof KeyboardHandler !== 'undefined') {
      KeyboardHandler.keyboardVisible = ${visible};
    }
  `);
}

/** Returns true when the action sheet is currently visible (display != 'none'). */
async function isActionSheetVisible(page: Page): Promise<boolean> {
  return page.evaluate(`
    (() => {
      const el = document.getElementById('composeActionSheet');
      if (!el) return false;
      return el.style.display !== 'none';
    })()
  `);
}

/** Wait until the action sheet becomes visible, with a short poll loop. */
async function waitForActionSheet(page: Page, timeout = 2000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isActionSheetVisible(page)) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

/** Dispatch a touchstart + touchend on an element via synthetic events.
 *  Used to simulate plus-button taps in a way that exercises the
 *  mobileInputPanel touchstart listener (the fix target). */
async function syntheticTouchButton(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error(`Element not found: ${sel}`);
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
    el.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [touch],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      })
    );
    el.dispatchEvent(
      new TouchEvent('touchend', {
        touches: [],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      })
    );
  }, selector);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Mobile compose plus button upload', () => {
  let server: WebServer;
  const device = REPRESENTATIVE_DEVICES['standard-phone']; // iPhone 14 Pro equivalent

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await stopTestServer(server);
    await closeAllBrowsers();
  });

  describe('Action sheet appearance', () => {
    let page: Page;
    let context: BrowserContext;

    beforeEach(async () => {
      const result = await createDevicePage(device, BASE_URL, 'chromium');
      page = result.page;
      context = result.context;
      // Ensure action sheet starts hidden
      await page.evaluate(`
        const sheet = document.getElementById('composeActionSheet');
        const bd = document.getElementById('composeActionBackdrop');
        if (sheet) sheet.style.display = 'none';
        if (bd) bd.style.display = 'none';
      `);
    });

    afterEach(async () => {
      await context.close();
    });

    it('opens action sheet when keyboard is HIDDEN (the fixed bug path)', async () => {
      // Explicitly mark keyboard as not visible — this is the broken state before the fix
      await setKeyboardVisible(page, false);

      // Tap the plus button using synthetic touch (exercises the touchstart handler)
      await syntheticTouchButton(page, '#composePlusBtn');

      const visible = await waitForActionSheet(page);
      expect(visible).toBe(true);
    });

    it('opens action sheet when keyboard is VISIBLE (regression guard)', async () => {
      // Mark keyboard as visible — this is the path that worked before the fix
      await setKeyboardVisible(page, true);

      await syntheticTouchButton(page, '#composePlusBtn');

      const visible = await waitForActionSheet(page);
      expect(visible).toBe(true);
    });

    it('closes action sheet when backdrop is tapped', async () => {
      // Open the sheet first
      await setKeyboardVisible(page, false);
      await syntheticTouchButton(page, '#composePlusBtn');
      await waitForActionSheet(page);

      // Tap the backdrop to dismiss
      await page.evaluate(`
        const bd = document.getElementById('composeActionBackdrop');
        if (bd) bd.click();
      `);

      await page.waitForTimeout(100);
      const visible = await isActionSheetVisible(page);
      expect(visible).toBe(false);
    });
  });

  describe('Action sheet option triggers file input', () => {
    let page: Page;
    let context: BrowserContext;

    beforeEach(async () => {
      const result = await createDevicePage(device, BASE_URL, 'chromium');
      page = result.page;
      context = result.context;
      // Ensure action sheet starts hidden
      await page.evaluate(`
        const sheet = document.getElementById('composeActionSheet');
        const bd = document.getElementById('composeActionBackdrop');
        if (sheet) sheet.style.display = 'none';
        if (bd) bd.style.display = 'none';
      `);
    });

    afterEach(async () => {
      await context.close();
    });

    it('gallery option clicks #composeFileGallery input', async () => {
      // Track whether the file input receives a click
      await page.evaluate(`
        window.__galleryClicked = false;
        const input = document.getElementById('composeFileGallery');
        if (input) input.addEventListener('click', () => { window.__galleryClicked = true; }, true);
      `);

      // Open action sheet (keyboard hidden path — the bug scenario)
      await setKeyboardVisible(page, false);
      await syntheticTouchButton(page, '#composePlusBtn');
      await waitForActionSheet(page);

      // Click the gallery action
      await page.evaluate(`
        const sheet = document.getElementById('composeActionSheet');
        const galleryBtn = sheet ? [...sheet.querySelectorAll('button')].find(b => b.textContent?.includes('Gallery') || b.textContent?.includes('Photo Library')) : null;
        if (galleryBtn) galleryBtn.click();
      `);

      await page.waitForTimeout(200);
      const clicked = await page.evaluate(`window.__galleryClicked`);
      expect(clicked).toBe(true);
    });

    it('attach file option clicks #composeFileAny input', async () => {
      await page.evaluate(`
        window.__fileAnyClicked = false;
        const input = document.getElementById('composeFileAny');
        if (input) input.addEventListener('click', () => { window.__fileAnyClicked = true; }, true);
      `);

      await setKeyboardVisible(page, false);
      await syntheticTouchButton(page, '#composePlusBtn');
      await waitForActionSheet(page);

      // Click the "Attach File" action
      await page.evaluate(`
        const sheet = document.getElementById('composeActionSheet');
        const fileBtn = sheet ? [...sheet.querySelectorAll('button')].find(b => b.textContent?.includes('File') || b.textContent?.includes('Attach')) : null;
        if (fileBtn) fileBtn.click();
      `);

      await page.waitForTimeout(200);
      const clicked = await page.evaluate(`window.__fileAnyClicked`);
      expect(clicked).toBe(true);
    });
  });
});

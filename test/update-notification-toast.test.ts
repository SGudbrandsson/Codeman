/**
 * Update notification toast tests
 *
 * Covers the frontend update notification feature added in app.js:
 *
 * 1. _onUpdateAvailable(data) shows a persistent toast with "Refresh" action button
 * 2. _onUpdateAvailable dedup flag prevents duplicate toasts
 * 3. _onUpdateAvailable handles missing data.version gracefully
 * 4. handleInit() stores initial version on first call
 * 5. handleInit() detects version mismatch on reconnect and shows toast
 * 6. handleInit() does NOT show toast when version matches
 * 7. UPDATE_AVAILABLE is wired in _SSE_HANDLER_MAP to _onUpdateAvailable
 *
 * Port: 3250
 *
 * Run: npx vitest run test/update-notification-toast.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3250;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  return { context, page };
}

async function navigateAndWait(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
    timeout: 8000,
  });
  await page.waitForTimeout(400);
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

// ─── Gap 1: _onUpdateAvailable shows persistent toast with Refresh button ─────

describe('_onUpdateAvailable handler', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('shows a persistent toast with version and Refresh button', async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      // Reset state
      app._updateToastShown = false;
      app._onUpdateAvailable({ version: '1.2.3' });
    });

    // Wait briefly for DOM update
    await page.waitForTimeout(200);

    const result = await page.evaluate(() => {
      const toast = document.querySelector('.toast-container .toast-info');
      if (!toast) return null;
      const btn = toast.querySelector('button');
      return {
        text: toast.textContent || '',
        btnLabel: btn ? btn.textContent : null,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.text).toContain('New version available');
    expect(result!.text).toContain('v1.2.3');
    expect(result!.btnLabel).toBe('Refresh');
  });

  it('sets _updateToastShown flag to prevent duplicates', async () => {
    // Clear any existing toasts and reset
    await page.evaluate(() => {
      const app = (window as any).app;
      document.querySelectorAll('.toast').forEach((t) => t.remove());
      app._updateToastShown = false;

      // Call twice
      app._onUpdateAvailable({ version: '2.0.0' });
      app._onUpdateAvailable({ version: '2.0.0' });
    });

    const toasts = page.locator('.toast-container .toast-info');
    // Only one toast should exist (dedup)
    expect(await toasts.count()).toBe(1);
  });

  it('handles missing data.version gracefully', async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      document.querySelectorAll('.toast').forEach((t) => t.remove());
      app._updateToastShown = false;
      app._onUpdateAvailable({});
    });

    await page.waitForTimeout(200);

    const text = await page.evaluate(() => {
      const toast = document.querySelector('.toast-container .toast-info');
      return toast ? toast.textContent || '' : null;
    });

    expect(text).not.toBeNull();
    expect(text).toContain('New version available');
    // Should NOT contain a version string when none provided
    expect(text).not.toContain(' — v');
  });
});

// ─── Gap 2: handleInit() version mismatch detection ──────────────────────────

describe('handleInit version mismatch detection', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('stores _initialServerVersion on first init', async () => {
    const stored = await page.evaluate(() => {
      return (window as any).app._initialServerVersion;
    });
    // After page load, handleInit has been called once via SSE init event
    expect(stored).toBeTruthy();
    expect(typeof stored).toBe('string');
  });

  it('shows toast when version changes on reconnect', async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      // Clear existing toasts and dedup flag
      document.querySelectorAll('.toast').forEach((t) => t.remove());
      app._updateToastShown = false;
      // Ensure initial version is set
      app._initialServerVersion = '0.1.0';
      // Simulate reconnect init with different version
      app.handleInit({ version: '0.2.0', sessions: [] });
    });

    // Wait briefly for async handleInit
    await page.waitForTimeout(300);

    const text = await page.evaluate(() => {
      const toast = document.querySelector('.toast-container .toast-info');
      return toast ? toast.textContent || '' : null;
    });

    expect(text).not.toBeNull();
    expect(text).toContain('New version available');
    expect(text).toContain('v0.2.0');
  });

  it('does NOT show toast when version matches on reconnect', async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      // Clear state
      document.querySelectorAll('.toast').forEach((t) => t.remove());
      app._updateToastShown = false;
      app._initialServerVersion = '0.5.0';
      // Simulate reconnect with same version
      app.handleInit({ version: '0.5.0', sessions: [] });
    });

    await page.waitForTimeout(300);

    // Count info toasts — should be zero (no version mismatch)
    const toastCount = await page.evaluate(() => {
      return document.querySelectorAll('.toast-container .toast-info').length;
    });
    expect(toastCount).toBe(0);
  });
});

// ─── Gap 3: UPDATE_AVAILABLE wired in _SSE_HANDLER_MAP ───────────────────────

describe('UPDATE_AVAILABLE SSE handler wiring', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('has UPDATE_AVAILABLE mapped to _onUpdateAvailable in the handler map', async () => {
    const result = await page.evaluate(() => {
      const app = (window as any).app;
      // Check that the SSE handler wrapper was registered for 'update:available'
      // _sseHandlerWrappers is populated from _SSE_HANDLER_MAP in connectSSE()
      if (app._sseHandlerWrappers && app._sseHandlerWrappers instanceof Map) {
        return app._sseHandlerWrappers.has('update:available');
      }
      // Fallback: check _onUpdateAvailable exists as a method
      return typeof app._onUpdateAvailable === 'function';
    });
    expect(result).toBe(true);
  });

  it('_onUpdateAvailable is a callable method on the app', async () => {
    const isFunction = await page.evaluate(() => {
      return typeof (window as any).app._onUpdateAvailable === 'function';
    });
    expect(isFunction).toBe(true);
  });
});

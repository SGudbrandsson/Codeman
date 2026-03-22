/**
 * Sidebar UX regression tests
 *
 * Covers two bugs:
 * 1. Mobile: pressing × on a session row shows the close confirmation sheet
 *    and does NOT displace the drawer (regression for position/overflow override).
 * 2. Click-outside-to-close for the session drawer overlay and mcp-type panels.
 *
 * Port: 3213 (sidebar-ux tests)
 *
 * Run: npx vitest run test/sidebar-ux.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3213;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

// ─── Helpers ──────────────────────────────────────────────────────────────

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
  // Brief pause for async SSE / polling data
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

// ─── Bug 1: Session drawer close-sheet does not displace the drawer ────────

describe('Session drawer: close sheet (bug 1 regression)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    // Mobile viewport: innerWidth < 430 → getDeviceType() === 'mobile'
    ({ context, page } = await freshPage(400, 800));
    await navigateTo(page);
  });

  afterAll(async () => {
    // Clean up the test session so it doesn't leak into ~/.codeman/state.json
    const sessionId = (page as any)._testSessionId;
    if (sessionId) {
      await page
        .evaluate(async (id: string) => {
          await fetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
        }, sessionId)
        .catch(() => {});
    }
    await context?.close();
  });

  it('renders a session row in the drawer after creating a session', async () => {
    // Create a session so the drawer has at least one row to act on.
    // The session is cleaned up in afterAll to avoid leaking into ~/.codeman/state.json.
    const sessionId: string = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'sidebar-ux-test' }),
      });
      const data = await res.json();
      return data.id ?? data.session?.id ?? '';
    });
    // Store for cleanup
    (page as any)._testSessionId = sessionId;

    // Open the drawer
    await page.evaluate(() => (window as any).SessionDrawer.open());
    await page.waitForSelector('#sessionDrawer.open', { timeout: 3000 });

    const rowCount = await page.locator('.drawer-session-row').count();
    expect(rowCount).toBeGreaterThan(0);
  });

  it('clicking × shows the close confirmation sheet', async () => {
    // Drawer should already be open from the previous test
    const closeBtn = page.locator('.drawer-session-close').first();
    await closeBtn.click();

    // Sheet should appear inside the drawer
    await page.waitForSelector('.drawer-close-sheet', { timeout: 3000 });
    const sheetVisible = await page.locator('.drawer-close-sheet').isVisible();
    expect(sheetVisible).toBe(true);
  });

  it('drawer keeps position:fixed after × click (no style override)', async () => {
    // position: fixed must be preserved — the bug set it to 'relative'
    const drawerPosition = await page.evaluate(() => {
      const drawer = document.getElementById('sessionDrawer');
      return drawer ? getComputedStyle(drawer).position : null;
    });
    expect(drawerPosition).toBe('fixed');
  });

  it('drawer inline style.position is not overridden to relative', async () => {
    const inlinePosition = await page.evaluate(() => {
      return (document.getElementById('sessionDrawer') as HTMLElement | null)?.style.position ?? '';
    });
    // Should be empty string (not overridden) — never 'relative'
    expect(inlinePosition).not.toBe('relative');
  });

  it('drawer inline style.overflow is not overridden to hidden', async () => {
    const inlineOverflow = await page.evaluate(() => {
      return (document.getElementById('sessionDrawer') as HTMLElement | null)?.style.overflow ?? '';
    });
    expect(inlineOverflow).not.toBe('hidden');
  });

  it('overlay is still open while sheet is displayed (screen not prematurely closed)', async () => {
    const overlayOpen = await page.evaluate(
      () => document.getElementById('sessionDrawerOverlay')?.classList.contains('open') ?? false
    );
    expect(overlayOpen).toBe(true);
  });

  it('Cancel button dismisses the sheet without closing the drawer', async () => {
    const cancelBtn = page.locator('.close-sheet-cancel');
    await cancelBtn.click();

    await page.waitForTimeout(200);

    const sheetGone = await page.locator('.drawer-close-sheet').count();
    expect(sheetGone).toBe(0);

    // Drawer must still be open
    const drawerOpen = await page.evaluate(
      () => document.getElementById('sessionDrawer')?.classList.contains('open') ?? false
    );
    expect(drawerOpen).toBe(true);
  });
});

// ─── Bug 2: Click-outside-to-close (session drawer) ──────────────────────

describe('Session drawer: click-outside closes it (bug 2)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('session drawer overlay is shown when drawer opens', async () => {
    await page.evaluate(() => (window as any).SessionDrawer.open());
    await page.waitForSelector('#sessionDrawer.open', { timeout: 3000 });

    const overlayOpen = await page.evaluate(
      () => document.getElementById('sessionDrawerOverlay')?.classList.contains('open') ?? false
    );
    expect(overlayOpen).toBe(true);
  });

  it('clicking the overlay closes the session drawer', async () => {
    await page.click('#sessionDrawerOverlay');
    await page.waitForTimeout(400); // allow CSS transition

    const drawerOpen = await page.evaluate(
      () => document.getElementById('sessionDrawer')?.classList.contains('open') ?? false
    );
    expect(drawerOpen).toBe(false);

    const overlayOpen = await page.evaluate(
      () => document.getElementById('sessionDrawerOverlay')?.classList.contains('open') ?? false
    );
    expect(overlayOpen).toBe(false);
  });
});

// ─── Bug 2: Click-outside-to-close (mcp-type panels) ─────────────────────

describe('MCP-type panels: panelBackdrop closes panels (bug 2)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('#panelBackdrop element exists in the DOM', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('panelBackdrop'));
    expect(exists).toBe(true);
  });

  it('McpPanel.open() shows #panelBackdrop', async () => {
    // PanelBackdrop.show() is synchronous so no delay needed before asserting
    await page.evaluate(() => (window as any).McpPanel.open('test-session'));

    const backdropOpen = await page.evaluate(
      () => document.getElementById('panelBackdrop')?.classList.contains('open') ?? false
    );
    expect(backdropOpen).toBe(true);
  });

  it('McpPanel is open before clicking backdrop', async () => {
    const panelOpen = await page.evaluate(
      () => document.getElementById('mcpPanel')?.classList.contains('open') ?? false
    );
    expect(panelOpen).toBe(true);
  });

  it('clicking #panelBackdrop closes McpPanel and hides the backdrop', async () => {
    await page.click('#panelBackdrop');
    await page.waitForTimeout(400); // allow CSS transition + setTimeout(260)

    const panelOpen = await page.evaluate(
      () => document.getElementById('mcpPanel')?.classList.contains('open') ?? false
    );
    expect(panelOpen).toBe(false);

    const backdropOpen = await page.evaluate(
      () => document.getElementById('panelBackdrop')?.classList.contains('open') ?? false
    );
    expect(backdropOpen).toBe(false);
  });

  it('PluginsPanel.open() shows #panelBackdrop', async () => {
    await page.evaluate(() => (window as any).PluginsPanel.open('test-session'));

    const backdropOpen = await page.evaluate(
      () => document.getElementById('panelBackdrop')?.classList.contains('open') ?? false
    );
    expect(backdropOpen).toBe(true);
  });

  it('clicking #panelBackdrop closes PluginsPanel', async () => {
    await page.click('#panelBackdrop');
    await page.waitForTimeout(400);

    const panelOpen = await page.evaluate(
      () => document.getElementById('pluginsPanel')?.classList.contains('open') ?? false
    );
    expect(panelOpen).toBe(false);
  });

  it('ContextBar.open() shows #panelBackdrop', async () => {
    await page.evaluate(() => (window as any).ContextBar.open('test-session'));

    const backdropOpen = await page.evaluate(
      () => document.getElementById('panelBackdrop')?.classList.contains('open') ?? false
    );
    expect(backdropOpen).toBe(true);
  });

  it('clicking #panelBackdrop closes ContextBar', async () => {
    await page.click('#panelBackdrop');
    await page.waitForTimeout(400);

    const panelOpen = await page.evaluate(
      () => document.getElementById('contextPanel')?.classList.contains('open') ?? false
    );
    expect(panelOpen).toBe(false);

    const backdropOpen = await page.evaluate(
      () => document.getElementById('panelBackdrop')?.classList.contains('open') ?? false
    );
    expect(backdropOpen).toBe(false);
  });

  it('McpPanel.close() removes .open from #panelBackdrop', async () => {
    // Open then close programmatically (no click)
    await page.evaluate(() => (window as any).McpPanel.open('test-session'));
    await page.waitForTimeout(100);
    await page.evaluate(() => (window as any).McpPanel.close());
    await page.waitForTimeout(100);

    const backdropOpen = await page.evaluate(
      () => document.getElementById('panelBackdrop')?.classList.contains('open') ?? false
    );
    expect(backdropOpen).toBe(false);
  });

  it('opening panel A while panel B is open keeps backdrop visible (A-closes-B scenario)', async () => {
    // Open PluginsPanel first
    await page.evaluate(() => (window as any).PluginsPanel.open('test-session'));

    // Now open McpPanel — its open() closes PluginsPanel internally, then shows backdrop
    await page.evaluate(() => (window as any).McpPanel.open('test-session'));

    // Net result: backdrop must still be open (McpPanel is now open)
    const backdropOpen = await page.evaluate(
      () => document.getElementById('panelBackdrop')?.classList.contains('open') ?? false
    );
    expect(backdropOpen).toBe(true);

    // McpPanel should be open, PluginsPanel should be closed
    const mcpOpen = await page.evaluate(() => document.getElementById('mcpPanel')?.classList.contains('open') ?? false);
    expect(mcpOpen).toBe(true);

    const pluginsOpen = await page.evaluate(
      () => document.getElementById('pluginsPanel')?.classList.contains('open') ?? false
    );
    expect(pluginsOpen).toBe(false);

    // Clean up
    await page.evaluate(() => (window as any).McpPanel.close());
  });
});

// ─── Bug 3: Mobile sidebar auto-focus suppression ─────────────────────────
//
// SessionDrawer is a script-scope const in app.js (declared with `const` at
// the top level of a non-module script). Top-level `const` does NOT become a
// property of `window`, so `window.SessionDrawer` is undefined. However, the
// binding IS in the page's global declarative environment and is reachable by
// passing a string expression to page.evaluate(), which the browser evaluates
// in the page's own script scope.

describe('Session drawer: search input focus on open (mobile vs desktop)', () => {
  it('mobile viewport: search input is NOT focused after drawer opens', async () => {
    // Mobile viewport (≤430px) → MobileDetection.getDeviceType() returns 'mobile'
    const { context, page } = await freshPage(400, 800);
    await navigateTo(page);

    // Pass a string so Playwright evaluates it in the page scope where
    // SessionDrawer (a script-scope const) is accessible.
    await page.evaluate('SessionDrawer.open()');
    await page.waitForSelector('#sessionDrawer.open', { timeout: 3000 });

    // Wait longer than the 350ms focus timer to let it fire if it were going to
    await page.waitForTimeout(500);

    const activeIsSearch = await page.evaluate(() => {
      const searchEl = document.getElementById('sessionDrawerSearch');
      return document.activeElement === searchEl;
    });
    expect(activeIsSearch).toBe(false);

    // Clean up
    await page.evaluate('SessionDrawer.close()');
    await context.close();
  });

  it('desktop viewport: search input IS focused after drawer opens', async () => {
    // Desktop viewport (≥1024px) → MobileDetection.getDeviceType() returns 'desktop'
    const { context, page } = await freshPage(1280, 800);
    await navigateTo(page);

    // Pass a string so Playwright evaluates it in the page scope where
    // SessionDrawer (a script-scope const) is accessible.
    await page.evaluate('SessionDrawer.open()');
    await page.waitForSelector('#sessionDrawer.open', { timeout: 3000 });

    // Wait for the 350ms focus timer to fire
    await page.waitForTimeout(500);

    const activeIsSearch = await page.evaluate(() => {
      const searchEl = document.getElementById('sessionDrawerSearch');
      return document.activeElement === searchEl;
    });
    expect(activeIsSearch).toBe(true);

    // Clean up
    await page.evaluate('SessionDrawer.close()');
    await context.close();
  });
});

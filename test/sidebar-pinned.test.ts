/**
 * Persistent desktop sidebar tests — pinned mode
 *
 * Covers the seven test gaps identified for the feat/persistent-desktop-sidebar feature:
 *
 * G1 — Pin-state restore on page load
 * G2 — _openPinned() renders session list
 * G3 — Session click does not close sidebar when pinned
 * G4 — close() is a no-op when pinned
 * G5 — Unpinning via pin button closes drawer
 * G6 — CSS layout: .main gets margin-right: 300px when sidebar-pinned
 * G7 — Mobile isolation: <1024px viewport does NOT auto-open pinned sidebar
 *
 * Port: 3214 (sidebar-pinned tests)
 *
 * Run: npx vitest run test/sidebar-pinned.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3214;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

// ─── Helpers ──────────────────────────────────────────────────────────────

async function freshPage(width = 1280, height = 800): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  return { context, page };
}

/**
 * Set localStorage before navigating so pin state is present on first load.
 * Playwright addInitScript runs before any page script.
 */
async function freshPageWithPinnedState(width = 1280, height = 800): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
  // Inject sidebarPinned=true into localStorage before the app JS runs
  await context.addInitScript(() => {
    localStorage.setItem('sidebarPinned', 'true');
  });
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

// ─── G1: Pin-state restore on page load ───────────────────────────────────

describe('G1 — Pin-state restore on page load', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPageWithPinnedState(1280, 800));
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('body has sidebar-pinned class when sidebarPinned=true is in localStorage at load', async () => {
    const hasPinned = await page.evaluate(() => document.body.classList.contains('sidebar-pinned'));
    expect(hasPinned).toBe(true);
  });

  it('#sessionDrawer has open class when pin state is restored on desktop', async () => {
    // _openPinned() is called via requestAnimationFrame after app init
    await page.waitForFunction(() => document.getElementById('sessionDrawer')?.classList.contains('open'), {
      timeout: 5000,
    });
    const drawerOpen = await page.evaluate(
      () => document.getElementById('sessionDrawer')?.classList.contains('open') ?? false
    );
    expect(drawerOpen).toBe(true);
  });
});

// ─── G2: _openPinned() renders session list ───────────────────────────────

describe('G2 — _openPinned() renders session list', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    // Create a session first via a plain page so state.json has at least one session
    const { context: setupCtx, page: setupPage } = await freshPage(1280, 800);
    await navigateTo(setupPage);
    await setupPage.evaluate(async () => {
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'pinned-list-test' }),
      });
    });
    await setupCtx.close();

    // Now open pinned page
    ({ context, page } = await freshPageWithPinnedState(1280, 800));
    await navigateTo(page);

    // Wait for drawer to be open (set by _openPinned)
    await page.waitForFunction(() => document.getElementById('sessionDrawer')?.classList.contains('open'), {
      timeout: 5000,
    });
    // Give SSE time to deliver session list and trigger _render()
    await page.waitForTimeout(600);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('drawer contains at least one session row after _openPinned()', async () => {
    const rowCount = await page.locator('.drawer-session-row').count();
    expect(rowCount).toBeGreaterThan(0);
  });
});

// ─── G3: Session click does not close sidebar when pinned ─────────────────

describe('G3 — Session click does not close sidebar when pinned', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    // Ensure there is at least one session
    const { context: setupCtx, page: setupPage } = await freshPage(1280, 800);
    await navigateTo(setupPage);
    await setupPage.evaluate(async () => {
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'pinned-click-test' }),
      });
    });
    await setupCtx.close();

    ({ context, page } = await freshPageWithPinnedState(1280, 800));
    await navigateTo(page);

    await page.waitForFunction(() => document.getElementById('sessionDrawer')?.classList.contains('open'), {
      timeout: 5000,
    });
    await page.waitForTimeout(600);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('clicking a session row in pinned mode keeps the drawer open', async () => {
    const rowCount = await page.locator('.drawer-session-row').count();
    expect(rowCount).toBeGreaterThan(0);

    // Click the first session row
    await page.locator('.drawer-session-row').first().click();
    await page.waitForTimeout(300);

    const drawerOpen = await page.evaluate(
      () => document.getElementById('sessionDrawer')?.classList.contains('open') ?? false
    );
    expect(drawerOpen).toBe(true);
  });
});

// ─── G4: close() is a no-op when pinned ──────────────────────────────────

describe('G4 — close() is a no-op when pinned', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPageWithPinnedState(1280, 800));
    await navigateTo(page);
    await page.waitForFunction(() => document.getElementById('sessionDrawer')?.classList.contains('open'), {
      timeout: 5000,
    });
  });

  afterAll(async () => {
    await context?.close();
  });

  it('SessionDrawer.close() does not remove open class while pinned', async () => {
    // Verify drawer is open and body is pinned before the call
    const stateBefore = await page.evaluate(() => ({
      pinned: document.body.classList.contains('sidebar-pinned'),
      open: document.getElementById('sessionDrawer')?.classList.contains('open') ?? false,
    }));
    expect(stateBefore.pinned).toBe(true);
    expect(stateBefore.open).toBe(true);

    // Trigger close() via the overlay element's onclick handler.
    // The overlay has onclick="SessionDrawer.close()" — clicking it exercises
    // the close() guard without requiring SessionDrawer to be on window
    // (it's a top-level const in a classic script, not a window property).
    await page.evaluate(() => {
      (document.getElementById('sessionDrawerOverlay') as HTMLElement)?.click();
    });
    await page.waitForTimeout(200);

    const drawerOpen = await page.evaluate(
      () => document.getElementById('sessionDrawer')?.classList.contains('open') ?? false
    );
    expect(drawerOpen).toBe(true);
  });
});

// ─── G5: Unpinning via pin button closes drawer ───────────────────────────

describe('G5 — Unpinning via pin button removes sidebar-pinned and closes drawer', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPageWithPinnedState(1280, 800));
    await navigateTo(page);
    await page.waitForFunction(() => document.getElementById('sessionDrawer')?.classList.contains('open'), {
      timeout: 5000,
    });
    // Wait for pin button to be injected by _openPinned()
    await page.waitForSelector('.drawer-pin-btn', { timeout: 5000 });
  });

  afterAll(async () => {
    await context?.close();
  });

  it('clicking the pin button removes sidebar-pinned from body', async () => {
    await page.click('.drawer-pin-btn');
    await page.waitForTimeout(300);

    const hasPinned = await page.evaluate(() => document.body.classList.contains('sidebar-pinned'));
    expect(hasPinned).toBe(false);
  });

  it('localStorage.sidebarPinned is set to false after unpinning', async () => {
    const storedValue = await page.evaluate(() => localStorage.getItem('sidebarPinned'));
    expect(storedValue).toBe('false');
  });

  it('drawer is closed after unpinning via pin button', async () => {
    await page.waitForTimeout(400); // allow CSS transition
    const drawerOpen = await page.evaluate(
      () => document.getElementById('sessionDrawer')?.classList.contains('open') ?? false
    );
    expect(drawerOpen).toBe(false);
  });
});

// ─── G6: CSS layout — .main gets margin-right: 300px when pinned ──────────

describe('G6 — CSS layout: body.sidebar-pinned applies margin-right: 300px to .main', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPageWithPinnedState(1280, 800));
    await navigateTo(page);
    await page.waitForFunction(() => document.getElementById('sessionDrawer')?.classList.contains('open'), {
      timeout: 5000,
    });
  });

  afterAll(async () => {
    await context?.close();
  });

  it('.main element has margin-right of 300px when body has sidebar-pinned class', async () => {
    const marginRight = await page.evaluate(() => {
      const mainEl = document.querySelector('.main') as HTMLElement | null;
      if (!mainEl) return null;
      return getComputedStyle(mainEl).marginRight;
    });
    expect(marginRight).toBe('300px');
  });
});

// ─── G6b: CSS layout — .header and other full-width elements get margin-right: 300px ──

describe('G6b — CSS layout: body.sidebar-pinned applies margin-right: 300px to full-width elements', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPageWithPinnedState(1280, 800));
    await navigateTo(page);
    await page.waitForFunction(() => document.getElementById('sessionDrawer')?.classList.contains('open'), {
      timeout: 5000,
    });
  });

  afterAll(async () => {
    await context?.close();
  });

  it('.header element has margin-right of 300px when body has sidebar-pinned class', async () => {
    const marginRight = await page.evaluate(() => {
      const el = document.querySelector('.header') as HTMLElement | null;
      if (!el) return null;
      return getComputedStyle(el).marginRight;
    });
    expect(marginRight).toBe('300px');
  });

  it('.session-indicator-bar has margin-right of 300px when pinned (if present in DOM)', async () => {
    const result = await page.evaluate(() => {
      const el = document.querySelector('.session-indicator-bar') as HTMLElement | null;
      if (!el) return 'not-present';
      return getComputedStyle(el).marginRight;
    });
    // Element may not be visible in testMode, but if present it must be shifted
    if (result !== 'not-present') {
      expect(result).toBe('300px');
    } else {
      // Element not in DOM — skip gracefully
      expect(result).toBe('not-present');
    }
  });
});

// ─── G8: Transcript view has sufficient bottom padding on desktop ──────────

describe('G8 — CSS layout: .transcript-view has enough bottom padding on desktop (Gap 4)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPageWithPinnedState(1280, 800));
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('.transcript-view padding-bottom is greater than 100px on desktop (covers compose bar + accessory bar)', async () => {
    // .transcript-view is always in the DOM (display:none when no session is selected).
    // The desktop @media rule adds padding-bottom: calc(60px + 40px + 8px) = 108px minimum.
    // NOTE: the live-status ResizeObserver in app.js (line ~13546) may set an inline
    // style "padding-bottom: 0px" on this element when no live status block is present.
    // This test will fail if that inline override is not accounted for in the implementation.
    const paddingBottom = await page.evaluate(() => {
      const el = document.getElementById('transcriptView') as HTMLElement | null;
      if (!el) return null;
      return getComputedStyle(el).paddingBottom;
    });
    expect(paddingBottom).not.toBeNull();
    // Parse the pixel value and assert it is greater than 100px
    const px = parseFloat(paddingBottom as string);
    expect(px).toBeGreaterThan(100);
  });
});

// ─── G7: Mobile isolation ─────────────────────────────────────────────────

describe('G7 — Mobile isolation: <1024px viewport does not auto-open pinned sidebar', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    // Use a narrow viewport (mobile) with sidebarPinned=true in localStorage
    ({ context, page } = await freshPageWithPinnedState(400, 800));
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('drawer does NOT have open class on a <1024px viewport even with sidebarPinned in localStorage', async () => {
    // Give ample time in case there's a delayed open
    await page.waitForTimeout(500);

    const drawerOpen = await page.evaluate(
      () => document.getElementById('sessionDrawer')?.classList.contains('open') ?? false
    );
    expect(drawerOpen).toBe(false);
  });

  it('body does NOT have sidebar-pinned class on a <1024px viewport', async () => {
    const hasPinned = await page.evaluate(() => document.body.classList.contains('sidebar-pinned'));
    expect(hasPinned).toBe(false);
  });
});

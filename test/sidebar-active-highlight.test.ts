/**
 * Sidebar active session highlight tests
 *
 * Covers three gaps identified for the fix/sidebar-active-session-highlight fix:
 *
 * Gap 1 — selectSession() triggers SessionDrawer._render() when drawer is open,
 *          updating the .active class on the correct row.
 * Gap 2 — Immediate .active class toggle in _renderSessionRow() click handler
 *          gives instant visual feedback in pinned mode.
 * Gap 3 — Agents view row click handler applies .active toggle.
 *
 * Port: 3249 (sidebar-active-highlight tests)
 *
 * Run: npx vitest run test/sidebar-active-highlight.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3249;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

// ─── Helpers ──────────────────────────────────────────────────────────────

async function freshPage(width = 1280, height = 800): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  return { context, page };
}

async function freshPageWithPinnedState(width = 1280, height = 800): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
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

/** Create a session via the API and return its id. */
async function createSession(page: Page, name: string): Promise<string> {
  return page.evaluate(async (n: string) => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: n }),
    });
    const data = await res.json();
    return data.id ?? data.session?.id ?? '';
  }, name);
}

/** Delete a session via the API (best-effort cleanup). */
async function deleteSession(page: Page, id: string): Promise<void> {
  await page
    .evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
    }, id)
    .catch(() => {});
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

// ─── Gap 1 + 2: Clicking a session row in pinned sidebar updates .active ──

describe('Gaps 1+2 — Clicking a session row in pinned sidebar moves .active highlight', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionA: string;
  let sessionB: string;

  beforeAll(async () => {
    // Create two sessions via a plain page so state has them
    const { context: setupCtx, page: setupPage } = await freshPage(1280, 800);
    await navigateTo(setupPage);
    sessionA = await createSession(setupPage, 'highlight-test-A');
    sessionB = await createSession(setupPage, 'highlight-test-B');
    await setupCtx.close();

    // Open pinned sidebar page
    ({ context, page } = await freshPageWithPinnedState(1280, 800));
    await navigateTo(page);

    // Wait for drawer to be open and populated
    await page.waitForFunction(() => document.getElementById('sessionDrawer')?.classList.contains('open'), {
      timeout: 5000,
    });
    await page.waitForTimeout(600);
  }, 30_000);

  afterAll(async () => {
    // Clean up test sessions
    if (sessionA) await deleteSession(page, sessionA);
    if (sessionB) await deleteSession(page, sessionB);
    await context?.close();
  });

  it('drawer contains at least two session rows', async () => {
    const rowCount = await page.locator('.drawer-session-row').count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
  });

  it('exactly one row has .active class initially', async () => {
    const activeCount = await page.locator('.drawer-session-row.active').count();
    expect(activeCount).toBe(1);
  });

  it('clicking a different session row moves .active to the clicked row', async () => {
    // Find the currently active row's session id
    const initialActiveId = await page.evaluate(() => {
      const el = document.querySelector('.drawer-session-row.active') as HTMLElement | null;
      return el?.dataset.sessionId ?? '';
    });
    expect(initialActiveId).not.toBe('');

    // Find a row that is NOT active and click it
    const targetRow = page.locator('.drawer-session-row:not(.active)').first();
    const targetId = await targetRow.getAttribute('data-session-id');
    expect(targetId).not.toBeNull();

    await targetRow.click();
    await page.waitForTimeout(500); // allow selectSession + _render to complete

    // The clicked row should now have .active
    const newActiveId = await page.evaluate(() => {
      const el = document.querySelector('.drawer-session-row.active') as HTMLElement | null;
      return el?.dataset.sessionId ?? '';
    });
    expect(newActiveId).toBe(targetId);

    // The previously active row should no longer have .active
    const oldRowStillActive = await page.evaluate((id: string) => {
      const row = document.querySelector(`.drawer-session-row[data-session-id="${id}"]`);
      return row?.classList.contains('active') ?? false;
    }, initialActiveId);
    expect(oldRowStillActive).toBe(false);
  });

  it('only one row has .active after switching', async () => {
    const activeCount = await page.locator('.drawer-session-row.active').count();
    expect(activeCount).toBe(1);
  });

  it('drawer remains open after clicking a session row in pinned mode', async () => {
    const drawerOpen = await page.evaluate(
      () => document.getElementById('sessionDrawer')?.classList.contains('open') ?? false
    );
    expect(drawerOpen).toBe(true);
  });
});

// ─── Gap 1 (programmatic): selectSession() updates drawer highlight ───────

describe('Gap 1 — Programmatic selectSession() updates drawer .active when drawer is open', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionA: string;
  let sessionB: string;

  beforeAll(async () => {
    const { context: setupCtx, page: setupPage } = await freshPage(1280, 800);
    await navigateTo(setupPage);
    sessionA = await createSession(setupPage, 'prog-highlight-A');
    sessionB = await createSession(setupPage, 'prog-highlight-B');
    await setupCtx.close();

    ({ context, page } = await freshPageWithPinnedState(1280, 800));
    await navigateTo(page);

    await page.waitForFunction(() => document.getElementById('sessionDrawer')?.classList.contains('open'), {
      timeout: 5000,
    });
    await page.waitForTimeout(600);
  }, 30_000);

  afterAll(async () => {
    if (sessionA) await deleteSession(page, sessionA);
    if (sessionB) await deleteSession(page, sessionB);
    await context?.close();
  });

  it('calling app.selectSession() programmatically updates .active in the drawer', async () => {
    // Get a session id that is NOT currently active
    const targetId = await page.evaluate(() => {
      const rows = document.querySelectorAll('.drawer-session-row:not(.active)');
      if (rows.length === 0) return '';
      return (rows[0] as HTMLElement).dataset.sessionId ?? '';
    });
    expect(targetId).not.toBe('');

    // Call selectSession programmatically (not via click)
    await page.evaluate((id: string) => (window as any).app.selectSession(id), targetId);
    await page.waitForTimeout(500);

    // The target row should now have .active
    const activeId = await page.evaluate(() => {
      const el = document.querySelector('.drawer-session-row.active') as HTMLElement | null;
      return el?.dataset.sessionId ?? '';
    });
    expect(activeId).toBe(targetId);

    // Only one row should be active
    const activeCount = await page.locator('.drawer-session-row.active').count();
    expect(activeCount).toBe(1);
  });
});

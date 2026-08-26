/**
 * Mobile session gear menu regression tests
 *
 * Covers the three defects fixed in src/web/public/app.js:
 *
 *   Bug A — the drawer gear used to call SessionDrawer.close(), so tapping ⚙
 *           slid the whole sidebar away ("the gear closes my menu").
 *   Bug B — Rename built its input inside a container that is invisible on
 *           mobile (#sessionTabs is display:none, or the just-closed drawer),
 *           so the user typed blindly. It now routes to
 *           SessionDrawer._startInlineRename(), and startInlineRename() bails
 *           out on a target with no layout box.
 *   Bug C — the outside-dismiss listener was armed with setTimeout(0) and is
 *           now armed behind a 250 ms gesture-grace window, listens on
 *           pointerdown as well as click, and ignores events inside the menu.
 *
 * Port: 3231 (mobile-session-gear-menu tests)
 *
 * Run: npx vitest run test/mobile-session-gear-menu.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebServer } from '../src/web/server.js';

const PORT = 3231;
const BASE_URL = `http://localhost:${PORT}`;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The dismiss listener is armed after 250 ms — waits must comfortably exceed it. */
const GRACE_MS = 250;
const PAST_GRACE_MS = 400;

let server: WebServer;
let browser: Browser;

/** Created once in the mobile suite, reused by the desktop suite, deleted in afterAll. */
let sessionId = '';

// ─── Helpers ──────────────────────────────────────────────────────────────

async function freshPage(
  width: number,
  height: number,
  hasTouch = false
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch });
  const page = await context.newPage();
  return { context, page };
}

async function navigateTo(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 8000 });
  await page.waitForTimeout(300);
}

/**
 * Re-open the drawer if a previous step closed it. Escape is handled globally by
 * app.closeAllPanels(), so any test that presses it also collapses the drawer.
 */
async function ensureDrawerOpen(page: Page): Promise<void> {
  const isOpen = await page.evaluate(
    () => document.getElementById('sessionDrawer')?.classList.contains('open') ?? false
  );
  if (isOpen) return;
  await page.evaluate('SessionDrawer.open()');
  await page.waitForSelector('#sessionDrawer.open', { timeout: 3000 });
  await page.waitForSelector(`.drawer-session-row`, { timeout: 5000 });
  await page.waitForTimeout(350); // bottom-sheet slide-up transition
}

/** Open the gear menu by dispatching a real click on the drawer row's ⚙ button. */
async function openDrawerGearMenu(page: Page): Promise<void> {
  await ensureDrawerOpen(page);
  await page.evaluate((id: string) => {
    (window as any).app.closeSessionContextMenu();
    const gear = document.querySelector(
      `.drawer-session-row[data-session-id="${id}"] .drawer-session-gear`
    ) as HTMLElement | null;
    if (!gear) throw new Error('drawer gear button not found');
    gear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, sessionId);
  await page.waitForSelector('.session-context-menu', { timeout: 3000 });
}

function menuCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.session-context-menu').length);
}

/** Read the last `z-index` declared for a selector in one of the stylesheets. */
function getCssZIndex(file: 'styles.css' | 'mobile.css', selector: string): number | null {
  const css = readFileSync(join(repoRoot, 'src/web/public', file), 'utf8');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped + '\\s*\\{([^}]+)\\}', 'g');
  let match: RegExpExecArray | null;
  let lastZIndex: number | null = null;
  while ((match = re.exec(css)) !== null) {
    const zMatch = match[1].match(/z-index\s*:\s*(\d+)/);
    if (zMatch) lastZIndex = parseInt(zMatch[1], 10);
  }
  return lastZIndex;
}

function getAppJs(): string {
  return readFileSync(join(repoRoot, 'src/web/public/app.js'), 'utf8');
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  // Delete the test session before the server goes down so it does not leak
  // into ~/.codeman/state.json.
  if (sessionId) {
    await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
  }
  await browser?.close();
  await server?.stop();
}, 60_000);

// ─── Mobile: gear menu behaviour (Bugs A, B, C) ───────────────────────────

describe('Mobile drawer gear menu', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    // 390x844 → innerWidth < 430 → MobileDetection.getDeviceType() === 'mobile'
    ({ context, page } = await freshPage(390, 844, true));
    await navigateTo(page);

    sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'gear-menu-test' }),
      });
      const data = await res.json();
      return data.id ?? data.session?.id ?? '';
    });
    expect(sessionId, 'test session must be created').not.toBe('');

    await page.evaluate('SessionDrawer.open()');
    await page.waitForSelector('#sessionDrawer.open', { timeout: 3000 });
    await page.waitForSelector(`.drawer-session-row[data-session-id="${sessionId}"]`, { timeout: 5000 });
  }, 60_000);

  afterAll(async () => {
    await page?.evaluate(() => (window as any).app.closeSessionContextMenu()).catch(() => {});
    await context?.close();
  });

  // ── Bug A ───────────────────────────────────────────────────────────────

  it('tapping the drawer gear opens the session context menu', async () => {
    await openDrawerGearMenu(page);
    expect(await menuCount(page)).toBe(1);
    expect(await page.locator('.session-context-menu').isVisible()).toBe(true);
  });

  it('drawer stays open after tapping the gear (Bug A)', async () => {
    const drawerOpen = await page.evaluate(
      () => document.getElementById('sessionDrawer')?.classList.contains('open') ?? false
    );
    expect(drawerOpen).toBe(true);
  });

  it('drawer is still on screen after tapping the gear (Bug A)', async () => {
    const onScreen = await page.evaluate(() => {
      const rect = document.getElementById('sessionDrawer')!.getBoundingClientRect();
      return rect.top < window.innerHeight;
    });
    expect(onScreen, 'drawer must not have slid below the viewport').toBe(true);
  });

  it('context menu paints above the still-open drawer', async () => {
    const zIndexes = await page.evaluate(() => ({
      menu: parseInt(getComputedStyle(document.querySelector('.session-context-menu')!).zIndex, 10),
      drawer: parseInt(getComputedStyle(document.getElementById('sessionDrawer')!).zIndex, 10),
    }));
    expect(zIndexes.menu).toBeGreaterThan(zIndexes.drawer);
  });

  // ── Bug C ───────────────────────────────────────────────────────────────

  it('menu survives a residual compatibility click from the opening tap (Bug C)', async () => {
    const survived = await page.evaluate((id: string) => {
      (window as any).app.closeSessionContextMenu();
      const gear = document.querySelector(
        `.drawer-session-row[data-session-id="${id}"] .drawer-session-gear`
      ) as HTMLElement;
      gear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // The touch stack replays the tap as a click on whatever is now under the
      // finger — with setTimeout(0) arming this tore the menu down instantly.
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return document.querySelectorAll('.session-context-menu').length;
    }, sessionId);
    expect(survived).toBe(1);
  });

  it('pointerdown outside the menu closes it once the grace window has elapsed (Bug C)', async () => {
    await page.waitForTimeout(PAST_GRACE_MS);
    await page.evaluate(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(await menuCount(page)).toBe(0);
  });

  it('pointerdown inside the menu does not dismiss it before the item click fires (Bug C)', async () => {
    await openDrawerGearMenu(page);
    await page.waitForTimeout(PAST_GRACE_MS);
    await page.evaluate(() => {
      const item = document.querySelector('.session-context-menu .session-ctx-item') as HTMLElement;
      item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(await menuCount(page)).toBe(1);
  });

  it('Escape closes the menu immediately, without waiting for the grace window (Bug C)', async () => {
    await openDrawerGearMenu(page);
    await page.keyboard.press('Escape');
    expect(await menuCount(page)).toBe(0);
  });

  it('closing inside the grace window clears the arm timer and the dismiss handler (Bug C)', async () => {
    await openDrawerGearMenu(page);
    const state = await page.evaluate(() => {
      const app = (window as any).app;
      app.closeSessionContextMenu();
      return {
        menus: document.querySelectorAll('.session-context-menu').length,
        armTimer: app._sessionCtxMenuArmTimer,
        cleanup: app._sessionCtxMenuCleanup,
        keyHandler: app._sessionCtxMenuKeyHandler,
      };
    });
    expect(state.menus).toBe(0);
    expect(state.armTimer).toBeNull();
    expect(state.cleanup).toBeNull();
    expect(state.keyHandler).toBeNull();
  });

  it('a menu re-opened after an early close is still dismissible (no leaked listeners)', async () => {
    await page.waitForTimeout(PAST_GRACE_MS);
    await openDrawerGearMenu(page);
    expect(await menuCount(page)).toBe(1);
    await page.waitForTimeout(PAST_GRACE_MS);
    await page.evaluate(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(await menuCount(page)).toBe(0);
  });

  // ── Bug B ───────────────────────────────────────────────────────────────

  it('Rename opens a visible, focused input on the drawer row (Bug B)', async () => {
    await openDrawerGearMenu(page);
    await page.waitForTimeout(PAST_GRACE_MS);
    await page.locator('.session-context-menu .session-ctx-item', { hasText: 'Rename' }).click();
    await page.waitForSelector('.drawer-rename-input', { timeout: 3000 });

    const result = await page.evaluate(() => {
      const input = document.querySelector('.drawer-rename-input') as HTMLInputElement;
      const rect = input.getBoundingClientRect();
      return {
        rowId: input.closest('.drawer-session-row')?.getAttribute('data-session-id') ?? null,
        focused: document.activeElement === input,
        width: rect.width,
        height: rect.height,
        onScreen: rect.top >= 0 && rect.bottom <= window.innerHeight,
        tabRenameInputs: document.querySelectorAll('.tab-rename-input').length,
      };
    });

    expect(result.rowId, 'rename input must live on the tapped drawer row').toBe(sessionId);
    expect(result.focused, 'rename input must be focused').toBe(true);
    expect(result.width, 'rename input must have a layout box').toBeGreaterThan(0);
    expect(result.height, 'rename input must have a layout box').toBeGreaterThan(0);
    expect(result.onScreen, 'rename input must be inside the viewport, not off-screen').toBe(true);
    expect(result.tabRenameInputs, 'must not use the hidden tab-strip rename').toBe(0);

    await page.keyboard.press('Escape'); // cancel the rename
    await page.waitForTimeout(200);
  });

  it('Rename still targets the live row after the drawer re-renders', async () => {
    await openDrawerGearMenu(page);
    // The drawer re-renders on SSE updates while the body-level menu survives —
    // the onRename callback must re-resolve the row from the live DOM.
    await page.evaluate('SessionDrawer._render()');
    await page.waitForTimeout(PAST_GRACE_MS);
    await page.locator('.session-context-menu .session-ctx-item', { hasText: 'Rename' }).click();
    await page.waitForSelector('.drawer-rename-input', { timeout: 3000 });

    const result = await page.evaluate(() => {
      const input = document.querySelector('.drawer-rename-input') as HTMLInputElement;
      return {
        attached: document.body.contains(input),
        rowId: input.closest('.drawer-session-row')?.getAttribute('data-session-id') ?? null,
        focused: document.activeElement === input,
      };
    });
    expect(result.attached).toBe(true);
    expect(result.rowId).toBe(sessionId);
    expect(result.focused).toBe(true);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  });
});

// ─── Desktop: tab-gear path must not regress (and the layout-box guard) ────

describe('Desktop tab gear menu (non-regression)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(1280, 800));
    await navigateTo(page);
    await page.waitForFunction((id: string) => (window as any).app?.sessions?.has(id), sessionId, {
      timeout: 8000,
    });
    // index.html ships #sessionTabs with an inline display:none (the tab strip was
    // moved into the sidebar), and both tab renderers early-return while it is
    // hidden. Un-hide it so the desktop .tab-gear path can be exercised at all.
    await page.evaluate(() => {
      // The strip is `display: none !important` in styles.css as well as inline.
      (document.getElementById('sessionTabs') as HTMLElement).style.setProperty('display', 'flex', 'important');
      (window as any).app._fullRenderSessionTabs();
    });
    await page.waitForSelector(`.session-tab[data-id="${sessionId}"] .tab-gear`, { timeout: 5000 });
  }, 60_000);

  afterAll(async () => {
    await page?.evaluate(() => (window as any).app.closeSessionContextMenu()).catch(() => {});
    await context?.close();
  });

  it('clicking the tab gear opens the session context menu', async () => {
    await page.locator(`.session-tab[data-id="${sessionId}"] .tab-gear`).click();
    await page.waitForSelector('.session-context-menu', { timeout: 3000 });
    expect(await menuCount(page)).toBe(1);
  });

  it('Rename from the tab gear still uses the app-level inline rename', async () => {
    await page.waitForTimeout(PAST_GRACE_MS);
    await page.locator('.session-context-menu .session-ctx-item', { hasText: 'Rename' }).click();
    await page.waitForSelector('.tab-rename-input', { timeout: 3000 });

    const result = await page.evaluate((id: string) => {
      const input = document.querySelector('.tab-rename-input') as HTMLInputElement;
      return {
        parentId: input.parentElement?.getAttribute('data-session-id') ?? null,
        parentClass: input.parentElement?.className ?? '',
        focused: document.activeElement === input,
        drawerRenameInputs: document.querySelectorAll('.drawer-rename-input').length,
        expectedId: id,
      };
    }, sessionId);

    expect(result.parentClass).toContain('tab-name');
    expect(result.parentId).toBe(result.expectedId);
    expect(result.focused, 'the layout-box guard must not fire on a visible tab strip').toBe(true);
    expect(result.drawerRenameInputs).toBe(0);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  });

  it('startInlineRename() bails out when the tab strip has no layout box (Bug B guard)', async () => {
    const inputs = await page.evaluate((id: string) => {
      const app = (window as any).app;
      // Re-hide the tab strip: .tab-name nodes still exist but have no layout box,
      // so focus() would be a no-op and the user would type into an invisible field.
      (document.getElementById('sessionTabs') as HTMLElement).style.setProperty('display', 'none', 'important');
      app.startInlineRename(id);
      return document.querySelectorAll('.tab-rename-input').length;
    }, sessionId);
    expect(inputs, 'no rename input may be attached to a zero-box target').toBe(0);
  });
});

// ─── Source / CSS invariants ──────────────────────────────────────────────

describe('Gear menu source invariants', () => {
  it('.session-context-menu out-z-indexes .session-drawer on mobile', () => {
    const menuZ = getCssZIndex('styles.css', '.session-context-menu');
    const drawerZ = getCssZIndex('mobile.css', '.session-drawer');
    expect(menuZ, '.session-context-menu z-index must be defined').not.toBeNull();
    expect(drawerZ, 'mobile .session-drawer z-index must be defined').not.toBeNull();
    expect(
      menuZ! > drawerZ!,
      `.session-context-menu z-index (${menuZ}) must be greater than mobile .session-drawer z-index (${drawerZ})`
    ).toBe(true);
  });

  it('the drawer gear handler does not close the drawer (Bug A)', () => {
    const src = getAppJs();
    const start = src.indexOf("gearBtn.className = 'drawer-session-gear'");
    expect(start, 'drawer gear button must exist').toBeGreaterThan(-1);
    const slice = src.slice(start, start + 1200);
    expect(slice.includes('app.openSessionContextMenu('), 'gear must open the context menu').toBe(true);
    expect(slice.includes('SessionDrawer.close()'), 'gear must not close the drawer').toBe(false);
  });

  it('the drawer gear passes an onRename callback to openSessionContextMenu (Bug B)', () => {
    const src = getAppJs();
    const start = src.indexOf("gearBtn.className = 'drawer-session-gear'");
    const slice = src.slice(start, start + 1200);
    expect(slice.includes('onRename')).toBe(true);
    expect(slice.includes('SessionDrawer._startInlineRename(')).toBe(true);
  });

  it('startInlineRename guards on the layout box right after the !tabName bail-out (Bug B)', () => {
    const src = getAppJs();
    const start = src.indexOf('startInlineRename(sessionId) {');
    expect(start, 'startInlineRename must exist').toBeGreaterThan(-1);
    const slice = src.slice(start, start + 1500);
    const nullGuard = slice.indexOf('if (!tabName) return;');
    const boxGuard = slice.search(
      /if \(!tabName\.offsetParent \|\| \w*[Rr]ect\.width === 0 \|\| \w*[Rr]ect\.height === 0\) return;/
    );
    expect(nullGuard, 'the !tabName bail-out must exist').toBeGreaterThan(-1);
    expect(boxGuard, 'the layout-box bail-out must exist').toBeGreaterThan(-1);
    expect(boxGuard, 'the layout-box guard must sit after the !tabName guard').toBeGreaterThan(nullGuard);
  });

  it('the outside-dismiss listener is armed behind a non-zero grace window (Bug C)', () => {
    const src = getAppJs();
    const start = src.indexOf('openSessionContextMenu(event, sessionId, options = {})');
    expect(start, 'openSessionContextMenu must exist').toBeGreaterThan(-1);
    const slice = src.slice(start, start + 6000);

    const graceMatch = slice.match(/const graceMs = (\d+);/);
    expect(graceMatch, 'a graceMs constant must guard the dismiss arming').not.toBeNull();
    expect(parseInt(graceMatch![1], 10)).toBeGreaterThanOrEqual(200);

    expect(slice.includes("addEventListener('pointerdown'"), 'must dismiss on pointerdown too').toBe(true);
    expect(slice.includes('menu.contains(e.target)'), 'events inside the menu must be ignored').toBe(true);
    expect(slice.includes('_sessionCtxMenuArmTimer'), 'the arm timer must be tracked so it can be cleared').toBe(true);
  });

  it('closeSessionContextMenu clears the arm timer and both dismiss listeners (Bug C)', () => {
    const src = getAppJs();
    const start = src.indexOf('closeSessionContextMenu() {');
    expect(start).toBeGreaterThan(-1);
    const slice = src.slice(start, start + 900);
    expect(slice.includes('clearTimeout(this._sessionCtxMenuArmTimer)')).toBe(true);
    expect(slice.includes("removeEventListener('pointerdown'")).toBe(true);
    expect(slice.includes("removeEventListener('click'")).toBe(true);
    expect(slice.includes("removeEventListener('keydown'")).toBe(true);
  });
});

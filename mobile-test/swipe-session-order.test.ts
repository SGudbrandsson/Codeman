// Port 3209 - Swipe navigation follows drawer visual order (grouped by project)
//
// Regression test for: mobile swipe navigates in raw sessionOrder (creation order)
// instead of the project-grouped order shown in the hamburger drawer.
//
// Fix: SessionDrawer._getOrderedSessionIds() returns the drawer visual order;
// SwipeHandler._resolveTarget() and nextSession()/prevSession() use it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { PORTS, WAIT } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import type { WebServer } from '../src/web/server.js';

const PORT = PORTS.SWIPE_SESSION_ORDER;
const BASE_URL = `http://localhost:${PORT}`;

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Inject a mock session/case environment into the page for testing ordering logic.
 *
 * Sessions (creation / drag order = sessionOrder):
 *   id-a  name "s1-alpha"  workingDir "/proj/alpha"  (Project alpha)
 *   id-b  name "s1-beta"   workingDir "/proj/beta"   (Project beta)
 *   id-c  name "s2-alpha"  workingDir "/proj/alpha"  (Project alpha)
 *   id-d  name "s2-beta"   workingDir "/proj/beta"   (Project beta)
 *
 * Cases (projects):
 *   alpha → path "/proj/alpha"
 *   beta  → path "/proj/beta"
 *
 * Raw sessionOrder (flat): [id-a, id-b, id-c, id-d]
 * Drawer visual order (grouped): [id-a, id-c, id-b, id-d]
 *   → alpha group: id-a, id-c
 *   → beta  group: id-b, id-d
 */
async function injectMockSessionEnvironment(page: Page): Promise<void> {
  await page.evaluate(`(function() {
    // Inject mock data into the global app object
    if (typeof app === 'undefined') return;

    app.cases = [
      { name: 'alpha', path: '/proj/alpha' },
      { name: 'beta',  path: '/proj/beta'  },
    ];

    app.sessions = new Map([
      ['id-a', { id: 'id-a', name: 's1-alpha', workingDir: '/proj/alpha', worktreeBranch: null, worktreeOriginId: null }],
      ['id-b', { id: 'id-b', name: 's1-beta',  workingDir: '/proj/beta',  worktreeBranch: null, worktreeOriginId: null }],
      ['id-c', { id: 'id-c', name: 's2-alpha', workingDir: '/proj/alpha', worktreeBranch: null, worktreeOriginId: null }],
      ['id-d', { id: 'id-d', name: 's2-beta',  workingDir: '/proj/beta',  worktreeBranch: null, worktreeOriginId: null }],
    ]);

    // Flat creation order — deliberately interleaves projects
    app.sessionOrder = ['id-a', 'id-b', 'id-c', 'id-d'];
    app.activeSessionId = 'id-a';
  })()`);
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('Swipe session order matches drawer visual order', () => {
  let server: WebServer;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    server = await createTestServer(PORT);
    ({ context, page } = await createDevicePage(
      {
        name: 'iPhone 14 Pro',
        viewport: { width: 390, height: 844 },
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
      BASE_URL
    ));
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
  });

  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  // ── API presence ──────────────────────────────────────────────────────────

  it('SessionDrawer._getOrderedSessionIds is a function', async () => {
    const isFunction = await page.evaluate(
      () => typeof (window as any).SessionDrawer?._getOrderedSessionIds === 'function'
    );
    expect(isFunction).toBe(true);
  });

  it('SessionDrawer._resolveCase is a function', async () => {
    const isFunction = await page.evaluate(() => typeof (window as any).SessionDrawer?._resolveCase === 'function');
    expect(isFunction).toBe(true);
  });

  it('SwipeHandler._resolveTarget is a function', async () => {
    const isFunction = await page.evaluate(() => typeof (window as any).SwipeHandler?._resolveTarget === 'function');
    expect(isFunction).toBe(true);
  });

  // ── drawer ordering ───────────────────────────────────────────────────────

  it('_getOrderedSessionIds returns an array', async () => {
    const result = await page.evaluate(() => (window as any).SessionDrawer._getOrderedSessionIds());
    expect(Array.isArray(result)).toBe(true);
  });

  it('_getOrderedSessionIds groups sessions by project — alpha before beta', async () => {
    await injectMockSessionEnvironment(page);
    const order: string[] = await page.evaluate(() => (window as any).SessionDrawer._getOrderedSessionIds());

    expect(order).toEqual(['id-a', 'id-c', 'id-b', 'id-d']);
  });

  it('drawer order differs from raw sessionOrder (confirms the bug scenario)', async () => {
    await injectMockSessionEnvironment(page);
    const [drawerOrder, rawOrder]: [string[], string[]] = await page.evaluate(() => [
      (window as any).SessionDrawer._getOrderedSessionIds(),
      (window as any).app?.sessionOrder ?? [],
    ]);

    // Raw order is creation order: a, b, c, d
    expect(rawOrder).toEqual(['id-a', 'id-b', 'id-c', 'id-d']);
    // Drawer order is grouped: a, c (alpha), b, d (beta)
    expect(drawerOrder).toEqual(['id-a', 'id-c', 'id-b', 'id-d']);
    expect(drawerOrder).not.toEqual(rawOrder);
  });

  // ── swipe target resolution ───────────────────────────────────────────────

  it('swiping forward from id-a yields id-c (drawer order), not id-b (raw order)', async () => {
    await injectMockSessionEnvironment(page);
    // direction +1 = forward (next in drawer)
    const target: string | null = await page.evaluate(() => (window as any).SwipeHandler._resolveTarget(1));
    // Drawer order: id-a → id-c → id-b → id-d
    expect(target).toBe('id-c');
  });

  it('swiping backward from id-a wraps to id-d (last in drawer order)', async () => {
    await injectMockSessionEnvironment(page);
    const target: string | null = await page.evaluate(() => (window as any).SwipeHandler._resolveTarget(-1));
    // Drawer order wraps: before id-a is id-d
    expect(target).toBe('id-d');
  });

  it('swiping forward from id-c yields id-b (crossing project boundary)', async () => {
    await injectMockSessionEnvironment(page);
    // Move active session to id-c
    await page.evaluate(() => {
      (window as any).app.activeSessionId = 'id-c';
    });
    const target: string | null = await page.evaluate(() => (window as any).SwipeHandler._resolveTarget(1));
    expect(target).toBe('id-b');
  });

  it('swiping forward from id-d wraps back to id-a', async () => {
    await injectMockSessionEnvironment(page);
    await page.evaluate(() => {
      (window as any).app.activeSessionId = 'id-d';
    });
    const target: string | null = await page.evaluate(() => (window as any).SwipeHandler._resolveTarget(1));
    expect(target).toBe('id-a');
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  it('_getOrderedSessionIds returns empty array when no sessions', async () => {
    await page.evaluate(() => {
      const a = (window as any).app;
      if (a) {
        a.sessions = new Map();
        a.sessionOrder = [];
        a.cases = [];
      }
    });
    const result: string[] = await page.evaluate(() => (window as any).SessionDrawer._getOrderedSessionIds());
    expect(result).toEqual([]);
  });

  it('ungrouped sessions (no cases) appear in raw sessionOrder order', async () => {
    await page.evaluate(() => {
      const a = (window as any).app;
      if (!a) return;
      a.cases = [];
      a.sessions = new Map([
        [
          'x1',
          { id: 'x1', name: 'session-1', workingDir: '/home/user/proj', worktreeBranch: null, worktreeOriginId: null },
        ],
        [
          'x2',
          { id: 'x2', name: 'session-2', workingDir: '/home/user/other', worktreeBranch: null, worktreeOriginId: null },
        ],
      ]);
      a.sessionOrder = ['x1', 'x2'];
    });
    const result: string[] = await page.evaluate(() => (window as any).SessionDrawer._getOrderedSessionIds());
    expect(result).toEqual(['x1', 'x2']);
  });
});

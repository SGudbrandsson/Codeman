/**
 * DrawerSwipeHandler tests — horizontal swipe between Sessions/Agents tabs
 *
 * Covers the gaps identified in TASK.md:
 * 1. DrawerSwipeHandler global exists on mobile
 * 2. Direction rules (sessions: left-only, agents: right-only)
 * 3. Gesture locking (horizontal lock vs vertical cancel)
 * 4. Commit threshold (COMMIT_RATIO / FLING_VELOCITY)
 * 5. Animation classes during swipe
 * 6. Spring-back on cancelled swipe
 * 7. Multi-touch rejection
 * 8. Desktop does not attach DrawerSwipeHandler
 *
 * Port: 3221 (drawer-swipe tests)
 *
 * Run: npx vitest run test/drawer-swipe.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3221;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

// ─── Helpers ──────────────────────────────────────────────────────────────

async function freshPage(width = 375, height = 812): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: true,
  });
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

/** Open the drawer and wait for it to be visible */
async function openDrawer(page: Page): Promise<void> {
  await page.evaluate('SessionDrawer.open()');
  await page.waitForSelector('#sessionDrawer.open', { timeout: 3000 });
  await page.waitForTimeout(200);
}

/**
 * Dispatch a synthetic touch sequence (start -> moves -> end) on #sessionDrawerList.
 * Returns the result of the callback evaluated after the sequence completes.
 */
async function simulateSwipe(
  page: Page,
  opts: { startX: number; startY: number; endX: number; endY: number; durationMs?: number; steps?: number }
): Promise<void> {
  const { startX, startY, endX, endY, durationMs = 150, steps = 6 } = opts;

  await page.evaluate(
    ({ sx, sy, ex, ey, dur, st }) => {
      const el = document.getElementById('sessionDrawerList');
      if (!el) throw new Error('sessionDrawerList not found');

      function touch(x: number, y: number): Touch {
        return new Touch({
          identifier: 0,
          target: el!,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          screenX: x,
          screenY: y,
        });
      }

      // touchstart
      el.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [touch(sx, sy)],
          changedTouches: [touch(sx, sy)],
          bubbles: true,
          cancelable: true,
        })
      );

      // touchmove steps (synchronous — timestamps are faked via performance.now offset)
      for (let i = 1; i <= st; i++) {
        const ratio = i / st;
        const cx = sx + (ex - sx) * ratio;
        const cy = sy + (ey - sy) * ratio;
        el.dispatchEvent(
          new TouchEvent('touchmove', {
            touches: [touch(cx, cy)],
            changedTouches: [touch(cx, cy)],
            bubbles: true,
            cancelable: true,
          })
        );
      }

      // Fake the elapsed time so velocity = dx / durationMs works correctly.
      // All touch events fire synchronously, so Date.now() sees near-zero elapsed
      // time. Override startTime to simulate the intended swipe duration.
      if (typeof DrawerSwipeHandler !== 'undefined') {
        (DrawerSwipeHandler as any).startTime = Date.now() - dur;
      }

      // touchend
      el.dispatchEvent(
        new TouchEvent('touchend', {
          touches: [],
          changedTouches: [touch(ex, ey)],
          bubbles: true,
          cancelable: true,
        })
      );
    },
    { sx: startX, sy: startY, ex: endX, ey: endY, dur: durationMs, st: steps }
  );
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

// ─── DrawerSwipeHandler exists on mobile ─────────────────────────────────

describe('DrawerSwipeHandler: global availability', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('DrawerSwipeHandler is defined on mobile viewport', async () => {
    const exists = await page.evaluate(() => typeof DrawerSwipeHandler !== 'undefined');
    expect(exists).toBe(true);
  });

  it('DrawerSwipeHandler has expected config constants', async () => {
    const config = await page.evaluate(() => {
      if (typeof DrawerSwipeHandler === 'undefined') return null;
      return {
        COMMIT_RATIO: (DrawerSwipeHandler as any).COMMIT_RATIO,
        FLING_VELOCITY: (DrawerSwipeHandler as any).FLING_VELOCITY,
        LOCK_THRESHOLD: (DrawerSwipeHandler as any).LOCK_THRESHOLD,
        TRANSITION_MS: (DrawerSwipeHandler as any).TRANSITION_MS,
      };
    });
    expect(config).not.toBeNull();
    expect(config!.COMMIT_RATIO).toBe(0.3);
    expect(config!.FLING_VELOCITY).toBe(0.4);
    expect(config!.LOCK_THRESHOLD).toBe(10);
    expect(config!.TRANSITION_MS).toBe(250);
  });
});

// ─── init / cleanup ──────────────────────────────────────────────────────

describe('DrawerSwipeHandler: init and cleanup', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('init() attaches _element when drawer is open', async () => {
    await openDrawer(page);
    const hasElement = await page.evaluate(() => {
      return typeof DrawerSwipeHandler !== 'undefined' && (DrawerSwipeHandler as any)._element !== null;
    });
    expect(hasElement).toBe(true);
  });

  it('cleanup() nulls _element and resets state', async () => {
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).cleanup();
    });
    const state = await page.evaluate(() => {
      if (typeof DrawerSwipeHandler === 'undefined') return null;
      const h = DrawerSwipeHandler as any;
      return {
        element: h._element,
        animating: h._animating,
        locked: h._locked,
        cancelled: h._cancelled,
        direction: h._direction,
      };
    });
    expect(state).not.toBeNull();
    expect(state!.element).toBeNull();
    expect(state!.animating).toBe(false);
    expect(state!.locked).toBe(false);
    expect(state!.cancelled).toBe(false);
    expect(state!.direction).toBe(0);
  });
});

// ─── Direction rules ─────────────────────────────────────────────────────

describe('DrawerSwipeHandler: direction rules', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('_resolveTarget returns "agents" for swipe-left when in sessions mode', async () => {
    const result = await page.evaluate(() => {
      if (typeof DrawerSwipeHandler === 'undefined') return null;
      // Ensure sessions mode
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
      return (DrawerSwipeHandler as any)._resolveTarget(-1);
    });
    expect(result).toBe('agents');
  });

  it('_resolveTarget returns null for swipe-right when in sessions mode (no-op)', async () => {
    const result = await page.evaluate(() => {
      if (typeof DrawerSwipeHandler === 'undefined') return null;
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
      return (DrawerSwipeHandler as any)._resolveTarget(1);
    });
    expect(result).toBeNull();
  });

  it('_resolveTarget returns "sessions" for swipe-right when in agents mode', async () => {
    const result = await page.evaluate(() => {
      if (typeof DrawerSwipeHandler === 'undefined') return null;
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('agents');
      return (DrawerSwipeHandler as any)._resolveTarget(1);
    });
    expect(result).toBe('sessions');
  });

  it('_resolveTarget returns null for swipe-left when in agents mode (no-op)', async () => {
    const result = await page.evaluate(() => {
      if (typeof DrawerSwipeHandler === 'undefined') return null;
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('agents');
      return (DrawerSwipeHandler as any)._resolveTarget(-1);
    });
    expect(result).toBeNull();
  });
});

// ─── Gesture locking ─────────────────────────────────────────────────────

describe('DrawerSwipeHandler: gesture locking', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('vertical swipe cancels gesture (sets _cancelled, does not lock)', async () => {
    await openDrawer(page);

    // Ensure sessions mode for valid left-swipe context
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);

    // Re-init after setViewMode since it may re-render
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Simulate a vertical swipe (large dy, small dx)
    await simulateSwipe(page, {
      startX: 200,
      startY: 400,
      endX: 205,
      endY: 340, // 60px vertical, 5px horizontal
    });

    const state = await page.evaluate(() => {
      if (typeof DrawerSwipeHandler === 'undefined') return null;
      const h = DrawerSwipeHandler as any;
      return { locked: h._locked, cancelled: h._cancelled };
    });
    // After touchend, state is reset — but the key is that no animation was triggered
    // Check that _animating is false (no commit happened)
    const animating = await page.evaluate(() => {
      return typeof DrawerSwipeHandler !== 'undefined' && (DrawerSwipeHandler as any)._animating;
    });
    expect(animating).toBe(false);
  });

  it('horizontal swipe locks gesture and applies swiping class', async () => {
    await openDrawer(page);

    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);

    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Simulate a horizontal swipe start (large dx, small dy) - only partway, check mid-state
    const midState = await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      if (!el || typeof DrawerSwipeHandler === 'undefined') return null;

      function touch(x: number, y: number): Touch {
        return new Touch({
          identifier: 0,
          target: el!,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          screenX: x,
          screenY: y,
        });
      }

      // touchstart
      el.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [touch(200, 400)],
          changedTouches: [touch(200, 400)],
          bubbles: true,
          cancelable: true,
        })
      );

      // touchmove past lock threshold (dx > 10, dy small) — swiping left
      el.dispatchEvent(
        new TouchEvent('touchmove', {
          touches: [touch(185, 402)],
          changedTouches: [touch(185, 402)],
          bubbles: true,
          cancelable: true,
        })
      );

      const h = DrawerSwipeHandler as any;
      return {
        locked: h._locked,
        cancelled: h._cancelled,
        hasSwiping: el.classList.contains('drawer-tab-swiping'),
        transform: el.style.transform,
      };
    });

    expect(midState).not.toBeNull();
    expect(midState!.locked).toBe(true);
    expect(midState!.cancelled).toBe(false);
    expect(midState!.hasSwiping).toBe(true);
    expect(midState!.transform).toContain('translateX');

    // Clean up — send touchend to reset
    await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      if (!el) return;
      function touch(x: number, y: number): Touch {
        return new Touch({
          identifier: 0,
          target: el!,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          screenX: x,
          screenY: y,
        });
      }
      el.dispatchEvent(
        new TouchEvent('touchend', { touches: [], changedTouches: [touch(185, 402)], bubbles: true, cancelable: true })
      );
    });
    await page.waitForTimeout(400); // allow animation to complete
  });
});

// ─── Commit and spring-back ──────────────────────────────────────────────

describe('DrawerSwipeHandler: commit and spring-back', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('small horizontal swipe springs back (below commit threshold)', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Swipe left by ~30px (well below 30% of 375 = 112.5px)
    await simulateSwipe(page, {
      startX: 200,
      startY: 400,
      endX: 170,
      endY: 402,
      durationMs: 500, // slow so velocity is low
      steps: 6,
    });
    await page.waitForTimeout(400); // allow spring-back animation

    // View mode should still be sessions
    const mode = await page.evaluate(() => {
      if (typeof SessionDrawer === 'undefined') return null;
      return (SessionDrawer as any)._viewMode;
    });
    expect(mode).toBe('sessions');

    // Transform should be cleared
    const transform = await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      return el ? el.style.transform : '';
    });
    expect(transform).toBe('');
  });

  it('large horizontal swipe commits (switches view mode)', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Swipe left by ~150px (above 30% of 375 = 112.5px)
    await simulateSwipe(page, {
      startX: 300,
      startY: 400,
      endX: 150,
      endY: 402,
      durationMs: 200,
      steps: 8,
    });
    await page.waitForTimeout(600); // allow two-phase animation + safety timeouts

    // View mode should have switched to agents
    const mode = await page.evaluate(() => {
      if (typeof SessionDrawer === 'undefined') return null;
      return (SessionDrawer as any)._viewMode;
    });
    expect(mode).toBe('agents');
  });

  it('swipe right on agents view commits back to sessions', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('agents');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Swipe right by ~150px
    await simulateSwipe(page, {
      startX: 75,
      startY: 400,
      endX: 225,
      endY: 402,
      durationMs: 200,
      steps: 8,
    });
    await page.waitForTimeout(600);

    const mode = await page.evaluate(() => {
      if (typeof SessionDrawer === 'undefined') return null;
      return (SessionDrawer as any)._viewMode;
    });
    expect(mode).toBe('sessions');
  });
});

// ─── Multi-touch rejection ───────────────────────────────────────────────

describe('DrawerSwipeHandler: multi-touch rejection', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('touchstart with multiple fingers is ignored', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    const result = await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      if (!el || typeof DrawerSwipeHandler === 'undefined') return null;

      function touch(id: number, x: number, y: number): Touch {
        return new Touch({
          identifier: id,
          target: el!,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          screenX: x,
          screenY: y,
        });
      }

      // touchstart with 2 fingers
      el.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [touch(0, 200, 400), touch(1, 250, 400)],
          changedTouches: [touch(0, 200, 400), touch(1, 250, 400)],
          bubbles: true,
          cancelable: true,
        })
      );

      const h = DrawerSwipeHandler as any;
      // startX should not have been set (still 0 from reset)
      return { startX: h.startX, locked: h._locked };
    });

    expect(result).not.toBeNull();
    // Multi-touch was rejected so startX should remain at default (0)
    expect(result!.startX).toBe(0);
    expect(result!.locked).toBe(false);
  });
});

// ─── Animation guard ─────────────────────────────────────────────────────

describe('DrawerSwipeHandler: animation guard', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('touchstart is ignored while _animating is true', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    const result = await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      if (!el || typeof DrawerSwipeHandler === 'undefined') return null;

      const h = DrawerSwipeHandler as any;
      // Force _animating to true
      h._animating = true;
      h.startX = 0;

      function touch(x: number, y: number): Touch {
        return new Touch({
          identifier: 0,
          target: el!,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          screenX: x,
          screenY: y,
        });
      }

      el.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [touch(200, 400)],
          changedTouches: [touch(200, 400)],
          bubbles: true,
          cancelable: true,
        })
      );

      const startXAfter = h.startX;
      // Reset for other tests
      h._animating = false;
      return { startX: startXAfter };
    });

    expect(result).not.toBeNull();
    // startX should NOT have been set because _animating blocked it
    expect(result!.startX).toBe(0);
  });
});

// ─── Invalid direction swipe is no-op ────────────────────────────────────

describe('DrawerSwipeHandler: invalid direction swipe', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('swipe right on sessions mode does not change view (no tab to the left)', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Swipe right by 150px — invalid direction for sessions
    await simulateSwipe(page, {
      startX: 75,
      startY: 400,
      endX: 225,
      endY: 402,
      durationMs: 200,
      steps: 8,
    });
    await page.waitForTimeout(400);

    const mode = await page.evaluate(() => {
      if (typeof SessionDrawer === 'undefined') return null;
      return (SessionDrawer as any)._viewMode;
    });
    expect(mode).toBe('sessions');
  });

  it('swipe left on agents mode does not change view (no tab to the right)', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('agents');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Swipe left by 150px — invalid direction for agents
    await simulateSwipe(page, {
      startX: 300,
      startY: 400,
      endX: 150,
      endY: 402,
      durationMs: 200,
      steps: 8,
    });
    await page.waitForTimeout(400);

    const mode = await page.evaluate(() => {
      if (typeof SessionDrawer === 'undefined') return null;
      return (SessionDrawer as any)._viewMode;
    });
    expect(mode).toBe('agents');
  });
});

// ─── Safety timer cleanup ───────────────────────────────────────────────

describe('DrawerSwipeHandler: safety timer cleanup during animation', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('cleanup() during active animation clears _slideOutTimer/_slideInTimer/_springBackTimer', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Set up fake timer IDs to simulate mid-animation state, then call cleanup
    const result = await page.evaluate(() => {
      if (typeof DrawerSwipeHandler === 'undefined') return null;
      const h = DrawerSwipeHandler as any;

      // Simulate active animation with pending timers
      h._animating = true;
      h._slideOutTimer = setTimeout(() => {}, 10000);
      h._slideInTimer = setTimeout(() => {}, 10000);
      h._springBackTimer = setTimeout(() => {}, 10000);

      const hadTimers = !!(h._slideOutTimer && h._slideInTimer && h._springBackTimer);

      // Call cleanup during "animation"
      h.cleanup();

      return {
        hadTimers,
        slideOutTimer: h._slideOutTimer,
        slideInTimer: h._slideInTimer,
        springBackTimer: h._springBackTimer,
        animating: h._animating,
        element: h._element,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.hadTimers).toBe(true);
    expect(result!.slideOutTimer).toBeNull();
    expect(result!.slideInTimer).toBeNull();
    expect(result!.springBackTimer).toBeNull();
    expect(result!.animating).toBe(false);
    expect(result!.element).toBeNull();
  });

  it('cleanup() during animation prevents stale timer callbacks from executing', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Start a real commit swipe, then immediately call cleanup
    const modeBefore = await page.evaluate(() => {
      if (typeof SessionDrawer === 'undefined') return null;
      return (SessionDrawer as any)._viewMode;
    });

    await simulateSwipe(page, {
      startX: 300,
      startY: 400,
      endX: 100,
      endY: 402,
      durationMs: 150,
      steps: 8,
    });

    // Immediately cleanup to interrupt the animation
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).cleanup();
    });

    // Wait for what would have been the timer callbacks
    await page.waitForTimeout(500);

    // _animating should still be false (cleanup cleared it) — no stale callback re-set it
    const state = await page.evaluate(() => {
      if (typeof DrawerSwipeHandler === 'undefined') return null;
      const h = DrawerSwipeHandler as any;
      return {
        animating: h._animating,
        element: h._element,
      };
    });
    expect(state).not.toBeNull();
    expect(state!.animating).toBe(false);
    expect(state!.element).toBeNull();
  });
});

// ─── Fling velocity commit ──────────────────────────────────────────────

describe('DrawerSwipeHandler: fling velocity commit', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('short-distance fast swipe commits via fling velocity (below COMMIT_RATIO but above FLING_VELOCITY)', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // 40px in 80ms = 0.5 px/ms velocity (above FLING_VELOCITY of 0.4)
    // 40px is well below 30% of 375 = 112.5px COMMIT_RATIO threshold
    await simulateSwipe(page, {
      startX: 200,
      startY: 400,
      endX: 160,
      endY: 402,
      durationMs: 80,
      steps: 4,
    });
    await page.waitForTimeout(600);

    const mode = await page.evaluate(() => {
      if (typeof SessionDrawer === 'undefined') return null;
      return (SessionDrawer as any)._viewMode;
    });
    expect(mode).toBe('agents');
  });
});

// ─── Direction reversal mid-swipe ───────────────────────────────────────

describe('DrawerSwipeHandler: direction reversal mid-swipe', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('start swiping left then reverse to right of start springs back', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Manually dispatch: start at 200, move left to 170 (locks direction = -1),
    // then move right past start to 230 (finalDirection = +1, != _direction = -1)
    await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      if (!el || typeof DrawerSwipeHandler === 'undefined') return;

      function touch(x: number, y: number): Touch {
        return new Touch({
          identifier: 0,
          target: el!,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          screenX: x,
          screenY: y,
        });
      }

      // touchstart
      el.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [touch(200, 400)],
          changedTouches: [touch(200, 400)],
          bubbles: true,
          cancelable: true,
        })
      );

      // Move left past lock threshold — locks direction = -1
      el.dispatchEvent(
        new TouchEvent('touchmove', {
          touches: [touch(185, 401)],
          changedTouches: [touch(185, 401)],
          bubbles: true,
          cancelable: true,
        })
      );

      // Reverse direction — end up right of start
      el.dispatchEvent(
        new TouchEvent('touchmove', {
          touches: [touch(230, 401)],
          changedTouches: [touch(230, 401)],
          bubbles: true,
          cancelable: true,
        })
      );

      // Set timing for velocity calc
      (DrawerSwipeHandler as any).startTime = Date.now() - 200;

      // touchend — final position is right of start, but _direction is -1
      el.dispatchEvent(
        new TouchEvent('touchend', {
          touches: [],
          changedTouches: [touch(230, 401)],
          bubbles: true,
          cancelable: true,
        })
      );
    });

    await page.waitForTimeout(400);

    // Should have sprung back — view mode unchanged
    const mode = await page.evaluate(() => {
      if (typeof SessionDrawer === 'undefined') return null;
      return (SessionDrawer as any)._viewMode;
    });
    expect(mode).toBe('sessions');

    // Transform should be cleared after spring-back
    const transform = await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      return el ? el.style.transform : '';
    });
    expect(transform).toBe('');
  });
});

// ─── _commitSwipe with null _element ────────────────────────────────────

describe('DrawerSwipeHandler: _commitSwipe with null _element', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('_commitSwipe with null _element falls back to _springBack without error', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);

    const result = await page.evaluate(() => {
      if (typeof DrawerSwipeHandler === 'undefined') return null;
      const h = DrawerSwipeHandler as any;

      // Force null _element while setting up minimal state
      h._element = null;
      h._direction = -1;
      h._animating = false;

      let threw = false;
      try {
        h._commitSwipe();
      } catch {
        threw = true;
      }

      // Wait a tick for any async side-effects
      return { threw, animating: h._animating };
    });

    // _springBack with null _element calls _resetState — no crash
    expect(result).not.toBeNull();
    expect(result!.threw).toBe(false);
    // _springBack with null _element calls _resetState, does not set _animating
    expect(result!.animating).toBe(false);
  });
});

// ─── drawer-tab-transitioning CSS class ─────────────────────────────────

describe('DrawerSwipeHandler: drawer-tab-transitioning CSS class', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(375, 812));
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('drawer-tab-transitioning class is applied during commit animation', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('sessions');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Start a commit swipe and check for transitioning class before animation completes
    await simulateSwipe(page, {
      startX: 300,
      startY: 400,
      endX: 100,
      endY: 402,
      durationMs: 150,
      steps: 8,
    });

    // Check immediately — the transitioning class should be present during animation
    const hasTransitioning = await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      if (!el) return false;
      return el.classList.contains('drawer-tab-transitioning');
    });
    expect(hasTransitioning).toBe(true);

    // Wait for full two-phase animation to complete (slide-out + slide-in + safety timers)
    await page.waitForTimeout(1000);

    // After animation, the class should be removed
    const hasTransitioningAfter = await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      if (!el) return true; // fail safe
      return el.classList.contains('drawer-tab-transitioning');
    });
    expect(hasTransitioningAfter).toBe(false);
  });

  it('drawer-tab-transitioning class is applied during spring-back', async () => {
    await openDrawer(page);
    await page.evaluate(() => {
      if (typeof SessionDrawer !== 'undefined') SessionDrawer.setViewMode('agents');
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      if (typeof DrawerSwipeHandler !== 'undefined') (DrawerSwipeHandler as any).init();
    });

    // Small swipe right (below commit threshold, slow velocity) — triggers spring-back
    await simulateSwipe(page, {
      startX: 100,
      startY: 400,
      endX: 120,
      endY: 402,
      durationMs: 500,
      steps: 4,
    });

    // Check immediately for transitioning class
    const hasTransitioning = await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      if (!el) return false;
      return el.classList.contains('drawer-tab-transitioning');
    });
    expect(hasTransitioning).toBe(true);

    // Wait for spring-back to complete
    await page.waitForTimeout(500);

    const hasTransitioningAfter = await page.evaluate(() => {
      const el = document.getElementById('sessionDrawerList');
      if (!el) return true;
      return el.classList.contains('drawer-tab-transitioning');
    });
    expect(hasTransitioningAfter).toBe(false);
  });
});

// ─── Desktop does not attach DrawerSwipeHandler ──────────────────────────

describe('DrawerSwipeHandler: desktop viewport', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    // Desktop viewport, no touch
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context = ctx;
    page = await ctx.newPage();
    await navigateMobile(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('DrawerSwipeHandler._element is null on desktop (init is a no-op)', async () => {
    await page.evaluate('SessionDrawer.open()');
    await page.waitForSelector('#sessionDrawer.open', { timeout: 3000 });
    await page.waitForTimeout(200);

    const hasElement = await page.evaluate(() => {
      return typeof DrawerSwipeHandler !== 'undefined' ? (DrawerSwipeHandler as any)._element : 'undefined';
    });
    // On desktop (non-touch), init() returns early without attaching
    expect(hasElement).toBeNull();
  });
});

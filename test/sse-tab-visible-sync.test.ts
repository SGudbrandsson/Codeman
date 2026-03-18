/**
 * SSE tab-visible sync tests
 *
 * Covers two fixes for the "sessions missed when tab backgrounded" bug:
 *
 * Fix 1 — `_lastSseEventTime` refresh in `_sseHandlerWrappers`:
 *   Named SSE events (e.g. `session:created`) now update `_lastSseEventTime`
 *   so staleness detection measures "time since last event" not "time since connect".
 *
 * Fix 2 — `loadState()` call in `_onTabVisible()`:
 *   When the tab becomes visible with SSE OPEN and not stale, `loadState()` is
 *   called to reconcile any events silently dropped by the browser while backgrounded.
 *   Guarded: skipped when `sseReconnectTimeout` is set (reconnect already pending).
 *
 * Port: 3214 (sse-tab-visible-sync tests)
 *
 * Run: npx vitest run test/sse-tab-visible-sync.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3214;
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
  // Allow SSE connection to stabilise
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

// ─── Fix 1: _lastSseEventTime is refreshed on named SSE event receipt ─────────

describe('Fix 1: _lastSseEventTime updated on named SSE event', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('app._lastSseEventTime is set after initial SSE connection', async () => {
    const ts = await page.evaluate(() => {
      const app = (window as any).app;
      return typeof app._lastSseEventTime === 'number' ? app._lastSseEventTime : null;
    });
    expect(ts).not.toBeNull();
    expect(ts).toBeGreaterThan(0);
  });

  it('_lastSseEventTime advances when a named SSE event (session:created) is dispatched', async () => {
    // Capture the timestamp immediately before dispatching the named event
    const tsBefore: number = await page.evaluate(() => {
      const app = (window as any).app;
      // Set to a known-old value so we can detect an update clearly
      app._lastSseEventTime = Date.now() - 10_000;
      return app._lastSseEventTime;
    });

    // Dispatch a `session:created` named event directly on the EventSource.
    // This is the same mechanism the server uses — the browser fires named
    // events via addEventListener(eventName, handler), not the generic `message`.
    await page.evaluate(() => {
      const app = (window as any).app;
      if (app.eventSource) {
        const event = new MessageEvent('session:created', {
          data: JSON.stringify({ id: 'test-fix1-' + Date.now(), name: 'fix1-test', workingDir: '/tmp' }),
        });
        app.eventSource.dispatchEvent(event);
      }
    });

    // Allow the handler to run (it is synchronous but give one tick)
    await page.waitForTimeout(100);

    const tsAfter: number = await page.evaluate(() => (window as any).app._lastSseEventTime);

    // The timestamp must have been refreshed to (approximately) now —
    // at minimum it must be strictly greater than the artificially old value.
    expect(tsAfter).toBeGreaterThan(tsBefore);
    // And it should be within 5 seconds of the current time (not stale)
    expect(Date.now() - tsAfter).toBeLessThan(5_000);
  });

  it('_lastSseEventTime is updated for other named events (session:deleted)', async () => {
    // Set an artificially old timestamp again
    await page.evaluate(() => {
      (window as any).app._lastSseEventTime = Date.now() - 20_000;
    });
    const tsBefore = Date.now() - 20_000;

    await page.evaluate(() => {
      const app = (window as any).app;
      if (app.eventSource) {
        const event = new MessageEvent('session:deleted', {
          data: JSON.stringify({ id: 'nonexistent-session-id' }),
        });
        app.eventSource.dispatchEvent(event);
      }
    });

    await page.waitForTimeout(100);

    const tsAfter: number = await page.evaluate(() => (window as any).app._lastSseEventTime);
    expect(tsAfter).toBeGreaterThan(tsBefore);
  });
});

// ─── Fix 2: loadState() called on tab-visible when SSE is healthy ─────────────

describe('Fix 2: _onTabVisible() calls loadState() when SSE is OPEN and not stale', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('_onTabVisible() method exists on app', async () => {
    const exists = await page.evaluate(() => typeof (window as any).app._onTabVisible === 'function');
    expect(exists).toBe(true);
  });

  it('loadState() is called when SSE is OPEN, not stale, and sseReconnectTimeout is null', async () => {
    // Instrument loadState to count invocations
    const loadStateCallsBefore: number = await page.evaluate(() => {
      const app = (window as any).app;
      if (typeof app._loadStateCallCount === 'undefined') {
        app._loadStateCallCount = 0;
        const original = app.loadState.bind(app);
        app.loadState = async function (...args: unknown[]) {
          app._loadStateCallCount++;
          return original(...args);
        };
      }
      return app._loadStateCallCount;
    });

    // Ensure SSE is OPEN, fresh, and no reconnect is pending
    await page.evaluate(() => {
      const app = (window as any).app;
      // Freshen the timestamp so the stale check passes
      app._lastSseEventTime = Date.now();
      // Clear any reconnect timeout so the guard allows loadState
      if (app.sseReconnectTimeout) {
        clearTimeout(app.sseReconnectTimeout);
        app.sseReconnectTimeout = null;
      }
    });

    // Simulate the tab becoming visible by calling _onTabVisible() directly
    // (document.visibilitychange is unreliable in headless Playwright when the
    // page is already in the foreground; direct invocation is equivalent.)
    await page.evaluate(() => {
      (window as any).app._onTabVisible();
    });

    // Allow the async loadState call to be counted
    await page.waitForTimeout(200);

    const loadStateCallsAfter: number = await page.evaluate(() => (window as any).app._loadStateCallCount);

    expect(loadStateCallsAfter).toBeGreaterThan(loadStateCallsBefore);
  });

  it('loadState() issues GET /api/status and reconciles state', async () => {
    // Verify that loadState() actually fetches /api/status
    const statusCalls: string[] = [];
    await page.route('**/api/status', async (route) => {
      statusCalls.push(route.request().url());
      await route.continue();
    });

    // Freshen the SSE state and invoke _onTabVisible
    await page.evaluate(() => {
      const app = (window as any).app;
      app._lastSseEventTime = Date.now();
      if (app.sseReconnectTimeout) {
        clearTimeout(app.sseReconnectTimeout);
        app.sseReconnectTimeout = null;
      }
    });

    await page.evaluate(() => {
      (window as any).app._onTabVisible();
    });

    // Wait for the fetch to occur
    await page.waitForTimeout(500);

    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    expect(statusCalls[0]).toContain('/api/status');

    // Remove the route intercept
    await page.unroute('**/api/status');
  });
});

// ─── Fix 2 edge case: loadState() NOT called when sseReconnectTimeout is set ──

describe('Fix 2 edge case: loadState() suppressed when reconnect is pending', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('loadState() is NOT called when sseReconnectTimeout is set', async () => {
    // Instrument loadState to count invocations
    await page.evaluate(() => {
      const app = (window as any).app;
      app._loadStateCallCountEdge = 0;
      const original = app.loadState.bind(app);
      app.loadState = async function (...args: unknown[]) {
        app._loadStateCallCountEdge++;
        return original(...args);
      };
    });

    // Ensure SSE appears OPEN and not stale, but set sseReconnectTimeout
    await page.evaluate(() => {
      const app = (window as any).app;
      app._lastSseEventTime = Date.now();
      // Simulate a pending reconnect by setting sseReconnectTimeout to a dummy timer
      if (!app.sseReconnectTimeout) {
        app._dummyReconnectTimer = setTimeout(() => {}, 60_000);
        app.sseReconnectTimeout = app._dummyReconnectTimer;
      }
    });

    // Call _onTabVisible() — the guard should block loadState()
    await page.evaluate(() => {
      (window as any).app._onTabVisible();
    });

    await page.waitForTimeout(200);

    const callCount: number = await page.evaluate(() => (window as any).app._loadStateCallCountEdge);
    expect(callCount).toBe(0);

    // Clean up the dummy timer so it doesn't affect other tests
    await page.evaluate(() => {
      const app = (window as any).app;
      if (app._dummyReconnectTimer) {
        clearTimeout(app._dummyReconnectTimer);
        app._dummyReconnectTimer = null;
      }
      app.sseReconnectTimeout = null;
    });
  });
});

/**
 * SSE session:working / session:idle isWorking sync tests.
 *
 * The fix adds `session.isWorking = true` in `_onSessionWorking` and
 * `session.isWorking = false` in `_onSessionIdle`. These tests dispatch
 * synthetic SSE events on the existing EventSource (following the same
 * pattern as test/sse-tab-visible-sync.test.ts) and verify that the
 * client-side session object's `isWorking` field is updated correctly.
 *
 * Port: 3220 (sse-session-working-sync tests)
 *
 * Run: npx vitest run test/sse-session-working-sync.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3220;
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

// ─── Helper: inject a fake session into the client sessions Map ───────────────

async function injectFakeSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id: string) => {
    const app = (window as any).app;
    // Insert a minimal session object so _onSessionWorking / _onSessionIdle can find it
    if (!app.sessions.has(id)) {
      app.sessions.set(id, {
        id,
        status: 'idle',
        isWorking: false,
        displayStatus: 'idle',
        name: 'test-session',
        workingDir: '/tmp',
      });
    }
  }, sessionId);
}

// ─── session:working sets session.isWorking = true ───────────────────────────

describe('session:working SSE sets session.isWorking to true', () => {
  let context: BrowserContext;
  let page: Page;
  const SESSION_ID = 'test-working-sync-' + Date.now();

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
    await injectFakeSession(page, SESSION_ID);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('session.isWorking is false before any SSE event', async () => {
    const isWorking = await page.evaluate((id: string) => {
      const app = (window as any).app;
      const session = app.sessions.get(id);
      return session ? session.isWorking : null;
    }, SESSION_ID);

    expect(isWorking).toBe(false);
  });

  it('session.isWorking becomes true after session:working SSE event', async () => {
    // Dispatch a session:working event directly on the EventSource
    await page.evaluate((id: string) => {
      const app = (window as any).app;
      if (app.eventSource) {
        const event = new MessageEvent('session:working', {
          data: JSON.stringify({ id }),
        });
        app.eventSource.dispatchEvent(event);
      }
    }, SESSION_ID);

    await page.waitForTimeout(100);

    const isWorking = await page.evaluate((id: string) => {
      const app = (window as any).app;
      const session = app.sessions.get(id);
      return session ? session.isWorking : null;
    }, SESSION_ID);

    expect(isWorking).toBe(true);
  });

  it('session.status is also set to busy after session:working SSE event', async () => {
    const status = await page.evaluate((id: string) => {
      const app = (window as any).app;
      const session = app.sessions.get(id);
      return session ? session.status : null;
    }, SESSION_ID);

    expect(status).toBe('busy');
  });
});

// ─── session:idle sets session.isWorking = false ─────────────────────────────

describe('session:idle SSE sets session.isWorking to false', () => {
  let context: BrowserContext;
  let page: Page;
  const SESSION_ID = 'test-idle-sync-' + Date.now();

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
    await injectFakeSession(page, SESSION_ID);

    // Start the session in a working state
    await page.evaluate((id: string) => {
      const app = (window as any).app;
      const session = app.sessions.get(id);
      if (session) {
        session.isWorking = true;
        session.status = 'busy';
      }
    }, SESSION_ID);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('session.isWorking is true before idle SSE event (precondition)', async () => {
    const isWorking = await page.evaluate((id: string) => {
      const app = (window as any).app;
      const session = app.sessions.get(id);
      return session ? session.isWorking : null;
    }, SESSION_ID);

    expect(isWorking).toBe(true);
  });

  it('session.isWorking becomes false after session:idle SSE event', async () => {
    await page.evaluate((id: string) => {
      const app = (window as any).app;
      if (app.eventSource) {
        const event = new MessageEvent('session:idle', {
          data: JSON.stringify({ id }),
        });
        app.eventSource.dispatchEvent(event);
      }
    }, SESSION_ID);

    await page.waitForTimeout(100);

    const isWorking = await page.evaluate((id: string) => {
      const app = (window as any).app;
      const session = app.sessions.get(id);
      return session ? session.isWorking : null;
    }, SESSION_ID);

    expect(isWorking).toBe(false);
  });

  it('session.status is also set to idle after session:idle SSE event', async () => {
    const status = await page.evaluate((id: string) => {
      const app = (window as any).app;
      const session = app.sessions.get(id);
      return session ? session.status : null;
    }, SESSION_ID);

    expect(status).toBe('idle');
  });
});

// ─── isWorking toggles correctly through working → idle → working cycle ───────

describe('session.isWorking tracks full working/idle cycle', () => {
  let context: BrowserContext;
  let page: Page;
  const SESSION_ID = 'test-cycle-sync-' + Date.now();

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
    await injectFakeSession(page, SESSION_ID);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('isWorking cycles false → true → false across working and idle events', async () => {
    // Helper to dispatch an SSE event
    const dispatch = async (eventName: string) => {
      await page.evaluate(
        ([name, id]: [string, string]) => {
          const app = (window as any).app;
          if (app.eventSource) {
            const event = new MessageEvent(name, {
              data: JSON.stringify({ id }),
            });
            app.eventSource.dispatchEvent(event);
          }
        },
        [eventName, SESSION_ID]
      );
      await page.waitForTimeout(50);
    };

    const getIsWorking = () =>
      page.evaluate((id: string) => {
        const app = (window as any).app;
        const session = app.sessions.get(id);
        return session ? session.isWorking : null;
      }, SESSION_ID);

    // Initial state
    expect(await getIsWorking()).toBe(false);

    // Transition to working
    await dispatch('session:working');
    expect(await getIsWorking()).toBe(true);

    // Transition back to idle
    await dispatch('session:idle');
    expect(await getIsWorking()).toBe(false);

    // Transition to working again
    await dispatch('session:working');
    expect(await getIsWorking()).toBe(true);
  });
});

/**
 * Busy indicator session-switch race condition tests.
 *
 * Covers three race conditions fixed in app.js:
 *
 * RC-1: _onSessionUpdated debounce-timer preservation
 *   - session:updated arriving while a show-timer (300ms) is pending must force
 *     displayStatus='busy' so the in-flight debounce is not clobbered.
 *   - session:updated arriving while a hide-timer (4s) is pending and old
 *     displayStatus was 'busy' must preserve 'busy' (no premature idle stamp).
 *
 * RC-2: selectSession reads (displayStatus ?? status) not raw status
 *   - switching to a session where displayStatus='idle' but status='busy' must
 *     call TranscriptView.setWorking(false), not setWorking(true).
 *   - fallback: displayStatus undefined → raw status is used.
 *
 * RC-3: _isLoadingBuffer guard hoisted to immediately after activeSessionId update
 *   - OSC-133 sequences arriving during buffer replay after a session switch are
 *     silently ignored (no false-busy on the newly-active session).
 *
 * Port: 3221 (busy-indicator-session-switch tests)
 *
 * Run: npx vitest run test/busy-indicator-session-switch.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3221;
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

async function injectFakeSession(
  page: Page,
  sessionId: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await page.evaluate(
    ([id, extra]: [string, Record<string, unknown>]) => {
      const app = (window as any).app;
      if (!app.sessions.has(id)) {
        app.sessions.set(id, {
          id,
          status: 'idle',
          isWorking: false,
          displayStatus: 'idle',
          name: 'test-session',
          workingDir: '/tmp',
          ...extra,
        });
      }
    },
    [sessionId, overrides]
  );
}

async function dispatchSseEvent(page: Page, eventName: string, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ([name, data]: [string, string]) => {
      const app = (window as any).app;
      if (app.eventSource) {
        const event = new MessageEvent(name, { data });
        app.eventSource.dispatchEvent(event);
      }
    },
    [eventName, JSON.stringify(payload)]
  );
}

// ─── RC-1: show-timer pending → session:updated must stamp 'busy' ─────────────

describe('RC-1: session:updated during 300ms show-timer preserves busy displayStatus', () => {
  let context: BrowserContext;
  let page: Page;
  const SESSION_ID = 'rc1-show-timer-' + Date.now();

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
    await injectFakeSession(page, SESSION_ID);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('displayStatus becomes busy after session:updated arrives while show-timer is pending', async () => {
    // Step 1: dispatch session:working to start the 300ms show-timer
    await dispatchSseEvent(page, 'session:working', { id: SESSION_ID });

    // Step 2: immediately (within 300ms window) dispatch session:updated with status='idle'
    // This simulates the server sending a status snapshot that has not yet caught up to the
    // working state. RC-1 fix must detect the pending show-timer and force displayStatus='busy'.
    const sessionSnapshot = {
      id: SESSION_ID,
      status: 'idle', // server snapshot lags — raw status still 'idle'
      name: 'test-session',
      workingDir: '/tmp',
    };
    await dispatchSseEvent(page, 'session:updated', { session: sessionSnapshot });

    // No need to wait for the 300ms timer to fire — we only check that the
    // _onSessionUpdated handler preserved 'busy' immediately.
    await page.waitForTimeout(50);

    const displayStatus = await page.evaluate((id: string) => {
      const app = (window as any).app;
      return app.sessions.get(id)?.displayStatus ?? null;
    }, SESSION_ID);

    expect(displayStatus).toBe('busy');
  });
});

// ─── RC-1: hide-timer pending → session:updated must not prematurely idle ─────

describe('RC-1: session:updated during 4s hide-timer preserves busy displayStatus', () => {
  let context: BrowserContext;
  let page: Page;
  const SESSION_ID = 'rc1-hide-timer-' + Date.now();

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
    // Inject session already in busy/displayStatus='busy' state
    await injectFakeSession(page, SESSION_ID, { status: 'busy', displayStatus: 'busy' });
  });

  afterAll(async () => {
    await context?.close();
  });

  it('displayStatus stays busy after session:updated arrives while hide-timer is pending', async () => {
    // Step 1: trigger session:idle to start the 4s hide-timer (displayStatus remains 'busy'
    // until the timer fires).
    await dispatchSseEvent(page, 'session:idle', { id: SESSION_ID });

    // Step 2: immediately dispatch session:updated — RC-1 hide-timer branch must detect the
    // pending hide-timer and keep displayStatus='busy' rather than stamping 'idle'.
    const sessionSnapshot = {
      id: SESSION_ID,
      status: 'idle',
      name: 'test-session',
      workingDir: '/tmp',
    };
    await dispatchSseEvent(page, 'session:updated', { session: sessionSnapshot });

    await page.waitForTimeout(50);

    const displayStatus = await page.evaluate((id: string) => {
      const app = (window as any).app;
      return app.sessions.get(id)?.displayStatus ?? null;
    }, SESSION_ID);

    // The hide-timer is still counting (4s); displayStatus must not have been reset to 'idle'
    expect(displayStatus).toBe('busy');
  });
});

// ─── RC-2: selectSession uses displayStatus ?? status ─────────────────────────

describe('RC-2: selectSession reads displayStatus rather than raw status', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('switching to session with displayStatus=idle but status=busy calls setWorking(false)', async () => {
    // Create a real session so selectSession() has a valid target
    const targetId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'rc2-target' }),
      });
      const data = await res.json();
      return (data.id ?? data.session?.id) as string;
    });

    // Patch the session in the client map: displayStatus='idle', status='busy'
    // This is the scenario where OSC-133 set status='busy' on a background session
    // but the debounce hide-timer has already settled displayStatus to 'idle'.
    await page.evaluate((id: string) => {
      const app = (window as any).app;
      const s = app.sessions.get(id);
      if (s) {
        s.status = 'busy';
        s.displayStatus = 'idle';
      }
    }, targetId);

    // Track setWorking calls on TranscriptView
    await page.evaluate((id: string) => {
      const tv = (window as any).TranscriptView;
      if (!tv) return;
      tv._testSetWorkingCalls = [];
      const orig = tv.setWorking.bind(tv);
      tv.setWorking = (val: boolean) => {
        tv._testSetWorkingCalls.push(val);
        orig(val);
      };
      // Make TranscriptView think it's showing this session
      tv._sessionId = id;
    }, targetId);

    // Switch to the target session
    await page.evaluate((id: string) => {
      (window as any).app.selectSession(id);
    }, targetId);

    await page.waitForTimeout(300);

    // RC-2: because displayStatus='idle' (not 'busy'), setWorking must have been called
    // with false (not true).
    const calls = await page.evaluate(() => {
      return (window as any).TranscriptView?._testSetWorkingCalls ?? [];
    });

    // The first call made by selectSession for this session must be false
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBe(false);
  });

  it('selectSession falls back to raw status when displayStatus is undefined', async () => {
    // Create a second session with no displayStatus set
    const targetId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'rc2-fallback' }),
      });
      const data = await res.json();
      return (data.id ?? data.session?.id) as string;
    });

    // Remove displayStatus so fallback logic must use raw status
    await page.evaluate((id: string) => {
      const app = (window as any).app;
      const s = app.sessions.get(id);
      if (s) {
        delete s.displayStatus;
        s.status = 'idle';
      }
    }, targetId);

    await page.evaluate((id: string) => {
      const tv = (window as any).TranscriptView;
      if (!tv) return;
      tv._testSetWorkingCalls = [];
      const orig = tv.setWorking.bind(tv);
      tv.setWorking = (val: boolean) => {
        tv._testSetWorkingCalls.push(val);
        orig(val);
      };
      tv._sessionId = id;
    }, targetId);

    await page.evaluate((id: string) => {
      (window as any).app.selectSession(id);
    }, targetId);

    await page.waitForTimeout(300);

    const calls = await page.evaluate(() => {
      return (window as any).TranscriptView?._testSetWorkingCalls ?? [];
    });

    // With displayStatus undefined and status='idle', should call setWorking(false)
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBe(false);
  });
});

// ─── RC-3: _isLoadingBuffer guard blocks OSC-133 during buffer replay ─────────

describe('RC-3: OSC-133 during buffer replay after session switch is ignored', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('_onOsc133 is a no-op while _isLoadingBuffer is true', async () => {
    // Create a real session to switch to
    const targetId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'rc3-osc133' }),
      });
      const data = await res.json();
      return (data.id ?? data.session?.id) as string;
    });

    // Set up the session as idle so we can observe any change
    await page.evaluate((id: string) => {
      const app = (window as any).app;
      const s = app.sessions.get(id);
      if (s) {
        s.status = 'idle';
        s.displayStatus = 'idle';
      }
    }, targetId);

    // Manually set _isLoadingBuffer=true (simulates the moment right after selectSession
    // updates activeSessionId but before buffer replay completes) and fire _onOsc133('C')
    // which is the "pre-execution / busy" signal.
    const displayStatusAfter = await page.evaluate((id: string) => {
      const app = (window as any).app;
      // Simulate the state at the point RC-3 guards: activeSessionId set, buffer loading
      app.activeSessionId = id;
      app._isLoadingBuffer = true;

      // Fire OSC-133 'C' (pre-execution busy signal) — RC-3 must make this a no-op
      app._onOsc133('C');

      // Return displayStatus: if the guard works it must still be 'idle'
      return app.sessions.get(id)?.displayStatus ?? null;
    }, targetId);

    expect(displayStatusAfter).toBe('idle');
  });
});

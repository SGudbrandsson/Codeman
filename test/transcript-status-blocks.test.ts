/**
 * Transcript Status Blocks — functional test suite
 *
 * Tests the #tv-live-status-wrapper injection/removal behaviour added by the
 * transcript-status-blocks feature.  Because the wrapper requires live task/agent
 * state that is hard to simulate end-to-end in a Playwright test, the suite is
 * split into two tiers:
 *
 * Tier 1 — Static / CSS smoke tests (no backend state required):
 *   • All CSS classes defined in styles.css (.tv-live-block, .tv-live-block--tasks,
 *     .tv-live-block--agents, .tv-live-row, .tv-live-gradient, …)
 *   • #tv-live-status-wrapper is absent by default (no tasks running)
 *   • app.renderTranscriptStatusBlocks is a callable function
 *
 * Tier 2 — DOM injection via direct app state manipulation:
 *   • Wrapper injection: calling renderTranscriptStatusBlocks with a session whose
 *     taskStats.running > 0 creates #tv-live-status-wrapper inside #transcriptView
 *   • Wrapper removal: clearing taskStats.running back to 0 removes the wrapper
 *   • Session-switch-away (TranscriptView.hide) removes the wrapper immediately
 *   • Session-switch-back (TranscriptView.show → renderTranscriptStatusBlocks)
 *     restores the wrapper when tasks are still running
 *   • Background session event does NOT remove the visible session's wrapper
 *
 * Port: 3225
 *
 * Run: npx vitest run test/transcript-status-blocks.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3225;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

let server: WebServer;
let browser: Browser;

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  return { context, page };
}

async function navigateTo(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 8000 });
  await page.waitForTimeout(500);
}

async function createSession(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-status-blocks' }),
    });
    const data = await res.json();
    return (data.id ?? data.session?.id) as string;
  });
  return id;
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { app: { selectSession: (id: string) => void } }).app.selectSession(id);
  }, sessionId);
  await page.waitForTimeout(800);
}

async function deleteSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await fetch('/api/sessions/' + id, { method: 'DELETE' });
  }, sessionId);
}

/**
 * Inject fake taskStats into a session object in app.sessions and call
 * renderTranscriptStatusBlocks so that the wrapper appears/disappears.
 */
async function setTaskStats(
  page: Page,
  sessionId: string,
  stats: { running: number; completed?: number; failed?: number; total?: number },
  taskTree?: Array<{ id: string; description: string; status: string; startTime: number; endTime?: number }>
): Promise<void> {
  await page.evaluate(
    ({ sid, s, tree }) => {
      const a = (
        window as unknown as {
          app: {
            sessions: Map<string, { taskStats: typeof s; taskTree: typeof tree }>;
            renderTranscriptStatusBlocks: (id: string) => void;
          };
        }
      ).app;
      const session = a.sessions.get(sid);
      if (session) {
        session.taskStats = s;
        session.taskTree = tree ?? [];
      }
      a.renderTranscriptStatusBlocks(sid);
    },
    { sid: sessionId, s: stats, tree: taskTree }
  );
  await page.waitForTimeout(200);
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Tier 1: CSS smoke tests ─────────────────────────────────────────────────

describe('CSS smoke — all required .tv-live-* classes are defined in the stylesheet', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  const expectedClasses = [
    '#tv-live-status-wrapper',
    '.tv-live-gradient',
    '.tv-live-block',
    '.tv-live-block--tasks',
    '.tv-live-block--agents',
    '.tv-live-block--todos',
    '.tv-live-header',
    '.tv-live-rows',
    '.tv-live-row',
    '.tv-live-row--running',
    '.tv-live-row--done',
    '.tv-live-row--failed',
    '.tv-live-row-name',
  ];

  for (const selector of expectedClasses) {
    it(`${selector} rule exists in a loaded stylesheet`, async () => {
      const found = await page.evaluate((sel) => {
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            const rules = Array.from(sheet.cssRules ?? []);
            if (rules.some((r) => r instanceof CSSStyleRule && r.selectorText === sel)) {
              return true;
            }
          } catch {
            // cross-origin sheet — skip
          }
        }
        return false;
      }, selector);
      expect(found, `Expected CSS rule for "${selector}" to be present`).toBe(true);
    });
  }
});

describe('CSS smoke — #tv-live-status-wrapper is absent on initial load (no tasks running)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('#tv-live-status-wrapper does not exist in the DOM when no session is selected', async () => {
    const count = await page.locator('#tv-live-status-wrapper').count();
    expect(count).toBe(0);
  });
});

describe('CSS smoke — app.renderTranscriptStatusBlocks is a callable function', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('app.renderTranscriptStatusBlocks is a function', async () => {
    const isFunction = await page.evaluate(() => {
      return (
        typeof (window as unknown as { app: { renderTranscriptStatusBlocks: unknown } }).app
          .renderTranscriptStatusBlocks === 'function'
      );
    });
    expect(isFunction).toBe(true);
  });
});

// ─── Tier 2: DOM injection tests ─────────────────────────────────────────────

describe('Wrapper injection — #tv-live-status-wrapper appears when taskStats.running > 0', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    // Inject a running task so renderTranscriptStatusBlocks creates the wrapper
    await setTaskStats(page, sessionId, { running: 1, completed: 0, failed: 0, total: 1 }, [
      { id: 'task-1', description: 'Write auth middleware', status: 'running', startTime: Date.now() - 5000 },
    ]);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#tv-live-status-wrapper is injected inside #transcriptView', async () => {
    const isInsideTranscript = await page.evaluate(() => {
      const container = document.getElementById('transcriptView');
      const wrapper = document.getElementById('tv-live-status-wrapper');
      return wrapper !== null && wrapper.closest('#transcriptView') !== null && container !== null;
    });
    expect(isInsideTranscript).toBe(true);
  });

  it('#tv-live-tasks block is present inside the wrapper', async () => {
    const count = await page.locator('#transcriptView #tv-live-tasks').count();
    expect(count).toBeGreaterThan(0);
  });

  it('a .tv-live-row--running row is rendered for the running task', async () => {
    const count = await page.locator('#transcriptView .tv-live-row--running').count();
    expect(count).toBeGreaterThan(0);
  });
});

describe('Wrapper removal — #tv-live-status-wrapper is removed when taskStats.running drops to 0', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    // First inject the wrapper
    await setTaskStats(page, sessionId, { running: 1, completed: 0, failed: 0, total: 1 }, [
      { id: 'task-1', description: 'Write auth middleware', status: 'running', startTime: Date.now() - 5000 },
    ]);

    // Now clear all running tasks
    await setTaskStats(page, sessionId, { running: 0, completed: 1, failed: 0, total: 1 }, [
      {
        id: 'task-1',
        description: 'Write auth middleware',
        status: 'completed',
        startTime: Date.now() - 5000,
        endTime: Date.now(),
      },
    ]);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#tv-live-status-wrapper is removed from the DOM when running drops to 0', async () => {
    const count = await page.locator('#tv-live-status-wrapper').count();
    expect(count).toBe(0);
  });
});

describe('Session-switch-away — TranscriptView.hide removes the wrapper immediately', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    // Inject wrapper
    await setTaskStats(page, sessionId, { running: 1, completed: 0, failed: 0, total: 1 }, [
      { id: 'task-1', description: 'Write auth middleware', status: 'running', startTime: Date.now() - 5000 },
    ]);

    // Simulate session switch away by calling TranscriptView.hide directly
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { hide: () => void } }).TranscriptView.hide();
    });
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#tv-live-status-wrapper is removed after TranscriptView.hide()', async () => {
    const count = await page.locator('#tv-live-status-wrapper').count();
    expect(count).toBe(0);
  });
});

describe('Session-switch-back — wrapper is restored when tasks are still running', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    // Inject wrapper (task still running)
    await setTaskStats(page, sessionId, { running: 1, completed: 0, failed: 0, total: 1 }, [
      { id: 'task-1', description: 'Write auth middleware', status: 'running', startTime: Date.now() - 5000 },
    ]);

    // Switch away
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { hide: () => void } }).TranscriptView.hide();
    });
    await page.waitForTimeout(200);

    // Switch back — selectSession calls TranscriptView.show which calls renderTranscriptStatusBlocks.
    // In the real app, session.taskStats persists via SSE regardless of which session is visible.
    // In tests there is no live SSE, so we verify the data persists across the switch-back by
    // calling renderTranscriptStatusBlocks explicitly after selectSession (simulating what would
    // happen when the first SESSION_UPDATED SSE fires after switching back).
    await selectSession(page, sessionId);
    await page.evaluate((sid) => {
      (
        window as unknown as { app: { renderTranscriptStatusBlocks: (id: string) => void } }
      ).app.renderTranscriptStatusBlocks(sid);
    }, sessionId);
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#tv-live-status-wrapper is restored after switching back to session with running tasks', async () => {
    const count = await page.locator('#transcriptView #tv-live-status-wrapper').count();
    expect(count).toBeGreaterThan(0);
  });
});

describe('Background session — renderTranscriptStatusBlocks for a background session does not destroy visible session wrapper', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionA: string;
  let sessionB: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);

    sessionA = await createSession(page);
    sessionB = await createSession(page);

    // Select session A as the visible session
    await selectSession(page, sessionA);

    // Inject wrapper for session A (running task)
    await setTaskStats(page, sessionA, { running: 1, completed: 0, failed: 0, total: 1 }, [
      { id: 'task-a', description: 'Session A task', status: 'running', startTime: Date.now() - 3000 },
    ]);

    // Simulate a background SSE event for session B by calling renderTranscriptStatusBlocks
    // with session B's id while session A is still the visible session.
    // Session B has running tasks — the guard must return early without touching session A's wrapper.
    await page.evaluate(
      ({ sid }) => {
        const a = (
          window as unknown as {
            app: {
              sessions: Map<string, { taskStats: { running: number }; taskTree: unknown[] }>;
              renderTranscriptStatusBlocks: (id: string) => void;
            };
          }
        ).app;
        const session = a.sessions.get(sid);
        if (session) {
          session.taskStats = { running: 1 };
          session.taskTree = [];
        }
        a.renderTranscriptStatusBlocks(sid);
      },
      { sid: sessionB }
    );
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionA);
    await deleteSession(page, sessionB);
    await context?.close();
  });

  it('#tv-live-status-wrapper still exists for session A after a background session B event', async () => {
    const count = await page.locator('#transcriptView #tv-live-status-wrapper').count();
    expect(count).toBeGreaterThan(0);
  });

  it('TranscriptView._sessionId is still session A (no session switch occurred)', async () => {
    const currentSessionId = await page.evaluate(() => {
      return (window as unknown as { TranscriptView: { _sessionId: string } }).TranscriptView._sessionId;
    });
    expect(currentSessionId).toBe(sessionA);
  });
});

// ─── Gap 2: Todos block appears when ralphStates has todos ────────────────────

describe('Todos block — #tv-live-todos appears when ralphStates has todos', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    // Inject todos via ralphStates and call renderTranscriptStatusBlocks
    await page.evaluate(
      ({ sid }) => {
        const a = (
          window as unknown as {
            app: {
              ralphStates: Map<string, { loop: null; todos: Array<{ content: string; status: string }> }>;
              renderTranscriptStatusBlocks: (id: string) => void;
            };
          }
        ).app;
        a.ralphStates.set(sid, {
          loop: null,
          todos: [
            { content: 'Write unit tests', status: 'in_progress' },
            { content: 'Review PR', status: 'pending' },
            { content: 'Deploy to staging', status: 'completed' },
          ],
        });
        a.renderTranscriptStatusBlocks(sid);
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#tv-live-todos is injected inside #transcriptView', async () => {
    const isInsideTranscript = await page.evaluate(() => {
      const wrapper = document.getElementById('tv-live-todos');
      return wrapper !== null && wrapper.closest('#transcriptView') !== null;
    });
    expect(isInsideTranscript).toBe(true);
  });

  it('in_progress todo is rendered with the ◐ symbol (tv-live-row--running)', async () => {
    const count = await page.locator('#tv-live-todos .tv-live-row--running').count();
    expect(count).toBeGreaterThan(0);
  });

  it('pending todo is rendered with the ○ symbol (plain tv-live-row)', async () => {
    const text = await page.locator('#tv-live-todos .tv-live-rows').innerText();
    expect(text).toContain('○');
  });

  it('completed todo is rendered with the ✓ symbol (tv-live-row--done)', async () => {
    const count = await page.locator('#tv-live-todos .tv-live-row--done').count();
    expect(count).toBeGreaterThan(0);
  });
});

// ─── Gap 3: hasTodos keeps wrapper alive when no tasks are running ────────────

describe('hasTodos — wrapper persists when taskStats.running is 0 but todos are non-empty', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    // Set taskStats.running = 0 (no running tasks) but provide todos
    await page.evaluate(
      ({ sid }) => {
        const a = (
          window as unknown as {
            app: {
              sessions: Map<
                string,
                {
                  taskStats: { running: number; completed: number; failed: number; total: number };
                  taskTree: unknown[];
                }
              >;
              ralphStates: Map<string, { loop: null; todos: Array<{ content: string; status: string }> }>;
              renderTranscriptStatusBlocks: (id: string) => void;
            };
          }
        ).app;
        const session = a.sessions.get(sid);
        if (session) {
          session.taskStats = { running: 0, completed: 0, failed: 0, total: 0 };
          session.taskTree = [];
        }
        a.ralphStates.set(sid, {
          loop: null,
          todos: [{ content: 'Pending task', status: 'pending' }],
        });
        a.renderTranscriptStatusBlocks(sid);
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#tv-live-status-wrapper remains in the DOM when todos are present even though no tasks are running', async () => {
    const count = await page.locator('#transcriptView #tv-live-status-wrapper').count();
    expect(count).toBeGreaterThan(0);
  });

  it('#tv-live-todos is present inside the wrapper', async () => {
    const count = await page.locator('#transcriptView #tv-live-todos').count();
    expect(count).toBeGreaterThan(0);
  });
});

// ─── Gap 4: _onRalphTodoUpdate triggers transcript re-render (SSE path) ───────

describe('_onRalphTodoUpdate — calling the SSE handler creates #tv-live-todos in the transcript overlay', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await selectSession(page, sessionId);

    // Simulate the SSE path by calling _onRalphTodoUpdate directly with a valid payload
    await page.evaluate(
      ({ sid }) => {
        const a = (
          window as unknown as {
            app: {
              _onRalphTodoUpdate: (data: {
                sessionId: string;
                todos: Array<{ content: string; status: string }>;
              }) => void;
            };
          }
        ).app;
        a._onRalphTodoUpdate({
          sessionId: sid,
          todos: [
            { content: 'Implement feature', status: 'in_progress' },
            { content: 'Write tests', status: 'pending' },
          ],
        });
      },
      { sid: sessionId }
    );
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#tv-live-todos appears in the transcript overlay after _onRalphTodoUpdate', async () => {
    const count = await page.locator('#transcriptView #tv-live-todos').count();
    expect(count).toBeGreaterThan(0);
  });

  it('#tv-live-status-wrapper is created after _onRalphTodoUpdate', async () => {
    const count = await page.locator('#transcriptView #tv-live-status-wrapper').count();
    expect(count).toBeGreaterThan(0);
  });
});

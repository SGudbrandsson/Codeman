/**
 * InputPanel._loadDraft race-condition tests
 *
 * Tests the five gaps identified in the test gap analysis for the
 * fix/input-swallowed-while-typing branch:
 *
 * 1. Race 1 guard: _loadDraft called when textarea has text → value unchanged
 * 2. Race 1 side-effect: in-progress text saved to _drafts for new session id
 * 3. Race 2 valueAfterLocal guard: slow fetch + type after local restore → server NOT applied
 * 4. Happy path: empty textarea + local cache present → textarea set to cached text
 * 5. Server draft applied when no local cache and textarea still empty after fetch
 *
 * Port: 3230
 *
 * Run: npx vitest run test/input-draft-race.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3230;
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
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-draft-race' }),
    });
    const data = await res.json();
    return (data.id ?? data.session?.id) as string;
  });
  return id;
}

async function deleteSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await fetch('/api/sessions/' + id, { method: 'DELETE' });
  }, sessionId);
}

/** Mock the GET /api/sessions/:id/draft endpoint to return a controlled response. */
async function mockDraftEndpoint(
  page: Page,
  sessionId: string,
  response: { text?: string; imagePaths?: string[] },
  delayMs = 0
): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/draft`, async (route) => {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}

/** Mock draft endpoint to return 404 (no server draft). */
async function mockDraftEndpointNotFound(page: Page, sessionId: string): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/draft`, (route) => {
    route.fulfill({ status: 404, body: 'Not Found' });
  });
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

// ─── Gap 1: Race 1 guard — textarea non-empty → value preserved ──────────────

describe('Race 1 guard — _loadDraft does not clear textarea when user is mid-type', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);

    // Mock the draft endpoint to return 404 so no server draft interferes
    await mockDraftEndpointNotFound(page, sessionId);

    // Set textarea to simulate user mid-type, then call _loadDraft for this session
    await page.evaluate(async (sid) => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      if (ta) ta.value = 'user is typing this';
      const ip = (window as unknown as { InputPanel: { _loadDraft: (id: string) => Promise<void> } }).InputPanel;
      await ip._loadDraft(sid);
    }, sessionId);

    // Allow any async tails to settle
    await page.waitForTimeout(300);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('textarea value is unchanged after _loadDraft resolves when user was mid-type', async () => {
    const value = await page.evaluate(() => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      return ta ? ta.value : null;
    });
    expect(value).toBe('user is typing this');
  });
});

// ─── Gap 2: Race 1 side-effect — in-progress text saved to _drafts ───────────

describe('Race 1 side-effect — in-progress text is saved to _drafts for new session id', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);

    await mockDraftEndpointNotFound(page, sessionId);

    // Set textarea to simulate in-progress typing, then call _loadDraft
    await page.evaluate(async (sid) => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      if (ta) ta.value = 'save me to drafts';
      const ip = (window as unknown as { InputPanel: { _loadDraft: (id: string) => Promise<void> } }).InputPanel;
      await ip._loadDraft(sid);
    }, sessionId);

    await page.waitForTimeout(300);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('_drafts.get(newSessionId).text equals the in-progress text from the textarea', async () => {
    const draftText = await page.evaluate((sid) => {
      const ip = (window as unknown as { InputPanel: { _drafts: Map<string, { text: string }> } }).InputPanel;
      return ip._drafts.get(sid)?.text ?? null;
    }, sessionId);
    expect(draftText).toBe('save me to drafts');
  });
});

// ─── Gap 3: Race 2 valueAfterLocal guard — slow fetch + typing wins ───────────

describe('Race 2 guard — server draft NOT applied when user types after local-cache restore', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);

    // Mock a slow fetch (300ms) that returns a server draft
    await mockDraftEndpoint(page, sessionId, { text: 'SERVER DRAFT — should not appear' }, 300);

    // Start _loadDraft (textarea is empty, no local cache) — don't await yet.
    // Then simulate the user typing while the fetch is in-flight.
    // We do both inside page.evaluate so timing is controlled.
    await page.evaluate(async (sid) => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      if (!ta) return;
      // Ensure textarea is empty and no local cache entry
      ta.value = '';
      const ip = (
        window as unknown as {
          InputPanel: {
            _loadDraft: (id: string) => Promise<void>;
            _drafts: Map<string, unknown>;
          };
        }
      ).InputPanel;
      ip._drafts.delete(sid);

      // Start the load (don't await — let it run in background)
      const loadPromise = ip._loadDraft(sid);

      // After a short delay (50ms), simulate the user typing something
      await new Promise<void>((r) => setTimeout(r, 50));
      ta.value = 'typed by user during fetch';

      // Wait for loadDraft to finish
      await loadPromise;
    }, sessionId);

    await page.waitForTimeout(100);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('textarea retains user-typed text, not the server draft value', async () => {
    const value = await page.evaluate(() => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      return ta ? ta.value : null;
    });
    expect(value).toBe('typed by user during fetch');
  });

  it('textarea does NOT contain the server draft text', async () => {
    const value = await page.evaluate(() => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      return ta ? ta.value : null;
    });
    expect(value).not.toContain('SERVER DRAFT');
  });
});

// ─── Gap 4: Happy path — empty textarea + local cache → restored ──────────────

describe('Happy path — empty textarea with local cache entry gets restored', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);

    // Mock draft endpoint to return 404 (no server draft — only local cache matters)
    await mockDraftEndpointNotFound(page, sessionId);

    await page.evaluate(async (sid) => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      if (!ta) return;
      // Ensure textarea is empty
      ta.value = '';

      const ip = (
        window as unknown as {
          InputPanel: {
            _loadDraft: (id: string) => Promise<void>;
            _drafts: Map<string, { text: string; imagePaths: string[] }>;
          };
        }
      ).InputPanel;

      // Pre-populate local cache for this session
      ip._drafts.set(sid, { text: 'cached draft text', imagePaths: [] });

      // Call _loadDraft — should restore from local cache
      await ip._loadDraft(sid);
    }, sessionId);

    await page.waitForTimeout(300);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('textarea value is set to the local cache text after _loadDraft resolves', async () => {
    const value = await page.evaluate(() => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      return ta ? ta.value : null;
    });
    expect(value).toBe('cached draft text');
  });
});

// ─── Gap 5: Server draft applied when no local cache + textarea still empty ───

describe('Server draft applied — no local cache, empty textarea, fetch returns data', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);

    // Mock a fast server draft response
    await mockDraftEndpoint(page, sessionId, { text: 'server restored draft', imagePaths: [] });

    await page.evaluate(async (sid) => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      if (!ta) return;
      // Ensure textarea is empty and no local cache
      ta.value = '';
      const ip = (
        window as unknown as {
          InputPanel: {
            _loadDraft: (id: string) => Promise<void>;
            _drafts: Map<string, unknown>;
          };
        }
      ).InputPanel;
      ip._drafts.delete(sid);

      // Call _loadDraft — should apply the server draft since textarea stays empty
      await ip._loadDraft(sid);
    }, sessionId);

    await page.waitForTimeout(300);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('textarea value is set to the server draft text when no local cache and user did not type', async () => {
    const value = await page.evaluate(() => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      return ta ? ta.value : null;
    });
    expect(value).toBe('server restored draft');
  });
});

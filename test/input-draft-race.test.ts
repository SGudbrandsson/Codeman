/**
 * InputPanel._loadDraft race-condition tests
 *
 * Tests for _loadDraft behavior after the compose-image-leaks-between-sessions
 * fix.  The old early-return guard (which preserved a non-empty textarea and
 * saved its content to _drafts) was removed.  onSessionChange now always clears
 * the textarea before calling _loadDraft, so _loadDraft never encounters
 * leftover content from a previous session during a normal switch.
 *
 * Updated gaps:
 * 1. _loadDraft with pre-populated textarea (no local cache) — textarea is
 *    NOT saved to _drafts (old save-to-drafts side-effect removed)
 * 2. onSessionChange unconditional clear — text + images with focused textarea,
 *    session switch clears everything (regression test for original bug)
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

// ─── Gap 1: _loadDraft no longer saves leftover textarea content to _drafts ──

describe('_loadDraft does not save pre-existing textarea content to _drafts (old guard removed)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);

    // Mock the draft endpoint to return 404 so no server draft interferes
    await mockDraftEndpointNotFound(page, sessionId);

    // Set textarea to simulate leftover content, then call _loadDraft directly.
    // The old code would save this content to _drafts for the new session — the
    // new code does not.
    await page.evaluate(async (sid) => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      if (ta) ta.value = 'leftover from previous session';
      const ip = (
        window as unknown as {
          InputPanel: {
            _loadDraft: (id: string) => Promise<void>;
            _drafts: Map<string, unknown>;
          };
        }
      ).InputPanel;
      // Ensure no local cache so the only way _drafts gets populated is via the
      // removed early-return guard.
      ip._drafts.delete(sid);
      await ip._loadDraft(sid);
    }, sessionId);

    await page.waitForTimeout(300);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('_drafts does NOT contain an entry for the session (no implicit save)', async () => {
    const hasDraft = await page.evaluate((sid) => {
      const ip = (
        window as unknown as {
          InputPanel: { _drafts: Map<string, { text: string }> };
        }
      ).InputPanel;
      return ip._drafts.has(sid);
    }, sessionId);
    expect(hasDraft).toBe(false);
  });
});

// ─── Gap 2: Regression — focused textarea + images, session switch clears all ─

describe('Regression — text + images with focused textarea are cleared on session switch', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionA: string;
  let sessionB: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionA = await createSession(page);
    sessionB = await createSession(page);

    await mockDraftEndpointNotFound(page, sessionA);
    await mockDraftEndpointNotFound(page, sessionB);

    // Reproduce the original bug scenario: text in textarea with focus + images
    // attached, then switch sessions.  Before the fix, the content would leak to
    // the new session.
    await page.evaluate(
      async ({ a, b }) => {
        const ip = (
          window as unknown as {
            InputPanel: {
              _getTextarea: () => HTMLTextAreaElement | null;
              onSessionChange: (oldId: string | null, newId: string) => void;
              _images: Array<{ objectUrl: string | null; file: File | null; path: string | null }>;
              _drafts: Map<string, unknown>;
            };
          }
        ).InputPanel;

        // Select session A
        ip.onSessionChange(null, a);
        await new Promise((r) => setTimeout(r, 200));

        // Type text and focus the textarea
        const ta = ip._getTextarea();
        if (ta) {
          ta.value = 'text that should not leak';
          ta.focus();
        }

        // Simulate attached images
        ip._images = [{ objectUrl: null, file: null, path: '/tmp/leak-test.png' }];

        // Ensure session B has no cached draft
        ip._drafts.delete(b);

        // Switch to session B — this is where the old bug would leak content
        ip.onSessionChange(a, b);
        await new Promise((r) => setTimeout(r, 200));
      },
      { a: sessionA, b: sessionB }
    );
  });

  afterAll(async () => {
    await deleteSession(page, sessionA);
    await deleteSession(page, sessionB);
    await context?.close();
  });

  it('textarea is empty in session B after switching (no text leak)', async () => {
    const value = await page.evaluate(() => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      return ta ? ta.value : null;
    });
    expect(value).toBe('');
  });

  it('_images is empty in session B after switching (no image leak)', async () => {
    const currentImages = await page.evaluate(() => {
      const ip = (
        window as unknown as {
          InputPanel: { _images: Array<{ path: string | null }> };
        }
      ).InputPanel;
      return ip._images.map((i) => i.path);
    });
    expect(currentImages).toEqual([]);
  });

  it('session A draft is preserved in _drafts (content saved, not lost)', async () => {
    const draft = await page.evaluate((sid) => {
      const ip = (
        window as unknown as {
          InputPanel: { _drafts: Map<string, { text: string; imagePaths: string[] }> };
        }
      ).InputPanel;
      const d = ip._drafts.get(sid);
      return d ? { text: d.text, imagePaths: d.imagePaths } : null;
    }, sessionA);
    expect(draft).not.toBeNull();
    expect(draft!.text).toBe('text that should not leak');
    expect(draft!.imagePaths).toEqual(['/tmp/leak-test.png']);
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

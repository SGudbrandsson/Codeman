/**
 * Draft-per-session tests
 *
 * Tests that the compose textarea draft is saved and restored per-session
 * when switching between sessions via InputPanel.onSessionChange().
 *
 * Covers the six gaps identified in the test gap analysis:
 * 1. Switching saves current draft
 * 2. Switching restores target session draft (or empty)
 * 3. Round-trip: type in A, switch to B, switch back to A — draft preserved
 * 4. Empty draft: switch to session with no draft — input should be empty
 * 5. Sending clears the draft for that session
 * 6. Image/file attachments should also be per-session
 *
 * Port: 3231
 *
 * Run: npx vitest run test/draft-per-session.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3231;
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
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-draft-per-session' }),
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

/** Mock the GET /api/sessions/:id/draft endpoint to return 404 (no server draft). */
async function mockDraftEndpointNotFound(page: Page, sessionId: string): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/draft`, (route) => {
    route.fulfill({ status: 404, body: 'Not Found' });
  });
}

/** Mock the PUT /api/sessions/:id/draft endpoint to succeed silently. */
async function mockDraftSaveEndpoint(page: Page, sessionId: string): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/draft`, (route, request) => {
    if (request.method() === 'PUT') {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    } else {
      route.fulfill({ status: 404, body: 'Not Found' });
    }
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

// ─── Gap 1: Switching saves current draft ──────────────────────────────────

describe('Gap 1 — switching saves current draft to _drafts map', () => {
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

    // Simulate: user types in session A, then switches to session B
    await page.evaluate(
      async ({ a, b }) => {
        const ip = (
          window as unknown as {
            InputPanel: {
              _getTextarea: () => HTMLTextAreaElement | null;
              onSessionChange: (oldId: string | null, newId: string) => void;
              _drafts: Map<string, { text: string; imagePaths: string[] }>;
              _currentSessionId: string | null;
            };
          }
        ).InputPanel;

        // First, select session A
        ip.onSessionChange(null, a);
        await new Promise((r) => setTimeout(r, 200));

        // Type text in session A
        const ta = ip._getTextarea();
        if (ta) ta.value = 'draft for session A';

        // Switch to session B — should save session A's draft
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

  it('_drafts contains session A draft text after switching away', async () => {
    const draftText = await page.evaluate((sid) => {
      const ip = (
        window as unknown as {
          InputPanel: { _drafts: Map<string, { text: string }> };
        }
      ).InputPanel;
      return ip._drafts.get(sid)?.text ?? null;
    }, sessionA);
    expect(draftText).toBe('draft for session A');
  });
});

// ─── Gap 2: Switching restores target session draft ────────────────────────

describe('Gap 2 — switching restores target session draft', () => {
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

    await page.evaluate(
      async ({ a, b }) => {
        const ip = (
          window as unknown as {
            InputPanel: {
              _getTextarea: () => HTMLTextAreaElement | null;
              onSessionChange: (oldId: string | null, newId: string) => void;
              _drafts: Map<string, { text: string; imagePaths: string[] }>;
            };
          }
        ).InputPanel;

        // Pre-populate a draft for session B in the local cache
        ip._drafts.set(b, { text: 'pre-existing draft for B', imagePaths: [] });

        // Select session A first
        ip.onSessionChange(null, a);
        await new Promise((r) => setTimeout(r, 200));

        // Switch to session B — should restore B's draft
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

  it('textarea shows target session draft after switching', async () => {
    const value = await page.evaluate(() => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      return ta ? ta.value : null;
    });
    expect(value).toBe('pre-existing draft for B');
  });
});

// ─── Gap 3: Round-trip A→B→A preserves draft ──────────────────────────────

describe('Gap 3 — round-trip: type in A, switch to B, switch back to A preserves draft', () => {
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

    await page.evaluate(
      async ({ a, b }) => {
        const ip = (
          window as unknown as {
            InputPanel: {
              _getTextarea: () => HTMLTextAreaElement | null;
              onSessionChange: (oldId: string | null, newId: string) => void;
              _drafts: Map<string, { text: string; imagePaths: string[] }>;
            };
          }
        ).InputPanel;

        // Select session A and type a draft
        ip.onSessionChange(null, a);
        await new Promise((r) => setTimeout(r, 200));
        const ta = ip._getTextarea();
        if (ta) ta.value = 'round-trip draft A';

        // Switch to B
        ip.onSessionChange(a, b);
        await new Promise((r) => setTimeout(r, 200));

        // Type something in B
        const ta2 = ip._getTextarea();
        if (ta2) ta2.value = 'draft for B';

        // Switch back to A
        ip.onSessionChange(b, a);
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

  it('textarea shows session A draft after A→B→A round-trip', async () => {
    const value = await page.evaluate(() => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      return ta ? ta.value : null;
    });
    expect(value).toBe('round-trip draft A');
  });

  it('session B draft was also saved during the round-trip', async () => {
    const draftB = await page.evaluate((sid) => {
      const ip = (
        window as unknown as {
          InputPanel: { _drafts: Map<string, { text: string }> };
        }
      ).InputPanel;
      return ip._drafts.get(sid)?.text ?? null;
    }, sessionB);
    expect(draftB).toBe('draft for B');
  });
});

// ─── Gap 4: Empty draft — switch to session with no draft ─────────────────

describe('Gap 4 — switching to session with no draft shows empty input', () => {
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

    await page.evaluate(
      async ({ a, b }) => {
        const ip = (
          window as unknown as {
            InputPanel: {
              _getTextarea: () => HTMLTextAreaElement | null;
              onSessionChange: (oldId: string | null, newId: string) => void;
              _drafts: Map<string, { text: string; imagePaths: string[] }>;
            };
          }
        ).InputPanel;

        // Select session A and type something
        ip.onSessionChange(null, a);
        await new Promise((r) => setTimeout(r, 200));
        const ta = ip._getTextarea();
        if (ta) ta.value = 'some text in A';

        // Switch to B which has never had a draft
        ip._drafts.delete(b); // ensure no local cache
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

  it('textarea is empty after switching to session with no draft', async () => {
    const value = await page.evaluate(() => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      return ta ? ta.value : null;
    });
    expect(value).toBe('');
  });
});

// ─── Gap 5: Sending clears the draft for that session ─────────────────────

describe('Gap 5 — sending a message clears the draft for the current session', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionA: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionA = await createSession(page);

    await mockDraftSaveEndpoint(page, sessionA);

    await page.evaluate(async (a) => {
      const ip = (
        window as unknown as {
          InputPanel: {
            _getTextarea: () => HTMLTextAreaElement | null;
            onSessionChange: (oldId: string | null, newId: string) => void;
            _drafts: Map<string, { text: string; imagePaths: string[] }>;
            send: () => void;
          };
        }
      ).InputPanel;

      // Stub app.sendInput so send() doesn't try to actually send to tmux
      const w = window as unknown as {
        app: {
          sendInput: (text: string) => Promise<void>;
          activeSessionId: string;
          sessions: Map<string, unknown>;
          _updateTabStatusDebounced: (id: string, status: string) => void;
        };
      };
      w.app.sendInput = () => Promise.resolve();
      w.app.activeSessionId = a;
      w.app._updateTabStatusDebounced = () => {};

      // Select session A and type a draft
      ip.onSessionChange(null, a);
      await new Promise((r) => setTimeout(r, 200));
      const ta = ip._getTextarea();
      if (ta) ta.value = 'message to send';

      // Save draft first to populate _drafts
      ip._drafts.set(a, { text: 'message to send', imagePaths: [] });

      // Send the message
      ip.send();
      await new Promise((r) => setTimeout(r, 200));
    }, sessionA);
  });

  afterAll(async () => {
    await deleteSession(page, sessionA);
    await context?.close();
  });

  it('draft text is empty after sending', async () => {
    const draftText = await page.evaluate((sid) => {
      const ip = (
        window as unknown as {
          InputPanel: { _drafts: Map<string, { text: string }> };
        }
      ).InputPanel;
      return ip._drafts.get(sid)?.text ?? null;
    }, sessionA);
    expect(draftText).toBe('');
  });

  it('textarea is cleared after sending', async () => {
    const value = await page.evaluate(() => {
      const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement | null;
      return ta ? ta.value : null;
    });
    expect(value).toBe('');
  });
});

// ─── Gap 6: Image attachments are per-session ─────────────────────────────

describe('Gap 6 — image attachments are saved and restored per-session', () => {
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

    await page.evaluate(
      async ({ a, b }) => {
        const ip = (
          window as unknown as {
            InputPanel: {
              _getTextarea: () => HTMLTextAreaElement | null;
              onSessionChange: (oldId: string | null, newId: string) => void;
              _drafts: Map<string, { text: string; imagePaths: string[] }>;
              _images: Array<{ objectUrl: string | null; file: File | null; path: string | null }>;
              _saveDraftLocal: (sessionId: string) => void;
            };
          }
        ).InputPanel;

        // Select session A and simulate having image attachments
        ip.onSessionChange(null, a);
        await new Promise((r) => setTimeout(r, 200));

        // Manually set _images to simulate attached images
        ip._images = [
          { objectUrl: null, file: null, path: '/tmp/image-a1.png' },
          { objectUrl: null, file: null, path: '/tmp/image-a2.png' },
        ];
        const ta = ip._getTextarea();
        if (ta) ta.value = 'text with images in A';

        // Switch to B — should save A's images
        ip.onSessionChange(a, b);
        await new Promise((r) => setTimeout(r, 200));

        // Verify images were cleared after switch
        // (stored in _images for current session should be empty or B's)
      },
      { a: sessionA, b: sessionB }
    );
  });

  afterAll(async () => {
    await deleteSession(page, sessionA);
    await deleteSession(page, sessionB);
    await context?.close();
  });

  it('session A draft includes imagePaths after switching away', async () => {
    const imagePaths = await page.evaluate((sid) => {
      const ip = (
        window as unknown as {
          InputPanel: { _drafts: Map<string, { text: string; imagePaths: string[] }> };
        }
      ).InputPanel;
      return ip._drafts.get(sid)?.imagePaths ?? null;
    }, sessionA);
    expect(imagePaths).toEqual(['/tmp/image-a1.png', '/tmp/image-a2.png']);
  });

  it('_images is cleared (empty) after switching to session B which has no attachments', async () => {
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

  it('switching back to A restores image attachments', async () => {
    // Switch back to A
    await page.evaluate(
      async ({ a, b }) => {
        const ip = (
          window as unknown as {
            InputPanel: {
              onSessionChange: (oldId: string, newId: string) => void;
            };
          }
        ).InputPanel;
        ip.onSessionChange(b, a);
        await new Promise((r) => setTimeout(r, 200));
      },
      { a: sessionA, b: sessionB }
    );

    const currentImages = await page.evaluate(() => {
      const ip = (
        window as unknown as {
          InputPanel: { _images: Array<{ path: string | null }> };
        }
      ).InputPanel;
      return ip._images.map((i) => i.path);
    });
    expect(currentImages).toEqual(['/tmp/image-a1.png', '/tmp/image-a2.png']);
  });
});

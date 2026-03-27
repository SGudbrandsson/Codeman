/**
 * Transcript mode guard tests
 *
 * Verifies that TranscriptView is hidden for non-claude sessions (shell, opencode)
 * after selectSession() is called, and remains visible for default claude sessions.
 *
 * Port: 3216 (transcript-mode-guard tests)
 *
 * Run: npx vitest run test/transcript-mode-guard.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3216;
const BASE_URL = `http://localhost:${PORT}`;

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

/** Create a session with the given mode (undefined = default claude) */
async function createSession(page: Page, mode?: string): Promise<string> {
  const id = await page.evaluate(async (sessionMode) => {
    const body: Record<string, unknown> = { workingDir: '/tmp', name: 'test-mode-guard' };
    if (sessionMode) body.mode = sessionMode;
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return (data.id ?? data.session?.id) as string;
  }, mode);
  return id;
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id): Promise<void> => {
    await (window as unknown as { app: { selectSession: (id: string) => Promise<void> } }).app.selectSession(id);
  }, sessionId);
  await page.waitForTimeout(800);
}

/** Mock the transcript endpoint to return an empty transcript */
async function mockEmptyTranscript(page: Page, sessionId: string): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/transcript**`, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
}

/** Clear localStorage transcript view mode for a session */
async function clearViewModeStorage(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    localStorage.removeItem('transcriptViewMode:' + id);
  }, sessionId);
}

beforeAll(async () => {
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

describe('TranscriptView hidden for shell mode sessions', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page, 'shell');
    await clearViewModeStorage(page, sessionId);
    await mockEmptyTranscript(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('#transcriptView is hidden after selectSession() for a shell session', async () => {
    const display = await page.locator('#transcriptView').evaluate((el) => (el as HTMLElement).style.display);
    expect(display).toBe('none');
  });

  it('#transcriptView is not visible for a shell session', async () => {
    const visible = await page.locator('#transcriptView').isVisible();
    expect(visible).toBe(false);
  });
});

describe('TranscriptView hidden for opencode mode sessions', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page, 'opencode');
    await clearViewModeStorage(page, sessionId);
    await mockEmptyTranscript(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('#transcriptView is hidden after selectSession() for an opencode session', async () => {
    const display = await page.locator('#transcriptView').evaluate((el) => (el as HTMLElement).style.display);
    expect(display).toBe('none');
  });

  it('#transcriptView is not visible for an opencode session', async () => {
    const visible = await page.locator('#transcriptView').isVisible();
    expect(visible).toBe(false);
  });
});

describe('TranscriptView shown for default claude sessions (regression guard)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    // No mode field — default claude session
    sessionId = await createSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockEmptyTranscript(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('#transcriptView is visible after selectSession() for a default claude session', async () => {
    const visible = await page.locator('#transcriptView').isVisible();
    expect(visible).toBe(true);
  });

  it('#transcriptView does not have display:none for a default claude session', async () => {
    const display = await page.locator('#transcriptView').evaluate((el) => (el as HTMLElement).style.display);
    expect(display).not.toBe('none');
  });
});

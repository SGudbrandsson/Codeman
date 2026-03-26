/**
 * Transcript clear → new session detection
 *
 * Tests the exact failure scenarios reported by the user:
 *
 * 1. After /clear, tab switch must NOT show old session content
 * 2. After /clear + user sends message, message survives one tab switch
 * 3. After /clear + user sends message, message survives two tab switches
 * 4. After SSE transcript:clear fires and Claude responds, tab switches show correct content
 *
 * Each test is written to FAIL against the broken implementation and PASS
 * only when the fix is correct. Watch each fail before implementing.
 *
 * Port: 3213
 *
 * Run: npx vitest run test/transcript-clear-new-session.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3213;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createSession(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-clear-session' }),
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
  await page.waitForTimeout(500);
}

/** Mock the transcript endpoint for this session */
async function mockTranscript(page: Page, sessionId: string, blocks: unknown[]): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/transcript**`, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(blocks) });
  });
}

/** Switch from whatever view to terminal view */
async function switchToTerminal(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    const tv = (window as unknown as { TranscriptView: { hide: (id: string) => void } }).TranscriptView;
    tv.hide(id);
    (
      window as unknown as { TranscriptView: { setViewMode: (id: string, mode: string) => void } }
    ).TranscriptView.setViewMode(id, 'terminal');
  }, sessionId);
  await page.waitForTimeout(100);
}

/** Switch from terminal back to transcript view */
async function switchToTranscript(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (
      window as unknown as {
        TranscriptView: { setViewMode: (id: string, mode: string) => void; show: (id: string) => void };
      }
    ).TranscriptView.setViewMode(id, 'web');
    (window as unknown as { TranscriptView: { show: (id: string) => void } }).TranscriptView.show(id);
  }, sessionId);
  await page.waitForTimeout(500);
}

/** Fire the clearOnly() method (what happens when user sends /clear) */
async function fireClearOnly(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { TranscriptView: { clearOnly: () => void } }).TranscriptView.clearOnly();
  });
  await page.waitForTimeout(100);
}

/** Fire the transcript:clear SSE event (what the backend sends after new UUID is registered) */
async function fireTranscriptClearSSE(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { app: { _onTranscriptClear: (d: unknown) => void } }).app._onTranscriptClear({
      sessionId: id,
    });
  }, sessionId);
  await page.waitForTimeout(300);
}

/** Show an optimistic bubble (what happens when user sends a message) */
async function fireUserSendMessage(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    (
      window as unknown as { TranscriptView: { appendOptimistic: (text: string) => void } }
    ).TranscriptView.appendOptimistic(t);
  }, text);
  await page.waitForTimeout(100);
}

/** Fire transcript:block SSE (what happens when Claude responds) */
async function fireClaudeResponse(page: Page, sessionId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ id, t }) => {
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: id,
        block: { type: 'text', role: 'assistant', text: t, timestamp: new Date().toISOString() },
      });
    },
    { id: sessionId, t: text }
  );
  await page.waitForTimeout(200);
}

/** Get visible text content of the transcript container */
async function getTranscriptText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.getElementById('transcriptView');
    return el?.innerText ?? '';
  });
}

/** Check if the empty CTA ("What's on your mind") is visible */
async function isEmptyCTAVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.getElementById('transcriptView');
    // The CTA element uses class tv-empty-cta; text uses \u2019 (curly apostrophe)
    if (el?.querySelector('.tv-empty-cta')) return true;
    const text = el?.innerText ?? '';
    return text.includes('What\u2019s on your mind') || text.includes("What's on your mind");
  });
}

// ─── Old session content used in tests ──────────────────────────────────────

const OLD_SESSION_BLOCKS = [
  {
    type: 'text',
    role: 'user',
    text: 'OLD SESSION MESSAGE — should never appear after /clear',
    timestamp: '2026-01-01T09:00:00.000Z',
  },
  {
    type: 'text',
    role: 'assistant',
    text: 'OLD SESSION REPLY — should never appear after /clear',
    timestamp: '2026-01-01T09:00:01.000Z',
  },
];

const NEW_USER_MESSAGE = 'NEW SESSION MESSAGE after clear';
const CLAUDE_REPLY = 'Claude reply in new session';

// ─── Setup / Teardown ───────────────────────────────────────────────────────

let server: WebServer;
let browser: Browser;

beforeAll(async () => {
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Transcript clear → new session: tab switch must not show old content', () => {
  let page: Page;
  let sessionId: string;

  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    sessionId = await createSession(page);
    // Transcript endpoint returns OLD session blocks (simulates backend still on old UUID)
    await mockTranscript(page, sessionId, OLD_SESSION_BLOCKS);
    await selectSession(page, sessionId);
    // Put session in transcript (web) view mode
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionId);
    await selectSession(page, sessionId);
  }, 20_000);

  afterEach(async () => {
    await page.close();
  });

  it('SCENARIO 1: after clearOnly(), switching to transcript must show empty CTA — not old session blocks', async () => {
    // Verify old session content is initially visible
    const before = await getTranscriptText(page);
    expect(before).toContain('OLD SESSION MESSAGE');

    // User sends /clear
    await fireClearOnly(page);

    // User switches to terminal then back to transcript
    // Backend still returns OLD blocks (transcript:clear SSE has not arrived yet)
    await switchToTerminal(page, sessionId);
    await switchToTranscript(page, sessionId);

    // MUST show empty CTA — old blocks are from old session, must not be shown
    const emptyCTA = await isEmptyCTAVisible(page);
    const transcriptText = await getTranscriptText(page);

    expect(emptyCTA).toBe(true);
    expect(transcriptText).not.toContain('OLD SESSION MESSAGE');
    expect(transcriptText).not.toContain('OLD SESSION REPLY');
  }, 20_000);

  it('SCENARIO 2: after clearOnly() + user sends message, one tab switch preserves the user message', async () => {
    await fireClearOnly(page);
    // Wait for empty CTA (fallback timer or immediate after clearOnly wipe)
    await page.waitForTimeout(200);

    // User types and sends a message (before transcript:clear SSE arrives)
    await fireUserSendMessage(page, NEW_USER_MESSAGE);

    // Verify message is visible immediately
    const afterSend = await getTranscriptText(page);
    expect(afterSend).toContain(NEW_USER_MESSAGE);

    // User switches to terminal then back
    await switchToTerminal(page, sessionId);
    await switchToTranscript(page, sessionId);

    // MUST still show the user's message — not old session, not empty CTA
    const afterSwitch = await getTranscriptText(page);
    expect(afterSwitch).toContain(NEW_USER_MESSAGE);
    expect(afterSwitch).not.toContain('OLD SESSION MESSAGE');
    expect(await isEmptyCTAVisible(page)).toBe(false);
  }, 20_000);

  it('SCENARIO 3: after clearOnly() + user sends message, TWO tab switches both preserve the user message', async () => {
    await fireClearOnly(page);
    await page.waitForTimeout(200);
    await fireUserSendMessage(page, NEW_USER_MESSAGE);

    // Switch out and back — first time
    await switchToTerminal(page, sessionId);
    await switchToTranscript(page, sessionId);

    const afterFirst = await getTranscriptText(page);
    expect(afterFirst).toContain(NEW_USER_MESSAGE);

    // Switch out and back — second time (this was the failing case)
    await switchToTerminal(page, sessionId);
    await switchToTranscript(page, sessionId);

    const afterSecond = await getTranscriptText(page);
    expect(afterSecond).toContain(NEW_USER_MESSAGE);
    expect(afterSecond).not.toContain('OLD SESSION MESSAGE');
    expect(await isEmptyCTAVisible(page)).toBe(false);
  }, 20_000);

  it('SCENARIO 4: after transcript:clear SSE fires + Claude responds, tab switch shows new session content', async () => {
    await fireClearOnly(page);
    await page.waitForTimeout(200);
    await fireUserSendMessage(page, NEW_USER_MESSAGE);

    // Now transcript:clear SSE arrives (backend registered new UUID)
    // Mock transcript endpoint now returns empty (new session, no blocks yet)
    await page.unroute(`**/api/sessions/${sessionId}/transcript**`);
    await mockTranscript(page, sessionId, []);
    await fireTranscriptClearSSE(page, sessionId);

    // Claude responds via SSE block
    await fireClaudeResponse(page, sessionId, CLAUDE_REPLY);

    // User switches to terminal
    await switchToTerminal(page, sessionId);

    // Mock transcript now returns the new session with Claude's response
    await page.unroute(`**/api/sessions/${sessionId}/transcript**`);
    await mockTranscript(page, sessionId, [
      { type: 'text', role: 'user', text: NEW_USER_MESSAGE, timestamp: new Date().toISOString() },
      { type: 'text', role: 'assistant', text: CLAUDE_REPLY, timestamp: new Date().toISOString() },
    ]);

    // Switch back to transcript
    await switchToTranscript(page, sessionId);

    const text = await getTranscriptText(page);
    expect(text).toContain(CLAUDE_REPLY);
    expect(text).not.toContain('OLD SESSION MESSAGE');
    expect(await isEmptyCTAVisible(page)).toBe(false);
  }, 20_000);

  it('SCENARIO 5: after transcript:clear SSE fires, tab switch × 2 still shows new session content', async () => {
    await fireClearOnly(page);
    await page.waitForTimeout(200);
    await fireUserSendMessage(page, NEW_USER_MESSAGE);

    // transcript:clear SSE arrives, new session established
    await page.unroute(`**/api/sessions/${sessionId}/transcript**`);
    await mockTranscript(page, sessionId, []);
    await fireTranscriptClearSSE(page, sessionId);
    await fireClaudeResponse(page, sessionId, CLAUDE_REPLY);

    // Mock transcript returns new session content
    await page.unroute(`**/api/sessions/${sessionId}/transcript**`);
    await mockTranscript(page, sessionId, [
      { type: 'text', role: 'user', text: NEW_USER_MESSAGE, timestamp: new Date().toISOString() },
      { type: 'text', role: 'assistant', text: CLAUDE_REPLY, timestamp: new Date().toISOString() },
    ]);

    // First switch
    await switchToTerminal(page, sessionId);
    await switchToTranscript(page, sessionId);
    const afterFirst = await getTranscriptText(page);
    expect(afterFirst).toContain(CLAUDE_REPLY);
    expect(afterFirst).not.toContain('OLD SESSION MESSAGE');

    // Second switch (the exact scenario that was failing)
    await switchToTerminal(page, sessionId);
    await switchToTranscript(page, sessionId);
    const afterSecond = await getTranscriptText(page);
    expect(afterSecond).toContain(CLAUDE_REPLY);
    expect(afterSecond).not.toContain('OLD SESSION MESSAGE');
  }, 20_000);
});

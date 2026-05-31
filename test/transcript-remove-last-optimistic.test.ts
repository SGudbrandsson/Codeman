/**
 * TranscriptView.removeLastOptimistic() — rollback of an optimistic user bubble
 *
 * Covers Gap 1 from the sluggish-send fix: the new removeLastOptimistic() method
 * (src/web/public/app.js ~line 3366) used by InputPanel._sendInner()'s .catch()
 * rollback when a fire-and-forget POST fails.
 *
 * Drives the REAL TranscriptView object in a Chromium page (same pattern as
 * transcript-clear-new-session.test.ts), then asserts on the live DOM.
 *
 * Assertions:
 *  1. removeLastOptimistic() removes the last [data-optimistic="true"] bubble.
 *  2. _pendingOptimisticText is reset to null afterwards.
 *  3. A real (non-optimistic) rendered block is left untouched — only DOM marked
 *     data-optimistic is removed.
 *  4. With multiple optimistic bubbles, only the LAST one is removed.
 *  5. No-op (no throw) when there is no optimistic bubble.
 *
 * Port: 3262
 *
 * Run: npx vitest run test/transcript-remove-last-optimistic.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3262;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createSession(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-remove-optimistic' }),
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

/** Append an optimistic user bubble via the real TranscriptView method */
async function appendOptimistic(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    (
      window as unknown as { TranscriptView: { appendOptimistic: (text: string) => void } }
    ).TranscriptView.appendOptimistic(t);
  }, text);
  await page.waitForTimeout(50);
}

/** Append a real (SSE-reconciled) assistant block via the real handler */
async function appendRealBlock(page: Page, sessionId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ id, t }) => {
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: id,
        block: { type: 'text', role: 'assistant', text: t, timestamp: new Date().toISOString() },
      });
    },
    { id: sessionId, t: text }
  );
  await page.waitForTimeout(100);
}

async function removeLastOptimistic(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as { TranscriptView: { removeLastOptimistic: () => void } }
    ).TranscriptView.removeLastOptimistic();
  });
  await page.waitForTimeout(50);
}

async function optimisticCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.getElementById('transcriptView');
    return el?.querySelectorAll('[data-optimistic="true"]').length ?? 0;
  });
}

/** Count real (non-optimistic) assistant blocks rendered in the transcript */
async function assistantBlockCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.getElementById('transcriptView');
    if (!el) return 0;
    // Real assistant blocks carry .tv-block--assistant and never data-optimistic
    return Array.from(el.querySelectorAll('.tv-block--assistant')).filter(
      (b) => (b as HTMLElement).dataset.optimistic !== 'true'
    ).length;
  });
}

async function getPendingOptimisticText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    return (window as unknown as { TranscriptView: { _pendingOptimisticText: string | null } }).TranscriptView
      ._pendingOptimisticText;
  });
}

async function getTranscriptText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.getElementById('transcriptView');
    return el?.innerText ?? '';
  });
}

const OPTIMISTIC_MESSAGE = 'optimistic message that failed to send';
const REAL_REPLY = 'a real assistant reply from SSE';

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

describe('TranscriptView.removeLastOptimistic(): rollback of optimistic bubbles', () => {
  let page: Page;
  let sessionId: string;

  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    sessionId = await createSession(page);
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionId);
    await selectSession(page, sessionId);
  }, 20_000);

  afterEach(async () => {
    await page.close();
  });

  it('removes the optimistic bubble and resets _pendingOptimisticText to null', async () => {
    await appendOptimistic(page, OPTIMISTIC_MESSAGE);

    expect(await optimisticCount(page)).toBe(1);
    expect(await getPendingOptimisticText(page)).toBe(OPTIMISTIC_MESSAGE);
    expect(await getTranscriptText(page)).toContain(OPTIMISTIC_MESSAGE);

    await removeLastOptimistic(page);

    expect(await optimisticCount(page)).toBe(0);
    expect(await getPendingOptimisticText(page)).toBeNull();
    expect(await getTranscriptText(page)).not.toContain(OPTIMISTIC_MESSAGE);
  }, 20_000);

  it('leaves a real (non-optimistic) block untouched', async () => {
    // A real assistant block arrives first (no data-optimistic marker)
    await appendRealBlock(page, sessionId, REAL_REPLY);
    expect(await assistantBlockCount(page)).toBe(1);
    expect(await optimisticCount(page)).toBe(0);

    // Then an optimistic user bubble is appended
    await appendOptimistic(page, OPTIMISTIC_MESSAGE);
    expect(await optimisticCount(page)).toBe(1);

    // Rolling back the optimistic send must not remove the real block
    await removeLastOptimistic(page);

    expect(await optimisticCount(page)).toBe(0);
    expect(await getTranscriptText(page)).not.toContain(OPTIMISTIC_MESSAGE);
    // The real assistant block is still rendered — removeLastOptimistic only
    // touches [data-optimistic="true"] elements.
    expect(await assistantBlockCount(page)).toBe(1);
  }, 20_000);

  it('removes only the LAST optimistic bubble when several exist', async () => {
    await appendOptimistic(page, 'first optimistic');
    await appendOptimistic(page, 'second optimistic');
    expect(await optimisticCount(page)).toBe(2);

    await removeLastOptimistic(page);

    expect(await optimisticCount(page)).toBe(1);
    const text = await getTranscriptText(page);
    expect(text).toContain('first optimistic');
    expect(text).not.toContain('second optimistic');
  }, 20_000);

  it('is a no-op (no throw) when there is no optimistic bubble', async () => {
    expect(await optimisticCount(page)).toBe(0);

    // Should not throw even with nothing to remove
    await expect(removeLastOptimistic(page)).resolves.toBeUndefined();

    expect(await optimisticCount(page)).toBe(0);
    expect(await getPendingOptimisticText(page)).toBeNull();
  }, 20_000);
});

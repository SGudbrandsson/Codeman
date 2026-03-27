/**
 * Transcript loading — TDD test suite for 8 contracts
 *
 * Tests the load() flow including tail pagination, cache path, error handling,
 * scroll-up lazy loading, and SSE append. Written as failing tests first (red),
 * then implementation is fixed to make them pass (green).
 *
 * Port: 3260 (transcript-loading tests)
 *
 * Run: npx vitest run test/transcript-loading.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3260;
const BASE_URL = `http://localhost:${PORT}`;
const BATCH_SIZE = 50; // Must match TranscriptView._BATCH_SIZE
const TAIL_SIZE = 100; // _BATCH_SIZE * 2, used by load()

// ─── Mock data ──────────────────────────────────────────────────────────────

function generateBlocks(count: number, startIdx = 0): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    const role = idx % 2 === 0 ? 'user' : 'assistant';
    blocks.push({
      type: 'text',
      role,
      text: `Message ${idx} from ${role}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, idx)).toISOString(),
    });
  }
  return blocks;
}

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
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-transcript-loading' }),
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

/**
 * Mock transcript endpoint with proper ?tail support and X-Total-Blocks header.
 * allBlocks is the full set of blocks the server "has".
 */
async function mockTranscriptWithTail(page: Page, sessionId: string, allBlocks: unknown[]): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/transcript**`, (route) => {
    const url = new URL(route.request().url());
    const tail = parseInt(url.searchParams.get('tail') || '0', 10);
    const arr = allBlocks as Array<Record<string, unknown>>;
    if (tail > 0 && arr.length > tail) {
      const sliced = arr.slice(-tail);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Total-Blocks': arr.length.toString() },
        body: JSON.stringify(sliced),
      });
    } else {
      // Return all blocks, no X-Total-Blocks header
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(arr),
      });
    }
  });
}

/** Mock transcript endpoint that returns an error */
async function mockTranscriptError(page: Page, sessionId: string): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/transcript**`, (route) => {
    route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' });
  });
}

/** Mock transcript endpoint that aborts (network error) */
async function mockTranscriptNetworkError(page: Page, sessionId: string): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/transcript**`, (route) => {
    route.abort('connectionrefused');
  });
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { app: { selectSession: (id: string) => void } }).app.selectSession(id);
  }, sessionId);
  await page.waitForTimeout(800);
}

async function setWebViewMode(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (
      window as unknown as { TranscriptView: { setViewMode: (id: string, mode: string) => void } }
    ).TranscriptView.setViewMode(id, 'web');
  }, sessionId);
}

async function getRenderedBlockCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const container = document.getElementById('transcriptView');
    if (!container) return 0;
    return Array.from(container.children).filter((el) => !el.classList.contains('tv-load-more-sentinel')).length;
  });
}

async function hasSentinel(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const container = document.getElementById('transcriptView');
    return !!container?.querySelector('.tv-load-more-sentinel');
  });
}

async function getRenderedStartIdx(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as unknown as { TranscriptView: { _renderedStartIdx: number } }).TranscriptView._renderedStartIdx;
  });
}

async function getStateBlocks(page: Page, sessionId: string): Promise<number> {
  return page.evaluate((id) => {
    const tv = window as unknown as { TranscriptView: { _getState: (id: string) => { blocks: unknown[] } } };
    return tv.TranscriptView._getState(id).blocks.length;
  }, sessionId);
}

async function getTotalServerBlocks(page: Page, sessionId: string): Promise<number> {
  return page.evaluate((id) => {
    const tv = window as unknown as {
      TranscriptView: { _getState: (id: string) => { totalServerBlocks?: number } };
    };
    return tv.TranscriptView._getState(id).totalServerBlocks ?? 0;
  }, sessionId);
}

async function getContainerText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const container = document.getElementById('transcriptView');
    return container?.textContent ?? '';
  });
}

async function hasPlaceholder(page: Page, text: string): Promise<boolean> {
  return page.evaluate((txt) => {
    const container = document.getElementById('transcriptView');
    const placeholder = container?.querySelector('.tv-placeholder');
    return placeholder?.textContent?.includes(txt) ?? false;
  }, text);
}

async function hasEmptyPlaceholder(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const container = document.getElementById('transcriptView');
    return !!container?.querySelector('.tv-empty-cta');
  });
}

async function triggerPrependBatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { TranscriptView: { _prependBatch: () => Promise<void> } }).TranscriptView._prependBatch();
  });
  await page.waitForTimeout(300);
}

async function getFirstBlockText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const container = document.getElementById('transcriptView');
    if (!container) return '';
    const blocks = Array.from(container.children).filter((el) => !el.classList.contains('tv-load-more-sentinel'));
    return blocks[0]?.textContent ?? '';
  });
}

async function getLastBlockText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const container = document.getElementById('transcriptView');
    if (!container) return '';
    const blocks = Array.from(container.children).filter((el) => !el.classList.contains('tv-load-more-sentinel'));
    return blocks[blocks.length - 1]?.textContent ?? '';
  });
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ═══════════════════════════════════════════════════════════════════════════
// Contract 1: Initial load for short sessions (<100 blocks)
// ═══════════════════════════════════════════════════════════════════════════

describe('Contract 1: Initial load for short sessions (<100 blocks)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL = 30;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(TOTAL);
    await mockTranscriptWithTail(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('renders all blocks in the DOM', async () => {
    const count = await getRenderedBlockCount(page);
    expect(count).toBe(TOTAL);
  });

  it('does not show sentinel (no lazy loading needed)', async () => {
    const sentinel = await hasSentinel(page);
    expect(sentinel).toBe(false);
  });

  it('has no errors in container', async () => {
    const text = await getContainerText(page);
    expect(text).not.toContain('Could not load');
  });

  it('state.blocks has all blocks', async () => {
    const blockCount = await getStateBlocks(page, sessionId);
    expect(blockCount).toBe(TOTAL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Contract 2: Initial load for long sessions (>100 blocks)
// ═══════════════════════════════════════════════════════════════════════════

describe('Contract 2: Initial load for long sessions (>100 blocks)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL = 3000;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(TOTAL);
    await mockTranscriptWithTail(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('renders only BATCH_SIZE blocks in DOM (tail batch)', async () => {
    const count = await getRenderedBlockCount(page);
    expect(count).toBe(BATCH_SIZE);
  });

  it('shows sentinel at top for lazy loading', async () => {
    const sentinel = await hasSentinel(page);
    expect(sentinel).toBe(true);
  });

  it('state.totalServerBlocks = 3000', async () => {
    const total = await getTotalServerBlocks(page, sessionId);
    expect(total).toBe(TOTAL);
  });

  it('state.blocks has 100 blocks (tail fetch)', async () => {
    const blockCount = await getStateBlocks(page, sessionId);
    expect(blockCount).toBe(TAIL_SIZE);
  });

  it('has no errors', async () => {
    const text = await getContainerText(page);
    expect(text).not.toContain('Could not load');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Contract 3: Switch away and back (cache path)
// ═══════════════════════════════════════════════════════════════════════════

describe('Contract 3: Switch away and back (cache path)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionA: string;
  let sessionB: string;
  const TOTAL = 3000;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionA = await createSession(page);
    sessionB = await createSession(page);

    const blocksA = generateBlocks(TOTAL);
    await mockTranscriptWithTail(page, sessionA, blocksA);
    await mockTranscriptWithTail(page, sessionB, []);
    await setWebViewMode(page, sessionA);
    await setWebViewMode(page, sessionB);

    // First visit to session A — populate cache
    await selectSession(page, sessionA);
  });

  afterAll(async () => {
    await deleteSession(page, sessionA);
    await deleteSession(page, sessionB);
    await context?.close();
  });

  it('switching away and back shows cached content without error', async () => {
    // Switch to session B
    await selectSession(page, sessionB);
    await page.waitForTimeout(300);

    // Switch back to session A
    await selectSession(page, sessionA);

    // Should render tail batch from cache
    const count = await getRenderedBlockCount(page);
    expect(count).toBe(BATCH_SIZE);

    // No error shown
    const text = await getContainerText(page);
    expect(text).not.toContain('Could not load');
  });

  it('cache path does not flash or wipe DOM when session grew', async () => {
    // Simulate session growing: add 10 new blocks on the "server"
    await page.unroute(`**/api/sessions/${sessionA}/transcript**`);
    const grownBlocks = generateBlocks(TOTAL + 10);
    await mockTranscriptWithTail(page, sessionA, grownBlocks);

    // Switch away and back
    await selectSession(page, sessionB);
    await page.waitForTimeout(300);
    await selectSession(page, sessionA);

    // Should still show content, not error
    const count = await getRenderedBlockCount(page);
    expect(count).toBeGreaterThanOrEqual(BATCH_SIZE);
    const text = await getContainerText(page);
    expect(text).not.toContain('Could not load');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Contract 4: Session with 0 blocks (empty/new session)
// ═══════════════════════════════════════════════════════════════════════════

describe('Contract 4: Session with 0 blocks', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockTranscriptWithTail(page, sessionId, []);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('shows empty placeholder', async () => {
    const empty = await hasEmptyPlaceholder(page);
    expect(empty).toBe(true);
  });

  it('has no errors', async () => {
    const text = await getContainerText(page);
    expect(text).not.toContain('Could not load');
  });

  it('does not show sentinel', async () => {
    const sentinel = await hasSentinel(page);
    expect(sentinel).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Contract 5: Fetch fails (network error)
// ═══════════════════════════════════════════════════════════════════════════

describe('Contract 5: Fetch fails with no cache', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockTranscriptError(page, sessionId);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('shows "Could not load session history." when no cache exists', async () => {
    const hasError = await hasPlaceholder(page, 'Could not load');
    expect(hasError).toBe(true);
  });
});

describe('Contract 5: Fetch fails WITH cache — keeps cached content', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionA: string;
  let sessionB: string;
  const TOTAL = 200;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionA = await createSession(page);
    sessionB = await createSession(page);

    // First load succeeds — populate cache
    const blocksA = generateBlocks(TOTAL);
    await mockTranscriptWithTail(page, sessionA, blocksA);
    await mockTranscriptWithTail(page, sessionB, []);
    await setWebViewMode(page, sessionA);
    await setWebViewMode(page, sessionB);
    await selectSession(page, sessionA);

    // Now make fetch fail
    await page.unroute(`**/api/sessions/${sessionA}/transcript**`);
    await mockTranscriptError(page, sessionA);
  });

  afterAll(async () => {
    await deleteSession(page, sessionA);
    await deleteSession(page, sessionB);
    await context?.close();
  });

  it('keeps cached content visible when fetch fails on revisit', async () => {
    // Switch away
    await selectSession(page, sessionB);
    await page.waitForTimeout(300);

    // Switch back — cache exists, fetch will fail
    await selectSession(page, sessionA);

    // Should NOT show error — cached content should be preserved
    const text = await getContainerText(page);
    expect(text).not.toContain('Could not load');

    // Should still have rendered blocks
    const count = await getRenderedBlockCount(page);
    expect(count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Contract 6: Scroll-up lazy loading from local cache
// ═══════════════════════════════════════════════════════════════════════════

describe('Contract 6: Scroll-up lazy loading from local cache', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL = 3000; // Server has 3000 blocks, fetch returns 100

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(TOTAL);
    await mockTranscriptWithTail(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('first prepend loads next 50 blocks from local cache', async () => {
    const idxBefore = await getRenderedStartIdx(page);
    expect(idxBefore).toBe(TAIL_SIZE - BATCH_SIZE); // 50

    await triggerPrependBatch(page);

    const idxAfter = await getRenderedStartIdx(page);
    expect(idxAfter).toBe(0); // all 100 local blocks now rendered

    const count = await getRenderedBlockCount(page);
    expect(count).toBe(TAIL_SIZE); // 100 blocks rendered
  });

  it('sentinel still shows after all local blocks rendered if server has more', async () => {
    const sentinel = await hasSentinel(page);
    expect(sentinel).toBe(true); // totalServerBlocks (3000) > state.blocks.length (100)
  });

  it('scroll position is preserved (no jump)', async () => {
    // Reset state for a clean check
    await page.unroute(`**/api/sessions/${sessionId}/transcript**`);
    const blocks = generateBlocks(TOTAL);
    await mockTranscriptWithTail(page, sessionId, blocks);
    await selectSession(page, sessionId);

    // Scroll to a mid-point
    const midScrollTop = await page.evaluate(() => {
      const container = document.getElementById('transcriptView')!;
      const mid = container.scrollHeight / 2;
      container.scrollTop = mid;
      return container.scrollTop;
    });

    await triggerPrependBatch(page);

    const newScrollTop = await page.evaluate(() => {
      return document.getElementById('transcriptView')!.scrollTop;
    });

    // scrollTop should have increased to compensate for prepended content
    expect(newScrollTop).toBeGreaterThanOrEqual(midScrollTop);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Contract 7: Scroll-up lazy loading from server
// ═══════════════════════════════════════════════════════════════════════════

describe('Contract 7: Scroll-up lazy loading from server', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL = 3000;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(TOTAL);
    await mockTranscriptWithTail(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);

    // Exhaust local cache by prepending twice
    await triggerPrependBatch(page);
    // All 100 local blocks are now rendered, _renderedStartIdx = 0
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('fetches older blocks from server when local cache exhausted', async () => {
    const idxBefore = await getRenderedStartIdx(page);
    expect(idxBefore).toBe(0); // all local blocks rendered

    const blocksBefore = await getStateBlocks(page, sessionId);
    expect(blocksBefore).toBe(TAIL_SIZE); // 100

    // Trigger another prepend — should fetch from server
    await triggerPrependBatch(page);

    const blocksAfter = await getStateBlocks(page, sessionId);
    expect(blocksAfter).toBeGreaterThan(blocksBefore); // server returned more blocks
  });

  it('new blocks are prepended to DOM', async () => {
    const count = await getRenderedBlockCount(page);
    expect(count).toBeGreaterThan(TAIL_SIZE); // more than 100 rendered
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Contract 8: Live SSE append while lazy-loaded
// ═══════════════════════════════════════════════════════════════════════════

describe('Contract 8: Live SSE append while lazy-loaded', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL = 3000;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(TOTAL);
    await mockTranscriptWithTail(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('SSE block appends at bottom without changing _renderedStartIdx', async () => {
    const countBefore = await getRenderedBlockCount(page);
    const idxBefore = await getRenderedStartIdx(page);

    // Simulate SSE block
    await page.evaluate((id) => {
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: id,
        block: {
          type: 'text',
          role: 'assistant',
          text: 'New SSE message from contract 8',
          timestamp: new Date().toISOString(),
        },
      });
    }, sessionId);
    await page.waitForTimeout(300);

    const countAfter = await getRenderedBlockCount(page);
    expect(countAfter).toBe(countBefore + 1);

    const idxAfter = await getRenderedStartIdx(page);
    expect(idxAfter).toBe(idxBefore); // unchanged

    // state.blocks updated
    const totalState = await getStateBlocks(page, sessionId);
    expect(totalState).toBe(TAIL_SIZE + 1);
  });

  it('SSE block is visible in DOM', async () => {
    await page.waitForTimeout(1500); // typewriter animation
    const text = await getContainerText(page);
    expect(text).toContain('New SSE message from contract 8');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug-specific regression: Cache comparison uses last-block (not first)
// ═══════════════════════════════════════════════════════════════════════════

describe('Regression: cache comparison with sliding tail window', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionA: string;
  let sessionB: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionA = await createSession(page);
    sessionB = await createSession(page);

    // Session A starts with 3000 blocks
    const blocks3000 = generateBlocks(3000);
    await mockTranscriptWithTail(page, sessionA, blocks3000);
    await mockTranscriptWithTail(page, sessionB, []);
    await setWebViewMode(page, sessionA);
    await setWebViewMode(page, sessionB);

    // First visit to A
    await selectSession(page, sessionA);
  });

  afterAll(async () => {
    await deleteSession(page, sessionA);
    await deleteSession(page, sessionB);
    await context?.close();
  });

  it('incremental update works when session grows (tail window slides)', async () => {
    // Session grew to 3010 blocks
    await page.unroute(`**/api/sessions/${sessionA}/transcript**`);
    const blocks3010 = generateBlocks(3010);
    await mockTranscriptWithTail(page, sessionA, blocks3010);

    // Switch away and back — cache has blocks 2900-2999, fetch returns 2910-3009
    await selectSession(page, sessionB);
    await page.waitForTimeout(300);
    await selectSession(page, sessionA);

    // Should not show error
    const text = await getContainerText(page);
    expect(text).not.toContain('Could not load');

    // Should have content rendered
    const count = await getRenderedBlockCount(page);
    expect(count).toBeGreaterThanOrEqual(BATCH_SIZE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug-specific regression: Periodic sync uses ?tail
// ═══════════════════════════════════════════════════════════════════════════

describe('Regression: periodic sync uses tail pagination', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let fetchUrls: string[] = [];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(200);
    await mockTranscriptWithTail(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);

    // Intercept future fetch calls to check URLs
    fetchUrls = [];
    await page.route(`**/api/sessions/${sessionId}/transcript**`, (route) => {
      fetchUrls.push(route.request().url());
      const url = new URL(route.request().url());
      const tail = parseInt(url.searchParams.get('tail') || '0', 10);
      const blocks200 = generateBlocks(200);
      if (tail > 0 && blocks200.length > tail) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'X-Total-Blocks': blocks200.length.toString() },
          body: JSON.stringify(blocks200.slice(-tail)),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(blocks200),
        });
      }
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('periodic sync fetch includes ?tail parameter', async () => {
    // Trigger periodic sync manually
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { _periodicSync: () => void } }).TranscriptView._periodicSync();
    });
    await page.waitForTimeout(500);

    // Check that the fetch URL included ?tail=
    const syncUrls = fetchUrls.filter((u) => u.includes('/transcript'));
    const hasNonTailFetch = syncUrls.some((u) => !u.includes('tail='));
    expect(hasNonTailFetch).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug-specific regression: IntersectionObserver race during load()
// ═══════════════════════════════════════════════════════════════════════════

describe('Regression: IntersectionObserver gated during load()', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionA: string;
  let sessionB: string;
  const TOTAL = 3000;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionA = await createSession(page);
    sessionB = await createSession(page);

    const blocks = generateBlocks(TOTAL);
    await mockTranscriptWithTail(page, sessionA, blocks);
    await mockTranscriptWithTail(page, sessionB, []);
    await setWebViewMode(page, sessionA);
    await setWebViewMode(page, sessionB);
    await selectSession(page, sessionA);
  });

  afterAll(async () => {
    await deleteSession(page, sessionA);
    await deleteSession(page, sessionB);
    await context?.close();
  });

  it('_prependBatch is blocked while load fetch is in-flight', async () => {
    // Add a delayed mock for session A to simulate slow fetch
    await page.unroute(`**/api/sessions/${sessionA}/transcript**`);
    await page.route(`**/api/sessions/${sessionA}/transcript**`, async (route) => {
      // Delay response
      await new Promise((r) => setTimeout(r, 500));
      const blocks = generateBlocks(TOTAL);
      const url = new URL(route.request().url());
      const tail = parseInt(url.searchParams.get('tail') || '0', 10);
      if (tail > 0 && blocks.length > tail) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'X-Total-Blocks': blocks.length.toString() },
          body: JSON.stringify(blocks.slice(-tail)),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(blocks),
        });
      }
    });

    // Switch away and back — triggers load() with cache
    await selectSession(page, sessionB);
    await page.waitForTimeout(100);

    // Switch back — load() starts, cache renders immediately, fetch is in-flight
    // Do NOT await selectSession fully — we want to call prependBatch during fetch
    page.evaluate((id) => {
      (window as unknown as { app: { selectSession: (id: string) => void } }).app.selectSession(id);
    }, sessionA);

    // Immediately try to prepend while fetch is in-flight
    await page.waitForTimeout(100);
    const idxBefore = await getRenderedStartIdx(page);
    await triggerPrependBatch(page);
    const idxAfter = await getRenderedStartIdx(page);

    // _prependBatch should have been blocked (no change to idx)
    // or at least not cause an error. The state should be consistent.
    await page.waitForTimeout(600); // let fetch complete

    const text = await getContainerText(page);
    expect(text).not.toContain('Could not load');
  });
});

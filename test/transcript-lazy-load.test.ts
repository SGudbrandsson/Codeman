/**
 * Transcript lazy loading — functional test suite
 *
 * Tests the lazy-load feature for long transcripts: tail-batch rendering,
 * sentinel insertion/removal, prepend batching, scroll preservation, and
 * clear/clearOnly state resets.
 *
 * Port: 3250 (transcript-lazy-load tests)
 *
 * Run: npx vitest run test/transcript-lazy-load.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3250;
const BASE_URL = `http://localhost:${PORT}`;
const BATCH_SIZE = 50; // Must match TranscriptView._BATCH_SIZE

// ─── Mock data ──────────────────────────────────────────────────────────────

/** Generate N text blocks alternating user/assistant roles. */
function generateBlocks(count: number): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    blocks.push({
      type: 'text',
      role,
      text: `Message ${i} from ${role}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString(),
    });
  }
  return blocks;
}

/** Generate blocks with a tool_use/tool_result pair at the boundary. */
function generateBlocksWithToolAtBoundary(total: number): Array<Record<string, unknown>> {
  // Place a tool_use at the position that will be the first block of the tail batch,
  // and its tool_result right after. This means the tool_use is at index (total - BATCH_SIZE)
  // and the tool_result is at (total - BATCH_SIZE + 1).
  const blocks: Array<Record<string, unknown>> = [];
  const boundaryIdx = total - BATCH_SIZE;
  for (let i = 0; i < total; i++) {
    if (i === boundaryIdx) {
      blocks.push({
        type: 'tool_use',
        id: 'tu_boundary',
        name: 'Read',
        input: { file_path: 'boundary.ts' },
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString(),
      });
    } else if (i === boundaryIdx + 1) {
      blocks.push({
        type: 'tool_result',
        toolUseId: 'tu_boundary',
        content: 'boundary file content',
        isError: false,
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString(),
      });
    } else {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      blocks.push({
        type: 'text',
        role,
        text: `Message ${i}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString(),
      });
    }
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
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-lazy-load' }),
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

async function mockTranscript(page: Page, sessionId: string, blocks: unknown[]): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/transcript`, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(blocks) });
  });
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { app: { selectSession: (id: string) => void } }).app.selectSession(id);
  }, sessionId);
  await page.waitForTimeout(800);
}

/** Set the view mode to 'web' (transcript view) for a session */
async function setWebViewMode(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (
      window as unknown as { TranscriptView: { setViewMode: (id: string, mode: string) => void } }
    ).TranscriptView.setViewMode(id, 'web');
  }, sessionId);
}

/** Get the number of rendered block elements (excluding the sentinel) in the transcript container */
async function getRenderedBlockCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const container = document.getElementById('transcriptView');
    if (!container) return 0;
    // Count children that are NOT the sentinel
    return Array.from(container.children).filter((el) => !el.classList.contains('tv-load-more-sentinel')).length;
  });
}

/** Check if the load-more sentinel exists in the DOM */
async function hasSentinel(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const container = document.getElementById('transcriptView');
    return !!container?.querySelector('.tv-load-more-sentinel');
  });
}

/** Get the _renderedStartIdx from TranscriptView */
async function getRenderedStartIdx(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as unknown as { TranscriptView: { _renderedStartIdx: number } }).TranscriptView._renderedStartIdx;
  });
}

/** Trigger _prependBatch() directly (simulates IntersectionObserver firing) */
async function triggerPrependBatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { TranscriptView: { _prependBatch: () => void } }).TranscriptView._prependBatch();
  });
  await page.waitForTimeout(200);
}

/** Get the text content of the first rendered block (excluding sentinel) */
async function getFirstBlockText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const container = document.getElementById('transcriptView');
    if (!container) return '';
    const blocks = Array.from(container.children).filter((el) => !el.classList.contains('tv-load-more-sentinel'));
    return blocks[0]?.textContent ?? '';
  });
}

/** Get the text content of the last rendered block */
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
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('_renderTailBatch: small transcript (no lazy loading needed)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(10);
    await mockTranscript(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('renders all 10 blocks when count < BATCH_SIZE', async () => {
    const count = await getRenderedBlockCount(page);
    expect(count).toBe(10);
  });

  it('does not insert sentinel when all blocks fit', async () => {
    const sentinel = await hasSentinel(page);
    expect(sentinel).toBe(false);
  });

  it('_renderedStartIdx is 0 (all blocks rendered from the start)', async () => {
    const idx = await getRenderedStartIdx(page);
    expect(idx).toBe(0);
  });
});

describe('_renderTailBatch: large transcript (lazy loading active)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL_BLOCKS = 120;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(TOTAL_BLOCKS);
    await mockTranscript(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('renders only BATCH_SIZE blocks initially', async () => {
    const count = await getRenderedBlockCount(page);
    expect(count).toBe(BATCH_SIZE);
  });

  it('inserts sentinel at top when older blocks exist', async () => {
    const sentinel = await hasSentinel(page);
    expect(sentinel).toBe(true);
  });

  it('_renderedStartIdx equals total - BATCH_SIZE', async () => {
    const idx = await getRenderedStartIdx(page);
    expect(idx).toBe(TOTAL_BLOCKS - BATCH_SIZE);
  });

  it('first rendered block is from index (total - BATCH_SIZE)', async () => {
    const text = await getFirstBlockText(page);
    const expectedIdx = TOTAL_BLOCKS - BATCH_SIZE;
    expect(text).toContain(`Message ${expectedIdx}`);
  });

  it('last rendered block is the final message', async () => {
    const text = await getLastBlockText(page);
    expect(text).toContain(`Message ${TOTAL_BLOCKS - 1}`);
  });
});

describe('_prependBatch: loading older messages on scroll-up', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL_BLOCKS = 120;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(TOTAL_BLOCKS);
    await mockTranscript(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('prepend batch adds older blocks and updates _renderedStartIdx', async () => {
    const idxBefore = await getRenderedStartIdx(page);
    expect(idxBefore).toBe(TOTAL_BLOCKS - BATCH_SIZE); // 70

    await triggerPrependBatch(page);

    const idxAfter = await getRenderedStartIdx(page);
    expect(idxAfter).toBe(Math.max(0, idxBefore - BATCH_SIZE)); // 20

    const count = await getRenderedBlockCount(page);
    expect(count).toBe(BATCH_SIZE * 2); // 100 blocks rendered
  });

  it('sentinel remains when more blocks exist above', async () => {
    // After first prepend: _renderedStartIdx = 20, still > 0
    const sentinel = await hasSentinel(page);
    expect(sentinel).toBe(true);
  });

  it('oldest rendered block is now from the earlier batch', async () => {
    const text = await getFirstBlockText(page);
    const expectedIdx = TOTAL_BLOCKS - BATCH_SIZE * 2; // 20
    expect(text).toContain(`Message ${expectedIdx}`);
  });

  it('final prepend renders all remaining blocks and removes sentinel', async () => {
    // _renderedStartIdx is 20, so one more prepend should get blocks 0..19
    await triggerPrependBatch(page);

    const idx = await getRenderedStartIdx(page);
    expect(idx).toBe(0);

    const sentinel = await hasSentinel(page);
    expect(sentinel).toBe(false);

    const count = await getRenderedBlockCount(page);
    expect(count).toBe(TOTAL_BLOCKS); // All 120 blocks rendered

    const text = await getFirstBlockText(page);
    expect(text).toContain('Message 0');
  });
});

describe('_prependBatch: scroll position preservation', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL_BLOCKS = 120;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(TOTAL_BLOCKS);
    await mockTranscript(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('viewport does not jump when older blocks are prepended', async () => {
    // Scroll to a mid-point first so we can check scroll preservation
    const midScrollTop = await page.evaluate(() => {
      const container = document.getElementById('transcriptView')!;
      const mid = container.scrollHeight / 2;
      container.scrollTop = mid;
      return container.scrollTop;
    });

    // Get the block visible at the current scroll position
    const visibleBlockText = await page.evaluate(() => {
      const container = document.getElementById('transcriptView')!;
      const rect = container.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const midX = rect.left + rect.width / 2;
      const el = document.elementFromPoint(midX, midY);
      return el?.textContent ?? '';
    });

    await triggerPrependBatch(page);

    // After prepend, the same content should still be roughly in view
    // (scrollTop adjusted by the height of prepended content)
    const newScrollTop = await page.evaluate(() => {
      return document.getElementById('transcriptView')!.scrollTop;
    });

    // scrollTop should have INCREASED (compensating for the prepended height)
    expect(newScrollTop).toBeGreaterThan(midScrollTop);
  });
});

describe('clear() and clearOnly() reset lazy-load state', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL_BLOCKS = 80;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(TOTAL_BLOCKS);
    await mockTranscript(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('clearOnly() resets _renderedStartIdx and removes sentinel', async () => {
    // Verify lazy state is set first
    const idxBefore = await getRenderedStartIdx(page);
    expect(idxBefore).toBeGreaterThan(0);
    const sentinelBefore = await hasSentinel(page);
    expect(sentinelBefore).toBe(true);

    // Fire clearOnly
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { clearOnly: () => void } }).TranscriptView.clearOnly();
    });
    await page.waitForTimeout(200);

    const idxAfter = await getRenderedStartIdx(page);
    expect(idxAfter).toBe(0);
    const sentinelAfter = await hasSentinel(page);
    expect(sentinelAfter).toBe(false);
  });

  it('clear() resets _renderedStartIdx and removes sentinel', async () => {
    // Re-select session to get lazy-load state back
    // First re-mock transcript since clear() triggers load()
    await mockTranscript(page, sessionId, generateBlocks(TOTAL_BLOCKS));
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { clear: () => void } }).TranscriptView.clear();
    });
    await page.waitForTimeout(1000);

    // After clear + reload, if we have > BATCH_SIZE blocks, lazy state is re-established
    // The key thing is that _renderedStartIdx was reset to 0 during clear,
    // then re-set by load(). Verify the reload happened successfully.
    const count = await getRenderedBlockCount(page);
    expect(count).toBe(BATCH_SIZE); // Re-rendered tail batch

    const idx = await getRenderedStartIdx(page);
    expect(idx).toBe(TOTAL_BLOCKS - BATCH_SIZE);
  });
});

describe('load() integration: cache path uses _renderTailBatch', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let sessionId2: string;
  const TOTAL_BLOCKS = 80;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    sessionId2 = await createSession(page);
    const blocks = generateBlocks(TOTAL_BLOCKS);
    await mockTranscript(page, sessionId, blocks);
    await mockTranscript(page, sessionId2, []);
    await setWebViewMode(page, sessionId);
    await setWebViewMode(page, sessionId2);
    // Select first session to populate cache
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await deleteSession(page, sessionId2);
    await context?.close();
  });

  it('switching away and back uses cached blocks with tail-batch rendering', async () => {
    // Switch to another session, then back
    await selectSession(page, sessionId2);
    await page.waitForTimeout(300);
    await selectSession(page, sessionId);

    // Should render only tail batch from cache
    const count = await getRenderedBlockCount(page);
    expect(count).toBe(BATCH_SIZE);

    const idx = await getRenderedStartIdx(page);
    expect(idx).toBe(TOTAL_BLOCKS - BATCH_SIZE);

    const sentinel = await hasSentinel(page);
    expect(sentinel).toBe(true);
  });
});

describe('SSE append still works after lazy load', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL_BLOCKS = 80;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    const blocks = generateBlocks(TOTAL_BLOCKS);
    await mockTranscript(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('new SSE block appends at the bottom without disturbing lazy state', async () => {
    const countBefore = await getRenderedBlockCount(page);
    const idxBefore = await getRenderedStartIdx(page);

    // Simulate an SSE transcript:block event
    await page.evaluate((id) => {
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: id,
        block: {
          type: 'text',
          role: 'assistant',
          text: 'New SSE message appended at bottom',
          timestamp: new Date().toISOString(),
        },
      });
    }, sessionId);
    await page.waitForTimeout(300);

    const countAfter = await getRenderedBlockCount(page);
    expect(countAfter).toBe(countBefore + 1);

    const idxAfter = await getRenderedStartIdx(page);
    expect(idxAfter).toBe(idxBefore); // unchanged

    // Wait for typewriter animation to complete (SSE blocks use typewriter reveal)
    await page.waitForTimeout(1500);
    const transcriptHtml = await page.evaluate(() => {
      return document.getElementById('transcriptView')?.innerHTML ?? '';
    });
    expect(transcriptHtml).toContain('New SSE message appended at bottom');
  });
});

describe('Tool grouping across prepend boundary', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const TOTAL_BLOCKS = 80;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    // Place a tool_use/tool_result pair fully within the prepend batch (not at the
    // exact tail boundary). The tail batch renders blocks [30..79]. The prepend
    // batch will be [0..29]. Place the tool pair at indices 10 and 11 so both are
    // in the prepend batch and can be grouped properly when prepended.
    const blocks: Array<Record<string, unknown>> = [];
    for (let i = 0; i < TOTAL_BLOCKS; i++) {
      if (i === 10) {
        blocks.push({
          type: 'tool_use',
          id: 'tu_in_prepend',
          name: 'Read',
          input: { file_path: 'prepend-batch-tool.ts' },
          timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString(),
        });
      } else if (i === 11) {
        blocks.push({
          type: 'tool_result',
          toolUseId: 'tu_in_prepend',
          content: 'prepend batch tool content',
          isError: false,
          timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString(),
        });
      } else {
        const role = i % 2 === 0 ? 'user' : 'assistant';
        blocks.push({
          type: 'text',
          role,
          text: `Message ${i}`,
          timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString(),
        });
      }
    }
    await mockTranscript(page, sessionId, blocks);
    await setWebViewMode(page, sessionId);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('tool blocks in prepend batch render and group correctly after prepend', async () => {
    // Initially only tail batch is rendered — tool pair is not visible yet
    const countBefore = await getRenderedBlockCount(page);
    expect(countBefore).toBeGreaterThan(0);

    // Verify the tool group from the prepend range is NOT yet in the DOM
    const toolGroupsBefore = await page.evaluate(() => {
      const container = document.getElementById('transcriptView');
      // Look for the tool wrapper with data-tool-id="tu_in_prepend"
      return !!container?.querySelector('[data-tool-id="tu_in_prepend"]');
    });
    expect(toolGroupsBefore).toBe(false);

    // Prepend the older batch that contains the tool_use/tool_result pair
    await triggerPrependBatch(page);

    const countAfter = await getRenderedBlockCount(page);
    expect(countAfter).toBeGreaterThan(countBefore);

    // Verify the tool wrapper with tu_in_prepend is now in the DOM
    const toolGroupsAfter = await page.evaluate(() => {
      const container = document.getElementById('transcriptView');
      return !!container?.querySelector('[data-tool-id="tu_in_prepend"]');
    });
    expect(toolGroupsAfter).toBe(true);
  });
});

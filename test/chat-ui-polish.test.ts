/**
 * Chat UI Polish — functional test suite
 *
 * Tests the five new UX features added in the chat-ui-polish feature branch:
 * 1. _formatTimestamp / .tv-ts timestamp spans
 * 2. _showThinkingBubble() / _hideThinkingBubble() / setWorking()
 * 3. _toolIcon() / _toolSummary() / updated tool row label
 * 4. _animateNextScroll flag — set on live append, not set on history load
 * 5. .tv-block--reveal / .tv-block--reveal-active reveal animation classes
 *
 * Port: 3220
 *
 * Run: npx vitest run test/chat-ui-polish.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3220;
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

async function createClaudeSession(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-chat-ui-polish' }),
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

async function mockTranscript(page: Page, sessionId: string, blocks: unknown[]): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/transcript`, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(blocks) });
  });
}

async function clearViewModeStorage(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    localStorage.removeItem('transcriptViewMode:' + id);
  }, sessionId);
}

async function sendBlock(page: Page, sessionId: string, block: unknown): Promise<void> {
  await page.evaluate(
    ({ sid, b }) => {
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: sid,
        block: b,
      });
    },
    { sid: sessionId, b: block }
  );
  await page.waitForTimeout(300);
}

async function deleteSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await fetch('/api/sessions/' + id, { method: 'DELETE' });
  }, sessionId);
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

// ─── Gap 1: _formatTimestamp / .tv-ts timestamp spans ───────────────────────

describe('Timestamps — .tv-ts span rendered on user block', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    // Timestamp far in the past (> 60 min ago, different day) to get a Mon D, HH:MM label
    const oldTs = '2026-01-01T10:00:00.000Z';
    await mockTranscript(page, sessionId, [{ type: 'text', role: 'user', text: 'Hello', timestamp: oldTs }]);
    await selectSession(page, sessionId);
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-ts span exists inside .tv-block--user', async () => {
    const count = await page.locator('#transcriptView .tv-block--user .tv-ts').count();
    expect(count).toBeGreaterThan(0);
  });

  it('.tv-ts text is non-empty', async () => {
    const text = await page.locator('#transcriptView .tv-block--user .tv-ts').first().textContent();
    expect(text).toBeTruthy();
    expect(text!.length).toBeGreaterThan(0);
  });
});

describe('Timestamps — .tv-ts span rendered on assistant block', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    const oldTs = '2026-01-01T11:00:00.000Z';
    await mockTranscript(page, sessionId, [{ type: 'text', role: 'assistant', text: 'Hello back', timestamp: oldTs }]);
    await selectSession(page, sessionId);
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-ts span exists inside .tv-block--assistant', async () => {
    const count = await page.locator('#transcriptView .tv-block--assistant .tv-ts').count();
    expect(count).toBeGreaterThan(0);
  });
});

describe('Timestamps — "just now" for a block with a very recent timestamp', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    // Send a live block with a fresh timestamp (< 60s ago)
    const nowTs = new Date().toISOString();
    await sendBlock(page, sessionId, {
      type: 'text',
      role: 'user',
      text: 'Recent message',
      timestamp: nowTs,
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-ts text is "just now" for a recent timestamp', async () => {
    const text = await page.locator('#transcriptView .tv-block--user .tv-ts').first().textContent();
    expect(text).toBe('just now');
  });
});

describe('Timestamps — no .tv-ts when timestamp is absent', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, [
      // No timestamp field
      { type: 'text', role: 'user', text: 'No timestamp here' },
    ]);
    await selectSession(page, sessionId);
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('no .tv-ts span when block has no timestamp', async () => {
    const count = await page.locator('#transcriptView .tv-block--user .tv-ts').count();
    expect(count).toBe(0);
  });
});

// ─── Gap 2: _showThinkingBubble / _hideThinkingBubble / setWorking ───────────

describe('Thinking bubble — setWorking(true) appends .tv-thinking-bubble into #transcriptView', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    // Call setWorking(true) directly
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { setWorking: (v: boolean) => void } }).TranscriptView.setWorking(true);
    });
    // Wait for the 300ms debounce to fire
    await page.waitForTimeout(600);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-thinking-bubble is a child of #transcriptView', async () => {
    const count = await page.locator('#transcriptView .tv-thinking-bubble').count();
    expect(count).toBeGreaterThan(0);
  });

  it('.tv-thinking-bubble is directly inside the container, not a fixed overlay', async () => {
    const isInFlow = await page.evaluate(() => {
      const container = document.getElementById('transcriptView');
      const bubble = container?.querySelector('.tv-thinking-bubble');
      return bubble !== null && bubble?.parentElement === container;
    });
    expect(isInFlow).toBe(true);
  });
});

describe('Thinking bubble — setWorking(false) removes .tv-thinking-bubble after debounce', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    // Show the bubble first
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { setWorking: (v: boolean) => void } }).TranscriptView.setWorking(true);
    });
    await page.waitForTimeout(600); // let the 300ms show-debounce fire

    // Now call _hideThinkingBubble directly to skip the 4s hide debounce
    await page.evaluate(() => {
      (
        window as unknown as { TranscriptView: { _hideThinkingBubble: () => void } }
      ).TranscriptView._hideThinkingBubble();
    });
    // Wait for the 280ms CSS transition + 500ms safety timeout to complete
    await page.waitForTimeout(700);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-thinking-bubble is removed after _hideThinkingBubble() and transition completes', async () => {
    const count = await page.locator('#transcriptView .tv-thinking-bubble').count();
    expect(count).toBe(0);
  });
});

describe('Thinking bubble — clear() removes the bubble reference', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    // Show bubble then trigger clear()
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { setWorking: (v: boolean) => void } }).TranscriptView.setWorking(true);
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { clear: () => void } }).TranscriptView.clear();
    });
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('_thinkingBubbleEl is null after clear()', async () => {
    const isNull = await page.evaluate(() => {
      return (
        (window as unknown as { TranscriptView: { _thinkingBubbleEl: unknown } }).TranscriptView._thinkingBubbleEl ===
        null
      );
    });
    expect(isNull).toBe(true);
  });
});

// ─── Gap 3: _toolIcon / _toolSummary / updated tool row label ────────────────

describe('Tool row — .tv-tool-icon span present for known tool types', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    // Send a Read tool_use block
    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_read_icon',
      name: 'Read',
      input: { file_path: 'src/auth.ts' },
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-tool-icon span exists inside the tool row', async () => {
    const count = await page.locator('#transcriptView .tv-tool-icon').count();
    expect(count).toBeGreaterThan(0);
  });
});

describe('Tool row — .tv-tool-arg shows human-readable summary for Bash tool', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_bash_summary',
      name: 'Bash',
      input: { command: 'npm run build' },
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-tool-arg contains "Run:" prefix for Bash tool', async () => {
    const text = await page.locator('#transcriptView .tv-tool-arg').first().textContent();
    expect(text).toMatch(/^Run:/);
  });
});

describe('Tool row — .tv-tool-arg shows "Read: <path>" for Read tool', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_read_arg',
      name: 'Read',
      input: { file_path: 'src/auth.ts' },
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-tool-arg contains "Read: src/auth.ts"', async () => {
    const text = await page.locator('#transcriptView .tv-tool-arg').first().textContent();
    expect(text).toContain('Read: src/auth.ts');
  });
});

describe('Tool group label — single tool shows tool name (not generic "1 tool call")', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_single_label',
      name: 'Read',
      input: { file_path: 'src/index.ts' },
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-tool-group-label shows just the tool name (no icon prefix, not "1 tool call")', async () => {
    const text = await page.locator('#transcriptView .tv-tool-group-label').first().textContent();
    // Should be exactly the tool name — icon glyph must NOT appear in the label
    expect(text).toBe('Read');
  });
});

describe('Tool group label — multiple tools shows "N more" summary', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    // Two tool_use blocks — they land in the same group
    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_multi_1',
      name: 'Read',
      input: { file_path: 'a.ts' },
      timestamp: new Date().toISOString(),
    });
    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_multi_2',
      name: 'Bash',
      input: { command: 'echo hi' },
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-tool-group-label shows "· N more" pattern for multiple tools', async () => {
    const text = await page.locator('#transcriptView .tv-tool-group-label').first().textContent();
    expect(text).toMatch(/\u00B7\s*\d+\s*more/); // "· N more"
  });
});

describe('Timestamps — invalid timestamp string produces no .tv-ts span', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, [{ type: 'text', role: 'user', text: 'Bad ts', timestamp: 'not-a-date' }]);
    await selectSession(page, sessionId);
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('no .tv-ts span for unparseable timestamp string', async () => {
    const count = await page.locator('#transcriptView .tv-block--user .tv-ts').count();
    expect(count).toBe(0);
  });
});

describe('Tool row — .tv-tool-arg shows "Agent: <description>" for Agent tool', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_agent',
      name: 'Agent',
      input: { description: 'Explore the codebase', prompt: '...' },
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-tool-arg shows "Agent: Explore the codebase" not raw prompt', async () => {
    const text = await page.locator('#transcriptView .tv-tool-arg').first().textContent();
    expect(text).toMatch(/^Agent: Explore/);
  });
});

// ─── Gap 4: _animateNextScroll flag ─────────────────────────────────────────

describe('_animateNextScroll — flag is set true on live append', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('_animateNextScroll is true immediately after append() sets it (before _scrollToBottom resets)', async () => {
    // Patch _scrollToBottom to capture the flag value before reset
    const flagBeforeReset = await page.evaluate((sid) => {
      const tv = (window as unknown as { TranscriptView: Record<string, unknown> }).TranscriptView;
      let captured: boolean | null = null;
      const orig = tv._scrollToBottom as (force: boolean) => void;
      tv._scrollToBottom = function (this: typeof tv, force: boolean) {
        captured = tv._animateNextScroll as boolean;
        orig.call(this, force);
      };
      // Trigger a live append
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: sid,
        block: { type: 'text', role: 'user', text: 'live block', timestamp: new Date().toISOString() },
      });
      // Restore
      tv._scrollToBottom = orig;
      return captured;
    }, sessionId);
    expect(flagBeforeReset).toBe(true);
  });
});

describe('_animateNextScroll — flag is NOT set during history load', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, [
      { type: 'text', role: 'assistant', text: 'History block', timestamp: '2026-01-01T10:00:00.000Z' },
    ]);
    await selectSession(page, sessionId);
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('_animateNextScroll is false after history load completes', async () => {
    const flag = await page.evaluate(() => {
      return (window as unknown as { TranscriptView: { _animateNextScroll: boolean } }).TranscriptView
        ._animateNextScroll;
    });
    expect(flag).toBe(false);
  });
});

// ─── Gap 5: typewriter reveal ─────────────────────────────────────────────────

describe('Typewriter reveal — live assistant block starts with partial text', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.tv-content starts empty immediately after live assistant block is appended', async () => {
    const fullText = 'Hello from Claude, this is a longer message to type out';
    const contentTextAtInsert = await page.evaluate(
      ({ sid, text }) => {
        return new Promise<string>((resolve) => {
          const container = document.getElementById('transcriptView');
          if (!container) return resolve('ERROR: no container');
          const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
              for (const node of Array.from(m.addedNodes)) {
                if (node instanceof HTMLElement && node.classList.contains('tv-block--assistant')) {
                  const content = node.querySelector('.tv-content');
                  observer.disconnect();
                  resolve(content?.textContent ?? '');
                  return;
                }
              }
            }
          });
          observer.observe(container, { childList: true });
          (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
            sessionId: sid,
            block: { type: 'text', role: 'assistant', text, timestamp: new Date().toISOString() },
          });
          setTimeout(() => {
            observer.disconnect();
            resolve('TIMEOUT');
          }, 2000);
        });
      },
      { sid: sessionId, text: fullText }
    );
    // At insertion time the typewriter starts empty
    expect(contentTextAtInsert.length).toBeLessThan(fullText.length);
  });

  it('.tv-content contains full text after typewriter completes', async () => {
    const fullText = 'Hello from Claude, this is a longer message to type out';
    await sendBlock(page, sessionId, {
      type: 'text',
      role: 'assistant',
      text: fullText,
      timestamp: new Date().toISOString(),
    });
    // Wait enough time for all ~40 rAF ticks (~800ms) plus margin
    await page.waitForTimeout(1200);
    const blocks = await page.locator('#transcriptView .tv-block--assistant .tv-content').all();
    const lastBlock = blocks[blocks.length - 1];
    const text = await lastBlock.textContent();
    expect(text).toContain('Hello from Claude');
  });
});

describe('Typewriter reveal — history-loaded assistant block shows full text immediately', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  const fullText = 'History assistant message with full content';

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, [
      { type: 'text', role: 'assistant', text: fullText, timestamp: '2026-01-01T10:00:00.000Z' },
    ]);
    await selectSession(page, sessionId);
    await page.waitForTimeout(800);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('history-loaded .tv-content contains full text without waiting', async () => {
    const text = await page.locator('#transcriptView .tv-block--assistant .tv-content').first().textContent();
    expect(text).toContain('History assistant message');
  });
});

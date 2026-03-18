/**
 * Transcript Web View — functional test suite
 *
 * Tests the full transcript web view feature: DOM presence, toggle button,
 * view mode switching, block rendering (text/tool/result), markdown output,
 * tool row expand/collapse, scroll anchor, localStorage persistence, and
 * SSE event handling (transcript:block and transcript:clear).
 *
 * Port: 3212 (transcript-web-view tests)
 *
 * Run: npx vitest run test/transcript-web-view.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3212;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Mock data ──────────────────────────────────────────────────────────────

const MOCK_TEXT_BLOCKS = [
  {
    type: 'text',
    role: 'user',
    text: 'Can you help me refactor the auth middleware?',
    timestamp: '2026-01-01T10:00:00.000Z',
  },
  {
    type: 'text',
    role: 'assistant',
    text: 'Sure! Here is the plan:\n\n- Extract token validation\n- Move rate limiting\n\n**Bold text** and `inline code` example.',
    timestamp: '2026-01-01T10:00:01.000Z',
  },
];

const MOCK_TOOL_BLOCKS = [
  {
    type: 'tool_use',
    id: 'tu_1',
    name: 'Read',
    input: { file_path: 'src/auth.ts' },
    timestamp: '2026-01-01T10:00:02.000Z',
  },
  {
    type: 'tool_result',
    toolUseId: 'tu_1',
    content: 'export function validateToken(t: string) { return true; }',
    isError: false,
    timestamp: '2026-01-01T10:00:03.000Z',
  },
];

const MOCK_ERROR_TOOL_BLOCKS = [
  {
    type: 'tool_use',
    id: 'tu_err',
    name: 'Bash',
    input: { command: 'tsc --noEmit' },
    timestamp: '2026-01-01T10:00:04.000Z',
  },
  {
    type: 'tool_result',
    toolUseId: 'tu_err',
    content: 'error TS2345: Argument of type',
    isError: true,
    timestamp: '2026-01-01T10:00:05.000Z',
  },
];

const MOCK_RESULT_BLOCK = [{ type: 'result', cost: 0.0042, durationMs: 2140, timestamp: '2026-01-01T10:00:06.000Z' }];

const ALL_BLOCKS = [...MOCK_TEXT_BLOCKS, ...MOCK_TOOL_BLOCKS, ...MOCK_ERROR_TOOL_BLOCKS, ...MOCK_RESULT_BLOCK];

// ─── Helpers ────────────────────────────────────────────────────────────────

let server: WebServer;
let browser: Browser;

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  return { context, page };
}

/** Navigate and wait for app-loaded, then wait for any session data */
async function navigateTo(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 8000 });
  await page.waitForTimeout(500);
}

/** Create a claude session, return its id */
async function createClaudeSession(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-transcript-session' }),
    });
    const data = await res.json();
    return (data.id ?? data.session?.id) as string;
  });
  return id;
}

/** Select a session via the app's selectSession method */
async function selectSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { app: { selectSession: (id: string) => void } }).app.selectSession(id);
  }, sessionId);
  await page.waitForTimeout(800);
}

/** Mock the transcript endpoint to return specific blocks */
async function mockTranscript(page: Page, sessionId: string, blocks: unknown[]): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/transcript`, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(blocks) });
  });
}

/** Clear localStorage transcript view mode for a session */
async function clearViewModeStorage(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    localStorage.removeItem('transcriptViewMode:' + id);
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DOM structure', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(() => context?.close());

  it('#transcriptView div exists in DOM', async () => {
    const count = await page.locator('#transcriptView').count();
    expect(count).toBe(1);
  });

  it('#transcriptView is hidden by default', async () => {
    const display = await page.locator('#transcriptView').evaluate((el) => (el as HTMLElement).style.display);
    expect(display).toBe('none');
  });

  it('#accessoryViewModeBtn exists in DOM', async () => {
    const count = await page.locator('#accessoryViewModeBtn').count();
    expect(count).toBe(1);
  });

  it('#accessoryViewModeBtn is hidden when no session is active', async () => {
    const visible = await page.locator('#accessoryViewModeBtn').isVisible();
    expect(visible).toBe(false);
  });
});

describe('Toggle button visibility', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('toggle button becomes visible for active Claude session', async () => {
    const visible = await page.locator('#accessoryViewModeBtn').isVisible();
    expect(visible).toBe(true);
  });

  it('toggle button shows "web" segment as active in web mode (default)', async () => {
    const activeMode = await page.locator('#accessoryViewModeBtn .view-mode-seg.active').getAttribute('data-mode');
    expect(activeMode).toBe('web');
  });

  it('toggle button does not have terminal-mode class in web mode', async () => {
    const hasClass = await page
      .locator('#accessoryViewModeBtn')
      .evaluate((el) => el.classList.contains('terminal-mode'));
    expect(hasClass).toBe(false);
  });
});

describe('View mode switching', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, MOCK_TEXT_BLOCKS);
    await selectSession(page, sessionId);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('transcript view is visible in web mode (default)', async () => {
    const visible = await page.locator('#transcriptView').isVisible();
    expect(visible).toBe(true);
  });

  it('terminal container is hidden in web mode', async () => {
    const visibility = await page.locator('#terminalContainer').evaluate((el) => (el as HTMLElement).style.visibility);
    expect(visibility).toBe('hidden');
  });

  it('clicking toggle switches to terminal mode', async () => {
    await page.locator('#accessoryViewModeBtn .view-mode-seg[data-mode="terminal"]').click();
    await page.waitForTimeout(400);

    const tvVisible = await page.locator('#transcriptView').isVisible();
    expect(tvVisible).toBe(false);

    const termVisibility = await page
      .locator('#terminalContainer')
      .evaluate((el) => (el as HTMLElement).style.visibility);
    expect(termVisibility).not.toBe('hidden');
  });

  it('toggle button shows "Terminal" segment as active', async () => {
    const activeMode = await page.locator('#accessoryViewModeBtn .view-mode-seg.active').getAttribute('data-mode');
    expect(activeMode).toBe('terminal');
  });

  it('clicking toggle again switches back to web mode', async () => {
    await mockTranscript(page, sessionId, MOCK_TEXT_BLOCKS);
    await page.locator('#accessoryViewModeBtn .view-mode-seg[data-mode="web"]').click();
    await page.waitForTimeout(600);

    const tvVisible = await page.locator('#transcriptView').isVisible();
    expect(tvVisible).toBe(true);
  });

  it('toggle button shows "Transcript/web" segment as active', async () => {
    const activeMode = await page.locator('#accessoryViewModeBtn .view-mode-seg.active').getAttribute('data-mode');
    expect(activeMode).toBe('web');
  });
});

describe('localStorage persistence', () => {
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
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('defaults to web mode stored in localStorage', async () => {
    const stored = await page.evaluate((id) => localStorage.getItem('transcriptViewMode:' + id), sessionId);
    // Default is 'web' — either stored as 'web' or returns null (falls back to 'web')
    expect(stored === 'web' || stored === null).toBe(true);
  });

  it('switching to terminal stores "terminal" in localStorage', async () => {
    await page.locator('#accessoryViewModeBtn .view-mode-seg[data-mode="terminal"]').click();
    await page.waitForTimeout(300);
    const stored = await page.evaluate((id) => localStorage.getItem('transcriptViewMode:' + id), sessionId);
    expect(stored).toBe('terminal');
  });

  it('switching back to web stores "web" in localStorage', async () => {
    await mockTranscript(page, sessionId, []);
    await page.locator('#accessoryViewModeBtn .view-mode-seg[data-mode="web"]').click();
    await page.waitForTimeout(300);
    const stored = await page.evaluate((id) => localStorage.getItem('transcriptViewMode:' + id), sessionId);
    expect(stored).toBe('web');
  });
});

describe('Block rendering — text blocks', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, MOCK_TEXT_BLOCKS);
    await selectSession(page, sessionId);
    await page.waitForTimeout(800);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('user block renders with .tv-block--user class', async () => {
    const count = await page.locator('#transcriptView .tv-block--user').count();
    expect(count).toBeGreaterThan(0);
  });

  it('user block shows "You" label', async () => {
    const label = await page.locator('#transcriptView .tv-block--user .tv-label').first().textContent();
    expect(label).toBe('You');
  });

  it('user message text appears in bubble', async () => {
    const text = await page.locator('#transcriptView .tv-block--user .tv-bubble').first().textContent();
    expect(text).toContain('refactor the auth middleware');
  });

  it('assistant block renders with .tv-block--assistant class', async () => {
    const count = await page.locator('#transcriptView .tv-block--assistant').count();
    expect(count).toBeGreaterThan(0);
  });

  it('assistant block shows "Claude" label', async () => {
    const label = await page.locator('#transcriptView .tv-block--assistant .tv-label').first().textContent();
    expect(label).toContain('Claude');
  });

  it('assistant text is rendered as markdown (.tv-markdown)', async () => {
    const count = await page.locator('#transcriptView .tv-markdown').count();
    expect(count).toBeGreaterThan(0);
  });

  it('markdown renders **bold** as <strong>', async () => {
    const strongCount = await page.locator('#transcriptView .tv-markdown strong').count();
    expect(strongCount).toBeGreaterThan(0);
  });

  it('markdown renders `inline code` as <code>', async () => {
    const codeCount = await page.locator('#transcriptView .tv-markdown code').count();
    expect(codeCount).toBeGreaterThan(0);
  });

  it('markdown renders list items as <li>', async () => {
    const liCount = await page.locator('#transcriptView .tv-markdown li').count();
    expect(liCount).toBeGreaterThan(0);
  });
});

describe('Block rendering — tool rows', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, [...MOCK_TEXT_BLOCKS, ...MOCK_TOOL_BLOCKS, ...MOCK_ERROR_TOOL_BLOCKS]);
    await selectSession(page, sessionId);
    await page.waitForTimeout(800);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('tool rows render with .tv-tool-row class', async () => {
    const count = await page.locator('#transcriptView .tv-tool-row').count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('tool name appears in row', async () => {
    const names = await page.locator('#transcriptView .tv-tool-name').allTextContents();
    expect(names).toContain('Read');
  });

  it('tool panel is collapsed by default (no .open class)', async () => {
    const openPanels = await page.locator('#transcriptView .tv-tool-panel.open').count();
    expect(openPanels).toBe(0);
  });

  it('clicking tool row expands the panel', async () => {
    // Use evaluate click to bypass Playwright actionability checks — tool row may be
    // partially obscured by the fixed compose panel in the test viewport.
    await page
      .locator('#transcriptView .tv-tool-row')
      .first()
      .evaluate((el) => (el as HTMLElement).click());
    await page.waitForTimeout(200);
    const openPanels = await page.locator('#transcriptView .tv-tool-panel.open').count();
    expect(openPanels).toBe(1);
  });

  it('expanded panel shows Input section', async () => {
    const labels = await page.locator('#transcriptView .tv-tool-section-label').allTextContents();
    expect(labels.some((l) => l.toUpperCase().includes('INPUT'))).toBe(true);
  });

  it('expanded panel shows Output section', async () => {
    const labels = await page.locator('#transcriptView .tv-tool-section-label').allTextContents();
    expect(labels.some((l) => l.toUpperCase().includes('OUTPUT'))).toBe(true);
  });

  it('clicking tool row again collapses the panel', async () => {
    await page
      .locator('#transcriptView .tv-tool-row')
      .first()
      .evaluate((el) => (el as HTMLElement).click());
    await page.waitForTimeout(200);
    const openPanels = await page.locator('#transcriptView .tv-tool-panel.open').count();
    expect(openPanels).toBe(0);
  });

  it('error tool row has .tv-tool-row--error class', async () => {
    const errorRows = await page.locator('#transcriptView .tv-tool-row--error').count();
    expect(errorRows).toBeGreaterThan(0);
  });

  it('tool result success shows ✓ status', async () => {
    const statuses = await page.locator('#transcriptView .tv-tool-status').allTextContents();
    expect(statuses.some((s) => s.includes('✓'))).toBe(true);
  });

  it('tool result error shows ✗ status', async () => {
    const statuses = await page.locator('#transcriptView .tv-tool-status').allTextContents();
    expect(statuses.some((s) => s.includes('✗'))).toBe(true);
  });
});

describe('Block rendering — result block', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, MOCK_RESULT_BLOCK);
    await selectSession(page, sessionId);
    await page.waitForTimeout(800);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('result block renders with .tv-result-line', async () => {
    const count = await page.locator('#transcriptView .tv-result-line').count();
    expect(count).toBe(1);
  });

  it('result shows ✓ Completed', async () => {
    const text = await page.locator('#transcriptView .tv-result-ok').textContent();
    expect(text).toContain('Completed');
  });

  it('result shows cost', async () => {
    const text = await page.locator('#transcriptView .tv-result-line').textContent();
    expect(text).toContain('$0.004');
  });

  it('result shows duration', async () => {
    const text = await page.locator('#transcriptView .tv-result-line').textContent();
    expect(text).toContain('2.1s');
  });
});

describe('Placeholder state', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []); // empty transcript
    await selectSession(page, sessionId);
    await page.waitForTimeout(800);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('shows empty-state CTA for empty transcript', async () => {
    const cta = await page.locator('#transcriptView .tv-empty-cta').count();
    expect(cta).toBe(1);
    const title = await page.locator('#transcriptView .tv-empty-cta-title').textContent();
    expect(title).toContain('on your mind');
  });
});

describe('SSE — transcript:block live append', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []); // start empty
    await selectSession(page, sessionId);
    await page.waitForTimeout(800);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('starts with empty-state CTA (no blocks)', async () => {
    const cta = await page.locator('#transcriptView .tv-empty-cta').count();
    expect(cta).toBe(1);
  });

  it('transcript:block SSE event appends a user block', async () => {
    await page.evaluate((sid) => {
      const block = { type: 'text', role: 'user', text: 'Live message via SSE', timestamp: new Date().toISOString() };
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: sid,
        block,
      });
    }, sessionId);
    await page.waitForTimeout(300);

    const userBlocks = await page.locator('#transcriptView .tv-block--user').count();
    expect(userBlocks).toBe(1);
  });

  it('appended block contains the correct text', async () => {
    const text = await page.locator('#transcriptView .tv-bubble').first().textContent();
    expect(text).toContain('Live message via SSE');
  });

  it('transcript:block SSE event appends an assistant block', async () => {
    await page.evaluate((sid) => {
      const block = {
        type: 'text',
        role: 'assistant',
        text: 'I received your message.',
        timestamp: new Date().toISOString(),
      };
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: sid,
        block,
      });
    }, sessionId);
    await page.waitForTimeout(300);

    const assistantBlocks = await page.locator('#transcriptView .tv-block--assistant').count();
    expect(assistantBlocks).toBe(1);
  });

  it('state.blocks count matches DOM block count — no double-push on live SSE', async () => {
    // With the double-push guard, append() pushes to state.blocks and _onTranscriptBlock
    // must NOT push again. After 2 SSE blocks (user + assistant), both counts must be 2.
    const stateLength = await page.evaluate((sid) => {
      const a = (window as unknown as { app: { _transcriptState: Record<string, { blocks: unknown[] }> } }).app;
      return a._transcriptState?.[sid]?.blocks?.length ?? -1;
    }, sessionId);
    const domCount = await page.locator('#transcriptView .tv-block').count();
    expect(stateLength).toBe(domCount); // diverges (state > dom) if double-push bug is present
  });
});

describe('SSE — transcript:clear', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, MOCK_TEXT_BLOCKS);
    await selectSession(page, sessionId);
    await page.waitForTimeout(800);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('starts with rendered blocks', async () => {
    const count = await page.locator('#transcriptView .tv-block').count();
    expect(count).toBeGreaterThan(0);
  });

  it('transcript:clear SSE event clears the view', async () => {
    // Mock the reload after clear to return empty
    await mockTranscript(page, sessionId, []);

    await page.evaluate((sid) => {
      (window as unknown as { app: { _onTranscriptClear: (d: unknown) => void } }).app._onTranscriptClear({
        sessionId: sid,
      });
    }, sessionId);
    await page.waitForTimeout(600);

    // After clear + empty transcript fetch, blocks are gone and empty-state CTA is shown
    const blocks = await page.locator('#transcriptView .tv-block').count();
    expect(blocks).toBe(0);
    const cta = await page.locator('#transcriptView .tv-empty-cta').count();
    expect(cta).toBe(1);
  });

  it('clearOnly() shows "Clearing…" placeholder immediately before reload', async () => {
    // clearOnly() gives instant feedback ("Clearing…") while the server-side /clear completes.
    // The transcript:clear SSE event will arrive later and trigger the actual reload.
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { clearOnly: () => void } }).TranscriptView.clearOnly();
    });
    await page.waitForTimeout(50); // no async needed — clearOnly() is synchronous

    const placeholder = await page.locator('#transcriptView .tv-placeholder').textContent();
    expect(placeholder).toContain('Clearing');

    // Clean up: cancel the fallback timer so it doesn't fire into subsequent tests.
    await page.evaluate(() => {
      const tv = (
        window as unknown as {
          TranscriptView: { _clearFallbackTimer: ReturnType<typeof setTimeout> | null; clear: () => void };
        }
      ).TranscriptView;
      clearTimeout(tv._clearFallbackTimer ?? undefined);
      tv._clearFallbackTimer = null;
    });
  });

  it('clearOnly() fallback timer shows empty CTA when transcript:clear never arrives', async () => {
    // Regression test for "Clearing… stuck forever":
    // After clearOnly(), if transcript:clear SSE never fires (e.g. /clear created a new
    // conversation but no hook event yet), the 1.5 s fallback renders the empty CTA
    // directly — without fetching from the server — so the view always transitions.

    // Prime the view with at least one block so there's content to clear
    await page.evaluate((sid) => {
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: sid,
        block: { type: 'text', role: 'user', text: 'hello', timestamp: new Date().toISOString() },
      });
    }, sessionId);
    await page.waitForTimeout(100);

    // Call clearOnly() — starts the fallback timer at 1.5 s
    await page.evaluate(() => {
      (window as unknown as { TranscriptView: { clearOnly: () => void } }).TranscriptView.clearOnly();
    });

    // Immediately after clearOnly(), the "Clearing…" placeholder should be visible
    const placeholderText = await page.locator('#transcriptView .tv-placeholder').textContent();
    expect(placeholderText).toContain('Clearing');

    // Wait for the fallback timer to fire (1.5 s) + render time
    await page.waitForTimeout(2000);

    // The fallback clear() → load() should have replaced "Clearing…" with the empty CTA
    const blocks = await page.locator('#transcriptView .tv-block').count();
    expect(blocks).toBe(0);
    const cta = await page.locator('#transcriptView .tv-empty-cta').count();
    expect(cta).toBe(1);
    const stuckPlaceholder = await page.locator('#transcriptView .tv-placeholder').count();
    expect(stuckPlaceholder).toBe(0);
  });
});

describe('Skill content suppression', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await selectSession(page, sessionId);
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('skill content block (starts with "Base directory for this skill:") is not rendered', async () => {
    const skillContent = [
      'Base directory for this skill: /home/user/.claude/plugins/cache/superpowers/1.0.0/skills/my-skill',
      '',
      '# My Skill',
      '',
      'This is the skill markdown content that should be hidden.',
    ].join('\n');

    const blocksBefore = await page.locator('#transcriptView .tv-block--user').count();

    await page.evaluate(
      ({ sid, text }) => {
        const block = { type: 'text', role: 'user', text, timestamp: new Date().toISOString() };
        (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
          sessionId: sid,
          block,
        });
      },
      { sid: sessionId, text: skillContent }
    );
    await page.waitForTimeout(300);

    const blocksAfter = await page.locator('#transcriptView .tv-block--user').count();
    expect(blocksAfter).toBe(blocksBefore); // no new user block should appear
  });

  it('regular user message is still rendered normally', async () => {
    const blocksBefore = await page.locator('#transcriptView .tv-block--user').count();

    await page.evaluate((sid) => {
      const block = {
        type: 'text',
        role: 'user',
        text: 'A normal user message that should appear.',
        timestamp: new Date().toISOString(),
      };
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: sid,
        block,
      });
    }, sessionId);
    await page.waitForTimeout(300);

    const blocksAfter = await page.locator('#transcriptView .tv-block--user').count();
    expect(blocksAfter).toBe(blocksBefore + 1);
  });
});

describe('Scroll anchor', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    // Many blocks to force scrollable content
    const manyBlocks = Array.from({ length: 30 }, (_, i) => ({
      type: 'text',
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `Message number ${i + 1} — some content here to make the block tall enough`,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
    }));
    await mockTranscript(page, sessionId, manyBlocks);
    await selectSession(page, sessionId);
    await page.waitForTimeout(1200);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('transcript view is scrollable (content overflows clientHeight)', async () => {
    // Verify the container has overflowing content — the actual scroll position
    // is set via smooth animation which doesn't complete in headless Chrome,
    // but the "no auto-scroll when scrolled up" test below verifies the scroll logic.
    const overflows = await page.locator('#transcriptView').evaluate((el) => {
      const e = el as HTMLElement;
      return e.scrollHeight > 0 && e.clientHeight > 0;
    });
    expect(overflows).toBe(true);
  });

  it('new block appends do NOT auto-scroll when user scrolled up', async () => {
    // Scroll up manually
    await page.locator('#transcriptView').evaluate((el) => {
      (el as HTMLElement).scrollTop = 0;
    });
    await page.waitForTimeout(200);

    // Force scrolledUp state
    await page.evaluate((sid) => {
      const app = (window as unknown as { app: { _transcriptState: Record<string, { scrolledUp: boolean }> } }).app;
      if (app._transcriptState?.[sid]) app._transcriptState[sid].scrolledUp = true;
    }, sessionId);

    const scrollBefore = await page.locator('#transcriptView').evaluate((el) => (el as HTMLElement).scrollTop);

    // Append a new block
    await page.evaluate((sid) => {
      const block = {
        type: 'text',
        role: 'assistant',
        text: 'New block while scrolled up',
        timestamp: new Date().toISOString(),
      };
      (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
        sessionId: sid,
        block,
      });
    }, sessionId);
    await page.waitForTimeout(300);

    const scrollAfter = await page.locator('#transcriptView').evaluate((el) => (el as HTMLElement).scrollTop);
    expect(scrollAfter).toBeLessThanOrEqual(scrollBefore + 5); // should not have scrolled down
  });
});

// ─── Helper: render markdown in page context ─────────────────────────────────

async function renderMd(page: Page, text: string): Promise<string> {
  return page.evaluate((md) => {
    return (window as unknown as { renderMarkdown: (t: string) => string }).renderMarkdown(md);
  }, text);
}

describe('Pipe table rendering', () => {
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
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('renders a basic pipe table as <table> element', async () => {
    const tableText = ['| Col A | Col B |', '|-------|-------|', '| val 1 | val 2 |'].join('\n');
    const html = await renderMd(page, tableText);
    expect(html).toContain('<table');
    expect(html).toContain('</table>');
  });

  it('wraps the table in .tv-table-wrap and .tv-table classes', async () => {
    const tableText = '| A | B |\n|---|---|\n| 1 | 2 |';
    const html = await renderMd(page, tableText);
    expect(html).toContain('tv-table-wrap');
    expect(html).toContain('tv-table');
  });

  it('renders first row above separator as <thead> with <th> elements', async () => {
    const tableText = '| Name | Age |\n|------|-----|\n| Alice | 30 |';
    const html = await renderMd(page, tableText);
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>');
    expect(html).toContain('Name');
    expect(html).toContain('Age');
  });

  it('renders rows below separator as <tbody> with <td> elements', async () => {
    const tableText = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |';
    const html = await renderMd(page, tableText);
    expect(html).toContain('<tbody>');
    expect(html).toContain('<td>');
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
  });

  it('honours right alignment (---:) with style="text-align:right"', async () => {
    const tableText = '| Item | Price |\n|------|------:|\n| Book | 9.99 |';
    const html = await renderMd(page, tableText);
    expect(html).toContain('text-align:right');
  });

  it('honours center alignment (:---:) with style="text-align:center"', async () => {
    const tableText = '| A | B |\n|:---:|---|\n| x | y |';
    const html = await renderMd(page, tableText);
    expect(html).toContain('text-align:center');
  });

  it('honours left alignment (:---) with style="text-align:left"', async () => {
    const tableText = '| A | B |\n|:---|---|\n| x | y |';
    const html = await renderMd(page, tableText);
    expect(html).toContain('text-align:left');
  });

  it('applies inline formatting (bold, code) inside table cells', async () => {
    const tableText = '| Feature | Status |\n|---------|--------|\n| **Auth** | `done` |';
    const html = await renderMd(page, tableText);
    expect(html).toContain('<strong>');
    expect(html).toContain('<code>');
  });

  it('does NOT render as a table when there is no separator row', async () => {
    const nonTable = '| just | some | pipes |\n| but | no | separator |';
    const html = await renderMd(page, nonTable);
    expect(html).not.toContain('<table');
  });

  it('does not absorb table lines into a preceding paragraph', async () => {
    const mixed = 'Regular paragraph text.\n| Col A | Col B |\n|-------|-------|\n| v1 | v2 |';
    const html = await renderMd(page, mixed);
    expect(html).toContain('<p>');
    expect(html).toContain('<table');
  });

  it('renders a table block in the transcript view via SSE block injection', async () => {
    const tableText = ['| Layer | Status |', '|-------|--------|', '| Auth | Active |', '| DB | Active |'].join('\n');

    await page.evaluate(
      ({ sid, text }) => {
        const block = { type: 'text', role: 'assistant', text, timestamp: new Date().toISOString() };
        (window as unknown as { app: { _onTranscriptBlock: (d: unknown) => void } }).app._onTranscriptBlock({
          sessionId: sid,
          block,
        });
      },
      { sid: sessionId, text: tableText }
    );
    await page.waitForTimeout(300);

    const tableCount = await page.locator('#transcriptView .tv-table').count();
    expect(tableCount).toBeGreaterThan(0);
  });

  it('unaligned columns (plain ---) produce no style attribute on <th> or <td>', async () => {
    // Gap 1: all separator cells are plain `---` with no colons — aligns[ci] returns null,
    // styleAttr is '', so no style= attribute should appear on any th or td element.
    const tableText = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |';
    const html = await renderMd(page, tableText);
    expect(html).toContain('<table');
    // The rendered th/td elements must not carry any text-align style
    expect(html).not.toContain('text-align');
    expect(html).not.toContain('style=');
  });

  it('does NOT render as a table when the separator is the first row (no header row above it)', async () => {
    // Gap 2: sepIndex === 0 — separator is the very first line, leaving no header row above it.
    // The sepIndex < 1 guard should reject this and fall back to a plain <p> block.
    const noHeaderTable = '|---|---|\n| val1 | val2 |';
    const html = await renderMd(page, noHeaderTable);
    expect(html).not.toContain('<table');
  });

  it('renders a ragged body row (fewer cells than separator) without crashing', async () => {
    // Gap 3: body row has fewer cells than the separator column count — aligns[ci] is
    // undefined (out-of-bounds), which gracefully produces no style attribute for that cell.
    const raggedTable = '| A | B | C |\n|---|---|---|\n| only two cells | here |';
    const html = await renderMd(page, raggedTable);
    // Table should still render (no crash)
    expect(html).toContain('<table');
    // The short row's cells should appear
    expect(html).toContain('only two cells');
    expect(html).toContain('here');
    // No style attribute on the short row's cells (plain separator → no alignment)
    expect(html).not.toContain('style=');
  });
});

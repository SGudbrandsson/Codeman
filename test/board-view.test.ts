/**
 * Board View — functional test suite
 *
 * Tests the board view UI added in the feat/board-view branch:
 * 1. Board visibility toggle (showBoard / hideBoard)
 * 2. Basic structure: four columns, correct labels, count badges
 * 3. Mock data cards: cards rendered per status, land in correct column
 * 4. Card content: title, status dot, elapsed time, next-action text
 * 5. Card click opens detail panel with correct data
 * 6. Detail panel close (overlay click, Escape key)
 * 7. SSE event handling: workItem:statusChanged moves cards, workItem:created adds cards, workItem:completed moves to Done
 * 8. Timeline feed: entries appear after SSE, timestamps formatted
 * 9. Responsive layout: single column at 767px, four columns at 1280px
 * 10. Return-to-session: selectSession() hides board
 * 11. Mock data fallback banner shown when API returns 404
 *
 * Port: 3230
 *
 * Run: npx vitest run test/board-view.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3230;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

let server: WebServer;
let browser: Browser;

async function freshPage(width = 1280): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  return { context, page };
}

async function navigateTo(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 10000 });
  await page.waitForTimeout(500);
}

async function createSession(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-board-view' }),
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

async function showBoard(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { app: { showBoard: () => void } }).app.showBoard();
  });
  // Wait for refresh() to complete (fetch + render)
  await page.waitForTimeout(600);
}

async function hideBoard(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { app: { hideBoard: () => void } }).app.hideBoard();
  });
  await page.waitForTimeout(200);
}

// Mock /api/work-items to return controlled data (using real API contract: { data: items })
async function mockWorkItemsRoute(page: Page, items: unknown[], status = 200): Promise<void> {
  await page.route('**/api/work-items', (route) => {
    if (status === 200) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: items }),
      });
    } else {
      route.fulfill({ status, body: 'Not Found' });
    }
  });
}

// Inject a work-item SSE event via the app handler
async function injectSSE(page: Page, method: string, data: unknown): Promise<void> {
  await page.evaluate(
    ({ m, d }) => {
      const a = (window as unknown as Record<string, unknown>).app as Record<string, (d: unknown) => void>;
      a[m](d);
    },
    { m: method, d: data }
  );
  await page.waitForTimeout(300);
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Gap 1: Board visibility toggle ─────────────────────────────────────────

describe('Board toggle — showBoard() makes #boardView visible', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#boardView is visible after showBoard()', async () => {
    const display = await page.evaluate(() => {
      const el = document.getElementById('boardView');
      return el ? window.getComputedStyle(el).display : 'missing';
    });
    expect(display).not.toBe('none');
    expect(display).not.toBe('missing');
  });

  it('#boardViewBtn has "active" class after showBoard()', async () => {
    const hasActive = await page.evaluate(() => {
      return document.getElementById('boardViewBtn')?.classList.contains('active') ?? false;
    });
    expect(hasActive).toBe(true);
  });
});

describe('Board toggle — hideBoard() hides #boardView', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
    await hideBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#boardView is hidden after hideBoard()', async () => {
    const display = await page.evaluate(() => {
      const el = document.getElementById('boardView');
      return el ? el.style.display : 'missing';
    });
    expect(display).toBe('none');
  });

  it('#boardViewBtn loses "active" class after hideBoard()', async () => {
    const hasActive = await page.evaluate(() => {
      return document.getElementById('boardViewBtn')?.classList.contains('active') ?? false;
    });
    expect(hasActive).toBe(false);
  });
});

// ─── Gap 2: Basic structure — four columns ───────────────────────────────────

describe('Board structure — four kanban columns rendered', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('exactly four .board-col elements exist', async () => {
    const count = await page.locator('#boardKanban .board-col').count();
    expect(count).toBe(4);
  });

  it('column labels are Queued, Working, Review, Done', async () => {
    const labels = await page.locator('#boardKanban .board-col-label').allTextContents();
    expect(labels).toEqual(['Queued', 'Working', 'Review', 'Done']);
  });

  it('each column has a .board-col-count badge', async () => {
    const counts = await page.locator('#boardKanban .board-col-count').count();
    expect(counts).toBe(4);
  });

  it('.board-col-count badge for empty column shows "0"', async () => {
    // With empty mock items, all columns should show 0
    const texts = await page.locator('#boardKanban .board-col-count').allTextContents();
    for (const t of texts) {
      expect(t).toBe('0');
    }
  });
});

// ─── Gap 3: Mock data cards land in correct columns ──────────────────────────

describe('Cards — mock data cards land in correct columns', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const mockItems = [
    {
      id: 'wi-test-q1',
      title: 'Queued task',
      status: 'queued',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
    {
      id: 'wi-test-w1',
      title: 'Working task',
      status: 'in_progress',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
    {
      id: 'wi-test-r1',
      title: 'Review task',
      status: 'review',
      createdAt: new Date(Date.now() - 10800000).toISOString(),
      assignedAgentId: null,
    },
    {
      id: 'wi-test-d1',
      title: 'Done task',
      status: 'done',
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      completedAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, mockItems);
    await showBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Queued column contains a card with "Queued task" title', async () => {
    const queuedCol = page.locator('#boardKanban .board-col[data-col="queued"]');
    const cardTitle = await queuedCol.locator('.board-card-title').first().textContent();
    expect(cardTitle).toContain('Queued task');
  });

  it('Working column contains a card with "Working task" title', async () => {
    const workingCol = page.locator('#boardKanban .board-col[data-col="working"]');
    const cardTitle = await workingCol.locator('.board-card-title').first().textContent();
    expect(cardTitle).toContain('Working task');
  });

  it('Review column contains a card with "Review task" title', async () => {
    const reviewCol = page.locator('#boardKanban .board-col[data-col="review"]');
    const cardTitle = await reviewCol.locator('.board-card-title').first().textContent();
    expect(cardTitle).toContain('Review task');
  });

  it('Done column contains a card with "Done task" title', async () => {
    const doneCol = page.locator('#boardKanban .board-col[data-col="done"]');
    const cardTitle = await doneCol.locator('.board-card-title').first().textContent();
    expect(cardTitle).toContain('Done task');
  });

  it('Queued column count badge shows 1', async () => {
    const queuedCount = await page.locator('#boardKanban .board-col[data-col="queued"] .board-col-count').textContent();
    expect(queuedCount).toBe('1');
  });
});

// ─── Gap 4: Card content ────────────────────────────────────────────────────

describe('Card content — title, status dot, elapsed, next-action text', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const mockItems = [
    {
      id: 'wi-test-c1',
      title: 'Content test item',
      status: 'in_progress',
      description: 'Test desc',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, mockItems);
    await showBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.board-card-title contains the item title', async () => {
    const title = await page.locator('#boardKanban .board-card-title').first().textContent();
    expect(title).toContain('Content test item');
  });

  it('.board-card-dot has a non-empty background color style', async () => {
    const bg = await page.evaluate(() => {
      const dot = document.querySelector('#boardKanban .board-card-dot') as HTMLElement | null;
      return dot?.style.background || dot?.style.backgroundColor || '';
    });
    expect(bg.length).toBeGreaterThan(0);
  });

  it('.board-card-elapsed shows time ago text', async () => {
    const elapsed = await page.locator('#boardKanban .board-card-elapsed').first().textContent();
    expect(elapsed).toBeTruthy();
    expect(elapsed!.length).toBeGreaterThan(0);
  });

  it('.board-card-next-action shows "In progress — check transcript" for in_progress status', async () => {
    const action = await page.locator('#boardKanban .board-card-next-action').first().textContent();
    expect(action).toContain('In progress');
  });

  it('.board-card-agent shows "Unassigned" when no agent assigned', async () => {
    const agent = await page.locator('#boardKanban .board-card-agent').first().textContent();
    expect(agent).toContain('Unassigned');
  });
});

// ─── Gap 5: Card click opens detail panel ────────────────────────────────────

describe('Detail panel — card click opens panel with correct data', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const mockItems = [
    {
      id: 'wi-panel-test',
      title: 'Panel test item',
      status: 'review',
      description: 'Detailed description here',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
      branchName: null,
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, mockItems);
    await showBoard(page);
    // Click the first card to open the detail panel
    await page.locator('#boardKanban .board-card').first().click();
    await page.waitForTimeout(400);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#workItemPanel has "open" class after card click', async () => {
    const hasOpen = await page.evaluate(() => {
      return document.getElementById('workItemPanel')?.classList.contains('open') ?? false;
    });
    expect(hasOpen).toBe(true);
  });

  it('#workItemPanelOverlay has "open" class after card click', async () => {
    const hasOpen = await page.evaluate(() => {
      return document.getElementById('workItemPanelOverlay')?.classList.contains('open') ?? false;
    });
    expect(hasOpen).toBe(true);
  });

  it('detail panel shows the work item title', async () => {
    const titleText = await page.locator('#workItemPanel .wip-title').first().textContent();
    expect(titleText).toContain('Panel test item');
  });

  it('detail panel shows the work item id', async () => {
    const idText = await page.locator('#workItemPanel .wip-id').first().textContent();
    expect(idText).toContain('wi-panel-test');
  });
});

// ─── Gap 6: Detail panel close ───────────────────────────────────────────────

describe('Detail panel close — overlay click closes panel', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const mockItems = [
    {
      id: 'wi-close-test',
      title: 'Close test item',
      status: 'queued',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, mockItems);
    await showBoard(page);
    // Open panel
    await page.locator('#boardKanban .board-card').first().click();
    await page.waitForTimeout(400);
    // Click overlay to close
    await page.locator('#workItemPanelOverlay').click();
    await page.waitForTimeout(300);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#workItemPanel loses "open" class after overlay click', async () => {
    const hasOpen = await page.evaluate(() => {
      return document.getElementById('workItemPanel')?.classList.contains('open') ?? false;
    });
    expect(hasOpen).toBe(false);
  });
});

describe('Detail panel close — Escape key closes panel', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const mockItems = [
    {
      id: 'wi-esc-test',
      title: 'Escape test item',
      status: 'queued',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, mockItems);
    await showBoard(page);
    // Open panel
    await page.locator('#boardKanban .board-card').first().click();
    await page.waitForTimeout(400);
    // Press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#workItemPanel loses "open" class after Escape key', async () => {
    const hasOpen = await page.evaluate(() => {
      return document.getElementById('workItemPanel')?.classList.contains('open') ?? false;
    });
    expect(hasOpen).toBe(false);
  });
});

// ─── Gap 7: SSE event handling ───────────────────────────────────────────────

describe('SSE — workItem:statusChanged moves card to new column', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const mockItems = [
    {
      id: 'wi-sse-status',
      title: 'SSE status test',
      status: 'queued',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, mockItems);
    await showBoard(page);
    // Inject statusChanged SSE: move wi-sse-status from queued -> in_progress
    await injectSSE(page, '_onWorkItemStatusChanged', { id: 'wi-sse-status', status: 'in_progress' });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('card moves out of Queued column after statusChanged to in_progress', async () => {
    const queuedCards = await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').count();
    expect(queuedCards).toBe(0);
  });

  it('card appears in Working column after statusChanged to in_progress', async () => {
    const workingCards = await page.locator('#boardKanban .board-col[data-col="working"] .board-card').count();
    expect(workingCards).toBe(1);
  });
});

describe('SSE — workItem:created adds a new card to the board', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
    // Initially empty board — now inject a new work item via SSE
    await injectSSE(page, '_onWorkItemCreated', {
      id: 'wi-sse-new',
      title: 'Brand new SSE item',
      status: 'queued',
      createdAt: new Date().toISOString(),
      assignedAgentId: null,
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('new card appears in Queued column after workItem:created SSE', async () => {
    const queuedCards = await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').count();
    expect(queuedCards).toBe(1);
  });

  it('new card title matches the SSE data title', async () => {
    const title = await page
      .locator('#boardKanban .board-col[data-col="queued"] .board-card-title')
      .first()
      .textContent();
    expect(title).toContain('Brand new SSE item');
  });
});

describe('SSE — workItem:completed moves card to Done column', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const mockItems = [
    {
      id: 'wi-sse-complete',
      title: 'Complete me',
      status: 'in_progress',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, mockItems);
    await showBoard(page);
    // Inject completed SSE
    await injectSSE(page, '_onWorkItemCompleted', {
      id: 'wi-sse-complete',
      completedAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('card is no longer in Working column after completed event', async () => {
    const workingCards = await page.locator('#boardKanban .board-col[data-col="working"] .board-card').count();
    expect(workingCards).toBe(0);
  });

  it('card appears in Done column after completed event', async () => {
    const doneCards = await page.locator('#boardKanban .board-col[data-col="done"] .board-card').count();
    expect(doneCards).toBe(1);
  });
});

// ─── Gap 8: Timeline feed ────────────────────────────────────────────────────

describe('Timeline feed — entries appear after SSE events', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);

    // Reset timeline to empty so we know exactly what to expect
    await page.evaluate(() => {
      (window as unknown as { app: { boardView: { _timeline: unknown[] } } }).app.boardView._timeline = [];
    });

    // Inject a status change SSE — this triggers addTimelineEvent
    await injectSSE(page, '_onWorkItemStatusChanged', {
      id: 'wi-timeline-test',
      title: 'Timeline item',
      status: 'review',
      agentName: 'TestAgent',
      ts: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('at least one .board-timeline-entry appears in #boardTimelineFeed', async () => {
    const count = await page.locator('#boardTimelineFeed .board-timeline-entry').count();
    expect(count).toBeGreaterThan(0);
  });

  it('.board-timeline-ts element contains formatted time text', async () => {
    const tsText = await page.locator('#boardTimelineFeed .board-timeline-ts').first().textContent();
    expect(tsText).toBeTruthy();
    expect(tsText!.length).toBeGreaterThan(0);
  });

  it('.board-timeline-actor shows the agent name from SSE event', async () => {
    const actorText = await page.locator('#boardTimelineFeed .board-timeline-actor').first().textContent();
    expect(actorText).toContain('TestAgent');
  });

  it('.board-timeline-desc contains the action description', async () => {
    const descText = await page.locator('#boardTimelineFeed .board-timeline-desc').first().textContent();
    expect(descText).toBeTruthy();
    expect(descText!.length).toBeGreaterThan(0);
  });
});

// ─── Gap 9: Responsive layout ────────────────────────────────────────────────

describe('Responsive layout — four columns at 1280px wide', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage(1280));
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#boardKanban has four .board-col children at 1280px', async () => {
    const count = await page.locator('#boardKanban .board-col').count();
    expect(count).toBe(4);
  });
});

describe('Responsive layout — board stacks at 767px wide', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage(767));
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#boardKanban columns stack vertically at 767px (each occupies full width)', async () => {
    // At narrow width, each column's computed width should approach the container width
    // (grid-template-columns: 1fr in a single-column layout means each col = 100% width)
    const result = await page.evaluate(() => {
      const kanban = document.getElementById('boardKanban');
      const col = kanban?.querySelector('.board-col') as HTMLElement | null;
      if (!kanban || !col) return { kanbanWidth: 0, colWidth: 0 };
      return {
        kanbanWidth: kanban.getBoundingClientRect().width,
        colWidth: col.getBoundingClientRect().width,
      };
    });
    // Column width should be close to kanban container width (within 5% tolerance)
    // This verifies single-column stacked layout
    const ratio = result.colWidth / result.kanbanWidth;
    expect(ratio).toBeGreaterThan(0.9);
  });
});

// ─── Gap 10: Return-to-session hides board ───────────────────────────────────

describe('Return to session — selectSession() hides the board', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
    // Calling selectSession should hide the board
    await page.evaluate((id) => {
      (window as unknown as { app: { selectSession: (id: string) => void } }).app.selectSession(id);
    }, sessionId);
    await page.waitForTimeout(600);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#boardView is hidden after selectSession()', async () => {
    const display = await page.evaluate(() => {
      const el = document.getElementById('boardView');
      return el ? el.style.display : 'missing';
    });
    expect(display).toBe('none');
  });

  it('_boardVisible is false after selectSession()', async () => {
    const boardVisible = await page.evaluate(() => {
      return (window as unknown as { app: { _boardVisible: boolean } }).app._boardVisible;
    });
    expect(boardVisible).toBe(false);
  });
});

// ─── Gap 11: Mock data fallback banner ───────────────────────────────────────

describe('Mock data banner — shown when API returns 404', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    // Route /api/work-items to return 404 — triggers mock data fallback
    await mockWorkItemsRoute(page, [], 404);
    await showBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.board-mock-banner is present when API returns 404', async () => {
    const count = await page.locator('#boardView .board-mock-banner').count();
    expect(count).toBe(1);
  });

  it('.board-mock-banner contains text about mock data', async () => {
    const text = await page.locator('#boardView .board-mock-banner').first().textContent();
    expect(text).toMatch(/mock/i);
  });

  it('mock data cards are rendered in columns (MOCK_ITEMS loaded)', async () => {
    // MOCK_ITEMS has 4 items — total card count should be 4
    const totalCards = await page.locator('#boardKanban .board-card').count();
    expect(totalCards).toBe(4);
  });
});

// ─── New tests: Bug 2 — real API data parsed correctly ───────────────────────

describe('Bug 2 — real API data: board shows cards from data.data format', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const realItems = [
    {
      id: 'wi-real-01',
      title: 'Real API card',
      status: 'queued',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
    {
      id: 'wi-real-02',
      title: 'Real in-progress card',
      status: 'in_progress',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, realItems);
    await showBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 2 — real API data: cards appear in board (data.data parsed correctly)', async () => {
    const totalCards = await page.locator('#boardKanban .board-card').count();
    expect(totalCards).toBe(2);
  });

  it('Bug 2 — real API data: no mock banner shown when real data returned', async () => {
    const bannerCount = await page.locator('#boardView .board-mock-banner').count();
    expect(bannerCount).toBe(0);
  });
});

// ─── New tests: Bug 1 — New Work Item dialog ─────────────────────────────────

describe('Bug 1 — New Work Item dialog: opens and has correct fields', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
    // Click the "+ New Work Item" button
    await page.evaluate(() => {
      (
        window as unknown as { app: { boardView: { openNewItemDialog: () => void } } }
      ).app.boardView.openNewItemDialog();
    });
    await page.waitForTimeout(300);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 1 — dialog opens: #newWorkItemDialog is visible', async () => {
    const visible = await page.evaluate(() => {
      const dlg = document.getElementById('newWorkItemDialog');
      if (!dlg) return false;
      return window.getComputedStyle(dlg).display !== 'none';
    });
    expect(visible).toBe(true);
  });

  it('Bug 1 — dialog has title input field', async () => {
    const count = await page.locator('#newWorkItemDialog #nwi-title').count();
    expect(count).toBe(1);
  });

  it('Bug 1 — dialog has description textarea', async () => {
    const count = await page.locator('#newWorkItemDialog #nwi-description').count();
    expect(count).toBe(1);
  });

  it('Bug 1 — dialog has source select with manual/asana/github/clockwork options', async () => {
    const options = await page.locator('#newWorkItemDialog #nwi-source option').allTextContents();
    expect(options).toContain('manual');
    expect(options).toContain('asana');
    expect(options).toContain('github');
    expect(options).toContain('clockwork');
  });

  it('Bug 1 — dialog has externalRef input', async () => {
    const count = await page.locator('#newWorkItemDialog #nwi-externalRef').count();
    expect(count).toBe(1);
  });

  it('Bug 1 — dialog has externalUrl input', async () => {
    const count = await page.locator('#newWorkItemDialog #nwi-externalUrl').count();
    expect(count).toBe(1);
  });
});

describe('Bug 1 — dialog cancel removes it from DOM', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
    await page.evaluate(() => {
      (
        window as unknown as { app: { boardView: { openNewItemDialog: () => void } } }
      ).app.boardView.openNewItemDialog();
    });
    await page.waitForTimeout(200);
    // Click cancel button
    await page.locator('#newWorkItemDialog .board-btn-refresh').click();
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 1 — cancel closes dialog: #newWorkItemDialog removed from DOM', async () => {
    const count = await page.locator('#newWorkItemDialog').count();
    expect(count).toBe(0);
  });
});

describe('Bug 1 — backdrop click closes dialog', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
    await page.evaluate(() => {
      (
        window as unknown as { app: { boardView: { openNewItemDialog: () => void } } }
      ).app.boardView.openNewItemDialog();
    });
    await page.waitForTimeout(200);
    // Click the overlay backdrop (the dialog's outer element)
    await page.locator('#newWorkItemDialog').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 1 — backdrop click closes dialog', async () => {
    const count = await page.locator('#newWorkItemDialog').count();
    expect(count).toBe(0);
  });
});

describe('Bug 1 — empty title prevents submit', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
    await page.evaluate(() => {
      (
        window as unknown as { app: { boardView: { openNewItemDialog: () => void } } }
      ).app.boardView.openNewItemDialog();
    });
    await page.waitForTimeout(200);
    // Submit with empty title
    await page.locator('#newWorkItemDialog .board-btn-new').click();
    await page.waitForTimeout(200);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 1 — empty title prevents submit: dialog stays open', async () => {
    const count = await page.locator('#newWorkItemDialog').count();
    expect(count).toBe(1);
  });

  it('Bug 1 — empty title: error message is shown', async () => {
    const errorVisible = await page.evaluate(() => {
      const err = document.querySelector('#newWorkItemDialog #nwi-error') as HTMLElement | null;
      return err ? err.style.display !== 'none' : false;
    });
    expect(errorVisible).toBe(true);
  });
});

describe('Bug 1 — submit POSTs to /api/work-items and closes dialog on success', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let postedBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);

    // Mock POST /api/work-items to capture body and return success
    await page.route('**/api/work-items', async (route) => {
      if (route.request().method() === 'POST') {
        postedBody = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              id: 'wi-new-created',
              title: postedBody!['title'],
              status: 'queued',
              source: 'manual',
              createdAt: new Date().toISOString(),
              assignedAgentId: null,
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    await page.evaluate(() => {
      (
        window as unknown as { app: { boardView: { openNewItemDialog: () => void } } }
      ).app.boardView.openNewItemDialog();
    });
    await page.waitForTimeout(200);
    await page.fill('#nwi-title', 'Test Item');
    await page.locator('#newWorkItemDialog .board-btn-new').click();
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 1 — submit: POST was made to /api/work-items with correct title', () => {
    expect(postedBody).not.toBeNull();
    expect(postedBody!['title']).toBe('Test Item');
  });

  it('Bug 1 — submit success: dialog is closed (removed from DOM)', async () => {
    const count = await page.locator('#newWorkItemDialog').count();
    expect(count).toBe(0);
  });
});

describe('Bug 1 — created item appears in Queued column via SSE', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
    // Inject SSE workItem:created as would happen server-side after POST
    await injectSSE(page, '_onWorkItemCreated', {
      id: 'wi-dialog-sse-01',
      title: 'Dialog SSE Item',
      status: 'queued',
      createdAt: new Date().toISOString(),
      assignedAgentId: null,
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 1 — created item: appears in Queued column after SSE event', async () => {
    const count = await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').count();
    expect(count).toBe(1);
  });

  it('Bug 1 — created item: card title matches SSE data', async () => {
    const title = await page
      .locator('#boardKanban .board-col[data-col="queued"] .board-card-title')
      .first()
      .textContent();
    expect(title).toContain('Dialog SSE Item');
  });
});

// ─── New tests: Bug 3 — Card interactions ────────────────────────────────────

describe('Bug 3 — Claim button calls /claim API', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let claimCalled = false;
  let claimBody: Record<string, unknown> | null = null;

  const queuedItem = {
    id: 'wi-claim-01',
    title: 'Claimable item',
    status: 'queued',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [queuedItem]);

    // Intercept POST /api/work-items/:id/claim
    await page.route('**/api/work-items/wi-claim-01/claim', async (route) => {
      if (route.request().method() === 'POST') {
        claimCalled = true;
        claimBody = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { ...queuedItem, assignedAgentId: 'agent-test', assignedAt: new Date().toISOString() },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    // Click the queued card to open detail panel
    await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').first().click();
    await page.waitForTimeout(400);
    // Click the Claim button
    await page.locator('#workItemPanel #wipClaimBtn').click();
    await page.waitForTimeout(200);
    // Fill in agent ID and submit
    await page.fill('#workItemPanel #wipClaimForm input', 'agent-test');
    await page.locator('#workItemPanel #wipClaimForm .board-btn-new').click();
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 3 — Claim: POST to /api/work-items/:id/claim was made', () => {
    expect(claimCalled).toBe(true);
  });

  it('Bug 3 — Claim: request body contains agentId', () => {
    expect(claimBody).not.toBeNull();
    expect(claimBody!['agentId']).toBe('agent-test');
  });
});

describe('Bug 3 — Change Status moves card to new column', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const queuedItem = {
    id: 'wi-status-01',
    title: 'Status change item',
    status: 'queued',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [queuedItem]);

    // Intercept PATCH /api/work-items/:id
    await page.route('**/api/work-items/wi-status-01', async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { ...queuedItem, status: body.status },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').first().click();
    await page.waitForTimeout(400);
    await page.locator('#workItemPanel #wipChangeStatusBtn').click();
    await page.waitForTimeout(200);
    // Select 'in_progress' from the status select
    await page.selectOption('#workItemPanel #wipStatusForm select', 'in_progress');
    await page.locator('#workItemPanel #wipStatusForm .board-btn-new').click();
    await page.waitForTimeout(600);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 3 — Change Status: card moved to Working column', async () => {
    const workingCount = await page.locator('#boardKanban .board-col[data-col="working"] .board-card').count();
    expect(workingCount).toBe(1);
  });

  it('Bug 3 — Change Status: Queued column is now empty', async () => {
    const queuedCount = await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').count();
    expect(queuedCount).toBe(0);
  });
});

describe('Bug 3 — Add Dependency calls /dependencies API', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let depCalled = false;
  let depBody: Record<string, unknown> | null = null;

  const item = {
    id: 'wi-dep-01',
    title: 'Dependency target',
    status: 'queued',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [item]);

    await page.route('**/api/work-items/wi-dep-01/dependencies', async (route) => {
      if (route.request().method() === 'POST') {
        depCalled = true;
        depBody = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { id: 'dep-1', dependsOnId: depBody!['dependsOnId'] } }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').first().click();
    await page.waitForTimeout(400);
    await page.locator('#workItemPanel #wipAddDepBtn').click();
    await page.waitForTimeout(200);
    await page.fill('#workItemPanel #wipDepForm input', 'wi-dep-99');
    await page.locator('#workItemPanel #wipDepForm .board-btn-new').click();
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 3 — Add Dependency: POST to /api/work-items/:id/dependencies was made', () => {
    expect(depCalled).toBe(true);
  });

  it('Bug 3 — Add Dependency: request body contains dependsOnId', () => {
    expect(depBody).not.toBeNull();
    expect(depBody!['dependsOnId']).toBe('wi-dep-99');
  });
});

describe('Bug 3 — clicking second card while panel open switches content', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const items = [
    {
      id: 'wi-switch-a',
      title: 'Card A',
      status: 'queued',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      assignedAgentId: null,
    },
    {
      id: 'wi-switch-b',
      title: 'Card B',
      status: 'queued',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, items);
    await showBoard(page);
    // Click card A
    await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').nth(0).click();
    await page.waitForTimeout(400);
    // Click card B while panel is open
    await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').nth(1).click();
    await page.waitForTimeout(400);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 3 — card switch: panel now shows Card B title', async () => {
    const titleText = await page.locator('#workItemPanel .wip-title').first().textContent();
    expect(titleText).toContain('Card B');
  });

  it('Bug 3 — card switch: panel is still open', async () => {
    const hasOpen = await page.evaluate(() => {
      return document.getElementById('workItemPanel')?.classList.contains('open') ?? false;
    });
    expect(hasOpen).toBe(true);
  });
});

// ─── New tests: Enhancement — inline status select on cards ──────────────────

describe('Enhancement — inline status select on board cards', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const items = [
    {
      id: 'wi-inline-01',
      title: 'Inline status item',
      status: 'queued',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      assignedAgentId: null,
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, items);
    await showBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Enhancement — each .board-card has a .board-card-status-select element', async () => {
    const selectCount = await page.locator('#boardKanban .board-card .board-card-status-select').count();
    const cardCount = await page.locator('#boardKanban .board-card').count();
    expect(selectCount).toBe(cardCount);
    expect(selectCount).toBeGreaterThan(0);
  });

  it('Enhancement — .board-card-status-select is pre-selected to card status', async () => {
    const selectedValue = await page.evaluate(() => {
      const select = document.querySelector(
        '#boardKanban .board-card .board-card-status-select'
      ) as HTMLSelectElement | null;
      return select?.value ?? '';
    });
    expect(selectedValue).toBe('queued');
  });
});

describe('Enhancement — inline status change moves card to new column', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const item = {
    id: 'wi-inline-move-01',
    title: 'Inline move item',
    status: 'queued',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [item]);

    // Intercept PATCH
    await page.route('**/api/work-items/wi-inline-move-01', async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { ...item, status: body.status },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    // Change status via inline select
    await page.selectOption(
      '#boardKanban .board-col[data-col="queued"] .board-card .board-card-status-select',
      'review'
    );
    await page.waitForTimeout(600);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Enhancement — card moves to Review column after inline status change', async () => {
    const reviewCount = await page.locator('#boardKanban .board-col[data-col="review"] .board-card').count();
    expect(reviewCount).toBe(1);
  });

  it('Enhancement — Queued column is empty after inline status change', async () => {
    const queuedCount = await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').count();
    expect(queuedCount).toBe(0);
  });

  it('Enhancement — count badge for Review column updates to 1', async () => {
    const reviewBadge = await page.locator('#boardKanban .board-col[data-col="review"] .board-col-count').textContent();
    expect(reviewBadge).toBe('1');
  });
});

// ─── New tests: Bug 4 — SSE updates reflected when board becomes visible ─────

describe('Bug 4 — SSE updates reflected when board becomes visible', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, []);
    await showBoard(page);
    // Hide the board
    await hideBoard(page);
    // Inject SSE while board is hidden
    await injectSSE(page, '_onWorkItemCreated', {
      id: 'wi-sse-hidden-01',
      title: 'Hidden SSE Card',
      status: 'queued',
      createdAt: new Date().toISOString(),
      assignedAgentId: null,
    });
    // Show board again — should use render() from _dirtyFromSSE flag
    await page.evaluate(() => {
      (window as unknown as { app: { showBoard: () => void } }).app.showBoard();
    });
    await page.waitForTimeout(600);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('Bug 4 — SSE card appears in Queued column when board becomes visible', async () => {
    const count = await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').count();
    expect(count).toBe(1);
  });

  it('Bug 4 — SSE card title matches injected event', async () => {
    const title = await page
      .locator('#boardKanban .board-col[data-col="queued"] .board-card-title')
      .first()
      .textContent();
    expect(title).toContain('Hidden SSE Card');
  });
});

// ─── Gap: Blocked card shows blocker indicator from _blockerMap ───────────────

describe('Blocked card shows blocker indicator from _blockerMap', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const blockedItem = {
    id: 'wi-blocked-card',
    title: 'Blocked Card Item',
    status: 'blocked',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);

    // Mock GET /api/work-items to return a blocked item
    await mockWorkItemsRoute(page, [blockedItem]);

    // Mock GET /api/work-items/:id/dependencies so _blockerMap is populated
    await page.route('**/api/work-items/wi-blocked-card/dependencies', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              blockers: [
                {
                  id: 'wi-blocker-source',
                  title: 'Upstream Blocker',
                  status: 'in_progress',
                  depId: 'wi-blocker-source',
                },
              ],
              blockedBy: [],
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('blocked card renders in Queued column', async () => {
    const count = await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').count();
    expect(count).toBe(1);
  });

  it('blocked card shows "Blocked by:" indicator text', async () => {
    const cardText = await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').first().textContent();
    expect(cardText).toContain('Blocked by:');
  });

  it('blocked card indicator includes the blocker title', async () => {
    const cardText = await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').first().textContent();
    expect(cardText).toContain('Upstream Blocker');
  });
});

// ─── Gap: Detail panel shows Blocked By section for blocked items ─────────────

describe('Detail panel — Blocked By section renders with blocker info', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const blockedItem = {
    id: 'wi-panel-blocked',
    title: 'Panel Blocked Item',
    status: 'blocked',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [blockedItem]);

    // Mock deps route — returns one blocker
    await page.route('**/api/work-items/wi-panel-blocked/dependencies', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              blockers: [
                { id: 'wi-blocker-dep', title: 'Blocking Task', status: 'in_progress', depId: 'wi-blocker-dep' },
              ],
              blockedBy: [],
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    // Click the blocked card to open detail panel
    await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').first().click();
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('detail panel is open after clicking blocked card', async () => {
    const hasOpen = await page.evaluate(() => {
      return document.getElementById('workItemPanel')?.classList.contains('open') ?? false;
    });
    expect(hasOpen).toBe(true);
  });

  it('detail panel shows "Blocked By" section header', async () => {
    const panelText = await page.locator('#workItemPanel').textContent();
    expect(panelText).toContain('Blocked By');
  });

  it('detail panel shows blocker title in Blocked By section', async () => {
    const panelText = await page.locator('#workItemPanel').textContent();
    expect(panelText).toContain('Blocking Task');
  });

  it('detail panel shows #wipUnblockBtn (Unblock All button) for blocked item', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('wipUnblockBtn'));
    expect(exists).toBe(true);
  });

  it('detail panel shows .wip-remove-blocker button for each blocker', async () => {
    const count = await page.locator('#workItemPanel .wip-remove-blocker').count();
    expect(count).toBe(1);
  });
});

// ─── Gap: .wip-remove-blocker calls DELETE and refreshes panel ────────────────

describe('Detail panel — .wip-remove-blocker calls DELETE /api/work-items/:id/dependencies/:blockerId', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let deleteCalled = false;
  let deleteUrl = '';

  const blockedItem = {
    id: 'wi-remove-blocker',
    title: 'Remove Blocker Item',
    status: 'blocked',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [blockedItem]);

    // Mock GET deps — one blocker
    await page.route('**/api/work-items/wi-remove-blocker/dependencies', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              blockers: [{ id: 'wi-dep-source', title: 'Dep Source', status: 'queued', depId: 'wi-dep-source' }],
              blockedBy: [],
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Mock DELETE deps/:blockerId — separate URL with the blocker id segment
    await page.route('**/api/work-items/wi-remove-blocker/dependencies/wi-dep-source', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        deleteUrl = route.request().url();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').first().click();
    await page.waitForTimeout(500);
    // Click the remove blocker button
    await page.locator('#workItemPanel .wip-remove-blocker').first().click();
    await page.waitForTimeout(400);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('.wip-remove-blocker click calls DELETE on the dependency', () => {
    expect(deleteCalled).toBe(true);
  });

  it('DELETE URL includes the blocker id', () => {
    expect(deleteUrl).toContain('wi-dep-source');
  });
});

// ─── Gap: #wipUnblockBtn removes all blockers, PATCHes to queued ──────────────

describe('Detail panel — #wipUnblockBtn removes blockers and patches status to queued', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let deleteCalled = false;
  let patchBody: Record<string, unknown> | null = null;

  const blockedItem = {
    id: 'wi-unblock-all',
    title: 'Unblock All Item',
    status: 'blocked',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [blockedItem]);

    // Mock GET deps
    await page.route('**/api/work-items/wi-unblock-all/dependencies', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              blockers: [{ id: 'wi-blocker-unblock', title: 'Blocker', status: 'queued', depId: 'wi-blocker-unblock' }],
              blockedBy: [],
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Mock DELETE deps/:blockerId — the Unblock All handler deletes each blocker by id
    await page.route('**/api/work-items/wi-unblock-all/dependencies/wi-blocker-unblock', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      } else {
        await route.continue();
      }
    });

    // Mock PATCH to capture status update
    await page.route('**/api/work-items/wi-unblock-all', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { ...blockedItem, status: 'queued' } }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').first().click();
    await page.waitForTimeout(500);
    // Click Unblock All
    await page.locator('#workItemPanel #wipUnblockBtn').click();
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#wipUnblockBtn click calls DELETE on each blocker dependency', () => {
    expect(deleteCalled).toBe(true);
  });

  it('#wipUnblockBtn click sends PATCH with status queued', () => {
    expect(patchBody).not.toBeNull();
    expect(patchBody!['status']).toBe('queued');
  });
});

// ─── Gap: #wipOpenSessionBtn disabled when no worktreePath and no assignedAgentId ─

describe('Detail panel — #wipOpenSessionBtn is disabled when no session is linked', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const itemNoSession = {
    id: 'wi-no-session',
    title: 'No Session Item',
    status: 'blocked',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
    worktreePath: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [itemNoSession]);

    await page.route('**/api/work-items/wi-no-session/dependencies', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { blockers: [], blockedBy: [] } }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').first().click();
    await page.waitForTimeout(500);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#wipOpenSessionBtn exists in the detail panel', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('wipOpenSessionBtn'));
    expect(exists).toBe(true);
  });

  it('#wipOpenSessionBtn is disabled when worktreePath and assignedAgentId are both null', async () => {
    const isDisabled = await page.evaluate(() => {
      const btn = document.getElementById('wipOpenSessionBtn') as HTMLButtonElement | null;
      return btn?.disabled ?? false;
    });
    expect(isDisabled).toBe(true);
  });
});

// ─── Gap: #wipOpenSessionBtn enabled — finds session by worktreePath ──────────

describe('Detail panel — #wipOpenSessionBtn finds session by worktreePath', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let selectSessionId: string | null = null;

  const itemWithPath = {
    id: 'wi-open-sess-wt',
    title: 'Open by worktree',
    status: 'queued',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
    worktreePath: '/tmp/test-worktree-path',
  };

  const matchingSession = { id: 'sess-wt-match', name: 'Worktree Session', workingDir: '/tmp/test-worktree-path' };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [itemWithPath]);

    // Deps route — no blockers
    await page.route('**/api/work-items/wi-open-sess-wt/dependencies', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { blockers: [], blockedBy: [] } }),
        });
      } else {
        await route.continue();
      }
    });

    // Sessions list returns a session whose workingDir matches the worktreePath
    await page.route('**/api/sessions', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([matchingSession]),
        });
      } else {
        route.continue();
      }
    });

    await showBoard(page);
    await page.locator('#boardKanban .board-card').first().click();
    await page.waitForTimeout(500);

    // Spy on selectSession, then click Open Session
    await page.evaluate(() => {
      const a = (window as any).app;
      (window as any)._testSelectSessionId = null;
      const orig = a.selectSession.bind(a);
      a.selectSession = function (id: string) {
        (window as any)._testSelectSessionId = id;
        return orig(id);
      };
    });

    await page.locator('#workItemPanel #wipOpenSessionBtn').click();
    await page.waitForTimeout(400);

    selectSessionId = await page.evaluate(() => (window as any)._testSelectSessionId as string | null);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#wipOpenSessionBtn calls selectSession with the matched session id', () => {
    expect(selectSessionId).toBe('sess-wt-match');
  });
});

// ─── Gap: #wipOpenSessionBtn enabled — uses assignedAgentId fallback ──────────

describe('Detail panel — #wipOpenSessionBtn falls back to assignedAgentId', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let selectSessionId: string | null = null;

  const itemWithAgentId = {
    id: 'wi-open-sess-agent',
    title: 'Open by agentId',
    status: 'queued',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: 'sess-agent-fallback',
    worktreePath: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [itemWithAgentId]);

    // Deps route — no blockers
    await page.route('**/api/work-items/wi-open-sess-agent/dependencies', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { blockers: [], blockedBy: [] } }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    await page.locator('#boardKanban .board-card').first().click();
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const a = (window as any).app;
      (window as any)._testSelectSessionId = null;
      const orig = a.selectSession.bind(a);
      a.selectSession = function (id: string) {
        (window as any)._testSelectSessionId = id;
        return orig(id);
      };
    });

    await page.locator('#workItemPanel #wipOpenSessionBtn').click();
    await page.waitForTimeout(400);

    selectSessionId = await page.evaluate(() => (window as any)._testSelectSessionId as string | null);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#wipOpenSessionBtn calls selectSession with assignedAgentId when worktreePath is null', () => {
    expect(selectSessionId).toBe('sess-agent-fallback');
  });
});

// ─── Gap: #wipUnblockBtn partial DELETE failure — PATCH still fires ───────────

describe('Detail panel — #wipUnblockBtn fires PATCH even when one DELETE fails', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let patchFired = false;
  let patchBody: Record<string, unknown> | null = null;

  const blockedItem = {
    id: 'wi-partial-fail',
    title: 'Partial Fail Item',
    status: 'blocked',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    assignedAgentId: null,
  };

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockWorkItemsRoute(page, [blockedItem]);

    // Two blockers in deps response
    await page.route('**/api/work-items/wi-partial-fail/dependencies', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              blockers: [
                { id: 'wi-blocker-ok', title: 'OK Blocker', status: 'queued', depId: 'wi-blocker-ok' },
                { id: 'wi-blocker-fail', title: 'Fail Blocker', status: 'queued', depId: 'wi-blocker-fail' },
              ],
              blockedBy: [],
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // First DELETE succeeds
    await page.route('**/api/work-items/wi-partial-fail/dependencies/wi-blocker-ok', async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      } else {
        await route.continue();
      }
    });

    // Second DELETE returns non-ok (500)
    await page.route('**/api/work-items/wi-partial-fail/dependencies/wi-blocker-fail', async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fail' }) });
      } else {
        await route.continue();
      }
    });

    // PATCH — capture to verify it fires regardless
    await page.route('**/api/work-items/wi-partial-fail', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchFired = true;
        patchBody = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { ...blockedItem, status: 'queued' } }),
        });
      } else {
        await route.continue();
      }
    });

    await showBoard(page);
    await page.locator('#boardKanban .board-col[data-col="queued"] .board-card').first().click();
    await page.waitForTimeout(500);
    await page.locator('#workItemPanel #wipUnblockBtn').click();
    await page.waitForTimeout(600);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('PATCH fires even when one DELETE returns non-ok', () => {
    expect(patchFired).toBe(true);
  });

  it('PATCH body has status queued', () => {
    expect(patchBody).not.toBeNull();
    expect(patchBody!['status']).toBe('queued');
  });
});

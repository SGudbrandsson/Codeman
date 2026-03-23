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
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 8000 });
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

// Mock /api/work-items to return controlled data
async function mockWorkItemsRoute(page: Page, items: unknown[], status = 200): Promise<void> {
  await page.route('**/api/work-items', (route) => {
    if (status === 200) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items }),
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

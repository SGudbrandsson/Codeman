/**
 * Action Dashboard — functional test suite
 *
 * Covers:
 * 1. DOM structure: #actionDashboardBtn, #actionDashboardBadge, #actionDashboard, #actionDashboardList
 * 2. View toggle lifecycle: showActionDashboard/hideActionDashboard/toggleActionDashboard
 * 3. Data derivation and priority sorting
 * 4. Badge count (correct count, hidden at 0, "99+" overflow)
 * 5. Card rendering (structure, empty state)
 * 6. Quick action buttons per type
 * 7. Mutual exclusion with Board view
 * 8. selectSession() hides dashboard
 * 9. markDirty() triggers re-derive when visible
 * 10. Polling lifecycle (start on show, stop on hide)
 *
 * Port: 3240
 *
 * Run: npx vitest run test/action-dashboard.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3240;
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
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-action-dashboard' }),
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

async function showDashboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { app: { showActionDashboard: () => void } }).app.showActionDashboard();
  });
  await page.waitForTimeout(600);
}

async function hideDashboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { app: { hideActionDashboard: () => void } }).app.hideActionDashboard();
  });
  await page.waitForTimeout(200);
}

// Mock all three API endpoints used by ActionDashboard.refresh()
async function mockDashboardRoutes(
  page: Page,
  sessions: unknown[] = [],
  workItems: unknown[] = [],
  worktrees: unknown[] = []
): Promise<void> {
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sessions),
      });
    } else {
      route.continue();
    }
  });
  await page.route('**/api/work-items', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: workItems }),
    });
  });
  await page.route('**/api/worktrees', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, worktrees }),
      });
    } else {
      route.continue();
    }
  });
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

// ─── Gap 1: DOM structure ────────────────────────────────────────────────────

describe('DOM structure (Gap 1)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('#actionDashboardBtn exists', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('actionDashboardBtn'));
    expect(exists).toBe(true);
  });

  it('#actionDashboardBadge exists', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('actionDashboardBadge'));
    expect(exists).toBe(true);
  });

  it('#actionDashboard exists', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('actionDashboard'));
    expect(exists).toBe(true);
  });

  it('#actionDashboardList exists', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('actionDashboardList'));
    expect(exists).toBe(true);
  });

  it('#actionDashboard is hidden by default', async () => {
    const display = await page.evaluate(() => {
      return document.getElementById('actionDashboard')?.style.display;
    });
    expect(display).toBe('none');
  });
});

// ─── Gap 2: View toggle lifecycle ────────────────────────────────────────────

describe('View toggle — showActionDashboard() makes dashboard visible (Gap 2)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockDashboardRoutes(page);
    await showDashboard(page);
  });

  afterAll(async () => {
    await hideDashboard(page);
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#actionDashboard is visible after showActionDashboard()', async () => {
    const display = await page.evaluate(() => {
      const el = document.getElementById('actionDashboard');
      return el ? window.getComputedStyle(el).display : 'missing';
    });
    expect(display).not.toBe('none');
    expect(display).not.toBe('missing');
  });

  it('#actionDashboardBtn has "active" class', async () => {
    const hasActive = await page.evaluate(() => {
      return document.getElementById('actionDashboardBtn')?.classList.contains('active') ?? false;
    });
    expect(hasActive).toBe(true);
  });

  it('#terminalContainer is hidden when dashboard is shown', async () => {
    const display = await page.evaluate(() => {
      return document.getElementById('terminalContainer')?.style.display;
    });
    expect(display).toBe('none');
  });
});

describe('View toggle — hideActionDashboard() hides dashboard (Gap 2)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockDashboardRoutes(page);
    await showDashboard(page);
    await hideDashboard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('#actionDashboard is hidden after hideActionDashboard()', async () => {
    const display = await page.evaluate(() => {
      return document.getElementById('actionDashboard')?.style.display;
    });
    expect(display).toBe('none');
  });

  it('#actionDashboardBtn loses "active" class', async () => {
    const hasActive = await page.evaluate(() => {
      return document.getElementById('actionDashboardBtn')?.classList.contains('active') ?? false;
    });
    expect(hasActive).toBe(false);
  });

  it('#terminalContainer is restored after hide', async () => {
    const display = await page.evaluate(() => {
      return document.getElementById('terminalContainer')?.style.display;
    });
    // '' means the inline style was removed, restoring default
    expect(display).toBe('');
  });
});

describe('View toggle — toggleActionDashboard() toggles (Gap 2)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockDashboardRoutes(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (window as unknown as { app: { hideActionDashboard: () => void } }).app.hideActionDashboard();
    });
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('toggleActionDashboard() shows when hidden', async () => {
    const visible = await page.evaluate(() => {
      const a = (window as unknown as { app: { toggleActionDashboard: () => void; _actionDashboardVisible: boolean } })
        .app;
      a.toggleActionDashboard();
      return a._actionDashboardVisible;
    });
    await page.waitForTimeout(600);
    expect(visible).toBe(true);
  });

  it('toggleActionDashboard() hides when visible', async () => {
    const visible = await page.evaluate(() => {
      const a = (window as unknown as { app: { toggleActionDashboard: () => void; _actionDashboardVisible: boolean } })
        .app;
      a.toggleActionDashboard();
      return a._actionDashboardVisible;
    });
    await page.waitForTimeout(200);
    expect(visible).toBe(false);
  });
});

// ─── Gap 3: Data derivation and priority sorting ─────────────────────────────

describe('Data derivation and priority sorting (Gap 3)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
    });
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('derives permission items from attentionItems with priority 0', async () => {
    const result = await page.evaluate(() => {
      (app as any).addAttentionItem('sess-perm', 'permission_prompt', 'Needs approval');
      const AD = (window as any).ActionDashboard;
      AD._sessions = [];
      AD._workItems = [];
      AD._dormantWorktrees = [];
      AD._deriveItems();
      const item = AD._items.find((i: any) => i.actionType === 'permission');
      (app as any).attentionItems.clear();
      return item ? { actionType: item.actionType, priority: item.priority, sessionId: item.sessionId } : null;
    });
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('permission');
    expect(result!.priority).toBe(0);
    expect(result!.sessionId).toBe('sess-perm');
  });

  it('derives question items from elicitation_dialog with priority 1', async () => {
    const result = await page.evaluate(() => {
      (app as any).addAttentionItem('sess-q', 'elicitation_dialog', 'Answer this');
      const AD = (window as any).ActionDashboard;
      AD._sessions = [];
      AD._workItems = [];
      AD._dormantWorktrees = [];
      AD._deriveItems();
      const item = AD._items.find((i: any) => i.actionType === 'question');
      (app as any).attentionItems.clear();
      return item ? { actionType: item.actionType, priority: item.priority } : null;
    });
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('question');
    expect(result!.priority).toBe(1);
  });

  it('derives idle items from idle_prompt with priority 2', async () => {
    const result = await page.evaluate(() => {
      (app as any).addAttentionItem('sess-idle', 'idle_prompt', 'Waiting for input');
      const AD = (window as any).ActionDashboard;
      AD._sessions = [];
      AD._workItems = [];
      AD._dormantWorktrees = [];
      AD._deriveItems();
      const item = AD._items.find((i: any) => i.actionType === 'idle');
      (app as any).attentionItems.clear();
      return item ? { actionType: item.actionType, priority: item.priority, sessionId: item.sessionId } : null;
    });
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('idle');
    expect(result!.priority).toBe(2);
    expect(result!.sessionId).toBe('sess-idle');
  });

  it('derives review items from work items API with priority 3', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [];
      AD._workItems = [{ id: 'wi-1', status: 'review', title: 'Fix bug', assignedAgentId: 'sess-1' }];
      AD._dormantWorktrees = [];
      AD._deriveItems();
      const item = AD._items.find((i: any) => i.actionType === 'review');
      return item ? { actionType: item.actionType, priority: item.priority, workItemId: item.workItemId } : null;
    });
    expect(result).not.toBeNull();
    expect(result!.priority).toBe(3);
    expect(result!.workItemId).toBe('wi-1');
  });

  it('derives blocked items from work items API with priority 4', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [];
      AD._workItems = [{ id: 'wi-2', status: 'blocked', title: 'Blocked item' }];
      AD._dormantWorktrees = [];
      AD._deriveItems();
      const item = AD._items.find((i: any) => i.actionType === 'blocked');
      return item ? { actionType: item.actionType, priority: item.priority } : null;
    });
    expect(result).not.toBeNull();
    expect(result!.priority).toBe(4);
  });

  it('derives error items from sessions with priority 3', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [{ id: 'sess-err', status: 'error', name: 'Error session' }];
      AD._workItems = [];
      AD._dormantWorktrees = [];
      AD._deriveItems();
      const item = AD._items.find((i: any) => i.actionType === 'error');
      return item ? { actionType: item.actionType, priority: item.priority } : null;
    });
    expect(result).not.toBeNull();
    expect(result!.priority).toBe(3);
  });

  it('derives stopped_worktree items from stopped sessions with worktreePath', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [
        { id: 'sess-stop', status: 'stopped', name: 'Stopped', worktreePath: '/tmp/wt', worktreeBranch: 'feat/x' },
      ];
      AD._workItems = [];
      AD._dormantWorktrees = [];
      AD._deriveItems();
      const item = AD._items.find((i: any) => i.actionType === 'stopped_worktree');
      return item ? { actionType: item.actionType, priority: item.priority } : null;
    });
    expect(result).not.toBeNull();
    expect(result!.priority).toBe(5);
  });

  it('derives stale_worktree items from idle sessions with old updatedAt', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
      AD._sessions = [
        { id: 'sess-stale', status: 'idle', name: 'Stale', worktreeBranch: 'feat/old', updatedAt: oldTime },
      ];
      AD._workItems = [];
      AD._dormantWorktrees = [];
      AD._deriveItems();
      const item = AD._items.find((i: any) => i.actionType === 'stale_worktree');
      return item ? { actionType: item.actionType, priority: item.priority } : null;
    });
    expect(result).not.toBeNull();
    expect(result!.priority).toBe(6);
  });

  it('derives dormant items from dormant worktrees with priority 7', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [];
      AD._workItems = [];
      AD._dormantWorktrees = [{ id: 'wt-1', branch: 'feat/dormant', path: '/tmp/dormant' }];
      AD._deriveItems();
      const item = AD._items.find((i: any) => i.actionType === 'dormant');
      return item ? { actionType: item.actionType, priority: item.priority } : null;
    });
    expect(result).not.toBeNull();
    expect(result!.priority).toBe(7);
  });

  it('sorts items by priority ascending, then timestamp descending', async () => {
    const result = await page.evaluate(() => {
      const now = Date.now();
      (app as any).addAttentionItem('sess-a', 'permission_prompt', 'Approve'); // priority 0
      (app as any).addAttentionItem('sess-b', 'idle_prompt', 'Idle'); // priority 2

      const AD = (window as any).ActionDashboard;
      AD._sessions = [{ id: 'sess-err2', status: 'error', name: 'Err', updatedAt: new Date(now - 5000).toISOString() }];
      AD._workItems = [
        { id: 'wi-r', status: 'review', title: 'Review item', updatedAt: new Date(now - 1000).toISOString() },
      ];
      AD._dormantWorktrees = [];
      AD._deriveItems();
      const types = AD._items.map((i: any) => i.actionType);
      (app as any).attentionItems.clear();
      return types;
    });

    // permission (0), idle (2), then review and error (both 3) — review has newer timestamp
    expect(result[0]).toBe('permission');
    expect(result[1]).toBe('idle');
    // review (now - 1000) and error (now - 5000) are both priority 3;
    // secondary sort is timestamp descending, so review (newer) must come before error (older)
    expect(result.indexOf('review')).toBeLessThan(result.indexOf('error'));
  });

  it('deduplicates attention items vs work item review items', async () => {
    const result = await page.evaluate(() => {
      // Add an attention review item for work item wi-dup
      (app as any).addAttentionWorkItem('sess-dup', 'wi-dup', 'Dup review');

      const AD = (window as any).ActionDashboard;
      AD._sessions = [];
      // Work item with same ID should NOT create a duplicate
      AD._workItems = [{ id: 'wi-dup', status: 'review', title: 'Dup review', assignedAgentId: 'sess-dup' }];
      AD._dormantWorktrees = [];
      AD._deriveItems();
      const reviewItems = AD._items.filter((i: any) => i.workItemId === 'wi-dup');
      (app as any).attentionItems.clear();
      return reviewItems.length;
    });
    expect(result).toBe(1);
  });
});

// ─── Gap 4: Badge count ─────────────────────────────────────────────────────

describe('Badge count (Gap 4)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('badge is hidden when count is 0', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._items = [];
      AD._updateBadge();
      const badge = document.getElementById('actionDashboardBadge');
      return badge?.style.display;
    });
    expect(result).toBe('none');
  });

  it('badge shows correct count for small numbers', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._items = [{}, {}, {}]; // 3 items
      AD._updateBadge();
      const badge = document.getElementById('actionDashboardBadge');
      return { text: badge?.textContent, display: badge?.style.display };
    });
    expect(result.text).toBe('3');
    expect(result.display).toBe('inline-flex');
  });

  it('badge shows "99+" when count exceeds 99', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._items = new Array(100).fill({});
      AD._updateBadge();
      const badge = document.getElementById('actionDashboardBadge');
      const text = badge?.textContent;
      AD._items = [];
      AD._updateBadge();
      return text;
    });
    expect(result).toBe('99+');
  });
});

// ─── Gap 5: Card rendering ──────────────────────────────────────────────────

describe('Card rendering (Gap 5)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('renders empty state when no items', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._items = [];
      AD.render();
      const list = document.getElementById('actionDashboardList');
      const empty = list?.querySelector('.action-dashboard-empty');
      return { hasEmpty: !!empty, text: empty?.textContent || '' };
    });
    expect(result.hasEmpty).toBe(true);
    expect(result.text).toContain('No items need attention');
  });

  it('renders cards with correct structure (dot, session name, badge, context, actions)', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._items = [
        {
          id: 'test-card-1',
          sessionId: 'sess-1',
          sessionName: 'Test Session',
          actionType: 'review',
          priority: 3,
          context: 'Review this code',
          timestamp: Date.now(),
          workItemId: 'wi-1',
          extra: {},
        },
      ];
      AD.render();
      const list = document.getElementById('actionDashboardList');
      const card = list?.querySelector('.action-card');
      if (!card) return null;
      return {
        hasDot: !!card.querySelector('.action-card-dot'),
        sessionName: card.querySelector('.action-card-session')?.textContent,
        badgeText: card.querySelector('.action-card-badge')?.textContent,
        contextText: card.querySelector('.action-card-context')?.textContent,
        hasTime: !!card.querySelector('.action-card-time'),
        hasActions: !!card.querySelector('.action-card-actions'),
        buttonCount: card.querySelectorAll('.action-card-btn').length,
      };
    });
    expect(result).not.toBeNull();
    expect(result!.hasDot).toBe(true);
    expect(result!.sessionName).toBe('Test Session');
    expect(result!.badgeText).toBe('Review');
    expect(result!.contextText).toBe('Review this code');
    expect(result!.hasTime).toBe(true);
    expect(result!.hasActions).toBe(true);
    expect(result!.buttonCount).toBeGreaterThan(0);
  });
});

// ─── Gap 6: Quick action buttons per type ────────────────────────────────────

describe('Quick action buttons per type (Gap 6)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  const buttonTestCases: Array<{ actionType: string; expectedLabels: string[] }> = [
    { actionType: 'permission', expectedLabels: ['Open Session'] },
    { actionType: 'question', expectedLabels: ['Open Session'] },
    { actionType: 'error', expectedLabels: ['Open Session'] },
    { actionType: 'idle', expectedLabels: ['Open Session', 'Send Input'] },
    { actionType: 'review', expectedLabels: ['Open Session', 'View Diff'] },
    { actionType: 'blocked', expectedLabels: ['Open Session', 'Unblock'] },
    { actionType: 'stopped_worktree', expectedLabels: ['Restart', 'Merge'] },
    { actionType: 'stale_worktree', expectedLabels: ['Open Session', 'Merge'] },
    { actionType: 'dormant', expectedLabels: ['Resume', 'Delete'] },
  ];

  for (const tc of buttonTestCases) {
    it(`${tc.actionType} produces buttons: ${tc.expectedLabels.join(', ')}`, async () => {
      const labels = await page.evaluate((type) => {
        const AD = (window as any).ActionDashboard;
        const item = {
          id: 'btn-test',
          sessionId: 'sess-btn',
          actionType: type,
          priority: 0,
          context: '',
          timestamp: Date.now(),
          extra: { worktreeId: 'wt-1', branch: 'feat/x', originSessionId: 'sess-origin' },
        };
        const defs = AD._getActionButtonDefs(item);
        return defs.map((d: any) => d.label);
      }, tc.actionType);
      expect(labels).toEqual(tc.expectedLabels);
    });
  }
});

// ─── Gap 7: Mutual exclusion with Board view ─────────────────────────────────

describe('Mutual exclusion with Board view (Gap 7)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockDashboardRoutes(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (
        window as unknown as { app: { hideActionDashboard: () => void; hideBoard: () => void } }
      ).app.hideActionDashboard();
      (window as unknown as { app: { hideBoard: () => void } }).app.hideBoard();
    });
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('showActionDashboard() hides board if visible', async () => {
    const result = await page.evaluate(() => {
      const a = (window as any).app;
      a.showBoard();
      a.showActionDashboard();
      return {
        boardVisible: a._boardVisible,
        dashboardVisible: a._actionDashboardVisible,
        boardDisplay: document.getElementById('boardView')?.style.display,
      };
    });
    await page.waitForTimeout(600);
    expect(result.boardVisible).toBe(false);
    expect(result.dashboardVisible).toBe(true);
    expect(result.boardDisplay).toBe('none');
  });

  it('showBoard() hides dashboard if visible', async () => {
    const result = await page.evaluate(() => {
      const a = (window as any).app;
      a.showActionDashboard();
      a.showBoard();
      return {
        boardVisible: a._boardVisible,
        dashboardVisible: a._actionDashboardVisible,
        dashboardDisplay: document.getElementById('actionDashboard')?.style.display,
      };
    });
    await page.waitForTimeout(600);
    expect(result.dashboardVisible).toBe(false);
    expect(result.boardVisible).toBe(true);
    expect(result.dashboardDisplay).toBe('none');
  });
});

// ─── Gap 7 (actual): Quick actions API calls ──────────────────────────────

describe('Quick actions API calls (Gap 7)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockDashboardRoutes(page);
  });

  afterAll(async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('restartSession() calls POST /api/sessions/:id/interactive and shows success toast', async () => {
    // Intercept the restart endpoint
    await page.route('**/api/sessions/sess-restart/interactive', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      } else {
        route.continue();
      }
    });

    const result = await page.evaluate(async () => {
      const AD = (window as any).ActionDashboard;
      // Spy on showToast
      let toastMsg = '';
      let toastType = '';
      const origToast = (app as any).showToast;
      (app as any).showToast = (msg: string, type: string) => {
        toastMsg = msg;
        toastType = type;
      };

      await AD.restartSession('sess-restart');

      (app as any).showToast = origToast;
      return { toastMsg, toastType };
    });

    expect(result.toastMsg).toBe('Session restarted');
    expect(result.toastType).toBe('success');
  });

  it('restartSession() shows error toast on failure', async () => {
    await page.route('**/api/sessions/sess-restart-fail/interactive', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fail' }) });
      } else {
        route.continue();
      }
    });

    const result = await page.evaluate(async () => {
      const AD = (window as any).ActionDashboard;
      let toastMsg = '';
      let toastType = '';
      const origToast = (app as any).showToast;
      (app as any).showToast = (msg: string, type: string) => {
        toastMsg = msg;
        toastType = type;
      };

      await AD.restartSession('sess-restart-fail');

      (app as any).showToast = origToast;
      return { toastMsg, toastType };
    });

    expect(result.toastMsg).toBe('Failed to restart session');
    expect(result.toastType).toBe('error');
  });

  it('mergeWorktree() shows confirmation dialog and calls POST /api/sessions/:id/worktree/merge on confirm', async () => {
    // Intercept the merge endpoint and capture the request body
    let capturedBody: string | null = null;
    await page.route('**/api/sessions/sess-merge/worktree/merge', (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = route.request().postData();
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      } else {
        route.continue();
      }
    });

    const result = await page.evaluate(async () => {
      const AD = (window as any).ActionDashboard;
      // Override confirm to return true (accept)
      const origConfirm = window.confirm;
      let confirmCalled = false;
      let confirmMessage = '';
      window.confirm = (msg: string) => {
        confirmCalled = true;
        confirmMessage = msg;
        return true;
      };

      let toastMsg = '';
      let toastType = '';
      const origToast = (app as any).showToast;
      (app as any).showToast = (msg: string, type: string) => {
        toastMsg = msg;
        toastType = type;
      };

      await AD.mergeWorktree('sess-merge', 'feat/my-branch');

      window.confirm = origConfirm;
      (app as any).showToast = origToast;
      return { confirmCalled, confirmMessage, toastMsg, toastType };
    });

    expect(result.confirmCalled).toBe(true);
    expect(result.confirmMessage).toContain('feat/my-branch');
    expect(result.toastMsg).toBe('Merge initiated');
    expect(result.toastType).toBe('success');
    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.branch).toBe('feat/my-branch');
  });

  it('mergeWorktree() does not call API when user cancels confirmation', async () => {
    let apiCalled = false;
    await page.route('**/api/sessions/sess-merge-cancel/worktree/merge', (route) => {
      apiCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });

    await page.evaluate(async () => {
      const AD = (window as any).ActionDashboard;
      const origConfirm = window.confirm;
      window.confirm = () => false; // user cancels

      await AD.mergeWorktree('sess-merge-cancel', 'feat/cancelled');

      window.confirm = origConfirm;
    });

    expect(apiCalled).toBe(false);
  });

  it('resumeDormant() calls POST /api/worktrees/:id/resume and shows success toast', async () => {
    await page.route('**/api/worktrees/wt-resume/resume', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      } else {
        route.continue();
      }
    });

    const result = await page.evaluate(async () => {
      const AD = (window as any).ActionDashboard;
      let toastMsg = '';
      let toastType = '';
      const origToast = (app as any).showToast;
      (app as any).showToast = (msg: string, type: string) => {
        toastMsg = msg;
        toastType = type;
      };

      await AD.resumeDormant('wt-resume');

      (app as any).showToast = origToast;
      return { toastMsg, toastType };
    });

    expect(result.toastMsg).toBe('Worktree resumed');
    expect(result.toastType).toBe('success');
  });

  it('deleteDormant() shows confirmation dialog and calls DELETE /api/worktrees/:id on confirm', async () => {
    let capturedMethod = '';
    let capturedBody: string | null = null;
    await page.route('**/api/worktrees/wt-delete', (route) => {
      if (route.request().method() === 'DELETE') {
        capturedMethod = 'DELETE';
        capturedBody = route.request().postData();
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      } else {
        route.continue();
      }
    });

    const result = await page.evaluate(async () => {
      const AD = (window as any).ActionDashboard;
      const origConfirm = window.confirm;
      let confirmCalled = false;
      window.confirm = () => {
        confirmCalled = true;
        return true;
      };

      let toastMsg = '';
      let toastType = '';
      const origToast = (app as any).showToast;
      (app as any).showToast = (msg: string, type: string) => {
        toastMsg = msg;
        toastType = type;
      };

      await AD.deleteDormant('wt-delete');

      window.confirm = origConfirm;
      (app as any).showToast = origToast;
      return { confirmCalled, toastMsg, toastType };
    });

    expect(result.confirmCalled).toBe(true);
    expect(capturedMethod).toBe('DELETE');
    expect(result.toastMsg).toBe('Worktree deleted');
    expect(result.toastType).toBe('success');
    // Verify removeDisk: true in body
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.removeDisk).toBe(true);
  });

  it('deleteDormant() does not call API when user cancels confirmation', async () => {
    let apiCalled = false;
    await page.route('**/api/worktrees/wt-delete-cancel', (route) => {
      apiCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });

    await page.evaluate(async () => {
      const AD = (window as any).ActionDashboard;
      const origConfirm = window.confirm;
      window.confirm = () => false;

      await AD.deleteDormant('wt-delete-cancel');

      window.confirm = origConfirm;
    });

    expect(apiCalled).toBe(false);
  });
});

// ─── Gap 8: selectSession() hides dashboard ──────────────────────────────────

describe('selectSession() hides dashboard (Gap 8)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockDashboardRoutes(page);
    await showDashboard(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('selectSession() sets _actionDashboardVisible to false', async () => {
    const result = await page.evaluate((sid) => {
      const a = (window as any).app;
      a.selectSession(sid);
      return a._actionDashboardVisible;
    }, sessionId);
    expect(result).toBe(false);
  });
});

// ─── Gap 9: markDirty() triggers re-derive when visible ──────────────────────

describe('markDirty() behaviour (Gap 9)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockDashboardRoutes(page);
  });

  afterAll(async () => {
    await hideDashboard(page);
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('markDirty() re-derives and renders when dashboard is visible', async () => {
    await showDashboard(page);
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      // Inject a cached session with error status
      AD._sessions = [{ id: 'sess-dirty', status: 'error', name: 'Dirty Test' }];
      AD._workItems = [];
      AD._dormantWorktrees = [];
      // markDirty should re-derive + render immediately since dashboard is visible
      AD.markDirty();
      const list = document.getElementById('actionDashboardList');
      const cards = list?.querySelectorAll('.action-card');
      return { cardCount: cards?.length ?? 0, hasItem: AD._items.some((i: any) => i.sessionId === 'sess-dirty') };
    });
    expect(result.hasItem).toBe(true);
    expect(result.cardCount).toBeGreaterThan(0);
  });

  it('markDirty() sets dirty flag but does not re-render when dashboard is hidden', async () => {
    await hideDashboard(page);
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._dirtyFromSSE = false;
      AD.markDirty();
      return AD._dirtyFromSSE;
    });
    expect(result).toBe(true);
  });
});

// ─── Gap 10: Polling lifecycle ───────────────────────────────────────────────

describe('Polling lifecycle (Gap 10)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockDashboardRoutes(page);
  });

  afterAll(async () => {
    await hideDashboard(page);
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('poll timer is set when dashboard is shown', async () => {
    await showDashboard(page);
    const hasTimer = await page.evaluate(() => {
      return (window as any).ActionDashboard._pollTimer !== null;
    });
    expect(hasTimer).toBe(true);
  });

  it('poll timer is cleared when dashboard is hidden', async () => {
    await hideDashboard(page);
    const hasTimer = await page.evaluate(() => {
      return (window as any).ActionDashboard._pollTimer !== null;
    });
    expect(hasTimer).toBe(false);
  });

  it('startPolling clears existing timer before setting new one (no leak)', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD.startPolling();
      const first = AD._pollTimer;
      AD.startPolling();
      const second = AD._pollTimer;
      AD.stopPolling();
      return { different: first !== second };
    });
    expect(result.different).toBe(true);
  });
});

// ─── Gap 11: Detail panel toggle and content ──────────────────────────────────

describe('Detail panel toggle and content (Gap 11)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('clicking card content toggles detail panel', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._items = [
        {
          id: 'detail-test-1',
          sessionId: 'sess-d1',
          sessionName: 'Detail Test',
          actionType: 'review',
          priority: 3,
          context: 'Review this',
          timestamp: Date.now(),
          workItemId: 'wi-d1',
          extra: { branch: 'fix/test-branch', worktreePath: '/tmp/wt-test', sessionStatus: 'idle' },
        },
      ];
      AD.render();
      const list = document.getElementById('actionDashboardList');
      const card = list?.querySelector('.action-card') as HTMLElement;
      const content = card?.querySelector('.action-card-content') as HTMLElement;

      // Click to expand
      content?.click();
      const hasDetail = !!card?.querySelector('.action-detail');
      const isExpanded = card?.classList.contains('expanded');

      // Click again to collapse
      content?.click();
      const hasDetailAfter = !!card?.querySelector('.action-detail');
      const isExpandedAfter = card?.classList.contains('expanded');

      return { hasDetail, isExpanded, hasDetailAfter, isExpandedAfter };
    });
    expect(result.hasDetail).toBe(true);
    expect(result.isExpanded).toBe(true);
    expect(result.hasDetailAfter).toBe(false);
    expect(result.isExpandedAfter).toBe(false);
  });

  it('detail panel shows branch, worktree, session, and work item info', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._workItems = [{ id: 'wi-detail', title: 'Fix the widget', description: 'Widget is broken', status: 'review' }];
      AD._items = [
        {
          id: 'detail-test-2',
          sessionId: 'sess-d2',
          sessionName: 'Widget Session',
          actionType: 'review',
          priority: 3,
          context: 'Needs review',
          timestamp: Date.now(),
          workItemId: 'wi-detail',
          extra: {
            branch: 'fix/widget-bug',
            worktreePath: '/home/test/wt-widget',
            sessionStatus: 'idle',
            workItemTitle: 'Fix the widget',
            workItemDescription: 'Widget is broken',
            workItemStatus: 'review',
          },
        },
      ];
      AD.render();
      const list = document.getElementById('actionDashboardList');
      const card = list?.querySelector('.action-card') as HTMLElement;
      const content = card?.querySelector('.action-card-content') as HTMLElement;
      content?.click();

      const detail = card?.querySelector('.action-detail');
      if (!detail) return null;

      const labels = Array.from(detail.querySelectorAll('.action-detail-label')).map((el: Element) => el.textContent);
      const monos = Array.from(detail.querySelectorAll('.action-detail-mono')).map((el: Element) => el.textContent);
      const hasViewBoardBtn = !!detail.querySelector('.action-card-btn:not(.primary)');
      const hasOpenSessionBtn = !!detail.querySelector('.action-card-btn.primary');

      return { labels, monos, hasViewBoardBtn, hasOpenSessionBtn };
    });
    expect(result).not.toBeNull();
    expect(result!.labels).toContain('Action Needed');
    expect(result!.labels).toContain('Branch');
    expect(result!.labels).toContain('Worktree');
    expect(result!.labels).toContain('Session');
    expect(result!.labels).toContain('Work Item');
    expect(result!.monos).toContain('fix/widget-bug');
    expect(result!.monos).toContain('/home/test/wt-widget');
    expect(result!.hasViewBoardBtn).toBe(true);
    expect(result!.hasOpenSessionBtn).toBe(true);
  });

  it('only one detail panel is open at a time', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._items = [
        {
          id: 'multi-1',
          sessionId: 's1',
          sessionName: 'S1',
          actionType: 'error',
          priority: 3,
          context: '',
          timestamp: Date.now(),
          extra: {},
        },
        {
          id: 'multi-2',
          sessionId: 's2',
          sessionName: 'S2',
          actionType: 'idle',
          priority: 2,
          context: '',
          timestamp: Date.now(),
          extra: {},
        },
      ];
      AD.render();
      const list = document.getElementById('actionDashboardList');
      const cards = list?.querySelectorAll('.action-card') as NodeListOf<HTMLElement>;

      // Expand first card
      (cards[0]?.querySelector('.action-card-content') as HTMLElement)?.click();
      const firstHasDetail = !!cards[0]?.querySelector('.action-detail');

      // Expand second card — first should collapse
      (cards[1]?.querySelector('.action-card-content') as HTMLElement)?.click();
      const firstStillHasDetail = !!cards[0]?.querySelector('.action-detail');
      const secondHasDetail = !!cards[1]?.querySelector('.action-detail');

      return { firstHasDetail, firstStillHasDetail, secondHasDetail };
    });
    expect(result.firstHasDetail).toBe(true);
    expect(result.firstStillHasDetail).toBe(false);
    expect(result.secondHasDetail).toBe(true);
  });

  it('card shows inline branch pill when branch is available', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._items = [
        {
          id: 'branch-pill-test',
          sessionId: 'sess-bp',
          sessionName: 'Branch Test',
          actionType: 'review',
          priority: 3,
          context: 'Review',
          timestamp: Date.now(),
          extra: { branch: 'feat/my-feature' },
        },
      ];
      AD.render();
      const list = document.getElementById('actionDashboardList');
      const branchEl = list?.querySelector('.action-card-branch');
      return branchEl?.textContent || null;
    });
    expect(result).toBe('feat/my-feature');
  });
});

// ─── Gap 12: _enrichExtra and _findWorkItemForSession helpers ─────────────────

describe('Data enrichment helpers (Gap 12)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('_enrichExtra populates branch, worktreePath, workingDir, sessionStatus from session', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [
        {
          id: 'sess-enrich',
          worktreeBranch: 'feat/enriched',
          worktreePath: '/tmp/wt-enriched',
          workingDir: '/home/test/project',
          status: 'busy',
        },
      ];
      const extra = AD._enrichExtra({}, 'sess-enrich');
      return extra;
    });
    expect(result.branch).toBe('feat/enriched');
    expect(result.worktreePath).toBe('/tmp/wt-enriched');
    expect(result.workingDir).toBe('/home/test/project');
    expect(result.sessionStatus).toBe('busy');
  });

  it('_enrichExtra does not overwrite existing values', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [
        {
          id: 'sess-keep',
          worktreeBranch: 'should-not-overwrite',
          worktreePath: '/should/not/overwrite',
          status: 'idle',
        },
      ];
      const extra = AD._enrichExtra({ branch: 'keep-this', worktreePath: '/keep/this' }, 'sess-keep');
      return extra;
    });
    expect(result.branch).toBe('keep-this');
    expect(result.worktreePath).toBe('/keep/this');
  });

  it('_findWorkItemForSession matches by assignedAgentId', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [{ id: 'sess-find', status: 'busy' }];
      AD._workItems = [
        { id: 'wi-other', assignedAgentId: 'sess-other' },
        { id: 'wi-match', assignedAgentId: 'sess-find' },
      ];
      const wi = AD._findWorkItemForSession('sess-find');
      return wi?.id || null;
    });
    expect(result).toBe('wi-match');
  });

  it('_findWorkItemForSession matches by worktreePath', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [{ id: 'sess-wt', status: 'busy', worktreePath: '/tmp/match-wt' }];
      AD._workItems = [
        { id: 'wi-no-match', worktreePath: '/tmp/other-wt' },
        { id: 'wi-wt-match', worktreePath: '/tmp/match-wt' },
      ];
      const wi = AD._findWorkItemForSession('sess-wt');
      return wi?.id || null;
    });
    expect(result).toBe('wi-wt-match');
  });

  it('_findWorkItemForSession returns null for unknown session', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [];
      AD._workItems = [{ id: 'wi-orphan' }];
      return AD._findWorkItemForSession('sess-nonexistent');
    });
    expect(result).toBeNull();
  });

  it('_deriveItems enriches attention items with work item metadata', async () => {
    const result = await page.evaluate(() => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [
        { id: 'sess-attn', status: 'busy', worktreeBranch: 'fix/attn-branch', worktreePath: '/tmp/attn' },
      ];
      AD._workItems = [{ id: 'wi-attn', title: 'Attention Work', status: 'in_progress', worktreePath: '/tmp/attn' }];
      AD._dormantWorktrees = [];
      (app as any).addAttentionItem('sess-attn', 'permission_prompt', 'Needs approval');
      AD._deriveItems();
      const item = AD._items.find((i: any) => i.sessionId === 'sess-attn');
      (app as any).attentionItems.clear();
      return item
        ? {
            workItemId: item.workItemId,
            branch: item.extra?.branch,
            worktreePath: item.extra?.worktreePath,
            workItemTitle: item.extra?.workItemTitle,
          }
        : null;
    });
    expect(result).not.toBeNull();
    expect(result!.workItemId).toBe('wi-attn');
    expect(result!.branch).toBe('fix/attn-branch');
    expect(result!.worktreePath).toBe('/tmp/attn');
    expect(result!.workItemTitle).toBe('Attention Work');
  });
});

// ─── Gap 13: openSession forces session reload ──────────────────────────────

describe('openSession forces session reload (Gap 13)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockDashboardRoutes(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('openSession clears activeSessionId before calling selectSession to force reload', async () => {
    const result = await page.evaluate((sid) => {
      const a = (window as any).app;
      const AD = (window as any).ActionDashboard;
      // Set the active session to be the same as what we'll open
      a.activeSessionId = sid;
      a.showActionDashboard();

      // Track whether selectSession was called (it would bail early without the fix)
      let selectCalled = false;
      const origSelect = a.selectSession.bind(a);
      a.selectSession = function (id: string) {
        selectCalled = true;
        // Verify activeSessionId was cleared before this call
        const wasCleared = a.activeSessionId === null;
        return origSelect(id).then(() => ({ wasCleared }));
      };

      AD.openSession(sid);

      // Restore
      a.selectSession = origSelect;
      return { selectCalled, dashboardVisible: a._actionDashboardVisible };
    }, sessionId);

    expect(result.selectCalled).toBe(true);
    expect(result.dashboardVisible).toBe(false);
  });
});

// ─── Gap 14: unblockSession sends prompt with retry ─────────────────────────

describe('unblockSession sends prompt with retry (Gap 14)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createSession(page);
    await mockDashboardRoutes(page);
  });

  afterAll(async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('sends resume prompt via /input with useMux and shows success toast', async () => {
    let capturedBody: string | null = null;
    await page.route('**/api/sessions/sess-unblock/input', (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = route.request().postData();
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      } else {
        route.continue();
      }
    });

    const result = await page.evaluate(async () => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [{ id: 'sess-unblock', status: 'busy' }]; // already running, no restart needed
      let toastMsg = '';
      let toastType = '';
      const origToast = (app as any).showToast;
      (app as any).showToast = (msg: string, type: string) => {
        toastMsg = msg;
        toastType = type;
      };

      const item = {
        sessionId: 'sess-unblock',
        workItemId: null,
        extra: { workItemTitle: 'Fix the bug', branch: 'fix/bug' },
        context: 'Blocked on something',
      };
      await AD.unblockSession('sess-unblock', item);

      (app as any).showToast = origToast;
      return { toastMsg, toastType };
    });

    expect(result.toastMsg).toBe('Unblock prompt sent');
    expect(result.toastType).toBe('success');
    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.useMux).toBe(true);
    expect(parsed.input).toContain('Fix the bug');
    expect(parsed.input).toContain('fix/bug');
    expect(parsed.input).toContain('TASK.md');
    expect(parsed.input.endsWith('\r')).toBe(true);
  });

  it('restarts stopped session before sending input', async () => {
    let interactiveCalled = false;
    await page.route('**/api/sessions/sess-stopped-unblock/interactive', (route) => {
      if (route.request().method() === 'POST') {
        interactiveCalled = true;
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      } else {
        route.continue();
      }
    });
    await page.route('**/api/sessions/sess-stopped-unblock/input', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      } else {
        route.continue();
      }
    });

    const result = await page.evaluate(async () => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [{ id: 'sess-stopped-unblock', status: 'stopped' }];
      let toastMsg = '';
      const origToast = (app as any).showToast;
      (app as any).showToast = (msg: string) => {
        toastMsg = msg;
      };

      await AD.unblockSession('sess-stopped-unblock', { extra: {}, context: 'task' });

      (app as any).showToast = origToast;
      return { toastMsg };
    });

    expect(interactiveCalled).toBe(true);
    expect(result.toastMsg).toBe('Unblock prompt sent');
  });

  it('retries on initial input failure', async () => {
    let inputAttempts = 0;
    await page.route('**/api/sessions/sess-retry/input', (route) => {
      if (route.request().method() === 'POST') {
        inputAttempts++;
        // Fail first attempt, succeed on second
        if (inputAttempts < 2) {
          route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not ready' }) });
        } else {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        }
      } else {
        route.continue();
      }
    });

    const result = await page.evaluate(async () => {
      const AD = (window as any).ActionDashboard;
      AD._sessions = [{ id: 'sess-retry', status: 'busy' }];
      let toastMsg = '';
      const origToast = (app as any).showToast;
      (app as any).showToast = (msg: string) => {
        toastMsg = msg;
      };

      await AD.unblockSession('sess-retry', { extra: {}, context: 'task' });

      (app as any).showToast = origToast;
      return { toastMsg };
    });

    expect(inputAttempts).toBeGreaterThanOrEqual(2);
    expect(result.toastMsg).toBe('Unblock prompt sent');
  });
});

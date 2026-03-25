/**
 * Attention Queue feature tests
 *
 * Covers:
 * 1. addAttentionItem / removeAttentionItem / removeAttentionWorkItem / removeAttentionItemsForSession / removeAttentionHooksForSession
 * 2. toggleAttentionQueue / _renderAttentionQueue
 * 3. Badge count and color logic (orange vs red/critical)
 * 4. Hook handler integration (idle_prompt, permission_prompt, elicitation_dialog, ask_user_question, clearPendingHooks)
 * 5. _attentionItemClick navigation
 * 6. Work item review detection (_onWorkItemStatusChanged)
 * 7. DOM structure (badge button + panel exist)
 * 8. Mobile layout (full-screen overlay at 768px)
 *
 * Port: 3223 (attention-queue tests)
 *
 * Run: npx vitest run test/attention-queue.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3223;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

// --- Helpers ---

async function freshPage(width = 1280, height = 800): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  return { context, page };
}

async function navigateTo(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 8000 });
  await page.waitForTimeout(300);
}

// --- Setup / Teardown ---

beforeAll(async () => {
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// --- Gap 7: DOM structure ---

describe('DOM structure (Gap 7)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('attentionBtn exists in the DOM', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('attentionBtn'));
    expect(exists).toBe(true);
  });

  it('attentionBadge exists in the DOM', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('attentionBadge'));
    expect(exists).toBe(true);
  });

  it('attentionQueuePanel exists in the DOM', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('attentionQueuePanel'));
    expect(exists).toBe(true);
  });

  it('attentionQueueList exists in the DOM', async () => {
    const exists = await page.evaluate(() => !!document.getElementById('attentionQueueList'));
    expect(exists).toBe(true);
  });

  it('attentionBtn is hidden when no items', async () => {
    const display = await page.evaluate(() => {
      return document.getElementById('attentionBtn')?.style.display;
    });
    expect(display).toBe('none');
  });
});

// --- Gap 1: add/remove attention items ---

describe('addAttentionItem / removeAttentionItem / removeAttentionWorkItem (Gap 1)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    // Clean up attention items
    await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
    });
    await context?.close();
  });

  it('addAttentionItem adds an item to attentionItems Map', async () => {
    const result = await page.evaluate(() => {
      (app as any).addAttentionItem('sess-1', 'idle_prompt', 'Claude is idle');
      return {
        size: (app as any).attentionItems.size,
        hasKey: (app as any).attentionItems.has('sess-1:idle_prompt'),
      };
    });
    expect(result.size).toBe(1);
    expect(result.hasKey).toBe(true);
  });

  it('addAttentionItem stores correct data fields', async () => {
    const item = await page.evaluate(() => {
      const entry = (app as any).attentionItems.get('sess-1:idle_prompt');
      return entry
        ? {
            sessionId: entry.sessionId,
            hookType: entry.hookType,
            context: entry.context,
            hasTimestamp: typeof entry.timestamp === 'number',
          }
        : null;
    });
    expect(item).not.toBeNull();
    expect(item!.sessionId).toBe('sess-1');
    expect(item!.hookType).toBe('idle_prompt');
    expect(item!.context).toBe('Claude is idle');
    expect(item!.hasTimestamp).toBe(true);
  });

  it('addAttentionItem with same key overwrites previous entry', async () => {
    const result = await page.evaluate(() => {
      (app as any).addAttentionItem('sess-1', 'idle_prompt', 'Updated context');
      return {
        size: (app as any).attentionItems.size,
        context: (app as any).attentionItems.get('sess-1:idle_prompt')?.context,
      };
    });
    expect(result.size).toBe(1);
    expect(result.context).toBe('Updated context');
  });

  it('removeAttentionItem removes a specific item', async () => {
    const result = await page.evaluate(() => {
      (app as any).addAttentionItem('sess-2', 'permission_prompt', 'Needs approval');
      const sizeBefore = (app as any).attentionItems.size;
      (app as any).removeAttentionItem('sess-2', 'permission_prompt');
      return {
        sizeBefore,
        sizeAfter: (app as any).attentionItems.size,
        hasKey: (app as any).attentionItems.has('sess-2:permission_prompt'),
      };
    });
    expect(result.sizeBefore).toBe(2);
    expect(result.sizeAfter).toBe(1);
    expect(result.hasKey).toBe(false);
  });

  it('addAttentionWorkItem adds a review item with correct key format', async () => {
    const result = await page.evaluate(() => {
      (app as any).addAttentionWorkItem('sess-3', 'wi-123', 'Fix bug');
      const key = 'sess-3:review:wi-123';
      const entry = (app as any).attentionItems.get(key);
      return {
        hasKey: (app as any).attentionItems.has(key),
        hookType: entry?.hookType,
        workItemId: entry?.workItemId,
        context: entry?.context,
      };
    });
    expect(result.hasKey).toBe(true);
    expect(result.hookType).toBe('review');
    expect(result.workItemId).toBe('wi-123');
    expect(result.context).toBe('Fix bug');
  });

  it('removeAttentionWorkItem removes a specific work item', async () => {
    const result = await page.evaluate(() => {
      (app as any).removeAttentionWorkItem('sess-3', 'wi-123');
      return (app as any).attentionItems.has('sess-3:review:wi-123');
    });
    expect(result).toBe(false);
  });
});

// --- Gap 1 continued: removeAttentionItemsForSession / removeAttentionHooksForSession ---

describe('removeAttentionItemsForSession / removeAttentionHooksForSession (Gap 1)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
    });
    await context?.close();
  });

  it('removeAttentionItemsForSession removes ALL items for a session', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).addAttentionItem('sess-A', 'idle_prompt', 'idle');
      (app as any).addAttentionItem('sess-A', 'permission_prompt', 'perm');
      (app as any).addAttentionWorkItem('sess-A', 'wi-1', 'review item');
      (app as any).addAttentionItem('sess-B', 'idle_prompt', 'other session');
      const sizeBefore = (app as any).attentionItems.size;
      (app as any).removeAttentionItemsForSession('sess-A');
      return {
        sizeBefore,
        sizeAfter: (app as any).attentionItems.size,
        hasSessB: (app as any).attentionItems.has('sess-B:idle_prompt'),
      };
    });
    expect(result.sizeBefore).toBe(4);
    expect(result.sizeAfter).toBe(1);
    expect(result.hasSessB).toBe(true);
  });

  it('removeAttentionHooksForSession removes hooks but preserves review items', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).addAttentionItem('sess-C', 'idle_prompt', 'idle');
      (app as any).addAttentionItem('sess-C', 'permission_prompt', 'perm');
      (app as any).addAttentionWorkItem('sess-C', 'wi-2', 'review stays');
      const sizeBefore = (app as any).attentionItems.size;
      (app as any).removeAttentionHooksForSession('sess-C');
      return {
        sizeBefore,
        sizeAfter: (app as any).attentionItems.size,
        hasReview: (app as any).attentionItems.has('sess-C:review:wi-2'),
        hasIdle: (app as any).attentionItems.has('sess-C:idle_prompt'),
        hasPerm: (app as any).attentionItems.has('sess-C:permission_prompt'),
      };
    });
    expect(result.sizeBefore).toBe(3);
    expect(result.sizeAfter).toBe(1);
    expect(result.hasReview).toBe(true);
    expect(result.hasIdle).toBe(false);
    expect(result.hasPerm).toBe(false);
  });
});

// --- Gap 3: Badge count and color logic ---

describe('Badge count and color logic (Gap 3)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
    });
    await context?.close();
  });

  it('badge shows correct count after adding items', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).addAttentionItem('s1', 'idle_prompt', 'idle1');
      (app as any).addAttentionItem('s2', 'idle_prompt', 'idle2');
      const badge = document.getElementById('attentionBadge');
      return {
        text: badge?.textContent,
        display: badge?.style.display,
      };
    });
    expect(result.text).toBe('2');
    expect(result.display).not.toBe('none');
  });

  it('button becomes visible when items exist', async () => {
    const display = await page.evaluate(() => {
      return document.getElementById('attentionBtn')?.style.display;
    });
    expect(display).not.toBe('none');
  });

  it('badge does NOT have .critical class for idle-only items (orange)', async () => {
    const hasCritical = await page.evaluate(() => {
      return document.getElementById('attentionBadge')?.classList.contains('critical');
    });
    expect(hasCritical).toBe(false);
  });

  it('badge gets .critical class when permission_prompt item exists (red)', async () => {
    const hasCritical = await page.evaluate(() => {
      (app as any).addAttentionItem('s3', 'permission_prompt', 'needs approval');
      return document.getElementById('attentionBadge')?.classList.contains('critical');
    });
    expect(hasCritical).toBe(true);
  });

  it('badge gets .critical class when elicitation_dialog item exists', async () => {
    const hasCritical = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).addAttentionItem('s4', 'elicitation_dialog', 'question');
      return document.getElementById('attentionBadge')?.classList.contains('critical');
    });
    expect(hasCritical).toBe(true);
  });

  it('badge gets .critical class when ask_user_question item exists', async () => {
    const hasCritical = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).addAttentionItem('s5', 'ask_user_question', 'question');
      return document.getElementById('attentionBadge')?.classList.contains('critical');
    });
    expect(hasCritical).toBe(true);
  });

  it('badge does NOT have .critical for review-only items', async () => {
    const hasCritical = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).addAttentionWorkItem('s6', 'wi-1', 'review');
      return document.getElementById('attentionBadge')?.classList.contains('critical');
    });
    expect(hasCritical).toBe(false);
  });

  it('badge and button hidden when count returns to 0', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
      return {
        btnDisplay: document.getElementById('attentionBtn')?.style.display,
        badgeDisplay: document.getElementById('attentionBadge')?.style.display,
      };
    });
    expect(result.btnDisplay).toBe('none');
    expect(result.badgeDisplay).toBe('none');
  });
});

// --- Gap 2: toggleAttentionQueue / _renderAttentionQueue ---

describe('toggleAttentionQueue / _renderAttentionQueue (Gap 2)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
    });
    await context?.close();
  });

  it('toggleAttentionQueue opens the panel', async () => {
    const result = await page.evaluate(() => {
      (app as any).addAttentionItem('sess-t1', 'idle_prompt', 'test');
      (app as any).toggleAttentionQueue();
      return document.getElementById('attentionQueuePanel')?.classList.contains('open');
    });
    expect(result).toBe(true);
  });

  it('toggleAttentionQueue again closes the panel', async () => {
    const result = await page.evaluate(() => {
      (app as any).toggleAttentionQueue();
      return document.getElementById('attentionQueuePanel')?.classList.contains('open');
    });
    expect(result).toBe(false);
  });

  it('panel renders attention items with correct DOM elements', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).addAttentionItem('sess-r1', 'permission_prompt', 'Needs tool approval');
      const list = document.getElementById('attentionQueueList');
      const items = list?.querySelectorAll('.attention-item');
      if (!items || items.length === 0) return null;
      const firstItem = items[0];
      return {
        itemCount: items.length,
        hasSessionName: !!firstItem.querySelector('.attention-item-session'),
        hasBadge: !!firstItem.querySelector('.attention-item-badge'),
        hasContext: !!firstItem.querySelector('.attention-item-context'),
        hasTime: !!firstItem.querySelector('.attention-item-time'),
        badgeText: firstItem.querySelector('.attention-item-badge')?.textContent,
        contextText: firstItem.querySelector('.attention-item-context')?.textContent,
        hasTypeClass: firstItem.classList.contains('type-permission'),
      };
    });
    expect(result).not.toBeNull();
    expect(result!.itemCount).toBe(1);
    expect(result!.hasSessionName).toBe(true);
    expect(result!.hasBadge).toBe(true);
    expect(result!.hasContext).toBe(true);
    expect(result!.hasTime).toBe(true);
    expect(result!.badgeText).toBe('PERMISSION');
    expect(result!.contextText).toBe('Needs tool approval');
    expect(result!.hasTypeClass).toBe(true);
  });

  it('panel renders items sorted by priority (permission > idle > review)', async () => {
    const order = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).addAttentionWorkItem('sess-s1', 'wi-1', 'Review item');
      (app as any).addAttentionItem('sess-s2', 'idle_prompt', 'Idle');
      (app as any).addAttentionItem('sess-s3', 'permission_prompt', 'Permission');
      const list = document.getElementById('attentionQueueList');
      const items = list?.querySelectorAll('.attention-item-badge');
      return Array.from(items || []).map((el) => el.textContent);
    });
    expect(order).toEqual(['PERMISSION', 'IDLE', 'REVIEW']);
  });

  it('panel shows empty message when no items', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
      const list = document.getElementById('attentionQueueList');
      const empty = list?.querySelector('.attention-queue-empty');
      return empty?.textContent;
    });
    expect(result).toBe('No items awaiting your attention');
  });

  it('panel auto-closes when items reach zero', async () => {
    const result = await page.evaluate(() => {
      (app as any).addAttentionItem('sess-ac', 'idle_prompt', 'test');
      (app as any).toggleAttentionQueue();
      const openBefore = document.getElementById('attentionQueuePanel')?.classList.contains('open');
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
      const openAfter = document.getElementById('attentionQueuePanel')?.classList.contains('open');
      return { openBefore, openAfter };
    });
    expect(result.openBefore).toBe(true);
    expect(result.openAfter).toBe(false);
  });

  it('context text is truncated to 120 characters', async () => {
    const length = await page.evaluate(() => {
      const longCtx = 'A'.repeat(200);
      (app as any).attentionItems.clear();
      (app as any).addAttentionItem('sess-trunc', 'idle_prompt', longCtx);
      const list = document.getElementById('attentionQueueList');
      const ctxEl = list?.querySelector('.attention-item-context');
      return ctxEl?.textContent?.length ?? 0;
    });
    expect(length).toBe(120);
  });
});

// --- Gap 4: Hook handler integration ---

describe('Hook handler integration (Gap 4)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
    });
    await context?.close();
  });

  it('_onHookIdlePrompt adds idle_prompt attention item', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      // Ensure session exists so handler doesn't bail
      (app as any).sessions.set('hook-test-1', { id: 'hook-test-1', name: 'Hook Test 1' });
      (app as any)._onHookIdlePrompt({ sessionId: 'hook-test-1', message: 'Idle for 60s' });
      return (app as any).attentionItems.has('hook-test-1:idle_prompt');
    });
    expect(result).toBe(true);
  });

  it('_onHookPermissionPrompt adds permission_prompt attention item', async () => {
    const result = await page.evaluate(() => {
      (app as any).sessions.set('hook-test-2', { id: 'hook-test-2', name: 'Hook Test 2' });
      (app as any)._onHookPermissionPrompt({ sessionId: 'hook-test-2', tool: 'Bash', command: 'rm -rf /' });
      return (app as any).attentionItems.has('hook-test-2:permission_prompt');
    });
    expect(result).toBe(true);
  });

  it('_onHookElicitationDialog adds elicitation_dialog attention item', async () => {
    const result = await page.evaluate(() => {
      (app as any).sessions.set('hook-test-3', { id: 'hook-test-3', name: 'Hook Test 3' });
      (app as any)._onHookElicitationDialog({
        sessionId: 'hook-test-3',
        elicitation: { title: 'Test', message: 'Pick one', schema: {} },
      });
      return (app as any).attentionItems.has('hook-test-3:elicitation_dialog');
    });
    expect(result).toBe(true);
  });

  it('_onHookAskUserQuestion adds ask_user_question attention item', async () => {
    const result = await page.evaluate(() => {
      (app as any).sessions.set('hook-test-4', { id: 'hook-test-4', name: 'Hook Test 4' });
      (app as any)._onHookAskUserQuestion({
        sessionId: 'hook-test-4',
        tool_input: { questions: [{ question: 'What color?' }] },
      });
      return (app as any).attentionItems.has('hook-test-4:ask_user_question');
    });
    expect(result).toBe(true);
  });

  it('clearPendingHooks with specific hookType removes that attention item', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).addAttentionItem('hook-clear-1', 'idle_prompt', 'idle');
      (app as any).addAttentionItem('hook-clear-1', 'permission_prompt', 'perm');
      // Set up pendingHooks so clearPendingHooks can find them
      (app as any).pendingHooks.set('hook-clear-1', new Set(['idle_prompt', 'permission_prompt']));
      (app as any).clearPendingHooks('hook-clear-1', 'idle_prompt');
      return {
        hasIdle: (app as any).attentionItems.has('hook-clear-1:idle_prompt'),
        hasPerm: (app as any).attentionItems.has('hook-clear-1:permission_prompt'),
      };
    });
    expect(result.hasIdle).toBe(false);
    expect(result.hasPerm).toBe(true);
  });

  it('clearPendingHooks without hookType removes all hook attention items for session', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).addAttentionItem('hook-clear-2', 'idle_prompt', 'idle');
      (app as any).addAttentionItem('hook-clear-2', 'permission_prompt', 'perm');
      (app as any).addAttentionWorkItem('hook-clear-2', 'wi-99', 'review stays');
      (app as any).pendingHooks.set('hook-clear-2', new Set(['idle_prompt', 'permission_prompt']));
      (app as any).clearPendingHooks('hook-clear-2');
      return {
        hasIdle: (app as any).attentionItems.has('hook-clear-2:idle_prompt'),
        hasPerm: (app as any).attentionItems.has('hook-clear-2:permission_prompt'),
        hasReview: (app as any).attentionItems.has('hook-clear-2:review:wi-99'),
      };
    });
    expect(result.hasIdle).toBe(false);
    expect(result.hasPerm).toBe(false);
    expect(result.hasReview).toBe(true);
  });
});

// --- Gap 5: _attentionItemClick navigation ---

describe('_attentionItemClick navigation (Gap 5)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
    });
    await context?.close();
  });

  it('_attentionItemClick calls selectSession and closes the panel', async () => {
    const result = await page.evaluate(() => {
      // Track selectSession calls
      const calls: string[] = [];
      const originalSelectSession = (app as any).selectSession.bind(app);
      (app as any).selectSession = (id: string) => {
        calls.push(id);
      };

      // Set up a session and an attention item
      (app as any).sessions.set('nav-test-1', { id: 'nav-test-1', name: 'Nav Test' });
      (app as any).addAttentionItem('nav-test-1', 'idle_prompt', 'idle');

      // Open the panel
      (app as any).toggleAttentionQueue();
      const panelOpenBefore = document.getElementById('attentionQueuePanel')?.classList.contains('open');

      // Click the attention item
      (app as any)._attentionItemClick('nav-test-1');
      const panelOpenAfter = document.getElementById('attentionQueuePanel')?.classList.contains('open');

      // Restore
      (app as any).selectSession = originalSelectSession;

      return {
        panelOpenBefore,
        panelOpenAfter,
        selectCalls: calls,
      };
    });
    expect(result.panelOpenBefore).toBe(true);
    expect(result.panelOpenAfter).toBe(false);
    expect(result.selectCalls).toEqual(['nav-test-1']);
  });

  it('clicking an attention item DOM element triggers navigation', async () => {
    const result = await page.evaluate(() => {
      const calls: string[] = [];
      const originalSelectSession = (app as any).selectSession.bind(app);
      (app as any).selectSession = (id: string) => {
        calls.push(id);
      };

      (app as any).attentionItems.clear();
      (app as any).sessions.set('nav-test-2', { id: 'nav-test-2', name: 'Nav Click Test' });
      (app as any).addAttentionItem('nav-test-2', 'permission_prompt', 'needs approval');

      // Open panel and click the rendered item
      (app as any).toggleAttentionQueue();
      const item = document.querySelector('#attentionQueueList .attention-item') as HTMLElement | null;
      if (item) item.click();

      (app as any).selectSession = originalSelectSession;
      return { selectCalls: calls };
    });
    expect(result.selectCalls).toEqual(['nav-test-2']);
  });
});

// --- Gap 6: Work item review detection ---

describe('Work item review detection (Gap 6)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
    });
    await context?.close();
  });

  it('_onWorkItemStatusChanged with status=review adds attention work item', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any).sessions.set('wi-sess-1', { id: 'wi-sess-1', name: 'WI Session' });
      (app as any)._onWorkItemStatusChanged({
        id: 'wi-abc',
        sessionId: 'wi-sess-1',
        status: 'review',
        title: 'Implement feature X',
      });
      return {
        hasItem: (app as any).attentionItems.has('wi-sess-1:review:wi-abc'),
        item: (app as any).attentionItems.get('wi-sess-1:review:wi-abc'),
      };
    });
    expect(result.hasItem).toBe(true);
    expect(result.item.hookType).toBe('review');
    expect(result.item.context).toBe('Implement feature X');
  });

  it('_onWorkItemStatusChanged with status!=review removes the attention work item', async () => {
    const result = await page.evaluate(() => {
      // Item should already be there from previous test
      const hadBefore = (app as any).attentionItems.has('wi-sess-1:review:wi-abc');
      (app as any)._onWorkItemStatusChanged({
        id: 'wi-abc',
        sessionId: 'wi-sess-1',
        status: 'in_progress',
        title: 'Implement feature X',
      });
      return {
        hadBefore,
        hasAfter: (app as any).attentionItems.has('wi-sess-1:review:wi-abc'),
      };
    });
    expect(result.hadBefore).toBe(true);
    expect(result.hasAfter).toBe(false);
  });

  it('_onWorkItemStatusChanged removal works across sessions (finds by workItemId)', async () => {
    const result = await page.evaluate(() => {
      (app as any).attentionItems.clear();
      // Add item under one session
      (app as any).addAttentionWorkItem('sess-x', 'wi-cross', 'Cross session item');
      const hadBefore = (app as any).attentionItems.has('sess-x:review:wi-cross');
      // StatusChanged event may come with different or no sessionId — removal iterates all keys
      (app as any)._onWorkItemStatusChanged({
        id: 'wi-cross',
        status: 'completed',
      });
      return {
        hadBefore,
        hasAfter: (app as any).attentionItems.has('sess-x:review:wi-cross'),
      };
    });
    expect(result.hadBefore).toBe(true);
    expect(result.hasAfter).toBe(false);
  });
});

// --- Gap 2 continued: _relativeTime ---

describe('_relativeTime formatting', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('returns "just now" for timestamps < 60s ago', async () => {
    const result = await page.evaluate(() => {
      return (app as any)._relativeTime(Date.now() - 30000);
    });
    expect(result).toBe('just now');
  });

  it('returns "Xm ago" for timestamps between 1-59 minutes ago', async () => {
    const result = await page.evaluate(() => {
      return (app as any)._relativeTime(Date.now() - 5 * 60000);
    });
    expect(result).toBe('5m ago');
  });

  it('returns "Xh ago" for timestamps between 1-23 hours ago', async () => {
    const result = await page.evaluate(() => {
      return (app as any)._relativeTime(Date.now() - 3 * 3600000);
    });
    expect(result).toBe('3h ago');
  });

  it('returns "Xd ago" for timestamps 1+ days ago', async () => {
    const result = await page.evaluate(() => {
      return (app as any)._relativeTime(Date.now() - 2 * 86400000);
    });
    expect(result).toBe('2d ago');
  });
});

// --- Gap 8: Mobile layout ---

describe('Mobile layout — full-screen overlay (Gap 8)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    // Mobile viewport: 375px wide (below 768px breakpoint)
    ({ context, page } = await freshPage(375, 812));
    await navigateTo(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
    });
    await context?.close();
  });

  it('attention queue panel has position:fixed on mobile viewport', async () => {
    const result = await page.evaluate(() => {
      (app as any).addAttentionItem('mob-1', 'idle_prompt', 'mobile test');
      (app as any).toggleAttentionQueue();
      const panel = document.getElementById('attentionQueuePanel');
      if (!panel) return null;
      const style = getComputedStyle(panel);
      return {
        position: style.position,
        isOpen: panel.classList.contains('open'),
      };
    });
    expect(result).not.toBeNull();
    expect(result!.isOpen).toBe(true);
    expect(result!.position).toBe('fixed');
  });

  it('attention queue panel covers full width on mobile', async () => {
    const result = await page.evaluate(() => {
      const panel = document.getElementById('attentionQueuePanel');
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      return {
        width: rect.width,
        viewportWidth: window.innerWidth,
      };
    });
    expect(result).not.toBeNull();
    // On mobile the panel should be close to full viewport width
    expect(result!.width).toBeGreaterThanOrEqual(result!.viewportWidth * 0.9);
  });
});

// --- Gap 1 + cleanup: _cleanupSessionData integration ---

describe('_cleanupSessionData removes attention items (Gap 1 integration)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await page.evaluate(() => {
      (app as any).attentionItems.clear();
      (app as any)._renderAttentionQueue();
    });
    await context?.close();
  });

  it('_cleanupSessionData removes all attention items for the deleted session', async () => {
    const result = await page.evaluate(() => {
      // Set up a fake session with attention items
      (app as any).attentionItems.clear();
      (app as any).sessions.set('cleanup-sess', { id: 'cleanup-sess', name: 'Cleanup Test' });
      // Ensure sessionOrder has the session (cleanup removes it)
      const idx = (app as any).sessionOrder.indexOf('cleanup-sess');
      if (idx === -1) (app as any).sessionOrder.push('cleanup-sess');
      (app as any).addAttentionItem('cleanup-sess', 'idle_prompt', 'idle');
      (app as any).addAttentionItem('cleanup-sess', 'permission_prompt', 'perm');
      (app as any).addAttentionWorkItem('cleanup-sess', 'wi-cleanup', 'review');
      // Also add item for another session to ensure it's not removed
      (app as any).addAttentionItem('other-sess', 'idle_prompt', 'should stay');
      const sizeBefore = (app as any).attentionItems.size;

      (app as any)._cleanupSessionData('cleanup-sess');
      return {
        sizeBefore,
        sizeAfter: (app as any).attentionItems.size,
        hasCleanupIdle: (app as any).attentionItems.has('cleanup-sess:idle_prompt'),
        hasCleanupPerm: (app as any).attentionItems.has('cleanup-sess:permission_prompt'),
        hasCleanupReview: (app as any).attentionItems.has('cleanup-sess:review:wi-cleanup'),
        hasOther: (app as any).attentionItems.has('other-sess:idle_prompt'),
      };
    });
    expect(result.sizeBefore).toBe(4);
    expect(result.hasCleanupIdle).toBe(false);
    expect(result.hasCleanupPerm).toBe(false);
    expect(result.hasCleanupReview).toBe(false);
    expect(result.sizeAfter).toBe(1);
    expect(result.hasOther).toBe(true);
  });
});

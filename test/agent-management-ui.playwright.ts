/**
 * @fileoverview Playwright UI tests for the Agent Management UI.
 *
 * Covers the 6 Playwright tests from the test plan:
 * 15. Agents view shows "+ New Agent" button when _viewMode === 'agents'
 * 16. Clicking "+ New Agent" opens #agentPanel with .open class
 * 17. Agent group header shows gear icon per group
 * 18. Clicking gear icon opens panel (panel gets .open class)
 * 19. Form submit (create) triggers POST to /api/agents (intercept network)
 * 20. Delete button shows confirmation; on confirm calls DELETE endpoint
 *
 * Port: 3245
 *
 * Run: npx vitest run test/agent-management-ui.playwright.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3245;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Create an agent via the API and return its agentId.
 * The agent is registered in the running server's state store.
 */
async function createAgent(page: Page, displayName: string, role = 'codeman-dev'): Promise<string> {
  const agentId = await page.evaluate(
    async ({ displayName, role, baseUrl }) => {
      const res = await fetch(`${baseUrl}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, role }),
      });
      const data = await res.json();
      return (data.data?.agentId ?? '') as string;
    },
    { displayName, role, baseUrl: BASE_URL }
  );
  return agentId;
}

/**
 * Delete an agent via the API (cleanup helper).
 */
async function deleteAgent(page: Page, agentId: string): Promise<void> {
  await page.evaluate(
    async ({ agentId, baseUrl }) => {
      await fetch(`${baseUrl}/api/agents/${agentId}`, { method: 'DELETE' });
    },
    { agentId, baseUrl: BASE_URL }
  );
}

/**
 * Switch the SessionDrawer to agents view mode.
 */
async function openAgentsView(page: Page): Promise<void> {
  await page.evaluate(() => {
    const drawer = (window as any).SessionDrawer;
    drawer._viewMode = 'agents';
    drawer.open();
  });
  await page.waitForSelector('#sessionDrawer.open', { timeout: 4000 });
  // Trigger re-render of agents view
  await page.evaluate(() => {
    const drawer = (window as any).SessionDrawer;
    if (typeof drawer._renderAgentsView === 'function') {
      const list = document.querySelector('#sessionDrawer .drawer-list');
      if (list) drawer._renderAgentsView(list);
    } else {
      // Fallback: toggle view mode to force re-render
      drawer._viewMode = 'agents';
      if (typeof drawer._render === 'function') drawer._render();
    }
  });
  await page.waitForTimeout(200);
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Agent Management UI — Playwright', () => {
  // ── Test 15: "+ New Agent" button visible in agents view ──────────────────

  describe('Agents view — "+ New Agent" button', () => {
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      ({ context, page } = await freshPage());
      await navigateTo(page);
    });

    afterAll(async () => {
      await context?.close();
    });

    it('shows "+ New Agent" button when drawer is in agents view mode', async () => {
      await openAgentsView(page);

      const btn = page.locator('.agent-new-btn');
      await expect(btn).toBeVisible({ timeout: 3000 });
      const text = await btn.textContent();
      expect(text).toContain('+ New Agent');
    });
  });

  // ── Test 16: "+ New Agent" opens #agentPanel ──────────────────────────────

  describe('Clicking "+ New Agent"', () => {
    let context: BrowserContext;
    let page: Page;

    beforeAll(async () => {
      ({ context, page } = await freshPage());
      await navigateTo(page);
    });

    afterAll(async () => {
      await context?.close();
    });

    it('opens #agentPanel with .open class', async () => {
      await openAgentsView(page);

      // Ensure agentPanel does not have .open yet
      const panelHasOpen = await page.locator('#agentPanel').evaluate((el) => el.classList.contains('open'));
      expect(panelHasOpen).toBe(false);

      // Click the "+ New Agent" button
      await page.locator('.agent-new-btn').click();
      await page.waitForTimeout(400);

      const panelOpen = await page.locator('#agentPanel').evaluate((el) => el.classList.contains('open'));
      expect(panelOpen).toBe(true);
    });
  });

  // ── Tests 17 + 18: Gear icon per agent group ──────────────────────────────

  describe('Agent group gear icon', () => {
    let context: BrowserContext;
    let page: Page;
    let agentId: string;

    beforeAll(async () => {
      ({ context, page } = await freshPage());
      await navigateTo(page);
      agentId = await createAgent(page, 'Gear Test Agent');
      // Give SSE a moment to propagate AGENT_CREATED
      await page.waitForTimeout(500);
    });

    afterAll(async () => {
      if (agentId) await deleteAgent(page, agentId);
      await context?.close();
    });

    it('shows gear icon (⚙) in agent group header', async () => {
      await openAgentsView(page);

      const gearBtn = page.locator('.drawer-agent-gear').first();
      await expect(gearBtn).toBeVisible({ timeout: 3000 });
      const text = await gearBtn.textContent();
      // The gear character \u2699
      expect(text).toContain('\u2699');
    });

    it('clicking gear icon opens #agentPanel with .open class', async () => {
      await openAgentsView(page);

      // Close panel first if open
      await page.evaluate(() => {
        const p = document.getElementById('agentPanel');
        if (p) p.classList.remove('open');
      });

      const gearBtn = page.locator('.drawer-agent-gear').first();
      await gearBtn.click();
      await page.waitForTimeout(400);

      const panelOpen = await page.locator('#agentPanel').evaluate((el) => el.classList.contains('open'));
      expect(panelOpen).toBe(true);
    });
  });

  // ── Test 19: Form submit triggers POST /api/agents ────────────────────────

  describe('Agent create form submission', () => {
    let context: BrowserContext;
    let page: Page;
    const createdAgentIds: string[] = [];

    beforeAll(async () => {
      ({ context, page } = await freshPage());
      await navigateTo(page);
    });

    afterAll(async () => {
      for (const id of createdAgentIds) {
        await deleteAgent(page, id).catch(() => {});
      }
      await context?.close();
    });

    it('intercepts POST to /api/agents when create form is submitted', async () => {
      // Open the new agent panel
      await page.evaluate(() => (window as any).AgentPanel.openNew());
      await page.waitForSelector('#agentPanel.open', { timeout: 4000 });

      // Track POST requests to /api/agents
      const postedBodies: string[] = [];
      await page.route('**/api/agents', async (route) => {
        if (route.request().method() === 'POST') {
          postedBodies.push(route.request().postData() ?? '');
        }
        // Continue the request so the real response goes through
        await route.continue();
      });

      // Fill in the form
      await page.locator('#agentFormName').fill('Playwright Test Agent');
      await page.locator('#agentFormRole').fill('analyst');

      // Submit by clicking the "Create Agent" button
      const createBtn = page.locator('#agentPanel button').filter({ hasText: /create agent/i });
      await createBtn.click();
      await page.waitForTimeout(600);

      expect(postedBodies.length).toBeGreaterThan(0);
      const body = JSON.parse(postedBodies[0]);
      expect(body.displayName).toBe('Playwright Test Agent');
      expect(body.role).toBe('analyst');

      // Collect the new agent id for cleanup
      if (body.agentId) createdAgentIds.push(body.agentId as string);

      // Unroute
      await page.unroute('**/api/agents');
    });
  });

  // ── Test 20: Delete button + confirmation ─────────────────────────────────

  describe('Agent delete flow', () => {
    let context: BrowserContext;
    let page: Page;
    let agentId: string;

    beforeAll(async () => {
      ({ context, page } = await freshPage());
      await navigateTo(page);
      agentId = await createAgent(page, 'Agent To Delete');
      await page.waitForTimeout(500);
    });

    afterAll(async () => {
      // Try to clean up in case delete test didn't fire
      if (agentId) await deleteAgent(page, agentId).catch(() => {});
      await context?.close();
    });

    it('shows confirmation dialog and calls DELETE endpoint on confirm', async () => {
      // Open the agent's settings panel
      await page.evaluate((id: string) => (window as any).AgentPanel.open(id), agentId);
      await page.waitForSelector('#agentPanel.open', { timeout: 4000 });

      // Track DELETE requests
      const deletedUrls: string[] = [];
      await page.route(`**/api/agents/${agentId}`, async (route) => {
        if (route.request().method() === 'DELETE') {
          deletedUrls.push(route.request().url());
        }
        await route.continue();
      });

      // Accept the confirmation dialog automatically
      page.once('dialog', (dialog) => dialog.accept());

      // Click the Delete button
      const deleteBtn = page.locator('#agentPanel .agent-btn-danger').filter({ hasText: /delete/i });
      await deleteBtn.click();
      await page.waitForTimeout(600);

      expect(deletedUrls.length).toBeGreaterThan(0);
      expect(deletedUrls[0]).toContain(`/api/agents/${agentId}`);

      // Cleanup: mark as already deleted
      agentId = '';

      await page.unroute(`**/api/agents/${agentId || '.*'}`).catch(() => {});
    });
  });
});

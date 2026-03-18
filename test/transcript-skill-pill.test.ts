/**
 * Transcript Skill Pill — functional test suite
 *
 * Tests the skill launch pill feature: when the Skill tool fires in Claude Code,
 * the tool_result block is rendered as a `.tv-skill-pill` instead of a normal
 * tool wrapper row, and the following user text block (skill content) is suppressed.
 *
 * Port: 3213 (adjacent to transcript-web-view tests on 3212)
 *
 * Run: npx vitest run test/transcript-skill-pill.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3213;
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
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-skill-pill-session' }),
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

/** Send a transcript block via the app's _onTranscriptBlock method */
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

describe('Skill pill — tool_result triggers pill rendering', () => {
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

    // Send tool_use block first (simulates Claude calling the Skill tool)
    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_skill',
      name: 'Skill',
      input: { skill: 'gsd:progress' },
      timestamp: new Date().toISOString(),
    });

    // Send the tool_result with "Launching skill: ..." content
    await sendBlock(page, sessionId, {
      type: 'tool_result',
      toolUseId: 'tu_skill',
      content: 'Launching skill: gsd:progress',
      isError: false,
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('.tv-skill-pill exists in #transcriptView', async () => {
    const count = await page.locator('#transcriptView .tv-skill-pill').count();
    expect(count).toBeGreaterThan(0);
  });

  it('.tv-skill-pill textContent is /gsd:progress', async () => {
    const text = await page.locator('#transcriptView .tv-skill-pill').first().textContent();
    expect(text).toBe('/gsd:progress');
  });

  it('no .tv-tool-row exists for the skill tool_use (pending wrapper was replaced)', async () => {
    const toolRows = await page.locator('#transcriptView .tv-tool-row').count();
    expect(toolRows).toBe(0);
  });

  it('.tv-skill-pill is a direct child of #transcriptView (not nested in a tool group)', async () => {
    const isDirectChild = await page.evaluate(() => {
      const container = document.getElementById('transcriptView');
      const pill = container?.querySelector('.tv-skill-pill');
      return pill !== null && pill?.parentElement === container;
    });
    expect(isDirectChild).toBe(true);
  });
});

describe('Skill pill — skill content user block is suppressed', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let blocksBefore: number;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    // Send skill launch pair
    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_skill2',
      name: 'Skill',
      input: { skill: 'gsd:progress' },
      timestamp: new Date().toISOString(),
    });
    await sendBlock(page, sessionId, {
      type: 'tool_result',
      toolUseId: 'tu_skill2',
      content: 'Launching skill: gsd:progress',
      isError: false,
      timestamp: new Date().toISOString(),
    });

    // Record user block count after skill launch (before skill content)
    blocksBefore = await page.locator('#transcriptView .tv-block--user').count();

    // Now send the GSD XML skill content block (should be suppressed)
    await sendBlock(page, sessionId, {
      type: 'text',
      role: 'user',
      text: '<objective>Make progress on the current task</objective>\n<when_to_save>After each major step</when_to_save>',
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('no new .tv-block--user appears after skill content block', async () => {
    const blocksAfter = await page.locator('#transcriptView .tv-block--user').count();
    expect(blocksAfter).toBe(blocksBefore);
  });
});

describe('Skill pill — superpowers skill content suppressed via flag', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let blocksBefore: number;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    // Send superpowers skill launch pair
    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_sp',
      name: 'Skill',
      input: { skill: 'superpowers:brainstorming' },
      timestamp: new Date().toISOString(),
    });
    await sendBlock(page, sessionId, {
      type: 'tool_result',
      toolUseId: 'tu_sp',
      content: 'Launching skill: superpowers:brainstorming',
      isError: false,
      timestamp: new Date().toISOString(),
    });

    blocksBefore = await page.locator('#transcriptView .tv-block--user').count();

    // Send the superpowers skill content (Base directory pattern)
    await sendBlock(page, sessionId, {
      type: 'text',
      role: 'user',
      text: 'Base directory for this skill: /home/user/.claude/plugins/cache/superpowers/1.0.0/skills/brainstorming\n\n# Brainstorming Skill\n\nThis skill helps you brainstorm ideas.',
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('.tv-skill-pill textContent is /superpowers:brainstorming', async () => {
    const text = await page.locator('#transcriptView .tv-skill-pill').first().textContent();
    expect(text).toBe('/superpowers:brainstorming');
  });

  it('no .tv-block--user appears for the superpowers skill content', async () => {
    const blocksAfter = await page.locator('#transcriptView .tv-block--user').count();
    expect(blocksAfter).toBe(blocksBefore);
  });
});

describe('Skill pill — regular user message after skill is NOT suppressed', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;
  let blocksBeforeRegular: number;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, []);
    await selectSession(page, sessionId);

    // Send skill launch + suppressed content
    await sendBlock(page, sessionId, {
      type: 'tool_use',
      id: 'tu_reg',
      name: 'Skill',
      input: { skill: 'gsd:progress' },
      timestamp: new Date().toISOString(),
    });
    await sendBlock(page, sessionId, {
      type: 'tool_result',
      toolUseId: 'tu_reg',
      content: 'Launching skill: gsd:progress',
      isError: false,
      timestamp: new Date().toISOString(),
    });
    // Suppressed skill content block
    await sendBlock(page, sessionId, {
      type: 'text',
      role: 'user',
      text: '<objective>Do the task</objective>',
      timestamp: new Date().toISOString(),
    });

    // Record count AFTER the suppressed block (flag should be cleared now)
    blocksBeforeRegular = await page.locator('#transcriptView .tv-block--user').count();

    // Send a normal user message — should NOT be suppressed
    await sendBlock(page, sessionId, {
      type: 'text',
      role: 'user',
      text: 'This is a regular user message that should appear.',
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('a new .tv-block--user appears for the regular user message (flag is cleared)', async () => {
    const blocksAfter = await page.locator('#transcriptView .tv-block--user').count();
    expect(blocksAfter).toBe(blocksBeforeRegular + 1);
  });
});

describe('Skill pill — replay from transcript JSON', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  const SKILL_TRANSCRIPT = [
    // First skill launch: gsd:progress
    {
      type: 'tool_use',
      id: 'tu_r1',
      name: 'Skill',
      input: { skill: 'gsd:progress' },
      timestamp: '2026-01-01T10:00:00.000Z',
    },
    {
      type: 'tool_result',
      toolUseId: 'tu_r1',
      content: 'Launching skill: gsd:progress',
      isError: false,
      timestamp: '2026-01-01T10:00:01.000Z',
    },
    // GSD XML skill content (should be suppressed)
    {
      type: 'text',
      role: 'user',
      text: '<objective>Make progress on the current task</objective>\n<phase>implementation</phase>',
      timestamp: '2026-01-01T10:00:02.000Z',
    },
    // Normal user message (should NOT be suppressed)
    {
      type: 'text',
      role: 'user',
      text: 'Please proceed with the implementation.',
      timestamp: '2026-01-01T10:00:03.000Z',
    },
  ];

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    sessionId = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionId);
    await mockTranscript(page, sessionId, SKILL_TRANSCRIPT);
    await selectSession(page, sessionId);
    await page.waitForTimeout(800);
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('.tv-skill-pill count matches number of skill launches in mock data (1)', async () => {
    const count = await page.locator('#transcriptView .tv-skill-pill').count();
    expect(count).toBe(1);
  });

  it('no .tv-block--user rendered for the skill content block', async () => {
    // The GSD XML block should be suppressed; only the normal user message should show
    const userBlocks = await page.locator('#transcriptView .tv-block--user').count();
    expect(userBlocks).toBe(1);
  });

  it('normal user message IS rendered as .tv-block--user', async () => {
    const text = await page.locator('#transcriptView .tv-block--user .tv-bubble').first().textContent();
    expect(text).toContain('Please proceed with the implementation');
  });
});

// ─── Gap 1: pendingEl-null path ──────────────────────────────────────────────
// A tool_result with "Launching skill:" arrives without a prior tool_use.
// The pendingEl lookup returns null, so the pill is appended directly to the
// container without any group-removal logic. This path was not previously tested.

describe('Skill pill — Gap 1: tool_result with no preceding tool_use still renders a pill', () => {
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

    // Send ONLY the tool_result — no preceding tool_use block
    await sendBlock(page, sessionId, {
      type: 'tool_result',
      toolUseId: 'tu_no_pending',
      content: 'Launching skill: codeman-task-runner',
      isError: false,
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('.tv-skill-pill is rendered even without a preceding tool_use', async () => {
    const count = await page.locator('#transcriptView .tv-skill-pill').count();
    expect(count).toBeGreaterThan(0);
  });

  it('.tv-skill-pill textContent is /codeman-task-runner', async () => {
    const text = await page.locator('#transcriptView .tv-skill-pill').first().textContent();
    expect(text).toBe('/codeman-task-runner');
  });

  it('.tv-skill-pill is a direct child of #transcriptView', async () => {
    const isDirectChild = await page.evaluate(() => {
      const container = document.getElementById('transcriptView');
      const pill = container?.querySelector('.tv-skill-pill');
      return pill !== null && pill?.parentElement === container;
    });
    expect(isDirectChild).toBe(true);
  });
});

// ─── Gap 2: pendingEl.remove() fallback branch ───────────────────────────────
// pendingEl exists but has no .tv-tool-group ancestor. The else branch
// calls pendingEl.remove() and still appends the pill to the container.
// This is tested by injecting a fake pendingEl directly into #transcriptView
// (not inside a .tv-tool-group) via JS, then sending a matching tool_result.

describe('Skill pill — Gap 2: pendingEl without .tv-tool-group ancestor is removed, pill still renders', () => {
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

    // Inject a fake pendingEl directly into #transcriptView (not inside a .tv-tool-group)
    // Give it the data-tool-id that matches the upcoming tool_result's toolUseId.
    await page.evaluate(() => {
      const container = document.getElementById('transcriptView');
      if (!container) throw new Error('#transcriptView not found');
      const fakeEl = document.createElement('div');
      fakeEl.className = 'tv-fake-pending-marker';
      fakeEl.dataset.toolId = 'tu_no_group_ancestor';
      fakeEl.textContent = 'fake pending element';
      container.appendChild(fakeEl);
    });
    await page.waitForTimeout(100);

    // Send the tool_result matching the fake pendingEl's toolUseId
    await sendBlock(page, sessionId, {
      type: 'tool_result',
      toolUseId: 'tu_no_group_ancestor',
      content: 'Launching skill: gsd:standup',
      isError: false,
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await page.evaluate(async (id) => {
      await fetch('/api/sessions/' + id, { method: 'DELETE' });
    }, sessionId);
    await context?.close();
  });

  it('the fake pendingEl is removed from #transcriptView', async () => {
    const fakeCount = await page.locator('#transcriptView .tv-fake-pending-marker').count();
    expect(fakeCount).toBe(0);
  });

  it('.tv-skill-pill is rendered after the fake pendingEl is removed', async () => {
    const pillCount = await page.locator('#transcriptView .tv-skill-pill').count();
    expect(pillCount).toBeGreaterThan(0);
  });

  it('.tv-skill-pill textContent is /gsd:standup', async () => {
    const text = await page.locator('#transcriptView .tv-skill-pill').first().textContent();
    expect(text).toBe('/gsd:standup');
  });

  it('.tv-skill-pill is a direct child of #transcriptView (not nested)', async () => {
    const isDirectChild = await page.evaluate(() => {
      const container = document.getElementById('transcriptView');
      const pill = container?.querySelector('.tv-skill-pill');
      return pill !== null && pill?.parentElement === container;
    });
    expect(isDirectChild).toBe(true);
  });
});

// ─── Gap 3: _lastSkillLaunch reset on session switch ─────────────────────────
// A stale _lastSkillLaunch from session A must not suppress the first real
// user message of session B after selectSession() is called.

describe('Skill pill — Gap 3: _lastSkillLaunch is reset on session switch (no stale suppression)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionIdA: string;
  let sessionIdB: string;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);

    // Create two sessions
    sessionIdA = await createClaudeSession(page);
    sessionIdB = await createClaudeSession(page);
    await clearViewModeStorage(page, sessionIdA);
    await clearViewModeStorage(page, sessionIdB);

    // Mock both sessions' transcripts as empty
    await mockTranscript(page, sessionIdA, []);
    await mockTranscript(page, sessionIdB, []);

    // Select session A and trigger a skill launch — this sets _lastSkillLaunch
    await selectSession(page, sessionIdA);
    await sendBlock(page, sessionIdA, {
      type: 'tool_use',
      id: 'tu_stale',
      name: 'Skill',
      input: { skill: 'gsd:progress' },
      timestamp: new Date().toISOString(),
    });
    await sendBlock(page, sessionIdA, {
      type: 'tool_result',
      toolUseId: 'tu_stale',
      content: 'Launching skill: gsd:progress',
      isError: false,
      timestamp: new Date().toISOString(),
    });

    // Do NOT send the skill content block — _lastSkillLaunch is still set on session A's view

    // Switch to session B — this should reset _lastSkillLaunch
    await selectSession(page, sessionIdB);

    // Send a normal user message to session B — must NOT be suppressed
    await sendBlock(page, sessionIdB, {
      type: 'text',
      role: 'user',
      text: 'This message should not be suppressed by a stale skill flag from session A.',
      timestamp: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await page.evaluate(
      async ([idA, idB]) => {
        await fetch('/api/sessions/' + idA, { method: 'DELETE' });
        await fetch('/api/sessions/' + idB, { method: 'DELETE' });
      },
      [sessionIdA, sessionIdB]
    );
    await context?.close();
  });

  it('user message in session B is NOT suppressed after switching from session A with stale flag', async () => {
    const userBlocks = await page.locator('#transcriptView .tv-block--user').count();
    expect(userBlocks).toBe(1);
  });

  it('the user message text is visible in session B', async () => {
    const text = await page.locator('#transcriptView .tv-block--user .tv-bubble').first().textContent();
    expect(text).toContain('should not be suppressed');
  });
});

/**
 * AskUserQuestion interactive UI tests
 *
 * Covers three bugs fixed in fix/transcript-interactive-questions:
 * 1. Multi-select (checkbox) support — selecting multiple options + Next button
 * 2. Wizard back navigation — Back button pre-fills previous answer
 * 3. No duplicate drawer — auq-panel must never appear; only tv-auq-block in transcript
 *
 * Additional regression guard:
 * 4. Free-form Claude questions (plain text) never trigger the structured widget
 *
 * Port: 3222 (auq-interactive tests)
 *
 * Run: npx vitest run test/auq-interactive.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3222;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

// ─── Helpers ──────────────────────────────────────────────────────────────

async function freshPage(width = 1280, height = 800): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  return { context, page };
}

async function navigateApp(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
    timeout: 8000,
  });
  await page.waitForTimeout(300);
}

/**
 * Inject an AskUserQuestion block and return the rendered element's outer HTML.
 * Creates a visible test container in the body.
 */
async function injectAndGetBlock(page: Page, block: object): Promise<string | null> {
  return page.evaluate((b) => {
    if (typeof TranscriptView === 'undefined') return null;
    // Remove any stale test container
    const old = document.getElementById('__test_tv_container');
    if (old) old.remove();
    const container = document.createElement('div');
    container.id = '__test_tv_container';
    // Make visible so Playwright can interact with children
    container.style.cssText =
      'position:fixed;top:0;left:0;width:600px;min-height:200px;background:#111;z-index:9999;overflow:auto;';
    document.body.appendChild(container);
    TranscriptView._container = container;
    TranscriptView._sessionId = 'test-session-auq';
    TranscriptView._appendBlock(b as any, false);
    const el = container.querySelector('.tv-auq-block');
    return el ? el.outerHTML : null;
  }, block);
}

/** Clean up the test container */
async function cleanupContainer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const c = document.getElementById('__test_tv_container');
    if (c) c.remove();
    if (typeof TranscriptView !== 'undefined') {
      TranscriptView._container = null;
    }
  });
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Bug 3: No duplicate drawer ───────────────────────────────────────────

describe('No duplicate drawer (bug 3 regression)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateApp(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('auq-panel DOM element does not exist in the page', async () => {
    const panelExists = await page.evaluate(() => {
      return !!document.getElementById('askUserQuestionPanel');
    });
    expect(panelExists).toBe(false);
  });

  it('renderAskUserQuestionPanel function is no longer defined on app', async () => {
    const hasFn = await page.evaluate(() => {
      return typeof (app as any).renderAskUserQuestionPanel === 'function';
    });
    expect(hasFn).toBe(false);
  });

  it('tv-auq-block renders inline when AskUserQuestion block is injected', async () => {
    const html = await injectAndGetBlock(page, {
      type: 'tool_use',
      id: 'auq-test-radio-1',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            header: 'Test Header',
            question: 'Pick one',
            options: [{ label: 'Option A' }, { label: 'Option B' }],
          },
        ],
      },
    });
    expect(html).not.toBeNull();
    expect(html).toContain('tv-auq-block');
    await cleanupContainer(page);
  });

  it('no auq-panel overlay exists at any time during question display', async () => {
    await injectAndGetBlock(page, {
      type: 'tool_use',
      id: 'auq-test-radio-2',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            header: 'Verify No Panel',
            question: 'Pick one',
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      },
    });

    const panelVisible = await page.evaluate(() => {
      const panel = document.getElementById('askUserQuestionPanel');
      if (!panel) return false;
      return panel.style.display !== 'none';
    });
    expect(panelVisible).toBe(false);
    await cleanupContainer(page);
  });
});

// ─── Bug 1 (radio): Single-select auto-advances ───────────────────────────

describe('Radio question (bug 1 — single-select auto-advance)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateApp(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('radio question renders option buttons without a Next button', async () => {
    await injectAndGetBlock(page, {
      type: 'tool_use',
      id: 'auq-radio-render',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            header: 'Radio Test',
            question: 'Which framework?',
            multiSelect: false,
            options: [{ label: 'React' }, { label: 'Vue' }],
          },
        ],
      },
    });

    const result = await page.evaluate(() => {
      const block = document.querySelector('.tv-auq-block');
      if (!block) return null;
      return {
        hasNextBtn: !!block.querySelector('.tv-auq-next'),
        optionCount: block.querySelectorAll('.tv-auq-option').length,
        hasCheckboxes: !!block.querySelector('input[type="checkbox"]'),
      };
    });

    expect(result).not.toBeNull();
    expect(result!.optionCount).toBe(2);
    expect(result!.hasNextBtn).toBe(false);
    expect(result!.hasCheckboxes).toBe(false);
    await cleanupContainer(page);
  });

  it('clicking a radio option invokes sendAskUserQuestionResponse and removes the block', async () => {
    // Intercept sendAskUserQuestionResponse via page.evaluate
    await page.evaluate(() => {
      (window as any).__auqResponseCalls = [];
    });

    await injectAndGetBlock(page, {
      type: 'tool_use',
      id: 'auq-radio-click',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Auto advance test',
            multiSelect: false,
            options: [{ label: 'OptionOne' }, { label: 'OptionTwo' }],
          },
        ],
      },
    });

    // Patch sendAskUserQuestionResponse AFTER the block is rendered
    await page.evaluate(() => {
      (window as any).__auqResponseCalls = [];
      (app as any).sendAskUserQuestionResponse = (sid: string, val: string) => {
        (window as any).__auqResponseCalls.push({ sid, val });
      };
    });

    // Click first option using dispatchEvent to avoid visibility issues
    await page.evaluate(() => {
      const btn = document.querySelector('#__test_tv_container .tv-auq-option') as HTMLButtonElement | null;
      if (btn) btn.click();
    });

    const result = await page.evaluate(() => {
      return {
        blockGone: !document.querySelector('#__test_tv_container .tv-auq-block'),
        calls: (window as any).__auqResponseCalls,
      };
    });

    expect(result.blockGone).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].val).toBe('1');
    await cleanupContainer(page);
  });
});

// ─── Bug 1 (checkbox): Multi-select + Next button ────────────────────────

describe('Checkbox question (bug 1 — multi-select + Next button)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateApp(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('multiSelect question renders a Next button', async () => {
    await injectAndGetBlock(page, {
      type: 'tool_use',
      id: 'auq-multi-render',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            header: 'Multi Test',
            question: 'Pick all that apply',
            multiSelect: true,
            options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          },
        ],
      },
    });

    const result = await page.evaluate(() => {
      const block = document.querySelector('.tv-auq-block');
      if (!block) return null;
      return {
        hasNextBtn: !!block.querySelector('.tv-auq-next'),
        optionCount: block.querySelectorAll('.tv-auq-option').length,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.hasNextBtn).toBe(true);
    expect(result!.optionCount).toBe(3);
    await cleanupContainer(page);
  });

  it('clicking options in multiSelect mode toggles .selected class without auto-advancing', async () => {
    await injectAndGetBlock(page, {
      type: 'tool_use',
      id: 'auq-multi-toggle',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Toggle test',
            multiSelect: true,
            options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
          },
        ],
      },
    });

    // Click first and third options via JS click
    await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('#__test_tv_container .tv-auq-option')) as HTMLButtonElement[];
      if (opts[0]) opts[0].click();
      if (opts[2]) opts[2].click();
    });

    const result = await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('#__test_tv_container .tv-auq-option'));
      return {
        selected: opts.map((o) => o.classList.contains('selected')),
        blockStillPresent: !!document.querySelector('#__test_tv_container .tv-auq-block'),
      };
    });

    expect(result.selected).toEqual([true, false, true]);
    expect(result.blockStillPresent).toBe(true); // NOT auto-advanced
    await cleanupContainer(page);
  });

  it('Next button in multiSelect submits comma-separated selected option numbers', async () => {
    await page.evaluate(() => {
      (window as any).__auqResponseCalls = [];
    });

    await injectAndGetBlock(page, {
      type: 'tool_use',
      id: 'auq-multi-submit',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Submit test',
            multiSelect: true,
            options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
          },
        ],
      },
    });

    await page.evaluate(() => {
      (window as any).__auqResponseCalls = [];
      (app as any).sendAskUserQuestionResponse = (sid: string, val: string) => {
        (window as any).__auqResponseCalls.push({ sid, val });
      };
      // Click first and third options
      const opts = Array.from(document.querySelectorAll('#__test_tv_container .tv-auq-option')) as HTMLButtonElement[];
      if (opts[0]) opts[0].click(); // X → 1
      if (opts[2]) opts[2].click(); // Z → 3
      // Click Next
      const nextBtn = document.querySelector('#__test_tv_container .tv-auq-next') as HTMLButtonElement | null;
      if (nextBtn) nextBtn.click();
    });

    const result = await page.evaluate(() => {
      return {
        blockGone: !document.querySelector('#__test_tv_container .tv-auq-block'),
        calls: (window as any).__auqResponseCalls,
      };
    });

    expect(result.blockGone).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].val).toContain('1');
    expect(result.calls[0].val).toContain('3');
    await cleanupContainer(page);
  });
});

// ─── Bug 2: Wizard back navigation ────────────────────────────────────────

describe('Wizard back navigation (bug 2)', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateApp(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('first question shows no Back button', async () => {
    await injectAndGetBlock(page, {
      type: 'tool_use',
      id: 'auq-wizard-1',
      name: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Step 1', options: [{ label: 'A' }, { label: 'B' }] },
          { question: 'Step 2', options: [{ label: 'C' }, { label: 'D' }] },
        ],
      },
    });

    const hasBack = await page.evaluate(() => {
      const block = document.querySelector('.tv-auq-block');
      return block ? !!block.querySelector('.tv-auq-back') : null;
    });

    expect(hasBack).toBe(false);
    await cleanupContainer(page);
  });

  it('after clicking an option on step 1, Back button appears on step 2', async () => {
    await injectAndGetBlock(page, {
      type: 'tool_use',
      id: 'auq-wizard-back',
      name: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Step One', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
          { question: 'Step Two', options: [{ label: 'Gamma' }, { label: 'Delta' }] },
        ],
      },
    });

    // Click first option on step 1 — radio auto-advances to step 2
    await page.evaluate(() => {
      const btn = document.querySelector('#__test_tv_container .tv-auq-option') as HTMLButtonElement | null;
      if (btn) btn.click();
    });

    const step2 = await page.evaluate(() => {
      const block = document.querySelector('.tv-auq-block');
      if (!block) return null;
      return {
        hasBack: !!block.querySelector('.tv-auq-back'),
        questionText: block.querySelector('.tv-auq-question')?.textContent,
      };
    });

    expect(step2).not.toBeNull();
    expect(step2!.hasBack).toBe(true);
    expect(step2!.questionText).toContain('Step Two');

    // Click Back
    await page.evaluate(() => {
      const backBtn = document.querySelector('#__test_tv_container .tv-auq-back') as HTMLButtonElement | null;
      if (backBtn) backBtn.click();
    });

    // Should be back on step 1
    const step1 = await page.evaluate(() => {
      const block = document.querySelector('.tv-auq-block');
      if (!block) return null;
      return {
        hasBack: !!block.querySelector('.tv-auq-back'),
        questionText: block.querySelector('.tv-auq-question')?.textContent,
      };
    });

    expect(step1!.questionText).toContain('Step One');
    expect(step1!.hasBack).toBe(false);
    await cleanupContainer(page);
  });

  it('Back navigation pre-fills previously selected option (.selected class)', async () => {
    await injectAndGetBlock(page, {
      type: 'tool_use',
      id: 'auq-wizard-prefill',
      name: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Q1', options: [{ label: 'Opt1' }, { label: 'Opt2' }] },
          { question: 'Q2', options: [{ label: 'Opt3' }, { label: 'Opt4' }] },
        ],
      },
    });

    // Click second option on Q1 (Opt2)
    await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('#__test_tv_container .tv-auq-option')) as HTMLButtonElement[];
      if (opts[1]) opts[1].click(); // selects Opt2, advances to Q2
    });

    // Go back
    await page.evaluate(() => {
      const backBtn = document.querySelector('#__test_tv_container .tv-auq-back') as HTMLButtonElement | null;
      if (backBtn) backBtn.click();
    });

    // Check that Opt2 (second button) has .selected class pre-filled
    const prefilled = await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('#__test_tv_container .tv-auq-option'));
      return opts.map((o) => o.classList.contains('selected'));
    });

    // Second option should be pre-selected after back navigation
    expect(prefilled[1]).toBe(true);
    expect(prefilled[0]).toBe(false);
    await cleanupContainer(page);
  });
});

// ─── Regression guard: free-form Claude questions ─────────────────────────

describe('Regression guard — freeform Claude questions', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateApp(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('plain text assistant block never triggers tv-auq-block', async () => {
    await page.evaluate(() => {
      if (typeof TranscriptView === 'undefined') return;
      const old = document.getElementById('__test_tv_container_freeform');
      if (old) old.remove();
      const container = document.createElement('div');
      container.id = '__test_tv_container_freeform';
      container.style.cssText = 'position:fixed;top:0;left:0;width:600px;min-height:100px;z-index:9999;';
      document.body.appendChild(container);
      TranscriptView._container = container;
      TranscriptView._sessionId = 'test-session-freeform';
      TranscriptView._appendBlock(
        {
          type: 'text',
          role: 'assistant',
          text: 'How are we doing this session? Are you happy with my progress?',
        } as any,
        false
      );
    });

    const hasAuqBlock = await page.evaluate(() => {
      return !!document.querySelector('#__test_tv_container_freeform .tv-auq-block');
    });
    expect(hasAuqBlock).toBe(false);

    await page.evaluate(() => {
      const c = document.getElementById('__test_tv_container_freeform');
      if (c) c.remove();
    });
  });

  it('tool_use block with name other than AskUserQuestion never triggers tv-auq-block', async () => {
    await page.evaluate(() => {
      if (typeof TranscriptView === 'undefined') return;
      const old = document.getElementById('__test_tv_container_othertool');
      if (old) old.remove();
      const container = document.createElement('div');
      container.id = '__test_tv_container_othertool';
      container.style.cssText = 'position:fixed;top:0;left:0;width:600px;min-height:100px;z-index:9999;';
      document.body.appendChild(container);
      TranscriptView._container = container;
      TranscriptView._sessionId = 'test-session-othertool';
      TranscriptView._appendBlock(
        {
          type: 'tool_use',
          id: 'tu-other',
          name: 'Bash',
          input: { command: 'echo hello' },
        } as any,
        false
      );
    });

    const hasAuqBlock = await page.evaluate(() => {
      return !!document.querySelector('#__test_tv_container_othertool .tv-auq-block');
    });
    expect(hasAuqBlock).toBe(false);

    await page.evaluate(() => {
      const c = document.getElementById('__test_tv_container_othertool');
      if (c) c.remove();
    });
  });
});

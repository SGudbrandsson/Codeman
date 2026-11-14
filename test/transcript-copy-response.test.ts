/**
 * Transcript Response Actions — functional test suite
 *
 * Every assistant transcript block ends in a `.tv-block-actions` row holding
 * two quiet icon buttons (the Claude app pattern):
 *   • `.tv-copy-btn` — copies the raw markdown source
 *   • `.tv-tts-btn`  — reads the whole response aloud (tap again to stop)
 *
 * Covered:
 *   • CSS rules exist; TranscriptView helpers are callable
 *   • Assistant blocks get the row, user blocks do not; the row sits after
 *     .tv-content and survives _typewriterReveal
 *   • No floating top-right read-aloud button remains
 *   • Copy writes block.text exactly; execCommand fallback works and failures toast
 *   • _flashCopied swaps the icon for a check mark + .copied, then restores
 *   • Coarse pointer: ≥40px targets; always visible without hover
 *   • Clicks call stopPropagation so block-level handlers do not fire
 *
 * Port: 3263
 *
 * Run: npx vitest run test/transcript-copy-response.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3263;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Mock data ──────────────────────────────────────────────────────────────

const ASSISTANT_MARKDOWN =
  'Here is the plan:\n\n- Extract token validation\n- Move rate limiting\n\n**Bold text** and `inline code` example.\n\n```js\nconst token = validate(req);\n```';

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
    text: ASSISTANT_MARKDOWN,
    timestamp: '2026-01-01T10:00:01.000Z',
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

let server: WebServer;
let browser: Browser;

type PageOpts = {
  /** Grant clipboard-read/write on the context (needed to read payloads back). */
  grantClipboard?: boolean;
  /**
   * Playwright device descriptor to build the context from — used by the
   * coarse-pointer suite. Defaults to a plain 1280x800 desktop context.
   */
  device?: Parameters<Browser['newContext']>[0];
};

async function freshPage(opts: PageOpts = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(opts.device ?? { viewport: { width: 1280, height: 800 } });
  if (opts.grantClipboard) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
  }
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
      body: JSON.stringify({ workingDir: '/tmp', name: 'test-copy-response' }),
    });
    const data = await res.json();
    return (data.id ?? data.session?.id) as string;
  });
  return id;
}

async function mockTranscript(page: Page, sessionId: string, blocks: unknown[]): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/transcript**`, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(blocks) });
  });
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { app: { selectSession: (id: string) => void } }).app.selectSession(id);
  }, sessionId);
  await page.waitForTimeout(800);
}

async function deleteSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await fetch('/api/sessions/' + id, { method: 'DELETE' });
  }, sessionId);
}

/** Boot a page with the mocked two-block transcript selected and rendered. */
async function pageWithTranscript(opts: PageOpts = {}): Promise<{
  context: BrowserContext;
  page: Page;
  sessionId: string;
}> {
  const { context, page } = await freshPage(opts);
  await navigateTo(page);
  const sessionId = await createSession(page);
  await page.evaluate((id) => localStorage.removeItem('transcriptViewMode:' + id), sessionId);
  await mockTranscript(page, sessionId, MOCK_TEXT_BLOCKS);
  await selectSession(page, sessionId);
  // Let the typewriter reveal finish so the final markdown pass has run.
  await page.waitForTimeout(1500);
  return { context, page, sessionId };
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

// ─── Tier 1: CSS smoke tests ─────────────────────────────────────────────────

describe('CSS smoke — response-action rules are defined in the stylesheet', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  const expectedSelectors = [
    '.tv-block-actions',
    '.tv-action-btn',
    '.tv-action-btn:hover, .tv-action-btn:focus-visible',
    '.tv-copy-btn.copied',
    '.tv-tts-btn--speaking',
  ];

  for (const selector of expectedSelectors) {
    it(`${selector} rule exists in a loaded stylesheet`, async () => {
      const found = await page.evaluate((sel) => {
        const wanted = sel.split(',').map((s) => s.trim());
        const visit = (rules: CSSRule[]): boolean =>
          rules.some((r) => {
            if (r instanceof CSSStyleRule) {
              const parts = r.selectorText.split(',').map((s) => s.trim());
              return wanted.every((w) => parts.includes(w));
            }
            if (r instanceof CSSMediaRule) return visit(Array.from(r.cssRules ?? []));
            return false;
          });
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            if (visit(Array.from(sheet.cssRules ?? []))) return true;
          } catch {
            // cross-origin sheet — skip
          }
        }
        return false;
      }, selector);
      expect(found, `Expected CSS rule for "${selector}" to be present`).toBe(true);
    });
  }
});

describe('CSS smoke — TranscriptView action helpers are callable functions', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  for (const name of ['_buildBlockActions', '_copyMarkdown', '_flashCopied', '_copySVG', '_checkSVG']) {
    it(`TranscriptView.${name} is a function`, async () => {
      const isFunction = await page.evaluate((n) => {
        const tv = (window as unknown as { TranscriptView: Record<string, unknown> }).TranscriptView;
        return typeof tv[n] === 'function';
      }, name);
      expect(isFunction).toBe(true);
    });
  }

  it('the rich-text copy path is gone', async () => {
    const leftovers = await page.evaluate(() => {
      const tv = (window as unknown as { TranscriptView: Record<string, unknown> }).TranscriptView;
      return ['_richHtmlFor', '_copyRichText', '_execCopyHtml'].filter((n) => n in tv);
    });
    expect(leftovers).toEqual([]);
  });
});

// ─── Tier 2: render placement ────────────────────────────────────────────────

describe('Render placement — one copy + one play icon under assistant blocks only', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page, sessionId } = await pageWithTranscript());
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('assistant block contains a .tv-block-actions row', async () => {
    const count = await page.locator('#transcriptView .tv-block--assistant .tv-block-actions').count();
    expect(count).toBe(1);
  });

  it('user block contains no .tv-block-actions row', async () => {
    const count = await page.locator('#transcriptView .tv-block--user .tv-block-actions').count();
    expect(count).toBe(0);
  });

  it('the row holds exactly a copy button then a play button, both icon-only', async () => {
    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#transcriptView .tv-block-actions button')).map((b) => ({
        cls: b.className,
        label: b.getAttribute('aria-label'),
        text: (b.textContent || '').trim(),
        hasSvg: !!b.querySelector('svg'),
      }))
    );
    expect(buttons.map((b) => b.label)).toEqual(['Copy response as markdown', 'Read aloud']);
    expect(buttons[0].cls).toContain('tv-copy-btn');
    expect(buttons[1].cls).toContain('tv-tts-btn');
    for (const b of buttons) {
      expect(b.text).toBe('');
      expect(b.hasSvg).toBe(true);
    }
  });

  it('no read-aloud button floats outside the actions row', async () => {
    const stray = await page.evaluate(
      () => document.querySelectorAll('#transcriptView .tv-block--assistant > .tv-tts-btn').length
    );
    expect(stray).toBe(0);
  });

  it('the row is a direct child of .tv-block--assistant and comes after .tv-content', async () => {
    const shape = await page.evaluate(() => {
      const row = document.querySelector('#transcriptView .tv-block--assistant .tv-block-actions');
      const block = document.querySelector('#transcriptView .tv-block--assistant');
      const content = block?.querySelector(':scope > .tv-content');
      return {
        directChild: row?.parentElement === block,
        insideContent: row?.closest('.tv-content') !== null,
        afterContent: !!(content && row && content.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    expect(shape.directChild).toBe(true);
    expect(shape.insideContent).toBe(false);
    expect(shape.afterContent).toBe(true);
  });

  it('the play button starts read-aloud for this response and toggles to stop', async () => {
    const state = await page.evaluate(() => {
      // ReadAloud is a top-level const (not on window) — reach it by name.
      // Keep the real UI wiring but do not actually synthesize audio.
      const readAloud = (0, eval)('ReadAloud') as { start: (o: unknown) => boolean };
      readAloud.start = () => true;
      const btn = document.querySelector('#transcriptView .tv-block-actions .tv-tts-btn') as HTMLButtonElement;
      btn.click();
      const speaking = btn.classList.contains('tv-tts-btn--speaking');
      const label = btn.getAttribute('aria-label');
      btn.click();
      return { speaking, label, after: btn.classList.contains('tv-tts-btn--speaking') };
    });
    expect(state.speaking).toBe(true);
    expect(state.label).toBe('Stop reading aloud');
    expect(state.after).toBe(false);
  });

  it('the row survives _typewriterReveal (still present after a re-reveal)', async () => {
    await page.evaluate(() => {
      const block = document.querySelector('#transcriptView .tv-block--assistant') as HTMLElement;
      const tv = (window as unknown as { TranscriptView: { _typewriterReveal: (el: HTMLElement, t: string) => void } })
        .TranscriptView;
      tv._typewriterReveal(block, 'Re-revealed response text');
    });
    await page.waitForTimeout(1200);
    const count = await page.locator('#transcriptView .tv-block--assistant .tv-block-actions').count();
    expect(count).toBe(1);
  });
});

// ─── Tier 2: always-visible (not hover-gated) ────────────────────────────────

describe('Always visible — the actions row is not hover-gated (mobile reachability)', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page, sessionId } = await pageWithTranscript());
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('computed style with no hover is display:flex and fully opaque', async () => {
    const style = await page.evaluate(() => {
      const row = document.querySelector('#transcriptView .tv-block-actions') as HTMLElement;
      const cs = getComputedStyle(row);
      return { display: cs.display, opacity: parseFloat(cs.opacity), visibility: cs.visibility };
    });
    expect(style.display).toBe('flex');
    expect(style.visibility).toBe('visible');
    expect(style.opacity).toBe(1);
  });

  it('both buttons are visible without hovering the block', async () => {
    expect(await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first().isVisible()).toBe(true);
    expect(await page.locator('#transcriptView .tv-block-actions .tv-tts-btn').first().isVisible()).toBe(true);
  });
});

// ─── Tier 2: clipboard payload ───────────────────────────────────────────────

describe('Clipboard payload — copy writes the markdown source', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page, sessionId } = await pageWithTranscript({ grantClipboard: true }));
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('copy writes the raw markdown source, not the rendered block chrome', async () => {
    await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first().click();
    await page.waitForTimeout(300);
    const text = await page.evaluate(() => navigator.clipboard.readText());
    // Exact match: no "Claude" label, timestamp or code-copy button text
    // can have leaked in, and no rendered-HTML round-trip has mangled it.
    expect(text).toBe(ASSISTANT_MARKDOWN);
  });
});

// ─── Tier 2: insecure-context fallback ───────────────────────────────────────

/**
 * Simulates a plain-HTTP LAN/tailscale origin: the async clipboard API is
 * unavailable, so `_copyMarkdown` must fall through to `_execCopyText`. It
 * wraps its body in a try/catch that calls `_copyFailed()`, so "no page error"
 * proves nothing — assert the observable outcome instead: the .copied flash
 * and the absence (or, when forced to fail, presence) of a "Copy failed" toast.
 */
async function disableAsyncClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });
}

/** Replaces app.showToast with a recorder at window.__toasts. */
async function spyToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { app: { showToast: (m: string, k?: string) => void }; __toasts: string[][] };
    w.__toasts = [];
    w.app.showToast = (message: string, kind?: string) => {
      w.__toasts.push([message, kind ?? '']);
    };
  });
}

async function readToasts(page: Page): Promise<string[][]> {
  return page.evaluate(() => (window as unknown as { __toasts: string[][] }).__toasts);
}

const isCopied = (page: Page) =>
  page
    .locator('#transcriptView .tv-block-actions .tv-copy-btn')
    .first()
    .evaluate((b) => b.classList.contains('copied'));

describe('Insecure-context fallback — execCommand path copies and reports success', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page, sessionId } = await pageWithTranscript());
    await disableAsyncClipboard(page);
    await spyToasts(page);
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('copy falls back to _execCopyText: flashes .copied and raises no failure toast', async () => {
    await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first().click();
    await page.waitForTimeout(400);
    expect(await isCopied(page)).toBe(true);
    expect(await readToasts(page)).toEqual([]);
  });
});

describe('Insecure-context fallback — a failing execCommand surfaces the "Copy failed" toast', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page, sessionId } = await pageWithTranscript());
    await disableAsyncClipboard(page);
    await spyToasts(page);
    // Last resort gone too: execCommand('copy') reports failure.
    await page.evaluate(() => {
      document.execCommand = () => false;
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('copy toasts ["Copy failed", "error"] and does not flash .copied', async () => {
    await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first().click();
    await page.waitForTimeout(400);
    expect(await readToasts(page)).toEqual([['Copy failed', 'error']]);
    expect(await isCopied(page)).toBe(false);
  });
});

// ─── Tier 2: coarse-pointer (touch) sizing ───────────────────────────────────

describe('Coarse pointer — @media (pointer: coarse) gives roomy touch targets', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    // A device-emulated context makes Chromium report pointer: coarse, which the
    // hard-coded 1280x800 desktop context of the other suites never does.
    ({ context, page, sessionId } = await pageWithTranscript({ device: devices['iPhone 13'] }));
  }, 60_000);

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('the emulated context genuinely matches (pointer: coarse)', async () => {
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    expect(coarse).toBe(true);
  });

  it('both action buttons are at least 40px square', async () => {
    const sizes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#transcriptView .tv-block-actions .tv-action-btn')).map((b) => {
        const r = b.getBoundingClientRect();
        return [r.width, r.height];
      })
    );
    expect(sizes.length).toBe(2);
    for (const [w, h] of sizes) {
      expect(w).toBeGreaterThanOrEqual(40);
      expect(h).toBeGreaterThanOrEqual(40);
    }
  });
});

// ─── Tier 2: _flashCopied feedback cycle ─────────────────────────────────────

describe('_flashCopied — check-mark swap, .copied class, and restore', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page, sessionId } = await pageWithTranscript({ grantClipboard: true }));
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  /** 'check' when the button shows the check-mark polyline, else 'copy'. */
  const icon = (page: Page) =>
    page
      .locator('#transcriptView .tv-block-actions .tv-copy-btn')
      .first()
      .evaluate((b) => (b.querySelector('svg polyline') ? 'check' : b.querySelector('svg rect') ? 'copy' : 'none'));

  it('starts with the copy icon', async () => {
    expect(await icon(page)).toBe('copy');
  });

  it('clicking swaps to a check mark and adds .copied', async () => {
    await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first().click();
    await page.waitForTimeout(300);
    expect(await icon(page)).toBe('check');
    expect(await isCopied(page)).toBe(true);
  });

  it('reverts to the copy icon after ~2s', async () => {
    await page.waitForTimeout(2200);
    expect(await icon(page)).toBe('copy');
    expect(await isCopied(page)).toBe(false);
  });

  it('a rapid re-click clears the pending timer instead of reverting early', async () => {
    const btn = page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first();
    await btn.click();
    await page.waitForTimeout(1500);
    await btn.click();
    // The first click's 2s timer would have fired by now had it not been cleared.
    await page.waitForTimeout(900);
    expect(await icon(page)).toBe('check');
    await page.waitForTimeout(1500);
    expect(await icon(page)).toBe('copy');
  });
});

// ─── Tier 2: stopPropagation ─────────────────────────────────────────────────

describe('stopPropagation — action clicks do not reach the transcript block handlers', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page, sessionId } = await pageWithTranscript({ grantClipboard: true }));
    await page.evaluate(() => {
      const w = window as unknown as { __blockClicks: number };
      ((0, eval)('ReadAloud') as { start: () => boolean }).start = () => true;
      const block = document.querySelector('#transcriptView .tv-block--assistant') as HTMLElement;
      w.__blockClicks = 0;
      block.addEventListener('click', () => {
        w.__blockClicks++;
      });
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('clicking copy or play does not fire the block-level click handler', async () => {
    await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first().click();
    await page.locator('#transcriptView .tv-block-actions .tv-tts-btn').first().click();
    await page.waitForTimeout(300);
    const clicks = await page.evaluate(() => (window as unknown as { __blockClicks: number }).__blockClicks);
    expect(clicks).toBe(0);
  });

  it('clicking the block itself still fires the block-level click handler (control)', async () => {
    await page.locator('#transcriptView .tv-block--assistant .tv-content').first().click();
    await page.waitForTimeout(200);
    const clicks = await page.evaluate(() => (window as unknown as { __blockClicks: number }).__blockClicks);
    expect(clicks).toBeGreaterThan(0);
  });
});

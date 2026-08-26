/**
 * Transcript Copy-Response Controls — functional test suite
 *
 * Tests the per-response copy controls added to assistant transcript blocks:
 * a `.tv-block-actions` row holding a "Copy" (raw markdown) and a
 * "Copy rich text" (rendered text/html) button.
 *
 * Split into two tiers, following test/transcript-status-blocks.test.ts:
 *
 * Tier 1 — Static / CSS smoke tests (no transcript data required):
 *   • All CSS rules exist (.tv-block-actions, hover/focus-within, .tv-copy-btn,
 *     .tv-copy-btn:hover, .tv-copy-btn.copied)
 *   • TranscriptView._buildBlockActions / _richHtmlFor are callable functions
 *
 * Tier 2 — DOM / behaviour tests driving a mocked transcript:
 *   • Assistant blocks get the row (two buttons, correct labels), user blocks do not
 *   • The row is a direct child of the block and a sibling of .tv-content
 *   • The row is always visible (not hover-gated) — the mobile-reachability gotcha
 *   • _richHtmlFor strips .tv-code-copy, flattens .tv-code-line, absolutises
 *     img[src]/a[href], and never mutates the live DOM
 *   • Clipboard payloads: markdown copy writes block.text (no chrome leakage),
 *     rich-text copy writes both text/html and a text/plain markdown fallback
 *   • Insecure-context fallback (no navigator.clipboard / no ClipboardItem) still
 *     copies via execCommand — and toasts 'Copy failed' when execCommand fails too
 *   • Coarse-pointer (device-emulated) context: 44px touch targets, opacity 1
 *   • _flashCopied swaps to "✓ Copied" + .copied and restores each button's own label
 *   • Copy clicks call e.stopPropagation() so block-level handlers do not fire
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

describe('CSS smoke — copy-response rules are defined in the stylesheet', () => {
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
    '.tv-block--assistant:hover .tv-block-actions, .tv-block-actions:focus-within',
    '.tv-copy-btn',
    '.tv-copy-btn:hover',
    '.tv-copy-btn.copied',
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

describe('CSS smoke — TranscriptView copy helpers are callable functions', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  for (const name of ['_buildBlockActions', '_richHtmlFor', '_copyMarkdown', '_copyRichText', '_flashCopied']) {
    it(`TranscriptView.${name} is a function`, async () => {
      const isFunction = await page.evaluate((n) => {
        const tv = (window as unknown as { TranscriptView: Record<string, unknown> }).TranscriptView;
        return typeof tv[n] === 'function';
      }, name);
      expect(isFunction).toBe(true);
    });
  }
});

// ─── Tier 2: render placement ────────────────────────────────────────────────

describe('Render placement — .tv-block-actions on assistant blocks only', () => {
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

  it('the row holds exactly two .tv-copy-btn buttons', async () => {
    const count = await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').count();
    expect(count).toBe(2);
  });

  it('the buttons are labelled "Copy" and "Copy rich text"', async () => {
    const labels = await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').allTextContents();
    expect(labels).toEqual(['Copy', 'Copy rich text']);
  });

  it('the row is a direct child of .tv-block--assistant and a sibling of .tv-content (never inside it)', async () => {
    const shape = await page.evaluate(() => {
      const row = document.querySelector('#transcriptView .tv-block--assistant .tv-block-actions');
      const block = document.querySelector('#transcriptView .tv-block--assistant');
      return {
        directChild: row?.parentElement === block,
        insideContent: row?.closest('.tv-content') !== null,
        // The row must come *after* the rendered content, not before it.
        afterContent: (() => {
          const content = block?.querySelector(':scope > .tv-content');
          if (!content || !row) return false;
          return !!(content.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
        })(),
      };
    });
    expect(shape.directChild).toBe(true);
    expect(shape.insideContent).toBe(false);
    expect(shape.afterContent).toBe(true);
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

  it('computed style with no hover is display:flex and a non-zero opacity', async () => {
    const style = await page.evaluate(() => {
      const row = document.querySelector('#transcriptView .tv-block-actions') as HTMLElement;
      const cs = getComputedStyle(row);
      return { display: cs.display, opacity: parseFloat(cs.opacity), visibility: cs.visibility };
    });
    expect(style.display).toBe('flex');
    expect(style.visibility).toBe('visible');
    expect(style.opacity).toBeGreaterThan(0);
  });

  it('the copy buttons are visible without hovering the block', async () => {
    const visible = await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first().isVisible();
    expect(visible).toBe(true);
  });
});

// ─── Tier 2: _richHtmlFor payload builder ────────────────────────────────────

describe('_richHtmlFor — clipboard HTML is cleaned and the live DOM is untouched', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  /** Build a detached .tv-content node from raw HTML and run _richHtmlFor on it. */
  async function richHtml(inner: string): Promise<{ out: string; liveUnchanged: boolean }> {
    return page.evaluate((html) => {
      const el = document.createElement('div');
      el.className = 'tv-content tv-markdown';
      el.innerHTML = html;
      const before = el.innerHTML;
      const tv = (window as unknown as { TranscriptView: { _richHtmlFor: (n: HTMLElement) => string } }).TranscriptView;
      const out = tv._richHtmlFor(el);
      return { out, liveUnchanged: el.innerHTML === before };
    }, inner);
  }

  it('removes .tv-code-copy buttons from the copied HTML', async () => {
    const { out } = await richHtml(
      '<div class="tv-code-block"><button class="tv-code-copy">Copy</button><pre><code class="tv-code">const a = 1;</code></pre></div>'
    );
    expect(out).not.toContain('tv-code-copy');
    expect(out).toContain('const a = 1;');
  });

  it('flattens .tv-code-line spans back to newline-separated code', async () => {
    const { out } = await richHtml(
      '<pre><code class="tv-code"><span class="tv-code-line">const a = 1;</span><span class="tv-code-line">const b = 2;</span></code></pre>'
    );
    expect(out).not.toContain('tv-code-line');
    expect(out).toContain('const a = 1;\nconst b = 2;');
  });

  it('absolutises relative img[src] against location.origin', async () => {
    const { out } = await richHtml('<p><img src="/api/files/preview?path=%2Ftmp%2Fa.png"></p>');
    expect(out).toContain(`${BASE_URL}/api/files/preview?path=%2Ftmp%2Fa.png`);
  });

  it('absolutises relative a[href] against location.origin', async () => {
    const { out } = await richHtml('<p><a href="/docs/readme.md">readme</a></p>');
    expect(out).toContain(`${BASE_URL}/docs/readme.md`);
  });

  it('leaves absolute urls alone', async () => {
    const { out } = await richHtml('<p><a href="https://example.com/x">x</a></p>');
    expect(out).toContain('https://example.com/x');
  });

  it('does not mutate the live content node', async () => {
    const { liveUnchanged } = await richHtml(
      '<div class="tv-code-block"><button class="tv-code-copy">Copy</button><pre><code class="tv-code"><span class="tv-code-line">const a = 1;</span></code></pre></div>'
    );
    expect(liveUnchanged).toBe(true);
  });
});

// ─── Tier 2: clipboard payloads ──────────────────────────────────────────────

describe('Clipboard payloads — markdown source and rich text/html + text/plain', () => {
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

  it('"Copy" writes the raw markdown source, not the rendered block chrome', async () => {
    await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first().click();
    await page.waitForTimeout(300);
    const text = await page.evaluate(() => navigator.clipboard.readText());
    // Exact match: no "Claude" label, timestamp, TTS or code-copy button text
    // can have leaked in, and no rendered-HTML round-trip has mangled it.
    expect(text).toBe(ASSISTANT_MARKDOWN);
  });

  it('"Copy rich text" writes both text/html and a text/plain markdown fallback', async () => {
    await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').nth(1).click();
    await page.waitForTimeout(300);
    const payload = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items[0];
      const types = item.types.slice();
      const readType = async (t: string) => (types.includes(t) ? (await item.getType(t)).text() : null);
      return { types, html: await readType('text/html'), plain: await readType('text/plain') };
    });
    expect(payload.types).toContain('text/html');
    expect(payload.types).toContain('text/plain');
    expect(payload.html).toContain('<strong>Bold text</strong>');
    expect(payload.plain).toBe(ASSISTANT_MARKDOWN);
  });

  it('the copied text/html strips the per-code-block chrome from real renderMarkdown output', async () => {
    await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').nth(1).click();
    await page.waitForTimeout(300);
    const html = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      return (await items[0].getType('text/html')).text();
    });
    // Sanity: the live block really does carry the code-block chrome we strip,
    // so a renderMarkdown reshape would fail here rather than silently pass.
    const liveChrome = await page.evaluate(() => {
      const content = document.querySelector('#transcriptView .tv-block--assistant .tv-content');
      return {
        copyBtns: content?.querySelectorAll('.tv-code-copy').length ?? 0,
        codeLines: content?.querySelectorAll('.tv-code-line').length ?? 0,
      };
    });
    expect(liveChrome.copyBtns).toBeGreaterThan(0);
    expect(html).not.toContain('tv-code-copy');
    expect(html).not.toContain('tv-code-line');
    expect(html).toContain('const token = validate(req);');
  });
});

// ─── Tier 2: insecure-context fallback ───────────────────────────────────────

/**
 * Simulates a plain-HTTP LAN/tailscale origin: the async clipboard API is
 * unavailable, so `_copyMarkdown` / `_copyRichText` must fall through to
 * `_execCopyText` / `_execCopyHtml`. Both wrap their body in a try/catch that
 * calls `_copyFailed()`, so "no page error" proves nothing — these tests assert
 * the *observable* outcome instead: the ✓ Copied flash and the absence (or, in
 * the forced-failure case, the presence) of a "Copy failed" toast.
 */
async function disableAsyncClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    (window as unknown as { ClipboardItem?: unknown }).ClipboardItem = undefined;
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

  it('"Copy" falls back to _execCopyText: flashes ✓ Copied and raises no failure toast', async () => {
    const btn = page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first();
    await btn.click();
    await page.waitForTimeout(400);
    expect(await btn.textContent()).toBe('✓ Copied');
    expect(await readToasts(page)).toEqual([]);
  });

  it('"Copy rich text" falls back to _execCopyHtml: flashes ✓ Copied and raises no failure toast', async () => {
    const btn = page.locator('#transcriptView .tv-block-actions .tv-copy-btn').nth(1);
    await btn.click();
    await page.waitForTimeout(400);
    expect(await btn.textContent()).toBe('✓ Copied');
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

  it('"Copy" toasts ["Copy failed", "error"] and does not flash ✓ Copied', async () => {
    const btn = page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first();
    await btn.click();
    await page.waitForTimeout(400);
    expect(await readToasts(page)).toEqual([['Copy failed', 'error']]);
    expect(await btn.textContent()).toBe('Copy');
    expect(await btn.evaluate((b) => b.classList.contains('copied'))).toBe(false);
  });

  it('"Copy rich text" toasts ["Copy failed", "error"] and does not flash ✓ Copied', async () => {
    const btn = page.locator('#transcriptView .tv-block-actions .tv-copy-btn').nth(1);
    await page.evaluate(() => {
      (window as unknown as { __toasts: string[][] }).__toasts = [];
    });
    await btn.click();
    await page.waitForTimeout(400);
    expect(await readToasts(page)).toEqual([['Copy failed', 'error']]);
    expect(await btn.textContent()).toBe('Copy rich text');
  });
});

// ─── Tier 2: coarse-pointer (touch) sizing ───────────────────────────────────

describe('Coarse pointer — @media (pointer: coarse) gives 44px targets and full opacity', () => {
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

  it('copy buttons are at least 44px tall (touch target minimum)', async () => {
    const heights = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#transcriptView .tv-block-actions .tv-copy-btn')).map(
        (b) => b.getBoundingClientRect().height
      )
    );
    expect(heights.length).toBe(2);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
  });

  it('the actions row is forced to full opacity (no hover available to reveal it)', async () => {
    const opacity = await page.evaluate(() => {
      const row = document.querySelector('#transcriptView .tv-block-actions') as HTMLElement;
      return getComputedStyle(row).opacity;
    });
    expect(opacity).toBe('1');
  });
});

// ─── Tier 2: _flashCopied feedback cycle ─────────────────────────────────────

describe('_flashCopied — label swap, .copied class, and per-button label restore', () => {
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

  it('clicking a copy button swaps the label to "✓ Copied" and adds .copied', async () => {
    const btn = page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first();
    await btn.click();
    await page.waitForTimeout(300);
    expect(await btn.textContent()).toBe('✓ Copied');
    expect(await btn.evaluate((b) => b.classList.contains('copied'))).toBe(true);
  });

  it('each button reverts to its own original label after ~2s', async () => {
    const rt = page.locator('#transcriptView .tv-block-actions .tv-copy-btn').nth(1);
    await rt.click();
    await page.waitForTimeout(300);
    expect(await rt.textContent()).toBe('✓ Copied');
    await page.waitForTimeout(2200);
    const labels = await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').allTextContents();
    expect(labels).toEqual(['Copy', 'Copy rich text']);
    expect(await rt.evaluate((b) => b.classList.contains('copied'))).toBe(false);
  });

  it('a rapid re-click clears the pending timer instead of reverting early', async () => {
    const btn = page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first();
    await btn.click();
    await page.waitForTimeout(1500);
    await btn.click();
    // The first click's 2s timer would have fired by now had it not been cleared.
    await page.waitForTimeout(900);
    expect(await btn.textContent()).toBe('✓ Copied');
    await page.waitForTimeout(1500);
    expect(await btn.textContent()).toBe('Copy');
  });
});

// ─── Tier 2: stopPropagation ─────────────────────────────────────────────────

describe('stopPropagation — copy clicks do not reach the transcript block handlers', () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    ({ context, page, sessionId } = await pageWithTranscript({ grantClipboard: true }));
    await page.evaluate(() => {
      const block = document.querySelector('#transcriptView .tv-block--assistant') as HTMLElement;
      (window as unknown as { __blockClicks: number }).__blockClicks = 0;
      block.addEventListener('click', () => {
        (window as unknown as { __blockClicks: number }).__blockClicks++;
      });
    });
  });

  afterAll(async () => {
    await deleteSession(page, sessionId);
    await context?.close();
  });

  it('clicking either copy button does not fire the block-level click handler', async () => {
    await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').first().click();
    await page.locator('#transcriptView .tv-block-actions .tv-copy-btn').nth(1).click();
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

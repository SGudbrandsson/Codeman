/**
 * @fileoverview Playwright UI tests for the files-sheet HTML Preview tab.
 *
 * jsdom does not enforce the iframe `sandbox` attribute, so the security
 * semantics of the preview can only be tested honestly in a real browser.
 * This file covers what test/files-html-preview.test.ts cannot:
 *   - the sandbox attribute as the browser actually parses it
 *   - a <script> in the previewed document does NOT execute (no allow-scripts)
 *   - the frame cannot reach window.parent / document.cookie
 *   - the preview renders visibly and fills the sheet at a 390x844 viewport
 *   - the Preview ⇄ Edit tabs push zero history entries (tabs, not navigation)
 *
 * The sheet is driven directly (filesState seeded + _filesRenderView called) so
 * no tmux session or real file is needed.
 *
 * Port: 3251
 *
 * Run: vitest.config.ts only globs `test/` + `**` + `/*.test.ts`, so *.playwright.ts
 * files are opt-in. Run this one with a config whose `include` glob matches
 * `*.playwright.ts`:
 *   npx vitest run --config <that-config> test/files-html-preview.playwright.ts
 *
 * NODE VERSION: this file imports the server, which pulls in better-sqlite3, so
 * it only loads under the node the native module was built for. In this
 * worktree that is the SYSTEM node v22 (/usr/bin/node) — brew node v25 fails at
 * import with `NODE_MODULE_VERSION 127 vs 141`. That is the opposite of the
 * usual repo advice for the pure-JS suites, so check `node -v` first.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

// Top-level `const` in app.js: a global lexical binding inside the page.
declare const OverlayHistory: { _stack: unknown[] };

const PORT = 3251;
const BASE_URL = `http://localhost:${PORT}`;

// 390x844 = iPhone 12/13/14 logical viewport (the acceptance target).
const VIEWPORT = { width: 390, height: 844 };

const HOSTILE_HTML = [
  '<!doctype html><html><head><style>h1 { color: rgb(0, 128, 0); }</style></head>',
  '<body><h1>Preview Heading</h1><p>Body text</p>',
  '<script>window.parent.__pwned = 1; document.title = "executed";<\/script>',
  '</body></html>',
].join('');

let server: WebServer;
let browser: Browser;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 8000 });
  return { context, page };
}

/**
 * Opens the files sheet in file-view mode with a seeded "current" file, without
 * needing a session or a real file on disk. Mirrors what filesOpenFile() leaves
 * behind after a successful fetch, then calls the real _filesRenderView().
 */
async function previewFile(page: Page, path: string, content: string): Promise<void> {
  await page.evaluate(
    ({ path, content }) => {
      const app = (window as any).app;
      const sheet = document.getElementById('filesSheet');
      const backdrop = document.getElementById('filesSheetBackdrop');
      if (sheet) {
        sheet.style.display = 'flex';
        sheet.classList.add('open');
      }
      if (backdrop) {
        backdrop.style.display = 'block';
        backdrop.classList.add('open');
      }
      app.filesState = { showHidden: true, expanded: new Set(), current: null, data: null, pendingContent: null };
      app._filesShowView();
      app.filesState.current = {
        path,
        mtime: Date.now(),
        content,
        dirty: false,
        editing: false,
        truncated: false,
        size: content.length,
      };
      app._filesRenderView();
    },
    { path, content }
  );
  await page.waitForSelector('#filesSheetViewContent', { state: 'attached', timeout: 4000 });
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

describe('Files sheet — HTML preview @390x844 — Playwright', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    // Load the CodeMirror/markdown vendor bundle the way openFilesSheet does,
    // so the Edit tab exercises the real editor rather than the fallback.
    await page.evaluate(() => (window as any).app._filesEnsureVendor());
    await page.waitForFunction(() => !!(window as any).CodemanEditor, { timeout: 8000 });
    await previewFile(page, 'docs/page.html', HOSTILE_HTML);
  }, 30_000);

  afterAll(async () => {
    await context?.close();
  });

  it('renders the document in a sandboxed frame with the Preview/Edit/Copy tabs', async () => {
    await page.waitForSelector('#filesSheetViewContent iframe.files-html-frame', { timeout: 4000 });
    const labels = await page.$$eval('#filesSheetViewActions button', (els) => els.map((e) => e.textContent));
    expect(labels).toEqual(['Preview', 'Edit', 'Copy']);
  });

  it('keeps the sandbox fully restrictive (no allow-same-origin, no allow-scripts)', async () => {
    const attrs = await page.$eval('#filesSheetViewContent iframe.files-html-frame', (el) => ({
      sandbox: el.getAttribute('sandbox'),
      tokens: (el as HTMLIFrameElement).sandbox.length,
      referrerpolicy: el.getAttribute('referrerpolicy'),
    }));
    expect(attrs.sandbox).toBe('');
    expect(attrs.tokens).toBe(0); // no allow-* token of any kind
    expect(attrs.referrerpolicy).toBe('no-referrer');
  });

  it('does not execute scripts inside the previewed document', async () => {
    // Give the frame document a beat to load and (not) run its script.
    await page.waitForTimeout(500);
    const pwned = await page.evaluate(() => (window as any).__pwned);
    expect(pwned).toBeUndefined();

    const frame = page.frames().find((f) => f.url() === 'about:srcdoc');
    expect(frame, 'srcdoc frame not found').toBeTruthy();
    const title = await frame!.title();
    expect(title).not.toBe('executed');
  });

  it('renders the document visibly inside the frame', async () => {
    const frame = page.frames().find((f) => f.url() === 'about:srcdoc')!;
    const heading = frame.locator('h1');
    await expect.poll(() => heading.textContent(), { timeout: 4000 }).toBe('Preview Heading');
    await expect.poll(() => heading.isVisible()).toBe(true);
    // Inline <style> from the document still applies inside the frame.
    const color = await heading.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe('rgb(0, 128, 0)');
  });

  it('gives the frame real height inside the sheet without overflowing the page', async () => {
    const box = await page.$eval('#filesSheetViewContent iframe.files-html-frame', (el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    expect(box.height).toBeGreaterThan(100);
    expect(box.width).toBeGreaterThan(200);
    expect(box.width).toBeLessThanOrEqual(VIEWPORT.width);

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflows).toBe(false);
  });

  it('switches to CodeMirror on the Edit tab and back to the frame on Preview', async () => {
    await page.click('#filesSheetViewActions button:has-text("Edit")');
    await page.waitForSelector('#filesSheetViewContent .files-cm-host', { timeout: 4000 });
    expect(await page.$('#filesSheetViewContent iframe.files-html-frame')).toBeNull();
    expect(await page.$eval('#filesSheetViewContent', (el) => el.classList.contains('is-frame'))).toBe(false);

    await page.click('#filesSheetViewActions button:has-text("Cancel")');
    await page.waitForSelector('#filesSheetViewContent iframe.files-html-frame', { timeout: 4000 });
    expect(await page.$eval('#filesSheetViewContent', (el) => el.classList.contains('is-frame'))).toBe(true);
  });

  it('pushes no history entries when toggling Preview ⇄ Edit (tabs, not navigation)', async () => {
    const before = await page.evaluate(() => ({
      len: history.length,
      // OverlayHistory is a top-level `const` in app.js — a global lexical
      // binding, reachable by name but not as a window property.
      stack: (OverlayHistory as any)._stack.length,
    }));

    await page.click('#filesSheetViewActions button:has-text("Edit")');
    await page.waitForSelector('#filesSheetViewContent .files-cm-host', { timeout: 4000 });
    await page.click('#filesSheetViewActions button:has-text("Cancel")');
    await page.waitForSelector('#filesSheetViewContent iframe.files-html-frame', { timeout: 4000 });
    await page.click('#filesSheetViewActions button:has-text("Preview")');
    await page.waitForSelector('#filesSheetViewContent iframe.files-html-frame', { timeout: 4000 });

    const after = await page.evaluate(() => ({
      len: history.length,
      // OverlayHistory is a top-level `const` in app.js — a global lexical
      // binding, reachable by name but not as a window property.
      stack: (OverlayHistory as any)._stack.length,
    }));
    // NB: this flow seeds filesState directly instead of calling filesOpenFile,
    // so the OverlayHistory baseline is an EMPTY stack (0 → 0). That still
    // catches the failure this test exists for — a tab pushing an entry would
    // move it 0 → 1 — but do not read it as "the files-file entry survived".
    expect(before.stack).toBe(0);
    expect(after).toEqual(before);
  });

  it('does not stack up frames when Preview is clicked while already previewing', async () => {
    // The Preview button re-enters _filesRenderView() on an already-framed
    // view; `content.innerHTML = ''` is what keeps this at one frame.
    await page.click('#filesSheetViewActions button:has-text("Preview")');
    await page.waitForSelector('#filesSheetViewContent iframe.files-html-frame', { timeout: 4000 });
    await page.click('#filesSheetViewActions button:has-text("Preview")');
    await page.waitForSelector('#filesSheetViewContent iframe.files-html-frame', { timeout: 4000 });

    const counts = await page.evaluate(() => {
      const el = document.getElementById('filesSheetViewContent')!;
      return {
        frames: el.querySelectorAll('iframe.files-html-frame').length,
        wrappers: el.querySelectorAll('.files-html-preview').length,
      };
    });
    expect(counts).toEqual({ frames: 1, wrappers: 1 });
  });
});

describe('Files sheet — markdown preview non-regression @390x844 — Playwright', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    // Load the vendor bundle so CodemanMarkdown is available, as openFilesSheet does.
    await page.evaluate(() => (window as any).app._filesEnsureVendor());
    await page.waitForFunction(() => !!(window as any).CodemanMarkdown, { timeout: 8000 });
    await previewFile(page, 'docs/notes.md', '# Markdown Heading\n\nBody text\n');
  }, 30_000);

  afterAll(async () => {
    await context?.close();
  });

  it('still renders markdown inline with no frame and no is-frame class', async () => {
    await page.waitForSelector('#filesSheetViewContent .files-md-preview h1', { timeout: 4000 });
    expect(await page.textContent('#filesSheetViewContent .files-md-preview h1')).toBe('Markdown Heading');
    expect(await page.$('#filesSheetViewContent iframe')).toBeNull();
    expect(await page.$eval('#filesSheetViewContent', (el) => el.classList.contains('is-frame'))).toBe(false);
    expect(await page.textContent('#filesSheetViewMeta')).not.toContain('local assets');
  });
});

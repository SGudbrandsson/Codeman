// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for the files-sheet HTML Preview tab (sandboxed iframe).
 *
 * The render logic lives in src/web/public/app.js (a browser bundle with no
 * exports), so the relevant method bodies are replicated here and run against a
 * jsdom DOM that mirrors #filesSheetView from index.html.
 *
 * Keep this replica in sync with _filesRenderView() / filesStartEdit() /
 * _filesRenderBinary() / filesOpenFile() in app.js (around line 19833).
 *
 * NOTE: jsdom does NOT enforce the iframe `sandbox` attribute, so script
 * non-execution is deliberately NOT asserted here — that lives in
 * test/files-html-preview.playwright.ts. What is asserted here is the shape of
 * the contract (attributes, srcdoc-as-property, branch matrix, class lifecycle)
 * plus source-text guards that read the real app.js so the replica can never
 * drift away from a loosened security contract.
 *
 * Run: npx vitest run test/files-html-preview.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
// The jsdom environment has no node:fs, so the shipped app.js is pulled in as
// text via Vite's ?raw loader for the source-text guards at the bottom.
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

// ─── escapeHtml replica (constants.js:421) ──────────────────────────────────

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ─── App replica ────────────────────────────────────────────────────────────

interface CurrentFile {
  path: string;
  content: string;
  size?: number;
  truncated?: boolean;
  totalLines?: number;
  dirty?: boolean;
  editing?: boolean;
}

/**
 * Reproduces the files-sheet render methods from app.js verbatim.
 * Returns a fresh instance per test to avoid cross-test leakage.
 */
function makeApp() {
  const app = {
    filesState: { current: null as CurrentFile | null, pendingContent: null as string | null, editor: null as any },

    $(id: string) {
      return document.getElementById(id) as HTMLElement;
    },

    formatFileSize(bytes?: number) {
      if (bytes === undefined || bytes === null) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    },

    getFileIcon(_ext: string) {
      return '';
    },

    _filesDestroyEditor() {
      if (this.filesState && this.filesState.editor) {
        try {
          this.filesState.editor.destroy();
        } catch (e) {
          /* ignore */
        }
        this.filesState.editor = null;
      }
    },

    // Mirrors the DOM-clearing prelude of filesOpenFile() (app.js:19746).
    filesOpenFileLoadingState() {
      const content = this.$('filesSheetViewContent');
      content.classList.remove('is-frame');
      content.innerHTML = '<div class="files-sheet-empty">Loading…</div>';
      this.$('filesSheetViewMeta').textContent = '';
      this.$('filesSheetViewActions').innerHTML = '';
    },

    _filesRenderBinary(data: { type: string; path: string; size?: number; extension?: string; url?: string }) {
      const content = this.$('filesSheetViewContent');
      const meta = this.$('filesSheetViewMeta');
      const actions = this.$('filesSheetViewActions');
      if (!content) return;
      this._filesDestroyEditor();
      if (this.filesState) {
        this.filesState.current = null;
        this.filesState.pendingContent = null;
      }
      content.classList.remove('is-frame');
      const ext = data.extension || (data.path ? data.path.split('.').pop() : '');
      const name = (data.path || '').split('/').pop();
      const rawUrl = data.url || `/api/sessions/x/file-raw?path=${encodeURIComponent(data.path)}`;
      meta.textContent = `${this.formatFileSize(data.size)}${ext ? ' • ' + ext : ''}`;
      actions.innerHTML = `<a class="files-sheet-tool" href="${escapeHtml(rawUrl)}" download="${escapeHtml(name!)}">Download</a>`;
      if (data.type === 'image') {
        content.innerHTML = `<div class="files-img-wrap"><img class="files-img" src="${escapeHtml(rawUrl)}" alt="${escapeHtml(name!)}"></div>`;
      } else {
        content.innerHTML = `<div class="files-binary-card"><div class="files-binary-name">${escapeHtml(name!)}</div></div>`;
      }
    },

    _filesRenderView() {
      const cur = this.filesState && this.filesState.current;
      if (!cur) return;
      this._filesDestroyEditor();
      const content = this.$('filesSheetViewContent');
      const meta = this.$('filesSheetViewMeta');
      const actions = this.$('filesSheetViewActions');
      const trunc = cur.truncated ? ` • showing first 10000/${cur.totalLines} lines` : '';
      const isMd = /\.(md|markdown)$/i.test(cur.path);
      const isHtml = /\.html?$/i.test(cur.path);
      const htmlPreview = isHtml && !cur.truncated;
      meta.textContent = `${this.formatFileSize(cur.size)}${trunc}${htmlPreview ? ' • preview: local assets not loaded' : ''}`;
      let noticeHtml = '';
      if (cur.truncated) {
        noticeHtml = `<div class="files-sheet-notice">File is truncated; editing is disabled to avoid data loss.</div>`;
      }
      content.classList.toggle('is-frame', htmlPreview);
      let rendered: string | null = null;
      if (!htmlPreview && isMd && (window as any).CodemanMarkdown) {
        try {
          rendered = (window as any).CodemanMarkdown.render(cur.content);
        } catch (e) {
          rendered = null;
        }
      }
      if (htmlPreview) {
        content.innerHTML = '';
        if (noticeHtml) {
          const n = document.createElement('div');
          n.innerHTML = noticeHtml;
          if (n.firstElementChild) content.appendChild(n.firstElementChild);
        }
        const wrap = document.createElement('div');
        wrap.className = 'files-html-preview';
        const frame = document.createElement('iframe');
        frame.className = 'files-html-frame';
        frame.setAttribute('sandbox', ''); // must be set BEFORE srcdoc
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('title', 'HTML preview');
        frame.srcdoc = cur.content;
        wrap.appendChild(frame);
        content.appendChild(wrap);
      } else if (rendered != null) {
        content.innerHTML = noticeHtml + `<div class="files-md-preview">${rendered}</div>`;
      } else {
        content.innerHTML = noticeHtml + `<pre><code>${escapeHtml(cur.content)}</code></pre>`;
      }
      if ((isMd || isHtml) && !cur.truncated) {
        actions.innerHTML = `<button class="files-sheet-tool is-active" onclick="app._filesRenderView()">Preview</button><button class="files-sheet-tool" onclick="app.filesStartEdit()">Edit</button><button class="files-sheet-tool" onclick="app.filesCopyCurrent()">Copy</button>`;
      } else {
        const editBtn = cur.truncated
          ? ''
          : `<button class="files-sheet-tool" onclick="app.filesStartEdit()">Edit</button>`;
        actions.innerHTML = `<button class="files-sheet-tool" onclick="app.filesCopyCurrent()">Copy</button>${editBtn}`;
      }
    },

    filesStartEdit() {
      const cur = this.filesState && this.filesState.current;
      if (!cur) return;
      if (cur.truncated) return;
      cur.editing = true;
      const content = this.$('filesSheetViewContent');
      const actions = this.$('filesSheetViewActions');
      this._filesDestroyEditor();
      content.classList.remove('is-frame');
      // CodemanEditor is never present in jsdom → textarea fallback path.
      content.innerHTML = `<textarea class="files-sheet-editor" id="filesSheetEditor" spellcheck="false" wrap="off"></textarea>`;
      const ta = this.$('filesSheetEditor') as HTMLTextAreaElement;
      ta.value = cur.content;
      this.filesState.editor = {
        getValue: () => ta.value,
        setValue: (v: string) => {
          ta.value = v;
        },
        focus: () => {},
        destroy: () => {},
      };
      actions.innerHTML = `<button class="files-sheet-tool" onclick="app.filesCancelEdit()">Cancel</button><button class="files-sheet-tool" onclick="app.filesSave()">Save</button>`;
    },
  };
  return app;
}

// ─── Fixture helpers ────────────────────────────────────────────────────────

function mountSheet() {
  document.body.innerHTML = `
    <div id="filesSheetView">
      <div class="files-sheet-view-toolbar">
        <div id="filesSheetViewMeta"></div>
        <div id="filesSheetViewActions"></div>
      </div>
      <div class="files-sheet-view-content" id="filesSheetViewContent"></div>
    </div>`;
}

function open(app: ReturnType<typeof makeApp>, file: Partial<CurrentFile> & { path: string }) {
  app.filesState.current = { content: '', size: 100, truncated: false, ...file };
  app._filesRenderView();
}

const content = () => document.getElementById('filesSheetViewContent')!;
const actions = () => document.getElementById('filesSheetViewActions')!;
const meta = () => document.getElementById('filesSheetViewMeta')!;
const frame = () => content().querySelector('iframe.files-html-frame') as HTMLIFrameElement | null;
const buttonLabels = () => Array.from(actions().querySelectorAll('button')).map((b) => b.textContent);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('files sheet — HTML preview', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    mountSheet();
    delete (window as any).CodemanMarkdown;
    app = makeApp();
  });

  // ── Gap 1a: sandbox security contract (DOM) ───────────────────────────────

  describe('sandbox contract', () => {
    beforeEach(() => open(app, { path: 'docs/page.html', content: '<h1>Hi</h1>' }));

    it('renders the document in an iframe, not in the app DOM', () => {
      expect(frame()).not.toBeNull();
      expect(content().querySelector('h1')).toBeNull();
    });

    it('sets sandbox to the empty value (all restrictions on)', () => {
      expect(frame()!.getAttribute('sandbox')).toBe('');
    });

    it('never grants allow-same-origin', () => {
      expect(frame()!.getAttribute('sandbox')).not.toContain('allow-same-origin');
    });

    it('never grants allow-scripts', () => {
      expect(frame()!.getAttribute('sandbox')).not.toContain('allow-scripts');
    });

    it('sets referrerpolicy=no-referrer and an accessible title', () => {
      expect(frame()!.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(frame()!.getAttribute('title')).toBe('HTML preview');
    });
  });

  // ── Re-render idempotency ────────────────────────────────────────────────
  //
  // The Preview tab button calls app._filesRenderView() on a view that is
  // ALREADY a frame, so the `content.innerHTML = ''` reset at the top of the
  // HTML branch is load-bearing: without it every Preview click would append a
  // second frame. This is the one code path the button actually re-enters.

  describe('re-render (Preview tab clicked while already previewing)', () => {
    it('leaves exactly one frame and one wrapper after a second render', () => {
      open(app, { path: 'docs/page.html', content: '<h1>Hi</h1>' });
      app._filesRenderView(); // what clicking "Preview" does

      expect(content().querySelectorAll('iframe.files-html-frame')).toHaveLength(1);
      expect(content().querySelectorAll('.files-html-preview')).toHaveLength(1);
      expect(content().children).toHaveLength(1);
    });

    it('still holds one frame after several re-renders, with fresh srcdoc', () => {
      open(app, { path: 'docs/page.html', content: '<h1>one</h1>' });
      app._filesRenderView();
      app.filesState.current!.content = '<h1>two</h1>';
      app._filesRenderView();

      expect(content().querySelectorAll('iframe.files-html-frame')).toHaveLength(1);
      expect(frame()!.srcdoc).toBe('<h1>two</h1>');
      expect(content().classList.contains('is-frame')).toBe(true);
    });

    it('replaces the frame when re-rendering after the Edit tab', () => {
      open(app, { path: 'docs/page.html', content: '<h1>Hi</h1>' });
      app.filesStartEdit();
      app._filesRenderView();

      expect(content().querySelectorAll('iframe.files-html-frame')).toHaveLength(1);
      expect(content().querySelector('#filesSheetEditor')).toBeNull();
    });
  });

  // ── Gap 2: srcdoc assigned as a property ──────────────────────────────────

  describe('srcdoc assignment', () => {
    it('carries hostile content verbatim without escaping or DOM leakage', () => {
      const hostile = `<h1 class="x">a " b</h1><\/iframe><img src=x onerror="1">`;
      open(app, { path: 'evil.html', content: hostile });

      expect(frame()!.srcdoc).toBe(hostile);
      expect(content().querySelector('h1')).toBeNull();
      expect(content().querySelector('img')).toBeNull();
      // The wrapper holds exactly one child: the frame.
      expect(content().querySelector('.files-html-preview')!.children).toHaveLength(1);
    });
  });

  // ── Gap 4: file-type dispatch branch matrix ───────────────────────────────

  describe('file-type dispatch', () => {
    it.each(['page.html', 'page.htm', 'PAGE.HTML', 'a/b/index.Htm'])('previews %s in a frame', (path) => {
      open(app, { path, content: '<h1>x</h1>' });
      expect(frame()).not.toBeNull();
      expect(content().classList.contains('is-frame')).toBe(true);
    });

    // Non-HTML, non-markdown paths: source view, never a frame. (`notes.md` is
    // deliberately NOT in this list — with CodemanMarkdown absent it would hit
    // the vendor-missing `<pre>` fallback rather than the real markdown path,
    // which would make the `pre code` assertion mean something else. Markdown
    // is covered by the "markdown preview (non-regression)" suite below.)
    it.each(['page.xhtml', 'page.htmlx', 'readme.txt', 'template.html.erb'])('does not preview %s', (path) => {
      open(app, { path, content: '<h1>x</h1>' });
      expect(frame()).toBeNull();
      expect(content().classList.contains('is-frame')).toBe(false);
      expect(content().querySelector('pre code')).not.toBeNull();
    });

    it('does not frame a markdown file', () => {
      open(app, { path: 'notes.md', content: '# x' });
      expect(frame()).toBeNull();
      expect(content().classList.contains('is-frame')).toBe(false);
    });

    it('previews an empty .html file as an empty frame rather than a source view', () => {
      open(app, { path: 'blank.html', content: '' });

      expect(frame()).not.toBeNull();
      expect(frame()!.srcdoc).toBe('');
      expect(content().classList.contains('is-frame')).toBe(true);
      expect(content().querySelector('pre code')).toBeNull();
    });

    it('falls through to escaped source for a truncated .html file', () => {
      open(app, { path: 'big.html', content: '<h1>x</h1>', truncated: true, totalLines: 50000 });

      expect(frame()).toBeNull();
      expect(content().classList.contains('is-frame')).toBe(false);
      expect(content().querySelector('.files-sheet-notice')).not.toBeNull();
      expect(content().querySelector('pre code')!.textContent).toBe('<h1>x</h1>');
    });
  });

  // ── Gap 5: tab wiring condition ───────────────────────────────────────────

  describe('toolbar tabs', () => {
    it('offers Preview / Edit / Copy for an HTML file', () => {
      open(app, { path: 'page.html', content: '<h1>x</h1>' });
      expect(buttonLabels()).toEqual(['Preview', 'Edit', 'Copy']);
      expect(actions().querySelector('.is-active')!.textContent).toBe('Preview');
    });

    it('still offers Preview / Edit / Copy for a markdown file (non-regression)', () => {
      open(app, { path: 'notes.md', content: '# x' });
      expect(buttonLabels()).toEqual(['Preview', 'Edit', 'Copy']);
    });

    it('offers only Copy / Edit for a plain text file', () => {
      open(app, { path: 'readme.txt', content: 'x' });
      expect(buttonLabels()).toEqual(['Copy', 'Edit']);
    });

    it('offers only Copy for a truncated HTML file', () => {
      open(app, { path: 'big.html', content: 'x', truncated: true, totalLines: 50000 });
      expect(buttonLabels()).toEqual(['Copy']);
    });
  });

  // ── Gap 6: is-frame class lifecycle ───────────────────────────────────────

  describe('is-frame lifecycle', () => {
    beforeEach(() => open(app, { path: 'page.html', content: '<h1>x</h1>' }));

    it('is removed when switching to the Edit tab', () => {
      app.filesStartEdit();
      expect(content().classList.contains('is-frame')).toBe(false);
      expect(content().querySelector('#filesSheetEditor')).not.toBeNull();
    });

    it('is removed when a markdown file is rendered next', () => {
      open(app, { path: 'notes.md', content: '# x' });
      expect(content().classList.contains('is-frame')).toBe(false);
    });

    it('is removed when a binary file is rendered next', () => {
      app._filesRenderBinary({ type: 'image', path: 'a/logo.png', size: 10, extension: 'png' });
      expect(content().classList.contains('is-frame')).toBe(false);
    });

    it("is removed by the next file's loading state", () => {
      app.filesOpenFileLoadingState();
      expect(content().classList.contains('is-frame')).toBe(false);
    });
  });

  // ── Gap 7: meta line ──────────────────────────────────────────────────────

  describe('meta line', () => {
    it('appends the local-assets hint for an HTML preview', () => {
      open(app, { path: 'page.html', content: '<h1>x</h1>', size: 2048 });
      expect(meta().textContent).toBe('2.0 KB • preview: local assets not loaded');
    });

    it.each([
      ['notes.md', '2.0 KB'],
      ['readme.txt', '2.0 KB'],
    ])('leaves the %s meta line unchanged', (path, expected) => {
      open(app, { path, content: 'x', size: 2048 });
      expect(meta().textContent).toBe(expected);
    });

    it('shows only the truncation notice for a truncated HTML file', () => {
      open(app, { path: 'big.html', content: 'x', size: 2048, truncated: true, totalLines: 40000 });
      expect(meta().textContent).toBe('2.0 KB • showing first 10000/40000 lines');
    });
  });

  // ── Gap 8: markdown preview non-regression ────────────────────────────────

  describe('markdown preview (non-regression)', () => {
    beforeEach(() => {
      (window as any).CodemanMarkdown = { render: (src: string) => `<h1>${src.replace(/^# /, '')}</h1>` };
    });

    it('renders .md through CodemanMarkdown, with no frame and no is-frame class', () => {
      open(app, { path: 'notes.md', content: '# Title' });

      const md = content().querySelector('.files-md-preview');
      expect(md).not.toBeNull();
      expect(md!.querySelector('h1')!.textContent).toBe('Title');
      expect(frame()).toBeNull();
      expect(content().classList.contains('is-frame')).toBe(false);
    });

    it('does not route .html through the markdown renderer', () => {
      open(app, { path: 'page.html', content: '# Title' });

      expect(content().querySelector('.files-md-preview')).toBeNull();
      expect(frame()!.srcdoc).toBe('# Title');
    });
  });
});

// ─── Source-text guards against the real app.js ─────────────────────────────
//
// The replica above tests a copy. These read the shipped file so a future edit
// that loosens the sandbox or adds history pushes fails here.

describe('src/web/public/app.js — source guards', () => {
  const source = APP_JS_SOURCE;

  function methodBody(name: string): string {
    let start = source.indexOf(`\n  ${name}(`);
    if (start === -1) start = source.indexOf(`\n  async ${name}(`);
    expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
    const end = source.indexOf('\n  }\n', start);
    return source.slice(start, end);
  }

  // ── Gap 1b: security contract in the shipped code ─────────────────────────

  it('never mentions allow-same-origin outside the do-not-add comments', () => {
    const code = source
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('allow-same-origin');
  });

  it('never grants allow-scripts to a sandboxed frame', () => {
    const code = source
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('allow-scripts');
  });

  it("sets sandbox to '' and does so before assigning srcdoc", () => {
    const body = methodBody('_filesRenderView');
    const sandboxAt = body.indexOf(`setAttribute('sandbox', '')`);
    const srcdocAt = body.indexOf('.srcdoc =');
    expect(sandboxAt).toBeGreaterThan(-1);
    expect(srcdocAt).toBeGreaterThan(-1);
    expect(sandboxAt).toBeLessThan(srcdocAt);
  });

  it('assigns srcdoc as a property rather than interpolating it into HTML', () => {
    const body = methodBody('_filesRenderView');
    expect(body).toContain('frame.srcdoc = cur.content');
    expect(body).not.toMatch(/srcdoc\s*=\s*["'`]/);
  });

  it('clears the view before building the frame, so re-rendering cannot stack frames', () => {
    // The Preview tab re-enters _filesRenderView() on an already-framed view;
    // dropping this reset would append a second frame on every click. The jsdom
    // re-render suite above proves the behaviour, this pins it in app.js.
    const body = methodBody('_filesRenderView');
    const resetAt = body.indexOf("content.innerHTML = '';");
    const frameAt = body.indexOf(`createElement('iframe')`);
    expect(resetAt).toBeGreaterThan(-1);
    expect(frameAt).toBeGreaterThan(-1);
    expect(resetAt).toBeLessThan(frameAt);
  });

  // ── Gaps 4/5/7: the feature's behavioural constants, in the shipped code ───
  //
  // The branch matrix, the tab condition and the meta hint are otherwise
  // asserted only against the replica above (and against the opt-in
  // *.playwright.ts file, which vitest.config.ts's `test/**/*.test.ts` include
  // glob excludes from the default run). These pin the real app.js text so a
  // mutation there cannot ship green.

  it('matches .htm as well as .html (gap 4)', () => {
    const body = methodBody('_filesRenderView');
    expect(body).toContain(String.raw`const isHtml = /\.html?$/i.test(cur.path)`);
  });

  it('never previews a truncated HTML document (gap 4)', () => {
    const body = methodBody('_filesRenderView');
    expect(body).toContain('const htmlPreview = isHtml && !cur.truncated');
  });

  it('offers the Preview/Edit tab pair to HTML files, not just markdown (gap 5)', () => {
    const body = methodBody('_filesRenderView');
    expect(body).toContain('if ((isMd || isHtml) && !cur.truncated) {');
  });

  it('surfaces the local-assets limitation in the meta line (gap 7)', () => {
    const body = methodBody('_filesRenderView');
    expect(body).toContain("${htmlPreview ? ' • preview: local assets not loaded' : ''}");
  });

  // ── Gap 9: tabs push no OverlayHistory entries ────────────────────────────

  it('does not touch OverlayHistory in _filesRenderView or filesStartEdit', () => {
    expect(methodBody('_filesRenderView')).not.toContain('OverlayHistory');
    expect(methodBody('filesStartEdit')).not.toContain('OverlayHistory');
  });

  it('pushes files-file only from filesOpenFile and the dirty-cancel re-push', () => {
    // Opening a file is the only place that creates the entry; the second site
    // is _filesBackFromHistory re-pushing the entry the browser already popped
    // when the user cancels a discard-changes confirm. Tabs add no third site.
    const pushes = source.match(/OverlayHistory\.push\('files-file'/g) || [];
    expect(pushes).toHaveLength(2);
    expect(methodBody('filesOpenFile')).toContain(`OverlayHistory.push('files-file'`);
    expect(methodBody('_filesBackFromHistory')).toContain(`OverlayHistory.push('files-file'`);
  });

  // ── Gap 6 (source side): every content-overwriting path clears is-frame ────

  it('clears is-frame in filesOpenFile, _filesRenderBinary and filesStartEdit', () => {
    for (const name of ['filesOpenFile', '_filesRenderBinary', 'filesStartEdit']) {
      expect(methodBody(name), `${name}() must clear is-frame`).toContain(`classList.remove('is-frame')`);
    }
    expect(methodBody('_filesRenderView')).toContain(`classList.toggle('is-frame'`);
  });
});

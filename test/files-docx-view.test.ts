// @vitest-environment jsdom

/**
 * @fileoverview Files-sheet read-only .docx preview in src/web/public/app.js
 * (_filesRenderDocx, _filesEnsureDocx, _filesSanitizeDocxLinks).
 *
 * As in test/files-grid-view.test.ts, the REAL method bodies are extracted from
 * the shipped app.js text and re-compiled into a plain object, then run against
 * a jsdom DOM that mirrors #filesSheetView from index.html.
 *
 * Only collaborators are stubbed:
 * - window.CodemanDocx, the lazy vendor/docx.min.js bundle (docx-preview +
 *   JSZip). docx-preview never settles in jsdom, so a fake records render calls
 *   and injects HTML into the container.
 * - fetch, OverlayHistory, FilesTTS and the markdown notes UI.
 *
 * jsdom never loads <script src>, so the "bundle unavailable" case fires the
 * appended script's error event by hand — exercising the real
 * _filesEnsureDocx() failure path.
 *
 * Run: npx vitest run test/files-docx-view.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

// ─── Real-source extraction ─────────────────────────────────────────────────

function methodSource(name: string): string {
  let start = APP_JS_SOURCE.indexOf(`\n  ${name}(`);
  if (start === -1) start = APP_JS_SOURCE.indexOf(`\n  async ${name}(`);
  expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
  const lines = APP_JS_SOURCE.slice(start + 1).split('\n');
  if (lines[0].trimEnd().endsWith('}')) return lines[0];
  const end = lines.findIndex((l, i) => i > 0 && l === '  }');
  expect(end, `${name}() has no 2-space closing brace`).toBeGreaterThan(0);
  return lines.slice(0, end + 1).join('\n');
}

const METHODS = [
  'formatFileSize',
  'filesOpenFile',
  '_filesEnsureDocx',
  '_filesDestroyEditor',
  '_filesGridSetMaximised',
  '_filesRenderBinary',
  '_filesDownloadHtml',
  '_filesRenderDocx',
  '_filesSanitizeDocxLinks',
];

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface RenderCall {
  data: ArrayBuffer;
  container: HTMLElement;
  opts: Record<string, unknown>;
}

function installDocx(impl?: (container: HTMLElement) => void | Promise<void>) {
  const calls: RenderCall[] = [];
  const docx = {
    render: vi.fn(async (data: ArrayBuffer, container: HTMLElement, opts: Record<string, unknown>) => {
      calls.push({ data, container, opts });
      if (impl) await impl(container);
      else container.innerHTML = '<section class="docx"><p>Hello docx</p></section>';
    }),
    calls,
  };
  (window as any).CodemanDocx = docx;
  return docx;
}

interface FetchCall {
  url: string;
  init?: { cache?: string };
}
type Responder = (call: FetchCall) => { status?: number; json?: unknown; bytes?: ArrayBuffer } | Promise<any>;

let fetchCalls: FetchCall[] = [];
let responder: Responder = () => ({ json: {} });

function makeApp() {
  const body = METHODS.map(methodSource).join(',\n');
  const factory = new Function('escapeHtml', 'FilesTTS', 'OverlayHistory', `return ({\n${body}\n});`);
  const history = { push() {}, pop() {}, has: () => false };
  const methods = factory(escapeHtml, { stop() {} }, history);
  return Object.assign(methods, {
    activeSessionId: 'sess-a',
    filesState: { current: null, pendingContent: null, editor: null, grid: null } as any,
    $(id: string) {
      return document.getElementById(id);
    },
    getFileIcon: () => '',
    _filesCloseNoteDialog() {},
    _filesHideNotePill() {},
    _filesClearSelSnapshot() {},
    _filesShowView() {},
    _filesEnsureVendor: async () => true,
    _filesBackFromHistory() {},
    _filesGridMaxIcon: () => '',
    // Not exercised here — present so a routing regression fails loudly.
    _filesRenderSpreadsheet: vi.fn(),
  });
}

type App = ReturnType<typeof makeApp>;

function mountSheet() {
  document.head.innerHTML = '';
  document.body.innerHTML = `
    <div id="filesSheet" class="files-sheet open">
      <div class="files-sheet-header">
        <div id="filesSheetTitle"></div>
        <button id="filesSheetBackBtn"></button>
      </div>
      <div id="filesSheetView">
        <div class="files-sheet-view-toolbar">
          <div id="filesSheetViewMeta"></div>
          <div id="filesSheetViewActions"></div>
        </div>
        <div class="files-sheet-view-content" id="filesSheetViewContent"></div>
      </div>
    </div>`;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
const rawUrlFor = (path: string) => `/api/sessions/sess-a/file-raw?path=${encodeURIComponent(path)}`;

/** file-content returns docx metadata; file-raw returns the bytes. */
function docxResponder(path: string, { size = 15384, rawStatus = 200 } = {}): Responder {
  return ({ url }) => {
    if (url.includes('/file-content?')) {
      return {
        json: {
          success: true,
          data: { path, size, type: 'document', extension: 'docx', url: rawUrlFor(path), mtime: 1 },
        },
      };
    }
    if (url === rawUrlFor(path)) return { status: rawStatus, bytes: DOCX_BYTES };
    return { json: {} };
  };
}

async function openDocx(app: App, path: string, opts?: { size?: number; rawStatus?: number }) {
  responder = docxResponder(path, opts);
  await app.filesOpenFile(path);
  await flush();
}

const content = () => document.getElementById('filesSheetViewContent')!;
const actions = () => document.getElementById('filesSheetViewActions')!;
const meta = () => document.getElementById('filesSheetViewMeta')!;
const docxScripts = () => document.head.querySelectorAll('script[src="vendor/docx.min.js"]');
const notices = () => Array.from(content().querySelectorAll('.files-sheet-notice')).map((n) => n.textContent!.trim());
const rawFetches = () => fetchCalls.filter((c) => c.url.includes('/file-raw?'));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('files sheet — docx preview', () => {
  let app: App;
  let docx: ReturnType<typeof installDocx>;

  beforeEach(() => {
    mountSheet();
    fetchCalls = [];
    responder = () => ({ json: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: FetchCall['init']) => {
        const call = { url, init };
        fetchCalls.push(call);
        const r = await responder(call);
        const status = r.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => r.json ?? {},
          arrayBuffer: async () => r.bytes ?? new ArrayBuffer(0),
        };
      })
    );
    docx = installDocx();
    app = makeApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).CodemanDocx;
  });

  describe('_filesRenderDocx', () => {
    it('routes file-content type "document" to the docx renderer and mounts the rendered wrap', async () => {
      await openDocx(app, 'docs/Plan.docx');

      expect(app._filesRenderSpreadsheet).not.toHaveBeenCalled();
      expect(docx.render).toHaveBeenCalledTimes(1);
      const wrap = content().querySelector('.files-docx-wrap');
      expect(wrap).not.toBeNull();
      expect(wrap!.querySelector('section.docx')!.textContent).toBe('Hello docx');
      expect(docx.calls[0].container).toBe(wrap);
      expect(docx.calls[0].data).toBe(DOCX_BYTES);
      expect(content().querySelector('.files-binary-card')).toBeNull();
      expect(meta().textContent).toBe('15.0 KB • docx');
    });

    it('fetches the bytes from file-raw without the HTTP cache', async () => {
      await openDocx(app, 'Plan.docx');
      expect(rawFetches()).toEqual([{ url: rawUrlFor('Plan.docx'), init: { cache: 'no-store' } }]);
    });

    it('renders with alt chunks disabled and images as data: URLs', async () => {
      await openDocx(app, 'Plan.docx');
      expect(docx.calls[0].opts).toMatchObject({ renderAltChunks: false, useBase64URL: true });
    });

    it('shows a full-file Download action while previewing', async () => {
      await openDocx(app, 'docs/Plan.docx');
      const dl = actions().querySelector('a[download="Plan.docx"]') as HTMLAnchorElement;
      expect(dl).not.toBeNull();
      expect(dl.getAttribute('href')).toBe(`${rawUrlFor('docs/Plan.docx')}&download=1`);
    });

    it('clears the editing state so save/edit cannot fire on a document', async () => {
      app.filesState.current = { path: 'old.txt' };
      app.filesState.pendingContent = 'x';
      await openDocx(app, 'Plan.docx');
      expect(app.filesState.current).toBeNull();
      expect(app.filesState.pendingContent).toBeNull();
    });

    it('sanitizes document links before the wrap is attached', async () => {
      docx = installDocx((c) => {
        c.innerHTML = '<a id="evil" href="javascript:alert(1)">x</a>';
      });
      await openDocx(app, 'Plan.docx');
      const link = content().querySelector('.files-docx-wrap #evil')!;
      expect(link).not.toBeNull();
      expect(link.hasAttribute('href')).toBe(false);
    });

    it('falls back to the Download card when the bundle fails to load', async () => {
      delete (window as any).CodemanDocx;
      await openDocx(app, 'Plan.docx');
      expect(docxScripts()).toHaveLength(1);

      docxScripts()[0].dispatchEvent(new Event('error'));
      await flush();

      expect(content().querySelector('.files-docx-wrap')).toBeNull();
      expect(content().querySelector('.files-binary-card a[download="Plan.docx"]')).not.toBeNull();
      expect(notices()).toEqual(['Preview unavailable — download the file to view it.']);
      expect(rawFetches()).toHaveLength(0);
    });

    it('falls back to the Download card when render throws', async () => {
      docx = installDocx(() => {
        throw new Error('Corrupted zip');
      });
      await openDocx(app, 'Plan.docx');

      expect(content().querySelector('.files-docx-wrap')).toBeNull();
      expect(content().querySelector('.files-binary-card')).not.toBeNull();
      expect(notices()).toEqual(['Preview unavailable — download the file to view it.']);
    });

    it('falls back to the Download card when file-raw is not OK', async () => {
      await openDocx(app, 'Plan.docx', { rawStatus: 500 });

      expect(docx.render).not.toHaveBeenCalled();
      expect(content().querySelector('.files-binary-card')).not.toBeNull();
      expect(notices()).toEqual(['Preview unavailable — download the file to view it.']);
    });

    it('shows the Download card without fetching when the document is over 20MB', async () => {
      await openDocx(app, 'Huge.docx', { size: 20 * 1024 * 1024 + 1 });

      expect(rawFetches()).toHaveLength(0);
      expect(docx.render).not.toHaveBeenCalled();
      expect(content().querySelector('.files-binary-card')).not.toBeNull();
      expect(notices()).toEqual(['Document too large to preview']);
    });

    it('drops a stale render when the editor is torn down during the fetch', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const base = docxResponder('Plan.docx');
      responder = async (call) => {
        if (call.url.includes('/file-raw?')) await gate;
        return base(call);
      };
      await app.filesOpenFile('Plan.docx');
      await flush();
      expect(rawFetches()).toHaveLength(1);

      app._filesDestroyEditor();
      content().innerHTML = '<pre id="other">other file</pre>';
      release();
      await flush();

      expect(docx.render).not.toHaveBeenCalled();
      expect(content().querySelector('#other')).not.toBeNull();
      expect(content().querySelector('.files-docx-wrap, .files-binary-card')).toBeNull();
    });

    it('drops a stale render when another file replaced the loading view without teardown', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      docx = installDocx(async (c) => {
        await gate;
        c.innerHTML = '<p>late</p>';
      });
      await openDocx(app, 'Plan.docx');
      expect(docx.render).toHaveBeenCalledTimes(1);

      content().innerHTML = '<div class="files-sheet-empty">Loading…</div>';
      release();
      await flush();

      expect(content().querySelector('.files-docx-wrap')).toBeNull();
      expect(content().textContent).toBe('Loading…');
    });

    it('_filesEnsureDocx caches its promise and injects the bundle script once', async () => {
      delete (window as any).CodemanDocx;
      const p1 = app._filesEnsureDocx();
      const p2 = app._filesEnsureDocx();
      expect(p1).toBe(p2);
      expect(docxScripts()).toHaveLength(1);

      installDocx();
      docxScripts()[0].dispatchEvent(new Event('load'));
      await expect(p1).resolves.toBe(true);
    });
  });

  describe('_filesSanitizeDocxLinks', () => {
    const XLINK = 'http://www.w3.org/1999/xlink';
    let wrap: HTMLElement;

    const q = (id: string) => Array.from(wrap.querySelectorAll('[id]')).find((n) => n.id === id)!;

    function sanitize(html: string, setup?: (w: HTMLElement) => void) {
      wrap = document.createElement('div');
      wrap.innerHTML = html;
      setup?.(wrap);
      app._filesSanitizeDocxLinks(wrap);
      document.body.appendChild(wrap);
    }

    it.each([
      ['javascript:', 'javascript:alert(1)'],
      ['mixed-case javascript: with leading space', ' JaVaScRiPt:alert(1)'],
      ['data:', 'data:text/html,<script>alert(1)</script>'],
      ['vbscript:', 'vbscript:msgbox(1)'],
    ])('removes %s hrefs', (_label, href) => {
      sanitize(`<a id="l">x</a>`, (w) => w.querySelector('#l')!.setAttribute('href', href));
      expect(q('l').hasAttribute('href')).toBe(false);
    });

    it('removes script-capable hrefs from <area>', () => {
      sanitize('<map><area id="ar" href="javascript:alert(1)"></map>');
      expect(q('ar').hasAttribute('href')).toBe(false);
    });

    it('keeps http(s) links, opening them in a new tab with noopener', () => {
      sanitize('<a id="h" href="https://x.example/p">h</a>');
      expect(q('h').getAttribute('href')).toBe('https://x.example/p');
      expect(q('h').getAttribute('target')).toBe('_blank');
      expect(q('h').getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('keeps mailto links', () => {
      sanitize('<a id="m" href="mailto:a@b.c">m</a>');
      expect(q('m').getAttribute('href')).toBe('mailto:a@b.c');
      expect(q('m').getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('turns a same-page #bookmark into a data-docx-anchor that scrolls without changing location', () => {
      const scrolled: string[] = [];
      const orig = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this.id);
      };
      try {
        sanitize(`<a id="bm" href="${location.href.split('#')[0]}#bm%20one">bm</a><span id="bm one">target</span>`);
        expect(q('bm').getAttribute('href')).toBe('#');
        expect(q('bm').getAttribute('data-docx-anchor')).toBe('bm one');

        const before = location.href;
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        q('bm').dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(scrolled).toEqual(['bm one']);
        expect(location.href).toBe(before);
      } finally {
        Element.prototype.scrollIntoView = orig;
      }
    });

    it('removes a same-page link without a hash', () => {
      sanitize(`<a id="self" href="${location.href.split('#')[0]}">self</a>`);
      expect(q('self').hasAttribute('href')).toBe(false);
    });

    it('keeps data:image img sources and removes remote ones', () => {
      sanitize('<img id="i1" src="data:image/png;base64,AAA"><img id="i2" src="https://evil.example/x.png">');
      expect(q('i1').getAttribute('src')).toBe('data:image/png;base64,AAA');
      expect(q('i2').hasAttribute('src')).toBe(false);
    });

    it('removes URL attributes from non-link elements', () => {
      sanitize(
        '<form id="f" action="javascript:1"><button id="b" formaction="javascript:1">b</button></form>' +
          '<iframe id="ifr" src="javascript:1"></iframe><img id="ss" srcset="https://evil.example/x.png 1x">' +
          '<video id="v" poster="https://evil.example/p.png"></video><object id="o" data="https://evil.example/o"></object>'
      );
      expect(q('f').hasAttribute('action')).toBe(false);
      expect(q('b').hasAttribute('formaction')).toBe(false);
      expect(q('ifr').hasAttribute('src')).toBe(false);
      expect(q('ss').hasAttribute('srcset')).toBe(false);
      expect(q('v').hasAttribute('poster')).toBe(false);
      expect(q('o').hasAttribute('data')).toBe(false);
    });

    it('keeps data:image hrefs on SVG <image> and strips xlink:href from SVG links', () => {
      sanitize('<svg><image id="si" href="data:image/png;base64,AAA"></image><a id="sa"></a></svg>', (w) =>
        w.querySelector('#sa')!.setAttributeNS(XLINK, 'xlink:href', 'javascript:alert(1)')
      );
      expect(q('si').getAttribute('href')).toBe('data:image/png;base64,AAA');
      expect(q('sa').getAttributeNS(XLINK, 'href')).toBeNull();
    });
  });
});

// @vitest-environment jsdom

/**
 * @fileoverview Files-sheet GRID spreadsheet view (csv, tsv, xlsx, xls, ods) in
 * src/web/public/app.js.
 *
 * As in test/files-review-notes.test.ts, the REAL method bodies are extracted
 * from the shipped app.js text and re-compiled into a plain object, then run
 * against a jsdom DOM that mirrors #filesSheetView from index.html. These
 * assertions therefore cannot drift from the code that ships.
 *
 * Only collaborators are stubbed:
 * - window.CodemanGrid, the lazy vendor/grid.min.js bundle (React + GRID +
 *   SheetJS). It cannot run in jsdom, so a fake records load/mount/serialize
 *   calls and renders a placeholder <canvas> into the mount element.
 * - fetch, confirm, navigator.clipboard, toasts, the markdown notes UI,
 *   FilesTTS and OverlayHistory.
 *
 * jsdom never loads <script src>, so the "bundle unavailable" cases fire the
 * appended script's error event by hand — exercising the real
 * _filesEnsureGrid() failure path.
 *
 * Source-text guards at the bottom pin the lazy-load and save contracts.
 *
 * Run: npx vitest run test/files-grid-view.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import fileRoutesSource from '../src/web/routes/file-routes.ts?raw';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import gridEntrySource from '../scripts/vendor/grid-entry.mjs?raw';
// @ts-expect-error — plain ESM helper without type declarations
import * as tabular from '../scripts/vendor/grid-tabular.mjs';

const APP_JS_SOURCE = appSource as string;
const FILE_ROUTES_SOURCE = fileRoutesSource as string;
const { tabularFormatOf } = tabular as { tabularFormatOf: (p: string) => string | null };

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

/** Evaluates a `name = 5 * 1024 * 1024;`-style constant from a source text. */
function productConstant(source: string, pattern: string, label: string): number {
  const m = new RegExp(pattern + String.raw` = ([\d\s*]+);`).exec(source);
  expect(m, `${label} not found`).toBeTruthy();
  return m![1].split('*').reduce((acc, n) => acc * Number(n.trim()), 1);
}

const classField = (name: string) => productConstant(APP_JS_SOURCE, String.raw`\n  ${name}`, `${name} field`);

const METHODS = [
  'formatFileSize',
  'filesOpenFile',
  '_tabularFormatOf',
  '_filesEnsureGrid',
  '_filesDestroyEditor',
  '_filesRenderBinary',
  '_filesDownloadHtml',
  '_filesRenderView',
  '_filesRenderSpreadsheet',
  '_filesGridTooLarge',
  '_filesGridAvailable',
  '_filesWantsGrid',
  '_filesGridCanEdit',
  '_filesGridReadOnlyReason',
  '_filesTabularTabsHtml',
  'filesSetTabularMode',
  '_filesGridHostHtml',
  '_filesRenderGridView',
  'filesStartGridEdit',
  '_filesGridLoadDoc',
  '_filesMountGrid',
  '_filesGridFallback',
  '_filesSaveGrid',
  'filesStartEdit',
  'filesCancelEdit',
  'filesCopyCurrent',
  'filesSave',
  '_filesShowConflict',
  'filesOverwriteCurrent',
  '_filesGridMetaText',
  '_filesGridMaxIcon',
  '_filesGridMaxBtnHtml',
  'filesToggleGridMaximise',
  '_filesGridSetMaximised',
  '_filesGridHandleEscape',
  '_doFilesBackToTree',
  '_doCloseFilesSheet',
];

// ─── escapeHtml replica (constants.js) ──────────────────────────────────────

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface Mount {
  el: HTMLElement;
  mode: string;
  doc: unknown;
  onDirty: () => void;
  destroy: ReturnType<typeof vi.fn>;
}

function installGrid(
  opts: {
    ready?: Promise<unknown>;
    loadResult?: unknown;
    loadError?: Error;
    serialized?: { encoding: string; content: string };
  } = {}
) {
  const mounts: Mount[] = [];
  const grid = {
    ready: opts.ready ?? Promise.resolve(true),
    load: vi.fn(async (args: { format: string }) => {
      if (opts.loadError) throw opts.loadError;
      return opts.loadResult ?? { model: args.format };
    }),
    mount: vi.fn((el: HTMLElement, doc: unknown, o: { mode: string; onDirty: () => void }) => {
      el.innerHTML = `<canvas class="fake-grid" data-mode="${o.mode}"></canvas>`;
      const m: Mount = { el, mode: o.mode, doc, onDirty: o.onDirty, destroy: vi.fn() };
      mounts.push(m);
      return { destroy: m.destroy };
    }),
    serialize: vi.fn(async () => opts.serialized ?? { encoding: 'utf-8', content: 'a,b\n' }),
    mounts,
  };
  (window as any).CodemanGrid = grid;
  return grid;
}

interface FetchCall {
  url: string;
  init?: { method?: string; body?: string; cache?: string };
}
type Responder = (call: FetchCall) => { status?: number; json?: unknown; bytes?: ArrayBuffer } | Promise<never>;

let fetchCalls: FetchCall[] = [];
let responder: Responder = () => ({ json: {} });

const puts = () => fetchCalls.filter((c) => c.init?.method === 'PUT');
const putBody = (i = -1) => JSON.parse(puts().at(i)!.init!.body!);

function makeApp() {
  const body = METHODS.map(methodSource).join(',\n');
  const factory = new Function(
    'escapeHtml',
    'FilesTTS',
    'OverlayHistory',
    'stripFrontmatter',
    `return ({\n${body}\n});`
  );
  const toasts: { msg: string; kind: string }[] = [];
  // Records the OverlayHistory stack like the real one (top dedup on push).
  const history = {
    stack: [] as { id: string; close: (forced?: boolean) => void }[],
    pops: [] as string[],
    push(id: string, close: (forced?: boolean) => void) {
      if (this.stack.at(-1)?.id === id) return;
      this.stack.push({ id, close });
    },
    pop(id: string) {
      const i = this.stack.findIndex((e) => e.id === id);
      if (i === -1) return;
      this.stack.splice(i, 1);
      this.pops.push(id);
    },
    has(id: string) {
      return this.stack.some((e) => e.id === id);
    },
    ids() {
      return this.stack.map((e) => e.id);
    },
  };
  const methods = factory(escapeHtml, { stop() {}, isPlaying: () => false, rebind() {} }, history, (s: string) => s);
  return Object.assign(methods, {
    history,
    activeSessionId: 'sess-a',
    filesState: { current: null, pendingContent: null, editor: null, grid: null } as any,
    _filesGridCsvMaxBytes: classField('_filesGridCsvMaxBytes'),
    _filesGridMaxCells: classField('_filesGridMaxCells'),
    _filesGridSheetMaxBytes: classField('_filesGridSheetMaxBytes'),
    _filesMaxWriteBytes: classField('_filesMaxWriteBytes'),
    toasts,
    $(id: string) {
      return document.getElementById(id);
    },
    $$(id: string) {
      return document.getElementById(id);
    },
    showToast(msg: string, kind: string) {
      toasts.push({ msg, kind });
    },
    getFileIcon: () => '',
    _filesTeardownNotesUi() {},
    _filesRenderMdTools() {},
    _filesApplyNoteHighlights() {},
    _filesInstallNoteSelection() {},
    _filesRenderNotesPanel() {},
    _filesPreviewEl: () => null,
    _filesPersistState() {},
    _filesCloseNoteDialog() {},
    _filesHideNotePill() {},
    _filesClearSelSnapshot() {},
    _filesShowView() {},
    _filesEnsureVendor: async () => true,
    _filesBackFromHistory() {},
    _filesShowTree() {},
    filesLoadTree() {},
    _filesPersistClosed() {},
  });
}

type App = ReturnType<typeof makeApp>;

// ─── Fixture helpers ────────────────────────────────────────────────────────

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
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

const MTIME = 111;
const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;

/** Opens a text file through the real filesOpenFile() (file-content JSON). */
async function openText(app: App, path: string, text: string, extra: Record<string, unknown> = {}) {
  responder = ({ url }) => {
    if (url.includes('/file-content?')) {
      return {
        json: {
          success: true,
          data: { path, content: text, size: text.length, mtime: MTIME, truncated: false, totalLines: 2, ...extra },
        },
      };
    }
    return { json: {} };
  };
  await app.filesOpenFile(path);
  await flush();
}

/** Opens a binary spreadsheet: file-content metadata, then bytes from file-raw. */
async function openSheet(app: App, path: string, size = 2048, rawStatus = 200) {
  const rawUrl = `/api/sessions/sess-a/file-raw?path=${encodeURIComponent(path)}`;
  responder = ({ url }) => {
    if (url.includes('/file-content?')) {
      const ext = path.split('.').pop()!.toLowerCase();
      return {
        json: { success: true, data: { path, size, type: 'spreadsheet', extension: ext, url: rawUrl, mtime: MTIME } },
      };
    }
    if (url === rawUrl) return { status: rawStatus, bytes: XLSX_BYTES };
    return { json: {} };
  };
  await app.filesOpenFile(path);
  await flush();
  return rawUrl;
}

const content = () => document.getElementById('filesSheetViewContent')!;
const actions = () => document.getElementById('filesSheetViewActions')!;
const meta = () => document.getElementById('filesSheetViewMeta')!;
// The icon-only maximise toggle is asserted separately (maxBtn()).
const buttonLabels = () =>
  Array.from(actions().querySelectorAll('button:not(.files-grid-max-btn)')).map((b) => b.textContent);
const maxBtn = () => actions().querySelector('button.files-grid-max-btn') as HTMLButtonElement | null;
const sheetEl = () => document.getElementById('filesSheet')!;
const isMaximised = () => sheetEl().classList.contains('is-grid-max');
const activeTab = () => actions().querySelector('button.is-active')?.textContent;
const gridScripts = () => document.head.querySelectorAll('script[src="vendor/grid.min.js"]');
const notices = () => Array.from(content().querySelectorAll('.files-sheet-notice')).map((n) => n.textContent!.trim());

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('files sheet — GRID spreadsheet view', () => {
  let app: App;
  let grid: ReturnType<typeof installGrid>;
  let clipboardWrite: ReturnType<typeof vi.fn>;

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
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true)
    );
    clipboardWrite = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboardWrite }, configurable: true });
    delete (window as any).CodemanEditor;
    delete (window as any).CodemanMarkdown;
    grid = installGrid();
    app = makeApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).CodemanGrid;
  });

  // ── csv / tsv routing ─────────────────────────────────────────────────────

  describe('csv/tsv routing', () => {
    it('opens a csv under the limits in the grid viewer with Grid/Text tabs', async () => {
      await openText(app, 'data/people.csv', 'a,b\n1,2\n');

      expect(content().classList.contains('is-grid')).toBe(true);
      expect(content().querySelector('.files-grid-host .files-grid-mount canvas[data-mode="view"]')).not.toBeNull();
      expect(content().querySelector('pre')).toBeNull();
      expect(buttonLabels()).toEqual(['Grid', 'Text', 'Edit', 'Copy']);
      expect(activeTab()).toBe('Grid');
      expect(actions().querySelector('a[download="people.csv"]')).not.toBeNull();
      expect(meta().textContent).toBe('8 B • csv');
      expect(grid.load).toHaveBeenCalledWith({
        format: 'csv',
        text: 'a,b\n1,2\n',
        filename: 'people.csv',
        maxCells: 250000,
      });
    });

    it('routes .TSV case-insensitively to the tsv grid', async () => {
      await openText(app, 'Data.TSV', 'a\tb\n');
      expect(app.filesState.current.tabular).toBe('tsv');
      expect(grid.load.mock.calls[0][0]).toMatchObject({ format: 'tsv' });
      expect(content().classList.contains('is-grid')).toBe(true);
    });

    it.each([
      ['truncated', { truncated: true, totalLines: 20000 }],
      ['over 2 MB', { size: 2 * 1024 * 1024 + 1 }],
    ])('shows a %s csv as text with a notice and never loads the grid', async (_label, extra) => {
      await openText(app, 'big.csv', 'a,b\n1,2\n', extra);

      expect(content().querySelector('.files-grid-host')).toBeNull();
      expect(content().classList.contains('is-grid')).toBe(false);
      expect(content().querySelector('pre code')!.textContent).toBe('a,b\n1,2\n');
      expect(notices()).toContain('Too large for spreadsheet view — showing text.');
      expect(buttonLabels()).not.toContain('Grid');
      expect(buttonLabels()).not.toContain('Text');
      expect(grid.load).not.toHaveBeenCalled();
      expect(gridScripts()).toHaveLength(0);
    });

    it('falls back to text with a notice when the parsed csv exceeds the cell limit', async () => {
      grid = installGrid({ loadResult: { tooLarge: true } });
      await openText(app, 'wide.csv', 'a,b\n1,2\n');

      expect(app.filesState.current.gridTooLarge).toBe(true);
      expect(grid.mount).not.toHaveBeenCalled();
      expect(content().querySelector('pre code')!.textContent).toBe('a,b\n1,2\n');
      expect(notices()).toContain('Too large for spreadsheet view — showing text.');
      expect(buttonLabels()).toEqual(['Copy', 'Edit']);
    });

    it('Text tab shows the raw file, unmounts the grid and keeps the Grid/Text pair', async () => {
      await openText(app, 'people.csv', 'a,"x,y"\n1,2\n');
      const viewer = grid.mounts[0];

      app.filesSetTabularMode('text');

      expect(content().querySelector('pre code')!.textContent).toBe('a,"x,y"\n1,2\n');
      expect(content().classList.contains('is-grid')).toBe(false);
      expect(buttonLabels()).toEqual(['Grid', 'Text', 'Copy', 'Edit']);
      expect(activeTab()).toBe('Text');
      expect(viewer.destroy).toHaveBeenCalledTimes(1);
      expect(app.filesState.grid).toBeNull();

      app.filesSetTabularMode('grid');
      await flush();
      expect(content().classList.contains('is-grid')).toBe(true);
      expect(grid.mounts).toHaveLength(2);
      // The parsed document is reused, not reloaded.
      expect(grid.load).toHaveBeenCalledTimes(1);
    });

    it('Edit from the Text tab opens the raw text editor, not the grid editor', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      app.filesSetTabularMode('text');

      app.filesStartEdit();
      await flush();

      const ta = content().querySelector('textarea#filesSheetEditor') as HTMLTextAreaElement;
      expect(ta.value).toBe('a,b\n');
      expect(grid.mounts.map((m) => m.mode)).toEqual(['view']);
      expect(content().classList.contains('is-grid')).toBe(false);
    });

    it('leaves non-tabular files on the existing text view', async () => {
      await openText(app, 'src/index.ts', 'const a = 1;\n');

      expect(app.filesState.current.tabular).toBeNull();
      expect(content().querySelector('pre code')!.textContent).toBe('const a = 1;\n');
      expect(grid.load).not.toHaveBeenCalled();
      expect(gridScripts()).toHaveLength(0);
    });
  });

  // ── Bundle unavailable ────────────────────────────────────────────────────

  describe('bundle unavailable (vendor/grid.min.js fails to load)', () => {
    beforeEach(() => {
      delete (window as any).CodemanGrid;
    });

    it('csv falls back to the text view without tabs, and the failed load is cached', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      expect(gridScripts()).toHaveLength(1);
      expect(document.head.querySelector('link[href="vendor/grid.min.css"]')).not.toBeNull();

      gridScripts()[0].dispatchEvent(new Event('error'));
      await flush();

      expect(app._filesGridFailed).toBe(true);
      expect(content().querySelector('pre code')!.textContent).toBe('a,b\n');
      expect(content().querySelector('.files-grid-host')).toBeNull();
      expect(content().classList.contains('is-grid')).toBe(false);
      expect(buttonLabels()).toEqual(['Copy', 'Edit']);

      await openText(app, 'other.csv', 'x\n');
      expect(gridScripts()).toHaveLength(1);
      expect(content().querySelector('pre code')!.textContent).toBe('x\n');
    });

    it('xlsx falls back to the Download card', async () => {
      await openSheet(app, 'book.xlsx');
      gridScripts()[0].dispatchEvent(new Event('error'));
      await flush();

      expect(content().querySelector('.files-binary-card')).not.toBeNull();
      expect(content().classList.contains('is-grid')).toBe(false);
      expect(app.filesState.current).toBeNull();
      expect(buttonLabels()).toEqual([]);
      expect(actions().querySelector('a[download="book.xlsx"]')).not.toBeNull();
    });
  });

  // ── Grid error fallback ───────────────────────────────────────────────────

  describe('grid error fallback (corrupt file / HTTP error)', () => {
    it('csv whose load throws toasts and falls back to the text view without tabs', async () => {
      grid = installGrid({ loadError: new Error('Unterminated quote') });
      await openText(app, 'broken.csv', 'a,"b\n');

      expect(app.toasts).toContainEqual({ msg: 'Spreadsheet view failed: Unterminated quote', kind: 'error' });
      expect(app.filesState.current.gridUnavailable).toBe(true);
      expect(grid.mount).not.toHaveBeenCalled();
      expect(content().querySelector('pre code')!.textContent).toBe('a,"b\n');
      expect(content().querySelector('.files-grid-host')).toBeNull();
      expect(content().classList.contains('is-grid')).toBe(false);
      expect(buttonLabels()).toEqual(['Copy', 'Edit']);
      expect(notices()).not.toContain('Too large for spreadsheet view — showing text.');
    });

    it('csv whose mount throws toasts and falls back to the text view', async () => {
      grid.mount.mockImplementationOnce(() => {
        throw new Error('render crashed');
      });
      await openText(app, 'people.csv', 'a,b\n');

      expect(app.toasts).toContainEqual({ msg: 'Spreadsheet view failed: render crashed', kind: 'error' });
      expect(app.filesState.grid).toBeNull();
      expect(content().querySelector('pre code')!.textContent).toBe('a,b\n');
      expect(buttonLabels()).toEqual(['Copy', 'Edit']);
    });

    it('xlsx whose load throws (corrupt workbook) falls back to the Download card', async () => {
      grid = installGrid({ loadError: new Error('Corrupted zip') });
      await openSheet(app, 'book.xlsx');

      expect(app.toasts).toContainEqual({ msg: 'Spreadsheet view failed: Corrupted zip', kind: 'error' });
      expect(content().querySelector('.files-binary-card')).not.toBeNull();
      expect(content().classList.contains('is-grid')).toBe(false);
      expect(app.filesState.current).toBeNull();
      expect(actions().querySelector('a[download="book.xlsx"]')).not.toBeNull();
    });

    it('xlsx whose file-raw fetch returns 500 falls back to the Download card without loading', async () => {
      await openSheet(app, 'book.xlsx', 2048, 500);

      expect(app.toasts).toContainEqual({ msg: 'Spreadsheet view failed: HTTP 500', kind: 'error' });
      expect(grid.load).not.toHaveBeenCalled();
      expect(grid.mount).not.toHaveBeenCalled();
      expect(content().querySelector('.files-binary-card')).not.toBeNull();
      expect(app.filesState.current).toBeNull();
    });

    it('a grid failure while starting a csv grid edit opens the raw text editor', async () => {
      await openText(app, 'people.csv', 'a,b\n1,2\n');
      const viewer = grid.mounts[0];
      grid.mount.mockImplementationOnce(() => {
        throw new Error('editor crashed');
      });

      app.filesStartEdit();
      await flush();

      expect(app.toasts).toContainEqual({ msg: 'Spreadsheet view failed: editor crashed', kind: 'error' });
      expect(viewer.destroy).toHaveBeenCalledTimes(1);
      const ta = content().querySelector('textarea#filesSheetEditor') as HTMLTextAreaElement;
      expect(ta).not.toBeNull();
      expect(ta.value).toBe('a,b\n1,2\n');
      expect(content().querySelector('.files-grid-host')).toBeNull();
      expect(content().classList.contains('is-grid')).toBe(false);
      expect(buttonLabels()).toEqual(['Cancel', 'Save']);
      expect(app.filesState.current).toMatchObject({ editing: true, gridHandle: null, gridUnavailable: true });
    });
  });

  // ── Binary spreadsheets ───────────────────────────────────────────────────

  describe('binary spreadsheets (xlsx/xls/ods)', () => {
    it('xlsx loads bytes from file-raw into the viewer with Edit + Download and no Copy', async () => {
      const rawUrl = await openSheet(app, 'reports/book.xlsx');

      expect(fetchCalls.find((c) => c.url === rawUrl)!.init).toEqual({ cache: 'no-store' });
      expect(grid.load).toHaveBeenCalledWith({ format: 'xlsx', bytes: XLSX_BYTES, filename: 'book.xlsx' });
      expect(content().querySelector('canvas[data-mode="view"]')).not.toBeNull();
      expect(buttonLabels()).toEqual(['Edit']);
      expect(actions().querySelector('a[download="book.xlsx"]')).not.toBeNull();
      expect(meta().textContent).toBe('2.0 KB • xlsx');
      expect(app.filesState.current).toMatchObject({
        kind: 'spreadsheet',
        format: 'xlsx',
        content: null,
        mtime: MTIME,
      });

      app.filesCopyCurrent();
      expect(clipboardWrite).not.toHaveBeenCalled();
    });

    it.each(['xls', 'ods'])('.%s is read-only: no Edit button, reason in the meta line', async (ext) => {
      await openSheet(app, `legacy.${ext}`);

      expect(content().querySelector('canvas[data-mode="view"]')).not.toBeNull();
      expect(buttonLabels()).toEqual([]);
      expect(meta().textContent).toBe(`2.0 KB • ${ext} • read-only: .${ext} can't be saved in place`);

      await app.filesStartEdit();
      await flush();
      expect(app.toasts).toContainEqual({ msg: `Read-only: .${ext} can't be saved in place`, kind: 'error' });
      expect(grid.mounts.map((m) => m.mode)).toEqual(['view']);
      expect(app.filesState.current.editing).toBe(false);
    });

    it('xlsx over the 5 MB save limit opens read-only and refuses grid edit', async () => {
      await openSheet(app, 'big.xlsx', 6 * 1024 * 1024);

      expect(meta().textContent).toBe('6.0 MB • xlsx • read-only: too large to save (over 5.0 MB)');
      expect(buttonLabels()).toEqual([]);

      await app.filesStartGridEdit();
      await flush();
      expect(app.toasts).toContainEqual({ msg: 'Read-only: too large to save (over 5.0 MB)', kind: 'error' });
      expect(grid.mounts.map((m) => m.mode)).toEqual(['view']);
    });

    it('xlsx over the 10 MB preview limit shows the Download card without loading the bundle', async () => {
      await openSheet(app, 'huge.xlsx', 10 * 1024 * 1024 + 1);

      expect(content().querySelector('.files-binary-card')).not.toBeNull();
      expect(notices()).toEqual(['Spreadsheet too large to preview']);
      expect(app.filesState.current).toBeNull();
      expect(grid.load).not.toHaveBeenCalled();
      expect(gridScripts()).toHaveLength(0);
    });
  });

  // ── Attribution (GRID licence §2.3) ───────────────────────────────────────

  describe('"Powered by GRID" attribution', () => {
    function expectAttribution() {
      const link = content().querySelector('.files-grid-host > .files-grid-attrib > a') as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.textContent).toBe('Powered by GRID');
      expect(link.getAttribute('href')).toBe('https://grid.is');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener');
      // Directly adjacent to the spreadsheet mount.
      expect(link.parentElement!.previousElementSibling!.classList.contains('files-grid-mount')).toBe(true);
    }

    it('is shown on the csv viewer', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      expectAttribution();
    });

    it('is shown on the read-only xls viewer', async () => {
      await openSheet(app, 'legacy.xls');
      expectAttribution();
    });

    it('is shown on the grid editor', async () => {
      await openSheet(app, 'book.xlsx');
      app.filesStartEdit();
      await flush();
      expect(content().querySelector('canvas[data-mode="edit"]')).not.toBeNull();
      expectAttribution();
    });
  });

  // ── is-grid class lifecycle ───────────────────────────────────────────────

  describe('is-grid lifecycle', () => {
    beforeEach(async () => {
      await openText(app, 'people.csv', 'a,b\n');
      expect(content().classList.contains('is-grid')).toBe(true);
    });

    it('is removed when a binary file is rendered next', () => {
      app._filesRenderBinary({ type: 'image', path: 'logo.png', size: 10, extension: 'png' });
      expect(content().classList.contains('is-grid')).toBe(false);
    });

    it("is removed by the next file's loading state", async () => {
      responder = () => new Promise<never>(() => {});
      void app.filesOpenFile('notes.md');
      await flush();
      expect(content().textContent).toBe('Loading…');
      expect(content().classList.contains('is-grid')).toBe(false);
    });

    it('is removed when a markdown file is rendered next', async () => {
      await openText(app, 'notes.md', '# x');
      expect(content().classList.contains('is-grid')).toBe(false);
    });
  });

  // ── Teardown ──────────────────────────────────────────────────────────────

  describe('teardown', () => {
    it('_filesDestroyEditor unmounts the grid and clears filesState.grid', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      const viewer = grid.mounts[0];
      expect(app.filesState.grid).not.toBeNull();

      app._filesDestroyEditor();

      expect(viewer.destroy).toHaveBeenCalledTimes(1);
      expect(app.filesState.grid).toBeNull();
    });

    it('opening another file unmounts the previous grid', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      const viewer = grid.mounts[0];
      await openText(app, 'notes.txt', 'hi');
      expect(viewer.destroy).toHaveBeenCalledTimes(1);
      expect(app.filesState.grid).toBeNull();
    });

    it('a mount still waiting on the bundle does not land in a replaced view', async () => {
      let resolveReady!: (v: boolean) => void;
      grid = installGrid({ ready: new Promise<boolean>((r) => (resolveReady = r)) });
      await openText(app, 'people.csv', 'a,b\n');
      await openText(app, 'notes.txt', 'hi');

      resolveReady(true);
      await flush();

      expect(grid.mount).not.toHaveBeenCalled();
      expect(content().querySelector('pre code')!.textContent).toBe('hi');
    });
  });

  // ── Grid edit & save ──────────────────────────────────────────────────────

  describe('grid edit and save', () => {
    it('Edit mounts the GRID editor with the values-only notice and Cancel/Save', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      app.filesStartEdit();
      await flush();

      const editor = grid.mounts[1];
      expect(editor.mode).toBe('edit');
      expect(notices()).toEqual([
        'CSV stores values only — formulas save as results; formatting and extra sheets are not saved.',
      ]);
      expect(buttonLabels()).toEqual(['Cancel', 'Save']);
      expect(app.filesState.current.editing).toBe(true);
      expect(app.filesState.current.gridHandle).toBe(editor.doc);

      expect(app.filesState.current.dirty).toBe(false);
      editor.onDirty();
      expect(app.filesState.current.dirty).toBe(true);
    });

    it('Save before the editor has mounted shows the still-loading toast and sends nothing', async () => {
      grid = installGrid({ ready: new Promise(() => {}) });
      await openText(app, 'people.csv', 'a,b\n');
      void app.filesStartEdit();
      await flush();

      await app.filesSave();

      expect(app.toasts).toEqual([
        { msg: 'Spreadsheet editor is still loading — try again in a moment.', kind: 'info' },
      ]);
      expect(puts()).toHaveLength(0);
    });

    it('saves a csv grid edit as utf-8 text with the staleness guard', async () => {
      grid = installGrid({ serialized: { encoding: 'utf-8', content: 'a,b\n9,2\n' } });
      await openText(app, 'people.csv', 'a,b\n1,2\n');
      app.filesStartEdit();
      await flush();
      grid.mounts[1].onDirty();

      responder = () => ({ json: { success: true, data: { mtime: 222, size: 8 } } });
      await app.filesSave();

      expect(putBody()).toEqual({ path: 'people.csv', content: 'a,b\n9,2\n', encoding: 'utf-8', expectedMtime: MTIME });
      expect(puts()[0].url).toBe('/api/sessions/sess-a/file-content');
      expect(app.filesState.current).toMatchObject({ content: 'a,b\n9,2\n', mtime: 222, size: 8, dirty: false });
      expect(confirm).not.toHaveBeenCalled();
      expect(app.toasts).toContainEqual({ msg: 'Saved', kind: 'success' });
    });

    it.each([
      [
        'HTTP 500 with an error message',
        500,
        { success: false, error: 'EACCES: permission denied' },
        'EACCES: permission denied',
      ],
      ['HTTP 200 without success', 200, { success: false }, 'Failed to save'],
    ])('a non-409 save failure (%s) toasts and keeps dirty and mtime', async (_label, status, json, reason) => {
      grid = installGrid({ serialized: { encoding: 'utf-8', content: 'a,b\n9,2\n' } });
      await openText(app, 'people.csv', 'a,b\n1,2\n');
      app.filesStartEdit();
      await flush();
      grid.mounts[1].onDirty();

      responder = () => ({ status, json });
      await app.filesSave();

      expect(puts()).toHaveLength(1);
      expect(app.toasts.at(-1)).toEqual({ msg: `Save failed: ${reason}`, kind: 'error' });
      expect(app.toasts).not.toContainEqual({ msg: 'Saved', kind: 'success' });
      expect(app.filesState.current).toMatchObject({
        content: 'a,b\n1,2\n',
        mtime: MTIME,
        dirty: true,
        editing: true,
      });
      expect(app.filesState.pendingContent).toBeNull();
      expect(buttonLabels()).toEqual(['Cancel', 'Save']);
      expect(grid.mounts.at(-1)!.destroy).not.toHaveBeenCalled();
    });

    it('xlsx save confirms once per file and sends base64', async () => {
      grid = installGrid({ serialized: { encoding: 'base64', content: 'UEsDBA==' } });
      await openSheet(app, 'book.xlsx');
      app.filesStartEdit();
      await flush();

      responder = () => ({ json: { success: true, data: { mtime: 333, size: 4 } } });
      await app.filesSave();
      await app.filesSave();

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(puts()).toHaveLength(2);
      expect(putBody(0)).toEqual({ path: 'book.xlsx', content: 'UEsDBA==', encoding: 'base64', expectedMtime: MTIME });
      expect(app.filesState.current).toMatchObject({ content: null, mtime: 333, size: 4 });
    });

    it('declining the xlsx confirmation sends nothing', async () => {
      vi.stubGlobal(
        'confirm',
        vi.fn(() => false)
      );
      await openSheet(app, 'book.xlsx');
      app.filesStartEdit();
      await flush();

      await app.filesSave();

      expect(grid.serialize).not.toHaveBeenCalled();
      expect(puts()).toHaveLength(0);
    });

    it('refuses to PUT a base64 payload that decodes to more than 5 MB', async () => {
      grid = installGrid({ serialized: { encoding: 'base64', content: 'A'.repeat(6990508) } });
      await openSheet(app, 'book.xlsx');
      app.filesStartEdit();
      await flush();

      await app.filesSave();

      expect(puts()).toHaveLength(0);
      expect(app.toasts.at(-1)).toEqual({
        msg: 'Not saved — file too large to save (5.0 MB; limit 5.0 MB)',
        kind: 'error',
      });
    });

    it('measures a utf-8 payload in bytes, not characters', async () => {
      // 3 MB of 2-byte characters = 6 MB on disk.
      grid = installGrid({ serialized: { encoding: 'utf-8', content: 'é'.repeat(3 * 1024 * 1024) } });
      await openText(app, 'people.csv', 'a,b\n');
      app.filesStartEdit();
      await flush();

      await app.filesSave();

      expect(puts()).toHaveLength(0);
      expect(app.toasts.at(-1)!.msg).toContain('Not saved — file too large to save (6.0 MB');
    });

    it('409 hands {content, encoding} to the conflict notice and Overwrite forwards encoding', async () => {
      grid = installGrid({ serialized: { encoding: 'base64', content: 'UEsDBA==' } });
      await openSheet(app, 'book.xlsx');
      app.filesStartEdit();
      await flush();

      responder = () => ({ status: 409, json: { success: false, errorCode: 'CONFLICT' } });
      await app.filesSave();

      expect(app.filesState.pendingContent).toEqual({ encoding: 'base64', content: 'UEsDBA==' });
      expect(
        content().querySelector('.files-sheet-notice button[onclick="app.filesOverwriteCurrent()"]')
      ).not.toBeNull();

      responder = () => ({ json: { success: true, data: { mtime: 444, size: 4 } } });
      await app.filesOverwriteCurrent();
      await flush();

      // Force overwrite: no expectedMtime, but the binary encoding survives.
      expect(putBody()).toEqual({ path: 'book.xlsx', content: 'UEsDBA==', encoding: 'base64' });
      expect(app.filesState.pendingContent).toBeNull();
      expect(app.filesState.current).toMatchObject({ content: null, mtime: 444, dirty: false });
      // Re-enters the grid editor, not the raw text editor.
      expect(grid.mounts.at(-1)!.mode).toBe('edit');
      expect(content().querySelector('#filesSheetEditor')).toBeNull();
    });

    it('Cancel after a dirty grid edit drops the mutated model so the viewer reloads it', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      app.filesStartEdit();
      await flush();
      grid.mounts[1].onDirty();

      app.filesCancelEdit();
      await flush();

      expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?');
      expect(grid.load).toHaveBeenCalledTimes(2);
      expect(grid.mounts.at(-1)!.mode).toBe('view');
      expect(app.filesState.current).toMatchObject({ editing: false, dirty: false, gridHandle: null });
    });
  });

  // ── Detected delimiter in the meta line ───────────────────────────────────

  describe('detected delimiter', () => {
    it('shows the delimiter once the csv has loaded, and keeps it on re-render', async () => {
      grid = installGrid({ loadResult: { model: 'csv', delimiter: ';', delimiterName: 'semicolon' } });
      const text = 'a;b\n1,50;2\n';
      await openText(app, 'eu.csv', text);

      expect(meta().textContent).toBe(`${text.length} B • csv • semicolon-delimited`);

      app.filesSetTabularMode('text');
      app.filesSetTabularMode('grid');
      expect(meta().textContent).toBe(`${text.length} B • csv • semicolon-delimited`);
      expect(grid.load).toHaveBeenCalledTimes(1);
    });

    it('never shows a delimiter for binary spreadsheets', async () => {
      grid = installGrid({ loadResult: { model: 'xlsx', delimiterName: 'comma' } });
      await openSheet(app, 'book.xlsx');
      expect(meta().textContent).toBe('2.0 KB • xlsx');
    });
  });

  // ── Maximise ──────────────────────────────────────────────────────────────

  describe('maximise', () => {
    it('is the first action in grid view and in grid edit', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      expect(actions().firstElementChild).toBe(maxBtn());
      expect(maxBtn()!.getAttribute('aria-pressed')).toBe('false');
      expect(maxBtn()!.title).toBe('Maximise');
      expect(maxBtn()!.getAttribute('aria-label')).toBe('Maximise spreadsheet');

      app.filesStartEdit();
      await flush();
      expect(actions().firstElementChild).toBe(maxBtn());
      expect(buttonLabels()).toEqual(['Cancel', 'Save']);
    });

    it('is offered for read-only binary spreadsheets too', async () => {
      await openSheet(app, 'legacy.xls');
      expect(maxBtn()).not.toBeNull();
    });

    it('toggles in place: class, history entry and button state, no remount', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      const viewer = grid.mounts[0];
      expect(app.history.ids()).toEqual(['files-file']);

      app.filesToggleGridMaximise();

      expect(isMaximised()).toBe(true);
      expect(app.filesState.gridMaximised).toBe(true);
      expect(app.history.ids()).toEqual(['files-file', 'files-grid-max']);
      expect(maxBtn()!.getAttribute('aria-pressed')).toBe('true');
      expect(maxBtn()!.title).toBe('Restore');
      expect(maxBtn()!.getAttribute('aria-label')).toBe('Restore spreadsheet');
      expect(grid.mounts).toHaveLength(1);
      expect(viewer.destroy).not.toHaveBeenCalled();
      expect(content().querySelector('.files-grid-host > .files-grid-attrib > a')!.textContent).toBe('Powered by GRID');

      app.filesToggleGridMaximise();

      expect(isMaximised()).toBe(false);
      expect(app.history.pops).toEqual(['files-grid-max']);
      expect(app.history.ids()).toEqual(['files-file']);
      expect(maxBtn()!.getAttribute('aria-pressed')).toBe('false');
      expect(grid.mounts).toHaveLength(1);
      expect(viewer.destroy).not.toHaveBeenCalled();
    });

    it('keeps edit mode and unsaved edits across toggles, with Save/Cancel available', async () => {
      await openText(app, 'people.csv', 'a,b\n1,2\n');
      app.filesStartEdit();
      await flush();
      const editor = grid.mounts[1];
      editor.onDirty();

      app.filesToggleGridMaximise();
      expect(buttonLabels()).toEqual(['Cancel', 'Save']);
      app.filesToggleGridMaximise();

      expect(app.filesState.current).toMatchObject({ editing: true, dirty: true, gridHandle: editor.doc });
      expect(grid.mounts).toHaveLength(2);
      expect(editor.destroy).not.toHaveBeenCalled();
    });

    it('Back (the history close fn) restores without popping again', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      app.filesToggleGridMaximise();

      // The browser has already popped the entry when popstate runs close().
      const entry = app.history.stack.pop()!;
      expect(entry.id).toBe('files-grid-max');
      entry.close();

      expect(isMaximised()).toBe(false);
      expect(app.filesState.gridMaximised).toBe(false);
      expect(app.history.pops).toEqual([]);
      expect(app.filesState.current).not.toBeNull();
    });

    it('Esc restores a maximised grid and is not handled otherwise', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      const esc = new KeyboardEvent('keydown', { key: 'Escape' });
      expect(app._filesGridHandleEscape(esc)).toBe(false);

      app.filesToggleGridMaximise();
      expect(app._filesGridHandleEscape(esc)).toBe(true);

      expect(isMaximised()).toBe(false);
      expect(app.history.pops).toEqual(['files-grid-max']);
      expect(esc.defaultPrevented).toBe(false);
      expect(app._filesGridHandleEscape(esc)).toBe(false);
    });

    it('Cancel from a maximised edit stays maximised in the viewer', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      app.filesStartEdit();
      await flush();
      app.filesToggleGridMaximise();

      app.filesCancelEdit();
      await flush();

      expect(isMaximised()).toBe(true);
      expect(grid.mounts.at(-1)!.mode).toBe('view');
      expect(buttonLabels()).toEqual(['Grid', 'Text', 'Edit', 'Copy']);
      expect(maxBtn()!.getAttribute('aria-pressed')).toBe('true');
      expect(maxBtn()!.title).toBe('Restore');
    });

    it.each([
      ['switching to the Text tab', (a: App) => a.filesSetTabularMode('text')],
      ['a grid failure', (a: App) => a._filesGridFallback(a.filesState.current, new Error('boom'))],
      ['opening another file', (a: App) => openText(a, 'notes.txt', 'hi')],
      ['rendering a binary file', (a: App) => a._filesRenderBinary({ type: 'image', path: 'x.png', size: 1 })],
      ['going back to the tree', (a: App) => a._doFilesBackToTree()],
      ['closing the sheet', (a: App) => a._doCloseFilesSheet()],
    ])('%s restores and pops the history entry', async (_label, leave) => {
      await openText(app, 'people.csv', 'a,b\n');
      app.filesToggleGridMaximise();
      expect(isMaximised()).toBe(true);

      await leave(app);
      await flush();

      expect(isMaximised()).toBe(false);
      expect(app.filesState.gridMaximised).toBe(false);
      expect(app.history.pops).toEqual(['files-grid-max']);
      expect(app.history.has('files-grid-max')).toBe(false);
    });

    it('opening the raw text editor restores', async () => {
      await openText(app, 'people.csv', 'a,b\n');
      app.filesToggleGridMaximise();
      app.filesState.tabularMode = 'text'; // e.g. Edit pressed while the Text tab is active

      app.filesStartEdit();

      expect(content().querySelector('textarea#filesSheetEditor')).not.toBeNull();
      expect(isMaximised()).toBe(false);
      expect(app.history.pops).toEqual(['files-grid-max']);
    });
  });
});

// ─── Source-text guards against the real app.js ─────────────────────────────

describe('src/web/public/app.js — GRID source guards', () => {
  const source = APP_JS_SOURCE;

  it('references vendor/grid.min.* only inside _filesEnsureGrid', () => {
    // Comment lines (e.g. the doc comment above the method) don't load anything.
    const code = (text: string) =>
      text
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
    const ensure = code(methodSource('_filesEnsureGrid'));
    for (const asset of ['vendor/grid.min.js', 'vendor/grid.min.css']) {
      expect(ensure).toContain(asset);
      expect(code(source).split(asset).length - 1, `${asset} referenced outside _filesEnsureGrid`).toBe(
        ensure.split(asset).length - 1
      );
    }
  });

  it('loads the bundle lazily: _filesEnsureGrid is only called from _filesMountGrid', () => {
    const calls = source.match(/_filesEnsureGrid\(\)/g) || [];
    // One call site plus the method definition itself.
    expect(calls).toHaveLength(2);
    expect(methodSource('_filesMountGrid')).toContain('await this._filesEnsureGrid()');
    expect(methodSource('_filesOpenSheetShell')).not.toContain('_filesEnsureGrid');
  });

  it('filesOverwriteCurrent forwards encoding in the PUT body', () => {
    expect(methodSource('filesOverwriteCurrent')).toMatch(/JSON\.stringify\(\{[^}]*\bencoding\b[^}]*\}\)/);
  });

  it('_tabularFormatOf agrees with tabularFormatOf in scripts/vendor/grid-tabular.mjs', () => {
    const app = new Function(`return ({\n${methodSource('_tabularFormatOf')}\n});`)();
    const paths = [
      'a.csv',
      'A.CSV',
      'x/y.tsv',
      'Book.XLSX',
      'old.Xls',
      'calc.ods',
      'notes.md',
      'csv',
      '',
      'a.csv.bak',
      'dir.csv/file',
      'weird.xlsx2',
      '.tsv',
    ];
    for (const p of paths) {
      expect(app._tabularFormatOf(p), p).toBe(tabularFormatOf(p));
    }
  });

  it('the global Escape handler lets a maximised grid restore before closeAllPanels()', () => {
    expect(methodSource('setupEventListeners')).toMatch(
      /if \(e\.key === 'Escape'\) \{\s*if \(!this\._filesGridHandleEscape\(e\)\) this\.closeAllPanels\(\);\s*\}/
    );
  });

  it('grid-entry load() detects the csv delimiter and never fits xlsx column widths', () => {
    const entry = gridEntrySource as string;
    const load = entry.slice(entry.indexOf('async function load('), entry.indexOf('function mount('));
    expect(load).toContain('detectDelimiter(text, format)');
    expect(load).not.toContain('delimiterOf(');
    expect(load).toContain('delimiterName: delimiterName(delimiter)');
    const xlsx = load.slice(load.indexOf("if (format === 'xlsx')"), load.indexOf("if (format === 'xls' ||"));
    expect(xlsx).toContain('Model.fromXLSX');
    expect(xlsx).not.toMatch(/setColumnWidth|fitUnsizedColumns|computeColumnWidths/);
  });

  it('grid-entry mount() does not mark a csv/tsv dirty for column/row resizes', () => {
    const entry = gridEntrySource as string;
    expect(entry).toMatch(/const SIZE_EVENTS = new Set\(\['resize-column', 'resize-row'\]\)/);
    const mount = entry.slice(entry.indexOf('function mount('), entry.indexOf('async function serialize('));
    const guard = mount.indexOf(
      "SIZE_EVENTS.has(type) && (handle.format === 'csv' || handle.format === 'tsv')) return;"
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(mount.indexOf('onDirty(type)'));
  });

  it('_filesMaxWriteBytes mirrors MAX_WRITE_SIZE in src/web/routes/file-routes.ts', () => {
    const backend = productConstant(FILE_ROUTES_SOURCE, 'const MAX_WRITE_SIZE', 'MAX_WRITE_SIZE');
    expect(classField('_filesMaxWriteBytes')).toBe(backend);
    expect(backend).toBe(5 * 1024 * 1024);
  });
});

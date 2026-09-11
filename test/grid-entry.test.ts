/**
 * @fileoverview GRID vendor bundle entry (scripts/vendor/grid-entry.mjs), the
 * code behind window.CodemanGrid that app.js lazy-loads for tabular files.
 *
 * The REAL @grid-is/spreadsheet-engine Model and the REAL SheetJS (xlsx) run
 * here: both work in node and take ~100 ms. So csv/tsv load -> serialize is a
 * true end-to-end round-trip through the engine, and xls/ods auto-fit is
 * checked against the widths the engine reports afterwards.
 *
 * Only the browser-only parts are mocked: react / react-dom (mount() renders
 * nothing; the element handed to render() is captured to reach the editor's
 * onChange), the viewer/editor components and their CSS. `window` and a
 * minimal `document` are stubbed because the entry assigns window.CodemanGrid
 * and fontConfig() reads document.baseURI. There is no canvas, so auto-fit uses
 * the pure estimate: 7.5 px per character + 16 px padding, clamped to 48..400.
 *
 * Edge cases the real SheetJS -> engine path cannot produce (pre-sized column
 * spans, huge sheets, a throwing sheet) use a fake model returned by a spy on
 * Model.fromXLSX.
 *
 * Run: npx vitest run test/grid-entry.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Model } from '@grid-is/spreadsheet-engine';
import * as XLSX from 'xlsx';

const rendered = vi.hoisted(() => ({ elements: [] as { type: unknown; props: Record<string, unknown> }[] }));

vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
}));
vi.mock('react-dom/client', () => ({
  createRoot: () => ({
    render: (element: { type: unknown; props: Record<string, unknown> }) => rendered.elements.push(element),
    unmount: () => {},
  }),
}));
vi.mock('@grid-is/spreadsheet-viewer', () => ({ SpreadsheetViewer: function SpreadsheetViewer() {} }));
vi.mock('@grid-is/spreadsheet-editor', () => ({ SpreadsheetEditor: function SpreadsheetEditor() {} }));
vi.mock('@grid-is/spreadsheet-viewer/style.css', () => ({}));
vi.mock('@grid-is/spreadsheet-editor/style.css', () => ({}));

interface EngineWorkbook {
  getSheets: () => { name: string; columns?: { start: number; end: number; size?: number }[] }[];
  getCell: (id: string, sheet: string) => { v: unknown } | undefined;
  columnWidth: (column1: number, sheet: string) => number;
}
interface Handle {
  format: string;
  filename?: string;
  model?: { getWorkbooks: () => EngineWorkbook[]; write: (ref: string, v: unknown) => void; recalculate: () => void };
  tooLarge?: boolean;
  cells?: number;
  delimiter?: string;
  delimiterName?: string;
  delimiterSource?: string;
  meta?: { sepLine: string; bom: boolean };
  structureChanged?: boolean;
}
type OnChange = (event: Record<string, unknown>) => void;
interface CodemanGrid {
  load: (opts: Record<string, unknown>) => Promise<Handle>;
  mount: (host: object, handle: Handle, opts: { mode?: string; onDirty?: (t: string) => void }) => { destroy(): void };
  serialize: (handle: Handle) => Promise<{ encoding: string; content: string }>;
}

let grid: CodemanGrid;

beforeAll(async () => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { baseURI: 'http://localhost:3001/' });
  // @ts-expect-error — plain ESM bundle entry without type declarations
  await import('../scripts/vendor/grid-entry.mjs');
  grid = (globalThis as unknown as { window: { CodemanGrid: CodemanGrid } }).window.CodemanGrid;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  rendered.elements.length = 0;
});

/** Workbook bytes of the given SheetJS bookType ('biff8' = .xls, 'ods', 'xlsx'). */
function workbookBytes(bookType: XLSX.BookType, sheets: Record<string, unknown[][]>): ArrayBuffer {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { bookType, type: 'array' }) as ArrayBuffer;
}

/** Minimal engine sheet over a 2D value array, as fitUnsizedColumns() reads it. */
function fakeSheet(name: string, rows: unknown[][], columns?: { start: number; end: number; size?: number | null }[]) {
  const right = Math.max(-1, ...rows.map((r) => r.length - 1));
  return {
    name,
    columns,
    *getCells() {
      for (const row of rows) for (const v of row) if (v !== '' && v != null) yield { v };
    },
    getBounds: () => ({ top: 0, left: 0, bottom: rows.length - 1, right }),
    getCellByRange: vi.fn(({ top, left }: { top: number; left: number }) => {
      const v = rows[top]?.[left];
      return v === '' || v == null ? undefined : { v };
    }),
  };
}

/** Runs load({format}) with Model.fromXLSX answering the fake sheets; returns the width calls. */
async function loadWithFakeSheets(format: 'xls' | 'ods', sheets: object[]) {
  const setColumnWidth = vi.fn();
  const workbook = { getSheets: () => sheets, setColumnWidth };
  vi.spyOn(Model, 'fromXLSX').mockResolvedValue({ getWorkbooks: () => [workbook] } as never);
  const bytes = workbookBytes(format === 'xls' ? 'biff8' : 'ods', { S: [['x']] });
  const handle = await grid.load({ format, bytes, filename: `book.${format}` });
  return { handle, setColumnWidth };
}

function editorOnChange(handle: Handle, onDirty: (t: string) => void): OnChange {
  grid.mount({}, handle, { mode: 'edit', onDirty });
  const element = rendered.elements.at(-1)!;
  expect((element.type as { name: string }).name).toBe('SpreadsheetEditor');
  return element.props.onChange as OnChange;
}

// ─── xls / ods auto-fit ─────────────────────────────────────────────────────

describe('load() xls/ods — fitUnsizedColumns', () => {
  for (const [format, bookType] of [
    ['xls', 'biff8'],
    ['ods', 'ods'],
  ] as const) {
    it(`${format}: fits each non-empty column at its own index and leaves empty columns at the default`, async () => {
      const bytes = workbookBytes(bookType, {
        Data: [
          ['id', null, 'a much longer header text here'],
          [7, null, 'x'],
        ],
        Empty: [],
      });
      const handle = await grid.load({ format, bytes, filename: `dir/book.${format}` });
      expect(handle.format).toBe(format);
      expect(handle.filename).toBe(`book.${format}`);
      const wb = handle.model!.getWorkbooks()[0];
      // columnWidth() is 1-based; "id" -> min 48, 30 chars -> 30 * 7.5 + 16 = 241, empty B keeps 65.
      expect(wb.columnWidth(1, 'Data')).toBe(48);
      expect(wb.columnWidth(2, 'Data')).toBe(65);
      expect(wb.columnWidth(3, 'Data')).toBe(241);
      expect(wb.getSheets().find((s) => s.name === 'Empty')!.columns ?? []).toEqual([]);
    });
  }

  it('xlsx is never fitted, so viewing cannot change the saved file', async () => {
    const bytes = workbookBytes('xlsx', { Data: [['id', 'a much longer header text here']] });
    const handle = await grid.load({ format: 'xlsx', bytes, filename: 'book.xlsx' });
    const wb = handle.model!.getWorkbooks()[0];
    expect(wb.getSheets()[0].columns ?? []).toEqual([]);
    expect(wb.columnWidth(2, 'Data')).toBe(65);
  });

  it('skips columns covered by a sized 1-based span, but treats a span without size as unsized', async () => {
    const long = 'a much longer header text here'; // 241 px
    const sheet = fakeSheet(
      'S',
      [
        [long, long, long, long],
        ['', '', '', ''],
      ],
      [
        { start: 1, end: 1, size: 100 }, // A sized
        { start: 2, end: 2, size: null }, // B unsized
        { start: 3, end: 4, size: 80 }, // C..D sized
      ]
    );
    const { setColumnWidth } = await loadWithFakeSheets('ods', [sheet]);
    expect(setColumnWidth.mock.calls).toEqual([['S', 1, 241]]);
  });

  it('rounds widths and skips empty columns and sheets without cells', async () => {
    const empty = fakeSheet('Empty', []);
    const sheet = fakeSheet('S', [
      ['abcdefg', '', 'x'], // 7 chars -> 68.5 px
      ['', '', ''],
    ]);
    const { setColumnWidth } = await loadWithFakeSheets('xls', [empty, sheet]);
    expect(setColumnWidth.mock.calls).toEqual([
      ['S', 0, 69],
      ['S', 2, 48],
    ]);
    expect(empty.getCellByRange).not.toHaveBeenCalled();
  });

  it('skips a sheet above 250k sampled cells without reading it', async () => {
    // 5000 rows sample to 2000; 2000 x 126 columns = 252,000 cells.
    const rows = Array.from({ length: 5000 }, () => [] as unknown[]);
    rows[0] = Array.from({ length: 126 }, () => 'wide');
    const huge = fakeSheet('Huge', rows);
    const small = fakeSheet('Small', [['abcdefg']]);
    const { setColumnWidth } = await loadWithFakeSheets('xls', [huge, small]);
    expect(huge.getCellByRange).not.toHaveBeenCalled();
    expect(setColumnWidth.mock.calls).toEqual([['Small', 0, 69]]);
  });

  it('a throwing sheet keeps its defaults, later sheets are still fitted and load resolves', async () => {
    const broken = fakeSheet('Broken', [['abcdefg']]);
    broken.getBounds = () => {
      throw new Error('boom');
    };
    const good = fakeSheet('Good', [['abcdefg']]);
    const { handle, setColumnWidth } = await loadWithFakeSheets('ods', [broken, good]);
    expect(handle.format).toBe('ods');
    expect(setColumnWidth.mock.calls).toEqual([['Good', 0, 69]]);
  });
});

// ─── csv / tsv load + serialize ─────────────────────────────────────────────

describe('load() csv/tsv — detected delimiter end to end', () => {
  it('parses a semicolon csv into cells, sizes its columns and records the delimiter', async () => {
    const text = 'name;description\nfoo;a much longer description\nbar;1,50\n';
    const handle = await grid.load({ format: 'csv', text, filename: 'dir/prices.csv' });
    expect(handle).toMatchObject({
      format: 'csv',
      filename: 'prices.csv',
      delimiter: ';',
      delimiterName: 'semicolon',
      delimiterSource: 'detected',
      rows: 3,
      cols: 2,
    });
    expect(handle.meta!.sepLine).toBe('');
    const wb = handle.model!.getWorkbooks()[0];
    const sheet = wb.getSheets()[0];
    expect(wb.getCell('A2', sheet.name)!.v).toBe('foo');
    expect(wb.getCell('B2', sheet.name)!.v).toBe('a much longer description');
    expect(wb.getCell('B3', sheet.name)!.v).toBe('1,50');
    // 4 chars -> min 48; 25 chars -> 25 * 7.5 + 16 = 203.5 -> 204.
    expect(sheet.columns).toEqual([
      { start: 1, end: 1, size: 48 },
      { start: 2, end: 2, size: 204 },
    ]);
    expect(wb.columnWidth(2, sheet.name)).toBe(204);
  });

  it('a BOM + sep=; file keeps the sep line in meta and out of the cells', async () => {
    const text = '\ufeffsep=;\r\nname;qty\r\nfoo;007\r\n';
    const handle = await grid.load({ format: 'csv', text, filename: 'bom.csv' });
    expect(handle).toMatchObject({ delimiter: ';', delimiterName: 'semicolon', delimiterSource: 'sep' });
    expect(handle.meta).toMatchObject({ bom: true, sepLine: 'sep=;\r\n' });
    const wb = handle.model!.getWorkbooks()[0];
    const name = wb.getSheets()[0].name;
    expect(wb.getCell('A1', name)!.v).toBe('name');
    expect(wb.getCell('B2', name)!.v).toBe('007');
  });

  it('a .tsv is tab-delimited whatever its content', async () => {
    const handle = await grid.load({ format: 'tsv', text: 'a;b\tc\n1;2\t3\n', filename: 'x.tsv' });
    expect(handle).toMatchObject({ delimiter: '\t', delimiterName: 'tab', delimiterSource: 'format', cols: 2 });
  });

  it('above maxCells returns tooLarge without building a model', async () => {
    const fromJSF = vi.spyOn(Model, 'fromJSF');
    const handle = await grid.load({ format: 'csv', text: 'a;b\n1;2\n', filename: 'x.csv', maxCells: 3 });
    expect(handle).toEqual({ format: 'csv', tooLarge: true, cells: 4 });
    expect(fromJSF).not.toHaveBeenCalled();
  });

  const roundTrips: [string, string][] = [
    ['semicolon csv with quoted ";" and decimal commas', 'item;price;note\nfoo;1,50;"x;y"\nbar;007;"say ""hi"""\n'],
    ['BOM + sep=; csv with CRLF', '\ufeffsep=;\r\nname;price\r\nfoo;1,5\r\nbar;2\r\n'],
  ];
  for (const [name, text] of roundTrips) {
    it(`serialize() of an unedited ${name} is byte-identical`, async () => {
      const handle = await grid.load({ format: 'csv', text, filename: 'round.csv' });
      expect(await grid.serialize(handle)).toEqual({ encoding: 'utf-8', content: text });
    });
  }
});

// ─── mount() editor onChange → dirty ────────────────────────────────────────

describe('mount() edit mode — what marks the file dirty', () => {
  it('csv/tsv column and row resizes are not unsaved changes', async () => {
    for (const format of ['csv', 'tsv']) {
      const text = format === 'csv' ? 'a;b\n1;2\n' : 'a\tb\n1\t2\n';
      const handle = await grid.load({ format, text, filename: `x.${format}` });
      const onDirty = vi.fn();
      const onChange = editorOnChange(handle, onDirty);
      onChange({ type: 'resize-column', sheetName: 'x', column: 0, width: 300 });
      onChange({ type: 'resize-row', sheetName: 'x', row: 0, height: 40 });
      onChange({ type: 'selection-change' });
      expect(onDirty, format).not.toHaveBeenCalled();
      expect(handle.structureChanged, format).toBeUndefined();
    }
  });

  it('xlsx resizes are saved with the workbook, so they mark it dirty', async () => {
    const bytes = workbookBytes('xlsx', { Data: [['a', 'b']] });
    const handle = await grid.load({ format: 'xlsx', bytes, filename: 'book.xlsx' });
    const onDirty = vi.fn();
    const onChange = editorOnChange(handle, onDirty);
    onChange({ type: 'resize-column' });
    onChange({ type: 'resize-row' });
    expect(onDirty.mock.calls).toEqual([['resize-column'], ['resize-row']]);
  });

  it('csv cell edits and structural edits still mark it dirty, and save with the detected delimiter', async () => {
    const handle = await grid.load({ format: 'csv', text: 'a;b\n1;2\n3;4\n', filename: 'x.csv' });
    const sheetName = handle.model!.getWorkbooks()[0].getSheets()[0].name;
    const onDirty = vi.fn();
    const onChange = editorOnChange(handle, onDirty);

    handle.model!.write(`'${sheetName}'!A2`, 'x;y');
    handle.model!.recalculate();
    onChange({ type: 'write-cell', cellId: 'A2', sheetName, value: 'x;y' });
    expect(onDirty.mock.calls).toEqual([['write-cell']]);
    expect(handle.structureChanged).toBeUndefined();
    expect((await grid.serialize(handle)).content).toBe('a;b\n"x;y";2\n3;4\n');

    onChange({ type: 'delete-rows' });
    expect(onDirty).toHaveBeenLastCalledWith('delete-rows');
    expect(handle.structureChanged).toBe(true);
  });
});

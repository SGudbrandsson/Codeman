/**
 * Pure CSV/TSV helpers behind the GRID spreadsheet view in the files sheet
 * (scripts/vendor/grid-tabular.mjs, bundled into vendor/grid.min.js).
 *
 * Covers format routing, RFC 4180 parsing, number detection, and — most
 * importantly — serialization: an unedited file must round-trip
 * byte-identically, while structural edits (deleted rows/columns) must shrink
 * the file instead of leaving phantom empty rows or columns behind.
 */

import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error — plain ESM helper without type declarations
import * as tabular from '../scripts/vendor/grid-tabular.mjs';

type Cell = string | number | boolean | null;
const {
  tabularFormatOf,
  formatInfo,
  parseDelimited,
  rowsToJsf,
  serializeDelimited,
  isCanonicalNumber,
  formatCellValue,
  columnName,
  sheetNameFor,
  detectDelimiter,
  delimiterName,
  computeColumnWidths,
  sampleRowIndexes,
} = tabular as {
  tabularFormatOf: (p: string) => string | null;
  formatInfo: (f: string | null) => { canEdit: boolean; saveMode: string | null; readOnlyReason: string | null };
  parseDelimited: (
    t: string,
    d?: string
  ) => {
    rows: string[][];
    meta: { bom: boolean; sepLine: string; eol: string; trailingEol: boolean; widths: number[] };
  };
  rowsToJsf: (
    rows: string[][],
    sheet?: string,
    file?: string,
    opts?: { columnWidths?: number[] }
  ) => {
    sheets: {
      cells: Record<string, { v: unknown }>;
      columns?: { start: number; end: number; size: number }[];
    }[];
  };
  detectDelimiter: (t: string, format: string) => { delimiter: string; source: string };
  delimiterName: (d: string) => string;
  computeColumnWidths: (
    rows: unknown[],
    opts?: {
      measure?: (s: string) => number;
      minWidth?: number;
      maxWidth?: number;
      padding?: number;
      sampleRows?: number;
      maxChars?: number;
    }
  ) => number[];
  sampleRowIndexes: (rowCount: number, sampleRows?: number) => number[];
  serializeDelimited: (grid: Cell[][], d?: string, meta?: object, opts?: { structureChanged?: boolean }) => string;
  isCanonicalNumber: (s: string) => boolean;
  formatCellValue: (v: unknown) => string;
  columnName: (index: number) => string;
  sheetNameFor: (filename: unknown) => string;
};

/**
 * Mirror of the bundle's load -> sheetToGrid path: parsed rows become JSF
 * cells (canonical numbers as numbers, empty fields as no cell) and the grid
 * is read back as a dense A1-anchored rectangle up to the used bounds.
 */
function gridOf(rows: string[][]): Cell[][] {
  const cells = rowsToJsf(rows, 'S', 's.csv').sheets[0].cells;
  let bottom = -1;
  let right = -1;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== '') {
        bottom = Math.max(bottom, r);
        right = Math.max(right, c);
      }
    }
  }
  const grid: Cell[][] = [];
  for (let r = 0; r <= bottom; r++) {
    const row: Cell[] = [];
    for (let c = 0; c <= right; c++) {
      const v = rows[r][c];
      row.push(v === undefined || v === '' ? '' : (cells[String.fromCharCode(65 + c) + (r + 1)].v as Cell));
    }
    grid.push(row);
  }
  return grid;
}

function roundTrip(text: string, delimiter = ','): string {
  const { rows, meta } = parseDelimited(text, delimiter);
  return serializeDelimited(gridOf(rows), delimiter, meta);
}

describe('tabularFormatOf / formatInfo', () => {
  it('routes tabular extensions case-insensitively and ignores others', () => {
    expect(tabularFormatOf('a/b/data.CSV')).toBe('csv');
    expect(tabularFormatOf('x.tsv')).toBe('tsv');
    expect(tabularFormatOf('Book.XLSX')).toBe('xlsx');
    expect(tabularFormatOf('old.Xls')).toBe('xls');
    expect(tabularFormatOf('sheet.ods')).toBe('ods');
    expect(tabularFormatOf('notes.md')).toBeNull();
    expect(tabularFormatOf('csv')).toBeNull();
    expect(tabularFormatOf('')).toBeNull();
  });

  it('allows editing csv/tsv/xlsx and keeps xls/ods read-only', () => {
    expect(formatInfo('csv')).toMatchObject({ canEdit: true, saveMode: 'text' });
    expect(formatInfo('tsv')).toMatchObject({ canEdit: true, saveMode: 'text' });
    expect(formatInfo('xlsx')).toMatchObject({ canEdit: true, saveMode: 'xlsx' });
    expect(formatInfo('xls')).toMatchObject({ canEdit: false, readOnlyReason: ".xls can't be saved in place" });
    expect(formatInfo('ods')).toMatchObject({ canEdit: false, readOnlyReason: ".ods can't be saved in place" });
    expect(formatInfo(null)).toMatchObject({ canEdit: false, saveMode: null });
  });
});

describe('parseDelimited', () => {
  it('handles quoted delimiters, "" escapes, embedded newlines, CRLF and BOM', () => {
    const { rows, meta } = parseDelimited('\ufeffa,"b,c"\r\n"say ""hi""","multi\r\nline"\r\n');
    expect(rows).toEqual([
      ['a', 'b,c'],
      ['say "hi"', 'multi\r\nline'],
    ]);
    expect(meta).toMatchObject({ bom: true, eol: '\r\n', trailingEol: true, widths: [2, 2] });
  });

  it('parses TSV and records blank lines and missing trailing EOL', () => {
    const { rows, meta } = parseDelimited('a\tb\n\n1\t2', '\t');
    expect(rows).toEqual([['a', 'b'], [''], ['1', '2']]);
    expect(meta).toMatchObject({ bom: false, eol: '\n', trailingEol: false, widths: [2, 0, 2] });
  });

  it('records an Excel sep= first line verbatim and keeps it out of the rows', () => {
    const crlf = parseDelimited('﻿sep=;\r\na;b\r\n1;2\r\n', ';');
    expect(crlf.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(crlf.meta).toMatchObject({
      bom: true,
      sepLine: 'sep=;\r\n',
      eol: '\r\n',
      trailingEol: true,
      widths: [2, 2],
    });

    const lf = parseDelimited('SEP=|\na|b\n', '|');
    expect(lf.rows).toEqual([['a', 'b']]);
    expect(lf.meta.sepLine).toBe('SEP=|\n');

    const eof = parseDelimited('sep=;', ';');
    expect(eof.rows).toEqual([]);
    expect(eof.meta).toMatchObject({ sepLine: 'sep=;', trailingEol: false, widths: [] });

    expect(parseDelimited('a;b\n', ';').meta.sepLine).toBe('');
  });

  it('falls back to the sep= line EOL when the body has none', () => {
    expect(parseDelimited('sep=;\r\na;b', ';').meta).toMatchObject({ sepLine: 'sep=;\r\n', eol: '\r\n' });
  });

  it('treats anything but "sep=" plus exactly one character on the first line as data', () => {
    for (const text of ['sep=;;\na;b\n', 'sep=\na;b\n', ' sep=;\na;b\n', 'a;b\nsep=;\n']) {
      const { rows, meta } = parseDelimited(text, ';');
      expect(meta.sepLine, JSON.stringify(text)).toBe('');
      expect(rows.length, JSON.stringify(text)).toBe(2);
    }
  });
});

describe('detectDelimiter', () => {
  const detect = (text: string, format = 'csv') => detectDelimiter(text, format);

  it.each([
    ['comma', 'a,b,c\n1,2,3\n', ','],
    ['semicolon', 'a;b;c\n1;2;3\n', ';'],
    ['tab in a .csv', 'a\tb\n1\t2\n', '\t'],
    ['pipe', 'a|b|c\n1|2|3\n', '|'],
    ['semicolons inside quoted comma fields', 'name,note\nfoo,"a;b"\nbar,"c;d"\n', ','],
    ['semicolon file with quoted semicolons', 'a;b\n"x;y";2\n"p;q";3\n', ';'],
    ['quoted comma in a semicolon file', 'name;price\n"Smith, J";1,50\n"Doe, A";2,75\n', ';'],
    ['embedded newline inside quotes', 'a;b\n"line1\nline2, more";2\n3;4\n', ';'],
    ['decimal commas with a header', 'a;b\n1,50;2,75\n3,10;4,20\n', ';'],
    ['decimal commas without a header', '1,50;2,75\n3,10;4,20\n', ';'],
    ['dot-thousands decimal', '1.234,56;7\n', ';'],
    ['ragged semicolon file with a title line', 'Report\na;b;c\n1;2;3\n4;5;6\n7;8;9\n10;11;12\n', ';'],
    ['CRLF semicolon', 'a;b\r\n1;2\r\n', ';'],
  ])('%s', (_name, text, want) => {
    expect(detect(text)).toEqual({ delimiter: want, source: 'detected' });
  });

  it('handles a UTF-8 BOM', () => {
    expect(detect('﻿a;b\n1;2\n')).toEqual({ delimiter: ';', source: 'detected' });
  });

  it.each([
    ['sep=; LF overriding comma-looking content', 'sep=;\na,b,c\n1,2,3\n', ';'],
    ['sep=| CRLF', 'sep=|\r\na,b\r\n1,2\r\n', '|'],
    ['BOM + sep=;', '﻿sep=;\na;b\n', ';'],
    ['sep= only, no EOL', 'sep=;', ';'],
    ['upper-case SEP=', 'SEP=\t\na,b\n', '\t'],
  ])('honours an Excel %s', (_name, text, want) => {
    expect(detect(text)).toEqual({ delimiter: want, source: 'sep' });
  });

  it.each([
    ['single column', 'a\nb\nc\n'],
    ['empty file', ''],
    ['blank lines only', '\n\r\n\n'],
    ['inconsistent field counts', 'a;b\nc\nd,e,f\ng|h|i|j\n'],
  ])('falls back to comma for %s', (_name, text) => {
    expect(detect(text)).toEqual({ delimiter: ',', source: 'default' });
  });

  it('keeps comma when a tie has no decimal-comma evidence', () => {
    expect(detect('a,b|c\n1,2|3\n')).toEqual({ delimiter: ',', source: 'detected' });
    expect(detect('a,b;c\nd,e;f\n')).toEqual({ delimiter: ',', source: 'detected' });
  });

  it('skips blank lines when scoring records', () => {
    // Counted as 1-field records, the blank lines would drop semicolon below
    // 80% consistency and the file would open as a single column.
    expect(detect('a;b\n1;2\n\n\n')).toEqual({ delimiter: ';', source: 'detected' });
    expect(detect('a;b\n1;2\n\n3;4\n\n5;6\n')).toEqual({ delimiter: ';', source: 'detected' });
  });

  it('ends a record at CRLF while detecting', () => {
    // A Windows Excel European export: a trailing '\r' in the last field would
    // break the decimal-comma evidence, and '\r'-only blank lines would count
    // as records.
    expect(detect('1,50;2,75\r\n3,10;4,20\r\n')).toEqual({ delimiter: ';', source: 'detected' });
    expect(detect('a;b\r\n1;2\r\n\r\n\r\n')).toEqual({ delimiter: ';', source: 'detected' });
  });

  it('prefers a clean candidate over one with stray quotes', () => {
    // Comma splits every record evenly into 2 fields, but only by cutting the
    // quoted "b,c" field in half (a '"' mid-field), so its scan is dirty.
    expect(detect('a;"b,c";d\ne;"f,g";h\n')).toEqual({ delimiter: ';', source: 'detected' });
    expect(detect('id;"Smith, J";3\nid;"Doe, A";4\n')).toEqual({ delimiter: ';', source: 'detected' });
  });

  it('marks text right after a closing quote as a bad fit', () => {
    // Comma splits every record evenly into 2 fields, but only by leaving
    // ";Oslo" right after the closing quote, so its scan is dirty. With no
    // decimal-comma evidence a clean tie would go to comma.
    expect(detect('"ACME Corp";Oslo, Norway\n"Beta Ltd";Bergen, Norway\n')).toEqual({
      delimiter: ';',
      source: 'detected',
    });
  });

  it('falls back to a candidate with stray quotes when none is clean', () => {
    expect(detect('a;b"c\nd;e"f\n')).toEqual({ delimiter: ';', source: 'detected' });
  });

  it('does not open a quoted field at a mid-field quote (inch marks)', () => {
    // An odd number of inch marks: opening a quoted section at 27" would
    // swallow the rest of the sample into one field, drop the delimiter below
    // 80% consistency and open the file as a single column.
    expect(detect('Product;Price\nMonitor 27";199\nKeyboard;49\nMouse;19\nDesk;299\n')).toEqual({
      delimiter: ';',
      source: 'detected',
    });
    expect(detect('Item;Size;Price\nMonitor 27";1;199\nTV;2;499\nLaptop;3;999\nPhone;4;599\n')).toEqual({
      delimiter: ';',
      source: 'detected',
    });
    expect(detect('Product\tPrice\nMonitor 27"\t199\nKeyboard\t49\nMouse\t19\nDesk\t299\n')).toEqual({
      delimiter: '\t',
      source: 'detected',
    });
  });

  it('prefers higher consistency before the tie-break', () => {
    // Comma is valid at exactly 0.8 (4 of 5 records have 2 fields) and would
    // win a tie with no decimal-comma evidence; semicolon is 1.0.
    expect(detect('Smith, J;3\nDoe, A;4\nRoe, B;5\nLee, C;6\nsolo;7\n')).toEqual({
      delimiter: ';',
      source: 'detected',
    });
  });

  it('treats exactly 80% consistency as valid and 75% as not', () => {
    // A semicolon export with a title line: 4 of 5 records have 2 fields.
    expect(detect('Report\na;b\n1;2\n3;4\n4;5\n')).toEqual({ delimiter: ';', source: 'detected' });
    expect(detect('a;b\n1;2\n3;4\n5;6\nsolo\n')).toEqual({ delimiter: ';', source: 'detected' });
    // One data record fewer: 3 of 4 records have 2 fields, below the threshold.
    expect(detect('Report\na;b\n1;2\n3;4\n')).toEqual({ delimiter: ',', source: 'default' });
  });

  it('breaks non-comma ties tab > semicolon > pipe', () => {
    expect(detect('a\tb;c|d\n').delimiter).toBe('\t');
    expect(detect('a;b|c\n').delimiter).toBe(';');
  });

  it('keeps .tsv on tab whatever the content looks like', () => {
    expect(detect('a,b,c\n1,2,3\n', 'tsv')).toEqual({ delimiter: '\t', source: 'format' });
    expect(detect('sep=;\na;b\n', 'tsv')).toEqual({ delimiter: '\t', source: 'format' });
  });

  it('only samples the first 50 records', () => {
    expect(detect('a;b\n'.repeat(50) + '1,2,3\n'.repeat(1000)).delimiter).toBe(';');
    // With fewer leading semicolon records the sampled comma rows dominate.
    expect(detect('a;b\n'.repeat(5) + '1,2,3\n'.repeat(1000)).delimiter).toBe(',');
  });

  it('drops a record cut off by the 64 KB sample limit', () => {
    // 3 semicolon records, then one ~70 KB line with no semicolon. Counted, it
    // would make semicolon 3/4 consistent (invalid); dropped, it is 3/3.
    const text = 'a;b\n1;2\n3;4\n' + 'x,'.repeat(35 * 1024) + 'y\n';
    expect(detect(text)).toEqual({ delimiter: ';', source: 'detected' });
  });
});

describe('delimiterName', () => {
  it('names the common delimiters and JSON-quotes anything else', () => {
    expect(delimiterName(',')).toBe('comma');
    expect(delimiterName(';')).toBe('semicolon');
    expect(delimiterName('\t')).toBe('tab');
    expect(delimiterName('|')).toBe('pipe');
    expect(delimiterName('#')).toBe('"#"');
  });
});

describe('computeColumnWidths / rowsToJsf columnWidths', () => {
  const byLength = (s: string) => s.length * 10;

  it('clamps to [minWidth, maxWidth] and adds padding', () => {
    const widths = computeColumnWidths([['a', 'x'.repeat(100), 'abcdefgh']], { measure: byLength });
    expect(widths).toEqual([48, 400, 96]);
  });

  it('measures the longest line of multi-line cells, cut to maxChars', () => {
    const measure = vi.fn(byLength);
    computeColumnWidths([['ab\nabcdef\r\nabc', 'y'.repeat(500)]], { measure, maxWidth: 10000 });
    expect(measure).toHaveBeenCalledWith('abcdef');
    expect(measure).toHaveBeenCalledWith('y'.repeat(200));
  });

  it('gives empty columns no width and handles ragged rows', () => {
    const widths = computeColumnWidths([['a', '', 'c'], ['b'], [], ['', '', '', 'long text here']], {
      measure: byLength,
    });
    expect(widths).toEqual([48, 0, 48, 156]);
  });

  it('uses a pure estimate by default', () => {
    expect(computeColumnWidths([['id', 'a long description here']])).toEqual([48, 188.5]);
  });

  it('stops measuring a column once it reaches maxWidth', () => {
    const measure = vi.fn(() => 1000);
    computeColumnWidths([['a'], ['b'], ['c']], { measure });
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('samples large sheets: bounded work, header and last row included', () => {
    const rows = Array.from({ length: 10000 }, (_, r) => [`v${r}`]);
    const measure = vi.fn((s: string) => s.length);
    computeColumnWidths(rows, { measure, maxWidth: 10000 });
    expect(measure.mock.calls.length).toBeLessThanOrEqual(2000);
    const seen = measure.mock.calls.map((c) => c[0]);
    expect(seen).toContain('v0');
    expect(seen).toContain('v999');
    expect(seen).toContain('v9999');
  });

  it('sampleRowIndexes: every row up to the budget, then head + strided tail', () => {
    expect(sampleRowIndexes(3, 10)).toEqual([0, 1, 2]);
    const idx = sampleRowIndexes(10000, 2000);
    expect(idx).toHaveLength(2000);
    expect(idx.slice(0, 1000)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(idx.at(-1)).toBe(9999);
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });

  it('rowsToJsf emits 1-based rounded column spans only for sized columns', () => {
    const sheet = rowsToJsf([['a', 'b', 'c']], 'S', 's.csv', { columnWidths: [60.4, 0, 120.6] }).sheets[0];
    expect(sheet.columns).toEqual([
      { start: 1, end: 1, size: 60 },
      { start: 3, end: 3, size: 121 },
    ]);
  });

  it('rowsToJsf omits columns without widths', () => {
    expect(rowsToJsf([['a']], 'S', 's.csv').sheets[0]).not.toHaveProperty('columns');
    expect(rowsToJsf([['a']], 'S', 's.csv', { columnWidths: [0] }).sheets[0]).not.toHaveProperty('columns');
  });
});

describe('columnName / sheetNameFor', () => {
  it('maps zero-based column indexes to spreadsheet letters past Z', () => {
    const cases: [number, string][] = [
      [0, 'A'],
      [25, 'Z'],
      [26, 'AA'],
      [51, 'AZ'],
      [52, 'BA'],
      [701, 'ZZ'],
      [702, 'AAA'],
      [18277, 'ZZZ'],
      [18278, 'AAAA'],
    ];
    for (const [index, name] of cases) expect(columnName(index), String(index)).toBe(name);
  });

  it('places cells of a CSV wider than 26 columns at AA, AZ, BA…', () => {
    const header = Array.from({ length: 60 }, (_, c) => `h${c}`).join(',');
    const { rows } = parseDelimited(header + '\n');
    const cells = rowsToJsf(rows).sheets[0].cells;

    expect(Object.keys(cells)).toHaveLength(60);
    expect(cells.Z1).toEqual({ v: 'h25' });
    expect(cells.AA1).toEqual({ v: 'h26' });
    expect(cells.AZ1).toEqual({ v: 'h51' });
    expect(cells.BA1).toEqual({ v: 'h52' });
    expect(cells.BH1).toEqual({ v: 'h59' });
    // A naive String.fromCharCode(65 + c) would put column 26 at '[1'.
    expect(cells).not.toHaveProperty('[1');
  });

  it('derives a legal Excel sheet name from the filename', () => {
    expect(sheetNameFor('reports/2024/Budget Q1.csv')).toBe('Budget Q1');
    expect(sheetNameFor('archive.tar.tsv')).toBe('archive.tar');
    expect(sheetNameFor('a[b]:c*d?e\\f.csv')).toBe('abcdef');
    expect(sheetNameFor("'quoted'.csv")).toBe('quoted');
    expect(sheetNameFor("it's.csv")).toBe("it's");
  });

  it('caps sheet names at 31 characters and trims the cut', () => {
    expect(sheetNameFor('x'.repeat(40) + '.csv')).toBe('x'.repeat(31));
    expect(sheetNameFor('a'.repeat(30) + ' tail.csv')).toBe('a'.repeat(30));
  });

  it('falls back to Sheet1 when nothing legal is left', () => {
    for (const name of ['', '.csv', '[]:*?.tsv', "''.csv", 'dir/', null, undefined]) {
      expect(sheetNameFor(name), String(name)).toBe('Sheet1');
    }
  });
});

describe('number detection', () => {
  it('only treats canonical numbers as numbers', () => {
    expect(isCanonicalNumber('10')).toBe(true);
    expect(isCanonicalNumber('-1.5')).toBe(true);
    for (const s of ['007', '1.50', '1e3', ' 1', 'NaN', 'Infinity', '2024-01-01', '']) {
      expect(isCanonicalNumber(s)).toBe(false);
    }
  });

  it('keeps "=" strings literal and drops empty fields', () => {
    const cells = rowsToJsf([['=1+1', '', '007', '42']]).sheets[0].cells;
    expect(cells).toEqual({ A1: { v: '=1+1' }, C1: { v: '007' }, D1: { v: 42 } });
  });

  it('formats booleans and errors like a CSV export', () => {
    expect(formatCellValue(true)).toBe('TRUE');
    expect(formatCellValue(false)).toBe('FALSE');
    expect(formatCellValue('#DIV/0!')).toBe('#DIV/0!');
    expect(formatCellValue(null)).toBe('');
  });
});

describe('serializeDelimited — unedited round-trip is byte-identical', () => {
  const fixtures: [string, string, string][] = [
    ['LF with trailing newline', 'a,b,c\n1,2,3\n4,5,6\n', ','],
    ['LF without trailing newline', 'a,b,c\n1,2,3', ','],
    ['CRLF', 'a,b\r\n1,2\r\n', ','],
    ['BOM + CRLF', '\ufeffname,qty\r\nfoo,007\r\n', ','],
    ['BOM without trailing newline', '\ufeffx,y\n1,2', ','],
    ['quoting and literal formulas', 'n,note\nfoo,"x,y"\nbar,"say ""hi"""\nbaz,=1+1\n', ','],
    ['embedded newline', 'a,b\n"line1\nline2",2\n', ','],
    ['ragged rows and blank lines', 'a,b\n1\n\nx,y,z\n', ','],
    ['rectangular with empty trailing column', 'a,b,\n1,2,\n', ','],
    ['numbers that must stay text', 'v\n1.50\n1e3\n007\n2024-01-01\n', ','],
    ['TSV', 'a\tb\n1\t2\n', '\t'],
    ['TSV CRLF with tab in quotes', 'a\tb\r\n"x\ty"\t2\r\n', '\t'],
    ['empty file', '', ','],
    ['semicolon LF', 'a;b;c\n1;2;3\n', ';'],
    ['semicolon CRLF + BOM', '﻿name;qty\r\nfoo;007\r\n', ';'],
    ['decimal commas stay unquoted in a semicolon file', 'item;price\nfoo;1,50\nbar;1.234,56\n', ';'],
    ['pipe', 'a|b\n1|2\n', '|'],
    ['quoted ";" inside a semicolon file', 'a;b\n"x;y";2\n"say ""hi""";3\n', ';'],
    ['sep=; line with CRLF', 'sep=;\r\na;b\r\n1,50;2\r\n', ';'],
    ['BOM + sep=; line', '﻿sep=;\na;b\n1;2\n', ';'],
    ['sep= line only, LF', 'sep=;\n', ';'],
    ['sep= line only, no EOL', 'sep=|', '|'],
  ];
  for (const [name, text, delimiter] of fixtures) {
    it(name, () => {
      expect(roundTrip(text, delimiter)).toBe(text);
    });
  }

  it('detectDelimiter picks each fixture delimiter, and the detected round-trip is byte-identical', () => {
    for (const [name, text, delimiter] of fixtures) {
      const format = delimiter === '\t' ? 'tsv' : 'csv';
      const detected = detectDelimiter(text, format).delimiter;
      expect(detected, name).toBe(delimiter);
      expect(roundTrip(text, detected), name).toBe(text);
    }
  });

  it('value-only edits in a BOM + sep=; semicolon file change only the edited cell', () => {
    const text = '﻿sep=;\r\nname;price\r\nfoo;1,50\r\nbar;2\r\n';
    const { rows, meta } = parseDelimited(text, detectDelimiter(text, 'csv').delimiter);
    const grid = gridOf(rows);
    grid[1][1] = '9,99';
    grid[2][0] = 'x;y';
    expect(serializeDelimited(grid, ';', meta)).toBe('﻿sep=;\r\nname;price\r\nfoo;9,99\r\n"x;y";2\r\n');
  });

  it('a structural edit keeps the BOM and sep= line', () => {
    const text = '﻿sep=;\r\nname;price\r\nfoo;1,50\r\nbar;2\r\n';
    const { rows, meta } = parseDelimited(text, ';');
    const grid = gridOf(rows).slice(0, 2);
    expect(serializeDelimited(grid, ';', meta, { structureChanged: true })).toBe(
      '﻿sep=;\r\nname;price\r\nfoo;1,50\r\n'
    );
  });

  it('value-only edits keep the rest of the file untouched', () => {
    const text = '\ufeffa,b\r\n1\r\n\r\nx,y,z\r\n';
    const { rows, meta } = parseDelimited(text);
    const grid = gridOf(rows);
    grid[0][0] = 'A';
    expect(serializeDelimited(grid, ',', meta)).toBe('\ufeffA,b\r\n1\r\n\r\nx,y,z\r\n');
  });
});

describe('serializeDelimited — structural edits shrink the file', () => {
  const base = 'a,b,c\n1,2,3\n4,5,6\n7,8,9\n';

  it('deleting the last rows drops them instead of writing ",," rows', () => {
    const { rows, meta } = parseDelimited(base);
    const grid = gridOf(rows).slice(0, 2); // engine bounds shrink after delete-rows
    expect(serializeDelimited(grid, ',', meta, { structureChanged: true })).toBe('a,b,c\n1,2,3\n');
  });

  it('drops trailing empty rows even if the grid still reports them', () => {
    const { rows, meta } = parseDelimited(base);
    const grid = gridOf(rows);
    grid[2] = ['', '', ''];
    grid[3] = ['', '', ''];
    expect(serializeDelimited(grid, ',', meta, { structureChanged: true })).toBe('a,b,c\n1,2,3\n');
  });

  it('deleting the last column drops it instead of a trailing empty column', () => {
    const { rows, meta } = parseDelimited(base);
    const grid = gridOf(rows).map((r) => r.slice(0, 2));
    expect(serializeDelimited(grid, ',', meta, { structureChanged: true })).toBe('a,b\n1,2\n4,5\n7,8\n');
  });

  it('deleting a middle column keeps the file rectangular', () => {
    const { rows, meta } = parseDelimited('a,b,c\n1,,3\n');
    const grid = gridOf(rows).map((r) => [r[0], r[2]]);
    expect(serializeDelimited(grid, ',', meta, { structureChanged: true })).toBe('a,c\n1,3\n');
  });

  it('ragged file with the last row deleted writes no phantom row', () => {
    const { rows, meta } = parseDelimited('a,b\n1\n\nx,y,z\n');
    const grid = gridOf(rows).slice(0, 2);
    expect(serializeDelimited(grid, ',', meta, { structureChanged: true })).toBe('a,b\n1\n');
  });

  it('ragged file keeps interior blank lines after a structural edit', () => {
    const { rows, meta } = parseDelimited('a,b\n1\n\nx,y,z\nlast\n');
    const grid = gridOf(rows).slice(0, 4);
    expect(serializeDelimited(grid, ',', meta, { structureChanged: true })).toBe('a,b\n1\n\nx,y,z\n');
  });

  it('keeps BOM, CRLF and the trailing-EOL choice', () => {
    const { rows, meta } = parseDelimited('\ufeffa,b,c\r\n1,2,3\r\n4,5,6');
    const grid = gridOf(rows).slice(0, 2);
    expect(serializeDelimited(grid, ',', meta, { structureChanged: true })).toBe('\ufeffa,b,c\r\n1,2,3');
  });

  it('inserted rows in the middle are written padded', () => {
    const { rows, meta } = parseDelimited('a,b\n1,2\n');
    const grid = gridOf(rows);
    grid.splice(1, 0, ['', '']);
    expect(serializeDelimited(grid, ',', meta, { structureChanged: true })).toBe('a,b\n,\n1,2\n');
  });

  it('deleting every row writes an empty file', () => {
    const { meta } = parseDelimited(base);
    expect(serializeDelimited([], ',', meta, { structureChanged: true })).toBe('');
  });
});

describe('serializeDelimited — documented edge cases', () => {
  it('normalizes redundant quoting when an unedited file is saved', () => {
    // Within spec (only canonical input round-trips byte-identically).
    expect(roundTrip('a,"b"\n')).toBe('a,b\n');
    expect(roundTrip('"",""\n')).toBe(',\n');
  });

  it('keeps an interior blank line of an unedited rectangular file', () => {
    expect(roundTrip('a,b,c\n1,2,3\n\n4,5,6\n')).toBe('a,b,c\n1,2,3\n\n4,5,6\n');
  });

  it('pads an interior blank line of a rectangular file to full width after a structural edit', () => {
    // Pins current behaviour (review attempt 2 nit): once structureChanged is
    // set, meta.widths is ignored, so the blank line becomes an empty ",," row.
    const { rows, meta } = parseDelimited('a,b,c\n1,2,3\n\n4,5,6\n');
    const grid = gridOf(rows).slice(1); // header row deleted
    expect(serializeDelimited(grid, ',', meta, { structureChanged: true })).toBe('1,2,3\n,,\n4,5,6\n');
  });
});

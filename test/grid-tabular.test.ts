/**
 * Pure CSV/TSV helpers behind the GRID spreadsheet view in the files sheet
 * (scripts/vendor/grid-tabular.mjs, bundled into vendor/grid.min.js).
 *
 * Covers format routing, RFC 4180 parsing, number detection, and — most
 * importantly — serialization: an unedited file must round-trip
 * byte-identically, while structural edits (deleted rows/columns) must shrink
 * the file instead of leaving phantom empty rows or columns behind.
 */

import { describe, it, expect } from 'vitest';
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
} = tabular as {
  tabularFormatOf: (p: string) => string | null;
  formatInfo: (f: string | null) => { canEdit: boolean; saveMode: string | null; readOnlyReason: string | null };
  parseDelimited: (
    t: string,
    d?: string
  ) => { rows: string[][]; meta: { bom: boolean; eol: string; trailingEol: boolean; widths: number[] } };
  rowsToJsf: (
    rows: string[][],
    sheet?: string,
    file?: string
  ) => { sheets: { cells: Record<string, { v: unknown }> }[] };
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
  ];
  for (const [name, text, delimiter] of fixtures) {
    it(name, () => {
      expect(roundTrip(text, delimiter)).toBe(text);
    });
  }

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

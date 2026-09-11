// Pure, dependency-free helpers for the GRID spreadsheet view in the files
// sheet. Bundled into dist/web/public/vendor/grid.min.js via grid-entry.mjs and
// imported directly by unit tests (test/grid-tabular.test.ts).
//
// Format matrix (see TASK.md §3):
//   csv / tsv -> parsed client-side to JSF, edited in GRID, saved back as text
//   xlsx      -> engine reads and writes natively, saved back as base64 bytes
//   xls / ods -> converted to xlsx with SheetJS for viewing only (read-only)
//
// app.js carries an inline replica of tabularFormatOf() (_tabularFormatOf) so
// it can route a file before this bundle has loaded — keep the two in sync.

export const TABULAR_FORMATS = ['csv', 'tsv', 'xlsx', 'xls', 'ods'];

/** 'csv' | 'tsv' | 'xlsx' | 'xls' | 'ods' | null, by extension (case-insensitive). */
export function tabularFormatOf(path) {
  const m = /\.([A-Za-z]+)$/.exec(String(path || ''));
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return TABULAR_FORMATS.includes(ext) ? ext : null;
}

/** What the files sheet may do with a tabular format. */
export function formatInfo(format) {
  switch (format) {
    case 'csv':
    case 'tsv':
      return { canEdit: true, saveMode: 'text', readOnlyReason: null };
    case 'xlsx':
      return { canEdit: true, saveMode: 'xlsx', readOnlyReason: null };
    case 'xls':
    case 'ods':
      return { canEdit: false, saveMode: null, readOnlyReason: `.${format} can't be saved in place` };
    default:
      return { canEdit: false, saveMode: null, readOnlyReason: null };
  }
}

export function delimiterOf(format) {
  return format === 'tsv' ? '\t' : ',';
}

/**
 * RFC 4180-style parser: quoted fields, "" escapes, embedded delimiters and
 * newlines, CRLF or LF line endings and a leading BOM.
 *
 * meta records what serializeDelimited() needs to write the file back the way
 * it came in: BOM, EOL style, whether the last line ended with an EOL, and the
 * field count of every row (0 = blank line) so ragged rows and blank lines
 * survive an unmodified round-trip.
 *
 * @returns {{ rows: string[][], meta: { bom: boolean, eol: '\r\n'|'\n', trailingEol: boolean, widths: number[] } }}
 */
export function parseDelimited(text, delimiter = ',') {
  let s = String(text == null ? '' : text);
  const bom = s.charCodeAt(0) === 0xfeff;
  if (bom) s = s.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let fieldQuoted = false;
  let inQuotes = false;
  let eol = null;
  const n = s.length;
  let i = 0;

  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    fieldQuoted = false;
  };

  while (i < n) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '' && !fieldQuoted) {
      inQuotes = true;
      fieldQuoted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      fieldQuoted = false;
      i++;
      continue;
    }
    if (c === '\r' && s[i + 1] === '\n') {
      if (eol === null) eol = '\r\n';
      endRow();
      i += 2;
      continue;
    }
    if (c === '\n') {
      if (eol === null) eol = '\n';
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }

  let trailingEol = false;
  if (field !== '' || fieldQuoted || row.length > 0 || inQuotes) {
    endRow();
  } else {
    trailingEol = rows.length > 0;
  }

  const widths = rows.map((r) => (r.length === 1 && r[0] === '' ? 0 : r.length));
  return { rows, meta: { bom, eol: eol || '\n', trailingEol, widths } };
}

/** 0 -> 'A', 25 -> 'Z', 26 -> 'AA'. */
export function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/**
 * A field becomes a number only when it round-trips exactly through Number(),
 * so 007, 1.50, 1e3, " 1", NaN and Infinity all stay strings and a saved file
 * never silently rewrites them.
 */
export function isCanonicalNumber(s) {
  if (typeof s !== 'string' || s === '') return false;
  const num = Number(s);
  return Number.isFinite(num) && String(num) === s;
}

/** Excel-style sheet name from a filename: extension dropped, illegal chars removed, 31 chars max. */
export function sheetNameFor(filename) {
  const base = String(filename || '')
    .split('/')
    .pop()
    .replace(/\.[^.]*$/, '')
    .replace(/[\[\]:*?/\\]/g, '')
    .replace(/^'+|'+$/g, '')
    .slice(0, 31)
    .trim();
  return base || 'Sheet1';
}

/**
 * Rows -> JSF workbook with one sheet. Empty strings produce no cell; strings
 * starting with '=' stay literal values (never formulas).
 */
export function rowsToJsf(rows, sheetName, filename) {
  const cells = {};
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const s = row[c];
      if (s === '' || s == null) continue;
      cells[columnName(c) + (r + 1)] = { v: isCanonicalNumber(s) ? Number(s) : String(s) };
    }
  }
  return { name: filename || 'workbook', sheets: [{ name: sheetName || 'Sheet1', cells }] };
}

/** Cell value -> CSV text: booleans as TRUE/FALSE, errors via their string form (#DIV/0!). */
export function formatCellValue(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v);
}

function quoteField(text, delimiter) {
  if (text.includes(delimiter) || text.includes('"') || text.includes('\r') || text.includes('\n')) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

/**
 * Grid -> delimited text. Fields are quoted only when they contain the
 * delimiter, '"', CR or LF. The original BOM, EOL style and trailing-EOL
 * presence are kept.
 *
 * Without structural edits, row widths follow meta.widths: a rectangular
 * source stays rectangular (padded to the widest row), a ragged source keeps
 * each row's original field count unless the row grew. An unmodified
 * parseDelimited() -> serializeDelimited() round-trip of canonical input is
 * byte-identical, and value-only edits keep every other line untouched.
 *
 * opts.structureChanged (rows/columns/cells were inserted, deleted or moved):
 * meta.widths no longer lines up with the grid, so it is not used to pad.
 * Trailing all-empty rows are dropped and the output is sized to the used
 * range instead — a rectangular source is padded to the widest used row, a
 * ragged source writes each row up to its last non-empty field. Deleting the
 * last rows or columns therefore shrinks the file instead of leaving ",,"
 * rows or trailing empty columns behind.
 */
export function serializeDelimited(grid, delimiter = ',', meta = {}, opts = {}) {
  const eol = meta.eol || '\n';
  const structureChanged = !!(opts && opts.structureChanged);
  const widths = Array.isArray(meta.widths) ? meta.widths : [];
  const rowsIn = Array.isArray(grid) ? grid : [];

  const lastFilled = (row) => {
    if (!Array.isArray(row)) return 0;
    for (let c = row.length - 1; c >= 0; c--) {
      if (formatCellValue(row[c]) !== '') return c + 1;
    }
    return 0;
  };

  const used = rowsIn.map(lastFilled);
  let lastRow = 0;
  for (let r = 0; r < used.length; r++) if (used[r] > 0) lastRow = r + 1;
  const nRows = structureChanged ? lastRow : Math.max(widths.length, lastRow);

  const nonBlank = widths.filter((w) => w > 0);
  const rectangular = nonBlank.length > 0 && nonBlank.every((w) => w === nonBlank[0]);
  let globalWidth = null;
  if (rectangular) globalWidth = Math.max(structureChanged ? 0 : nonBlank[0], ...used, 0);

  const lines = [];
  for (let r = 0; r < nRows; r++) {
    const row = rowsIn[r] || [];
    const filled = used[r] || 0;
    const orig = !structureChanged && r < widths.length ? widths[r] : undefined;
    if (orig === 0 && filled === 0) {
      lines.push('');
      continue;
    }
    const width = globalWidth != null ? globalWidth : Math.max(orig || 0, filled);
    const out = [];
    for (let c = 0; c < width; c++) out.push(quoteField(formatCellValue(row[c]), delimiter));
    lines.push(out.join(delimiter));
  }

  let text = lines.join(eol);
  if (meta.trailingEol && nRows > 0) text += eol;
  return (meta.bom ? '\ufeff' : '') + text;
}

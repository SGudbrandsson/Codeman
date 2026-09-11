// Pure, dependency-free helpers for the GRID spreadsheet view in the files
// sheet. Bundled into dist/web/public/vendor/grid.min.js via grid-entry.mjs and
// imported directly by unit tests (test/grid-tabular.test.ts).
//
// Format matrix (see TASK.md §3):
//   csv / tsv -> delimiter detected (detectDelimiter), parsed client-side to
//                JSF with auto-fit column widths, edited in GRID, saved back as
//                text with the same delimiter
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

// Excel's "sep=X" hint: the first line (after an optional BOM) is exactly
// "sep=" plus one character, then an EOL or the end of the file.
const SEP_LINE_RE = /^sep=([^\r\n"])(\r\n|\n|$)/i;

const DELIMITER_CANDIDATES = [',', ';', '\t', '|'];
// Tie-break order among non-comma candidates (earlier wins).
const DELIMITER_PREFERENCE = ['\t', ';', '|'];
const DETECT_MAX_RECORDS = 50;
const DETECT_MAX_CHARS = 64 * 1024;
// A European decimal number: 1,50 / -3,5 / 1.234,56.
const DECIMAL_COMMA_RE = /^[-+]?(\d{1,3}(\.\d{3})+|\d+),\d+$/;

/**
 * Quote-aware record scan with the same state machine as parseDelimited(),
 * used by detectDelimiter() to score one candidate. Collects per non-blank
 * record field counts, whether the scan looked like the wrong delimiter
 * (a '"' in the middle of a field, or anything but the delimiter/EOL right
 * after a closing quote), and decimal-comma evidence among the fields.
 */
function scanRecords(s, delimiter, { maxRecords = DETECT_MAX_RECORDS, truncated = false } = {}) {
  const counts = [];
  let dirty = false;
  let decimalFields = 0;
  let otherCommaFields = 0;
  let fields = 0;
  let field = '';
  let fieldQuoted = false;
  let inQuotes = false;
  let afterQuote = false;
  const n = s.length;
  let i = 0;

  const endField = () => {
    if (DECIMAL_COMMA_RE.test(field)) decimalFields++;
    else if (!fieldQuoted && field.includes(',')) otherCommaFields++;
    fields++;
    field = '';
    fieldQuoted = false;
    afterQuote = false;
  };
  const endRecord = () => {
    const blank = fields === 0 && field === '' && !fieldQuoted;
    endField();
    if (!blank) counts.push(fields);
    fields = 0;
  };

  while (i < n && counts.length < maxRecords) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        afterQuote = true;
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
      endField();
      i++;
      continue;
    }
    if (c === '\r' && s[i + 1] === '\n') {
      endRecord();
      i += 2;
      continue;
    }
    if (c === '\n') {
      endRecord();
      i++;
      continue;
    }
    if (c === '"' || afterQuote) dirty = true;
    afterQuote = false;
    field += c;
    i++;
  }
  // The final record is complete only if the text was not cut short.
  if (counts.length < maxRecords && !truncated && (fields > 0 || field !== '' || fieldQuoted)) endRecord();
  return { counts, dirty, decimalComma: decimalFields > 0 && otherCommaFields === 0 };
}

/**
 * Delimiter of a delimited text file.
 *   .tsv                      -> tab ('format')
 *   "sep=X" first line        -> X ('sep')
 *   sampled content           -> ',', ';', '\t' or '|' ('detected')
 *   single column / ambiguous -> ',' ('default')
 *
 * A candidate is valid when its most common field count is at least 2 and at
 * least 80% of the sampled non-blank records have it. Clean scans beat ones
 * with stray quotes, then higher consistency wins. On a tie, tab > semicolon >
 * pipe, and a non-comma candidate beats comma only with decimal-comma evidence
 * (1,50;2,75 splits evenly on both, but is a semicolon file).
 *
 * @returns {{ delimiter: string, source: 'format'|'sep'|'detected'|'default' }}
 */
export function detectDelimiter(text, format) {
  if (format === 'tsv') return { delimiter: '\t', source: 'format' };
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const sep = SEP_LINE_RE.exec(s);
  if (sep) return { delimiter: sep[1], source: 'sep' };

  const truncated = s.length > DETECT_MAX_CHARS;
  const sample = truncated ? s.slice(0, DETECT_MAX_CHARS) : s;
  const valid = [];
  for (const delimiter of DELIMITER_CANDIDATES) {
    const { counts, dirty, decimalComma } = scanRecords(sample, delimiter, { truncated });
    if (counts.length === 0) continue;
    const freq = new Map();
    for (const w of counts) freq.set(w, (freq.get(w) || 0) + 1);
    let modeWidth = 0;
    let modeCount = 0;
    for (const [w, k] of freq) {
      if (k > modeCount || (k === modeCount && w > modeWidth)) {
        modeWidth = w;
        modeCount = k;
      }
    }
    const consistency = modeCount / counts.length;
    if (modeWidth >= 2 && consistency >= 0.8) valid.push({ delimiter, dirty, decimalComma, consistency });
  }
  const clean = valid.filter((v) => !v.dirty);
  const pool = clean.length ? clean : valid;
  if (!pool.length) return { delimiter: ',', source: 'default' };

  const best = Math.max(...pool.map((v) => v.consistency));
  const top = pool.filter((v) => Math.abs(v.consistency - best) < 1e-9);
  const comma = top.find((v) => v.delimiter === ',');
  const other = DELIMITER_PREFERENCE.map((d) => top.find((v) => v.delimiter === d)).find(Boolean);
  if (!other) return { delimiter: ',', source: 'detected' };
  if (comma && !other.decimalComma) return { delimiter: ',', source: 'detected' };
  return { delimiter: other.delimiter, source: 'detected' };
}

/** Human name of a delimiter for the meta line: 'comma', 'semicolon', 'tab', 'pipe'. */
export function delimiterName(d) {
  switch (d) {
    case ',':
      return 'comma';
    case ';':
      return 'semicolon';
    case '\t':
      return 'tab';
    case '|':
      return 'pipe';
    default:
      return JSON.stringify(d);
  }
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
 * An Excel "sep=X" first line (after the BOM) is not data: it is removed from
 * the rows and kept verbatim, EOL included, in meta.sepLine so it is written
 * back on save. eol, trailingEol and widths describe the rest of the file
 * (eol falls back to the sep line's EOL when the body has none).
 *
 * @returns {{ rows: string[][], meta: { bom: boolean, sepLine: string, eol: '\r\n'|'\n', trailingEol: boolean, widths: number[] } }}
 */
export function parseDelimited(text, delimiter = ',') {
  let s = String(text == null ? '' : text);
  const bom = s.charCodeAt(0) === 0xfeff;
  if (bom) s = s.slice(1);
  const sep = SEP_LINE_RE.exec(s);
  const sepLine = sep ? sep[0] : '';
  if (sep) s = s.slice(sepLine.length);

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
  return { rows, meta: { bom, sepLine, eol: eol || (sep && sep[2]) || '\n', trailingEol, widths } };
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
 *
 * opts.columnWidths (px per 0-based column, falsy = GRID default) becomes the
 * sheet's 1-based `columns` spans. Widths are baked into the model when it is
 * built, so they fire no editor events and never mark the file dirty.
 */
export function rowsToJsf(rows, sheetName, filename, { columnWidths } = {}) {
  const cells = {};
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const s = row[c];
      if (s === '' || s == null) continue;
      cells[columnName(c) + (r + 1)] = { v: isCanonicalNumber(s) ? Number(s) : String(s) };
    }
  }
  const sheet = { name: sheetName || 'Sheet1', cells };
  const columns = [];
  if (Array.isArray(columnWidths)) {
    for (let c = 0; c < columnWidths.length; c++) {
      const w = columnWidths[c];
      if (w > 0) columns.push({ start: c + 1, end: c + 1, size: Math.round(w) });
    }
  }
  if (columns.length) sheet.columns = columns;
  return { name: filename || 'workbook', sheets: [sheet] };
}

/** Pure fallback text measure (px) when no canvas is available. */
const approxMeasure = (s) => s.length * 7.5;

/**
 * Row indexes computeColumnWidths() looks at for a sheet of rowCount rows:
 * all of them up to sampleRows, otherwise the first half of the budget from
 * the top (header included) and the rest strided evenly down to the last row.
 */
export function sampleRowIndexes(rowCount, sampleRows = 2000) {
  const indexes = [];
  if (rowCount <= sampleRows) {
    for (let r = 0; r < rowCount; r++) indexes.push(r);
    return indexes;
  }
  const head = Math.floor(sampleRows / 2);
  const tail = sampleRows - head;
  const stride = (rowCount - head) / tail;
  for (let r = 0; r < head; r++) indexes.push(r);
  for (let k = 1; k <= tail; k++) indexes.push(head + Math.ceil(k * stride) - 1);
  return indexes;
}

/**
 * Auto-fit column widths (px) from cell text: the widest sampled cell per
 * column (longest line of a multi-line value, first maxChars characters) plus
 * padding, clamped to [minWidth, maxWidth]. Columns with no non-empty sampled
 * cell get 0 (keep GRID's default). Sheets over sampleRows rows are sampled
 * (see sampleRowIndexes); rows outside the sample may be left unset.
 *
 * @returns {number[]}
 */
export function computeColumnWidths(
  rows,
  { measure = approxMeasure, minWidth = 48, maxWidth = 400, padding = 16, sampleRows = 2000, maxChars = 200 } = {}
) {
  const list = Array.isArray(rows) ? rows : [];
  const widths = [];
  for (const r of sampleRowIndexes(list.length, sampleRows)) {
    const row = list[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      if (widths.length <= c) widths.push(0);
      const v = row[c];
      if (v == null || v === '' || widths[c] >= maxWidth) continue;
      let line = '';
      for (const part of String(v).split(/\r\n|\r|\n/)) if (part.length > line.length) line = part;
      if (line.length > maxChars) line = line.slice(0, maxChars);
      const w = Math.min(maxWidth, Math.max(minWidth, measure(line) + padding));
      if (w > widths[c]) widths[c] = w;
    }
  }
  return widths;
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
 * delimiter, '"', CR or LF. The original BOM, "sep=" line, EOL style and
 * trailing-EOL presence are kept.
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
  return (meta.bom ? '\ufeff' : '') + (meta.sepLine || '') + text;
}

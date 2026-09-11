// esbuild entry for the Codeman GRID spreadsheet vendor bundle.
// Bundled to dist/web/public/vendor/grid.min.js (+ grid.min.css) as an IIFE
// that exposes one global so app.js stays React-free:
//   window.CodemanGrid = { ready, load, mount, serialize, formatInfo, tabularFormatOf }
// A csv/tsv handle also carries the detected delimiter (delimiterName for the
// meta line); serialize() writes back with that same delimiter.
//
// Lazy-loaded by app.js (_filesEnsureGrid) only when a csv/tsv/xlsx/xls/ods file
// is opened. Built only when the GRID packages are installed (they are
// devDependencies under the GRID evaluation licence) and excluded from the
// published npm tarball — see scripts/build.mjs, package.json "files" and the
// licence notes in TASK.md. GRID code is used unmodified: its telemetry ping
// and console banner are left alone, and --legal-comments=eof keeps notices.

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Model } from '@grid-is/spreadsheet-engine';
import { SpreadsheetViewer } from '@grid-is/spreadsheet-viewer';
import { SpreadsheetEditor } from '@grid-is/spreadsheet-editor';
import '@grid-is/spreadsheet-viewer/style.css';
import '@grid-is/spreadsheet-editor/style.css';
import { read as xlsxRead, write as xlsxWrite } from 'xlsx';

import {
  tabularFormatOf,
  formatInfo,
  detectDelimiter,
  delimiterName,
  parseDelimited,
  rowsToJsf,
  serializeDelimited,
  sheetNameFor,
  isCanonicalNumber,
  formatCellValue,
  computeColumnWidths,
  sampleRowIndexes,
} from './grid-tabular.mjs';

// Dark chrome matching the files sheet (#0d1117 / #e6edf3, accent #58a6ff).
// Applied through the viewer's documented `theme` prop only — GRID's own CSS
// is never edited.
const VIEWER_THEME = {
  'mondrian-bg-white': '#0d1117',
  'mondrian-bg-gray-100': '#161b22',
  'mondrian-bg-gray-200': '#21262d',
  'mondrian-text-black': '#e6edf3',
  'mondrian-text-gray-400': '#8b949e',
  'mondrian-text-gray-500': '#8b949e',
  'mondrian-text-gray-700': '#c9d1d9',
  'mondrian-border-primary': '#30363d',
  'mondrian-border-separator': '#30363d',
  'mondrian-highlight-fill': 'rgba(56, 139, 253, 0.18)',
  'mondrian-highlight-stroke': '#58a6ff',
  'mondrian-hover-overlay': 'rgba(255, 255, 255, 0.08)',
  'mondrian-resizer-hover': 'rgba(88, 166, 255, 0.35)',
  'mondrian-error-red': '#f85149',
  'mondrian-syntax-number': '#79c0ff',
  'mondrian-syntax-prefix': '#8b949e',
  'mondrian-syntax-range': '#f0883e',
  'mondrian-syntax-string': '#7ee787',
};

// GRID fetches its woff2 fonts from `${origin}/fonts/` by default, which does
// not exist on Codeman. An empty filter registers no optional fonts; the
// baseUrl keeps the editor's fixed Calibri preload away from /fonts/ on our
// origin (it falls back to system fonts when that request fails).
function fontConfig() {
  const base = new URL('vendor/grid-fonts/', document.baseURI).toString();
  return { fontFilter: [], baseUrl: { open: base, restricted: base } };
}

const WORKBOOK_WRITABLE = new Set(['csv', 'tsv', 'xlsx']);

// Editor events that shift cells around. After any of these, the row widths
// recorded when a csv/tsv was parsed no longer line up with the grid, so
// serializeDelimited() sizes the output to the used range instead of padding
// to the original shape (which would leave phantom ",," rows or empty columns).
const STRUCTURAL_EVENTS = new Set([
  'insert-row',
  'insert-column',
  'insert-cells',
  'delete-rows',
  'delete-columns',
  'delete-cells',
  'move-rows',
  'move-columns',
  'move-cells',
]);

// Column/row sizes a csv/tsv cannot store: resizing is not an unsaved change.
const SIZE_EVENTS = new Set(['resize-column', 'resize-row']);

// Auto-fit measures text with the font GRID's own editor auto-fit uses.
let measureCtx;
function textMeasure() {
  if (measureCtx === undefined) {
    measureCtx = null;
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx) {
        ctx.font = '14px calibri, sans-serif';
        measureCtx = ctx;
      }
    } catch {
      /* no canvas: computeColumnWidths falls back to its estimate */
    }
  }
  return measureCtx ? (s) => measureCtx.measureText(s).width : undefined;
}

// Sampled rows × columns above which xls/ods auto-fit is skipped.
const FIT_MAX_CELLS = 250000;

/**
 * xls/ods only (read-only, never saved): fit columns the workbook gives no
 * width. xlsx is never fitted — its model is the one saved by toXLSX(), and
 * viewing must not alter the file. Any failure keeps GRID's defaults.
 */
function fitUnsizedColumns(model) {
  const workbook = model.getWorkbooks()[0];
  if (!workbook) return;
  const measure = textMeasure();
  for (const sheet of workbook.getSheets()) {
    try {
      let hasCell = false;
      for (const _cell of sheet.getCells()) {
        hasCell = true;
        break;
      }
      if (!hasCell) continue;
      const b = sheet.getBounds();
      const indexes = sampleRowIndexes(b.bottom + 1);
      if (indexes.length * (b.right + 1) > FIT_MAX_CELLS) continue;
      const rows = new Array(b.bottom + 1);
      for (const r of indexes) {
        const row = [];
        for (let c = 0; c <= b.right; c++) {
          const cell = sheet.getCellByRange({ top: r, left: c });
          row.push(cell ? formatCellValue(cell.v) : '');
        }
        rows[r] = row;
      }
      const sized = (col) => (sheet.columns || []).some((g) => g && g.size != null && g.start <= col && col <= g.end);
      computeColumnWidths(rows, { measure }).forEach((w, c) => {
        if (w > 0 && !sized(c + 1)) workbook.setColumnWidth(sheet.name, c, Math.round(w));
      });
    } catch {
      /* keep defaults */
    }
  }
}

/**
 * csv/tsv only: store a typed value the way the csv loader would store that
 * text. GRID's editor parses input like Excel (2024-01-01 -> date serial 45292,
 * 1.50 -> 1.5, 1,000 -> 1000, 50% -> 0.5, true -> TRUE), which a values-only
 * text file would then save as the parsed number instead of what was typed.
 * Canonical numbers, formulas ("=") and "'"-prefixed text are left to GRID.
 */
function keepTypedText(handle, event) {
  if (handle.format !== 'csv' && handle.format !== 'tsv') return;
  const text = event.value;
  if (typeof text !== 'string' || text === '' || text[0] === '=' || text[0] === "'") return;
  if (isCanonicalNumber(text)) return;
  const workbook = handle.model.getWorkbooks()[0];
  const cell = workbook && workbook.getCell(event.cellId, event.sheetName);
  if (!cell || cell.f || formatCellValue(cell.v) === text) return;
  const sheet = String(event.sheetName).replace(/'/g, "''");
  handle.model.write(`'${sheet}'!${event.cellId}`, text);
  handle.model.recalculate();
}

function toBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** First sheet of the first workbook as a 2D value grid, always starting at A1. */
function sheetToGrid(sheet) {
  const grid = [];
  if (!sheet) return grid;
  let hasCell = false;
  for (const _cell of sheet.getCells()) {
    hasCell = true;
    break;
  }
  if (!hasCell) return grid;
  const b = sheet.getBounds();
  for (let r = 0; r <= b.bottom; r++) {
    const row = [];
    for (let c = 0; c <= b.right; c++) {
      const cell = sheet.getCellByRange({ top: r, left: c });
      row.push(cell ? cell.v : '');
    }
    grid.push(row);
  }
  return grid;
}

/**
 * Build a workbook handle.
 *   csv/tsv: { format, text, filename, maxCells? }
 *   xlsx/xls/ods: { format, bytes: ArrayBuffer, filename }
 * For csv/tsv above maxCells the handle is { tooLarge: true, cells } with no model.
 */
async function load({ format, text, bytes, filename, maxCells }) {
  await Model.preconditions;
  const name = String(filename || 'workbook')
    .split('/')
    .pop();
  if (format === 'csv' || format === 'tsv') {
    // Same delimiter for parse and save; a "sep=" line is kept in meta.sepLine.
    const { delimiter, source } = detectDelimiter(text, format);
    const { rows, meta } = parseDelimited(text, delimiter);
    let cols = 0;
    for (const r of rows) if (r.length > cols) cols = r.length;
    const cells = rows.length * cols;
    if (maxCells && cells > maxCells) return { format, tooLarge: true, cells };
    const columnWidths = computeColumnWidths(rows, { measure: textMeasure() });
    const model = Model.fromJSF(rowsToJsf(rows, sheetNameFor(name), name, { columnWidths }));
    return {
      format,
      filename: name,
      model,
      meta,
      delimiter,
      delimiterName: delimiterName(delimiter),
      delimiterSource: source,
      rows: rows.length,
      cols,
    };
  }
  if (format === 'xlsx') {
    // No auto-fit: this model is saved by toXLSX(), so viewing must not change it.
    const model = await Model.fromXLSX(bytes, name);
    return { format, filename: name, model };
  }
  if (format === 'xls' || format === 'ods') {
    const wb = xlsxRead(new Uint8Array(bytes), { type: 'array', cellFormula: true, cellStyles: false });
    const out = xlsxWrite(wb, { bookType: 'xlsx', type: 'array' });
    const model = await Model.fromXLSX(out, name.replace(/\.(xls|ods)$/i, '.xlsx'));
    fitUnsizedColumns(model);
    return { format, filename: name, model };
  }
  throw new Error(`Unsupported spreadsheet format: ${format}`);
}

/**
 * Render the viewer (mode 'view') or editor (mode 'edit') into host. host must
 * have an explicit height. onDirty fires for every mutating editor event.
 */
function mount(host, handle, { mode = 'view', onDirty } = {}) {
  if (!host || !handle || !handle.model) throw new Error('Nothing to mount');
  host.textContent = '';
  const root = createRoot(host);
  if (mode === 'edit') {
    root.render(
      createElement(SpreadsheetEditor, {
        model: handle.model,
        fontConfig: fontConfig(),
        autoFocus: true,
        showErrorTooltips: true,
        onChange: (event) => {
          const type = event && event.type;
          if (!type || type === 'selection-change' || type === 'sheet-change') return;
          if (SIZE_EVENTS.has(type) && (handle.format === 'csv' || handle.format === 'tsv')) return;
          if (STRUCTURAL_EVENTS.has(type)) handle.structureChanged = true;
          if (type === 'write-cell') {
            try {
              keepTypedText(handle, event);
            } catch {
              /* keep GRID's parsed value */
            }
          }
          if (onDirty) onDirty(type);
        },
      })
    );
  } else {
    root.render(
      createElement(SpreadsheetViewer, {
        model: handle.model,
        theme: VIEWER_THEME,
        fontConfig: fontConfig(),
        showErrorTooltips: true,
      })
    );
  }
  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        root.unmount();
      } catch {
        /* ignore */
      }
    },
  };
}

/** csv/tsv -> { encoding: 'utf-8', content }; xlsx -> { encoding: 'base64', content }. */
async function serialize(handle) {
  if (!handle || !handle.model || !WORKBOOK_WRITABLE.has(handle.format)) {
    throw new Error(`.${handle && handle.format} can't be saved in place`);
  }
  const workbook = handle.model.getWorkbooks()[0];
  if (!workbook) throw new Error('Workbook is empty');
  if (handle.format === 'xlsx') {
    const buf = await workbook.toXLSX('arraybuffer');
    return { encoding: 'base64', content: toBase64(buf) };
  }
  const sheet = workbook.getSheets()[0];
  const text = serializeDelimited(sheetToGrid(sheet), handle.delimiter, handle.meta, {
    structureChanged: !!handle.structureChanged,
  });
  return { encoding: 'utf-8', content: text };
}

window.CodemanGrid = {
  ready: Model.preconditions.then(() => true),
  load,
  mount,
  serialize,
  formatInfo: (pathOrFormat) => formatInfo(tabularFormatOf(pathOrFormat) || pathOrFormat),
  tabularFormatOf,
};

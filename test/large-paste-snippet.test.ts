/**
 * Specification / parity checks for the large-paste → document-snippet feature.
 *
 * app.js is an unbundled browser script with no exports and cannot be imported
 * into jsdom, so — as with every other client test in this repo (see
 * test/non-image-file-upload.test.ts, test/compose-slash-commands.test.ts,
 * test/paste-newline-routing.test.ts) — the pure logic is MIRRORED here as
 * standalone functions matching the exact expressions in InputPanel. These
 * tests lock the thresholds, boundaries, and divert-decision table; the live
 * DOM handler is exercised by the manual browser QA in the plan (Task 4).
 *
 * Keep the mirrors below character-identical to app.js.
 */
import { describe, it, expect } from 'vitest';

// ── Mirrored from app.js: constants ──────────────────────────────────────────
const PASTE_SNIPPET_MAX_BYTES = 10 * 1024;
const PASTE_SNIPPET_MAX_LINES = 30;
const PASTE_SNIPPET_HARD_MAX = 9 * 1024 * 1024;

// ── Mirrored from app.js: InputPanel pure helpers ────────────────────────────
const countPasteLines = (text: string): number => {
  if (!text) return 0;
  const parts = text.replace(/\r\n|\r|\u2028|\u2029/g, '\n').split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
};

const pasteByteLength = (text: string): number => new TextEncoder().encode(text).length;

const shouldSnippetPaste = (text: string): boolean => {
  if (!text) return false;
  if (pasteByteLength(text) > PASTE_SNIPPET_MAX_BYTES) return true;
  if (countPasteLines(text) > PASTE_SNIPPET_MAX_LINES) return true;
  return false;
};

const makePasteFilename = (n: number): string => `pasted-text-${n}.txt`;

const fmtPasteBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

describe('large-paste snippet detection', () => {
  it('does not snippet an empty paste', () => {
    expect(shouldSnippetPaste('')).toBe(false);
  });

  it('does not snippet a small single-line paste', () => {
    expect(shouldSnippetPaste('a short stack trace line')).toBe(false);
  });

  it('counts 30 newline-joined lines as 30 (boundary, not over)', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    expect(countPasteLines(text)).toBe(30);
    expect(shouldSnippetPaste(text)).toBe(false);
  });

  it('does not count a single trailing newline as an extra line', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
    expect(countPasteLines(text)).toBe(30);
    expect(shouldSnippetPaste(text)).toBe(false);
  });

  it('snippets a 31-line paste (over the line threshold)', () => {
    const text = Array.from({ length: 31 }, (_, i) => `line ${i}`).join('\n');
    expect(countPasteLines(text)).toBe(31);
    expect(shouldSnippetPaste(text)).toBe(true);
  });

  it('keeps a blank final line when there are two trailing newlines', () => {
    // "a\n\n" → ["a", "", ""] → pop one trailing "" → ["a", ""] → 2 lines
    expect(countPasteLines('a\n\n')).toBe(2);
  });

  it('stays native at exactly the byte threshold, diverts one byte over', () => {
    expect(shouldSnippetPaste('x'.repeat(PASTE_SNIPPET_MAX_BYTES))).toBe(false);
    expect(shouldSnippetPaste('x'.repeat(PASTE_SNIPPET_MAX_BYTES + 1))).toBe(true);
  });

  it('normalizes CR-only and Unicode line separators when counting', () => {
    expect(countPasteLines('a\rb\rc')).toBe(3);
    expect(countPasteLines('a\u2028b\u2029c')).toBe(3);
    expect(countPasteLines('a\r\nb\r\nc')).toBe(3);
  });

  it('counts UTF-8 bytes, not code units, for the byte threshold', () => {
    // '€' is 3 UTF-8 bytes; 3500 of them = 10500 bytes > 10 KB, in 3500 chars.
    const text = '€'.repeat(3500);
    expect(pasteByteLength(text)).toBe(10500);
    expect(shouldSnippetPaste(text)).toBe(true);
  });

  it('builds a readable paste filename', () => {
    expect(makePasteFilename(1)).toBe('pasted-text-1.txt');
    expect(makePasteFilename(7)).toBe('pasted-text-7.txt');
  });

  it('formats byte sizes', () => {
    expect(fmtPasteBytes(512)).toBe('512 B');
    expect(fmtPasteBytes(340 * 1024)).toBe('340 KB');
    expect(fmtPasteBytes(1.2 * 1024 * 1024)).toBe('1.2 MB');
  });
});

// ── Mirrored from app.js: _onTextPaste divert decision ───────────────────────
interface FakeClipboard {
  files?: { length: number };
  getData: (t: string) => string;
}
type Decision = 'native' | 'too-large' | 'snippet';

// Returns the branch _onTextPaste takes for a given clipboard + session state.
const pasteDecision = (cd: FakeClipboard | null, hasActiveSession: boolean): Decision => {
  if (!cd) return 'native';
  if (cd.files && cd.files.length) return 'native'; // file paste → global handler
  const text = cd.getData('text/plain');
  if (!text) return 'native'; // empty / HTML-only
  if (!shouldSnippetPaste(text)) return 'native'; // small paste
  if (!hasActiveSession) return 'native'; // nowhere to upload
  if (pasteByteLength(text) > PASTE_SNIPPET_HARD_MAX) return 'too-large';
  return 'snippet';
};

describe('paste divert decision', () => {
  const big = 'y'.repeat(PASTE_SNIPPET_MAX_BYTES + 1);
  const mk = (files: number, text: string): FakeClipboard => ({
    files: { length: files },
    getData: () => text,
  });

  it('diverts a big text paste when a session is active', () => {
    expect(pasteDecision(mk(0, big), true)).toBe('snippet');
  });
  it('ignores a big paste when no session is active', () => {
    expect(pasteDecision(mk(0, big), false)).toBe('native');
  });
  it('ignores a file paste (handled by the global handler)', () => {
    expect(pasteDecision(mk(1, big), true)).toBe('native');
  });
  it('ignores an empty/HTML-only paste', () => {
    expect(pasteDecision(mk(0, ''), true)).toBe('native');
  });
  it('ignores a small text paste', () => {
    expect(pasteDecision(mk(0, 'hello'), true)).toBe('native');
  });
  it('rejects a paste over the ~9 MB hard max', () => {
    const huge = 'z'.repeat(PASTE_SNIPPET_HARD_MAX + 1);
    expect(pasteDecision(mk(0, huge), true)).toBe('too-large');
  });
});

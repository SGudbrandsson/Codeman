/**
 * @fileoverview Tests for paste-with-newlines detection and routing logic
 *
 * Covers the paste detection block added to setupTerminal() → terminal.onData()
 * Normal Mode section in src/web/public/app.js (~lines 3829–3851).
 *
 * Because app.js is a browser bundle (no exports), the logic is replicated
 * here as pure functions matching the exact expressions in the source.
 * This mirrors the approach used in terminal-parsing.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Pure helpers extracted from the paste-detection block in app.js
// ---------------------------------------------------------------------------

/**
 * Returns true when data matches the paste-with-newlines detection condition:
 *   data.length > 1 && data.charCodeAt(0) >= 32 && /[\r\n]/.test(data)
 */
const isPasteWithNewlines = (data: string): boolean =>
  data.length > 1 && data.charCodeAt(0) >= 32 && /[\r\n]/.test(data);

/**
 * Normalizes line endings to \n, as performed before calling sendInput().
 *   data.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
 */
const normalizePasteLineEndings = (data: string): string => data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/**
 * Determines whether \r should be appended to the paste before sending,
 * indicating user intent to submit (paste itself ended with a newline).
 *   /[\r\n]$/.test(data)   — tested against the ORIGINAL data (before normalization)
 */
const pasteEndsWithNewline = (data: string): boolean => /[\r\n]$/.test(data);

/**
 * Full paste payload sent to sendInput(), combining normalization and submit suffix.
 */
const buildPastePayload = (data: string): string =>
  normalizePasteLineEndings(data) + (pasteEndsWithNewline(data) ? '\r' : '');

// ---------------------------------------------------------------------------
// Simulated onData handler for flushing behaviour tests
// ---------------------------------------------------------------------------

interface OnDataHandlerContext {
  _pendingInput: string;
  _inputFlushTimeout: ReturnType<typeof setTimeout> | null;
  sendInputCalls: string[];
  flushInputCalls: string[];
}

/**
 * Simulates the relevant part of the terminal.onData() handler:
 * - If paste-with-newlines detected, flush _pendingInput then call sendInput().
 * - Otherwise fall through to the pre-existing logic (appends to _pendingInput).
 *
 * Returns the context after processing, allowing assertions on side effects.
 */
function simulateOnData(ctx: OnDataHandlerContext, data: string): OnDataHandlerContext {
  const out = { ...ctx, sendInputCalls: [...ctx.sendInputCalls], flushInputCalls: [...ctx.flushInputCalls] };

  if (isPasteWithNewlines(data)) {
    // Flush any buffered input first (ordering preserved)
    if (out._pendingInput) {
      if (out._inputFlushTimeout) {
        out._inputFlushTimeout = null; // clearTimeout equivalent
      }
      out.flushInputCalls.push(out._pendingInput);
      out._pendingInput = '';
    }
    out.sendInputCalls.push(buildPastePayload(data));
    // returns early — does NOT append to _pendingInput
    return out;
  }

  // Pre-existing path: append to _pendingInput
  out._pendingInput += data;
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Paste-with-newlines detection (Normal Mode onData)', () => {
  describe('isPasteWithNewlines — detection condition', () => {
    it('detects a multi-char printable paste containing \\n', () => {
      expect(isPasteWithNewlines('Hello\nWorld')).toBe(true);
    });

    it('detects a paste containing \\r\\n (Windows line endings)', () => {
      expect(isPasteWithNewlines('Hello\r\nWorld')).toBe(true);
    });

    it('detects a paste containing bare \\r', () => {
      expect(isPasteWithNewlines('Hello\rWorld')).toBe(true);
    });

    it('does NOT trigger for a single printable character', () => {
      expect(isPasteWithNewlines('A')).toBe(false);
    });

    it('does NOT trigger for multi-char paste without any newline', () => {
      expect(isPasteWithNewlines('HelloWorld')).toBe(false);
    });

    it('does NOT trigger for ESC sequences (first char < 32)', () => {
      // ESC = 0x1B = 27 < 32 — escape sequences must fall through to existing logic
      expect(isPasteWithNewlines('\x1b[A')).toBe(false);
    });

    it('does NOT trigger for a single \\n character (length === 1)', () => {
      expect(isPasteWithNewlines('\n')).toBe(false);
    });

    it('does NOT trigger for a single \\r character (length === 1)', () => {
      expect(isPasteWithNewlines('\r')).toBe(false);
    });
  });

  describe('normalizePasteLineEndings — \\r\\n and bare \\r → \\n', () => {
    it('converts \\r\\n to \\n', () => {
      expect(normalizePasteLineEndings('Hello\r\nWorld')).toBe('Hello\nWorld');
    });

    it('converts bare \\r to \\n', () => {
      expect(normalizePasteLineEndings('Hello\rWorld')).toBe('Hello\nWorld');
    });

    it('leaves \\n unchanged', () => {
      expect(normalizePasteLineEndings('Hello\nWorld')).toBe('Hello\nWorld');
    });

    it('handles multiple mixed line endings', () => {
      expect(normalizePasteLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    });
  });

  describe('pasteEndsWithNewline — submit intent detection', () => {
    it('returns true when paste ends with \\n', () => {
      expect(pasteEndsWithNewline('Hello\nWorld\n')).toBe(true);
    });

    it('returns true when paste ends with \\r', () => {
      expect(pasteEndsWithNewline('Hello\r')).toBe(true);
    });

    it('returns true when paste ends with \\r\\n', () => {
      expect(pasteEndsWithNewline('Hello\r\n')).toBe(true);
    });

    it('returns false when paste does NOT end with a newline', () => {
      expect(pasteEndsWithNewline('Hello\nWorld')).toBe(false);
    });
  });

  describe('buildPastePayload — full payload sent to sendInput()', () => {
    it('appends \\r when paste ends with \\n (submit intent)', () => {
      const payload = buildPastePayload('Hello\nWorld\n');
      expect(payload).toBe('Hello\nWorld\n\r');
    });

    it('does NOT append \\r when paste does not end with a newline', () => {
      const payload = buildPastePayload('Hello\nWorld');
      expect(payload).toBe('Hello\nWorld');
    });

    it('normalizes \\r\\n before appending \\r for submit', () => {
      // Original ends with \r\n → pasteEndsWithNewline = true → append \r
      // normalization converts \r\n → \n first
      const payload = buildPastePayload('Hello\r\nWorld\r\n');
      expect(payload).toBe('Hello\nWorld\n\r');
    });

    it('normalizes bare \\r and appends \\r for submit when paste ends with \\r', () => {
      const payload = buildPastePayload('Hello\rWorld\r');
      expect(payload).toBe('Hello\nWorld\n\r');
    });
  });

  describe('simulateOnData — routing and flushing behaviour', () => {
    let ctx: OnDataHandlerContext;

    beforeEach(() => {
      ctx = {
        _pendingInput: '',
        _inputFlushTimeout: null,
        sendInputCalls: [],
        flushInputCalls: [],
      };
    });

    it('routes multi-char paste with \\n through sendInput (not _pendingInput)', () => {
      ctx = simulateOnData(ctx, 'Hello\nWorld');
      expect(ctx.sendInputCalls).toHaveLength(1);
      expect(ctx._pendingInput).toBe('');
    });

    it('does not append to _pendingInput on paste-with-newlines', () => {
      ctx = simulateOnData(ctx, 'Hello\nWorld');
      expect(ctx._pendingInput).toBe('');
    });

    it('flushes non-empty _pendingInput before dispatching paste', () => {
      ctx._pendingInput = 'buffered';
      ctx = simulateOnData(ctx, 'Hello\nWorld');
      // The buffered input must have been flushed first
      expect(ctx.flushInputCalls).toContain('buffered');
      // _pendingInput should be empty after flush + paste dispatch
      expect(ctx._pendingInput).toBe('');
    });

    it('does not flush if _pendingInput is empty when paste arrives', () => {
      ctx._pendingInput = '';
      ctx = simulateOnData(ctx, 'Hello\nWorld');
      expect(ctx.flushInputCalls).toHaveLength(0);
    });

    it('single printable char falls through to _pendingInput (regression guard)', () => {
      ctx = simulateOnData(ctx, 'A');
      expect(ctx.sendInputCalls).toHaveLength(0);
      expect(ctx._pendingInput).toBe('A');
    });

    it('multi-char paste without \\n/\\r falls through to _pendingInput (regression guard)', () => {
      ctx = simulateOnData(ctx, 'HelloWorld');
      expect(ctx.sendInputCalls).toHaveLength(0);
      expect(ctx._pendingInput).toBe('HelloWorld');
    });

    it('ESC sequence falls through to _pendingInput (regression guard)', () => {
      ctx = simulateOnData(ctx, '\x1b[A');
      expect(ctx.sendInputCalls).toHaveLength(0);
      expect(ctx._pendingInput).toBe('\x1b[A');
    });
  });
});

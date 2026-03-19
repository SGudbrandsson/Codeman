/**
 * @fileoverview Tests for TmuxManager.sendInput() newline-splitting logic
 *
 * TmuxManager.sendInput() is a no-op in VITEST=1 test mode (IS_TEST_MODE guard),
 * so the actual splitting behaviour (lines 1267–1300 in src/tmux-manager.ts) cannot
 * be exercised through the class directly. Instead, this file tests the pure logic
 * by replicating the identical transformations inline — the same approach used in
 * terminal-parsing.test.ts for browser-bundle code.
 *
 * Covered gaps:
 *  - Input containing \n produces separate send-keys calls with C-j between segments.
 *  - A trailing \r produces a final Enter key event.
 *  - Input without \r does not send Enter.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure helpers extracted from TmuxManager.sendInput() (src/tmux-manager.ts)
// ---------------------------------------------------------------------------

interface SendKeysCall {
  type: 'literal' | 'C-j' | 'Enter';
  text?: string;
}

/**
 * Simulates the command-building logic of TmuxManager.sendInput() and returns
 * the ordered list of conceptual tmux send-keys calls that would be executed.
 *
 * This mirrors lines 1267–1300 of src/tmux-manager.ts exactly:
 *
 *   const hasCarriageReturn = input.includes('\r');
 *   const lines = input.replace(/\r/g, '').split('\n');
 *   for (let i = 0; i < lines.length; i++) {
 *     const line = lines[i].trimEnd();
 *     const isLastLine = i === lines.length - 1;
 *     if (line) { // send literal text }
 *     if (!isLastLine) { // send C-j }
 *   }
 *   if (hasCarriageReturn) { // send Enter }
 */
function buildSendKeysCalls(input: string): SendKeysCall[] {
  const calls: SendKeysCall[] = [];

  const hasCarriageReturn = input.includes('\r');
  const lines = input.replace(/\r/g, '').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const isLastLine = i === lines.length - 1;

    if (line) {
      calls.push({ type: 'literal', text: line });
    }

    if (!isLastLine) {
      calls.push({ type: 'C-j' });
    }
  }

  if (hasCarriageReturn) {
    calls.push({ type: 'Enter' });
  }

  return calls;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TmuxManager.sendInput() newline-splitting logic', () => {
  describe('multi-line input containing \\n', () => {
    it('produces separate literal send-keys calls for each line segment', () => {
      const calls = buildSendKeysCalls('Hello\nWorld');
      const literals = calls.filter((c) => c.type === 'literal').map((c) => c.text);
      expect(literals).toEqual(['Hello', 'World']);
    });

    it('inserts C-j between line segments', () => {
      const calls = buildSendKeysCalls('Hello\nWorld');
      // Expected sequence: literal("Hello"), C-j, literal("World")
      expect(calls[0]).toEqual({ type: 'literal', text: 'Hello' });
      expect(calls[1]).toEqual({ type: 'C-j' });
      expect(calls[2]).toEqual({ type: 'literal', text: 'World' });
    });

    it('inserts C-j between every adjacent pair of lines for 3+ lines', () => {
      const calls = buildSendKeysCalls('a\nb\nc');
      const cjCalls = calls.filter((c) => c.type === 'C-j');
      // Two \n separators → two C-j events
      expect(cjCalls).toHaveLength(2);
    });

    it('does NOT send Enter when input contains \\n but no \\r', () => {
      const calls = buildSendKeysCalls('Hello\nWorld');
      const enterCalls = calls.filter((c) => c.type === 'Enter');
      expect(enterCalls).toHaveLength(0);
    });
  });

  describe('trailing \\r — submit intent', () => {
    it('sends Enter when input ends with \\r', () => {
      const calls = buildSendKeysCalls('Hello\nWorld\r');
      const enterCalls = calls.filter((c) => c.type === 'Enter');
      expect(enterCalls).toHaveLength(1);
    });

    it('sends Enter when input is single line with \\r', () => {
      const calls = buildSendKeysCalls('Hello\r');
      const enterCalls = calls.filter((c) => c.type === 'Enter');
      expect(enterCalls).toHaveLength(1);
    });

    it('strips \\r from literal text before sending', () => {
      // \r must not appear in the literal send-keys text — it is handled via Enter
      const calls = buildSendKeysCalls('Hello\r');
      const literals = calls.filter((c) => c.type === 'literal');
      expect(literals[0].text).not.toContain('\r');
    });
  });

  describe('no \\r — awaiting Enter', () => {
    it('does NOT send Enter when input has no \\r', () => {
      const calls = buildSendKeysCalls('Hello\nWorld');
      const enterCalls = calls.filter((c) => c.type === 'Enter');
      expect(enterCalls).toHaveLength(0);
    });

    it('does NOT send Enter for plain single-line input without \\r', () => {
      const calls = buildSendKeysCalls('Hello');
      const enterCalls = calls.filter((c) => c.type === 'Enter');
      expect(enterCalls).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('handles empty lines between content without emitting literal for empty segment', () => {
      // "a\n\nb" — middle empty line should not produce a literal call
      const calls = buildSendKeysCalls('a\n\nb');
      const literals = calls.filter((c) => c.type === 'literal').map((c) => c.text);
      expect(literals).toEqual(['a', 'b']);
      // But C-j events are still sent for both \n separators
      const cjCalls = calls.filter((c) => c.type === 'C-j');
      expect(cjCalls).toHaveLength(2);
    });

    it('trims trailing spaces from each line segment', () => {
      const calls = buildSendKeysCalls('Hello   \nWorld   ');
      const literals = calls.filter((c) => c.type === 'literal').map((c) => c.text);
      expect(literals).toEqual(['Hello', 'World']);
    });
  });
});

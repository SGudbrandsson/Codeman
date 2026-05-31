/**
 * Tests for planSendKeys — the pure planner that turns a chunk of input into the
 * ordered sequence of tmux send-keys operations for an Ink-based CLI.
 *
 * Regression focus: a previous trimEnd() in TmuxManager.sendInput silently dropped
 * standalone space keystrokes and whitespace-only lines. That broke the space bar
 * inside Claude Code sessions and made its interactive selection menus (which use
 * space to toggle) appear completely broken. The planner must preserve spaces.
 */

import { describe, it, expect } from 'vitest';
import { planSendKeys } from '../src/utils/tmux-send-keys-plan.js';

const literals = (input: string) =>
  planSendKeys(input)
    .filter((s) => s.type === 'literal')
    .map((s) => (s as { text: string }).text);

const keys = (input: string) =>
  planSendKeys(input)
    .filter((s) => s.type === 'key')
    .map((s) => (s as { key: string }).key);

describe('planSendKeys', () => {
  it('sends a lone space as a literal keystroke (the space-bar bug)', () => {
    expect(literals(' ')).toEqual([' ']);
    // and it must not be turned into an Enter/submit
    expect(keys(' ')).toEqual([]);
  });

  it('preserves a trailing space at the end of a chunk', () => {
    expect(literals('foo ')).toEqual(['foo ']);
  });

  it('preserves a whitespace-only line in the middle of multi-line input', () => {
    // "a\n \nb": the middle " " line must survive as a literal, between two C-j
    expect(literals('a\n \nb')).toEqual(['a', ' ', 'b']);
    expect(keys('a\n \nb')).toEqual(['C-j', 'C-j']);
  });

  it('sends text then Enter (as separate key) when input ends with \\r', () => {
    expect(literals('hello\r')).toEqual(['hello']);
    expect(keys('hello\r')).toEqual(['Enter']);
  });

  it('converts \\n to C-j (newline within the input buffer)', () => {
    expect(keys('a\nb')).toEqual(['C-j']);
    expect(literals('a\nb')).toEqual(['a', 'b']);
  });

  it('preserves genuinely empty lines as a bare C-j (no literal)', () => {
    // "a\n\nb": blank middle line emits only a C-j, no literal
    expect(literals('a\n\nb')).toEqual(['a', 'b']);
    expect(keys('a\n\nb')).toEqual(['C-j', 'C-j']);
  });

  it('produces no steps for empty input', () => {
    expect(planSendKeys('')).toEqual([]);
  });

  it('handles Enter-only input (bare \\r) as just a submit', () => {
    expect(literals('\r')).toEqual([]);
    expect(keys('\r')).toEqual(['Enter']);
  });

  it('keeps a 100ms settle before Enter and 50ms between sends', () => {
    const steps = planSendKeys('a\nb\r');
    // literal a, d50, C-j, d50, literal b, d50, d100, Enter
    expect(steps).toEqual([
      { type: 'literal', text: 'a' },
      { type: 'delay', ms: 50 },
      { type: 'key', key: 'C-j' },
      { type: 'delay', ms: 50 },
      { type: 'literal', text: 'b' },
      { type: 'delay', ms: 50 },
      { type: 'delay', ms: 100 },
      { type: 'key', key: 'Enter' },
    ]);
  });
});

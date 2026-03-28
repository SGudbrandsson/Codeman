/**
 * Tests for the compose textarea input deduplication logic.
 *
 * Android voice-to-text services like Wispr Flow can trigger both an IME
 * commitText AND a paste event for the same text, causing Chrome to fire
 * two separate beforeinput events that each independently insert the text.
 * The deduplication logic in InputPanel.init() prevents the second insertion.
 *
 * This test mirrors the deduplication algorithm from app.js InputPanel.init().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mirrored deduplication logic from app.js InputPanel.init() ──────────────

/**
 * Creates a deduplication checker for multi-character text insertions.
 * Returns true if the given text is a duplicate of a recent insertion.
 *
 * @param windowMs  Maximum time (ms) between insertions to consider as duplicate
 * @param getNow    Clock function (injectable for testing)
 */
function createInputDeduplicator(windowMs = 300, getNow = () => performance.now()) {
  let lastText = '';
  let lastTime = 0;

  return function isDuplicate(text: string): boolean {
    // Only deduplicate multi-character insertions (not single keystrokes)
    if (text.length <= 1) return false;
    const now = getNow();
    if (text === lastText && now - lastTime < windowMs) {
      return true;
    }
    lastText = text;
    lastTime = now;
    return false;
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Input deduplication (Wispr Flow double-paste fix)', () => {
  let clock: number;
  let isDuplicate: ReturnType<typeof createInputDeduplicator>;

  beforeEach(() => {
    clock = 0;
    isDuplicate = createInputDeduplicator(300, () => clock);
  });

  it('allows first insertion of multi-character text', () => {
    expect(isDuplicate('hello world')).toBe(false);
  });

  it('blocks duplicate text within the time window', () => {
    expect(isDuplicate('hello world')).toBe(false);
    clock += 50; // 50ms later
    expect(isDuplicate('hello world')).toBe(true);
  });

  it('allows same text after the time window expires', () => {
    expect(isDuplicate('hello world')).toBe(false);
    clock += 301; // just past 300ms
    expect(isDuplicate('hello world')).toBe(false);
  });

  it('allows different text within the time window', () => {
    expect(isDuplicate('hello')).toBe(false);
    clock += 50;
    expect(isDuplicate('world')).toBe(false);
  });

  it('never deduplicates single-character input (normal typing)', () => {
    expect(isDuplicate('a')).toBe(false);
    clock += 10;
    expect(isDuplicate('a')).toBe(false);
    clock += 10;
    expect(isDuplicate('a')).toBe(false);
  });

  it('never deduplicates empty string', () => {
    expect(isDuplicate('')).toBe(false);
    clock += 10;
    expect(isDuplicate('')).toBe(false);
  });

  it('handles rapid sequential different phrases (normal voice input)', () => {
    expect(isDuplicate('first phrase')).toBe(false);
    clock += 100;
    expect(isDuplicate('second phrase')).toBe(false);
    clock += 100;
    expect(isDuplicate('third phrase')).toBe(false);
  });

  it('blocks duplicate at boundary (exactly 300ms is still within window)', () => {
    // The check is `< 300`, so exactly 300ms should NOT be blocked
    expect(isDuplicate('test text')).toBe(false);
    clock += 300;
    expect(isDuplicate('test text')).toBe(false);
  });

  it('blocks duplicate just before boundary (299ms)', () => {
    expect(isDuplicate('test text')).toBe(false);
    clock += 299;
    expect(isDuplicate('test text')).toBe(true);
  });

  it('resets tracking after duplicate is blocked', () => {
    // First insertion
    expect(isDuplicate('hello')).toBe(false);
    // Duplicate blocked — tracking should NOT update (time stays at first insertion)
    clock += 50;
    expect(isDuplicate('hello')).toBe(true);
    // Wait until window expires from the FIRST insertion
    clock += 251; // total 301ms from first
    expect(isDuplicate('hello')).toBe(false);
  });

  it('handles Wispr Flow scenario: paste then IME commit of same text', () => {
    // Wispr Flow puts text in clipboard and pastes
    expect(isDuplicate('the quick brown fox')).toBe(false);
    // ~10ms later, IME commitText fires with same text
    clock += 10;
    expect(isDuplicate('the quick brown fox')).toBe(true);
  });

  it('handles multi-line text', () => {
    const multiLine = 'line one\nline two\nline three';
    expect(isDuplicate(multiLine)).toBe(false);
    clock += 20;
    expect(isDuplicate(multiLine)).toBe(true);
  });

  it('treats texts differing only by whitespace as different', () => {
    expect(isDuplicate('hello world')).toBe(false);
    clock += 10;
    expect(isDuplicate('hello world ')).toBe(false); // trailing space
  });
});

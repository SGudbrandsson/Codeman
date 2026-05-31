/**
 * Tests for the flicker-filter flush-timing policy in app.js batchTerminalWrite().
 *
 * Bug: every cursor-up redraw reset the 50ms flush timer. A busy Claude session
 * emits cursor-up redraws faster than 50ms apart, so the timer never fired and the
 * buffer grew until a 256KB safety valve dumped it all at once — the terminal
 * appeared frozen, then caught up in a janky burst, and keystroke echo stalled.
 *
 * Fix: bound the total hold time (MAX_FLICKER_HOLD_MS). Once output has been
 * withheld that long, flush regardless of continued redraws.
 *
 * This test mirrors the flush-timing decision from app.js batchTerminalWrite().
 * If that logic changes, update this mirror accordingly.
 */

import { describe, it, expect } from 'vitest';

/**
 * Returns the simulated time (ms) at which the flicker buffer flushes, given a
 * sequence of cursor-up redraw event timestamps.
 *
 * @param events     ascending timestamps (ms) of cursor-up redraws
 * @param syncMs     idle flush timer (SYNC_WAIT_TIMEOUT_MS = 50)
 * @param maxHoldMs  bounded total hold (MAX_FLICKER_HOLD_MS); Infinity = old behavior
 */
function simulateFlickerFlush(events: number[], syncMs: number, maxHoldMs: number): number {
  let cycleStart: number | null = null;
  let timerDeadline: number | null = null;

  for (const t of events) {
    // An idle timer scheduled by an earlier event may fire before this one arrives.
    if (timerDeadline !== null && t >= timerDeadline) {
      return timerDeadline;
    }
    if (cycleStart === null) cycleStart = t;
    // Bounded hold: stop extending the deadline and flush now.
    if (t - cycleStart >= maxHoldMs) {
      return t;
    }
    // Otherwise reset the idle timer.
    timerDeadline = t + syncMs;
  }
  // Stream ended: the last idle timer fires.
  return timerDeadline ?? 0;
}

const SYNC = 50;
const MAX_HOLD = 150;

describe('flicker filter flush timing', () => {
  it('sustained sub-50ms redraws: bounded policy flushes by MAX_FLICKER_HOLD_MS', () => {
    // Redraws every 30ms for ~1s (faster than the 50ms idle timer)
    const events = Array.from({ length: 34 }, (_, i) => i * 30); // 0,30,...,990
    const flushAt = simulateFlickerFlush(events, SYNC, MAX_HOLD);
    expect(flushAt).toBeLessThanOrEqual(MAX_HOLD);
  });

  it('reproduces the starvation: without the bound, flush is starved to end-of-stream', () => {
    const events = Array.from({ length: 34 }, (_, i) => i * 30); // 0..990
    const flushAt = simulateFlickerFlush(events, SYNC, Infinity);
    // Old behavior: idle timer keeps getting pushed; only fires 50ms after the LAST event.
    expect(flushAt).toBe(990 + SYNC);
  });

  it('quiescent case is unchanged: a lone redraw flushes after the idle timer', () => {
    expect(simulateFlickerFlush([0], SYNC, MAX_HOLD)).toBe(SYNC);
    expect(simulateFlickerFlush([0], SYNC, Infinity)).toBe(SYNC);
  });

  it('sparse redraws (slower than idle timer) are governed by the idle timer, not the bound', () => {
    // Redraws every 200ms — the 50ms idle timer always fires between them.
    const events = [0, 200, 400, 600];
    expect(simulateFlickerFlush(events, SYNC, MAX_HOLD)).toBe(SYNC);
  });

  it('bound never delays a flush beyond what the idle timer would have done', () => {
    // For any stream, bounded flush time <= unbounded flush time.
    const events = Array.from({ length: 20 }, (_, i) => i * 40); // 0..760, every 40ms
    const bounded = simulateFlickerFlush(events, SYNC, MAX_HOLD);
    const unbounded = simulateFlickerFlush(events, SYNC, Infinity);
    expect(bounded).toBeLessThanOrEqual(unbounded);
  });
});

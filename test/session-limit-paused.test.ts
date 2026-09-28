/**
 * @fileoverview Paused sessions have freed their process, so they must not count
 * toward MAX_CONCURRENT_SESSIONS — otherwise parking sessions still blocks new ones.
 */

import { describe, it, expect } from 'vitest';
import { MAX_CONCURRENT_SESSIONS, countActiveSessions } from '../src/config/map-limits.js';

describe('countActiveSessions', () => {
  it('excludes paused sessions', () => {
    const sessions = [{ paused: false }, { paused: true }, { paused: false }, { paused: true }];
    expect(countActiveSessions(sessions)).toBe(2);
  });

  it('accepts a Map values iterator, as the routes pass it', () => {
    const map = new Map([
      ['a', { paused: false }],
      ['b', { paused: true }],
    ]);
    expect(countActiveSessions(map.values())).toBe(1);
  });

  it('a full set of paused sessions leaves room for new ones', () => {
    const sessions = Array.from({ length: MAX_CONCURRENT_SESSIONS }, () => ({ paused: true }));
    expect(countActiveSessions(sessions)).toBeLessThan(MAX_CONCURRENT_SESSIONS);
  });
});

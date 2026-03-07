import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StaleExpirationMap } from '../src/utils/stale-expiration-map.js';

describe('StaleExpirationMap', () => {
  let map: StaleExpirationMap<string, number>;

  afterEach(() => {
    // Always dispose to clear cleanup timers
    map?.dispose();
  });

  describe('construction', () => {
    it('creates an empty map', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      expect(map.size).toBe(0);
      expect(map.isDisposed).toBe(false);
    });

    it('defaults refreshOnGet to true', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      // Verify by setting, advancing time partially, getting (refreshes), advancing again
      vi.useFakeTimers();
      map.set('a', 1);
      vi.advanceTimersByTime(800); // 800ms of 1000ms TTL
      map.get('a'); // should refresh
      vi.advanceTimersByTime(800); // 1600ms total, but only 800ms since last access
      expect(map.has('a')).toBe(true);
      vi.useRealTimers();
    });
  });

  describe('set/get', () => {
    beforeEach(() => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
    });

    it('stores and retrieves values', () => {
      map.set('a', 1);
      map.set('b', 2);
      expect(map.get('a')).toBe(1);
      expect(map.get('b')).toBe(2);
    });

    it('returns undefined for missing keys', () => {
      expect(map.get('nonexistent')).toBeUndefined();
    });

    it('overwrites existing values', () => {
      map.set('a', 1);
      map.set('a', 10);
      expect(map.get('a')).toBe(10);
    });

    it('supports chaining on set', () => {
      const result = map.set('a', 1).set('b', 2);
      expect(result).toBe(map);
      expect(map.size).toBe(2);
    });

    it('ignores set when disposed', () => {
      map.dispose();
      map.set('a', 1);
      expect(map.size).toBe(0);
    });
  });

  describe('TTL expiration', () => {
    it('expires entries after TTL', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      vi.advanceTimersByTime(1001);
      expect(map.get('a')).toBeUndefined();
      expect(map.size).toBe(0);
      vi.useRealTimers();
    });

    it('entries are accessible before TTL', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      vi.advanceTimersByTime(500);
      expect(map.get('a')).toBe(1);
      vi.useRealTimers();
    });

    it('get refreshes TTL when refreshOnGet is true', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000, refreshOnGet: true });
      map.set('a', 1);
      vi.advanceTimersByTime(800);
      map.get('a'); // refreshes to now
      vi.advanceTimersByTime(800); // 800ms after refresh, still within TTL
      expect(map.get('a')).toBe(1);
      vi.useRealTimers();
    });

    it('get does not refresh TTL when refreshOnGet is false', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000, refreshOnGet: false });
      map.set('a', 1);
      vi.advanceTimersByTime(800);
      map.get('a'); // does NOT refresh
      vi.advanceTimersByTime(300); // 1100ms total, past TTL
      expect(map.get('a')).toBeUndefined();
      vi.useRealTimers();
    });
  });

  describe('has', () => {
    it('returns true for non-expired keys', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      expect(map.has('a')).toBe(true);
    });

    it('returns false for missing keys', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      expect(map.has('nonexistent')).toBe(false);
    });

    it('returns false and deletes expired keys', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      vi.advanceTimersByTime(1001);
      expect(map.has('a')).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('peek', () => {
    it('returns value without refreshing TTL', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      vi.advanceTimersByTime(800);
      expect(map.peek('a')).toBe(1); // does not refresh
      vi.advanceTimersByTime(300); // 1100ms total
      expect(map.peek('a')).toBeUndefined();
      vi.useRealTimers();
    });

    it('returns undefined for missing keys', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      expect(map.peek('nonexistent')).toBeUndefined();
    });

    it('deletes expired entries on peek', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      vi.advanceTimersByTime(1001);
      map.peek('a');
      // The internal entry should be deleted
      expect(map.size).toBe(0);
      vi.useRealTimers();
    });
  });

  describe('delete', () => {
    it('removes an existing key', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      expect(map.delete('a')).toBe(true);
      expect(map.has('a')).toBe(false);
      expect(map.size).toBe(0);
    });

    it('returns false for non-existent key', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      expect(map.delete('nonexistent')).toBe(false);
    });

    it('does not call onExpire on manual delete', () => {
      const onExpire = vi.fn();
      map = new StaleExpirationMap({ ttlMs: 1000, onExpire });
      map.set('a', 1);
      map.delete('a');
      expect(onExpire).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      map.set('b', 2);
      map.clear();
      expect(map.size).toBe(0);
      expect(map.get('a')).toBeUndefined();
    });
  });

  describe('touch', () => {
    it('refreshes TTL without returning value', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      vi.advanceTimersByTime(800);
      expect(map.touch('a')).toBe(true);
      vi.advanceTimersByTime(800); // 1600ms total, but 800ms since touch
      expect(map.has('a')).toBe(true);
      vi.useRealTimers();
    });

    it('returns false for non-existent keys', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      expect(map.touch('nonexistent')).toBe(false);
    });

    it('returns false for expired keys', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      vi.advanceTimersByTime(1001);
      expect(map.touch('a')).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('getAge', () => {
    it('returns age since creation', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 10000 });
      map.set('a', 1);
      vi.advanceTimersByTime(3000);
      const age = map.getAge('a');
      expect(age).toBe(3000);
      vi.useRealTimers();
    });

    it('returns undefined for missing keys', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      expect(map.getAge('nonexistent')).toBeUndefined();
    });
  });

  describe('getRemainingTtl', () => {
    it('returns remaining time before expiration', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      vi.advanceTimersByTime(300);
      const remaining = map.getRemainingTtl('a');
      expect(remaining).toBe(700);
      vi.useRealTimers();
    });

    it('returns 0 for expired entries (before cleanup removes them)', () => {
      vi.useFakeTimers();
      // Use a long cleanup interval so the entry is not auto-removed
      map = new StaleExpirationMap({ ttlMs: 1000, cleanupIntervalMs: 60000 });
      map.set('a', 1);
      vi.advanceTimersByTime(2000);
      expect(map.getRemainingTtl('a')).toBe(0);
      vi.useRealTimers();
    });

    it('returns undefined after cleanup removes expired entry', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      vi.advanceTimersByTime(2000); // cleanup fires and removes 'a'
      expect(map.getRemainingTtl('a')).toBeUndefined();
      vi.useRealTimers();
    });

    it('returns undefined for missing keys', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      expect(map.getRemainingTtl('nonexistent')).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('removes expired entries and returns count', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      map.set('b', 2);
      vi.advanceTimersByTime(500);
      map.set('c', 3);
      vi.advanceTimersByTime(600); // 'a' and 'b' at 1100ms, 'c' at 600ms
      const removed = map.cleanup();
      expect(removed).toBe(2);
      expect(map.size).toBe(1);
      expect(map.has('c')).toBe(true);
      vi.useRealTimers();
    });

    it('calls onExpire for each expired entry', () => {
      vi.useFakeTimers();
      const onExpire = vi.fn();
      map = new StaleExpirationMap({ ttlMs: 1000, onExpire });
      map.set('a', 1);
      map.set('b', 2);
      vi.advanceTimersByTime(1001);
      map.cleanup();
      expect(onExpire).toHaveBeenCalledTimes(2);
      expect(onExpire).toHaveBeenCalledWith('a', 1);
      expect(onExpire).toHaveBeenCalledWith('b', 2);
      vi.useRealTimers();
    });

    it('returns 0 when nothing is expired', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      expect(map.cleanup()).toBe(0);
    });

    it('periodic cleanup runs automatically', () => {
      vi.useFakeTimers();
      const onExpire = vi.fn();
      map = new StaleExpirationMap({ ttlMs: 1000, cleanupIntervalMs: 500, onExpire });
      map.set('a', 1);
      vi.advanceTimersByTime(1500); // past TTL, and cleanup interval fires
      expect(onExpire).toHaveBeenCalledWith('a', 1);
      vi.useRealTimers();
    });
  });

  describe('iteration', () => {
    it('iterates non-expired entries via for..of', () => {
      map = new StaleExpirationMap({ ttlMs: 5000 });
      map.set('a', 1);
      map.set('b', 2);
      const entries: [string, number][] = [];
      for (const [k, v] of map) {
        entries.push([k, v]);
      }
      expect(entries).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
    });

    it('skips expired entries during iteration', () => {
      vi.useFakeTimers();
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      vi.advanceTimersByTime(500);
      map.set('b', 2);
      vi.advanceTimersByTime(600); // 'a' expired at 1100ms, 'b' at 600ms

      const entries: [string, number][] = [];
      for (const [k, v] of map) {
        entries.push([k, v]);
      }
      expect(entries).toEqual([['b', 2]]);
      vi.useRealTimers();
    });

    it('keys() yields non-expired keys', () => {
      map = new StaleExpirationMap({ ttlMs: 5000 });
      map.set('a', 1);
      map.set('b', 2);
      expect([...map.keys()]).toEqual(['a', 'b']);
    });

    it('values() yields non-expired values', () => {
      map = new StaleExpirationMap({ ttlMs: 5000 });
      map.set('a', 1);
      map.set('b', 2);
      expect([...map.values()]).toEqual([1, 2]);
    });
  });

  describe('dispose', () => {
    it('marks map as disposed', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      expect(map.isDisposed).toBe(false);
      map.dispose();
      expect(map.isDisposed).toBe(true);
    });

    it('clears all entries on dispose', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.set('a', 1);
      map.dispose();
      expect(map.size).toBe(0);
    });

    it('is idempotent', () => {
      map = new StaleExpirationMap({ ttlMs: 1000 });
      map.dispose();
      map.dispose(); // should not throw
      expect(map.isDisposed).toBe(true);
    });

    it('stops periodic cleanup after dispose', () => {
      vi.useFakeTimers();
      const onExpire = vi.fn();
      map = new StaleExpirationMap({ ttlMs: 1000, cleanupIntervalMs: 500, onExpire });
      map.set('a', 1);
      map.dispose();
      vi.advanceTimersByTime(2000);
      // onExpire should not be called because timer was stopped
      expect(onExpire).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});

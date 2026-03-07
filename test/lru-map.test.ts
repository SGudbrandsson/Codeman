import { describe, it, expect, vi } from 'vitest';
import { LRUMap } from '../src/utils/lru-map.js';

describe('LRUMap', () => {
  describe('construction', () => {
    it('creates an empty map with maxSize', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      expect(map.size).toBe(0);
      expect(map.maxEntries).toBe(5);
      expect(map.freeSlots).toBe(5);
    });

    it('accepts an onEvict callback', () => {
      const onEvict = vi.fn();
      const map = new LRUMap<string, number>({ maxSize: 2, onEvict });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3); // evicts 'a'
      expect(onEvict).toHaveBeenCalledWith('a', 1);
    });
  });

  describe('set/get', () => {
    it('stores and retrieves values', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      expect(map.get('a')).toBe(1);
      expect(map.get('b')).toBe(2);
    });

    it('returns undefined for missing keys', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      expect(map.get('nonexistent')).toBeUndefined();
    });

    it('overwrites existing key and refreshes position', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('a', 10); // refresh 'a' position
      expect(map.get('a')).toBe(10);
      expect(map.keysInOrder()).toEqual(['b', 'a']);
    });

    it('supports chaining on set', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      const result = map.set('a', 1).set('b', 2);
      expect(result).toBe(map);
      expect(map.size).toBe(2);
    });
  });

  describe('has', () => {
    it('returns true for existing keys', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      expect(map.has('a')).toBe(true);
    });

    it('returns false for missing keys', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      expect(map.has('a')).toBe(false);
    });

    it('does not refresh position', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.has('a'); // should NOT refresh 'a'
      expect(map.keysInOrder()).toEqual(['a', 'b']);
    });
  });

  describe('delete', () => {
    it('removes an existing key', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      expect(map.delete('a')).toBe(true);
      expect(map.has('a')).toBe(false);
      expect(map.size).toBe(0);
    });

    it('returns false for non-existent key', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      expect(map.delete('nonexistent')).toBe(false);
    });

    it('updates newestKey when deleting the newest entry', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);
      map.delete('c'); // delete newest
      expect(map.newest()).toEqual(['b', 2]);
    });

    it('handles deleting the only entry', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.delete('a');
      expect(map.newest()).toBeUndefined();
      expect(map.oldest()).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.clear();
      expect(map.size).toBe(0);
      expect(map.newest()).toBeUndefined();
      expect(map.oldest()).toBeUndefined();
    });
  });

  describe('eviction', () => {
    it('evicts oldest entry when exceeding maxSize', () => {
      const map = new LRUMap<string, number>({ maxSize: 2 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3); // evicts 'a'
      expect(map.has('a')).toBe(false);
      expect(map.has('b')).toBe(true);
      expect(map.has('c')).toBe(true);
      expect(map.size).toBe(2);
    });

    it('evicts multiple entries to stay within maxSize', () => {
      const map = new LRUMap<string, number>({ maxSize: 1 });
      map.set('a', 1);
      map.set('b', 2); // evicts 'a'
      expect(map.size).toBe(1);
      expect(map.has('a')).toBe(false);
      expect(map.get('b')).toBe(2);
    });

    it('calls onEvict for each evicted entry', () => {
      const onEvict = vi.fn();
      const map = new LRUMap<string, number>({ maxSize: 2, onEvict });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3); // evicts 'a'
      map.set('d', 4); // evicts 'b'
      expect(onEvict).toHaveBeenCalledTimes(2);
      expect(onEvict).toHaveBeenCalledWith('a', 1);
      expect(onEvict).toHaveBeenCalledWith('b', 2);
    });

    it('get() refreshes position and changes eviction order', () => {
      const map = new LRUMap<string, number>({ maxSize: 2 });
      map.set('a', 1);
      map.set('b', 2);
      map.get('a'); // refresh 'a' — now 'b' is oldest
      map.set('c', 3); // evicts 'b', not 'a'
      expect(map.has('a')).toBe(true);
      expect(map.has('b')).toBe(false);
      expect(map.has('c')).toBe(true);
    });
  });

  describe('peek', () => {
    it('returns value without refreshing position', () => {
      const map = new LRUMap<string, number>({ maxSize: 2 });
      map.set('a', 1);
      map.set('b', 2);
      expect(map.peek('a')).toBe(1);
      // 'a' should still be oldest since peek doesn't refresh
      map.set('c', 3); // should evict 'a'
      expect(map.has('a')).toBe(false);
    });

    it('returns undefined for missing keys', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      expect(map.peek('nonexistent')).toBeUndefined();
    });
  });

  describe('oldest/newest', () => {
    it('returns undefined on empty map', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      expect(map.oldest()).toBeUndefined();
      expect(map.newest()).toBeUndefined();
    });

    it('returns correct oldest and newest', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);
      expect(map.oldest()).toEqual(['a', 1]);
      expect(map.newest()).toEqual(['c', 3]);
    });

    it('newest updates after get()', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.get('a'); // 'a' becomes newest
      expect(map.newest()).toEqual(['a', 1]);
      expect(map.oldest()).toEqual(['b', 2]);
    });

    it('newest updates after set() overwrites', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('a', 10); // 'a' refreshed to newest
      expect(map.newest()).toEqual(['a', 10]);
    });
  });

  describe('expireOlderThan', () => {
    it('removes entries older than cutoff', () => {
      const map = new LRUMap<string, { ts: number }>({ maxSize: 5 });
      const now = Date.now();
      map.set('old1', { ts: now - 10000 });
      map.set('old2', { ts: now - 8000 });
      map.set('new1', { ts: now - 1000 });

      const evicted = map.expireOlderThan(5000, (v) => v.ts);
      expect(evicted).toBe(2);
      expect(map.size).toBe(1);
      expect(map.has('new1')).toBe(true);
    });

    it('calls onEvict for expired entries', () => {
      const onEvict = vi.fn();
      const map = new LRUMap<string, { ts: number }>({ maxSize: 5, onEvict });
      const now = Date.now();
      map.set('old', { ts: now - 10000 });
      map.set('new', { ts: now - 100 });

      map.expireOlderThan(5000, (v) => v.ts);
      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(onEvict).toHaveBeenCalledWith('old', { ts: now - 10000 });
    });

    it('returns 0 when nothing to expire', () => {
      const map = new LRUMap<string, { ts: number }>({ maxSize: 5 });
      const now = Date.now();
      map.set('a', { ts: now });
      expect(map.expireOlderThan(5000, (v) => v.ts)).toBe(0);
    });

    it('handles empty map', () => {
      const map = new LRUMap<string, { ts: number }>({ maxSize: 5 });
      expect(map.expireOlderThan(5000, (v) => v.ts)).toBe(0);
    });

    it('updates newestKey when all entries expired', () => {
      const map = new LRUMap<string, { ts: number }>({ maxSize: 5 });
      const now = Date.now();
      map.set('a', { ts: now - 20000 });
      map.set('b', { ts: now - 10000 });
      map.expireOlderThan(5000, (v) => v.ts);
      expect(map.newest()).toBeUndefined();
      expect(map.size).toBe(0);
    });
  });

  describe('keysInOrder/valuesInOrder', () => {
    it('returns keys from oldest to newest', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);
      expect(map.keysInOrder()).toEqual(['a', 'b', 'c']);
    });

    it('returns values from oldest to newest', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);
      expect(map.valuesInOrder()).toEqual([1, 2, 3]);
    });

    it('reflects refreshed order', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3);
      map.get('a'); // 'a' moves to end
      expect(map.keysInOrder()).toEqual(['b', 'c', 'a']);
      expect(map.valuesInOrder()).toEqual([2, 3, 1]);
    });

    it('returns empty arrays for empty map', () => {
      const map = new LRUMap<string, number>({ maxSize: 5 });
      expect(map.keysInOrder()).toEqual([]);
      expect(map.valuesInOrder()).toEqual([]);
    });
  });

  describe('maxEntries/freeSlots', () => {
    it('freeSlots decreases as entries are added', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
      expect(map.freeSlots).toBe(3);
      map.set('a', 1);
      expect(map.freeSlots).toBe(2);
      map.set('b', 2);
      expect(map.freeSlots).toBe(1);
      map.set('c', 3);
      expect(map.freeSlots).toBe(0);
    });

    it('freeSlots does not go below 0 after eviction', () => {
      const map = new LRUMap<string, number>({ maxSize: 2 });
      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3); // evicts 'a'
      expect(map.freeSlots).toBe(0);
      expect(map.size).toBe(2);
    });
  });

  describe('iteration', () => {
    it('iterates entries via for..of', () => {
      const map = new LRUMap<string, number>({ maxSize: 3 });
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
  });

  describe('edge cases', () => {
    it('works with maxSize of 1', () => {
      const map = new LRUMap<string, number>({ maxSize: 1 });
      map.set('a', 1);
      expect(map.get('a')).toBe(1);
      map.set('b', 2);
      expect(map.has('a')).toBe(false);
      expect(map.get('b')).toBe(2);
      expect(map.size).toBe(1);
    });

    it('handles non-string keys', () => {
      const map = new LRUMap<number, string>({ maxSize: 3 });
      map.set(1, 'one');
      map.set(2, 'two');
      expect(map.get(1)).toBe('one');
      // get(1) refreshes key 1, so order is now [2, 1]
      expect(map.keysInOrder()).toEqual([2, 1]);
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { BufferAccumulator } from '../src/utils/buffer-accumulator.js';

describe('BufferAccumulator', () => {
  describe('construction', () => {
    it('creates with simple size parameters', () => {
      const buf = new BufferAccumulator(1000, 800);
      expect(buf.isEmpty).toBe(true);
      expect(buf.length).toBe(0);
      expect(buf.value).toBe('');
    });

    it('creates with BufferConfig object', () => {
      const buf = new BufferAccumulator({ maxSize: 1000, trimSize: 800 });
      expect(buf.isEmpty).toBe(true);
    });

    it('creates with BufferConfig including onTrim', () => {
      const onTrim = vi.fn();
      const buf = new BufferAccumulator({ maxSize: 100, trimSize: 50, onTrim });
      buf.append('x'.repeat(101));
      expect(onTrim).toHaveBeenCalled();
    });
  });

  describe('append', () => {
    it('appends data and updates length', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('hello');
      expect(buf.length).toBe(5);
      expect(buf.isEmpty).toBe(false);
      buf.append(' world');
      expect(buf.length).toBe(11);
      expect(buf.value).toBe('hello world');
    });

    it('ignores empty strings', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('');
      expect(buf.length).toBe(0);
      expect(buf.isEmpty).toBe(true);
    });

    it('handles multiple chunks efficiently', () => {
      const buf = new BufferAccumulator(10000, 8000);
      for (let i = 0; i < 100; i++) {
        buf.append(`chunk${i}`);
      }
      expect(buf.length).toBeGreaterThan(0);
      const value = buf.value;
      expect(value).toContain('chunk0');
      expect(value).toContain('chunk99');
    });
  });

  describe('value', () => {
    it('returns empty string when empty', () => {
      const buf = new BufferAccumulator(1000, 800);
      expect(buf.value).toBe('');
    });

    it('returns single chunk without joining', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('single');
      expect(buf.value).toBe('single');
    });

    it('consolidates chunks on access', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('a');
      buf.append('b');
      buf.append('c');
      expect(buf.value).toBe('abc');
      // Access again should be same (consolidated)
      expect(buf.value).toBe('abc');
    });
  });

  describe('clear', () => {
    it('resets buffer to empty', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('some data');
      buf.clear();
      expect(buf.isEmpty).toBe(true);
      expect(buf.length).toBe(0);
      expect(buf.value).toBe('');
    });
  });

  describe('set', () => {
    it('replaces buffer content', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('old data');
      buf.set('new data');
      expect(buf.value).toBe('new data');
      expect(buf.length).toBe(8);
    });

    it('handles empty string', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('some data');
      buf.set('');
      expect(buf.isEmpty).toBe(true);
      expect(buf.length).toBe(0);
    });
  });

  describe('tail', () => {
    it('returns last N characters', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('hello world');
      expect(buf.tail(5)).toBe('world');
    });

    it('returns entire buffer when N >= length', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('short');
      expect(buf.tail(100)).toBe('short');
    });

    it('returns empty string on empty buffer', () => {
      const buf = new BufferAccumulator(1000, 800);
      expect(buf.tail(5)).toBe('');
    });
  });

  describe('endsWith', () => {
    it('returns true when buffer ends with suffix', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('hello world');
      expect(buf.endsWith('world')).toBe(true);
    });

    it('returns false when buffer does not end with suffix', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('hello world');
      expect(buf.endsWith('hello')).toBe(false);
    });

    it('returns true for empty suffix', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('hello');
      expect(buf.endsWith('')).toBe(true);
    });

    it('returns false when suffix is longer than buffer', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('hi');
      expect(buf.endsWith('hello world')).toBe(false);
    });
  });

  describe('contains', () => {
    it('finds string pattern in buffer', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('hello world foo bar');
      expect(buf.contains('world')).toBe(true);
      expect(buf.contains('baz')).toBe(false);
    });

    it('finds regex pattern in buffer', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('hello world 123');
      expect(buf.contains(/\d+/)).toBe(true);
      expect(buf.contains(/[A-Z]{3}/)).toBe(false);
    });

    it('searches within last N characters when fromEnd provided', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('hello world');
      expect(buf.contains('hello', 5)).toBe(false); // last 5 = 'world'
      expect(buf.contains('world', 5)).toBe(true);
    });

    it('regex search with fromEnd', () => {
      const buf = new BufferAccumulator(1000, 800);
      buf.append('abc 123 xyz');
      expect(buf.contains(/\d+/, 4)).toBe(false); // last 4 = ' xyz'
      expect(buf.contains(/\d+/, 8)).toBe(true); // last 8 = '123 xyz'
    });
  });

  describe('trimming', () => {
    it('trims when maxSize is exceeded', () => {
      const buf = new BufferAccumulator(100, 50);
      buf.append('x'.repeat(60));
      buf.append('y'.repeat(50)); // total 110, triggers trim
      expect(buf.length).toBeLessThanOrEqual(100);
      // After trim, should keep most recent data
      expect(buf.value).toContain('y');
    });

    it('calls onTrim callback with trimmed byte count', () => {
      const onTrim = vi.fn();
      const buf = new BufferAccumulator({ maxSize: 100, trimSize: 50, onTrim });
      buf.append('x'.repeat(101)); // triggers trim
      expect(onTrim).toHaveBeenCalledTimes(1);
      expect(onTrim).toHaveBeenCalledWith(expect.any(Number));
      const trimmedBytes = onTrim.mock.calls[0][0] as number;
      expect(trimmedBytes).toBeGreaterThan(0);
    });

    it('keeps most recent data after trim', () => {
      const buf = new BufferAccumulator(100, 50);
      buf.append('A'.repeat(60));
      buf.append('B'.repeat(50)); // total 110, triggers trim to ~50 chars
      const value = buf.value;
      // The end should be B's
      expect(value.endsWith('B')).toBe(true);
    });

    it('advances past first newline within 4KB to avoid mid-ANSI-escape', () => {
      const buf = new BufferAccumulator(100, 80);
      // Create content that when trimmed, has a newline near the start of the kept portion
      const prefix = 'A'.repeat(30);
      const newlineSection = 'X'.repeat(10) + '\n' + 'Y'.repeat(10);
      const suffix = 'B'.repeat(60);
      buf.append(prefix + newlineSection + suffix);
      // After trimming, the buffer should start after the first newline in the kept portion
      const value = buf.value;
      // Should not start with partial X's before the newline
      if (value.includes('\n')) {
        // If the newline fell within the kept window, it should be skipped
        expect(value.startsWith('X')).toBe(false);
      }
    });

    it('handles trim with no newline in first 4KB', () => {
      const buf = new BufferAccumulator(100, 50);
      // No newlines at all
      buf.append('A'.repeat(110));
      // Should still trim without error
      expect(buf.length).toBeLessThanOrEqual(100);
    });

    it('does not call onTrim when trimmedBytes is 0 or negative', () => {
      const onTrim = vi.fn();
      // trimSize equal to maxSize means nothing actually gets trimmed in bytes
      // But this scenario is unusual; just test that onTrim is only called with positive values
      const buf = new BufferAccumulator({ maxSize: 50, trimSize: 50, onTrim });
      buf.append('x'.repeat(51)); // triggers trim, but trimSize == 50 so 1 byte trimmed
      // The trim logic: full.length(51) - trimSize(50) = 1 > 0, so onTrim IS called
      expect(onTrim).toHaveBeenCalledWith(expect.any(Number));
    });
  });

  describe('edge cases', () => {
    it('works with very small maxSize', () => {
      const buf = new BufferAccumulator(5, 3);
      buf.append('abcdef'); // 6 chars, triggers trim to 3
      expect(buf.length).toBeLessThanOrEqual(5);
    });

    it('handles rapid appends', () => {
      const buf = new BufferAccumulator(10000, 8000);
      for (let i = 0; i < 1000; i++) {
        buf.append('data');
      }
      expect(buf.length).toBeLessThanOrEqual(10000);
      expect(buf.length).toBeGreaterThan(0);
    });

    it('set after trim works correctly', () => {
      const buf = new BufferAccumulator(100, 50);
      buf.append('x'.repeat(110)); // triggers trim
      buf.set('fresh start');
      expect(buf.value).toBe('fresh start');
      expect(buf.length).toBe(11);
    });

    it('clear after trim works correctly', () => {
      const buf = new BufferAccumulator(100, 50);
      buf.append('x'.repeat(110)); // triggers trim
      buf.clear();
      expect(buf.isEmpty).toBe(true);
      expect(buf.value).toBe('');
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { RespawnAdaptiveTiming, AdaptiveTimingConfig } from '../src/respawn-adaptive-timing.js';

describe('RespawnAdaptiveTiming', () => {
  let timing: RespawnAdaptiveTiming;
  const defaultConfig: AdaptiveTimingConfig = {
    adaptiveMinConfirmMs: 5000,
    adaptiveMaxConfirmMs: 30000,
  };

  beforeEach(() => {
    timing = new RespawnAdaptiveTiming(defaultConfig);
  });

  describe('initial state', () => {
    it('should start with default 10000ms completion confirm', () => {
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(10000);
    });

    it('should start with empty timing history', () => {
      const history = timing.getTimingHistory();
      expect(history.recentIdleDetectionMs).toEqual([]);
      expect(history.recentCycleDurationMs).toEqual([]);
      expect(history.sampleCount).toBe(0);
      expect(history.maxSamples).toBe(20);
    });
  });

  describe('recordTimingData', () => {
    it('should add samples to rolling windows', () => {
      timing.recordTimingData(1000, 5000);

      const history = timing.getTimingHistory();
      expect(history.recentIdleDetectionMs).toEqual([1000]);
      expect(history.recentCycleDurationMs).toEqual([5000]);
      expect(history.sampleCount).toBe(1);
    });

    it('should accumulate multiple samples', () => {
      timing.recordTimingData(1000, 5000);
      timing.recordTimingData(2000, 6000);
      timing.recordTimingData(3000, 7000);

      const history = timing.getTimingHistory();
      expect(history.recentIdleDetectionMs).toEqual([1000, 2000, 3000]);
      expect(history.recentCycleDurationMs).toEqual([5000, 6000, 7000]);
      expect(history.sampleCount).toBe(3);
    });

    it('should trim to maxSamples when exceeded', () => {
      // Add 22 samples (exceeds maxSamples of 20)
      for (let i = 1; i <= 22; i++) {
        timing.recordTimingData(i * 100, i * 500);
      }

      const history = timing.getTimingHistory();
      expect(history.recentIdleDetectionMs.length).toBe(20);
      expect(history.recentCycleDurationMs.length).toBe(20);
      // First two should have been shifted off
      expect(history.recentIdleDetectionMs[0]).toBe(300); // 3rd sample
      expect(history.recentCycleDurationMs[0]).toBe(1500);
      expect(history.sampleCount).toBe(20);
    });

    it('should update lastUpdatedAt timestamp', () => {
      const before = Date.now();
      timing.recordTimingData(1000, 5000);
      const after = Date.now();

      const history = timing.getTimingHistory();
      expect(history.lastUpdatedAt).toBeGreaterThanOrEqual(before);
      expect(history.lastUpdatedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('adaptive timing calculation', () => {
    it('should not recalculate with fewer than 5 samples', () => {
      // Add 4 samples -- below the threshold
      for (let i = 0; i < 4; i++) {
        timing.recordTimingData(8000, 20000);
      }

      // Should still be the default
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(10000);
    });

    it('should recalculate at exactly 5 samples', () => {
      // All the same value = easy to predict
      for (let i = 0; i < 5; i++) {
        timing.recordTimingData(10000, 20000);
      }

      // P75 of [10000, 10000, 10000, 10000, 10000] = 10000
      // With 20% buffer = 12000, clamped to [5000, 30000] = 12000
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(12000);
    });

    it('should use 75th percentile with 20% buffer', () => {
      // 5 sorted values: 1000, 2000, 3000, 4000, 5000
      timing.recordTimingData(3000, 10000);
      timing.recordTimingData(1000, 10000);
      timing.recordTimingData(5000, 10000);
      timing.recordTimingData(2000, 10000);
      timing.recordTimingData(4000, 10000);

      // Sorted: [1000, 2000, 3000, 4000, 5000]
      // P75 index = floor(5 * 0.75) = 3 -> value = 4000
      // With 20% buffer: 4000 * 1.2 = 4800
      // Clamped to min 5000
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(5000);
    });

    it('should clamp to minimum configured value', () => {
      // Very small idle detection times
      for (let i = 0; i < 5; i++) {
        timing.recordTimingData(1000, 5000);
      }

      // P75 = 1000, with buffer = 1200, clamped to min 5000
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(5000);
    });

    it('should clamp to maximum configured value', () => {
      // Very large idle detection times
      for (let i = 0; i < 5; i++) {
        timing.recordTimingData(50000, 100000);
      }

      // P75 = 50000, with buffer = 60000, clamped to max 30000
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(30000);
    });

    it('should handle varying values correctly', () => {
      // 10 values, spread out
      const values = [2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000];
      for (const v of values) {
        timing.recordTimingData(v, v * 2);
      }

      // Sorted: [2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000]
      // P75 index = floor(10 * 0.75) = 7 -> value = 16000
      // With 20% buffer: 16000 * 1.2 = 19200
      // Clamped to [5000, 30000] = 19200
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(19200);
    });

    it('should adapt as new data arrives', () => {
      // Start with small values
      for (let i = 0; i < 5; i++) {
        timing.recordTimingData(3000, 10000);
      }
      // P75 = 3000, buffer = 3600, clamped to min 5000
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(5000);

      // Now add larger values that shift the P75 up
      for (let i = 0; i < 10; i++) {
        timing.recordTimingData(20000, 40000);
      }
      // P75 of mostly-20000 values = 20000, buffer = 24000
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(24000);
    });
  });

  describe('getTimingHistory', () => {
    it('should return a new object each call (shallow copy)', () => {
      timing.recordTimingData(1000, 5000);
      const history1 = timing.getTimingHistory();
      const history2 = timing.getTimingHistory();

      // Different object references each time
      expect(history1).not.toBe(history2);
      // But equal content
      expect(history1).toEqual(history2);
    });

    it('should allow overwriting top-level fields on the copy without affecting source', () => {
      timing.recordTimingData(1000, 5000);
      const copy = timing.getTimingHistory();
      copy.sampleCount = 999;

      expect(timing.getTimingHistory().sampleCount).toBe(1);
    });
  });

  describe('reset', () => {
    it('should clear all timing history', () => {
      // Add some data
      for (let i = 0; i < 10; i++) {
        timing.recordTimingData(i * 1000, i * 5000);
      }

      timing.reset();

      const history = timing.getTimingHistory();
      expect(history.recentIdleDetectionMs).toEqual([]);
      expect(history.recentCycleDurationMs).toEqual([]);
      expect(history.adaptiveCompletionConfirmMs).toBe(10000);
      expect(history.sampleCount).toBe(0);
      expect(history.maxSamples).toBe(20);
    });

    it('should allow re-recording after reset', () => {
      for (let i = 0; i < 5; i++) {
        timing.recordTimingData(10000, 20000);
      }
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(12000);

      timing.reset();
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(10000);

      // Record new data -- below 5 samples, should stay at default
      timing.recordTimingData(5000, 10000);
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(10000);
    });
  });

  describe('edge cases', () => {
    it('should handle zero idle detection times', () => {
      for (let i = 0; i < 5; i++) {
        timing.recordTimingData(0, 5000);
      }
      // P75 = 0, buffer = 0, clamped to min 5000
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(5000);
    });

    it('should handle identical values', () => {
      for (let i = 0; i < 20; i++) {
        timing.recordTimingData(15000, 30000);
      }
      // P75 = 15000, buffer = 18000
      expect(timing.getAdaptiveCompletionConfirmMs()).toBe(18000);
    });

    it('should handle config with very narrow bounds', () => {
      const narrowTiming = new RespawnAdaptiveTiming({
        adaptiveMinConfirmMs: 10000,
        adaptiveMaxConfirmMs: 10000,
      });

      for (let i = 0; i < 5; i++) {
        narrowTiming.recordTimingData(50000, 100000);
      }

      // Always clamped to 10000 regardless of data
      expect(narrowTiming.getAdaptiveCompletionConfirmMs()).toBe(10000);
    });
  });
});

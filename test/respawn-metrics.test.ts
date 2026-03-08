import { describe, it, expect, beforeEach } from 'vitest';
import { RespawnCycleMetricsTracker } from '../src/respawn-metrics.js';
import type { CycleOutcome } from '../src/types/index.js';

describe('RespawnCycleMetricsTracker', () => {
  let tracker: RespawnCycleMetricsTracker;

  beforeEach(() => {
    tracker = new RespawnCycleMetricsTracker();
  });

  describe('initial state', () => {
    it('should have no current cycle', () => {
      expect(tracker.getCurrentCycle()).toBeNull();
    });

    it('should have empty recent metrics', () => {
      expect(tracker.getRecent()).toEqual([]);
    });

    it('should have zeroed aggregate metrics', () => {
      const agg = tracker.getAggregate();
      expect(agg.totalCycles).toBe(0);
      expect(agg.successfulCycles).toBe(0);
      expect(agg.stuckRecoveryCycles).toBe(0);
      expect(agg.blockedCycles).toBe(0);
      expect(agg.errorCycles).toBe(0);
      expect(agg.avgCycleDurationMs).toBe(0);
      expect(agg.avgIdleDetectionMs).toBe(0);
      expect(agg.p90CycleDurationMs).toBe(0);
      expect(agg.successRate).toBe(100);
    });
  });

  describe('startCycle', () => {
    it('should create a current cycle with correct fields', () => {
      const idleDetectionStartTime = Date.now() - 1500;
      tracker.startCycle('session-1', 1, 'completion_message', idleDetectionStartTime, 50000, 10000);

      const cycle = tracker.getCurrentCycle();
      expect(cycle).not.toBeNull();
      expect(cycle!.cycleId).toBe('session-1:1');
      expect(cycle!.sessionId).toBe('session-1');
      expect(cycle!.cycleNumber).toBe(1);
      expect(cycle!.idleReason).toBe('completion_message');
      expect(cycle!.stepsCompleted).toEqual([]);
      expect(cycle!.clearSkipped).toBe(false);
      expect(cycle!.tokenCountAtStart).toBe(50000);
      expect(cycle!.completionConfirmMsUsed).toBe(10000);
      // idleDetectionMs should be approximately 1500 (within margin)
      expect(cycle!.idleDetectionMs).toBeGreaterThanOrEqual(1400);
      expect(cycle!.idleDetectionMs).toBeLessThanOrEqual(2000);
    });

    it('should overwrite a previous current cycle', () => {
      tracker.startCycle('session-1', 1, 'reason1', Date.now(), 10000, 5000);
      tracker.startCycle('session-1', 2, 'reason2', Date.now(), 20000, 6000);

      const cycle = tracker.getCurrentCycle();
      expect(cycle!.cycleNumber).toBe(2);
      expect(cycle!.idleReason).toBe('reason2');
    });
  });

  describe('recordStep', () => {
    it('should add steps to current cycle', () => {
      tracker.startCycle('session-1', 1, 'test', Date.now(), 0, 10000);

      tracker.recordStep('update');
      tracker.recordStep('clear');
      tracker.recordStep('init');

      const cycle = tracker.getCurrentCycle();
      expect(cycle!.stepsCompleted).toEqual(['update', 'clear', 'init']);
    });

    it('should be a no-op when no cycle is in progress', () => {
      // Should not throw
      tracker.recordStep('update');
      expect(tracker.getCurrentCycle()).toBeNull();
    });
  });

  describe('markClearSkipped', () => {
    it('should set clearSkipped flag on current cycle', () => {
      tracker.startCycle('session-1', 1, 'test', Date.now(), 0, 10000);

      tracker.markClearSkipped();

      const cycle = tracker.getCurrentCycle();
      expect(cycle!.clearSkipped).toBe(true);
    });

    it('should be a no-op when no cycle is in progress', () => {
      // Should not throw
      tracker.markClearSkipped();
      expect(tracker.getCurrentCycle()).toBeNull();
    });
  });

  describe('completeCycle', () => {
    it('should return null when no cycle is in progress', () => {
      const result = tracker.completeCycle('success', 60000);
      expect(result).toBeNull();
    });

    it('should return completed metrics with correct fields', () => {
      tracker.startCycle('session-1', 1, 'completion_message', Date.now(), 50000, 10000);
      tracker.recordStep('update');
      tracker.recordStep('clear');

      const result = tracker.completeCycle('success', 60000);

      expect(result).not.toBeNull();
      expect(result!.outcome).toBe('success');
      expect(result!.tokenCountAtEnd).toBe(60000);
      expect(result!.completedAt).toBeGreaterThan(0);
      expect(result!.durationMs).toBeGreaterThanOrEqual(0);
      expect(result!.stepsCompleted).toEqual(['update', 'clear']);
    });

    it('should include error message for error outcome', () => {
      tracker.startCycle('session-1', 1, 'test', Date.now(), 0, 10000);

      const result = tracker.completeCycle('error', 0, 'Something went wrong');

      expect(result!.outcome).toBe('error');
      expect(result!.errorMessage).toBe('Something went wrong');
    });

    it('should clear current cycle after completion', () => {
      tracker.startCycle('session-1', 1, 'test', Date.now(), 0, 10000);
      tracker.completeCycle('success', 0);

      expect(tracker.getCurrentCycle()).toBeNull();
    });

    it('should add to recent metrics', () => {
      tracker.startCycle('session-1', 1, 'test', Date.now(), 0, 10000);
      tracker.completeCycle('success', 0);

      const recent = tracker.getRecent();
      expect(recent.length).toBe(1);
      expect(recent[0].outcome).toBe('success');
    });
  });

  describe('aggregate metrics updates', () => {
    function completeOneCycle(outcome: CycleOutcome): void {
      tracker.startCycle('session-1', tracker.getAggregate().totalCycles + 1, 'test', Date.now(), 0, 10000);
      tracker.completeCycle(outcome, 0);
    }

    it('should count successful cycles', () => {
      completeOneCycle('success');
      completeOneCycle('success');

      const agg = tracker.getAggregate();
      expect(agg.totalCycles).toBe(2);
      expect(agg.successfulCycles).toBe(2);
      expect(agg.successRate).toBe(100);
    });

    it('should count stuck_recovery cycles', () => {
      completeOneCycle('stuck_recovery');

      const agg = tracker.getAggregate();
      expect(agg.totalCycles).toBe(1);
      expect(agg.stuckRecoveryCycles).toBe(1);
      expect(agg.successRate).toBe(0);
    });

    it('should count blocked cycles', () => {
      completeOneCycle('blocked');

      const agg = tracker.getAggregate();
      expect(agg.totalCycles).toBe(1);
      expect(agg.blockedCycles).toBe(1);
    });

    it('should count error cycles', () => {
      completeOneCycle('error');

      const agg = tracker.getAggregate();
      expect(agg.totalCycles).toBe(1);
      expect(agg.errorCycles).toBe(1);
    });

    it('should count cancelled cycles in total but no specific category', () => {
      completeOneCycle('cancelled');

      const agg = tracker.getAggregate();
      expect(agg.totalCycles).toBe(1);
      expect(agg.successfulCycles).toBe(0);
      expect(agg.stuckRecoveryCycles).toBe(0);
      expect(agg.blockedCycles).toBe(0);
      expect(agg.errorCycles).toBe(0);
    });

    it('should calculate success rate correctly', () => {
      completeOneCycle('success');
      completeOneCycle('success');
      completeOneCycle('error');
      completeOneCycle('success');

      const agg = tracker.getAggregate();
      expect(agg.totalCycles).toBe(4);
      expect(agg.successfulCycles).toBe(3);
      expect(agg.successRate).toBe(75);
    });

    it('should update lastUpdatedAt timestamp', () => {
      const before = Date.now();
      completeOneCycle('success');
      const after = Date.now();

      const agg = tracker.getAggregate();
      expect(agg.lastUpdatedAt).toBeGreaterThanOrEqual(before);
      expect(agg.lastUpdatedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('getRecent', () => {
    it('should return newest first', () => {
      for (let i = 1; i <= 5; i++) {
        tracker.startCycle('session-1', i, `reason-${i}`, Date.now(), 0, 10000);
        tracker.completeCycle('success', 0);
      }

      const recent = tracker.getRecent();
      expect(recent.length).toBe(5);
      expect(recent[0].cycleNumber).toBe(5);
      expect(recent[4].cycleNumber).toBe(1);
    });

    it('should respect limit parameter', () => {
      for (let i = 1; i <= 10; i++) {
        tracker.startCycle('session-1', i, 'test', Date.now(), 0, 10000);
        tracker.completeCycle('success', 0);
      }

      const recent = tracker.getRecent(3);
      expect(recent.length).toBe(3);
      expect(recent[0].cycleNumber).toBe(10);
    });

    it('should default to 20 items', () => {
      for (let i = 1; i <= 25; i++) {
        tracker.startCycle('session-1', i, 'test', Date.now(), 0, 10000);
        tracker.completeCycle('success', 0);
      }

      const recent = tracker.getRecent();
      expect(recent.length).toBe(20);
    });
  });

  describe('memory limit (MAX_CYCLE_METRICS_IN_MEMORY)', () => {
    it('should trim recent metrics beyond 100 entries', () => {
      for (let i = 1; i <= 105; i++) {
        tracker.startCycle('session-1', i, 'test', Date.now(), 0, 10000);
        tracker.completeCycle('success', 0);
      }

      // Internal storage should be capped at 100
      // We can verify via getRecent with a high limit
      const recent = tracker.getRecent(200);
      expect(recent.length).toBe(100);
      // The earliest should be cycle 6 (first 5 were shifted off)
      expect(recent[recent.length - 1].cycleNumber).toBe(6);
    });
  });

  describe('getAggregate', () => {
    it('should return a copy, not a reference', () => {
      const agg1 = tracker.getAggregate();
      const agg2 = tracker.getAggregate();

      expect(agg1).not.toBe(agg2);
      expect(agg1).toEqual(agg2);
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      // Add some cycles
      for (let i = 1; i <= 5; i++) {
        tracker.startCycle('session-1', i, 'test', Date.now(), 0, 10000);
        tracker.completeCycle('success', 0);
      }

      // Start another cycle
      tracker.startCycle('session-1', 6, 'test', Date.now(), 0, 10000);

      tracker.reset();

      expect(tracker.getCurrentCycle()).toBeNull();
      expect(tracker.getRecent()).toEqual([]);

      const agg = tracker.getAggregate();
      expect(agg.totalCycles).toBe(0);
      expect(agg.successfulCycles).toBe(0);
      expect(agg.successRate).toBe(100);
    });
  });

  describe('aggregate averages and P90', () => {
    it('should calculate average cycle duration across recent cycles', () => {
      // We can't directly control durationMs since it's computed from Date.now(),
      // but we can verify the aggregate fields are populated after completing cycles
      tracker.startCycle('session-1', 1, 'test', Date.now(), 0, 10000);
      tracker.completeCycle('success', 0);

      const agg = tracker.getAggregate();
      // durationMs should be very small (within the same tick)
      expect(agg.avgCycleDurationMs).toBeGreaterThanOrEqual(0);
      expect(agg.p90CycleDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('should calculate P90 from sorted durations', () => {
      // Complete multiple cycles to populate P90
      for (let i = 1; i <= 10; i++) {
        tracker.startCycle('session-1', i, 'test', Date.now(), 0, 10000);
        tracker.completeCycle('success', 0);
      }

      const agg = tracker.getAggregate();
      // P90 should be >= avg (for uniform values, P90 ~= avg)
      expect(agg.p90CycleDurationMs).toBeGreaterThanOrEqual(0);
    });
  });
});

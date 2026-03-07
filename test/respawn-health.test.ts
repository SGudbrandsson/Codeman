import { describe, it, expect } from 'vitest';
import { calculateHealthScore, shouldSkipClear, HealthInputs } from '../src/respawn-health.js';
import type { RespawnAggregateMetrics, CircuitBreakerStatus } from '../src/types/index.js';

/**
 * Helper to create a default healthy HealthInputs object.
 * Override specific fields as needed.
 */
function createHealthInputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    aggregateMetrics: {
      totalCycles: 10,
      successfulCycles: 10,
      stuckRecoveryCycles: 0,
      blockedCycles: 0,
      errorCycles: 0,
      avgCycleDurationMs: 5000,
      avgIdleDetectionMs: 1000,
      p90CycleDurationMs: 8000,
      successRate: 100,
      lastUpdatedAt: Date.now(),
    },
    circuitBreakerStatus: null,
    iterationStallMetrics: null,
    aiCheckerState: { status: 'ready', consecutiveErrors: 0 },
    stuckRecoveryCount: 0,
    maxStuckRecoveries: 5,
    ...overrides,
  };
}

function createCircuitBreakerStatus(state: 'CLOSED' | 'HALF_OPEN' | 'OPEN'): CircuitBreakerStatus {
  return {
    state,
    consecutiveNoProgress: state === 'OPEN' ? 5 : state === 'HALF_OPEN' ? 2 : 0,
    consecutiveSameError: 0,
    consecutiveTestsFailure: 0,
    lastProgressIteration: 0,
    reason: `State: ${state}`,
    reasonCode: 'no_progress',
    lastTransitionAt: Date.now(),
    lastErrorMessage: null,
  };
}

describe('calculateHealthScore', () => {
  describe('overall score calculation', () => {
    it('should return 100 for perfectly healthy system', () => {
      const result = calculateHealthScore(createHealthInputs());

      expect(result.score).toBe(100);
      expect(result.status).toBe('excellent');
      expect(result.components.cycleSuccess).toBe(100);
      expect(result.components.circuitBreaker).toBe(100);
      expect(result.components.iterationProgress).toBe(100);
      expect(result.components.aiChecker).toBe(100);
      expect(result.components.stuckRecovery).toBe(100);
    });

    it('should return excellent for score >= 90', () => {
      const result = calculateHealthScore(createHealthInputs());
      expect(result.score).toBeGreaterThanOrEqual(90);
      expect(result.status).toBe('excellent');
    });

    it('should return good for score >= 70 and < 90', () => {
      // AI checker disabled = 30 (weight 0.15), everything else 100
      // Score = 100*0.35 + 100*0.2 + 100*0.2 + 30*0.15 + 100*0.1 = 35+20+20+4.5+10 = 89.5 -> 90
      // That's still excellent. Let's use circuitBreaker half-open for 50 (weight 0.2):
      // Score = 100*0.35 + 50*0.2 + 100*0.2 + 100*0.15 + 100*0.1 = 35+10+20+15+10 = 90
      // Still excellent. Use a lower cycleSuccess:
      const result = calculateHealthScore(
        createHealthInputs({
          aggregateMetrics: {
            totalCycles: 10,
            successfulCycles: 8,
            stuckRecoveryCycles: 1,
            blockedCycles: 1,
            errorCycles: 0,
            avgCycleDurationMs: 5000,
            avgIdleDetectionMs: 1000,
            p90CycleDurationMs: 8000,
            successRate: 80,
            lastUpdatedAt: Date.now(),
          },
          circuitBreakerStatus: createCircuitBreakerStatus('HALF_OPEN'),
        })
      );
      // cycleSuccess=80, circuitBreaker=50, iterationProgress=100, aiChecker=100, stuckRecovery=100
      // 80*0.35 + 50*0.2 + 100*0.2 + 100*0.15 + 100*0.1 = 28+10+20+15+10 = 83
      expect(result.score).toBe(83);
      expect(result.status).toBe('good');
    });

    it('should return degraded for score >= 50 and < 70', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          aggregateMetrics: {
            totalCycles: 10,
            successfulCycles: 5,
            stuckRecoveryCycles: 2,
            blockedCycles: 2,
            errorCycles: 1,
            avgCycleDurationMs: 5000,
            avgIdleDetectionMs: 1000,
            p90CycleDurationMs: 8000,
            successRate: 50,
            lastUpdatedAt: Date.now(),
          },
          circuitBreakerStatus: createCircuitBreakerStatus('HALF_OPEN'),
          aiCheckerState: { status: 'cooldown', consecutiveErrors: 0 },
        })
      );
      // cycleSuccess=50, circuitBreaker=50, iterationProgress=100, aiChecker=70, stuckRecovery=100
      // 50*0.35 + 50*0.2 + 100*0.2 + 70*0.15 + 100*0.1 = 17.5+10+20+10.5+10 = 68
      expect(result.score).toBe(68);
      expect(result.status).toBe('degraded');
    });

    it('should return critical for score < 50', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          aggregateMetrics: {
            totalCycles: 10,
            successfulCycles: 0,
            stuckRecoveryCycles: 3,
            blockedCycles: 4,
            errorCycles: 3,
            avgCycleDurationMs: 5000,
            avgIdleDetectionMs: 1000,
            p90CycleDurationMs: 8000,
            successRate: 0,
            lastUpdatedAt: Date.now(),
          },
          circuitBreakerStatus: createCircuitBreakerStatus('OPEN'),
          iterationStallMetrics: {
            stallDurationMs: 600000,
            warningThresholdMs: 300000,
            criticalThresholdMs: 600000,
          },
          aiCheckerState: { status: 'error', consecutiveErrors: 3 },
          stuckRecoveryCount: 5,
          maxStuckRecoveries: 5,
        })
      );
      // cycleSuccess=0, circuitBreaker=0, iterationProgress=0, aiChecker=50, stuckRecovery=0
      // 0*0.35 + 0*0.2 + 0*0.2 + 50*0.15 + 0*0.1 = 7.5 -> 8
      expect(result.score).toBeLessThan(50);
      expect(result.status).toBe('critical');
    });
  });

  describe('component: cycleSuccess', () => {
    it('should return 100 when no cycles have been tracked', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          aggregateMetrics: {
            totalCycles: 0,
            successfulCycles: 0,
            stuckRecoveryCycles: 0,
            blockedCycles: 0,
            errorCycles: 0,
            avgCycleDurationMs: 0,
            avgIdleDetectionMs: 0,
            p90CycleDurationMs: 0,
            successRate: 100,
            lastUpdatedAt: Date.now(),
          },
        })
      );
      expect(result.components.cycleSuccess).toBe(100);
    });

    it('should use successRate from aggregate metrics', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          aggregateMetrics: {
            totalCycles: 20,
            successfulCycles: 15,
            stuckRecoveryCycles: 3,
            blockedCycles: 1,
            errorCycles: 1,
            avgCycleDurationMs: 5000,
            avgIdleDetectionMs: 1000,
            p90CycleDurationMs: 8000,
            successRate: 75,
            lastUpdatedAt: Date.now(),
          },
        })
      );
      expect(result.components.cycleSuccess).toBe(75);
    });
  });

  describe('component: circuitBreaker', () => {
    it('should return 100 when circuit breaker is null', () => {
      const result = calculateHealthScore(createHealthInputs({ circuitBreakerStatus: null }));
      expect(result.components.circuitBreaker).toBe(100);
    });

    it('should return 100 for CLOSED state', () => {
      const result = calculateHealthScore(
        createHealthInputs({ circuitBreakerStatus: createCircuitBreakerStatus('CLOSED') })
      );
      expect(result.components.circuitBreaker).toBe(100);
    });

    it('should return 50 for HALF_OPEN state', () => {
      const result = calculateHealthScore(
        createHealthInputs({ circuitBreakerStatus: createCircuitBreakerStatus('HALF_OPEN') })
      );
      expect(result.components.circuitBreaker).toBe(50);
    });

    it('should return 0 for OPEN state', () => {
      const result = calculateHealthScore(
        createHealthInputs({ circuitBreakerStatus: createCircuitBreakerStatus('OPEN') })
      );
      expect(result.components.circuitBreaker).toBe(0);
    });
  });

  describe('component: iterationProgress', () => {
    it('should return 100 when stall metrics are null', () => {
      const result = calculateHealthScore(createHealthInputs({ iterationStallMetrics: null }));
      expect(result.components.iterationProgress).toBe(100);
    });

    it('should return 100 when stall duration is below half the warning threshold', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          iterationStallMetrics: {
            stallDurationMs: 10000,
            warningThresholdMs: 300000,
            criticalThresholdMs: 600000,
          },
        })
      );
      expect(result.components.iterationProgress).toBe(100);
    });

    it('should return 70 when stall duration is at half the warning threshold', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          iterationStallMetrics: {
            stallDurationMs: 150000,
            warningThresholdMs: 300000,
            criticalThresholdMs: 600000,
          },
        })
      );
      expect(result.components.iterationProgress).toBe(70);
    });

    it('should return 30 when stall duration hits warning threshold', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          iterationStallMetrics: {
            stallDurationMs: 300000,
            warningThresholdMs: 300000,
            criticalThresholdMs: 600000,
          },
        })
      );
      expect(result.components.iterationProgress).toBe(30);
    });

    it('should return 0 when stall duration hits critical threshold', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          iterationStallMetrics: {
            stallDurationMs: 600000,
            warningThresholdMs: 300000,
            criticalThresholdMs: 600000,
          },
        })
      );
      expect(result.components.iterationProgress).toBe(0);
    });

    it('should return 0 when stall duration exceeds critical threshold', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          iterationStallMetrics: {
            stallDurationMs: 900000,
            warningThresholdMs: 300000,
            criticalThresholdMs: 600000,
          },
        })
      );
      expect(result.components.iterationProgress).toBe(0);
    });
  });

  describe('component: aiChecker', () => {
    it('should return 100 for ready status with no errors', () => {
      const result = calculateHealthScore(
        createHealthInputs({ aiCheckerState: { status: 'ready', consecutiveErrors: 0 } })
      );
      expect(result.components.aiChecker).toBe(100);
    });

    it('should return 30 for disabled status', () => {
      const result = calculateHealthScore(
        createHealthInputs({ aiCheckerState: { status: 'disabled', consecutiveErrors: 0 } })
      );
      expect(result.components.aiChecker).toBe(30);
    });

    it('should return 70 for cooldown status', () => {
      const result = calculateHealthScore(
        createHealthInputs({ aiCheckerState: { status: 'cooldown', consecutiveErrors: 0 } })
      );
      expect(result.components.aiChecker).toBe(70);
    });

    it('should return 50 for ready status with consecutive errors', () => {
      const result = calculateHealthScore(
        createHealthInputs({ aiCheckerState: { status: 'ready', consecutiveErrors: 2 } })
      );
      expect(result.components.aiChecker).toBe(50);
    });
  });

  describe('component: stuckRecovery', () => {
    it('should return 100 when no stuck recoveries', () => {
      const result = calculateHealthScore(createHealthInputs({ stuckRecoveryCount: 0, maxStuckRecoveries: 5 }));
      expect(result.components.stuckRecovery).toBe(100);
    });

    it('should return 0 when stuck recoveries reach max', () => {
      const result = calculateHealthScore(createHealthInputs({ stuckRecoveryCount: 5, maxStuckRecoveries: 5 }));
      expect(result.components.stuckRecovery).toBe(0);
    });

    it('should return proportional score for partial recoveries', () => {
      const result = calculateHealthScore(createHealthInputs({ stuckRecoveryCount: 2, maxStuckRecoveries: 5 }));
      // 100 - (2/5) * 100 = 60
      expect(result.components.stuckRecovery).toBe(60);
    });

    it('should return 0 when stuck recoveries exceed max', () => {
      const result = calculateHealthScore(createHealthInputs({ stuckRecoveryCount: 10, maxStuckRecoveries: 5 }));
      expect(result.components.stuckRecovery).toBe(0);
    });
  });

  describe('recommendations', () => {
    it('should recommend no action for healthy system', () => {
      const result = calculateHealthScore(createHealthInputs());
      expect(result.recommendations).toEqual(['System is healthy. No action needed.']);
    });

    it('should recommend checking cycle success when low', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          aggregateMetrics: {
            totalCycles: 10,
            successfulCycles: 5,
            stuckRecoveryCycles: 3,
            blockedCycles: 1,
            errorCycles: 1,
            avgCycleDurationMs: 5000,
            avgIdleDetectionMs: 1000,
            p90CycleDurationMs: 8000,
            successRate: 50,
            lastUpdatedAt: Date.now(),
          },
        })
      );
      expect(result.recommendations).toContainEqual(expect.stringContaining('Cycle success rate is low'));
    });

    it('should recommend reviewing circuit breaker when open', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          circuitBreakerStatus: createCircuitBreakerStatus('OPEN'),
        })
      );
      expect(result.recommendations).toContainEqual(expect.stringContaining('Circuit breaker is open'));
    });

    it('should recommend checking iteration when stalled', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          iterationStallMetrics: {
            stallDurationMs: 400000,
            warningThresholdMs: 300000,
            criticalThresholdMs: 600000,
          },
        })
      );
      expect(result.recommendations).toContainEqual(expect.stringContaining('Iteration progress has stalled'));
    });

    it('should recommend checking AI checker when disabled', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          aiCheckerState: { status: 'disabled', consecutiveErrors: 3 },
        })
      );
      // aiChecker score = 30 (disabled), which is < 50 -> triggers recommendation
      expect(result.recommendations).toContainEqual(expect.stringContaining('AI idle checker has errors'));
    });

    it('should recommend adjusting timeouts when stuck recoveries are high', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          stuckRecoveryCount: 4,
          maxStuckRecoveries: 5,
        })
      );
      expect(result.recommendations).toContainEqual(expect.stringContaining('Multiple stuck-state recoveries'));
    });

    it('should include multiple recommendations when multiple components are degraded', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          aggregateMetrics: {
            totalCycles: 10,
            successfulCycles: 3,
            stuckRecoveryCycles: 3,
            blockedCycles: 2,
            errorCycles: 2,
            avgCycleDurationMs: 5000,
            avgIdleDetectionMs: 1000,
            p90CycleDurationMs: 8000,
            successRate: 30,
            lastUpdatedAt: Date.now(),
          },
          circuitBreakerStatus: createCircuitBreakerStatus('OPEN'),
          stuckRecoveryCount: 4,
          maxStuckRecoveries: 5,
        })
      );
      expect(result.recommendations.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('summary', () => {
    it('should include score in summary', () => {
      const result = calculateHealthScore(createHealthInputs());
      expect(result.summary).toContain('100/100');
    });

    it('should describe excellent status', () => {
      const result = calculateHealthScore(createHealthInputs());
      expect(result.summary).toContain('excellently');
    });

    it('should describe critical status with lowest component', () => {
      const result = calculateHealthScore(
        createHealthInputs({
          aggregateMetrics: {
            totalCycles: 10,
            successfulCycles: 0,
            stuckRecoveryCycles: 5,
            blockedCycles: 3,
            errorCycles: 2,
            avgCycleDurationMs: 5000,
            avgIdleDetectionMs: 1000,
            p90CycleDurationMs: 8000,
            successRate: 0,
            lastUpdatedAt: Date.now(),
          },
          circuitBreakerStatus: createCircuitBreakerStatus('OPEN'),
        })
      );
      expect(result.summary).toContain('critical');
    });

    it('should include calculatedAt timestamp', () => {
      const before = Date.now();
      const result = calculateHealthScore(createHealthInputs());
      const after = Date.now();

      expect(result.calculatedAt).toBeGreaterThanOrEqual(before);
      expect(result.calculatedAt).toBeLessThanOrEqual(after);
    });
  });
});

describe('shouldSkipClear', () => {
  it('should not skip when token count is 0 (unknown)', () => {
    expect(shouldSkipClear(0, 50, 200000)).toBe(false);
  });

  it('should skip when usage is below threshold', () => {
    // 10000 / 200000 = 5% < 50%
    expect(shouldSkipClear(10000, 50, 200000)).toBe(true);
  });

  it('should not skip when usage is above threshold', () => {
    // 150000 / 200000 = 75% > 50%
    expect(shouldSkipClear(150000, 50, 200000)).toBe(false);
  });

  it('should not skip when usage equals threshold', () => {
    // 100000 / 200000 = 50% == 50% -> not less than, so false
    expect(shouldSkipClear(100000, 50, 200000)).toBe(false);
  });

  it('should handle edge case of very small threshold', () => {
    // 1000 / 200000 = 0.5% < 1%
    expect(shouldSkipClear(1000, 1, 200000)).toBe(true);
  });

  it('should handle 100% threshold (always skip)', () => {
    // 190000 / 200000 = 95% < 100%
    expect(shouldSkipClear(190000, 100, 200000)).toBe(true);
  });

  it('should handle 0% threshold (never skip except when unknown)', () => {
    // Any positive count / total > 0% so not < 0%
    expect(shouldSkipClear(1, 0, 200000)).toBe(false);
  });
});

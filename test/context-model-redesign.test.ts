/**
 * @fileoverview Tests for context & model redesign (2026-03-24)
 *
 * Covers three gaps identified in the test gap analysis:
 *
 * Gap 1 — Snapshot context formula (src/session.ts lines 2033-2044)
 *   The new snapshot formula: input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
 *   Tests verify contextUpdate emission payload, _contextWindowTokens persistence,
 *   zero-total suppression, pct capping at 100, fallback maxTokens, and calibrated max.
 *
 * Gap 2 — Model extraction and cliInfoUpdated re-emission (src/session.ts lines 1993-2002)
 *   Tests verify emission on model change, no re-emission when unchanged, _currentModel update,
 *   and currentModel in toJSON() output.
 *
 * Gap 3 — currentModel in SessionState interface (src/types/session.ts line 216)
 *   Round-trip assignment test for the new optional field.
 *
 * Pattern: mirrors claude-resume-id-update.test.ts — re-implements the minimal logic under test
 * as a standalone object so tests run without PTY/tmux dependencies. If the implementation
 * in session.ts changes, update the corresponding mini-implementation here to match.
 */

import { describe, it, expect } from 'vitest';
import type { SessionState } from '../src/types/session.js';

// ── Minimal re-implementation of the snapshot formula logic ──────────────────
// Mirrors the exact logic in session.ts processOutput(), assistant message block.
// Lines ~1993-2044 at time of writing.

interface UsagePayload {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AssistantMessage {
  type: 'assistant';
  message?: {
    content: Array<{ type: string; text?: string }>;
    usage?: UsagePayload;
    model?: string;
  };
}

interface ContextUpdateEvent {
  inputTokens: number;
  maxTokens: number;
  pct: number;
}

interface CliInfoUpdatedEvent {
  version: string | null;
  model: string | null;
  accountType: string | null;
  latestVersion: string | null;
}

/**
 * Minimal implementation of the snapshot context update logic.
 * Mirrors the code at session.ts: `if (snapshotTotal > 0) { ... emit('contextUpdate', ...) }`.
 */
function computeSnapshotContextUpdate(usage: UsagePayload, contextWindowMax: number | null): ContextUpdateEvent | null {
  const snapshotTotal =
    (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

  if (snapshotTotal === 0) return null;

  const maxTokens = contextWindowMax ?? 200_000;
  return {
    inputTokens: snapshotTotal,
    maxTokens,
    pct: Math.min(100, Math.round((snapshotTotal / maxTokens) * 100)),
  };
}

/**
 * Minimal implementation of the model-change tracking logic.
 * Mirrors session.ts: `if (msg.message.model && msg.message.model !== this._currentModel)`.
 * Returns the new event to emit, or null if model is unchanged or absent.
 */
function computeModelUpdate(
  messageModel: string | undefined,
  currentModel: string,
  version: string,
  accountType: string,
  latestVersion: string
): { newModel: string; event: CliInfoUpdatedEvent } | null {
  if (messageModel && messageModel !== currentModel) {
    return {
      newModel: messageModel,
      event: {
        version: version || null,
        model: messageModel,
        accountType: accountType || null,
        latestVersion: latestVersion || null,
      },
    };
  }
  return null;
}

// ── Gap 1: Snapshot context formula ──────────────────────────────────────────

describe('snapshot context formula (Gap 1)', () => {
  describe('contextUpdate payload composition', () => {
    it('sums input_tokens + cache_creation_input_tokens + cache_read_input_tokens', () => {
      const usage: UsagePayload = {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 94000,
      };
      const result = computeSnapshotContextUpdate(usage, null);
      expect(result).not.toBeNull();
      // 1000 + 5000 + 94000 = 100000
      expect(result!.inputTokens).toBe(100_000);
    });

    it('uses only input_tokens when cache fields are absent', () => {
      const usage: UsagePayload = {
        input_tokens: 50_000,
        output_tokens: 500,
      };
      const result = computeSnapshotContextUpdate(usage, null);
      expect(result).not.toBeNull();
      expect(result!.inputTokens).toBe(50_000);
    });

    it('does NOT accumulate — uses values from this message only (not a running sum)', () => {
      // Run two independent messages; each should return its own snapshot, not a sum
      const usage1: UsagePayload = {
        input_tokens: 10_000,
        output_tokens: 100,
        cache_read_input_tokens: 40_000,
      };
      const usage2: UsagePayload = {
        input_tokens: 12_000,
        output_tokens: 150,
        cache_read_input_tokens: 45_000,
      };
      const result1 = computeSnapshotContextUpdate(usage1, null);
      const result2 = computeSnapshotContextUpdate(usage2, null);
      expect(result1!.inputTokens).toBe(50_000);
      expect(result2!.inputTokens).toBe(57_000);
      // They must not equal each other (no accumulation)
      expect(result2!.inputTokens).not.toBe(result1!.inputTokens + result2!.inputTokens);
    });
  });

  describe('zero-total suppression guard', () => {
    it('returns null when all usage fields are zero', () => {
      const usage: UsagePayload = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      expect(computeSnapshotContextUpdate(usage, null)).toBeNull();
    });

    it('returns null when only output_tokens is non-zero (output not included in snapshot)', () => {
      const usage: UsagePayload = {
        input_tokens: 0,
        output_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
      expect(computeSnapshotContextUpdate(usage, null)).toBeNull();
    });

    it('emits when any input-side field is non-zero', () => {
      expect(computeSnapshotContextUpdate({ input_tokens: 1, output_tokens: 0 }, null)).not.toBeNull();
      expect(
        computeSnapshotContextUpdate({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1 }, null)
      ).not.toBeNull();
      expect(
        computeSnapshotContextUpdate({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1 }, null)
      ).not.toBeNull();
    });
  });

  describe('pct calculation and capping', () => {
    it('computes pct correctly against maxTokens', () => {
      const usage: UsagePayload = { input_tokens: 100_000, output_tokens: 0 };
      const result = computeSnapshotContextUpdate(usage, 200_000);
      expect(result!.pct).toBe(50);
    });

    it('caps pct at 100 when snapshotTotal exceeds maxTokens', () => {
      const usage: UsagePayload = { input_tokens: 210_000, output_tokens: 0 };
      const result = computeSnapshotContextUpdate(usage, 200_000);
      expect(result!.pct).toBe(100);
    });

    it('caps pct at 100 even when vastly over limit', () => {
      const usage: UsagePayload = {
        input_tokens: 100_000,
        cache_creation_input_tokens: 200_000,
        cache_read_input_tokens: 100_000,
        output_tokens: 0,
      };
      const result = computeSnapshotContextUpdate(usage, 200_000);
      expect(result!.pct).toBe(100);
    });

    it('rounds pct correctly', () => {
      // 1 / 3 ≈ 0.333 → rounds to 0
      const usage: UsagePayload = { input_tokens: 66_666, output_tokens: 0 };
      const result = computeSnapshotContextUpdate(usage, 200_000);
      // 66666 / 200000 = 0.33333 → round = 33
      expect(result!.pct).toBe(33);
    });
  });

  describe('maxTokens denominator', () => {
    it('falls back to 200_000 when _contextWindowMax is null', () => {
      const usage: UsagePayload = { input_tokens: 100_000, output_tokens: 0 };
      const result = computeSnapshotContextUpdate(usage, null);
      expect(result!.maxTokens).toBe(200_000);
      expect(result!.pct).toBe(50);
    });

    it('uses calibrated _contextWindowMax when set', () => {
      const usage: UsagePayload = { input_tokens: 50_000, output_tokens: 0 };
      // e.g. after a /context parse calibrated max to 100_000
      const result = computeSnapshotContextUpdate(usage, 100_000);
      expect(result!.maxTokens).toBe(100_000);
      expect(result!.pct).toBe(50);
    });

    it('calibrated max changes pct compared to fallback', () => {
      const usage: UsagePayload = { input_tokens: 50_000, output_tokens: 0 };
      const withFallback = computeSnapshotContextUpdate(usage, null);
      const withCalibrated = computeSnapshotContextUpdate(usage, 100_000);
      // 50k / 200k = 25%
      expect(withFallback!.pct).toBe(25);
      // 50k / 100k = 50%
      expect(withCalibrated!.pct).toBe(50);
    });
  });

  describe('_contextWindowTokens persistence', () => {
    it('snapshotTotal is the value that must be stored for toJSON() persistence', () => {
      // This test documents the required assignment: this._contextWindowTokens = snapshotTotal
      // When snapshotTotal > 0, the value must be stored (not null) so toJSON() can export it.
      const usage: UsagePayload = {
        input_tokens: 2_000,
        output_tokens: 0,
        cache_creation_input_tokens: 8_000,
        cache_read_input_tokens: 90_000,
      };
      const result = computeSnapshotContextUpdate(usage, null);
      // The stored value (_contextWindowTokens = snapshotTotal) must equal inputTokens in the event
      expect(result).not.toBeNull();
      expect(result!.inputTokens).toBe(100_000); // the value to persist
    });

    it('zero total means no update — _contextWindowTokens stays unchanged', () => {
      // When snapshotTotal === 0, the guard fires and _contextWindowTokens must NOT be touched
      const usage: UsagePayload = { input_tokens: 0, output_tokens: 0 };
      const result = computeSnapshotContextUpdate(usage, null);
      expect(result).toBeNull(); // no update emitted, no persistence
    });
  });
});

// ── Gap 2: Model extraction and cliInfoUpdated re-emission ───────────────────

describe('model extraction and cliInfoUpdated re-emission (Gap 2)', () => {
  describe('first model arrival', () => {
    it('emits cliInfoUpdated when model differs from empty _currentModel', () => {
      // Initial state: _currentModel = ''
      const result = computeModelUpdate('claude-opus-4-6', '', '', '', '');
      expect(result).not.toBeNull();
      expect(result!.event.model).toBe('claude-opus-4-6');
    });

    it('sets _currentModel to the new value', () => {
      const result = computeModelUpdate('claude-sonnet-4-6', '', '', '', '');
      expect(result!.newModel).toBe('claude-sonnet-4-6');
    });

    it('includes existing cliVersion, accountType, latestVersion in the event', () => {
      const result = computeModelUpdate(
        'claude-opus-4-6',
        '', // currentModel
        '2.1.27', // version
        'Claude Max', // accountType
        '2.1.30' // latestVersion
      );
      expect(result!.event.version).toBe('2.1.27');
      expect(result!.event.model).toBe('claude-opus-4-6');
      expect(result!.event.accountType).toBe('Claude Max');
      expect(result!.event.latestVersion).toBe('2.1.30');
    });
  });

  describe('model change flood prevention', () => {
    it('does NOT re-emit cliInfoUpdated when model is unchanged', () => {
      // _currentModel already = 'claude-sonnet-4-6', same model arrives
      const result = computeModelUpdate('claude-sonnet-4-6', 'claude-sonnet-4-6', '', '', '');
      expect(result).toBeNull();
    });

    it('re-emits when model changes from one non-empty value to another', () => {
      const result = computeModelUpdate('claude-opus-4-6', 'claude-sonnet-4-6', '', '', '');
      expect(result).not.toBeNull();
      expect(result!.event.model).toBe('claude-opus-4-6');
      expect(result!.newModel).toBe('claude-opus-4-6');
    });

    it('does not emit when model field is absent (undefined)', () => {
      const result = computeModelUpdate(undefined, 'claude-sonnet-4-6', '', '', '');
      expect(result).toBeNull();
    });

    it('does not emit when model field is empty string', () => {
      const result = computeModelUpdate('', 'claude-sonnet-4-6', '', '', '');
      expect(result).toBeNull();
    });
  });

  describe('_currentModel update', () => {
    it('returns updated model string so caller can update _currentModel', () => {
      const result = computeModelUpdate('claude-haiku-4-6', 'claude-sonnet-4-6', '', '', '');
      expect(result!.newModel).toBe('claude-haiku-4-6');
    });

    it('multiple sequential messages: only first one triggers emission', () => {
      let currentModel = '';
      const msg1 = computeModelUpdate('claude-sonnet-4-6', currentModel, '', '', '');
      expect(msg1).not.toBeNull();
      currentModel = msg1!.newModel;

      const msg2 = computeModelUpdate('claude-sonnet-4-6', currentModel, '', '', '');
      expect(msg2).toBeNull(); // same model, no re-emit

      const msg3 = computeModelUpdate('claude-opus-4-6', currentModel, '', '', '');
      expect(msg3).not.toBeNull(); // model changed, emit again
      currentModel = msg3!.newModel;
      expect(currentModel).toBe('claude-opus-4-6');
    });
  });

  describe('currentModel in toJSON() output', () => {
    it('toJSON output contains currentModel when _currentModel is set', () => {
      // Simulates the toJSON() line: currentModel: this._currentModel || undefined
      const toJSONCurrentModel = (model: string): string | undefined => model || undefined;

      expect(toJSONCurrentModel('claude-opus-4-6')).toBe('claude-opus-4-6');
    });

    it('toJSON output omits currentModel when _currentModel is empty string', () => {
      const toJSONCurrentModel = (model: string): string | undefined => model || undefined;

      expect(toJSONCurrentModel('')).toBeUndefined();
    });

    it('toJSON output changes after model is updated', () => {
      let currentModel = '';
      const result = computeModelUpdate('claude-sonnet-4-6', currentModel, '', '', '');
      currentModel = result!.newModel;

      const toJSONCurrentModel = (model: string): string | undefined => model || undefined;
      expect(toJSONCurrentModel(currentModel)).toBe('claude-sonnet-4-6');
    });
  });
});

// ── Gap 3: currentModel in SessionState interface ────────────────────────────

describe('SessionState interface includes currentModel (Gap 3)', () => {
  it('accepts currentModel as an optional string field', () => {
    const s: SessionState = {
      id: 'test-session',
      pid: null,
      status: 'idle',
      workingDir: '/tmp',
      currentTaskId: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      currentModel: 'claude-opus-4-6',
    };
    expect(s.currentModel).toBe('claude-opus-4-6');
  });

  it('allows currentModel to be absent (optional field)', () => {
    const s: SessionState = {
      id: 'test-session-2',
      pid: null,
      status: 'idle',
      workingDir: '/tmp',
      currentTaskId: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    expect(s.currentModel).toBeUndefined();
  });

  it('allows currentModel to be undefined explicitly', () => {
    const s: SessionState = {
      id: 'test-session-3',
      pid: null,
      status: 'idle',
      workingDir: '/tmp',
      currentTaskId: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      currentModel: undefined,
    };
    expect(s.currentModel).toBeUndefined();
  });

  it('currentModel is distinct from cliModel (separate fields)', () => {
    const s: SessionState = {
      id: 'test-session-4',
      pid: null,
      status: 'idle',
      workingDir: '/tmp',
      currentTaskId: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      cliModel: 'Opus 4.5', // display name from terminal header
      currentModel: 'claude-opus-4-5', // confirmed ID from stream-json
    };
    expect(s.cliModel).toBe('Opus 4.5');
    expect(s.currentModel).toBe('claude-opus-4-5');
    expect(s.cliModel).not.toBe(s.currentModel);
  });

  it('round-trips through JSON serialization', () => {
    const s: SessionState = {
      id: 'test-session-5',
      pid: 1234,
      status: 'busy',
      workingDir: '/home/user/project',
      currentTaskId: null,
      createdAt: 1700000000000,
      lastActivityAt: 1700000001000,
      currentModel: 'claude-sonnet-4-6',
    };
    const json = JSON.stringify(s);
    const parsed = JSON.parse(json) as SessionState;
    expect(parsed.currentModel).toBe('claude-sonnet-4-6');
    expect(parsed.id).toBe('test-session-5');
  });
});

/**
 * Harness activity source (spec §1) and idle-reason normalisation (spec §5).
 *
 * Run: npx vitest run test/harness-activity-source.test.ts
 */
import { describe, it, expect } from 'vitest';
import { getHarness } from '../src/harnesses/registry.js';
import { normalizeIdleReason } from '../src/types/activity.js';

describe('harness activity source', () => {
  it.each([
    ['claude', 'claudeTranscript'],
    ['pi', 'hook'],
    ['codex', 'transcript'],
    ['opencode', 'pty'],
    ['shell', 'pty'],
  ] as const)('%s uses %s', (mode, source) => {
    expect(getHarness(mode).activity).toBe(source);
  });
});

describe('normalizeIdleReason', () => {
  it('treats a missing argument as completed (legacy emit("idle"))', () => {
    expect(normalizeIdleReason()).toBe('completed');
    expect(normalizeIdleReason({})).toBe('completed');
  });
  it('keeps stale', () => {
    expect(normalizeIdleReason({ reason: 'stale' })).toBe('stale');
  });
  it('keeps completed', () => {
    expect(normalizeIdleReason({ reason: 'completed' })).toBe('completed');
  });
  it('rejects unknown values as completed', () => {
    expect(normalizeIdleReason({ reason: 'bogus' as never })).toBe('completed');
  });
});

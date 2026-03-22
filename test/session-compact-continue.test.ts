/**
 * @fileoverview Unit tests for SessionCompactContinue.
 *
 * Tests the state machine, detection logic (COMPACT.md and phrase fallback),
 * event emission, and guard paths.
 *
 * fs/promises is mocked so no real filesystem access occurs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock node:fs/promises ────────────────────────────────────────────────────
// Must be declared before the module import so vitest hoists the mock.
vi.mock('node:fs/promises', () => ({
  default: {
    stat: vi.fn(),
  },
  stat: vi.fn(),
}));

import fs from 'node:fs/promises';
import { SessionCompactContinue } from '../src/session-compact-continue.js';

const mockedStat = vi.mocked(fs.stat);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFreshStatResult(ageMs: number = 1000): Awaited<ReturnType<typeof fs.stat>> {
  return {
    mtimeMs: Date.now() - ageMs,
  } as Awaited<ReturnType<typeof fs.stat>>;
}

function makeCallbacks(overrides?: { writeCommand?: (cmd: string) => Promise<boolean>; isStopped?: () => boolean }) {
  const writeCommand = vi.fn(async (_cmd: string) => true);
  const isStopped = vi.fn(() => false);
  return {
    writeCommand: overrides?.writeCommand ?? writeCommand,
    isStopped: overrides?.isStopped ?? isStopped,
    _writeCommand: writeCommand,
    _isStopped: isStopped,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionCompactContinue', () => {
  let scc: SessionCompactContinue;
  let callbacks: ReturnType<typeof makeCallbacks>;

  beforeEach(() => {
    // mockReset clears call counts AND any queued once-values, then we set the default.
    mockedStat.mockReset();
    // By default stat will reject with ENOENT (COMPACT.md absent) unless the test overrides it.
    mockedStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    callbacks = makeCallbacks();
    scc = new SessionCompactContinue(callbacks);
  });

  // ========== Initial state ==========

  describe('initial state', () => {
    it('starts disabled', () => {
      expect(scc.enabled).toBe(false);
    });

    it('starts in state "none"', () => {
      expect(scc.state).toBe('none');
    });
  });

  // ========== setEnabled ==========

  describe('setEnabled', () => {
    it('setEnabled(true) makes enabled === true', () => {
      scc.setEnabled(true);
      expect(scc.enabled).toBe(true);
    });

    it('setEnabled(false) makes enabled === false', () => {
      scc.setEnabled(true);
      scc.setEnabled(false);
      expect(scc.enabled).toBe(false);
    });

    it('setEnabled(false) resets state to "none" from sent_compact', async () => {
      scc.setEnabled(true);
      // Put the state machine into sent_compact
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000));
      await scc.onIdle('/workdir', '');
      expect(scc.state).toBe('sent_compact');

      scc.setEnabled(false);
      expect(scc.state).toBe('none');
    });
  });

  // ========== destroy ==========

  describe('destroy', () => {
    it('resets state to "none" when called from sent_compact', async () => {
      scc.setEnabled(true);
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000));
      await scc.onIdle('/workdir', '');
      expect(scc.state).toBe('sent_compact');

      scc.destroy();
      expect(scc.state).toBe('none');
    });

    it('is a no-op if already none', () => {
      scc.destroy();
      expect(scc.state).toBe('none');
    });
  });

  // ========== onIdle guards ==========

  describe('onIdle guards', () => {
    it('returns early without calling writeCommand when disabled', async () => {
      // scc is disabled by default
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000));
      await scc.onIdle('/workdir', '');
      expect(callbacks._writeCommand).not.toHaveBeenCalled();
      expect(scc.state).toBe('none');
    });

    it('returns early without calling writeCommand when isStopped() is true', async () => {
      scc.setEnabled(true);
      callbacks._isStopped.mockReturnValue(true);
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000));
      await scc.onIdle('/workdir', '');
      expect(callbacks._writeCommand).not.toHaveBeenCalled();
      expect(scc.state).toBe('none');
    });

    it('returns early (sent_compact step) when isStopped() is true', async () => {
      scc.setEnabled(true);
      // First idle: put state machine into sent_compact
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000));
      await scc.onIdle('/workdir', '');
      expect(scc.state).toBe('sent_compact');

      // Now stop the session before second idle
      callbacks._isStopped.mockReturnValue(true);
      await scc.onIdle('/workdir', '');
      // State stays sent_compact — isStopped guard fired
      expect(scc.state).toBe('sent_compact');
      // writeCommand was only called once (for /compact)
      expect(callbacks._writeCommand).toHaveBeenCalledTimes(1);
    });
  });

  // ========== state machine: none → sent_compact ==========

  describe('state machine: none → sent_compact (COMPACT.md primary path)', () => {
    it('sends /compact\\r and transitions to sent_compact when COMPACT.md is fresh', async () => {
      scc.setEnabled(true);
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000)); // 1 second old — fresh
      await scc.onIdle('/workdir', '');
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
      expect(scc.state).toBe('sent_compact');
    });

    it('does not transition when COMPACT.md is stale (> 30s)', async () => {
      scc.setEnabled(true);
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(31_000)); // 31 seconds old
      // No phrase in textOutput either
      await scc.onIdle('/workdir', '');
      expect(callbacks._writeCommand).not.toHaveBeenCalled();
      expect(scc.state).toBe('none');
    });

    it('does not transition when COMPACT.md is absent and no phrase matches', async () => {
      scc.setEnabled(true);
      mockedStat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      await scc.onIdle('/workdir', 'normal idle output with no compaction phrases');
      expect(callbacks._writeCommand).not.toHaveBeenCalled();
      expect(scc.state).toBe('none');
    });
  });

  // ========== state machine: sent_compact → none ==========

  describe('state machine: sent_compact → none', () => {
    it('sends continue\\r and transitions back to none on second idle', async () => {
      scc.setEnabled(true);

      // First idle: compact detected
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000));
      await scc.onIdle('/workdir', '');
      expect(scc.state).toBe('sent_compact');

      // Second idle: compact done — send continue
      await scc.onIdle('/workdir', '');
      expect(callbacks._writeCommand).toHaveBeenLastCalledWith('continue\r');
      expect(scc.state).toBe('none');
    });

    it('does not call stat on the second idle (sent_compact branch skips detection)', async () => {
      scc.setEnabled(true);
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000));
      await scc.onIdle('/workdir', '');

      mockedStat.mockClear();
      await scc.onIdle('/workdir', '');
      // stat should NOT have been called in the sent_compact branch
      expect(mockedStat).not.toHaveBeenCalled();
    });
  });

  // ========== event emission ==========

  describe('event emission', () => {
    it('emits compactSent when /compact is sent', async () => {
      scc.setEnabled(true);
      const handler = vi.fn();
      scc.on('compactSent', handler);

      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000));
      await scc.onIdle('/workdir', '');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits continueSent when continue is sent', async () => {
      scc.setEnabled(true);
      const handler = vi.fn();
      scc.on('continueSent', handler);

      // First idle: compact
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000));
      await scc.onIdle('/workdir', '');
      expect(handler).not.toHaveBeenCalled();

      // Second idle: continue
      await scc.onIdle('/workdir', '');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not emit compactSent when disabled', async () => {
      const handler = vi.fn();
      scc.on('compactSent', handler);

      mockedStat.mockResolvedValueOnce(makeFreshStatResult(1000));
      await scc.onIdle('/workdir', '');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ========== detection: COMPACT.md boundary ==========

  describe('COMPACT.md detection boundary', () => {
    it('detects as fresh when age is exactly at 30s boundary (ageMs == 30000)', async () => {
      scc.setEnabled(true);
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(30_000)); // exactly 30s
      await scc.onIdle('/workdir', '');
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
    });

    it('falls through to phrase scan when age is 30001ms', async () => {
      scc.setEnabled(true);
      mockedStat.mockResolvedValueOnce(makeFreshStatResult(30_001)); // just over 30s
      // No phrase — expect no command
      await scc.onIdle('/workdir', 'nothing matches');
      expect(callbacks._writeCommand).not.toHaveBeenCalled();
    });
  });

  // ========== detection: phrase fallback ==========

  describe('phrase fallback detection', () => {
    // Helper: COMPACT.md is absent (default mock rejects with ENOENT) → falls through to phrase scan
    async function phraseTest(phrase: string): Promise<void> {
      scc.setEnabled(true);
      // mockedStat already rejects by default (set in beforeEach)
      await scc.onIdle('/workdir', phrase);
    }

    it('detects "context is about to compact"', async () => {
      await phraseTest('The context is about to compact, please wait.');
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
    });

    it('detects "context is critically low"', async () => {
      await phraseTest('Warning: context is critically low.');
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
    });

    it('detects "state is saved to compact.md"', async () => {
      await phraseTest('State is saved to compact.md for resumption.');
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
    });

    it('detects "after compaction," (with comma)', async () => {
      await phraseTest('after compaction, I will resume from step 3.');
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
    });

    it('detects "after compaction " (with space)', async () => {
      await phraseTest("after compaction I'll continue the task.");
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
    });

    it('detects "will compact"', async () => {
      await phraseTest('Claude will compact the conversation now.');
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
    });

    it('detects "compaction imminent"', async () => {
      await phraseTest('compaction imminent — saving state.');
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
    });

    it('is case-insensitive — UPPER CASE phrase', async () => {
      await phraseTest('CONTEXT IS ABOUT TO COMPACT');
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
    });

    it('returns false / no command when no phrase matches', async () => {
      await phraseTest('Finished writing tests. All good.');
      expect(callbacks._writeCommand).not.toHaveBeenCalled();
      expect(scc.state).toBe('none');
    });

    it('detects phrase appearing in last 50 lines, not in earlier lines', async () => {
      scc.setEnabled(true);
      mockedStat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const earlyLines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      const recentLines = Array.from({ length: 10 }, (_, i) => `recent ${i}`).join('\n');
      const fullOutput = `${earlyLines}\ncontext is about to compact\n${recentLines}`;
      await scc.onIdle('/workdir', fullOutput);
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
    });
  });

  // ========== workingDir edge cases ==========

  describe('workingDir edge cases', () => {
    it('skips COMPACT.md check when workingDir is empty string', async () => {
      scc.setEnabled(true);
      // Default mockedStat rejects — but with empty workingDir the if (workingDir) guard
      // skips the stat call entirely; phrase fallback fires instead.
      await scc.onIdle('', 'context is about to compact');
      // phrase fallback should still fire
      expect(callbacks._writeCommand).toHaveBeenCalledWith('/compact\r');
      expect(mockedStat).not.toHaveBeenCalled();
    });
  });
});

// ─── SSE event constants (Gap 3) ─────────────────────────────────────────────

describe('SSE event constants: compact-and-continue', () => {
  it('SessionCompactSent equals "session:compactSent"', async () => {
    const { SessionCompactSent, SseEvent } = await import('../src/web/sse-events.js');
    expect(SessionCompactSent).toBe('session:compactSent');
    expect(SseEvent.SessionCompactSent).toBe('session:compactSent');
  });

  it('SessionContinueSent equals "session:continueSent"', async () => {
    const { SessionContinueSent, SseEvent } = await import('../src/web/sse-events.js');
    expect(SessionContinueSent).toBe('session:continueSent');
    expect(SseEvent.SessionContinueSent).toBe('session:continueSent');
  });
});

// ─── AutoCompactAndContinueSchema (Gap 4) ────────────────────────────────────

describe('AutoCompactAndContinueSchema', () => {
  it('accepts { enabled: true }', async () => {
    const { AutoCompactAndContinueSchema } = await import('../src/web/schemas.js');
    const result = AutoCompactAndContinueSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
  });

  it('accepts { enabled: false }', async () => {
    const { AutoCompactAndContinueSchema } = await import('../src/web/schemas.js');
    const result = AutoCompactAndContinueSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it('rejects missing enabled field', async () => {
    const { AutoCompactAndContinueSchema } = await import('../src/web/schemas.js');
    const result = AutoCompactAndContinueSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean enabled (string)', async () => {
    const { AutoCompactAndContinueSchema } = await import('../src/web/schemas.js');
    const result = AutoCompactAndContinueSchema.safeParse({ enabled: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean enabled (number)', async () => {
    const { AutoCompactAndContinueSchema } = await import('../src/web/schemas.js');
    const result = AutoCompactAndContinueSchema.safeParse({ enabled: 1 });
    expect(result.success).toBe(false);
  });
});

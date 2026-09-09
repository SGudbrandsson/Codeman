/**
 * @fileoverview Proves each capability consumer actually reads the registry,
 * rather than merely proving the registry's data is correct.
 */

import { describe, it, expect } from 'vitest';
import { getHarness } from '../src/harnesses/registry.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import type { SessionMode } from '../src/types/session.js';

describe('buildSpawnCommand delegates to the registry', () => {
  it('throws on an unknown mode instead of silently launching a shell', () => {
    // 'codex' was the placeholder here until Task 4 registered it; use a mode
    // that will never exist so the assertion keeps testing the throw.
    expect(() => buildSpawnCommand({ mode: 'nope' as SessionMode, sessionId: 'x' })).toThrow(/unknown harness/i);
  });

  it('produces the same claude command the registry does', () => {
    const ctx = { mode: 'claude' as SessionMode, sessionId: 'sid-1', claudeMode: 'normal' as const };
    expect(buildSpawnCommand(ctx)).toBe(getHarness('claude').buildCommand({ ...ctx }));
  });

  it('still returns $SHELL for shell mode', () => {
    expect(buildSpawnCommand({ mode: 'shell' as SessionMode, sessionId: 'x' })).toBe('$SHELL');
  });
});

describe('shell loses the Claude-only subsystems it used to receive', () => {
  // Regression lock for the one intentional behaviour change in this refactor.
  // The old guards read `mode !== 'opencode'`, which was true for shell.
  it.each(['ralph', 'respawn', 'claudeTranscript', 'claudeParsers'] as const)('shell.caps.%s is false', (cap) => {
    expect(getHarness('shell').caps[cap]).toBe(false);
  });
});

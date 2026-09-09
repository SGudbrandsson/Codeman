/**
 * @fileoverview Tests for the harness registry.
 *
 * The capability table test is the safety net for the guard refactor in Task 2:
 * it pins the exact truth values every `mode !== 'opencode'` guard used to produce,
 * so a refactor that changes claude or opencode behaviour fails loudly.
 */

import { describe, it, expect } from 'vitest';
import { getHarness, listHarnesses } from '../src/harnesses/registry.js';
import type { SessionMode } from '../src/types/session.js';

describe('harness registry', () => {
  it('exposes exactly the three existing harnesses', () => {
    expect(
      listHarnesses()
        .map((h) => h.id)
        .sort()
    ).toEqual(['claude', 'opencode', 'shell']);
  });

  it('throws on an unknown mode rather than falling back to a shell', () => {
    expect(() => getHarness('nope' as SessionMode)).toThrow(/unknown harness/i);
  });

  describe('capability table', () => {
    // Pins today's behaviour. claude and opencode reproduce the pre-refactor guards
    // exactly. shell's four Claude-only flags are FALSE here but were effectively
    // TRUE before the refactor, because the old guards read `mode !== 'opencode'`.
    // See spec section 2.
    const expected: Record<string, Record<string, boolean>> = {
      claude: {
        ralph: true,
        respawn: true,
        claudeTranscript: true,
        claudeParsers: true,
        requiresMux: false,
        preassignsSessionId: true,
        pausable: true,
        claudeHooks: true,
        usesClaudeModelDefaults: true,
      },
      opencode: {
        ralph: false,
        respawn: false,
        claudeTranscript: false,
        claudeParsers: false,
        requiresMux: true,
        preassignsSessionId: false,
        pausable: false,
        claudeHooks: false,
        usesClaudeModelDefaults: false,
      },
      shell: {
        ralph: false,
        respawn: false,
        claudeTranscript: false,
        claudeParsers: false,
        requiresMux: false,
        preassignsSessionId: false,
        pausable: false,
        claudeHooks: false,
        usesClaudeModelDefaults: false,
      },
    };

    for (const [mode, caps] of Object.entries(expected)) {
      it(`${mode} has the expected capabilities`, () => {
        expect(getHarness(mode as SessionMode).caps).toEqual(caps);
      });
    }
  });

  describe('buildCommand', () => {
    it('builds a claude command with session id and disallowed tools', () => {
      const cmd = getHarness('claude').buildCommand({
        sessionId: 'abc-123',
        mode: 'claude',
        claudeMode: 'dangerously-skip-permissions',
      });
      expect(cmd).toContain('claude');
      expect(cmd).toContain('--dangerously-skip-permissions');
      expect(cmd).toContain('--session-id "abc-123"');
      expect(cmd).toContain('--disallowedTools AskUserQuestion');
    });

    it('omits --session-id when resuming, which the claude CLI rejects', () => {
      const cmd = getHarness('claude').buildCommand({
        sessionId: 'abc-123',
        mode: 'claude',
        extraArgs: ['--resume', 'uuid-1'],
      });
      expect(cmd).not.toContain('--session-id');
      expect(cmd).toContain('--resume');
    });

    it('drops an unsafe model string instead of interpolating it', () => {
      const cmd = getHarness('claude').buildCommand({
        sessionId: 'abc-123',
        mode: 'claude',
        model: 'opus; rm -rf /',
      });
      expect(cmd).not.toContain('rm -rf');
      expect(cmd).not.toContain('--model');
    });

    it('builds an opencode command with a provider/model pair', () => {
      const cmd = getHarness('opencode').buildCommand({
        sessionId: 'x',
        mode: 'opencode',
        openCodeConfig: { model: 'anthropic/claude-sonnet-4-5' },
      });
      expect(cmd).toBe('opencode --model anthropic/claude-sonnet-4-5');
    });

    it('builds a shell command', () => {
      expect(getHarness('shell').buildCommand({ sessionId: 'x', mode: 'shell' })).toBe('$SHELL');
    });
  });
});

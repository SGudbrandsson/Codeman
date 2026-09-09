/**
 * @fileoverview Proves harness config and identity reach the spawn command.
 *
 * Session fields are inert unless they are forwarded through CreateSessionOptions
 * into TmuxManager.buildSpawnCommand. This asserts the options object actually
 * carries them, and (once codex/pi exist in Task 4) that the command string does too.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import { Session } from '../src/session.js';
import type { CreateSessionOptions, TerminalMultiplexer } from '../src/mux-interface.js';

/**
 * A mux stub that records the options it was handed and then fails.
 *
 * Failing is deliberate: `startInteractive()` falls through to the direct-PTY
 * branch, which for a `requiresMux` harness throws immediately — so the test
 * never spawns a real process, and the recorded options are the only thing that
 * matters.
 */
function recordingMux(): { mux: TerminalMultiplexer; calls: CreateSessionOptions[] } {
  const calls: CreateSessionOptions[] = [];
  const mux = {
    backend: 'tmux',
    isAvailable: () => true,
    muxSessionExists: () => false,
    isPaneDead: vi.fn().mockResolvedValue(false),
    createSession: vi.fn(async (options: CreateSessionOptions) => {
      calls.push(options);
      throw new Error('stub: no real tmux');
    }),
  } as unknown as TerminalMultiplexer;
  return { mux, calls };
}

describe('Session forwards harness config and identity to the mux spawn boundary', () => {
  it('passes codexConfig, piConfig and harnessSessionId into createSession', async () => {
    const { mux, calls } = recordingMux();
    const session = new Session({
      id: 'sess-1',
      workingDir: '/tmp',
      // opencode requires mux, so the direct-PTY fallback throws instead of spawning.
      mode: 'opencode',
      mux,
      useMux: true,
      codexConfig: { model: 'gpt-5.2' },
      piConfig: { model: 'anthropic/sonnet' },
      harnessSessionId: 'harness-id-1',
    });

    await expect(session.startInteractive()).rejects.toThrow(/require tmux/i);

    expect(calls).toHaveLength(1);
    expect(calls[0].codexConfig).toEqual({ model: 'gpt-5.2' });
    expect(calls[0].piConfig).toEqual({ model: 'anthropic/sonnet' });
    expect(calls[0].harnessSessionId).toBe('harness-id-1');
  });

  it('does not send Claude-only CLI args to a non-Claude harness', async () => {
    const { mux, calls } = recordingMux();
    const session = new Session({
      id: 'sess-2',
      workingDir: '/tmp',
      mode: 'opencode',
      mux,
      useMux: true,
    });
    session.claudeResumeId = '11111111-2222-4333-8444-555555555555';

    await expect(session.startInteractive()).rejects.toThrow(/require tmux/i);

    expect(calls[0].extraArgs).not.toContain('--resume');
    expect(calls[0].extraArgs).not.toContain('--mcp-config');
  });

  it('round-trips the harness config and identity through toState()', () => {
    const session = new Session({
      id: 'sess-3',
      workingDir: '/tmp',
      mode: 'shell',
      codexConfig: { model: 'gpt-5.2' },
      piConfig: { model: 'anthropic/sonnet' },
      harnessSessionId: 'harness-id-3',
    });
    const state = session.toState();
    expect(state.codexConfig).toEqual({ model: 'gpt-5.2' });
    expect(state.piConfig).toEqual({ model: 'anthropic/sonnet' });
    expect(state.harnessSessionId).toBe('harness-id-3');
  });

  it('setClaudeResumeId mirrors into the neutral harnessSessionId', () => {
    const session = new Session({ id: 'sess-4', workingDir: '/tmp', mode: 'claude' });
    session.setClaudeResumeId('11111111-2222-4333-8444-555555555555');
    expect(session.harnessSessionId).toBe('11111111-2222-4333-8444-555555555555');
  });
});

// The codex/pi harnesses do not exist until Task 4; these are un-skipped there.
describe('spawn boundary carries harness config', () => {
  it.skip('a configured codex session gets its model on the command line', () => {
    const cmd = buildSpawnCommand({
      mode: 'codex' as never,
      sessionId: 's1',
      codexConfig: { model: 'gpt-5.2' },
    });
    expect(cmd).toContain('-m gpt-5.2');
  });

  it.skip('a restored codex session resumes by its harnessSessionId', () => {
    const cmd = buildSpawnCommand({
      mode: 'codex' as never,
      sessionId: 's1',
      harnessSessionId: '01a085e9-15f5-7b80-8af1-411de2591ffe',
    });
    expect(cmd).toContain('resume 01a085e9-15f5-7b80-8af1-411de2591ffe');
  });

  it.skip('a fresh pi session reuses the Codeman session id', () => {
    const cmd = buildSpawnCommand({ mode: 'pi' as never, sessionId: 'codeman-sid-9' });
    expect(cmd).toContain('--session-id codeman-sid-9');
  });

  it.skip('a configured pi session gets its model', () => {
    const cmd = buildSpawnCommand({ mode: 'pi' as never, sessionId: 's', piConfig: { model: 'anthropic/sonnet' } });
    expect(cmd).toContain('--model anthropic/sonnet');
  });
});

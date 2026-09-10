/**
 * Activity token (spec §2): a per-process token Codeman generates when it launches a pi
 * process, exported as CODEMAN_ACTIVITY_TOKEN, and required on every harness_activity report.
 *
 * Rotated ONLY in the create-session and dead-pane-respawn branches of startInteractive();
 * attaching to a surviving pane (restore after a Codeman restart) keeps the persisted token,
 * because that surviving process still reports with it.
 *
 * `node-pty` is mocked and the multiplexer is a plain fake; no tmux or pi binary is touched.
 * The tmux command-prefix export is covered in test/tmux-spawn-outer-shell.test.ts.
 *
 * Run: npx vitest run test/activity-token.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    // A PID far above any real one, so SIGTERM/SIGKILL can never hit a live process.
    pid: 2_147_483_600,
    onData: () => {},
    onExit: () => {},
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

import { Session } from '../src/session.js';
import { ACTIVITY_TOKEN_PATTERN, newActivityToken } from '../src/activity-token.js';
import type {
  CreateSessionOptions,
  MuxSession,
  RespawnPaneOptions,
  TerminalMultiplexer,
} from '../src/mux-interface.js';
import type { SessionMode } from '../src/types/session.js';

const OLD_TOKEN = 'a'.repeat(32);

function fakeMux(opts: { exists: boolean; dead: boolean }) {
  return {
    backend: 'tmux',
    isAvailable: () => true,
    muxSessionExists: vi.fn(() => opts.exists),
    isPaneDead: vi.fn(async () => opts.dead),
    respawnPane: vi.fn(async (_o: RespawnPaneOptions) => 4242),
    createSession: vi.fn(async (o: CreateSessionOptions) => ({
      sessionId: o.sessionId,
      muxName: `codeman-${o.sessionId.slice(0, 8)}`,
      pid: 4242,
      createdAt: Date.now(),
      workingDir: o.workingDir,
      mode: o.mode,
      attached: false,
    })),
    capturePaneContent: vi.fn(() => null),
    getAttachCommand: () => 'tmux',
    getAttachArgs: (name: string) => ['attach-session', '-t', name],
    setAttached: vi.fn(),
    rebindSession: vi.fn(),
    killSession: vi.fn(async () => true),
    registerSession: vi.fn(),
  };
}

const sessions: Session[] = [];

/**
 * `existingPane`: 'none' → no mux session (create branch); 'dead' → dead pane (respawn
 * branch); 'live' → surviving pane (restored-session attach branch).
 */
function makeSession(mode: SessionMode, existingPane: 'none' | 'dead' | 'live') {
  const id = randomUUID();
  const mux = fakeMux({ exists: existingPane !== 'none', dead: existingPane === 'dead' });
  const muxSession: MuxSession | undefined =
    existingPane === 'none'
      ? undefined
      : {
          sessionId: id,
          muxName: `codeman-${id.slice(0, 8)}`,
          pid: 4242,
          createdAt: Date.now(),
          workingDir: '/tmp',
          mode,
          attached: false,
        };
  const session = new Session({
    id,
    workingDir: '/tmp',
    mode,
    mux: mux as unknown as TerminalMultiplexer,
    useMux: true,
    muxSession,
    harnessSessionId: mode === 'codex' ? 'codex-known-id' : undefined,
  });
  sessions.push(session);
  return { session, mux };
}

const hookOwnerOf = (s: Session) =>
  (s as unknown as { _hookOwner: { lastSeq?: number; ownerGen?: number } })._hookOwner;
const setHookOwner = (s: Session, v: { lastSeq?: number; ownerGen?: number }) => {
  (s as unknown as { _hookOwner: typeof v })._hookOwner = v;
};

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    try {
      await s.stop(false);
    } catch {
      /* already stopped */
    }
  }
});

describe('newActivityToken', () => {
  it('is 32 lowercase hex characters and random', () => {
    const a = newActivityToken();
    const b = newActivityToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(ACTIVITY_TOKEN_PATTERN.test(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('pattern rejects anything that is not exactly 32 lowercase hex', () => {
    for (const bad of ['', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(30)};x`, '$(id -u)']) {
      expect(ACTIVITY_TOKEN_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('startInteractive token rotation', () => {
  it('create-session branch: a pi session gets a fresh token, passed to createSession and persisted', async () => {
    const { session, mux } = makeSession('pi', 'none');
    await session.startInteractive();

    expect(mux.createSession).toHaveBeenCalledTimes(1);
    const token = mux.createSession.mock.calls[0][0].activityToken;
    expect(token).toMatch(ACTIVITY_TOKEN_PATTERN);
    expect(session.activityToken).toBe(token);
    expect(session.toState().activityToken).toBe(token);
  });

  it('dead-pane respawn branch: a pi session gets a NEW token, passed to respawnPane', async () => {
    const { session, mux } = makeSession('pi', 'dead');
    session.activityToken = OLD_TOKEN;
    await session.startInteractive();

    expect(mux.respawnPane).toHaveBeenCalledTimes(1);
    expect(mux.createSession).not.toHaveBeenCalled();
    const token = mux.respawnPane.mock.calls[0][0].activityToken;
    expect(token).toMatch(ACTIVITY_TOKEN_PATTERN);
    expect(token).not.toBe(OLD_TOKEN);
    expect(session.activityToken).toBe(token);
    expect(session.toState().activityToken).toBe(token);
  });

  it('surviving pane (restore after a Codeman restart): no spawn, the persisted token is kept', async () => {
    const { session, mux } = makeSession('pi', 'live');
    session.activityToken = OLD_TOKEN;
    await session.startInteractive();

    expect(mux.createSession).not.toHaveBeenCalled();
    expect(mux.respawnPane).not.toHaveBeenCalled();
    expect(session.activityToken).toBe(OLD_TOKEN);
    expect(session.toState().activityToken).toBe(OLD_TOKEN);
  });

  it.each(['claude', 'codex', 'shell', 'opencode'] as const)('a %s session passes no token', async (mode) => {
    const { session, mux } = makeSession(mode, 'none');
    await session.startInteractive();

    expect(mux.createSession).toHaveBeenCalledTimes(1);
    expect(mux.createSession.mock.calls[0][0].activityToken).toBeUndefined();
    expect(session.activityToken).toBeUndefined();
    expect(session.toState().activityToken).toBeUndefined();
  });

  it('rotation resets the hook ordering state (a new pi process restarts seq/gen at 1)', async () => {
    const created = makeSession('pi', 'none');
    setHookOwner(created.session, { lastSeq: 50, ownerGen: 3 });
    await created.session.startInteractive();
    expect(hookOwnerOf(created.session)).toEqual({});

    const respawned = makeSession('pi', 'dead');
    setHookOwner(respawned.session, { lastSeq: 50, ownerGen: 3 });
    await respawned.session.startInteractive();
    expect(hookOwnerOf(respawned.session)).toEqual({});
  });

  it('attaching to a surviving pane keeps the hook ordering state', async () => {
    const { session } = makeSession('pi', 'live');
    session.activityToken = OLD_TOKEN;
    setHookOwner(session, { lastSeq: 50, ownerGen: 3 });
    await session.startInteractive();

    expect(hookOwnerOf(session)).toEqual({ lastSeq: 50, ownerGen: 3 });
  });
});

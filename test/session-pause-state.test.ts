/**
 * @fileoverview Unit tests for the paused-session state machine on `Session`.
 *
 * Complements `test/session-pause-trackers.test.ts` (which covers tracker event
 * forwarding). Here we pin the persisted shape and the post-conditions that every
 * "don't touch a parked session" guard depends on:
 *
 * - `toState()` must stay byte-identical for unpaused sessions (the state store
 *   diffs on `JSON.stringify`) and must carry `paused`/`pausedAt` once parked —
 *   this is the hinge that makes "paused survives a server restart" work.
 * - `pause()` must leave `status === 'stopped'` and `isWorking === false`, and must
 *   NOT clear the terminal buffer (the preserved-scrollback promise).
 * - The interactive PTY's late `onExit` callback must not un-park the session by
 *   resetting its status to 'idle'.
 *
 * `node-pty` is mocked so `startInteractive()` can run without spawning Claude.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node-pty — capture the onData / onExit callbacks the Session registers
// ---------------------------------------------------------------------------
const ptyMocks = vi.hoisted(() => ({
  onDataCb: null as ((data: string) => void) | null,
  onExitCb: null as ((e: { exitCode: number }) => void) | null,
  kill: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    // A PID far above any real one, so the SIGTERM/SIGKILL in stop() can never hit a live process.
    pid: 2_147_483_600,
    onData: (cb: (data: string) => void) => {
      ptyMocks.onDataCb = cb;
    },
    onExit: (cb: (e: { exitCode: number }) => void) => {
      ptyMocks.onExitCb = cb;
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: ptyMocks.kill,
  })),
}));

import { Session } from '../src/session.js';

function makeSession(): Session {
  return new Session({ workingDir: '/tmp', useMux: false });
}

beforeEach(() => {
  ptyMocks.onDataCb = null;
  ptyMocks.onExitCb = null;
  ptyMocks.kill.mockClear();
});

describe('Session.toState() paused round-trip', () => {
  it('omits paused and pausedAt entirely for a session that was never parked', () => {
    const state = makeSession().toState();

    expect('paused' in state).toBe(false);
    expect('pausedAt' in state).toBe(false);
  });

  it('carries paused and pausedAt once the session is parked', async () => {
    const session = makeSession();
    await session.pause();

    const state = session.toState();
    expect(state.paused).toBe(true);
    expect(typeof state.pausedAt).toBe('number');
    // Preserved so `--resume` still works after a server restart
    expect(state.status).toBe('stopped');
  });

  it('omits paused and pausedAt again after clearPaused()', async () => {
    const session = makeSession();
    await session.pause();
    session.clearPaused();

    const state = session.toState();
    expect('paused' in state).toBe(false);
    expect('pausedAt' in state).toBe(false);
  });
});

describe('Session.pause() post-conditions', () => {
  it('leaves the session stopped and no longer mid-turn', async () => {
    const session = makeSession();
    (session as unknown as { _isWorking: boolean })._isWorking = true;

    await session.pause();

    expect(session.paused).toBe(true);
    expect(session.status).toBe('stopped');
    expect(session.isWorking).toBe(false);
    expect(session.isBusy()).toBe(false);
    expect(session.isIdle()).toBe(false);
    expect(session.isRunning()).toBe(false);
  });

  it('preserves the terminal scrollback', async () => {
    const session = makeSession();
    await session.startInteractive();
    ptyMocks.onDataCb!('scrollback worth keeping');

    await session.pause();

    expect(session.terminalBuffer).toContain('scrollback worth keeping');
  });

  it('records pausedAt', async () => {
    const before = Date.now();
    const session = makeSession();

    await session.pause();

    expect(session.pausedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('Session.markPaused() / clearPaused()', () => {
  it('markPaused() parks a restored session without touching any process', () => {
    const session = makeSession();

    session.markPaused(1_700_000_000_000);

    expect(session.paused).toBe(true);
    expect(session.pausedAt).toBe(1_700_000_000_000);
    expect(session.status).toBe('stopped');
    expect(session.pid).toBeNull();
  });

  it('markPaused() defaults pausedAt to now when the persisted value is missing', () => {
    const before = Date.now();
    const session = makeSession();

    session.markPaused();

    expect(session.pausedAt).toBeGreaterThanOrEqual(before);
  });

  it('clearPaused() releases the stopped latch so startInteractive() can run again', async () => {
    const session = makeSession();
    await session.pause();
    expect((session as unknown as { _isStopped: boolean })._isStopped).toBe(true);

    session.clearPaused();

    expect(session.paused).toBe(false);
    expect(session.pausedAt).toBeNull();
    expect((session as unknown as { _isStopped: boolean })._isStopped).toBe(false);
    expect(session.status).toBe('idle');

    await expect(session.startInteractive()).resolves.toBeUndefined();
    expect(session.pid).toBe(2_147_483_600);
  });
});

describe('late PTY exit callback', () => {
  it('does NOT reset a parked session back to idle', async () => {
    const session = makeSession();
    await session.startInteractive();
    const onExit = ptyMocks.onExitCb!;

    await session.pause();
    expect(session.status).toBe('stopped');

    // The PTY's exit callback is not awaited by stop() and can land afterwards.
    // If it reset the status, every `status === 'stopped'` guard would silently
    // stop protecting the parked session.
    onExit({ exitCode: 0 });

    expect(session.status).toBe('stopped');
    expect(session.paused).toBe(true);
  });

  it('still resets a non-paused session to idle', async () => {
    const session = makeSession();
    await session.startInteractive();
    const onExit = ptyMocks.onExitCb!;

    onExit({ exitCode: 0 });

    expect(session.status).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// PTY generation guard — a late exit from a killed PTY must not clobber its
// replacement. This is the pause -> resume race: node-pty delivers `onExit`
// asynchronously, so the OLD pty's callback can land after resume has already
// spawned a NEW one.
// ---------------------------------------------------------------------------

describe('stale PTY callbacks after pause -> resume', () => {
  it('ignores an exit from the superseded PTY instead of nulling the resumed one', async () => {
    const session = makeSession();
    await session.startInteractive();
    const staleExit = ptyMocks.onExitCb!;
    expect(staleExit).toBeTypeOf('function');

    await session.pause();

    // Resume: a brand new PTY (and therefore a new generation) is spawned.
    session.clearPaused();
    await session.startInteractive();
    const livePid = session.pid;
    expect(livePid).not.toBeNull();

    const onExit = vi.fn();
    session.on('exit', onExit);

    // The OLD pty's exit finally lands.
    staleExit({ exitCode: 0 });

    // It must not tear down the session that replaced it: the server's 'exit'
    // handler strips the terminal/SSE listeners, so emitting here would leave the
    // resumed session running invisibly.
    expect(onExit).not.toHaveBeenCalled();
    expect(session.pid).toBe(livePid);
    expect(session.status).not.toBe('stopped');
  });

  it('still handles the exit of the CURRENT pty normally', async () => {
    const session = makeSession();
    await session.startInteractive();
    const onExit = vi.fn();
    session.on('exit', onExit);

    ptyMocks.onExitCb!({ exitCode: 0 });

    expect(onExit).toHaveBeenCalledWith(0);
    expect(session.pid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A pause that did not actually kill the mux session must FAIL. `stop()` swallows
// tmux kill errors, so without this check pause would report success and persist
// `paused: true` while Claude kept running — the opposite of freeing memory.
// ---------------------------------------------------------------------------

describe('pause() verifies the mux session really died', () => {
  function withFakeMux(session: Session, muxSessionExists: boolean) {
    const mux = {
      killSession: vi.fn(async () => true),
      muxSessionExists: vi.fn(() => muxSessionExists),
      setAttached: vi.fn(),
      registerSession: vi.fn(),
    };
    // White-box: the mux plumbing is established by startInteractive()'s real mux path,
    // which is out of scope here — we only care about pause()'s post-kill verification.
    (session as unknown as { _mux: unknown })._mux = mux;
    (session as unknown as { _muxSession: unknown })._muxSession = { muxName: 'codeman-test' };
    return mux;
  }

  it('throws and marks the pause as failed when the pane survives', async () => {
    const session = makeSession();
    await session.startInteractive();
    const mux = withFakeMux(session, true);

    await expect(session.pause()).rejects.toThrow(/still alive/i);

    expect(mux.muxSessionExists).toHaveBeenCalledWith('codeman-test');
    // The session stays PARKED (so /resume and a retried /pause both have something to act
    // on) but flags that nothing was actually freed.
    expect(session.paused).toBe(true);
    expect(session.pauseFailed).toBe(true);
    expect(session.toState().paused).toBe(true);
    expect(session.toState().pauseFailed).toBe(true);
  });

  it('re-adopts the surviving pane so resume attaches instead of creating a duplicate', async () => {
    const session = makeSession();
    await session.startInteractive();
    const mux = withFakeMux(session, true);

    await expect(session.pause()).rejects.toThrow(/still alive/i);

    // stop() nulled the binding and the mux manager's record of it; both must come back,
    // otherwise startInteractive() would try `tmux new-session` on a name that still exists
    // and a retried pause would have nothing left to kill.
    expect((session as unknown as { _muxSession: { muxName: string } | null })._muxSession?.muxName).toBe(
      'codeman-test'
    );
    expect(mux.registerSession).toHaveBeenCalledWith(expect.objectContaining({ muxName: 'codeman-test' }));
  });

  it('retries the kill on a second pause instead of reporting a false success', async () => {
    const session = makeSession();
    await session.startInteractive();
    const mux = withFakeMux(session, true);
    await expect(session.pause()).rejects.toThrow(/still alive/i);
    mux.killSession.mockClear();

    // Second attempt: the pane is gone this time.
    mux.muxSessionExists.mockReturnValue(false);
    await expect(session.pause()).resolves.toBeUndefined();

    expect(mux.killSession).toHaveBeenCalledTimes(1);
    expect(session.paused).toBe(true);
    expect(session.pauseFailed).toBe(false);
    expect(session.toState().pauseFailed).toBeUndefined();
  });

  it('verifies by the deterministic mux name when the binding is already gone', async () => {
    const session = makeSession();
    await session.startInteractive();
    const mux = withFakeMux(session, true);
    // Simulate the state an older failed pause left behind: flag cleared, binding nulled.
    (session as unknown as { _muxSession: unknown })._muxSession = null;

    await expect(session.pause()).rejects.toThrow(/still alive/i);
    expect(mux.muxSessionExists).toHaveBeenCalledWith(`codeman-${session.id.slice(0, 8)}`);
  });

  it('succeeds and parks the session when the pane is gone', async () => {
    const session = makeSession();
    await session.startInteractive();
    withFakeMux(session, false);

    await expect(session.pause()).resolves.toBeUndefined();

    expect(session.paused).toBe(true);
    expect(session.pauseFailed).toBe(false);
    expect(session.status).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// Non-mux sessions have no pane to check — the PTY process itself is the proof.
// ---------------------------------------------------------------------------

describe('pause() verifies the PTY died for a non-mux session', () => {
  it('throws and flags the failure when the process is still live', async () => {
    const session = makeSession();
    await session.startInteractive();
    const isLive = vi
      .spyOn(Session as unknown as { isProcessLive: (pid: number) => boolean }, 'isProcessLive')
      .mockReturnValue(true);

    await expect(session.pause()).rejects.toThrow(/still running/i);

    expect(isLive).toHaveBeenCalledWith(2_147_483_600);
    expect(session.paused).toBe(true);
    expect(session.pauseFailed).toBe(true);
    isLive.mockRestore();
  });

  it('parks cleanly when the process is gone', async () => {
    const session = makeSession();
    await session.startInteractive();

    await expect(session.pause()).resolves.toBeUndefined();
    expect(session.pauseFailed).toBe(false);
  });
});

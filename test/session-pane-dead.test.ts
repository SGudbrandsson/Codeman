/**
 * Session pane-death state: `markPaneDead()`, the dead-pane start guard in
 * `startInteractive()`/`startShell()` (attach-client release + `_startInFlight` re-entry guard),
 * and how the dead state survives / is cleared by the exit handlers, stop, prepareForRestart
 * and rebindMuxSession.
 *
 * Same harness as session-activity-lifecycle.test.ts: `node-pty` is mocked (every spawn is
 * recorded so exits can be replayed), the multiplexer is a plain fake, and activity monitor
 * factories are swapped for fakes. No tmux, harness binary or transcript file is touched.
 * Restarts wait for the real 300 ms respawn delay + 300 ms attach-client kill.
 *
 * Run: npx vitest run test/session-pane-dead.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

interface SpawnRecord {
  onData?: (data: string) => void;
  onExit?: (e: { exitCode: number }) => void;
  kill: ReturnType<typeof vi.fn>;
}

const ptyMocks = vi.hoisted(() => ({ spawned: [] as SpawnRecord[] }));

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const rec: SpawnRecord = { kill: vi.fn() };
    ptyMocks.spawned.push(rec);
    return {
      // A PID far above any real one, so SIGTERM/SIGKILL can never hit a live process.
      pid: 2_147_483_600,
      onData: (cb: (data: string) => void) => {
        rec.onData = cb;
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        rec.onExit = cb;
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: rec.kill,
    };
  }),
}));

import { Session } from '../src/session.js';
import { activityMonitorFactories, type ActivityMonitor, type ActivityState } from '../src/activity-monitor.js';
import type { ActivitySource } from '../src/types/activity.js';
import type { CreateSessionOptions, TerminalMultiplexer } from '../src/mux-interface.js';
import type { SessionMode } from '../src/types/session.js';

class FakeMonitor extends EventEmitter implements ActivityMonitor {
  state: ActivityState;
  stopped = false;
  constructor(private readonly initial: ActivityState) {
    super();
    this.state = initial;
  }
  async start(): Promise<void> {
    if (this.initial === 'working') this.emit('working');
  }
  stop(): void {
    this.stopped = true;
  }
  setHarnessSessionId(): void {}
}

const originalFactories = { ...activityMonitorFactories };
let instances: FakeMonitor[] = [];
const sessions: Session[] = [];

function installFake(source: ActivitySource, initial: ActivityState): void {
  activityMonitorFactories[source] = () => {
    const m = new FakeMonitor(initial);
    instances.push(m);
    return m;
  };
}

function fakeMux() {
  return {
    backend: 'tmux',
    isAvailable: () => true,
    muxSessionExists: vi.fn(() => true),
    isPaneDead: vi.fn(async (_muxName: string) => false),
    respawnPane: vi.fn(async (_o: unknown) => 4242),
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

function makeSession(mode: SessionMode, opts: { useMux?: boolean } = {}) {
  const mux = fakeMux();
  const session = new Session({
    id: randomUUID(),
    workingDir: '/tmp',
    mode,
    mux: mux as unknown as TerminalMultiplexer,
    useMux: opts.useMux ?? true,
  });
  sessions.push(session);
  const events: Array<{ type: string; info?: unknown }> = [];
  for (const type of ['working', 'idle', 'exit', 'completion', 'paneDied']) {
    session.on(type, (info?: unknown) => events.push({ type, info }));
  }
  return { session, mux, events };
}

const RUNNING = 'Session already has a running process';
const lastPty = () => ptyMocks.spawned[ptyMocks.spawned.length - 1];
const count = (events: Array<{ type: string }>, type: string) => events.filter((e) => e.type === type).length;
const monitorOf = (s: Session) => (s as unknown as { _activityMonitor: ActivityMonitor | null })._activityMonitor;
const startInFlight = (s: Session) => (s as unknown as { _startInFlight: boolean })._startInFlight;
const ptyOf = (s: Session) => (s as unknown as { ptyProcess: { kill: unknown } }).ptyProcess;

beforeEach(() => {
  ptyMocks.spawned = [];
  instances = [];
});

afterEach(async () => {
  vi.useRealTimers();
  Object.assign(activityMonitorFactories, originalFactories);
  for (const s of sessions.splice(0)) {
    try {
      await s.stop(false);
    } catch {
      /* already stopped */
    }
  }
});

describe('markPaneDead()', () => {
  it('reports the session exited, detaches the monitor and emits only paneDied', async () => {
    installFake('claudeTranscript', 'working');
    const { session, events } = makeSession('claude');
    await session.startInteractive();
    expect(session.isWorking).toBe(true);
    events.length = 0;

    expect(session.markPaneDead(2)).toBe(true);

    expect(session.status).toBe('stopped');
    expect(session.paneDead).toBe(true);
    expect(session.paneExitStatus).toBe(2);
    expect(session.pid).toBeNull();
    expect(session.isWorking).toBe(false);
    expect(instances[0].stopped).toBe(true);
    expect(monitorOf(session)).toBeNull();
    expect(events).toEqual([{ type: 'paneDied', info: { exitStatus: 2 } }]);
    // The attach client is left running; only a restart releases it
    expect(lastPty().kill).not.toHaveBeenCalled();
  });

  it('returns false on a second call without emitting again', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, events } = makeSession('claude');
    await session.startInteractive();
    session.markPaneDead(1);

    expect(session.markPaneDead(7)).toBe(false);

    expect(session.paneExitStatus).toBe(1);
    expect(count(events, 'paneDied')).toBe(1);
  });

  it('is a no-op for a paused session', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, events } = makeSession('claude');
    await session.startInteractive();
    session.markPaused(1_700_000_000_000);

    expect(session.markPaneDead(0)).toBe(false);

    expect(session.paneDead).toBe(false);
    expect(session.paused).toBe(true);
    expect(count(events, 'paneDied')).toBe(0);
  });

  it('is a no-op after stop()', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, events } = makeSession('claude');
    await session.startInteractive();
    await session.stop(false);

    expect(session.markPaneDead(0)).toBe(false);

    expect(session.paneDead).toBe(false);
    expect(count(events, 'paneDied')).toBe(0);
  });

  it('is a no-op for a session not using mux', async () => {
    const { session, events } = makeSession('claude', { useMux: false });
    await session.startInteractive();
    const status = session.status;

    expect(session.markPaneDead(0)).toBe(false);

    expect(session.paneDead).toBe(false);
    expect(session.status).toBe(status);
    expect(count(events, 'paneDied')).toBe(0);
  });

  it('is a no-op while startInteractive() is in flight', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, mux, events } = makeSession('claude');
    await session.startInteractive();
    let resolveProbe!: (dead: boolean) => void;
    mux.isPaneDead.mockImplementationOnce(() => new Promise<boolean>((r) => (resolveProbe = r)));
    const status = session.status;

    const start = session.startInteractive();
    expect(session.markPaneDead(0)).toBe(false);
    expect(session.paneDead).toBe(false);
    expect(session.status).toBe(status);
    expect(count(events, 'paneDied')).toBe(0);

    resolveProbe(false);
    await expect(start).rejects.toThrow(RUNNING);
  });

  it('toState() carries paneDead/paneExitStatus only while the pane is dead', async () => {
    installFake('claudeTranscript', 'idle');
    const { session } = makeSession('claude');
    await session.startInteractive();

    const live = JSON.parse(JSON.stringify(session.toState()));
    expect('paneDead' in live).toBe(false);
    expect('paneExitStatus' in live).toBe(false);

    session.markPaneDead(3);
    const dead = session.toState();
    expect(dead.status).toBe('stopped');
    expect(dead.paneDead).toBe(true);
    expect(dead.paneExitStatus).toBe(3);
  });

  it('gates PTY heuristics off: dead-pane output does not flip a shell session busy/idle', async () => {
    const { session, events } = makeSession('shell');
    await session.startInteractive();
    session.markPaneDead(0);
    events.length = 0;

    vi.useFakeTimers();
    lastPty().onData!('⠋ working');
    lastPty().onData!('❯ ');
    vi.advanceTimersByTime(30_000);

    expect(count(events, 'working') + count(events, 'idle')).toBe(0);
    expect(session.status).toBe('stopped');
    expect(session.isWorking).toBe(false);
  });
});

describe('start guard: startInteractive()/startShell() with a live attach client', () => {
  it('refuses when the pane is alive: no respawn, attach client untouched', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, mux } = makeSession('claude');
    await session.startInteractive();
    const client = lastPty();
    const generation = session.ptyGeneration;

    await expect(session.startInteractive()).rejects.toThrow(RUNNING);

    expect(mux.isPaneDead).toHaveBeenCalled();
    expect(mux.respawnPane).not.toHaveBeenCalled();
    expect(client.kill).not.toHaveBeenCalled();
    expect(mux.setAttached).not.toHaveBeenCalledWith(session.id, false);
    expect(ptyMocks.spawned).toHaveLength(1);
    expect(session.ptyGeneration).toBe(generation);
    expect(startInFlight(session)).toBe(false);
  });

  it('restarts a dead pane: respawns it, then kills the old attach client, and clears the dead state', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, mux } = makeSession('claude');
    await session.startInteractive();
    const oldClient = lastPty();
    session.markPaneDead(0);
    mux.isPaneDead.mockResolvedValue(true);
    const generation = session.ptyGeneration;

    await session.startInteractive();

    expect(oldClient.kill).toHaveBeenCalledTimes(1);
    // tmux 3.4 exits (killing every session) when a client leaves a dead pane whose TUI was
    // killed by a signal, so the pane must be respawned while the old client is still attached.
    expect(mux.respawnPane.mock.invocationCallOrder[0]).toBeLessThan(oldClient.kill.mock.invocationCallOrder[0]);
    expect(mux.setAttached).toHaveBeenCalledWith(session.id, false);
    expect(mux.respawnPane).toHaveBeenCalledTimes(1);
    expect(ptyMocks.spawned).toHaveLength(2);
    expect(session.paneDead).toBe(false);
    expect(session.paneExitStatus).toBeNull();
    expect(session.status).not.toBe('stopped');
    expect(session.pid).not.toBeNull();
    expect(session.ptyGeneration).not.toBe(generation);
  });

  it("ignores the retired attach client's onExit that lands during the kill window", async () => {
    installFake('claudeTranscript', 'idle');
    const { session, mux, events } = makeSession('claude');
    await session.startInteractive();
    const oldClient = lastPty();
    session.markPaneDead(0);
    mux.isPaneDead.mockResolvedValue(true);
    events.length = 0;
    // Real `tmux attach-session` clients exit as soon as they are killed, i.e. inside the
    // 300 ms kill wait (after the respawn) and before the new spawn bumps the generation again.
    let respawnedBeforeKill = false;
    let statusBeforeStaleExit: string | undefined;
    let statusAfterStaleExit: string | undefined;
    oldClient.kill.mockImplementation(() => {
      respawnedBeforeKill = mux.respawnPane.mock.calls.length === 1;
      statusBeforeStaleExit = session.status;
      oldClient.onExit!({ exitCode: 0 });
      statusAfterStaleExit = session.status;
    });

    await session.startInteractive();

    expect(oldClient.kill).toHaveBeenCalledTimes(1);
    expect(respawnedBeforeKill).toBe(true);
    // A stale handler would reset the status to idle before the new client is spawned
    expect(statusBeforeStaleExit).toBe('busy');
    expect(statusAfterStaleExit).toBe(statusBeforeStaleExit);
    expect(count(events, 'exit')).toBe(0);
    expect(mux.respawnPane).toHaveBeenCalledTimes(1);
    expect(ptyMocks.spawned).toHaveLength(2);
    expect(session.status).not.toBe('stopped');
    expect(session.pid).not.toBeNull();
    expect(ptyOf(session).kill).toBe(lastPty().kill);
    expect(monitorOf(session)).not.toBeNull();
  });

  it('refuses a second concurrent start: only one release and respawn happen', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, mux } = makeSession('claude');
    await session.startInteractive();
    const oldClient = lastPty();
    session.markPaneDead(0);
    mux.isPaneDead.mockResolvedValue(true);

    const first = session.startInteractive();
    const second = session.startInteractive();

    await expect(second).rejects.toThrow(RUNNING);
    await first;
    expect(oldClient.kill).toHaveBeenCalledTimes(1);
    expect(mux.respawnPane).toHaveBeenCalledTimes(1);
    expect(ptyMocks.spawned).toHaveLength(2);
  });

  it('releases the in-flight guard when a start throws, so a later start is not refused', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, mux } = makeSession('claude');
    await session.startInteractive();
    mux.isPaneDead.mockRejectedValueOnce(new Error('tmux probe failed'));

    await expect(session.startInteractive()).rejects.toThrow('tmux probe failed');
    expect(startInFlight(session)).toBe(false);

    mux.isPaneDead.mockResolvedValue(true);
    await expect(session.startInteractive()).resolves.toBeUndefined();
    expect(mux.respawnPane).toHaveBeenCalledTimes(1);
    expect(ptyMocks.spawned).toHaveLength(2);
  });

  it('leaves the old attach client attached when the dead pane cannot be respawned', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, mux, events } = makeSession('claude');
    await session.startInteractive();
    const oldClient = lastPty();
    session.markPaneDead(0);
    mux.isPaneDead.mockResolvedValue(true);
    mux.respawnPane.mockResolvedValueOnce(null as unknown as number);
    events.length = 0;

    await session.startInteractive();

    // Killing a client on a still-dead pane can crash the tmux server
    expect(mux.respawnPane).toHaveBeenCalledTimes(1);
    expect(oldClient.kill).not.toHaveBeenCalled();
    expect(count(events, 'exit')).toBe(0);
    expect(ptyMocks.spawned).toHaveLength(2);
    expect(ptyOf(session).kill).toBe(lastPty().kill);
  });

  it('startShell() respawns a pane tmux reports dead, then kills the old attach client', async () => {
    const { session, mux } = makeSession('shell');
    await session.startShell();
    const oldClient = lastPty();
    mux.isPaneDead.mockResolvedValue(true);

    await session.startShell();

    expect(oldClient.kill).toHaveBeenCalledTimes(1);
    expect(mux.respawnPane.mock.invocationCallOrder[0]).toBeLessThan(oldClient.kill.mock.invocationCallOrder[0]);
    expect(mux.setAttached).toHaveBeenCalledWith(session.id, false);
    expect(mux.respawnPane).toHaveBeenCalledWith(expect.objectContaining({ mode: 'shell' }));
    expect(ptyMocks.spawned).toHaveLength(2);
    expect(session.status).not.toBe('stopped');
  });

  it("startShell() ignores the retired attach client's onExit that lands during the kill window", async () => {
    const { session, mux, events } = makeSession('shell');
    await session.startShell();
    const oldClient = lastPty();
    mux.isPaneDead.mockResolvedValue(true);
    events.length = 0;
    let respawnedBeforeKill = false;
    let statusBeforeStaleExit: string | undefined;
    let statusAfterStaleExit: string | undefined;
    oldClient.kill.mockImplementation(() => {
      respawnedBeforeKill = mux.respawnPane.mock.calls.length === 1;
      statusBeforeStaleExit = session.status;
      oldClient.onExit!({ exitCode: 0 });
      statusAfterStaleExit = session.status;
    });

    await session.startShell();

    expect(oldClient.kill).toHaveBeenCalledTimes(1);
    expect(respawnedBeforeKill).toBe(true);
    // A stale handler would reset the status to idle before the new client is spawned
    expect(statusAfterStaleExit).toBe(statusBeforeStaleExit);
    expect(count(events, 'exit')).toBe(0);
    expect(mux.respawnPane).toHaveBeenCalledTimes(1);
    expect(ptyMocks.spawned).toHaveLength(2);
    expect(session.status).not.toBe('stopped');
    expect(ptyOf(session).kill).toBe(lastPty().kill);
  });

  it('startShell() still refuses when the pane is alive', async () => {
    const { session, mux } = makeSession('shell');
    await session.startShell();
    const client = lastPty();

    await expect(session.startShell()).rejects.toThrow(RUNNING);

    expect(mux.isPaneDead).toHaveBeenCalled();
    expect(client.kill).not.toHaveBeenCalled();
    expect(mux.respawnPane).not.toHaveBeenCalled();
    expect(ptyMocks.spawned).toHaveLength(1);
  });

  it('a non-mux session with a PTY still refuses a second start', async () => {
    const { session } = makeSession('claude', { useMux: false });
    await session.startInteractive();

    await expect(session.startInteractive()).rejects.toThrow(RUNNING);

    expect(ptyMocks.spawned).toHaveLength(1);
    expect(lastPty().kill).not.toHaveBeenCalled();
  });
});

describe('teardown of a dead pane: tmux session is killed before the attach client', () => {
  // tmux 3.4 exits when a client leaves a dead pane whose TUI was killed by a signal; killing
  // the tmux session first is safe (the client then exits on its own).
  it.each([
    ['stop(true)', (s: Session) => s.stop(true)],
    ['prepareForRestart()', (s: Session) => s.prepareForRestart()],
  ])('%s on a dead pane kills the mux session before the attach client', async (_label, teardown) => {
    installFake('claudeTranscript', 'idle');
    const { session, mux } = makeSession('claude');
    await session.startInteractive();
    const client = lastPty();
    session.markPaneDead(143);

    await teardown(session);

    expect(mux.killSession).toHaveBeenCalled();
    expect(client.kill).toHaveBeenCalledTimes(1);
    expect(mux.killSession.mock.invocationCallOrder[0]).toBeLessThan(client.kill.mock.invocationCallOrder[0]);
  });

  it('stop(true) probes tmux for a dead pane the sweep has not marked yet', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, mux } = makeSession('claude');
    await session.startInteractive();
    const client = lastPty();
    mux.isPaneDead.mockResolvedValue(true);

    await session.stop(true);

    expect(mux.killSession.mock.invocationCallOrder[0]).toBeLessThan(client.kill.mock.invocationCallOrder[0]);
  });

  it('stop(true) on a live pane keeps the original order (attach client first)', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, mux } = makeSession('claude');
    await session.startInteractive();
    const client = lastPty();

    await session.stop(true);

    expect(client.kill).toHaveBeenCalledTimes(1);
    expect(mux.killSession).toHaveBeenCalledTimes(1);
    expect(client.kill.mock.invocationCallOrder[0]).toBeLessThan(mux.killSession.mock.invocationCallOrder[0]);
  });
});

describe('server-shutdown detach (stop(false)) of a dead pane keeps the tmux session', () => {
  // stop(false) is the Codeman shutdown path: the tmux session must survive so the next
  // restoreMuxSessions() can find the dead pane and mark the session exited again.
  // It must also not gracefully signal the attach client: tmux 3.4 crashes when the client of a
  // dead pane gets SIGHUP (node-pty's kill()) or SIGTERM. A SIGKILL of the client or its process
  // group is tmux-safe and allowed, as is sending no signal at all.
  it.each([
    ['marked dead', (s: Session, _mux: ReturnType<typeof fakeMux>) => void s.markPaneDead(143)],
    [
      'reported dead by isPaneDead only',
      (_s: Session, mux: ReturnType<typeof fakeMux>) => void mux.isPaneDead.mockResolvedValue(true),
    ],
  ] as const)(
    'stop(false) on a pane %s keeps the mux session and does not gracefully signal the attach client',
    async (_label, makeDead) => {
      installFake('claudeTranscript', 'idle');
      const { session, mux } = makeSession('claude');
      await session.startInteractive();
      const client = lastPty();
      const clientPid = session.pid as number;
      makeDead(session, mux);
      mux.isPaneDead.mockClear();
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      let processKillCalls: Array<Parameters<typeof process.kill>> = [];

      try {
        await session.stop(false);
      } finally {
        // mockRestore() also clears mock.calls, so copy them first
        processKillCalls = [...processKill.mock.calls];
        processKill.mockRestore();
      }

      expect(mux.killSession).not.toHaveBeenCalled();
      // node-pty's kill() sends SIGHUP
      expect(client.kill).not.toHaveBeenCalled();
      // Only SIGKILL may reach the client pid or its process group (-pid)
      const clientSignals = processKillCalls.filter(([pid]) => Math.abs(pid) === clientPid).map(([, signal]) => signal);
      expect(clientSignals.filter((signal) => signal !== 'SIGKILL' && signal !== 9)).toEqual([]);
      expect(ptyOf(session)).toBeNull();
      expect(session.pid).toBeNull();
    }
  );
});

describe('dead state preservation and clearing', () => {
  it("the interactive attach client's exit keeps a dead pane 'stopped' (not idle)", async () => {
    installFake('claudeTranscript', 'idle');
    const { session } = makeSession('claude');
    await session.startInteractive();
    session.markPaneDead(0);

    lastPty().onExit!({ exitCode: 0 });

    expect(session.status).toBe('stopped');
    expect(session.paneDead).toBe(true);
  });

  it("the shell attach client's exit keeps a dead pane 'stopped' (not idle)", async () => {
    const { session } = makeSession('shell');
    await session.startShell();
    session.markPaneDead(0);

    lastPty().onExit!({ exitCode: 0 });

    expect(session.status).toBe('stopped');
    expect(session.paneDead).toBe(true);
  });

  it.each([
    ['stop(false)', (s: Session) => s.stop(false)],
    ['prepareForRestart()', (s: Session) => s.prepareForRestart()],
    [
      'rebindMuxSession()',
      (s: Session, mux: ReturnType<typeof fakeMux>) =>
        s.rebindMuxSession('codeman-other', mux as unknown as TerminalMultiplexer),
    ],
  ] as const)('%s clears paneDead and paneExitStatus', async (_name, act) => {
    installFake('claudeTranscript', 'idle');
    const { session, mux } = makeSession('claude');
    await session.startInteractive();
    session.markPaneDead(4);
    expect(session.paneDead).toBe(true);

    await act(session, mux);

    expect(session.paneDead).toBe(false);
    expect(session.paneExitStatus).toBeNull();
    expect(session.toState().paneDead).toBeUndefined();
  });
});

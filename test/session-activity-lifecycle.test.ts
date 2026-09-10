/**
 * Session activity lifecycle: one attach/detach path for activity monitors (spec §5).
 *
 * `node-pty` is mocked (every spawn is recorded so stale callbacks can be replayed), the
 * multiplexer is a plain fake, and the per-source monitor factories are swapped for fakes
 * that record their instances. No tmux, harness binary or transcript file is touched.
 *
 * Run: npx vitest run test/session-activity-lifecycle.test.ts
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

import * as pty from 'node-pty';
import { Session } from '../src/session.js';
import { activityMonitorFactories, type ActivityMonitor, type ActivityState } from '../src/activity-monitor.js';
import { ClaudeActivityMonitor } from '../src/claude-activity-monitor.js';
import type { ActivitySource } from '../src/types/activity.js';
import type { CreateSessionOptions, TerminalMultiplexer } from '../src/mux-interface.js';
import type { SessionMode } from '../src/types/session.js';

class FakeMonitor extends EventEmitter implements ActivityMonitor {
  state: ActivityState;
  stopped = false;
  harnessIds: string[] = [];
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
  setHarnessSessionId(id: string): void {
    this.harnessIds.push(id);
  }
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
  const mux = {
    backend: 'tmux',
    isAvailable: () => true,
    muxSessionExists: vi.fn(() => true),
    isPaneDead: vi.fn(async () => false),
    respawnPane: vi.fn(async () => 4242),
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
  return mux;
}

function makeSession(mode: SessionMode, opts: { useMux?: boolean; harnessSessionId?: string } = {}) {
  const mux = fakeMux();
  const session = new Session({
    id: randomUUID(),
    workingDir: '/tmp',
    mode,
    mux: mux as unknown as TerminalMultiplexer,
    useMux: opts.useMux ?? true,
    // Codex without an id starts rollout discovery; give it one so nothing is watched.
    harnessSessionId: opts.harnessSessionId ?? (mode === 'codex' ? 'codex-known-id' : undefined),
  });
  sessions.push(session);
  const events: Array<{ type: string; info?: unknown }> = [];
  session.on('working', () => events.push({ type: 'working' }));
  session.on('idle', (info?: unknown) => events.push({ type: 'idle', info }));
  session.on('exit', () => events.push({ type: 'exit' }));
  return { session, mux, events };
}

const monitorOf = (s: Session) => (s as unknown as { _activityMonitor: ActivityMonitor | null })._activityMonitor;
const lastPty = () => ptyMocks.spawned[ptyMocks.spawned.length - 1];
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const count = (events: Array<{ type: string }>, type: string) => events.filter((e) => e.type === type).length;

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

describe('monitor type per activity source', () => {
  it('claude attaches a ClaudeActivityMonitor', async () => {
    const { session } = makeSession('claude');
    await session.startInteractive();
    expect(monitorOf(session)).toBeInstanceOf(ClaudeActivityMonitor);
  });

  it.each(['shell', 'opencode'] as const)('%s attaches no monitor and keeps the PTY fallback', async (mode) => {
    const { session, events } = makeSession(mode);
    await session.startInteractive();
    expect(monitorOf(session)).toBeNull();

    lastPty().onData!('⠋ working');
    expect(count(events, 'working')).toBe(1);
    expect(session.isWorking).toBe(true);
  });

  it('non-mux claude (direct PTY fallback) keeps the PTY heuristics', async () => {
    const { session, events } = makeSession('claude', { useMux: false });
    await session.startInteractive();
    expect(monitorOf(session)).toBeNull();

    lastPty().onData!('⠋ thinking');
    expect(count(events, 'working')).toBe(1);
    expect(session.status).toBe('busy');
  });

  it('codex and pi attach their source monitor', async () => {
    installFake('transcript', 'idle');
    installFake('hook', 'idle');
    const codex = makeSession('codex');
    const pi = makeSession('pi');
    await codex.session.startInteractive();
    await pi.session.startInteractive();
    expect(instances).toHaveLength(2);
    expect(monitorOf(codex.session)).toBe(instances[0]);
    expect(monitorOf(pi.session)).toBe(instances[1]);
  });
});

describe('initial state publication', () => {
  it('initial idle emits zero idle events and leaves both fields idle', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, events } = makeSession('claude');
    await session.startInteractive();
    await flush();
    expect(events).toEqual([]);
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
  });

  it('initial unknown emits nothing', async () => {
    installFake('transcript', 'unknown');
    const { session, events } = makeSession('codex');
    await session.startInteractive();
    await flush();
    expect(events).toEqual([]);
    expect(session.status).toBe('idle');
  });

  it('initial working emits exactly one working', async () => {
    installFake('claudeTranscript', 'working');
    const { session, events } = makeSession('claude');
    await session.startInteractive();
    await flush();
    expect(events).toEqual([{ type: 'working' }]);
    expect(session.status).toBe('busy');
    expect(session.isWorking).toBe(true);
  });
});

describe('idle reasons from monitors', () => {
  it('stale while idle is dropped; stale then completed emits both, completed exactly once', async () => {
    installFake('transcript', 'idle');
    const { session, events } = makeSession('codex');
    await session.startInteractive();
    const m = instances[0];

    m.emit('idle', { reason: 'stale' });
    expect(events).toEqual([]);

    m.emit('working');
    m.emit('idle', { reason: 'stale' });
    m.emit('idle', { reason: 'completed' });
    expect(events).toEqual([
      { type: 'working' },
      { type: 'idle', info: { reason: 'stale' } },
      { type: 'idle', info: { reason: 'completed' } },
    ]);
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
  });

  it('an argument-free monitor idle is forwarded as completed', async () => {
    installFake('claudeTranscript', 'working');
    const { session, events } = makeSession('claude');
    await session.startInteractive();
    instances[0].emit('idle');
    expect(events.at(-1)).toEqual({ type: 'idle', info: { reason: 'completed' } });
  });
});

describe('detach paths', () => {
  it('repeated start -> PTY exit leaves exactly one live monitor', async () => {
    installFake('claudeTranscript', 'idle');
    const { session } = makeSession('claude');
    for (let i = 0; i < 3; i++) {
      await session.startInteractive();
      lastPty().onExit!({ exitCode: 0 });
    }
    expect(instances.filter((m) => !m.stopped)).toHaveLength(0);

    await session.startInteractive();
    expect(instances).toHaveLength(4);
    expect(instances.filter((m) => !m.stopped)).toHaveLength(1);
    expect(monitorOf(session)).toBe(instances[3]);
  });

  it('PTY exit disposes the monitor, sets both fields idle and emits no activity event', async () => {
    installFake('claudeTranscript', 'working');
    const { session, events } = makeSession('claude');
    await session.startInteractive();
    events.length = 0;

    lastPty().onExit!({ exitCode: 0 });

    expect(instances[0].stopped).toBe(true);
    expect(monitorOf(session)).toBeNull();
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
    expect(count(events, 'idle') + count(events, 'working')).toBe(0);
  });

  it('prepareForRestart disposes the monitor, sets both fields idle and emits nothing', async () => {
    installFake('hook', 'working');
    const { session, events } = makeSession('pi');
    await session.startInteractive();
    events.length = 0;

    await session.prepareForRestart();

    expect(instances[0].stopped).toBe(true);
    expect(monitorOf(session)).toBeNull();
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
    expect(events).toEqual([]);
  });

  it('startInteractive failure on a mux-only harness disposes the monitor and leaves both fields idle', async () => {
    installFake('transcript', 'working');
    const { session, events } = makeSession('codex');
    vi.mocked(pty.spawn).mockImplementationOnce(() => {
      throw new Error('attach spawn failed');
    });

    await expect(session.startInteractive()).rejects.toThrow(/require tmux/i);

    expect(instances[0].stopped).toBe(true);
    expect(monitorOf(session)).toBeNull();
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
    expect(count(events, 'idle')).toBe(0);
  });

  it.each([
    ['codex', 'transcript'],
    ['pi', 'hook'],
  ] as const)('stop() on %s stops and clears the monitor; a late event changes nothing', async (mode, source) => {
    installFake(source, 'working');
    const { session, events } = makeSession(mode);
    await session.startInteractive();
    const m = instances[0];
    expect(monitorOf(session)).toBe(m);

    await session.stop(false);

    expect(m.stopped).toBe(true);
    expect(monitorOf(session)).toBeNull();
    const status = session.status;
    const isWorking = session.isWorking;
    events.length = 0;

    m.emit('idle', { reason: 'completed' });
    m.emit('working');

    expect(events).toEqual([]);
    expect(session.status).toBe(status);
    expect(session.isWorking).toBe(isWorking);
  });

  it('a late callback from a detached monitor changes nothing', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, events } = makeSession('claude');
    await session.startInteractive();
    const old = instances[0];
    lastPty().onExit!({ exitCode: 0 });
    await session.startInteractive();
    events.length = 0;

    old.emit('working');
    old.emit('idle');

    expect(events).toEqual([]);
    expect(session.isWorking).toBe(false);
  });
});

describe('settle timer', () => {
  it('does not overwrite a monitor-reported working', async () => {
    vi.useFakeTimers();
    installFake('transcript', 'working');
    const { session } = makeSession('codex');
    await session.startInteractive();
    expect(session.status).toBe('busy');

    vi.advanceTimersByTime(5000);

    expect(session.status).toBe('busy');
    expect(session.isWorking).toBe(true);
  });

  it('still marks a PTY-heuristic harness (opencode) idle', async () => {
    vi.useFakeTimers();
    const { session } = makeSession('opencode');
    await session.startInteractive();
    expect(session.status).toBe('busy');

    vi.advanceTimersByTime(5000);

    expect(session.status).toBe('idle');
  });
});

describe('status writers skip while a monitor is attached', () => {
  it('assignTask and legacy start() do not overwrite a monitored idle/busy status', async () => {
    installFake('claudeTranscript', 'idle');
    const { session } = makeSession('claude');
    await session.startInteractive();

    session.assignTask('task-1');
    expect(session.status).toBe('idle');

    instances[0].emit('working');
    await session.start();
    expect(session.status).toBe('busy');
  });

  it('clearTask and sendInput do not overwrite a monitored status', async () => {
    installFake('claudeTranscript', 'working');
    const { session } = makeSession('claude');
    await session.startInteractive();

    session.clearTask();
    expect(session.status).toBe('busy');

    instances[0].emit('idle');
    expect(session.status).toBe('idle');
    vi.spyOn(session, 'runPrompt').mockResolvedValue(undefined as never);
    await session.sendInput('hello');
    expect(session.status).toBe('idle');
  });
});

describe('recordHarnessSessionId', () => {
  it('forwards a newly recorded id to the attached monitor', async () => {
    installFake('transcript', 'idle');
    const { session } = makeSession('codex', { harnessSessionId: 'first' });
    await session.startInteractive();

    session.recordHarnessSessionId('second');

    expect(instances[0].harnessIds).toEqual(['second']);
  });
});

describe('rebindMuxSession', () => {
  it('an exit from the killed PTY, even one delivered during the kill, changes nothing', async () => {
    installFake('claudeTranscript', 'working');
    const { session, mux, events } = makeSession('claude');
    await session.startInteractive();
    const oldPty = lastPty();
    oldPty.kill.mockImplementation(() => oldPty.onExit!({ exitCode: 0 }));
    events.length = 0;

    await session.rebindMuxSession('codeman-other', mux as unknown as TerminalMultiplexer);
    oldPty.onExit!({ exitCode: 0 });

    expect(count(events, 'exit')).toBe(0);
    expect(monitorOf(session)).toBe(instances[0]);
    expect(instances[0].stopped).toBe(false);
    expect(session.pid).not.toBeNull();
    // Claude: fields resynchronised from the monitor, not forced idle.
    expect(session.status).toBe('busy');
    expect(session.isWorking).toBe(true);
  });

  it('pi re-attaches a fresh hook monitor', async () => {
    installFake('hook', 'idle');
    const { session, mux } = makeSession('pi');
    await session.startInteractive();

    await session.rebindMuxSession('codeman-other', mux as unknown as TerminalMultiplexer);

    expect(instances).toHaveLength(2);
    expect(instances[0].stopped).toBe(true);
    expect(monitorOf(session)).toBe(instances[1]);
  });

  it('claude with no attached monitor keeps the PTY spinner heuristics after rebind', async () => {
    installFake('claudeTranscript', 'idle');
    const { session, mux, events } = makeSession('claude');
    await session.startInteractive();
    // The attach PTY exits: the monitor is detached and not re-attached by the rebind.
    lastPty().onExit!({ exitCode: 0 });
    expect(monitorOf(session)).toBeNull();
    events.length = 0;

    await session.rebindMuxSession('codeman-other', mux as unknown as TerminalMultiplexer);
    expect(monitorOf(session)).toBeNull();
    expect(session.isWorking).toBe(false);

    lastPty().onData!('⠋ working');

    expect(count(events, 'working')).toBe(1);
    expect(session.status).toBe('busy');
    expect(session.isWorking).toBe(true);
  });

  it('pi ignores PTY spinner and prompt output after rebind', async () => {
    installFake('hook', 'idle');
    const { session, mux, events } = makeSession('pi');
    await session.startInteractive();

    await session.rebindMuxSession('codeman-other', mux as unknown as TerminalMultiplexer);
    expect(monitorOf(session)).toBe(instances[1]);
    events.length = 0;

    vi.useFakeTimers();
    lastPty().onData!('⠋ Working');
    lastPty().onData!('❯ ');
    vi.advanceTimersByTime(30_000);

    expect(count(events, 'working') + count(events, 'idle')).toBe(0);
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
  });

  it('codex is detached, not re-attached, and PTY output drives no activity', async () => {
    installFake('transcript', 'working');
    const { session, mux, events } = makeSession('codex');
    await session.startInteractive();
    expect(session.isWorking).toBe(true);
    events.length = 0;

    await session.rebindMuxSession('codeman-other', mux as unknown as TerminalMultiplexer);

    expect(instances).toHaveLength(1);
    expect(instances[0].stopped).toBe(true);
    expect(monitorOf(session)).toBeNull();
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);

    vi.useFakeTimers();
    lastPty().onData!('⠋ Working');
    lastPty().onData!('❯ ');
    vi.advanceTimersByTime(30_000);

    expect(count(events, 'working') + count(events, 'idle')).toBe(0);
  });
});

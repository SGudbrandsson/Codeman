/**
 * pi activity from harness_activity reports (spec §4, §5):
 *  - `acceptActivityReport`: token ownership and seq/gen ordering (pure);
 *  - `HookActivityMonitor`: working/idle transitions, the completed-vs-stale rule and 90 s
 *    staleness;
 *  - `Session.applyHookActivity`: validation against the session's token and ordering state,
 *    forwarding to the attached monitor, token rotation and surviving-pane restore.
 *
 * `node-pty` is mocked and the multiplexer is a plain fake; no tmux or pi binary is touched.
 *
 * Run: npx vitest run test/hook-activity-monitor.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { HookActivityMonitor, acceptActivityReport, type HarnessActivityReport } from '../src/hook-activity-monitor.js';
import { activityMonitorFactories } from '../src/activity-monitor.js';
import type { CreateSessionOptions, MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import type { SessionMode } from '../src/types/session.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

const report = (over: Partial<HarnessActivityReport> = {}): HarnessActivityReport => ({
  state: 'working',
  token: TOKEN,
  gen: 1,
  seq: 1,
  ...over,
});

describe('acceptActivityReport', () => {
  it('rejects a wrong token, and any token when none is expected', () => {
    const owner = {};
    expect(acceptActivityReport(owner, TOKEN, report({ token: OTHER }))).toBe(false);
    expect(acceptActivityReport(owner, undefined, report())).toBe(false);
    expect(owner).toEqual({});
  });

  it('accepts the first valid report with no prior state and initialises the ordering state', () => {
    const owner = {};
    expect(acceptActivityReport(owner, TOKEN, report({ gen: 4, seq: 17 }))).toBe(true);
    expect(owner).toEqual({ lastSeq: 17, ownerGen: 4 });
  });

  it('rejects a seq that does not exceed the last accepted seq', () => {
    const owner = { lastSeq: 17, ownerGen: 4 };
    expect(acceptActivityReport(owner, TOKEN, report({ gen: 4, seq: 17 }))).toBe(false);
    expect(acceptActivityReport(owner, TOKEN, report({ gen: 4, seq: 3 }))).toBe(false);
    expect(owner).toEqual({ lastSeq: 17, ownerGen: 4 });
  });

  it('rejects a lower gen even when its seq is higher (a superseded runtime)', () => {
    const owner = { lastSeq: 17, ownerGen: 4 };
    expect(acceptActivityReport(owner, TOKEN, report({ gen: 3, seq: 99 }))).toBe(false);
    expect(owner).toEqual({ lastSeq: 17, ownerGen: 4 });
  });

  it('accepts a higher gen and takes ownership', () => {
    const owner = { lastSeq: 17, ownerGen: 4 };
    expect(acceptActivityReport(owner, TOKEN, report({ gen: 5, seq: 18 }))).toBe(true);
    expect(owner).toEqual({ lastSeq: 18, ownerGen: 5 });
    expect(acceptActivityReport(owner, TOKEN, report({ gen: 5, seq: 19 }))).toBe(true);
    expect(owner).toEqual({ lastSeq: 19, ownerGen: 5 });
  });
});

describe('HookActivityMonitor', () => {
  let monitor: HookActivityMonitor;
  let events: Array<{ type: string; info?: unknown }>;

  beforeEach(async () => {
    vi.useFakeTimers();
    monitor = new HookActivityMonitor();
    events = [];
    monitor.on('working', () => events.push({ type: 'working' }));
    monitor.on('idle', (info?: unknown) => events.push({ type: 'idle', info }));
    await monitor.start();
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it('starts unknown and emits nothing until a report arrives', () => {
    expect(monitor.state).toBe('unknown');
    vi.advanceTimersByTime(300_000);
    expect(events).toEqual([]);
  });

  it('a working report emits one working; an idle report emits idle { completed }', () => {
    monitor.report('working');
    expect(monitor.state).toBe('working');
    expect(monitor.turnOpen).toBe(true);
    monitor.report('idle');
    expect(monitor.state).toBe('idle');
    expect(monitor.turnOpen).toBe(false);
    expect(events).toEqual([{ type: 'working' }, { type: 'idle', info: { reason: 'completed' } }]);
  });

  it('repeated working heartbeats emit nothing new', () => {
    monitor.report('working');
    monitor.report('working');
    vi.advanceTimersByTime(30_000);
    monitor.report('working');
    expect(events).toEqual([{ type: 'working' }]);
  });

  it('an idle report with no open turn emits nothing', () => {
    monitor.report('idle');
    monitor.report('idle');
    expect(monitor.state).toBe('idle');
    expect(events).toEqual([]);
  });

  it('90 s without any report while working emits idle { stale } and keeps the turn open', () => {
    monitor.report('working');
    vi.advanceTimersByTime(89_999);
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(events[1]).toEqual({ type: 'idle', info: { reason: 'stale' } });
    expect(monitor.state).toBe('idle');
    expect(monitor.turnOpen).toBe(true);
  });

  it('heartbeats keep a long turn from going stale', () => {
    monitor.report('working');
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(30_000);
      monitor.report('working');
    }
    expect(events).toEqual([{ type: 'working' }]);
  });

  it('stale then a later idle report emits idle { completed } exactly once', () => {
    monitor.report('working');
    vi.advanceTimersByTime(90_000);
    monitor.report('idle');
    monitor.report('idle');
    expect(events).toEqual([
      { type: 'working' },
      { type: 'idle', info: { reason: 'stale' } },
      { type: 'idle', info: { reason: 'completed' } },
    ]);
    expect(monitor.turnOpen).toBe(false);
  });

  it('stale then a later working report resumes normally', () => {
    monitor.report('working');
    vi.advanceTimersByTime(90_000);
    monitor.report('working');
    expect(monitor.state).toBe('working');
    monitor.report('idle');
    expect(events.map((e) => e.type)).toEqual(['working', 'idle', 'working', 'idle']);
    expect(events[3].info).toEqual({ reason: 'completed' });
  });

  it('an idle report cancels the stale timer', () => {
    monitor.report('working');
    monitor.report('idle');
    vi.advanceTimersByTime(300_000);
    expect(events).toHaveLength(2);
  });

  it('after stop() reports and timers change nothing', () => {
    monitor.report('working');
    monitor.stop();
    vi.advanceTimersByTime(300_000);
    monitor.report('idle');
    expect(events).toEqual([{ type: 'working' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours a staleMs option', () => {
    const quick = new HookActivityMonitor({ staleMs: 1_000 });
    const seen: unknown[] = [];
    quick.on('idle', (info?: unknown) => seen.push(info));
    quick.report('working');
    vi.advanceTimersByTime(1_000);
    expect(seen).toEqual([{ reason: 'stale' }]);
    quick.stop();
  });

  it('is the monitor registered for the hook activity source', () => {
    const created = activityMonitorFactories.hook?.({ id: 's', workingDir: '/tmp' });
    expect(created).toBeInstanceOf(HookActivityMonitor);
    created?.stop();
  });
});

// ========== Session.applyHookActivity ==========

function fakeMux(opts: { exists: boolean; dead: boolean }) {
  return {
    backend: 'tmux',
    isAvailable: () => true,
    muxSessionExists: vi.fn(() => opts.exists),
    isPaneDead: vi.fn(async () => opts.dead),
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
}

const sessions: Session[] = [];

function makeSession(mode: SessionMode, existingPane: 'none' | 'live' = 'none') {
  const id = randomUUID();
  const muxOpts = { exists: existingPane !== 'none', dead: false };
  const mux = fakeMux(muxOpts);
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
  const events: Array<{ type: string; info?: unknown }> = [];
  session.on('working', () => events.push({ type: 'working' }));
  session.on('idle', (info?: unknown) => events.push({ type: 'idle', info }));
  return { session, mux, muxOpts, events };
}

describe('Session.applyHookActivity', () => {
  afterEach(async () => {
    for (const s of sessions.splice(0)) {
      try {
        await s.stop(false);
      } catch {
        /* already stopped */
      }
    }
  });

  it('accepts an owned, ordered report and drives busy/idle through the hook monitor', async () => {
    const { session, events } = makeSession('pi');
    await session.startInteractive();
    const token = session.activityToken!;

    expect(session.applyHookActivity(report({ token, seq: 1 }))).toBe('accepted');
    expect(session.status).toBe('busy');
    expect(session.isWorking).toBe(true);

    expect(session.applyHookActivity(report({ token, seq: 2, state: 'idle' }))).toBe('accepted');
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
    expect(events).toEqual([{ type: 'working' }, { type: 'idle', info: { reason: 'completed' } }]);
  });

  it('rejects a wrong token, a stale seq and a superseded gen without changing state', async () => {
    const { session, events } = makeSession('pi');
    await session.startInteractive();
    const token = session.activityToken!;
    expect(session.applyHookActivity(report({ token, gen: 2, seq: 10 }))).toBe('accepted');

    expect(session.applyHookActivity(report({ token: OTHER, gen: 2, seq: 11, state: 'idle' }))).toBe('rejected');
    expect(session.applyHookActivity(report({ token, gen: 2, seq: 10, state: 'idle' }))).toBe('rejected');
    expect(session.applyHookActivity(report({ token, gen: 1, seq: 50, state: 'idle' }))).toBe('rejected');

    expect(session.isWorking).toBe(true);
    expect(events).toEqual([{ type: 'working' }]);
  });

  it.each(['claude', 'codex', 'shell', 'opencode'] as const)('rejects every report for a %s session', (mode) => {
    const { session } = makeSession(mode);
    session.activityToken = TOKEN;
    expect(session.applyHookActivity(report())).toBe('rejected');
  });

  it('after a token rotation, the new process starting again at seq 1 / gen 1 is accepted', async () => {
    const { session, muxOpts } = makeSession('pi');
    await session.startInteractive();
    const firstToken = session.activityToken!;
    expect(session.applyHookActivity(report({ token: firstToken, gen: 3, seq: 50 }))).toBe('accepted');

    // The pane died; restarting respawns it with a new process and a new token.
    await session.prepareForRestart();
    muxOpts.dead = true;
    await session.startInteractive();
    const secondToken = session.activityToken!;
    expect(secondToken).not.toBe(firstToken);

    expect(session.applyHookActivity(report({ token: firstToken, gen: 3, seq: 51 }))).toBe('rejected');
    expect(session.applyHookActivity(report({ token: secondToken, gen: 1, seq: 1 }))).toBe('accepted');
    expect(session.isWorking).toBe(true);
  });

  it('restored session attaching to a surviving pane accepts that process with its persisted token', async () => {
    const { session, mux, events } = makeSession('pi', 'live');
    session.activityToken = TOKEN; // restored from state.json by _restoreSessionConfig
    await session.startInteractive();
    expect(mux.createSession).not.toHaveBeenCalled();

    // First report after a Codeman restart: no prior ordering state in memory.
    expect(session.applyHookActivity(report({ gen: 2, seq: 40 }))).toBe('accepted');
    expect(session.isWorking).toBe(true);
    expect(events).toEqual([{ type: 'working' }]);
  });

  it('accepted reports with no attached monitor update ordering but not activity', () => {
    const { session, events } = makeSession('pi');
    session.activityToken = TOKEN;
    expect(session.applyHookActivity(report({ seq: 5 }))).toBe('accepted');
    expect(session.applyHookActivity(report({ seq: 5 }))).toBe('rejected');
    expect(session.isWorking).toBe(false);
    expect(events).toEqual([]);
  });
});

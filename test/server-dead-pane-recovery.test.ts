/**
 * @fileoverview Unit tests for WebServer.checkAndRecoverDeadPanes() auto-recovery logic.
 *
 * Tests the nine behavioural gaps listed in TASK.md:
 * 1. Skip non-busy session
 * 2. Skip non-worktree session
 * 3. Skip already-recovering session (pre-push guard)
 * 4. Skip cleaning-up session
 * 5. Alive pane: prepareForRestart/startInteractive not called
 * 6. Dead pane happy path: prepareForRestart then startInteractive called; SSE broadcasts fired; _recoveringSessionIds cleared
 * 7. Dead pane error path: startInteractive rejects → SessionError broadcast; _recoveringSessionIds cleared
 * 8. Concurrent recovery guard (two-phase inner async check)
 * 9. Multiple sessions isolation (Promise.allSettled)
 * 10. Mux name formula: isPaneDead called with `codeman-${session.id}` (documents the sweep's
 *     derived name, which does NOT match real tmux names `codeman-${id.slice(0, 8)}`; the sweep is
 *     dormant in production and dead panes are reported by checkPaneDeaths(), tested below)
 *
 * SAFETY: Server is constructed in testMode=true.
 * No real tmux commands are executed (TmuxManager is in VITEST test mode).
 * Port: N/A (no server.start() is called)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// All mock functions must be declared via vi.hoisted() so they are available
// when vi.mock() factory callbacks are hoisted to the top of the module.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  isPaneDeadImpl: vi.fn<[string], boolean | Promise<boolean>>().mockReturnValue(false),
  paneDeathStates: new Map<string, { dead: boolean; exitStatus: number | null }>(),
  muxSessions: [] as Array<{
    sessionId: string;
    muxName: string;
    pid: number;
    createdAt: number;
    workingDir: string;
    mode: string;
    attached: boolean;
    name?: string;
  }>,
  reconcileResult: { alive: [] as string[], dead: [] as string[], discovered: [] as string[] },
  // node:fs
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  mkdirSync: vi.fn(),
  writeFileCb: vi.fn((_p: unknown, _d: unknown, cb: (e: null) => void) => cb(null)),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  chmodSync: vi.fn(),
  // node:child_process
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === 'string' && cmd.includes('which')) return '/usr/bin/tmux\n';
    return '';
  }),
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn(), pid: 12345 })),
}));

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: mocks.execSync, spawn: mocks.spawn };
});

// ---------------------------------------------------------------------------
// Mock node:fs
// ---------------------------------------------------------------------------
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    mkdirSync: mocks.mkdirSync,
    writeFile: mocks.writeFileCb,
    writeFileSync: mocks.writeFileSync,
    readdirSync: mocks.readdirSync,
    chmodSync: mocks.chmodSync,
    statSync: vi.fn(() => ({ isDirectory: () => false })),
    unlinkSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('{}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  readdir: vi.fn().mockResolvedValue([]),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  unlink: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock state-store
// ---------------------------------------------------------------------------
vi.mock('../src/state-store.js', () => {
  const store = {
    getSession: vi.fn().mockReturnValue(null),
    setSession: vi.fn(),
    removeSession: vi.fn(),
    getConfig: vi.fn().mockReturnValue({}),
    getSessions: vi.fn().mockReturnValue({}),
    save: vi.fn(),
    cleanupStaleSessions: vi.fn().mockReturnValue({ removed: [] }),
    getAggregateStats: vi.fn().mockReturnValue({}),
    addToGlobalStats: vi.fn(),
    recordDailyUsage: vi.fn(),
    updateRalphState: vi.fn(),
    removeRalphState: vi.fn(),
    getRalphState: vi.fn().mockReturnValue(null),
    incrementSessionsCreated: vi.fn(),
  };
  return {
    getStore: () => store,
    StateStore: function () {
      return store;
    },
  };
});

// ---------------------------------------------------------------------------
// Mock session-lifecycle-log
// ---------------------------------------------------------------------------
vi.mock('../src/session-lifecycle-log.js', () => {
  const log = {
    log: vi.fn(),
    trimIfNeeded: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getLifecycleLog: () => log,
    SessionLifecycleLog: function () {
      return log;
    },
  };
});

// ---------------------------------------------------------------------------
// Mock ralph-config
// ---------------------------------------------------------------------------
vi.mock('../src/ralph-config.js', () => ({
  extractCompletionPhrase: vi.fn().mockReturnValue(null),
  loadRalphConfig: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Mock git-utils
// ---------------------------------------------------------------------------
vi.mock('../src/utils/git-utils.js', () => ({
  isGitWorktreeDir: vi.fn().mockReturnValue(false),
  getCurrentBranch: vi.fn().mockResolvedValue(null),
  findGitRoot: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Mock Session class
// ---------------------------------------------------------------------------
vi.mock('../src/session.js', async () => {
  const { EventEmitter } = await import('node:events');

  class MockSession extends EventEmitter {
    id: string;
    workingDir: string;
    mode: string;
    name: string;
    status: string = 'idle';
    worktreePath: string | undefined = undefined;
    claudeResumeId: string | null = null;
    flickerFilterEnabled: boolean | undefined = undefined;
    draft: string | undefined = undefined;
    mcpServers: unknown = undefined;
    ptyProcess = null;
    ralphTracker = {
      enabled: false,
      autoEnableDisabled: false,
      loopState: { completionPhrase: null },
      startLoop: vi.fn(),
      enable: vi.fn(),
      disableAutoEnable: vi.fn(),
      enableAutoEnable: vi.fn(),
    };

    constructor(opts: {
      id: string;
      workingDir: string;
      mode: string;
      name?: string;
      worktreePath?: string;
      claudeResumeId?: string | null;
      [key: string]: unknown;
    }) {
      super();
      this.id = opts.id;
      this.workingDir = opts.workingDir ?? '/tmp';
      this.mode = opts.mode ?? 'claude';
      this.name = opts.name ?? 'unnamed';
      this.worktreePath = opts.worktreePath;
      this.claudeResumeId = opts.claudeResumeId ?? null;
    }

    isBusy = vi.fn().mockReturnValue(false);
    markStopped = vi.fn(function (this: MockSession) {
      this.status = 'stopped';
    });
    startInteractive = vi.fn().mockResolvedValue(undefined);
    prepareForRestart = vi.fn().mockResolvedValue(undefined);
    setAutoCompact = vi.fn();
    setAutoClear = vi.fn();
    setNice = vi.fn();
    setSafeMode = vi.fn();
    setColor = vi.fn();
    restoreTokens = vi.fn();
    restoreContextWindow = vi.fn();
    getState = vi.fn(function (this: MockSession) {
      return { id: this.id };
    });
    toState = vi.fn(function (this: MockSession) {
      return { id: this.id, workingDir: this.workingDir, status: this.status, pid: null };
    });
  }

  return { Session: MockSession, SessionState: {} };
});

// ---------------------------------------------------------------------------
// Mock mux-factory — inject a fully controllable fake mux
// ---------------------------------------------------------------------------
vi.mock('../src/mux-factory.js', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeMux extends EventEmitter {
    reconcileSessions = vi.fn(async () => mocks.reconcileResult);
    getSessions = vi.fn(() => mocks.muxSessions);
    isPaneDead = vi.fn(async (muxName: string) => mocks.isPaneDeadImpl(muxName));
    listPaneDeathStates = vi.fn(async () => mocks.paneDeathStates);
    getSession = vi.fn();
    registerSession = vi.fn();
    killSession = vi.fn().mockResolvedValue(true);
    updateSessionName = vi.fn();
    startStatsCollection = vi.fn();
    startMouseModeSync = vi.fn();
    destroy = vi.fn();
  }

  const instance = new FakeMux();
  return { createMultiplexer: () => instance };
});

// ---------------------------------------------------------------------------
// Stub remaining heavy server deps (not relevant to the tested behaviour)
// ---------------------------------------------------------------------------
vi.mock('../src/subagent-watcher.js', async () => {
  const { EventEmitter } = await import('node:events');
  const instance = new EventEmitter();
  return {
    SubagentWatcher: class extends EventEmitter {},
    subagentWatcher: instance,
    getSubagentWatcher: () => instance,
  };
});
vi.mock('../src/image-watcher.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { imageWatcher: new EventEmitter() };
});
vi.mock('../src/team-watcher.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    TeamWatcher: class extends EventEmitter {
      start = vi.fn();
      stop = vi.fn();
    },
  };
});
vi.mock('../src/tunnel-manager.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    TunnelManager: class extends EventEmitter {
      start = vi.fn();
      stop = vi.fn();
    },
  };
});
vi.mock('../src/update-checker.js', () => ({
  UpdateChecker: class {
    check = vi.fn().mockResolvedValue(null);
  },
}));
vi.mock('../src/push-store.js', () => ({
  PushSubscriptionStore: class {
    getAll = vi.fn(() => []);
    save = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
  setVapidDetails: vi.fn(),
}));
vi.mock('../src/run-summary.js', () => ({
  RunSummaryTracker: class {
    on = vi.fn();
    off = vi.fn();
  },
}));
vi.mock('../src/plan-orchestrator.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    PlanOrchestrator: class extends EventEmitter {
      start = vi.fn();
      stop = vi.fn();
    },
  };
});
vi.mock('../src/respawn-controller.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    RespawnController: class extends EventEmitter {
      start = vi.fn();
      stop = vi.fn();
    },
  };
});
vi.mock('../src/file-stream-manager.js', () => ({
  fileStreamManager: {
    addStream: vi.fn(),
    removeStream: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  },
}));
vi.mock('../src/transcript-watcher.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    TranscriptWatcher: class extends EventEmitter {
      _transcriptPath: string | null = null;
      watch = vi.fn();
      unwatch = vi.fn();
      updatePath = vi.fn();
      constructor() {
        super();
      }
    },
  };
});

// Import after all mocks are registered
import { WebServer } from '../src/web/server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock Session-like object and inject it into the server's session map. */
function injectSession(
  server: WebServer,
  opts: {
    id: string;
    name?: string;
    busy?: boolean;
    worktreePath?: string | undefined;
  }
): any {
  const session = {
    id: opts.id,
    name: opts.name ?? 'Test Session',
    worktreePath: opts.worktreePath,
    isBusy: vi.fn().mockReturnValue(opts.busy ?? false),
    prepareForRestart: vi.fn().mockResolvedValue(undefined),
    startInteractive: vi.fn().mockResolvedValue(undefined),
    // Minimal extras WebServer may touch during broadcast helpers
    toState: vi.fn().mockReturnValue({ id: opts.id }),
    getState: vi.fn().mockReturnValue({ id: opts.id }),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };

  (server as any).sessions.set(opts.id, session);
  return session;
}

/** Wait for all microtasks and a tick so fire-and-forget promises settle. */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebServer.checkAndRecoverDeadPanes()', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset shared mock state
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.paneDeathStates = new Map();
    mocks.muxSessions = [];
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };

    // Construct in testMode — start() will NOT set up intervals
    server = new WebServer(0, false, true);

    // Stub methods not under test to keep them inert
    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();
    // Stub broadcast so we can spy without needing real SSE connections
    (server as any).broadcast = vi.fn();
    // Stub getSessionStateWithRespawn to avoid deep session state wiring
    (server as any).getSessionStateWithRespawn = vi.fn().mockReturnValue({});
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // Gap 1: Skip non-busy session
  // -------------------------------------------------------------------------
  it('skips sessions that are not busy', async () => {
    const session = injectSession(server, {
      id: 'idle-sess',
      busy: false,
      worktreePath: '/some/worktree',
    });
    mocks.isPaneDeadImpl.mockReturnValue(true);

    (server as any).checkAndRecoverDeadPanes();
    await flushAsync();

    expect(session.prepareForRestart).not.toHaveBeenCalled();
    expect(session.startInteractive).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Gap 2: Skip non-worktree session
  // -------------------------------------------------------------------------
  it('skips busy sessions that have no worktreePath', async () => {
    const session = injectSession(server, {
      id: 'non-worktree-sess',
      busy: true,
      worktreePath: undefined,
    });
    mocks.isPaneDeadImpl.mockReturnValue(true);

    (server as any).checkAndRecoverDeadPanes();
    await flushAsync();

    expect(session.prepareForRestart).not.toHaveBeenCalled();
    expect(session.startInteractive).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Gap 3: Skip already-recovering session (pre-push guard)
  // -------------------------------------------------------------------------
  it('skips sessions already present in _recoveringSessionIds before any async work', async () => {
    const session = injectSession(server, {
      id: 'recovering-sess',
      busy: true,
      worktreePath: '/some/worktree',
    });
    mocks.isPaneDeadImpl.mockReturnValue(true);

    // Pre-seed the recovering set
    (server as any)._recoveringSessionIds.add('recovering-sess');

    (server as any).checkAndRecoverDeadPanes();
    await flushAsync();

    expect(session.prepareForRestart).not.toHaveBeenCalled();
    expect(session.startInteractive).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Gap 4: Skip cleaning-up session
  // -------------------------------------------------------------------------
  it('skips sessions present in the cleaningUp set', async () => {
    const session = injectSession(server, {
      id: 'cleanup-sess',
      busy: true,
      worktreePath: '/some/worktree',
    });
    mocks.isPaneDeadImpl.mockReturnValue(true);

    (server as any).cleaningUp.add('cleanup-sess');

    (server as any).checkAndRecoverDeadPanes();
    await flushAsync();

    expect(session.prepareForRestart).not.toHaveBeenCalled();
    expect(session.startInteractive).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Gap 5: Alive pane — prepareForRestart/startInteractive not called
  // -------------------------------------------------------------------------
  it('does not call prepareForRestart or startInteractive when the pane is alive', async () => {
    const session = injectSession(server, {
      id: 'alive-sess',
      busy: true,
      worktreePath: '/some/worktree',
    });
    mocks.isPaneDeadImpl.mockReturnValue(false); // pane alive

    (server as any).checkAndRecoverDeadPanes();
    await flushAsync();

    expect(session.prepareForRestart).not.toHaveBeenCalled();
    expect(session.startInteractive).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Gap 6: Dead pane happy path
  // -------------------------------------------------------------------------
  it('calls prepareForRestart then startInteractive, broadcasts SSE events, and clears _recoveringSessionIds on success', async () => {
    const sessionId = 'dead-sess-happy';
    const session = injectSession(server, {
      id: sessionId,
      name: 'Happy Session',
      busy: true,
      worktreePath: '/some/worktree',
    });
    mocks.isPaneDeadImpl.mockReturnValue(true);

    (server as any).checkAndRecoverDeadPanes();
    await flushAsync();

    // Core recovery sequence
    expect(session.prepareForRestart).toHaveBeenCalledTimes(1);
    expect(session.startInteractive).toHaveBeenCalledTimes(1);

    // prepareForRestart must be called before startInteractive
    const prepareOrder = session.prepareForRestart.mock.invocationCallOrder[0];
    const startOrder = session.startInteractive.mock.invocationCallOrder[0];
    expect(prepareOrder).toBeLessThan(startOrder);

    // SSE broadcasts: SessionMessage (x2), SessionInteractive, SessionUpdated
    const broadcast = (server as any).broadcast as ReturnType<typeof vi.fn>;
    const eventNames: string[] = broadcast.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventNames).toContain('session:interactive');
    expect(eventNames).toContain('session:updated');
    // At least the "auto-recovered successfully" message
    const messageCalls = broadcast.mock.calls.filter((c: unknown[]) => c[0] === 'session:message');
    expect(messageCalls.length).toBeGreaterThanOrEqual(1);

    // Guard cleared after success
    expect((server as any)._recoveringSessionIds.has(sessionId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Gap 7: Dead pane error path
  // -------------------------------------------------------------------------
  it('broadcasts SessionError and clears _recoveringSessionIds when startInteractive rejects', async () => {
    const sessionId = 'dead-sess-error';
    const session = injectSession(server, {
      id: sessionId,
      name: 'Error Session',
      busy: true,
      worktreePath: '/some/worktree',
    });
    mocks.isPaneDeadImpl.mockReturnValue(true);
    session.startInteractive.mockRejectedValue(new Error('PTY spawn failed'));

    (server as any).checkAndRecoverDeadPanes();
    await flushAsync();

    const broadcast = (server as any).broadcast as ReturnType<typeof vi.fn>;
    const errorCalls = broadcast.mock.calls.filter((c: unknown[]) => c[0] === 'session:error');
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    // Error payload should contain the rejection message
    const payload = errorCalls[0][1] as Record<string, unknown>;
    expect(payload.id).toBe(sessionId);
    expect(String(payload.message)).toContain('PTY spawn failed');

    // Guard cleared after error
    expect((server as any)._recoveringSessionIds.has(sessionId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Gap 8: Concurrent recovery guard (two-phase inner async check)
  // -------------------------------------------------------------------------
  it('aborts the inner async recovery when _recoveringSessionIds is populated between outer and inner checks', async () => {
    const sessionId = 'concurrent-sess';
    const session = injectSession(server, {
      id: sessionId,
      busy: true,
      worktreePath: '/some/worktree',
    });

    // isPaneDead will add the id to _recoveringSessionIds before the inner guard runs
    mocks.isPaneDeadImpl.mockImplementation(() => {
      (server as any)._recoveringSessionIds.add(sessionId);
      return true; // pane IS dead, but concurrent recovery already started
    });

    (server as any).checkAndRecoverDeadPanes();
    await flushAsync();

    // Recovery must have been aborted by the inner guard
    expect(session.prepareForRestart).not.toHaveBeenCalled();
    expect(session.startInteractive).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Gap 9: Multiple sessions isolation (Promise.allSettled)
  // -------------------------------------------------------------------------
  it('recovers an alive-and-dead pair independently; failure of one does not prevent recovery of the other', async () => {
    const aliveId = 'multi-alive';
    const deadId = 'multi-dead';

    const aliveSession = injectSession(server, {
      id: aliveId,
      busy: true,
      worktreePath: '/worktree/alive',
    });
    const deadSession = injectSession(server, {
      id: deadId,
      busy: true,
      worktreePath: '/worktree/dead',
    });

    // alive pane: alive; dead pane: dead and its startInteractive rejects
    mocks.isPaneDeadImpl.mockImplementation((name: string) => name === `codeman-${deadId}`);
    deadSession.startInteractive.mockRejectedValue(new Error('restart failed'));

    (server as any).checkAndRecoverDeadPanes();
    await flushAsync();

    // Alive session must NOT have been touched
    expect(aliveSession.prepareForRestart).not.toHaveBeenCalled();
    expect(aliveSession.startInteractive).not.toHaveBeenCalled();

    // Dead session must have had recovery attempted
    expect(deadSession.prepareForRestart).toHaveBeenCalledTimes(1);
    // Guard cleared even after error
    expect((server as any)._recoveringSessionIds.has(deadId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Gap 10: Mux name formula
  // -------------------------------------------------------------------------
  // Pins the sweep's current (non-matching) derived name — see the NOTE in sweepDeadPanes().
  it('calls isPaneDead with the mux name "codeman-<sessionId>"', async () => {
    const sessionId = 'mux-name-check';
    injectSession(server, {
      id: sessionId,
      busy: true,
      worktreePath: '/some/worktree',
    });
    mocks.isPaneDeadImpl.mockReturnValue(false);

    (server as any).checkAndRecoverDeadPanes();
    await flushAsync();

    expect(mocks.isPaneDeadImpl).toHaveBeenCalledWith(`codeman-${sessionId}`);
  });

  // -------------------------------------------------------------------------
  // Sweep in-flight guard (_deadPaneCheckInFlight)
  // -------------------------------------------------------------------------
  describe('sweep in-flight guard (_deadPaneCheckInFlight)', () => {
    it('skips a sweep started while a previous sweep is still in flight', async () => {
      injectSession(server, {
        id: 'guard-sess',
        busy: true,
        worktreePath: '/some/worktree',
      });

      // Hold the first sweep open on a pending isPaneDead probe
      let resolveProbe!: (dead: boolean) => void;
      const pendingProbe = new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      });
      mocks.isPaneDeadImpl.mockReturnValue(pendingProbe);

      const firstSweep = (server as any).checkAndRecoverDeadPanes() as Promise<void>;
      // First sweep has synchronously reached the pending probe by now
      expect(mocks.isPaneDeadImpl).toHaveBeenCalledTimes(1);

      // Second call while the first sweep is in flight must not probe
      await (server as any).checkAndRecoverDeadPanes();
      expect(mocks.isPaneDeadImpl).toHaveBeenCalledTimes(1);

      resolveProbe(false);
      await firstSweep;
    });

    it('resets the in-flight flag after a sweep completes so the next sweep probes again', async () => {
      injectSession(server, {
        id: 'guard-reset-sess',
        busy: true,
        worktreePath: '/some/worktree',
      });
      mocks.isPaneDeadImpl.mockReturnValue(false);

      await (server as any).checkAndRecoverDeadPanes();
      await (server as any).checkAndRecoverDeadPanes();

      // A stuck flag would leave the second sweep skipped (count 1)
      expect(mocks.isPaneDeadImpl).toHaveBeenCalledTimes(2);
    });

    it('does not block subsequent sweeps when a recovery hangs (fire-and-forget recoveries)', async () => {
      const hungId = 'hung-recovery-sess';
      const healthyId = 'healthy-probe-sess';

      const hungSession = injectSession(server, {
        id: hungId,
        busy: true,
        worktreePath: '/worktree/hung',
      });
      const healthySession = injectSession(server, {
        id: healthyId,
        busy: true,
        worktreePath: '/worktree/healthy',
      });

      // Hung session's pane is dead; healthy session's pane is alive
      mocks.isPaneDeadImpl.mockImplementation((name: string) => name === `codeman-${hungId}`);
      // Recovery hangs forever on prepareForRestart
      hungSession.prepareForRestart.mockReturnValue(new Promise(() => {}));

      // Fire the first sweep without awaiting it directly — a direct await on a
      // regressed (recovery-awaiting) implementation would hang the test instead
      // of failing the assertions below.
      void (server as any).checkAndRecoverDeadPanes();
      await flushAsync();

      // The in-flight flag must clear after the probe phase even though the
      // hung recovery is still pending
      expect((server as any)._deadPaneCheckInFlight).toBe(false);

      // Second sweep must run its probe phase despite the pending recovery
      await (server as any).checkAndRecoverDeadPanes();
      await flushAsync();

      // Healthy session probed on both sweeps
      const healthyProbes = mocks.isPaneDeadImpl.mock.calls.filter(([name]) => name === `codeman-${healthyId}`);
      expect(healthyProbes.length).toBe(2);

      // Hung session probed only on the first sweep — skipped on the second
      // via _recoveringSessionIds while its recovery is still pending
      const hungProbes = mocks.isPaneDeadImpl.mock.calls.filter(([name]) => name === `codeman-${hungId}`);
      expect(hungProbes.length).toBe(1);

      // Recovery attempted exactly once — not re-triggered by the second sweep
      expect(hungSession.prepareForRestart).toHaveBeenCalledTimes(1);
      expect(healthySession.prepareForRestart).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Probe failure isolation (rejected isPaneDead)
  // -------------------------------------------------------------------------
  describe('probe failure isolation', () => {
    it('recovers a dead session even when the probe for another session rejects', async () => {
      const failId = 'probe-fail-sess';
      const deadId = 'probe-ok-dead-sess';

      const failSession = injectSession(server, {
        id: failId,
        busy: true,
        worktreePath: '/worktree/fail',
      });
      const deadSession = injectSession(server, {
        id: deadId,
        busy: true,
        worktreePath: '/worktree/dead',
      });

      // fail session's probe rejects; dead session's probe reports dead
      mocks.isPaneDeadImpl.mockImplementation((name: string) => {
        if (name === `codeman-${failId}`) throw new Error('probe failed');
        return true;
      });

      (server as any).checkAndRecoverDeadPanes();
      await flushAsync();

      // Rejected probe must not trigger recovery for its session
      expect(failSession.prepareForRestart).not.toHaveBeenCalled();
      expect(failSession.startInteractive).not.toHaveBeenCalled();

      // The other session's recovery must still proceed
      expect(deadSession.prepareForRestart).toHaveBeenCalledTimes(1);
      expect(deadSession.startInteractive).toHaveBeenCalledTimes(1);

      // No stale guard entries left behind
      expect((server as any)._recoveringSessionIds.size).toBe(0);
    });
  });
  // -------------------------------------------------------------------------
  // checkPaneDeaths(): busy worktree session with a real 8-char tmux name
  // -------------------------------------------------------------------------
  describe('checkPaneDeaths() with real tmux mux names', () => {
    const fullId = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    const realMuxName = `codeman-${fullId.slice(0, 8)}`;

    function injectMuxSession(opts: { busy: boolean; worktreePath?: string }): any {
      const session = injectSession(server, { id: fullId, busy: opts.busy, worktreePath: opts.worktreePath });
      Object.assign(session, {
        mode: 'claude',
        paused: false,
        paneDead: false,
        muxName: realMuxName,
        ptyGeneration: 1,
        markPaneDead: vi.fn(function (exitStatus: number | null) {
          session.paneDead = true;
          session.paneExitStatus = exitStatus;
          session.isBusy.mockReturnValue(false);
          return true;
        }),
      });
      return session;
    }

    it('marks a BUSY worktree session exited when its pane (codeman-<8 chars>) is dead', async () => {
      const session = injectMuxSession({ busy: true, worktreePath: '/some/worktree' });
      mocks.paneDeathStates = new Map([[realMuxName, { dead: true, exitStatus: 0 }]]);

      await (server as any).checkPaneDeaths();

      expect(session.markPaneDead).toHaveBeenCalledWith(0);
      const broadcast = (server as any).broadcast as ReturnType<typeof vi.fn>;
      const eventNames: string[] = broadcast.mock.calls.map((c: unknown[]) => c[0]);
      expect(eventNames).toContain('session:updated');
      // Pane death must never look like a session exit (frontend auto-closes on code 0)
      expect(eventNames.some((n) => n.includes('exit'))).toBe(false);
      expect((server as any).persistSessionState).toHaveBeenCalledWith(session);

      // The auto-recovery sweep must not then fight it: the session is no longer busy
      mocks.isPaneDeadImpl.mockReturnValue(true);
      await (server as any).checkAndRecoverDeadPanes();
      await flushAsync();
      expect(session.prepareForRestart).not.toHaveBeenCalled();
      expect(session.startInteractive).not.toHaveBeenCalled();
    });

    it('matches pane states by the session muxName, not a name derived from the full id', async () => {
      const session = injectMuxSession({ busy: true, worktreePath: '/some/worktree' });
      mocks.paneDeathStates = new Map([
        [`codeman-${fullId}`, { dead: true, exitStatus: 1 }],
        [realMuxName, { dead: false, exitStatus: null }],
      ]);

      await (server as any).checkPaneDeaths();

      expect(session.markPaneDead).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // checkPaneDeaths(): remaining branches (common case, skips, race and in-flight guards)
  // -------------------------------------------------------------------------
  describe('checkPaneDeaths() branches', () => {
    /** A mux-bound session (idle, no worktree) whose muxName is `codeman-<first 8 chars>`. */
    function injectPaneSession(id: string, overrides: Record<string, unknown> = {}): any {
      const session = injectSession(server, { id });
      Object.assign(session, {
        mode: 'shell',
        paused: false,
        paneDead: false,
        muxName: `codeman-${id.slice(0, 8)}`,
        ptyGeneration: 1,
        markPaneDead: vi.fn().mockReturnValue(true),
        ...overrides,
      });
      return session;
    }

    const broadcast = () => (server as any).broadcast as ReturnType<typeof vi.fn>;
    const persist = () => (server as any).persistSessionState as ReturnType<typeof vi.fn>;
    const listPaneDeathStates = () => (server as any).mux.listPaneDeathStates as ReturnType<typeof vi.fn>;

    it('marks a plain idle non-worktree session exited, broadcasts SessionUpdated and persists', async () => {
      const session = injectPaneSession('plain001-idle');
      mocks.paneDeathStates = new Map([['codeman-plain001', { dead: true, exitStatus: 7 }]]);

      await (server as any).checkPaneDeaths();

      expect(session.markPaneDead).toHaveBeenCalledWith(7);
      const names: string[] = broadcast().mock.calls.map((c: unknown[]) => c[0] as string);
      expect(names).toEqual(['session:updated']);
      expect(persist()).toHaveBeenCalledWith(session);
    });

    it.each([
      ['paused', (_srv: any, s: any) => (s.paused = true)],
      ['already marked paneDead', (_srv: any, s: any) => (s.paneDead = true)],
      ['being cleaned up', (srv: any, s: any) => srv.cleaningUp.add(s.id)],
      ['being auto-recovered', (srv: any, s: any) => srv._recoveringSessionIds.add(s.id)],
    ])('skips a session that is %s', async (_label, setup) => {
      const session = injectPaneSession('skip0001-sess');
      setup(server, session);
      mocks.paneDeathStates = new Map([['codeman-skip0001', { dead: true, exitStatus: 0 }]]);

      await (server as any).checkPaneDeaths();

      expect(session.markPaneDead).not.toHaveBeenCalled();
      expect(broadcast()).not.toHaveBeenCalled();
      expect(persist()).not.toHaveBeenCalled();
    });

    it('skips a session restarted (ptyGeneration changed) while the probe was pending', async () => {
      const session = injectPaneSession('race0001-sess');
      let resolveProbe!: (m: Map<string, { dead: boolean; exitStatus: number | null }>) => void;
      listPaneDeathStates().mockImplementationOnce(() => new Promise((r) => (resolveProbe = r)));

      const check = (server as any).checkPaneDeaths() as Promise<void>;
      session.ptyGeneration = 2; // restart completed during the probe
      resolveProbe(new Map([['codeman-race0001', { dead: true, exitStatus: 0 }]]));
      await check;

      expect(session.markPaneDead).not.toHaveBeenCalled();
      expect(broadcast()).not.toHaveBeenCalled();
    });

    it('does not broadcast or persist when markPaneDead() declines', async () => {
      const session = injectPaneSession('decl0001-sess', { markPaneDead: vi.fn().mockReturnValue(false) });
      mocks.paneDeathStates = new Map([['codeman-decl0001', { dead: true, exitStatus: 1 }]]);

      await (server as any).checkPaneDeaths();

      expect(session.markPaneDead).toHaveBeenCalledWith(1);
      expect(broadcast()).not.toHaveBeenCalled();
      expect(persist()).not.toHaveBeenCalled();
    });

    it.each([
      ['its pane is alive', new Map([['codeman-live0001', { dead: false, exitStatus: null }]])],
      ['its pane has no entry', new Map([['codeman-someone', { dead: true, exitStatus: 0 }]])],
      ['the probe returns an empty map', new Map()],
    ])('does not mark a session when %s', async (_label, states) => {
      const session = injectPaneSession('live0001-sess');
      mocks.paneDeathStates = states as Map<string, { dead: boolean; exitStatus: number | null }>;

      await (server as any).checkPaneDeaths();

      expect(session.markPaneDead).not.toHaveBeenCalled();
      expect(broadcast()).not.toHaveBeenCalled();
    });

    it('does not probe again while a check is in flight, and resets the guard afterwards', async () => {
      injectPaneSession('flight01-sess');
      let resolveProbe!: (m: Map<string, { dead: boolean; exitStatus: number | null }>) => void;
      listPaneDeathStates().mockImplementationOnce(() => new Promise((r) => (resolveProbe = r)));

      const first = (server as any).checkPaneDeaths() as Promise<void>;
      expect(listPaneDeathStates()).toHaveBeenCalledTimes(1);

      await (server as any).checkPaneDeaths();
      expect(listPaneDeathStates()).toHaveBeenCalledTimes(1);

      resolveProbe(new Map());
      await first;
      expect((server as any)._paneDeathCheckInFlight).toBe(false);

      await (server as any).checkPaneDeaths();
      expect(listPaneDeathStates()).toHaveBeenCalledTimes(2);
    });
  });
});

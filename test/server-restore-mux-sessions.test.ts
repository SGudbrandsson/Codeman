/**
 * @fileoverview Unit tests for WebServer.restoreMuxSessions() auto-reconnect logic.
 *
 * Tests the three new branches added to restoreMuxSessions():
 * 1. Alive pane  -> session.startInteractive() is called
 * 2. Dead pane   -> session.startInteractive() is NOT called
 * 3. startInteractive() rejects -> error is swallowed, loop continues
 *
 * SAFETY: Server is constructed in testMode=true so restoreMuxSessions() is
 * NOT invoked during start(). We call it directly as a private method.
 * No real tmux commands are executed (TmuxManager is in VITEST test mode).
 *
 * Port: N/A (no server.start() is called)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// All mock functions must be declared via vi.hoisted() so they are available
// when vi.mock() factory callbacks are hoisted to the top of the module.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  startInteractiveImpl: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  isPaneDeadImpl: vi.fn<[string], boolean>().mockReturnValue(false),
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
  // TranscriptWatcher instances created during tests — captured for assertion
  transcriptWatcherInstances: [] as Array<{
    updatePath: ReturnType<typeof vi.fn>;
    _transcriptPath: string | null;
    on: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => boolean;
    transcriptClearCount: { value: number };
  }>,
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
// Captures all Session constructor calls so tests can inspect which opts were passed
const sessionConstructorCalls: Array<Record<string, unknown>> = [];

vi.mock('../src/session.js', async () => {
  const { EventEmitter } = await import('node:events');

  class MockSession extends EventEmitter {
    id: string;
    workingDir: string;
    mode: string;
    name: string;
    status: string = 'idle';
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
      claudeResumeId?: string | null;
      [key: string]: unknown;
    }) {
      super();
      this.id = opts.id;
      this.workingDir = opts.workingDir ?? '/tmp';
      this.mode = opts.mode ?? 'claude';
      this.name = opts.name ?? 'unnamed';
      this.claudeResumeId = opts.claudeResumeId ?? null;
      // Record constructor arguments for test assertions (Gap 3)
      sessionConstructorCalls.push({ ...opts });
    }

    markStopped = vi.fn(function (this: MockSession) {
      this.status = 'stopped';
    });
    startInteractive = mocks.startInteractiveImpl;
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
    isPaneDead = vi.fn((muxName: string) => mocks.isPaneDeadImpl(muxName));
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
      updatePath = vi.fn(function (
        this: { _transcriptPath: string | null; emit: (e: string) => boolean },
        path: string
      ) {
        if (this._transcriptPath !== path) {
          this.emit('transcript:clear');
          this._transcriptPath = path;
        }
      });
      constructor() {
        super();
        // Capture this instance for test assertions
        mocks.transcriptWatcherInstances.push(this as unknown as (typeof mocks.transcriptWatcherInstances)[0]);
      }
    },
  };
});

// Import after all mocks are registered
import { WebServer } from '../src/web/server.js';
import { getStore } from '../src/state-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _sessionCounter = 0;

function makeMuxSession(
  overrides: Partial<{
    sessionId: string;
    muxName: string;
    pid: number;
    createdAt: number;
    workingDir: string;
    mode: string;
    attached: boolean;
    name: string;
  }> = {}
) {
  _sessionCounter++;
  return {
    sessionId: overrides.sessionId ?? `sess-${_sessionCounter}`,
    muxName: overrides.muxName ?? `codeman-${_sessionCounter.toString(16).padStart(8, '0')}`,
    pid: overrides.pid ?? 1234,
    createdAt: overrides.createdAt ?? Date.now(),
    workingDir: overrides.workingDir ?? '/tmp',
    mode: overrides.mode ?? 'claude',
    attached: overrides.attached ?? false,
    name: overrides.name ?? 'Test Session',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebServer.restoreMuxSessions() — auto-reconnect on restart', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    // Reset shared mock state
    mocks.startInteractiveImpl.mockResolvedValue(undefined);
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.muxSessions = [];
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };

    // Construct in testMode — start() will NOT call restoreMuxSessions()
    server = new WebServer(0, false, true);

    // Stub methods not under test to keep them inert
    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  it('calls startInteractive() for a session whose tmux pane is alive', async () => {
    const muxSession = makeMuxSession({ sessionId: 'sess-alive', muxName: 'codeman-aabbccdd' });
    mocks.muxSessions = [muxSession];
    mocks.reconcileResult = { alive: ['sess-alive'], dead: [], discovered: [] };
    mocks.isPaneDeadImpl.mockReturnValue(false); // pane is alive

    await (server as any).restoreMuxSessions();

    expect(mocks.startInteractiveImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT call startInteractive() for a session whose tmux pane is dead', async () => {
    const muxSession = makeMuxSession({ sessionId: 'sess-dead', muxName: 'codeman-deadbeef' });
    mocks.muxSessions = [muxSession];
    mocks.reconcileResult = { alive: ['sess-dead'], dead: [], discovered: [] };
    mocks.isPaneDeadImpl.mockReturnValue(true); // pane is dead

    await (server as any).restoreMuxSessions();

    expect(mocks.startInteractiveImpl).not.toHaveBeenCalled();
  });

  it('continues restoring remaining sessions when startInteractive() rejects for one session', async () => {
    const session1 = makeMuxSession({ sessionId: 'sess-fail', muxName: 'codeman-fail1111' });
    const session2 = makeMuxSession({ sessionId: 'sess-ok', muxName: 'codeman-ok222222' });
    mocks.muxSessions = [session1, session2];
    mocks.reconcileResult = { alive: ['sess-fail', 'sess-ok'], dead: [], discovered: [] };
    mocks.isPaneDeadImpl.mockReturnValue(false); // both panes alive

    let callCount = 0;
    mocks.startInteractiveImpl.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('PTY attach failed'));
      return Promise.resolve();
    });

    // The loop must complete without throwing
    await expect((server as any).restoreMuxSessions()).resolves.not.toThrow();

    // Let the fire-and-forget promises settle
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Both sessions had startInteractive() attempted
    expect(mocks.startInteractiveImpl).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — Eager transcript watcher on restore
// ---------------------------------------------------------------------------

describe('WebServer.restoreMuxSessions() — eager transcript watcher', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    // Reset shared mock state
    mocks.startInteractiveImpl.mockResolvedValue(undefined);
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.muxSessions = [];
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };
    mocks.transcriptWatcherInstances = [];

    // Default store.getSession returns null (no saved state)
    (getStore() as any).getSession.mockReturnValue(null);
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    // Construct in testMode — start() will NOT call restoreMuxSessions()
    server = new WebServer(0, false, true);

    // Stub methods not under test
    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  it('calls startTranscriptWatcher() with the correct JSONL path when claudeResumeId and workingDir are set', async () => {
    const resumeId = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
    const workingDir = '/home/user/myproject';
    const muxSession = makeMuxSession({
      sessionId: 'sess-with-resume',
      muxName: 'codeman-resumetest',
      workingDir,
    });
    mocks.muxSessions = [muxSession];
    mocks.reconcileResult = { alive: ['sess-with-resume'], dead: [], discovered: [] };

    // Return savedState with claudeResumeId so the server sets it on the session
    (getStore() as any).getSession.mockReturnValue({
      status: 'idle',
      claudeResumeId: resumeId,
    });

    // Spy on startTranscriptWatcher before calling restoreMuxSessions
    const startWatcherSpy = vi.spyOn(server as any, 'startTranscriptWatcher');

    await (server as any).restoreMuxSessions();

    // Expected path uses same escaping as the production code
    const escapedDir = workingDir.replace(/\//g, '-');
    const expectedPath = join(homedir(), '.claude', 'projects', escapedDir, `${resumeId}.jsonl`);

    expect(startWatcherSpy).toHaveBeenCalledTimes(1);
    expect(startWatcherSpy).toHaveBeenCalledWith('sess-with-resume', expectedPath);
  });

  it('does NOT call startTranscriptWatcher() when claudeResumeId is absent from savedState', async () => {
    const muxSession = makeMuxSession({
      sessionId: 'sess-no-resume',
      muxName: 'codeman-noresume',
      workingDir: '/home/user/myproject',
    });
    mocks.muxSessions = [muxSession];
    mocks.reconcileResult = { alive: ['sess-no-resume'], dead: [], discovered: [] };

    // savedState has no claudeResumeId
    (getStore() as any).getSession.mockReturnValue({ status: 'idle' });

    const startWatcherSpy = vi.spyOn(server as any, 'startTranscriptWatcher');

    await (server as any).restoreMuxSessions();

    expect(startWatcherSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit transcript:clear on second startTranscriptWatcher() call with the same path', async () => {
    const resumeId = '11112222-3333-4444-5555-666677778888';
    const workingDir = '/home/user/project2';
    const muxSession = makeMuxSession({
      sessionId: 'sess-double-watch',
      muxName: 'codeman-doublewatch',
      workingDir,
    });
    mocks.muxSessions = [muxSession];
    mocks.reconcileResult = { alive: ['sess-double-watch'], dead: [], discovered: [] };

    (getStore() as any).getSession.mockReturnValue({
      status: 'idle',
      claudeResumeId: resumeId,
    });

    await (server as any).restoreMuxSessions();

    // The eager watcher call created exactly one TranscriptWatcher instance
    expect(mocks.transcriptWatcherInstances).toHaveLength(1);
    const watcher = mocks.transcriptWatcherInstances[0];

    // Record how many times transcript:clear was emitted by the watcher
    let transcriptClearCount = 0;
    watcher.on('transcript:clear', () => {
      transcriptClearCount++;
    });

    // Simulate the conversationId SSE listener calling startTranscriptWatcher again
    // with the same path — this is the scenario the eager watcher is designed to prevent
    const escapedDir = workingDir.replace(/\//g, '-');
    const samePath = join(homedir(), '.claude', 'projects', escapedDir, `${resumeId}.jsonl`);
    (server as any).startTranscriptWatcher('sess-double-watch', samePath);

    // updatePath was called twice total (once eager, once simulated conversationId)
    expect(watcher.updatePath).toHaveBeenCalledTimes(2);

    // No transcript:clear must have been emitted from the second call
    // (the watcher already has the path set, so updatePath() is a no-op)
    expect(transcriptClearCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gap 3 — worktreeNotes / assignedPort fix in the mux recovery path
// ---------------------------------------------------------------------------

describe('WebServer.restoreMuxSessions() — mux path passes worktreeNotes and assignedPort', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    mocks.startInteractiveImpl.mockResolvedValue(undefined);
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.muxSessions = [];
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };

    (getStore() as any).getSession.mockReturnValue(null);
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    server = new WebServer(0, false, true);

    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  it('passes worktreeNotes and assignedPort from savedState to the mux-path Session constructor', async () => {
    const muxSession = makeMuxSession({
      sessionId: 'sess-mux-notes',
      muxName: 'codeman-muxnotes1',
      workingDir: '/tmp',
    });
    mocks.muxSessions = [muxSession];
    mocks.reconcileResult = { alive: ['sess-mux-notes'], dead: [], discovered: [] };
    mocks.isPaneDeadImpl.mockReturnValue(false);

    (getStore() as any).getSession.mockReturnValue({
      status: 'idle',
      worktreeNotes: 'My notes here',
      assignedPort: 4321,
    });

    await (server as any).restoreMuxSessions();

    const call = sessionConstructorCalls.find((c) => c.id === 'sess-mux-notes');
    expect(call).toBeDefined();
    expect(call!.worktreeNotes).toBe('My notes here');
    expect(call!.assignedPort).toBe(4321);
  });
});

// ---------------------------------------------------------------------------
// Gap 1 — Non-mux restore pass (primary crash-recovery logic)
// ---------------------------------------------------------------------------

describe('WebServer.restoreMuxSessions() — non-mux restore pass', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    mocks.startInteractiveImpl.mockResolvedValue(undefined);
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.muxSessions = [];
    // No alive mux sessions — simulates the "tmux is dead" scenario
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };

    (getStore() as any).getSession.mockReturnValue(null);
    (getStore() as any).getSessions.mockReturnValue({});
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    server = new WebServer(0, false, true);

    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  it('creates a Session for a state.json entry with no surviving tmux pane and adds it to this.sessions', async () => {
    // existsSync returns true so workingDir check passes
    mocks.existsSync.mockReturnValue(true);

    (getStore() as any).getSessions.mockReturnValue({
      'sess-nonmux-1': {
        id: 'sess-nonmux-1',
        workingDir: '/tmp/project1',
        mode: 'claude',
        name: 'My Session',
        status: 'stopped',
        createdAt: 1000,
      },
    });

    await (server as any).restoreMuxSessions();

    const sessions: Map<string, unknown> = (server as any).sessions;
    expect(sessions.has('sess-nonmux-1')).toBe(true);
    expect((server as any).setupSessionListeners).toHaveBeenCalledTimes(1);
  });

  it('skips a state.json entry whose workingDir does not exist on disk', async () => {
    mocks.existsSync.mockReturnValue(false);

    (getStore() as any).getSessions.mockReturnValue({
      'sess-missing-dir': {
        id: 'sess-missing-dir',
        workingDir: '/nonexistent/path',
        mode: 'claude',
        name: 'Gone Session',
        status: 'stopped',
        createdAt: 1000,
      },
    });

    await (server as any).restoreMuxSessions();

    const sessions: Map<string, unknown> = (server as any).sessions;
    expect(sessions.has('sess-missing-dir')).toBe(false);
  });

  it('skips archived sessions in state.json', async () => {
    mocks.existsSync.mockReturnValue(true);

    (getStore() as any).getSessions.mockReturnValue({
      'sess-archived': {
        id: 'sess-archived',
        workingDir: '/tmp/archived',
        mode: 'claude',
        name: 'Archived Session',
        status: 'archived',
        createdAt: 1000,
      },
    });

    await (server as any).restoreMuxSessions();

    const sessions: Map<string, unknown> = (server as any).sessions;
    expect(sessions.has('sess-archived')).toBe(false);
  });

  it('adds parent sessions (no worktreeOriginId) before child sessions', async () => {
    mocks.existsSync.mockReturnValue(true);

    // Child is listed first in the object to ensure sorting is not order-dependent
    (getStore() as any).getSessions.mockReturnValue({
      'sess-child': {
        id: 'sess-child',
        workingDir: '/tmp/child',
        mode: 'claude',
        name: 'Child',
        status: 'stopped',
        createdAt: 2000,
        worktreeOriginId: 'sess-parent',
      },
      'sess-parent': {
        id: 'sess-parent',
        workingDir: '/tmp/parent',
        mode: 'claude',
        name: 'Parent',
        status: 'stopped',
        createdAt: 1000,
      },
    });

    await (server as any).restoreMuxSessions();

    // Parent constructor call must appear before child constructor call
    const parentIdx = sessionConstructorCalls.findIndex((c) => c.id === 'sess-parent');
    const childIdx = sessionConstructorCalls.findIndex((c) => c.id === 'sess-child');
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeGreaterThanOrEqual(0);
    expect(parentIdx).toBeLessThan(childIdx);
  });

  it('passes worktreeNotes and assignedPort to the non-mux Session constructor', async () => {
    mocks.existsSync.mockReturnValue(true);

    (getStore() as any).getSessions.mockReturnValue({
      'sess-with-meta': {
        id: 'sess-with-meta',
        workingDir: '/tmp/meta',
        mode: 'claude',
        name: 'Meta Session',
        status: 'stopped',
        createdAt: 1000,
        worktreeNotes: 'Important notes',
        assignedPort: 5678,
      },
    });

    await (server as any).restoreMuxSessions();

    const call = sessionConstructorCalls.find((c) => c.id === 'sess-with-meta');
    expect(call).toBeDefined();
    expect(call!.worktreeNotes).toBe('Important notes');
    expect(call!.assignedPort).toBe(5678);
  });

  it('preserves createdAt from savedState in the Session constructor', async () => {
    mocks.existsSync.mockReturnValue(true);

    (getStore() as any).getSessions.mockReturnValue({
      'sess-createdat': {
        id: 'sess-createdat',
        workingDir: '/tmp/createdat',
        mode: 'claude',
        name: 'CreatedAt Session',
        status: 'stopped',
        createdAt: 1234567890,
      },
    });

    await (server as any).restoreMuxSessions();

    const call = sessionConstructorCalls.find((c) => c.id === 'sess-createdat');
    expect(call).toBeDefined();
    expect(call!.createdAt).toBe(1234567890);
  });

  it('marks stopped sessions with stopped status after restore', async () => {
    mocks.existsSync.mockReturnValue(true);

    // Track sessions added to this.sessions so we can inspect them
    const capturedSessions: unknown[] = [];
    const originalSet = (server as any).sessions.set.bind((server as any).sessions);
    (server as any).sessions.set = (id: string, sess: unknown) => {
      capturedSessions.push(sess);
      return originalSet(id, sess);
    };

    (getStore() as any).getSessions.mockReturnValue({
      'sess-stopped-status': {
        id: 'sess-stopped-status',
        workingDir: '/tmp/stopped',
        mode: 'claude',
        name: 'Stopped Session',
        status: 'stopped',
        createdAt: 1000,
      },
    });

    await (server as any).restoreMuxSessions();

    // The session object in this.sessions must have status 'stopped'
    const sess = capturedSessions.find((s: any) => s.id === 'sess-stopped-status') as any;
    expect(sess).toBeDefined();
    expect(sess.status).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// Non-mux error isolation — per-session try/catch
// ---------------------------------------------------------------------------

describe('WebServer.restoreMuxSessions() — non-mux error isolation', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    mocks.startInteractiveImpl.mockResolvedValue(undefined);
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.muxSessions = [];
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };

    (getStore() as any).getSession.mockReturnValue(null);
    (getStore() as any).getSessions.mockReturnValue({});
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    server = new WebServer(0, false, true);

    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();

    mocks.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  it('continues processing remaining sessions when one fails setupSessionListeners', async () => {
    (getStore() as any).getSessions.mockReturnValue({
      'sess-err-first': {
        id: 'sess-err-first',
        workingDir: '/tmp/err-first',
        mode: 'claude',
        name: 'Error First',
        status: 'stopped',
        createdAt: 1000,
      },
      'sess-ok-second': {
        id: 'sess-ok-second',
        workingDir: '/tmp/ok-second',
        mode: 'claude',
        name: 'OK Second',
        status: 'stopped',
        createdAt: 2000,
      },
    });

    let callCount = 0;
    (server as any).setupSessionListeners = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('setupSessionListeners failed for first session');
      return Promise.resolve();
    });

    // Must not throw
    await expect((server as any).restoreMuxSessions()).resolves.not.toThrow();

    // The second session must have been added to this.sessions despite the first failing
    const sessions: Map<string, unknown> = (server as any).sessions;
    expect(sessions.has('sess-ok-second')).toBe(true);
    // The failed session must be removed from the map (no zombie with missing listeners)
    expect(sessions.has('sess-err-first')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — Auto-resume for sessions that were running
// ---------------------------------------------------------------------------

describe('WebServer.restoreMuxSessions() — non-mux auto-resume', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    mocks.startInteractiveImpl.mockResolvedValue(undefined);
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.muxSessions = [];
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };

    (getStore() as any).getSession.mockReturnValue(null);
    (getStore() as any).getSessions.mockReturnValue({});
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    server = new WebServer(0, false, true);

    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();

    // existsSync always returns true so workingDir check passes
    mocks.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  it('calls startInteractive() for an idle session with a claudeResumeId in claude mode', async () => {
    (getStore() as any).getSessions.mockReturnValue({
      'sess-idle-resume': {
        id: 'sess-idle-resume',
        workingDir: '/tmp/proj',
        mode: 'claude',
        name: 'Resumable',
        status: 'idle',
        createdAt: 1000,
        claudeResumeId: 'aaaa-bbbb-cccc',
      },
    });

    await (server as any).restoreMuxSessions();

    // Fire-and-forget: let the microtask queue drain
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.startInteractiveImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT call startInteractive() for a stopped session even with claudeResumeId', async () => {
    (getStore() as any).getSessions.mockReturnValue({
      'sess-stopped-resume': {
        id: 'sess-stopped-resume',
        workingDir: '/tmp/proj',
        mode: 'claude',
        name: 'Stopped',
        status: 'stopped',
        createdAt: 1000,
        claudeResumeId: 'dddd-eeee-ffff',
      },
    });

    await (server as any).restoreMuxSessions();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.startInteractiveImpl).not.toHaveBeenCalled();
  });

  it('does NOT call startInteractive() for an idle session with no claudeResumeId', async () => {
    (getStore() as any).getSessions.mockReturnValue({
      'sess-idle-noresume': {
        id: 'sess-idle-noresume',
        workingDir: '/tmp/proj',
        mode: 'claude',
        name: 'Idle No Resume',
        status: 'idle',
        createdAt: 1000,
        // No claudeResumeId
      },
    });

    await (server as any).restoreMuxSessions();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.startInteractiveImpl).not.toHaveBeenCalled();
  });

  it('does NOT call startInteractive() for an idle opencode session with claudeResumeId', async () => {
    (getStore() as any).getSessions.mockReturnValue({
      'sess-opencode-resume': {
        id: 'sess-opencode-resume',
        workingDir: '/tmp/proj',
        mode: 'opencode',
        name: 'Opencode',
        status: 'idle',
        createdAt: 1000,
        claudeResumeId: 'gggg-hhhh-iiii',
      },
    });

    await (server as any).restoreMuxSessions();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.startInteractiveImpl).not.toHaveBeenCalled();
  });

  it('swallows startInteractive() rejection and continues processing remaining sessions', async () => {
    (getStore() as any).getSessions.mockReturnValue({
      'sess-fail-resume': {
        id: 'sess-fail-resume',
        workingDir: '/tmp/fail',
        mode: 'claude',
        name: 'Fail',
        status: 'idle',
        createdAt: 1000,
        claudeResumeId: 'fail-resume-id',
      },
      'sess-ok-resume': {
        id: 'sess-ok-resume',
        workingDir: '/tmp/ok',
        mode: 'claude',
        name: 'OK',
        status: 'idle',
        createdAt: 2000,
        claudeResumeId: 'ok-resume-id',
      },
    });

    let callCount = 0;
    mocks.startInteractiveImpl.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('auto-resume failed'));
      return Promise.resolve();
    });

    // Must not throw
    await expect((server as any).restoreMuxSessions()).resolves.not.toThrow();

    // Let fire-and-forget promises settle
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Both sessions had startInteractive() attempted
    expect(mocks.startInteractiveImpl).toHaveBeenCalledTimes(2);
    // Both sessions must still appear in this.sessions
    const sessions: Map<string, unknown> = (server as any).sessions;
    expect(sessions.has('sess-fail-resume')).toBe(true);
    expect(sessions.has('sess-ok-resume')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap 4 — _restoreSessionConfig() helper
// ---------------------------------------------------------------------------

describe('WebServer._restoreSessionConfig()', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    (getStore() as any).getSessions.mockReturnValue({});
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    server = new WebServer(0, false, true);

    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  function makeSession(opts: { mode?: string } = {}): {
    id: string;
    workingDir: string;
    mode: string;
    claudeResumeId: string | null;
    flickerFilterEnabled: boolean | undefined;
    draft: string | undefined;
    mcpServers: unknown;
    setAutoCompact: ReturnType<typeof vi.fn>;
    setAutoClear: ReturnType<typeof vi.fn>;
    setNice: ReturnType<typeof vi.fn>;
    setSafeMode: ReturnType<typeof vi.fn>;
    setColor: ReturnType<typeof vi.fn>;
    restoreTokens: ReturnType<typeof vi.fn>;
    restoreContextWindow: ReturnType<typeof vi.fn>;
    ralphTracker: {
      enabled: boolean;
      autoEnableDisabled: boolean;
      loopState: { completionPhrase: null };
      startLoop: ReturnType<typeof vi.fn>;
      enable: ReturnType<typeof vi.fn>;
      disableAutoEnable: ReturnType<typeof vi.fn>;
      enableAutoEnable: ReturnType<typeof vi.fn>;
    };
    emit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  } {
    return {
      id: 'test-session',
      workingDir: '/tmp',
      mode: opts.mode ?? 'claude',
      claudeResumeId: null,
      flickerFilterEnabled: undefined,
      draft: undefined,
      mcpServers: undefined,
      setAutoCompact: vi.fn(),
      setAutoClear: vi.fn(),
      setNice: vi.fn(),
      setSafeMode: vi.fn(),
      setColor: vi.fn(),
      restoreTokens: vi.fn(),
      restoreContextWindow: vi.fn(),
      ralphTracker: {
        enabled: false,
        autoEnableDisabled: false,
        loopState: { completionPhrase: null },
        startLoop: vi.fn(),
        enable: vi.fn(),
        disableAutoEnable: vi.fn(),
        enableAutoEnable: vi.fn(),
      },
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
  }

  it('calls setAutoCompact() when autoCompactEnabled is present in savedState', () => {
    const session = makeSession();
    (server as any)._restoreSessionConfig(session, {
      autoCompactEnabled: true,
      autoCompactThreshold: 80000,
      autoCompactPrompt: 'compact now',
    });
    expect(session.setAutoCompact).toHaveBeenCalledWith(true, 80000, 'compact now');
  });

  it('calls setAutoClear() when autoClearEnabled is present in savedState', () => {
    const session = makeSession();
    (server as any)._restoreSessionConfig(session, {
      autoClearEnabled: true,
      autoClearThreshold: 5000,
    });
    expect(session.setAutoClear).toHaveBeenCalledWith(true, 5000);
  });

  it('restores claudeResumeId onto the session object', () => {
    const session = makeSession();
    (server as any)._restoreSessionConfig(session, {
      claudeResumeId: 'my-resume-id',
    });
    expect(session.claudeResumeId).toBe('my-resume-id');
  });

  it('skips Ralph restore when session.mode is opencode', () => {
    const session = makeSession({ mode: 'opencode' });
    (server as any)._restoreSessionConfig(session, {
      ralphEnabled: true,
      ralphCompletionPhrase: 'DONE',
    });
    expect(session.ralphTracker.enable).not.toHaveBeenCalled();
    expect(session.ralphTracker.startLoop).not.toHaveBeenCalled();
  });

  it('skips respawn restore when session.mode is opencode', () => {
    const restoreRespawnSpy = vi.spyOn(server as any, 'restoreRespawnController').mockImplementation(() => {});
    const session = makeSession({ mode: 'opencode' });
    (server as any)._restoreSessionConfig(session, {
      respawnEnabled: true,
      respawnConfig: { enabled: true, intervalMs: 5000 },
    });
    expect(restoreRespawnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test group 1 — Color restoration in _restoreSessionConfig()
// ---------------------------------------------------------------------------

describe('WebServer._restoreSessionConfig() — color restoration', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    (getStore() as any).getSessions.mockReturnValue({});
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    server = new WebServer(0, false, true);

    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  function makeColorSession(opts: { mode?: string } = {}) {
    return {
      id: 'test-color-session',
      workingDir: '/tmp',
      mode: opts.mode ?? 'claude',
      claudeResumeId: null,
      flickerFilterEnabled: undefined,
      draft: undefined,
      mcpServers: undefined,
      setAutoCompact: vi.fn(),
      setAutoClear: vi.fn(),
      setNice: vi.fn(),
      setSafeMode: vi.fn(),
      setColor: vi.fn(),
      restoreTokens: vi.fn(),
      restoreContextWindow: vi.fn(),
      ralphTracker: {
        enabled: false,
        autoEnableDisabled: false,
        loopState: { completionPhrase: null },
        startLoop: vi.fn(),
        enable: vi.fn(),
        disableAutoEnable: vi.fn(),
        enableAutoEnable: vi.fn(),
      },
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
  }

  it('restores session color when savedState.color is non-default', () => {
    const session = makeColorSession();
    (server as any)._restoreSessionConfig(session, { color: 'blue' });
    expect(session.setColor).toHaveBeenCalledWith('blue');
  });

  it('does not call setColor when savedState.color is default', () => {
    const session = makeColorSession();
    (server as any)._restoreSessionConfig(session, { color: 'default' });
    expect(session.setColor).not.toHaveBeenCalled();
  });

  it('does not call setColor when savedState.color is missing', () => {
    const session = makeColorSession();
    (server as any)._restoreSessionConfig(session, {});
    expect(session.setColor).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test group 2 (additional) — busy session auto-resume + undefined workingDir guard
// ---------------------------------------------------------------------------

describe('WebServer.restoreMuxSessions() — non-mux auto-resume (busy status)', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    mocks.startInteractiveImpl.mockResolvedValue(undefined);
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.muxSessions = [];
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };

    (getStore() as any).getSession.mockReturnValue(null);
    (getStore() as any).getSessions.mockReturnValue({});
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    server = new WebServer(0, false, true);

    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();

    mocks.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  it('calls startInteractive() for a busy session with a claudeResumeId in claude mode', async () => {
    (getStore() as any).getSessions.mockReturnValue({
      'sess-busy-resume': {
        id: 'sess-busy-resume',
        workingDir: '/tmp/proj',
        mode: 'claude',
        name: 'Busy',
        status: 'busy',
        createdAt: 1000,
        claudeResumeId: 'busy-resume-id',
      },
    });

    await (server as any).restoreMuxSessions();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.startInteractiveImpl).toHaveBeenCalledTimes(1);
  });
});

describe('WebServer.restoreMuxSessions() — non-mux restore pass (undefined workingDir)', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    mocks.startInteractiveImpl.mockResolvedValue(undefined);
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.muxSessions = [];
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };

    (getStore() as any).getSession.mockReturnValue(null);
    (getStore() as any).getSessions.mockReturnValue({});
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    server = new WebServer(0, false, true);

    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  it('skips sessions with undefined workingDir gracefully', async () => {
    // existsSync would throw if called with undefined — this test ensures we never reach it
    mocks.existsSync.mockImplementation((p: unknown) => {
      if (p === undefined || p === null) throw new TypeError('existsSync called with undefined');
      return false;
    });

    (getStore() as any).getSessions.mockReturnValue({
      'sess-no-workdir': {
        id: 'sess-no-workdir',
        // workingDir intentionally omitted — simulates malformed state.json entry
        mode: 'claude',
        name: 'No WorkDir',
        status: 'stopped',
        createdAt: 1000,
      },
    });

    // Must not throw
    await expect((server as any).restoreMuxSessions()).resolves.not.toThrow();

    const sessions: Map<string, unknown> = (server as any).sessions;
    expect(sessions.has('sess-no-workdir')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test group 3 — Mixed scenario: mux + non-mux sessions restored together
// ---------------------------------------------------------------------------

describe('WebServer.restoreMuxSessions() — mixed mux and non-mux restore', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    mocks.startInteractiveImpl.mockResolvedValue(undefined);
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.muxSessions = [];
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };

    (getStore() as any).getSession.mockReturnValue(null);
    (getStore() as any).getSessions.mockReturnValue({});
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    server = new WebServer(0, false, true);

    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();

    mocks.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  it('restores non-mux sessions while also keeping sessions already restored from tmux', async () => {
    const muxSessionId = 'sess-alive-mux';
    const nonMuxSessionId = 'sess-nonmux-crash';

    // One alive mux session
    const muxSession = makeMuxSession({
      sessionId: muxSessionId,
      muxName: 'codeman-alivemux1',
      workingDir: '/tmp/mux-project',
    });
    mocks.muxSessions = [muxSession];
    mocks.reconcileResult = { alive: [muxSessionId], dead: [], discovered: [] };
    mocks.isPaneDeadImpl.mockReturnValue(false);

    // state.json contains both sessions — one with tmux, one without
    (getStore() as any).getSessions.mockReturnValue({
      [muxSessionId]: {
        id: muxSessionId,
        workingDir: '/tmp/mux-project',
        mode: 'claude',
        name: 'Mux Session',
        status: 'idle',
        createdAt: 1000,
      },
      [nonMuxSessionId]: {
        id: nonMuxSessionId,
        workingDir: '/tmp/crash-project',
        mode: 'claude',
        name: 'Crashed Session',
        status: 'stopped',
        createdAt: 2000,
      },
    });

    await (server as any).restoreMuxSessions();

    const sessions: Map<string, unknown> = (server as any).sessions;
    // Both sessions must be present
    expect(sessions.has(muxSessionId)).toBe(true);
    expect(sessions.has(nonMuxSessionId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test group 4 — Transcript watcher for non-mux sessions
// ---------------------------------------------------------------------------

describe('WebServer.restoreMuxSessions() — non-mux transcript watcher', () => {
  let server: WebServer;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionConstructorCalls.length = 0;

    mocks.startInteractiveImpl.mockResolvedValue(undefined);
    mocks.isPaneDeadImpl.mockReturnValue(false);
    mocks.muxSessions = [];
    mocks.reconcileResult = { alive: [], dead: [], discovered: [] };
    mocks.transcriptWatcherInstances = [];

    (getStore() as any).getSession.mockReturnValue(null);
    (getStore() as any).getSessions.mockReturnValue({});
    (getStore() as any).cleanupStaleSessions.mockReturnValue({ removed: [] });

    server = new WebServer(0, false, true);

    (server as any).setupSessionListeners = vi.fn().mockResolvedValue(undefined);
    (server as any).persistSessionState = vi.fn();
    (server as any).getClaudeModeConfig = vi.fn().mockResolvedValue({});
    (server as any).cleanupStaleSessions = vi.fn();
    (server as any)._runStartupOrphanCleanup = vi.fn().mockResolvedValue(undefined);
    (server as any)._persistSessionStateNow = vi.fn();

    mocks.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    try {
      (server as any).mux?.destroy();
    } catch {
      // ignore
    }
  });

  it('starts transcript watcher for non-mux session with claudeResumeId', async () => {
    const resumeId = 'ccccdddd-eeee-ffff-0000-111122223333';
    const workingDir = '/home/user/nonmux-project';

    (getStore() as any).getSessions.mockReturnValue({
      'sess-nonmux-watcher': {
        id: 'sess-nonmux-watcher',
        workingDir,
        mode: 'claude',
        name: 'Non-mux With Resume',
        status: 'idle',
        createdAt: 1000,
        claudeResumeId: resumeId,
      },
    });

    const startWatcherSpy = vi.spyOn(server as any, 'startTranscriptWatcher');

    await (server as any).restoreMuxSessions();

    const escapedDir = workingDir.replace(/\//g, '-');
    const expectedPath = join(homedir(), '.claude', 'projects', escapedDir, `${resumeId}.jsonl`);

    expect(startWatcherSpy).toHaveBeenCalledWith('sess-nonmux-watcher', expectedPath);
  });
});

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
vi.mock('../src/session.js', async () => {
  const { EventEmitter } = await import('node:events');

  class MockSession extends EventEmitter {
    id: string;
    workingDir: string;
    mode: string;
    name: string;
    claudeResumeId: string | null = null;
    ptyProcess = null;
    ralphTracker = {
      enabled: false,
      loopState: { completionPhrase: null },
      startLoop: vi.fn(),
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
    }

    startInteractive = mocks.startInteractiveImpl;
    setAutoCompact = vi.fn();
    setAutoClear = vi.fn();
    restoreTokens = vi.fn();
    getState = vi.fn(function (this: MockSession) {
      return { id: this.id };
    });
    toState = vi.fn(function (this: MockSession) {
      return { id: this.id, workingDir: this.workingDir, status: 'idle', pid: null };
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

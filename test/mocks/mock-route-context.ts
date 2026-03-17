/**
 * Mock context for route handler testing.
 *
 * Satisfies ALL port interfaces (SessionPort, EventPort, RespawnPort,
 * ConfigPort, InfraPort, AuthPort) so any route module can be tested.
 * Override specific methods in individual tests as needed.
 *
 * Uses app.inject() — no real HTTP ports needed.
 */
import { vi } from 'vitest';
import { MockSession, createMockSession } from './mock-session.js';
import type { SessionState } from '../../src/types/session.js';

/**
 * Creates a mock context that satisfies all port interfaces.
 * Pre-populated with one session for convenience.
 */
export function createMockRouteContext(options?: { sessionId?: string }) {
  const sessionId = options?.sessionId ?? 'test-session-1';
  const session = createMockSession(sessionId);
  const sessions = new Map<string, MockSession>();
  sessions.set(sessionId, session);

  return {
    // -- SessionPort --
    sessions,
    addSession: vi.fn((s: MockSession) => {
      sessions.set(s.id, s);
    }),
    cleanupSession: vi.fn(async () => {}),
    clearSession: vi.fn(async (_id: string, _force: boolean) => {
      const archivedSession = createMockSession('archived-session');
      const archivedState: SessionState = {
        ...archivedSession.toState(),
        status: 'archived',
        clearedAt: new Date().toISOString(),
      };
      const newSession = createMockSession('new-child-session');
      const newSessionState: SessionState = {
        ...newSession.toState(),
        parentSessionId: 'archived-session',
      };
      return { archivedSession: archivedState, newSession, newSessionState };
    }),
    setupSessionListeners: vi.fn(async () => {}),
    persistSessionState: vi.fn(),
    persistSessionStateNow: vi.fn(),
    getSessionStateWithRespawn: vi.fn((s: MockSession) => s.toState()),

    // -- EventPort --
    broadcast: vi.fn(),
    sendPushNotifications: vi.fn(),
    batchTerminalData: vi.fn(),
    broadcastSessionStateDebounced: vi.fn(),
    batchTaskUpdate: vi.fn(),
    getSseClientCount: vi.fn(() => 0),

    // -- RespawnPort --
    respawnControllers: new Map(),
    respawnTimers: new Map(),
    setupRespawnListeners: vi.fn(),
    setupTimedRespawn: vi.fn(),
    restoreRespawnController: vi.fn(),
    saveRespawnConfig: vi.fn(),

    // -- ConfigPort --
    store: {
      getConfig: vi.fn(() => ({ ralphEnabled: false, maxConcurrentSessions: 5 })),
      getSessions: vi.fn(() => ({})),
      getSession: vi.fn(),
      setSession: vi.fn(),
      removeSession: vi.fn(),
      getSettings: vi.fn(() => ({})),
      setSettings: vi.fn(),
      getRalphLoopState: vi.fn(() => ({})),
      setRalphLoopState: vi.fn(),
      getTasks: vi.fn(() => ({})),
      save: vi.fn(),
      load: vi.fn(),
      incrementSessionsCreated: vi.fn(),
      setConfig: vi.fn(),
      getAggregateStats: vi.fn(() => ({ totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 })),
      getGlobalStats: vi.fn(() => ({ sessionsCreated: 0 })),
      getDailyStats: vi.fn(() => []),
      cleanupStaleSessions: vi.fn(() => ({ count: 0, cleaned: [] })),
    },
    port: 3000,
    https: false,
    testMode: true,
    serverStartTime: Date.now(),
    getGlobalNiceConfig: vi.fn(async () => undefined),
    getModelConfig: vi.fn(async () => null),
    getClaudeModeConfig: vi.fn(async () => ({})),
    getDefaultClaudeMdPath: vi.fn(async () => undefined),
    getLightState: vi.fn(() => ({ sessions: [], status: 'ok' })),
    getLightSessionsState: vi.fn(() => {
      const result: Record<string, unknown>[] = [];
      for (const s of sessions.values()) {
        // Mirror the server-side filter: archived sessions are excluded from the sidebar list.
        if (s.status === 'archived') continue;
        result.push(s.toState());
      }
      return result;
    }),
    startTranscriptWatcher: vi.fn(),
    stopTranscriptWatcher: vi.fn(),
    getTranscriptPath: vi.fn((_id: string) => null),

    // -- InfraPort --
    mux: {
      createSession: vi.fn(),
      killSession: vi.fn(),
      listSessions: vi.fn(() => []),
      getStats: vi.fn(() => ({})),
      updateSessionName: vi.fn(() => true),
      getSession: vi.fn(() => null),
      clearRespawnConfig: vi.fn(),
      updateRespawnConfig: vi.fn(),
    },
    runSummaryTrackers: new Map(),
    activePlanOrchestrators: new Map(),
    scheduledRuns: new Map(),
    teamWatcher: { getTeams: vi.fn(() => []), getTeamTasks: vi.fn(() => []), hasActiveTeammates: vi.fn(() => false) },
    tunnelManager: null,
    pushStore: null,
    startScheduledRun: vi.fn(),
    stopScheduledRun: vi.fn(),

    // -- AuthPort --
    authSessions: null,
    qrAuthFailures: null,
    // https already declared above in ConfigPort (shared property)

    // Convenience accessors (not part of any port interface)
    _session: session,
    _sessionId: sessionId,
  };
}

export type MockRouteContext = ReturnType<typeof createMockRouteContext>;

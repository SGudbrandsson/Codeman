/**
 * @fileoverview Unit tests for src/orchestrator.ts
 *
 * Tests the orchestrator's pure logic with mocked dependencies.
 * Uses in-memory SQLite for the work-items store (same pattern as store.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, closeDb } from '../src/work-items/db.js';
import { createWorkItem, listWorkItems, updateWorkItem, claimWorkItem, getWorkItem } from '../src/work-items/store.js';
import { Orchestrator, type OrchestratorDeps } from '../src/orchestrator.js';
import type { AgentProfile, SessionState } from '../src/types/session.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(overrides?: Partial<AgentProfile>): AgentProfile {
  return {
    agentId: overrides?.agentId ?? 'agent-1',
    displayName: overrides?.displayName ?? 'Test Agent',
    role: overrides?.role ?? 'backend-developer',
    rolePrompt: overrides?.rolePrompt ?? '',
    capabilities: overrides?.capabilities ?? [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeMockDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  const sessions = new Map();
  const _agents: AgentProfile[] = [];
  const _sessionsState: Record<string, SessionState> = {};

  return {
    store: {
      getConfig: vi.fn(() => ({
        orchestrator: {
          pollIntervalMs: 30000,
          stallThresholdMs: 900000,
          nudgeThresholdMs: 1800000,
          maxConcurrentDispatches: 5,
          mode: 'hybrid' as const,
          matchingThreshold: 3,
        },
      })),
      setConfig: vi.fn(),
      listAgents: vi.fn(() => _agents),
      getAgent: vi.fn((id: string) => _agents.find((a) => a.agentId === id)),
      getState: vi.fn(() => ({ sessions: _sessionsState })),
      getSessions: vi.fn(() => _sessionsState),
    } as unknown as OrchestratorDeps['store'],
    broadcast: vi.fn(),
    addSession: vi.fn(),
    setupSessionListeners: vi.fn(async () => {}),
    persistSessionState: vi.fn(),
    getSessionStateWithRespawn: vi.fn(),
    sessions,
    cleanupSession: vi.fn(async () => {}),
    mux: {
      createSession: vi.fn(),
      killSession: vi.fn(),
    } as unknown as OrchestratorDeps['mux'],
    getGlobalNiceConfig: vi.fn(async () => undefined),
    getModelConfig: vi.fn(async () => null),
    getClaudeModeConfig: vi.fn(async () => ({})),
    sendPushNotifications: vi.fn(),
    ...overrides,
    // expose internal state for test manipulation
    _agents,
    _sessionsState,
  } as OrchestratorDeps & { _agents: AgentProfile[]; _sessionsState: Record<string, SessionState> };
}

beforeEach(() => {
  openDb(':memory:');
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});

// ─── selectAgent ─────────────────────────────────────────────────────────────

describe('Orchestrator.selectAgent', () => {
  it('returns pre-assigned agent with method "explicit"', async () => {
    const deps = makeMockDeps();
    const orch = new Orchestrator(deps);
    const item = createWorkItem({ title: 'Task' });
    // Claim to set assignedAgentId
    claimWorkItem(item.id, 'agent-007');
    const claimed = getWorkItem(item.id)!;

    const result = await orch.selectAgent(claimed);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('agent-007');
    expect(result!.method).toBe('explicit');
  });

  it('returns null when no agents exist', async () => {
    const deps = makeMockDeps();
    const orch = new Orchestrator(deps);
    const item = createWorkItem({ title: 'Task' });

    const result = await orch.selectAgent(item);
    expect(result).toBeNull();
  });

  it('picks clear winner via mechanical scoring', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _agents: AgentProfile[] };
    // Agent whose role keyword "backend" matches the title
    depsExt._agents.push(makeAgent({ agentId: 'backend-1', role: 'backend-developer' }));
    // Agent whose role does NOT match
    depsExt._agents.push(makeAgent({ agentId: 'frontend-1', role: 'frontend-designer' }));

    const orch = new Orchestrator(deps);
    const item = createWorkItem({ title: 'Fix backend API crash' });

    const result = await orch.selectAgent(item);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('backend-1');
    expect(result!.method).toBe('mechanical');
  });

  it('falls back when scoring is ambiguous and LLM unavailable', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _agents: AgentProfile[] };
    // Both agents have roles that do NOT match the title — equal base scores
    depsExt._agents.push(makeAgent({ agentId: 'agent-a', role: 'analyst' }));
    depsExt._agents.push(makeAgent({ agentId: 'agent-b', role: 'planner' }));

    const orch = new Orchestrator(deps);
    const item = createWorkItem({ title: 'Generic task with no keywords' });

    const result = await orch.selectAgent(item);
    // LLM import will fail (no SDK), so should fall back to first idle agent
    expect(result).not.toBeNull();
    expect(result!.method).toBe('fallback');
  });
});

// ─── scoreAgent ──────────────────────────────────────────────────────────────

describe('Orchestrator.scoreAgent (via selectAgent)', () => {
  it('keyword match gives +3, base gives +1 = score 4', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _agents: AgentProfile[] };
    const agent = makeAgent({ agentId: 'dev-1', role: 'backend-developer' });
    depsExt._agents.push(agent);

    const orch = new Orchestrator(deps);
    // Access scoreAgent via prototype (it's private, but we can test through selectAgent behavior)
    // Agent with keyword match should score 4 (1 base + 3 keyword)
    // With only one agent and score > 0, it should win mechanically
    const item = createWorkItem({ title: 'backend service fix' });
    const result = await orch.selectAgent(item);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('mechanical');
  });

  it('MCP capability match gives +2', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _agents: AgentProfile[] };
    const agent = makeAgent({
      agentId: 'cap-agent',
      role: 'generalist',
      capabilities: [{ name: 'docker', enabled: true }],
    });
    depsExt._agents.push(agent);

    const orch = new Orchestrator(deps);
    const item = createWorkItem({ title: 'Fix docker container issue' });
    const result = await orch.selectAgent(item);
    expect(result).not.toBeNull();
    // Score = 1 (base) + 2 (MCP match) = 3, single agent with score > 0 wins mechanically
    expect(result!.method).toBe('mechanical');
  });

  it('busy agent gets -5 penalty', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _agents: AgentProfile[] };

    // Busy agent (has keyword match but will be penalized)
    depsExt._agents.push(makeAgent({ agentId: 'busy-1', role: 'backend-developer' }));
    // Idle agent (no keyword match)
    depsExt._agents.push(makeAgent({ agentId: 'idle-1', role: 'generalist' }));

    // Create an in_progress item assigned to busy-1
    const busyItem = createWorkItem({ title: 'existing task' });
    claimWorkItem(busyItem.id, 'busy-1');
    updateWorkItem(busyItem.id, { status: 'in_progress' });

    const orch = new Orchestrator(deps);
    const item = createWorkItem({ title: 'backend API task' });

    const result = await orch.selectAgent(item);
    expect(result).not.toBeNull();
    // busy-1: 1 + 3 (keyword) - 5 (busy) = -1
    // idle-1: 1 (base only)
    // idle-1 should win with score 1 vs -1, gap = 2 which is < matchingThreshold(3)
    // So it should go to LLM fallback -> fallback (first idle)
    expect(result!.agentId).toBe('idle-1');
  });
});

// ─── dispatchRecovery ────────────────────────────────────────────────────────

describe('Orchestrator.dispatchRecovery', () => {
  it('reverts stuck assigned items (no worktreePath, >5min) to queued', async () => {
    const deps = makeMockDeps();
    const orch = new Orchestrator(deps);

    const item = createWorkItem({ title: 'Stuck item' });
    claimWorkItem(item.id, 'agent-1');

    // Backdate assignedAt to 10 minutes ago
    const db = openDb(':memory:');
    db.prepare(`UPDATE work_items SET assigned_at = datetime('now', '-10 minutes') WHERE id = ?`).run(item.id);

    await orch.dispatchRecovery();

    const recovered = getWorkItem(item.id);
    expect(recovered!.status).toBe('queued');
    expect(recovered!.assignedAgentId).toBeNull();
  });

  it('leaves freshly assigned items alone', async () => {
    const deps = makeMockDeps();
    const orch = new Orchestrator(deps);

    const item = createWorkItem({ title: 'Fresh item' });
    claimWorkItem(item.id, 'agent-1');

    await orch.dispatchRecovery();

    const stillAssigned = getWorkItem(item.id);
    expect(stillAssigned!.status).toBe('assigned');
    expect(stillAssigned!.assignedAgentId).toBe('agent-1');
  });

  it('leaves assigned items with worktreePath alone even if old', async () => {
    const deps = makeMockDeps();
    const orch = new Orchestrator(deps);

    const item = createWorkItem({ title: 'Has worktree' });
    claimWorkItem(item.id, 'agent-1');

    const db = openDb(':memory:');
    db.prepare(
      `UPDATE work_items SET assigned_at = datetime('now', '-10 minutes'), worktree_path = '/tmp/wt' WHERE id = ?`
    ).run(item.id);

    await orch.dispatchRecovery();

    const still = getWorkItem(item.id);
    expect(still!.status).toBe('assigned');
  });
});

// ─── tick ────────────────────────────────────────────────────────────────────

describe('Orchestrator.tick', () => {
  it('skips items without caseId', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _agents: AgentProfile[] };
    depsExt._agents.push(makeAgent({ agentId: 'agent-1' }));

    const orch = new Orchestrator(deps);

    // Create item WITHOUT caseId
    createWorkItem({ title: 'No case task' });

    await orch.tick();

    // No dispatch should have occurred (broadcast not called with dispatch event)
    const broadcastCalls = (deps.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    const dispatchCalls = broadcastCalls.filter((c: unknown[]) => c[0] === 'orchestrator:dispatch');
    expect(dispatchCalls).toHaveLength(0);
  });

  it('respects maxConcurrentDispatches capacity', async () => {
    const deps = makeMockDeps();
    const orch = new Orchestrator(deps);

    // Fill capacity: create 5 in_progress items
    for (let i = 0; i < 5; i++) {
      const item = createWorkItem({ title: `Active ${i}`, caseId: 'test-case' });
      claimWorkItem(item.id, 'agent-1');
      updateWorkItem(item.id, { status: 'in_progress' });
    }

    // Create a queued item with caseId
    createWorkItem({ title: 'Queued task', caseId: 'test-case' });

    await orch.tick();

    // Should not dispatch because capacity is full
    const broadcastCalls = (deps.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    const dispatchCalls = broadcastCalls.filter((c: unknown[]) => c[0] === 'orchestrator:dispatch');
    expect(dispatchCalls).toHaveLength(0);
  });
});

// ─── handleSessionCompletion ─────────────────────────────────────────────────

describe('Orchestrator.handleSessionCompletion', () => {
  it('ignores sessions without currentWorkItemId', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };
    depsExt._sessionsState['sess-1'] = { id: 'sess-1' } as SessionState;

    const orch = new Orchestrator(deps);
    await orch.handleSessionCompletion('sess-1');

    // No work item updates should have occurred
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it('ignores non-in_progress work items', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'Done item' });
    updateWorkItem(item.id, { status: 'done' });

    depsExt._sessionsState['sess-1'] = {
      id: 'sess-1',
      currentWorkItemId: item.id,
    } as SessionState;

    const orch = new Orchestrator(deps);
    await orch.handleSessionCompletion('sess-1');

    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it('leaves item in_progress when no commits found (git fails)', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'Active item' });
    claimWorkItem(item.id, 'agent-1');
    updateWorkItem(item.id, {
      status: 'in_progress',
      worktreePath: '/nonexistent/path',
      branchName: 'feat/test',
    });

    depsExt._sessionsState['sess-1'] = {
      id: 'sess-1',
      currentWorkItemId: item.id,
    } as SessionState;

    const orch = new Orchestrator(deps);
    await orch.handleSessionCompletion('sess-1');

    // No status change broadcast (git log will fail on nonexistent path)
    const updated = getWorkItem(item.id);
    expect(updated!.status).toBe('in_progress');
  });
});

// ─── checkStalls ─────────────────────────────────────────────────────────────

describe('Orchestrator.checkStalls', () => {
  it('marks item blocked when session is missing', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'Orphaned' });
    claimWorkItem(item.id, 'agent-1');
    updateWorkItem(item.id, {
      status: 'in_progress',
      worktreePath: '/tmp/wt',
    });

    // No session state for this item
    const orch = new Orchestrator(deps);
    await orch.checkStalls();

    const updated = getWorkItem(item.id);
    expect(updated!.status).toBe('blocked');
  });

  it('marks item blocked when session is stopped', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'Stopped session item' });
    claimWorkItem(item.id, 'agent-1');
    updateWorkItem(item.id, {
      status: 'in_progress',
      worktreePath: '/tmp/wt',
    });

    depsExt._sessionsState['sess-1'] = {
      id: 'sess-1',
      currentWorkItemId: item.id,
      status: 'stopped',
      lastActivityAt: Date.now(),
    } as unknown as SessionState;

    const orch = new Orchestrator(deps);
    await orch.checkStalls();

    const updated = getWorkItem(item.id);
    expect(updated!.status).toBe('blocked');
  });

  it('marks item blocked when session is in error state', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'Error session item' });
    claimWorkItem(item.id, 'agent-1');
    updateWorkItem(item.id, {
      status: 'in_progress',
      worktreePath: '/tmp/wt',
    });

    depsExt._sessionsState['sess-1'] = {
      id: 'sess-1',
      currentWorkItemId: item.id,
      status: 'error',
      lastActivityAt: Date.now(),
    } as unknown as SessionState;

    const orch = new Orchestrator(deps);
    await orch.checkStalls();

    const updated = getWorkItem(item.id);
    expect(updated!.status).toBe('blocked');
  });

  it('sends nudge to idle session past stall threshold', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'Stalled item' });
    claimWorkItem(item.id, 'agent-1');
    updateWorkItem(item.id, {
      status: 'in_progress',
      worktreePath: '/tmp/wt',
    });

    const mockSession = { sendInput: vi.fn() };
    deps.sessions.set('sess-1', mockSession as never);

    depsExt._sessionsState['sess-1'] = {
      id: 'sess-1',
      currentWorkItemId: item.id,
      status: 'running',
      lastActivityAt: Date.now() - 1_000_000, // > stallThresholdMs (900000)
    } as unknown as SessionState;

    const orch = new Orchestrator(deps);
    await orch.checkStalls();

    // Session should receive a nudge
    expect(mockSession.sendInput).toHaveBeenCalledTimes(1);
    // Item should still be in_progress (not blocked yet)
    const updated = getWorkItem(item.id);
    expect(updated!.status).toBe('in_progress');
  });

  it('blocks item after nudge when still idle past nudge threshold', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'Blocked after nudge' });
    claimWorkItem(item.id, 'agent-1');
    updateWorkItem(item.id, {
      status: 'in_progress',
      worktreePath: '/tmp/wt',
    });

    const mockSession = { sendInput: vi.fn() };
    deps.sessions.set('sess-1', mockSession as never);

    depsExt._sessionsState['sess-1'] = {
      id: 'sess-1',
      currentWorkItemId: item.id,
      status: 'running',
      lastActivityAt: Date.now() - 2_000_000, // > nudgeThresholdMs (1800000)
    } as unknown as SessionState;

    const orch = new Orchestrator(deps);

    // First check: sends nudge
    await orch.checkStalls();
    expect(mockSession.sendInput).toHaveBeenCalledTimes(1);

    // Second check: past nudge threshold, should block
    await orch.checkStalls();
    const updated = getWorkItem(item.id);
    expect(updated!.status).toBe('blocked');
  });

  it('auto-detects TASK.md done status and triggers completion flow', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'Auto-detect done' });
    claimWorkItem(item.id, 'agent-1');

    // Create a temp directory with a TASK.md containing status: done
    const tmpDir = (await import('node:os')).tmpdir();
    const worktreePath = `${tmpDir}/test-orchestrator-${item.id}`;
    const fsP = (await import('node:fs/promises')).default;
    await fsP.mkdir(worktreePath, { recursive: true });
    await fsP.writeFile(`${worktreePath}/TASK.md`, '---\ntype: feature\nstatus: done\n---\n# Test\n');

    updateWorkItem(item.id, {
      status: 'in_progress',
      worktreePath,
    });

    depsExt._sessionsState['sess-1'] = {
      id: 'sess-1',
      currentWorkItemId: item.id,
      status: 'running',
      name: 'test-session',
      lastActivityAt: Date.now(),
    } as unknown as SessionState;

    const orch = new Orchestrator(deps);
    await orch.checkStalls();

    // Work item should transition to review (synchronous in checkStalls)
    const updated = getWorkItem(item.id);
    expect(updated!.status).toBe('review');

    // Status changed event should be broadcast synchronously
    const broadcastCalls = (deps.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    const statusCalls = broadcastCalls.filter((c: unknown[]) => c[0] === 'workItem:statusChanged');
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    expect(statusCalls[0][1]).toMatchObject({ id: item.id, status: 'review' });

    // Note: handleCompletionFlow is fire-and-forget — tested separately in its own describe block

    // Cleanup
    await fsP.rm(worktreePath, { recursive: true, force: true });
  });

  it('auto-detects TASK.md failed status and marks item blocked', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'Auto-detect failed' });
    claimWorkItem(item.id, 'agent-1');

    const tmpDir = (await import('node:os')).tmpdir();
    const worktreePath = `${tmpDir}/test-orchestrator-failed-${item.id}`;
    const fsP = (await import('node:fs/promises')).default;
    await fsP.mkdir(worktreePath, { recursive: true });
    await fsP.writeFile(`${worktreePath}/TASK.md`, '---\ntype: feature\nstatus: failed\n---\n# Test\n');

    updateWorkItem(item.id, {
      status: 'in_progress',
      worktreePath,
    });

    depsExt._sessionsState['sess-1'] = {
      id: 'sess-1',
      currentWorkItemId: item.id,
      status: 'running',
      lastActivityAt: Date.now(),
    } as unknown as SessionState;

    const orch = new Orchestrator(deps);
    await orch.checkStalls();

    const updated = getWorkItem(item.id);
    expect(updated!.status).toBe('blocked');

    await fsP.rm(worktreePath, { recursive: true, force: true });
  });

  it('skips TASK.md detection when file is missing', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'No TASK.md' });
    claimWorkItem(item.id, 'agent-1');
    updateWorkItem(item.id, {
      status: 'in_progress',
      worktreePath: '/nonexistent/path/no-task-md',
    });

    // Session missing — should fall through to normal stall logic (marks blocked)
    const orch = new Orchestrator(deps);
    await orch.checkStalls();

    const updated = getWorkItem(item.id);
    expect(updated!.status).toBe('blocked');
  });
});

// ─── handleCompletionFlow ────────────────────────────────────────────────────

describe('Orchestrator.handleCompletionFlow', () => {
  it('broadcasts completion event and sends push notification', async () => {
    const deps = makeMockDeps();
    const depsExt = deps as OrchestratorDeps & { _sessionsState: Record<string, Partial<SessionState>> };

    const item = createWorkItem({ title: 'Completed item' });
    claimWorkItem(item.id, 'agent-1');
    updateWorkItem(item.id, {
      status: 'review',
      worktreePath: '/nonexistent/no-worktree',
      branchName: 'feat/test',
    });

    depsExt._sessionsState['sess-1'] = {
      id: 'sess-1',
      currentWorkItemId: item.id,
      name: 'test-session',
    } as unknown as SessionState;

    const orch = new Orchestrator(deps);
    await orch.handleCompletionFlow(item.id);

    // Should broadcast orchestrator:completion
    const broadcastCalls = (deps.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    const completionCalls = broadcastCalls.filter((c: unknown[]) => c[0] === 'orchestrator:completion');
    expect(completionCalls).toHaveLength(1);
    expect(completionCalls[0][1]).toMatchObject({
      workItemId: item.id,
      workItemTitle: 'Completed item',
      sessionName: 'test-session',
    });

    // Should send push notification
    expect(deps.sendPushNotifications).toHaveBeenCalledWith(
      'orchestrator:completion',
      expect.objectContaining({ workItemId: item.id })
    );
  });

  it('is idempotent — second call is a no-op', async () => {
    const deps = makeMockDeps();

    const item = createWorkItem({ title: 'Idempotent test' });
    claimWorkItem(item.id, 'agent-1');
    updateWorkItem(item.id, { status: 'review' });

    const orch = new Orchestrator(deps);
    await orch.handleCompletionFlow(item.id);
    await orch.handleCompletionFlow(item.id);

    // Completion event should only be broadcast once
    const broadcastCalls = (deps.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    const completionCalls = broadcastCalls.filter((c: unknown[]) => c[0] === 'orchestrator:completion');
    expect(completionCalls).toHaveLength(1);
  });

  it('skips merge-prep when worktree path does not exist', async () => {
    const deps = makeMockDeps();

    const item = createWorkItem({ title: 'No worktree' });
    claimWorkItem(item.id, 'agent-1');
    updateWorkItem(item.id, {
      status: 'review',
      worktreePath: '/nonexistent/path',
    });

    const orch = new Orchestrator(deps);
    await orch.handleCompletionFlow(item.id);

    // Should still broadcast completion, just without merge-prep result
    const broadcastCalls = (deps.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    const completionCalls = broadcastCalls.filter((c: unknown[]) => c[0] === 'orchestrator:completion');
    expect(completionCalls).toHaveLength(1);
    expect(completionCalls[0][1]).toMatchObject({
      mergePrepPassed: null,
    });

    // No merge-prep started event
    const mergePrepCalls = broadcastCalls.filter((c: unknown[]) => c[0] === 'orchestrator:mergePrepStarted');
    expect(mergePrepCalls).toHaveLength(0);
  });
});

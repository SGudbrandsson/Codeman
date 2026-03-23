/**
 * @fileoverview Tests for vault capture branch in hook-event-routes
 * and vault briefing injection in session-routes.
 *
 * GAP 6 — hook-event-routes vault capture:
 *   - stop hook with agentProfile: capture() is called (fire-and-forget)
 *   - stop hook without agentProfile: capture() is NOT called
 *   - content extraction priority (summary > transcript_summary > terminal buffer)
 *   - notesSinceConsolidation incremented via store.setAgent after capture
 *
 * GAP 7 — session-routes vault briefing injection:
 *   - /api/sessions/:id/interactive with agentProfile + worktreePath → injectVaultBriefing called
 *   - /api/sessions/:id/interactive without agentProfile → injectVaultBriefing NOT called
 *   - /api/sessions/:id/interactive without worktreePath → injectVaultBriefing NOT called
 *   - errors from injectVaultBriefing are swallowed (session still starts)
 *
 * Uses vi.mock to intercept vault module calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RouteTestHarness } from './_route-test-utils.js';

// ── Mock the vault module before any imports that use it ──────────────────────

const mockCapture = vi.fn().mockResolvedValue({
  filename: '2026-03-23T14:00:00Z-abcd1234.md',
  capturedAt: '2026-03-23T14:00:00Z',
  sessionId: 'test-session-1',
  workItemId: null,
  content: '',
  indexed: false,
});

const mockInjectVaultBriefing = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/vault/index.js', () => ({
  capture: mockCapture,
  query: vi.fn().mockResolvedValue([]),
  injectVaultBriefing: mockInjectVaultBriefing,
}));

// Now import after the mock is set up
const { createRouteTestHarness } = await import('./_route-test-utils.js');
const { registerHookEventRoutes } = await import('../../src/web/routes/hook-event-routes.js');
const { registerSessionRoutes } = await import('../../src/web/routes/session-routes.js');

describe('vault capture in hook-event-routes', () => {
  let harness: RouteTestHarness;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = join(tmpdir(), `vault-hook-test-${Date.now()}`);
    mkdirSync(vaultPath, { recursive: true });

    harness = await createRouteTestHarness(registerHookEventRoutes);
    mockCapture.mockClear();
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(vaultPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // ── stop hook without agentProfile ─────────────────────────────────────────

  it('does NOT call capture when stop hook fires for a session without agentProfile', async () => {
    // Default session in mock has no agentProfile in getState().sessions
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: {
        event: 'stop',
        sessionId: harness.ctx._sessionId,
        data: { summary: 'session completed task' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);

    // capture should NOT have been called — no agentProfile
    await new Promise((r) => setTimeout(r, 20)); // wait for any async
    expect(mockCapture).not.toHaveBeenCalled();
  });

  // ── stop hook with agentProfile ────────────────────────────────────────────

  it('calls capture fire-and-forget when stop hook fires for a session with agentProfile', async () => {
    // Inject session state with agentProfile into the store mock
    const sessionState = {
      agentProfile: {
        agentId: 'agent-hook-1',
        vaultPath,
      },
      currentWorkItemId: 'wi-42',
    };
    // Set sessions in getState()
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: {
        [harness.ctx._sessionId]: sessionState,
      },
      agents: {},
    });
    // Also set agent in store for the notesSinceConsolidation increment
    harness.ctx.store.setAgent({
      agentId: 'agent-hook-1',
      role: 'implementer',
      displayName: 'Hook Agent',
      vaultPath,
      capabilities: [],
      notesSinceConsolidation: 3,
      decay: { notesTtlDays: 90, patternsTtlDays: 180 },
      createdAt: new Date().toISOString(),
    });

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: {
        event: 'stop',
        sessionId: harness.ctx._sessionId,
        data: { summary: 'completed the authentication refactor' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);

    // Wait for the fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(mockCapture).toHaveBeenCalledWith(
      'agent-hook-1',
      vaultPath,
      expect.objectContaining({
        sessionId: harness.ctx._sessionId,
        workItemId: 'wi-42',
        content: 'completed the authentication refactor',
      })
    );
  });

  // ── content extraction priority ────────────────────────────────────────────

  it('prefers summary field over transcript_summary for capture content', async () => {
    const sessionState = {
      agentProfile: { agentId: 'agent-prio', vaultPath },
      currentWorkItemId: null,
    };
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: { [harness.ctx._sessionId]: sessionState },
      agents: {},
    });

    await harness.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: {
        event: 'stop',
        sessionId: harness.ctx._sessionId,
        data: {
          summary: 'primary summary text',
          transcript_summary: 'fallback transcript text',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    const call = mockCapture.mock.calls[0];
    expect(call?.[2].content).toBe('primary summary text');
  });

  it('falls back to transcript_summary when summary is absent', async () => {
    const sessionState = {
      agentProfile: { agentId: 'agent-ts', vaultPath },
      currentWorkItemId: null,
    };
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: { [harness.ctx._sessionId]: sessionState },
      agents: {},
    });

    await harness.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: {
        event: 'stop',
        sessionId: harness.ctx._sessionId,
        data: { transcript_summary: 'transcript fallback content' },
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    const call = mockCapture.mock.calls[0];
    expect(call?.[2].content).toBe('transcript fallback content');
  });

  it('falls back to terminal buffer when no summary fields in data', async () => {
    const sessionState = {
      agentProfile: { agentId: 'agent-buf', vaultPath },
      currentWorkItemId: null,
    };
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: { [harness.ctx._sessionId]: sessionState },
      agents: {},
    });
    // Set terminal buffer on the mock session
    harness.ctx._session.terminalBuffer = 'terminal buffer output content here';

    await harness.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: {
        event: 'stop',
        sessionId: harness.ctx._sessionId,
        data: { unrelated_field: 'no summary' },
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    const call = mockCapture.mock.calls[0];
    expect(call?.[2].content).toContain('terminal buffer output');
  });

  it('does NOT call capture when content is empty after extraction', async () => {
    const sessionState = {
      agentProfile: { agentId: 'agent-empty', vaultPath },
      currentWorkItemId: null,
    };
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: { [harness.ctx._sessionId]: sessionState },
      agents: {},
    });
    harness.ctx._session.terminalBuffer = '   '; // whitespace only

    await harness.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: {
        event: 'stop',
        sessionId: harness.ctx._sessionId,
        data: {},
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('non-stop events do not trigger vault capture', async () => {
    const sessionState = {
      agentProfile: { agentId: 'agent-nonstop', vaultPath },
      currentWorkItemId: null,
    };
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: { [harness.ctx._sessionId]: sessionState },
      agents: {},
    });

    await harness.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: {
        event: 'idle_prompt',
        sessionId: harness.ctx._sessionId,
        data: { summary: 'should not capture' },
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(mockCapture).not.toHaveBeenCalled();
  });

  // ── notesSinceConsolidation increment ──────────────────────────────────────

  it('increments notesSinceConsolidation via store.setAgent after capture', async () => {
    const sessionState = {
      agentProfile: { agentId: 'agent-nsync', vaultPath },
      currentWorkItemId: null,
    };
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: { [harness.ctx._sessionId]: sessionState },
      agents: {},
    });
    harness.ctx.store.setAgent({
      agentId: 'agent-nsync',
      role: 'implementer',
      displayName: 'NST Agent',
      vaultPath,
      capabilities: [],
      notesSinceConsolidation: 7,
      decay: { notesTtlDays: 90, patternsTtlDays: 180 },
      createdAt: new Date().toISOString(),
    });

    await harness.app.inject({
      method: 'POST',
      url: '/api/hook-event',
      payload: {
        event: 'stop',
        sessionId: harness.ctx._sessionId,
        data: { summary: 'increment test content' },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    // After capture resolves, store.setAgent should have been called with
    // notesSinceConsolidation === 8 (original 7 + 1)
    const setAgentCalls = (harness.ctx.store.setAgent as ReturnType<typeof vi.fn>).mock.calls;
    const incrementCall = setAgentCalls.find(
      (c) => c[0]?.agentId === 'agent-nsync' && c[0]?.notesSinceConsolidation === 8
    );
    expect(incrementCall).toBeDefined();
  });
});

// ── GAP 7: vault briefing injection in session-routes ─────────────────────────

describe('vault briefing injection in session-routes', () => {
  let harness: RouteTestHarness;
  let workDir: string;

  beforeEach(async () => {
    workDir = join(tmpdir(), `vault-session-test-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });

    harness = await createRouteTestHarness(registerSessionRoutes);
    mockInjectVaultBriefing.mockClear();
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(workDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // ── no agentProfile → no injection ────────────────────────────────────────

  it('does NOT call injectVaultBriefing when session has no agentProfile', async () => {
    // Default mock session state has no agentProfile
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: {
        [harness.ctx._sessionId]: {
          id: harness.ctx._sessionId,
          worktreePath: workDir,
          // no agentProfile
        },
      },
      agents: {},
    });

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(mockInjectVaultBriefing).not.toHaveBeenCalled();
  });

  // ── no worktreePath → no injection ────────────────────────────────────────

  it('does NOT call injectVaultBriefing when session has agentProfile but no worktreePath', async () => {
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: {
        [harness.ctx._sessionId]: {
          id: harness.ctx._sessionId,
          agentProfile: {
            agentId: 'agent-nowt',
            vaultPath: '/tmp/vault-nowt',
          },
          // no worktreePath
        },
      },
      agents: {},
    });

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(mockInjectVaultBriefing).not.toHaveBeenCalled();
  });

  // ── with agentProfile + worktreePath → injection called ───────────────────

  it('calls injectVaultBriefing with correct sessionState and CLAUDE.md path', async () => {
    const sessionState = {
      id: harness.ctx._sessionId,
      agentProfile: {
        agentId: 'agent-inject-sess',
        vaultPath: '/tmp/vault-inject',
      },
      worktreePath: workDir,
    };
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: { [harness.ctx._sessionId]: sessionState },
      agents: {},
    });

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);

    expect(mockInjectVaultBriefing).toHaveBeenCalledWith(sessionState, join(workDir, 'CLAUDE.md'));
  });

  // ── briefing error is swallowed ────────────────────────────────────────────

  it('swallows errors from injectVaultBriefing and still starts the session', async () => {
    mockInjectVaultBriefing.mockRejectedValueOnce(new Error('vault read error'));

    const sessionState = {
      id: harness.ctx._sessionId,
      agentProfile: {
        agentId: 'agent-err',
        vaultPath: '/tmp/vault-err',
      },
      worktreePath: workDir,
    };
    (harness.ctx.store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      sessions: { [harness.ctx._sessionId]: sessionState },
      agents: {},
    });

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
    });
    // Session should still start successfully even when briefing fails
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
  });
});

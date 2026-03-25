/**
 * @fileoverview Tests for command panel routes (GET /api/command/status,
 * POST /api/command, POST /api/command/confirm).
 *
 * Mocks the dynamic @anthropic-ai/sdk import and work-items module.
 * Uses app.inject() — no real HTTP ports needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock @anthropic-ai/sdk (hoisted by Vitest) ──────────────────────────────
// The route uses `await import('@anthropic-ai/sdk' as string)` — vi.mock still
// intercepts this. We expose a mutable `mockCreate` so tests can control the
// LLM response per test case.
const mockCreate = vi.fn<[Record<string, unknown>], unknown>();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

// ── Mock work-items module (hoisted by Vitest) ───────────────────────────────
vi.mock('../../src/work-items/index.js', () => ({
  listWorkItems: vi.fn(() => []),
  createWorkItem: vi.fn(() => ({ id: 'wi-1', title: 'Test item' })),
}));

// ── Mock the orchestrator (used by orchestrator_status tool) ─────────────────
vi.mock('../../src/orchestrator.js', () => ({
  getOrchestrator: vi.fn(() => null),
}));

import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerCommandPanelRoutes } from '../../src/web/routes/command-panel-routes.js';

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** A simple text response from the LLM. */
function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  };
}

/** A tool_use response from the LLM. */
function toolUseResponse(name: string, input: Record<string, unknown>, id = 'toolu_01') {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
  };
}

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe('GET /api/command/status', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerCommandPanelRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('returns available:true when SDK importable and ANTHROPIC_API_KEY is set', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const res = await harness.app.inject({ method: 'GET', url: '/api/command/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it('returns available:false when ANTHROPIC_API_KEY is not set', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await harness.app.inject({ method: 'GET', url: '/api/command/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(false);
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});

describe('POST /api/command', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerCommandPanelRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('returns 400 when message is missing', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/message/i);
  });

  it('returns 400 when message is empty string', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: '   ' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/message/i);
  });

  it('creates a new conversation and returns conversationId', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('Hello!'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'hello' },
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.conversationId).toBeDefined();
    expect(typeof body.conversationId).toBe('string');
    expect(body.response).toBe('Hello!');
  });

  it('reuses existing conversation when conversationId provided', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('First'));

    // First message — create conversation
    const res1 = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'hello' },
    });
    const body1 = JSON.parse(res1.body);
    const convId = body1.conversationId;

    // Second message — reuse conversation
    mockCreate.mockResolvedValueOnce(textResponse('Second'));
    const res2 = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'another', conversationId: convId },
    });
    const body2 = JSON.parse(res2.body);
    expect(body2.conversationId).toBe(convId);

    // The second call should have received conversation history (2 user + 1 assistant messages)
    const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0] as { messages: unknown[] };
    expect(lastCall.messages.length).toBeGreaterThan(1);
  });

  it('executes non-destructive tool (list_sessions) immediately', async () => {
    // First call returns tool_use, second call (follow-up) returns text summary
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('list_sessions', {}))
      .mockResolvedValueOnce(textResponse('Here are your sessions.'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'list my sessions' },
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.actions).toBeDefined();
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0].tool).toBe('list_sessions');
    expect(body.actions[0].success).toBe(true);
    // Should have session data from the mock context (1 session)
    expect(body.actions[0].result).toBeInstanceOf(Array);
    expect(body.actions[0].result.length).toBe(1);
    expect(body.response).toBe('Here are your sessions.');
  });

  it('executes rename_session tool and broadcasts update', async () => {
    mockCreate
      .mockResolvedValueOnce(
        toolUseResponse('rename_session', {
          session_id: harness.ctx._sessionId,
          name: 'New Name',
        })
      )
      .mockResolvedValueOnce(textResponse('Renamed.'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'rename to New Name' },
    });

    const body = JSON.parse(res.body);
    expect(body.actions[0].tool).toBe('rename_session');
    expect(body.actions[0].success).toBe(true);
    expect(body.actions[0].result).toEqual({ id: harness.ctx._sessionId, name: 'New Name' });
    expect(harness.ctx.mux.updateSessionName).toHaveBeenCalledWith(harness.ctx._sessionId, 'New Name');
    expect(harness.ctx.persistSessionState).toHaveBeenCalled();
    expect(harness.ctx.broadcast).toHaveBeenCalled();
  });

  it('returns needsConfirmation for destructive tool (delete_session)', async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse('delete_session', { session_id: 'test-session-1' }));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'delete that session' },
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.needsConfirmation).toBeDefined();
    expect(body.needsConfirmation.action).toBe('delete_session');
    expect(body.needsConfirmation.confirmId).toBeDefined();
    expect(body.actions).toBeUndefined();
    // cleanupSession should NOT have been called
    expect(harness.ctx.cleanupSession).not.toHaveBeenCalled();
  });

  it('returns needsConfirmation for send_input (destructive)', async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse('send_input', { session_id: 'test-session-1', text: 'exit' }));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'send exit to the session' },
    });

    const body = JSON.parse(res.body);
    expect(body.needsConfirmation).toBeDefined();
    expect(body.needsConfirmation.action).toBe('send_input');
  });

  it('returns needsConfirmation for orchestrator_toggle (destructive)', async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse('orchestrator_toggle', { case_id: 'case-1', enabled: false }));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'disable orchestrator for case-1' },
    });

    const body = JSON.parse(res.body);
    expect(body.needsConfirmation).toBeDefined();
    expect(body.needsConfirmation.action).toBe('orchestrator_toggle');
  });

  it('executes get_system_status tool', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('get_system_status', {}))
      .mockResolvedValueOnce(textResponse('System is up.'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'system status' },
    });

    const body = JSON.parse(res.body);
    expect(body.actions[0].tool).toBe('get_system_status');
    expect(body.actions[0].success).toBe(true);
    expect(body.actions[0].result.sessionCount).toBe(1);
    expect(body.actions[0].result.testMode).toBe(true);
    expect(typeof body.actions[0].result.uptime).toBe('string');
  });

  it('executes get_session_details for known session', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('get_session_details', { session_id: harness.ctx._sessionId }))
      .mockResolvedValueOnce(textResponse('Details.'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'session details' },
    });

    const body = JSON.parse(res.body);
    expect(body.actions[0].tool).toBe('get_session_details');
    expect(body.actions[0].success).toBe(true);
    expect(body.actions[0].result.id).toBe(harness.ctx._sessionId);
  });

  it('handles get_session_details for unknown session', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('get_session_details', { session_id: 'nonexistent' }))
      .mockResolvedValueOnce(textResponse('Not found.'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'details for nonexistent' },
    });

    const body = JSON.parse(res.body);
    expect(body.actions[0].tool).toBe('get_session_details');
    expect(body.actions[0].success).toBe(false);
    expect(body.actions[0].error).toMatch(/not found/i);
  });

  it('handles LLM API error gracefully', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API rate limit'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'hello' },
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/API rate limit/);
  });
});

describe('POST /api/command/confirm', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerCommandPanelRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('returns 400 when confirmId is missing', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command/confirm',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/confirmId/i);
  });

  it('returns 404 for unknown confirmId', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command/confirm',
      payload: { confirmId: 'nonexistent-id' },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/expired|not found/i);
  });

  it('executes pending destructive action on confirm', async () => {
    // Step 1: trigger a destructive tool to get a confirmId
    mockCreate.mockResolvedValueOnce(toolUseResponse('delete_session', { session_id: harness.ctx._sessionId }));

    const cmdRes = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'delete session' },
    });
    const cmdBody = JSON.parse(cmdRes.body);
    expect(cmdBody.needsConfirmation).toBeDefined();
    const confirmId = cmdBody.needsConfirmation.confirmId;
    const conversationId = cmdBody.conversationId;

    // Step 2: confirm it
    const confirmRes = await harness.app.inject({
      method: 'POST',
      url: '/api/command/confirm',
      payload: { confirmId, conversationId },
    });

    expect(confirmRes.statusCode).toBe(200);
    const confirmBody = JSON.parse(confirmRes.body);
    expect(confirmBody.action.tool).toBe('delete_session');
    expect(confirmBody.action.success).toBe(true);
    expect(harness.ctx.cleanupSession).toHaveBeenCalledWith(harness.ctx._sessionId);
    expect(confirmBody.conversationId).toBeDefined();
  });

  it('cannot reuse the same confirmId twice', async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse('delete_session', { session_id: harness.ctx._sessionId }));

    const cmdRes = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'delete session' },
    });
    const cmdBody = JSON.parse(cmdRes.body);
    const confirmId = cmdBody.needsConfirmation.confirmId;

    // First confirm succeeds
    await harness.app.inject({
      method: 'POST',
      url: '/api/command/confirm',
      payload: { confirmId, conversationId: cmdBody.conversationId },
    });

    // Second confirm fails (already consumed)
    const res2 = await harness.app.inject({
      method: 'POST',
      url: '/api/command/confirm',
      payload: { confirmId, conversationId: cmdBody.conversationId },
    });
    expect(res2.statusCode).toBe(404);
  });
});

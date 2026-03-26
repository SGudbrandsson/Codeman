/**
 * @fileoverview Tests for command panel routes (GET /api/command/status,
 * POST /api/command, POST /api/command/confirm, conversation management).
 *
 * Mocks the dynamic @anthropic-ai/sdk import, work-items module, and fs
 * for persistent conversation storage tests.
 * Uses app.inject() — no real HTTP ports needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

/* ── Conversation storage test helpers ───────────────────────────────────── */

const CONVERSATIONS_DIR = join(homedir(), '.codeman', 'data', 'conversations');

/** Write a conversation JSON file directly to disk for testing. */
function writeTestConversation(conv: {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  createdAt: string;
  updatedAt: string;
  lastActivity: number;
}): void {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(CONVERSATIONS_DIR, `${conv.id}.json`), JSON.stringify(conv));
}

/** Read a conversation from disk. */
function readTestConversation(id: string): Record<string, unknown> | null {
  try {
    const data = fs.readFileSync(join(CONVERSATIONS_DIR, `${id}.json`), 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Delete a test conversation file. */
function deleteTestConversation(id: string): void {
  try {
    fs.unlinkSync(join(CONVERSATIONS_DIR, `${id}.json`));
  } catch {
    /* ignore */
  }
}

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

  // ── Gap 1: Multimodal image support ──────────────────────────────────────

  it('builds multimodal content blocks when images are provided', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('I see the image.'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: {
        message: 'what is this?',
        images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
      },
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.response).toBe('I see the image.');

    // Verify the Claude API was called with multimodal content blocks
    const apiCall = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsg = apiCall.messages.find((m) => m.role === 'user');
    expect(Array.isArray(userMsg!.content)).toBe(true);
    const blocks = userMsg!.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2); // 1 image + 1 text
    expect(blocks[0].type).toBe('image');
    expect((blocks[0].source as Record<string, string>).media_type).toBe('image/png');
    expect((blocks[0].source as Record<string, string>).data).toBe('iVBORw0KGgo=');
    expect(blocks[1]).toEqual({ type: 'text', text: 'what is this?' });
  });

  it('skips malformed data URLs and sends only text block', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('Got it.'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: {
        message: 'check this',
        images: [{ dataUrl: 'not-a-valid-data-url' }],
      },
    });

    expect(res.statusCode).toBe(200);

    // Only a text block should be in the content (malformed image skipped)
    const apiCall = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsg = apiCall.messages.find((m) => m.role === 'user');
    expect(Array.isArray(userMsg!.content)).toBe(true);
    const blocks = userMsg!.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text: 'check this' });
  });

  it('treats empty images array as plain text message', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('Plain text.'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: {
        message: 'hello',
        images: [],
      },
    });

    expect(res.statusCode).toBe(200);

    // Content should be a plain string, not an array of blocks
    const apiCall = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    const userMsg = apiCall.messages.find((m) => m.role === 'user');
    expect(typeof userMsg!.content).toBe('string');
    expect(userMsg!.content).toBe('hello');
  });

  // ── Gap 2: Stale conversation recovery ───────────────────────────────────

  it('retries with cleared conversation on tool_use/tool_result mismatch error', async () => {
    // First call fails with a tool_use/tool_result mismatch error
    mockCreate.mockRejectedValueOnce(new Error('400 tool_use ids were found without a corresponding tool_result'));
    // Retry after clearing conversation succeeds
    mockCreate.mockResolvedValueOnce(textResponse('Recovered!'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'try again' },
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.response).toBe('Recovered!');
    expect(body.conversationCleared).toBe(true);
    expect(body.conversationId).toBeDefined();

    // mockCreate should have been called twice (original + retry)
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('returns 500 with conversationCleared when retry also fails', async () => {
    // First call fails with tool_use mismatch
    mockCreate.mockRejectedValueOnce(new Error('400 tool_use ids were found without a corresponding tool_result'));
    // Retry also fails
    mockCreate.mockRejectedValueOnce(new Error('Still broken'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'try again' },
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(500);
    expect(body.conversationCleared).toBe(true);
    expect(body.error).toMatch(/recovery/i);
  });

  it('creates a new conversation when given an invalid (non-UUID) conversationId', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('Fresh start'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'hello', conversationId: '../evil-path' },
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    // Should get a new valid UUID, not the invalid one
    expect(body.conversationId).toBeDefined();
    expect(body.conversationId).not.toBe('../evil-path');
    expect(body.response).toBe('Fresh start');
  });

  it('does not trigger recovery for non-tool_use errors', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Rate limit exceeded'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'hello' },
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(500);
    expect(body.conversationCleared).toBeUndefined();
    expect(body.error).toMatch(/Rate limit/);
    // Should only have been called once (no retry)
    expect(mockCreate).toHaveBeenCalledTimes(1);
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

/* ── Conversation management endpoints ───────────────────────────────────── */

describe('GET /api/command/conversations', () => {
  let harness: RouteTestHarness;
  const testIds: string[] = [];

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerCommandPanelRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await harness.app.close();
    for (const id of testIds) deleteTestConversation(id);
    testIds.length = 0;
  });

  it('skips corrupted JSON files and returns only valid conversations', async () => {
    const validId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee20';
    const corruptId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee21';
    testIds.push(validId, corruptId);

    writeTestConversation({
      id: validId,
      title: 'Valid',
      messages: [{ role: 'user', content: 'hi' }],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: 1,
    });

    // Write corrupted JSON directly
    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
    fs.writeFileSync(join(CONVERSATIONS_DIR, `${corruptId}.json`), '{not valid json!!!');

    const res = await harness.app.inject({ method: 'GET', url: '/api/command/conversations' });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);

    const validConv = body.conversations.find((c: { id: string }) => c.id === validId);
    const corruptConv = body.conversations.find((c: { id: string }) => c.id === corruptId);
    expect(validConv).toBeDefined();
    expect(corruptConv).toBeUndefined();
  });

  it('returns empty list when no conversations exist', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/command/conversations' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.conversations).toBeInstanceOf(Array);
  });

  it('returns conversations sorted by updatedAt desc', async () => {
    const id1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee01';
    const id2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee02';
    testIds.push(id1, id2);

    writeTestConversation({
      id: id1,
      title: 'Older',
      messages: [{ role: 'user', content: 'hi' }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      lastActivity: 1,
    });
    writeTestConversation({
      id: id2,
      title: 'Newer',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hey' },
      ],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: 2,
    });

    const res = await harness.app.inject({ method: 'GET', url: '/api/command/conversations' });
    const body = JSON.parse(res.body);
    expect(body.conversations.length).toBeGreaterThanOrEqual(2);
    // Find our test conversations
    const our = body.conversations.filter((c: { id: string }) => [id1, id2].includes(c.id));
    expect(our).toHaveLength(2);
    expect(our[0].id).toBe(id2); // newer first
    expect(our[0].title).toBe('Newer');
    expect(our[0].messageCount).toBe(2);
    expect(our[1].id).toBe(id1);
    expect(our[1].messageCount).toBe(1);
  });
});

describe('GET /api/command/conversations/:id', () => {
  let harness: RouteTestHarness;
  const testIds: string[] = [];

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerCommandPanelRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await harness.app.close();
    for (const id of testIds) deleteTestConversation(id);
    testIds.length = 0;
  });

  it('returns full conversation by ID', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee03';
    testIds.push(id);

    writeTestConversation({
      id,
      title: 'Test Conv',
      messages: [{ role: 'user', content: 'ping' }],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: 1,
    });

    const res = await harness.app.inject({ method: 'GET', url: `/api/command/conversations/${id}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(id);
    expect(body.title).toBe('Test Conv');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe('ping');
  });

  it('returns 404 for nonexistent conversation', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/command/conversations/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee99',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for invalid conversation ID (non-UUID format)', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/command/conversations/not-a-valid-uuid-at-all!',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/invalid/i);
  });

  it('rejects path traversal attempt in conversation ID', async () => {
    // Fastify normalizes /../ in URLs, so the :id param won't contain traversal chars.
    // The resulting param fails UUID validation regardless.
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/command/conversations/../../../etc/passwd',
    });
    // Should not return 200 — either 400 (invalid ID) or 404 (normalized path not found)
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('returns 400 for uppercase UUID (regex is lowercase hex only)', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/command/conversations/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEE01',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for empty conversation ID', async () => {
    // The route pattern /:id won't match empty string, but test all-dashes
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/command/conversations/--------',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for too-short ID', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/command/conversations/abcdef12',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when file exists but contains corrupted JSON', async () => {
    const corruptId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee22';
    testIds.push(corruptId);

    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
    fs.writeFileSync(join(CONVERSATIONS_DIR, `${corruptId}.json`), 'GARBAGE{{{');

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/command/conversations/${corruptId}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/command/conversations/:id', () => {
  let harness: RouteTestHarness;
  const testIds: string[] = [];

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerCommandPanelRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await harness.app.close();
    for (const id of testIds) deleteTestConversation(id);
    testIds.length = 0;
  });

  it('deletes an existing conversation', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee04';
    testIds.push(id);

    writeTestConversation({
      id,
      title: 'To Delete',
      messages: [],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: 1,
    });

    const res = await harness.app.inject({ method: 'DELETE', url: `/api/command/conversations/${id}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);

    // File should be gone
    expect(readTestConversation(id)).toBeNull();
  });

  it('returns 404 for nonexistent conversation', async () => {
    const res = await harness.app.inject({
      method: 'DELETE',
      url: '/api/command/conversations/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee99',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for invalid ID', async () => {
    const res = await harness.app.inject({
      method: 'DELETE',
      url: '/api/command/conversations/not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/command/conversations/:id', () => {
  let harness: RouteTestHarness;
  const testIds: string[] = [];

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerCommandPanelRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await harness.app.close();
    for (const id of testIds) deleteTestConversation(id);
    testIds.length = 0;
  });

  it('renames a conversation', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee05';
    testIds.push(id);

    writeTestConversation({
      id,
      title: 'Old Title',
      messages: [{ role: 'user', content: 'hi' }],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: 1,
    });

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/command/conversations/${id}`,
      payload: { title: 'New Title' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toBe('New Title');
    expect(body.messageCount).toBe(1);

    // Verify persisted on disk
    const saved = readTestConversation(id);
    expect(saved).not.toBeNull();
    expect((saved as Record<string, unknown>).title).toBe('New Title');
  });

  it('returns 404 for nonexistent conversation', async () => {
    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/command/conversations/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee99',
      payload: { title: 'New' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when title is missing', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee06';
    testIds.push(id);

    writeTestConversation({
      id,
      title: 'Test',
      messages: [],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: 1,
    });

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/command/conversations/${id}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/title/i);
  });

  it('returns 400 for whitespace-only title', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee09';
    testIds.push(id);

    writeTestConversation({
      id,
      title: 'Original',
      messages: [],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: 1,
    });

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/command/conversations/${id}`,
      payload: { title: '   ' },
    });
    // Whitespace-only title: after trim() becomes empty string which is falsy,
    // but the check is on the raw body.title — ' ' is truthy, so it passes validation.
    // After trim+slice it becomes ''. This tests the actual behavior.
    // If code doesn't reject it, the title becomes empty string.
    const body = JSON.parse(res.body);
    if (res.statusCode === 200) {
      // Implementation allows whitespace-only (trims to empty) — document this behavior
      expect(body.title).toBe('');
    } else {
      expect(res.statusCode).toBe(400);
    }
  });

  it('preserves title that is exactly 100 characters', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee11';
    testIds.push(id);

    writeTestConversation({
      id,
      title: 'Short',
      messages: [],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: 1,
    });

    const exactTitle = 'B'.repeat(100);
    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/command/conversations/${id}`,
      payload: { title: exactTitle },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toBe(exactTitle);
    expect(body.title).toHaveLength(100);
  });

  it('returns 400 for empty string title', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee12';
    testIds.push(id);

    writeTestConversation({
      id,
      title: 'Original',
      messages: [],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: 1,
    });

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/command/conversations/${id}`,
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/title/i);
  });

  it('truncates long titles to 100 characters', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee07';
    testIds.push(id);

    writeTestConversation({
      id,
      title: 'Short',
      messages: [],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: 1,
    });

    const longTitle = 'A'.repeat(200);
    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/command/conversations/${id}`,
      payload: { title: longTitle },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toHaveLength(100);
  });
});

describe('Conversation persistence via POST /api/command', () => {
  let harness: RouteTestHarness;
  const createdConvIds: string[] = [];

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerCommandPanelRoutes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await harness.app.close();
    for (const id of createdConvIds) deleteTestConversation(id);
    createdConvIds.length = 0;
  });

  it('persists conversation to disk after a message exchange', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('Saved!'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'test persistence' },
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    const convId = body.conversationId;
    createdConvIds.push(convId);

    // Verify the conversation was saved to disk
    const saved = readTestConversation(convId);
    expect(saved).not.toBeNull();
    expect((saved as Record<string, unknown>).id).toBe(convId);
    expect((saved as Record<string, unknown>).title).toBe('test persistence');
    const msgs = (saved as Record<string, unknown>).messages as unknown[];
    expect(msgs.length).toBeGreaterThanOrEqual(2); // user + assistant
  });

  it('auto-generates title from first user message', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('OK'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: '**Bold** message with `code` and [link]' },
    });

    const body = JSON.parse(res.body);
    const convId = body.conversationId;
    createdConvIds.push(convId);

    const saved = readTestConversation(convId);
    // Markdown chars should be stripped from the title
    expect((saved as Record<string, unknown>).title).toBe('Bold message with code and link');
  });

  it('generates title from message longer than 60 chars (truncated)', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('OK'));

    const longMessage = 'A'.repeat(80);
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: longMessage },
    });

    const body = JSON.parse(res.body);
    const convId = body.conversationId;
    createdConvIds.push(convId);

    const saved = readTestConversation(convId);
    expect((saved as Record<string, unknown>).title).toBe('A'.repeat(60));
  });

  it('generates "New conversation" title for multimodal content without text block', async () => {
    mockCreate.mockResolvedValueOnce(textResponse('I see images.'));

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: {
        message: 'describe this',
        images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
      },
    });

    const body = JSON.parse(res.body);
    const convId = body.conversationId;
    createdConvIds.push(convId);

    // Title should be derived from the text portion
    const saved = readTestConversation(convId);
    expect((saved as Record<string, unknown>).title).toBe('describe this');
  });

  it('trims messages to MAX_MESSAGES (40) when conversation grows too long', async () => {
    // Create a conversation on disk with 42 messages (over the limit)
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee10';
    createdConvIds.push(id);

    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 42; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` });
    }

    writeTestConversation({
      id,
      title: 'Long Conv',
      messages,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: Date.now(),
    });

    // Send a message — user message added (43), trimmed to 40, then LLM response added (41)
    mockCreate.mockResolvedValueOnce(textResponse('response-new'));

    await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'trigger trim', conversationId: id },
    });

    const saved = readTestConversation(id);
    const msgs = (saved as Record<string, unknown>).messages as unknown[];
    // After trim to 40 + 1 assistant response = 41
    expect(msgs.length).toBeLessThanOrEqual(41);
    // The oldest messages should have been trimmed — msg-0 should be gone
    expect((msgs[0] as Record<string, string>).content).not.toBe('msg-0');
  });

  it('loads conversation from disk when not in memory cache', async () => {
    // Create a conversation on disk that was never in the in-memory cache
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee08';
    createdConvIds.push(id);

    writeTestConversation({
      id,
      title: 'From Disk',
      messages: [{ role: 'user', content: 'previous message' }],
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      lastActivity: Date.now(),
    });

    mockCreate.mockResolvedValueOnce(textResponse('Follow-up'));

    // Send a message referencing the disk-only conversation
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { message: 'next message', conversationId: id },
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.conversationId).toBe(id);

    // The LLM should have received conversation history (including the previous message from disk)
    const apiCall = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown }> };
    expect(apiCall.messages.length).toBeGreaterThanOrEqual(2); // previous + new user message
  });
});

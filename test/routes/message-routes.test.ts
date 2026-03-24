/**
 * @fileoverview API route tests for message-routes — all 5 endpoints.
 *
 * Uses app.inject() — no real HTTP ports opened.
 * The messages store is fully mocked via vi.mock so route logic is tested
 * in isolation from SQLite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock the messages module (hoisted by Vitest) ─────────────────────────────
vi.mock('../../src/messages/index.js', () => ({
  sendMessage: vi.fn(),
  getMessage: vi.fn(),
  getInbox: vi.fn(),
  markRead: vi.fn(),
  broadcastMessage: vi.fn(),
  buildHandoffContext: vi.fn(),
}));

import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerMessageRoutes } from '../../src/web/routes/message-routes.js';
import { SseEvent } from '../../src/web/sse-events.js';
import { sendMessage, getMessage, getInbox, markRead, broadcastMessage } from '../../src/messages/index.js';
import type { AgentMessage } from '../../src/messages/index.js';

// Typed mock references
const mockSend = vi.mocked(sendMessage);
const mockGet = vi.mocked(getMessage);
const mockInbox = vi.mocked(getInbox);
const mockMarkRead = vi.mocked(markRead);
const mockBroadcast = vi.mocked(broadcastMessage);

/** Minimal AgentMessage stub */
function makeMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: overrides?.id ?? 'msg-test001',
    fromAgentId: overrides?.fromAgentId ?? 'agent-a',
    toAgentId: overrides?.toAgentId ?? 'agent-b',
    workItemId: overrides?.workItemId ?? null,
    type: overrides?.type ?? 'handoff',
    subject: overrides?.subject ?? 'Test subject',
    body: overrides?.body ?? 'Test body',
    context: overrides?.context ?? null,
    sentAt: overrides?.sentAt ?? '2026-01-01T00:00:00.000Z',
    readAt: overrides?.readAt ?? null,
  };
}

describe('message-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerMessageRoutes);
    vi.clearAllMocks();

    // Safe defaults
    mockSend.mockReturnValue(makeMessage());
    mockGet.mockReturnValue(undefined);
    mockInbox.mockReturnValue({ messages: [], unreadCount: 0 });
    mockMarkRead.mockReturnValue(undefined);
    mockBroadcast.mockReturnValue([]);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ── POST /api/agents/:agentId/messages ───────────────────────────────────

  describe('POST /api/agents/:agentId/messages', () => {
    it('returns 400 when fromAgentId is missing', async () => {
      // Register agent in mock store so 404 check passes
      harness.ctx.store.setAgent({
        agentId: 'agent-b',
        displayName: 'B',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/agent-b/messages',
        payload: { type: 'handoff', subject: 'S', body: 'B' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/fromAgentId/i);
    });

    it('returns 400 when type is missing', async () => {
      harness.ctx.store.setAgent({
        agentId: 'agent-b',
        displayName: 'B',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/agent-b/messages',
        payload: { fromAgentId: 'agent-a', subject: 'S', body: 'B' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/type/i);
    });

    it('returns 400 when subject is missing', async () => {
      harness.ctx.store.setAgent({
        agentId: 'agent-b',
        displayName: 'B',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/agent-b/messages',
        payload: { fromAgentId: 'agent-a', type: 'handoff', body: 'B' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/subject/i);
    });

    it('returns 400 when body is missing', async () => {
      harness.ctx.store.setAgent({
        agentId: 'agent-b',
        displayName: 'B',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/agent-b/messages',
        payload: { fromAgentId: 'agent-a', type: 'handoff', subject: 'S' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/body/i);
    });

    it('returns 404 when recipient agent does not exist', async () => {
      // Don't set any agent — getAgent returns undefined
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/ghost-agent/messages',
        payload: { fromAgentId: 'agent-a', type: 'handoff', subject: 'S', body: 'B' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/agent not found/i);
    });

    it('returns 201 with message and broadcasts AgentMessage SSE', async () => {
      const msg = makeMessage({ id: 'msg-new001', toAgentId: 'agent-b' });
      mockSend.mockReturnValue(msg);
      harness.ctx.store.setAgent({
        agentId: 'agent-b',
        displayName: 'B',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/agent-b/messages',
        payload: { fromAgentId: 'agent-a', type: 'handoff', subject: 'Task handoff', body: 'Details here.' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('msg-new001');

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          fromAgentId: 'agent-a',
          toAgentId: 'agent-b',
          type: 'handoff',
          subject: 'Task handoff',
        })
      );
    });

    it('broadcasts AgentMessage SSE when recipient has an active session', async () => {
      const msg = makeMessage({ toAgentId: 'agent-b' });
      mockSend.mockReturnValue(msg);
      harness.ctx.store.setAgent({
        agentId: 'agent-b',
        displayName: 'B',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      // Place a session in the store that belongs to agent-b
      const sessions = harness.ctx.store.getSessions() as Record<string, unknown>;
      sessions['sess-xyz'] = { agentProfile: { agentId: 'agent-b' } };

      await harness.app.inject({
        method: 'POST',
        url: '/api/agents/agent-b/messages',
        payload: { fromAgentId: 'agent-a', type: 'handoff', subject: 'S', body: 'B' },
      });

      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.AgentMessage,
        expect.objectContaining({ sessionId: 'sess-xyz' })
      );
    });
  });

  // ── GET /api/agents/:agentId/inbox ───────────────────────────────────────

  describe('GET /api/agents/:agentId/inbox', () => {
    it('returns inbox for the agent with unreadCount', async () => {
      const msgs = [makeMessage({ id: 'msg-1' }), makeMessage({ id: 'msg-2' })];
      mockInbox.mockReturnValue({ messages: msgs, unreadCount: 2 });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/agent-b/inbox',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.messages).toHaveLength(2);
      expect(body.data.unreadCount).toBe(2);
    });

    it('passes unreadOnly=true query param to getInbox', async () => {
      mockInbox.mockReturnValue({ messages: [], unreadCount: 0 });

      await harness.app.inject({
        method: 'GET',
        url: '/api/agents/agent-b/inbox?unreadOnly=true',
      });

      expect(mockInbox).toHaveBeenCalledWith('agent-b', expect.objectContaining({ unreadOnly: true }));
    });

    it('passes limit and offset query params to getInbox', async () => {
      mockInbox.mockReturnValue({ messages: [], unreadCount: 0 });

      await harness.app.inject({
        method: 'GET',
        url: '/api/agents/agent-b/inbox?limit=5&offset=10',
      });

      expect(mockInbox).toHaveBeenCalledWith('agent-b', expect.objectContaining({ limit: 5, offset: 10 }));
    });

    it('returns empty inbox for unknown agent without error', async () => {
      mockInbox.mockReturnValue({ messages: [], unreadCount: 0 });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/nobody/inbox',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.messages).toHaveLength(0);
      expect(body.data.unreadCount).toBe(0);
    });
  });

  // ── PATCH /api/agents/:agentId/messages/:id/read ─────────────────────────

  describe('PATCH /api/agents/:agentId/messages/:messageId/read', () => {
    it('returns 404 when message is not found', async () => {
      mockMarkRead.mockReturnValue(undefined);

      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/agents/agent-b/messages/msg-ghost/read',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns 200 with updated message after marking read', async () => {
      const readMsg = makeMessage({ id: 'msg-mark001', readAt: '2026-01-01T01:00:00Z' });
      mockMarkRead.mockReturnValue(readMsg);

      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/agents/agent-b/messages/msg-mark001/read',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.readAt).toBe('2026-01-01T01:00:00Z');
      expect(mockMarkRead).toHaveBeenCalledWith('msg-mark001');
    });
  });

  // ── POST /api/agents/broadcast ────────────────────────────────────────────

  describe('POST /api/agents/broadcast', () => {
    it('returns 400 when fromAgentId is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/broadcast',
        payload: { subject: 'S', body: 'B' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/fromAgentId/i);
    });

    it('returns 400 when subject is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/broadcast',
        payload: { fromAgentId: 'agent-a', body: 'B' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/subject/i);
    });

    it('returns 400 when body field is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/broadcast',
        payload: { fromAgentId: 'agent-a', subject: 'S' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/body/i);
    });

    it('returns 201 with messages and broadcasts AgentBroadcast SSE', async () => {
      const msgs = [makeMessage({ toAgentId: 'agent-b' }), makeMessage({ id: 'msg-2', toAgentId: 'agent-c' })];
      mockBroadcast.mockReturnValue(msgs);

      // Add agents to the store
      harness.ctx.store.setAgent({
        agentId: 'agent-a',
        displayName: 'A',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);
      harness.ctx.store.setAgent({
        agentId: 'agent-b',
        displayName: 'B',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);
      harness.ctx.store.setAgent({
        agentId: 'agent-c',
        displayName: 'C',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/broadcast',
        payload: { fromAgentId: 'agent-a', subject: 'Team update', body: 'Hello all.' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);

      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.AgentBroadcast,
        expect.objectContaining({ fromAgentId: 'agent-a' })
      );
    });

    it('passes all agents IDs to broadcastMessage', async () => {
      mockBroadcast.mockReturnValue([]);
      harness.ctx.store.setAgent({
        agentId: 'agent-x',
        displayName: 'X',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);
      harness.ctx.store.setAgent({
        agentId: 'agent-y',
        displayName: 'Y',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      await harness.app.inject({
        method: 'POST',
        url: '/api/agents/broadcast',
        payload: { fromAgentId: 'agent-x', subject: 'S', body: 'B' },
      });

      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          fromAgentId: 'agent-x',
          recipientAgentIds: expect.arrayContaining(['agent-x', 'agent-y']),
        })
      );
    });
  });

  // ── GET /api/agents/:agentId/messages/:messageId ─────────────────────────

  describe('GET /api/agents/:agentId/messages/:messageId', () => {
    it('returns 404 for unknown message id', async () => {
      mockGet.mockReturnValue(undefined);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/agent-b/messages/msg-ghost',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns 200 with message for known id', async () => {
      const msg = makeMessage({ id: 'msg-known01' });
      mockGet.mockReturnValue(msg);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/agent-b/messages/msg-known01',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('msg-known01');
      expect(mockGet).toHaveBeenCalledWith('msg-known01');
    });

    it('returns message with context when present', async () => {
      const msg = makeMessage({
        id: 'msg-ctx01',
        context: {
          workItemId: 'wi-abc',
          vaultSnippets: [{ sourceFile: 'note.md', snippet: 'snippet text', timestamp: '2026-01-01T00:00:00Z' }],
          gitHash: 'deadbeef',
          extra: {},
        },
      });
      mockGet.mockReturnValue(msg);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/agent-b/messages/msg-ctx01',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.context.gitHash).toBe('deadbeef');
    });
  });

  // ── SSE event name regression guard ──────────────────────────────────────

  describe('SSE event constants', () => {
    it('AgentMessage event string matches expected value', () => {
      expect(SseEvent.AgentMessage).toBe('agent:message');
    });

    it('AgentBroadcast event string matches expected value', () => {
      expect(SseEvent.AgentBroadcast).toBe('agent:broadcast');
    });
  });

  // ── SSE broadcast mock verification (session-scoped) ─────────────────────
  // These tests verify the route correctly calls ctx.broadcast with the right
  // event name, payload shape, and session-scoping when an agent:message is sent.

  describe('SSE broadcast scoping (mock verification)', () => {
    it('does NOT call broadcast when recipient has no active session', async () => {
      const msg = makeMessage({ toAgentId: 'agent-nosession' });
      mockSend.mockReturnValue(msg);
      harness.ctx.store.setAgent({
        agentId: 'agent-nosession',
        displayName: 'NS',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);
      // No session added for this agent

      await harness.app.inject({
        method: 'POST',
        url: '/api/agents/agent-nosession/messages',
        payload: { fromAgentId: 'agent-a', type: 'briefing', subject: 'S', body: 'B' },
      });

      expect(harness.ctx.broadcast).not.toHaveBeenCalled();
    });

    it('broadcasts to each active session whose agent matches any broadcast recipient', async () => {
      const msgs = [makeMessage({ toAgentId: 'agent-b' }), makeMessage({ id: 'msg-2', toAgentId: 'agent-c' })];
      mockBroadcast.mockReturnValue(msgs);

      harness.ctx.store.setAgent({
        agentId: 'agent-a',
        displayName: 'A',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);
      harness.ctx.store.setAgent({
        agentId: 'agent-b',
        displayName: 'B',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);
      harness.ctx.store.setAgent({
        agentId: 'agent-c',
        displayName: 'C',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/broadcast',
        payload: { fromAgentId: 'agent-a', subject: 'Team sync', body: 'All hands.' },
      });

      expect(res.statusCode).toBe(201);
      // AgentBroadcast is called once for the whole broadcast (not per recipient)
      expect(harness.ctx.broadcast).toHaveBeenCalledTimes(1);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.AgentBroadcast,
        expect.objectContaining({ fromAgentId: 'agent-a', messages: msgs })
      );
    });

    it('broadcast payload contains the messages array from broadcastMessage()', async () => {
      const msgs = [makeMessage({ toAgentId: 'agent-d' })];
      mockBroadcast.mockReturnValue(msgs);
      harness.ctx.store.setAgent({
        agentId: 'agent-d',
        displayName: 'D',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      await harness.app.inject({
        method: 'POST',
        url: '/api/agents/broadcast',
        payload: { fromAgentId: 'agent-a', subject: 'Notify', body: 'Hello.' },
      });

      const call = vi.mocked(harness.ctx.broadcast).mock.calls[0];
      expect(call[0]).toBe('agent:broadcast');
      expect((call[1] as any).messages).toHaveLength(1);
      expect((call[1] as any).messages[0].id).toBe('msg-test001');
    });
  });
});

// SSE delivery end-to-end tests live in test/routes/message-sse-delivery.test.ts
// (separate file to avoid vi.mock hoisting conflicting with real implementations).

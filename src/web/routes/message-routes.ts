/**
 * @fileoverview Inter-agent messaging REST routes.
 *
 * Routes:
 *   POST   /api/agents/:agentId/messages         — send message to agent
 *   GET    /api/agents/:agentId/inbox             — get inbox (unread first)
 *   PATCH  /api/agents/:agentId/messages/:id/read — mark as read
 *   POST   /api/agents/broadcast                  — send to all agents
 *   GET    /api/agents/:agentId/messages/:id      — get single message
 *
 * IMPORTANT: POST /api/agents/broadcast MUST be registered BEFORE
 * POST /api/agents/:agentId/messages to avoid 'broadcast' being captured
 * as an agentId param.
 */

import { FastifyInstance } from 'fastify';
import type { EventPort } from '../ports/event-port.js';
import type { ConfigPort } from '../ports/config-port.js';
import { SseEvent } from '../sse-events.js';
import { sendMessage, getMessage, getInbox, markRead, broadcastMessage } from '../../messages/index.js';
import type { AgentMessageType } from '../../messages/index.js';

type MessageRoutesCtx = EventPort & ConfigPort;

export function registerMessageRoutes(app: FastifyInstance, ctx: MessageRoutesCtx): void {
  // ── POST /api/agents/broadcast ────────────────────────────────────────────
  // MUST be registered before /:agentId routes to avoid 'broadcast' being
  // captured as an agentId param.
  app.post('/api/agents/broadcast', async (req, reply) => {
    const body = req.body as {
      fromAgentId?: string;
      subject?: string;
      body?: string;
      workItemId?: string;
      type?: AgentMessageType;
    };

    if (!body.fromAgentId) {
      reply.code(400);
      return { success: false, error: 'fromAgentId is required' };
    }
    if (!body.subject) {
      reply.code(400);
      return { success: false, error: 'subject is required' };
    }
    if (!body.body) {
      reply.code(400);
      return { success: false, error: 'body is required' };
    }

    // Collect all agent IDs from the state store
    const agents = ctx.store.listAgents();
    const recipientAgentIds = agents.map((a) => a.agentId);

    const messages = broadcastMessage({
      fromAgentId: body.fromAgentId,
      recipientAgentIds,
      subject: body.subject,
      body: body.body,
      workItemId: body.workItemId,
      type: body.type,
    });

    // Broadcast SSE to all clients
    ctx.broadcast(SseEvent.AgentBroadcast, { messages, fromAgentId: body.fromAgentId });

    reply.code(201);
    return { success: true, data: messages };
  });

  // ── POST /api/agents/:agentId/messages ────────────────────────────────────
  app.post('/api/agents/:agentId/messages', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const body = req.body as {
      fromAgentId?: string;
      toAgentId?: string;
      type?: AgentMessageType;
      subject?: string;
      body?: string;
      workItemId?: string;
      context?: Record<string, unknown>;
    };

    // toAgentId in body overrides param, but both must agree or param is used
    const toAgentId = body.toAgentId ?? agentId;

    if (!body.fromAgentId) {
      reply.code(400);
      return { success: false, error: 'fromAgentId is required' };
    }
    if (!body.type) {
      reply.code(400);
      return { success: false, error: 'type is required' };
    }
    if (!body.subject) {
      reply.code(400);
      return { success: false, error: 'subject is required' };
    }
    if (!body.body) {
      reply.code(400);
      return { success: false, error: 'body is required' };
    }

    // Validate recipient agent exists
    const recipientProfile = ctx.store.getAgent(toAgentId);
    if (!recipientProfile) {
      reply.code(404);
      return { success: false, error: 'Recipient agent not found' };
    }

    const message = sendMessage({
      fromAgentId: body.fromAgentId,
      toAgentId,
      type: body.type,
      subject: body.subject,
      body: body.body,
      workItemId: body.workItemId,
      context: body.context as import('../../messages/index.js').AgentMessageContext | undefined,
    });

    // SSE targeted delivery: find recipient's active session
    const sessions = ctx.store.getSessions() as Record<string, { agentProfile?: { agentId?: string } }>;
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (session?.agentProfile?.agentId === toAgentId) {
        ctx.broadcast(SseEvent.AgentMessage, { sessionId, ...message });
        break;
      }
    }

    reply.code(201);
    return { success: true, data: message };
  });

  // ── GET /api/agents/:agentId/inbox ────────────────────────────────────────
  app.get('/api/agents/:agentId/inbox', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const query = req.query as { unreadOnly?: string; limit?: string; offset?: string };

    const result = getInbox(agentId, {
      unreadOnly: query.unreadOnly === 'true',
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });

    return { success: true, data: result };
  });

  // ── GET /api/agents/:agentId/messages/:messageId ──────────────────────────
  app.get('/api/agents/:agentId/messages/:messageId', async (req, reply) => {
    const { messageId } = req.params as { agentId: string; messageId: string };
    const message = getMessage(messageId);
    if (!message) {
      reply.code(404);
      return { success: false, error: 'Message not found' };
    }
    return { success: true, data: message };
  });

  // ── PATCH /api/agents/:agentId/messages/:messageId/read ───────────────────
  app.patch('/api/agents/:agentId/messages/:messageId/read', async (req, reply) => {
    const { messageId } = req.params as { agentId: string; messageId: string };
    const message = markRead(messageId);
    if (!message) {
      reply.code(404);
      return { success: false, error: 'Message not found' };
    }
    return { success: true, data: message };
  });
}

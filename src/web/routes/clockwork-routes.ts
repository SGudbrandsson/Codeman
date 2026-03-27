/**
 * @fileoverview Clockwork OS integration REST routes.
 *
 * Provides a dedicated API surface for the Clockwork OS strategic orchestrator
 * to interact with Codeman (the execution layer).
 *
 * Routes:
 *   POST /api/clockwork/webhook              — register webhook callback URL
 *   POST /api/clockwork/work-items           — create work item from external source
 *   GET  /api/clockwork/status               — board summary (counts per status, active agents)
 *   POST /api/clockwork/broadcast            — message all agents
 *   POST /api/clockwork/agents/:id/briefing  — send briefing to specific agent
 *   GET  /api/clockwork/work-items/:id/suggest-agent — ranked agent suggestions
 *
 * Auth: X-Clockwork-Token header checked against
 *   ctx.store.getConfig().clockworkToken ?? process.env.CLOCKWORK_API_TOKEN
 *
 * IMPORTANT: POST /api/clockwork/broadcast and POST /api/clockwork/webhook MUST
 * be registered before the /:id param routes.
 */

import { timingSafeEqual } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import type { EventPort } from '../ports/event-port.js';
import type { ConfigPort } from '../ports/config-port.js';
import { SseEvent } from '../sse-events.js';
import { createWorkItem, listWorkItems, getWorkItem } from '../../work-items/index.js';
import { getOrchestrator } from '../../orchestrator.js';
import type { WorkItemSource } from '../../work-items/index.js';
import { broadcastMessage, sendMessage } from '../../messages/index.js';
import type { AgentProfile } from '../../types/session.js';

type ClockworkRoutesCtx = EventPort & ConfigPort;

/**
 * Verify the Clockwork API token from the request headers.
 * Returns true if valid, false if missing or invalid.
 */
function verifyToken(ctx: ClockworkRoutesCtx, provided: string | undefined): boolean {
  if (!provided) return false;

  const config = ctx.store.getConfig();
  const configToken = config.clockworkToken ?? process.env.CLOCKWORK_API_TOKEN;

  if (!configToken) return false;

  // timingSafeEqual requires same-length buffers; check length first to
  // avoid leaking length info via timing, then compare equal-length bufs.
  if (provided.length !== configToken.length) return false;

  return timingSafeEqual(Buffer.from(configToken), Buffer.from(provided));
}

export function registerClockworkRoutes(app: FastifyInstance, ctx: ClockworkRoutesCtx): void {
  // ── POST /api/clockwork/webhook ───────────────────────────────────────────
  // Register or update the Clockwork OS webhook callback URL.
  // Body: { url: string, secret?: string }
  app.post('/api/clockwork/webhook', async (req, reply) => {
    const token = (req.headers as Record<string, string | undefined>)['x-clockwork-token'];
    if (!verifyToken(ctx, token)) {
      reply.code(401);
      return { success: false, error: 'Unauthorized' };
    }

    const body = req.body as { url?: string; secret?: string };
    if (!body.url) {
      reply.code(400);
      return { success: false, error: 'url is required' };
    }

    ctx.store.setConfig({
      clockworkWebhook: { url: body.url, secret: body.secret ?? null },
    } as Parameters<typeof ctx.store.setConfig>[0]);

    return { success: true, data: { url: body.url, registered: true } };
  });

  // ── POST /api/clockwork/work-items ────────────────────────────────────────
  // Create a work item from an external source (Clockwork OS push).
  app.post('/api/clockwork/work-items', async (req, reply) => {
    const token = (req.headers as Record<string, string | undefined>)['x-clockwork-token'];
    if (!verifyToken(ctx, token)) {
      reply.code(401);
      return { success: false, error: 'Unauthorized' };
    }

    const body = req.body as {
      title?: string;
      description?: string;
      source?: WorkItemSource;
      externalRef?: string;
      externalUrl?: string;
      metadata?: Record<string, unknown>;
    };

    if (!body.title) {
      reply.code(400);
      return { success: false, error: 'title is required' };
    }

    const item = createWorkItem({
      title: body.title,
      description: body.description,
      source: body.source ?? 'clockwork',
      externalRef: body.externalRef,
      externalUrl: body.externalUrl,
      metadata: body.metadata,
    });

    ctx.broadcast(SseEvent.WorkItemCreated, item);
    ctx.broadcast(SseEvent.ClockworkWorkItemPushed, item);
    getOrchestrator()?.triggerTick();

    reply.code(201);
    return { success: true, data: item };
  });

  // ── GET /api/clockwork/status ─────────────────────────────────────────────
  // Board summary: counts per status + active agents.
  app.get('/api/clockwork/status', async (req, reply) => {
    const token = (req.headers as Record<string, string | undefined>)['x-clockwork-token'];
    if (!verifyToken(ctx, token)) {
      reply.code(401);
      return { success: false, error: 'Unauthorized' };
    }

    const items = listWorkItems({});
    const countsByStatus: Record<string, number> = {};
    for (const item of items) {
      countsByStatus[item.status] = (countsByStatus[item.status] ?? 0) + 1;
    }

    const agents = ctx.store.listAgents();
    const sessions = ctx.store.getSessions() as Record<
      string,
      { agentProfile?: { agentId?: string }; status?: string }
    >;

    // Agents that have at least one session currently active
    const activeAgentIds = new Set<string>();
    for (const session of Object.values(sessions)) {
      if (session?.agentProfile?.agentId && session.status === 'working') {
        activeAgentIds.add(session.agentProfile.agentId);
      }
    }

    const activeAgents = agents
      .filter((a) => activeAgentIds.has(a.agentId))
      .map((a) => ({ agentId: a.agentId, displayName: a.displayName, role: a.role }));

    return {
      success: true,
      data: {
        workItems: {
          total: items.length,
          byStatus: countsByStatus,
        },
        agents: {
          total: agents.length,
          active: activeAgents.length,
          activeAgents,
        },
      },
    };
  });

  // ── POST /api/clockwork/broadcast ─────────────────────────────────────────
  // Send a message to all registered agents.
  // MUST be registered before /api/clockwork/agents/:id routes.
  app.post('/api/clockwork/broadcast', async (req, reply) => {
    const token = (req.headers as Record<string, string | undefined>)['x-clockwork-token'];
    if (!verifyToken(ctx, token)) {
      reply.code(401);
      return { success: false, error: 'Unauthorized' };
    }

    const body = req.body as {
      subject?: string;
      body?: string;
      workItemId?: string;
    };

    if (!body.subject) {
      reply.code(400);
      return { success: false, error: 'subject is required' };
    }
    if (!body.body) {
      reply.code(400);
      return { success: false, error: 'body is required' };
    }

    const agents = ctx.store.listAgents();
    const recipientAgentIds = agents.map((a) => a.agentId);

    const messages = broadcastMessage({
      fromAgentId: 'clockwork-os',
      recipientAgentIds,
      subject: body.subject,
      body: body.body,
      workItemId: body.workItemId,
      type: 'broadcast',
    });

    ctx.broadcast(SseEvent.AgentBroadcast, { messages, fromAgentId: 'clockwork-os' });

    reply.code(201);
    return { success: true, data: messages };
  });

  // ── POST /api/clockwork/agents/:id/briefing ───────────────────────────────
  // Send a briefing message to a specific agent.
  app.post('/api/clockwork/agents/:id/briefing', async (req, reply) => {
    const token = (req.headers as Record<string, string | undefined>)['x-clockwork-token'];
    if (!verifyToken(ctx, token)) {
      reply.code(401);
      return { success: false, error: 'Unauthorized' };
    }

    const { id: agentId } = req.params as { id: string };
    const body = req.body as {
      subject?: string;
      body?: string;
      workItemId?: string;
    };

    if (!body.subject) {
      reply.code(400);
      return { success: false, error: 'subject is required' };
    }
    if (!body.body) {
      reply.code(400);
      return { success: false, error: 'body is required' };
    }

    // Validate recipient agent exists
    const recipientProfile = ctx.store.getAgent(agentId);
    if (!recipientProfile) {
      reply.code(404);
      return { success: false, error: 'Agent not found' };
    }

    const message = sendMessage({
      fromAgentId: 'clockwork-os',
      toAgentId: agentId,
      type: 'briefing',
      subject: body.subject,
      body: body.body,
      workItemId: body.workItemId,
    });

    // SSE targeted delivery: find the recipient agent's active session
    const sessions = ctx.store.getSessions() as Record<string, { agentProfile?: { agentId?: string } }>;
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (session?.agentProfile?.agentId === agentId) {
        ctx.broadcast(SseEvent.ClockworkBriefingSent, { sessionId, agentId, ...message });
        break;
      }
    }

    reply.code(201);
    return { success: true, data: message };
  });

  // ── GET /api/clockwork/work-items/:id/suggest-agent ───────────────────────
  // Return a ranked list of agents that could handle the given work item.
  app.get('/api/clockwork/work-items/:id/suggest-agent', async (req, reply) => {
    const token = (req.headers as Record<string, string | undefined>)['x-clockwork-token'];
    if (!verifyToken(ctx, token)) {
      reply.code(401);
      return { success: false, error: 'Unauthorized' };
    }

    const { id } = req.params as { id: string };
    const item = getWorkItem(id);
    if (!item) {
      reply.code(404);
      return { success: false, error: 'Work item not found' };
    }

    const agents = ctx.store.listAgents();

    // Simple heuristic scoring:
    //  +3 if work item source matches an agent capability name
    //  +2 if work item title/description contains agent role keyword
    //  +1 base score for any agent (everyone can handle anything)
    const searchText = `${item.title} ${item.description} ${item.source}`.toLowerCase();

    interface RankedAgent {
      agentId: string;
      displayName: string;
      role: string;
      score: number;
      reasons: string[];
    }

    const ranked: RankedAgent[] = agents.map((agent: AgentProfile) => {
      let score = 1;
      const reasons: string[] = [];

      // Match agent capabilities against work item source / text
      for (const cap of agent.capabilities ?? []) {
        if (searchText.includes(cap.name.toLowerCase())) {
          score += 3;
          reasons.push(`capability match: ${cap.name}`);
        }
      }

      // Match agent role keywords against work item text
      const roleKeywords = agent.role.split('-');
      for (const keyword of roleKeywords) {
        if (keyword.length > 3 && searchText.includes(keyword.toLowerCase())) {
          score += 2;
          reasons.push(`role keyword match: ${keyword}`);
          break; // only count once per role
        }
      }

      // Match work item source to known agent roles
      if (item.source === 'github' && agent.role === 'codeman-dev') {
        score += 2;
        reasons.push('github source suits codeman-dev');
      }
      if (item.source === 'asana' && agent.role === 'orchestrator') {
        score += 2;
        reasons.push('asana source suits orchestrator');
      }
      if (item.source === 'clockwork' && agent.role === 'orchestrator') {
        score += 1;
        reasons.push('clockwork source suits orchestrator');
      }

      return {
        agentId: agent.agentId,
        displayName: agent.displayName,
        role: agent.role,
        score,
        reasons,
      };
    });

    // Sort descending by score
    ranked.sort((a, b) => b.score - a.score);

    return { success: true, data: { workItemId: id, suggestions: ranked } };
  });
}

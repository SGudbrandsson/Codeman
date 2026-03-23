/**
 * @fileoverview Agent profile CRUD routes.
 *
 * Provides REST endpoints to create, read, update, and delete AgentProfile
 * records stored in AppState.agents. Broadcasts SSE events on mutations.
 *
 * Routes:
 *   GET    /api/agents              — list all agent profiles
 *   GET    /api/agents/:agentId     — get a single profile (404 if not found)
 *   POST   /api/agents              — create a new profile
 *   PATCH  /api/agents/:agentId     — update allowed fields
 *   DELETE /api/agents/:agentId     — delete profile (clears sessions, no vault delete)
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FastifyInstance } from 'fastify';
import type { ConfigPort } from '../ports/config-port.js';
import type { EventPort } from '../ports/event-port.js';
import { SseEvent } from '../sse-events.js';
import type { AgentProfile, AgentRole, AgentCapability } from '../../types/session.js';

type AgentRoutesCtx = ConfigPort & EventPort;

export function registerAgentRoutes(app: FastifyInstance, ctx: AgentRoutesCtx): void {
  // ── GET /api/agents ──────────────────────────────────────────────────────
  app.get('/api/agents', async () => {
    return { success: true, data: ctx.store.listAgents() };
  });

  // ── GET /api/agents/:agentId ─────────────────────────────────────────────
  app.get('/api/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const profile = ctx.store.getAgent(agentId);
    if (!profile) {
      reply.code(404);
      return { success: false, error: 'Agent not found' };
    }
    return { success: true, data: profile };
  });

  // ── POST /api/agents ─────────────────────────────────────────────────────
  app.post('/api/agents', async (req, reply) => {
    const body = req.body as {
      role: AgentRole;
      displayName: string;
      rolePrompt?: string;
      capabilities?: AgentCapability[];
      decay?: { notesTtlDays?: number; patternsTtlDays?: number };
    };

    if (!body.role || !body.displayName) {
      reply.code(400);
      return { success: false, error: 'role and displayName are required' };
    }

    const agentId = randomUUID();
    const profile: AgentProfile = {
      agentId,
      role: body.role,
      displayName: body.displayName,
      vaultPath: join(homedir(), '.codeman', 'vaults', agentId),
      capabilities: body.capabilities ?? [],
      rolePrompt: body.rolePrompt,
      notesSinceConsolidation: 0,
      decay: {
        notesTtlDays: body.decay?.notesTtlDays ?? 90,
        patternsTtlDays: body.decay?.patternsTtlDays ?? 365,
      },
      createdAt: new Date().toISOString(),
    };

    ctx.store.setAgent(profile);
    ctx.broadcast(SseEvent.AgentCreated, profile);

    reply.code(201);
    return { success: true, data: profile };
  });

  // ── PATCH /api/agents/:agentId ───────────────────────────────────────────
  app.patch('/api/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const existing = ctx.store.getAgent(agentId);
    if (!existing) {
      reply.code(404);
      return { success: false, error: 'Agent not found' };
    }

    const body = req.body as {
      displayName?: string;
      rolePrompt?: string;
      capabilities?: AgentCapability[];
      decay?: { notesTtlDays?: number; patternsTtlDays?: number };
    };

    const updated: AgentProfile = {
      ...existing,
      displayName: body.displayName ?? existing.displayName,
      rolePrompt: body.rolePrompt !== undefined ? body.rolePrompt : existing.rolePrompt,
      capabilities: body.capabilities ?? existing.capabilities,
      decay: {
        notesTtlDays: body.decay?.notesTtlDays ?? existing.decay.notesTtlDays,
        patternsTtlDays: body.decay?.patternsTtlDays ?? existing.decay.patternsTtlDays,
      },
    };

    ctx.store.setAgent(updated);
    ctx.broadcast(SseEvent.AgentUpdated, updated);

    return { success: true, data: updated };
  });

  // ── DELETE /api/agents/:agentId ──────────────────────────────────────────
  app.delete('/api/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const existing = ctx.store.getAgent(agentId);
    if (!existing) {
      reply.code(404);
      return { success: false, error: 'Agent not found' };
    }

    // Clear agentProfile from any sessions that reference this agentId
    const sessions = ctx.store.getSessions();
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (session.agentProfile?.agentId === agentId) {
        const { agentProfile: _removed, ...rest } = session;
        ctx.store.setSession(sessionId, rest as typeof session);
      }
    }

    ctx.store.removeAgent(agentId);
    ctx.broadcast(SseEvent.AgentDeleted, { agentId });

    reply.code(204);
    return null;
  });
}

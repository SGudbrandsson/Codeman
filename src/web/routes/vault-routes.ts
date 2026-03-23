/**
 * @fileoverview Vault and agent management routes.
 *
 * Agent CRUD:
 *   GET    /api/agents                           → AgentProfile[]
 *   GET    /api/agents/:agentId                  → AgentProfile | 404
 *   POST   /api/agents                           → AgentProfile (creates agent + vault dirs)
 *   PATCH  /api/agents/:agentId                  → AgentProfile
 *   DELETE /api/agents/:agentId                  → 204
 *
 * Vault:
 *   POST   /api/agents/:agentId/vault/capture    → { filename, noteCount }
 *   GET    /api/agents/:agentId/vault/query      → VaultQueryResult[]  (?q=&limit=5)
 *   GET    /api/agents/:agentId/vault/notes      → { notes: VaultNote[], total: number }
 *   DELETE /api/agents/:agentId/vault/notes/:filename → 204
 */

import { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { capture, query } from '../../vault/index.js';
import { listNotes, deleteNote, countNotes, ensureVaultDirs } from '../../vault/store.js';
import { invalidateIndex } from '../../vault/search.js';
import type { AgentProfile, AgentRole } from '../../types/session.js';
import type { ConfigPort } from '../ports/index.js';

const VAULT_BASE = join(homedir(), '.codeman', 'vaults');

function defaultVaultPath(agentId: string): string {
  return join(VAULT_BASE, agentId);
}

export function registerVaultRoutes(app: FastifyInstance, ctx: ConfigPort): void {
  const { store } = ctx;

  // ═══════════════════════════════════════════════════════════════
  // Agent CRUD
  // ═══════════════════════════════════════════════════════════════

  // GET /api/agents
  app.get('/api/agents', async () => {
    return { success: true, agents: store.listAgents() };
  });

  // GET /api/agents/:agentId
  app.get('/api/agents/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const agent = store.getAgent(agentId);
    if (!agent) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Agent not found');
    return { success: true, agent };
  });

  // POST /api/agents — create a new agent
  app.post('/api/agents', async (req) => {
    const body = req.body as {
      agentId?: string;
      role?: AgentRole;
      displayName?: string;
      vaultPath?: string;
      rolePrompt?: string;
      capabilities?: AgentProfile['capabilities'];
      decay?: AgentProfile['decay'];
    };

    if (!body.agentId || !body.role || !body.displayName) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'agentId, role, and displayName are required');
    }

    const existing = store.getAgent(body.agentId);
    if (existing) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Agent '${body.agentId}' already exists`);
    }

    const vaultPath = body.vaultPath ?? defaultVaultPath(body.agentId);
    ensureVaultDirs(vaultPath);

    const now = new Date().toISOString();
    const profile: AgentProfile = {
      agentId: body.agentId,
      role: body.role,
      displayName: body.displayName,
      vaultPath,
      capabilities: body.capabilities ?? [],
      rolePrompt: body.rolePrompt,
      notesSinceConsolidation: 0,
      decay: body.decay ?? { notesTtlDays: 90, patternsTtlDays: 180 },
      createdAt: now,
    };

    store.setAgent(profile);
    return { success: true, agent: profile };
  });

  // PATCH /api/agents/:agentId — update agent fields
  app.patch('/api/agents/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const agent = store.getAgent(agentId);
    if (!agent) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Agent not found');

    const body = req.body as Partial<AgentProfile>;
    const updated: AgentProfile = {
      ...agent,
      ...body,
      agentId, // prevent changing agentId via PATCH
      vaultPath: agent.vaultPath, // prevent changing vaultPath via PATCH
    };

    store.setAgent(updated);
    return { success: true, agent: updated };
  });

  // DELETE /api/agents/:agentId
  app.delete('/api/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const agent = store.getAgent(agentId);
    if (!agent) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Agent not found');

    store.deleteAgent(agentId);
    invalidateIndex(agentId);
    reply.code(204);
    return '';
  });

  // ═══════════════════════════════════════════════════════════════
  // Vault routes
  // ═══════════════════════════════════════════════════════════════

  // POST /api/agents/:agentId/vault/capture
  app.post('/api/agents/:agentId/vault/capture', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const agent = store.getAgent(agentId);
    if (!agent) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Agent not found');

    const body = req.body as { sessionId?: string; workItemId?: string | null; content?: string };
    if (!body.sessionId || !body.content) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'sessionId and content are required');
    }

    try {
      const note = await capture(agentId, agent.vaultPath, {
        sessionId: body.sessionId,
        workItemId: body.workItemId ?? null,
        content: body.content,
      });

      // Increment notesSinceConsolidation
      store.setAgent({
        ...agent,
        notesSinceConsolidation: agent.notesSinceConsolidation + 1,
        lastActiveAt: new Date().toISOString(),
      });

      return {
        success: true,
        filename: note.filename,
        noteCount: countNotes(agent.vaultPath),
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Capture failed: ${String(err)}`);
    }
  });

  // GET /api/agents/:agentId/vault/query?q=&limit=5
  app.get('/api/agents/:agentId/vault/query', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const agent = store.getAgent(agentId);
    if (!agent) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Agent not found');

    const qs = req.query as { q?: string; limit?: string };
    const q = qs.q ?? '';
    const limit = Math.min(parseInt(qs.limit ?? '5', 10) || 5, 20);

    if (!q.trim()) {
      return { success: true, results: [] };
    }

    try {
      const results = await query(agentId, agent.vaultPath, q, limit);
      return { success: true, results };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Query failed: ${String(err)}`);
    }
  });

  // GET /api/agents/:agentId/vault/notes?limit=50&offset=0
  app.get('/api/agents/:agentId/vault/notes', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const agent = store.getAgent(agentId);
    if (!agent) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Agent not found');

    const qs = req.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(qs.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(qs.offset ?? '0', 10) || 0;

    const { notes, total } = listNotes(agent.vaultPath, { limit, offset });
    return { success: true, notes, total };
  });

  // DELETE /api/agents/:agentId/vault/notes/:filename
  app.delete('/api/agents/:agentId/vault/notes/:filename', async (req, reply) => {
    const { agentId, filename } = req.params as { agentId: string; filename: string };
    const agent = store.getAgent(agentId);
    if (!agent) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Agent not found');

    const deleted = deleteNote(agent.vaultPath, filename);
    if (!deleted) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Note not found');

    // Invalidate index so next query rebuilds without this note
    invalidateIndex(agentId);

    reply.code(204);
    return '';
  });
}

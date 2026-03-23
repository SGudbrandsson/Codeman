/**
 * @fileoverview Vault capture and retrieval routes.
 *
 * Agent CRUD lives in agent-routes.ts. These routes handle vault operations:
 *   POST   /api/agents/:agentId/vault/capture    → { filename, noteCount }
 *   GET    /api/agents/:agentId/vault/query      → VaultQueryResult[]  (?q=&limit=5)
 *   GET    /api/agents/:agentId/vault/notes      → { notes: VaultNote[], total: number }
 *   DELETE /api/agents/:agentId/vault/notes/:filename → 204
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { capture, query } from '../../vault/index.js';
import { listNotes, deleteNote, countNotes } from '../../vault/store.js';
import { invalidateIndex } from '../../vault/search.js';
import type { ConfigPort } from '../ports/index.js';

export function registerVaultRoutes(app: FastifyInstance, ctx: ConfigPort): void {
  const { store } = ctx;

  // ═══════════════════════════════════════════════════════════════
  // Vault routes (Agent CRUD lives in agent-routes.ts)
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

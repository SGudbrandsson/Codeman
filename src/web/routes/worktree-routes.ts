/**
 * @fileoverview Dormant worktree management routes.
 *
 * GET    /api/worktrees            — list dormant worktrees
 * POST   /api/worktrees            — save a worktree as dormant ("Keep" action)
 * POST   /api/worktrees/:id/resume — resume a dormant worktree (spawn new session)
 * DELETE /api/worktrees/:id        — remove dormant entry (and optionally disk)
 */

import { FastifyInstance } from 'fastify';
import { Session } from '../../session.js';
import { SseEvent } from '../sse-events.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getWorktreeStore } from '../../worktree-store.js';
import { findGitRoot, removeWorktree } from '../../utils/git-utils.js';
import { SaveDormantWorktreeSchema, DeleteDormantWorktreeSchema } from '../schemas.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../ports/index.js';

export function registerWorktreeRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort & InfraPort
): void {
  const store = getWorktreeStore();

  // GET /api/worktrees
  app.get('/api/worktrees', async () => {
    return { success: true, worktrees: store.getAll() };
  });

  // POST /api/worktrees — save dormant
  app.post('/api/worktrees', async (req) => {
    const parsed = SaveDormantWorktreeSchema.safeParse(req.body);
    if (!parsed.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    const entry = store.add(parsed.data);
    return { success: true, worktree: entry };
  });

  // POST /api/worktrees/:id/resume
  app.post('/api/worktrees/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    const entry = store.get(id);
    if (!entry) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Dormant worktree not found');

    const [globalNice, modelConfig, claudeModeConfig] = await Promise.all([
      ctx.getGlobalNiceConfig(),
      ctx.getModelConfig(),
      ctx.getClaudeModeConfig(),
    ]);

    const session = new Session({
      workingDir: entry.path,
      name: entry.branch,
      mux: ctx.mux,
      useMux: true,
      niceConfig: globalNice,
      model: modelConfig?.defaultModel,
      claudeMode: claudeModeConfig.claudeMode,
      allowedTools: claudeModeConfig.allowedTools,
      worktreePath: entry.path,
      worktreeBranch: entry.branch,
      worktreeOriginId: entry.originSessionId,
    });

    ctx.addSession(session);
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    store.remove(id);

    const lightState = ctx.getSessionStateWithRespawn(session);
    ctx.broadcast(SseEvent.SessionCreated, lightState);
    return { success: true, session: lightState };
  });

  // DELETE /api/worktrees/:id
  app.delete('/api/worktrees/:id', async (req) => {
    const { id } = req.params as { id: string };
    const entry = store.get(id);
    if (!entry) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Dormant worktree not found');

    const parsed = DeleteDormantWorktreeSchema.safeParse(req.body);
    const removeDisk = parsed.success ? (parsed.data.removeDisk ?? false) : false;

    if (removeDisk) {
      const gitRoot = findGitRoot(entry.path);
      if (gitRoot) {
        try {
          await removeWorktree(gitRoot, entry.path, true);
        } catch {
          /* best-effort */
        }
      }
    }

    store.remove(id);
    return { success: true };
  });
}

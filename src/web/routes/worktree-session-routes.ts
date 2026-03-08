/**
 * @fileoverview Session-scoped worktree routes.
 *
 * GET    /api/sessions/:id/worktree/branches  — list branches
 * POST   /api/sessions/:id/worktree           — create worktree + new session
 * POST   /api/sessions/:id/worktree/merge     — merge branch into session's dir
 * DELETE /api/sessions/:id/worktree           — remove worktree from disk
 */

import { FastifyInstance } from 'fastify';
import { dirname, join } from 'node:path';
import { Session } from '../../session.js';
import { SseEvent } from '../sse-events.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { CreateWorktreeSchema, RemoveWorktreeSchema, MergeWorktreeSchema } from '../schemas.js';
import {
  findGitRoot,
  listBranches,
  getCurrentBranch,
  addWorktree,
  removeWorktree,
  isWorktreeDirty,
  mergeBranch,
} from '../../utils/git-utils.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../ports/index.js';

// Validate branch name: alphanumeric, dots, hyphens, forward slashes only
const BRANCH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

export function registerWorktreeSessionRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort & InfraPort
): void {
  // GET /api/sessions/:id/worktree/branches
  app.get('/api/sessions/:id/worktree/branches', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);
    if (!session) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');

    const gitRoot = findGitRoot(session.workingDir);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Not a git repository');

    try {
      const [branches, current] = await Promise.all([listBranches(gitRoot), getCurrentBranch(gitRoot)]);
      return { success: true, branches, current };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `git error: ${String(err)}`);
    }
  });

  // POST /api/sessions/:id/worktree
  app.post('/api/sessions/:id/worktree', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);
    if (!session) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');

    const parsed = CreateWorktreeSchema.safeParse(req.body);
    if (!parsed.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');

    const { branch, isNew } = parsed.data;
    if (!BRANCH_PATTERN.test(branch)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid branch name');
    }

    const gitRoot = findGitRoot(session.workingDir);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Not a git repository');

    const projectName = gitRoot.split('/').pop() ?? 'project';
    const safeBranch = branch.replace(/\//g, '-');
    const worktreePath = join(dirname(gitRoot), `${projectName}-${safeBranch}`);

    try {
      await addWorktree(gitRoot, worktreePath, branch, isNew);
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create worktree: ${String(err)}`);
    }

    const [globalNice, modelConfig, claudeModeConfig] = await Promise.all([
      ctx.getGlobalNiceConfig(),
      ctx.getModelConfig(),
      ctx.getClaudeModeConfig(),
    ]);

    const newSession = new Session({
      workingDir: worktreePath,
      mode: session.mode,
      name: branch,
      mux: ctx.mux,
      useMux: true,
      niceConfig: globalNice,
      model: modelConfig?.defaultModel,
      claudeMode: claudeModeConfig.claudeMode,
      allowedTools: claudeModeConfig.allowedTools,
      worktreePath,
      worktreeBranch: branch,
      worktreeOriginId: id,
    });

    ctx.addSession(newSession);
    ctx.persistSessionState(newSession);
    await ctx.setupSessionListeners(newSession);

    const lightState = ctx.getSessionStateWithRespawn(newSession);
    ctx.broadcast(SseEvent.SessionCreated, lightState);
    return { success: true, session: lightState, worktreePath };
  });

  // POST /api/sessions/:id/worktree/merge
  app.post('/api/sessions/:id/worktree/merge', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);
    if (!session) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');

    const parsed = MergeWorktreeSchema.safeParse(req.body);
    if (!parsed.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    if (!BRANCH_PATTERN.test(parsed.data.branch)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid branch name');
    }

    try {
      const output = await mergeBranch(session.workingDir, parsed.data.branch);
      return { success: true, output };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Merge failed: ${String(err)}`);
    }
  });

  // DELETE /api/sessions/:id/worktree
  app.delete('/api/sessions/:id/worktree', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);
    if (!session) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    if (!session.worktreePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Session is not a worktree session');
    }

    const parsed = RemoveWorktreeSchema.safeParse(req.body);
    const force = parsed.success ? (parsed.data.force ?? false) : false;

    const originSession = session.worktreeOriginId ? ctx.sessions.get(session.worktreeOriginId) : undefined;
    const gitRoot = findGitRoot(originSession?.workingDir ?? session.worktreePath ?? session.workingDir);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Cannot find git root');

    if (!force) {
      const dirty = await isWorktreeDirty(session.worktreePath);
      if (dirty) {
        return {
          success: false,
          dirty: true,
          message: 'Worktree has uncommitted changes. Pass force:true to remove anyway.',
        };
      }
    }

    try {
      await removeWorktree(gitRoot, session.worktreePath, force);
      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to remove worktree: ${String(err)}`);
    }
  });
}

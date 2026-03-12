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
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { Session } from '../../session.js';
import { SseEvent } from '../sse-events.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { CreateWorktreeSchema, RemoveWorktreeSchema, MergeWorktreeSchema } from '../schemas.js';
import {
  findGitRoot,
  isGitWorktreeDir,
  listBranches,
  getCurrentBranch,
  addWorktree,
  removeWorktree,
  isWorktreeDirty,
  mergeBranch,
} from '../../utils/git-utils.js';
import { CASES_DIR } from '../route-helpers.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import { detectPortsFromDir, allocateNextPort } from '../../utils/port-detection.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../ports/index.js';

// Validate branch name: alphanumeric, dots, hyphens, forward slashes only
const BRANCH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

async function resolveCasePath(name: string): Promise<string | null> {
  let linkedPath: string | null = null;
  try {
    const linked: Record<string, string> = JSON.parse(
      await fs.readFile(join(homedir(), '.codeman', 'linked-cases.json'), 'utf-8')
    );
    if (linked[name] && existsSync(linked[name])) linkedPath = linked[name];
  } catch {
    /* linked-cases.json not found or invalid */
  }

  const caseDirPath = join(CASES_DIR, name);
  if (existsSync(caseDirPath)) {
    // Prefer linked path when CASES_DIR entry has no git repo but linked one does
    if (linkedPath && !findGitRoot(caseDirPath) && findGitRoot(linkedPath)) return linkedPath;
    return caseDirPath;
  }

  return linkedPath;
}

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
      return { success: true, branches, current, isWorktree: isGitWorktreeDir(session.workingDir) };
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

    const { branch, isNew, mode, notes, autoStart } = parsed.data;
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

    const [[globalNice, modelConfig, claudeModeConfig], basePorts] = await Promise.all([
      Promise.all([ctx.getGlobalNiceConfig(), ctx.getModelConfig(), ctx.getClaudeModeConfig()]),
      detectPortsFromDir(gitRoot),
    ]);

    const usedPorts = [...ctx.sessions.values()]
      .filter((s) => s.worktreePath && s.worktreePath.startsWith(dirname(gitRoot)))
      .map((s) => s.assignedPort)
      .filter((p): p is number => p !== undefined);
    const assignedPort = allocateNextPort(basePorts, usedPorts) ?? undefined;

    const finalNotes = assignedPort
      ? `${notes ? notes + '\n\n' : ''}Assigned dev port for this worktree: ${assignedPort}. Start the dev server with --port ${assignedPort} (or set PORT=${assignedPort}).`
      : notes;

    const newSession = new Session({
      workingDir: worktreePath,
      mode: mode ?? session.mode,
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
      worktreeNotes: finalNotes,
      assignedPort,
    });

    ctx.addSession(newSession);
    ctx.persistSessionState(newSession);
    await ctx.setupSessionListeners(newSession);

    const lightState = ctx.getSessionStateWithRespawn(newSession);
    ctx.broadcast(SseEvent.SessionCreated, lightState);

    if (autoStart) {
      try {
        if (newSession.mode === 'shell') {
          await newSession.startShell();
          getLifecycleLog().log({ event: 'started', sessionId: newSession.id, name: newSession.name, mode: 'shell' });
          ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: 'shell' });
        } else {
          await newSession.startInteractive();
          getLifecycleLog().log({
            event: 'started',
            sessionId: newSession.id,
            name: newSession.name,
            mode: newSession.mode,
          });
          ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: newSession.mode });
        }
        ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(newSession) });
      } catch (err) {
        console.error(`[worktree] autoStart failed for session ${newSession.id}:`, err);
      }
    }

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

    // Check if the worktree session for this branch has uncommitted changes — if so,
    // git merge will say "already up to date" and the user will be confused.
    const worktreeSession = [...ctx.sessions.values()].find(
      (s) => s.worktreeOriginId === id && s.worktreeBranch === parsed.data.branch
    );
    if (worktreeSession?.worktreePath) {
      const dirty = await isWorktreeDirty(worktreeSession.worktreePath);
      if (dirty) {
        return {
          success: false,
          uncommittedChanges: true,
          message: 'Worktree has uncommitted changes — commit them inside the worktree session first, then merge.',
        };
      }
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

    // If the directory is already gone, we can skip git worktree remove and just clean up
    const dirGone = !existsSync(session.worktreePath);
    if (!dirGone) {
      try {
        await removeWorktree(gitRoot, session.worktreePath, force);
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to remove worktree: ${String(err)}`);
      }
    }
    // Close the session now that the worktree directory is gone
    await ctx.cleanupSession(id, true, 'worktree_deleted');
    return { success: true };
  });

  // GET /api/cases/:name/worktree/branches
  app.get('/api/cases/:name/worktree/branches', async (req) => {
    const { name } = req.params as { name: string };
    const casePath = await resolveCasePath(name);
    if (!casePath) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
    const gitRoot = findGitRoot(casePath);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Not a git repository');
    try {
      const [branches, current] = await Promise.all([listBranches(gitRoot), getCurrentBranch(gitRoot)]);
      return { success: true, branches, current };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `git error: ${String(err)}`);
    }
  });

  // POST /api/cases/:name/worktree
  app.post('/api/cases/:name/worktree', async (req) => {
    const { name } = req.params as { name: string };
    const casePath = await resolveCasePath(name);
    if (!casePath) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found');
    const parsed = CreateWorktreeSchema.safeParse(req.body);
    if (!parsed.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    const { branch, isNew, mode, notes, autoStart } = parsed.data;
    if (!BRANCH_PATTERN.test(branch)) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid branch name');
    const gitRoot = findGitRoot(casePath);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Not a git repository');
    const projectName = gitRoot.split('/').pop() ?? 'project';
    const worktreePath = join(dirname(gitRoot), `${projectName}-${branch.replace(/\//g, '-')}`);
    try {
      await addWorktree(gitRoot, worktreePath, branch, isNew);
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create worktree: ${String(err)}`);
    }
    const [[globalNice, modelConfig, claudeModeConfig], basePorts] = await Promise.all([
      Promise.all([ctx.getGlobalNiceConfig(), ctx.getModelConfig(), ctx.getClaudeModeConfig()]),
      detectPortsFromDir(gitRoot),
    ]);
    const usedPorts = [...ctx.sessions.values()]
      .filter((s) => s.worktreePath && s.worktreePath.startsWith(dirname(gitRoot)))
      .map((s) => s.assignedPort)
      .filter((p): p is number => p !== undefined);
    const assignedPort = allocateNextPort(basePorts, usedPorts) ?? undefined;
    const finalNotes = assignedPort
      ? `${notes ? notes + '\n\n' : ''}Assigned dev port for this worktree: ${assignedPort}. Start the dev server with --port ${assignedPort} (or set PORT=${assignedPort}).`
      : notes;
    const newSession = new Session({
      workingDir: worktreePath,
      mode: mode ?? 'claude',
      name: branch,
      mux: ctx.mux,
      useMux: true,
      niceConfig: globalNice,
      model: modelConfig?.defaultModel,
      claudeMode: claudeModeConfig.claudeMode,
      allowedTools: claudeModeConfig.allowedTools,
      worktreePath,
      worktreeBranch: branch,
      worktreeNotes: finalNotes,
      assignedPort,
    });
    ctx.addSession(newSession);
    ctx.persistSessionState(newSession);
    await ctx.setupSessionListeners(newSession);
    const lightState = ctx.getSessionStateWithRespawn(newSession);
    ctx.broadcast(SseEvent.SessionCreated, lightState);

    if (autoStart) {
      try {
        if (newSession.mode === 'shell') {
          await newSession.startShell();
          getLifecycleLog().log({ event: 'started', sessionId: newSession.id, name: newSession.name, mode: 'shell' });
          ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: 'shell' });
        } else {
          await newSession.startInteractive();
          getLifecycleLog().log({
            event: 'started',
            sessionId: newSession.id,
            name: newSession.name,
            mode: newSession.mode,
          });
          ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: newSession.mode });
        }
        ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(newSession) });
      } catch (err) {
        console.error(`[worktree] autoStart failed for session ${newSession.id}:`, err);
      }
    }

    return { success: true, session: lightState, worktreePath };
  });
}

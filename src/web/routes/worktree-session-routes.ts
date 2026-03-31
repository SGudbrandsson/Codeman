/**
 * @fileoverview Session-scoped worktree routes.
 *
 * GET    /api/sessions/:id/worktree/branches  — list branches
 * POST   /api/sessions/cleanup-orphans        — detect and remove orphaned worktrees
 * POST   /api/sessions/:id/worktree           — create worktree + new session
 * POST   /api/sessions/:id/worktree/merge     — merge branch into session's dir
 * DELETE /api/sessions/:id/worktree           — remove worktree from disk
 */

import { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { Session } from '../../session.js';
import { SseEvent } from '../sse-events.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { CreateWorktreeSchema, RemoveWorktreeSchema, MergeWorktreeSchema, CleanupOrphansSchema } from '../schemas.js';
import {
  findGitRoot,
  findMainGitRoot,
  isGitWorktreeDir,
  listBranches,
  getCurrentBranch,
  addWorktree,
  setupWorktreeArtifacts,
  removeWorktree,
  isWorktreeDirty,
  mergeBranch,
  checkBranchExists,
  isBranchMerged,
  deleteBranch,
  listGitWorktrees,
  pruneWorktrees,
} from '../../utils/git-utils.js';
import { CASES_DIR } from '../route-helpers.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import { detectPortsFromDir, allocateNextPort } from '../../utils/port-detection.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../ports/index.js';
import { getWorktreeStore } from '../../worktree-store.js';

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

/**
 * Check for branch collision before addWorktree().
 * Returns { collision: false } if safe to proceed.
 * Returns { collision: true, response } with a structured error if blocked.
 * If the branch exists but is merged, auto-cleans it and returns { collision: false }.
 */
async function handleBranchCollision(
  gitRoot: string,
  branch: string,
  worktreePath: string,
  log: FastifyBaseLogger
): Promise<{ collision: true; response: object } | { collision: false }> {
  const exists = await checkBranchExists(gitRoot, branch);
  if (!exists) return { collision: false };

  const merged = await isBranchMerged(gitRoot, branch);
  if (merged) {
    log.info({ gitRoot, branch, worktreePath }, '[worktree-collision] branch is merged — auto-cleaning stale branch');
    try {
      await removeWorktree(gitRoot, worktreePath, true);
    } catch {
      // Ignore errors if directory doesn't exist or is already gone
    }
    try {
      await deleteBranch(gitRoot, branch, false);
    } catch (err) {
      log.warn({ err, branch }, '[worktree-collision] failed to delete merged branch, continuing');
    }
    return { collision: false };
  }

  // Branch exists and is NOT merged — block creation
  log.info({ gitRoot, branch }, '[worktree-collision] branch exists unmerged — blocking creation');
  return {
    collision: true,
    response: {
      success: false,
      errorCode: ApiErrorCode.ALREADY_EXISTS,
      error: `BRANCH_EXISTS_UNMERGED: branch ${branch} already exists and has unmerged commits`,
      branch,
    },
  };
}

export interface OrphanResult {
  removed: Array<{ path: string; branch: string; reason: string }>;
  warnings: Array<{ path: string; branch: string | null; reason: string }>;
  errors: Array<{ path: string; error: string }>;
}

/**
 * Scan git worktrees for orphans (no active session and no dormant store entry).
 * Merged orphans are removed; unmerged orphans generate warnings.
 */
export async function runOrphanCleanup(
  gitRoot: string,
  activeSessions: ReadonlyMap<string, Session>,
  log: {
    info: (msg: string, ctx?: object) => void;
    warn: (msg: string, ctx?: object) => void;
    error: (msg: string, ctx?: object) => void;
  }
): Promise<OrphanResult> {
  const result: OrphanResult = { removed: [], warnings: [], errors: [] };

  let worktrees;
  try {
    worktrees = await listGitWorktrees(gitRoot);
  } catch (err) {
    result.errors.push({ path: gitRoot, error: `Failed to list worktrees: ${String(err)}` });
    return result;
  }

  const dormantStore = getWorktreeStore();
  const dormantPaths = new Set(dormantStore.getAll().map((w) => w.path));
  const activePaths = new Set([...activeSessions.values()].map((s) => s.worktreePath).filter(Boolean) as string[]);

  for (const wt of worktrees) {
    if (wt.isMain) continue;

    if (activePaths.has(wt.path)) continue; // tracked by active session
    if (dormantPaths.has(wt.path)) continue; // tracked by dormant store

    // Orphan found
    if (wt.branch == null) {
      result.warnings.push({ path: wt.path, branch: null, reason: 'orphan worktree with detached HEAD (no branch)' });
      continue;
    }

    let merged = false;
    try {
      merged = await isBranchMerged(gitRoot, wt.branch);
    } catch (err) {
      result.errors.push({ path: wt.path, error: `Failed to check merge status: ${String(err)}` });
      continue;
    }

    if (merged) {
      try {
        await removeWorktree(gitRoot, wt.path, true);
        await deleteBranch(gitRoot, wt.branch, false);
        await pruneWorktrees(gitRoot);
        log.info(`[orphan-cleanup] removed merged orphan: ${wt.path} (${wt.branch})`);
        result.removed.push({ path: wt.path, branch: wt.branch, reason: 'orphan worktree with merged branch' });
      } catch (err) {
        result.errors.push({ path: wt.path, error: `Failed to remove orphan: ${String(err)}` });
      }
    } else {
      log.warn(`[orphan-cleanup] unmerged orphan found: ${wt.path} (${wt.branch})`);
      result.warnings.push({ path: wt.path, branch: wt.branch, reason: 'orphan worktree with unmerged branch' });
    }
  }

  return result;
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

  // POST /api/sessions/cleanup-orphans — MUST be before /:id routes
  app.post('/api/sessions/cleanup-orphans', async (req) => {
    const parsed = CleanupOrphansSchema.safeParse(req.body);
    if (!parsed.success)
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body: repoDir required');

    const { repoDir } = parsed.data;
    const gitRoot = findGitRoot(repoDir);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Not a git repository');

    try {
      const result = await runOrphanCleanup(gitRoot, ctx.sessions, req.log);
      return { success: true, ...result };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Orphan cleanup failed: ${String(err)}`);
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

    const resolvedMode = mode ?? session.mode;
    const gitRoot = findGitRoot(session.workingDir);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Not a git repository');

    const projectName = gitRoot.split('/').pop() ?? 'project';
    const safeBranch = branch.replace(/\//g, '-');
    const worktreePath = join(dirname(gitRoot), `${projectName}-${safeBranch}`);

    // Fire-and-forget orphan cleanup pre-flight
    runOrphanCleanup(gitRoot, ctx.sessions, req.log).catch(() => {});

    // Collision detection (only for new branches)
    if (isNew) {
      try {
        const collision = await handleBranchCollision(gitRoot, branch, worktreePath, req.log);
        if (collision.collision) return collision.response;
      } catch (err) {
        req.log.warn({ err, branch }, '[worktree] collision check failed, proceeding');
      }
    }

    try {
      await addWorktree(gitRoot, worktreePath, branch, isNew);
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create worktree: ${String(err)}`);
    }

    try {
      await setupWorktreeArtifacts(gitRoot, worktreePath);
    } catch (err) {
      req.log.warn({ err, worktreePath }, '[worktree] setupWorktreeArtifacts failed — continuing');
    }

    const [[globalNice, modelConfig, claudeModeConfig], basePorts] = await Promise.all([
      Promise.all([ctx.getGlobalNiceConfig(), ctx.getModelConfig(), ctx.getClaudeModeConfig()]),
      detectPortsFromDir(gitRoot),
    ]);

    const usedPorts = [...ctx.sessions.values()]
      .filter((s) => s.worktreePath && s.worktreePath.startsWith(dirname(gitRoot)))
      .map((s) => s.assignedPort)
      .filter((p): p is number => p !== undefined);
    const assignedPort = (await allocateNextPort(basePorts, usedPorts)) ?? undefined;

    const finalNotes = assignedPort
      ? `${notes ? notes + '\n\n' : ''}Assigned dev port for this worktree: ${assignedPort}. Start the dev server with --port ${assignedPort} (or set PORT=${assignedPort}).`
      : notes;

    const newSession = new Session({
      workingDir: worktreePath,
      mode: resolvedMode,
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

    let lightState = ctx.getSessionStateWithRespawn(newSession);
    ctx.broadcast(SseEvent.SessionCreated, lightState);

    if (autoStart) {
      try {
        if (resolvedMode === 'shell') {
          await newSession.startShell();
          getLifecycleLog().log({ event: 'started', sessionId: newSession.id, name: newSession.name, mode: 'shell' });
          ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: 'shell' });
        } else {
          await newSession.startInteractive();
          getLifecycleLog().log({
            event: 'started',
            sessionId: newSession.id,
            name: newSession.name,
            mode: resolvedMode,
          });
          ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: resolvedMode });
        }
        lightState = ctx.getSessionStateWithRespawn(newSession);
        ctx.broadcast(SseEvent.SessionUpdated, { session: lightState });

        // Send notes as the first prompt if provided
        if (notes && resolvedMode !== 'shell') {
          // Wait for the session to fully initialize before sending input
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const noteInput = notes + '\r';
          const sent = await newSession.writeViaMux(noteInput);
          if (!sent) {
            req.log.warn({ sessionId: newSession.id }, '[worktree] autoStart: failed to send notes as first prompt');
          }
        }
      } catch (err) {
        req.log.error({ err, sessionId: newSession.id }, '[worktree] autoStart failed');
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

    const { branch } = parsed.data;

    // Check if the worktree session for this branch has uncommitted changes — if so,
    // git merge will say "already up to date" and the user will be confused.
    // Primary lookup: by origin ID + branch (reliable for sessions created via the UI).
    // Fallback: by branch alone for sessions that lack worktreeOriginId (e.g. auto-detected
    // on server restart from old state.json, or started outside the Codeman worktree UI).
    const worktreeSession =
      [...ctx.sessions.values()].find((s) => s.worktreeOriginId === id && s.worktreeBranch === branch) ??
      [...ctx.sessions.values()].find((s) => s.worktreeBranch === branch && s.worktreePath != null);
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

    // Resolve the main repo root (not a worktree dir) so `git merge` runs from master,
    // not from the feature branch worktree (which would be "already up to date" with itself).
    const mainGitRoot = await findMainGitRoot(session.workingDir);
    if (!mainGitRoot) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Could not resolve main git repository root');
    }

    // Safety check: ensure the main repo is on master/main before merging.
    // If someone has checked out a different branch in the main repo, merging there would
    // silently corrupt that branch instead of master.
    const mainBranch = await getCurrentBranch(mainGitRoot);
    if (mainBranch === 'HEAD') {
      return createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        'Main repo is in detached HEAD state — check out master or main first'
      );
    }
    if (mainBranch !== 'master' && mainBranch !== 'main') {
      return createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        `Main repo HEAD is on "${mainBranch}", not master/main — cannot merge safely`
      );
    }

    let output: string;
    try {
      output = await mergeBranch(mainGitRoot, branch);
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Merge failed: ${String(err)}`);
    }

    // Guard: if git reported a no-op, check whether the branch was already merged.
    // Matches both "Already up to date." (modern git) and "Already up-to-date." (older git).
    const isNoOp = /already up[\s-]to[\s-]date/i.test(output);
    let alreadyMerged = false;
    if (isNoOp) {
      // Pass mainBranch so isBranchMerged skips the master→main fallback when we already know.
      alreadyMerged = await isBranchMerged(mainGitRoot, branch, mainBranch);
      if (alreadyMerged) {
        // Branch is genuinely merged — treat as success and let cleanup proceed normally.
        req.log.info({ branch }, '[worktree-merge] branch already merged, proceeding to cleanup');
      } else {
        // No-op but branch is not merged — commits may be missing. Abort to prevent data loss.
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Merge was a no-op but branch is not merged into master — commits may be missing. Aborting cleanup to prevent data loss.'
        );
      }
    }

    // Post-merge auto-cleanup — fire-and-forget (response is sent before cleanup completes).
    const worktreePath = worktreeSession?.worktreePath;
    (async () => {
      try {
        if (worktreeSession) {
          req.log.info({ sessionId: worktreeSession.id }, '[worktree-merge-cleanup] cleaning up worktree session');
          await ctx.cleanupSession(worktreeSession.id, true, 'merged');
        }
        if (worktreePath) {
          try {
            await removeWorktree(mainGitRoot, worktreePath, false);
            req.log.info({ worktreePath }, '[worktree-merge-cleanup] removed worktree directory');
          } catch {
            // May already be gone — not an error
          }
        }
        try {
          await deleteBranch(mainGitRoot, branch, false);
          req.log.info({ branch }, '[worktree-merge-cleanup] deleted branch');
        } catch (err) {
          req.log.warn(
            { err, branch },
            '[worktree-merge-cleanup] failed to delete branch (may be checked out elsewhere)'
          );
        }
        // Remove from dormant store if present
        const store = getWorktreeStore();
        const dormant = store
          .getAll()
          .find((w) => w.branch === branch && (worktreePath ? w.path === worktreePath : true));
        if (dormant) {
          store.remove(dormant.id);
          req.log.info({ dormantId: dormant.id, branch }, '[worktree-merge-cleanup] removed dormant store entry');
        }
      } catch (err) {
        req.log.error({ err, branch }, '[worktree-merge-cleanup] unexpected error during post-merge cleanup');
      }
    })().catch((err) => {
      req.log.error({ err, branch }, '[worktree-merge-cleanup] unhandled cleanup error');
    });

    return {
      success: true,
      output,
      cleaned: !!(worktreeSession || worktreePath),
      ...(alreadyMerged && { alreadyMerged: true }),
    };
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
    const resolvedMode = mode ?? 'claude';
    const gitRoot = findGitRoot(casePath);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Not a git repository');
    const projectName = gitRoot.split('/').pop() ?? 'project';
    const worktreePath = join(dirname(gitRoot), `${projectName}-${branch.replace(/\//g, '-')}`);

    // Fire-and-forget orphan cleanup pre-flight
    runOrphanCleanup(gitRoot, ctx.sessions, req.log).catch(() => {});

    // Collision detection (only for new branches)
    if (isNew) {
      try {
        const collision = await handleBranchCollision(gitRoot, branch, worktreePath, req.log);
        if (collision.collision) return collision.response;
      } catch (err) {
        req.log.warn({ err, branch }, '[worktree] collision check failed, proceeding');
      }
    }

    try {
      await addWorktree(gitRoot, worktreePath, branch, isNew);
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create worktree: ${String(err)}`);
    }
    try {
      await setupWorktreeArtifacts(gitRoot, worktreePath);
    } catch (err) {
      req.log.warn({ err, worktreePath }, '[worktree] setupWorktreeArtifacts failed — continuing');
    }
    const [[globalNice, modelConfig, claudeModeConfig], basePorts] = await Promise.all([
      Promise.all([ctx.getGlobalNiceConfig(), ctx.getModelConfig(), ctx.getClaudeModeConfig()]),
      detectPortsFromDir(gitRoot),
    ]);
    const usedPorts = [...ctx.sessions.values()]
      .filter((s) => s.worktreePath && s.worktreePath.startsWith(dirname(gitRoot)))
      .map((s) => s.assignedPort)
      .filter((p): p is number => p !== undefined);
    const assignedPort = (await allocateNextPort(basePorts, usedPorts)) ?? undefined;
    const finalNotes = assignedPort
      ? `${notes ? notes + '\n\n' : ''}Assigned dev port for this worktree: ${assignedPort}. Start the dev server with --port ${assignedPort} (or set PORT=${assignedPort}).`
      : notes;
    const newSession = new Session({
      workingDir: worktreePath,
      mode: resolvedMode,
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
    let lightState = ctx.getSessionStateWithRespawn(newSession);
    ctx.broadcast(SseEvent.SessionCreated, lightState);

    if (autoStart) {
      try {
        if (resolvedMode === 'shell') {
          await newSession.startShell();
          getLifecycleLog().log({ event: 'started', sessionId: newSession.id, name: newSession.name, mode: 'shell' });
          ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: 'shell' });
        } else {
          await newSession.startInteractive();
          getLifecycleLog().log({
            event: 'started',
            sessionId: newSession.id,
            name: newSession.name,
            mode: resolvedMode,
          });
          ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: resolvedMode });
        }
        lightState = ctx.getSessionStateWithRespawn(newSession);
        ctx.broadcast(SseEvent.SessionUpdated, { session: lightState });

        // Send notes as the first prompt if provided
        if (notes && resolvedMode !== 'shell') {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const noteInput = notes + '\r';
          const sent = await newSession.writeViaMux(noteInput);
          if (!sent) {
            req.log.warn({ sessionId: newSession.id }, '[worktree] autoStart: failed to send notes as first prompt');
          }
        }
      } catch (err) {
        req.log.error({ err, sessionId: newSession.id }, '[worktree] autoStart failed');
      }
    }

    return { success: true, session: lightState, worktreePath };
  });
}

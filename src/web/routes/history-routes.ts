/**
 * @fileoverview Session history routes — resume previously closed sessions.
 *
 * GET  /api/sessions/history   — list closed sessions from lifecycle log + JSONL scan
 * POST /api/sessions/resume    — create a new session resuming a prior conversation
 *
 * @module history-routes
 */

import { FastifyInstance } from 'fastify';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Session } from '../../session.js';
import { SseEvent } from '../sse-events.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { ResumeClosedSessionSchema } from '../schemas.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../ports/index.js';

/** Maximum JSONL files to scan across all project dirs */
const MAX_SCAN_ENTRIES = 100;
/** Maximum lifecycle log lines to read from the end */
const MAX_LIFECYCLE_LINES = 500;
/** UUID v4 regex */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A single entry in the session history list */
export interface ClosedSessionEntry {
  resumeId: string;
  workingDir: string;
  displayName: string;
  lastActiveAt: number;
  worktreeBranch?: string;
  source: 'lifecycle' | 'scan';
}

/**
 * Decode an escaped project dir name back to an approximate path.
 * Claude escapes the workingDir by replacing '/' with '-'.
 * This is a lossy reverse — hyphens in dir names and '/' both become '-'.
 * The leading '-' in the escaped name already decodes to the leading '/', so
 * no prefix is needed.
 */
function decodeProjectDir(escapedDir: string): string {
  // Claude escapes: replace each '/' with '-', so '-home-user-project' → '/home/user/project'
  // The leading '-' already becomes the leading '/', so just replace all '-' with '/'.
  return escapedDir.replace(/-/g, '/');
}

/**
 * Get the set of currently active claudeResumeIds and workingDirs.
 */
function getActiveSets(sessions: ReadonlyMap<string, Session>): {
  activeResumeIds: Set<string>;
  activeWorkingDirs: Set<string>;
} {
  const activeResumeIds = new Set<string>();
  const activeWorkingDirs = new Set<string>();
  for (const s of sessions.values()) {
    if (s.claudeResumeId) activeResumeIds.add(s.claudeResumeId);
    if (s.workingDir) activeWorkingDirs.add(s.workingDir);
  }
  return { activeResumeIds, activeWorkingDirs };
}

/**
 * Build history from lifecycle log (last MAX_LIFECYCLE_LINES lines).
 * Returns a map of resumeId → ClosedSessionEntry for entries with a valid claudeResumeId.
 */
async function buildLifecycleEntries(activeResumeIds: Set<string>): Promise<Map<string, ClosedSessionEntry>> {
  const entries = new Map<string, ClosedSessionEntry>();

  // Use query() with no event filter, limit to MAX_LIFECYCLE_LINES
  const log = getLifecycleLog();
  const all = await log.query({ limit: MAX_LIFECYCLE_LINES });

  // all is returned newest-first; deduplicate by sessionId (keep latest event per session)
  const seenSessionIds = new Set<string>();

  for (const entry of all) {
    // Only care about deleted/detached events
    if (entry.event !== 'deleted' && entry.event !== 'detached') continue;
    if (seenSessionIds.has(entry.sessionId)) continue;
    seenSessionIds.add(entry.sessionId);

    const resumeId = entry.extra?.claudeResumeId as string | undefined;
    if (!resumeId || typeof resumeId !== 'string' || !UUID_PATTERN.test(resumeId)) continue;
    if (activeResumeIds.has(resumeId)) continue;

    const workingDir = entry.extra?.workingDir as string | undefined;
    if (!workingDir || typeof workingDir !== 'string') continue;

    const worktreeBranch = entry.extra?.worktreeBranch as string | undefined;
    const displayName =
      (entry.name && entry.name.length > 0 ? entry.name : null) ?? workingDir.split('/').pop() ?? workingDir;

    entries.set(resumeId, {
      resumeId,
      workingDir,
      displayName,
      lastActiveAt: entry.ts,
      worktreeBranch: worktreeBranch || undefined,
      source: 'lifecycle',
    });
  }

  return entries;
}

/**
 * Scan ~/.claude/projects/ for JSONL files not already covered by lifecycle entries.
 * Returns at most MAX_SCAN_ENTRIES total entries.
 */
async function buildScanEntries(
  existingResumeIds: Set<string>,
  activeResumeIds: Set<string>
): Promise<ClosedSessionEntry[]> {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  const results: ClosedSessionEntry[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(claudeProjectsDir);
  } catch {
    return results;
  }

  // Collect all JSONL file entries with mtime
  const candidates: { filePath: string; escapedDir: string; mtime: number; uuid: string }[] = [];

  for (const escapedDir of projectDirs) {
    const projectPath = join(claudeProjectsDir, escapedDir);
    try {
      const stat = statSync(projectPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    let files: string[];
    try {
      files = readdirSync(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const uuid = file.slice(0, -6); // strip .jsonl
      if (!UUID_PATTERN.test(uuid)) continue;
      if (existingResumeIds.has(uuid) || activeResumeIds.has(uuid)) continue;

      const filePath = join(projectPath, file);
      try {
        const stat = statSync(filePath);
        candidates.push({ filePath, escapedDir, mtime: stat.mtimeMs, uuid });
      } catch {
        // Skip inaccessible files
      }
    }
  }

  // Sort by mtime descending (most recent first)
  candidates.sort((a, b) => b.mtime - a.mtime);

  // Take up to MAX_SCAN_ENTRIES
  for (const c of candidates.slice(0, MAX_SCAN_ENTRIES)) {
    const workingDir = decodeProjectDir(c.escapedDir);
    const displayName = workingDir.split('/').pop() ?? workingDir;
    results.push({
      resumeId: c.uuid,
      workingDir,
      displayName,
      lastActiveAt: c.mtime,
      source: 'scan',
    });
  }

  return results;
}

export function registerHistoryRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort & InfraPort
): void {
  // GET /api/sessions/history
  app.get('/api/sessions/history', async () => {
    const { activeResumeIds } = getActiveSets(ctx.sessions);

    // Source 1: lifecycle log entries (have workingDir + resumeId from extra)
    const lifecycleEntries = await buildLifecycleEntries(activeResumeIds);

    // Source 2: JSONL filesystem scan (fills in sessions without lifecycle data)
    const allLifecycleResumeIds = new Set<string>([...lifecycleEntries.keys(), ...activeResumeIds]);
    const scanEntries = await buildScanEntries(allLifecycleResumeIds, activeResumeIds);

    // Merge: lifecycle entries take priority; scan entries fill gaps
    const merged: ClosedSessionEntry[] = [...lifecycleEntries.values(), ...scanEntries];

    // Sort by lastActiveAt descending
    merged.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    return { success: true, sessions: merged };
  });

  // POST /api/sessions/resume
  app.post('/api/sessions/resume', async (req) => {
    const parsed = ResumeClosedSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.error.issues[0]?.message ?? 'Validation failed');
    }

    const { workingDir, resumeId, name, mode } = parsed.data;

    // Validate workingDir exists and is a directory
    try {
      const stat = statSync(workingDir);
      if (!stat.isDirectory()) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
      }
    } catch {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
    }

    // Reject if the session is already active (same resumeId or same workingDir)
    for (const s of ctx.sessions.values()) {
      if (s.claudeResumeId === resumeId) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'A session with this conversation ID is already active'
        );
      }
      if (s.workingDir === workingDir && !s.worktreeBranch) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'A session for this working directory is already active'
        );
      }
    }

    // Resolve config
    const [globalNice, modelConfig, claudeModeConfig] = await Promise.all([
      ctx.getGlobalNiceConfig(),
      ctx.getModelConfig(),
      ctx.getClaudeModeConfig(),
    ]);

    const resolvedMode = mode ?? 'claude';
    const model = resolvedMode !== 'shell' ? modelConfig?.defaultModel : undefined;

    // Create session WITHOUT claudeResumeId in constructor — set it after construction
    const newSession = new Session({
      workingDir,
      mode: resolvedMode,
      name: name ?? workingDir.split('/').pop() ?? '',
      mux: ctx.mux,
      useMux: true,
      niceConfig: globalNice,
      model,
      claudeMode: claudeModeConfig.claudeMode,
      allowedTools: claudeModeConfig.allowedTools,
    });

    // Set claudeResumeId BEFORE startInteractive() so CLI builder injects --resume <uuid>
    newSession.claudeResumeId = resumeId;

    ctx.addSession(newSession);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(newSession);
    await ctx.setupSessionListeners(newSession);
    getLifecycleLog().log({ event: 'created', sessionId: newSession.id, name: newSession.name });

    const lightState = ctx.getSessionStateWithRespawn(newSession);
    ctx.broadcast(SseEvent.SessionCreated, lightState);

    try {
      await newSession.startInteractive();
      getLifecycleLog().log({
        event: 'started',
        sessionId: newSession.id,
        name: newSession.name,
        mode: resolvedMode,
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: resolvedMode });
    } catch (err) {
      req.log.error({ err, sessionId: newSession.id }, '[history] startInteractive failed');
    }

    const updatedState = ctx.getSessionStateWithRespawn(newSession);
    ctx.broadcast(SseEvent.SessionUpdated, { session: updatedState });

    return { success: true, session: updatedState };
  });
}

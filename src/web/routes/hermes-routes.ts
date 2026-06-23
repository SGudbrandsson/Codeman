// src/web/routes/hermes-routes.ts
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { SessionPort } from '../ports/session-port.js';
import type { EventPort } from '../ports/event-port.js';
import type { ConfigPort } from '../ports/config-port.js';
import type { InfraPort } from '../ports/infra-port.js';
import { subagentWatcher } from '../../subagent-watcher.js';
import { resolveParentSession, type ResolverSession } from '../hermes/parent-resolver.js';
import { slugifyBranch } from '../hermes/branch-slug.js';
import { renderTaskMd, WORKTREE_CLAUDE_MD } from '../hermes/task-templates.js';
import { buildDigest } from '../hermes/digest.js';
import { parseTaskPhase } from '../hermes/task-phase.js';

// One in-flight worktree-create per parent session id.
const parentLocks = new Map<string, Promise<unknown>>();
function withParentLock<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = parentLocks.get(parentId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const sentinel = next.catch(() => {});
  parentLocks.set(parentId, sentinel);
  sentinel.then(() => {
    if (parentLocks.get(parentId) === sentinel) parentLocks.delete(parentId);
  });
  return next;
}

interface StartBody {
  project: string;
  title: string;
  description: string;
  acceptance?: string;
  parentSessionId?: string;
}

export function registerHermesRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort & InfraPort
): void {
  const startHandler =
    (kind: 'feature' | 'fix') =>
    async (req: { body: unknown; headers: Record<string, string | string[] | undefined> }) => {
      const body = req.body as Partial<StartBody>;
      if (!body?.project || !body?.title || !body?.description) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'project, title, and description are required');
      }

      const sessions = ctx.getLightSessionsState() as ResolverSession[];
      const resolved = resolveParentSession(sessions, body.project, body.parentSessionId);
      if (!resolved.ok) {
        const code = resolved.code === 'INVALID_INPUT' ? ApiErrorCode.INVALID_INPUT : ApiErrorCode.NOT_FOUND;
        return { ...createErrorResponse(code, resolved.message), candidates: resolved.candidates };
      }
      const parentId = resolved.sessionId;

      const taskMd = renderTaskMd(kind, {
        title: body.title,
        description: body.description,
        acceptance: body.acceptance,
      });
      const notes = 'Read TASK.md in this directory, then invoke the codeman-task-runner skill.';

      return withParentLock(parentId, async () => {
        const prefix = kind === 'fix' ? 'fix' : 'feat';
        let lastErr = 'unknown error';
        for (let attempt = 1; attempt <= 5; attempt++) {
          const branch =
            attempt === 1 ? slugifyBranch(body.title!, prefix) : `${slugifyBranch(body.title!, prefix)}-${attempt}`;

          const injectHeaders: Record<string, string> = {};
          const authHeader = req.headers.authorization;
          if (authHeader) injectHeaders.authorization = Array.isArray(authHeader) ? authHeader[0] : authHeader;
          const res = await app.inject({
            method: 'POST',
            url: `/api/sessions/${parentId}/worktree`,
            headers: injectHeaders,
            payload: { branch, isNew: true, autoStart: true, notes, taskMd, claudeMd: WORKTREE_CLAUDE_MD },
          });

          if (res.statusCode >= 400) {
            let errJson: { errorCode?: string; error?: string; message?: string } = {};
            try {
              errJson = res.json() as typeof errJson;
            } catch {
              // non-JSON body (e.g. plain-text "Unauthorized")
            }
            lastErr = errJson.error ?? errJson.message ?? errJson.errorCode ?? res.body ?? `HTTP ${res.statusCode}`;
            const isCollision = errJson.errorCode === 'ALREADY_EXISTS' || /BRANCH_EXISTS/i.test(lastErr);
            if (!isCollision) break;
            continue;
          }

          let json:
            | { success: true; session: { id: string }; worktreePath: string }
            | { success: false; errorCode?: string; error?: string; message?: string };
          try {
            json = res.json() as typeof json;
          } catch {
            lastErr = res.body || `HTTP ${res.statusCode}`;
            break;
          }

          if (json.success) {
            return {
              success: true,
              data: { sessionId: json.session.id, branch, worktreePath: json.worktreePath, started: true },
            };
          }
          // Worktree route error shape: { success:false, errorCode: 'ALREADY_EXISTS',
          //   error: 'BRANCH_EXISTS_UNMERGED: ...' } (see worktree-session-routes.ts handleBranchCollision)
          lastErr = json.error ?? json.message ?? json.errorCode ?? `HTTP ${res.statusCode}`;
          const isCollision = json.errorCode === 'ALREADY_EXISTS' || /BRANCH_EXISTS/i.test(lastErr);
          if (!isCollision) break; // non-collision failure — stop retrying
        }
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Could not create worktree: ${lastErr}`);
      });
    };

  app.post('/api/feature', startHandler('feature'));
  app.post('/api/fix', startHandler('fix'));

  app.get('/api/sessions/:id/digest', async (req) => {
    const { id } = req.params as { id: string };
    const sessions = ctx.getLightSessionsState() as Array<{
      id: string;
      name: string;
      status: string;
      workingDir?: string;
      worktreeBranch?: string | null;
      lastActivityAt?: number;
    }>;
    const s = sessions.find((x) => x.id === id);
    if (!s) return createErrorResponse(ApiErrorCode.NOT_FOUND, `No session "${id}"`);

    let phase: string | null = null;
    if (s.workingDir) {
      try {
        const taskMd = await readFile(`${s.workingDir}/TASK.md`, 'utf-8');
        phase = parseTaskPhase(taskMd);
      } catch {
        /* no TASK.md → phase stays null */
      }
    }

    const subagents = s.workingDir ? subagentWatcher.getSubagentsForSession(s.workingDir) : [];
    const digest = buildDigest({
      id: s.id,
      name: s.name,
      status: s.status,
      transcript: ctx.getTranscriptState(id),
      subagents,
      phase,
      lastActivityAt: s.lastActivityAt ?? null,
    });
    return { success: true, data: digest };
  });
}

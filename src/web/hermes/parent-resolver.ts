export interface ResolverSession {
  id: string;
  name: string;
  status: string;
  workingDir?: string;
  worktreeBranch?: string | null;
}

export type ResolveResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'AMBIGUOUS' | 'INVALID_INPUT';
      message: string;
      candidates?: Array<{ id: string; name: string; workingDir?: string }>;
    };

const isMain = (s: ResolverSession): boolean => !s.worktreeBranch;
const basename = (p: string | undefined): string => (p ?? '').replace(/\/+$/, '').split('/').pop() ?? '';

export function resolveParentSession(
  sessions: ResolverSession[],
  project: string,
  parentSessionId?: string
): ResolveResult {
  const mains = sessions.filter(isMain);

  if (parentSessionId) {
    const hit = mains.find((s) => s.id === parentSessionId);
    if (!hit) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `parentSessionId "${parentSessionId}" is not a main (non-worktree) session`,
      };
    }
    return { ok: true, sessionId: hit.id };
  }

  const needle = project.trim().toLowerCase();
  const matches = mains.filter((s) => basename(s.workingDir).toLowerCase() === needle);

  if (matches.length === 0) {
    return { ok: false, code: 'NOT_FOUND', message: `No main session found for project "${project}"` };
  }

  const idle = matches.filter((s) => s.status === 'idle');
  const pool = idle.length > 0 ? idle : matches;
  if (pool.length === 1) return { ok: true, sessionId: pool[0].id };

  return {
    ok: false,
    code: 'AMBIGUOUS',
    message: `Multiple sessions match project "${project}" — pass parentSessionId to disambiguate`,
    candidates: pool.map((s) => ({ id: s.id, name: s.name, workingDir: s.workingDir })),
  };
}

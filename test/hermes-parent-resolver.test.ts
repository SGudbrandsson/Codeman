import { describe, it, expect } from 'vitest';
import { resolveParentSession, type ResolverSession } from '../src/web/hermes/parent-resolver.js';

const main = (id: string, dir: string, status = 'idle', branch: string | null = null): ResolverSession => ({
  id,
  name: id,
  status,
  workingDir: dir,
  worktreeBranch: branch,
});

describe('resolveParentSession', () => {
  it('matches a single main session by project basename', () => {
    const r = resolveParentSession([main('a', '/home/u/Codeman')], 'codeman');
    expect(r).toEqual({ ok: true, sessionId: 'a' });
  });

  it('ignores worktree sessions (those with a branch)', () => {
    const sessions = [main('a', '/home/u/Codeman'), main('b', '/home/u/Codeman-feat', 'idle', 'feat/x')];
    expect(resolveParentSession(sessions, 'codeman')).toEqual({ ok: true, sessionId: 'a' });
  });

  it('prefers an idle main session over a busy one', () => {
    const sessions = [main('busy', '/home/u/Codeman', 'busy'), main('idle', '/home/u/Codeman', 'idle')];
    expect(resolveParentSession(sessions, 'codeman')).toEqual({ ok: true, sessionId: 'idle' });
  });

  it('returns AMBIGUOUS with candidates when >1 idle match', () => {
    const sessions = [main('a', '/home/u/Codeman'), main('b', '/srv/Codeman')];
    const r = resolveParentSession(sessions, 'codeman');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('AMBIGUOUS');
      expect(r.candidates?.map((c) => c.id).sort()).toEqual(['a', 'b']);
    }
  });

  it('returns NOT_FOUND when no project matches', () => {
    const r = resolveParentSession([main('a', '/home/u/Other')], 'codeman');
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('honors an explicit parentSessionId', () => {
    const sessions = [main('a', '/home/u/Codeman'), main('b', '/srv/Codeman')];
    expect(resolveParentSession(sessions, 'codeman', 'b')).toEqual({ ok: true, sessionId: 'b' });
  });

  it('rejects a parentSessionId that is a worktree session', () => {
    const sessions = [main('wt', '/home/u/Codeman-feat', 'idle', 'feat/x')];
    expect(resolveParentSession(sessions, 'codeman', 'wt')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
});

/**
 * @fileoverview Tests for the neutral harnessSessionId identity and its migration.
 */

import { describe, it, expect } from 'vitest';
import { backfillHarnessSessionId } from '../src/web/server.js';
import { CreateSessionSchema, ResumeClosedSessionSchema } from '../src/web/schemas.js';
import type { SessionState } from '../src/types/session.js';

const base = (over: Partial<SessionState>): SessionState =>
  ({ id: 's1', name: 'n', workingDir: '/tmp', status: 'idle', ...over }) as SessionState;

describe('backfillHarnessSessionId', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';

  it('backfills a legacy entry that has no mode at all', () => {
    const s = base({ claudeResumeId: uuid });
    expect(backfillHarnessSessionId(s)).toBe(true);
    expect(s.harnessSessionId).toBe(uuid);
  });

  it('backfills an explicit claude entry', () => {
    const s = base({ mode: 'claude', claudeResumeId: uuid });
    expect(backfillHarnessSessionId(s)).toBe(true);
    expect(s.harnessSessionId).toBe(uuid);
  });

  it('does NOT backfill a non-claude entry that carries a claudeResumeId', () => {
    // Otherwise a codex session would later run `codex resume <Claude UUID>`.
    const s = base({ mode: 'opencode', claudeResumeId: uuid });
    expect(backfillHarnessSessionId(s)).toBe(false);
    expect(s.harnessSessionId).toBeUndefined();
  });

  it('does not clobber an existing harnessSessionId', () => {
    const s = base({ mode: 'claude', claudeResumeId: uuid, harnessSessionId: 'already-set' });
    expect(backfillHarnessSessionId(s)).toBe(false);
    expect(s.harnessSessionId).toBe('already-set');
  });

  it('is a no-op when there is nothing to migrate', () => {
    const s = base({ mode: 'claude' });
    expect(backfillHarnessSessionId(s)).toBe(false);
  });
});

describe('CreateSessionSchema rejects a mismatched resume id', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';

  it('accepts claudeResumeId with mode claude', () => {
    expect(CreateSessionSchema.safeParse({ mode: 'claude', claudeResumeId: uuid }).success).toBe(true);
  });

  it('accepts claudeResumeId with no mode (defaults to claude)', () => {
    expect(CreateSessionSchema.safeParse({ claudeResumeId: uuid }).success).toBe(true);
  });

  it('rejects claudeResumeId paired with a non-claude mode', () => {
    const r = CreateSessionSchema.safeParse({ mode: 'opencode', claudeResumeId: uuid });
    expect(r.success).toBe(false);
  });
});

describe('ResumeClosedSessionSchema rejects non-claude harnesses', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  const base = { workingDir: '/tmp', resumeId: uuid };

  it('accepts mode claude', () => {
    expect(ResumeClosedSessionSchema.safeParse({ ...base, mode: 'claude' }).success).toBe(true);
  });

  it('accepts an omitted mode (defaults to claude)', () => {
    expect(ResumeClosedSessionSchema.safeParse(base).success).toBe(true);
  });

  it.each(['codex', 'pi', 'opencode', 'shell'] as const)('rejects mode %s', (mode) => {
    // resumeId is a Claude conversation UUID. The route feeds it to
    // setClaudeResumeId(), which mirrors it into harnessSessionId — so a codex
    // session would spawn as `codex resume <claude-uuid>` and a shell session
    // would become eligible for the state.json auto-resume gate.
    const r = ResumeClosedSessionSchema.safeParse({ ...base, mode });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/only.*claude/i);
  });
});

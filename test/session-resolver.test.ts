import { describe, it, expect } from 'vitest';
import { resolveActiveSession } from '../src/session-resolver.js';

type SessionStub = { id: string; status: string; lastActivityAt: number };

function makeSession(id: string, status = 'idle', lastActivityAt = 1000000): SessionStub {
  return { id, status, lastActivityAt };
}

function sessionsMap(...sessions: SessionStub[]): Map<string, SessionStub> {
  return new Map(sessions.map((s) => [s.id, s]));
}

function liveTmuxSet(...ids: string[]): Set<string> {
  return new Set(ids.map((id) => `codeman-${id.slice(0, 8)}`));
}

describe('resolveActiveSession', () => {
  it('returns null when session map is empty', async () => {
    const result = await resolveActiveSession({
      persistedActiveId: null,
      sessions: sessionsMap(),
      liveTmuxNames: new Set(),
    });
    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe('none');
  });

  it('returns persisted session with high confidence when alive in tmux', async () => {
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const result = await resolveActiveSession({
      persistedActiveId: id,
      sessions: sessionsMap(makeSession(id)),
      liveTmuxNames: liveTmuxSet(id),
    });
    expect(result.sessionId).toBe(id);
    expect(result.confidence).toBe('high');
    expect(result.source).toBe('persisted');
  });

  it('ignores persisted session when not in session map', async () => {
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const other = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: id,
      sessions: sessionsMap(makeSession(other)),
      liveTmuxNames: liveTmuxSet(other),
    });
    expect(result.sessionId).toBe(other);
    expect(result.source).not.toBe('persisted');
  });

  it('ignores persisted session when it is archived', async () => {
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const other = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: id,
      sessions: sessionsMap(makeSession(id, 'archived'), makeSession(other)),
      liveTmuxNames: liveTmuxSet(id, other),
    });
    expect(result.sessionId).toBe(other);
  });

  it('ignores persisted session when its tmux name is not in live set', async () => {
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const other = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: id,
      sessions: sessionsMap(makeSession(id), makeSession(other)),
      liveTmuxNames: liveTmuxSet(other), // id is NOT in live set
    });
    expect(result.sessionId).toBe(other);
    expect(result.source).toBe('tmux-verified');
    expect(result.confidence).toBe('medium');
  });

  it('returns most recently active tmux-verified session when no persisted match', async () => {
    const old = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const recent = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: null,
      sessions: sessionsMap(makeSession(old, 'idle', 1000), makeSession(recent, 'idle', 9000)),
      liveTmuxNames: liveTmuxSet(old, recent),
    });
    expect(result.sessionId).toBe(recent);
    expect(result.source).toBe('tmux-verified');
  });

  it('falls back to activity-timestamp ordering when no tmux verification', async () => {
    const old = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const recent = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: null,
      sessions: sessionsMap(makeSession(old, 'idle', 1000), makeSession(recent, 'idle', 9000)),
      liveTmuxNames: new Set(),
    });
    expect(result.sessionId).toBe(recent);
    expect(result.source).toBe('activity-timestamp');
    expect(result.confidence).toBe('low');
  });

  it('ignores archived sessions in all fallback paths', async () => {
    const archived = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const active = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: null,
      sessions: sessionsMap(makeSession(archived, 'archived', 99999), makeSession(active, 'idle', 1000)),
      liveTmuxNames: liveTmuxSet(archived, active),
    });
    expect(result.sessionId).toBe(active);
  });

  it('returns any non-archived session as fallback when no timestamps', async () => {
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const result = await resolveActiveSession({
      persistedActiveId: null,
      sessions: sessionsMap({ id, status: 'idle', lastActivityAt: 0 }),
      liveTmuxNames: new Set(),
    });
    expect(result.sessionId).toBe(id);
    expect(result.source).toBe('fallback');
  });
});

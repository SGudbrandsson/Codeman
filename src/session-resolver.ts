/**
 * @fileoverview Session resolver — picks the best active session for the frontend to display.
 *
 * Priority:
 * 1. Persisted active ID (from state store) if non-archived + has live tmux → high confidence
 * 2. Non-archived sessions with live tmux, sorted by lastActivityAt desc → medium confidence
 * 3. Non-archived sessions sorted by lastActivityAt desc (no tmux check) → low confidence
 * 4. Any non-archived session (lastActivityAt === 0) → low confidence / fallback
 * 5. No non-archived sessions → null / none
 *
 * Note: lastActivityAt is a Unix ms timestamp (number). Zero means "no timestamp available".
 */

export type ResolvedSessionSource = 'persisted' | 'tmux-verified' | 'activity-timestamp' | 'fallback';

export type ResolvedSessionConfidence = 'high' | 'medium' | 'low' | 'none';

export interface ResolvedSession {
  sessionId: string | null;
  confidence: ResolvedSessionConfidence;
  source: ResolvedSessionSource | null;
}

interface SessionLike {
  id: string;
  status: string;
  lastActivityAt: number;
}

/** Maps a Codeman session ID to its expected tmux session name. */
export function sessionIdToMuxName(sessionId: string): string {
  return `codeman-${sessionId.slice(0, 8)}`;
}

export async function resolveActiveSession(params: {
  persistedActiveId: string | null;
  sessions: Map<string, SessionLike>;
  liveTmuxNames: Set<string>;
}): Promise<ResolvedSession> {
  const { persistedActiveId, sessions, liveTmuxNames } = params;

  const nonArchived = [...sessions.values()].filter((s) => s.status !== 'archived');

  if (nonArchived.length === 0) {
    return { sessionId: null, confidence: 'none', source: null };
  }

  // Priority 1: persisted + exists + non-archived + live in tmux
  if (persistedActiveId) {
    const session = sessions.get(persistedActiveId);
    if (session && session.status !== 'archived') {
      const muxName = sessionIdToMuxName(persistedActiveId);
      if (liveTmuxNames.has(muxName)) {
        return { sessionId: persistedActiveId, confidence: 'high', source: 'persisted' };
      }
    }
  }

  // Priority 2: tmux-verified, most recent first
  const tmuxVerified = nonArchived
    .filter((s) => liveTmuxNames.has(sessionIdToMuxName(s.id)))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  if (tmuxVerified.length > 0) {
    return { sessionId: tmuxVerified[0].id, confidence: 'medium', source: 'tmux-verified' };
  }

  // Priority 3: activity-timestamp, most recent first (lastActivityAt > 0)
  const withTimestamps = nonArchived
    .filter((s) => s.lastActivityAt > 0)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  if (withTimestamps.length > 0) {
    return { sessionId: withTimestamps[0].id, confidence: 'low', source: 'activity-timestamp' };
  }

  // Priority 4: any non-archived session
  return { sessionId: nonArchived[0].id, confidence: 'low', source: 'fallback' };
}

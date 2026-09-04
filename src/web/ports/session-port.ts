/**
 * @fileoverview Session port — capabilities for session lifecycle management.
 * Route modules that manage sessions depend on this port.
 */

import type { Session } from '../../session.js';
import type { SessionState } from '../../types/session.js';

export interface SessionPort {
  readonly sessions: ReadonlyMap<string, Session>;
  addSession(session: Session): void;
  cleanupSession(sessionId: string, killMux?: boolean, reason?: string): Promise<void>;
  clearSession(
    sessionId: string,
    force: boolean
  ): Promise<{ archivedSession: SessionState; newSession: Session; newSessionState: SessionState }>;
  setupSessionListeners(session: Session): Promise<void>;
  /** Registers session listeners only if they were stripped (e.g. by the exit handler). */
  ensureSessionListeners(session: Session): Promise<void>;
  /** Tears down respawn controller/timers, ralph watchers and the image watcher before parking a session. */
  pauseSessionSideEffects(sessionId: string): Promise<void>;
  resumeSessionSideEffects(sessionId: string): Promise<void>;
  persistSessionState(session: Session): void;
  persistSessionStateNow(session: Session): void;
  getSessionStateWithRespawn(session: Session): unknown;
}

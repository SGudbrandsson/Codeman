/**
 * @fileoverview Active session routes.
 *
 * GET  /api/sessions/resolve-active       — returns best session for frontend to display
 * POST /api/sessions/:id/mark-active      — persists frontend's session selection
 * GET  /api/sessions/:id/screen-snapshot  — returns current tmux screen + analysis
 */
import type { FastifyInstance } from 'fastify';
import type { ConfigPort } from '../ports/config-port.js';
import type { InfraPort } from '../ports/infra-port.js';
import type { SessionPort } from '../ports/session-port.js';
import { resolveActiveSession } from '../../session-resolver.js';
import { captureScreen, analyzeScreen } from '../../screen-analyzer.js';

type ActiveSessionContext = ConfigPort & InfraPort & SessionPort;

export function registerActiveSessionRoutes(app: FastifyInstance, ctx: ActiveSessionContext): void {
  // ── GET /api/sessions/resolve-active ────────────────────────────────────────
  app.get('/api/sessions/resolve-active', async (_request, reply) => {
    const persistedActiveId = ctx.store.getActiveSessionId();

    const sessionMap = new Map<string, { id: string; status: string; lastActivityAt: number }>();
    for (const [id, session] of ctx.sessions) {
      const state = session.toState() as { id: string; status: string; lastActivityAt?: number };
      sessionMap.set(id, {
        id: state.id,
        status: state.status,
        lastActivityAt: state.lastActivityAt ?? 0,
      });
    }

    let liveTmuxNames: Set<string>;
    try {
      const liveSessions = ctx.mux.listAllTmuxSessions();
      liveTmuxNames = new Set(liveSessions.map((s: { name: string }) => s.name));
    } catch {
      liveTmuxNames = new Set();
    }

    const result = await resolveActiveSession({ persistedActiveId, sessions: sessionMap, liveTmuxNames });
    return reply.send(result);
  });

  // ── POST /api/sessions/:id/mark-active ────────────────────────────────────
  app.post('/api/sessions/:id/mark-active', async (request, reply) => {
    const { id } = request.params as { id: string };

    const session = ctx.sessions.get(id);
    if (!session) {
      return reply.status(404).send({ error: 'session_not_found' });
    }

    const state = session.toState() as { status: string };
    if (state.status === 'archived') {
      return reply.status(400).send({ error: 'session_archived' });
    }

    ctx.store.setActiveSessionId(id);
    return reply.send({ ok: true });
  });

  // ── GET /api/sessions/:id/screen-snapshot ────────────────────────────────
  app.get('/api/sessions/:id/screen-snapshot', async (request, reply) => {
    const { id } = request.params as { id: string };

    const muxSession = ctx.mux.getSession(id);
    if (!muxSession) {
      return reply.status(404).send({ error: 'no_mux_session' });
    }

    const rawScreen = captureScreen(muxSession.muxName);
    if (rawScreen === null) {
      return reply.status(503).send({ error: 'screen_capture_failed' });
    }

    const analysis = analyzeScreen(rawScreen);
    return reply.send({ muxName: muxSession.muxName, rawScreen, analysis });
  });
}

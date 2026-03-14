/**
 * @fileoverview Mux (tmux) session management routes.
 * Provides mux session listing, killing, reconciliation, and stats control.
 */

import { FastifyInstance } from 'fastify';
import type { InfraPort } from '../ports/index.js';
import { STATS_COLLECTION_INTERVAL_MS } from '../../config/server-timing.js';

export function registerMuxRoutes(app: FastifyInstance, ctx: InfraPort): void {
  app.get('/api/mux-sessions', async () => {
    const sessions = await ctx.mux.getSessionsWithStats();
    return {
      sessions,
      muxAvailable: ctx.mux.isAvailable(),
    };
  });

  /**
   * GET /api/mux/all-sessions
   * Lists ALL live tmux sessions (not just Codeman-tracked ones).
   * Also annotates each entry with which Codeman session currently owns it.
   */
  app.get('/api/mux/all-sessions', async () => {
    const rawSessions = ctx.mux.listAllTmuxSessions();
    // Build a map: muxName → Codeman sessionId
    const ownerMap = new Map<string, string>();
    for (const muxSess of ctx.mux.getSessions()) {
      ownerMap.set(muxSess.muxName, muxSess.sessionId);
    }
    const sessions = rawSessions.map((s) => ({
      ...s,
      ownerSessionId: ownerMap.get(s.name) ?? null,
    }));
    return { sessions, muxAvailable: ctx.mux.isAvailable() };
  });

  app.delete('/api/mux-sessions/:sessionId', async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    const success = await ctx.mux.killSession(sessionId);
    return { success };
  });

  app.post('/api/mux-sessions/reconcile', async () => {
    const result = await ctx.mux.reconcileSessions();
    return result;
  });

  app.post('/api/mux-sessions/stats/start', async () => {
    ctx.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
    return { success: true };
  });

  app.post('/api/mux-sessions/stats/stop', async () => {
    ctx.mux.stopStatsCollection();
    return { success: true };
  });
}

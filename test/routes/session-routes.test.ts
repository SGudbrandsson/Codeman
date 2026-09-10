/**
 * @fileoverview Tests for session route handlers.
 *
 * Uses app.inject() (Fastify's built-in test helper) — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

describe('session-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/sessions ==========

  describe('GET /api/sessions', () => {
    it('returns session list when sessions exist', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
    });

    it('returns empty array when no sessions', async () => {
      harness.ctx.sessions.clear();
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it('excludes archived sessions from the response', async () => {
      // Add an archived session to the sessions Map to simulate an edge-case where
      // an archived session is present (e.g., mid-flight clear interrupted by restart).
      const { createMockSession } = await import('../mocks/mock-session.js');
      const archivedSession = createMockSession('archived-session-id');
      (archivedSession as unknown as { status: string }).status = 'archived';
      harness.ctx.sessions.set('archived-session-id', archivedSession);

      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<{ id: string }>;
      const ids = body.map((s) => s.id);
      expect(ids).not.toContain('archived-session-id');
      // The original non-archived session should still be present
      expect(ids).toContain(harness.ctx._sessionId);
    });
  });

  // ========== GET /api/sessions/:id ==========

  describe('GET /api/sessions/:id', () => {
    it('returns session state for existing session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(harness.ctx._sessionId);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(200); // returns error in body, not HTTP 404
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });
  });

  // ========== DELETE /api/sessions/:id ==========

  describe('DELETE /api/sessions/:id', () => {
    it('deletes existing session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.cleanupSession).toHaveBeenCalledWith(harness.ctx._sessionId, true, 'user_delete');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== DELETE /api/sessions (delete all) ==========

  describe('DELETE /api/sessions', () => {
    it('deletes all sessions', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.killed).toBe(1);
      expect(harness.ctx.cleanupSession).toHaveBeenCalled();
    });
  });

  // ========== PUT /api/sessions/:id/name ==========

  describe('PUT /api/sessions/:id/name', () => {
    it('renames session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/name`,
        payload: { name: 'new-name' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.name).toBe('new-name');
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/sessions/nonexistent/name',
        payload: { name: 'test' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== PUT /api/sessions/:id/color ==========

  describe('PUT /api/sessions/:id/color', () => {
    it('sets session color', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/color`,
        payload: { color: 'blue' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.color).toBe('blue');
    });

    it('rejects invalid color', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/color`,
        payload: { color: 'neon-rainbow' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/input ==========

  describe('POST /api/sessions/:id/input', () => {
    it('sends input to session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: 'hello' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/input',
        payload: { input: 'hello' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects empty payload', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('useMux:true happy path — calls writeViaMux, does not call write', async () => {
      const session = harness.ctx._session;
      const writeViaMuxSpy = vi.spyOn(session, 'writeViaMux').mockResolvedValue(true);
      const writeSpy = vi.spyOn(session, 'write');

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: 'hello\nworld\r', useMux: true },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(writeViaMuxSpy).toHaveBeenCalledWith('hello\nworld\r');
      // Allow the fire-and-forget promise to settle before asserting write was not called
      await new Promise((r) => setTimeout(r, 10));
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('useMux:true, writeViaMux returns false — falls back to write with \\n replaced by spaces', async () => {
      const session = harness.ctx._session;
      vi.spyOn(session, 'writeViaMux').mockResolvedValue(false);
      const writeSpy = vi.spyOn(session, 'write');

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: 'line1\nline2\r', useMux: true },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      // Allow the fire-and-forget promise to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(writeSpy).toHaveBeenCalledWith('line1 line2\r');
    });

    it('useMux:true, writeViaMux throws — falls back to write with \\n replaced by spaces', async () => {
      const session = harness.ctx._session;
      vi.spyOn(session, 'writeViaMux').mockRejectedValue(new Error('tmux unavailable'));
      const writeSpy = vi.spyOn(session, 'write');

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: 'line1\nline2\r', useMux: true },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      // Allow the fire-and-forget promise to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(writeSpy).toHaveBeenCalledWith('line1 line2\r');
    });

    it('useMux:true — HTTP response is withheld until writeViaMux resolves (await-before-response)', async () => {
      // This test verifies that the route awaits writeViaMux before returning the HTTP 200.
      // Previously, the route used fire-and-forget (.then().catch()) and returned immediately.
      // Now it awaits, so inject() must not return until after writeViaMux has resolved.
      const DELAY_MS = 60;
      const session = harness.ctx._session;

      let muxResolveTime = 0;
      vi.spyOn(session, 'writeViaMux').mockImplementation(() => {
        return new Promise<boolean>((resolve) => {
          setTimeout(() => {
            muxResolveTime = Date.now();
            resolve(true);
          }, DELAY_MS);
        });
      });

      const requestStartTime = Date.now();
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: 'hello\r', useMux: true },
      });
      const responseTime = Date.now();

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      // writeViaMux must have resolved before the response arrived
      expect(muxResolveTime).toBeGreaterThan(0);
      expect(responseTime).toBeGreaterThanOrEqual(muxResolveTime);
      // The response must have been delayed by at least the mock delay
      expect(responseTime - requestStartTime).toBeGreaterThanOrEqual(DELAY_MS);
    });
  });

  // ========== POST /api/sessions/:id/resize ==========

  describe('POST /api/sessions/:id/resize', () => {
    it('resizes session terminal', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 120, rows: 40 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.resize).toHaveBeenCalledWith(120, 40);
    });

    it('rejects cols exceeding max (500)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 501, rows: 24 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects rows exceeding max (200)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 80, rows: 201 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects zero dimensions', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 0, rows: 24 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/terminal ==========

  describe('GET /api/sessions/:id/terminal', () => {
    it('returns terminal buffer', async () => {
      harness.ctx._session.terminalBuffer = 'hello world';
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.terminalBuffer).toBeDefined();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/terminal',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/run ==========

  describe('POST /api/sessions/:id/run', () => {
    it('runs prompt on session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'do something' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('rejects empty prompt', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: '' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/run',
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/interactive ==========

  describe('POST /api/sessions/:id/interactive', () => {
    it('starts interactive mode', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/interactive',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/shell ==========

  describe('POST /api/sessions/:id/shell', () => {
    it('starts shell mode', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startShell).toHaveBeenCalled();
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/output ==========

  describe('GET /api/sessions/:id/output', () => {
    it('returns session output data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/output`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('textOutput');
      expect(body.data).toHaveProperty('messages');
      expect(body.data).toHaveProperty('errorBuffer');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/output',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/ralph-state ==========

  describe('GET /api/sessions/:id/ralph-state', () => {
    it('returns ralph state data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-state`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('loop');
      expect(body.data).toHaveProperty('todos');
      expect(body.data).toHaveProperty('todoStats');
    });
  });

  // ========== GET /api/sessions/:id/active-tools ==========

  describe('GET /api/sessions/:id/active-tools', () => {
    it('returns active tools', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/active-tools`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('tools');
    });
  });

  // ========== POST /api/logout ==========

  describe('POST /api/logout', () => {
    it('returns success', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/logout',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });

  // ========== GET /api/sessions/:id/chain ==========

  describe('GET /api/sessions/:id/chain', () => {
    it('returns single-item chain for session with no parent', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/chain`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe(harness.ctx._sessionId);
    });

    it('returns ordered chain [root, mid, leaf] for a 3-level ancestry', async () => {
      // root (archived, in store only) → mid (archived, in store only) → leaf (active session)
      const rootState = {
        ...harness.ctx._session.toState(),
        id: 'root-id',
        status: 'archived' as const,
        childSessionId: 'mid-id',
      };
      const midState = {
        ...harness.ctx._session.toState(),
        id: 'mid-id',
        status: 'archived' as const,
        parentSessionId: 'root-id',
        childSessionId: harness.ctx._sessionId,
      };
      // Leaf is the active session with parentSessionId pointing to mid
      vi.spyOn(harness.ctx._session, 'toState').mockReturnValue({
        ...harness.ctx._session.toState(),
        parentSessionId: 'mid-id',
      });
      harness.ctx.store.getSession.mockImplementation((id: string) => {
        if (id === 'root-id') return rootState;
        if (id === 'mid-id') return midState;
        return undefined;
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/chain`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.sessions).toHaveLength(3);
      expect(body.sessions[0].id).toBe('root-id');
      expect(body.sessions[1].id).toBe('mid-id');
      expect(body.sessions[2].id).toBe(harness.ctx._sessionId);
    });

    it('returns 200 with error body for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/chain',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });
  });

  // ========== GET /api/sessions/:id/state ==========

  describe('GET /api/sessions/:id/state', () => {
    it('returns session state and transcript array', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/state`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.session.id).toBe(harness.ctx._sessionId);
      expect(Array.isArray(body.transcript)).toBe(true);
    });

    it('returns 200 with error body for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/state',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });
  });

  // ========== POST /api/sessions/:id/clear ==========

  describe('POST /api/sessions/:id/clear', () => {
    it('calls ctx.clearSession and returns archived + new session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/clear`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.archivedSession).toBeDefined();
      expect(body.newSession).toBeDefined();
      expect(harness.ctx.clearSession).toHaveBeenCalledWith(harness.ctx._sessionId, false);
    });

    it('passes force:true when requested', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/clear`,
        payload: { force: true },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.clearSession).toHaveBeenCalledWith(harness.ctx._sessionId, true);
    });

    it('returns 200 with error body for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/clear',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });
  });

  // ========== POST /api/sessions/:id/auto-compact-continue ==========

  describe('POST /api/sessions/:id/auto-compact-continue', () => {
    it('enables auto-compact-continue and returns updated state', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-compact-continue`,
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.autoCompactAndContinue).toBe(true);
      expect(harness.ctx._session.setAutoCompactAndContinue).toHaveBeenCalledWith(true);
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('disables auto-compact-continue and returns updated state', async () => {
      // First enable it
      harness.ctx._session.autoCompactAndContinue = true;
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-compact-continue`,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.autoCompactAndContinue).toBe(false);
      expect(harness.ctx._session.setAutoCompactAndContinue).toHaveBeenCalledWith(false);
    });

    for (const mode of ['codex', 'pi', 'shell', 'opencode']) {
      it(`rejects enabling for a ${mode} session (Claude-only) and leaves it disabled`, async () => {
        harness.ctx._session.mode = mode;
        const res = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${harness.ctx._sessionId}/auto-compact-continue`,
          payload: { enabled: true },
        });
        const body = JSON.parse(res.body);
        expect(body.success).toBe(false);
        expect(harness.ctx._session.setAutoCompactAndContinue).not.toHaveBeenCalled();
        expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
      });
    }

    it('still allows disabling for a non-Claude session', async () => {
      harness.ctx._session.mode = 'pi';
      harness.ctx._session.autoCompactAndContinue = true;
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-compact-continue`,
        payload: { enabled: false },
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.setAutoCompactAndContinue).toHaveBeenCalledWith(false);
    });

    it('returns error for invalid body (missing enabled field)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-compact-continue`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(harness.ctx._session.setAutoCompactAndContinue).not.toHaveBeenCalled();
    });

    it('returns error for invalid body (non-boolean enabled)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-compact-continue`,
        payload: { enabled: 'yes' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(harness.ctx._session.setAutoCompactAndContinue).not.toHaveBeenCalled();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/auto-compact-continue',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/restart ==========

  describe('POST /api/sessions/:id/restart', () => {
    it('restarts session successfully', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/restart`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.prepareForRestart).toHaveBeenCalled();
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('rejects shell sessions', async () => {
      harness.ctx._session.mode = 'shell';
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/restart`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/restart',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error when prepareForRestart throws', async () => {
      harness.ctx._session.prepareForRestart.mockRejectedValueOnce(new Error('PTY kill failed'));
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/restart`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('PTY kill failed');
    });

    it('returns error when startInteractive throws', async () => {
      harness.ctx._session.startInteractive.mockRejectedValueOnce(new Error('spawn failed'));
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/restart`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('spawn failed');
    });
  });

  // ========== POST /api/sessions/:id/input with /clear command ==========

  describe('POST /api/sessions/:id/input with /clear command', () => {
    it('intercepts /clear and calls clearSession instead of writing to PTY', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: '/clear\r', useMux: true },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.clearSession).toHaveBeenCalledWith(harness.ctx._sessionId, false);
      // PTY write should NOT have been called (batchTerminalData is for terminal output, not input)
      expect(harness.ctx.broadcast).not.toHaveBeenCalledWith('session:clearTerminal', expect.anything());
    });
  });
  // ========== POST /api/sessions/:id/pause ==========

  describe('POST /api/sessions/:id/pause', () => {
    /** A session that satisfies every pause precondition. */
    function makeParkable() {
      const session = harness.ctx._session;
      session.mode = 'claude';
      session.claudeResumeId = 'conv-abc-123';
      session.safeMode = false;
      session.isWorking = false;
      session.paused = false;
      return session;
    }

    async function pause(payload: Record<string, unknown> = {}) {
      return harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/pause`,
        payload,
      });
    }

    it('returns NOT_FOUND for an unknown session', async () => {
      const res = await harness.app.inject({ method: 'POST', url: '/api/sessions/nonexistent/pause', payload: {} });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('NOT_FOUND');
    });

    it('rejects shell sessions', async () => {
      const session = makeParkable();
      session.mode = 'shell';

      const body = JSON.parse((await pause()).body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');
      expect(body.error).toContain('Shell sessions cannot be paused');
      expect(session.pause).not.toHaveBeenCalled();
    });

    it('rejects opencode sessions', async () => {
      const session = makeParkable();
      session.mode = 'opencode';

      const body = JSON.parse((await pause()).body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');
      expect(session.pause).not.toHaveBeenCalled();
    });

    it('refuses to park a session with no claudeResumeId, even with force', async () => {
      const session = makeParkable();
      session.claudeResumeId = null;

      const body = JSON.parse((await pause({ force: true })).body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');
      expect(body.error).toContain('No resumable conversation ID');
      expect(session.pause).not.toHaveBeenCalled();
    });

    it('refuses to park a safe-mode session, even with force', async () => {
      const session = makeParkable();
      session.safeMode = true;

      const body = JSON.parse((await pause({ force: true })).body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');
      expect(body.error).toContain('No resumable conversation ID');
      expect(session.pause).not.toHaveBeenCalled();
    });

    it('returns SESSION_BUSY when Claude is mid-turn and force is not set', async () => {
      const session = makeParkable();
      session.isWorking = true;

      const body = JSON.parse((await pause()).body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('SESSION_BUSY');
      expect(session.pause).not.toHaveBeenCalled();
    });

    it('pauses a mid-turn session when force is true', async () => {
      const session = makeParkable();
      session.isWorking = true;

      const body = JSON.parse((await pause({ force: true })).body);
      expect(body.success).toBe(true);
      expect(session.pause).toHaveBeenCalledTimes(1);
    });

    it('is idempotent for an already-paused session and runs no side effects', async () => {
      const session = makeParkable();
      session.paused = true;

      const body = JSON.parse((await pause()).body);
      expect(body.success).toBe(true);
      expect(session.pause).not.toHaveBeenCalled();
      expect(harness.ctx.pauseSessionSideEffects).not.toHaveBeenCalled();
      expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
    });

    it('tears down side effects BEFORE killing the process, then persists and broadcasts', async () => {
      const session = makeParkable();

      const body = JSON.parse((await pause()).body);
      expect(body.success).toBe(true);

      expect(harness.ctx.pauseSessionSideEffects).toHaveBeenCalledWith(harness.ctx._sessionId);
      expect(session.pause).toHaveBeenCalledTimes(1);
      // Side effects (respawn controller config save, watchers) must be torn down while the
      // process is still alive — otherwise the exit handler has already discarded them.
      expect(harness.ctx.pauseSessionSideEffects.mock.invocationCallOrder[0]).toBeLessThan(
        session.pause.mock.invocationCallOrder[0]
      );

      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(session);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', { session: expect.anything() });
    });

    it('persists and broadcasts the parked state when pause() throws after raising the flag', async () => {
      const session = makeParkable();
      session.pause.mockImplementationOnce(async () => {
        session.paused = true;
        throw new Error('tmux kill failed');
      });

      const body = JSON.parse((await pause()).body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');
      // The session really is parked in memory, so the persisted/broadcast state must say so.
      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(session);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', { session: expect.anything() });
    });

    it('does not persist or broadcast when pauseSessionSideEffects throws before the flag is raised', async () => {
      const session = makeParkable();
      harness.ctx.pauseSessionSideEffects.mockImplementationOnce(() => {
        throw new Error('respawn teardown failed');
      });

      const body = JSON.parse((await pause()).body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');
      expect(session.pause).not.toHaveBeenCalled();
      expect(session.paused).toBe(false);
      expect(harness.ctx.persistSessionState).not.toHaveBeenCalled();
      expect(harness.ctx.broadcast).not.toHaveBeenCalledWith('session:updated', expect.anything());
    });

    // ── R1: a pause that could not prove the kill leaves a RETRYABLE state ──
    it('retries the kill when the previous attempt could not prove the process died', async () => {
      const session = makeParkable();
      session.paused = true;
      session.pauseFailed = true;

      const body = JSON.parse((await pause()).body);
      expect(body.success).toBe(true);
      // Not the idempotent no-op path: this session is parked over a live pane, and this
      // call is the retry the failure message asked the user to make.
      expect(session.pause).toHaveBeenCalledTimes(1);
      expect(harness.ctx.pauseSessionSideEffects).toHaveBeenCalledWith(harness.ctx._sessionId);
    });

    it('reports failure (not success) when the subagent sweep cannot kill them', async () => {
      const session = makeParkable();
      harness.ctx.killSessionSubagents.mockRejectedValueOnce(new Error('subagent 123 still alive'));

      const body = JSON.parse((await pause()).body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/still alive/i);
      // The session really is parked (the main process died), so the state must say so.
      expect(session.paused).toBe(true);
      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(session);
    });

    it('kills subagents only after the main process is dead', async () => {
      const session = makeParkable();

      const body = JSON.parse((await pause()).body);
      expect(body.success).toBe(true);
      expect(harness.ctx.killSessionSubagents).toHaveBeenCalledWith(harness.ctx._sessionId);
      // A live Claude can spawn a replacement subagent, so the sweep must come last.
      expect(session.pause.mock.invocationCallOrder[0]).toBeLessThan(
        harness.ctx.killSessionSubagents.mock.invocationCallOrder[0]
      );
    });
  });

  // ========== POST /api/sessions/:id/resume ==========

  describe('POST /api/sessions/:id/resume', () => {
    function makeParked(pausedAt = 1_700_000_000_000) {
      const session = harness.ctx._session;
      session.mode = 'claude';
      session.claudeResumeId = 'conv-abc-123';
      session.workingDir = '/home/user/proj';
      session.paused = true;
      session.pausedAt = pausedAt;
      return session;
    }

    async function resume() {
      return harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resume`,
      });
    }

    it('returns NOT_FOUND for an unknown session', async () => {
      const res = await harness.app.inject({ method: 'POST', url: '/api/sessions/nonexistent/resume' });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('NOT_FOUND');
    });

    it('is idempotent for a live (unpaused) session', async () => {
      const session = harness.ctx._session;
      session.paused = false;

      const body = JSON.parse((await resume()).body);
      expect(body.success).toBe(true);
      expect(session.startInteractive).not.toHaveBeenCalled();
      expect(harness.ctx.ensureSessionListeners).not.toHaveBeenCalled();
    });

    it('re-registers server-side listeners BEFORE relaunching Claude', async () => {
      const session = makeParked();

      const body = JSON.parse((await resume()).body);
      expect(body.success).toBe(true);

      expect(harness.ctx.ensureSessionListeners).toHaveBeenCalledWith(session);
      expect(session.startInteractive).toHaveBeenCalledTimes(1);
      // The exit handler stripped every listener when the PTY died; re-arming them after
      // startInteractive() would lose the first frames and freeze the terminal.
      expect(harness.ctx.ensureSessionListeners.mock.invocationCallOrder[0]).toBeLessThan(
        session.startInteractive.mock.invocationCallOrder[0]
      );
      expect(session.clearPaused).toHaveBeenCalledTimes(1);
    });

    it('re-arms the transcript watcher and broadcasts interactive + updated', async () => {
      const session = makeParked();

      const body = JSON.parse((await resume()).body);
      expect(body.success).toBe(true);

      expect(harness.ctx.startTranscriptWatcher).toHaveBeenCalledWith(
        harness.ctx._sessionId,
        expect.stringContaining('-home-user-proj/conv-abc-123.jsonl')
      );
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:interactive', { id: harness.ctx._sessionId });
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', { session: expect.anything() });
      expect(session.paused).toBe(false);
    });

    it('rolls back to the parked state when startInteractive() rejects', async () => {
      const session = makeParked(1_700_000_000_000);
      session.startInteractive.mockRejectedValueOnce(new Error('spawn failed'));

      const body = JSON.parse((await resume()).body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');

      // Not limbo: the session goes back to being parked, with its original pausedAt.
      expect(session.markPaused).toHaveBeenCalledWith(1_700_000_000_000, false);
      expect(session.paused).toBe(true);
      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(session);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', { session: expect.anything() });
    });

    // ── C5: pause tears the respawn controller down; resume must rebuild it ──
    it('restores the paused side effects (respawn controller) on a successful resume', async () => {
      makeParked();

      const body = JSON.parse((await resume()).body);
      expect(body.success).toBe(true);
      expect(harness.ctx.resumeSessionSideEffects).toHaveBeenCalledWith(harness.ctx._sessionId);
    });

    it('does not restore side effects when the relaunch fails', async () => {
      const session = makeParked();
      session.startInteractive.mockRejectedValueOnce(new Error('spawn failed'));

      const body = JSON.parse((await resume()).body);
      expect(body.success).toBe(false);
      expect(harness.ctx.resumeSessionSideEffects).not.toHaveBeenCalled();
    });

    // ── C7: --resume only works while the local transcript still exists ──
    describe('transcript preflight', () => {
      it('refuses to resume when the local transcript is gone', async () => {
        const session = makeParked();
        harness.ctx.resolveSessionTranscript.mockReturnValueOnce(null);

        const body = JSON.parse((await resume()).body);
        expect(body.success).toBe(false);
        // A dedicated code (not the catch-all OPERATION_FAILED) is what lets the UI offer
        // the force ladder instead of leaving the session parked with no way out.
        expect(body.errorCode).toBe('TRANSCRIPT_UNAVAILABLE');
        expect(body.error).toMatch(/transcript is gone/i);

        // The session must stay parked and untouched — no fresh conversation started.
        expect(session.startInteractive).not.toHaveBeenCalled();
        expect(session.clearPaused).not.toHaveBeenCalled();
        expect(session.paused).toBe(true);
      });

      it('resumes anyway when force is passed, accepting the loss of history', async () => {
        const session = makeParked();
        harness.ctx.resolveSessionTranscript.mockReturnValueOnce(null);

        const res = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${harness.ctx._sessionId}/resume`,
          payload: { force: true },
        });
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(session.startInteractive).toHaveBeenCalledTimes(1);
      });

      it('checks the transcript for the session own resume id and working dir', async () => {
        const session = makeParked();

        await resume();
        expect(harness.ctx.resolveSessionTranscript).toHaveBeenCalledWith(session.workingDir, session.claudeResumeId);
      });
    });
  });

  // ========== Paused sessions must not be woken by other execution routes ==========

  describe('execution routes reject a paused session', () => {
    function park() {
      const session = harness.ctx._session;
      session.mode = 'claude';
      session.paused = true;
      return session;
    }

    it('POST /run does not start a prompt in a paused session', async () => {
      const session = park();
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'hello' },
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/paused/i);
      expect(session.runPrompt).not.toHaveBeenCalled();
    });

    it('POST /restart does not relaunch a paused session', async () => {
      const session = park();
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/restart`,
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/paused/i);
      expect(session.startInteractive).not.toHaveBeenCalled();
      expect(session.prepareForRestart).not.toHaveBeenCalled();
    });

    it('POST /shell does not open a shell in a paused session', async () => {
      const session = park();
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/paused/i);
      expect(session.startShell).not.toHaveBeenCalled();
    });
  });

  // ========== POST /api/sessions/:id/interactive — un-parking ==========

  describe('POST /api/sessions/:id/interactive un-parks a paused session', () => {
    async function startInteractive() {
      return harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
    }

    it('clears the paused flag, persists and re-registers listeners before starting', async () => {
      const session = harness.ctx._session;
      session.paused = true;
      session.pausedAt = 1_700_000_000_000;

      const body = JSON.parse((await startInteractive()).body);
      expect(body.success).toBe(true);

      expect(session.clearPaused).toHaveBeenCalledTimes(1);
      expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(session);
      expect(harness.ctx.ensureSessionListeners).toHaveBeenCalledWith(session);
      expect(harness.ctx.ensureSessionListeners.mock.invocationCallOrder[0]).toBeLessThan(
        session.startInteractive.mock.invocationCallOrder[0]
      );
      expect(session.paused).toBe(false);
    });

    it('restores the parked state when startInteractive() rejects', async () => {
      const session = harness.ctx._session;
      session.paused = true;
      session.pausedAt = 1_700_000_000_000;
      session.startInteractive.mockRejectedValueOnce(new Error('spawn failed'));

      const body = JSON.parse((await startInteractive()).body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');
      expect(session.markPaused).toHaveBeenCalledWith(1_700_000_000_000, false);
      expect(session.paused).toBe(true);
    });

    it('does not touch the paused bookkeeping for a live session', async () => {
      const session = harness.ctx._session;
      session.paused = false;

      const body = JSON.parse((await startInteractive()).body);
      expect(body.success).toBe(true);
      expect(session.clearPaused).not.toHaveBeenCalled();
      expect(harness.ctx.ensureSessionListeners).not.toHaveBeenCalled();
      expect(harness.ctx.resumeSessionSideEffects).not.toHaveBeenCalled();
    });

    // ── R3: un-parking here must obey the same rules as /resume ──
    it('refuses to un-park when the local transcript is gone', async () => {
      const session = harness.ctx._session;
      session.paused = true;
      harness.ctx.resolveSessionTranscript.mockReturnValueOnce(null);

      const body = JSON.parse((await startInteractive()).body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('TRANSCRIPT_UNAVAILABLE');
      expect(session.clearPaused).not.toHaveBeenCalled();
      expect(session.startInteractive).not.toHaveBeenCalled();
      expect(session.paused).toBe(true);
    });

    it('un-parks with force even when the transcript is gone', async () => {
      const session = harness.ctx._session;
      session.paused = true;
      harness.ctx.resolveSessionTranscript.mockReturnValueOnce(null);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
        payload: { force: true },
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(session.startInteractive).toHaveBeenCalledTimes(1);
    });

    it('restores the paused side effects after a successful un-park', async () => {
      const session = harness.ctx._session;
      session.paused = true;

      const body = JSON.parse((await startInteractive()).body);
      expect(body.success).toBe(true);
      // Without this the respawn controller pause tore down stays dead until a server restart.
      expect(harness.ctx.resumeSessionSideEffects).toHaveBeenCalledWith(harness.ctx._sessionId);
    });
  });

  // ========== POST /api/sessions/:id/input — paused rejection ==========

  describe('POST /api/sessions/:id/input on a paused session', () => {
    it('rejects the input instead of silently swallowing it', async () => {
      const session = harness.ctx._session;
      session.paused = true;
      const writeSpy = vi.spyOn(session, 'write');
      const writeViaMuxSpy = vi.spyOn(session, 'writeViaMux');

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: 'hello', useMux: true },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');
      expect(body.error).toBe('Session is paused — resume it before sending input');
      expect(writeSpy).not.toHaveBeenCalled();
      expect(writeViaMuxSpy).not.toHaveBeenCalled();
    });
  });
});

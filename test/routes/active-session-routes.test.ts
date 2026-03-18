import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerActiveSessionRoutes } from '../../src/web/routes/active-session-routes.js';
import { createMockSession } from '../mocks/mock-session.js';

// Mock screen-analyzer so tests don't call real tmux binary
vi.mock('../../src/screen-analyzer.js', () => ({
  captureScreen: vi.fn(() => null),
  analyzeScreen: vi.fn(() => ({
    state: 'waiting_for_input',
    lastVisibleText: '❯',
    hasClaudePresence: true,
    confidence: 90,
  })),
}));

describe('active session routes', () => {
  let harness: Awaited<ReturnType<typeof createRouteTestHarness>>;

  beforeAll(async () => {
    harness = await createRouteTestHarness(registerActiveSessionRoutes, { sessionId: 'test-session-1' });
  });

  afterAll(async () => {
    await harness.app.close();
  });

  // ── resolve-active ────────────────────────────────────────────

  describe('GET /api/sessions/resolve-active', () => {
    it('returns null when no sessions exist', async () => {
      harness.ctx.sessions.clear();
      harness.ctx.store.getActiveSessionId = vi.fn(() => null);
      harness.ctx.mux = { listAllTmuxSessions: vi.fn(() => []) } as any;

      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/resolve-active' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.sessionId).toBeNull();
      expect(body.confidence).toBe('none');
    });

    it('returns persisted session ID with high confidence when it has a live tmux session', async () => {
      const id = 'test-session-1';
      const session = createMockSession(id);
      harness.ctx.sessions.clear();
      harness.ctx.sessions.set(id, session);
      harness.ctx.store.getActiveSessionId = vi.fn(() => id);
      harness.ctx.mux = {
        listAllTmuxSessions: vi.fn(() => [
          { name: `codeman-${id.slice(0, 8)}`, windows: 1, createdAt: Date.now(), attached: true },
        ]),
      } as any;

      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/resolve-active' });
      const body = JSON.parse(res.body);
      expect(body.sessionId).toBe(id);
      expect(body.confidence).toBe('high');
    });

    it('falls back to most recent non-archived session when nothing persisted', async () => {
      const id = 'test-session-1';
      harness.ctx.sessions.clear();
      harness.ctx.sessions.set(id, createMockSession(id));
      harness.ctx.store.getActiveSessionId = vi.fn(() => null);
      harness.ctx.mux = { listAllTmuxSessions: vi.fn(() => []) } as any;

      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/resolve-active' });
      const body = JSON.parse(res.body);
      expect(body.sessionId).toBe(id);
    });
  });

  // ── mark-active ───────────────────────────────────────────────

  describe('POST /api/sessions/:id/mark-active', () => {
    it('returns 200 and saves to store', async () => {
      const id = 'test-session-1';
      harness.ctx.sessions.clear();
      harness.ctx.sessions.set(id, createMockSession(id));
      harness.ctx.store.setActiveSessionId = vi.fn();

      const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${id}/mark-active` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect(harness.ctx.store.setActiveSessionId).toHaveBeenCalledWith(id);
    });

    it('returns 404 for unknown session ID', async () => {
      harness.ctx.sessions.clear();
      const res = await harness.app.inject({ method: 'POST', url: '/api/sessions/nonexistent/mark-active' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for archived session', async () => {
      const id = 'test-session-1';
      const session = createMockSession(id);
      // Override toState to return archived status
      vi.spyOn(session, 'toState').mockReturnValue({ ...session.toState(), status: 'archived' } as any);
      harness.ctx.sessions.clear();
      harness.ctx.sessions.set(id, session);

      const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${id}/mark-active` });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── screen-snapshot ───────────────────────────────────────────

  describe('GET /api/sessions/:id/screen-snapshot', () => {
    it('returns 404 when session has no mux session', async () => {
      harness.ctx.sessions.set('test-session-1', createMockSession('test-session-1'));
      harness.ctx.mux = { getSession: vi.fn(() => undefined) } as any;

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/test-session-1/screen-snapshot',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 503 when captureScreen returns null', async () => {
      // captureScreen is mocked at module level to return null
      harness.ctx.sessions.set('test-session-1', createMockSession('test-session-1'));
      harness.ctx.mux = {
        getSession: vi.fn(() => ({ muxName: 'codeman-testtest', sessionId: 'test-session-1' })),
      } as any;

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/test-session-1/screen-snapshot',
      });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'screen_capture_failed' });
    });

    it('returns 200 with analysis when capture succeeds', async () => {
      // Override the module-level mock to return a screen string for this test
      const { captureScreen } = await import('../../src/screen-analyzer.js');
      vi.mocked(captureScreen).mockReturnValueOnce('❯ ');

      harness.ctx.sessions.set('test-session-1', createMockSession('test-session-1'));
      harness.ctx.mux = {
        getSession: vi.fn(() => ({ muxName: 'codeman-testtest', sessionId: 'test-session-1' })),
      } as any;

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/test-session-1/screen-snapshot',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.muxName).toBe('codeman-testtest');
      expect(body.analysis).toBeDefined();
      expect(typeof body.rawScreen).toBe('string');
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerUpdateRoutes } from '../../src/web/routes/update-routes.js';

describe('update routes', () => {
  describe('GET /api/update/check', () => {
    it('returns update info shape', async () => {
      const mockChecker = {
        check: vi.fn().mockResolvedValue({
          currentVersion: '0.5.0',
          latestVersion: '0.6.0',
          releaseNotes: 'New features',
          releaseUrl: 'https://github.com/SGudbrandsson/Codeman/releases/tag/v0.6.0',
          publishedAt: '2026-03-01T00:00:00Z',
          updateAvailable: true,
          checkedAt: Date.now(),
        }),
      };

      const { app } = await createRouteTestHarness((a, ctx) => registerUpdateRoutes(a, ctx, mockChecker as any));

      const res = await app.inject({ method: 'GET', url: '/api/update/check' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        currentVersion: '0.5.0',
        latestVersion: '0.6.0',
        updateAvailable: true,
      });
    });

    it('passes force=true when ?force=1 query param present', async () => {
      const mockChecker = {
        check: vi.fn().mockResolvedValue({
          currentVersion: '0.5.0',
          latestVersion: '0.5.0',
          releaseNotes: '',
          releaseUrl: '',
          publishedAt: '',
          updateAvailable: false,
          checkedAt: Date.now(),
        }),
      };

      const { app } = await createRouteTestHarness((a, ctx) => registerUpdateRoutes(a, ctx, mockChecker as any));

      await app.inject({ method: 'GET', url: '/api/update/check?force=1' });
      expect(mockChecker.check).toHaveBeenCalledWith(true);
    });
  });

  describe('POST /api/update/apply', () => {
    it('returns 400 when no updateRepoPath in settings', async () => {
      const mockChecker = { check: vi.fn() };
      const { app, ctx } = await createRouteTestHarness((a, c) => registerUpdateRoutes(a, c, mockChecker as any));
      ctx.store.getSettings.mockReturnValue({});

      const res = await app.inject({ method: 'POST', url: '/api/update/apply' });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/repo path/i);
    });

    it('returns 400 when updateRepoPath is empty string', async () => {
      const mockChecker = { check: vi.fn() };
      const { app, ctx } = await createRouteTestHarness((a, c) => registerUpdateRoutes(a, c, mockChecker as any));
      ctx.store.getSettings.mockReturnValue({ updateRepoPath: '' });

      const res = await app.inject({ method: 'POST', url: '/api/update/apply' });
      expect(res.statusCode).toBe(400);
    });
  });
});

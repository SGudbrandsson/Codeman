/**
 * @fileoverview Tests for POST /api/sessions/:id/auto-name route.
 *
 * Separated from session-routes.test.ts because this route needs
 * vi.mock('node:fs/promises') for settings file reads and mock
 * dynamic imports for @anthropic-ai/sdk.
 *
 * Uses app.inject() (Fastify's built-in test helper) — no real HTTP ports needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

// Mock node:fs/promises — only readFile is needed by the auto-name route
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => {
      throw new Error('ENOENT');
    }),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
    readdir: vi.fn(async () => []),
    rm: vi.fn(async () => {}),
    access: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
  },
}));

import fs from 'node:fs/promises';

const mockedReadFile = vi.mocked(fs.readFile);

describe('POST /api/sessions/:id/auto-name', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
    vi.clearAllMocks();

    // Default: settings file not found (auto-name enabled by default)
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('returns 404 for unknown session', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/auto-name',
    });
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
  });

  it('returns disabled when autoNameEnabled is false in settings', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ autoNameEnabled: false }));

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/auto-name`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.reason).toBe('disabled');
  });

  it('returns no-context when session has no workingDir, branch, notes, or name', async () => {
    const session = harness.ctx._session;
    session.workingDir = '';
    session.name = '';
    // worktreeBranch and worktreeNotes are not defined on MockSession, so they are undefined

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/auto-name`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.reason).toBe('no-context');
  });

  it('returns api-error when @anthropic-ai/sdk is not available', async () => {
    // Session has context (workingDir is set by default in MockSession)
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/auto-name`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.reason).toBe('api-error');
  });

  it('proceeds when settings file is missing (default: enabled)', async () => {
    // mockedReadFile already throws ENOENT by default
    // Session has context via workingDir
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/auto-name`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should not be 'disabled' — it proceeds past settings check
    expect(body.reason).not.toBe('disabled');
  });

  it('proceeds when autoNameEnabled is true in settings', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ autoNameEnabled: true }));

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/auto-name`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should not be 'disabled'
    expect(body.reason).not.toBe('disabled');
  });
});

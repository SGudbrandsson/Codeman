/**
 * @fileoverview Tests for system route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * Mocks: fs (promises + sync), subagentWatcher, imageWatcher,
 * session-lifecycle-log, and opencode-cli-resolver singletons.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('../../src/subagent-watcher.js', () => ({
  subagentWatcher: {
    getSubagents: vi.fn(() => []),
    getRecentSubagents: vi.fn(() => []),
    getSubagentsForSession: vi.fn(() => []),
    getSubagent: vi.fn(() => null),
    getTranscript: vi.fn(async () => []),
    formatTranscript: vi.fn(() => ''),
    killSubagent: vi.fn(async () => false),
    cleanupNow: vi.fn(() => 0),
    clearAll: vi.fn(() => 0),
    getStats: vi.fn(() => ({
      totalAgents: 0,
      activeAgents: 0,
      fileDebouncerCount: 0,
      dirWatcherCount: 0,
      idleTimerCount: 0,
    })),
    isRunning: vi.fn(() => true),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../../src/image-watcher.js', () => ({
  imageWatcher: {
    isRunning: vi.fn(() => false),
    start: vi.fn(),
    stop: vi.fn(),
    watchSession: vi.fn(),
  },
}));

vi.mock('../../src/session-lifecycle-log.js', () => ({
  getLifecycleLog: vi.fn(() => ({
    log: vi.fn(),
    query: vi.fn(async () => []),
  })),
}));

vi.mock('../../src/utils/opencode-cli-resolver.js', () => ({
  isOpenCodeAvailable: vi.fn(() => false),
  resolveOpenCodeDir: vi.fn(() => null),
}));

import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { subagentWatcher } from '../../src/subagent-watcher.js';
import { getLifecycleLog } from '../../src/session-lifecycle-log.js';
import { isOpenCodeAvailable, resolveOpenCodeDir } from '../../src/utils/opencode-cli-resolver.js';

const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedSubagentWatcher = vi.mocked(subagentWatcher);
const mockedGetLifecycleLog = vi.mocked(getLifecycleLog);
const mockedIsOpenCodeAvailable = vi.mocked(isOpenCodeAvailable);
const mockedResolveOpenCodeDir = vi.mocked(resolveOpenCodeDir);

describe('system-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
    vi.clearAllMocks();

    // Re-apply defaults after clearAllMocks
    mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockedWriteFile.mockResolvedValue(undefined);
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([]);
    mockedSubagentWatcher.getSubagents.mockReturnValue([]);
    mockedSubagentWatcher.getStats.mockReturnValue({
      totalAgents: 0,
      activeAgents: 0,
      fileDebouncerCount: 0,
      dirWatcherCount: 0,
      idleTimerCount: 0,
    } as never);
    mockedGetLifecycleLog.mockReturnValue({
      log: vi.fn(),
      query: vi.fn(async () => []),
    } as never);
    mockedIsOpenCodeAvailable.mockReturnValue(false);
    mockedResolveOpenCodeDir.mockReturnValue(null);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/status ==========

  describe('GET /api/status', () => {
    it('returns server status', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/status' });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.getLightState).toHaveBeenCalled();
    });
  });

  // ========== GET /api/config ==========

  describe('GET /api/config', () => {
    it('returns config', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.config).toBeDefined();
    });
  });

  // ========== PUT /api/config ==========

  describe('PUT /api/config', () => {
    it('updates config with valid payload', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { maxConcurrentSessions: 10 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.store.setConfig).toHaveBeenCalled();
    });

    it('rejects unknown config fields (strict schema)', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { unknownField: 'invalid' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/stats ==========

  describe('GET /api/stats', () => {
    it('returns aggregate stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.stats).toBeDefined();
    });
  });

  // ========== GET /api/token-stats ==========

  describe('GET /api/token-stats', () => {
    it('returns daily and aggregate token stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/token-stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.daily).toBeDefined();
      expect(body.totals).toBeDefined();
    });
  });

  // ========== GET /api/debug/memory ==========

  describe('GET /api/debug/memory', () => {
    it('returns memory and map usage info', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/debug/memory' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.memory).toBeDefined();
      expect(body.memory.rssMB).toBeGreaterThan(0);
      expect(body.mapSizes).toBeDefined();
      expect(body.uptime).toBeDefined();
    });
  });

  // ========== GET /api/system/stats ==========

  describe('GET /api/system/stats', () => {
    it('returns CPU and memory stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/system/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('cpu');
      expect(body).toHaveProperty('memory');
    });
  });

  // ========== POST /api/cleanup-state ==========

  describe('POST /api/cleanup-state', () => {
    it('cleans up stale session state', async () => {
      const res = await harness.app.inject({ method: 'POST', url: '/api/cleanup-state' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.cleanedSessions).toBe(0);
      expect(harness.ctx.store.cleanupStaleSessions).toHaveBeenCalled();
    });
  });

  // ========== GET /api/subagents ==========

  describe('GET /api/subagents', () => {
    it('returns subagent list', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });

    it('filters by minutes when query param provided', async () => {
      mockedSubagentWatcher.getRecentSubagents.mockReturnValue([]);
      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents?minutes=30' });
      expect(res.statusCode).toBe(200);
      expect(mockedSubagentWatcher.getRecentSubagents).toHaveBeenCalledWith(30);
    });
  });

  // ========== POST /api/auth/revoke ==========

  describe('POST /api/auth/revoke', () => {
    it('returns success even without auth sessions', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('revokes a specific session token', async () => {
      const authSessions = new Map();
      authSessions.set('tok-123', { ip: '1.2.3.4', ua: 'test', createdAt: Date.now(), method: 'basic' });
      harness.ctx.authSessions = authSessions;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: { sessionToken: 'tok-123' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(authSessions.has('tok-123')).toBe(false);
    });

    it('clears all sessions when no token specified', async () => {
      const authSessions = new Map();
      authSessions.set('a', { ip: '1', ua: '', createdAt: 0, method: 'basic' });
      authSessions.set('b', { ip: '2', ua: '', createdAt: 0, method: 'qr' });
      harness.ctx.authSessions = authSessions;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(authSessions.size).toBe(0);
    });
  });

  // ========== GET /api/settings ==========

  describe('GET /api/settings', () => {
    it('returns empty object when settings file does not exist', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });

    it('returns parsed settings when file exists', async () => {
      const settings = { subagentTrackingEnabled: true, showSystemStats: false };
      mockedReadFile.mockResolvedValue(JSON.stringify(settings) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(settings);
    });
  });

  // ========== PUT /api/settings ==========

  describe('PUT /api/settings', () => {
    it('saves valid settings', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { showSystemStats: true, subagentTrackingEnabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockedWriteFile).toHaveBeenCalled();
    });

    it('merges with existing settings', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ showCost: true }) as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { showTokenCount: false },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);

      // Verify writeFile was called with merged content
      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.showCost).toBe(true);
      expect(writtenContent.showTokenCount).toBe(false);
    });

    it('rejects unknown settings fields (strict schema)', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { unknownField: 'bad' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects non-object body', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: 'not-an-object',
        headers: { 'content-type': 'application/json' },
      });
      // Fastify will reject non-object JSON before it reaches the handler
      expect(res.statusCode).not.toBe(200);
    });
  });

  // ========== GET /api/subagent-window-states ==========

  describe('GET /api/subagent-window-states', () => {
    it('returns default when file does not exist', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-window-states' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ minimized: {}, open: [] });
    });

    it('returns persisted window states', async () => {
      const states = { minimized: { 'agent-1': true }, open: ['agent-2'] };
      mockedReadFile.mockResolvedValue(JSON.stringify(states) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-window-states' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(states);
    });
  });

  // ========== PUT /api/subagent-window-states ==========

  describe('PUT /api/subagent-window-states', () => {
    it('saves valid window states', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-window-states',
        payload: { minimized: { 'agent-1': true }, open: ['agent-2'] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(mockedWriteFile).toHaveBeenCalled();
    });

    it('accepts empty state', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-window-states',
        payload: { minimized: {}, open: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
    });

    it('rejects invalid minimized values', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-window-states',
        payload: { minimized: { 'agent-1': 'not-a-boolean' } },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/subagent-parents ==========

  describe('GET /api/subagent-parents', () => {
    it('returns empty object when file does not exist', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-parents' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });

    it('returns persisted parent map', async () => {
      const parents = { 'agent-1': 'session-abc', 'agent-2': 'session-xyz' };
      mockedReadFile.mockResolvedValue(JSON.stringify(parents) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-parents' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(parents);
    });
  });

  // ========== PUT /api/subagent-parents ==========

  describe('PUT /api/subagent-parents', () => {
    it('saves valid parent map', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-parents',
        payload: { 'agent-1': 'session-abc' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(mockedWriteFile).toHaveBeenCalled();
    });

    it('accepts empty parent map', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-parents',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
    });

    it('rejects non-string values in parent map', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-parents',
        payload: { 'agent-1': 123 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/screenshots ==========

  describe('GET /api/screenshots', () => {
    it('returns empty list when directory does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({ method: 'GET', url: '/api/screenshots' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ files: [] });
    });

    it('returns image files sorted in reverse order', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReaddirSync.mockReturnValue([
        'screenshot_2026-01-01_00-00-00.png',
        'screenshot_2026-01-02_00-00-00.png',
        'not-an-image.txt',
        'screenshot_2026-01-03_00-00-00.jpg',
      ] as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/screenshots' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.files).toHaveLength(3); // excludes .txt
      // Sorted reverse: 03, 02, 01
      expect(body.files[0].name).toBe('screenshot_2026-01-03_00-00-00.jpg');
      expect(body.files[1].name).toBe('screenshot_2026-01-02_00-00-00.png');
      expect(body.files[2].name).toBe('screenshot_2026-01-01_00-00-00.png');
    });
  });

  // ========== GET /api/screenshots/:name ==========

  describe('GET /api/screenshots/:name', () => {
    it('rejects path traversal attempts', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/..%2F..%2Fetc%2Fpasswd',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when screenshot does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/nonexistent.png',
      });
      expect(res.statusCode).toBe(404);
    });

    it('serves existing screenshot with correct content type', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFile.mockResolvedValue(Buffer.from('fake-png-data') as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/test-image.png',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
    });

    it('serves jpeg with correct content type', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFile.mockResolvedValue(Buffer.from('fake-jpg-data') as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/photo.jpg',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
    });
  });

  // ========== POST /api/screenshots ==========

  describe('POST /api/screenshots', () => {
    it('rejects non-multipart content type', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/screenshots',
        payload: { file: 'data' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('multipart');
    });
  });

  // ========== GET /api/session-lifecycle ==========

  describe('GET /api/session-lifecycle', () => {
    it('returns lifecycle entries', async () => {
      const mockEntries = [{ event: 'session_created', sessionId: 'test-1', timestamp: Date.now() }];
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: vi.fn(async () => mockEntries),
      } as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/session-lifecycle' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.entries).toEqual(mockEntries);
    });

    it('passes filter query params to lifecycle log', async () => {
      const queryFn = vi.fn(async () => []);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: queryFn,
      } as never);

      await harness.app.inject({
        method: 'GET',
        url: '/api/session-lifecycle?sessionId=s1&event=session_created&since=1000&limit=50',
      });

      expect(queryFn).toHaveBeenCalledWith({
        sessionId: 's1',
        event: 'session_created',
        since: 1000,
        limit: 50,
      });
    });

    it('caps limit at 1000', async () => {
      const queryFn = vi.fn(async () => []);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: queryFn,
      } as never);

      await harness.app.inject({
        method: 'GET',
        url: '/api/session-lifecycle?limit=5000',
      });

      expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
    });

    it('defaults limit to 200 when not specified', async () => {
      const queryFn = vi.fn(async () => []);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: queryFn,
      } as never);

      await harness.app.inject({ method: 'GET', url: '/api/session-lifecycle' });

      expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    });
  });

  // ========== GET /api/opencode/status ==========

  describe('GET /api/opencode/status', () => {
    it('returns unavailable when opencode is not installed', async () => {
      mockedIsOpenCodeAvailable.mockReturnValue(false);
      mockedResolveOpenCodeDir.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/opencode/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(false);
      expect(body.path).toBeNull();
    });

    it('returns available with path when opencode is installed', async () => {
      mockedIsOpenCodeAvailable.mockReturnValue(true);
      mockedResolveOpenCodeDir.mockReturnValue('/usr/local/bin');

      const res = await harness.app.inject({ method: 'GET', url: '/api/opencode/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
      expect(body.path).toBe('/usr/local/bin');
    });
  });

  // ========== GET /api/execution/model-config ==========

  describe('GET /api/execution/model-config', () => {
    it('returns empty data when settings file does not exist', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/execution/model-config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({});
    });

    it('returns model config from settings', async () => {
      const settings = { modelConfig: { model: 'claude-3', temperature: 0.7 } };
      mockedReadFile.mockResolvedValue(JSON.stringify(settings) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/execution/model-config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(settings.modelConfig);
    });

    it('returns empty data when settings has no modelConfig', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ showCost: true }) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/execution/model-config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({});
    });
  });

  // ========== PUT /api/execution/model-config ==========

  describe('PUT /api/execution/model-config', () => {
    it('saves valid model config', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/execution/model-config',
        payload: { model: 'claude-3', temperature: 0.5 },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(mockedWriteFile).toHaveBeenCalled();

      // Verify the written content contains modelConfig
      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.modelConfig).toEqual({ model: 'claude-3', temperature: 0.5 });
    });

    it('preserves existing settings when updating model config', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ showCost: true, other: 'value' }) as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/execution/model-config',
        payload: { model: 'new-model' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);

      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.showCost).toBe(true);
      expect(writtenContent.other).toBe('value');
      expect(writtenContent.modelConfig).toEqual({ model: 'new-model' });
    });
  });

  // ========== GET /api/subagents/:agentId ==========

  describe('GET /api/subagents/:agentId', () => {
    it('returns 200 with error for unknown agent', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents/unknown-agent' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('returns agent info for known agent', async () => {
      const agentInfo = { agentId: 'agent-1', status: 'active', pid: 1234 };
      mockedSubagentWatcher.getSubagent.mockReturnValue(agentInfo as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents/agent-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(agentInfo);
    });
  });

  // ========== GET /api/subagents/:agentId/transcript ==========

  describe('GET /api/subagents/:agentId/transcript', () => {
    it('returns raw transcript by default', async () => {
      const transcript = [{ role: 'assistant', content: 'hello' }];
      mockedSubagentWatcher.getTranscript.mockResolvedValue(transcript as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/subagents/agent-1/transcript',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(transcript);
    });

    it('returns formatted transcript when format=formatted', async () => {
      const transcript = [{ role: 'assistant', content: 'hello' }];
      mockedSubagentWatcher.getTranscript.mockResolvedValue(transcript as never);
      mockedSubagentWatcher.formatTranscript.mockReturnValue('## Formatted\nhello');

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/subagents/agent-1/transcript?format=formatted',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.formatted).toBe('## Formatted\nhello');
      expect(body.data.entryCount).toBe(1);
    });

    it('passes limit parameter', async () => {
      mockedSubagentWatcher.getTranscript.mockResolvedValue([] as never);

      await harness.app.inject({
        method: 'GET',
        url: '/api/subagents/agent-1/transcript?limit=10',
      });
      expect(mockedSubagentWatcher.getTranscript).toHaveBeenCalledWith('agent-1', 10);
    });
  });

  // ========== DELETE /api/subagents/:agentId ==========

  describe('DELETE /api/subagents/:agentId', () => {
    it('returns error for unknown agent', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/unknown' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('kills a known agent successfully', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue({ agentId: 'agent-1' } as never);
      mockedSubagentWatcher.killSubagent.mockResolvedValue(true);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/agent-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('killed');
    });

    it('returns error when kill fails', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue({ agentId: 'agent-1' } as never);
      mockedSubagentWatcher.killSubagent.mockResolvedValue(false);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/agent-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already completed');
    });
  });

  // ========== POST /api/subagents/cleanup ==========

  describe('POST /api/subagents/cleanup', () => {
    it('triggers cleanup and returns count', async () => {
      mockedSubagentWatcher.cleanupNow.mockReturnValue(3);
      mockedSubagentWatcher.getSubagents.mockReturnValue([{ agentId: 'a' }, { agentId: 'b' }] as never);

      const res = await harness.app.inject({ method: 'POST', url: '/api/subagents/cleanup' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.removed).toBe(3);
      expect(body.data.remaining).toBe(2);
    });
  });

  // ========== DELETE /api/subagents ==========

  describe('DELETE /api/subagents', () => {
    it('clears all subagents', async () => {
      mockedSubagentWatcher.clearAll.mockReturnValue(5);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.cleared).toBe(5);
    });
  });

  // ========== GET /api/sessions/:id/subagents ==========

  describe('GET /api/sessions/:id/subagents', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/subagents',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns subagents for valid session', async () => {
      mockedSubagentWatcher.getSubagentsForSession.mockReturnValue([{ agentId: 'sub-1', status: 'active' }] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/subagents`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
    });
  });

  // ========== POST /api/sessions/:id/upload ==========

  describe('POST /api/sessions/:id/upload', () => {
    /**
     * The upload endpoint reads req.raw directly (same as screenshots).
     * Fastify needs a content-type parser for multipart/form-data registered
     * (done in server.ts but not in the test harness). We create a dedicated
     * harness with the parser for these tests.
     */
    let uploadHarness: RouteTestHarness;

    beforeEach(async () => {
      const Fastify = (await import('fastify')).default;
      const fastifyCookie = (await import('@fastify/cookie')).default;
      const { createMockRouteContext } = await import('../mocks/index.js');

      const app = Fastify({ logger: false });
      await app.register(fastifyCookie);
      // Register the multipart parser that server.ts normally provides
      app.addContentTypeParser('multipart/form-data', (_req: unknown, _payload: unknown, done: (err: null) => void) => {
        done(null);
      });
      const ctx = createMockRouteContext();
      registerSystemRoutes(app, ctx as never);
      await app.ready();
      uploadHarness = { app, ctx };

      // Re-apply fs mocks for this sub-harness
      mockedExistsSync.mockReturnValue(false);
      mockedWriteFile.mockResolvedValue(undefined);
    });

    afterEach(async () => {
      await uploadHarness.app.close();
    });

    /** Build a multipart/form-data body with the given filename and content buffer */
    function buildMultipart(filename: string, content: Buffer, fieldName = 'file') {
      const boundary = '----TestBoundary123';
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      return {
        body: Buffer.concat([header, content, footer]),
        contentType: `multipart/form-data; boundary=${boundary}`,
      };
    }

    it('uploads a non-image file successfully', async () => {
      const { body, contentType } = buildMultipart('report.pdf', Buffer.from('pdf-content'));

      const res = await uploadHarness.app.inject({
        method: 'POST',
        url: `/api/sessions/${uploadHarness.ctx._sessionId}/upload`,
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
      expect(data.filename).toBe('report.pdf');
      expect(data.path).toContain('.codeman-uploads');
      expect(data.path).toContain('report.pdf');
      expect(data.isImage).toBe(false);
      expect(mockedWriteFile).toHaveBeenCalled();
    });

    it('sets isImage true for image extensions', async () => {
      const { body, contentType } = buildMultipart('photo.png', Buffer.from('png-data'));

      const res = await uploadHarness.app.inject({
        method: 'POST',
        url: `/api/sessions/${uploadHarness.ctx._sessionId}/upload`,
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.isImage).toBe(true);
    });

    it('sets isImage true for jpg, jpeg, webp, gif, svg, bmp, ico', async () => {
      for (const ext of ['jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico']) {
        mockedExistsSync.mockReturnValue(false);
        mockedWriteFile.mockResolvedValue(undefined);
        const { body, contentType } = buildMultipart(`img.${ext}`, Buffer.from('data'));
        const res = await uploadHarness.app.inject({
          method: 'POST',
          url: `/api/sessions/${uploadHarness.ctx._sessionId}/upload`,
          headers: { 'content-type': contentType },
          body,
        });
        const data = JSON.parse(res.body);
        expect(data.isImage).toBe(true);
      }
    });

    it('handles duplicate filenames with numeric suffix', async () => {
      let callCount = 0;
      mockedExistsSync.mockImplementation(() => {
        callCount++;
        // call 1: uploadsDir check -> exists
        // call 2: if(existsSync(filepath)) -> true (duplicate exists)
        // call 3: while(existsSync(filepath)) -> true (same original path)
        // call 4: while(existsSync(filepath)) -> false (renamed path "(1)" doesn't exist)
        return callCount <= 3;
      });

      const { body, contentType } = buildMultipart('report.pdf', Buffer.from('content'));
      const res = await uploadHarness.app.inject({
        method: 'POST',
        url: `/api/sessions/${uploadHarness.ctx._sessionId}/upload`,
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.filename).toBe('report (1).pdf');
    });

    it('sanitizes path traversal characters from filename', async () => {
      const { body, contentType } = buildMultipart('../../../etc/passwd', Buffer.from('bad'));

      const res = await uploadHarness.app.inject({
        method: 'POST',
        url: `/api/sessions/${uploadHarness.ctx._sessionId}/upload`,
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.filename).not.toContain('/');
      expect(data.filename).not.toContain('\\');
    });

    it('rejects files exceeding 10MB', async () => {
      const largeContent = Buffer.alloc(11 * 1024 * 1024, 'x');
      const { body, contentType } = buildMultipart('big.bin', largeContent);

      const res = await uploadHarness.app.inject({
        method: 'POST',
        url: `/api/sessions/${uploadHarness.ctx._sessionId}/upload`,
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(413);
      const data = JSON.parse(res.body);
      expect(data.error).toContain('too large');
    });

    it('returns 404 for non-existent session', async () => {
      const { body, contentType } = buildMultipart('file.txt', Buffer.from('data'));

      const res = await uploadHarness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/upload',
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns error when session has no workingDir', async () => {
      uploadHarness.ctx._session.workingDir = '';
      const { body, contentType } = buildMultipart('file.txt', Buffer.from('data'));

      const res = await uploadHarness.app.inject({
        method: 'POST',
        url: `/api/sessions/${uploadHarness.ctx._sessionId}/upload`,
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toContain('working directory');
    });

    it('rejects non-multipart content type', async () => {
      const res = await uploadHarness.app.inject({
        method: 'POST',
        url: `/api/sessions/${uploadHarness.ctx._sessionId}/upload`,
        payload: { file: 'data' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(false);
      expect(data.error).toContain('multipart');
    });

    it('rejects request with no file part', async () => {
      const boundary = '----TestBoundary123';
      const body = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="other"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\ndata\r\n--${boundary}--\r\n`
      );

      const res = await uploadHarness.app.inject({
        method: 'POST',
        url: `/api/sessions/${uploadHarness.ctx._sessionId}/upload`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(false);
      expect(data.error).toContain('No file uploaded');
    });
  });

  // ========== POST /api/tunnel/qr/regenerate ==========

  describe('POST /api/tunnel/qr/regenerate', () => {
    it('calls regenerateQrToken on tunnel manager', async () => {
      // Set up a mock tunnel manager
      harness.ctx.tunnelManager = {
        regenerateQrToken: vi.fn(),
        getStatus: vi.fn(() => ({ running: false })),
        getUrl: vi.fn(() => null),
        getQrSvg: vi.fn(),
        consumeToken: vi.fn(),
        isRunning: vi.fn(() => false),
        start: vi.fn(),
        stop: vi.fn(),
      } as never;

      // Re-create the harness since tunnelManager was null originally
      await harness.app.close();
      harness = await createRouteTestHarness(registerSystemRoutes);
      harness.ctx.tunnelManager = {
        regenerateQrToken: vi.fn(),
        getStatus: vi.fn(() => ({ running: false })),
        getUrl: vi.fn(() => null),
        getQrSvg: vi.fn(),
        consumeToken: vi.fn(),
        isRunning: vi.fn(() => false),
        start: vi.fn(),
        stop: vi.fn(),
      } as never;

      const res = await harness.app.inject({ method: 'POST', url: '/api/tunnel/qr/regenerate' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
    });
  });
});

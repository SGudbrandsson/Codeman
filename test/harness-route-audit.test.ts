/**
 * @fileoverview Task 6 — route and CLI audit.
 *
 * Exercises the REAL routes (via Fastify's app.inject) to prove that harness
 * availability, model defaults, and harness config plumbing read the registry
 * instead of testing for "not shell" / "not opencode".
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';

// ── Mocks ──────────────────────────────────────────────────────────

// Binary resolution is machine-dependent; drive it from the test instead.
vi.mock('../src/harnesses/resolver.js', () => ({
  resolveHarnessDir: vi.fn(() => '/usr/local/bin'),
  isHarnessAvailable: vi.fn(() => true),
  _clearResolverCache: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
    writeFile: vi.fn(async () => {}),
  },
}));

interface RecordedSessionOptions {
  mode?: string;
  model?: string;
  openCodeConfig?: { model?: string };
  codexConfig?: { model?: string };
  piConfig?: { model?: string };
}

const createdSessions: RecordedSessionOptions[] = [];

vi.mock('../src/session.js', () => {
  function MockSessionConstructor(this: Record<string, unknown>, opts: RecordedSessionOptions) {
    createdSessions.push(opts);
    Object.assign(this, {
      id: `mock-session-${createdSessions.length}`,
      workingDir: '/tmp',
      mode: opts?.mode ?? 'claude',
      name: 'mock',
      ralphTracker: { enabled: false, enable: vi.fn(), enableAutoEnable: vi.fn() },
      toState: vi.fn(() => ({ id: 'mock-session' })),
      startInteractive: vi.fn().mockResolvedValue(undefined),
      startShell: vi.fn().mockResolvedValue(undefined),
      setClaudeResumeId: vi.fn(),
      writeViaMux: vi.fn().mockResolvedValue(true),
      isBusy: vi.fn(() => false),
    });
  }
  return { Session: MockSessionConstructor };
});

vi.mock('../src/session-lifecycle-log.js', () => ({
  getLifecycleLog: vi.fn(() => ({ log: vi.fn(), query: vi.fn(async () => []) })),
}));

import { registerSystemRoutes } from '../src/web/routes/system-routes.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { registerWorktreeSessionRoutes } from '../src/web/routes/worktree-session-routes.js';
import { isHarnessAvailable, resolveHarnessDir } from '../src/harnesses/resolver.js';

const mockedIsAvailable = vi.mocked(isHarnessAvailable);
const mockedResolveDir = vi.mocked(resolveHarnessDir);

describe('Task 6 — route and CLI audit', () => {
  let system: RouteTestHarness;
  let sessionRoutes: RouteTestHarness;
  let worktree: RouteTestHarness;

  beforeEach(async () => {
    createdSessions.length = 0;
    mockedIsAvailable.mockReturnValue(true);
    mockedResolveDir.mockReturnValue('/usr/local/bin');
    system = await createRouteTestHarness(registerSystemRoutes);
    sessionRoutes = await createRouteTestHarness(registerSessionRoutes);
    worktree = await createRouteTestHarness(registerWorktreeSessionRoutes);
  });

  afterEach(async () => {
    await system.app.close();
    await sessionRoutes.app.close();
    await worktree.app.close();
    vi.clearAllMocks();
  });

  // ========== GET /api/harnesses ==========

  describe('GET /api/harnesses', () => {
    it('lists all five harnesses with labels and availability', async () => {
      const res = await system.app.inject({ method: 'GET', url: '/api/harnesses' });
      expect(res.statusCode).toBe(200);
      const ids = res
        .json()
        .harnesses.map((h: { id: string }) => h.id)
        .sort();
      expect(ids).toEqual(['claude', 'codex', 'opencode', 'pi', 'shell']);
    });

    it('exposes label, shortLabel, installHint, available and caps for each harness', async () => {
      const res = await system.app.inject({ method: 'GET', url: '/api/harnesses' });
      const codex = res.json().harnesses.find((h: { id: string }) => h.id === 'codex');
      expect(codex).toMatchObject({
        id: 'codex',
        label: 'Codex',
        shortLabel: 'cx',
        available: true,
      });
      expect(typeof codex.installHint).toBe('string');
      expect(codex.caps).toMatchObject({ ralph: false, claudeTranscript: false, requiresMux: true });
    });

    it('reports a harness as unavailable when its binary does not resolve', async () => {
      mockedIsAvailable.mockReturnValue(false);
      const res = await system.app.inject({ method: 'GET', url: '/api/harnesses' });
      expect(res.json().harnesses.every((h: { available: boolean }) => h.available === false)).toBe(true);
    });
  });

  // ========== GET /api/harness/:id/status ==========

  describe('GET /api/harness/:id/status', () => {
    it('404s on an unknown harness', async () => {
      const res = await system.app.inject({ method: 'GET', url: '/api/harness/nope/status' });
      expect(res.statusCode).toBe(404);
    });

    it('reports availability and path for a known harness', async () => {
      const res = await system.app.inject({ method: 'GET', url: '/api/harness/pi/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: true, path: '/usr/local/bin' });
    });

    it('reports a null path for shell, which has no binary', async () => {
      const res = await system.app.inject({ method: 'GET', url: '/api/harness/shell/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: true, path: null });
    });

    it('keeps the legacy opencode alias working', async () => {
      const res = await system.app.inject({ method: 'GET', url: '/api/opencode/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('available');
      expect(res.json()).toHaveProperty('path');
    });
  });

  // ========== POST /api/sessions ==========

  describe('POST /api/sessions', () => {
    it('does not hand the Claude default model to a codex session', async () => {
      sessionRoutes.ctx.getModelConfig.mockResolvedValue({ defaultModel: 'opus' } as never);
      const res = await sessionRoutes.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir: '/tmp', mode: 'codex' },
      });
      expect(res.statusCode).toBe(200);
      expect(createdSessions).toHaveLength(1);
      expect(createdSessions[0].model).toBeUndefined();
    });

    it('still hands the Claude default model to a claude session', async () => {
      sessionRoutes.ctx.getModelConfig.mockResolvedValue({ defaultModel: 'opus' } as never);
      await sessionRoutes.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir: '/tmp', mode: 'claude' },
      });
      expect(createdSessions[0].model).toBe('opus');
    });

    it('prefers an explicit codex model over the Claude default', async () => {
      sessionRoutes.ctx.getModelConfig.mockResolvedValue({ defaultModel: 'opus' } as never);
      await sessionRoutes.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir: '/tmp', mode: 'codex', codexConfig: { model: 'gpt-5.2' } },
      });
      expect(createdSessions[0].model).toBe('gpt-5.2');
      expect(createdSessions[0].codexConfig).toEqual({ model: 'gpt-5.2' });
      expect(createdSessions[0].piConfig).toBeUndefined();
      expect(createdSessions[0].openCodeConfig).toBeUndefined();
    });

    it('passes piConfig through for a pi session', async () => {
      await sessionRoutes.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir: '/tmp', mode: 'pi', piConfig: { model: 'anthropic/sonnet' } },
      });
      expect(createdSessions[0].piConfig).toEqual({ model: 'anthropic/sonnet' });
      expect(createdSessions[0].codexConfig).toBeUndefined();
    });

    it('refuses to create a session whose harness binary is missing', async () => {
      mockedIsAvailable.mockReturnValue(false);
      const res = await sessionRoutes.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { workingDir: '/tmp', mode: 'pi' },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toContain('Pi CLI not found');
      expect(createdSessions).toHaveLength(0);
    });

    it('rejects a create with claudeResumeId on a non-claude mode', async () => {
      const res = await sessionRoutes.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          workingDir: '/tmp',
          mode: 'codex',
          claudeResumeId: '11111111-2222-4333-8444-555555555555',
        },
      });
      expect(res.json().success).toBe(false);
      expect(createdSessions).toHaveLength(0);
    });
  });

  // ========== POST /api/quick-start ==========

  describe('POST /api/quick-start', () => {
    it('does not hand the Claude default model to a pi session and passes piConfig', async () => {
      sessionRoutes.ctx.getModelConfig.mockResolvedValue({ defaultModel: 'opus' } as never);
      const res = await sessionRoutes.app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'testcase', mode: 'pi', piConfig: { model: 'anthropic/sonnet' } },
      });
      expect(res.statusCode).toBe(200);
      expect(createdSessions).toHaveLength(1);
      expect(createdSessions[0].model).toBe('anthropic/sonnet');
      expect(createdSessions[0].piConfig).toEqual({ model: 'anthropic/sonnet' });
    });

    it('refuses a quick-start whose harness binary is missing', async () => {
      mockedIsAvailable.mockReturnValue(false);
      const res = await sessionRoutes.app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'testcase', mode: 'codex' },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toContain('Codex CLI not found');
      expect(createdSessions).toHaveLength(0);
    });
  });

  // ========== POST /api/sessions/:id/worktree ==========

  describe('POST /api/sessions/:id/worktree', () => {
    it('refuses to create a worktree session whose harness binary is missing', async () => {
      mockedIsAvailable.mockReturnValue(false);
      const res = await worktree.app.inject({
        method: 'POST',
        url: `/api/sessions/${worktree.ctx._sessionId}/worktree`,
        payload: { branch: 'feat/x', isNew: true, mode: 'codex' },
      });
      expect(res.json().success).toBe(false);
      expect(res.json().error).toContain('Codex CLI not found');
    });
  });
});

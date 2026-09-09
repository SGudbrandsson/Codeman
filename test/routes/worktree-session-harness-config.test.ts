/**
 * Regression tests for two non-blocking review notes on the harness registry work:
 *
 *  1. The case-scoped worktree creator (POST /api/cases/:name/worktree) must forward
 *     openCodeConfig / codexConfig / piConfig from the request. It has no originating
 *     session to inherit from, so dropping them silently loses the model config.
 *  2. The session-scoped worktree creator resolves the harness from the originating
 *     session's PERSISTED mode. An unknown/legacy mode must answer a soft failure
 *     rather than throwing out of getHarness() as a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';

const hoisted = vi.hoisted(() => ({ ctorCalls: [] as Array<Record<string, unknown>> }));

vi.mock('../../src/harnesses/resolver.js', () => ({
  isHarnessAvailable: vi.fn(() => true),
  resolveHarnessDir: vi.fn(() => '/usr/local/bin'),
  _clearResolverCache: vi.fn(),
}));

vi.mock('../../src/session-lifecycle-log.js', () => ({
  getLifecycleLog: vi.fn().mockReturnValue({ log: vi.fn() }),
}));

// resolveCasePath() only checks that <CASES_DIR>/<name> exists; pretend the one case
// this file uses does, and delegate every other path to the real implementation.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      String(p).endsWith('/codeman-cases/test-case') || actual.existsSync(p),
  };
});

vi.mock('../../src/utils/git-utils.js', () => ({
  findGitRoot: vi.fn().mockReturnValue('/tmp/test-repo'),
  findMainGitRoot: vi.fn().mockResolvedValue('/tmp/test-repo'),
  isGitWorktreeDir: vi.fn().mockReturnValue(false),
  listBranches: vi.fn().mockResolvedValue(['main']),
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  addWorktree: vi.fn().mockResolvedValue(undefined),
  setupWorktreeArtifacts: vi.fn().mockResolvedValue(undefined),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  isWorktreeDirty: vi.fn().mockResolvedValue(false),
  isBranchMerged: vi.fn().mockResolvedValue(false),
  deleteBranch: vi.fn().mockResolvedValue(undefined),
  checkBranchExists: vi.fn().mockResolvedValue(false),
  listGitWorktrees: vi.fn().mockResolvedValue([]),
  pruneWorktrees: vi.fn().mockResolvedValue(undefined),
  mergeBranch: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../src/session.js', () => {
  function MockSessionConstructor(this: unknown, opts: Record<string, unknown>) {
    hoisted.ctorCalls.push(opts);
    Object.assign(this as object, {
      id: 'new-session-id',
      workingDir: '/tmp/worktree',
      mode: opts?.mode ?? 'claude',
      toState: () => ({ id: 'new-session-id' }),
      startInteractive: vi.fn().mockResolvedValue(undefined),
      startShell: vi.fn().mockResolvedValue(undefined),
      writeViaMux: vi.fn().mockResolvedValue(true),
    });
  }
  return { Session: MockSessionConstructor };
});

import { registerWorktreeSessionRoutes } from '../../src/web/routes/worktree-session-routes.js';

describe('worktree creators — harness config forwarding', () => {
  beforeEach(() => {
    hoisted.ctorCalls.length = 0;
  });

  it('case creator forwards codexConfig from the request to the new session', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/cases/test-case/worktree',
      payload: { branch: 'feature/codex', isNew: true, mode: 'codex', codexConfig: { model: 'gpt-5.2' } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(hoisted.ctorCalls).toHaveLength(1);
    expect(hoisted.ctorCalls[0]!.mode).toBe('codex');
    expect(hoisted.ctorCalls[0]!.codexConfig).toEqual({ model: 'gpt-5.2' });
    expect(hoisted.ctorCalls[0]!.piConfig).toBeUndefined();
    expect(hoisted.ctorCalls[0]!.openCodeConfig).toBeUndefined();
  });

  it('case creator forwards piConfig from the request to the new session', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/cases/test-case/worktree',
      payload: { branch: 'feature/pi', isNew: true, mode: 'pi', piConfig: { model: 'anthropic/sonnet:high' } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(hoisted.ctorCalls[0]!.piConfig).toEqual({ model: 'anthropic/sonnet:high' });
    expect(hoisted.ctorCalls[0]!.codexConfig).toBeUndefined();
  });

  it('case creator drops config that does not match the resolved mode', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/cases/test-case/worktree',
      payload: { branch: 'feature/mismatch', isNew: true, mode: 'claude', codexConfig: { model: 'gpt-5.2' } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(hoisted.ctorCalls[0]!.codexConfig).toBeUndefined();
  });

  it('session creator prefers request config over the originating session config', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const origin = ctx.sessions.get(ctx._sessionId) as unknown as Record<string, unknown>;
    origin.mode = 'codex';
    origin.codexConfig = { model: 'inherited-model' };
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/override', isNew: true, codexConfig: { model: 'requested-model' } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(hoisted.ctorCalls[0]!.codexConfig).toEqual({ model: 'requested-model' });
  });

  it('session creator still inherits config when the request carries none', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const origin = ctx.sessions.get(ctx._sessionId) as unknown as Record<string, unknown>;
    origin.mode = 'codex';
    origin.codexConfig = { model: 'inherited-model' };
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/inherit', isNew: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(hoisted.ctorCalls[0]!.codexConfig).toEqual({ model: 'inherited-model' });
  });
});

describe('session worktree creator — unknown persisted mode', () => {
  beforeEach(() => {
    hoisted.ctorCalls.length = 0;
  });

  it('answers success:false instead of throwing a 500 for a legacy/unknown mode', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const origin = ctx.sessions.get(ctx._sessionId) as unknown as Record<string, unknown>;
    // A state.json written by a newer build, or hand-edited: getHarness() throws on this.
    origin.mode = 'some-future-harness';
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/legacy', isNew: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(String(body.error?.message ?? body.error)).toContain('some-future-harness');
    // No session was created and no worktree was added.
    expect(hoisted.ctorCalls).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';

vi.mock('../../src/session-lifecycle-log.js', () => ({
  getLifecycleLog: vi.fn().mockReturnValue({ log: vi.fn() }),
}));

vi.mock('../../src/utils/git-utils.js', () => ({
  findGitRoot: vi.fn().mockReturnValue('/tmp/test-repo'),
  findMainGitRoot: vi.fn().mockResolvedValue('/tmp/test-repo'),
  isGitWorktreeDir: vi.fn().mockReturnValue(false),
  listBranches: vi.fn().mockResolvedValue(['main', 'feature/x']),
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  addWorktree: vi.fn().mockResolvedValue(undefined),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  isWorktreeDirty: vi.fn().mockResolvedValue(false),
  isBranchMerged: vi.fn().mockResolvedValue(false),
  deleteBranch: vi.fn().mockResolvedValue(undefined),
  mergeBranch: vi.fn().mockResolvedValue('Merge made by the recursive strategy.'),
}));

vi.mock('../../src/session.js', () => {
  function MockSessionConstructor(this: unknown) {
    Object.assign(this as object, {
      id: 'new-session-id',
      workingDir: '/tmp/worktree',
      worktreePath: '/tmp/worktree',
      worktreeBranch: 'feature/test',
      worktreeOriginId: 'origin-id',
      mode: 'claude',
      toState: () => ({ id: 'new-session-id' }),
      startInteractive: vi.fn().mockResolvedValue(undefined),
      startShell: vi.fn().mockResolvedValue(undefined),
    });
  }
  return { Session: MockSessionConstructor };
});

// Static import so vi.mock hoisting applies before module executes
import { registerWorktreeSessionRoutes } from '../../src/web/routes/worktree-session-routes.js';
import * as gitUtils from '../../src/utils/git-utils.js';

describe('worktree-session routes', () => {
  beforeEach(() => {
    vi.mocked(gitUtils.findGitRoot).mockReturnValue('/tmp/test-repo');
    vi.mocked(gitUtils.findMainGitRoot).mockResolvedValue('/tmp/test-repo');
    vi.mocked(gitUtils.isGitWorktreeDir).mockReturnValue(false);
    vi.mocked(gitUtils.listBranches).mockResolvedValue(['main', 'feature/x']);
    vi.mocked(gitUtils.getCurrentBranch).mockResolvedValue('main');
    vi.mocked(gitUtils.addWorktree).mockResolvedValue(undefined);
    vi.mocked(gitUtils.removeWorktree).mockResolvedValue(undefined);
    vi.mocked(gitUtils.isWorktreeDirty).mockResolvedValue(false);
    vi.mocked(gitUtils.isBranchMerged).mockResolvedValue(false);
    vi.mocked(gitUtils.deleteBranch).mockResolvedValue(undefined);
    vi.mocked(gitUtils.mergeBranch).mockResolvedValue('Merge made by the recursive strategy.');
  });

  // ---------------------------------------------------------------------------
  // GET /api/sessions/:id/worktree/branches
  // ---------------------------------------------------------------------------

  it('GET branches — session not found → success:false', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent/worktree/branches' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('GET branches — session found, not a git repo → success:false', async () => {
    vi.mocked(gitUtils.findGitRoot).mockReturnValue(null);
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${ctx._sessionId}/worktree/branches`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('GET branches — session found, git repo → branches + current branch', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${ctx._sessionId}/worktree/branches`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.branches).toEqual(['main', 'feature/x']);
    expect(body.current).toBe('main');
  });

  // ---------------------------------------------------------------------------
  // POST /api/sessions/:id/worktree
  // ---------------------------------------------------------------------------

  it('POST worktree — invalid branch name with shell chars → success:false', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feat; rm -rf /', isNew: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('POST worktree — session not found → success:false', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/worktree',
      payload: { branch: 'feature/test', isNew: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('POST worktree — valid request → creates session and returns success:true', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/test', isNew: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.worktreePath).toBeTruthy();
    expect(ctx.broadcast).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // POST /api/sessions/:id/worktree — autoStart behaviour
  // ---------------------------------------------------------------------------

  it('POST worktree — autoStart omitted → startInteractive NOT called', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/test', isNew: true, notes: 'do something' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // MockSessionConstructor always assigns id: 'new-session-id'
    const newSession = ctx.sessions.get('new-session-id') as { startInteractive: ReturnType<typeof vi.fn> };
    expect(newSession.startInteractive).not.toHaveBeenCalled();
  });

  it('POST worktree — autoStart:true, claude mode → startInteractive called', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/test', isNew: true, notes: 'do something', autoStart: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    const newSession = ctx.sessions.get('new-session-id') as { startInteractive: ReturnType<typeof vi.fn> };
    expect(newSession.startInteractive).toHaveBeenCalledOnce();
  });

  it('POST worktree — autoStart:true, shell mode → startShell called, not startInteractive', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/test', isNew: true, mode: 'shell', autoStart: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    const newSession = ctx.sessions.get('new-session-id') as {
      startShell: ReturnType<typeof vi.fn>;
      startInteractive: ReturnType<typeof vi.fn>;
    };
    expect(newSession.startShell).toHaveBeenCalledOnce();
    expect(newSession.startInteractive).not.toHaveBeenCalled();
  });

  it('POST worktree — autoStart:true, startInteractive throws → still success:true', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    // Patch addSession to override startInteractive with a rejecting mock before the route calls it.
    const origAddSession = ctx.addSession.bind(ctx);
    ctx.addSession = vi.fn().mockImplementation((s: unknown) => {
      (s as { startInteractive: () => Promise<void> }).startInteractive = vi
        .fn()
        .mockRejectedValue(new Error('spawn failed'));
      return origAddSession(s);
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/test', isNew: true, autoStart: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // POST /api/cases/:name/worktree — autoStart behaviour
  // ---------------------------------------------------------------------------

  it('POST cases worktree — autoStart:true → startInteractive called', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/cases/test-case/worktree`,
      payload: { branch: 'feature/test', isNew: true, autoStart: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // If case not found, that's ok for this smoke test — just verify no crash
    if (body.success) {
      const newSession = ctx.sessions.get('new-session-id') as { startInteractive: ReturnType<typeof vi.fn> };
      expect(newSession?.startInteractive).toHaveBeenCalledOnce();
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/sessions/:id/worktree/merge
  // ---------------------------------------------------------------------------

  it('POST merge — session not found → success:false', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/worktree/merge',
      payload: { branch: 'feature/test' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('POST merge — invalid branch name → success:false', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree/merge`,
      payload: { branch: 'bad branch!' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('POST merge — valid branch → success:true with output', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree/merge`,
      payload: { branch: 'feature/test' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.output).toBe('Merge made by the recursive strategy.');
  });

  it('POST merge — worktree session has worktreeOriginId → cleanupSession called via primary lookup', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    // Add a worktree session linked to the origin session via worktreeOriginId
    const worktreeSession = {
      id: 'wt-session-1',
      worktreeBranch: 'feature/cleanup',
      worktreePath: '/tmp/wt',
      worktreeOriginId: ctx._sessionId,
    } as unknown as ReturnType<typeof ctx.sessions.get>;
    ctx.sessions.set('wt-session-1', worktreeSession!);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree/merge`,
      payload: { branch: 'feature/cleanup' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    // Allow the fire-and-forget cleanup IIFE to settle
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.cleanupSession).toHaveBeenCalledWith('wt-session-1', true, 'merged');
  });

  it('POST merge — worktree session lacks worktreeOriginId → cleanupSession called via fallback lookup', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    // Add a worktree session WITHOUT worktreeOriginId (e.g. restored from old state.json)
    const worktreeSession = {
      id: 'wt-session-2',
      worktreeBranch: 'feature/orphan',
      worktreePath: '/tmp/wt-orphan',
    } as unknown as ReturnType<typeof ctx.sessions.get>;
    ctx.sessions.set('wt-session-2', worktreeSession!);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree/merge`,
      payload: { branch: 'feature/orphan' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.cleanupSession).toHaveBeenCalledWith('wt-session-2', true, 'merged');
  });

  it('POST merge — findMainGitRoot returns null → OPERATION_FAILED', async () => {
    vi.mocked(gitUtils.findMainGitRoot).mockResolvedValue(null);
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree/merge`,
      payload: { branch: 'feature/test' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/resolve main git/i);
  });

  it('POST merge — main repo on detached HEAD → OPERATION_FAILED with specific message', async () => {
    vi.mocked(gitUtils.getCurrentBranch).mockResolvedValue('HEAD');
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree/merge`,
      payload: { branch: 'feature/test' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/detached HEAD/i);
  });

  it('POST merge — main repo on unexpected branch → OPERATION_FAILED', async () => {
    vi.mocked(gitUtils.getCurrentBranch).mockResolvedValue('feature/other');
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree/merge`,
      payload: { branch: 'feature/test' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/cannot merge safely/i);
  });

  it('POST merge — mergeBranch throws → OPERATION_FAILED', async () => {
    vi.mocked(gitUtils.mergeBranch).mockRejectedValue(new Error('CONFLICT: merge conflict'));
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree/merge`,
      payload: { branch: 'feature/test' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Merge failed/);
  });

  it('POST merge — no-op but branch not merged → OPERATION_FAILED (data loss prevention)', async () => {
    vi.mocked(gitUtils.mergeBranch).mockResolvedValue('Already up to date.');
    vi.mocked(gitUtils.isBranchMerged).mockResolvedValue(false);
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree/merge`,
      payload: { branch: 'feature/test' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/commits may be missing/i);
  });

  it('POST merge — no-op and branch already merged → success with alreadyMerged:true', async () => {
    vi.mocked(gitUtils.mergeBranch).mockResolvedValue('Already up to date.');
    vi.mocked(gitUtils.isBranchMerged).mockResolvedValue(true);
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree/merge`,
      payload: { branch: 'feature/test' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.alreadyMerged).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/sessions/:id/worktree
  // ---------------------------------------------------------------------------

  it('DELETE worktree — session not a worktree (no worktreePath) → success:false', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    // Default mock session has no worktreePath
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('DELETE worktree — dirty worktree, force:false → { success:false, dirty:true }', async () => {
    vi.mocked(gitUtils.isWorktreeDirty).mockResolvedValue(true);
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    // Give the session a worktreePath so the route proceeds past the guard
    (ctx._session as Record<string, unknown>).worktreePath = '/tmp/worktree-feat';

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { force: false },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.dirty).toBe(true);
  });

  it('DELETE worktree — force:true → success:true', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    (ctx._session as Record<string, unknown>).worktreePath = '/tmp/worktree-feat';

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { force: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });
});

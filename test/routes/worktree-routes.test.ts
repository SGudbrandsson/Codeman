import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { WorktreeStore } from '../../src/worktree-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

vi.mock('../../src/utils/git-utils.js', () => ({
  findGitRoot: () => '/tmp/test-repo',
  removeWorktree: vi.fn().mockResolvedValue(undefined),
}));

let _mockStore: WorktreeStore;
vi.mock('../../src/worktree-store.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/worktree-store.js')>();
  return { ...mod, getWorktreeStore: () => _mockStore };
});

// Static import so vi.mock hoisting applies before module executes
import { registerWorktreeRoutes } from '../../src/web/routes/worktree-routes.js';

describe('worktree routes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codeman-wt-test-'));
    _mockStore = new WorktreeStore(join(tmpDir, 'worktrees.json'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/worktrees returns empty list initially', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/worktrees' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.worktrees).toEqual([]);
  });

  it('POST /api/worktrees saves a dormant worktree', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/worktrees',
      payload: { path: '/tmp/proj-feat', branch: 'feat', originSessionId: 'abc', projectName: 'proj' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.worktree.branch).toBe('feat');
    expect(body.worktree.id).toBeTruthy();
  });

  it('DELETE /api/worktrees/:id removes entry', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeRoutes);
    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/worktrees',
      payload: { path: '/tmp/proj-feat', branch: 'feat', originSessionId: 'abc', projectName: 'proj' },
    });
    const { worktree } = JSON.parse(saveRes.body);
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/worktrees/${worktree.id}`,
      payload: { removeDisk: false },
    });
    expect(JSON.parse(delRes.body).success).toBe(true);
    const listRes = await app.inject({ method: 'GET', url: '/api/worktrees' });
    expect(JSON.parse(listRes.body).worktrees).toHaveLength(0);
  });

  it('DELETE /api/worktrees/:id returns not-found for unknown id', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/worktrees/00000000-0000-0000-0000-000000000000',
      payload: {},
    });
    expect(JSON.parse(res.body).success).toBe(false);
  });
});

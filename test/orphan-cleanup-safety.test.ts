/**
 * @fileoverview runOrphanCleanup() must never destroy work in worktrees it doesn't track.
 *
 * Regression: startup orphan cleanup force-removed (`git worktree remove --force`) any
 * untracked worktree whose branch `git branch --merged` reported as merged. A branch freshly
 * created from main has no commits of its own, so it counts as "merged" — a worktree made
 * outside Codeman (e.g. by an Agent Teams lead for a teammate) was deleted on every server
 * restart, uncommitted work included.
 *
 * Uses real git repositories in a temp dir; only the dormant worktree store is mocked.
 *
 * Run: npx vitest run test/orphan-cleanup-safety.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/worktree-store.js', () => ({
  getWorktreeStore: () => ({ getAll: () => [] }),
}));

import { runOrphanCleanup } from '../src/web/routes/worktree-session-routes.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function branchExists(name: string): boolean {
  return git(repo, 'branch', '--list', name).length > 0;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orphan-cleanup-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runOrphanCleanup safety', () => {
  it('keeps a fresh branch with untracked work (the cm-p7 case)', async () => {
    const wt = join(dir, 'wt-fresh');
    git(repo, 'worktree', 'add', '-q', '-b', 'fresh', wt, 'main');
    writeFileSync(join(wt, 'new-file.ts'), 'work in progress\n');

    const result = await runOrphanCleanup(repo, new Map(), log);

    expect(result.removed).toEqual([]);
    expect(existsSync(join(wt, 'new-file.ts'))).toBe(true);
    expect(branchExists('fresh')).toBe(true);
  });

  it('keeps a fresh, clean branch that has never had a commit', async () => {
    const wt = join(dir, 'wt-empty');
    git(repo, 'worktree', 'add', '-q', '-b', 'empty', wt, 'main');

    const result = await runOrphanCleanup(repo, new Map(), log);

    expect(result.removed).toEqual([]);
    expect(existsSync(wt)).toBe(true);
    expect(branchExists('empty')).toBe(true);
  });

  it('keeps a merged branch whose worktree has uncommitted changes to tracked files', async () => {
    const wt = join(dir, 'wt-dirty');
    git(repo, 'worktree', 'add', '-q', '-b', 'dirty', wt, 'main');
    writeFileSync(join(wt, 'README.md'), 'change\n');
    git(wt, 'commit', '-q', '-am', 'work');
    git(repo, 'merge', '-q', '--ff-only', 'dirty');
    writeFileSync(join(wt, 'README.md'), 'more uncommitted change\n');

    const result = await runOrphanCleanup(repo, new Map(), log);

    expect(result.removed).toEqual([]);
    expect(existsSync(wt)).toBe(true);
  });

  it('still removes a clean worktree whose committed branch was merged', async () => {
    const wt = join(dir, 'wt-merged');
    git(repo, 'worktree', 'add', '-q', '-b', 'merged', wt, 'main');
    writeFileSync(join(wt, 'feature.ts'), 'done\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'feature');
    git(repo, 'merge', '-q', '--ff-only', 'merged');

    const result = await runOrphanCleanup(repo, new Map(), log);

    expect(result.removed.map((r) => r.branch)).toEqual(['merged']);
    expect(existsSync(wt)).toBe(false);
    expect(branchExists('merged')).toBe(false);
  });
});

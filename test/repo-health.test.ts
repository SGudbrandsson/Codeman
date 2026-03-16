/**
 * @fileoverview Repo health checks — enforces invariants about repository state.
 *
 * These tests run against the actual git repository to catch configuration
 * drift that causes runtime failures (e.g. TASK.md being tracked causes new
 * worktrees to inherit a stale task status, breaking autonomous task sessions).
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

// Resolve repo root relative to this test file (test/ → repo root)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function gitLsFiles(...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['ls-files', ...args], { cwd: repoRoot });
  return stdout.trim();
}

describe('repo health', () => {
  describe('TASK.md', () => {
    it('TASK.md must not be tracked in git', async () => {
      const tracked = await gitLsFiles('TASK.md');
      expect(tracked, 'TASK.md is tracked in git — run: git rm --cached TASK.md').toBe('');
    });

    it('TASK.md must be listed in .gitignore', async () => {
      const ignored = await gitLsFiles('--others', '--ignored', '--exclude-standard', 'TASK.md');
      // If TASK.md doesn't exist on disk, git won't list it as ignored — check .gitignore directly
      const { stdout } = await execFileP('git', ['check-ignore', '-q', 'TASK.md'], {
        cwd: repoRoot,
      }).catch(() => ({ stdout: '' }));
      // check-ignore exits 0 if ignored, 1 if not — we catch the rejection and treat as not ignored
      // Re-run without -q to see if it's ignored
      const checkIgnore = await execFileP('git', ['check-ignore', 'TASK.md'], { cwd: repoRoot })
        .then((r) => r.stdout.trim())
        .catch(() => '');
      expect(checkIgnore, 'TASK.md is not in .gitignore — add it to prevent stale task inheritance').toBe('TASK.md');
    });

    it('no worktree TASK.md files should be tracked', async () => {
      const tracked = await gitLsFiles('**/TASK.md');
      expect(tracked, `Some TASK.md files are tracked: ${tracked}`).toBe('');
    });
  });
});

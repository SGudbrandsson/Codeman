/**
 * @fileoverview Git utility functions for worktree management.
 * Uses execFile (array args, no shell) to prevent injection.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join, dirname } from 'node:path';

const execFileP = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, timeout: 30_000 });
  return stdout.trim();
}

export function isGitWorktreeDir(dir: string): boolean {
  const gitPath = join(dir, '.git');
  if (!existsSync(gitPath)) return false;
  return statSync(gitPath).isFile();
}

export function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function listBranches(repoDir: string): Promise<string[]> {
  const output = await git(['branch', '-a', '--format=%(refname:short)'], repoDir);
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const raw of output.split('\n')) {
    const branch = raw.trim().replace(/^origin\//, '');
    if (!branch || branch === 'HEAD' || branch.includes('->')) continue;
    if (!seen.has(branch)) {
      seen.add(branch);
      branches.push(branch);
    }
  }
  return branches;
}

export async function getCurrentBranch(repoDir: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
}

const WORKTREE_ARTIFACTS = ['node_modules', 'dist'] as const;

/**
 * Symlinks gitignored runtime artifacts (node_modules, dist) from the git root
 * into a newly-created worktree directory. Each artifact is symlinked independently —
 * a failure on one does not block the others or abort worktree creation.
 */
export async function setupWorktreeArtifacts(gitRoot: string, worktreePath: string): Promise<void> {
  for (const artifact of WORKTREE_ARTIFACTS) {
    const src = join(gitRoot, artifact);
    const dest = join(worktreePath, artifact);
    try {
      if (!existsSync(src)) continue;
      if (existsSync(dest)) continue;
      await fs.symlink(src, dest, 'dir');
    } catch (err) {
      console.warn(`[setupWorktreeArtifacts] Failed to symlink ${artifact}: ${String(err)}`);
    }
  }
}

export async function addWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
  isNew: boolean
): Promise<void> {
  const args = isNew ? ['worktree', 'add', worktreePath, '-b', branch] : ['worktree', 'add', worktreePath, branch];
  await git(args, repoDir);
}

export async function removeWorktree(repoDir: string, worktreePath: string, force = false): Promise<void> {
  const args = ['worktree', 'remove', worktreePath, ...(force ? ['--force'] : [])];
  await git(args, repoDir);
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  try {
    const status = await git(['status', '--porcelain', '-uno'], worktreePath);
    return status.length > 0;
  } catch {
    return false;
  }
}

export async function mergeBranch(targetDir: string, branch: string): Promise<string> {
  return git(['merge', branch, '--no-edit'], targetDir);
}

export async function gitClone(url: string, targetPath: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  await execFileP('git', ['clone', '--', url, targetPath], { timeout: 120_000 });
}

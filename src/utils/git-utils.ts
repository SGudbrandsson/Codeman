/**
 * @fileoverview Git utility functions for worktree management.
 * Uses execFile (array args, no shell) to prevent injection.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
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
    const status = await git(['status', '--porcelain'], worktreePath);
    return status.length > 0;
  } catch {
    return false;
  }
}

export async function mergeBranch(targetDir: string, branch: string): Promise<string> {
  return git(['merge', branch, '--no-edit'], targetDir);
}

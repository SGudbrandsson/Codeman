/**
 * @fileoverview Tests for session display name derivation
 *
 * Tests the human-readable name cleaning logic used in sidebar session tabs.
 * Functions are extracted from CodemanApp methods in app.js to enable unit testing.
 *
 * Run: npx vitest run test/session-display-name.test.ts
 */

import { describe, it, expect } from 'vitest';

// ─── Extracted logic from app.js (mirrors CodemanApp._cleanBranchName) ───

function cleanBranchName(branch: string): string {
  let name = branch.replace(/^[a-z]+\//, '');
  name = name.replace(/wi-[0-9a-f]{8}-?/gi, '');
  name = name.replace(/^-+|-+$/g, '');
  return name || branch;
}

// ─── Extracted logic from app.js (mirrors CodemanApp._cleanDirName) ───

function cleanDirName(basename: string): string {
  const typeMatch = basename.match(/-(feat|fix|chore|hotfix)-/);
  if (typeMatch) {
    let suffix = basename.slice(basename.indexOf(`-${typeMatch[1]}-`) + typeMatch[1].length + 2);
    suffix = suffix.replace(/wi-[0-9a-f]{8}-?/gi, '');
    suffix = suffix.replace(/^-+|-+$/g, '');
    if (suffix) return suffix;
  }
  let cleaned = basename.replace(/wi-[0-9a-f]{8}-?/gi, '');
  cleaned = cleaned.replace(/^-+|-+$/g, '');
  return cleaned !== basename ? cleaned : '';
}

// ─── Extracted logic from app.js (mirrors CodemanApp._getSessionTooltip) ───

function getSessionTooltip(session: { worktreeBranch?: string; workingDir?: string }): string {
  if (session.worktreeBranch && session.workingDir) {
    return `Branch: ${session.worktreeBranch}\n${session.workingDir}`;
  }
  return session.workingDir || '';
}

// ─── Extracted logic from app.js (mirrors CodemanApp.getSessionName) ───

function getSessionName(session: { name?: string; worktreeBranch?: string; workingDir?: string; id: string }): string {
  if (session.name) return session.name;
  if (session.worktreeBranch) return cleanBranchName(session.worktreeBranch);
  if (session.workingDir) {
    const basename = session.workingDir.split('/').pop() || session.workingDir;
    const cleaned = cleanDirName(basename);
    return cleaned || basename;
  }
  return session.id.slice(0, 8);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Session Display Name', () => {
  describe('cleanBranchName', () => {
    it('strips feat/ prefix', () => {
      expect(cleanBranchName('feat/sidebar-session-names')).toBe('sidebar-session-names');
    });

    it('strips fix/ prefix', () => {
      expect(cleanBranchName('fix/activity-indicators-v2')).toBe('activity-indicators-v2');
    });

    it('strips chore/ prefix', () => {
      expect(cleanBranchName('chore/update-deps')).toBe('update-deps');
    });

    it('strips hotfix/ prefix', () => {
      expect(cleanBranchName('hotfix/critical-bug')).toBe('critical-bug');
    });

    it('strips ticket ID from branch name', () => {
      expect(cleanBranchName('feat/wi-55196757-sidebar-session-names')).toBe('sidebar-session-names');
    });

    it('strips ticket ID with uppercase hex', () => {
      expect(cleanBranchName('feat/wi-05DA3211-some-feature')).toBe('some-feature');
    });

    it('leaves branch without type prefix unchanged', () => {
      expect(cleanBranchName('main')).toBe('main');
    });

    it('leaves branch without type prefix but strips ticket ID', () => {
      expect(cleanBranchName('wi-abcd1234-hotpatch')).toBe('hotpatch');
    });

    it('falls back to original branch when cleaning produces empty', () => {
      expect(cleanBranchName('feat/wi-55196757')).toBe('feat/wi-55196757');
    });

    it('handles branch with only type prefix and no suffix', () => {
      // Edge case: "feat/" with nothing after — strip leaves empty, fallback to original
      expect(cleanBranchName('feat/')).toBe('feat/');
    });

    it('handles multi-segment branch names', () => {
      expect(cleanBranchName('feat/wi-12345678-multi-word-feature-name')).toBe('multi-word-feature-name');
    });
  });

  describe('cleanDirName', () => {
    it('extracts meaningful suffix from worktree directory name', () => {
      expect(cleanDirName('Codeman-feat-wi-55196757-sidebar-session-names')).toBe('sidebar-session-names');
    });

    it('extracts suffix for fix-type worktrees', () => {
      expect(cleanDirName('Codeman-fix-wi-abcdef12-broken-tooltip')).toBe('broken-tooltip');
    });

    it('extracts suffix without ticket ID', () => {
      expect(cleanDirName('Codeman-feat-new-cool-feature')).toBe('new-cool-feature');
    });

    it('returns empty for names without type pattern', () => {
      expect(cleanDirName('Codeman')).toBe('');
    });

    it('returns empty for plain directory names', () => {
      expect(cleanDirName('my-project')).toBe('');
    });

    it('strips ticket ID from names without type pattern', () => {
      expect(cleanDirName('wi-abcd1234-something')).toBe('something');
    });

    it('handles long worktree names with truncation', () => {
      expect(cleanDirName('Codeman-feat-wi-55196757-sidebar-session-names-show-human-readabl')).toBe(
        'sidebar-session-names-show-human-readabl'
      );
    });

    it('handles chore type', () => {
      expect(cleanDirName('MyProject-chore-cleanup-old-logs')).toBe('cleanup-old-logs');
    });

    it('handles hotfix type', () => {
      expect(cleanDirName('App-hotfix-critical-crash')).toBe('critical-crash');
    });
  });

  describe('getSessionTooltip', () => {
    it('shows branch and path when both present', () => {
      expect(
        getSessionTooltip({
          worktreeBranch: 'feat/sidebar-names',
          workingDir: '/home/user/projects/Codeman-feat-sidebar-names',
        })
      ).toBe('Branch: feat/sidebar-names\n/home/user/projects/Codeman-feat-sidebar-names');
    });

    it('shows only path when no branch', () => {
      expect(
        getSessionTooltip({
          workingDir: '/home/user/projects/Codeman',
        })
      ).toBe('/home/user/projects/Codeman');
    });

    it('returns empty string when no path or branch', () => {
      expect(getSessionTooltip({})).toBe('');
    });

    it('returns empty when branch set but no workingDir', () => {
      expect(getSessionTooltip({ worktreeBranch: 'feat/x' })).toBe('');
    });
  });

  describe('getSessionName (integrated)', () => {
    it('returns custom name when set', () => {
      expect(
        getSessionName({
          id: 'abc12345-1234-1234-1234-123456789abc',
          name: 'My Custom Session',
          worktreeBranch: 'feat/something',
          workingDir: '/some/path',
        })
      ).toBe('My Custom Session');
    });

    it('derives name from worktree branch', () => {
      expect(
        getSessionName({
          id: 'abc12345-1234-1234-1234-123456789abc',
          worktreeBranch: 'feat/wi-55196757-sidebar-session-names',
          workingDir: '/home/user/Codeman-feat-wi-55196757-sidebar-session-names',
        })
      ).toBe('sidebar-session-names');
    });

    it('prefers branch over directory name', () => {
      expect(
        getSessionName({
          id: 'abc12345-1234-1234-1234-123456789abc',
          worktreeBranch: 'fix/nice-fix',
          workingDir: '/home/user/Codeman-fix-ugly-dirname',
        })
      ).toBe('nice-fix');
    });

    it('falls back to cleaned directory name when no branch', () => {
      expect(
        getSessionName({
          id: 'abc12345-1234-1234-1234-123456789abc',
          workingDir: '/home/user/Codeman-feat-wi-12345678-cool-feature',
        })
      ).toBe('cool-feature');
    });

    it('falls back to raw directory basename when cleaning fails', () => {
      expect(
        getSessionName({
          id: 'abc12345-1234-1234-1234-123456789abc',
          workingDir: '/home/user/my-project',
        })
      ).toBe('my-project');
    });

    it('falls back to short ID when no name, branch, or dir', () => {
      expect(
        getSessionName({
          id: 'abc12345-1234-1234-1234-123456789abc',
        })
      ).toBe('abc12345');
    });
  });
});

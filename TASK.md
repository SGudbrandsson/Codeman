# Task

type: bug
status: done
title: Merge API reports 'already up to date' when branch has unmerged commits
description: |
  POST /api/sessions/:id/worktree/merge returned {"success":true,"output":"Already up to date.","cleaned":true}
  for branch fix/mobile-new-session-detection, even though that branch had 7 commits not present in master.
  The API also cleaned up the worktree directory, leaving the branch dangling with no working directory.

  A manual `git merge fix/mobile-new-session-detection` from the main repo confirmed the commits were
  genuinely missing from master — it produced a merge commit with real changes (app.js, index.html).

  The bug likely involves how the merge endpoint determines the target branch or resolves the working
  directory. Hypothesis: the merge is being run from inside the worktree directory (which is already
  on that branch, making it "already up to date" with itself), rather than from the parent repo's
  master branch. Or the wrong base ref is being used.

  Additionally, "cleaned: true" was returned, meaning the worktree was deleted before confirming the
  merge actually landed in master — this is a secondary safety issue.

affected_area: backend — worktree merge API endpoint
fix_cycles: 0

## Reproduction

1. Create a Codeman session pointing at a git repo (the "origin session", e.g. session ID `ABC`). Its `workingDir` is the main repo root, e.g. `/home/siggi/sources/Codeman`.
2. From that session, create a worktree for a new branch (`fix/mobile-new-session-detection`). This creates `/home/siggi/sources/Codeman-fix-mobile-new-session-detection` with `workingDir` = that worktree path.
3. Make commits in the worktree branch so it diverges from master.
4. Call `POST /api/sessions/ABC/worktree/merge` with body `{"branch":"fix/mobile-new-session-detection"}`.
5. Expected: git merges the branch commits into master in the main repo. Actual: returns `{"success":true,"output":"Already up to date.","cleaned":true}` — no commits land in master.

The "already up to date" message is reproducible whenever `session.workingDir` for the origin session is itself a worktree directory (i.e. the origin session was created for a worktree, not for the bare main repo), OR more commonly: if the `findGitRoot` resolution for `session.workingDir` yields a path whose `HEAD` is already pointing to the feature branch (e.g. because the origin session's worktree happens to be on the same branch, or git resolves the wrong repo context).

## Root Cause / Spec

### Primary Bug — wrong `cwd` for `git merge`

In `src/web/routes/worktree-session-routes.ts` line 368, the merge is run as:

```typescript
output = await mergeBranch(session.workingDir, branch);
```

where `session` is the **origin session** (identified by `:id` in the URL).

`mergeBranch` in `src/utils/git-utils.ts` executes:
```typescript
git(['merge', branch, '--no-edit'], targetDir)
```

which runs `git merge <branch> --no-edit` with `cwd = session.workingDir`.

**The intent** is to merge the feature branch into the main repo's current branch (master). For that to work, `cwd` must be the main repo root **with HEAD on master**.

**The failure case** — the origin session's `workingDir` IS the worktree directory for another feature branch. This is the normal case in Codeman's autonomous workflow: the "codeman-merge-worktree" skill calls the merge endpoint against the origin session, but the origin session in practice IS a worktree session itself (the fix/feat worktree session that ran the autonomous agent). When `git merge fix/mobile-new-session-detection` runs inside `/home/siggi/sources/Codeman-fix-mobile-new-session-detection` (which is already checked out on that branch), git correctly reports "Already up to date" — because you are merging a branch into itself.

**Root cause summary:** `mergeBranch` must be run from the **git root on the target base branch (master)**, not from `session.workingDir`, which may be the worktree directory for the very branch being merged. The fix must resolve the true git root and ensure it is on `master` (or the configured base branch), OR use `findGitRoot(session.workingDir)` to get the main repo root and verify its current branch before merging.

### Secondary Bug — cleanup runs unconditionally on "already up to date"

Lines 376–415 fire the post-merge cleanup (delete session, remove worktree directory, delete branch) regardless of whether the merge actually integrated any new commits. The `cleaned: true` flag in the response is set based on whether `worktreeSession` exists or `gitRoot` is resolvable — not on whether the merge output indicates real work was done (i.e., it fires even on "Already up to date."). This causes the worktree directory to be destroyed without the commits ever landing in master.

**Fix needed for secondary bug:** Guard the cleanup behind a check that the merge output is NOT "Already up to date." (or similar no-op messages). If the merge was a no-op, return an error rather than silently cleaning up.

### Affected files
- `src/utils/git-utils.ts` — `mergeBranch` function (line 99)
- `src/web/routes/worktree-session-routes.ts` — merge route handler (lines 334–416), specifically line 368 (`mergeBranch(session.workingDir, branch)`) and the cleanup guard logic

## Fix / Implementation Notes

### Primary fix — `src/utils/git-utils.ts`

Added `findMainGitRoot(startDir: string): Promise<string | null>`.

Uses `git rev-parse --git-common-dir` which returns the path to the shared `.git` directory regardless of whether `startDir` is inside a linked worktree or the main repo. Stripping the trailing `/.git` yields the main repo working tree root. This is the correct `cwd` for running `git merge`.

### Primary fix — `src/web/routes/worktree-session-routes.ts`

- Imported `findMainGitRoot`.
- In the merge route, replaced `mergeBranch(session.workingDir, branch)` with `mergeBranch(mainGitRoot, branch)` where `mainGitRoot = await findMainGitRoot(session.workingDir)`. If resolution fails, returns an error before attempting the merge.
- Updated `removeWorktree` and `deleteBranch` calls to use `mainGitRoot` instead of the old `gitRoot` derived from `findGitRoot` (which was scoped to the worktree path).

### Secondary fix — no-op guard

After `mergeBranch` returns, added a check: if output matches `/already up.?to.?date/i`, return an `OPERATION_FAILED` error immediately (before the cleanup async block runs). This prevents worktree directory deletion and branch deletion when no commits actually landed in master.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

**Primary fix correctness — PASS**

`findMainGitRoot` uses `git rev-parse --git-common-dir` which is the canonical mechanism for finding the shared `.git` directory. Verified empirically: from inside this worktree (`/home/siggi/sources/Codeman-fix-merge-api-already-up-to-date`) it returns `/home/siggi/sources/Codeman/.git`, while `--git-dir` would return `.git/worktrees/...`. The path normalization regex `/.git\/?$/` is correct for all real-world cases (`--git-common-dir` always returns the top-level `.git` dir, not a subdirectory within it).

**Edge case: relative vs. absolute path from `--git-common-dir` — PASS**

From the main repo, git returns `.git` (relative); from a linked worktree, it returns an absolute path. The code correctly handles both: `commonDir.startsWith('/') ? commonDir : join(startDir, commonDir)`. Tested both paths manually.

**Secondary fix (no-op guard) — PASS**

The `/already up.?to.?date/i` regex is broader than needed but not dangerously so — it correctly catches git's "Already up to date." message and the early return fires before the cleanup async block. This is the right behavior.

**Secondary fix: cleanup uses `mainGitRoot` — PASS**

`removeWorktree` and `deleteBranch` now use `mainGitRoot` instead of the old `findGitRoot`-derived `gitRoot`. The old code wrapped these in `if (gitRoot)` guards, which are now simplified since `mainGitRoot` is guaranteed non-null at that point. This is a clean improvement.

**Minor observation: `cleaned` flag semantics (non-blocking)**

`return { success: true, output, cleaned: !!(worktreeSession || mainGitRoot) }` will always return `cleaned: true` after a successful merge, because `mainGitRoot` is non-null at that point. Previously `gitRoot` could theoretically be null (causing `cleaned: false` when neither a worktree session existed nor a git root was found). The new value is semantically "cleanup was attempted" rather than "cleanup succeeded/is happening", which is slightly more optimistic but consistent — the cleanup is fire-and-forget anyway. Not worth blocking on.

**TypeScript correctness — PASS**

No implicit `any`, no unused variables. The `catch` in `findMainGitRoot` swallows the error and returns `null`, which is the documented contract. The return type `Promise<string | null>` is accurate.

**Security — PASS**

Branch name is already validated by `BRANCH_PATTERN` before reaching the new code. `findMainGitRoot` only reads from git, no writes. `git` helper uses `execFile` (not shell), so no injection risk from `startDir`.

**Consistency with existing patterns — PASS**

The new utility follows the same pattern as `findGitRoot` / `isWorktreeDirty` / `mergeBranch`. The import is properly added.

No blocking issues found.

## QA Results

**Date:** 2026-03-16

### TypeScript typecheck (`tsc --noEmit`) — PASS
Zero errors. No type issues in `findMainGitRoot`, `mainGitRoot` usage, or the no-op guard.

### ESLint (`npm run lint`) — PASS
Zero warnings or errors.

### Dev server startup (port 3099) — PASS
Server started successfully and responded to `GET /api/status` with full session list (v0.6.4). Worktree session `restored-d5b27bcb` for `fix/merge-api-already-up-to-date` was visible in the sessions list, confirming the worktree registration path works correctly.

### Fix verification — PASS
Confirmed in `src/web/routes/worktree-session-routes.ts`:
- `findMainGitRoot` imported and called on `session.workingDir` (line 369).
- `mergeBranch` now called with `mainGitRoot` instead of `session.workingDir` (line 376).
- `removeWorktree` and `deleteBranch` both use `mainGitRoot` (lines 400, 407).
- No-op guard with `/already up.?to.?date/i` regex fires at line 382–388, returning `OPERATION_FAILED` before any cleanup runs.

**Overall: ALL CHECKS PASSED**

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

2026-03-16: Used `git rev-parse --git-common-dir` (via new `findMainGitRoot`) rather than walking the filesystem with `findGitRoot`. The filesystem walk finds the first directory containing a `.git` entry — in a worktree that is the worktree dir itself (`.git` is a file there), not the main repo. `--git-common-dir` is the canonical git mechanism for this.

2026-03-16: The no-op guard returns `OPERATION_FAILED` (not `success:false`) so that callers (e.g. `codeman-merge-worktree` skill) get a clear error signal and can investigate rather than silently proceeding. The worktree and branch are left intact for the user to retry.

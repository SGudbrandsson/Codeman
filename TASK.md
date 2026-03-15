# Task

type: feature
status: done
title: Worktree post-creation setup — symlink node_modules and auto-start dev server
description: |
  Two improvements to the worktree lifecycle to reduce manual setup steps.

  ## Problem 1 — No node_modules after worktree creation
  When a new git worktree is created, node_modules is not present (not tracked by git).
  This means the worktree cannot run until dependencies are installed. The QA stage hits
  missing module errors or the user has to manually run npm install.

  Fix: After worktree creation, add a post-creation step that symlinks node_modules (and any
  other necessary runtime artifacts like .env, dist/ references, etc.) from the parent repo
  directory into the new worktree directory. Symlink is preferred over copy — fast, low disk
  usage, and keeps them in sync.

  Look at where worktrees are created in the backend (session/worktree creation code) and add
  the symlink step there.

  ## Problem 2 — Dev server not auto-started at QA phase
  At the end of the task runner workflow, the "How to test" / Phase 6 output tells the user
  how to start the dev server manually, but never actually starts it. The user always has to
  explicitly ask.

  Fix: After the task runner completes its final commit, automatically start the dev server on
  the worktree's assigned port (the session already has an assignedPort field). Print the URL
  so the user knows where to access it. Use the same nohup + tsx startup pattern documented in
  the codebase (nohup npx tsx src/index.ts web --port PORT > /tmp/codeman-PORT.log 2>&1 &).

  This applies to the codeman-task-runner skill and potentially the server startup logic.

affected_area: backend
fix_cycles: 0

## Root Cause / Spec

### Problem 1 — Missing node_modules in worktrees

**Root cause:** `git worktree add` creates a clean checkout of the branch's tracked files. `node_modules/` is gitignored (not tracked), so it is never copied into the new worktree directory. Same applies to `dist/` (build output, also gitignored).

**Code location:** Worktree creation happens in two route handlers in
`src/web/routes/worktree-session-routes.ts`:
- `POST /api/sessions/:id/worktree` (line 80)
- `POST /api/cases/:name/worktree` (line 264)

Both handlers call `addWorktree(gitRoot, worktreePath, branch, isNew)` from
`src/utils/git-utils.ts` (line 53). The actual `git worktree add` exec is on line 59.

**Implementation spec:**

Add a new exported async function `setupWorktreeArtifacts(gitRoot: string, worktreePath: string): Promise<void>` in `src/utils/git-utils.ts`.

This function symlinks the following artifacts from `gitRoot` into `worktreePath`, but only if the source exists and the destination does not already exist:
- `node_modules` (always needed to run tsx/npm scripts)
- `dist` (optional — only if it exists in gitRoot; avoids build step)

Use `fs.symlink(src, dest, 'dir')` from `node:fs/promises`.

Catch and swallow errors per-artifact (e.g. symlink already exists, no permission) — a failed symlink should be logged but must not abort worktree creation.

Call `setupWorktreeArtifacts(gitRoot, worktreePath)` in both POST handlers, after `addWorktree()` succeeds and before `new Session(...)` is constructed. Since it's async, `await` it. Wrap in try/catch so a failure logs a warning but does not prevent the session from being created.

**Rationale for symlink over copy:** Fast (O(1)), zero additional disk usage, stays in sync with parent if deps are updated (npm install in main repo benefits all worktrees).

---

### Problem 2 — Dev server not auto-started after task runner commit

**Root cause:** The `codeman-task-runner` skill (`~/.claude/skills/codeman-task-runner/SKILL.md`) Phase 6 only **prints** the nohup command for the user to run manually. It never executes it.

**Code location:** Phase 6 template in `~/.claude/skills/codeman-task-runner/SKILL.md` lines 229–252.

**Implementation spec:**

Modify Phase 5 of the skill (after the commit completes on either the clean or NEEDS REVIEW path) to add a **"Auto-start dev server"** step before the Phase 6 output. The runner should:

1. Check if `assignedPort` is known (from `worktreeNotes` in TASK.md or via the session API).
2. If known, run the following bash commands in the worktree directory:
   ```bash
   nohup npx tsx src/index.ts web --port <assignedPort> > /tmp/codeman-<assignedPort>.log 2>&1 &
   sleep 6 && curl -s http://localhost:<assignedPort>/api/status
   ```
3. Print the result — either a success confirmation with the URL, or a warning if the server failed to start.
4. If `assignedPort` is unknown, skip and note it in the Phase 6 output (the existing manual command format).

The Phase 6 template's "Dev server (if not already running):" section should be updated to say "Dev server (started automatically — verify with):" followed by the curl health-check command, rather than the full nohup command (since it was already started).

**Affected file:** `~/.claude/skills/codeman-task-runner/SKILL.md`

---

### Affected area

`backend` for Problem 1 (TypeScript source changes to `git-utils.ts` and `worktree-session-routes.ts`).
`logic` / skill change for Problem 2 (markdown skill file edit only, no TypeScript).

Both changes are minimal and isolated. No schema changes, no new dependencies.

## Fix / Implementation Notes

### Problem 1 — `setupWorktreeArtifacts` in `git-utils.ts`

Added `import fs from 'node:fs/promises'` to `src/utils/git-utils.ts` (the file previously only used the sync `fs` exports via named imports, so the default import is new but non-conflicting).

Added `setupWorktreeArtifacts(gitRoot, worktreePath)` as a new exported async function. It iterates over `['node_modules', 'dist']`, checks existence of the source in `gitRoot` and absence of the destination in `worktreePath`, and calls `fs.symlink(src, dest, 'dir')`. Each artifact is wrapped in its own try/catch so one failure cannot affect the others or abort worktree creation. Failures are logged via `console.warn`.

In `src/web/routes/worktree-session-routes.ts`:
- Added `setupWorktreeArtifacts` to the named imports from `../../utils/git-utils.js`.
- In `POST /api/sessions/:id/worktree` (line ~102): added a try/catch block calling `await setupWorktreeArtifacts(gitRoot, worktreePath)` immediately after the `addWorktree()` success block and before port allocation / `new Session(...)`. Failures are logged with `req.log.warn` and do not return an error response.
- In `POST /api/cases/:name/worktree` (line ~279): same pattern applied.

### Problem 2 — Auto-start dev server in `codeman-task-runner` SKILL.md

Modified Phase 5 in `~/.claude/skills/codeman-task-runner/SKILL.md` to add an **"Auto-start dev server"** step that runs after the git commit on both the clean and NEEDS REVIEW paths. The step:
1. Extracts `assignedPort` from TASK.md's worktreeNotes by matching `Assigned dev port for this worktree: <N>`.
2. If found, runs `nohup npx tsx src/index.ts web --port <port> > /tmp/codeman-<port>.log 2>&1 &` followed by `sleep 6 && curl -s http://localhost:<port>/api/status`.
3. Reports success or a warning based on the curl response.
4. Gracefully skips if no port is found (falls back to manual instructions in Phase 6).

Updated the Phase 6 template's "Dev server" section from "if not already running" (nohup command) to "started automatically — verify with" (curl health-check only), with a fallback block for the case where auto-start was skipped.

Updated the Phase 6 rules bullet to clarify the auto-start behaviour and the fallback to port 3099.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

**git-utils.ts — `setupWorktreeArtifacts`**
- Import `fs from 'node:fs/promises'` is non-conflicting with the existing named sync imports from `node:fs`. Correct.
- `WORKTREE_ARTIFACTS as const` — prevents mutation, gives literal tuple type. Good.
- `existsSync(src)` guard before `fs.symlink`: correct. There is a theoretical TOCTOU window, but this is a non-security-sensitive one-shot path and the inner `catch` handles any race outcome acceptably.
- `existsSync(dest)` guard: correctly prevents re-symlinking if the destination already exists (e.g., re-used worktree path or prior run).
- `fs.symlink(src, dest, 'dir')`: correct API. Absolute source path (via `join(gitRoot, artifact)`) — correct; relative symlinks would break if worktrees are moved.
- Per-artifact `try/catch` with `console.warn`: appropriate since the function has no access to `req.log`. Outer handler adds a second safety layer with `req.log.warn`.
- No implicit `any`, no unused variables. TypeScript-clean.

**worktree-session-routes.ts**
- `setupWorktreeArtifacts` correctly added to named imports from `git-utils.js`.
- Both POST handlers call it immediately after `addWorktree()` succeeds and before port allocation / `new Session()` — matches spec exactly.
- Outer `try/catch` uses `req.log.warn` and does NOT return an error — correct non-blocking pattern.
- Minor style inconsistency (missing blank line before `const [[globalNice...` in the cases handler vs. the sessions handler), but not a defect.

**SKILL.md — Phase 5 auto-start**
- Auto-start step added to Phase 5 for both clean and NEEDS REVIEW paths.
- Port extraction from `worktreeNotes` is clearly documented with graceful skip if not found.
- Phase 6 template correctly updated to "started automatically — verify with:" with a fallback block for unknown-port case.
- No `--host` flag used in the nohup command — consistent with the documented gotcha in MEMORY.md.
- Fallback port 3099 aligns with the QA subagent's existing default.

No issues found. Implementation is correct, minimal, well-guarded, and consistent with existing patterns.

## QA Results
<!-- filled by QA subagent -->

**Date:** 2026-03-15

| Check | Result | Notes |
|---|---|---|
| `tsc --noEmit` | PASS | Zero type errors |
| `npm run lint` | PASS | Zero ESLint warnings/errors |
| Dev server startup (port 3099) | PASS | Server responded with valid JSON from `/api/status` |
| `setupWorktreeArtifacts` exported | PASS | Exported from `src/utils/git-utils.ts` and imported+called in both POST handlers in `worktree-session-routes.ts` |

All checks passed. Status set to `done`.

## Decisions & Context

- **Symlink vs copy:** Chose symlink (O(1), zero disk) as specified. The `'dir'` type argument to `fs.symlink` is required on Windows but ignored on Linux/macOS; kept for cross-platform correctness.
- **Per-artifact try/catch inside `setupWorktreeArtifacts`:** A missing `dist/` or a pre-existing `node_modules` symlink must not kill the whole function. Outer try/catch in the route handlers adds a second safety layer but inner catches carry the real per-artifact resilience.
- **`existsSync` for destination check:** Using sync existence check before `fs.symlink` is fine since this is a one-shot setup path, not a hot loop. This matches the existing pattern in `git-utils.ts`.
- **`console.warn` inside `setupWorktreeArtifacts`:** The function has no access to the Fastify request logger (`req.log`), so `console.warn` is the appropriate choice. The route handler re-logs via `req.log.warn` for the outer error.
- **Skill auto-start placement:** The auto-start step is placed in Phase 5 (after commit, before Phase 6 output) rather than in Phase 6 itself, so that the Phase 6 output can reference an already-running server. This matches the spec.
- **Graceful fallback when port unknown:** If `assignedPort` is not extractable from TASK.md, the skill skips auto-start and shows the full nohup command in the Phase 6 template. This satisfies the "must not break Phase 6 when no port is available" constraint.

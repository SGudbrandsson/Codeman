# Compaction Handoff — 2026-03-21

## Goal
User asked to fix bugs introduced by feat/manage-projects (project delete/custom folder feature).

## Status
- [x] Merged feat/manage-projects and fix/desktop-close-session-dialog
- [x] Merged fix/no-transcript-for-shell-opencode
- [x] Fixed self-referential symlinks (dist/node_modules/vendor) left by merge
- [x] Deployed to ~/.codeman/app, pushed to remote
- [x] Created fix worktree for delete bugs (session running autonomously)
- [ ] **RESUME HERE:** Monitor or merge `fix/delete-project-ui-not-updating` when done
  - Worktree: `/home/siggi/sources/Codeman-fix-delete-project-ui-not-updating`
  - Session ID: `17c2c163-33a5-44e6-8afb-2b3ef2e5ab74`
  - Status: `fixing` (agent is mid-work)
  - TASK.md updated to cover 3 bugs (see below)

## Bugs in fix/delete-project-ui-not-updating
1. Deleting a project doesn't remove it from the UI (loadQuickStartCases not propagating)
2. "Case not found" error when deleting existing projects (name mismatch in deleteCase() call)
3. User-facing error messages say "case" instead of "project"

## Key Decisions
- The "case not found" root cause: likely deleteCase() in app.js passes wrong name to DELETE /api/cases/:name
- Self-referential symlinks came from worktree gitlinks being committed in feat/manage-projects merge — removed with `git rm --cached` and `rm` on disk, then `npm install`
- SSH SCP-style git clone fix (was uncommitted in main repo) — committed as separate commit before merging feat/manage-projects

## Files Changed (last session)
- `.skills/fix-workflow.md` — test enforcement, skeptical reviewer, resume checkpoints
- `.skills/new-worktree.md` — master sync step, test sections in TASK.md template
- `skills/codeman-worktrees/SKILL.md` — master sync step added
- `src/web/routes/case-routes.ts` + `src/web/schemas.ts` — SSH URL fix (committed)

- [ ] Also merge `fix/custom-path-parent-dir` when done
  - Worktree: `/home/siggi/sources/Codeman-fix-custom-path-parent-dir`
  - Session ID: `cfd54175-cd86-4078-96d1-38130bb43e1c`
  - Bug: creating project with existing dir as customPath fails with ALREADY_EXISTS
  - Fix: treat existing dir as parent, join(customPath, name); add tilde expansion; update tests

## Resume Instructions
Read this file. Check `git status` in /home/siggi/sources/Codeman. Merge any completed fix worktrees.

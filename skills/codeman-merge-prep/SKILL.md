---
name: codeman-merge-prep
description: Prep a Codeman worktree for merging. Runs full quality gate (typecheck, lint, tests), determines if tests are needed and writes them if so, commits any stragglers, and outputs a merge-ready verdict. Use before merging a worktree branch.
---

# Codeman Merge Prep

## Overview

Run a full pre-merge quality gate on the current worktree. Fix what can be fixed autonomously.
Output a clear verdict: **READY TO MERGE** or **NEEDS ATTENTION** with actionable details.

This skill runs in the worktree directory. If invoked remotely (from the orchestrator session),
send a prompt to the worktree session via the input API — **always include `"useMux": true`**
so the Enter keypress is sent and Claude actually receives the message:

```bash
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/input \
  -H "Content-Type: application/json" \
  -d '{"input": "Invoke the codeman-merge-prep skill.", "useMux": true}'
```

Without `useMux: true` the text is written to the PTY but Enter is never pressed, so Claude
never receives the prompt.

---

## Step 1 — Gather context

Read `TASK.md` (if present) to understand what was changed and why.

```bash
git log master..HEAD --oneline          # commits on this branch
git diff master..HEAD --name-only       # files changed vs master
git status --short                      # uncommitted files
```

Categorise the changed files:
- `src/web/public/` → frontend changes
- `src/**/*.ts` (non-test) → backend/logic changes
- `test/**` → test files touched

---

## Step 2 — Commit stragglers

If `git status --short` shows uncommitted changes:

1. Check each file — is it intentional work product or generated/temp file?
   - `CLAUDE.md`, `TASK.md` — **skip** (task metadata, do not commit to branch)
   - Everything else — add and commit:
     ```bash
     git add -A -- ':!CLAUDE.md' ':!TASK.md'
     git diff --cached --quiet || git commit -m "chore: pre-merge cleanup"
     ```

---

## Step 3 — Typecheck

```bash
tsc --noEmit 2>&1
```

**Pass:** zero errors.
**Fail:** fix all errors, re-run until clean. Do not proceed to Step 4 with TS errors.

---

## Step 4 — Lint

```bash
npm run lint 2>&1
```

**Pass:** zero errors (warnings are acceptable).
**Fail:** run `npm run lint:fix`, then manually fix any remaining errors. Re-run until clean.

---

## Step 5 — Test assessment

### 5a — Were tests needed?

Examine the changed files. Tests are needed if ANY of the following apply:
- New backend route or endpoint was added
- New utility function or class was added in `src/` (non-web/public)
- Existing logic was modified in a way that changes behaviour
- A bug was fixed that could have been caught by a test

Tests are NOT needed for:
- Pure frontend UI changes (CSS, HTML structure, app.js visual behaviour)
- Changes to skill files, docs, or config
- Version bump strings (e.g. `?v=` in index.html)

### 5b — Were tests written?

Check `git diff master..HEAD --name-only` for any `test/**` files.

**If tests were needed AND none were written:**

Dispatch a subagent to write the minimal tests:
- Route tests: use `app.inject()` pattern from `test/routes/_route-test-utils.ts`
- Logic tests: use `vitest` with `globals: true`
- Pick a unique port (search `const PORT =` to avoid collisions)
- Cover: happy path, 404/400 error cases, one edge case

**If tests were needed AND they exist:** proceed to 5c.
**If tests were not needed:** skip to Step 6.

### 5c — Run tests

```bash
npx vitest run test/<relevant-file>.test.ts
```

**NEVER run `npx vitest run` (full suite)** — it spawns tmux sessions and will crash the current Codeman session.

**Pass:** all pass.
**Fail:** fix the code or tests until they pass.

---

## Step 6 — Final git status check

```bash
git status --short
git log master..HEAD --oneline
```

Branch must be clean (no uncommitted changes except CLAUDE.md / TASK.md).
There must be at least one commit beyond master.

---

## Step 6b — Docs checklist

Run:

```bash
git diff master..HEAD --name-only
```

Apply these rules to the output:
- Any file matching `src/web/routes/*.ts` → flag: `"API docs may need update (src/web/routes/ changed)"`
- Any file matching `src/web/public/app.js` or `src/web/public/styles.css` → flag: `"UI docs may need update (frontend changed significantly)"`
- Any file matching `skills/*/SKILL.md` → flag: `"Skill docs may need update (skills/ changed)"`

Record the flags for inclusion in the Step 7 verdict. This is advisory — not a blocking check.

---

## Step 7 — Output verdict

### If all checks passed:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ READY TO MERGE: <branch-name>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Checks passed:
  ✓ TypeScript — 0 errors
  ✓ Lint — 0 errors
  ✓ Tests — <written N tests | not needed | N passed>
  ✓ Git — clean, <N> commit(s) ahead of master

Docs checklist:
  [ ] API docs  — <flagged: src/web/routes/ changed | not needed>
  [ ] UI docs   — <flagged: frontend changed significantly | not needed>
  [ ] Skill docs — <flagged: skills/ changed | not needed>

Commits on branch:
  <git log --oneline output>

To merge:
  Use the Codeman UI merge button, or ask:
  "merge the worktree for <branch>"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### If any check failed and could not be auto-fixed:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠ NEEDS ATTENTION: <branch-name>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Blocking issues:
  ✗ TypeScript — <N errors, see details below>
  ✗ Tests — <N failing>
  ...

Details:
  <paste relevant error output>

Suggested fix:
  <specific actionable instruction>

Docs checklist (informational — not blocking):
  [ ] API docs  — <flagged: src/web/routes/ changed | not needed>
  [ ] UI docs   — <flagged: frontend changed significantly | not needed>
  [ ] Skill docs — <flagged: skills/ changed | not needed>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Committing TASK.md or CLAUDE.md to the branch | Exclude them: `git add -A -- ':!CLAUDE.md' ':!TASK.md'` |
| Running full vitest suite | Only run specific test files — full suite kills the tmux session |
| Skipping test assessment for "just frontend" changes | Still check — new API routes or backend helpers need tests |
| Proceeding to verdict with TS errors | Fix all TS errors before lint/tests — they cascade |
| Wrong port for dev server | Use the worktree's `assignedPort` from session state or TASK.md notes |
| Treating docs flags as blocking | Docs checklist is advisory — it never blocks a merge |

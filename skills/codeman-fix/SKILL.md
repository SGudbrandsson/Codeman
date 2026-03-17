---
name: codeman-fix
description: Use when user wants to fix a bug, debug an issue, or investigate a problem. Triggers on phrases like "fix this bug", "there's a bug with X", "debug X", "investigate X".
---

# Codeman Bug Fix — Intake

## Overview

Prepare a Codeman worktree session for autonomous bug fixing. Creates a worktree via API, then writes `TASK.md` and `CLAUDE.md` to the returned worktree path. The session runs the full fix → review → QA workflow autonomously via the `codeman-task-runner` skill. Base URL: `http://localhost:3001`.

## Step 1 — Collect Inputs

Ask the user (in one message) for everything missing:
- **Title** — one-line summary of the bug (e.g. "hamburger menu blocked by overlay on mobile")
- **Description** — free-text details: what happens, what was expected, any context

If the user already provided these in the invocation, skip asking.

Also ask or infer:
- **Target project** — which repo? (ask if not obvious from context, or infer from current session's `workingDir`)

## Step 2 — Find Parent Session

```bash
curl -s http://localhost:3001/api/sessions
```

Filter for sessions where `worktreeBranch` is null/absent (main sessions only, not sub-worktrees). Match `workingDir` against the project name (case-insensitive). Prefer `status: idle` over `busy`; prefer shorter `workingDir` (closer to repo root).

If no match found, list sessions and ask the user which session to use.

## Step 3 — Generate Branch Name

Slug the title: lowercase, replace spaces/special chars with hyphens, max 37 chars (leave room for -2 or -3 suffixes if branch exists).

Branch name: `fix/<slug>`

Examples:
- "hamburger menu blocked by overlay" → `fix/hamburger-menu-blocked-by-overlay`
- "Session crash on respawn" → `fix/session-crash-on-respawn`

## Step 4 — Create Worktree via API

```bash
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/worktree \
  -H "Content-Type: application/json" \
  -d '{
    "branch": "fix/<slug>",
    "isNew": true,
    "notes": "Read TASK.md in this directory, then invoke the codeman-task-runner skill.",
    "autoStart": false
  }'
```

The `notes` field is just this short trigger sentence — the full task description lives in `TASK.md`. **Do NOT set `autoStart: true`** — that races against the TASK.md write. Write the files first, then start the session in Step 5b.

**Success response:** `{ success: true, session: {...}, worktreePath: "/absolute/path/to/worktree" }`

**Error handling:**
- `NOT_FOUND` → ask user to confirm the project name and retry with the correct session ID.
- `INVALID_INPUT` with "branch already exists" → append `-2` to the slug and retry (e.g. `fix/my-bug-2`).
- `INVALID_INPUT` other → fix the branch name (no spaces, valid git ref characters only).
- `OPERATION_FAILED` → report the full error message and stop.

## Step 5 — Write TASK.md and CLAUDE.md

Write both files to `worktreePath` from the response **before starting the session**.

**Write `<worktreePath>/TASK.md`:**

```markdown
# Task

type: bug
status: analysis
title: <title from Step 1>
description: <full description from Step 1>
affected_area: unknown
fix_cycles: 0
test_fix_cycles: 0

## Reproduction
<!-- filled by analysis subagent -->

## Root Cause / Spec
<!-- filled by analysis subagent -->

## Fix / Implementation Notes
<!-- filled by fix subagent -->

## Review History
<!-- appended by each review subagent — never overwrite -->

## Test Gap Analysis
<!-- filled by test gap analysis subagent -->

## Test Writing Notes
<!-- filled by test writing subagent -->

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

## QA Results
<!-- filled by QA subagent -->

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->
```

**Write `<worktreePath>/CLAUDE.md`:**

```markdown
You are working autonomously in a Codeman worktree.
Before doing ANYTHING else, re-read `TASK.md` in this directory
and resume from the phase in `status`.
Do not rely on conversation history.
Then invoke the codeman-task-runner skill.
```

## Step 5b — Start the session

After both files are written, start the Claude process:

```bash
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/interactive
```

Use the session ID returned in Step 4 (from `session.id` in the response).

## Step 6 — Report

Summarize what was created:
- Branch: `fix/<slug>`
- Worktree: `<worktreePath>`
- Session: link or name from API response
- Status: session started, running autonomously

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Putting full description in `notes` | `notes` is just the short trigger sentence; full description goes in TASK.md |
| Using `autoStart: true` | **Never use autoStart: true** — it races against the TASK.md write. Use `autoStart: false`, write files, then call `/interactive` |
| Forgetting to call `/interactive` after writing files | After `autoStart: false` creation + file writes, always POST to `/api/sessions/:id/interactive` to start Claude |
| Using a worktree session as parent | Filter for `worktreeBranch: null` sessions only |
| Wrong port | Codeman runs on **3001**, not 3000 |
| Branch name with spaces | Use hyphens only, max 37 chars |

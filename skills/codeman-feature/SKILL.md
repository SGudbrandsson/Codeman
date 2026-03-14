---
name: codeman-feature
description: Use when user wants to implement a feature, add new functionality, or build something new. Triggers on phrases like "implement X", "add feature X", "build X", "I need X".
---

# Codeman Feature — Intake

## Overview

Prepare a Codeman worktree session for autonomous feature implementation. Creates a worktree via API, then writes `TASK.md` and `CLAUDE.md` to the returned worktree path. The session runs the full implement → review → QA workflow autonomously via the `codeman-task-runner` skill. Base URL: `http://localhost:3001`.

## Step 1 — Collect Inputs

Ask the user (in one message) for everything missing:
- **Title** — one-line summary of the feature (e.g. "add dark mode toggle to settings panel")
- **Description** — free-text details: what it should do, user-facing behaviour
- **Constraints or acceptance criteria** — any must-haves or must-nots (optional but ask)

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

Branch name: `feat/<slug>`

Examples:
- "add dark mode toggle to settings panel" → `feat/dark-mode-toggle`
- "implement rate limiting for API endpoints" → `feat/api-rate-limiting`

## Step 4 — Create Worktree via API

```bash
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/worktree \
  -H "Content-Type: application/json" \
  -d '{
    "branch": "feat/<slug>",
    "isNew": true,
    "notes": "Read TASK.md in this directory, then invoke the codeman-task-runner skill.",
    "autoStart": false
  }'
```

The `notes` field is just this short trigger sentence — the full task description lives in `TASK.md`. **Do NOT set `autoStart: true`** — that races against the TASK.md write. Write the files first, then start the session in Step 5b.

**Success response:** `{ success: true, session: {...}, worktreePath: "/absolute/path/to/worktree" }`

**Error handling:**
- `NOT_FOUND` → ask user to confirm the project name and retry with the correct session ID.
- `INVALID_INPUT` with "branch already exists" → append `-2` to the slug and retry (e.g. `feat/my-feature-2`).
- `INVALID_INPUT` other → fix the branch name (no spaces, valid git ref characters only).
- `OPERATION_FAILED` → report the full error message and stop.

## Step 5 — Write TASK.md and CLAUDE.md

Write both files to `worktreePath` from the response.

**Write `<worktreePath>/TASK.md`:**

```markdown
# Task

type: feature
status: analysis
title: <title from Step 1>
description: <full description from Step 1>
constraints: <constraints/acceptance criteria from Step 1, or "none specified">
affected_area: unknown
fix_cycles: 0

## Root Cause / Spec
<!-- filled by analysis subagent -->

## Fix / Implementation Notes
<!-- filled by implement subagent -->

## Review History
<!-- appended by each review subagent — never overwrite -->

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

## Step 5b — Start the Session

After writing both files, start the Claude process:

```bash
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/interactive
```

This fires Claude only after TASK.md is safely on disk, eliminating the race condition.

## Step 6 — Report

Summarize what was created:
- Branch: `feat/<slug>`
- Worktree: `<worktreePath>`
- Session: link or name from API response
- Status: session started, running autonomously

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Putting full description in `notes` | `notes` is just the short trigger sentence; full description goes in TASK.md |
| Using `autoStart: true` | **Never use autoStart: true** — it races against the TASK.md write. Use `autoStart: false`, write files, then call `/interactive` |
| Using a worktree session as parent | Filter for `worktreeBranch: null` sessions only |
| Wrong port | Codeman runs on **3001**, not 3000 |
| Branch name with spaces | Use hyphens only, max 37 chars |
| Forgetting to call `/interactive` after writing files | After `autoStart: false` creation + file writes, always POST to `/api/sessions/:id/interactive` to start Claude |
| Sending input without `useMux: true` | `POST /api/sessions/:id/input` without `useMux: true` writes text but never sends Enter — Claude never receives the message. Always include `"useMux": true` |

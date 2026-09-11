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

Pass `taskMd` and `claudeMd` inline so the server writes them atomically before returning. This eliminates the race condition where Claude starts before TASK.md exists.

```bash
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/worktree \
  -H "Content-Type: application/json" \
  -d '{
    "branch": "feat/<slug>",
    "isNew": true,
    "mode": "claude",
    "notes": "Read TASK.md in this directory, then invoke the codeman-task-runner skill.",
    "autoStart": false,
    "taskMd": "<TASK.md content as a JSON string — see Step 4a>",
    "claudeMd": "You are working autonomously in a Codeman worktree.\nBefore doing ANYTHING else, re-read `TASK.md` in this directory\nand resume from the phase in `status`.\nDo not rely on conversation history.\nThen invoke the codeman-task-runner skill.\n"
  }'
```

**Always send `"mode": "claude"`.** If omitted, the worktree inherits the parent session's mode, and Codeman's own main sessions are often `shell`. The result is a plain fish shell: `/interactive` still returns `{success:true}` and the kickoff prompt runs as a shell command ("Command 'Read' not found"). Only use another mode if the user explicitly asks for a different harness.

The server writes `TASK.md` and `CLAUDE.md` to the worktree directory before returning. **Do NOT write these files separately** — use the `taskMd`/`claudeMd` fields to avoid race conditions.

**Success response:** `{ success: true, session: {...}, worktreePath: "/absolute/path/to/worktree" }`

**Error handling:**
- `NOT_FOUND` → ask user to confirm the project name and retry with the correct session ID.
- `INVALID_INPUT` with "branch already exists" → append `-2` to the slug and retry (e.g. `feat/my-feature-2`).
- `INVALID_INPUT` other → fix the branch name (no spaces, valid git ref characters only).
- `OPERATION_FAILED` → report the full error message and stop.

## Step 4b — Create Work Item (optional — guard all steps)

If the work item API is unavailable or returns an error at any sub-step, log a warning and continue. Work item tracking must never block the core task workflow.

**4b.1 — Create the work item:**

```bash
curl -s -X POST http://localhost:3001/api/work-items \
  -H "Content-Type: application/json" \
  -d '{
    "title": "<title from Step 1>",
    "description": "<description from Step 1>",
    "source": "manual"
  }'
```

Save the returned `data.id` as `WORK_ITEM_ID`. If the request fails, set `WORK_ITEM_ID=none` and skip 4b.2 and 4b.3.

**4b.2 — Auto-claim if the session has an agent:**

From the Step 2 parent session lookup, check if the session object has `agentProfile.agentId`. If it does:

```bash
curl -s -X POST http://localhost:3001/api/work-items/WORK_ITEM_ID/claim \
  -H "Content-Type: application/json" \
  -d '{"agentId": "<agentProfile.agentId>"}'
```

If the response is 409 (already claimed), skip silently. If the session has no `agentProfile.agentId`, skip this step.

**4b.3 — Link worktree path and branch:**

After Step 4 returns `worktreePath`:

```bash
curl -s -X PATCH http://localhost:3001/api/work-items/WORK_ITEM_ID \
  -H "Content-Type: application/json" \
  -d '{
    "worktreePath": "<worktreePath>",
    "branchName": "feat/<slug>",
    "taskMdPath": "<worktreePath>/TASK.md"
  }'
```

If this PATCH fails, log a warning and continue.

## Step 4a — TASK.md content template

Use this template for the `taskMd` field in Step 4 (JSON-escape newlines as `\n`):

```markdown
# Task

type: feature
status: analysis
title: <title from Step 1>
description: <full description from Step 1>
constraints: <constraints/acceptance criteria from Step 1, or "none specified">
affected_area: unknown
work_item_id: <WORK_ITEM_ID, or "none" if not created>
fix_cycles: 0
test_fix_cycles: 0

## Root Cause / Spec
<!-- filled by analysis subagent -->

## Fix / Implementation Notes
<!-- filled by implement subagent -->

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

## Step 5 — Start the Session

The server already wrote TASK.md and CLAUDE.md in Step 4. Now start Claude:

```bash
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/interactive
```

Use the session ID from Step 4 response (`session.id`).

## Step 5b — Send the kickoff prompt (REQUIRED)

`/interactive` only spawns Claude — it sends NO prompt. CLAUDE.md is only read once a
prompt is submitted, so without this step the session sits idle forever at an empty prompt.

Wait ~3 seconds for Claude to initialize. **Before sending anything, confirm Claude is actually running:** `GET /api/sessions/SESSION_ID` must show `mode: "claude"`, and `GET /api/sessions/SESSION_ID/terminal` should show the Claude Code banner, not a shell prompt. If it is a shell session, do NOT send input — see the `mode` row in Common Mistakes for recovery. Then send the kickoff prompt via `/input`:

```bash
sleep 3
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/input \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Read TASK.md in this directory, then invoke the codeman-task-runner skill.",
    "submit": true
  }'
```

**Verify delivery:** wait ~5 seconds, then `curl -s http://localhost:3001/api/sessions/SESSION_ID`
and check `isWorking: true` (or `status: busy`). If still idle, re-send the `/input` call once.
Do not report success until the session is confirmed working.

## Step 6 — Report

Summarize what was created:
- Branch: `feat/<slug>`
- Worktree: `<worktreePath>`
- Session: link or name from API response
- Status: session started, kickoff prompt confirmed delivered (Step 5b), running autonomously
- Work item: `<WORK_ITEM_ID>` (or "none — work item tracking skipped")
  Board: http://localhost:3001 → Board → find item "<title>"

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Writing TASK.md/CLAUDE.md separately with Write tool | **Always use `taskMd`/`claudeMd` fields** in the worktree creation request — the server writes them atomically before returning, eliminating race conditions |
| Putting full description in `notes` | `notes` is just the short trigger sentence; full description goes in `taskMd` |
| Using `autoStart: true` | Use `autoStart: false`, then call `/interactive` after worktree creation returns |
| Using a worktree session as parent | Filter for `worktreeBranch: null` sessions only |
| Wrong port | Codeman runs on **3001**, not 3000 |
| Branch name with spaces | Use hyphens only, max 37 chars |
| Forgetting to call `/interactive` | Always POST to `/api/sessions/:id/interactive` after worktree creation to start Claude |
| Sending input without `useMux: true` | `POST /api/sessions/:id/input` without `useMux: true` writes text but never sends Enter — Claude never receives the message. Always include `"useMux": true` (or `"submit": true`, which implies mux + Enter) |
| **Stopping after `/interactive`** | `/interactive` spawns Claude but sends NO prompt — the session sits idle forever. Always follow with Step 5b: POST `/api/sessions/:id/input` with `{"input": "...", "submit": true}` and verify `isWorking: true` |
| Omitting `mode` in the worktree request | The worktree inherits the parent's mode (often `shell`), so Claude never starts. Always pass `"mode": "claude"`. **Recovery** if it already happened: `POST /api/sessions` with `mode: "claude"`, `workingDir`, and the old session's `worktreeBranch`/`worktreePath`/`worktreeOriginId`/`worktreeNotes`/`assignedPort`; then `DELETE /api/sessions/<old-id>` (plain delete keeps the worktree dir — do NOT use `DELETE /api/sessions/<id>/worktree`, which removes it); then run Steps 5–5b on the new session |

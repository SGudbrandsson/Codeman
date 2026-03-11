---
name: codeman-worktrees
description: Use when user wants to create one or more git worktrees in Codeman, start feature branches across multiple projects, spin up new isolated sessions for parallel work, merge worktrees back to master, or close/remove worktree sessions. Triggers on phrases like "create a worktree", "new branch for X", "work on X and Y at the same time", "spin up a session for", "merge this worktree", "close the worktree".
---

# Codeman Worktree Creator

## Overview

Create git worktrees + Codeman sessions via API. Handles multiple repos in one conversation. Base URL: `http://localhost:3001`.

## Workflow

```dot
digraph flow {
  "Collect inputs" -> "Find parent sessions";
  "Find parent sessions" -> "Missing session?" [label="any?"];
  "Missing session?" -> "Ask user which session to use" [label="yes"];
  "Missing session?" -> "Create worktrees" [label="no"];
  "Ask user which session to use" -> "Create worktrees";
  "Create worktrees" -> "Report results";
}
```

## Step 1 — Collect Inputs

Ask the user (in one message) for everything missing:
- Which **project(s)** (repo name or path)
- **Branch name(s)** for each (e.g. `feat/my-feature`)
- **Description/notes** for each worktree — bug details, task context, etc. (pass as `notes`)
- New branch or existing? (default: new)

If user already provided these, skip asking.

## Step 2 — Find Parent Session

```bash
curl -s http://localhost:3001/api/sessions
```

Returns array of session objects. Find the best match for each project:
- Filter: `worktreeBranch` is null/absent (main sessions only, not sub-worktrees)
- Match: `workingDir` contains the project name (case-insensitive)
- Prefer: `status: idle` over `busy`; shorter `workingDir` (closer to repo root)

If multiple candidates, pick the most likely one. If none found, ask the user which session ID to use.

## Step 3 — Create Worktree

For each project × branch pair:

```bash
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/worktree \
  -H "Content-Type: application/json" \
  -d '{"branch": "feat/my-feature", "isNew": true, "notes": "Bug: hamburger menu blocked by overlay"}'
```

**Body fields:**
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `branch` | string | yes | Full branch name e.g. `feat/my-feature` |
| `isNew` | boolean | yes | `true` = create new branch, `false` = checkout existing |
| `mode` | string | no | `claude` / `opencode` / `shell` — inherits from parent if omitted |
| `notes` | string | no | Bug description or task context (max 2000 chars) — stored on the session and sent as initial Claude prompt |

**Success response:** `{ success: true, session: {...}, worktreePath: "/path/to/worktree" }`

**Error response:** `{ success: false, error: { code, message } }`

Common errors:
- `OPERATION_FAILED` + "branch already exists" → set `isNew: false`
- `NOT_FOUND` → wrong session ID, re-fetch sessions
- `INVALID_INPUT` → branch name invalid (no spaces, valid git ref)

## Step 4 — Multiple Repos in Parallel

When creating worktrees across multiple repos, run all `curl` calls in a single Bash command with `&` and `wait`, or sequentially if you need error handling per repo.

## Step 5 — Report Results

After all calls complete, summarize:
- ✓ Created: branch name, worktree path, new session name
- ✗ Failed: error message + what to try next

---

## Merge & Close Workflow

When user wants to merge a worktree branch back to master and remove it:

### Step 1 — Find the worktree session

```bash
curl -s http://localhost:3001/api/sessions | jq '.[] | select(.worktreeBranch != null) | {id, name, worktreeBranch, worktreeOriginId}'
```

### Step 2 — Merge branch into parent

Call merge on the **origin/parent** session, passing the worktree branch name:

```bash
curl -s -X POST http://localhost:3001/api/sessions/ORIGIN_SESSION_ID/worktree/merge \
  -H "Content-Type: application/json" \
  -d '{"branch": "fix/my-branch"}'
```

**Possible responses:**
- `{ success: true, output: "..." }` — merged successfully
- `{ success: false, uncommittedChanges: true, message: "..." }` — worktree has uncommitted files; commit them first then retry
- `{ success: false, error: { code: "OPERATION_FAILED", message: "Merge failed: ..." } }` — git merge error (conflicts, etc.)

If `uncommittedChanges: true` → tell the user the Claude session inside the worktree needs to commit its work first. You can commit manually:
```bash
git -C /path/to/worktree add -A && git -C /path/to/worktree commit -m "fix: description"
```
Then retry the merge.

### Step 3 — Remove worktree and delete session

```bash
# Remove worktree from disk (force if needed)
curl -s -X DELETE http://localhost:3001/api/sessions/WORKTREE_SESSION_ID/worktree \
  -H "Content-Type: application/json" \
  -d '{"force": false}'

# Delete the Codeman session from the sidebar
curl -s -X DELETE http://localhost:3001/api/sessions/WORKTREE_SESSION_ID
```

### Step 4 — Rebuild and deploy (if it's the Codeman repo)

```bash
npm run build && cp -r dist /home/siggi/.codeman/app/ && cp package.json /home/siggi/.codeman/app/package.json && systemctl --user restart codeman-web
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using a worktree session as parent | Find sessions where `worktreeBranch` is null |
| Branch name with spaces | Use hyphens/slashes only |
| `isNew: true` on existing branch | Set `isNew: false` |
| Merging when worktree has uncommitted changes | Commit in the worktree first, then merge |
| Wrong port | Codeman runs on port **3001**, not 3000 |
| Forgetting to delete the session after removing worktree | Always `DELETE /api/sessions/:id` after worktree removal |

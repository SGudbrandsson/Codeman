---
name: bug-to-worktree
description: Use when the user wants to process a bug report into a Codeman worktree. Accepts an Asana URL, task code (e.g. KA-34), Asana GID, or natural language description of the bug. Triggers on phrases like "process bug KA-34", "create a worktree for this bug", "fix the seasonal photos bug", "spin up a worktree for <bug description>".
---

# Bug-to-Worktree

## Overview

Turns an Asana bug report into a fully briefed Codeman worktree that autonomously runs the full fix-to-PR pipeline. Source is Asana for v1.

Pipeline:
```
[Disambiguation] → [Fetcher Subagent] → [Bug Brief] →
  [codeman-worktrees] → [Asana: move to In Progress + start comment]
                                ↓
              Worktree Claude runs fix-workflow + /codeman-full-qa
                                ↓
              [Asana: move to Code review + finish comment]
                                ↓
                          PR opens on origin
```

The **Bug Brief** (`/tmp/bug-briefs/<id>/brief.json`) is the normalized contract between steps.

Codeman API base: `http://localhost:3001`

Asana is reached via `mcp__gateway__execute service=asana action=…`. **Do not call `mcp__claude_ai_Asana__*`** — those tools do not exist in this environment. For project / section GIDs and call shapes, see the project-local `.skills/asana-workflow.md` (in repos that have it; otherwise the defaults below).

---

## Step 1 — Disambiguate the Task

Resolve which task the user means before doing any heavy work.

`AskUserQuestion` means: invoke the AskUserQuestion tool and wait for the reply before continuing. If the user already said "no need to confirm" or named an exact URL/GID, skip the confirmation.

Reject → restart always re-enters Step 1 from the top (user provides new input, which may be any form).

### Path A — Full Asana URL or raw GID

Extract the GID from the URL (last numeric segment) or use it directly. Look up the task:

```
mcp__gateway__execute
  service: "asana"
  action: "get_task"
  params: {"task_id": "<GID>"}
```

If the user did NOT pre-confirm, use `AskUserQuestion`:

> "Found: **<task code or title>** — '<title>'. Is this the right task?"

- Yes → Step 2.
- No → ask what to search for, restart Step 1.

### Path B — Task code (e.g. KA-34)

The gateway exposes `search_tasks`, but Asana's search endpoint requires a premium plan and returns HTTP 402 on this workspace. Prefer Path A whenever possible. If only a task code is provided:

1. Try `mcp__gateway__execute service=asana action=search_tasks params={"query": "<code>", "project_id": "<the relevant project GID>"}`.
2. If it returns 402, fall back to `list_project_tasks` for the most likely project and grep the result for the code.
3. Single match → confirm via `AskUserQuestion` and continue to Step 2. Multiple matches → ask the user to pick. Zero matches → ask what to search for instead.

### Path C — Natural language

Same as Path B with the description as the query. If search is unavailable (402), ask the user for the URL or GID directly rather than guessing.

Do not proceed to Step 2 until the task is confirmed (or the user said "no need to confirm").

---

## Step 2 — Fetcher Subagent

Dispatch a subagent (`general-purpose`) with the prompt below. Pass it the confirmed Asana task GID. The subagent uses the gateway, not `mcp__claude_ai_Asana__*`.

```
You are a bug report fetcher. Fetch a complete Asana task and produce a raw Bug Brief JSON.

Task GID: <GID>

Steps:
1. Fetch the task and its comments via the MCP gateway:
   mcp__gateway__execute
     service: "asana"
     action: "get_task"
     params: {"task_id": "<GID>"}
   Use the gateway's get_task_comments action for the comment list.
2. If the task has a parent (data.parent is not null), fetch that parent the same way.
3. Determine the directory id:
   - task-code: the human-readable code in the title or notes (e.g. "KA-34"). If none, use the GID itself.
   - Create the brief dir: mkdir -p /tmp/bug-briefs/<id>/
4. Download attachments (if any) into that dir using curl -sL <url> -o /tmp/bug-briefs/<id>/<name>.
5. **READ every downloaded image with the Read tool** and write what it shows into
   the brief's `attachmentFindings`. Downloading is not reading — you can see
   images, so look at them. Operator bug reports are mostly screenshots and the
   decisive evidence is usually in the picture, not the prose. If the image
   contradicts the task text, the image wins: say so explicitly.
6. Fetch the task's comments too, and read any images attached to them — the
   clarification that changes the diagnosis usually arrives as a screenshot in a
   later comment, sometimes in Icelandic. Translate rather than skip.

Output ONLY a JSON object matching:
{
  "id": "<task-code or GID>",
  "source": "asana",
  "asanaGid": "<GID>",
  "title": "<task name>",
  "description": "<task notes>",
  "type": "bug",
  "url": "<source URL from notes if present, else permalink_url>",
  "reporter": "<reporter email if mentioned in notes>",
  "sourceLink": "<marker.io or external issue link if present>",
  "environment": "<environment string if present>",
  "attachments": [ { "name": "<filename>", "localPath": "/tmp/bug-briefs/<id>/<filename>", "whatItShows": "<what you SAW when you read it — required for images>" } ],
  "comments": [ { "author": "<name or email>", "at": "<ISO timestamp>", "text": "<text>" } ],
  "parentTask": { "id": "...", "title": "...", "description": "...", "url": "..." } | null
}

Use null or [] for fields with no data. Do not add confidence, gaps, isMorphed, or isFollowUp.
```

Save the JSON to `/tmp/bug-briefs/<id>/brief.json`. Parse failures → report to the user and stop.

---

## Step 3 — Create the Worktree

Hand the Bug Brief to the `codeman-worktrees` skill (or call the Codeman API directly per its instructions). The worktree's TASK.md must include:

- `title:` from the brief
- `description:` from the brief
- `asana: <permalink URL>` and `asana_gid: <GID>` — used by the worktree's later sync step
- `## Reproduction`, `## Root Cause / Spec`, etc. (see project-local `.skills/new-worktree.md` for the canonical template)
- A `## Post-Fix Action` section reminding the worktree to: run /codeman-full-qa, push, open a PR, then post the Code-review comment + move the Asana section.

After the worktree exists and Claude has been started in it, **continue to Step 4** — do not stop here.

---

## Step 4 — Asana: mark In Progress

Move the task to **In Progress** and post a start comment. This is the parent session's job (the worktree Claude does not see the user's chat history, so it cannot describe what the user said).

For the **Keeps - Unibrix** project (most common):

```
mcp__gateway__execute
  service: "asana"
  action: "add_task_to_project"
  params: {"task_id": "<GID>", "project_id": "1207965059957872", "section_id": "1207965059957879"}
```

```
mcp__gateway__execute
  service: "asana"
  action: "post_comment"
  params: {"task_id": "<GID>", "text": "🔧 Started: <one-sentence summary>. Branch <branch>. Worktree will systematically investigate, fix, run full QA, and open a PR."}
```

For any **other** project, list its sections first (the gateway does not expose a list-sections action — use curl with the token from `apps/app/.env.prod` `ASANA_ACCESS_TOKEN`):

```bash
ASANA_TOKEN=$(grep -h '^ASANA_ACCESS_TOKEN=' apps/app/.env.prod | cut -d= -f2- | tr -d '"')
curl -s -H "Authorization: Bearer $ASANA_TOKEN" \
  "https://app.asana.com/api/1.0/projects/<PROJECT_GID>/sections" \
  | python3 -c "import json,sys; [print(s['gid'], s['name']) for s in json.load(sys.stdin)['data']]"
```

Pick the section that matches "In Progress" / "Doing" / "Active" and use its GID in `add_task_to_project`.

Project-local `.skills/asana-workflow.md` (in the Keeps repo) is the single source of truth for these GIDs — defer to it whenever it exists.

---

## Step 5 — Hand off, then poll

Report to the user:
- Branch + worktree path + Codeman session id
- Asana task moved to In Progress (with the post-comment confirmation)
- The worktree is autonomously running fix-workflow → /codeman-full-qa → PR

Schedule a wakeup (~20–30 min) to:
1. Check the Codeman session status and the worktree's TASK.md `status:` field.
2. If `status: done` and a PR exists (`gh pr list --head <branch>`), the worktree should already have moved the Asana task to **Code review** itself via fix-workflow's Phase 5b. If it hasn't (the worktree predates that phase, or the Asana call failed), do it from the parent:

   ```
   add_task_to_project  → project 1207965059957872, section 1207965059957890
   post_comment         → "✅ Ready for code review — PR <url>. Root cause: …. Fix: … Tests: …. Full QA pipeline passed."
   ```

3. If the worktree is stuck or failed, move the Asana task to **On Hold** (Keeps-Unibrix section `1208260165130052`) with an explanation comment, and surface the blocker to the user.

---

## Common Mistakes

| Mistake | Fix |
|---|---|
| Using `mcp__claude_ai_Asana__*` | Those tools are not available. Use `mcp__gateway__execute` with `service: "asana"`. |
| Creating the worktree but skipping Step 4 | The Asana board should reflect "In Progress" the moment the branch exists. Step 4 is non-optional. |
| Hard-coding section names | Use GIDs. Names change; GIDs do not. |
| Moving sections silently with no comment | Every section move pairs with a comment. A move alone hides the why. |
| Forgetting `project_id` on `add_task_to_project` | Sections belong to a project — both IDs are required. |
| Trying to also auto-move to Completed on merge | Stop at Code review. Completed is moved by the human reviewer / board automation. |

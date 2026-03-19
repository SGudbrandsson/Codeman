---
name: bug-to-worktree
description: Use when the user wants to process a bug report into a Codeman worktree. Accepts an Asana URL, task code (e.g. KA-34), Asana GID, or natural language description of the bug. Triggers on phrases like "process bug KA-34", "create a worktree for this bug", "fix the seasonal photos bug", "spin up a worktree for <bug description>".
---

# Bug-to-Worktree

## Overview

Turns an Asana bug report into a fully briefed Codeman worktree that autonomously runs the full fix-to-PR pipeline. Source is Asana for v1.

Pipeline:
```
[Disambiguation] → [Fetcher Subagent] → [Analyzer Subagent] → [codeman-worktrees skill]
                                                                       ↓
                                                           Worktree Claude uses
                                                     superpowers:systematic-debugging
```

The **Bug Brief** (`/tmp/bug-briefs/<id>/brief.json`) is the normalized contract between all steps.

Codeman API base: `http://localhost:3001`

---

## Step 1 — Disambiguate the Task

Resolve what task the user is referring to before doing any heavy work.

`AskUserQuestion` means: invoke the AskUserQuestion tool to send the user a message and wait for their reply before continuing.

Reject → restart always re-enters Step 1 from the top (the user provides new input, which may be any form).

### Path A — Full Asana URL or raw GID:
Extract the GID from the URL (last numeric segment) or use it directly. Call `mcp__claude_ai_Asana__get_task` with the GID for a direct lookup. Use `AskUserQuestion` to confirm:

> "Found: **KA-34** — 'Very important! Seasonal photos not in leonardo'. Is this the right task?"

- If yes: proceed to Step 2.
- If no: use `AskUserQuestion` to ask what to search for instead, then restart from the top of Step 1 with the new input.

### Path B — Task code (e.g. KA-34):
Use `mcp__claude_ai_Asana__search_objects` with `resource_type: "task"` and the exact task code as the query. Then:

- **Single result:** Use `AskUserQuestion` to confirm: "Found: **KA-34** — 'title'. Is this the right task?"
  - If yes: proceed to Step 2.
  - If no: use `AskUserQuestion` to ask what to search for instead, then restart from the top of Step 1.
- **Multiple results:** Use `AskUserQuestion` to present all candidates (ID + title each). Wait for the user to pick one. If the user rejects all / says none match, use `AskUserQuestion` to ask what to search for instead, then restart from the top of Step 1.
- **No results:** Use `AskUserQuestion` to say no match was found and ask what to search for instead, then restart from the top of Step 1.

### Path C — Natural language (e.g. "the seasonal photos bug"):
Use `mcp__claude_ai_Asana__search_objects` with `resource_type: "task"` and the natural language description as the query. Then:

- **Multiple results:** Use `AskUserQuestion` to present the candidates (show ID + title for each). Wait for the user to pick one. If the user rejects all / says none match, use `AskUserQuestion` to ask what to search for instead, then restart from the top of Step 1.
- **Single result:** Use `AskUserQuestion` to confirm: "Found: **KA-34** — 'title'. Is this the right task?"
  - If yes: proceed to Step 2.
  - If no: use `AskUserQuestion` to ask what to search for instead, then restart from the top of Step 1.
- **No results:** Use `AskUserQuestion` to say no match was found and ask what to search for instead, then restart from the top of Step 1.

Do not proceed to Step 2 until the task is confirmed.

---

## Step 2 — Fetcher Subagent

Dispatch a subagent with the following instructions. Pass it the confirmed Asana task GID.

**Subagent prompt:**

```
You are a bug report fetcher. Your job is to fetch a complete Asana task and produce a raw Bug Brief JSON.

Task GID: <GID>

Steps:
1. Fetch the full task including comments: use mcp__claude_ai_Asana__get_task with opt_fields:
   "gid,name,notes,custom_fields,permalink_url,attachments,parent,stories,stories.created_at,stories.created_by,stories.text,stories.type"
   The `stories` field contains all comments on the task. Filter to stories where type is "comment".
2. If the task has a parent (task.parent is not null), fetch the parent task with the same opt_fields.
3. Download all attachments:
   - task-code is the human-readable code from custom_fields (e.g. "KA-34").
     If no task code exists, use the raw GID as the directory name. Use this as <id>.
   - Create directory: /tmp/bug-briefs/<id>/
   - For each attachment URL, download to that directory:
     curl -sL "<url>" -o "/tmp/bug-briefs/<id>/<filename>"

Output ONLY a JSON object matching this schema (no other text):
{
  "id": "<task-code or GID>",
  "source": "asana",
  "title": "<task name>",
  "description": "<task notes>",
  "type": "bug",
  "url": "<source URL from task notes if present, else permalink_url>",
  "reporter": "<reporter email from task notes if present>",
  "sourceLink": "<marker.io or external issue link from task notes if present>",
  "environment": "<environment string from task notes if present>",
  "attachments": [
    { "name": "<filename>", "localPath": "/tmp/bug-briefs/<id>/<filename>" }
  ],
  "comments": [
    { "author": "<author name or email>", "at": "<ISO timestamp>", "text": "<comment text>" }
  ],
  "parentTask": {
    "id": "<parent task code or GID>",
    "title": "<parent task name>",
    "description": "<parent task notes>",
    "url": "<parent permalink_url>"
  }
}

parentTask should be null if no parent exists. If any other field has no data, use null or [] as appropriate.
Do not add confidence, gaps, isMorphed, or isFollowUp — those are set by the analyzer.
```

After the subagent returns, parse its JSON output as the raw Bug Brief. If parsing fails, report the error to the user and stop.

---
name: prepare-for-compaction
description: Use when context window is filling up, a compaction warning appears, or before starting a long multi-step operation where continuity matters - preserves work state so the post-compaction instance resumes without asking the user to repeat context
---

# Prepare for Compaction

## Overview

Context compaction erases all conversation history. Anything not written to disk is lost forever. This skill ensures the post-compaction Claude instance has everything needed to resume seamlessly — no user re-explanation required.

## When to Use

- System warns context is approaching limits
- You're mid-task and compaction seems likely
- User says "prepare for compaction" or "save your state"
- Before starting a long operation you may not finish in one context

**NOT needed if:** task is complete, or the entire context fits in one conversation.

## Step 1: Check git state

```bash
git status
git diff --stat
```

## Step 2: Commit pending work

Commit meaningful in-progress changes so the post-compaction instance doesn't face an ambiguous working tree:

```bash
git add <specific files>
git commit -m "wip: <describe current state>"
```

If nothing meaningful to commit yet, skip this step.

## Step 3: Write COMPACT.md

Create `COMPACT.md` in the working directory (or update `TASK.md` if in a Codeman worktree — set `status` to current phase):

```markdown
# Compaction Handoff — YYYY-MM-DD

## Goal
<verbatim or close paraphrase of what the user asked for>

## Status
- [x] <completed step with file/line refs>
- [x] <completed step>
- [ ] **RESUME HERE:** <next action — be specific: file, function, what to do>
- [ ] <remaining step>
- [ ] <remaining step>

## Key Decisions
<non-obvious choices made and why — omit anything obvious>

## Files Changed
- `path/to/file.ts` — <what changed>

## Blockers / Open Questions
<anything unresolved>

## Resume Instructions
Read this file. Run `git status` to confirm state. Then execute the RESUME HERE step.
```

## Step 4: Inform the user

> "Context is compacting. State saved to COMPACT.md (changes committed). After compaction I'll re-read it and continue from [next step]."

## Resuming After Compaction

First action when resuming:
1. Read `COMPACT.md` (or `TASK.md` in worktrees)
2. Run `git status` to verify committed state
3. Execute the **RESUME HERE** step
4. Do NOT ask the user to repeat the task

## Codeman Worktree Note

In Codeman worktrees, `TASK.md` + `CLAUDE.md` already handle resume. Update `status` to the current phase, add any in-progress notes, and the `CLAUDE.md` autoload will trigger resume automatically.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Assuming memory survives compaction | It doesn't. Write everything important to disk. |
| Vague "next step" | Specify file, function, exact action |
| Not committing WIP | Uncommitted changes confuse the next instance |
| Writing COMPACT.md but not reading it on resume | First action post-compaction: read the state file |
| Repeating prior context verbatim | Summarize decisions; don't dump conversation |

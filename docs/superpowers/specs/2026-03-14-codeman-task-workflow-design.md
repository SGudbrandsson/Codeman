# Codeman Task Workflow — Design Spec

**Date:** 2026-03-14
**Status:** Approved
**Scope:** Two intake skills + one shared runner skill for autonomous bug-fix and feature-implementation workflows in Codeman worktrees.

---

## Problem

Working on multiple parallel tasks in Codeman today requires manually creating a worktree, manually driving the investigation, fix, review, and QA phases, and losing context when the session compacts or resets. There is no automated workflow that takes a task from intake to a reviewable commit without human intervention at every step.

---

## Goals

1. Accept a free-text bug description or feature request and produce a clean, reviewed, tested commit — autonomously.
2. Run in a Codeman worktree session so the main session stays free for other work.
3. Survive context compaction and session resets without losing the thread.
4. Enforce a review loop (max 3 attempts) before committing, with graceful failure handling.
5. Apply targeted QA (typecheck + lint + area-specific verification) before every commit.

---

## Architecture

Three skill files with a two-layer design: thin intake skills that prepare and hand off, and a shared runner that executes the full workflow autonomously inside the worktree session.

```dot
digraph task_workflow {
    rankdir=TB;
    node [shape=box, fontname="monospace"];

    subgraph cluster_main {
        label="Main Claude Session";
        style=dashed;
        fix_intake   [label="codeman-fix\n(intake skill)"];
        feat_intake  [label="codeman-feature\n(intake skill)"];
    }

    subgraph cluster_worktree {
        label="Worktree Session (autonomous)";
        style=dashed;
        runner    [label="codeman-task-runner\n(runner skill)"];
        analysis  [label="Analysis\nsubagent", shape=ellipse];
        fix       [label="Fix/Implement\nsubagent", shape=ellipse];
        review    [label="Review\nsubagent\n(×3 max)", shape=ellipse];
        qa        [label="QA\nsubagent", shape=ellipse];
        commit    [label="Commit\n& Report", shape=ellipse];
    }

    task_md   [label="TASK.md\n(persistent anchor)", shape=cylinder];
    claude_md [label="CLAUDE.md\n(compact guard)", shape=cylinder];
    worktree  [label="Git Worktree\n(isolated branch)", shape=folder];

    fix_intake  -> worktree  [label="creates via API"];
    feat_intake -> worktree  [label="creates via API"];
    fix_intake  -> task_md   [label="writes (type: bug)"];
    feat_intake -> task_md   [label="writes (type: feature)"];
    fix_intake  -> claude_md [label="writes"];
    feat_intake -> claude_md [label="writes"];

    worktree  -> runner   [label="autoStart prompt:\nread TASK.md → invoke runner"];
    claude_md -> runner   [label="reloaded after\ncompact/clear"];

    runner -> analysis;
    runner -> fix;
    runner -> review;
    runner -> qa;
    runner -> commit;

    analysis -> task_md  [label="writes", style=dashed];
    fix      -> task_md  [label="writes", style=dashed];
    review   -> task_md  [label="appends", style=dashed];
    qa       -> task_md  [label="writes", style=dashed];

    task_md -> runner    [label="re-read at\nevery phase", style=dotted];
}
```

---

## Context Rot Protection

Two mechanisms work together:

**1. `TASK.md` — persistent phase anchor**
Written to the worktree root at creation. Updated at the end of every phase. Each subagent's first action is to re-read it. If the session compacts or Claude restarts, the runner picks up from `status` in `TASK.md` — no reliance on conversation history.

**2. Worktree `CLAUDE.md` — compact/clear guard**
Written to the worktree root at creation. Claude Code auto-reloads `CLAUDE.md` after `/compact` and `/clear`. Content:

```
You are working autonomously in a Codeman worktree.
Before doing ANYTHING else, re-read `TASK.md` in this directory
and resume from the phase in `status`.
Do not rely on conversation history.
Then invoke the codeman-task-runner skill.
```

---

## TASK.md Structure

```markdown
# Task

type: bug | feature
status: analysis | fixing | reviewing | qa | done | failed
title: <one-line summary>
description: <free text from user>
affected_area: backend | frontend | logic | unknown
attempts: 0

## Reproduction (bugs only)
<!-- filled by analysis subagent -->

## Root Cause / Spec
<!-- filled by analysis subagent -->

## Fix / Implementation Notes
<!-- filled by fix/implement subagent -->

## Review History
<!-- appended by each review subagent — never overwrite, max 3 entries -->

## QA Results
<!-- filled by QA subagent -->

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->
```

---

## Phase Definitions

### Phase 1 — Analysis

**Subagent job:**
- Read `TASK.md` description
- Explore the codebase to understand the affected area
- **Bugs:** attempt to reproduce the issue; document reproduction steps; identify root cause hypothesis
- **Features:** gather implicit constraints from existing code; draft a minimal spec
- Determine `affected_area`: `backend` | `frontend` | `logic`

**Writes to TASK.md:** Reproduction section (bugs), Root Cause / Spec section, `affected_area` field
**Updates status:** `analysis` → `fixing`

---

### Phase 2 — Fix / Implement

**Subagent job:**
- Read `TASK.md` (analysis outputs + full description)
- Implement the fix or feature in the worktree
- Keep changes minimal and focused — no unrelated cleanup
- Document key decisions in the Decisions & Context section

**Writes to TASK.md:** Fix / Implementation Notes
**Updates status:** `fixing` → `reviewing`

---

### Phase 3 — Review Loop (max 3 attempts)

**Subagent job (fresh context each attempt):**
- Read `TASK.md` + `git diff` of changes
- Approve or flag specific issues (no vague feedback)
- If approved: proceed to QA
- If issues found: pass back to Fix subagent; increment `attempts`

**Writes to TASK.md:** Appends one entry to Review History per attempt
**Loop exit conditions:**
- Reviewer approves → status → `qa`
- `attempts` reaches 3 → commit with `[NEEDS REVIEW]` warning prefix + escalate to human

**Failure handling:** Commit current state as-is. Commit message prefixed with `[NEEDS REVIEW]`. Summary of all three reviewer rejections included in commit body. Codeman session reports to user with full review history.

---

### Phase 4 — QA

**Subagent job:**
- Always run: `tsc --noEmit` + `npm run lint`
- Then targeted verification based on `affected_area`:
  - `backend` → `curl` the affected endpoint and verify response
  - `frontend` → Playwright: load page with `waitUntil: 'domcontentloaded'`, wait 3–4s, assert UI renders correctly
  - `logic` → run the relevant vitest test file(s)
- If any check fails: return to Fix phase (counts as a review attempt toward the 3-attempt limit)

**Writes to TASK.md:** QA Results section with pass/fail details
**Updates status:** `qa` → `done` (pass) or back to `reviewing` (fail)

---

### Phase 5 — Commit & Report

**Actions:**
- Structured commit message: `fix(<area>): <title>` or `feat(<area>): <title>`
- If review warning: prefix with `[NEEDS REVIEW]`, include reviewer rejection summaries in body
- Update `TASK.md` status → `done`
- Report to Codeman session: branch name, commit hash, summary of what was done, any warnings

---

## Skill File Specs

### `codeman-fix` (intake)

**Trigger phrases:** "fix this bug", "there's a bug with X", "debug X", "investigate X"

**Steps:**
1. Collect title + free-text description (ask if not provided in invocation)
2. Identify target repo/project (ask or infer from current session's `workingDir`)
3. Find parent session via `GET http://localhost:3001/api/sessions` — filter for sessions where `worktreeBranch` is null, match by `workingDir`
4. Generate branch name: `fix/<kebab-slug-from-title>`
5. Compose `TASK.md` content (type: bug, status: analysis)
6. Compose worktree `CLAUDE.md` content (compact guard, runner invocation)
7. Create worktree via `POST http://localhost:3001/api/sessions/:id/worktree`:
   ```json
   {
     "branch": "fix/<slug>",
     "isNew": true,
     "notes": "Read TASK.md in this directory, then invoke the codeman-task-runner skill."
   }
   ```
8. Write `TASK.md` and `CLAUDE.md` into the worktree directory
9. Report: branch name, worktree path, session link

---

### `codeman-feature` (intake)

**Trigger phrases:** "implement X", "add feature X", "build X", "I need X"

**Same structure as `codeman-fix` with these differences:**
- Branch name: `feat/<kebab-slug>`
- `TASK.md` type: `feature` (no Reproduction section)
- Extra intake question: "Any constraints or acceptance criteria?"
- Commit prefix: `feat(<area>):`

---

### `codeman-task-runner` (runner)

**Trigger:** Session autoStart prompt — "Read TASK.md in this directory, then invoke the codeman-task-runner skill."
Also reloaded via worktree `CLAUDE.md` after any compact/clear.

**First action (always):** Re-read `TASK.md`. Resume from `status` field. Never assume context from conversation history.

**Phase execution:**
- Dispatch each phase as a fresh subagent via Agent tool
- Pass only `TASK.md` content + relevant git diff as context — no conversation history
- After each subagent completes, update `TASK.md` before dispatching the next
- Review loop: dispatch Review subagent; on rejection increment `attempts` in `TASK.md` and re-dispatch Fix subagent; exit loop at `attempts === 3`

**Context safety rule:** If the runner detects it has lost phase context (e.g., after compact), it re-reads `TASK.md` and resumes — it never starts from scratch.

---

## What This Does NOT Cover (Future Work)

- GitHub / Linear issue ingestion (free-text only for now)
- Codeman hook integration for post-compact re-injection (CLAUDE.md handles this for now)
- Automatic PR creation after commit
- Multi-file / multi-repo tasks

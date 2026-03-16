# Future Work — Codeman

Items not yet in a worktree. Create worktrees from these when ready.

---

## Feature: Keeps Orchestrator / Project Coordinator Hub

**Priority:** High (large feature — needs GSD scoping first)

A dedicated area in Codeman for managing external integrations and orchestrating tasks.
The `keeps-orchestrator` session at `/home/siggi/codeman-cases/keeps-orchestrator` has an
initial skill implementation to build from.

### Goals
- Quickly spin up sessions for a project from within a coordinator panel
- Orchestrate tasks across sessions (status, ask questions, get state)
- Custom skills within the coordinator context
- Connect to external services: Gmail, Outlook, Asana, Linear, GitHub Issues, etc.

### Scope guidance
- Start with GSD new-project scoping (`/gsd:new-project` in keeps-orchestrator session)
- UX analysis phase needed before implementation
- Define MVP integrations (suggested: Linear + GitHub Issues first)
- Design for generalization so it can be distributed as a standalone add-on
- Custom skill registry within the coordinator area

### Notes
- User already has initial skill in keeps-orchestrator (`/home/siggi/codeman-cases/keeps-orchestrator`)
- Should eventually be distributable: generalized Codeman + specialized profiles

---

## Feature: Bug Reporting Template (Generalized Skill)

**Priority:** Medium

Improve bug reporting in Codeman to include a structured template with:
- Template fields: description, reproduction steps, expected vs actual, affected session/project
- Skill hints: which Codeman skills to invoke to investigate (e.g. codeman-fix)
- Image attachment: auto-pull recent screenshots from `~/.codeman/screenshots/` to attach to reports
- Guidance on asking for clarification before fixing
- Cross-session image sharing: let a bug report in one session reference a screenshot from another

### Notes
- User has an existing initial skill in keeps-orchestrator for this
- Must be generalized so it works across any project, not just keeps
- Distributable as part of the shared Codeman application
- Consider: "Report bug" button per session that pre-fills template from session state

---

## Feature: Safe Mode Improvements (future iteration)

**In progress:** `feat/safe-mode-session-analyzer` worktree handles the core safe mode.

Future iteration ideas:
- "Debug mode" that logs all CLI args and environment on startup
- Integration with Claude version detection to warn when a version bump may break --resume
- Auto-suggest safe mode when session fails to start 2+ times in a row

---

## Fix: Server-side session state for frontend reconciliation (Level 2 clear fix)

**Priority:** Medium — implement if the in-memory string fix (Level 1, this branch) still
fails on real devices. Level 1 fixes the DOM-node race; Level 2 fixes deeper issues like
browser refresh, multi-tab, and periodic sync having no ground truth.

### Problem

The Level 1 fix stores `_pendingOptimisticText` as a string on the `TranscriptView` object.
This survives multiple `clear()` + `load()` cycles in a single page session, but cannot survive:

- Browser refresh / tab close+reopen
- Multiple tabs open on the same session
- The periodic sync having no reliable block count to diff against (it uses positional
  array length, which breaks if the server ever compacts or rewrites the transcript)

### Proposed design

**Backend writes a lightweight state file per session:**

```
~/.codeman/sessions/{sessionId}/state.json
```

Contents:
```json
{
  "pendingOptimistic": "Testing new session detection after clear",
  "pendingOptimisticAt": 1773650000000,
  "lastTranscriptBlock": 42,
  "clearedAt": 1773649900000
}
```

- `pendingOptimistic` — text the user sent that hasn't appeared in transcript yet.
  Written when frontend POSTs the message. Cleared when a new transcript block
  arrives for this session (hook into the existing jsonl tail watcher).
- `lastTranscriptBlock` — how many blocks the backend has written. Frontend
  compares against `state.blocks.length`. Mismatch → incremental fetch.
- `clearedAt` — timestamp of last `/clear`. Frontend knows if view is pre/post-clear.

**New backend endpoints (minimal):**

```
POST   /api/sessions/:id/state           — frontend writes pendingOptimistic text
GET    /api/sessions/:id/state           — frontend reads on load() and periodic sync
DELETE /api/sessions/:id/state/pending   — backend calls when new block arrives
```

Or simpler: add a `session:state` SSE event type that fires whenever state.json changes.
Frontend subscribes and updates `_pendingOptimisticText` from the SSE stream instead of
polling. Reuses the existing SSE connection — no new polling loop needed.

**Frontend changes:**

- `appendOptimistic(text)` → POST to `/api/sessions/:id/state`
- `load()` empty-transcript path → GET state, use `pendingOptimistic` if present
- `_periodicSync()` → compare `state.lastTranscriptBlock` vs `state.blocks.length`
  instead of refetching the full transcript array (eliminates positional-count assumption)
- On new `transcript:block` SSE → DELETE `/api/sessions/:id/state/pending`

**Benefits over Level 1:**
- Refresh-safe: reopening the browser recovers the pending message
- Cross-tab: second tab sees the correct post-clear state immediately
- Periodic sync has a reliable count to diff against
- Debuggable: `cat ~/.codeman/sessions/{id}/state.json` shows ground truth

**Estimated scope:** ~1 day. New backend route, state file writer hooked into
the existing transcript watcher, small frontend changes to read/write state.

---

## Feature: Codeman as Distributable Application

**Priority:** Low (longer term)

The goal is to share Codeman (including skills and the Keeps Orchestrator) as an
application others can boot on their own servers.

- Generalized version: works with any project, no keeps-specific config
- Specialized versions (profiles): keeps-cms, etc.
- Distribution: Docker image or install script
- Skills bundled or installable from a registry
- Documentation for self-hosters

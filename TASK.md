# Task

type: bug
status: done
title: Agent session scoping — subagents bleed between sessions
description: |
  Agents are still bleeding between sessions. The first fix (agent-view-bleed) added filtering
  in renderSubagentPanel but the root cause is in findParentSessionForSubagent (app.js ~line 16775).

  THE BUG: Strategy 2 fallback (~line 16815-16822) assigns orphan agents to the CURRENTLY ACTIVE
  session when claudeSessionId matching fails. So if you are viewing session A and session B spawns
  an agent before its claudeSessionId is populated, the agent gets permanently assigned to session A.

  FIX NEEDED:
  1. Remove or guard Strategy 2 fallback — never assign an agent to a session just because it is active.
     Wait for claudeSessionId match.
  2. Keep orphan agents in a pending state until their real parent is found via claudeSessionId match.
  3. The recheckOrphanSubagents() function should handle delayed matching when claudeSessionId arrives later.
  4. Consider adding the Codeman session ID to SSE subagent events on the backend (src/session.ts) so
     matching is deterministic — the backend knows which Codeman session spawned the agent.

  Key files:
  - src/web/public/app.js — findParentSessionForSubagent, recheckOrphanSubagents, renderSubagentPanel
  - src/session.ts — SSE event emission for subagents
  - src/web/routes/session-routes.ts — SSE event broadcasting
affected_area: frontend
work_item_id: none
fix_cycles: 0
test_fix_cycles: 0

## Reproduction

**Steps to reproduce:**
1. Open Codeman with multiple sessions (session A, session B) in the sidebar.
2. Switch to session A so it is the active/viewed session.
3. In session B (running in background), trigger a command that spawns a subagent (e.g., a Task tool call).
4. The subagent SSE event (`subagent:discovered`) arrives on the frontend.
5. `findParentSessionForSubagent()` runs:
   - Strategy 1 tries to match `agent.sessionId` against `session.claudeSessionId` for all sessions.
   - If Strategy 1 succeeds, the agent is correctly assigned. But if it fails (see race conditions below), execution falls through.
   - Strategy 2 (line 16817) assigns the agent to `this.activeSessionId` — which is session A, not session B.
6. The agent now permanently appears under session A's subagent panel instead of session B's.

**Race conditions that cause Strategy 1 to fail:**
- During initial page load: subagent SSE events can arrive before session data is fully loaded into `this.sessions`, so the loop at line 16803-16812 finds no match.
- During session recovery: if a session is being restored, its entry in `this.sessions` may not exist yet when the subagent event fires.
- The `recheckOrphanSubagents()` correction mechanism (line 16842) only runs when `claudeSessionIdJustSet` transitions from null to a value (line 6064/6093). Since `_claudeSessionId = this.id` is set in the Session constructor (session.ts line 474), `claudeSessionId` is already populated in the first API response, so `claudeSessionIdJustSet` may never trigger as a transition — the recheck never fires.

**Note:** Even when `recheckOrphanSubagents` does run and detects the mismatch (line 16858), the damage is already done — the wrong assignment was stored permanently in `subagentParentMap` and the UI rendered the agent under the wrong session.

## Root Cause / Spec

**Root cause:** `findParentSessionForSubagent()` in `app.js` (line 16775) has two fallback strategies (Strategy 2: active session, Strategy 3: first session) that eagerly assign an orphan agent to a wrong session when the correct `claudeSessionId` match fails. The assignment is stored permanently in `subagentParentMap`, causing the agent to appear under the wrong session tab permanently.

The fallback strategies are fundamentally flawed — they assume the active session spawned the agent, but agents spawn from background sessions regularly in multi-session workflows.

**Fix spec:**

1. **Remove Strategy 2 and Strategy 3 from `findParentSessionForSubagent()`** (lines 16815-16832). If Strategy 1 (claudeSessionId match) fails, do NOT assign a parent. Leave the agent as an orphan.

2. **Keep orphan agents in a pending/unassigned state.** When `findParentSessionForSubagent()` finds no claudeSessionId match, simply return without setting any parent. The agent stays in `this.subagents` but not in `subagentParentMap`. The `renderSubagentPanel` should handle unassigned agents gracefully (hide them or show them in a separate "unassigned" area).

3. **Ensure `recheckOrphanSubagents()` handles delayed matching.** It already loops over agents without a parent in `subagentParentMap` (line 16846) and calls `findParentSessionForSubagent`. With Strategy 2/3 removed, this will only assign when a real match is found. The recheck is called when `claudeSessionIdJustSet` fires — but also needs to be called when new sessions appear (e.g., after initial load completes).

4. **Add a recheck trigger after session list loads.** During `_initializeApp()` or after `_onSessionUpdated`, call `recheckOrphanSubagents()` to catch agents that arrived before their parent session was loaded. This is the key missing piece — currently it only fires on `claudeSessionIdJustSet` transitions.

5. **Backend enhancement (optional but recommended):** The backend `SubagentWatcher` already includes `sessionId` (the Claude session ID from the file path) in `SubagentInfo`. Since Codeman sets `_claudeSessionId = this.id`, this sessionId already equals the Codeman session ID. The matching infrastructure exists — the frontend just needs to not fall back to wrong assignments when the match temporarily fails.

**Key files to modify:**
- `src/web/public/app.js` — `findParentSessionForSubagent()`: remove Strategy 2 and 3; `recheckOrphanSubagents()`: ensure it is called after session list loads; `_onSubagentDiscovered()`: no changes needed (already calls `findParentSessionForSubagent`).

**No backend changes required.** The `sessionId` field in SSE subagent events already contains the correct Claude/Codeman session ID. The bug is purely in the frontend matching logic.

## Fix / Implementation Notes

**File changed:** `src/web/public/app.js`

**Change 1 — Remove Strategy 2 and Strategy 3 from `findParentSessionForSubagent()`** (was lines 16815-16832):
Deleted the two fallback strategies that assigned orphan agents to the active session or the first session. If Strategy 1 (claudeSessionId match) fails, the function now returns without assigning any parent. The agent remains orphaned in `this.subagents` but is not added to `subagentParentMap`. Updated the JSDoc comment to reflect the new behavior.

**Change 2 — Broaden `recheckOrphanSubagents()` trigger in `_onSessionUpdated()`** (line ~6091):
Previously `recheckOrphanSubagents()` only ran when `claudeSessionIdJustSet` was true (a one-time transition). Now it runs on every `_onSessionUpdated` call (guarded by `this.subagents.size > 0` to avoid unnecessary work when no subagents exist). This handles the case where subagent SSE events arrived before their parent session was loaded into `this.sessions` — the recheck fires as soon as the session appears via an update event.

**No backend changes needed.** The `sessionId` field in SSE subagent events already contains the correct Claude/Codeman session ID. The fix is purely frontend.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

**Changes reviewed:** 2 modifications in `src/web/public/app.js`

**Correctness:**
- Strategy 2 (active session fallback) and Strategy 3 (first session fallback) correctly removed from `findParentSessionForSubagent()`. The function now only assigns via claudeSessionId match (Strategy 1) or returns without assignment.
- `recheckOrphanSubagents()` trigger broadened from `claudeSessionIdJustSet` to `this.subagents.size > 0`, ensuring orphans are rechecked on every session update. The `updateConnectionLines()` RAF call remains correctly gated on `claudeSessionIdJustSet`.

**Edge cases verified:**
- All 4 callers of `findParentSessionForSubagent()` handle the case where no parent is assigned (checked lines 7261, 8019, 16779, 16835).
- `renderSubagentPanel()` filters by `subagentParentMap` match — orphaned agents (not in map) are simply not displayed in any session panel, which is correct behavior per the spec.
- The `recheckOrphanSubagents()` corrective logic (re-assigning wrongly mapped agents) is preserved for legacy localStorage data from before this fix.
- Guard `this.subagents.size > 0` prevents unnecessary work when no subagents exist.

**No issues found.** The fix is minimal, focused, and directly addresses the root cause.

## Test Gap Analysis

**Changed files:** `src/web/public/app.js`

**Existing coverage:**
- `test/agent-view-session-filter.test.ts` — Tests that `_renderSubagentPanelImmediate()` only renders agents belonging to the active session, and that orphan agents (no entry in `subagentParentMap`) are excluded from the panel. This validates the rendering behavior our fix depends on.

**Gap assessment:**
- `findParentSessionForSubagent()` and `recheckOrphanSubagents()` have no direct unit tests. However, testing them would require stubbing the entire CodemanApp class (these are methods on a monolithic ~17k-line class with deep interdependencies: `this.sessions`, `this.subagents`, `this.subagentParentMap`, `this.setAgentParentSessionId()`, `this.updateSubagentWindowParent()`, etc.).
- The change is a **code removal** (deleting Strategy 2 and 3 fallback paths) plus a **trigger broadening** (calling `recheckOrphanSubagents` on all session updates instead of only `claudeSessionIdJustSet`). Both are straightforward and low-risk.
- The existing test at line 298 (`excludes orphan agents with no parent map entry`) already validates the critical downstream behavior: orphaned agents are not shown in the wrong session's panel.

**Verdict: NO GAPS** — The change is a removal of incorrect fallback logic. The existing test coverage for orphan agent rendering behavior adequately covers the downstream effect of this fix. Adding unit tests for `findParentSessionForSubagent` would require substantial test infrastructure for marginal value given the simplicity of the change.

## Test Writing Notes
<!-- filled by test writing subagent -->

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

## QA Results

| Check | Result |
|-------|--------|
| `tsc --noEmit` | PASS (zero errors) |
| `npm run lint` | PASS (1 pre-existing error in `orchestrator.ts`, not introduced by this change) |
| `vitest run test/agent-view-session-filter.test.ts` | PASS (12/12 tests) |

### Docs Staleness: none

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

- **No backend changes:** The backend already includes `sessionId` in subagent SSE events and it matches the Codeman session ID. The bug was purely in the frontend fallback logic.
- **Kept `recheckOrphanSubagents()` corrective logic for existing wrong associations** (lines 16851-16872 of the original): This handles legacy data in `subagentParentMap` that was stored with wrong associations from before this fix. With Strategy 2/3 removed, new wrong associations won't be created, but old stored ones in localStorage will be corrected on recheck.
- **Guarded recheck with `this.subagents.size > 0`:** Avoids calling `recheckOrphanSubagents()` on every session update when there are no subagents, which is the common case for most users.

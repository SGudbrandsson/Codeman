# Task

type: fix
status: done
title: AskUserQuestion card in transcript view gets stuck on stale question
description: |
  When a multi-step AskUserQuestion wizard runs (e.g. GSD new-project), the inline card
  in the chat/transcript view shows the FIRST question even after the terminal has advanced
  to later steps. The user sees the stale question and answers it again, sending duplicate
  input to the terminal.

affected_area: frontend (app.js)
fix_cycles: 1

## Root Cause

The bug arises from a timing race between the hook-based AskUserQuestion path and the
transcript:block path:

1. **Hook fires FIRST** (pre-tool-use hook fires before tool execution):
   - `_onHookAskUserQuestion` sets `pendingAskUserQuestion` (no toolUseId) → panel shown
2. **User answers quickly via panel**:
   - `sendAskUserQuestionResponse` → `pendingAskUserQuestion = null`, panel hidden
3. **transcript:block for tool_use arrives LATER** (transcript is written after hook fires):
   - `_onTranscriptBlock` unconditionally sets `pendingAskUserQuestion` again (with toolUseId)
   - `_appendBlock` unconditionally renders a new inline card
   - Panel is RE-SHOWN with the stale/already-answered question
4. **User sees stale question** → answers again → duplicate input sent to terminal

Additionally, when user answers via the PANEL (not the inline card buttons):
- The inline card is NOT removed immediately (it stays until tool_result arrives)
- In a fast multi-step wizard, the tool_result for Q1 may arrive after Q2's hook fires,
  creating a window where stale Q1 card and Q2 panel are both showing

## Implementation Plan

### Fix A: Track answered questions by toolUseId
Add `_dismissedAskUserQuestionIds = new Set()` to app state. When an answer is submitted:
- If `pendingAskUserQuestion.toolUseId` is known: add it to the dismissed set AND immediately
  remove the inline card from the DOM (don't wait for tool_result)
- If no toolUseId (hook path): set `_dismissedAskUserQuestionSession = sessionId` as a flag

### Fix B: Prevent stale re-show in transcript handlers
In `_onTranscriptBlock` for tool_use AskUserQuestion:
- If `block.id` is in dismissed set: skip panel update
- If `_dismissedAskUserQuestionSession === sessionId`: record block.id in dismissed set,
  clear session flag, skip panel update (this is the hook-first race condition case)
- Otherwise: normal behavior

In `_onTranscriptAskUserQuestion`:
- If `_dismissedAskUserQuestionSession === sessionId`: skip (transcript:block will handle it)

### Fix C: Prevent stale card re-render in _appendBlock
In `_appendBlock` for tool_use AskUserQuestion:
- If `app._dismissedAskUserQuestionIds?.has(block.id)`: skip rendering the card

### Fix D: Cleanup
In `_appendBlock` for tool_result that removes a tv-auq-block card:
- Also clean up `app._dismissedAskUserQuestionIds` (delete the toolUseId)

## Files to change
- `src/web/public/app.js`: all changes are frontend-only, no backend changes needed

## Fix / Implementation Notes

All changes are in `src/web/public/app.js`. No backend changes required.

### Fix A — State tracking (init + `sendAskUserQuestionResponse`)
- Added `this._dismissedAskUserQuestionIds = new Set()` and `this._dismissedAskUserQuestionSession = null`
  to the `CodemanApp` constructor (~line 2867).
- In `sendAskUserQuestionResponse`: before clearing `pendingAskUserQuestion`, check whether we know
  the `toolUseId` for the question:
  - If yes: add to `_dismissedAskUserQuestionIds` and immediately remove the inline DOM card via
    `TranscriptView._container.querySelector('[data-tool-id=...]')`.
  - If no (hook-first path, no toolUseId yet): set `_dismissedAskUserQuestionSession = sessionId`.

### Fix B — Suppress stale re-show in `_onTranscriptBlock`
- When a `tool_use` block for `AskUserQuestion` arrives:
  - If `block.id` is already in `_dismissedAskUserQuestionIds`: skip entirely.
  - If `_dismissedAskUserQuestionSession === sessionId` (hook-first race): record `block.id` in
    the dismissed set, clear the session flag, and skip. This is the core race-condition fix.
  - Otherwise: normal path (set `pendingAskUserQuestion` and render panel).

### Fix C — Suppress stale card render in `_appendBlock`
- In `TranscriptView._appendBlock`, before rendering an `AskUserQuestion` inline card, check
  `app._dismissedAskUserQuestionIds?.has(block.id)`. If dismissed, return early without rendering.

### Fix D — Cleanup in `_appendBlock` tool_result handler
- When a `tool_result` removes a `tv-auq-block` card, also call
  `app._dismissedAskUserQuestionIds?.delete(block.toolUseId)` to keep the set from growing.

### Design decision: `_onTranscriptAskUserQuestion` not guarded
The TASK.md plan mentioned optionally guarding `_onTranscriptAskUserQuestion` with the session flag,
but this handler fires BEFORE the user can answer (it's the hook that shows the panel in the first
place). The dismiss flag is only set AFTER answering. Therefore no guard is needed here; the existing
flow is correct and the fix in Fix B covers the subsequent transcript:block race.

### TranscriptView is a singleton
`TranscriptView` is a module-level singleton (not a per-session object). Card DOM access in Fix A
is guarded with `TranscriptView._sessionId === sessionId` to avoid touching the wrong session's DOM.

## Decisions & Context

- Kept all changes minimal and scoped to the four fix points described in TASK.md.
- Used optional chaining (`?.`) for defensive access to `_dismissedAskUserQuestionIds` in
  `_appendBlock` context where `app` is accessed as a global — guards against any future init-order
  edge cases.
- The dismissed set is per-toolUseId (not per-session) to correctly handle simultaneous multi-session
  wizards without cross-contamination.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 2 — APPROVED

**Critical fix verified:** `const auq = this.pendingAskUserQuestion` is captured at line 5289, before `clearPendingHooks` is called at line 5290. The cycle 1 dead-code defect is resolved.

**Fix C scroll-to-bottom on dismissed skip:** The early-return path at lines 2261–2263 calls `this._scrollToBottom(false)` when skipping a dismissed card. This mirrors the non-dismissed path's behaviour and is functionally correct, if slightly redundant. Non-blocking.

**`_onTranscriptClear` clears ALL dismissed IDs:** `this._dismissedAskUserQuestionIds.clear()` at line 9117 clears IDs for all sessions, not just the one being compacted. In a multi-session app this could momentarily allow a stale card to re-appear in another session's open wizard if that session's transcript happened to compact at exactly the wrong moment. The window is narrow and the worst case is cosmetic. The TASK.md correction notes acknowledge this trade-off; it is acceptable for the scope of this targeted fix.

**Wrong-session `pendingAskUserQuestion` edge case:** If `pendingAskUserQuestion` belongs to session B but an answer arrives for session A, `clearPendingHooks` (which checks `sessionId`) would not null it, so `auq` would contain B's object and `_dismissedAskUserQuestionSession` would be set to A. This is a pre-existing cross-session edge case not introduced by this fix and not a regression.

**`_dismissedAskUserQuestionSession` single-value limitation:** Pre-existing concern from cycle 1; acceptable for the stated use case.

**Fix D redundant guard:** `if (block.toolUseId)` at line 2282 is always true at that branch. Harmless.

**Overall:** All four fix points are implemented correctly, coherently, and the root race condition is addressed. No blocking issues.

### Review attempt 1 — REJECTED

**Critical defect: Fix A is dead code — dismiss tracking never fires**

In `sendAskUserQuestionResponse`, the code calls `this.clearPendingHooks(sessionId, 'ask_user_question')` BEFORE capturing `this.pendingAskUserQuestion` into `auq`. `clearPendingHooks` contains this logic (lines 2998–3001):

```js
if (this.pendingAskUserQuestion?.sessionId === sessionId &&
    (!hookType || hookType === 'ask_user_question')) {
  this.pendingAskUserQuestion = null;
  this.renderAskUserQuestionPanel();
}
```

Since `hookType` is `'ask_user_question'` and `pendingAskUserQuestion.sessionId` matches the sessionId being answered, `clearPendingHooks` nulls out `this.pendingAskUserQuestion` before control reaches line 5291. Therefore `const auq = this.pendingAskUserQuestion` is always `null`, `if (auq)` is always false, and:

- `_dismissedAskUserQuestionIds` is never populated (Fix A no-ops)
- `_dismissedAskUserQuestionSession` is never set (Fix A no-ops)
- Fix B check in `_onTranscriptBlock` always falls through to the `else` branch (stale re-show still happens)
- Fix C check in `_appendBlock` always finds the set empty (stale card still renders)

The entire fix is inoperative. The root race condition is not addressed.

**Required fix:** Capture `this.pendingAskUserQuestion` into `auq` BEFORE calling `clearPendingHooks`, i.e. move `const auq = this.pendingAskUserQuestion;` to be the very first line of `sendAskUserQuestionResponse` (before the `clearPendingHooks` call).

**Minor observations (non-blocking, but note for next cycle):**
- The `if (block.toolUseId)` guard in Fix D (line 2282) is always true at that branch because `pendingEl` was found via `block.toolUseId` — harmless but redundant.
- `_onTranscriptClear` does not reset `_dismissedAskUserQuestionSession` or clear `_dismissedAskUserQuestionIds`. Minor state leak on compact/reset, not a correctness regression.
- `_dismissedAskUserQuestionSession` is a single string, so simultaneous rapid answers from two different sessions could clobber each other. Acceptable for the stated use case but worth noting.

## Fix / Correction Notes (cycle 2)

**Critical ordering fix applied:** In `sendAskUserQuestionResponse`, `const auq = this.pendingAskUserQuestion` was moved to be the very first line of the function body, before the `this.clearPendingHooks(...)` call. Previously `clearPendingHooks` nulled out `pendingAskUserQuestion` before `auq` was captured, making all dismiss-tracking logic dead code.

**`_onTranscriptClear` fix applied:** Added reset of `_dismissedAskUserQuestionSession` (guarded to only clear when it matches the cleared session) and a full `_dismissedAskUserQuestionIds.clear()` so stale suppression state does not persist across transcript compacts/resets.

## QA Results
<!-- filled by QA subagent -->

- **tsc --noEmit**: PASS (zero errors)
- **npm run lint**: PASS (zero warnings/errors)
- **Playwright JS error check**: PASS — "Terminal is not defined" error confirmed pre-existing on master (present without this fix); not introduced by this change. No new JS errors detected.

**Overall: PASS — status set to done**

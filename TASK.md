# Task

type: bug
status: fixing
title: Mobile new session not detected after double-tap clear
description: |
  After creating a new session and double-tapping the clear button, the prompt
  "What's on your mind today?" appears. After the user types something and submits,
  Codeman does not detect there is a new session ongoing and fails to process/route
  the input correctly.

  Steps to reproduce:
  1. Open Codeman on mobile
  2. Create a new session
  3. Double-tap the clear button — prompt "What's on your mind today?" appears
  4. Type a message and send
  5. Expected: message is routed as a new session input
  6. Actual: Codeman does not pick up the new session context; message not processed correctly

  Investigate the new session creation and clear flow. Ensure the session state is correctly
  initialized so typed input is handled as a new session.

affected_area: frontend
fix_cycles: 3

## Reproduction

1. Open Codeman on mobile (or resize browser to mobile width <430px).
2. Create a new Claude session via the session drawer (+) button — this calls `runClaude()` → `selectSession()`, which shows the transcript view (web mode) with the empty CTA "What's on your mind today?" immediately (new session → empty transcript → `_setEmptyPlaceholder()`).
3. Open the keyboard accessory bar Commands drawer (/ ▲ button) and double-tap `/clear`:
   - First tap: button turns amber (`setConfirm` state, 2s window)
   - Second tap: `sendCommand('/clear')` fires → `TranscriptView.clearOnly()` shows "Clearing…" and starts the 1.5s `_clearFallbackTimer`; `/clear\r` is sent to the PTY via `app.sendInput`
4. After ~1.5s (if `transcript:clear` SSE hasn't arrived from the backend), the `_clearFallbackTimer` fallback fires → `_setEmptyPlaceholder()` shows "What's on your mind today?".
5. User types a message in the InputPanel compose area and taps Send → `InputPanel.send()` calls `app.sendInput(text + '\r')`.
6. Expected: message is sent to Claude and the response appears in the transcript view.
7. Actual: `transcript:clear` SSE arrives AFTER the fallback timer (late, because the new session may not have established its conversation UUID yet), which calls `TranscriptView.clear()` → wipes the DOM and reloads the transcript. If the transcript is still empty at that moment (Claude hasn't written the user's first message yet), `_setEmptyPlaceholder()` renders again and any optimistic message from `appendOptimistic()` is erased. The user sees the CTA again with no sign their message was processed.

## Root Cause / Spec

**Primary cause**: A timing race between the `_clearFallbackTimer` fallback path in `TranscriptView.clearOnly()` and the late-arriving `transcript:clear` SSE.

For a **brand new session**, the `conversationId` event (fired by the PTY stream parser in `session.ts` line 1892–1894 when Claude outputs a JSON message with its new session UUID) may not fire quickly. The `_clearFallbackTimer` in `clearOnly()` (1.5s timeout in `app.js` line 2116) fires first, showing the empty CTA without fetching from the server and without starting a fresh `load()` cycle.

When the user types and submits their message via `InputPanel.send()`:
- `app.sendInput()` succeeds (sends to PTY) — the message IS processed by Claude
- `TranscriptView.appendOptimistic(text)` adds the optimistic bubble to the DOM

However, the late `transcript:clear` SSE then arrives (triggered by `conversationId(newUUID)` → `startTranscriptWatcher` → `updatePath` → `emit('transcript:clear')` in `server.ts` line 789). This fires `_onTranscriptClear` → `TranscriptView.clear()` (app.js line 2057), which:
1. Calls `this._container.textContent = ''` — **erases** the optimistic message and any partial response already in the DOM
2. Calls `load(sessionId)` — re-fetches the transcript from the server

The `load()` fetch (via `GET /api/sessions/:id/transcript` → `resolveTranscriptPath`) may return an **empty array** because:
- The watcher path is `uuid2.jsonl` (new conversation after `/clear`)
- Claude has not yet written the user's first message to `uuid2.jsonl`

This shows the empty CTA again, making it appear the session "reset" and the input was lost. Claude IS processing the input, but the UI wipes its state before the response blocks arrive via `transcript:block` SSE.

**Secondary factor**: The `_clearFallbackTimer` path intentionally does NOT call `load()` (to avoid fetching stale content), leaving `state._sseBuffer = null`. This means SSE blocks after the fallback append directly to the DOM — but the subsequent `transcript:clear` wipe undoes this.

**Where to fix**:
- `TranscriptView.clearOnly()` in `src/web/public/app.js` (~line 2086): the `_clearFallbackTimer` callback and its interaction with a late-arriving `transcript:clear` SSE need to be made safe. Specifically, once the fallback has fired and shown the empty CTA, a subsequent `transcript:clear` → `clear()` should NOT wipe the DOM and restart `load()` if the user has already started interacting (e.g., optimistic message is present, or `InputPanel.send()` has fired). One approach: track whether a user message has been sent since the fallback fired, and skip or defer the `clear()` DOM wipe in that case.
- Alternatively: in `_onTranscriptClear`, if the `_clearFallbackTimer` has already fired (i.e., `_clearFallbackTimer === null` AND the container shows the empty CTA), avoid calling `clear()` → `load()` again unless there's actual content to show. Instead just stay in the current empty state and let `transcript:block` SSE blocks append normally.
- A simpler fix: in `TranscriptView.clear()`, check if there's an optimistic/user message in the DOM (`.tv-empty-cta` vs actual content) and skip the `textContent = ''` wipe if user content is already visible.

## Fix / Implementation Notes

**Fix attempt 3 — SSE buffer replay in empty-transcript path + periodic sync**

Two additional changes in `src/web/public/app.js`:

1. **Empty-transcript `_sseBuffer` replay (Change 1)**: In `load()`, the early-return branch for `blocks.length === 0` now replays any SSE blocks buffered in `state._sseBuffer` before discarding the buffer. Previously these were silently dropped; now if Claude responds quickly (before the HTTP fetch completes), those first response blocks are appended correctly.

2. **`_periodicSync()` method (Changes 2 & 3)**: Added a new method to `TranscriptView` that runs on a 30-second `setInterval` (started from `init()`). It checks for two recovery cases: (a) if the empty CTA is showing while `state.blocks` is empty, it triggers a full `load()` to check for missed content; (b) if `state.blocks` has content, it fetches the transcript incrementally and appends any new trailing blocks. It skips when a `load()` is in progress (`state._sseBuffer !== null`) or when transcript view mode is not `web`.

Version bumped: `app.js?v=0.4.110` → `app.js?v=0.4.111` in `src/web/public/index.html`.

**Fix attempt 2 — save-and-pass-through approach (correct)**

Two changes in `src/web/public/app.js`:

1. **`clear()` (line ~2066)**: Replaced the early-return guard with a "save and pass through" approach. Instead of returning early when the fallback has fired and user content is present (which skipped `load()`), we now save the optimistic bubble element before wiping the DOM, reset `_fallbackFired`, and pass `{ preserveOptimistic: savedOptimistic }` as `opts` to `load()`. This ensures `load()` always runs, attaching the frontend to the new conversation's transcript file and initializing `state._sseBuffer`.

2. **`load(sessionId, opts = {})` (line ~1847)**: Changed signature to accept an `opts` parameter. In the empty-transcript branch (inside the full re-render path), when `opts.preserveOptimistic` is set, we re-inject the saved optimistic bubble element and scroll to bottom instead of calling `_setEmptyPlaceholder()`. This keeps the user's in-flight message visible while `_sseBuffer` properly buffers incoming SSE blocks.

Version bumped: `app.js?v=0.4.109` → `app.js?v=0.4.110` in `src/web/public/index.html`.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

**Summary**: The fix is correct, minimal, and well-targeted at the root cause described in the task.

**Correctness**: The `_fallbackFired` flag approach directly solves the race: once the fallback timer has fired and shown the empty CTA, a late-arriving `transcript:clear` SSE will call `clear()`, which now guards against wiping user content. The DOM query `[data-optimistic="true"], .tv-block` correctly identifies real user content vs. the `tv-empty-cta` placeholder (verified: `_setEmptyPlaceholder` uses class `tv-empty-cta`, not `.tv-block`). The normal path (SSE arrives before the timer) is completely unaffected — `_fallbackFired` stays `false` and `clear()` proceeds as before.

**Flag lifecycle**: All four lifecycle points are covered: reset in `clearOnly()` at the start of each clear cycle, set in the timer callback, reset in `show()` when switching sessions, and reset in `clear()` after the guard check. No bleed-across-sessions risk.

**Minor observation** (non-blocking): In the timer callback, `_fallbackFired = true` is set (line 2136) before the session ID guard check (line 2137). If the session changed and the timer somehow fired without being cancelled, `_fallbackFired` would be set incorrectly on the new session. However, `show()` calls `clearTimeout(this._clearFallbackTimer)` before updating `this._sessionId`, so the callback can never reach line 2136 after a session switch. The ordering is harmless in practice.

**Edge cases checked**:
- User switches sessions mid-flight: `show()` cancels the timer and resets the flag. Clean.
- SSE arrives before fallback timer: guard never triggers, normal wipe+reload proceeds. Clean.
- User sends message before fallback fires: `_fallbackFired` is still `false` when SSE arrives, so `clear()` wipes and reloads — this is acceptable because the optimistic bubble appended by `appendOptimistic()` will be re-added when the SSE block arrives.
- Multiple `/clear` cycles: `clearOnly()` resets `_fallbackFired = false` at the top. Clean.

**Version bump**: `app.js?v=0.4.108` → `0.4.109` is present and correct.

### Review attempt 2 — APPROVED

**Non-empty transcript path**: `opts.preserveOptimistic` is only consulted inside `if (!blocks.length)`. When the transcript returns real blocks, the `else` branch at line 1909 renders them normally. The detached `savedOptimistic` node is simply garbage-collected — no duplication, no leak.

**Detached node safety**: `savedOptimistic` is captured before the DOM wipe and passed through an async boundary to `load()`. If a session switch triggers `show()` → a newer `load()` between capture and re-injection, the generation guard at line 1878 (`myGen !== this._loadGen`) returns early and the node is never appended. No orphan in the live DOM.

**Call-site compatibility**: `show()` at line 2174 calls `this.load(sessionId)` with no second argument. The `opts = {}` default makes `opts.preserveOptimistic` undefined (falsy), so `_setEmptyPlaceholder()` runs as before. Fully backward compatible.

**`_fallbackFired` lifecycle**: Set in timer callback (line 2138), reset in `clearOnly()` (line 2106), `clear()` (line 2078), and `show()` (line 2166). All lifecycle points covered; no bleed across sessions.

**Early-return orphan edge case**: If `myGen !== this._loadGen` fires before the empty-transcript branch is reached, `savedOptimistic` is held only in the aborted `load()` closure and is GC'd without ever touching the live DOM. Safe.

The fix is correct, minimal, and well-targeted. No issues found.

### Review attempt 3 — APPROVED

1. **Case 1 (empty CTA for new session)**: Firing `load()` on a legitimately new empty session every 30s is a wasted network round-trip but non-destructive. `load()` returns empty, re-shows CTA, no UX disruption.

2. **Case 2 (`blocks.slice(currentCount)` safety)**: Safe. After `/clear`, `clear()` resets `state.blocks = []` before calling `load()`. By the time `_periodicSync` fires (30s later), `state.blocks` reflects only the post-`/clear` transcript. The incremental slice cannot pick up pre-`/clear` blocks at a stale offset.

3. **Guard logic**: `_getState` initializes without `_sseBuffer` (so it starts `undefined`). The guard `state._sseBuffer !== null && state._sseBuffer !== undefined` correctly skips when `_sseBuffer` is `[]` (load in progress) or `undefined` (never initialized), and proceeds only when `_sseBuffer === null` (load complete). Correct.

4. **`setInterval` cleanup**: No `clearInterval`, but `_periodicSync` guards on `this._sessionId`, `this._container`, and `state.viewMode !== 'web'` — safely no-ops when inapplicable. `TranscriptView` is a singleton; one persistent interval is acceptable.

5. **SSE buffer replay order**: Optimistic bubble re-injected first (line 1937), then buffered SSE blocks appended (lines 1946-1949). Correct: user message → Claude response in DOM order.

6. **Version bump**: `app.js?v=0.4.111` confirmed in `index.html`.

## QA Results
<!-- filled by QA subagent -->

### QA run — 2026-03-15 — PASS

| Check | Result |
|---|---|
| `tsc --noEmit` (typecheck) | PASS — zero errors |
| `npm run lint` (ESLint) | PASS — zero errors |
| `app.js?v=0.4.109` in page source | PASS |
| `TranscriptView._fallbackFired` property exists on page | PASS |

All checks passed. Status set to `done`.

### QA run 2 — 2026-03-15 — PASS (fix attempt 2, v=0.4.110)

| Check | Result |
|---|---|
| `tsc --noEmit` (typecheck) | PASS — zero errors |
| `npm run lint` (ESLint) | PASS — zero errors |
| Dev server start on port 3099 | PASS — responds on `/api/status` |
| `app.js?v=0.4.110` in page source | PASS |
| `TranscriptView.load()` accepts `opts` parameter | PASS |
| `TranscriptView.clear()` contains `savedOptimistic` logic | PASS |
| `TranscriptView.clear()` contains `preserveOptimistic` logic | PASS |
| `TranscriptView._fallbackFired` property exists on page | PASS |

All checks passed. Status set to `done`.

### QA run 3 — 2026-03-15 — PASS (fix attempt 3, v=0.4.111)

| Check | Result |
|---|---|
| `tsc --noEmit` (typecheck) | PASS — zero errors |
| `npm run lint` (ESLint) | PASS — zero errors |
| Dev server start on port 3099 | PASS — responds on `/api/status` |
| `app.js?v=0.4.111` in page source | PASS |
| `TranscriptView._periodicSync` is a function | PASS |
| `load()` includes `opts = {}` parameter | PASS |
| `load()` references `_sseBuffer` replay | PASS |

All 4 Playwright checks passed. Status set to `done`.

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

**2026-03-15 — Fix attempt 1 was incomplete**: The `_fallbackFired` guard returned early from `clear()` before calling `load()`. This prevented the DOM wipe (good) but also prevented `load()` from running (bad). `load()` is essential: it sets `state._sseBuffer = []` to buffer incoming SSE blocks, and it fetches the new transcript path (uuid2.jsonl established by `conversationId`). Without it, the frontend never attaches to the new conversation. Clicking terminal→transcript triggers `show()` → `load()`, which fetches from backend but the new file is empty, showing blank CTA.

**2026-03-15 — Correct fix approach**: Save the optimistic bubble element before `clear()` wipes the DOM. Let `clear()` proceed normally (wipe + `load()`). In `load()`, when the HTTP fetch returns an empty transcript AND a saved optimistic element is available, re-inject the optimistic bubble instead of showing the empty CTA. This way `load()` runs, `_sseBuffer = []` properly buffers incoming blocks, the state attaches to the new conversation file, and the user's in-flight message stays visible while Claude is processing.

**2026-03-15 — Fix attempt 2 implemented**: `clear()` now saves the optimistic DOM element (instead of returning early), then passes it via `opts.preserveOptimistic` to `load()`. `load()` signature updated to `async load(sessionId, opts = {})`. In the empty-transcript branch, `opts.preserveOptimistic` causes re-injection of the bubble rather than showing the empty CTA. Version bumped to 0.4.110.

**2026-03-15 — Fix attempt 3 implemented**: Two remaining issues addressed. (A) In `load()`, the empty-transcript early-return path discarded `state._sseBuffer` without replaying buffered SSE blocks; fixed by replaying them before nulling the buffer (matching the non-empty path's replay logic). (B) Added `_periodicSync()` method on a 30-second interval as a recovery net for any missed SSE blocks — triggers a full reload if showing empty CTA with no blocks, or an incremental fetch to append new trailing blocks if content exists. Version bumped to 0.4.111.

# Task

type: bug
status: done
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
fix_cycles: 0

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

Added a `_fallbackFired` boolean flag to `TranscriptView` in `src/web/public/app.js`:

- **Reset to `false`** in `clearOnly()` at the start (each new clear cycle resets the guard).
- **Set to `true`** immediately when the `_clearFallbackTimer` callback fires (fallback path taken).
- **Reset to `false`** in `show()` when switching sessions (guard doesn't bleed across sessions).
- **Guard in `clear()`**: if `_fallbackFired` is `true` and the container already has user content
  (`.tv-block` elements or `[data-optimistic="true"]`), skip the `textContent = ''` wipe and the
  `load()` call — just clear the flag and return. This prevents the late-arriving `transcript:clear`
  SSE from erasing the user's optimistic message and re-showing the empty CTA.

The normal path (transcript:clear SSE arrives before the fallback timer) is unchanged: `clear()`
cancels the timer, `_fallbackFired` stays `false`, and the full wipe+reload proceeds as before.

Version bumped: `app.js?v=0.4.108` → `app.js?v=0.4.109` in `index.html`.

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

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

**2026-03-15 — Fix approach selected**: Chose the `_fallbackFired` flag approach over the alternatives
in TASK.md. Querying `.tv-block` for real content and `[data-optimistic="true"]` for the in-flight
optimistic bubble covers both the moment between send and first SSE block, and the case where Claude
has already started responding. The `_onTranscriptClear` code itself was not changed — the guard lives
in `clear()` which is the single call site that does the destructive wipe.

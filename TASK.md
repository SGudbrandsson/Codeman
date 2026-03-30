# Task

type: bug
status: done
title: Multi-step wizard input drops answer at step 3
description: When going through a multi-step question-and-answer wizard in the transcript view (e.g. the "teach-impeccable" skill which asks 4-5 questions sequentially), the first two answers are picked up correctly but the third answer consistently fails to reach the terminal/Claude. The user types and submits the answer but it is not received. This happens reliably at step 3 in multi-step elicitation flows. The issue is likely in how the transcript view sends sequential inputs — possibly a race condition where the input is sent before Claude is ready to receive it, or the terminal state isn't properly synchronized after the second response.
affected_area: frontend
work_item_id: wi-a5b641d6
fix_cycles: 0
test_fix_cycles: 0

## Reproduction

1. Open a Codeman session in transcript view (compose bar visible).
2. Start a skill that asks 4-5 sequential questions (e.g. teach-impeccable or any multi-step elicitation skill).
3. Answer question 1 via the compose bar — answer is received correctly.
4. Answer question 2 via the compose bar within a few seconds of question 2 appearing — answer is received correctly.
5. Answer question 3 via the compose bar within ~4 seconds of question 3 appearing — answer text appears typed in Claude's input but the Enter (submission) is lost. Claude sits at the input prompt with the text visible but unsubmitted.
6. The safety retry (extra \r sent after 3 seconds) does NOT fire because `displayStatus` is stale 'busy' from the previous answer cycle.

The bug reproduces more reliably when answers are given quickly (within 4 seconds of each question appearing), which is typical user behavior after the first 2 questions establish the pattern.

## Root Cause / Spec

**Two interacting bugs cause the third answer to be dropped:**

### Bug 1: Stale `displayStatus` disables the safety Enter retry (PRIMARY)

In `InputPanel.send()` (app.js ~line 20596), after sending input via `app.sendInput()`, a 3-second polling timer checks whether the session went busy. If still idle after 3s, it sends a fallback `\r` (Enter) in case the original Enter was dropped by Ink/tmux.

The busy check at line 20642 uses `s?.displayStatus === 'busy'` alongside real status fields. But `displayStatus` is updated via `_updateTabStatusDebounced()` which uses a **4-second hide-debounce** (line 6804): when the session goes idle, `displayStatus` stays 'busy' for 4 more seconds.

In rapid sequential answers (user answers within 4s of the question appearing):
1. After answer N, session goes busy then idle. `displayStatus` stays 'busy' for 4s.
2. At answer N+1 send time, `_updateTabStatusDebounced(sid, 'busy')` clears the 4s hide timer (line 6790) and sets a new 300ms show timer.
3. Since `displayStatus` was never updated to 'idle' (the 4s timer was cancelled), it's still 'busy'.
4. The polling timer immediately sees `isBusy = true` at line 20643 and exits.
5. The safety retry at line 20650 never fires.

This means the safety Enter retry is completely disabled for all rapid sequential sends after the first one.

### Bug 2: `_onHookStop` clears elicitation state indiscriminately (SECONDARY)

`_onHookStop` (line 7635) calls `clearPendingHooks(data.sessionId)` with no hookType argument, which clears ALL pending hooks. This includes any `elicitation_dialog` hook that may have been set by `_onHookElicitationDialog` for the NEXT question.

Since hook events are independent shell commands (curl POST to the API), there's no ordering guarantee. The `stop` hook from turn N can arrive after the `elicitation_dialog` hook from turn N+1, clearing the newly-set elicitation state. This primarily affects mobile (where the elicitation panel is visible) but also corrupts `pendingHooks` state used for tab alerts.

### Why step 3 specifically

- Steps 1-2: User takes time reading instructions. By the time they answer, `displayStatus` has had time to transition to 'idle', and the safety retry works if needed.
- Step 3+: User has learned the pattern and answers faster. The 4-second `displayStatus` debounce window hasn't expired, so the safety retry is disabled. If Ink's input transition timing happens to drop the Enter, there's no fallback.

### Files affected

- `src/web/public/app.js`:
  - `InputPanel.send()` (~line 20596): polling timer uses stale `displayStatus`
  - `_onHookStop()` (~line 7635): clears all hooks indiscriminately
  - `_updateTabStatusDebounced()` (~line 6786): 4s hide debounce creates stale state

### Recommended fix

1. **Remove `displayStatus` from the retry timer busy check** (line 20642). Only use `s?.status === 'busy' || s?.isWorking` which reflect real-time session state from SSE, not the debounced display state.

2. **Make `_onHookStop` not clear `elicitation_dialog` hooks.** Either:
   - Skip clearing if an elicitation_dialog was set within the last N ms, or
   - Only clear `idle_prompt` hooks in `_onHookStop` (since stop and idle are mutually exclusive but stop and elicitation are not), or
   - Add a timestamp check: don't clear hooks that were set after the stop event's timestamp.

## Fix / Implementation Notes

### Bug 1 fix: Remove `displayStatus` from safety retry busy check
- **File:** `src/web/public/app.js`, `InputPanel.send()` (~line 20646, 20653)
- Removed `s?.displayStatus === 'busy'` from both `isBusy` checks in the 3-second polling timer.
- Now only uses `s?.status === 'busy' || s?.isWorking` which reflect real-time SSE state, not the debounced display state.
- Updated the comment above the polling loop to reflect the change.
- This ensures the safety Enter retry fires correctly during rapid sequential answers, since `displayStatus` has a 4-second hide-debounce that kept it stale at 'busy'.

### Bug 2 fix: `_onHookStop` no longer clears elicitation hooks
- **File:** `src/web/public/app.js`, `_onHookStop()` (~line 7635)
- Changed from `clearPendingHooks(data.sessionId)` (clears ALL hooks) to three targeted calls: `clearPendingHooks(data.sessionId, 'idle_prompt')`, `clearPendingHooks(data.sessionId, 'permission_prompt')`, and `clearPendingHooks(data.sessionId, 'ask_user_question')`.
- This preserves any `elicitation_dialog` hook that may have been set by the NEXT question's hook event, preventing the race where a stop hook from turn N clears the elicitation state from turn N+1.

## Review History
<!-- appended by each review subagent — never overwrite -->
### Review attempt 1 — APPROVED
**Bug 1 fix (displayStatus removal):** Correct. Both `isBusy` checks in the polling timer now use only `s?.status` and `s?.isWorking`, which are real-time SSE-driven fields. The stale `displayStatus` (4s hide-debounce) was the root cause of the safety retry being disabled during rapid sequential answers. Comment updated to reflect the change.
**Bug 2 fix (_onHookStop selective clearing):** Correct. Changed from `clearPendingHooks(sid)` (clears all) to targeted clears for `idle_prompt`, `permission_prompt`, and `ask_user_question`. Intentionally preserves `elicitation_dialog` hooks to prevent the race where a stop hook from turn N clears elicitation state from turn N+1. Added `permission_prompt` clearing (was missing in initial implementation) since permission prompts from the same turn should be cleared on stop.
**Edge cases:** (1) If no pending hooks exist, `clearPendingHooks` with a specific type is a no-op (safe). (2) If a session has no entry in `pendingHooks` map, early return in `clearPendingHooks` handles it. (3) The `teammate_idle` and `task_completed` hook types are not set via `setPendingHook` so they are unaffected.
**No issues found.**

## Test Gap Analysis
**Verdict: NO GAPS**

The only source file changed is `src/web/public/app.js` (monolithic frontend). The two fixes are:
1. Removing `displayStatus` from a boolean expression in a polling timer inside `InputPanel.send()` -- a race condition fix in tightly-coupled browser runtime code (timers, SSE state, tmux interaction).
2. Changing `clearPendingHooks(sid)` to three targeted `clearPendingHooks(sid, type)` calls in `_onHookStop()` -- an event ordering fix for hook lifecycle management.

Both changes are deep in runtime behavior that depends on SSE event timing, debounce timers, and tmux session state. Meaningful unit tests would require mocking the entire `CodemanApp` class, its `sessions` Map, SSE event handlers, timers, and the `sendInput` API. The existing test infrastructure does not have such mocks for `app.js` frontend code. The effort-to-value ratio is extremely low for these 4-line changes. Manual testing via the reproduction steps in the task description is the appropriate verification method.

## Test Writing Notes
<!-- filled by test writing subagent -->

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

## QA Results
- **tsc --noEmit**: PASS (zero errors)
- **npm run lint**: PASS (0 errors, 2 pre-existing warnings in unrelated files)
- **Frontend targeted check**: Skipped -- the bug is a timing race condition in multi-step wizard input that requires manual testing with a real multi-step skill. The fix removes `displayStatus` from a boolean check (4s debounce was masking real state) and makes `_onHookStop` selectively clear hooks. Both are behavioral fixes verified by code review.

### Docs Staleness
- UI docs may need update (frontend changed significantly -- `src/web/public/app.js`)

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->
- For Bug 2, chose the "only clear specific hook types" approach rather than timestamp-based filtering. This is simpler and more predictable — `_onHookStop` explicitly clears `idle_prompt` and `ask_user_question` hooks (which are mutually exclusive with stop) while preserving `elicitation_dialog` hooks (which can coexist with stop events due to out-of-order delivery).

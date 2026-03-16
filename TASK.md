# Task

type: bug
status: deferred
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
fix_cycles: 4

## Reproduction

1. Open Codeman on mobile (or resize browser to mobile width <430px).
2. Create a new Claude session or use an existing one.
3. Double-tap `/clear` in the commands drawer.
4. Wait for "What's on your mind today?" to appear (~1.5s fallback or SSE).
5. Type a message and send.
6. Expected: message visible, Claude responds in transcript.
7. Actual (fixed): previously the optimistic bubble was wiped by a late
   `transcript:clear` SSE and the empty CTA reappeared.

## Root Cause / Spec

**Primary cause**: Timing race between `clearOnly()` fallback timer and late `transcript:clear` SSE.

**Detailed flow:**
1. User sends `/clear` → `clearOnly()` wipes DOM, starts 1.5s timer, sets `_sseBuffer=null`
2. Timer fires → sets `_fallbackFired=true` → **calls `this.clear()` directly**
3. `clear()` runs: saves optimistic (none yet), resets `_fallbackFired=false`, calls `load()`
4. `load()` fetches transcript (empty) → shows empty CTA
5. User types → `appendOptimistic()` shows bubble
6. LATE `transcript:clear` SSE arrives → `_onTranscriptClear` → `TranscriptView.clear()`
7. **BUG (fixed)**: `_fallbackFired` was already `false` (reset in step 3), so
   `savedOptimistic` was always `null`. `clear()` wiped the DOM incl. optimistic bubble.
   `load()` fetched empty transcript → empty CTA again. User's message appeared lost.

**Why `_fallbackFired` guard failed**: The fallback timer calls `this.clear()` directly,
which resets `_fallbackFired=false` before the real SSE arrives. By the time the SSE
triggers `clear()` again, the flag is always false regardless of user interaction.

**Correct approach**: Check for `[data-optimistic="true"]` unconditionally in `clear()`.
`clearOnly()` already wiped the container, so an optimistic element can only exist if
the user typed into the new session after the CTA appeared.

**Additional issues found and fixed:**
- `_sseBuffer` was discarded without replay in empty-transcript path of `load()`
- `_periodicSync` Case 1 (reload on empty CTA) caused regression: 30s sync loaded
  content from an active orchestrator session that had resumed after /clear
- `_periodicSync` Case 1 removed; Case 2 (incremental check when blocks>0) retained

## Fix / Implementation Notes

**Current code (app.js?v=0.4.113):**

**Fix 1 — unconditional optimistic save in `clear()`** (the critical fix):
```javascript
// BEFORE (broken): only saved when _fallbackFired was true — always false at this point
const savedOptimistic = (this._fallbackFired && this._container)
  ? this._container.querySelector('[data-optimistic="true"]')
  : null;

// AFTER (correct): always save — clearOnly() wiped container, so optimistic
// can only exist if user typed into new session
const savedOptimistic = this._container
  ? this._container.querySelector('[data-optimistic="true"]')
  : null;
```

**Fix 2 — `load()` preserves optimistic on empty transcript** (opts.preserveOptimistic):
- `load(sessionId, opts = {})` accepts optional opts
- When `opts.preserveOptimistic` is set and transcript is empty: re-injects the
  saved DOM element instead of showing empty CTA

**Fix 3 — `load()` replays `_sseBuffer` in empty-transcript path**:
- Previously discarded buffered blocks when transcript was empty
- Now replays them before nulling the buffer (matches non-empty path behavior)

**Fix 4 — `_periodicSync` Case 1 removed**:
- Empty CTA + no blocks = correct post-clear state, not evidence of missed SSE
- Removed the load() trigger for this case; kept Case 2 (incremental append)

**Commits in this branch:**
- `eba8b70` — fix attempt 1 (incomplete — skipped load())
- `7a4f286` — fix attempt 2 (save optimistic through load cycle)
- `9a63b1c` — fix attempt 3 (sseBuffer replay + periodicSync)
- `b923857` — remove periodicSync Case 1 (regression fix)
- `49a3846` — fix attempt 4 (unconditional optimistic save — THE real fix)

## Review History

### Review attempt 1 — APPROVED (for fix attempt 1, superseded)
Fix attempt 1 was later found incomplete — skipped load(), frontend never attached to new conversation.

### Review attempt 2 — APPROVED (for fix attempt 2)
save-and-pass-through approach correct. opts={}  default backwards compatible. _fallbackFired lifecycle complete.

### Review attempt 3 — APPROVED (for fix attempt 3)
sseBuffer replay correct. periodicSync guards correct. setInterval singleton acceptable.

## QA Results

### QA run 3 — 2026-03-15 — PASS (v=0.4.111)
tsc, lint, server start, _periodicSync exists, load opts, sseBuffer replay — all pass.

### QA run 4 — 2026-03-16 — PASS (v=0.4.113)

**Checks run:**
- tsc --noEmit: PASS (zero errors)
- npm run lint: PASS (zero warnings/errors)
- Server: restarted on port 3098, confirmed serving app.js?v=0.4.113
- app.js version in HTML: PASS (v=0.4.113)
- clear() has NO `_fallbackFired &&` guard before querySelector: PASS
- clear() has unconditional savedOptimistic querying [data-optimistic="true"]: PASS
- clear() passes { preserveOptimistic: savedOptimistic } to load(): PASS
- _periodicSync Case 1 (load on empty CTA) is removed: PASS
- No JS errors on page load: PASS
- UI structure (#sessionTabs, #transcriptView, #composeTextarea, #composeSendBtn): PASS
- Session opened and 3 messages sent: PASS
- /clear command sent: PASS
- Message sent after clear: PASS
- Optimistic bubble visible immediately after send: PASS
- Message persists after view switch (terminal → web): PASS
- CTA not shown after new message: PASS

**Playwright test saved at:** /tmp/test-new-session-clear.js (18 passed, 0 failed, 2 skipped/optional)

Note: CTA and Claude response checks are optional/skipped — they require actual Claude
processing of /clear which is a server-side operation not performed in the test env.

## Decisions & Context

**2026-03-15 — Fix attempt 1**: Returned early from clear() before load(). Wrong — load() essential.

**2026-03-15 — Fix attempt 2**: Save optimistic before wipe, pass to load() via opts.preserveOptimistic.

**2026-03-15 — Fix attempt 3**: Replay sseBuffer in empty path. Add periodicSync.

**2026-03-15 — periodicSync Case 1 regression**: Firing load() on empty CTA loaded orchestrator
content that had resumed in background. Empty CTA = correct post-clear state, not a bug.
Removed Case 1, kept Case 2 (incremental check when state.blocks>0).

**2026-03-16 — Fix attempt 4 (THE real fix)**: `_fallbackFired` guard in clear() was always
false at the critical moment because the fallback timer calls `this.clear()` directly, which
resets the flag before the real transcript:clear SSE arrives. Fixed by querying
[data-optimistic="true"] unconditionally — the element's presence is sufficient signal.
clearOnly() wipes the container, so optimistic can only exist if user typed into new session.
Version bumped to 0.4.113.

## Known Issue & Workaround

**2026-03-16 — Deferred**: Fix attempt 4 passed automated QA (Playwright 18/18, tsc, lint) but
user testing on real mobile confirmed the issue persists. The optimistic bubble still disappears
after the terminal→transcript view switch in real usage.

**Root cause not fully resolved**: The timing race between `clearOnly()` fallback and late
`transcript:clear` SSE is deeper than the `_fallbackFired` flag. Further investigation needed.

**Workaround**: Close the browser tab and reopen the Codeman URL. The session will reload
fresh and the new session context will be correctly displayed.

**Deferred for**: Future investigation session. The automated Playwright checks may not fully
simulate the real SSE timing conditions on device.

## Next Steps After Compaction

Resume from status: qa

Run QA on fix attempt 4:
1. `tsc --noEmit` — must pass
2. `npm run lint` — must pass
3. Start dev server on port 3098 (already running) or 3099
4. Playwright: verify `app.js?v=0.4.113`, verify `clear()` source does NOT contain
   `this._fallbackFired &&` before `this._container.querySelector`
5. If QA passes: commit any TASK.md updates, then output testing instructions
6. Ask user to test: new session → /clear → wait for CTA → type message → verify bubble
   stays and Claude responds → click terminal → click back to transcript → verify content

Server on port 3098 is running with v=0.4.113.
Tailscale: http://100.69.214.73:3098

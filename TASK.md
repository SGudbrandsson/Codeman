# Task

type: bug
status: done
title: Sluggish send/input latency in web compose bar
description: When the user types text in the compose bar and hits send, the UI often "stays there" for a noticeable delay before the text is sent and the textarea clears. Root cause is twofold. (1) CLIENT: the compose send awaits the full HTTP round-trip before doing anything — no optimistic UI and no local echo. app.sendInput() (src/web/public/app.js ~line 11357) awaits the POST, and InputPanel._sendInner() (~line 21254-21385) only clears the textarea, shows the optimistic user bubble (TranscriptView.appendOptimistic), and shows the working indicator (TranscriptView.setWorking) AFTER sendInput resolves (~line 21321, 21357-21385). (2) SERVER: the POST /api/sessions/:id/input handler blocks the HTTP 200 on `await session.writeViaMux(inputStr)` (src/web/routes/session-routes.ts:724). writeViaMux -> TmuxManager.sendInput (src/tmux-manager.ts ~1286) runs `tmux send-keys` SEQUENTIALLY via execAsync per step, with hardcoded sleeps from planSendKeys (src/utils/tmux-send-keys-plan.ts): 50ms after each line of text, 50ms after each newline (C-j), and 100ms before the final Enter. Multi-line pastes stack these into 1s+ before the response even returns. On the way back, the terminal flicker filter (batchTerminalWrite, MAX_FLICKER_HOLD_MS=150) holds echoed output another 50-150ms.

affected_area: frontend
affected_area_detail: src/web/public/app.js (compose send / optimistic UI — PRIMARY), src/web/routes/session-routes.ts (input route), src/tmux-manager.ts + src/utils/tmux-send-keys-plan.ts (send-keys delays)
work_item_id: wi-39d6dc38
fix_cycles: 0
test_fix_cycles: 0

## Reproduction
- Open a session in the web UI, type a message into the compose bar, press send (Ctrl+Enter or the send button). Observe the textarea does not clear and no optimistic user bubble / "working" indicator appears until the HTTP POST resolves — several hundred ms for a single line, 1s+ for a multi-line paste.
- The latency scales with line count: each text line costs 50ms, each newline (C-j) costs 50ms, plus a fixed 100ms before the final Enter. A 5-line paste = ~5×50 + 4×50 + 100 = ~550ms of pure server-side sleeps before the 200 returns, and only THEN does the client clear/echo.
- Confirm by instrumenting timing: log a timestamp at the top of `InputPanel._sendInner` and another right before `ta.value = ''` (currently the last step); the gap equals the full round-trip including all `planSendKeys` sleeps.

## Root Cause / Spec

### Fix Lever 1 (PRIMARY — low risk, biggest perceived win): Optimistic client UI
Make the compose bar feel instant. On send, BEFORE/WITHOUT awaiting the network round-trip:
- Capture the text, then immediately: clear the textarea, append the optimistic user bubble (TranscriptView.appendOptimistic), and show the working indicator (TranscriptView.setWorking(true)).
- Fire the POST in the background. On error, roll back gracefully: surface a toast and restore the textarea content (and remove the optimistic bubble if feasible) so the user can retry.
- Preserve existing guards: the `_sending` re-entrancy guard, in-flight image-upload wait, and secret-detection scan must still run BEFORE clearing/sending (do not send if secrets block). Sequence: run validation (uploads + secret scan) first; once cleared to send, do the optimistic clear + fire-and-forget POST.
- Keep behavior correct for the case where the send target session != active session (the optimistic bubble/working indicator only render when TranscriptView._sessionId === app.activeSessionId — keep that condition).

### Fix Lever 2 (SECONDARY — careful): Don't block HTTP 200 on the full tmux sequence
- In POST /api/sessions/:id/input (session-routes.ts:724), avoid awaiting the entire writeViaMux/send-keys sequence before returning success. Options: enqueue the write and return 200 immediately (fire-and-forget with internal error logging), OR keep the await but trim/justify the sleeps.
- The 50/100ms sleeps in planSendKeys exist to let Ink (the Claude CLI renderer) settle between keystrokes so multi-line paste lands intact. Do NOT blindly remove them — if you trim, verify multi-line paste still arrives correctly in the target Ink app. The HTTP RESPONSE does not need to wait for the settle delays even if the writes themselves keep them.
- If fire-and-forget on the server: ensure ordering is preserved (a later input must not overtake an earlier one for the same session) and that write failures are still logged/surfaced (the existing fallback to session.write on writeViaMux failure must be retained in some form).

### Acceptance
- Pressing send clears the textarea and shows feedback within ~1 frame, independent of tmux timing.
- Multi-line paste still arrives intact in the session.
- Error path (POST fails) restores the user's text and notifies them.
- No regression to the `_sending` guard, secret detection, image-upload wait, or cross-session optimistic-render condition.

### Analysis Findings (confirmed)

**CLIENT — `src/web/public/app.js`**
- `App.sendInput(input, sessionId)` at line **11357** awaits the POST and throws on `!res.ok`. Body is `{ input, useMux: true }`. Caller is responsible for `\r` (already appended). This function is fine to keep as-is; the fix is in the *caller's* ordering.
- `InputPanel._sendInner()` at lines **21261-21388** is the bug site. Current ordering:
  1. Upload wait (21266-21273), `FeatureTracker.track` (21274), validation/empty check (21275-21281).
  2. Build `sendText` with image/file refs (21287-21299), secret scan (21301-21312) — these run BEFORE send. Good; keep before optimistic clear.
  3. Capture `_sendSessionId = app.activeSessionId` (21315), build `inputString = sendText + '\r'` (21318).
  4. `await app.sendInput(inputString, _sendSessionId)` at **line 21321** — BLOCKS here for the full round-trip.
  5. Post-resolve fallback Enter poller (21324-21346): if shell-mode skip, else poll status 20×150ms and resend `'\r'` once if still idle. Depends on send having "completed".
  6. `catch` (21347-21355): restores `ta.value = text`, `_restoreImages`, toast. This is the existing error-rollback — REUSE this logic for Lever 1's rollback.
  7. ONLY AFTER resolve: optimistic bubble `TranscriptView.appendOptimistic(sendText)` (line **21363**), `TranscriptView.setWorking(true)` (line **21370**), `_updateTabStatusDebounced(...'busy')` (21372), draft clear (21374-21379), `ta.value = ''` (21381), image/file strip (21384-21385).
- Cross-session guard already present at lines **21359** and **21369**: `TranscriptView._sessionId === app.activeSessionId`. Must be preserved when moving these earlier. Note: `appendOptimistic` is line 3346, `setWorking` is line 3894, `_restoreImages` is line 21025 — all exist.
- **Fix shape for Lever 1:** keep steps 1-3 (validation, secret scan, capture id) unchanged. Then do the optimistic block (bubble + setWorking + tab status + draft clear + `ta.value=''` + image strip) IMMEDIATELY, then fire `app.sendInput(...)` without `await` (fire-and-forget). Move the existing `catch` rollback (step 6) into the promise's `.catch()` so a failed POST still restores text/images and toasts. The fallback-Enter poller (step 5) can stay chained after the POST resolves (`.then(...)`) since it only needs to run on success.

**SERVER — `src/web/routes/session-routes.ts`**
- Input route handler ends at line **738** (`return { success: true }`). The blocking `await session.writeViaMux(inputStr)` is at line **724** inside the `effectiveUseMux` branch (717-734). On failure it falls back to `session.write(safeStr)` with `\n`→space (728-733). Shell mode (715-716) and non-mux (735-736) write directly.
- The comment at 718-721 explicitly states the await exists "so client-side retry timers can start counting from a meaningful baseline" — i.e. the client's fallback-Enter poller assumes the 200 means Enter was dispatched. If Lever 2 makes the server fire-and-forget, that client assumption breaks; Lever 1 (client optimistic) is independent of this and is the primary win. If Lever 2 is pursued, preserve ordering per-session and retain the writeViaMux-failure fallback to `session.write`.

**SERVER — `src/tmux-manager.ts` / `src/utils/tmux-send-keys-plan.ts`**
- `TmuxManager.sendInput` at line **1286** loops over `planSendKeys(input)` steps (1313-1328), running one `execAsync` per literal/key step and `setTimeout` per delay step — all sequential `await`s, so total latency = sum of all delays + exec time.
- `planSendKeys` (tmux-send-keys-plan.ts, lines 26-56): 50ms after each non-empty line (line 40), 50ms after each `C-j` newline (line 46), 100ms before final Enter (line 51). These exist for Ink settle timing; file header (lines 18-19) and `test/tmux-send-keys-plan.test.ts` warn NOT to trim. Note `_sendInner` already collapses multi-line into a single line (no `\n`) before sending (comment at 21283-21286, `inputString = sendText + '\r'`), so in the compose-bar path the only delay is the 100ms pre-Enter + one 50ms line delay ≈ 150ms server-side. Multi-line latency is more relevant to other callers / paste paths. **Dominant fix is therefore Lever 1 (client), confirming affected_area: frontend.**

**RETURN PATH**
- `batchTerminalWrite` (app.js line 6087) with `MAX_FLICKER_HOLD_MS` (used line 6138) holds echoed terminal output up to 150ms — affects when the echoed text appears in the *terminal* view, not the optimistic bubble. Lever 1 sidesteps this entirely for perceived latency.

## Fix / Implementation Notes

### Lever 1 (PRIMARY) — Optimistic client UI in `InputPanel._sendInner()` (src/web/public/app.js)

**What changed (the send-ordering reorder around old lines 21320-21388):**

BEFORE — strictly sequential:
1. `await app.sendInput(inputString, _sendSessionId)` blocked for the full HTTP round-trip (incl. all `planSendKeys` sleeps).
2. On resolve: fallback-Enter poller started.
3. `catch`: restored `ta.value`, `_restoreImages`, toast, `return`.
4. ONLY AFTER resolve: optimistic bubble (`appendOptimistic`) + `setWorking(true)` + `_updateTabStatusDebounced('busy')` + draft clear + `ta.value = ''` + image/file strip.

AFTER — optimistic-first, fire-and-forget:
1. Steps 1-3 unchanged (upload wait, FeatureTracker, empty-check, sendText build with image/file refs, SecretDetector scan, `_sendSessionId` capture, `inputString` build). Nothing is cleared or sent until the secret scan and validation have passed.
2. The optimistic block now runs IMMEDIATELY (synchronously, before any network await): appendOptimistic / clearOnly (guarded by `TranscriptView._sessionId === app.activeSessionId`), `setWorking(true)` (same guard), `_updateTabStatusDebounced('busy')`, draft clear, `ta.value = ''`, image/file strip, `_renderThumbnails()`, `_autoGrow()`. The cross-session guard is preserved verbatim at both sites.
3. `app.sendInput(inputString, _sendSessionId)` is fired WITHOUT `await`:
   - `.then(...)` holds the fallback-Enter poller (the 20×150ms `setInterval` resend), so it still runs — but only on a successful POST, matching the prior "Enter dispatched by now" assumption.
   - `.catch(...)` holds the rollback: logs, restores `ta.value = text` **only if the textarea is still empty** (avoids clobbering text the user started typing in the gap), `_restoreImages(_sentImagePaths)`, error toast, and removes the optimistic bubble via the new `TranscriptView.removeLastOptimistic()` (guarded so it's a no-op if the user navigated to another session, and feature-detected with `typeof === 'function'`).

**New method added** — `TranscriptView.removeLastOptimistic()` (app.js, immediately after `appendOptimistic` ~line 3363): removes the last `[data-optimistic="true"]` bubble and clears `_pendingOptimisticText`. Used only by the rollback path. Touches only DOM marked optimistic, never SSE-reconciled real blocks (real blocks already strip `data-optimistic` on arrival at line ~3566).

**Rollback snapshot:** `_sentImagePaths = images.map(img => img.path)` and `_optimisticAppended` boolean are captured before firing, since `this._images` is mutated synchronously by the optimistic strip.

### `_sending` re-entrancy guard decision
The guard lives in `send()` (the wrapper, lines 21255-21259): `if (this._sending) return; this._sending = true; try { await this._sendInner(); } finally { this._sending = false; }`. With fire-and-forget, `_sendInner()` now returns as soon as the optimistic block runs and the POST is fired (it no longer awaits the round-trip), so `_sending` resets almost immediately rather than after the full network cycle. **This is correct and intentional:** the double-submit risk that `_sending` guards against is fully eliminated the moment the optimistic block clears the textarea — a second invocation hits the empty-text guard (`if (!text && !images.length && !attachedFiles.length) return;`) and bails. Keeping `_sending` reset on `_sendInner` return (not on promise settle) maximizes UI responsiveness while still preventing the synchronous double-fire. No change to the wrapper was needed.

### Lever 2 (SECONDARY/SERVER) — NOT TOUCHED
See Decisions & Context below.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

Verified the fire-and-forget reorder in `InputPanel._sendInner()` (src/web/public/app.js ~21271-21422) and the new `TranscriptView.removeLastOptimistic()` (~3364-3372) against the task spec and acceptance criteria.

**Reorder correctness:** Validation (upload wait, FeatureTracker, empty-check, sendText build, SecretDetector scan) and session-id capture (`_sendSessionId`) run unchanged BEFORE anything is cleared or sent. The optimistic block (appendOptimistic/clearOnly, setWorking(true), `_updateTabStatusDebounced('busy')`, draft clear, `ta.value=''`, image/file strip, `_renderThumbnails`, `_autoGrow`) now runs synchronously before the network call. The POST is fired without `await`; the fallback-Enter poller is chained on `.then()` (success only) and rollback on `.catch()` (failure). Confirmed against the live source, not just the diff.

**Cross-session guard:** Preserved verbatim. Optimistic render guards use `TranscriptView._sessionId === app.activeSessionId`, and since `_sendSessionId = app.activeSessionId` is captured with no intervening await, they are equivalent. Rollback's bubble-removal guard correctly uses the captured `_sendSessionId` against the current `TranscriptView._sessionId`, so navigating away makes removal a no-op.

**Re-entrancy / double-submit:** Verified. `_sending` resets in the wrapper's `finally` after `_sendInner` returns. `ta.value = ''` (line 21364) executes synchronously before the POST is fired and before `_sendInner` returns, so a second invocation reads an empty textarea, the sent images/files are already filtered out, and it bails on the empty-text guard (line 21290). During an in-flight upload, `_sendInner` suspends at `await this._uploadsCompletePromise` (21282) with `_sending` still true — guard correctly holds across the upload wait.

**Rollback correctness:** `removeLastOptimistic()` only queries `[data-optimistic="true"]`. Confirmed real SSE user blocks never carry that attribute — `append()` (3575-3578) removes the optimistic bubble and renders the real block via `_appendBlock` without setting the marker, so no real block can be wrongly removed. Textarea restore is guarded on `!taNow.value.trim()` (won't clobber new typing). `_sentImagePaths`/`_optimisticAppended` are captured before the synchronous image strip mutates `this._images` — correct. `_restoreImages` takes a path array, matching `_sentImagePaths`.

**Edge cases:** `/clear` path leaves `_optimisticAppended` false, so rollback correctly skips `removeLastOptimistic` (the cleared transcript isn't restored on a failed `/clear`, but that matches prior behavior — not a regression). Shell-mode sessions still skip the Enter poller via the `mode !== 'shell'` check inside `.then()`. Unconditional `_restoreImages(_sentImagePaths)` on rollback can replace freshly-attached images, but this mirrors the original catch behavior — not a regression.

**Build:** `node --check src/web/public/app.js` → OK. `npx tsc --noEmit` → exit 0, no errors.

No regressions to the `_sending` guard, secret detection, image-upload wait, or cross-session optimistic-render condition. Lever 2 (server) deliberately untouched per the SECONDARY/risky designation — acceptable; Lever 1 alone satisfies the perceived-latency acceptance criteria.

## Test Gap Analysis

**Verdict: GAPS FOUND** (2 realistically-fillable gaps)

### Test infrastructure for app.js front-end behavior
`app.js` is a single large browser bundle with no module exports, and the vitest environment is `node` (no jsdom — confirmed in `vitest.config.ts:6`). Two established patterns exist for covering it:

1. **Pure-function replica** (node env) — the app.js logic under test is re-implemented in TypeScript and asserted directly. Used by `test/image-send-race-guard.test.ts` (replicates `InputPanel.send()` + `_updateSendBtnState()` upload-race logic), `test/compose-slash-commands.test.ts`, `test/image-paste-attach.test.ts`, `test/photo-upload-fixes.test.ts`. Each file states the replica must be kept in sync with app.js by hand.
2. **Playwright browser drive** — boots a real `WebServer` in Chromium and calls real `TranscriptView`/`InputPanel` objects via `page.evaluate`, then asserts on the live DOM. Used by `test/transcript-clear-new-session.test.ts` (already calls `TranscriptView.appendOptimistic`, `clearOnly`, `setViewMode` directly and queries the rendered container), `test/input-draft-race.test.ts`, `test/transcript-web-view.test.ts`, `test/draft-per-session.test.ts`.

There is NO jsdom harness that drives the real `InputPanel._sendInner()` method end-to-end; doing so would require stubbing `app.sendInput`, session state, the `_sending` guard, secret scan, and the fallback-Enter timers — not feasible cheaply and not matching any existing pattern. Gaps below are scoped to what each existing pattern can realistically reach.

### Gap 1 — `TranscriptView.removeLastOptimistic()` is untested (Playwright pattern)
- **File / target:** `src/web/public/app.js` ~line 3366 (`removeLastOptimistic`), new method, no coverage.
- **Realistic approach:** Add to `test/transcript-clear-new-session.test.ts` (or a sibling Playwright file) — it already drives `TranscriptView.appendOptimistic` and queries the container via `page.evaluate`. Append one or two optimistic bubbles, call `TranscriptView.removeLastOptimistic()`, assert: (a) the last `[data-optimistic="true"]` element is removed, (b) `_pendingOptimisticText` is reset to `null`, (c) a real (non-optimistic) rendered block is left untouched — i.e. the query only targets `[data-optimistic="true"]` and never strips an SSE-reconciled block. This directly mirrors the spec note that real blocks lose `data-optimistic` on arrival (app.js ~3576).

### Gap 2 — Optimistic-before-send ordering + rollback-on-failure are untested (pure-function replica pattern)
- **File / target:** `src/web/public/app.js` `InputPanel._sendInner()` reorder (~lines 21327-21420): optimistic clear/append fires synchronously BEFORE the fire-and-forget `app.sendInput(...)`; `.catch()` rollback restores `ta.value = text` only if the textarea is still empty, restores `_sentImagePaths`, and removes the optimistic bubble.
- **Realistic approach:** Extend the replica in `test/image-send-race-guard.test.ts` (which already models `InputPanel.send()` with a stubbed `sent[]`/`toasts[]` and resolvable upload promises) — or a new sibling file following the same pattern — to cover the reordered send path. Assert: (a) on send, the textarea value is cleared and the optimistic bubble is appended SYNCHRONOUSLY, i.e. before the `sendInput` promise settles (model `sendInput` as a pending/never-resolved promise and check state immediately); (b) on a REJECTED `sendInput`, the rollback restores the original text only when the replica textarea is still empty, restores the captured image paths, removes the optimistic bubble, and surfaces a toast; (c) the rollback does NOT clobber text the user typed into the textarea during the in-flight gap (the `!taNow.value.trim()` guard).
- **Note / limitation:** This is a replica, not a drive of the real method, consistent with how `send()` is already tested. It cannot catch a divergence between the replica and the real `_sendInner` source; the existing files accept this tradeoff explicitly. The fallback-Enter poller (`.then()` 20×150ms `setInterval`) and the `_sending` guard are already (or adjacently) covered and are lower-value to re-replicate; focus the new test on the ordering + rollback, which is the actual behavioral change.

### Not flagged
- Server levers (session-routes.ts / tmux-send-keys-plan.ts) were deliberately NOT changed (Lever 2 untouched), so `test/tmux-send-keys-plan.test.ts` and `test/tmux-send-input-newlines.test.ts` remain valid and need no update.
- The `_sending` re-entrancy guard, secret detection, and upload-wait paths are unchanged in behavior (only reordered relative to the network call); existing `image-send-race-guard.test.ts` coverage still holds.
<!-- filled by test gap analysis subagent -->

### Re-check (post-test-review)

**Verdict: NO GAPS** — all changed code is now adequately covered.

Re-confirmed the diff vs `master`: the ONLY source change is `src/web/public/app.js`, with exactly two behavioral additions — `TranscriptView.removeLastOptimistic()` (~3364) and the `InputPanel._sendInner()` optimistic-first / fire-and-forget reorder (~21327-21420). Both original gaps are now filled with APPROVED, passing tests:
- Gap 1 → `test/transcript-remove-last-optimistic.test.ts` (Playwright drive of the REAL method): 4/4 PASS.
- Gap 2 → `test/optimistic-send-rollback.test.ts` (replica of the reorder): 6/6 PASS. Verified the replica covers every materially-changed branch — synchronous optimistic block, `/clear` no-bubble path, `setWorking(true)`, image strip with in-flight preservation, fire-and-forget ordering, reject rollback (text+images+bubble+toast), and the `!taNow.value.trim()` no-clobber guard.

Considered but NOT flagged (not material / not introduced by this change):
- **`.then()` fallback-Enter poller** (the 20×150ms `setInterval` resend + shell-mode skip): pre-existing logic that was merely moved from inside the old `try` into `.then()`; its internals are byte-for-byte unchanged. It was never tested before this change and is not realistically fillable cheaply (timer-driven, depends on live session-status polling). The gap analysis already deprioritized it; the reorder introduced no new behavior here. Not a new gap.
- Server levers (Lever 2) remain untouched — existing `tmux-send-keys-plan.test.ts` / `tmux-send-input-newlines.test.ts` still valid, no update needed.

No new harness is warranted. Proceeding to QA.

## Test Writing Notes

Two new test files were added — one per gap. No existing tests were refactored.

### Gap 1 — `TranscriptView.removeLastOptimistic()` (Playwright browser drive)
- **File created:** `test/transcript-remove-last-optimistic.test.ts`
- **Pattern:** mirrors `test/transcript-clear-new-session.test.ts` exactly — boots a real `WebServer` (port **3262**, previously unused) in headless Chromium, calls the REAL `TranscriptView.appendOptimistic` / `removeLastOptimistic` and the real `app._onTranscriptBlock` handler via `page.evaluate`, then asserts on the live DOM.
- **Covers (4 tests):**
  1. `removeLastOptimistic()` removes the `[data-optimistic="true"]` bubble AND resets `_pendingOptimisticText` to `null`.
  2. A real (non-optimistic) assistant block (rendered via the real `_onTranscriptBlock` → `append` → `_appendBlock`, which never sets `data-optimistic`) is left untouched — asserted by counting `.tv-block--assistant` elements without the optimistic marker before/after. This is the load-bearing spec point (real SSE blocks are not stripped).
  3. With two optimistic bubbles, only the LAST is removed.
  4. No-op / no throw when there is no optimistic bubble.
- **Run:** `npx vitest run test/transcript-remove-last-optimistic.test.ts`
- **Result:** 4/4 PASS (~10s incl. server+browser boot).

### Gap 2 — Optimistic-before-send ordering + rollback-on-failure (pure-function replica)
- **File created:** `test/optimistic-send-rollback.test.ts`
- **Pattern:** mirrors `test/image-send-race-guard.test.ts` — re-implements the reordered `InputPanel._sendInner()` body (post-validation) in TypeScript with a controllable `app.sendInput` stub (resolve / reject / never-settle) and a `TranscriptView` replica (appendOptimistic/removeLastOptimistic/setWorking). Faithfully mirrors current app.js (~lines 21330-21421): rollback snapshot captured before the synchronous image strip, optimistic block runs synchronously, `app.sendInput(...)` fired WITHOUT `await`, `.catch()` rollback with the `!taNow.value.trim()` no-clobber guard, `_restoreImages(_sentImagePaths)`, guarded `removeLastOptimistic()`, and the exact error toast string.
- **Covers (6 tests):**
  - Synchronous optimistic UI: textarea cleared + bubble appended + `setWorking(true)` + `\r`-terminated POST fired, all BEFORE the (never-settled, pending) `sendInput` promise resolves; sent images stripped synchronously while in-flight images are preserved; `/clear` uses the no-bubble path.
  - Rollback on a REJECTED POST: restores text (when textarea still empty), restores image paths from the snapshot, removes the optimistic bubble, fires the error toast.
  - No-clobber guard: text the user typed into the textarea during the in-flight gap is NOT overwritten on failure (bubble still rolled back, toast still fires).
  - Success path: no rollback (textarea stays empty, bubble stays, images stay cleared, no toast).
- **Run:** `npx vitest run test/optimistic-send-rollback.test.ts`
- **Result:** 6/6 PASS (~0.2s).
- **Limitation (per Gap Analysis):** this is a replica, not a drive of the real `_sendInner` (app.js is an export-less browser bundle, vitest env is `node`/no-jsdom). It cannot detect replica/source divergence — same accepted tradeoff as the existing `image-send-race-guard.test.ts` and sibling replica tests.

### Verification
- Both new files typecheck clean (`npx tsc --noEmit` — no errors in either file).
- No implementation bugs found; all tests pass against the current fix. (One initial Playwright assertion used full `innerText` matching which was brittle against the empty-CTA placeholder + markdown wrapping of long reply text — switched to DOM `.tv-block--assistant` counting; this was a test-bug fix, not an implementation issue.)
<!-- filled by test writing subagent -->

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

### Test review attempt 1 — APPROVED

Both new test files reviewed against the two gaps, verified line-by-line against the real app.js source, and run to confirm they pass.

**Gap 1 — `test/transcript-remove-last-optimistic.test.ts` (Playwright drive):**
- Coverage: drives the REAL `TranscriptView.appendOptimistic` / `removeLastOptimistic` and the real `app._onTranscriptBlock` handler in headless Chromium, asserting on live DOM. Directly exercises the new method (app.js ~3366), not a replica.
- Correctness: assertions check real behaviour — `[data-optimistic="true"]` element removed, `_pendingOptimisticText` reset to `null`, real assistant block left untouched. Verified against source: `_appendBlock` (app.js 3574-3577) only strips the optimistic marker when a *user* SSE block arrives; the test uses a `role: 'assistant'` block so that path doesn't fire, and assistant blocks never carry `data-optimistic`. The `assistantBlockCount` filter (excludes `data-optimistic`) makes test 2 genuinely load-bearing.
- Edge cases: multiple bubbles (only last removed), no-op/no-throw with nothing to remove (matches real `removeLastOptimistic` which unconditionally nulls `_pendingOptimisticText`).
- Style: mirrors `transcript-clear-new-session.test.ts` exactly (same `new WebServer(PORT, false, true)` testMode, beforeAll/afterAll, page-per-test). Port 3262 confirmed unique across the test suite.
- Result: 4/4 PASS (~8s incl. browser+server boot).

**Gap 2 — `test/optimistic-send-rollback.test.ts` (pure-function replica):**
- Replica fidelity (the critical check): verified against real `_sendInner` (app.js 21330-21421). Confirmed the replica faithfully mirrors current behaviour:
  - Rollback snapshot (`_sentImagePaths` from path-filtered `images`, `_optimisticAppended`) captured BEFORE the synchronous image strip — matches 21335-21336.
  - Optimistic block runs synchronously (appendOptimistic / `/clear` no-bubble path / setWorking(true)) under the `TranscriptView._sessionId === app.activeSessionId` guard — matches 21341-21354.
  - `ta.value = ''` and `this._images = filter(!img.path)` (in-flight preserved) run before the POST — matches 21364-21368.
  - `app.sendInput(inputString, _sendSessionId)` fired WITHOUT await; `.then()` = success (poller, not modeled — acceptable per gap analysis), `.catch()` = rollback — matches 21375-21421.
  - `.catch()` restores `ta.value = text` only under the `!taNow.value.trim()` no-clobber guard, calls `_restoreImages(_sentImagePaths)` unconditionally, removes the bubble only when `_optimisticAppended && _sessionId === _sendSessionId && typeof removeLastOptimistic === 'function'`, and toasts the EXACT string `'Message failed to send — your input has been restored.'` ('error') — all match 21408-21420 verbatim.
- Edge cases covered: synchronous optimistic UI before a never-settling POST; sent-image strip + in-flight preservation; `/clear` no-bubble; rollback on reject (text+images+bubble+toast); no-clobber guard (user typed during in-flight gap → draft preserved, bubble still rolled back, toast still fires); success path (no rollback, bubble/cleared-images stay, no toast).
- Style: mirrors `image-send-race-guard.test.ts` (TS replica, stubbed `sent[]`/`toasts[]`, controllable promise behaviour). Same accepted replica/source-divergence tradeoff, documented in the file header and gap analysis.
- Result: 6/6 PASS (~10ms).

No issues found. Both gaps are genuinely covered, assertions verify real behaviour, the replica matches the actual app.js logic (not an idealized version), and inputs/mocks are realistic. No source or test files were modified during review.

## QA Results
<!-- filled by QA subagent -->

### QA attempt 1 — PASS (2026-05-31)

**1. `npx tsc --noEmit`** — PASS (exit 0, zero errors).

**2. `npm run lint`** — PASS (exit 0, 0 errors). 2 pre-existing warnings, both unrelated to the changed file `src/web/public/app.js`:
- `src/vault/search.ts:11` — unused eslint-disable directive.
- `src/web/routes/session-routes.ts:246` — unused eslint-disable directive.
No new lint errors introduced by the change.

**3. New test files** — PASS.
`npx vitest run test/optimistic-send-rollback.test.ts test/transcript-remove-last-optimistic.test.ts`
→ 2 files, 10/10 tests passed (~10s; Playwright file 4/4, replica file 6/6).

**4. Frontend dev-server check (port 3115)** — PASS.
- Server started clean (version 0.6.6), `GET /api/status` 200, no startup errors in `/tmp/codeman-3115.log`.
- Loaded `http://localhost:3115` (domcontentloaded + 4s settle) in headless Chromium.
- Method/wiring assertions via `page.evaluate`:
  - `typeof TranscriptView.removeLastOptimistic` === `'function'` ✓
  - `typeof InputPanel._sendInner` === `'function'` ✓
  - `appendOptimistic`, `setWorking`, `app.sendInput` all `'function'` ✓
- Opened a session; compose textarea rendered (`COMPOSE_TEXTAREA=true`).
- Console: 0 errors total, 0 errors matching `removeLastOptimistic|_sendInner|appendOptimistic|sendInput`.
- Server killed after the check; port 3115 confirmed down.

**Verdict: all gates PASS. status → done.**

### Docs Staleness
- `src/web/public/app.js` changed → flag "UI docs may need update (frontend changed significantly)". (Informational only — not updated per QA scope. Change is internal send-ordering / rollback logic with no user-facing UI surface or copy change, so doc impact is likely minimal.)
- No `src/web/routes/*.ts` changes → no API docs flag.
- No `skills/*/SKILL.md` changes → no skill docs flag.
- Note: changes are in the working tree (uncommitted), so `git diff master..HEAD` is empty; staleness assessed against the working-tree diff (`git status`).

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

### Fix subagent (2026-05-31)

1. **Lever 1 only; Lever 2 (server) deliberately NOT changed.** Rationale:
   - Lever 1 fully satisfies the perceived-latency acceptance criteria: the textarea now clears and the optimistic bubble + working indicator render within ~1 frame, completely decoupled from tmux send-keys timing and the HTTP round-trip.
   - The server `await session.writeViaMux(inputStr)` at session-routes.ts:724 is intentionally coupled to the client's fallback-Enter retry baseline (per the comment at lines 718-721: the client poller assumes the 200 means Enter was dispatched). Making the server fire-and-forget would break that assumption and risk reordering / lost-write-error handling. TASK.md flagged this as RISKIER/SECONDARY.
   - In the compose-bar path specifically, `_sendInner` already collapses input to a single line (`sendText + '\r'`), so server-side delay is only ~150ms (one 50ms line delay + 100ms pre-Enter), which is now hidden entirely behind the optimistic UI. There was no clearly safe, low-risk server trim available, so the server is left as-is per the task instruction ("Do NOT make a risky server change").

2. **`_sending` reset timing:** reset on `_sendInner` return (immediately after firing the fire-and-forget POST), NOT on promise settle. Detailed rationale in Fix / Implementation Notes — double-submit is prevented by the empty-textarea guard once the optimistic clear runs, so the early reset is safe and keeps the UI responsive.

3. **Rollback robustness:** on POST failure the textarea is restored only if it is still empty (user hasn't begun typing a replacement), the optimistic bubble is removed via a new `removeLastOptimistic()` helper, sent images are restored, and a toast fires. The cross-session guard (`TranscriptView._sessionId === ...`) is preserved at every optimistic render/rollback site so a background-session send never mutates the foreground transcript.

4. **Verification:** `node --check src/web/public/app.js` → OK; `npx tsc --noEmit` → exit 0, no errors.

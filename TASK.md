# Task

type: bug
status: done
title: Image upload succeeds but image not attached to sent message
description: Screenshots are uploaded to the server successfully (they appear in ~/.codeman/screenshots/) but are not always attached to the session message when sending. The image reaches the server via POST /api/screenshots and gets a path back, but when the user hits send, the image path is sometimes missing from the input string sent to the session. This is intermittent — sometimes it works, sometimes the image is silently dropped. Needs a failing test that reproduces the race condition. Likely a frontend issue in the compose/send flow where the upload response hasn't been processed before the send fires, or the image state (_images array) gets cleared prematurely.
affected_area: frontend
work_item_id: wi-a3bd55db
fix_cycles: 0
test_fix_cycles: 0

## Reproduction

### Steps to reproduce (Race Condition #1 — Ctrl+Enter bypass)
1. Open a session in the Codeman web UI.
2. Paste a large image (or use a slow connection) so the upload to `POST /api/screenshots` takes a noticeable amount of time.
3. While the image is still uploading (thumbnail visible, path not yet resolved), type some text in the compose textarea.
4. Press **Ctrl+Enter** (or Cmd+Enter on Mac) to send.
5. **Result**: The text is sent but the image is silently dropped. The image entry's `path` is still `null` because the upload hasn't completed, so `this._images.filter(img => img.path)` at line 20601 returns an empty array. Then line 20679 (`this._images = []`) clears the still-uploading image.

### Steps to reproduce (Race Condition #2 — send() clears in-flight uploads)
1. Even if the Send button is properly disabled during upload, if `send()` is invoked by any code path (keyboard shortcut), the method does not guard against in-flight uploads.
2. After send completes, `this._images = []` at line 20679 unconditionally clears ALL images, including any that were mid-upload from a concurrent paste/pick operation.

### Intermittent nature explained
The bug is timing-dependent: it only triggers when the user sends (via keyboard shortcut) before the upload fetch resolves. On fast local networks, the upload may complete before the user can type and hit Ctrl+Enter. On slower connections or with larger images, the window is wider.

## Root Cause / Spec

### Root Cause
Two related issues in `src/web/public/app.js`, `InputPanel` object (line ~20305):

**Primary: `send()` does not check `_uploadingCount`** (line 20596-20683)
The `_updateSendBtnState()` method (line 20804) correctly disables the Send *button* while `_uploadingCount > 0`. However, the Ctrl+Enter keyboard shortcut (line 20462-20466) calls `this.send()` directly, bypassing the disabled button. The `send()` method itself has no guard against in-flight uploads. It reads `this._images.filter(img => img.path)` which silently drops any images whose `path` is still `null` (upload not yet resolved), then unconditionally clears `this._images = []`, destroying the in-flight upload entries.

**Secondary: `send()` clears `_images` unconditionally** (line 20679)
Even in the non-racy case, `this._images = []` wipes the entire array including any entries that might be mid-upload from a concurrent paste operation. If the user pastes a second image while composing (starting a new upload) and then sends via the first image's completion, the second image's upload entry is destroyed.

### Affected code locations
- `InputPanel.send()` — line 20596 in `app.js`
- `InputPanel._updateSendBtnState()` — line 20804 in `app.js`
- `InputPanel._uploadFiles()` — line 20824 in `app.js`
- Ctrl+Enter handler — line 20462 in `app.js`

### Fix spec
1. **Guard `send()` against in-flight uploads**: At the top of `send()`, check `this._uploadingCount > 0`. If uploads are pending, either (a) block and wait for them to complete, or (b) show a toast and return early. Option (a) is better UX — await a promise that resolves when `_uploadingCount` reaches 0, then proceed with send. Option (b) is simpler.
2. **Recommended approach**: Add an `_uploadsComplete` promise/resolver pattern. When `_uploadingCount` transitions from 0 to positive, create a new Promise. When it transitions back to 0, resolve it. In `send()`, if `_uploadingCount > 0`, await the promise before proceeding. This way the user's Ctrl+Enter intent is preserved — it just waits for uploads to finish.
3. **Alternative simpler approach**: In `send()`, if `_uploadingCount > 0`, show a toast "Waiting for image upload..." and return. The user retaps/re-presses to send after the upload completes. Less ideal but simpler.
4. **Also fix the keyboard handler**: Even if `send()` gets its own guard, also consider disabling the Ctrl+Enter path when uploads are in-flight for consistency.

## Fix / Implementation Notes

Three changes in `src/web/public/app.js`, all within the `InputPanel` object:

1. **`send()` now awaits in-flight uploads** (line ~20596): Made `send()` async. Added a guard at the top that checks `_uploadingCount > 0`. If uploads are pending, it shows an info toast ("Waiting for image upload...") and awaits the `_uploadsCompletePromise`. This handles both the Send button click path and the Ctrl+Enter keyboard shortcut path, since both call `send()`.

2. **`_updateSendBtnState()` manages the promise lifecycle** (line ~20818): When `_uploadingCount` transitions from 0 to positive, a new `_uploadsCompletePromise` is created. When `_uploadingCount` returns to 0, the promise is resolved and cleaned up. This lets `send()` await upload completion without polling.

3. **`send()` only clears sent images** (line ~20691): Changed `this._images = []` to `this._images = this._images.filter(img => !img.path)` (same for `_files`). This preserves any entries that are still mid-upload from a concurrent paste, only removing entries that had resolved paths and were included in the sent message.

## Review History
<!-- appended by each review subagent — never overwrite -->
### Review attempt 1 — APPROVED
**Correctness**: All three changes directly address the two root causes identified in the spec. The async/await pattern in `send()` correctly blocks until uploads complete. The promise lifecycle in `_updateSendBtnState()` correctly creates/resolves based on `_uploadingCount` transitions. The selective clearing via `filter(img => !img.path)` correctly preserves in-flight uploads.
**Edge cases checked**:
- Double Ctrl+Enter during upload: both calls await same promise; second finds empty text/images and returns early via the existing guard. Safe.
- Concurrent paste during await: new image entry has null path, preserved by the filter. Correct.
- Multiple images uploading: promise created on first increment, resolved when all complete (count reaches 0). Correct.
- Safety timer (60s): resets count to 0, calls `_updateSendBtnState()` which resolves the promise, unblocking any waiting `send()`. Correct.
- `send()` callers don't await the returned promise: fire-and-forget is fine since the async function runs to completion independently.
- Upload failure (catch branch splices entry out of `_images`): subsequent `send()` won't see the failed entry. Correct.
**Security**: No new external inputs, no DOM injection, no user-controlled paths.
**Patterns**: Consistent with existing code style (object literal methods, `typeof app !== 'undefined'` guards, `app.showToast`).
**No issues found.**

## Test Gap Analysis
**Verdict: GAPS FOUND**

Changed file: `src/web/public/app.js` (InputPanel object)

Existing test coverage:
- `test/photo-upload-fixes.test.ts` — covers `_updateSendBtnState` safety timer and upload timeout/error handling, but NOT the new promise lifecycle or send-during-upload behavior.
- `test/manual/test-image-send-race.mjs` — a manual Playwright test that verifies button disablement during upload, but does NOT test the new async await-in-send path or Ctrl+Enter bypass.
- `test/image-paste-attach.test.ts` — covers clipboard paste flow, not send behavior.

Gaps:
1. **`send()` awaiting uploads**: No test verifies that `send()` waits for `_uploadsCompletePromise` to resolve before proceeding when `_uploadingCount > 0`.
2. **Promise lifecycle in `_updateSendBtnState()`**: No test verifies that the promise is created when count goes positive and resolved when count returns to 0.
3. **Selective image clearing**: No test verifies that `send()` preserves images with `path === null` (still uploading) while removing images with resolved paths.
4. **Double-send safety**: No test verifies that two concurrent `send()` calls during upload don't double-send (second call should find empty text/images and return early).

## Test Writing Notes

Created `test/image-send-race-guard.test.ts` — 13 tests across 4 describe blocks:

1. **`_updateSendBtnState promise lifecycle`** (4 tests): Verifies promise created on 0→positive transition, resolved on return to 0, same promise reused for multiple concurrent uploads, no-throw when count is 0 with no promise.

2. **`send() awaits uploads before sending`** (5 tests): Immediate send with no uploads, blocking await until upload completes, waiting for multiple uploads, text-only fallback when all uploads fail, early return when uploads fail and text is empty.

3. **`send() selective image clearing`** (3 tests): Clears resolved images after send, preserves in-flight images (path null), preserves in-flight files (path null).

4. **`double-send safety during upload`** (1 test): Two concurrent send() calls — first processes correctly, verifying no crash or unexpected behavior.

All 13 tests pass. Follows the project pattern of replicating browser-bundle logic as pure functions (same approach as `photo-upload-fixes.test.ts`, `image-paste-attach.test.ts`).

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->
### Test review attempt 1 — APPROVED
**Coverage**: All 4 gaps from the test gap analysis are addressed — promise lifecycle (4 tests), send-await behavior (5 tests), selective clearing (3 tests), double-send safety (1 test).
**Correctness**: Assertions verify real behavior, not just that code runs. The await-then-check pattern correctly uses `Promise.resolve()` to flush microtasks before asserting. The `startUpload`/`completeUpload`/`failUpload` helpers accurately mirror the real `_uploadFiles` increment/decrement pattern.
**Realism**: Test inputs reflect production scenarios (image paths, mixed images+files, empty text, failed uploads).
**Edge cases**: Covered — multiple concurrent uploads, all-uploads-fail, empty-text-with-failed-upload, no-promise-at-zero-count.
**Style**: Matches project conventions (replicated pure functions from browser bundle, `describe`/`it` nesting, vitest imports).
**Minor fixes applied**: Changed "Three behaviours" to "Four behaviours" in file header; removed unused `vi`/`beforeEach` imports.

## QA Results
- **tsc --noEmit**: PASS (zero errors)
- **npm run lint**: PASS (0 errors, 2 pre-existing warnings in unrelated files)
- **vitest run test/image-send-race-guard.test.ts**: PASS (13/13 tests)

### Docs Staleness
- UI docs may need update (frontend `app.js` changed) -- advisory only, minor bug fix.

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->
- Chose the "await promise" approach (spec option a/2) over the "toast and return" approach (spec option b/3). Better UX: the user's send intent is preserved and fires automatically once uploads finish.
- Did not add a separate guard to the Ctrl+Enter handler because the guard is in `send()` itself, which both code paths call. Adding it in both places would be redundant.
- The `close()` method's unconditional `_images = []` was left as-is since closing the compose panel is an explicit destructive action, not a race condition.

# Task

type: bug
status: done
title: Image in compose bar leaks between sessions on switch
description: When switching sessions with an image attached in the compose bar, the message and image follow to the new session instead of staying on the original session. Compose state (text + images) must be saved per-session and restored when switching back.
affected_area: frontend
work_item_id: none
fix_cycles: 0
test_fix_cycles: 0

## Reproduction

1. Open session A. Type some text in the compose bar and/or attach one or more images.
2. Click on session B's tab (or use any method to switch sessions).
3. Observe: the compose bar in session B still shows the text and/or images from session A.
4. Switch back to session A. Observe: the compose bar is now empty (the draft was overwritten).

The bug is most visible when the textarea has focus while switching (clicking a session tab), or when images are attached (images leak regardless of focus).

## Root Cause / Spec

### Root Cause

File: `src/web/public/app.js`, `InputPanel.onSessionChange()` (line ~20745)

The method has a "migration" guard that was added to protect against SSE-triggered session switches clobbering user input. The logic at lines 20756-20763:

```js
const userHasText = ta && ta.value && document.activeElement === ta;
const userHasImages = this._images.length > 0;
const userHasContent = userHasText || userHasImages;
if (ta && !userHasContent) { ta.value = ''; }
if (!userHasContent) this._restoreImages([]);
```

When `userHasContent` is true (textarea focused with text, OR images attached), the textarea and images are **not** cleared before setting `_currentSessionId = newId` and calling `_loadDraft(newId)`.

Inside `_loadDraft(newId)` (line ~20788), the method checks `ta.value` (which still has old session's text) and treats it as "in-progress user input" for the new session. It then **saves the old content as the new session's draft** (line 20796) and returns early without restoring the actual draft for the new session.

Two sub-bugs:
1. **Text leaks when textarea is focused** -- `userHasText` requires `document.activeElement === ta`, but clicking a session tab often doesn't blur the textarea first, so the guard fires on normal user-initiated switches.
2. **Images always leak** -- `userHasImages` checks `this._images.length > 0` with no focus check at all. Any attached image causes the entire compose state to migrate.

### Fix Spec

**In `onSessionChange(oldId, newId)`:**
- The draft is already saved correctly for the old session at line 20747 (`_saveDraftLocal(oldId)`).
- After saving, **always** clear the textarea and images, regardless of `userHasContent`. Remove the conditional guard entirely.
- Then proceed to load the new session's draft as before.

**In `_loadDraft(sessionId)`:**
- Remove or rework the early-return guard at lines 20794-20798 that treats leftover textarea content as "in-progress input." After the `onSessionChange` fix, the textarea will always be empty when `_loadDraft` is called during a session switch, so this guard becomes moot for that path. However, if this guard is needed for other callers, add a parameter (e.g., `isSessionSwitch`) to distinguish the two cases.

**SSE-triggered switch protection (if still needed):**
- If the concern about SSE-triggered auto-switches clobbering user input is valid, the right approach is to pass a flag from `selectSession` indicating whether the switch was user-initiated or SSE-triggered, and only skip the clear on SSE-triggered switches. However, given that `_saveDraftLocal` already saves the content before clearing, the user's input is preserved in the draft and will be restored when they switch back. The "migration" behavior is actually harmful and should be removed entirely.

## Fix / Implementation Notes

**File changed:** `src/web/public/app.js`

**Change 1 — `onSessionChange()` (line ~20745):**
Removed the conditional `userHasContent` guard that skipped clearing textarea/images when the user had content. Now the method always clears both textarea and images after `_saveDraftLocal(oldId)` saves the old session's state. The draft is preserved in the local cache and will be restored when the user switches back.

**Change 2 — `_loadDraft()` (line ~20782):**
Removed the early-return guard that treated a non-empty textarea as "in-progress input" and saved it as the new session's draft. After Change 1, the textarea is always empty when `_loadDraft` is called during a session switch, making this guard unnecessary. The method now unconditionally clears images, applies the local cache, then fetches from the server.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

**Changes reviewed:** Two edits in `src/web/public/app.js` — removal of the `userHasContent` conditional guard in `onSessionChange()` and removal of the early-return guard in `_loadDraft()`.

**Correctness:** Both changes directly address the root cause. `_saveDraftLocal(oldId)` captures the full compose state (text + image paths) before the clear, so no user data is lost. The unconditional clear ensures nothing leaks to the target session. The `_loadDraft` early-return removal is safe because `_loadDraft` is only called from `onSessionChange` (confirmed by grep), and after Change 1 the textarea is always empty on entry.

**Edge cases considered:**
- SSE-triggered session switches: the old "migration" guard was meant to protect against these, but `_saveDraftLocal` already persists drafts before clearing, so the user's content is preserved and restored on switch-back. No data loss.
- The redundant `_restoreImages([])` call inside `_loadDraft` (line 20786) after it was already called in `onSessionChange` (line 20755) is harmless defensive cleanup. Not a concern.
- No other callers of `_loadDraft` exist, so the guard removal has no unintended side effects.

**Security:** No new inputs, API calls, or data flow changes. No concerns.

**Consistency:** Code follows existing patterns in the file. Comments are clear and accurate.

## Test Gap Analysis

**Verdict: NO GAPS** (re-check after test updates)

### Coverage summary

- **`test/input-draft-race.test.ts`** (8 tests, 5 gaps) — Updated Gap 1 and Gap 2 to reflect the fix. Gap 1 now verifies `_loadDraft` does NOT save pre-existing textarea content to `_drafts` (old early-return guard removed). Gap 2 is a regression test reproducing the original bug scenario end-to-end (focused textarea + images, session switch clears everything, draft preserved). Gaps 3-5 unchanged and still valid.
- **`test/draft-per-session.test.ts`** (10 tests, 6 gaps) — All tests pass without modification. Covers save on switch, restore on switch, round-trip A->B->A, empty draft, send clears draft, and image attachment isolation.

All 18 tests pass. Both source changes (removal of `userHasContent` guard in `onSessionChange`, removal of early-return guard in `_loadDraft`) are adequately covered.

## Test Writing Notes

### Modified: `test/input-draft-race.test.ts`

**Gap 1 (replaced):** Old test expected `_loadDraft` to preserve a non-empty textarea via the early-return guard. New test (`_loadDraft does not save pre-existing textarea content to _drafts`) verifies that calling `_loadDraft` directly with a pre-populated textarea and no local cache does NOT create a `_drafts` entry for the session. This confirms the old save-to-drafts side-effect is gone.

**Gap 2 (replaced):** Old test expected `_loadDraft` to save leftover textarea content into `_drafts` for the new session. New test (`Regression — text + images with focused textarea are cleared on session switch`) reproduces the original bug scenario end-to-end via `onSessionChange`: types text in session A with focused textarea, attaches images, switches to session B. Asserts:
- Textarea is empty in session B (no text leak)
- `_images` is empty in session B (no image leak)
- Session A's draft is preserved in `_drafts` with correct text and imagePaths

**Gaps 3-5:** Unchanged. These tests cover the `valueAfterLocal` race guard, local cache restore, and server draft application -- all still valid after the fix.

### Unchanged: `test/draft-per-session.test.ts`

All 10 existing tests pass without modification. No changes needed.

### Test results

- `test/input-draft-race.test.ts`: 8 tests passed
- `test/draft-per-session.test.ts`: 10 tests passed

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

### Test review attempt 1 — APPROVED

**Gap 1 (replaced):** The test calls `_loadDraft` directly with a pre-populated textarea and no local cache, then asserts `_drafts.has(sid)` is `false`. This correctly verifies the old save-to-drafts side-effect (removed early-return guard) no longer fires. The implementation at `_loadDraft` lines 20782-20810 confirms there is no code path that writes to `_drafts` — it only reads from it. Test is correct and targeted.

**Gap 2 (replaced):** The regression test reproduces the exact original bug scenario end-to-end via `onSessionChange`: sets text + focus + images in session A, switches to session B. Three assertions cover the full fix surface:
1. Textarea empty in session B — confirms unconditional clear works (no text leak).
2. `_images` empty in session B — confirms image leak is fixed.
3. Session A draft preserved with correct `text` and `imagePaths` — confirms `_saveDraftLocal(oldId)` runs before the clear, so no data is lost.

Verified against the implementation: `_saveDraftLocal` reads `ta.value` and `_images` before the clear at lines 20746-20755, so the draft capture is correct. The mocked 404 for session B prevents server draft interference.

**Gaps 3-5 (unchanged):** Verified these still match the implementation. Gap 3 tests the `valueAfterLocal` race guard at line 20804. Gap 4 tests local cache fast-path restore at lines 20789-20794. Gap 5 tests server draft application at lines 20804-20808. All correct.

**Style/quality:** Tests follow the existing Playwright integration pattern (fresh browser context, session lifecycle management, cleanup in afterAll). Naming conventions and structure match the rest of the file. Type assertions are appropriately narrow.

**Edge cases:** The key edge case (textarea focused during switch, which was the trigger for the old buggy guard) is covered by Gap 2's explicit `ta.focus()` call. Image-only leak (no text) is implicitly covered by `draft-per-session.test.ts`. No missing boundaries identified.

**Verdict: All 5 gaps covered. 8 tests passing. No issues found.**

## QA Results
<!-- filled by QA subagent -->

- **tsc --noEmit:** PASS (zero errors)
- **npm run lint:** PASS (0 errors, 2 pre-existing warnings unrelated to this change)
- **vitest (input-draft-race + draft-per-session):** PASS (18/18 tests passed)
- **Frontend smoke test (Playwright):** PASS (page loads, session elements present, compose area present, no JS errors)

### Docs Staleness
- Skill docs may need update (`skills/codeman-full-qa/SKILL.md`, `skills/codeman-task-runner/SKILL.md`, `skills/codeman-worktrees/SKILL.md` changed)

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->
- Removed the "migration" guard entirely rather than adding an `isSessionSwitch` flag. Rationale: `_saveDraftLocal` already persists the compose state before clearing, so there is no data loss. The migration behavior was the root cause of the bug — it leaked content to the wrong session and overwrote the target session's draft.
- Removed the `_loadDraft` early-return guard rather than parameterizing it. After the `onSessionChange` fix, the textarea is always empty on entry to `_loadDraft` during session switches, so the guard is dead code for that path. No other caller passes leftover content.

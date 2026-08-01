# Task

type: feature
status: done
title: Files sheet — browser back button / swipe-back navigation via OverlayHistory
description: Wire the files sheet into the existing OverlayHistory manager (src/web/public/app.js ~581-633) so hardware/gesture back works naturally on mobile. Desired behavior (user-specified): (1) With the files sheet open showing a FILE (view or edit mode), pressing the browser back button or swipe-back gesture closes the FILE view and returns to the tree — not the whole sheet. (2) With the sheet showing the TREE, back closes the sheet. (3) Closing via UI controls (X button, back chevron in the sheet header, backdrop tap if wired) must consume the corresponding history entries — so a later back press does NOT reopen/re-close ghosts and there is no "infinite back loop". OverlayHistory already implements the push/pop/_skipPopstate pattern for this (used by McpPanel/PluginsPanel etc.) — integrate, do not reinvent.
constraints: (a) Two-level integration: OverlayHistory.push('files-sheet', closeFn) in openFilesSheet(); OverlayHistory.push('files-file', backFn) in filesOpenFile() (only when navigating tree→file, not on conflict reloads of the same file — check for double-push, note push() already dedupes consecutive same id). UI back chevron (filesSheetBack) → OverlayHistory.pop('files-file'); X close (closeFilesSheet) → pop both ids as needed. The close functions registered with OverlayHistory must close WITHOUT calling pop again (split each close into a _doClose internal + public wrapper that pops, matching how other overlays integrate). (b) DIRTY EDITOR EDGE CASE - closeFilesSheet() and file-level back both confirm('Discard unsaved changes?') when the editor is dirty. On popstate-driven close, the browser has ALREADY popped the history entry before the confirm runs; if the user cancels, the overlay must stay open AND its history entry must be restored (re-push) so a subsequent back still works. Handle this explicitly for both levels; test it. (c) Session-switch path calls OverlayHistory.clear() (app.js ~15522) — verify the files sheet closes cleanly through it (dirty confirm inside clear(): decide and document behavior; do not let a cancelled confirm corrupt the stack — prefer discarding silently is NOT acceptable; simplest acceptable: clear() keeps existing semantics and files close fn force-closes without confirm on clear, documented). (d) Frontend only, vanilla JS, edit src/web/public/app.js (+styles if needed); no backend changes. (e) Do not regress: existing overlays using OverlayHistory (MCP panel, plugins panel, etc.), the editor save/conflict flow, CodeMirror editor v2 (3d0c99ff — filesStartEdit now uses window.CodemanEditor with textarea fallback; dirty state may live in the editor adapter — find the current dirty check and use it). (f) iOS Safari swipe-back = popstate on same-document history — same code path, but VERIFY no visual glitch (sheet should not slide with the page); no special-casing unless broken. (g) Acceptance criteria @390px Playwright: open sheet → open file → history.back() → file view closes, tree remains; history.back() again → sheet closes; reopen sheet → close via X → history.back() → sheet does NOT reopen and app does not navigate away; open file → edit → make dirty → history.back() → cancel confirm → editor still open with content AND another history.back() still triggers the confirm again (entry restored); session switch with sheet open → sheet closed, no stuck history entries (subsequent single back does nothing overlay-related and does not trap). tsc + lint pass; existing tests pass (no route changes expected).
affected_area: src/web/public/app.js (OverlayHistory integration in openFilesSheet/closeFilesSheet/filesOpenFile/filesSheetBack, ~19525-19560 and ~19660+; OverlayHistory itself ~581-633 — extend only if strictly necessary)
work_item_id: wi-59210c7b
fix_cycles: 0
test_fix_cycles: 0

## Root Cause / Spec

VERIFIED 2026-08-01 (worktree @ 3d0c99ff). All line numbers below confirmed by reading the file.

### OverlayHistory (app.js 581–633) — VERIFIED, do NOT reinvent
- `_stack: []` of `{id, close}`; `_skipPopstate: 0` counter.
- `init()` (581–588): replaceState + popstate listener. Called once at boot (app.js 5574).
- `push(id, closeFn)` (590–595): **dedupes only when the id equals the CURRENT TOP** (`_stack[len-1].id === id`) → returns early; else pushState + push entry.
- `pop(id)` (597–604): findIndex by id (any position), splice it out, `_skipPopstate++`, `history.back()`. NOTE: pop() does NOT invoke the close fn — the caller must already have torn down the DOM. `_onPopState` sees skip>0 and just decrements. This is the mcp `close()` pattern.
- `_onPopState(e)` (606–616): if skip>0 → decrement, return (no close). Else `entry = _stack.pop(); entry.close()`. **The registered close fn IS what runs on a real back/gesture.**
- `has(id)` (618–620).
- `clear()` (622–632): snapshot stack, empty it, `for (entry of entries) entry.close()`, then one `_skipPopstate++` + `history.go(-n)`. **Needs a one-line extension** — see plan step 6.

### Reference integration pattern (VERIFIED: McpPanel 690–712, AgentPanel 26100–26133, others)
Three-method split every tracked overlay uses:
- `open()` … ends with `OverlayHistory.push('mcp', () => this._closeInternal());`
- `_closeInternal()` — DOM teardown ONLY (no pop, no history, no confirm).
- `close()` — public UI/X handler: `this._closeInternal(); OverlayHistory.pop('mcp');`
So: real back → `_onPopState` → registered `_closeInternal()` (DOM only). UI X → `close()` → `_closeInternal()` + `pop()` (which back()s + skips). Mirror this exactly, extended to two levels.
`closeAllPanels()` (15520–15549, fired ONLY by Escape at 6637) calls each overlay's `_closeInternal()` directly then `OverlayHistory.clear()` once.

### Files sheet — VERIFIED line numbers & state
- `filesState` object (init'd in openFilesSheet 19531): `{ showHidden, expanded, current, data, pendingContent, editor, activeDir }`.
- **DIRTY STATE lives at `this.filesState.current.dirty`** (boolean). Set by the editor onChange:
  - CodeMirror path (filesStartEdit ~19829): `onChange:(v)=>{ cur.dirty = v !== cur.content; }`
  - textarea fallback (~19839): `ta.addEventListener('input', ()=>{ cur.dirty = ta.value !== cur.content; })`
  - Cleared to false on successful save (filesSave 19889, filesOverwriteCurrent) and on filesCancelEdit. `cur` === `this.filesState.current`. **Use `this.filesState?.current?.dirty` as the single dirty check.**
- `openFilesSheet()` 19525–19542: guards `!activeSessionId`; sets display flex + `.open`; title 'Files'; hides back btn; `_filesShowTree()`; `filesLoadTree()`; `_filesEnsureVendor()`.
- `closeFilesSheet()` 19563–19574: dirty confirm → early return on cancel; remove `.open`+hide sheet & backdrop; `_filesDestroyEditor()`; null current+pendingContent.
- `_filesShowTree()` 19575 / `_filesShowView()` 19581: toggle toolbar/body vs view display.
- `filesSheetBack()` 19587–19597 (header chevron `#filesSheetBackBtn`, index.html 2360): dirty confirm → early return; destroy editor; null current+pending; title 'Files'; hide back btn; show tree; reload tree.
- `filesOpenFile(path)` 19698–19735: destroy editor; `_filesShowView()`; set title + **show back btn (19704)**; fetch file-content; binary types → `_filesRenderBinary` (sets current=null) + return; else set `filesState.current={…dirty:false…}` + `_filesRenderView()`.
- `filesStartEdit()` 19809 / `filesCancelEdit()` ~19855 / `filesSave()` 19866 / `_filesShowConflict()` 19894 / `filesReloadCurrent()` 19912 (calls `filesOpenFile(cur.path)` — a same-file RELOAD) / `filesOverwriteCurrent()` ~19917 (calls filesStartEdit).
- Create-file success path (~20014): `await filesOpenFile(new path)` then `filesStartEdit()` — a genuine tree→file nav.
- Delete-open-file path (~20040): manually returns to tree (nulls current, hides back btn, `_filesShowTree`) — **must also pop the 'files-file' entry** (see plan step 5c).

### UI bindings (index.html) — VERIFIED
- Files button 528: `app.openFilesSheet()`.
- Backdrop 2354–2355: `onclick="app.closeFilesSheet()"`.
- Back chevron 2360: `onclick="app.filesSheetBack()"` (hidden by default).
- X close 2363: `onclick="app.closeFilesSheet()"`.

### Session-switch reality (CORRECTION to intake)
`OverlayHistory.clear()` is called ONLY from `closeAllPanels()` (15548), which is triggered ONLY by the Escape key (6637). **`selectSession()` (9698) does NOT call closeAllPanels/clear today** — the files sheet currently stays open across a session switch. Acceptance (g) requires it to close on session switch, so we must add an explicit force-close in `selectSession` (anchor: right after the `if (this.activeSessionId === sessionId) return;` guard at 9700).

### CSS (f) — VERIFIED, no change needed
`.files-sheet.open` is `position: fixed` (styles.css 12859). It will not slide with the page during iOS swipe-back. No CSS work required unless testing reveals a glitch.

### The two-entry trap
Stack while a file is open: `[…, 'files-sheet', 'files-file']` (top = files-file). One real back pops files-file → returns to tree. Second back pops files-sheet → closes sheet. Closing via X while a file is open must remove BOTH entries (two `pop()` calls). Because sheet-level close-via-history only ever runs at the tree (files-file already popped), `current` is null there → its dirty confirm is a no-op on the back path; the sheet-level dirty confirm matters only for the X/backdrop path.

## Implementation Plan (concrete)

Split each close into force-internal (DOM only) + history-aware wrapper. Add a `forced` arg so `clear()` can bypass the confirm.

1. **Internal teardown helpers (no confirm, no pop, no history):**
   - `_doCloseFilesSheet()` — body of current closeFilesSheet MINUS the confirm (remove .open, hide sheet+backdrop, destroy editor, null current+pending).
   - `_doFilesBackToTree()` — body of current filesSheetBack MINUS the confirm (destroy editor, null current+pending, title 'Files', hide back btn, `_filesShowTree()`, `filesLoadTree()`).

2. **History-registered close fns (run on real back/gesture and on clear):**
   - `_filesSheetCloseFromHistory(forced)`: if `!forced && this.filesState?.current?.dirty && !confirm('Discard unsaved changes?')` → `OverlayHistory.push('files-sheet', (f)=>this._filesSheetCloseFromHistory(f)); return;` (re-push the entry the browser already popped) else `this._doCloseFilesSheet();`
   - `_filesBackFromHistory(forced)`: same shape, re-push `'files-file'` on cancel, else `this._doFilesBackToTree();`
   (Re-pushing inside `_onPopState` is fine — pushState is allowed there. It restores the entry so a subsequent back re-triggers the confirm, satisfying (b) for both levels.)

3. **openFilesSheet:** at the END add `OverlayHistory.push('files-sheet', (f)=>this._filesSheetCloseFromHistory(f));`

4. **filesOpenFile:** right after showing the view / back btn (near 19704, BEFORE the await) add `OverlayHistory.push('files-file', (f)=>this._filesBackFromHistory(f));`. push() top-dedup makes the conflict-reload (`filesReloadCurrent`→filesOpenFile same path, 'files-file' already top) a no-op automatically — no extra guard needed. Genuine tree→file (tap, create-new) pushes because top is 'files-sheet'.

5. **Public UI wrappers (must pop so history stays consistent):**
   - `closeFilesSheet()` → keep dirty confirm; on OK: `this._doCloseFilesSheet(); if (OverlayHistory.has('files-file')) OverlayHistory.pop('files-file'); if (OverlayHistory.has('files-sheet')) OverlayHistory.pop('files-sheet');` (order irrelevant — pop() splices by id; two back()s both skip-guarded).
   - `filesSheetBack()` → keep dirty confirm; on OK: `this._doFilesBackToTree(); OverlayHistory.pop('files-file');`
   - **Delete-open-file path (~20040):** after its manual return-to-tree, add `if (OverlayHistory.has('files-file')) OverlayHistory.pop('files-file');` so the stale entry is consumed.

6. **clear() force flag (OverlayHistory 622–632):** change `entry.close()` → `entry.close(true)`. Every other registered fn is `()=>this._closeInternal()` and ignores the arg — safe. This makes Escape/closeAllPanels force-close the files sheet WITHOUT a confirm (documents constraint (c): clear = silent force-close is the accepted trade-off ONLY on the batch-clear path; interactive back/X still confirm).

7. **Session switch (selectSession 9698):** after the `if (this.activeSessionId === sessionId) return;` guard, add:
   `if (OverlayHistory.has('files-sheet')) { this._doCloseFilesSheet(); if (OverlayHistory.has('files-file')) OverlayHistory.pop('files-file'); OverlayHistory.pop('files-sheet'); }`
   Force-closes DOM (no confirm — mid-switch prompts are undesirable and match the clear() trade-off) and consumes both entries so no ghost back remains. Document this.

8. **No CSS changes** expected. tsc/lint/tests should be untouched (frontend-only, no routes).

### Edge cases to verify in Playwright @390px
- open→file→back: file closes, tree stays. back again: sheet closes.
- reopen→X→back: sheet does NOT reopen, no app navigation.
- open file→edit→dirty→back→cancel: editor still open WITH content; another back re-triggers confirm (entry restored).
- session switch with sheet open: sheet gone, single subsequent back does nothing overlay-related (no trap).
- Regression: MCP/plugins/agent/settings/help overlays still back-close correctly (clear() arg change is additive).

## Fix / Implementation Notes

Implemented 2026-08-01 per the 8-step plan. All anchor line numbers re-verified against the file before editing; they matched the plan exactly. Frontend-only, all in `src/web/public/app.js`. `node --check` passes.

Changes (final line numbers after edits):

1. **DOM-only teardown helpers (new methods, ~19579, ~19589):**
   - `_doCloseFilesSheet()` — body of old `closeFilesSheet` MINUS the dirty confirm (remove `.open`, hide sheet+backdrop, `_filesDestroyEditor()`, null current+pending).
   - `_doFilesBackToTree()` — body of old `filesSheetBack` MINUS the confirm (destroy editor, null current+pending, title→'Files', hide back btn, `_filesShowTree()`, `filesLoadTree()`).

2. **History-registered close fns (new methods, ~19602, ~19614):**
   - `_filesSheetCloseFromHistory(forced)` — on a non-forced dirty-cancel, re-push `'files-sheet'` (browser already popped it) and return; else `_doCloseFilesSheet()`.
   - `_filesBackFromHistory(forced)` — same shape, re-push `'files-file'` on cancel; else `_doFilesBackToTree()`.

3. **openFilesSheet (~19556):** appended `OverlayHistory.push('files-sheet', (f)=>this._filesSheetCloseFromHistory(f));` at the end. push() top-dedup makes reopen-while-open a no-op.

4. **filesOpenFile (~19761):** added `OverlayHistory.push('files-file', (f)=>this._filesBackFromHistory(f));` immediately after showing the view + back btn, before the fetch await. Top-dedup makes the conflict-reload (`filesReloadCurrent`→same path, 'files-file' already top) a no-op; genuine tree→file navigations push because top is 'files-sheet'.

5. **Public UI wrappers now pop:**
   - `closeFilesSheet()` (~19625): keeps its dirty confirm; on OK → `_doCloseFilesSheet()` then pop 'files-file' (if present) + pop 'files-sheet' (if present).
   - `filesSheetBack()` (~19648): keeps its dirty confirm; on OK → `_doFilesBackToTree()` + `pop('files-file')`.
   - Delete-open-file path (~20103): after the manual return-to-tree, added `if (OverlayHistory.has('files-file')) OverlayHistory.pop('files-file');`.

6. **OverlayHistory.clear() (~630):** `entry.close()` → `entry.close(true)`. All other registered fns are `()=>this._closeInternal()` and ignore the arg; only the files fns read `forced`. Makes Escape/closeAllPanels force-close the files sheet without a confirm.

7. **selectSession (~9705, right after the same-session `return` guard):** if `OverlayHistory.has('files-sheet')` → `_doCloseFilesSheet()`, pop 'files-file' (if present), pop 'files-sheet'. Force-close (no confirm mid-switch) that also consumes both entries so no ghost back remains.

8. **No CSS changes.** No backend/route/test changes.

Dirty check used throughout: `this.filesState.current.dirty` (guarded), the single source of truth set by the editor onChange (CodeMirror + textarea fallback) and cleared on save/cancel.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

Reviewed the full diff against constraints (a)–(g) and the verified plan, reading the actual code (OverlayHistory 581–632, files methods 19525–20110, selectSession 9701–9711, all 13 other `push()` call sites) rather than trusting the diff. Also empirically tested the one load-bearing browser assumption.

**Verified correct:**
- **OverlayHistory pattern match (a):** `_doCloseFilesSheet` / `_doFilesBackToTree` are pure DOM teardown (no confirm, no pop); the history-registered `_filesSheetCloseFromHistory`/`_filesBackFromHistory` run on real back; the public `closeFilesSheet`/`filesSheetBack` keep the confirm and pop. Exactly mirrors the McpPanel `_closeInternal` + `close()` split, extended to two levels.
- **`clear(true)` change (c/step 6):** confirmed all 13 other registered close fns are zero-arg arrows (`() => this._closeInternal()` etc.) that ignore the `forced` arg. Only the two files fns read it. Safe.
- **Two-level stack consistency:** stack is `[files-sheet, files-file]` while a file is open. back→back closes file then sheet; X (file open) pops both. `_onPopState` pops the entry from `_stack` *before* invoking `close()`, so the dirty-cancel re-push (`push('files-file')`) correctly restores the just-popped entry and browser+_stack stay in sync — a subsequent back re-triggers the confirm. Verified at both levels. Re-push inside popstate (pushState during a popstate handler) is legal.
- **No duplicate `files-file`:** `push()` dedupes by id, so `filesReloadCurrent`→`filesOpenFile(same path)` (conflict reload) is a no-op, and even a hypothetical file→file nav could not stack two entries. `create-file` (`_filesCreateSubmit`→`filesOpenFile`) always runs from the tree (create toolbar is in `filesSheetTreeToolbar`, hidden in view mode) so top is `files-sheet` and it pushes correctly.
- **Binary-file path:** `filesOpenFile` pushes `files-file` before the fetch, then `_filesRenderBinary` sets `current=null` and returns. Not a leak — every exit (real back → not-dirty → `_doFilesBackToTree`; header back; X) consumes the entry. Consistent.
- **selectSession force-close (c/g):** placed right after the same-session guard, DOM-only close + pop both entries (files-file conditional, files-sheet within the `has('files-sheet')` guard). Invariant (files-file only above files-sheet) holds, so pop targeting is correct. No ordering conflict with the rest of selectSession.
- **Delete-open-file path:** correctly adds `pop('files-file')` after its manual return-to-tree.
- **Reopen-while-open:** confirmed the sheet (z-index 10003) + backdrop (10002) cover the viewport, so the Files button is unclickable while open — `openFilesSheet` cannot be re-invoked, so the "reopen at file view would push a duplicate files-sheet" edge (dedup only holds when top is `files-sheet`) is unreachable via UI.
- **Double synchronous `history.back()`** (closeFilesSheet with file open, and selectSession issue two `pop()`s): empirically tested in Chromium via Playwright — two `history.back()` calls fire two popstate events, `_skipPopstate` goes 2→0 with no coalescing. The QA target handles it cleanly.
- `node --check src/web/public/app.js` passes.

**Non-blocking notes for QA / future (do not block merge):**
1. The double-pop paths (X-close-with-file-open, session-switch-with-file-open) rely on two synchronous `history.back()` producing two popstates. Verified clean in Chromium; **not testable here on iOS Safari** (the real mobile target, constraint f), which has historically been more prone to coalescing rapid traversals. Worst case is benign: `_stack` is already spliced consistent, so at most one lingering `_skipPopstate` / one extra ghost-back — no stack corruption. QA should exercise those two paths on iOS Safari specifically. If ever flaky, the bulletproof fix is a batch pop (single `history.go(-2)`) mirroring `clear()`; not required now.
2. The delete-open-file path (~20097) manually returns to tree without calling `_filesDestroyEditor()`, so a live CodeMirror instance for a deleted-while-editing file isn't torn down. Pre-existing (this diff only added the `pop` line there); out of scope. `_doFilesBackToTree()` would have handled it.
3. `_filesSheetCloseFromHistory`'s dirty branch is effectively dead on the history path (files-file is always popped first, so `current` is null at the tree). Documented in TASK.md; harmless defensive code.

The implementation faithfully follows the verified 8-step plan with no deviations, is internally consistent across every traced path, and introduces no regressions to the shared OverlayHistory mechanism.

## Test Gap Analysis

Analyzed 2026-08-01. Verdict: **GAPS FOUND (one small, in-scope gap)** → status `writing-tests`.

### Test infrastructure that exists (assessed)
- **Default suite is vitest only.** `vitest.config.ts` `include: ['test/**/*.test.ts']`, `environment: 'node'`. `npm test` = `vitest run`. `.playwright.ts` files are **NOT** in the default include and only run when named explicitly (`npx vitest list` shows none).
- **Playwright DOES exist as an opt-in pattern.** `playwright@^1.58.0` is a dep; `test/agent-management-ui.playwright.ts` (and `agent-management-ui` counterpart) spin up `WebServer` + chromium, `page.goto`, `waitForFunction('app-loaded')`, viewport sizing. So a browser harness for @390px acceptance scenarios is technically available — but it is opt-in, not wired into `npm test`, and per project memory is historically flaky in worktrees (~115 pre-existing env failures; QA guidance is "verify via headless Playwright against a dev server", i.e. manual, not CI).
- **Client-logic-via-jsdom-replica is the established pattern.** 6 files use `@vitest-environment jsdom`. Critically, **`test/overlay-history.test.ts` already exists** and tests this exact mechanism by copying OverlayHistory's logic verbatim into the test (documented "Keep this replica in sync with OverlayHistory in app.js"), running push/pop/clear/_onPopState/_skipPopstate against jsdom-mocked `history.*`. It has thorough `clear()`, `pop()`, and `_skipPopstate` coverage.
- **No existing test touches the files sheet.** grep of `test/` for `filesSheet`/`openFilesSheet`/`closeFilesSheet`/`popstate` hits only `overlay-history.test.ts` (for `popstate`). The files-sheet methods are not exercised anywhere.

### What this diff actually changed (testability seam analysis)
`git diff master` = 70 ins / 11 del, all in `src/web/public/app.js`. Two distinct kinds of change:
1. **Shared mechanism — ONE line:** `OverlayHistory.clear()` now calls `entry.close(true)` instead of `entry.close()` (forced-close flag, constraint (c)). This is the only change to the reusable, self-contained, replica-tested OverlayHistory object.
2. **Files-sheet integration (the bulk):** new `_doCloseFilesSheet`/`_doFilesBackToTree`/`_filesSheetCloseFromHistory`/`_filesBackFromHistory` methods + push/pop calls in `openFilesSheet`/`filesOpenFile`/`closeFilesSheet`/`filesSheetBack`/`selectSession`/delete-path. These live inside the `CodemanApp` class and are tightly coupled to live DOM nodes, `filesState`, the CodeMirror/textarea editor adapter, `confirm()`, and `fetch`. There is **no importable seam** — app.js is a browser bundle attached to `window`/DOM, not a module the vitest suite imports. Faithfully replicating this two-level dance in a jsdom replica would be large and would drift from the real code (the replica value only holds for small self-contained units like OverlayHistory itself, not for DOM-coupled controller methods).

### Gap found (recommended, fits existing pattern exactly)
**`test/overlay-history.test.ts` is now out of sync with the source and does not cover the forced-close contract.** The replica's `clear()` still calls `entry.close()` (no arg), and no test asserts that `clear()` passes `forced=true` to registered close fns while `pop()`/real-popstate pass no/ falsy arg. This forced-close-on-batch-clear is the specific behavior constraint (c) relies on to prevent stack corruption on Escape/`closeAllPanels` and session-switch (a dropped arg would silently reintroduce a mid-batch dirty `confirm()`). The test belongs in the file that already exists, uses the identical replica pattern, is a few lines, and locks a load-bearing contract.
- Update the replica `clear()` to `entry.close(true)` (keep in sync with source).
- Add assertion(s): registered close fns receive `true` from `clear()`; and (to document the contract) that `pop()`-driven and `_onPopState`-driven closes do NOT pass a truthy forced flag. Optionally model a two-level `[files-sheet, files-file]` stack with a dirty-cancel re-push close fn to demonstrate the re-push-restores-entry behavior against the replica (still pattern-consistent — pure OverlayHistory mechanics, no DOM/editor coupling).

### Explicitly scoped OUT (not a gap worth writing)
- **A new Playwright @390px files-sheet suite.** The acceptance criteria are Playwright scenarios and the `.playwright.ts` harness exists, but: (a) it is opt-in / not in `npm test`; (b) it is historically flaky in worktrees (project memory); (c) the files sheet guards on a live `activeSessionId` and the file view/edit/dirty paths need a real session + real files — substantially heavier fixtures than any existing playwright test, for a brittle result that won't run in the default gate. Recommending it would push infra beyond how the repo actually gates changes. These scenarios are better left to the manual @390px QA phase (the code review already empirically verified the load-bearing double-`history.back()` behavior in Chromium). Documenting this so QA explicitly exercises: open→file→back→back, reopen→X→back, dirty→back→cancel→back, and session-switch-with-sheet-open on the real mobile target (iOS Safari), per acceptance (g).
### Re-check 2026-08-01 (after test-writing + Opus test review APPROVED). Verdict: **NO GAPS** → status `qa`.

Re-verified the whole change against the now-updated suite:

- **Original gap is fully filled, not partial.** `test/overlay-history.test.ts` now has a `describe('forced-close contract (files-sheet integration)')` block with 4 tests, and its replica `clear()` calls `entry.close(true)`. Diffed the replica line-by-line against the real `OverlayHistory` (app.js 581–633): `init`/`push`/`pop`/`_onPopState`/`has`/`clear` all match verbatim, including `_onPopState` calling `entry.close()` with **no** arg and `clear()` calling `entry.close(true)`. No drift. Full file: **34 passed / 0 failed**.
- **The contract is locked from both directions.** Tests assert `clear()` passes `forced===true` (silent batch-close, constraint (c)); real popstate passes a falsy `forced` (interactive back runs the confirm branch, constraint (b)); `pop()` never invokes the close fn (UI already tore down DOM); and the dirty-cancel re-push keeps the entry so the next back re-confirms. This models both the `files-sheet` and `files-file` close-fn shapes (`_filesSheetCloseFromHistory` / `_filesBackFromHistory` are identical in shape), so the single generic re-push model covers both levels.
- **No NEW gap introduced by the test-writing cycle.** The 4 tests are pure OverlayHistory mechanics with no DOM/editor coupling; they add no infrastructure. The review's only note (`toBeFalsy()` vs `toBeUndefined()`) is a strictness nicety, not a coverage gap.
- **Two-level LIFO unwind is already covered generically.** The pre-existing `nested overlay stack (LIFO)` tests (reverse-order popstate close, three-deep unwind, pop-middle) already exercise the exact stack mechanics the `[files-sheet, files-file]` pairing relies on; no files-specific duplicate is warranted.
- **DOM-coupled files-sheet integration remains correctly OUT of scope.** The bulk of the diff (`_doCloseFilesSheet`/`_doFilesBackToTree`/`selectSession` force-close/`filesOpenFile` push/delete-path pop) lives inside `CodemanApp`, tightly coupled to live DOM, `filesState`, the CodeMirror/textarea adapter, `confirm()`, and `fetch`, with no importable seam in the browser bundle. As established, these acceptance flows (open→file→back→back, reopen→X→back, dirty→back→cancel→back, session-switch-with-sheet-open) belong to the manual @390px / iOS Safari QA phase, not the vitest default gate. No change to that assessment.

Conclusion: the change is adequately covered within the project's established vitest-only replica pattern. No additional in-scope, writable gap remains. Advancing to `qa`.
<!-- filled by test gap analysis subagent -->
<!-- re-check appended above by test gap analysis subagent -->

## Test Writing Notes

Written 2026-08-01. Scope held tight to the single in-scope gap from the analysis: the `OverlayHistory.clear()` forced-close contract. No files-sheet CodemanApp integration was replicated (no importable seam; Playwright-only, out of the default gate — as scoped out).

### File modified: `test/overlay-history.test.ts`

**Replica sync (kept the jsdom replica faithful to the real code):**
- `StackEntry.close` and `push()`'s `closeFn` param typed as `(forced?: boolean) => void`.
- Replica `clear()` now calls `entry.close(true)` (was `entry.close()`), matching `OverlayHistory.clear()` in app.js ~630. Added a sync comment.

**New tests — `describe('forced-close contract (files-sheet integration)')`, 4 tests:**
1. `clear() invokes every registered close fn with forced === true` — pushes `files-sheet` + `files-file`, asserts each close fn is called once with `true`. Locks the batch-clear silent-force-close contract (constraint (c): Escape/closeAllPanels/session-switch must not fire a mid-batch confirm).
2. `real popstate invokes close fn without a truthy forced arg` — `_onPopState` calls the registered fn with a falsy leading arg (`toBeFalsy()`), documenting that the interactive back/gesture path runs the confirm branch.
3. `pop() does NOT invoke the close fn at all` — confirms the UI-driven pop path never passes a forced flag (caller already tore down the DOM); no `forced` leaks here.
4. `dirty-cancel re-push on a real back restores the entry so the next back re-confirms` — models the files-file close fn's re-push-on-cancel behavior against the pure replica: first back (dirty, cancelled) re-pushes and keeps the entry; second back (discarded) tears down and removes it. Demonstrates the entry-restoration contract from constraint (b) using only OverlayHistory mechanics (no DOM/editor coupling).

### Vitest run result
`npx vitest run test/overlay-history.test.ts` → **1 file passed, 34 tests passed** (30 pre-existing + 4 new), 0 failures. No native-dep/ABI issues (this test has none). No implementation bugs surfaced.
<!-- filled by test writing subagent -->

## Test Review History
<!-- appended by each test review subagent — never overwrite -->

### Test review attempt 1 — APPROVED

Reviewed `test/overlay-history.test.ts` (replica sync + 4 new `forced-close contract` tests) against the real `OverlayHistory` (app.js 581–633) and the real files-sheet history close fns (`_filesSheetCloseFromHistory` 19602, `_filesBackFromHistory` 19614). Ran the suite: **34 passed / 0 failed**.

**Replica faithfulness — VERIFIED line-by-line against source.** After the `entry.close(true)` sync, the jsdom replica still mirrors the real object exactly: `init` (replaceState + popstate listener), `push` (top-only dedup → push entry + pushState), `pop` (findIndex/`-1` guard/splice/`_skipPopstate++`/`history.back()`), `_onPopState` (skip>0 → decrement+return, else `_stack.pop()` + `entry.close()` **with no argument**), `has`, and `clear` (snapshot → empty → `entry.close(true)` per entry → `_skipPopstate++` + `history.go(-n)` guarded on non-empty). The replica's sync comment matches the source's clear() comment. No drift.

**Coverage — hits the exact gap.** The Test Gap Analysis scoped the only unit-testable seam to the `clear()` → forced-close contract. The 4 new tests lock it:
1. `clear()` passes `forced === true` to every registered close fn (the load-bearing constraint (c): batch clear must silence the mid-batch confirm) — correct.
2. real popstate path invokes the close fn with a non-truthy `forced` (confirm branch runs on interactive back) — correct.
3. `pop()` (UI-driven) never invokes the close fn — correctly documents that the caller already tore down the DOM.
4. dirty-cancel re-push: first (dirty, cancelled) back re-pushes and preserves the entry + stack; second (discarded) back tears down and empties. Faithfully models the real `_filesBackFromHistory` shape (`if (!forced && dirty) { push(same id); return } else teardown`) using pure OverlayHistory mechanics — no DOM/editor coupling, consistent with the replica pattern and the DOM-coupled integration correctly scoped OUT.

**Correctness / realism.** Assertions verify behavior (call counts + arg values + resulting `_stack`/`has()` state), not mere execution. Edge cases the reviewer checked for are already covered elsewhere in the file and need no duplication: empty-stack `clear()` is safe (line 244) and the `_skipPopstate>0` path does NOT call close (line 279). Style matches the file conventions (`oh` fixture, describe/it naming, leading contract comments).

**Non-blocking note (not a defect, no change required):** test 2 asserts `expect(closeFn.mock.calls[0][0]).toBeFalsy()` on the popstate path. The real `_onPopState` calls `entry.close()` with **no argument**, so the value is precisely `undefined`; `toBeUndefined()` would pin the "popstate passes no arg" contract a hair more tightly. `toBeFalsy()` still correctly captures the load-bearing property (the `!forced` confirm branch runs), so this is a strictness nicety, not a blocker.

Verdict: **APPROVED**. Status advanced to `test-analysis` for a re-check of remaining gaps.

## QA Results

QA run 2026-08-01 (QA subagent). Verdict: **ALL PASS** → status `done`.

### Standard quality gates
- **`npm run typecheck` (tsc --noEmit):** PASS — zero errors.
- **`npm run lint` (eslint 'src/**/*.ts'):** PASS — 0 errors, 2 pre-existing warnings in files NOT touched by this diff (`src/vault/search.ts`, `src/web/routes/session-routes.ts`; unused eslint-disable directives). Note: the changed file `src/web/public/app.js` is `.js` and outside the lint glob, so lint does not cover it directly; `node --check` was clean per implementation/review notes.
- **`npx vitest run test/overlay-history.test.ts`:** PASS — **34/34 tests passed** (ran with brew Node v25.6.1 on PATH; no native-dep issues).

### Targeted frontend acceptance (Playwright, Chromium, viewport 390px)
Dev server started on an ephemeral port (tsx src/index.ts web), `/api/status` healthy, adopted real sessions from shared ~/.codeman. Copied `editor.min.js` into the worktree `src/web/public/vendor/` (xterm vendor already present). Drove the app via `window.app.*` methods for setup + real `history.back()` for navigation, with sentinel history entries below the app so trailing backs land on the app (not about:blank). Used a session with a populated file tree (`.env` chosen). All 8 assertions passed:
1. **S1** Open files sheet → sheet `.open`, display flex, tree body visible, view hidden. PASS
2. **S2** Open a file → view shown (display flex), back chevron visible, title = filename. PASS
3. **S3** `history.back()` → file view closes, TREE remains, sheet still `.open`, back chevron hidden. PASS
4. **S4** `history.back()` again → sheet closes (no `.open`, display none). PASS
5. **S5** Reopen → close via X (`closeFilesSheet`) → `history.back()` → sheet does NOT reopen, `window.app` intact, URL unchanged. PASS (proves the X-close consumed the history entry — back is a normal browser back, no ghost).
6. **S6** Open file → edit → force dirty → `history.back()` → dismiss (cancel) the `confirm('Discard unsaved changes?')` → editor STAYS open with view visible; a second `history.back()` re-triggers the confirm again (2 confirms observed, editor still open after both cancels). PASS — confirms the dirty-cancel re-push restores the history entry at the file level.
7. **S7** Session switch with sheet open → sheet closes; a subsequent `history.back()` leaves it closed and app intact (no stuck/ghost entry). PASS.

Screenshot evidence: /tmp/qa-files-sheet.png. Dev server killed and temp QA script removed after the run. No regressions observed to app load or session list.

### Docs Staleness
- `src/web/public/app.js` changed (frontend integration) → **flag: UI docs may need update (frontend changed significantly)**. Advisory only — no docs updated by QA.
- No route/skill/backend changes (only app.js + test/overlay-history.test.ts + TASK.md).

## Decisions & Context

- 2026-08-01 intake: user request (voice, mobile UX): back button/swipe-back should close the open file first, then the sheet; UI-close must unwind history so back never loops. Existing OverlayHistory chosen as the mechanism — files sheet was simply never wired into it.

- 2026-08-01 implement: Followed the plan exactly; no deviations. Key decisions carried through:
  - **Dirty-cancel re-push**: on a real back/gesture the browser has already popped the entry before our confirm runs. On cancel we re-`push()` the same id inside the popstate-triggered close fn to restore it, so the sheet stays open AND a later back re-triggers the confirm. Verified pushState-inside-popstate is legal. Applied at both levels.
  - **clear() force flag (constraint (c))**: chose the documented "silent force-close on batch clear only" trade-off. `clear()` now calls `entry.close(true)`; interactive back / X / header-back still confirm. Escape→closeAllPanels→clear() therefore force-closes the files sheet without a mid-batch prompt (a cancelled confirm there could corrupt the shared stack, which the constraint explicitly forbids).
  - **Session switch (constraint (c) / acceptance (g))**: intake's assumption that selectSession calls clear() was corrected during analysis — it does not. Added an explicit force-close block right after the same-session guard in selectSession, force-closing DOM (no confirm mid-switch) and popping both entries so a subsequent single back does nothing overlay-related (no trap).
  - **Two-entry model**: stack while a file is open is `[…, 'files-sheet', 'files-file']`. X-close pops both; header-back pops only 'files-file'. The sheet-level history close fn only ever runs at the tree (files-file already popped, current null) so its dirty confirm is a no-op there — the sheet-level confirm matters only for the X/backdrop path, which keeps its own confirm.

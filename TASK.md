# Task

type: feature
status: done
title: Markdown review mode — file-editor v2 everywhere, annotation notes, files-sheet state persistence
description: Three related improvements to the file viewing experience in the Codeman web frontend (src/web/public), primarily used on mobile (iOS Safari):

1. **Route ALL file opens through the new file-editor v2.** Today, clicking a file path in the transcript opens the OLD file picker/viewer. Replace that old viewer entirely: any file clicked anywhere (transcript file links, tool-result paths, etc.) must open in the new file-editor v2 surface (the one used by the files sheet — CodeMirror editor, markdown Edit/Preview tabs, image/binary previews, HTML preview tab). Markdown files should open in Preview mode by default, same as when opened from the files sheet. Remove/retire the old picker code path once nothing uses it.

2. **Markdown annotation / review notes mode.** When reading a markdown file in Preview mode, the user wants to review long documents (e.g. stories) and give feedback without bouncing between the viewer and the chat. Implement: (a) selecting text in the markdown preview offers an 'Add note' affordance (must work with iOS Safari text selection — consider a floating button near the selection or a toolbar action that captures the current selection); (b) the note dialog shows the selected excerpt and lets the user type a comment; (c) notes accumulate in a review panel/list for that file — each entry shows the quoted excerpt + the note, and can be edited or deleted; (d) annotated ranges are visually highlighted in the preview while the review session is active; (e) a 'Send notes' action composes ONE message containing the file path and each excerpt with its note (clear, LLM-friendly format, e.g. quoted excerpt blocks followed by the comment), and submits it as input to the session's Claude (the same way the chat composer sends a message). After sending, the note list is cleared. Notes should survive tab-switching/preview-tab changes within the session (in-memory + sessionStorage-level persistence is fine; no server-side storage required unless trivially easy).

3. **Fix: files sheet loses state when the browser tab is backgrounded.** On mobile, opening a file in the files sheet, switching to another app/browser tab, and returning closes the files sheet (or resets it), forcing the user to reopen the sheet, re-navigate the tree, and re-find their scroll position. Diagnose why (likely the reconnect/visibilitychange/SSE-reconnect flow re-rendering or resetting overlay state, or a page reload losing state). Fix so that on return, the files sheet is still open on the same file, same tab (Edit/Preview), and scroll position is restored (or at minimum the same file reopens at the same scroll offset if the page itself was reloaded by the OS — persist open-file + scroll + active tab to sessionStorage and restore on load).

4. **Listen to a markdown file (text-to-speech).** Add a play/stop button to the markdown Preview toolbar so the user can listen to the document being read aloud (e.g. listening to a story instead of reading it). Use the browser's built-in Web Speech API (`speechSynthesis`) — no new dependencies, no server-side TTS. Requirements: (a) play button starts reading the rendered document's text content (strip markdown syntax — read the preview text, not raw source; skip code blocks or read them briefly, skip image alt clutter); (b) button toggles to stop while playing; stopping cancels speech immediately; (c) highlight or indicate the paragraph/section currently being read if feasible (via utterance boundaries per paragraph — speak paragraph-by-paragraph so progress indication and long-text reliability come for free); (d) handle iOS Safari quirks: speech must start from a user gesture, long utterances get cut off (hence per-paragraph chunking with sequential utterances), and speech pauses/cancels when the tab is backgrounded — recover gracefully (resume or reset to a stopped state, no stuck UI); (e) if a text selection is active, offer to start reading from that point, otherwise start from the top; (f) closing the file or the sheet stops speech.\n\nconstraints: Must work well on iOS Safari mobile — test selection UX and visibility/bfcache restore paths there conceptually and via headless Playwright where possible. Preserve the existing OverlayHistory back-button/swipe-back integration for the files sheet (back closes file then tree then sheet) — the new open-from-transcript path must also register with OverlayHistory. Do not break the HTML preview tab, image/binary previews, or dirty-file save guard. Sending notes must use the existing session input path with proper submit semantics. No new heavyweight dependencies; reuse vendored CodeMirror/markdown-it/dompurify stack. Sanitize any note/excerpt content rendered to DOM. Keep the review-notes feature markdown-Preview-scoped for now (not the code editor).
affected_area: frontend
work_item_id: wi-0c9b0b8a
fix_cycles: 1
test_fix_cycles: 0

## Root Cause / Spec

All work is in `src/web/public/` (`app.js`, `index.html`, `styles.css`) plus one small
build-input file (`scripts/vendor/editor-entry.mjs`) only if the markdown renderer needs
a change. No backend change is required — every endpoint and the input path already exist.

### Landscape (what exists today)

**OLD file viewer (to retire)** — `app.openFilePreview()` at `app.js:19592-19638`, plus
`closeFilePreview()` `app.js:19640-19646`, `copyFilePreviewContent()` `app.js:19648-19657`,
field `filePreviewContent` `app.js:19377`, markup `#filePreviewOverlay` at
`index.html:445-458`, CSS `.file-preview-*` in `styles.css`. It is a read-only 500-line
`<pre>` modal with no OverlayHistory registration, no markdown preview, no editing.
Callers (exactly three):
- `app.js:510` — transcript inline-code file link click (`linkifyFilePaths`)
- `app.js:515` — same, Enter/Space keydown
- `app.js:19485` — desktop `#fileBrowserPanel` tree row click (`renderFileBrowserTree`)
No test references `openFilePreview` / `filePreviewOverlay` (grep over `test/` is empty).

**File-editor v2 (the target surface)** — the "files sheet", `app.js:19661-20290`:
- `openFilesSheet()` `19666` — inits `filesState`, shows `#filesSheet`/`#filesSheetBackdrop`,
  resets title/back button, `_filesShowTree()`, `filesLoadTree()`, `_filesEnsureVendor()`,
  `OverlayHistory.push('files-sheet', …)`.
- `_filesEnsureVendor()` `19691` — lazy-loads `vendor/editor.min.js`
  (built by `scripts/build.mjs:49` from `scripts/vendor/editor-entry.mjs`), exposing
  `window.CodemanEditor` (CodeMirror adapter) and `window.CodemanMarkdown.render()`
  (markdown-it `html:false` + DOMPurify). Fire-and-forget; resolves `false` on failure.
- `filesOpenFile(path)` `19882` — pushes `OverlayHistory.push('files-file', …)`, GETs
  `/api/sessions/:id/file-content?path=…&lines=10000`, routes image/video/binary to
  `_filesRenderBinary()` `19936`, else sets `filesState.current` and calls `_filesRenderView()`.
- `_filesRenderView()` `19965` — the Preview renderer. `isMd = /\.(md|markdown)$/i`,
  `isHtml = /\.html?$/i`; HTML → sandboxed `<iframe srcdoc>`; md → `window.CodemanMarkdown.render()`
  into `<div class="files-md-preview">`; else escaped `<pre>`. For md/html it renders the
  `Preview | Edit | Copy` action row into `#filesSheetViewActions` (`app.js:20023`).
  **Markdown already defaults to Preview** — the only gap is that `filesOpenFile` does not
  await `_filesEnsureVendor()`, so a first open before the bundle lands falls back to `<pre>`.
- `filesStartEdit()` `20030`, `filesSave()` `20088` (mtime-conflict → `_filesShowConflict` `20116`),
  `filesCancelEdit()` `20068`, `filesCopyCurrent()` `20079`.
- Back-stack contract: `OverlayHistory` (`app.js:581-636`) with entries `files-sheet`
  (close sheet) and `files-file` (file → tree). Dirty guard lives in
  `_filesSheetCloseFromHistory()` `19732` and `_filesBackFromHistory()` `19744`.
- Scroll container is `#filesSheetViewContent` (`styles.css:13023`, `overflow:auto`).
- The sheet has **no** media query — it works on desktop too, so it is a valid target
  for the desktop file-browser click path as well.

**Session input path (chat composer)** — `InputPanel.send()` `app.js:22227` →
`_sendInner()` `22233`. It: scans with `SecretDetector` (`22273`), captures
`app.activeSessionId` **before** any await (`22287`), appends `'\r'`, optimistically calls
`TranscriptView.appendOptimistic()` + `TranscriptView.setWorking(true)` +
`app._updateTabStatusDebounced(id,'busy')`, then fires `app.sendInput(inputString, sid)`
(`22338`) without awaiting, with a 3s "Enter was dropped" re-send poller.
`app.sendInput(input, sessionId)` `app.js:11663` POSTs
`/api/sessions/:id/input` with `{ input, useMux: true }`.
Server: `src/web/routes/session-routes.ts:676-736`; `MAX_INPUT_LENGTH = 64 * 1024`
(`src/config/terminal-limits.ts:12`); `useMux` → `session.writeViaMux()` →
`TmuxManager.sendInput()` (`src/tmux-manager.ts:1328`) → `planSendKeys()`
(`src/utils/tmux-send-keys-plan.ts`), which maps **`\n` → `C-j` (newline inside Ink's
buffer)** and **`\r` → Enter (submit)**. So a multi-line notes message is safe — but each
line costs one `tmux send-keys` exec + 50ms settle, so keep the message compact.

**Existing TTS** — `TranscriptTTS` `app.js:3045-3170`: `_stripMarkdown()` `3053`,
`_speakEdge()` (POST `/api/tts`, Edge voice) `3095`, `_speakWeb()` (`SpeechSynthesisUtterance`)
`3111`, `_stop()` `3132`, generation counter `_gen` to cancel superseded speech.
Useful prior art but it speaks one blob and is bound to a transcript button; the doc
reader needs per-block sequencing.

---

### Part 3 — root cause of the files-sheet reset (diagnosed, deterministic)

`selectSession()` `app.js:9831` force-closes the files sheet at `9834-9840`:

```js
async selectSession(sessionId) {
  if (this.activeSessionId === sessionId) return;      // 9832 — identity early-return
  if (OverlayHistory.has('files-sheet')) {             // 9834
    this._doCloseFilesSheet();
    if (OverlayHistory.has('files-file')) OverlayHistory.pop('files-file');
    OverlayHistory.pop('files-sheet');
  }
```

`handleInit()` re-selects the previously active session at `app.js:9141-9150`:

```js
const previousActiveId = this.activeSessionId;
this.activeSessionId = null;                          // 9143  ← defeats the 9832 guard
…
this._sseReconnectRestoreId = …;
this.selectSession(restoreId);                        // 9150  restoreId === previousActiveId
```

Because `activeSessionId` is nulled first, the identity early-return at `9832` cannot fire
on a same-session restore, so the sheet is force-closed on **every** `handleInit()`.
`handleInit()` runs on (a) the SSE `INIT` event after any reconnect and (b)
`loadState()` (`app.js:9172`) which `_onTabVisible()` calls at `app.js:8871` every time the
tab becomes visible. Hence: background the tab → return → sheet closes, tree resets,
`filesState.current` is nulled by `_doCloseFilesSheet()` `19709`. Exactly the reported bug.
(iOS also frequently discards and reloads the page outright — that path needs the
sessionStorage restore below; nothing today persists sheet state, grep for `sessionStorage`
in `app.js` returns zero hits.)

---

### Implementation plan

#### Part 1 — every file open goes through file-editor v2

1. Add `async openFileInEditor(path, opts = {})` next to the files-sheet block
   (after `openFilesSheet()`, ~`app.js:19690`):
   - guard `this.activeSessionId` (toast + return if absent);
   - `FeatureTracker.track('file-open-editor')`;
   - open the **sheet shell** and then the file so the back stack is
     `files-sheet` → `files-file` (back = file → tree → close), satisfying the constraint.
     Refactor `openFilesSheet()` `19666` into:
     - `_filesOpenSheetShell()` — everything except `_filesShowTree()` + `filesLoadTree()`
       (state init, DOM show, hidden checkbox, title reset, `_filesEnsureVendor()`,
       `OverlayHistory.push('files-sheet', …)`). `push()` top-dedupes, so opening while
       already open is a no-op and does not double-push.
     - `openFilesSheet()` = `_filesOpenSheetShell()` + `_filesShowTree()` + `filesLoadTree()`.
     - `openFileInEditor()` = `_filesOpenSheetShell()` + `this.filesLoadTree()`
       (fire-and-forget so Back lands on a populated tree) + `await this._filesEnsureVendor()`
       + `await this.filesOpenFile(path)`.
   - **Await `_filesEnsureVendor()` before `filesOpenFile()`** so markdown lands in
     Preview (rendered), not the `<pre>` fallback, on a cold open. Do the same in
     `filesOpenFile()` itself (cheap: the promise is cached) so the files-sheet path also
     stops racing the bundle.
   - If the sheet is already open on a different file with `filesState.current.dirty`,
     run the same `confirm('Discard unsaved changes?')` guard used by
     `filesSheetBack()` `19775` before switching files; abort on cancel.
2. Repoint the three call sites to `app.openFileInEditor(path)`:
   `app.js:510`, `app.js:515`, `app.js:19485`.
   Update the `linkifyFilePaths` doc-comment at `app.js:479-484` (it names
   `app.openFilePreview(path)`).
3. Delete the old path: `openFilePreview()` `19592-19638`, `closeFilePreview()`,
   `copyFilePreviewContent()`, the `filePreviewContent` field `19377`, the
   `#filePreviewOverlay` markup `index.html:445-458`, and the now-dead `.file-preview-*`
   CSS rules in `styles.css`. Keep `FeatureRegistry` id `file-browser-file-click`
   (`feature-registry.js:62`) — just update its description; add a `file-open-editor`
   entry if a new track id is used.
4. Path shape: transcript links pass the raw inline-code text, which
   `_checkFilePathExists()` `app.js:462` already validated against the same
   `/file-content` endpoint `filesOpenFile()` uses, so no normalization is needed.

#### Part 2 — markdown review notes

State (in `filesState`, mirrored to sessionStorage):
```js
filesState.notes = Map<path, Array<{ id, excerpt, occurrence, note, createdAt }>>
```
`occurrence` = 0-based index of the exact `excerpt` string within the preview's
`textContent`, so highlights survive a re-render. Persist under
`sessionStorage['codeman-review-notes:' + sessionId]` as a plain object; load lazily on
first `filesOpenFile` of a md file; wrap all sessionStorage access in try/catch
(Safari private mode throws).

- **Selection affordance** (`_filesInstallNoteSelection()`, bound once per rendered
  `.files-md-preview`): listen to `selectionchange` on `document` (debounced ~120ms) plus
  `pointerup`/`touchend` on the preview. When the selection is non-collapsed and
  `preview.contains(sel.anchorNode)`, position a floating `<button class="files-note-pill">`
  (appended to `#filesSheetView`, `position:absolute`) from
  `sel.getRangeAt(0).getBoundingClientRect()`, clamped to the sheet. Bind on
  `pointerdown` with `e.preventDefault()` so iOS does not collapse the selection before
  the handler runs; read `window.getSelection().toString()` inside the handler.
  Also add a persistent `Note` button to the md Preview action row
  (`_filesRenderView()` `app.js:20023`) that captures the current selection — the required
  iOS fallback when the pill is dismissed by the native callout.
- **Dialog** — clone the existing in-sheet dialog pattern `_filesShowCreateDialog()`
  `app.js:20173` (overlay + `.files-create-dialog`, Enter/Escape keys, backdrop click).
  New `_filesShowNoteDialog({ excerpt, id })`: excerpt shown read-only via
  **`textContent`** (never `innerHTML`), a `<textarea>` for the comment, Save/Cancel.
  Reused for edit (prefilled) and add.
- **Review panel** — a collapsible drawer inside `#filesSheetView` toggled by a
  `Notes (N)` button in the md Preview action row. Each row: excerpt (truncated, via
  `textContent`/`escapeHtml`) + note + Edit/Delete. Footer: `Send notes` + `Clear all`.
  Only rendered when `isMd && !cur.editing`.
- **Highlighting** — after `_filesRenderView()` injects the sanitized HTML, run
  `_filesApplyNoteHighlights()`: `TreeWalker` over text nodes of `.files-md-preview`,
  match each note's `excerpt` at its `occurrence`, and wrap with
  `<mark class="files-md-note" data-note-id="…">` via `Range.surroundContents()`.
  Skip (silently) matches that span element boundaries — a known limitation; the note
  still exists in the list. Clicking a `<mark>` scrolls the panel to that note.
  Re-apply on every re-render (`_filesRenderView`) and after add/edit/delete.
- **Send notes** (`filesSendNotes()`), mirroring `InputPanel._sendInner()`:
  ```
  Review notes on `<path>`:

  1. > <excerpt line 1>
     > <excerpt line 2>
     — <note>

  2. …
  ```
  - Capture `const sid = this.activeSessionId` **before** any await (same reason as
    `app.js:22287`).
  - Truncate each excerpt to ~400 chars with `…`; hard-cap the whole message well under
    `MAX_INPUT_LENGTH` (64 KB) — if over, toast and refuse rather than silently truncate.
  - Cap the line count (each `\n` is a tmux exec + 50ms); if a message would exceed ~60
    lines, collapse each excerpt to a single line.
  - Run `SecretDetector.scan(sid, msg)` when `SecretDetector.isEnabled()` and use the
    redacted text (same as `app.js:22273`).
  - `await this.sendInput(msg + '\r', sid)` (this is the `useMux:true` path;
    `\n` → `C-j`, trailing `\r` → Enter).
  - Optimistic UI: `TranscriptView.appendOptimistic(msg)` + `setWorking(true)` +
    `_updateTabStatusDebounced(sid,'busy')` **only if** `TranscriptView._sessionId === sid`.
  - **Clear the note list for that path only on success** (rollback/keep on throw so
    notes are never lost); re-render preview to drop highlights; toast.
  - Do NOT reuse `InputPanel.send()` — it would clobber the user's draft textarea.
- Notes must survive Edit⇄Preview tab flips: they live in `filesState.notes` +
  sessionStorage, not in the DOM. `_filesDestroyEditor()` / `filesStartEdit()` must not
  touch them. Feature is **Preview-only** (constraint) — hide the pill and Note/Notes
  buttons while `cur.editing`.

#### Part 3 — files-sheet survives backgrounding

1. **Stop the force-close on a same-session restore.**
   - Change the signature to `async selectSession(sessionId, opts = {})` and guard
     `app.js:9834` with `if (!opts.preserveFilesSheet && OverlayHistory.has('files-sheet'))`.
   - At `app.js:9150`, call
     `this.selectSession(restoreId, { preserveFilesSheet: restoreId === previousActiveId })`.
     (`previousActiveId` is already captured at `9141`.) All other call sites are
     unaffected — a genuine user tab switch still closes the sheet, as intended.
   - Also verify no other `handleInit()` teardown touches the sheet: `MobileDetection` /
     `KeyboardHandler` / `SwipeHandler` cleanup+init at `app.js:8948-8955` do not, and
     `closeAllPanels()` (`app.js:6760`) is Escape-only.
2. **sessionStorage persistence (OS-reload / bfcache path).**
   - Key: `codeman-files-sheet:<sessionId>`; value
     `{ open, path, mode: 'preview'|'edit', scrollTop, expanded: string[], activeDir }`.
   - Write (`_filesPersistState()`, try/catch) on: sheet open/close, `filesOpenFile`,
     `_doFilesBackToTree`, Preview⇄Edit switch, and a **passive, ~250ms-throttled**
     `scroll` listener on `#filesSheetViewContent`.
   - Restore (`_filesRestoreState()`): after the first successful `handleInit()` selection
     settles, if the stored entry for the active session has `open:true`, call
     `openFileInEditor(path)` (or `openFilesSheet()` if no path). Never restore into
     `edit` mode — unsaved content is not persisted, so restore to Preview/read
     (dirty-file save guard is thereby preserved).
   - Restore scroll after render with a double `requestAnimationFrame` (CodeMirror /
     markdown layout settles a frame late); for md also re-apply note highlights first so
     offsets are final.
   - Add a `pageshow` listener (`event.persisted` → bfcache) that re-applies `scrollTop`
     without re-fetching.
3. Never persist file **content** (secrets-safety comment at `app.js:19657-19660`) — only
   the path, mode, scroll offset and tree expansion.

#### Part 4 — listen to a markdown file (TTS)

New `FilesTTS` singleton in `app.js` (place next to `TranscriptTTS` `3045` or in the files
block), **Web Speech only** per the scope note (`/api/tts` exists but is out of scope):

- **Blocks**: read the rendered preview, not raw markdown. Query
  `.files-md-preview > h1,h2,h3,h4,h5,h6,p,li,blockquote,td` in document order; take
  `el.textContent.trim()`; skip empties and `pre`/`code` blocks entirely (per scope: skip
  code); skip `img` alt text (images contribute no textContent, so this is free).
  Split any block longer than ~300 chars on sentence boundaries — iOS Safari truncates
  long utterances.
- **Sequential playback**: one `SpeechSynthesisUtterance` per chunk, `onend` advances to
  the next. A `_gen` counter (copy `TranscriptTTS._gen` `app.js:3049`) invalidates
  callbacks after stop/supersede.
- **Toolbar button** in the md Preview action row (`_filesRenderView()` `20023`):
  `▶ Listen` ⇄ `■ Stop`; toggling stop calls `speechSynthesis.cancel()` and clears the
  highlight immediately. Must be started from the click handler synchronously — iOS
  requires the first `speak()` inside the user gesture, so do **not** await anything
  before the first `speak()`.
- **Progress indication**: add `.files-md-speaking` to the current block element on
  utterance `start`, remove on `end`; `scrollIntoView({block:'nearest'})` when the block
  is off-screen. Reuse `<mark>`-independent styling so it composes with note highlights.
- **Start from selection** (scope e): if a non-collapsed selection exists inside the
  preview when Listen is pressed, start at the block containing `sel.anchorNode`
  (`closest()` up to the block list), else block 0.
- **iOS/backgrounding**: `visibilitychange` → on hidden, `speechSynthesis.pause()`;
  on visible, if we believe we are playing, `resume()` and, if `!speaking && !paused`
  after a short tick, hard-reset the UI to Stopped (no stuck button). Chrome's ~15s
  auto-pause is handled by the same resume tick. Also stop on
  `_doFilesBackToTree()` `19717`, `_doCloseFilesSheet()` `19709`, `filesOpenFile()`
  (new file), `filesStartEdit()`, and session switch in `selectSession()`.
- Feature-detect `'speechSynthesis' in window`; hide the button when absent.

---

### Constraints / regression surface

- HTML preview (`_filesRenderView` `20000-20015`, sandboxed `<iframe srcdoc>`, no
  `allow-same-origin`) and image/video/binary previews (`_filesRenderBinary` `19936`)
  must be untouched — the notes/TTS UI is gated on `isMd && !htmlPreview && !cur.editing`.
- Dirty-file save guard: `filesSheetBack()` `19775`, `closeFilesSheet()` `19754`,
  `_filesSheetCloseFromHistory()` `19732`, `_filesBackFromHistory()` `19744` must keep
  their `confirm()`; the new `openFileInEditor()` adds the same guard when replacing an
  open dirty file.
- OverlayHistory ordering is `files-sheet` then `files-file`; `push()` top-dedup
  (`app.js:591`) makes re-open idempotent. Do not push a third entry for the note dialog —
  close it with Escape/backdrop like `_filesCloseCreateDialog()` `20261`.
- All note/excerpt text into the DOM via `textContent` or `escapeHtml()`
  (`constants.js:421`); markdown continues through `window.CodemanMarkdown.render()`
  (markdown-it `html:false` + DOMPurify, `scripts/vendor/editor-entry.mjs`). No new deps.
- New CSS classes to add in `styles.css` near the existing `.files-md-preview` block
  (~`13092`): `.files-note-pill`, `.files-md-note`, `.files-notes-panel`,
  `.files-notes-row`, `.files-md-speaking`.

### Test hooks

- `test/files-html-preview.test.ts` replicates `_filesRenderView()` / `filesStartEdit()` /
  `_filesRenderBinary()` / `filesOpenFile()` in jsdom and has **source-text guards that
  read `src/web/public/app.js` verbatim** — any change to those methods must be mirrored
  in that replica or the suite fails.
- `test/overlay-history.test.ts` covers the push/pop/clear contract; the new
  `openFileInEditor` back-stack should be added there.
- `test/file-link-click.test.ts` and `test/file-path-detection.test.ts` cover the
  transcript link path (they do not reference `openFilePreview`, so retiring it is safe).

## Fix / Implementation Notes

### Part 1 — every file open goes through file-editor v2
- `openFilesSheet()` split into `_filesOpenSheetShell()` (state init, DOM show, hidden
  checkbox, title reset, `_filesEnsureVendor()`, `OverlayHistory.push('files-sheet')`,
  `_filesInstallScrollPersist()`; returns `false` when there is no active session) and
  `openFilesSheet()` = shell + `_filesShowTree()` + `filesLoadTree()` + persist.
- New `async openFileInEditor(path, opts)`: session guard, `FeatureTracker.track('file-open-editor')`,
  dirty-file `confirm('Discard unsaved changes?')` when replacing a *different* open dirty file,
  shell, fire-and-forget `filesLoadTree()` (so Back lands on a populated tree),
  `await _filesEnsureVendor()`, `await filesOpenFile(path)`, optional scroll restore.
  Back stack is therefore `files-sheet` → `files-file`, unchanged from the sheet path.
- `filesOpenFile()` now also `await this._filesEnsureVendor()` before the fetch (cached
  promise, so free after the first open) — a cold open no longer races the bundle into the
  escaped-`<pre>` fallback, i.e. markdown really does land in Preview.
- Three call sites repointed to `openFileInEditor`: `linkifyFilePaths` click + keydown, and the
  desktop `#fileBrowserPanel` tree row. `linkifyFilePaths` doc-comment updated.
- Deleted: `openFilePreview()`, `closeFilePreview()`, `copyFilePreviewContent()`, the
  `filePreviewContent` field, `#filePreviewOverlay` markup in `index.html`, and the whole
  `.file-preview-*` CSS block. `grep` over `src/web/public` for `openFilePreview|filePreviewOverlay|file-preview`
  is now empty. `feature-registry.js`: `file-browser-file-click` description updated, new
  `file-open-editor` entry added.

### Part 2 — markdown review notes
- State: `filesState.notes` = `{ [path]: [{ id, excerpt, occurrence, note, createdAt }] }`,
  mirrored to `sessionStorage['codeman-review-notes:'+sessionId]`, every access in try/catch
  (Safari private mode throws). Lives outside the DOM, so Edit⇄Preview flips keep it.
- Selection affordance: `_filesInstallNoteSelection()` binds once — debounced (120ms)
  `selectionchange`, plus `pointerup`/`touchend` on `#filesSheetView`, plus a delegated click
  that maps a `<mark>` back to its panel row. `_filesUpdateNotePill()` positions
  `.files-note-pill` from `getRangeAt(0).getBoundingClientRect()`, clamped to the sheet, flipped
  below the selection when there is no room above. The pill is bound on **`pointerdown` with
  `preventDefault()`** and reads the selection synchronously — iOS collapses the selection
  before a `click` would fire. Toolbar `Note` button (`filesAddNoteFromSelection()`) is the
  iOS fallback when the native callout covers the pill.
- Dialog: `_filesShowNoteDialog()` clones the `_filesShowCreateDialog()` chrome
  (`.files-create-overlay` / `.files-create-dialog`), backdrop-click + Escape close, Cmd/Ctrl+Enter
  saves. Excerpt is injected with **`textContent`**, never `innerHTML`. Same dialog is reused
  for edit (prefilled from the stored note). No OverlayHistory entry is pushed for it.
- Panel: `.files-notes-panel` appended to `#filesSheetView`, toggled by the `Notes (N)` toolbar
  button. Rows use `escapeHtml()` for both excerpt and note; footer has `Clear all` + `Send notes`.
- Highlights: `_filesApplyNoteHighlights()` → `_filesHighlightExcerpt()` walks text nodes with a
  `TreeWalker`, counts occurrences to reach `note.occurrence`, and wraps with
  `<mark class="files-md-note" data-note-id>` via `Range.surroundContents()`. Excerpts that
  cross element boundaries throw and are skipped silently (note still listed). Verified in a
  jsdom harness: correct occurrence selection, boundary-crossing case skipped without throwing.
  **Superseded in fix cycle 2** — see finding 3 below: matching now runs over a
  whitespace-normalised projection and is applied per text node, so hard-wrapped and
  boundary-crossing excerpts both highlight.
- `filesSendNotes()`: captures `const sid = this.activeSessionId` **before any await**, builds one
  numbered message (`Review notes on \`path\`:` + quoted excerpt blocks + `— note`), collapses each
  excerpt to a single line when the message would exceed ~60 lines (each `\n` is a tmux exec),
  truncates excerpts to 400 chars / notes to 800, refuses (toast) above 32 000 chars, runs
  `SecretDetector.scan(sid, msg)` when enabled, does optimistic `TranscriptView.appendOptimistic`
  + `setWorking(true)` + `_updateTabStatusDebounced` gated on `TranscriptView._sessionId === sid`,
  then `await this.sendInput(msg + '\r', sid)` (the `useMux:true` path). Notes are cleared **only
  on success** — a throw keeps them, since they are the user's only copy. It deliberately does not
  reuse `InputPanel.send()`, which would clobber the draft textarea.
- Gating: the Note/Notes buttons, the pill and the highlights only render for `isMd && !htmlPreview`
  in `_filesRenderView()`; `filesStartEdit()`, `_doFilesBackToTree()` and `_doCloseFilesSheet()`
  tear the UI down (`_filesTeardownNotesUi()`), leaving the note *data* intact.

### Part 3 — files sheet survives backgrounding
- Root cause fixed: `selectSession(sessionId, opts = {})`; the force-close block is now
  `if (!opts.preserveFilesSheet && OverlayHistory.has('files-sheet'))`, and `handleInit()`'s
  same-session restore calls
  `this.selectSession(restoreId, { preserveFilesSheet: restoreId === previousActiveId })`.
  A genuine user session switch still closes the sheet (and stops speech).
- sessionStorage persistence under `codeman-files-sheet:<sessionId>`:
  `{ open, path, mode:'preview', scrollTop, expanded[], activeDir }`. Written by
  `_filesPersistState()` on sheet open, `filesOpenFile`, `_doFilesBackToTree`, tree-folder toggle,
  and a **passive, 250ms-throttled** `scroll` listener on `#filesSheetViewContent`; cleared by
  `_filesPersistClosed()` from `_doCloseFilesSheet()`. **File content is never persisted.**
- `_filesRestoreState()` runs once per page load, at the tail of `handleInit()` behind
  `_filesRestoreAttempted`, so a live reconnect (which now preserves the sheet) never re-enters it.
  It restores tree expansion + activeDir, then `openFileInEditor(path, { scrollTop })`, or
  `openFilesSheet()` when the sheet was on the tree. Mode is always restored to Preview —
  unsaved editor content is not persisted, so reopening into Edit would be lossy; this also keeps
  the dirty-file save guard meaningful.
- Scroll restore uses a double `requestAnimationFrame` (markdown/CodeMirror layout settles a
  frame late, so a same-frame `scrollTop` is clamped to 0), and a `pageshow` listener re-applies
  `scrollTop` on `event.persisted` (bfcache) without re-fetching.

### Part 4 — markdown Preview text-to-speech
- New `FilesTTS` singleton next to `TranscriptTTS`, Web Speech only (`/api/tts` deliberately not
  used — per-block sequencing is what makes progress highlighting and iOS reliability work).
- `collectChunks()` reads the **rendered** preview: `h1..h6,p,li,blockquote,td` in document order,
  `pre`/code skipped entirely, and `_ownText()` takes each element's own text minus any nested
  block, so a `<li>` wrapping a nested `<ul>` (or a `<blockquote>` wrapping `<p>`) is neither
  read twice nor silently dropped. Blocks longer than ~300 chars split on sentence boundaries,
  with a hard 400-char slice for punctuation-free runs.
- `_split()` is written **without a lookbehind assertion** — older iOS Safari throws on those at
  parse time, which would take the whole bundle down.
- Sequential playback: one utterance per chunk chained on `onend`; `onerror` skips to the next
  rather than stranding the document; a `_gen` counter invalidates callbacks after stop/supersede.
- `filesToggleListen()` runs fully synchronously to `speechSynthesis.speak()` — iOS only permits
  the first utterance inside the originating user gesture. Button is `▶ Listen` ⇄ `■ Stop`
  (`filesListenBtn`), feature-detected via `FilesTTS.supported` so it is absent when
  `speechSynthesis` is missing.
- Progress: `.files-md-speaking` on the current block, `scrollIntoView({block:'nearest'})` only when
  the block is off-screen; styling composes with the note `<mark>`s.
- Start-from-selection: a non-collapsed selection inside the preview starts at the block containing
  its anchor, otherwise block 0.
- Backgrounding: a single `visibilitychange` listener pauses on hidden, resumes on visible, and
  after a 600ms tick hard-resets to Stopped if the engine is neither speaking, pending nor paused —
  no stuck Stop button. (Same tick covers Chrome's ~15s auto-pause.)
- Speech is stopped from `_doCloseFilesSheet()`, `_doFilesBackToTree()`, `filesOpenFile()`,
  `filesStartEdit()` and the session-switch branch of `selectSession()`.

### Regression surface / verification
- `test/files-html-preview.test.ts`: mirrored the new `_filesRenderView()` tail
  (`cur.editing = false` + md-only `_filesRenderMdTools()`) into the jsdom replica, added a
  `_filesRenderMdTools` stub, updated the markdown toolbar expectation to
  `['Preview','Edit','Copy','Note','Notes (0)']` and added a guard that the HTML path gets no
  `Note` button. All source-text guards still hold verbatim: the `isHtml`/`htmlPreview`/tab-condition
  lines and the sandbox/srcdoc contract are untouched, `_filesRenderView` and `filesStartEdit`
  still contain no `OverlayHistory`, and `OverlayHistory.push('files-file'` still appears exactly
  twice (`openFileInEditor` goes through `filesOpenFile`, it does not push its own entry).
- HTML preview, image/video/binary previews and the dirty-file save guard are untouched; the
  notes/TTS UI is gated on `isMd && !htmlPreview`.
- Verified: `node --check src/web/public/app.js`, `npx tsc --noEmit`, and
  `npx vitest run test/files-html-preview.test.ts test/overlay-history.test.ts
  test/file-link-click.test.ts test/file-path-detection.test.ts` (112 passed), plus
  `busy-indicator-session-switch` / `input-draft-race` / `transcript-session-isolation`
  (131 passed together). Two jsdom harnesses were used ad hoc (not committed) to smoke-test
  `FilesTTS.collectChunks/_split` and `_filesHighlightExcerpt`.
- New CSS in `styles.css` near `.files-md-preview`: `.files-note-pill`, `mark.files-md-note`,
  `.files-md-speaking`, `.files-notes-panel/-head/-list/-empty/-row/-excerpt/-note/-actions/-foot`,
  `.files-note-excerpt`, `.files-note-input`; `.files-sheet-view` gained `position: relative`
  as the pill's positioning context.

### Fix cycle 2 — review attempt 1 findings addressed

1. **Cross-session note bleed (blocking).** `filesState` now carries
   `notesSessionId`. `_filesNotesAll()` reloads from sessionStorage whenever
   `notesSessionId !== activeSessionId` (not just when the cache is falsy), and
   `_filesPersistNotes()` refuses to write when they differ, so one session's
   notes can never be stored under another's key. In addition `selectSession()`
   nulls `filesState.notes` / `filesState.notesSessionId` immediately after the
   `activeSessionId === sessionId` early-return — **outside** the
   `!opts.preserveFilesSheet` block, so it runs on the SSE-reconnect path too.
   The in-memory cache is never ahead of storage (`_filesPersistNotes()` runs on
   every mutation), so dropping it is lossless.
2. **Scroll reset on every note operation (blocking).** Two layers:
   - `_filesRenderView()` captures `content.scrollTop` into `keepScroll` when it
     is re-rendering the *same* path in Preview (`this._filesRenderedPath === cur.path
     && !cur.editing`) and reassigns it after the render. `filesOpenFile()` sets
     `_filesRenderedPath = null` so a freshly loaded document still starts at the
     top (or at the restored `opts.scrollTop`), and a return from Edit also starts
     at the top. Content height is unchanged by the re-render, so no rAF is needed.
   - The note paths no longer re-render the document at all. New
     `_filesRefreshNotesUi()` updates the `Notes (N)` button (now `id="filesNotesBtn"`)
     in place and re-renders only the panel; `_filesUnwrapHighlights(id?)` removes
     `<mark>`s in place (and `normalize()`s the parent). `filesToggleNotesPanel()`,
     `_filesOpenNotesPanel()`, `filesDeleteNote()`, `filesClearNotes()` and the
     `filesSendNotes()` tail all use these instead of `_filesRenderView()`;
     `_filesSaveNote()` highlights just the newly added note via
     `_filesHighlightExcerpt()`. `_filesScrollToNote()` inherits the fix through
     `_filesOpenNotesPanel()`.
3. **Highlights on hard-wrapped prose.** `_filesHighlightExcerpt()` was rewritten
   around a new `_filesTextProjection(preview)`, which builds a whitespace-normalised
   string plus a per-character `{ node, offset }` map over the preview's text nodes
   (skipping nodes already inside a highlight, and treating a change of block
   ancestor as whitespace because `Selection.toString()` breaks lines between
   blocks). The excerpt is matched in that projection, then applied one text node
   at a time (back-to-front, so an earlier slice's offsets stay valid), so
   `surroundContents()` only ever sees a single-text-node range. This also removes
   the documented "spans element boundaries" limitation — cross-`<em>` and
   cross-paragraph excerpts now highlight as multiple `<mark>`s sharing the note id.
   `_filesSelectionOccurrence()` now normalises the prefix with the same
   `\s+ → ' '` rule so the occurrence index means the same thing at capture and at
   highlight time; an occurrence that no longer exists falls back to the first match.
   Smoke-tested in a throwaway jsdom harness (hard-wrapped, cross-element,
   cross-block, occurrence 0/1, no-match, unwrap-one/unwrap-all).
4. **Dirty guard hole.** `openFileInEditor()` dropped the `cur.path !== path`
   condition — `filesOpenFile()` re-fetches from disk, so re-opening the file you
   are editing must prompt too.
5. **OverlayHistory double-push.** `_filesOpenSheetShell()` now pushes `files-sheet`
   only when `!OverlayHistory.has('files-sheet')`.
6. **Stale TTS block refs.** New `FilesTTS.rebind(preview)` re-collects the chunks
   and re-anchors `_index` by matching the currently-spoken chunk text, then
   re-applies `.files-md-speaking`. `_filesRenderView()` calls it when
   `FilesTTS.isPlaying()`. (With finding 2 fixed, note operations no longer
   re-render at all; this covers the Preview-tab re-entry path.)
7. **Send failure rollback.** The `catch` in `filesSendNotes()` now calls
   `TranscriptView.setWorking(false)` (gated on `TranscriptView._sessionId === sid`)
   and `_updateTabStatusDebounced(sid, 'idle')` before toasting.
8. **Dead branch removed.** The `oneLine` / `estimatedLines` multi-line-quoting
   logic is gone; excerpts are always single-line, so the builder just emits
   `'   > ' + excerpt`.

**Test mirror + verification.** `test/files-html-preview.test.ts`: the jsdom replica of
`_filesRenderView()` mirrors `keepScroll` / `_filesRenderedPath`, and `_filesRenderMdTools()`
mirrors the new `id="filesNotesBtn"`. Five new source guards were added — scroll
preservation, "note paths never call `_filesRenderView()`", session-scoped notes cache
(including the ordering assertion that the invalidation precedes the `preserveFilesSheet`
branch), the `openFileInEditor` dirty guard + `has('files-sheet')` push guard, and the
send-failure rollback. Verified: `node --check src/web/public/app.js` OK, `npx tsc --noEmit`
clean, `npx vitest run test/files-html-preview.test.ts test/overlay-history.test.ts
test/file-link-click.test.ts test/file-path-detection.test.ts` → **4 files / 117 tests passed**
(112 before + 5 new). No CSS changes were needed.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — REJECTED

**Verified independently (all claims hold):**
- `node --check src/web/public/app.js` → OK.
- `npx vitest run test/files-html-preview.test.ts test/overlay-history.test.ts test/file-link-click.test.ts test/file-path-detection.test.ts` → **4 files / 112 tests passed**, matching the implementation notes.
- `grep -rn 'openFilePreview|filePreviewOverlay|file-preview|filePreviewContent|closeFilePreview|copyFilePreviewContent'` over `src/ test/ scripts/` → **zero hits**. `.binary-message` (only used by the old modal) is also gone from both CSS and JS. The CSS diff removes nothing outside the `.file-preview-*` block.
- All three call sites repointed (`linkifyFilePaths` click + keydown, desktop `#fileBrowserPanel` row); the `linkifyFilePaths` doc-comment is updated; `feature-registry.js` gains `file-open-editor` and rewords `file-browser-file-click`.
- Security: dialog excerpt goes in via `textContent`; panel rows use `escapeHtml()` on excerpt, note and the internally-generated id; `srcdoc`/`sandbox=""` contract and `_filesRenderBinary` are untouched; no file **content** is persisted to sessionStorage (only user-selected excerpts, which the spec sanctions).
- `filesSendNotes()` captures `sid` before any await, uses `sendInput(msg + '\r', sid)` (the `useMux:true` path), and clears notes only on success — confirmed `sendInput()` throws on `!res.ok` and propagates network errors, so the clear really is success-gated.
- Notes survive Edit⇄Preview (data lives in `filesState.notes` + sessionStorage; teardown removes DOM only). Notes/TTS UI is correctly gated on `isMd && !htmlPreview` with `cur.editing = false` and torn down in `filesStartEdit()`.
- Part 3: `preserveFilesSheet` is set only on the same-session `handleInit()` restore; genuine user switches still close the sheet and stop speech. `activeSessionId` is assigned synchronously inside `selectSession()` (no await before it), so `_filesRestoreState()` at the tail of `handleInit()` reads the correct key; restore is always to Preview.
- Part 4: `FilesTTS._split()` has no lookbehind; no other syntax that would break older iOS Safari at parse time. `_gen` invalidation is correct on `onstart`/`onend`/`onerror`; `filesToggleListen()` reaches `speechSynthesis.speak()` synchronously from the gesture; stop hooks are present on close, back-to-tree, new file, `filesStartEdit()` and session switch; the visibility resume + 600ms hard-reset avoids a stuck Stop button.

**Blocking issues**

1. **Cross-session note bleed / sessionStorage clobber** (`_filesNotesAll`, `app.js` ~20375).
   `filesState` is a class field that is created once and *never reset on a session switch* (`_doCloseFilesSheet()` only nulls `current`/`pendingContent`). `_filesNotesAll()` memoises the loaded object into `filesState.notes` and only reads sessionStorage when that field is falsy. So: add a note in session A → switch to session B → open a markdown file there → `_filesNotesFor(path)` returns **session A's** notes (keyed by path only), they are highlighted in B's document and would be sent to B's Claude; the subsequent `_filesPersistNotes()` then writes session A's entire notes object under `codeman-review-notes:<sessionB>`, destroying whatever B had stored. Codeman routinely runs several worktree sessions of the *same* repo, so path collisions (`TASK.md`, `README.md`, `src/web/public/app.js`) are close to guaranteed.
   Fix: invalidate the cache whenever the active session changes — e.g. in `selectSession()` after `this.activeSessionId = sessionId`, `if (_prevSessionId !== sessionId && this.filesState) this.filesState.notes = null;` (or store `filesState.notesSessionId` and reload when it differs). Note this must NOT be inside the `!opts.preserveFilesSheet` block, which is skipped on the reconnect path.

2. **Every note operation scrolls the document back to the top** (`_filesRenderView` rewrites `content.innerHTML`).
   `_filesSaveNote()`, `filesDeleteNote()`, `filesClearNotes()`, `filesToggleNotesPanel()`, `_filesOpenNotesPanel()` (also reached from `_filesScrollToNote()` when a `<mark>` is clicked) and the tail of `filesSendNotes()` all call `_filesRenderView()`, which reassigns `#filesSheetViewContent.innerHTML` and therefore clamps `scrollTop` to 0. For the feature's stated use case — annotating a long story on mobile — adding a note at 60% through the document throws the reader back to page 1, and merely toggling the Notes panel does the same. This makes the review loop unusable in practice.
   Fix: capture `const st = content.scrollTop` before the re-render and reassign it immediately after (content height is unchanged, so no rAF is needed), either inside `_filesRenderView()` itself or in each of the note callers; better still, skip the markdown re-render entirely for panel toggles and only update the panel + `Notes (N)` counter.

**Non-blocking, please address or explicitly waive**

3. **Highlights silently fail on hard-wrapped prose.** `_filesSelectionText()` normalises the excerpt with `.replace(/\s+/g, ' ')`, but `_filesHighlightExcerpt()` matches with `node.data.indexOf(note.excerpt)` against **raw** text-node data. markdown-it preserves the source newlines inside a paragraph's text node, so any selection that spans a source line break can never match and gets no `<mark>` — exactly the long-prose documents this feature targets. This is a broader limitation than the documented "spans element boundaries" case. Consider a whitespace-tolerant scan (build a normalised projection of the text nodes with an offset map) or, at minimum, document it in the notes.

4. **Dirty guard has a hole in `openFileInEditor()`**: the `confirm('Discard unsaved changes?')` only fires when `cur.path !== path`. Re-opening the *same* file while it is dirty (transcript link to the file you are editing) falls straight through to `filesOpenFile()`, which re-fetches and discards the unsaved buffer with no prompt. Drop the `cur.path !== path` condition, or prompt on the same-path case too.

5. **Latent OverlayHistory double-push.** `_filesOpenSheetShell()` pushes `files-sheet` unconditionally and `OverlayHistory.push()` dedupes only against the stack **top** (`app.js:592`). Calling `openFileInEditor()` while the sheet is already open on a file (top = `files-file`) therefore yields `['files-sheet','files-file','files-sheet','files-file']` and two ghost Back presses. It is not reachable today only because `.files-sheet-backdrop.open` (`inset:0; z-index:10002`) covers the transcript and the desktop file-browser — but the method is documented as the universal "open this file from anywhere" entry point, so this is one bad call away. One-line hardening: `if (!OverlayHistory.has('files-sheet')) OverlayHistory.push('files-sheet', …)`.

6. **TTS keeps stale block references across a re-render.** Any note operation re-renders the preview while speech is playing; `FilesTTS._chunks[].el` then points at detached nodes, so the `.files-md-speaking` progress highlight and `scrollIntoView` silently stop working for the rest of the document (audio continues). Either `FilesTTS.stop()` on re-render, or re-collect chunks and re-anchor the current index.

7. **`filesSendNotes()` failure path leaves the UI optimistic.** On a throw it toasts and returns, but `TranscriptView.setWorking(true)` and `_updateTabStatusDebounced(sid,'busy')` are never rolled back, and unlike `InputPanel._sendInner()` there is no re-send poller to correct it. Roll both back in the catch.

8. **Dead branch (cosmetic).** Excerpts are always whitespace-normalised to a single line by `_filesSelectionText()`, so `note.excerpt.split('\n').length` is always 1 and the `oneLine` / multi-line-quoting logic in `filesSendNotes()` can never trigger. Harmless, but it is untestable dead code — either drop it or normalise later so multi-line excerpts are actually possible.

### Review attempt 2 — APPROVED

**Independent verification (all re-run, not taken on trust):**
- `node --check src/web/public/app.js` → OK; `npx tsc --noEmit` → clean (exit 0).
- `npx vitest run test/files-html-preview.test.ts test/overlay-history.test.ts test/file-link-click.test.ts test/file-path-detection.test.ts` → **4 files / 117 tests passed** (112 + 5 new), matching the notes.
- `grep` over `src/ test/ scripts/` for `openFilePreview|filePreviewOverlay|file-preview|binary-message` → zero hits; `OverlayHistory.push('files-file'` still appears exactly twice.
- No regex lookbehind anywhere in the diff (the one `(?<!\()` at `app.js:370` is pre-existing and untouched). No other syntax that would break older iOS Safari at parse time. Every `this._files*` / `app.files*` call resolves to a defined method (scripted check, no typos).

**Blocking findings from attempt 1 — all genuinely fixed (code read, not just claimed):**
1. *Cross-session note bleed* — `_filesNotesAll()` now reloads whenever `filesState.notesSessionId !== this.activeSessionId` (not just on a falsy cache) and stamps `notesSessionId` after loading; `_filesPersistNotes()` early-returns on a mismatch so a foreign cache can never be written under this session's key. `selectSession()` nulls `filesState.notes`/`notesSessionId` immediately after the identity early-return, **before** `this.activeSessionId = sessionId` and **outside** the `!opts.preserveFilesSheet` block — confirmed by reading `selectSession()` at `app.js:10050-10073`, so the SSE-reconnect path invalidates too. The ordering is safe: the cache is lazily reloaded against whatever `activeSessionId` is current, and every mutation persists first, so dropping it is lossless. `handleInit()`'s transient `activeSessionId = null` window self-heals via the same mismatch check.
2. *Scroll reset on note operations* — `_filesRenderView()` captures `keepScroll` only when re-rendering the same path in Preview (`!cur.editing && this._filesRenderedPath === cur.path`) and reassigns it after the render; `filesOpenFile()` sets `_filesRenderedPath = null` so a new document starts at the top / at the restored offset. More importantly the note paths no longer re-render at all: `filesToggleNotesPanel`, `_filesOpenNotesPanel`, `filesDeleteNote`, `filesClearNotes` and the `filesSendNotes()` tail go through `_filesRefreshNotesUi()` + `_filesUnwrapHighlights()`, and `_filesSaveNote()` highlights just the new note in place. Verified by grep that none of those methods contains `_filesRenderView()`.

**Non-blocking findings from attempt 1 — all addressed:**
- (3) Highlight matching rewritten around `_filesTextProjection()`. I exercised `_filesTextProjection` + `_filesHighlightExcerpt` directly in a jsdom harness against the real source (extracted verbatim from `app.js`): hard-wrapped paragraph (`"brown fox"` across a source newline) ✓, cross-`<em>` ✓, cross-`<p>` ✓, occurrence 1 of a repeated word ✓, no-match no-op ✓, projection normalisation `"a  b\nc"` → `"a b c"` ✓. Offset math, back-to-front segment application and the block-boundary pseudo-space are all correct; `surroundContents()` only ever sees a single-text-node range, and `_filesUnwrapHighlights()` + `normalize()` restores whole text runs.
- (4) `openFileInEditor()` now prompts on `cur.dirty` regardless of path. (5) `_filesOpenSheetShell()` pushes `files-sheet` only when `!OverlayHistory.has('files-sheet')`. (6) `FilesTTS.rebind()` re-collects chunks, re-anchors `_index` by matching the current chunk text, keeps old refs when it cannot match, and is called from `_filesRenderView()` while playing. (7) `filesSendNotes()` catch rolls back `TranscriptView.setWorking(false)` (gated on `_sessionId === sid`) and `_updateTabStatusDebounced(sid,'idle')`. (8) The `oneLine`/`estimatedLines` dead branch is gone.

**No regressions in the rest of the change:**
- HTML preview untouched (`sandbox=''` set before `srcdoc`, DOM-built frame, `is-frame` toggling intact); `_filesRenderBinary` untouched; notes/TTS gated on `isMd && !htmlPreview`; the new test asserts the HTML path gets no `Note` button.
- Dirty save guard intact in `filesSheetBack`/`closeFilesSheet`/`_filesSheetCloseFromHistory`/`_filesBackFromHistory`/`filesCancelEdit`, plus the new one in `openFileInEditor`.
- OverlayHistory contract unchanged: `openFileInEditor` pushes no entry of its own, stack stays `files-sheet` → `files-file`.
- Security: excerpt into the dialog via `textContent`; panel rows via `escapeHtml()` on excerpt, note and the internally generated id; `_filesUnwrapHighlights` selector interpolates only that generated id and is try/caught; sessionStorage holds path/mode/scroll/expanded + user-selected excerpts only — never file content.
- `filesSendNotes()` captures `sid` before any await, scans via `SecretDetector` when enabled, sends on the `useMux` path with a trailing `\r`, and clears notes only after `sendInput()` resolves.
- The five new source guards read `app.js` verbatim via `methodBody()` and assert real invariants (including the ordering assertion `guardAt > invalidateAt`); none are tautological.

**Non-blocking notes (do not block merge; fix later or waive):**
- a) `_filesTextProjection()` skips text already inside a `mark.files-md-note`, so when the *same* excerpt string carries several notes the occurrence index can drift: annotating occurrence 0 and then occurrence 2 of a thrice-repeated phrase highlights occurrence 1 for the second note (reproduced in the harness — `target` is not found, and the "fall back to first match" branch picks the wrong span). Only affects repeated identical excerpts; the note data itself is always correct. A fix would be to build the projection over the pre-highlight text and reuse it for all notes in one pass.
- b) Same exclusion means an excerpt can theoretically match across a previously highlighted gap (`"abc" + <mark>XYZ</mark> + "def"` projects as `"abcdef"`), producing two disjoint marks. Very unlikely in practice.
- c) The spec's "cap the message at ~60 lines" is no longer enforced anywhere (the dead `oneLine` branch was removed rather than replaced). Excerpts are single-line so a message is `2 + 4N` lines; the 32 000-char cap allows enough notes to reach ~200 lines, i.e. ~10 s of `tmux send-keys` execs. Consider capping the note count per send.
- d) `filesCancelEdit()` sets `cur.editing = false` **before** calling `_filesRenderView()`, so `keepScroll` takes the editor container's `scrollTop` rather than 0 — contradicting the in-code comment "a return from Edit legitimately starts at the top". Harmless in practice (CodeMirror/textarea scroll internally, so the container's `scrollTop` is 0), but the comment and the code disagree.
- e) `_filesPersistState()` records `#filesSheetViewContent.scrollTop` even while the tree view is showing; the value is stale but unused in that case (`path` is null).

## Test Gap Analysis

**Verdict: GAPS FOUND** (analysis only — no tests written, no source touched).

### Changed source files
- `src/web/public/app.js` (+~1100 lines: `openFileInEditor`/`_filesOpenSheetShell`, the whole
  review-notes subsystem, sessionStorage persistence, `FilesTTS`, `selectSession(opts)`)
- `src/web/public/feature-registry.js` (one reworded + one new entry — generically covered by
  `test/feature-tracker.test.ts`, which asserts the registry round-trips; no gap)
- `src/web/public/index.html`, `src/web/public/styles.css` (markup/CSS deletions only)

### Already covered (do not re-report)
`test/files-html-preview.test.ts` (117 passing) covers, for the changed code:
- jsdom replica of `_filesRenderView()`/`filesStartEdit()`: markdown toolbar is now
  `['Preview','Edit','Copy','Note','Notes (0)']`, HTML path gets **no** `Note` button,
  sandbox/`srcdoc` contract, `is-frame` lifecycle, binary/image dispatch, meta line.
- Five new **source-text guards** (they read `app.js` verbatim; they assert the code *contains*
  a string, not that it behaves): scroll preservation in `_filesRenderView`, "note paths never
  call `_filesRenderView()`", session-scoped notes cache incl. the ordering assertion in
  `selectSession`, `openFileInEditor` dirty-guard + `has('files-sheet')` push guard,
  `filesSendNotes` failure rollback.
- `OverlayHistory.push('files-file'` still appears exactly twice.

`test/overlay-history.test.ts`, `test/file-link-click.test.ts`, `test/file-path-detection.test.ts`
are unchanged and unaffected.

**Nothing in `test/` executes any of the new behaviour.** A grep for `filesSendNotes|FilesTTS|
_filesTextProjection|_filesHighlightExcerpt|preserveFilesSheet|_filesRestoreState|
openFileInEditor|codeman-review-notes|codeman-files-sheet` across `test/` hits only the five
source-text guards above. The author validated the highlight engine and `FilesTTS` in
**throwaway jsdom harnesses that were never committed** — that logic is currently unprotected.

### Gaps (priority order; all testable in this project's jsdom/replica style)

**P1 — highest value**

1. `_filesTextProjection()` / `_filesHighlightExcerpt()` / `_filesUnwrapHighlights()`
   (`app.js:20711-20870`) — the most intricate new logic, entirely untested. Missing:
   whitespace-normalised projection over hard-wrapped prose; excerpt spanning `<em>` and
   spanning two `<p>` blocks → multiple `<mark>`s sharing one `data-note-id`; block-ancestor
   change treated as whitespace; occurrence index selects the Nth match; missing occurrence
   falls back to the first match; no-match is a silent no-op; back-to-front application keeps
   earlier offsets valid; `_filesUnwrapHighlights(id)` removes one note's marks and
   `_filesUnwrapHighlights()` removes all, with `normalize()` restoring single text nodes.
   Also worth pinning as a **documented-current-behaviour** test: review note (a) — because the
   projection skips text already inside `mark.files-md-note`, annotating occurrence 0 then
   occurrence 2 of a thrice-repeated phrase highlights the wrong span.

2. `filesSendNotes()` (`app.js:20918`) — only two `toContain` string guards today. Missing
   behavioural tests with stubbed `sendInput`/`TranscriptView`/`SecretDetector`:
   exact message shape (``Review notes on `path`:`` header, blank line, `N.` / `   > excerpt` /
   `   — note` per entry, trailing `\r` on the sent string); `sid` captured before the await and
   used for `sendInput` even if `activeSessionId` changes mid-send; empty-notes and no-session
   early returns (toast, no send); >32000-char refusal (toast, no send, notes kept);
   `SecretDetector` redaction path substitutes the redacted text; optimistic
   `appendOptimistic`/`setWorking(true)` **only** when `TranscriptView._sessionId === sid`;
   on resolve → notes for that path cleared + persisted + highlights unwrapped; on **throw** →
   notes kept, `setWorking(false)` + `_updateTabStatusDebounced(sid,'idle')`.
   Excerpt truncation at 400 / note at 800 via `_filesTruncate`.

3. `FilesTTS.collectChunks()` / `_ownText()` / `_split()` / `rebind()` / `_gen`
   (`app.js:3236-3360`) — pure DOM/string logic, zero tests. Missing: `pre`/code blocks skipped;
   a `<li>` wrapping a nested `<ul>` and a `<blockquote>` wrapping `<p>` are read once, not twice
   and not dropped; `startEl` skips preceding blocks and matches via `contains()` both ways;
   `_split()` leaves ≤300-char text intact, splits on `.!?…` + whitespace, packs sentences to
   ~300, hard-slices a punctuation-free run at 400, and (source guard) contains no regex
   lookbehind; `rebind()` re-anchors `_index` by matching the current chunk's text and **keeps
   the old refs** when the text is gone; a stale-`_gen` `onend` callback does not advance
   playback (drive with a stubbed `speechSynthesis`).

4. sessionStorage persistence (`_filesPersistState` / `_filesReadState` / `_filesPersistClosed` /
   `_filesRestoreState` / `_filesRestoreScroll`, `app.js:21015-21100`) — untested. Missing:
   payload contains only `{open,path,mode,scrollTop,expanded,activeDir}` and **never file
   content** (assert the stored JSON does not contain the loaded content string — this is the
   secrets-safety invariant); `mode` is always `'preview'` even when persisted while editing;
   closing the sheet `removeItem`s the key; the key is session-scoped
   (`codeman-files-sheet:<id>`); `_filesRestoreState()` with `path` → `openFileInEditor(path,
   {scrollTop})`, without `path` → `openFilesSheet()`, with `open:false`/absent → no-op, and
   restore **never** enters Edit; the one-shot `_filesRestoreAttempted` gate means a second
   `handleInit()` does not re-restore; every sessionStorage access survives a throwing
   `sessionStorage` (Safari private mode) without propagating.

**P2**

5. Notes state layer (`_filesNotesAll` / `_filesNotesFor` / `_filesPersistNotes` /
   `_filesSaveNote` / `filesEditNote` / `filesDeleteNote` / `filesClearNotes`,
   `app.js:20428-20700`) — only a source-text guard today; the actual cross-session-bleed
   regression is unproven. Missing: add → persisted under `codeman-review-notes:<sid>` and
   readable back; switching `activeSessionId` reloads from the new key (session A's notes never
   appear for session B); `_filesPersistNotes()` refuses to write when
   `notesSessionId !== activeSessionId`; edit mutates in place and keeps `id`/`occurrence`;
   delete/clear-all update storage; corrupt/non-object JSON in storage degrades to `{}`;
   notes for a path survive an Edit⇄Preview flip (data lives outside the DOM).

6. `selectSession(sessionId, opts)` `preserveFilesSheet` behaviour (`app.js:~9834`) — only an
   ordering source guard. Missing a replica test: same-session restore with
   `preserveFilesSheet:true` leaves the sheet open and the OverlayHistory entries intact, a
   genuine switch closes it (and stops speech), and the notes-cache invalidation runs on **both**
   paths.

7. `openFileInEditor()` back-stack (`app.js:~19700`) — `### Test hooks` in this task explicitly
   says this should be added to `test/overlay-history.test.ts`; it was not. Missing: stack after
   a cold open is exactly `['files-sheet','files-file']`; calling it again while the sheet is
   already open on a file does **not** produce a 4-entry stack (the `has('files-sheet')` guard);
   `cur.dirty` + declined `confirm()` aborts before `filesOpenFile()`; missing
   `activeSessionId` → toast + no open.

**P3 — cheap, low risk**

8. `_filesSelectionText()` / `_filesSelectionOccurrence()` (`app.js:20470-20500`) — whitespace
   normalisation and prefix-based occurrence counting. jsdom's Selection support is thin, so
   drive these with a hand-built `Range` and a stubbed `window.getSelection()`; assert `\s+ → ' '`
   collapsing, selection outside the preview → `''`, collapsed selection → `''`, and that the
   occurrence index matches what `_filesTextProjection()` later computes for the same text
   (the two normalisations must agree — that is the whole point of the field).

9. Retirement of the old viewer has no regression guard. A one-line source guard test (grep
   `src/web/public/{app.js,index.html,styles.css}` for
   `openFilePreview|filePreviewOverlay|file-preview|filePreviewContent`) would stop it being
   reintroduced, and pins that the three call sites go to `openFileInEditor`.

### Out of scope (do not write tests for these)
- Real iOS Safari selection behaviour: the native callout, `pointerdown`+`preventDefault()`
  keeping the selection alive, pill positioning from `getBoundingClientRect()` (jsdom returns
  all-zero rects). Verify by hand / Playwright.
- Actual speech output, iOS utterance truncation, Chrome's ~15s auto-pause. The
  `visibilitychange` pause/resume + 600ms hard-reset **state machine** could optionally be driven
  with a stubbed `speechSynthesis` and fake timers, but the engine behaviour itself cannot.
- Double-`requestAnimationFrame` scroll restore landing on a real laid-out document (jsdom has no
  layout); assert the rAF chain and the final `scrollTop` assignment only.
- CSS (`styles.css`) and the deleted `index.html` markup beyond the grep guard in gap 9.

### Re-check after test review attempt 1

**Verdict: NO GAPS** (analysis only — no tests written, no source touched).

Re-ran the four new suites locally: `files-md-highlight` (26) + `files-review-notes` (21)
+ `files-sheet-persistence` (20) + `files-tts` (24) → **91 passed, 0 failed** (4.1s).

Cross-checked every method added by `git diff master -- src/web/public/app.js` (58 new/changed
members) against a grep of `test/`. All nine original gaps are genuinely closed by real
behavioural tests (not just source-text guards): P1 gaps 1–4, P2 gaps 5–7, P3 gaps 8–9.
The Opus review's mutation testing (8 injected defects, all caught) confirms the extraction
harness asserts shipped behaviour rather than merely executing it.

**Members with no direct test, and why none is a material gap:**
- `_filesInstallNoteSelection` / `_filesUpdateNotePill` / `_filesHideNotePill` — iOS selection
  geometry + `getBoundingClientRect()` pill placement; on the documented out-of-scope list
  (jsdom returns all-zero rects).
- `_bindVisibility` — the `visibilitychange` pause/resume + 600ms reset state machine; listed as
  *optional* by the first pass and dominated by real engine behaviour. The stale-generation and
  `stop()` paths that actually protect the UI are covered in `files-tts`.
- `_filesRenderNotesPanel` / `_filesShowNoteDialog` / `_filesCloseNoteDialog` markup,
  `_filesScrollToNote` flash, `_filesUpdateListenBtn`, `filesToggleListen` — presentation-only
  glue; on the out-of-scope list. Their escaping contract is exercised by the notes state tests
  and their toolbar composition is pinned by `files-html-preview`.
- `_filesApplyNoteHighlights` (4-line loop over `_filesHighlightExcerpt`), `_filesIsMdPreview`
  (one-line predicate), `_filesTruncate`, `_speakCurrent` — thin wrappers whose bodies are
  exercised transitively by the covered callers (`_speakCurrent` via every `FilesTTS.start()`
  test, `_filesTruncate` via the 400/800 send tests).
- `feature-registry.js` / `index.html` / `styles.css` — registry round-trip is covered by
  `test/feature-tracker.test.ts`; the markup/CSS deletions are pinned by the gap-9 grep guards.

The three non-blocking notes from the test review (`methodSource()` duplication, the tautological
line in "selects the Nth match", the missing source guard on the `_filesTeardownNotesUi()` else
branch + feature-detected `Listen` button in the `files-html-preview` replica) were re-examined:
none of them leaves shipped behaviour unprotected — the teardown branch and the `Listen` button
are both divergences of the *replica*, and both are called out in comments. Carrying them forward
as future-cleanup items rather than reopening test writing.

Moving to QA.

## Test Writing Notes
<!-- filled by test writing subagent -->

2026-08-16 (test writing): 91 new tests across 4 new files + 8 added to an existing one.
All 215 tests in the files-sheet suites pass; `npx tsc --noEmit` is clean.

**Method**: rather than hand-writing replicas, these tests EXTRACT the real method bodies
from `src/web/public/app.js` (imported via Vite's `?raw`) and re-compile them into a plain
object, injecting only the free variables (`SecretDetector`, `TranscriptView`, `FilesTTS`,
`OverlayHistory`, `FeatureTracker`). So the logic under test is the shipped code, and no
replica can drift. The existing replica-style file (`files-html-preview.test.ts`) was left
untouched.

### `test/files-md-highlight.test.ts` (new, 26 tests) — gap 1 + gap 8
Real `_filesTextProjection` / `_filesHighlightExcerpt` / `_filesUnwrapHighlights` /
`_filesSelectionText` / `_filesSelectionOccurrence`.
- projection: hard-wrap collapsing, block boundary → space, no leading space, skips text
  already inside `mark.files-md-note`, char→node/offset map.
- highlight: hard-wrapped excerpt, excerpt spanning `<em>` (one `<mark>` per text node,
  shared `data-note-id`, spaces stay outside the marks), excerpt spanning two `<p>`,
  Nth-occurrence selection, fallback to first match when the occurrence is gone, silent
  no-op on no match / empty excerpt, visible text unchanged, back-to-front application.
- **documented current behaviour**: annotating occurrence 0 then occurrence 2 of a
  thrice-repeated phrase highlights the SECOND occurrence (the projection skips already
  marked text). Pinned as-is, flagged in the test comment as current, not desired.
- unwrap: by id, all, `normalize()` re-joins text nodes, re-highlight after unwrap.
- selection: whitespace normalisation, collapsed → '', outside preview → '', no selection
  → '', and the occurrence index agreeing with what the projection later computes.

### `test/files-review-notes.test.ts` (new, 21 tests) — gap 2 + gap 5
Real notes state layer + `filesSendNotes()`, with stubbed `sendInput` / `TranscriptView` /
`SecretDetector` / toasts.
- state: persisted under `codeman-review-notes:<sid>` and read back; empty comment refused;
  session A's notes never served or written to session B; `_filesPersistNotes()` refuses a
  mismatched cache; edit keeps `id`/`occurrence`; delete + clear-all persist; confirm-declined
  clear keeps notes; corrupt/non-object JSON → `{}`; notes survive an Edit⇄Preview DOM wipe;
  per-path scoping.
- send: exact message shape + trailing `\r`; `sid` captured before the await; empty-notes and
  no-session early returns; >32000-char refusal keeps the notes; 400/800 truncation;
  SecretDetector redaction substitutes the text; optimistic bubble only when
  `TranscriptView._sessionId === sid`; on resolve → notes cleared + persisted + highlights
  unwrapped + panel closed; on throw → notes kept, `setWorking(false)`, tab status back to
  `idle`.

### `test/files-tts.test.ts` (new, 24 tests) — gap 3
The real `FilesTTS` object literal, compiled against a stubbed `speechSynthesis` /
`SpeechSynthesisUtterance` (installed before compilation so `supported` is true).
- `collectChunks`: document order, `pre` skipped, nested `<li>` read once under its own
  element, `<blockquote><p>` read once, inline markup kept + whitespace normalised, empty
  blocks dropped, `startEl` skipping, `el.contains(startEl)` and `startEl.contains(el)`.
- `_split`: ≤300 intact, sentence packing to ≤300 with nothing lost, `?!…` boundaries,
  400-char hard slice of a punctuation-free run, source guard for no regex lookbehind.
- playback: first chunk spoken synchronously and chained via `onend`, `onerror` skips ahead,
  refuses an unreadable document, **stale `_gen` `onend` does not advance**, speaking-block
  class set/cleared, `onStateChange(false)` fired exactly once.
- `rebind`: re-anchors `_index` onto the rebuilt nodes; keeps the old refs when the text is
  gone; no-op when not playing.

### `test/files-sheet-persistence.test.ts` (new, 20 tests) — gap 4 + gap 6 + gap 9
Real `_filesPersistState` / `_filesPersistClosed` / `_filesReadState` / `_filesRestoreScroll` /
`_filesRestoreState`, plus the real `selectSession()` prologue extracted as a statement block.
- persistence: payload is exactly `{open,path,mode,scrollTop,expanded,activeDir}` and the
  stored JSON does **not** contain the file content (secrets-safety invariant); `mode` is
  `'preview'` even while editing; tree-only open stores `path:null`; closing `removeItem`s;
  key is session-scoped; no-op without a session.
- restore: `path` → `openFileInEditor(path,{scrollTop})`, no `path` → `openFilesSheet()`,
  `open:false`/absent → no-op, expanded/activeDir rehydrated, never enters Edit, corrupt JSON
  → `null`.
- a throwing `sessionStorage` (Safari private mode) never propagates out of persist / read /
  close / restore.
- `_filesRestoreScroll`: assignment happens only after the SECOND rAF; zero offset is a no-op.
- `selectSession` prologue: `preserveFilesSheet:true` leaves sheet + both history entries
  intact and does not stop speech; a genuine switch closes the sheet, stops TTS and pops
  `files-file` then `files-sheet`; the notes cache is invalidated on BOTH paths.
- source guards: the one-shot `_filesRestoreAttempted` gate; the old viewer is gone from
  `app.js`/`index.html`/`styles.css` (`openFilePreview`, `closeFilePreview`, `filePreview*`,
  `.file-preview*`); the four file-open call sites all go to `openFileInEditor`.

### `test/overlay-history.test.ts` (modified, +8 tests) — gap 7
New `describe('openFileInEditor() back stack')`, running the real `openFileInEditor()` +
`_filesOpenSheetShell()` against the existing OverlayHistory replica: cold open →
`['files-sheet','files-file']`; a second open while the sheet already shows a file does not
stack a second pair; `opts.scrollTop` reaches `_filesRestoreScroll`; dirty + declined confirm
aborts before `filesOpenFile()`; dirty + accepted confirm clears the flag and opens; missing
`activeSessionId` → toast, nothing opened; empty path → no-op. Existing tests untouched.

### Deliberately left uncovered
- Everything on the gap analysis's out-of-scope list (iOS selection/callout geometry, pill
  positioning from `getBoundingClientRect()`, real speech output, real layout scroll restore).
- The `visibilitychange` pause/resume + 600ms reset state machine (listed as *optional* in the
  gap analysis): it binds a document listener at `start()` time and is dominated by real engine
  behaviour that jsdom cannot model; the stale-generation and stop() paths that protect the UI
  are covered instead.
- Pure presentation: `_filesRenderNotesPanel()` / `_filesRenderMdTools()` markup, the note
  dialog DOM, `_filesScrollToNote()` flash, and the click-a-highlight→scroll listener. The
  escaping contract they depend on is already exercised through the notes state tests, and the
  toolbar composition is pinned by `test/files-html-preview.test.ts`.
- No implementation bugs were found — every new test passes against the current source.

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

### Test review attempt 1 — APPROVED

**Independently verified.** Ran the eight suites named in the brief:
`files-md-highlight` (26) + `files-review-notes` (21) + `files-tts` (24) +
`files-sheet-persistence` (20) + `overlay-history` (41) + `files-html-preview` (52) +
`file-link-click` (7) + `file-path-detection` (24) → **215 passed, 0 failed** (40.9s).
`npx tsc --noEmit` clean. Prettier only covers `src/**/*.ts` (`format:check` in
package.json), and the HEAD version of `files-html-preview.test.ts` already fails a
prettier check, so the two reformat nits in the modified test file are pre-existing and
outside the gate — not an issue.

**The extraction harness is sound, and not vacuous.**
- `methodSource()` guards against a silent miss: `expect(start, '<name>() not found in
  app.js').toBeGreaterThan(-1)` plus `expect(end, 'no 2-space closing brace')`. The
  FilesTTS extractor and the `selectSession` prologue extractor carry the same guards.
  A rename or reflow in app.js therefore fails loudly rather than skipping a method.
- I independently checked completeness of every extracted member: all 23 method
  snippets (`_filesTextProjection` … `openFileInEditor`) are brace-balanced and end on
  the real closing line — no method is silently truncated by the `l === '  }'` heuristic.
- Free variables are injected as `new Function` params (`SecretDetector`,
  `TranscriptView`, `FilesTTS`, `OverlayHistory`, `FeatureTracker`) or as assigned
  stubs; anything unstubbed would ReferenceError at call time, i.e. fail loudly.

**Mutation-tested (source perturbed in place, then restored — `md5sum` verified
identical, working tree unchanged).** Eight deliberate defects, all caught:

| injected defect | test that failed |
|---|---|
| drop the `at === -1 && target > 0` occurrence fallback | falls back to the first match … |
| `'   > '` → `'   >'` in the notes message | composes one LLM-friendly message … / truncation test |
| drop the `notesSessionId !== activeSessionId` write guard | refuses to write a cache that belongs to a different session |
| persist `mode: cur.editing ? 'edit' : 'preview'` | records mode "preview" even when editing |
| add `content:` to the persisted payload | stores only the view coordinates, never the file content |
| drop `el.closest('pre')` skip in `collectChunks` | skips code blocks / refuses to start on … nothing readable |
| `_split` threshold 300 → 3000 | three `_split` tests |
| drop `rebind`'s `at === -1` bail | keeps the old refs when the current text is gone |

So these assert real behaviour of the shipped code, not that it merely runs.

**Coverage vs the gap analysis** — all nine gaps are addressed:
1 ✅ (projection/highlight/unwrap, incl. the documented occurrence-drift pin, correctly
flagged in-comment as *current* not *desired*); 2 ✅ (exact message shape + `\r`, sid
captured pre-await, both early returns, 32000 refusal keeping notes, 400/800 truncation,
SecretDetector redaction, conditional optimistic bubble, resolve→clear/throw→rollback);
3 ✅ (`collectChunks`/`_ownText`/`_split`/`rebind`/stale `_gen`); 4 ✅; 5 ✅; 6 ✅ (real
`selectSession` prologue extracted and driven both ways); 7 ✅ (`['files-sheet',
'files-file']`, no double-stack, dirty confirm both ways, no-session, empty path);
8 ✅ (incl. the important cross-check that `_filesSelectionOccurrence` and
`_filesTextProjection` agree on the same text); 9 ✅ (grep guards over app.js /
index.html / styles.css + the four call sites).
Realism is good: jsdom DOM shapes match markdown-it output, storage stubs model Safari
private mode by throwing on every accessor, and the collaborators stubbed are exactly
the ones out of jsdom's reach.

**Non-blocking notes for a future pass (do NOT gate the merge on these):**
- `methodSource()` is copy-pasted verbatim into four test files. If a fifth arrives,
  promote it to a shared helper (e.g. `test/helpers/app-source.ts`).
- `files-md-highlight.test.ts` → "selects the Nth match": the line
  `expect(p.textContent.indexOf(marks()[0].textContent)).toBe(0)` is tautological
  (`indexOf('tap here')` is 0 whichever occurrence was marked). The following
  `childNodes[0].textContent === 'tap here. '` assertion is the one doing the work, so
  there is no false confidence — the line is just noise.
- The `files-html-preview.test.ts` replica of `_filesRenderView` mirrors the new tail
  (`keepScroll`, `cur.editing = false`, `_filesRenderMdTools`) but omits the
  `else { this._filesTeardownNotesUi(); }` branch and the feature-detected `Listen`
  button, so the toolbar-label assertion (`['Preview','Edit','Copy','Note','Notes (0)']`)
  does not match a real browser, where `speechSynthesis` exists. Both divergences are
  called out in comments; a source-text guard on the teardown branch would close the
  remaining hole.
- Only grep-level coverage for the one-shot `_filesRestoreAttempted` gate, and no
  coverage at all for `_filesInstallScrollPersist` (the 250ms scroll throttle and the
  `pageshow`/bfcache re-apply). Neither was requested by the gap analysis; both are
  cheap to add with fake timers if a later cycle wants them.

No test was found to be vacuous, mis-scoped, or asserting a mock instead of the code.
No source or test file was modified by this review.

## QA Results
<!-- filled by QA subagent -->

### QA run — 2026-08-16 — PASS

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **PASS** — exit 0, zero errors |
| `npm run lint` (`eslint 'src/**/*.ts'`) | **PASS** — 0 errors, 2 warnings (both pre-existing, in `src/vault/search.ts` and `src/web/routes/session-routes.ts` — files untouched by this branch) |
| Targeted vitest (8 suites) | **PASS** — 8 files / **215 tests passed**, 0 failed (41.2s) |
| Dev server boot | **PASS** — `npx tsx src/index.ts web --port 44903`, `/api/status` returned 200 with the session list |
| Browser console on load | **PASS** — 0 page errors, 0 console errors, 0 failed requests (mobile 390x844 iOS UA) |
| New CSS rules parsed & active | **PASS** — all six confirmed |
| `#filePreviewOverlay` retired | **PASS** — absent from the DOM; `app.openFilePreview` is `undefined`, `app.openFileInEditor` is a function |
| Mobile UI exercise (files sheet, markdown Preview, notes, TTS button) | **PASS** |
| Backgrounding / reload persistence (Part 3) | **PASS** |

Suites run: `files-md-highlight` (26) + `files-review-notes` (21) + `files-tts` (24) +
`files-sheet-persistence` (20) + `overlay-history` (41) + `files-html-preview` (52) +
`file-link-click` (7) + `file-path-detection` (24) = 215.

**Vendor assets:** no fix needed — `src/web/public/vendor` is already a symlink to the
main checkout's vendor dir, and `/vendor/editor.min.js` served 200 (728 KB). No `/vendor/*`
404s, so nothing was copied.

#### CSS verification (rules enumerated from `document.styleSheets`, plus `getComputedStyle` probes)
- `.files-note-pill` → `position:absolute; z-index:6; display:none; background:rgb(31,111,235); border-radius:999px; padding:7px 14px` — computed style matches, not defaults.
- `mark.files-md-note` → `background:rgba(210,153,34,.28); border-bottom:2px solid rgba(210,153,34,.75); cursor:pointer` — confirmed live on a real `<mark>` created by adding a note (`backgroundColor` = `rgba(210,153,34,0.28)`).
- `.files-notes-panel` → `display:flex; max-height:42%; border-top:1px solid; background:rgb(13,17,23)` — computed on the real panel.
- `.files-notes-row` → `padding:10px 12px; border-top:1px solid` (+ `.is-flash`) — computed `padding-top:10px` on a real row.
- `.files-md-speaking` → present as `.files-md-preview .files-md-speaking` with `background:rgba(88,166,255,.14); box-shadow:inset 3px 0 0 rgb(88,166,255)`. (A bare probe outside `.files-md-preview` correctly shows defaults — the rule is descendant-scoped by design.)
- `.files-sheet-view` → `position: relative` confirmed on the live `#filesSheetView` element (the pill's positioning context).
No CSS parse errors: 3,567 selector rules enumerated across the 7 stylesheets.

#### Headless mobile walkthrough (390x844, iPhone UA, touch)
1. `selectSession()` → `openFileInEditor('TASK.md')` (the transcript-link entry point) opened the **files sheet** with title `TASK.md`, `#filesSheetView` visible, and a rendered `.files-md-preview` (children `H1,P,OL,H2,P,H3`, 77 KB of text) — **not** the escaped `<pre>` fallback, i.e. the awaited `_filesEnsureVendor()` fix works on a cold open.
2. Preview toolbar rendered exactly `['Preview','Edit','Copy','Note','Notes (0)','▶ Listen']` — the `Listen` button is present because headless Chromium exposes `speechSynthesis` (`FilesTTS.supported === true`).
3. Notes: programmatic selection → `_filesSelectionText()` / `_filesSelectionOccurrence()` / `_filesSaveNote()` produced 1 `mark.files-md-note` (highlight text spanned a hard-wrapped source newline and still matched, confirming the `_filesTextProjection()` rewrite), the button became `Notes (1)`, the review panel auto-opened with 1 row plus `Clear all` / `Send notes`, and the note round-tripped to `sessionStorage['codeman-review-notes:<sid>']` as `{path:[{id,excerpt,occurrence,note,createdAt}]}` — no file content stored.
4. TTS: clicking `▶ Listen` flipped the label to `■ Stop` **synchronously** within the click handler and `FilesTTS.isPlaying()` was true immediately (the iOS user-gesture requirement); `collectChunks(preview, null)` returned 297 chunks for README.md. It self-reset to `▶ Listen` ~600 ms later because headless Chromium has no speech engine (every utterance errors instantly) — the graceful no-stuck-UI reset is exactly the specified behaviour, but real audio and the `.files-md-speaking` progress highlight could **not** be exercised headlessly.
5. Back nav: `filesSheetBack()` returned to the populated tree (49 rows), `closeFilesSheet()` hid the sheet. No console errors at any step.

#### Part 3 — backgrounding / reload (verified end-to-end)
- Opened `TASK.md`, scrolled `#filesSheetViewContent` to 1200 px, then called `app.loadState()` (the exact path `_onTabVisible()` takes on tab re-show → `handleInit()`): sheet still open, still on `TASK.md`, preview still rendered, **scrollTop still 1200**. Pre-fix this closed the sheet.
- Full `page.reload()` (simulating an iOS tab discard): the sheet **restored itself** — open, title `TASK.md`, markdown Preview rendered, `scrollTop` back to 1200, toolbar intact, and 0 console/page errors on the restored load. Persisted payload was `{"open":true,"path":"TASK.md","mode":"preview","scrollTop":1200,"expanded":[],"activeDir":""}` — path/mode/scroll only, never content, and mode is always `preview`.

#### Not exercised (environment limits, not defects)
- Real iOS Safari selection callout / pill positioning from `getRangeAt(0).getBoundingClientRect()` (headless Chromium does not reproduce the native callout); the toolbar `Note` fallback button is present.
- Actual speech output, per-block `.files-md-speaking` progress highlight, and the `visibilitychange` pause/resume state machine (no speech engine in headless Chromium).
- `filesSendNotes()` was not fired — it would inject a real message into the live session's Claude.
- `pageshow`/bfcache re-apply path (Playwright reload is not a bfcache restore).

#### Observations (non-blocking, no action taken)
- One console error appears only when previewing `README.md`: the CSP `img-src 'self' data: blob:` blocks the external `img.shields.io` badge referenced by the document. This is markdown-preview behaviour that predates this branch (the preview shipped in `3d0c99ff`) and is a correct CSP enforcement, not a regression. No error occurs on `TASK.md` or on page load.

### Docs Staleness

`git diff master..HEAD --name-only` is **empty** (this branch's work is entirely uncommitted),
so the flags below were determined from the **working-tree** diff `git diff master --name-only`
plus untracked files:
`TASK.md`, `src/web/public/app.js`, `src/web/public/feature-registry.js`,
`src/web/public/index.html`, `src/web/public/styles.css`,
`test/files-html-preview.test.ts`, `test/overlay-history.test.ts`,
and new `test/files-{md-highlight,review-notes,tts,sheet-persistence}.test.ts`.

- ⚠️ **UI docs may need update (frontend changed significantly)** — `src/web/public/app.js`
  (+~1100 lines) and `src/web/public/styles.css` both changed.
- No `src/web/routes/*.ts` changes → API docs flag does **not** apply.
- No `skills/*/SKILL.md` changes → skill docs flag does **not** apply.

Advisory only — no docs were modified.

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->
- 2026-08-16: User added scope item 4 (TTS play/stop in markdown Preview) while task was in analysis phase — include it in the analysis and implementation.
- 2026-08-16 (implement): kept `openFilesSheet()`'s public name and behaviour, adding
  `_filesOpenSheetShell()` underneath, so every existing caller and the OverlayHistory
  contract are unchanged.
- 2026-08-16 (implement): `openFileInEditor()` does not push its own `files-file` entry —
  it delegates to `filesOpenFile()`, which keeps the existing two-push invariant that
  `test/files-html-preview.test.ts` pins.
- 2026-08-16 (implement): restore is always to Preview, never Edit. Unsaved editor content
  is deliberately not persisted (secrets safety), so restoring into Edit would silently
  drop the user's work and defeat the dirty-file guard.
- 2026-08-16 (implement): `_filesRestoreState()` is gated by a one-shot
  `_filesRestoreAttempted` flag so it only runs on a real page load; live SSE reconnects
  keep the sheet via `preserveFilesSheet` instead.
- 2026-08-16 (implement): note excerpts that span element boundaries get no `<mark>`
  (`Range.surroundContents()` throws) — accepted limitation from the spec; the note itself
  is still listed, editable and sent.
- 2026-08-16 (implement): `filesSendNotes()` clears the note list only after `sendInput()`
  resolves; on failure the notes are kept, since they are the user's only copy.
- 2026-08-16 (implement): `FilesTTS._split()` avoids regex lookbehind — older iOS Safari
  throws at parse time, which would break the entire app.js bundle rather than just TTS.
- 2026-08-16 (implement): TTS reads each block's *own* text (`_ownText()`) rather than
  `textContent`, so nested lists/blockquotes are neither duplicated nor dropped.
- 2026-08-16 (fix cycle 2): the notes cache is invalidated in BOTH places —
  `selectSession()` (eager, as the reviewer specified) and `_filesNotesAll()` via
  `notesSessionId` (self-healing, covers any path that changes `activeSessionId`
  without going through `selectSession()`). `_filesPersistNotes()` also refuses to
  write a mismatched cache, so the clobber is impossible even if both were bypassed.
- 2026-08-16 (fix cycle 2): note mutations update the DOM incrementally rather than
  re-rendering the markdown. The `_filesRenderView()` scroll preservation is kept as
  well, since the Preview tab button re-enters it directly.
- 2026-08-16 (fix cycle 2): highlights are now applied per text node instead of one
  `Range.surroundContents()`, which both fixes hard-wrapped prose and retires the
  earlier "excerpts spanning element boundaries get no highlight" limitation. A note
  can therefore own several `<mark>`s; they all carry the same `data-note-id`, so the
  click-to-scroll and unwrap paths are unaffected.
- 2026-08-16 (fix cycle 2): `FilesTTS.rebind()` re-anchors by matching the current
  chunk's text; if the text is not found (file changed underneath) it keeps the old
  refs rather than jumping the reader to an unrelated block.

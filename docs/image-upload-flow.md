# Image Upload / Attach / Send Pipeline — End-to-End Documentation

All line numbers reference `src/web/public/app.js` unless noted otherwise.

## Overview

Images are uploaded to the server as files, stored in `~/.codeman/screenshots/`, and their
absolute file paths are prepended as text lines to the user's message. The combined text is
sent to the Claude CLI PTY via tmux `send-keys`, where Claude reads the file paths as input.

## State Variables (InputPanel object, line 20484)

| Variable | Type | Line | Purpose |
|---|---|---|---|
| `_images` | `Array<{ objectUrl: string\|null, file: File\|null, path: string\|null }>` | 20488 | Array of image entries. `path` is null until upload completes. |
| `_files` | `Array<{ filename: string, path: string\|null, uploading: boolean }>` | 20489 | Non-image file attachments |
| `_uploadingCount` | `number` (implicit) | never initialized explicitly | Count of in-flight uploads. Incremented before fetch, decremented in finally. |
| `_uploadsCompletePromise` | `Promise\|null` (implicit) | never initialized explicitly | Created when uploads start, resolved when all complete. Used by `send()` to wait. |
| `_uploadsCompleteResolve` | `Function\|null` (implicit) | never initialized explicitly | Resolver for `_uploadsCompletePromise`. |
| `_replaceIdx` | `number` | 20495 | Index of image being replaced (-1 = no replace). |
| `_drafts` | `Map<sessionId, {text, imagePaths[]}>` | 20497 | Per-session draft cache for text + image paths. |
| `_currentSessionId` | `string\|null` | 20499 | Session whose draft is currently loaded. |

## Entry Points

### 1. Global Paste Handler (line 5226)

```
document.addEventListener('paste', async (e) => { ... }, true);  // capture phase
```

- Registered in `init()` at line 5226 with capture phase (`true`).
- Filters clipboard items for files (lines 5227-5231).
- Routes to `CommandPanel._onPaste()` if CommandPanel is open (line 5237).
- Otherwise classifies files as image/non-image (lines 5240-5245).
- Has multiple fallback paths for getting files from clipboard (lines 5249-5272).
- Calls `InputPanel.open()` if not open (line 5274).
- **CRITICAL: Does NOT await** `InputPanel._onFilesFromPaste(imageFiles)` (line 5275).
- Also calls `InputPanel._uploadNonImageFiles(nonImageFiles)` (line 5276) — also not awaited.

### 2. File Picker (action sheet) (line 5955-5967)

- `_actionSheetPick(type)` triggers file input click (line 5966).
- `_onFilesChosen(input, type)` handles the `change` event (line 20975).
- Separates images from non-images.
- Calls `await this._uploadFiles(imageFiles)` — properly awaited within the handler.

### 3. Ctrl/Cmd+Enter (line 20681)

```js
ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.send().catch(() => {});  // line 20684
    }
});
```

### 4. Send Button Click (line 20704)

```js
sendBtn.addEventListener('click', () => this.send());  // NOT awaited, no .catch()
```

## Upload Flow: `_uploadFiles(files)` (line 21069)

For each file in the array (sequential via `for` loop with `await`):

1. **Create entry** (line 21081): `{ objectUrl: URL.createObjectURL(file), file, path: null }`
2. **Add to `_images`** (line 21088): `this._images.push(entry)` (or replace at `_replaceIdx`)
3. **Render thumbnails** (line 21090): Shows upload-in-progress indicator
4. **Increment `_uploadingCount`** (line 21094): `this._uploadingCount = (this._uploadingCount || 0) + 1`
5. **Update send button** (line 21095): `this._updateSendBtnState()` — disables send, creates `_uploadsCompletePromise`
6. **Upload via fetch** (line 21105): `POST /api/screenshots` with FormData, 30s timeout
7. **On success** (line 21115): `entry.path = data.path` — mutates the entry in `_images`
8. **On failure** (line 21121): Removes entry from `_images`, revokes objectUrl
9. **Finally** (line 21126): Decrements `_uploadingCount`, calls `_updateSendBtnState()`

### Server-side upload: `POST /api/screenshots` (system-routes.ts line 694)

- Accepts multipart/form-data
- Saves file to `~/.codeman/screenshots/screenshot_YYYY-MM-DD_HH-MM-SS.ext`
- Returns `{ success: true, path: "/home/user/.codeman/screenshots/screenshot_...", filename: "screenshot_..." }`

## Upload Guard: `_updateSendBtnState()` (line 21038)

- Disables send button when `_uploadingCount > 0` (line 21041)
- Creates `_uploadsCompletePromise` when count transitions from 0 to positive (line 21046-21047)
- Resolves promise when count returns to 0 (line 21048-21051)
- Safety valve: force-resets `_uploadingCount` to 0 after 60 seconds (line 21057-21065)

## Send Flow: `send()` (line 20815)

1. **Wait for uploads** (line 20820-20826): If `_uploadingCount > 0`, awaits `_uploadsCompletePromise`
2. **Get text** (line 20831): `text = ta.value.trim()`
3. **Filter images with paths** (line 20832): `images = this._images.filter(img => img.path)`
4. **Filter files with paths** (line 20833): `attachedFiles = this._files.filter(f => f.path)`
5. **Guard: nothing to send** (line 20834): Returns if no text, images, or files
6. **Build sendText** (line 20841-20847): Prepend file refs, apply secret detection
7. **Build parts** (line 20861): `[...images.map(img => img.path), ...(sendText ? [sendText] : [])]`
8. **Capture session ID** (line 20862): `_sendSessionId = app.activeSessionId` (used only for polling)
9. **Send** (line 20863): `app.sendInput(parts.join('\n') + '\r')` — fire-and-forget with `.then()/.catch()`
10. **Optimistic UI** (line 20887-20900): Show message in transcript, set busy indicator
11. **Clear draft** (line 20903-20906): Empties draft for current session
12. **Clear textarea** (line 20909): `ta.value = ''`
13. **Remove sent images** (line 20912): `this._images = this._images.filter(img => !img.path)` — keeps only unsent (uploading) entries

## `app.sendInput(input)` (line 11148)

```js
async sendInput(input) {
    if (!this.activeSessionId) return;
    await fetch(`/api/sessions/${this.activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, useMux: true })
    });
}
```

**Key observations:**
- Uses `this.activeSessionId` at call time, NOT a captured session ID
- No error handling — fetch failures are silently ignored
- No retry logic (contrast with `_sendInputAsync` at line 8224 which has queuing)

## Server-side Input: `POST /api/sessions/:id/input` (session-routes.ts line 645)

- Validates input with `SessionInputWithLimitSchema` (100KB max)
- Intercepts `/clear` command for special handling (line 667)
- Calls `session.writeViaMux(inputStr)` (line 681)
- Falls back to direct PTY write if writeViaMux fails (line 690) — **strips \n in fallback**

## PTY Input: `writeViaMux()` (session.ts line 2341)

Delegates to `TmuxManager.sendInput()` (tmux-manager.ts line 1285):

1. **Strip \r, split on \n** (line 1313): `lines = input.replace(/\r/g, '').split('\n')`
2. **For each line** (line 1315):
   - If line is non-empty: `tmux send-keys -t "session" -l "line text"` (literal mode)
   - 50ms delay between sends
   - If not last line: `tmux send-keys -t "session" C-j` (Ctrl+J = newline in Ink's input buffer)
3. **If input had \r** (line 1336): 100ms delay, then `tmux send-keys -t "session" Enter`

### What Claude CLI receives:

For input `"/path/to/image.png\nHello world\r"`:
1. Literal text: `/path/to/image.png`
2. C-j (newline in input buffer)
3. Literal text: `Hello world`
4. Enter (submits the prompt)

## Session Change: `onSessionChange(oldId, newId)` (line 20504)

Called when the active session changes (user switch, SSE-triggered auto-clear, etc.):

1. **Save old draft** (line 20506-20507): `_saveDraftLocal(oldId)`
2. **Check if user has text** (line 20517): `userHasText = ta && ta.value && document.activeElement === ta`
3. **Clear textarea** (line 20518): Only if `!userHasText`
4. **Clear images** (line 20519): `if (!userHasText) this._restoreImages([])` — **WIPES ALL IMAGES**
5. **Load new draft** (line 20521): `_loadDraft(newId)` — async, fetches from server

## Draft Persistence

- **Local cache**: `_drafts` Map stores `{text, imagePaths}` per session (line 20497)
- **Server sync**: `PUT /api/sessions/:id/draft` (debounced 2s) (line 20537)
- **Restore**: `_restoreImages(imagePaths)` rebuilds `_images` from path strings (line 20586)
- Images restored from drafts have `objectUrl: null, file: null` — thumbnails use API URL

---

## IDENTIFIED BUGS

### BUG 1 (CRITICAL): `sendInput()` uses `this.activeSessionId` instead of captured session ID

**Location**: line 11148-11155

`InputPanel.send()` captures `app.activeSessionId` at line 20862 as `_sendSessionId`, but then calls `app.sendInput(...)` which internally reads `this.activeSessionId` at the time the fetch executes. If an SSE event triggers a session switch between `send()` starting and the fetch executing, the input goes to the WRONG session or is silently dropped (if `activeSessionId` becomes null).

This is especially problematic because:
- `send()` is `async` and may `await _uploadsCompletePromise` (line 20826), yielding to event loop
- Session switches can be triggered by SSE events at any time
- Auto-clear (`/clear`) creates a child session and triggers `onSessionChange`

### BUG 2 (CRITICAL): `sendInput()` has NO error handling

**Location**: line 11148-11155

If the fetch fails (network error, server restart, 500), the promise rejects, which is swallowed by `.catch(() => {})` at line 20884. The user's message (including image paths) is silently lost. The textarea and images have already been cleared (lines 20909-20912), so there's no way to recover.

Compare with `_sendInputAsync()` at line 8224 which has proper offline queuing and retry.

### BUG 3 (MODERATE): Session switch wipes images even when user has images attached

**Location**: line 20517-20519

The `userHasText` check only looks at `ta.value` (text content). If the user has images pasted but no text yet, `userHasText` is false, and `_restoreImages([])` at line 20519 wipes all images. The images are saved to the draft (line 20529 captures `imagePaths`), but only if `_saveDraftLocal(oldId)` runs first — which it does at line 20506.

However, the restored draft only contains `imagePaths` for images that have completed upload (`img.path` is non-null). Images still uploading are lost permanently.

### BUG 4 (MODERATE): Global paste handler doesn't await upload

**Location**: line 5275

`InputPanel._onFilesFromPaste(imageFiles)` is called without `await`. This is normally fine because `_uploadingCount` is incremented synchronously before the first `await` in `_uploadFiles()`. But if the paste handler encounters an error before reaching `_uploadFiles()`, or if `_onFilesFromPaste` is overridden/patched, the upload count won't be tracked.

### BUG 5 (MINOR): `_uploadingCount` never explicitly initialized

**Location**: line 20484 (InputPanel object literal)

`_uploadingCount` is not declared in the object literal. It's implicitly created via `(this._uploadingCount || 0) + 1` at line 20994/21094. While this works in practice due to JavaScript's falsy coercion, it makes the state harder to reason about and could interact poorly with any code that checks `typeof this._uploadingCount`.

### BUG 6 (DESIGN): No explicit "images ready" state — relies on mutation of shared entry objects

The `entry` object created at line 21081 is pushed into `_images` with `path: null`, then mutated at line 21115 (`entry.path = data.path`). The `send()` function at line 20832 filters for `img.path` being truthy. This is fragile because:
- The entry is a shared mutable reference
- There's no event/notification when an entry's path becomes available
- If `send()` runs between the `push` and the `path` assignment, the image is silently excluded

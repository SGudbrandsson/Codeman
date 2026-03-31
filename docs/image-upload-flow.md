# Image/File Attach and Send Pipeline

This document describes the rewritten image attach and send flow in the Codeman web UI.

## Overview

Images and files are uploaded to the server, stored in `~/.codeman/screenshots/`, and their
absolute file paths are embedded as **inline references** within a single-line text message.
The combined message is sent to the Claude CLI PTY via `writeViaMux()`. Claude reads the
file paths from the inline `[Image: /path]` and `[Attached file: /path]` markers.

---

## Upload Phase

1. User pastes an image (Ctrl+V) or attaches a file via the compose bar.
2. The file is uploaded via `POST /api/screenshots` (images), which stores it in
   `~/.codeman/screenshots/`.
3. A thumbnail appears in the compose bar's thumbnail strip while uploading.
4. On upload success, the entry in `InputPanel._images[]` gets its `.path` set to the
   absolute server path (e.g. `/home/user/.codeman/screenshots/screenshot_2026-03-31_19-46-46.png`).
5. Non-image files go through `InputPanel._files[]` with a similar flow.

### Server-side upload: POST /api/screenshots (system-routes.ts)

- Accepts multipart/form-data.
- Saves file to `~/.codeman/screenshots/screenshot_YYYY-MM-DD_HH-MM-SS.ext`.
- Returns `{ success: true, path: "/home/user/.codeman/screenshots/screenshot_...", filename: "screenshot_..." }`.
- Images can be retrieved via `GET /api/screenshots/:name`.

---

## Send Phase (InputPanel._sendInner in app.js)

1. `_sendInner()` waits for any in-flight uploads to complete (`_uploadsCompletePromise`).
2. Builds a **single-line** text message with inline references:
   - Images: `[Image: /absolute/path/to/file.png]`
   - Files: `[Attached file: /absolute/path/to/file.pdf]`
   - Format: `[Image: /path1] [Image: /path2] [Attached file: /path3] user's typed text`
3. Captures `activeSessionId` **before** any async work to prevent session-switch races.
4. Sends as a single line via `app.sendInput(inputString + '\r', sessionId)` -- no multi-line,
   no tmux timing issues.
5. On failure: restores textarea text and images, shows error toast.
6. On success: shows optimistic UI bubble with the full sendText (including `[Image:]` refs).

---

## Why Single-Line (Critical Design Decision)

Previous attempts sent image paths as separate lines via tmux `send-keys`. This caused:

- **Ink discards typed input during working state.** Claude Code's terminal framework (Ink)
  drops keystrokes while it is processing, so image paths sent first would get dropped.
- **Multi-line sends use `C-j` between lines with 50ms delays** -- unreliable timing meant
  lines could arrive out of order or be swallowed entirely.
- **Image paths sent first, text sent later** -- the text would arrive but image paths would
  be lost, or vice versa.

This was the root cause of 8+ bug reports. Sending everything as a single line with inline
markers eliminates the entire class of timing bugs.

---

## Transcript Rendering (TranscriptView._renderTextBlock in app.js)

### User message blocks

1. Detects `[Image: /path]` and `[Image: source: /path]` patterns via regex.
2. Detects `[Attached file: /path]` patterns.
3. Strips these references from the display text.
4. Renders in order: **text first** (primary content), then **image thumbnails** in a
   horizontal strip, then **file chips**.
5. Image thumbnails are fixed 4:3 aspect ratio with `object-fit: cover` -- handles any
   source dimensions.
6. Single image: 180x135px. Multiple: 120x90px each. Assistant-side: 240x180px.
7. Each thumbnail has a download button (appears on hover) and opens lightbox on click.

### Assistant message blocks

1. `replaceImagePaths()` processes rendered markdown HTML.
2. Matches `[Image: /path]`, `[Image: source: /path]`, `[Attached file: /path]`, and bare
   absolute image paths.
3. Replaces with inline `<span class="tv-img-preview">` elements with download buttons.
4. Skips matches inside `<code>` or `<pre>` blocks.

---

## Lightbox

- Click any image preview (user or assistant) to open full-size in lightbox overlay.
- Backdrop blur, fade-in animation.
- Click backdrop or press Escape to close.
- Download button available on hover.

---

## Server-side Input: POST /api/sessions/:id/input (session-routes.ts)

- Receives the single-line input string.
- Passes directly to `session.writeViaMux()` -- no waiting for idle, no delays.
- The `/clear` command is intercepted before writing to tmux.

---

## Key Files

| File | Relevant symbols |
|---|---|
| `src/web/public/app.js` | `InputPanel.send()`, `InputPanel._sendInner()`, `TranscriptView._renderTextBlock()`, `replaceImagePaths()` |
| `src/web/public/styles.css` | `.tv-img-preview`, `.tv-img-strip`, `.tv-img-download`, `.tv-file-ref`, `.tv-lightbox` |
| `src/web/routes/session-routes.ts` | `POST /api/sessions/:id/input` |
| `src/web/routes/system-routes.ts` | `POST /api/screenshots`, `GET /api/screenshots/:name` |

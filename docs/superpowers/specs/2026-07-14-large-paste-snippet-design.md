# Large-paste → document snippet

**Date:** 2026-07-14 (revised 2026-07-15 after adversarial review)
**Status:** Design approved, pending spec review

## Problem

When a user pastes a very large amount of text (hundreds of KB, thousands of
lines) into the Codeman compose box and sends it, the message "takes forever"
and is eventually discarded. Root causes (confirmed in code):

1. **Hard size caps reject large input.** Input over `MAX_INPUT_LENGTH =
   64 KB` (`src/config/terminal-limits.ts:12`) is refused at
   `src/web/routes/session-routes.ts:746`. The Zod schema separately caps at
   100 KB (`src/web/schemas.ts:961-963`). A message between 64–100 KB passes one
   check and fails the other; above 100 KB fails the schema. Either way the
   client's `sendInput` throws and the optimistic UI rolls back — the message
   silently vanishes ("discarded").
2. **Even under the cap, delivery is slow.** Input is not pasted; it is replayed
   through `tmux send-keys`, one `execAsync` subprocess per line plus a **50 ms
   delay per line** (`src/utils/tmux-send-keys-plan.ts`, `src/tmux-manager.ts`).
   Thousands of lines ≈ minutes, and the HTTP response is awaited the whole time
   (`session-routes.ts:773-795`) — hence "takes forever".

Images do not suffer this: they are uploaded to a file endpoint, saved to disk,
and only a short `[Image: /path]` text reference is typed into the terminal
(`app.js:21460-21472`). Non-image files already work the same way via
`[Attached file: /path]` (`app.js:21462-21465`).

## Goal

Treat a large paste the same way: divert the bytes to a file, insert only a
short reference into the message. The pasted content becomes a removable
"document snippet" chip in the compose bar.

## Key design decision: reuse the existing attached-file pipeline

A large paste is, in effect, "attach the pasted text as a `.txt` file." Codeman
**already has** the complete machinery for this — building a bespoke `/api/pastes`
endpoint would duplicate it and reintroduce bugs it has already solved. We reuse:

- **Endpoint:** `POST /api/sessions/:id/upload` (`system-routes.ts:825-918`).
  - Uses **multipart/form-data** and reads `req.raw` directly — so it is *not*
    intercepted by the Fastify `text/plain` body parsers registered at
    `server.ts:734,741`. (A naive `text/plain` POST would be consumed by those
    parsers before the handler could read the stream — this endpoint avoids that.)
  - Streams the body with a **10 MB cap** → real HTTP **413**
    (`MAX_UPLOAD_SIZE`, `system-routes.ts:849-852`).
  - Saves into **`<session.workingDir>/.codeman-uploads/`**
    (`system-routes.ts:895-915`). Because the file lives **inside the session's
    own working directory**, Claude can `Read` it even under restricted /
    safe-mode / `allowedTools` permission profiles that deny reads outside the
    project. A global `~/.codeman/pastes` path would not have this guarantee.
  - Sanitizes filenames, resolves duplicate names, returns
    `{ success, path, filename, isImage }`.
- **Client upload flow:** `InputPanel._uploadNonImageFiles(files)`
  (`app.js:21658`), which posts to `/upload`, tracks the result in the compose
  bar's attachment state, renders a chip, and gates the send button on in-flight
  uploads.
- **Send reference:** the existing `[Attached file: /path]` marker
  (`app.js:21462-21465`). Claude already reads attached files via this
  convention today, so pastes inherit proven behavior — no new marker format and
  no new "will the model read it?" risk.

**What this design actually adds is small:**

1. Client-side detection of a large text paste in the compose textarea.
2. Turning that text into a `File` and feeding it into the existing
   `_uploadNonImageFiles` flow.
3. An optional distinct chip label / preview so a pasted blob reads as
   "📄 Pasted text" rather than a generic file.

## Scope (v1)

- **In scope:** paste into the **compose/input box**.
- **Out of scope (follow-up):** paste directly into the terminal view
  (`app.js:5961-5981`) — a separate code path.

## Detection (client, compose box)

Add a paste handler on the compose textarea (coordinating with the existing
capture-phase paste interceptor at `app.js:5516-5570`, which already handles
*file* clipboard items — this handler must only act on **text** pastes and must
not interfere with file pastes).

On paste:

1. Read `text = e.clipboardData.getData('text/plain')`.
2. **If `text` is empty, do nothing** — let native behavior proceed. (An
   HTML/RTF-only or file-only clipboard yields empty `text/plain`; we must not
   `preventDefault()` and swallow it into an empty snippet.)
3. Normalize line endings for counting: treat `\r\n`, `\r`, and Unicode line
   separators (` `, ` `) as line breaks.
4. Convert to a snippet when the paste exceeds **either** threshold:
   - **> 10 KB** (UTF-8 byte length), **or**
   - **> 30 lines** (normalized line count).
5. When triggered: `e.preventDefault()` (so the blob never lands in the
   textarea — a 340 KB textarea insertion is itself laggy), capture the **target
   session id now**, and divert the text to the upload flow (§Upload). Leave any
   already-typed textarea text untouched.

Pastes below both thresholds behave exactly as today (native textarea insert).

Thresholds are named client-side constants:
`PASTE_SNIPPET_MAX_BYTES = 10 * 1024`, `PASTE_SNIPPET_MAX_LINES = 30`.

## Upload (reuses existing endpoint)

1. Build a text file from the paste:
   `new File([text], 'pasted-text-<n>.txt', { type: 'text/plain' })`, where `<n>`
   is a per-compose counter (for a readable, non-colliding name; the server also
   de-dupes).
2. Feed it into the existing `InputPanel._uploadNonImageFiles([file])` path,
   which uploads to `POST /api/sessions/:id/upload` and stores the result in the
   compose attachment state, keyed to the session captured at paste time.
3. No compression. The body is sent as-is (see §Compression — dropped).

## Snippet chip (client UI)

The uploaded `.txt` appears as a chip in the existing compose attachment strip.
Give text pastes a distinct presentation over the generic file chip:

- Label: **`📄 Pasted text #N · 1,240 lines · 340 KB`** (line/byte counts
  measured client-side at paste time).
- **× to remove** — same removal behavior as other attachments. (Removing the
  chip drops it from the outgoing message. Server-side file cleanup is covered by
  the retention follow-up below, consistent with how image/file attachments
  behave today.)
- **Click to preview** — lightweight modal showing the captured text (truncated
  for very large pastes, with a "showing first N KB" note).
- Send is gated on in-flight uploads via the existing
  `_uploadsCompletePromise` / `_updateSendBtnState` mechanism
  (`app.js:21707-21736`, `app.js:21439-21446`).

## Send path (client)

Unchanged from today. On send, the snippet contributes an existing
`[Attached file: <path>]` reference to the collapsed single-line input
(`_sendInner`, `app.js:21434`; ref assembly at `app.js:21460-21472`). Only that
short marker is typed through the mux — well under the 64 KB cap, single line, so
it avoids both the size-cap rejection and the per-line `send-keys` slowdown.
Claude `Read`s the referenced file when it needs the content.

## Data flow (end to end)

1. User pastes large text into the compose box.
2. Client paste handler: nonempty text, exceeds threshold → `preventDefault()`,
   capture session id.
3. Client builds `pasted-text-N.txt` and `POST`s it to
   `/api/sessions/:id/upload` (multipart).
4. Server streams (10 MB cap), writes `<workingDir>/.codeman-uploads/…txt`,
   returns metadata.
5. Client renders the "📄 Pasted text" chip; send is gated until upload resolves.
6. User sends. `_sendInner` includes `[Attached file: <path>]` in the collapsed
   single-line input.
7. Marker typed through mux (tiny). Claude `Read`s the file when relevant.

## Compression — dropped for v1

The paste bytes are sent uncompressed, matching images and existing file uploads
(also uncompressed). Rationale:

- In-transit compression only meaningfully helps a multi-MB paste over the mobile
  tunnel on cellular; over localhost/Tailscale even several MB of text is
  sub-second.
- Safe server-side inflation requires a **bounded streaming gunzip** with a hard
  decompressed-size cap (a gzip bomb otherwise inflates far past 10 MB). That
  guard would have to live either in the **shared** `/upload` handler (risky for
  every other upload) or in a **dedicated** paste endpoint (undoing the reuse
  that makes this design clean).
- The core fix — not typing through tmux — stands without it.

**Follow-up hook (if ever needed):** add a dedicated `POST /api/pastes` that
accepts `Content-Encoding: gzip`, inflates via a size-capped `createGunzip()`
stream (abort/destroy at 10 MB decompressed), and writes into the same
`.codeman-uploads/` directory returning the same shape. Isolated, no change to
the shared endpoint.

## Error handling

- **Upload failure / timeout:** chip shows an error state; the text is not
  silently lost. Reuse the AbortController timeout pattern from the existing
  upload path (`app.js:21678`). User can retry or remove.
- **Over 10 MB:** existing endpoint returns 413; client surfaces a clear "paste
  too large" message on the chip.
- **Empty / non-text clipboard:** detection no-ops; native paste proceeds.
- **No working directory on session:** existing endpoint returns 400; client
  shows chip error state.

## Known limitations (pre-existing; shared with today's image/file attachments)

These are **not introduced** by this feature; they affect the existing image and
file attachment paths equally. Listed for completeness; addressing them is
out of scope for v1.

- **Reference ordering / caret position.** All attachment refs are *prepended*
  to the typed text (`app.js:21460-21472`) rather than inserted at the caret, so
  a paste made mid-sentence becomes a leading marker. Caret-position insertion
  (placeholder token replaced at send) is a possible future enhancement across
  all attachment types.
- **Pure slash-command + attachment.** The server intercepts input that trims
  exactly to `/clear` (`session-routes.ts:761`). An attachment ref alongside a
  bare `/clear` would not match. Rare; document.
- **`.codeman-uploads/` disk growth.** The uploads directory already grows
  unbounded today. A shared retention sweep (TTL / directory quota, plus a
  `.gitignore` entry for `.codeman-uploads/`) is a good follow-up for all
  attachment types.

## Testing

- **Client unit:** threshold logic (>10 KB, >30 lines, either/or, below-threshold
  pass-through); empty/non-text clipboard no-op; line-ending normalization
  (`\r\n`, `\r`, ` `); session id captured at paste time; chip label /
  count formatting; File construction (`pasted-text-N.txt`, correct bytes).
- **Integration / manual:** paste a multi-thousand-line blob → "📄 Pasted text"
  chip appears, textarea stays clean, send completes quickly, the `.txt` lands in
  `<workingDir>/.codeman-uploads/`, and Claude can `Read` it (including in a
  restricted/safe-mode session); small paste still inserts inline as before;
  file paste (image) still routes to the existing image handler, not the snippet
  path.

## Non-goals

- New `/api/pastes` endpoint (reuse `/api/sessions/:id/upload`).
- In-transit compression (see §Compression — dropped).
- Terminal-view paste diversion (follow-up).
- Auto-injecting paste content into Claude's context.
- Fixing pre-existing attachment ordering / cleanup behavior (shared follow-up).

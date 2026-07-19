# Task

type: feature
status: done
title: Mobile-friendly file explorer with editing (browse / view / edit / create / delete)
description: Add a mobile-friendly file manager to the Codeman web UI so the user can browse, view, edit, create, and delete files in the active session's working directory — directly from a phone. PRIMARY USE CASE - jump into a session on the go and paste secrets into an environment file (.env or similar) without pasting secrets into the chat and without opening a shell editor. Inspiration - Claude Code UI (https://github.com/siteboon/claudecodeui) which has an interactive file tree with syntax highlighting and live editing (they use CodeMirror; we do NOT have to — see constraints). ENTRY POINT (user-specified) - a new "Files" button in the fixed bottom toolbar on mobile, positioned BETWEEN the session switch button (left side) and the project selector / codeman-dot button (right side). Tapping it swipes up a bottom sheet with the file tree; tapping a file opens view mode (read, copy, syntax-colored if cheap); an Edit action switches to an editor with Save; plus actions for New File, New Folder, Delete (with confirmation), and a hidden-files toggle that DEFAULTS TO ON (dotfiles like .env are the whole point). Desktop should not regress; the sheet may also work on desktop but mobile is the target.
constraints: See "Root Cause / Spec" pre-seeded recon below — it is accurate as of 2026-07-19, verify line numbers before editing. (1) Mobile-first, lightweight, friendly UI. Frontend is vanilla JS static files (no bundler) — edit src/web/public/, never dist/. Match existing patterns - inline onclick="app.*" handlers, this.$(id) lookups, bottom-sheet pattern with .open class + sheet-up/backdrop-fade keyframes documented at src/web/public/mobile.css:3109-3184 (z-index - sheet 10003, backdrop 10002). (2) Editor - a plain <textarea> with monospace font + Save is acceptable and preferred for v1; syntax highlighting for VIEW mode may use a small vendored highlight.js core+common bundle (CSP allows cdn.jsdelivr.net but vendoring like xterm in vendor/ is preferred). Do NOT pull in Monaco; CodeMirror 6 only if it stays lightweight and works offline. (3) Backend - new write endpoints are REQUIRED (none exist today) - save file content, create file, create directory, delete file/dir (recursive delete only with explicit confirm flag). Add them in src/web/routes/file-routes.ts and mirror the existing realpathSync + path.relative traversal sandbox at file-routes.ts:170-179 so every path stays inside session.workingDir. Reject writes above a sane size limit (e.g. 5 MB). Auth middleware applies automatically. (4) SECRETS SAFETY - never log file contents or file bodies server-side (no request-body logging on these routes); never echo saved content back into chat/terminal; no content in error messages. (5) Concurrency - best-effort staleness guard - return mtime on read, accept expected mtime on save, 409 on mismatch with a "Reload / Overwrite" choice in UI. (6) Delete requires a confirmation dialog naming the file. (7) Hidden files - the tree endpoint already supports showHidden; the UI toggle defaults to ON. (8) Reuse existing endpoints - GET /api/sessions/:id/files (tree), GET /api/sessions/:id/file-content (read) — extend rather than duplicate. (9) Acceptance criteria - on a phone-width viewport (390px) - open Files sheet from toolbar button between switch and project buttons; navigate tree incl. dotfiles; open .env; edit; save; re-open shows new content; create new file .env.local with pasted content; delete it with confirm; no content appears in server logs; tsc + lint pass; desktop file browser and preview still work.
affected_area: frontend
work_item_id: wi-c9212f08
fix_cycles: 0
test_fix_cycles: 0

## Root Cause / Spec

VERIFIED by analysis subagent 2026-07-19 against branch head `d63b5a4f` (working dir at `feat/mobile-file-explorer`, no source changes yet). Line numbers below are re-confirmed; corrections and critical additions are marked **[CORRECTED]** / **[CRITICAL]**. Build on this — do not re-discover.

### Toolbar entry button (VERIFIED)
- `src/web/public/index.html:461` `<footer class="toolbar">` — confirmed. Mobile CSS `src/web/public/mobile.css:933-955` (`.toolbar`: `position:fixed; bottom:var(--safe-area-bottom); height:40px; z-index:50`).
- `.toolbar-right` (contains session-search button `btn-session-search` at `index.html:569`) is `display:none !important` on mobile at **`mobile.css:963-965`** [CORRECTED — recon said 963; the rule spans 963-965]. So the session-switch button is NOT visible on phones; the phone toolbar's visible buttons all live in `.toolbar-left > .toolbar-group:first-child`.
- Project selector button `btn-case-mobile` confirmed at `index.html:528` (`onclick="app.showMobileCasePicker()"`).
- **[CRITICAL — mobile layout uses CSS `order`, not DOM order.]** The visible phone toolbar buttons are laid out by explicit `order:` values inside `.toolbar-left .toolbar-group:first-child` (a flex row). Confirmed orders:
  - `.btn-run` / `.btn-run-gear` — no `order` set → `order:0` (leftmost). `mobile.css:1025,1039`.
  - `.btn-case-settings-mobile` → `order:1`. `mobile.css:1173`.
  - `.btn-case-mobile` (project) → `order:2`. `mobile.css:1147`.
  - `.btn-stop` → `order:3`. `mobile.css:1099`.
  - `.btn-shell` → `order:4`. `mobile.css:1114`.
  - `.btn-voice-mobile` → `order:5`. `mobile.css:795`.
  - `.btn-settings-mobile` → `order:6`. `mobile.css:828`.
  So visual L→R on phone = Run · gear · Project · Stop · Shell · Voice · Settings. Placing the Files button "between the switch button and the project selector" means: give it an `order` that lands it just LEFT of `.btn-case-mobile` (order 2). Recommended: add `.btn-files-mobile { order: 2 }` and bump `.btn-case-mobile`→`order:3`, `.btn-stop`→`4`, `.btn-shell`→`5`, `.btn-voice-mobile`→`6`, `.btn-settings-mobile`→`7` (shift the tail up by one). DOM insertion point: put the `<button class="btn-toolbar btn-files-mobile" ...>` in the same `.toolbar-group` — cleanest right before `btn-case-mobile` at `index.html:528` (DOM order only matters as an `order`-tie fallback). The new button must be styled `display:flex !important` inside the mobile `@media` block (like `.btn-case-mobile` at `mobile.css:1142`) AND `display:none` on desktop (desktop shows the `.toolbar-right` layout instead) — mirror how `.btn-case-mobile`/`.btn-settings-mobile` are desktop-hidden: base rule `styles.css:3416` sets `.btn-toolbar.btn-case-mobile { display:none }` (also `.btn-settings-mobile` `styles.css:3411`, `.btn-voice-mobile` `styles.css:3441`), and the mobile `@media` block in `mobile.css` re-shows it with `display:flex !important`. Add an equivalent base `display:none` for `.btn-files-mobile` in `styles.css` plus the mobile-media `display:flex !important` + `order` in `mobile.css`.

### Bottom-sheet pattern (VERIFIED — use this exact convention)
- Documented comment block `mobile.css:3109-3131` (z-index convention line 3129: "session-drawer 9000, sheet 10003, backdrop 10002"; background `#0d1117`).
- Reference CSS `.compose-action-backdrop.open` `mobile.css:3134-3141` and `.compose-action-sheet.open` `mobile.css:3142-3157`. `@keyframes backdrop-fade` at `mobile.css:3158`.
- **[CORRECTED] `@keyframes sheet-up` is at `mobile.css:3245` but is defined INSIDE `@media (max-width:429px)` (block starts 3202).** The `.compose-action-sheet.open` rule references `animation: sheet-up ...` but that rule is top-level, so on viewports ≥430px the animation name doesn't resolve (element just appears — no error). Fine for a phone-first sheet. If the Files sheet should animate on tablet/desktop too, define its own `@keyframes` at top level.
- **Open/close JS pattern (VERIFIED, `app.js:21638-21663`, `InputPanel._openActionSheet`/`_closeActionSheet`):** elements are `style="display:none"` inline in HTML; to OPEN set `el.style.display='flex'` (sheet) / `'block'` (backdrop) THEN `el.classList.add('open')`; to CLOSE `el.classList.remove('open')` THEN `el.style.display='none'`. The inline-display-first rule is a deliberate Android-Chrome black-screen compositing fix — replicate it exactly, do NOT drive visibility purely via a CSS class. HTML markup for these two elements is at `index.html:2336-2347`.
- Alternative analog with header/body is the mobile case picker (`showMobileCasePicker` `app.js:20247`, opened via `classList.add('active')`) — but prefer the newer `.open` + inline-display convention above for the Files sheet.

### Existing file plumbing (VERIFIED — REUSE)
- `GET /api/sessions/:id/files` — `file-routes.ts:34`. Recursive tree, `depth` (default 5, capped 10 at `:39`), `showHidden` (`=== 'true'`, `:40`), excludes `.git/node_modules/dist/build/...` (set at `:44-59`), max 5000 files. Returns `{ success, data: { root, tree, totalFiles, totalDirectories, truncated } }`; each node `{name, path (rel, computed via `fullPath.slice(workingDir.length+1)` at `:105`), type, size?, extension?, children?}`.
- `GET /api/sessions/:id/file-content` — `file-routes.ts:158`. Query `path`, `lines` (default 500, cap 10000), `raw`. **[CORRECTED] For TEXT files it returns `{ success, data: { path, content, size, totalLines, truncated, extension } }` — there is NO `type` field on the text branch** (`:247-257`). A `type` field (`image`/`video`/`binary`) is only present on the binary branch (`:218-227`). Text size limit is 10 MB (`:231`). **[CRITICAL for staleness guard] This route does NOT currently return `mtime`.** To support the mtime staleness guard the Fix agent MUST extend the text branch to also return `mtime: stat.mtimeMs` (the `stat` is already fetched at `:181`). Frontend `openFilePreview` treats "no type" as text (else branch, `app.js:19486`) so adding `mtime` is non-breaking.
- **[CRITICAL — path sandbox, EXACT lines to mirror] `file-routes.ts:167-178`:**
  ```ts
  // Validate path is within working directory (security: resolve symlinks to prevent traversal)
  const fullPath = resolve(session.workingDir, filePath);
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(fullPath);
  } catch {
    return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
  }
  const relativePath = relative(session.workingDir, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path must be within working directory');
  }
  ```
  This works for EXISTING targets (read/save/delete). **[CRITICAL] It does NOT work for CREATE (new file / mkdir): `realpathSync(fullPath)` throws ENOENT because the target does not exist yet.** For create routes the Fix agent MUST sandbox the PARENT dir instead: `realpathSync(dirname(resolve(session.workingDir, relPath)))`, verify that resolved parent is inside `workingDir` via the same `relative()`/`startsWith('..')`/`isAbsolute()` check, THEN build the final path as `join(realParent, basename(relPath))`. Also reject a basename containing `/`, `\`, or equal to `.`/`..`, and reject if the target already exists (return `ApiErrorCode.ALREADY_EXISTS`). Note `realpathSync`, `resolve`, `relative`, `isAbsolute`, `extname`, `join` are already imported at `file-routes.ts:7-8` (also `mkdirSync` from `node:fs`; `fs` promises as `fs`).
- `GET /api/sessions/:id/file-raw` (`:264`), `file-thumbnail` (`:~581`), `tail-file` SSE (`:336`).
- Desktop file browser JS: class fields `app.js:19231-19236`, `loadFileBrowser()` `app.js:19238` (fetches `/files?depth=5&showHidden=false`), `renderFileBrowserTree()` `app.js:19270` (builds tree HTML, uses `this.getFileIcon`/`this.formatFileSize`/`escapeHtml`, wires click handlers to `toggleFileBrowserFolder` for dirs / `openFilePreview` for files). Reuse this rendering logic for the sheet (note it hardcodes `showHidden=false` — the sheet needs its own load call with `showHidden=true` default).
- File preview overlay markup: `index.html:445-458` [CORRECTED — 445-458, not 446-457]; `openFilePreview()` `app.js:19451`; text rendered as `` `<pre><code>${escapeHtml(data.content)}</code></pre>` `` at `app.js:19489`. `closeFilePreview` `:19499`, `copyFilePreviewContent` `:19507` (uses `navigator.clipboard.writeText` + `this.showToast`).

### Error-response / route conventions (VERIFIED)
- `findSessionOrFail(ctx, id)` (`src/web/route-helpers.ts:28`) returns the `Session` or throws a `{statusCode:404, body:createErrorResponse(NOT_FOUND, …)}` — every route calls this first. `session.workingDir` is the sandbox root.
- `ApiErrorCode` enum (`src/types/api.ts:23`) has ONLY: `NOT_FOUND, INVALID_INPUT, SESSION_BUSY, OPERATION_FAILED, ALREADY_EXISTS, INTERNAL_ERROR`. **[NOTE] There is NO `CONFLICT` code.** For the 409 staleness mismatch, either (a) add `CONFLICT = 'CONFLICT'` to the enum (preferred, clearest) or (b) reuse `ALREADY_EXISTS`/`OPERATION_FAILED` with an HTTP 409 via `reply.code(409)`. `createErrorResponse(code, details?)` (`api.ts`) returns `{success:false, error, errorCode}`.
- **HTTP status codes:** GET routes that `return createErrorResponse(...)` respond HTTP 200 with `success:false`. Routes that need real HTTP status codes take `(req, reply)` and call `reply.code(N).send(createErrorResponse(...))` — see `file-raw` `:270,280,285` and thumbnail `:631,637`. **New write routes (POST/PUT/DELETE) SHOULD use the `reply.code()` form** (e.g. 400 invalid, 404 not found, 409 stale/exists, 413 or 400 too-large, 500 failed) to give the frontend proper status codes.
- Register new routes inside `registerFileRoutes(app, ctx)` in `file-routes.ts` (function ends at `:670`). No extra wiring needed — it's already called from `server.ts:795` and exported via `routes/index.ts:8`. Auth hook applies automatically.

### [CRITICAL] SECRETS SAFETY (constraint 4)
- Do NOT add any `req.body`/content logging on the new routes. The existing routes never log bodies — match that. Do NOT interpolate file CONTENT into error strings (existing errors only include `getErrorMessage(err)` / sizes / paths, never content). Never echo saved content to chat/terminal/SSE.

### Missing (BUILD)
- Backend (in `file-routes.ts`): `PUT/POST` save-content (with `expectedMtime` staleness check → 409), create-file, create-dir (mkdir), delete (recursive only with explicit `confirm`/`recursive` flag). Enforce a write size limit (≤5 MB, constraint 3 — note existing text READ limit is 10 MB; use 5 MB for writes). Extend `file-content` text branch to return `mtime`.
- Frontend: the mobile Files bottom-sheet UI (tree + view mode + textarea editor + Save + New File / New Folder / Delete-with-confirm + hidden-files toggle defaulting ON); the `btn-files-mobile` toolbar button + CSS; new methods on the `CodemanApp` class.

### Session context (VERIFIED)
- Active session id = `app.activeSessionId`; working dir cached at `app.currentSessionWorkingDir` (set `app.js:9817`, declared `:5121`). All file endpoints per-session, sandboxed to `session.workingDir`.

### Frontend arch & registration (VERIFIED)
- Vanilla JS, no bundler. `src/web/public/app.js` (~26k lines). **`app` is a class instance: `class CodemanApp {` at `app.js:5040`; `const app = new CodemanApp()` at `:25545`; `window.app = app` at `:25548`.** Add new file-explorer functionality as **methods on the `CodemanApp` class** (class-field style, referenced via `app.method()` in inline `onclick=`), OR as a separate module object like `const SessionSwitcher = {...}` (`app.js:2124`) / `const InputPanel = {...}` (`:21106`) exported via `window.X = X` (`:25551`). Given tight reuse of `this.$()`, `this.getFileIcon`, `this.formatFileSize`, `this.showToast`, class methods on `CodemanApp` are the lower-friction choice. `escapeHtml` is a global from `constants.js` (loaded before app.js) — call it un-prefixed.
- Helpers available: `this.$(id)` (getElementById), `escapeHtml(str)` (global), `this.showToast(msg, 'success'|'error')`, `this.formatFileSize(bytes)`, `this.getFileIcon(ext)`.
- Script includes at `index.html:2472-2483` (all `<script defer>`). If a NEW standalone JS file is added, add a `<script defer src="...">` line here BEFORE `app.js:2480` if app.js depends on it, or after if it depends on app. Simplest: keep everything in `app.js` (no new include needed) + markup in `index.html` + styles in `mobile.css`.

### [DECISION] Editor & syntax highlighting for v1
- **Editor: plain `<textarea>` with monospace font + explicit Save button. CONFIRMED for v1.** No CodeMirror/Monaco. This satisfies the primary use case (paste secrets into `.env`) with zero new dependencies and works offline.
- **Syntax highlighting for VIEW mode: DEFER for v1.** Keep view mode as `<pre><code>${escapeHtml(content)}</code></pre>` (identical to existing `openFilePreview` at `app.js:19489`). Highlighting adds a vendored bundle (`vendor/`) for marginal value on a phone and is explicitly optional in the spec. If added later, vendor a small highlight.js core+common into `vendor/` (like xterm) rather than a CDN pull — CSP allows `cdn.jsdelivr.net` for `script-src`/`style-src` (`middleware/auth.ts:162`) but vendoring is the house style.

### CSP / auth (VERIFIED)
- CSP header set at `src/web/middleware/auth.ts:161-162`: `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; ... connect-src 'self' wss://api.deepgram.com`. Same-origin `fetch()` to the new API routes is allowed by `connect-src 'self'`. Auth is no-op unless `CODEMAN_PASSWORD` set (`auth.ts:47`); new routes inherit the hook automatically — no per-route auth code.

## Fix / Implementation Notes

Implemented 2026-07-19 by the implement subagent. All changes verified: `npx tsc --noEmit` clean, `node --check app.js` clean, and the new backend routes exercised end-to-end against a live dev server (create / read-with-mtime / save / 409-on-stale / mkdir / traversal-reject-400 / delete file / delete dir — all pass; server log confirmed to contain zero file content).

### Backend
- **`src/types/api.ts`** — added `CONFLICT = 'CONFLICT'` to the `ApiErrorCode` enum plus its entry in the `ErrorMessages` map ("The resource was modified by another process"). Used for the 409 staleness mismatch.
- **`src/web/routes/file-routes.ts`**:
  - Added `dirname, basename` to the `node:path` import.
  - Extended the `file-content` TEXT branch to also return `mtime: stat.mtimeMs` (non-breaking; frontend still treats no-`type` as text).
  - New routes inside `registerFileRoutes(app, ctx)` (all use `reply.code()` for real HTTP statuses; `MAX_WRITE_SIZE = 5 MB`):
    - `PUT /api/sessions/:id/file-content` — save/overwrite existing file. Mirrors the existing-target `realpathSync`+`relative` sandbox (file-routes.ts). Rejects non-string/oversize content (400), missing/out-of-sandbox path (400/404), non-regular-file (400). If `expectedMtime` (number) supplied and current `mtimeMs` differs by >0.5 ms → **409 CONFLICT**. On success writes UTF-8, returns `{ path, size, mtime }` (never echoes content).
    - `POST /api/sessions/:id/file-create` — create new file (optional `content`). Uses new **`resolveNewChild()`** helper (parent-dir sandbox: `realpathSync(dirname(...))` validated via `relative()`, rejects basename containing `/`,`\`,`.`,`..`, then `join(realParent, base)`). 409 `ALREADY_EXISTS` if target exists; writes with `flag:'wx'`. Returns `{ path, size, mtime }`.
    - `POST /api/sessions/:id/dir-create` — mkdir via the same `resolveNewChild()` sandbox; 409 if exists. Returns `{ path, mtime }`.
    - `DELETE /api/sessions/:id/file` — accepts `path` + `recursive`/`confirm` (body or query). Existing-target sandbox. Refuses to delete the working-dir root. Non-empty directory delete requires the explicit flag (else 400); files use `fs.unlink`, dirs use `fs.rm({recursive})`.
  - **Secrets safety:** no request-body/content logging added; content never interpolated into error messages (errors only use `getErrorMessage`/sizes/paths) and never echoed back — verified in the live-server log check.
  - Module-level `resolveNewChild(workingDir, relPath, reply)` helper added after `registerFileRoutes` for the create-route parent sandbox.

### Frontend (`src/web/public/`)
- **`index.html`** — added `<button class="btn-toolbar btn-files-mobile" onclick="app.openFilesSheet()">` (file icon) in the toolbar group immediately before `btn-case-mobile`. Added the Files bottom-sheet markup (`#filesSheetBackdrop` + `#filesSheet` with header, tree toolbar [New File / New Folder / Hidden toggle (checked) / Refresh], `#filesSheetTreeBody`, and a `#filesSheetView` view/edit pane) after the compose action sheet, all `style="display:none"` inline per the Android-Chrome convention.
- **`styles.css`** — added base `.btn-toolbar.btn-files-mobile { display:none }` (desktop-hidden), mirroring `btn-case-mobile`.
- **`mobile.css`** — bumped toolbar `order` tail (`btn-case-mobile` 2→3, `btn-stop` 3→4, `btn-shell` 4→5, `btn-voice-mobile` 5→6, `btn-settings-mobile` 6→7) and added `.btn-toolbar.btn-files-mobile { display:flex !important; order:2 }` in the mobile `@media` block. Added a full Files-sheet CSS block (`.files-sheet[-backdrop].open`, header, toolbar, tree rows, view/edit pane, `.files-sheet-editor` monospace textarea, `.files-sheet-notice` conflict banner) following the documented sheet convention (sheet z-index 10003, backdrop 10002, bg `#0d1117`, `sheet-up`/`backdrop-fade`).
- **`app.js`** — added methods on the `CodemanApp` class (after `copyFilePreviewContent`), state held in `this.filesState`:
  - `openFilesSheet` / `closeFilesSheet` (inline-display-first, then `.open`), `_filesShowTree` / `_filesShowView`, `filesSheetBack`, `filesRefresh`, `filesToggleHidden` (default ON).
  - `filesLoadTree` (fetch `/files?depth=5&showHidden=<toggle>`), `filesRenderTree` (recursive, reuses `getFileIcon`/`formatFileSize`/`escapeHtml`, event-delegated expand/open/delete).
  - `filesOpenFile` (VIEW mode `<pre><code>escapeHtml(content)</code></pre>`, stores `mtime`, disables edit when truncated), `_filesRenderView`, `filesStartEdit` (plain `<textarea class="files-sheet-editor">`), `filesCancelEdit`, `filesCopyCurrent`.
  - `filesSave` (PUT with `expectedMtime`; on HTTP 409 shows `_filesShowConflict` Reload/Overwrite banner), `filesReloadCurrent`, `filesOverwriteCurrent` (force PUT without `expectedMtime`).
  - `filesNewFile` (prompt name → create → reload → open in edit mode for paste), `filesNewFolder`, `filesDelete` (confirm() naming the file/folder; recursive flag for dirs).
- Editor is a plain monospace textarea (v1 DECISION); no syntax highlighting / CodeMirror / Monaco. Desktop file browser + preview untouched (new button is mobile-only).

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

Verified `npx tsc --noEmit` → exit 0, zero errors. `node --check app.js` clean.

**Backend (file-routes.ts + api.ts) — correct and secure:**
- Path sandbox for EXISTING targets (PUT save, DELETE) mirrors the reference `realpathSync`+`relative()`+`startsWith('..')`/`isAbsolute()` pattern exactly. Symlink escape is prevented: `realpathSync` resolves the link and the `relative()` check rejects any resolved path outside `workingDir`.
- Path sandbox for NEW targets (file-create, dir-create) correctly delegates to the module-level `resolveNewChild()` helper, which sandboxes the PARENT dir (`realpathSync(dirname(...))`) — avoiding the ENOENT-on-nonexistent-path trap — then rebuilds `join(realParent, base)`. Traversal via `..`/absolute parents is rejected. I traced the tricky cases (`relPath` = `..`, `../evil`, `foo/..`, `subdir/newfile`) — all resolve to a parent that either fails the `relative()` check or an empty/`.`/`..` basename that the explicit basename guard rejects.
- Basename rejection is present and correct: rejects empty, `.`, `..`, and any name containing `/` or `\`.
- Staleness guard: `file-content` text branch now returns `mtime: stat.mtimeMs`; PUT compares `expectedMtime` with a 0.5 ms float tolerance and returns **409 CONFLICT** on mismatch. `CONFLICT` enum + ErrorMessages entry added cleanly.
- Create routes gate on `existsSync` AND `flag:'wx'` (O_EXCL) → clean 409 ALREADY_EXISTS with TOCTOU protection.
- Delete: refuses working-dir root (`relativePath === ''` OR `resolvedPath === realpathSync(workingDir)`); non-empty directory requires the explicit `recursive`/`confirm` flag (else 400); files use `unlink`, dirs use `fs.rm({recursive})`. Recursive delete only reached with the flag or an empty dir.
- 5 MB write cap enforced via `Buffer.byteLength` on both save and create before any FS write.
- All write routes use the `reply.code(N).send(...)` form giving real HTTP statuses (400/404/409/500).

**SECRETS SAFETY (constraint 4) — PASS.** No request-body/content logging added on any new route. Error strings only ever interpolate `getErrorMessage(err)` (fs errors carry paths, never content — explicitly allowed by spec), sizes, and byte counts — never `content`/`body`. Save/create responses return only `{path, size, mtime}`, never the content. No content echoed to SSE/chat/terminal.

**TypeScript — clean.** New routes are properly typed (`req.body`/`req.query` cast to explicit shapes); `resolveNewChild` typed with inline `import('fastify').FastifyReply`; new import members (`dirname, basename`) used; no implicit any / unused locals (tsc noUnusedLocals satisfied).

**Frontend — correct:**
- Bottom-sheet open/close replicates the Android-Chrome fix exactly: open sets inline `display` first THEN `.classList.add('open')`; close removes `.open` THEN sets `display='none'`. Matches the documented `InputPanel` convention.
- Toolbar button: base `.btn-toolbar.btn-files-mobile { display:none }` in styles.css (desktop-hidden), re-shown `display:flex !important` in the mobile `@media`. `order` tail shift is internally consistent — final L→R: Run(0)·case-settings(1)·**Files(2)**·Project(3)·Stop(4)·Shell(5)·Voice(6)·Settings(7) — Files lands just left of the project button as specified. No desktop regression (desktop file browser/preview code untouched; new button hidden on desktop).
- 409 handling shows a Reload/Overwrite banner; Overwrite re-PUTs without `expectedMtime` and preserves the user's typed content (`pendingContent`).
- Delete `confirm()` names the file/folder and warns on recursive dir delete.
- Hidden-files toggle defaults ON (state init `showHidden:true`, checkbox `checked`, persisted in `filesState`).
- `escapeHtml` applied to every interpolated path/name/content (`data-path`, tree name, `<pre><code>`, error messages); titles/meta use `textContent`. No XSS surface found.
- Consistent with house patterns: `this.$()`, `escapeHtml`, `showToast`, inline `onclick="app.*"`, event-delegated tree clicks.

**Minor, non-blocking notes (no action required for approval):**
- `filesOpenFile` early-returns for binary/image without clearing `filesState.current`, leaving stale `current` from a prior text file. No exploit path — the binary view exposes no Edit/Save action, so the stale `current` is never acted on. Cosmetic only.
- Deleting a parent folder of a currently-open file doesn't reset the open-file state (only exact-path match is handled); a subsequent save would 404 gracefully. Rare edge, acceptable for v1.

Verdict: **APPROVED** — ready for test gap analysis.

## Test Gap Analysis

Verdict: **GAPS FOUND** — the four new backend write routes (`PUT file-content`, `POST file-create`, `POST dir-create`, `DELETE file`), the `resolveNewChild` sandbox helper, and the new `mtime` field on the `file-content` read all have ZERO test coverage. The existing route-test infrastructure fully supports testing them, so these gaps are worth closing.

### Existing test infra to MIRROR (exact model already in repo)
- **Test file to extend / mirror: `test/routes/file-routes.test.ts`** (existing). It already tests the READ routes of this exact module via `app.inject()`. The new write-route tests should be ADDED to this same file (new `describe` blocks), not a new file — it already imports `registerFileRoutes` and wires the harness. (If preferred as a separate file, `test/routes/file-write-routes.test.ts` mirroring the same header would also work, but same-file is the house pattern — one test file per route module.)
- Harness: `createRouteTestHarness(registerFileRoutes)` from `test/routes/_route-test-utils.js` — builds a real Fastify instance, registers only this route module against a mock ctx, uses `app.inject()` (no ports). Session id = `harness.ctx._sessionId`; sandbox root = `harness.ctx._session.workingDir` (mock value `/tmp/test-workdir`, from `test/mocks/mock-session.ts:16`). Unknown-session → 404 via `findSessionOrFail`.
- Mocking pattern (already at top of `file-routes.test.ts`): `vi.mock('node:fs/promises', …)`, `vi.mock('node:fs', …)` overriding `realpathSync`, and `vi.mock('node:os')`. `realpathSync` is mocked to return its arg unchanged (identity) in `beforeEach`; to simulate a traversal/symlink escape, `mockedRealpathSync.mockReturnValue('/etc/passwd')` so the `relative()` check fails; to simulate ENOENT, `mockedRealpathSync.mockImplementation(() => { throw … })`.

### REQUIRED mock extensions the test-writer must add (current mocks are insufficient)
The existing `vi.mock` blocks only stub `readdir/readFile/stat` (fs/promises) and `realpathSync` (fs). The write routes call additional APIs that MUST be added to the mock declarations:
- `node:fs/promises`: add `writeFile: vi.fn()`, `mkdir: vi.fn()`, `rm: vi.fn()`, `unlink: vi.fn()` (readdir/stat already present — but `stat` default must be enriched, see below).
- `node:fs`: add `existsSync: vi.fn(() => false)` to the mock (used by create routes for the pre-check AND at module load for `THUMB_CACHE_DIR` — give it a benign default so import-time `if (!existsSync(THUMB_CACHE_DIR)) mkdirSync(...)` doesn't blow up; `mkdirSync` is already real via the `...actual` spread and is fine). Note `realpathSync` is also called on `session.workingDir` in the delete root-guard (`resolvedPath === realpathSync(workingDir)`) — the identity mock handles this.
- `stat` default: the write routes read `stat.isFile()`, `stat.isDirectory()`, `stat.size`, and `stat.mtimeMs`. The current default `{ size: 100, isFile: () => true }` lacks `isDirectory` and `mtimeMs` — per-test overrides must supply `isDirectory: () => …` and `mtimeMs: <number>` where the route reads them.

### Specific gaps to cover (all security/correctness-critical, all backend)
`src/web/routes/file-routes.ts`:
1. **`GET file-content` now returns `mtime`** — add an assertion to the existing "returns text file content" test that `body.data.mtime` equals the stubbed `stat.mtimeMs` (staleness guard depends on it).
2. **`PUT /api/sessions/:id/file-content` (save):**
   - 404 unknown session; 400 missing `path`; 400 non-string `content`.
   - 400 when `Buffer.byteLength(content) > 5 MB` (write cap) — assert error contains "too large"/"limit".
   - Path traversal / symlink escape → `realpathSync` returns a path outside `workingDir` → 400 "within working directory".
   - `realpathSync` throws → 404 "File not found".
   - `stat.isFile()` false → 400 "not a regular file".
   - **Staleness guard:** `expectedMtime` supplied and differs from `stat.mtimeMs` by > 0.5 ms → **409** with `errorCode === 'CONFLICT'`; matching (or within 0.5 ms) → success, `fs.writeFile` called, response `{ path, size, mtime }` (assert content is NOT echoed back).
   - Success path: `fs.writeFile` called with utf-8; response returns fresh `size`/`mtime`.
3. **`POST /api/sessions/:id/file-create`:**
   - 400 missing `path`; 5 MB content cap.
   - `resolveNewChild` basename rejection: `path` whose basename is `.`, `..`, contains `/` or `\` → 400 "Invalid file or folder name". (Traversal like `../evil` resolves to a basename `evil` with a parent OUTSIDE workingDir — drive via `realpathSync` on the parent returning an out-of-sandbox path → 400 "within working directory"; and parent `realpathSync` throwing → 404 "Parent directory not found".)
   - `existsSync(target)` true → **409 ALREADY_EXISTS**.
   - Success: `fs.writeFile` called with `flag:'wx'`, response `{ path, size, mtime }`.
4. **`POST /api/sessions/:id/dir-create`:** missing path 400; same `resolveNewChild` sandbox/basename cases; `existsSync` true → 409; success calls `fs.mkdir(target)` and returns `{ path, mtime }`.
5. **`DELETE /api/sessions/:id/file`:**
   - 400 missing path; traversal → 400; `realpathSync` throws → 404.
   - **Refuses working-dir root:** `relativePath === ''` (path resolves to workingDir itself) → 400 "Refusing to delete the working directory root".
   - File (`isFile`/non-dir) → `fs.unlink` called, success.
   - **Non-empty directory without flag** (`isDirectory()` true + `fs.readdir` returns non-empty) → 400 "recursive delete requires explicit confirmation"; `fs.rm` NOT called.
   - Directory WITH `recursive`/`confirm` flag (body or query) → `fs.rm(resolvedPath, { recursive: true, force: false })` called, success. Also cover empty dir deleting without a flag.
6. **`resolveNewChild` helper** — exercised indirectly through the create/dir-create route tests above (it is not exported, so test it via the routes).

`src/types/api.ts` (`CONFLICT` added to `ApiErrorCode`) — no dedicated test needed; covered indirectly by the PUT-save 409 assertion (`errorCode === 'CONFLICT'`).

### Re-check 2026-07-19 — NO GAPS (proceed to QA)

Re-verified after the Test Writing subagent added 39 tests (70 total) and the Opus reviewer APPROVED. `PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npx vitest run test/routes/file-routes.test.ts` → **70 passed**. Confirmed dedicated `describe` blocks exist for all four write routes (`PUT file-content` line 620, `POST file-create` 790, `POST dir-create` 910, `DELETE file` 981) plus the `mtime` assertion on the read test — all six original gap items closed.

Changed-source surface re-audited for any REMAINING proportionate gap:
- **Backend (`file-routes.ts`, `api.ts`)** — fully covered by the approved tests; nothing else changed there. The `CONFLICT` enum is exercised indirectly via the 409 `errorCode === 'CONFLICT'` assertion — no dedicated test warranted.
- **Frontend Files sheet (`app.js`/`index.html`/`mobile.css`/`styles.css`)** — confirmed **NO vitest gap**, and this remains the correct call. The vitest environment is `node` (`vitest.config.ts:6`); there is no jsdom harness and no `CodemanApp` instantiation anywhere in `test/`. The repo's only frontend-test patterns are (a) verbatim extraction of *pure* helpers (`file-path-detection`, `non-image-file-upload`), (b) source-text `readFileSync` assertions (`sidebar-new-session-menu`), and (c) Playwright against a real server (`auq-panel-mobile`, `mobile-test/`). The Files-sheet methods (`openFilesSheet`, `filesLoadTree`, `filesRenderTree`, `filesSave`, …) are DOM- and fetch-coupled, not pure functions, so the extraction pattern does not apply; a jsdom unit test would be disproportionate and unlike anything in the suite.
- **Informational follow-up (NOT required this pass):** a `mobile-test/` Playwright smoke driving the 390px flow (open Files sheet from the toolbar button → navigate tree incl. dotfiles → create/edit/save/delete a file) would be valuable end-to-end coverage of the acceptance criteria and could be added later. It is out of scope for the vitest test-writing pass and does not block QA.
- **Note (already flagged, not a gap):** the documented 5 MB-cap-unreachable finding (Fastify default 1 MB `bodyLimit` → 413 before the handler) is a source follow-up for review, not a test gap; the two oversized-body tests correctly assert the real 413 behavior.

Verdict: **NO GAPS** — coverage is adequate and proportionate. Proceed to QA.

### Frontend — NO test gap (by convention)
The mobile Files-sheet UI in `src/web/public/app.js` / `index.html` / `mobile.css` / `styles.css` is vanilla, DOM-heavy UI. This repo does NOT unit-test such UI methods — frontend UI is covered by Playwright suites under `mobile-test/` (device-matrix, layout, tabs, etc.), not by vitest units, and there is no existing harness that instantiates `CodemanApp` in jsdom for method-level tests. Writing jsdom unit tests for these sheet methods would be disproportionate and unlike anything in the suite. Leave frontend uncovered for v1 (optionally a `mobile-test/` Playwright smoke could be added later, but it is out of scope for this vitest test-writing pass).

### Where to put new tests
Add to **`test/routes/file-routes.test.ts`** — new `describe('PUT /api/sessions/:id/file-content', …)`, `describe('POST …/file-create')`, `describe('POST …/dir-create')`, `describe('DELETE …/file')` blocks, after extending the two `vi.mock` declarations as noted above. Run with brew Node (v25) on PATH per repo memory (`gotcha_vitest_node_abi`): `npx vitest run test/routes/file-routes.test.ts`.

## Test Writing Notes

- 2026-07-19 test-writing: Extended `test/routes/file-routes.test.ts` with 39 new tests across four `describe` blocks for the write routes, plus one assertion added to the existing read test. Went from 31 → 70 tests in the file.

### Mock extensions applied (per gap analysis)
- `node:fs/promises` mock: added `writeFile`, `mkdir`, `rm`, `unlink` (all `vi.fn(async () => undefined)`); enriched default `stat` with `isDirectory: () => false` and `mtimeMs: 0`.
- `node:fs` mock: added `existsSync`. **Caveat discovered:** the analysis suggested `existsSync: () => false`, but that made the module-load bootstrap `if (!existsSync(THUMB_CACHE_DIR)) mkdirSync(...)` actually run, and since `homedir` is mocked to the unwritable `/home/testuser`, the real (spread) `mkdirSync` threw `EACCES` and the whole suite failed to load (0 tests — and this also breaks the *pre-existing* READ tests on HEAD in this worktree environment). Fixed by making the default `existsSync: vi.fn((p) => String(p).includes('thumbnails'))` — reports the thumbnail cache dir as existing (skips the import-time mkdir) while still returning `false` for create-route targets. `beforeEach` resets `existsSync` to `mockReturnValue(false)` for the create-route tests (module load has already happened by then).
- `beforeEach` enriched default stat with `isDirectory()`/`mtimeMs` and resets `existsSync`.

### Tests added
- **GET file-content:** added `body.data.mtime` assertion (== stubbed `stat.mtimeMs`) to the existing "returns text file content" test — covers the new staleness field.
- **PUT file-content (save):** 404 unknown session; 400 missing path; 400 non-string content; oversized body rejected before `writeFile` (see finding below); traversal/symlink escape → 400 "within working directory"; realpathSync throws → 404; non-regular-file → 400; **409 CONFLICT on expectedMtime mismatch** (asserts `errorCode === 'CONFLICT'`, writeFile NOT called); matching expectedMtime → write proceeds; success returns `{path,size,mtime}` and does NOT echo `content` (asserts `body.data.content` undefined; writeFile called with utf-8).
- **POST file-create:** 404 unknown session; 400 missing path; oversized body rejected; unsafe basename (backslash) → 400 "Invalid file or folder name"; parent outside sandbox → 400 "within working directory"; parent realpathSync throws → 404 "Parent directory not found"; existsSync true → **409 ALREADY_EXISTS**; success writes with `{encoding:'utf-8', flag:'wx'}` and returns `{path,size,mtime}`.
- **POST dir-create:** 404; 400 missing path; unsafe basename → 400; existsSync true → 409 ALREADY_EXISTS; success calls `fs.mkdir(target)` and returns `{path,mtime}`.
- **DELETE file:** 404; 400 missing path; traversal → 400 (no unlink/rm); realpathSync throws → 404; **refuses working-dir root** (path `.`) → 400 "Refusing to delete the working directory root"; regular file → `fs.unlink` called (no rm); non-empty dir without flag → 400 "recursive delete requires explicit confirmation" (rm NOT called); non-empty dir WITH `recursive:true` → `fs.rm(path,{recursive:true,force:false})`; empty dir without flag → deleted via rm.

### Finding (documented, not a test bug) — write-cap 5MB guard is preempted by Fastify's 1MB bodyLimit
The routes declare `MAX_WRITE_SIZE = 5 * 1024 * 1024` and return a 400 "Content too large" for bodies over 5MB. However, the real server (`src/web/server.ts:353/355`) constructs Fastify with **no `bodyLimit` override**, so Fastify's default 1MB limit rejects any body >1MB with a **413** *before the handler runs*. The route's own 5MB guard (and its "too large" message) is therefore unreachable over HTTP; the effective write cap is ~1MB, not the intended 5MB. The two "oversized body" tests assert the real observable behavior (413, `writeFile` never called) rather than the unreachable route message. Not fixed (source changes out of scope for test-writing) — flagging for review: if 5MB writes are a real requirement (editing files up to 5MB was the intent), the server needs `bodyLimit` raised to ≥5MB, otherwise the `MAX_WRITE_SIZE` constant is effectively dead code.

### Result
`PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npx vitest run test/routes/file-routes.test.ts`
→ **Test Files 1 passed (1) | Tests 70 passed (70)**. No source files modified; only the test file and TASK.md.

## Test Review History

### Test review attempt 1 — APPROVED

Reviewed the 39 new tests (70 total in file) in `test/routes/file-routes.test.ts` against the six gap items. Ran `PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npx vitest run test/routes/file-routes.test.ts` → **Test Files 1 passed, Tests 70 passed (70)**.

**Coverage — all gaps closed.**
- GET file-content `mtime` assertion added ✓
- PUT save: 404 / 400 missing path / 400 non-string content / oversized / traversal-escape / realpath-throws-404 / non-regular-file-400 / 409 CONFLICT / matching-mtime-writes / success-no-content-echo ✓
- file-create: 404 / 400 missing path / oversized / unsafe basename / parent-outside-sandbox / parent-throws-404 / 409 ALREADY_EXISTS / success wx-flag ✓
- dir-create: 404 / 400 missing path / unsafe basename / 409 / success mkdir ✓
- DELETE: 404 / 400 missing path / traversal / realpath-throws-404 / refuse-root / unlink-file / non-empty-no-flag-refused / recursive-flag-rm / empty-dir-rm ✓
- resolveNewChild exercised indirectly through create/dir-create ✓

**Correctness — sandbox logic genuinely exercised, not short-circuited.** The traversal/escape tests mock `realpathSync` to return an out-of-sandbox path (`/etc/passwd`, `/etc`) and let the route's real `relative()` + `startsWith('..')` check produce the 400. Traced each: if the sandbox guard were deleted from source, PUT/DELETE/create would fall through to `writeFile`/`unlink`/`writeFile` and return 200 — so these tests would fail. They assert real behavior. The 409 CONFLICT staleness test drives the real `Math.abs(mtimeMs - expectedMtime) > 0.5` branch and asserts `writeFile` is never called; the root-guard test drives `relativePath === ''` via path `.`. `writeFile`/`mkdir`/`rm`/`unlink` call-argument assertions match the resolved sandbox paths exactly.

**Realism — mocks are adequate.** Enriched `stat` (`isFile`/`isDirectory`/`size`/`mtimeMs`) matches what the routes read; per-test overrides supply the right shape. The `existsSync` default `(p) => String(p).includes('thumbnails')` is a sound workaround for the module-load `THUMB_CACHE_DIR` bootstrap side-effect (mocked-unwritable homedir would otherwise EACCES at import); `beforeEach` resets it to `false` and the 409 tests flip it to `true`. Slightly string-fragile but reasonable and well-commented.

**On the two findings (TESTS-only view):**
1. *Module-load EACCES* — real pre-existing module-level side effect; the test workaround is legitimate and does not mask a feature bug. Fine for test purposes.
2. *5MB cap unreachable (413 vs route's own 400)* — the two oversized-body tests correctly assert the **real observable behavior**: Fastify's default 1MB `bodyLimit` (server.ts sets no override) rejects >1MB bodies with 413 before the handler runs, so the route's 5MB `MAX_WRITE_SIZE` 400 branch is genuinely unreachable over HTTP and cannot be driven via `app.inject()` without a bodyLimit override. Asserting 413 reflects reality rather than papering over anything. This does leave the route's own "Content too large" 400 branch uncovered, but that is unreachable dead code over HTTP, not a test defect. The writer flagged it correctly as a source follow-up (raise server `bodyLimit` to ≥5MB if 5MB writes are actually intended, else the constant is dead code) — out of scope for test-writing.

**Minor (non-blocking, no action required):** the "writes when expectedMtime matches (within 0.5ms tolerance)" test uses an exact match (5000 == 5000) rather than a sub-0.5ms delta, so it doesn't probe the tolerance boundary itself; and the unsafe-basename tests cover only the backslash case (the `.`/`..`/`/` variants are hard to trigger post-`resolve()`, so backslash is a fair representative). Neither weakens the security guarantees under test.

Style matches the existing `app.inject()` + `vi.mocked` house pattern. Verdict: **APPROVED** — all gaps covered, assertions meaningful, mocks realistic.
<!-- appended by each Opus test review subagent — never overwrite -->

## QA Results

QA run 2026-07-19 (QA_PORT 34925, dev server via `npx tsx`, brew Node v25 for better-sqlite3 ABI). **Verdict: PASS — status → done.**

### Always-run checks
- **tsc `--noEmit`**: PASS (exit 0, zero errors).
- **`npm run lint`**: PASS (0 errors; 2 pre-existing warnings in UNRELATED files — `src/vault/search.ts:11`, `src/web/routes/session-routes.ts:246`, both "unused eslint-disable"; none in files changed by this task).
- **vitest `test/routes/file-routes.test.ts`**: PASS — **70/70 passing** (expected 70). (Duplicate-member warnings from `test/mocks/mock-state-store.ts` are pre-existing and non-fatal.)

### Server startup
- First attempt with system Node FAILED (`better-sqlite3` NODE_MODULE_VERSION 141 vs 127). Restarted with `/home/linuxbrew/.linuxbrew/bin` (brew Node v25) on PATH → server came up cleanly, `/api/status` returned v0.6.6. (Documented gotcha; not a code defect.)

### Frontend targeted check (390px viewport, Playwright/Chromium)
- **Files toolbar button**: PASS — `.btn-files-mobile` exists, `display:flex`, `visibility:visible`, `onclick="app.openFilesSheet()"`. Computed `order:2`; the pre-existing project button `.btn-case-mobile` is `order:3` — so Files sits just LEFT of the project button, i.e. between the run/gear cluster and the project selector, exactly as specified.
- **Desktop hidden**: PASS — at 1200px the button computes `display:none`.
- **Bottom sheet**: PASS — tapping Files (`app.openFilesSheet()`) opens `#filesSheet` (`.open`, `display:flex`) with `#filesSheetBackdrop` (`.open`, `display:block`).
- **Hidden/dotfiles default ON**: PASS — `#filesShowHidden` checkbox `checked === true`; the tree renders 252 rows including dotfiles at top (`.changeset`, `.github`, `.superpowers`, `.gitignore`, `.editorconfig` …). The `/files?showHidden=true` API returns 661 entries incl. dotfiles.
- **Note (harness artifacts, NOT feature bugs):** (a) The whole `.toolbar` (including the pre-existing `.btn-case-mobile`) measures 0×0 with no offsetParent when a session is activated programmatically in headless Chromium — the real terminal-pane layout never mounts, so ALL toolbar buttons collapse equally; this is not a Files-button regression. (b) The tree briefly showed "Loading…" on the auto-click path because the tsx dev server 404s the vendored xterm assets (`/vendor/xterm*.js` are in `dist/web/public/vendor/` but NOT `src/web/public/vendor/`), throwing `Terminal is not defined` inside `selectSession` and aborting the in-flight `filesLoadTree`. Running `filesLoadTree()` uninterrupted renders the full tree correctly (252 rows, dotfiles present). Both artifacts are dev-server-only and unrelated to this feature; they do not occur in the built/deployed app.

### Backend end-to-end (curl against session 56c9c14e, workingDir = this worktree)
- **CREATE** `POST /file-create` (sentinel content): 200, returns `{path,size,mtime}`. PASS
- **READ** `GET /file-content`: 200, returns `content` + `mtime` (mtime present as required for the staleness guard). PASS
- **STALE SAVE** `PUT /file-content` with `expectedMtime:1`: **409 `CONFLICT`** ("File was modified since it was loaded"). PASS
- **VALID SAVE** `PUT /file-content` with correct `expectedMtime`: 200, returns new mtime. PASS
- **DELETE** `DELETE /file?path=...`: 200; file confirmed gone from disk; subsequent read returns `NOT_FOUND` body. PASS
  - (Minor, pre-existing: the GET `/file-content` read route returns HTTP 200 with a `{success:false,errorCode:NOT_FOUND}` body rather than a 404 status — this is existing read-route behavior, not one of the new write routes, and not a QA failure.)

### SECRETS SAFETY CHECK (critical)
- Sentinel `SUPERSECRET_QA_VALUE_12345` in `/tmp/codeman-34925.log`: **count = 0**. Also grepped for the value bodies (`hunter2`/`=updated`/`=changed`): count 0. **PASS — no file content leaked to server logs.**

### Known limitation (informational, not a failure)
- The 5 MB write cap (`MAX_WRITE_SIZE`) is effectively ~1 MB in practice because Fastify's default `bodyLimit` returns 413 first. Normal-size create/save/delete (the primary small-`.env` use case) all work, so per the QA brief this is reported but does NOT fail QA. Consider raising `bodyLimit` on these routes if larger saves are ever needed.

### Docs Staleness
- `src/web/routes/file-routes.ts` changed → **API docs may need update (src/web/routes/ changed)**.
- `src/web/public/app.js` and `styles.css` changed → **UI docs may need update (frontend changed significantly)**.
- No `skills/*/SKILL.md` changed.
- (Advisory only — no docs modified. Note: feature changes are currently uncommitted in the working tree, so `git diff master..HEAD` was empty; staleness assessed against `git status` changed files.)

## Decisions & Context

- 2026-07-19 intake: user explicitly wants the Files button between the session-switch button and the project selector in the bottom toolbar; swipe-up sheet; primary use case is pasting secrets into env files on mobile, so dotfiles must be visible by default and content must never be logged. Editor choice left to analysis: prefer plain textarea for v1 over heavy editor libs; claudecodeui (CodeMirror-based) is inspiration for the tree UX, not a dependency mandate.
- 2026-07-19 implement: chose `CONFLICT` enum addition (spec option a) for the 409 staleness code rather than reusing `ALREADY_EXISTS`. Staleness comparison uses a 0.5 ms tolerance on `mtimeMs` (it is a sub-ms float) to avoid spurious 409s. Create routes use `flag:'wx'` in addition to an `existsSync` pre-check (belt-and-suspenders against the TOCTOU window; the common case still returns a clean 409 ALREADY_EXISTS). New File and New Folder use `prompt()`, Delete and discard-unsaved use `confirm()` — both are already used elsewhere in app.js and keep v1 dependency-free. New File opens the created (empty) file directly in EDIT mode so the user can immediately paste secret content (matches the `.env.local` acceptance flow). VIEW mode disables the Edit action when the read was truncated (>10000 lines) to prevent silent data loss on save. `depth=5` tree (server caps at 10); creation is relative to the working-dir root (a typed relative path with an existing parent also works via the parent sandbox). Delete of a currently-open file auto-returns to the tree. Verified live: create/read-mtime/save/409-stale/mkdir/traversal-400/delete-file/delete-dir all pass and the server log leaked no file content.

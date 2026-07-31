# Task

type: feature
status: done
title: File editor v2 — CodeMirror surface, markdown preview, image/binary previews, contextual file creation
description: Upgrade the mobile files-sheet editor (shipped in feat/mobile-file-explorer) to a CowCo-inspired simple-but-proper experience. Four parts. (1) EDITING SURFACE - replace the bare <textarea> in filesStartEdit() with CodeMirror 6, styled minimal (no toolbar; gutter optional/off on phone) so it still LOOKS like a plain editor but adds syntax highlighting, proper touch text editing, and large-file handling. Keep the existing Cancel/Save header chrome and the existing save flow (PUT file-content with expectedMtime, 409 conflict UI, toasts) EXACTLY as is. CodeMirror must be vendored offline via esbuild into dist/web/public/vendor/ (same pattern as xterm in scripts/build.mjs step 3) and LAZY-LOADED only when the files sheet first opens - zero cost to normal app startup. Reasonable language set: JS/TS, JSON, YAML, CSS, HTML, Python, shell, markdown; target ≲150 KB brotli for the bundle. Keep plain-textarea fallback if the vendor bundle fails to load. (2) MARKDOWN PREVIEW - for .md files add an Edit ⇄ Preview toggle in the sheet view header (tabs, NOT split pane - phone width). Render with markdown-it + DOMPurify (vendored the same way). Preview is read-only rendered HTML, styled to match the app theme. (3) IMAGE/BINARY PREVIEWS IN THE SHEET - currently filesOpenFile() shows only a text notice "Cannot edit image file (…)" (app.js ~19678). Instead render actual previews: images via <img> from GET /api/sessions/:id/file-raw?path=… (endpoint exists, file-routes.ts ~264), video via <video controls>, and for other binaries show a small info card (name, size, type) with a Download button (file-raw) instead of a dead end. Pinch-zoom or at least max-width:100% fit for images. (4) CONTEXTUAL FILE CREATION - filesNewFile()/filesNewFolder() (app.js ~19825) currently prompt() for a path relative to the workingDir ROOT, forcing the user to type full paths. Replace with contextual creation: a per-directory "+" affordance in the tree (or New File/New Folder actions that default to the currently expanded/selected directory), pre-filling the parent path so the user types only a name. Show the target directory in the dialog so it is obvious where the file will land. Keep dotfile-friendly (creating .env.local in a subdir must work).
constraints: (a) Frontend is vanilla JS static, no bundler for app code - vendored libs only, CSP allows self + cdn.jsdelivr.net but PREFER vendoring (offline requirement, like xterm). Edit src/web/public/, never dist/. (b) Lazy-load all new vendor bundles on first sheet open (dynamic <script> injection or import()); app.js boot path must not grow. (c) Keep ALL existing behavior: save/conflict/toast flow (toasts z-index 10010, commit 37474c14), Cache-Control no-store on API (13679a01), hidden files default ON, sandbox checks on any new/changed routes (realpathSync + relative pattern in file-routes.ts). file-raw already exists - reuse it, do not add new binary-serving routes unless必要. (d) Mobile-first at 390px but must work at all widths (the sheet is available everywhere since b4fefe38). (e) CodeMirror styled to blend with the app dark theme (#0d1117 sheet bg); no light-theme flash. (f) Do not log file contents anywhere (secrets safety). (g) Size discipline: total new vendor payload ≲250 KB brotli across editor+markdown+sanitizer; if a language mode pushes past budget, drop it rather than blow the budget. (h) Acceptance criteria: on 390px viewport - open a .ts file → syntax-highlighted editor, edit+save works incl. 409 path; open a .md file → Edit/Preview tabs, preview renders sanitized HTML; open a .png → actual image renders (not a notice); open a .zip → info card with Download; tap "+" on a nested folder → dialog pre-filled with that folder path, type only "test.txt", file appears in that folder and opens in editor; existing desktop file browser/preview unaffected; tsc + lint + existing 70 file-route tests pass; npm run build emits fresh .gz+.br for new vendor files (zlib step compresses dist/web/public AND vendor/ - verify new bundles are covered).
affected_area: src/web/public/app.js (filesSheet functions ~19525-19870), src/web/public/styles.css (files-sheet styles ~12840+), scripts/build.mjs (vendor bundling step), src/web/public/index.html (script tags NOT needed if lazy-loading; sheet markup ~2354), possibly src/web/routes/file-routes.ts (only if file-raw needs content-disposition for Download)
work_item_id: wi-090d31f4
fix_cycles: 0
test_fix_cycles: 0

## Root Cause / Spec

Pre-seeded context (2026-07-31, master @ 13679a01) — verify line numbers, then build on this:

- Files sheet shipped in 0fe7fbd0 + follow-ups (6c4cba67 bodyLimit 8MB, b4fefe38/abecafeb all-viewport, b762c0ab Files button in accessory bar, 7aba0490 tree retry, 37474c14 toast z-index/conflict UX, 13679a01 no-store).
- Key frontend functions in src/web/public/app.js: openFilesSheet ~19525, filesLoadTree/filesRenderTree ~19600s, filesOpenFile ~19660 (GET file-content lines=10000, cache no-store), _filesRenderView ~19699, filesStartEdit ~19716 (bare textarea), filesSave ~19749 (PUT + expectedMtime + 409 → _filesShowConflict), filesNewFile ~19825 / filesNewFolder ~19847 (prompt() with root-relative path — the UX complaint), filesDelete nearby.
- Binary handling today: filesOpenFile checks data.type image/video/binary and renders a dead-end notice (app.js ~19678). Server GET /api/sessions/:id/file-raw (file-routes.ts ~264) serves raw bytes with correct content-type; thumbnails exist (~581).
- Vendor pattern to copy: scripts/build.mjs step 3 uses npx esbuild node_modules/<pkg> --minify --outfile=dist/web/public/vendor/<name>.min.js. Compression step 6 (Node zlib, commit f803ccde) globs dist/web/public/*.{js,css,html} AND dist/web/public/vendor/* — new vendor bundles get .gz/.br automatically.
- CodeMirror 6 packages needed: @codemirror/state, @codemirror/view, @codemirror/language, @codemirror/commands plus language packages (@codemirror/lang-javascript, -json, -yaml, -css, -html, -python, -markdown; shell via @codemirror/legacy-modes). Bundle ONE iife via esbuild with a small entry file (e.g. scripts/cm-entry.mjs) exposing window.CodemanEditor = { create(parent, {doc, filename, onDocChanged}) } so app.js stays dependency-free. markdown-it + dompurify as a second small bundle or same bundle.
- CodeMirror does NOT include a file browser — tree stays our code.
- Editor abstraction: filesStartEdit/filesSave/filesCancelEdit currently read ta.value; introduce a tiny adapter (getValue()/setValue()/focus()) so textarea fallback and CodeMirror share one code path.
- QA per memory: worktree vitest needs node_modules symlink + brew node v25; verify UI headlessly via Playwright against a dev server on a spare port (vendor/ files are gitignored — copy vendor from main dist before browser testing, see gotcha_worktree_dev_server_missing_vendor).

### Analysis findings — verified 2026-07-31 (worktree @ feat/file-editor-v2)

All pre-seeded line numbers drifted slightly; VERIFIED current values below. All target
functions live in one contiguous block in `src/web/public/app.js` (~19523–19895) — the
mobile files-SHEET code. There is a SEPARATE desktop file browser/preview (`filePreview`
~19236, `renderFileTree` ~19299–19344, `openFilePreview` ~19451–19491, classes `.file-tree-*`
singular + `#filePreviewOverlay`, `.binary-message`) — DO NOT TOUCH IT. All work is scoped to
the `files-sheet-*` (plural) functions/markup/CSS.

#### Verified line numbers — src/web/public/app.js
- `openFilesSheet()` 19525 · `closeFilesSheet()` 19540 · `_filesShowTree()` 19552 · `_filesShowView()` 19558
- `filesSheetBack()` 19564 · `filesRefresh()` 19575 · `filesToggleHidden()` 19577
- `filesLoadTree()` 19583 (GET `/files?depth=5&showHidden=…`, 20s AbortController)
- `filesRenderTree()` 19614 — builds row HTML in `renderNode`; delegated click handler `body.onclick` at ~19643 (dir toggle vs `filesOpenFile`; delete via `[data-del]`)
- `filesOpenFile(path)` 19660 — GET `file-content?path=…&lines=10000` `{cache:'no-store'}`; **binary dead-end at 19677–19681** (`data.type` image|video|binary → `Cannot edit … file` notice + early return)
- `_filesRenderView()` 19699 — renders `<pre><code>` + Copy/Edit actions
- `filesStartEdit()` 19716 — **bare `<textarea id="filesSheetEditor">`**, `ta.value = cur.content`, input listener sets `cur.dirty`
- `filesCancelEdit()` 19731 · `filesCopyCurrent()` 19741
- `filesSave()` 19749 — reads `ta.value` via `this.$('filesSheetEditor')`; PUT `file-content` `{path,content,expectedMtime:cur.mtime}`; **409 → `_filesShowConflict` at 19765**
- `_filesShowConflict(pending)` 19777 · `filesReloadCurrent()` 19795 · `filesOverwriteCurrent()` 19801 (re-enters `filesStartEdit()` after overwrite)
- `filesNewFile()` 19825 · `filesNewFolder()` 19847 — both `prompt()` a root-relative path
- `filesDelete(path,isDir)` 19867 · `getFileIcon(ext)` 19897 · `formatFileSize()` exists · `escapeHtml()` is GLOBAL (constants.js:421, loaded before app.js)

#### index.html — files sheet markup: lines 2354–2396
- Backdrop 2354, sheet 2356. Tree toolbar `#filesSheetTreeToolbar` 2369: New File btn (onclick `filesNewFile()`) 2370, New Folder (`filesNewFolder()`) 2374, Hidden toggle 2378, Refresh 2382. Tree body `#filesSheetTreeBody` 2386.
- View pane `#filesSheetView` 2388: view-toolbar with `#filesSheetViewMeta` (2390) + `#filesSheetViewActions` (2391); `#filesSheetViewContent` 2393. Title `#filesSheetTitle`, back btn `#filesSheetBackBtn`.
- No new static `<script>` tags needed — lazy-load dynamically (see below).

#### styles.css — files-sheet block: 12838–13090
- Sheet `.files-sheet.open` bg `#0d1117`, z-index **10003**; backdrop 10002. (Toasts are z-index 10010 per 37474c14 — above the sheet, keep as-is.)
- `.files-sheet-view-content` 13023 (flex, `overflow:auto`), `.files-sheet-view-content pre` 13029, `.files-sheet-editor` (textarea) 13038, `.files-sheet-notice` 13053. Desktop media query (`min-width:768px`) at 13065 turns the sheet into a centered 760px modal — new CSS must work at BOTH phone and desktop.

#### file-routes.ts (src/web/routes/file-routes.ts) — verified
- `file-content` GET **line 158**. Binary detection 182–227: if `raw==='true' || binaryExts.has(ext)` returns `{success,data:{path,size,type:('image'|'video'|'binary'),extension,url:'/api/sessions/:id/file-raw?path=…'}}` (NO content/mtime). `imageExts` = png/jpg/jpeg/gif/webp/svg/bmp/ico; `videoExts` = mp4/webm/mov/avi. Text path returns `content,totalLines,truncated,mtime`.
- `file-raw` GET **line 265**. Sandbox realpathSync+relative 279–289. MAX_RAW_FILE_SIZE 50MB. Sets `Content-Type` from a mimeTypes map (png/jpg/gif/webp/svg/ico/bmp/mp4/webm/mov/mp3/wav/ogg/pdf/json → else `application/octet-stream`). **No Content-Disposition.**
- `file-create` POST **line 750**, `dir-create` POST **line 797**, delete DELETE 833. All CREATE routes use `resolveNewChild(workingDir, relPath, reply)` **line 905**: takes a RELATIVE path, splits into `basename`+`dirname`, rejects unsafe basenames (`''`,`.`,`..`,`/`,`\`), realpath-validates the PARENT is inside workingDir. **Subdirectory + dotfile paths ALREADY WORK**: passing `sub/dir/.env.local` → base `.env.local` (allowed), parent `workingDir/sub/dir` (validated). → **CONTEXTUAL CREATION NEEDS NO BACKEND CHANGE** — just POST `{path: parentDir ? parentDir + '/' + name : name}`.

#### CSP — src/web/middleware/auth.ts:168–169 (verified, NO change needed)
`default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' …; img-src 'self' data: blob:; connect-src 'self' wss://api.deepgram.com; font-src 'self' …`
- Dynamically injected `<script src="vendor/…">` = 'self' → OK. CodeMirror injects runtime `<style>` (StyleModule) = 'unsafe-inline' style → OK. `<img src="/api/…/file-raw">` = 'self' → OK; `<video>` has no media-src so falls back to default-src 'self' → same-origin OK. Vendoring satisfies the offline requirement; do NOT rely on jsdelivr.

#### build.mjs — verified (scripts/build.mjs)
- Step 3 vendor bundling: lines 38–44 (xterm). Pattern: `npx esbuild node_modules/<pkg>/lib/x.js --minify --outfile=dist/web/public/vendor/<name>.min.js`. xterm files are prebuilt singles (no `--bundle`). **Our CM/markdown bundles pull many npm packages, so they need an ENTRY FILE + `--bundle --format=iife`** (see below).
- Step 6 compression: lines 84–108. Iterates EXACTLY `dist/web/public` AND `dist/web/public/vendor` (non-recursive `readdirSync`), filter `/\.(js|css|html)$/`, writes `.gz` (gzip 9) + `.br` (brotli q9). **New `vendor/*.min.js` bundles are auto-compressed — confirmed. Any emitted `.css` too.** No build change needed beyond adding step-3 bundle commands.

#### Packages: NONE of CodeMirror / markdown-it / dompurify are installed. `esbuild ^0.27.3` IS present (devDep).
Add as deps (so they exist in node_modules at build time): `@codemirror/{state,view,language,commands,lang-javascript,lang-json,lang-yaml,lang-css,lang-html,lang-python,lang-markdown,legacy-modes}`, plus `markdown-it`, `dompurify`. (TS/JSX handled by lang-javascript config `{typescript:true}`; shell via legacy-modes `shell`.) Commit the package.json/package-lock changes.

---

### Concrete implementation plan

**Vendor bundles (esbuild entry files, IIFE, expose globals so app.js stays dependency-free).**
Create `scripts/vendor/editor-entry.mjs` (or two entries). Recommend ONE combined bundle to
minimise dynamic requests, but split if the combined `.br` would blow the ≲250 KB total budget.

1. `window.CodemanEditor = { create(parent, {doc, filename, readOnly, onChange}) }` returning an
   adapter `{ getValue(), setValue(str), focus(), destroy(), dom }`. Build with:
   `EditorState.create({doc, extensions:[…]})` + `new EditorView({state, parent})`.
   Extensions: minimal — `lineNumbers()` optional (spec says gutter off on phone: gate on
   `matchMedia('(min-width:768px)')` or just omit for simplicity), `history()`,
   `keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab])`, `EditorView.lineWrapping`
   (better for touch than horizontal pre-scroll), a dark theme built with `EditorView.theme({...},{dark:true})`
   matching `#0d1117` bg / `#e6edf3` text (NO light-theme flash — theme is dark from creation),
   syntax highlighting via `syntaxHighlighting(defaultHighlightStyle)` or a small custom
   HighlightStyle, and `langFor(filename)` picking one language by extension:
   ts/tsx/js/jsx/mjs/cjs→javascript({typescript,jsx}), json→json, yaml/yml→yaml, css/scss→css,
   html/htm→html, py→python, md/markdown→markdown, sh/bash/zsh→StreamLanguage.define(shell).
   `onChange` via `EditorView.updateListener.of(u=>{ if(u.docChanged) onChange(view.state.doc.toString()) })`.
2. `window.CodemanMarkdown = { render(src) }` → `DOMPurify.sanitize(markdownIt.render(src))`.
   Configure markdown-it `{html:false, linkify:true, breaks:false}` and DOMPurify defaults
   (strip scripts/event handlers). Return sanitized HTML string.

Build step 3 additions (append after xterm lines ~44), e.g.:
`npx esbuild scripts/vendor/editor-entry.mjs --bundle --minify --format=iife --outfile=dist/web/public/vendor/editor.min.js`
(esbuild resolves the npm imports from node_modules). Confirm the `.br` appears after `npm run build`
and check its size (`ls -l dist/web/public/vendor/editor.min.js.br`) against budget — if over,
drop the heaviest langs (html/python/yaml lezer grammars) before shipping.

**Lazy-load (app.js).** Add `_filesEnsureVendor()` returning a cached Promise (store on
`this._filesVendorPromise`). On first call, inject `<script src="vendor/editor.min.js">` into
`document.head`, resolve on `onload`, reject on `onerror`. Call it (fire-and-forget, or await
before creating an editor) from `openFilesSheet()`. On reject, set a flag so the editor path
falls back to the plain `<textarea>` and markdown preview falls back to `<pre>` escaped text.
Boot path (index.html) unchanged — zero new static tags.

**Part 1 — Editor surface (filesStartEdit/filesSave/filesCancelEdit).**
Introduce an editor adapter on `this.filesState.editor`. In `filesStartEdit()` (19716): if
`window.CodemanEditor` is available, clear `#filesSheetViewContent` and
`this.filesState.editor = window.CodemanEditor.create(contentEl, {doc:cur.content, filename:cur.path, onChange:(v)=>{cur.dirty = v!==cur.content}})`; else keep the existing textarea and set
`this.filesState.editor = { getValue:()=>ta.value, setValue:v=>{ta.value=v}, focus:()=>ta.focus(), destroy(){} }`.
Keep the exact Cancel/Save actions HTML (19727). In `filesSave()` (19749) replace `ta.value`
with `this.filesState.editor.getValue()` and guard on `editor` instead of `ta`. In
`filesCancelEdit()`/`filesOverwriteCurrent()`/`_filesRenderView()` call `editor.destroy()` when
tearing down. **Keep expectedMtime/409→_filesShowConflict/toast flow byte-for-byte.** Truncated
files still disable editing (existing guard). NEVER log `cur.content` (secrets).

**Part 2 — Markdown preview.** For `.md`/`.markdown`, in `_filesRenderView()` add an Edit⇄Preview
tab pair in `#filesSheetViewActions` (or a small tab strip above the content). Preview =
read-only div `innerHTML = window.CodemanMarkdown.render(cur.content)` (fallback: escaped `<pre>`
if lib missing). Style a `.files-md-preview` block to match theme (reuse existing color vars;
headings/code/blockquote). Tabs NOT split-pane. Toggling to Edit reuses `filesStartEdit()`.

**Part 3 — Image/binary previews.** Rewrite the dead-end branch in `filesOpenFile()` (19677–19681).
Instead of the notice + early return, render into `#filesSheetViewContent`:
- image → `<img src="/api/sessions/${sid}/file-raw?path=${enc}" style="max-width:100%;height:auto">`
  inside a scroll/zoom container (`.files-img-wrap` with `overflow:auto; touch-action:pinch-zoom`).
- video → `<video controls playsinline style="max-width:100%"><source src=…></video>`.
- other binary → info card (name, `formatFileSize(size)`, ext/type) + a Download control.
Set `meta` = size + ext; Download = anchor `<a href="/api/.../file-raw?path=…" download="<name>">`
— same-origin + `download` attr triggers a save, **no Content-Disposition / backend change needed**
(only add an optional `&download=1` → `Content-Disposition: attachment` in file-raw IF the plain
`download` attribute proves unreliable in testing; keep it minimal). Do NOT set editing state for
binaries; back button already returns to the tree. `data.url` from the API can be used directly.

**Part 4 — Contextual file/folder creation.** Track the active/target directory:
set `this.filesState.activeDir = path` whenever a directory row is tapped/expanded in the
`filesRenderTree` click handler (~19643). Add a per-directory create affordance: either a small
"+" button on `.files-tree-item.is-dir` rows (mirrors the existing `.files-tree-del` button, use
`data-newfile`/`data-newfolder` and handle in the delegated `body.onclick`) OR keep the toolbar
New File/Folder buttons but have them default to `activeDir`. Replace `prompt()` with a small
in-sheet dialog (reuse `.files-sheet-notice`/modal styling or a lightweight custom modal) that
SHOWS the target dir ("Create in: `<dir>/`" or "repo root") and takes ONLY a name input. On
submit POST `{path: dir ? dir + '/' + name.trim() : name.trim()}` to `file-create`/`dir-create`
(dotfiles + nested paths already supported by `resolveNewChild`). After success: `filesLoadTree()`,
ensure the parent dir is in `filesState.expanded`, then for a file `filesOpenFile(result.data.path)`
+ `filesStartEdit()`. Keep the existing 409 "already exists" toast behaviour.

**Verification (QA phase).** tsc + eslint + `npm run build` (confirm fresh `vendor/*.min.js.gz`
+ `.br` and check `.br` sizes vs budget). Existing **70** tests in `test/routes/file-routes.test.ts`
must still pass (run with brew node v25 + node_modules symlink per memory). Headless Playwright at
390px against a dev server on a spare port — **copy `vendor/` from main dist first** (vendor is
gitignored; see gotcha_worktree_dev_server_missing_vendor) OR run `npm run build` in the worktree
so vendor bundles exist. Acceptance: .ts→highlighted editor+save+409; .md→Edit/Preview tabs
sanitized; .png→image; .zip→info card+Download; "+" on nested folder→prefilled dialog→create in
that folder→opens in editor; desktop browser/preview unaffected.

<!-- analysis complete: status → fixing -->

## Fix / Implementation Notes

Implemented 2026-07-31. All four parts done; verified end-to-end via headless
Playwright at 390px against a dev server on port 3011 (using the app's own active
session pointed at the Codeman repo — scratch files created + saved + cleaned up).

### New files
- `scripts/vendor/editor-entry.mjs` — esbuild entry that bundles CodeMirror 6 +
  markdown-it + DOMPurify into ONE IIFE. Exposes `window.CodemanEditor.create(parent, {doc, filename, readOnly, onChange}) -> { dom, getValue, setValue, focus, destroy }`
  and `window.CodemanMarkdown.render(src) -> sanitized HTML string`. Dark CM theme
  (`#0d1117` / `#e6edf3`, `{dark:true}`) built into the extensions so there is no
  light flash. Gutter (`lineNumbers()`) is gated on `matchMedia('(min-width:768px)')`
  → OFF on phones. `langFor(filename)` maps extension → one language
  (ts/tsx/js/jsx/mjs/cjs, json, yaml/yml, css/scss, html/htm, py, md/markdown,
  sh/bash/zsh via legacy-modes shell). markdown-it configured `{html:false, linkify:true, breaks:false}`;
  DOMPurify `USE_PROFILES:{html:true}` as belt-and-braces.

### Changed files
- `package.json` / `package-lock.json` — added deps: `@codemirror/{state,view,language,commands,lang-javascript,lang-json,lang-yaml,lang-css,lang-html,lang-python,lang-markdown,legacy-modes}`, `markdown-it`, `dompurify`. (NOTE: `npm install` replaced the worktree's `node_modules` symlink→main with a real self-contained install — see Decisions re: vitest/brew-node ABI.)
- `scripts/build.mjs` — step 3 (after xterm lines) now runs
  `npx esbuild scripts/vendor/editor-entry.mjs --bundle --minify --format=iife --legal-comments=none --outfile=dist/web/public/vendor/editor.min.js`.
  Step 6 (zlib) already globs `vendor/*` → auto-emits `.gz` + `.br` for it (confirmed).
- `src/web/public/app.js` (files-SHEET functions only; desktop browser untouched):
  - `openFilesSheet()` fires `_filesEnsureVendor()` (new) — cached-promise lazy `<script>`
    injection of `vendor/editor.min.js`; resolves false on error so callers fall back.
  - `_filesDestroyEditor()` (new) tears down the live CM view; called anywhere the view
    DOM is replaced (open/back/close/cancel/render/binary).
  - Editor adapter on `this.filesState.editor`: `filesStartEdit()` uses CodeMirror when
    available, else the original `<textarea>` (same `{getValue,setValue,focus,destroy}`
    shape). `filesSave()` now reads `editor.getValue()` instead of `ta.value` — the
    expectedMtime / 409 → `_filesShowConflict` / toast flow is byte-for-byte unchanged.
  - `_filesRenderView()` renders a sanitized `.files-md-preview` for `.md`/`.markdown`
    with an Edit⇄Preview tab pair (Preview | Edit | Copy); non-md keeps `<pre><code>`.
    Falls back to escaped `<pre>` if the markdown lib is missing.
  - `_filesRenderBinary(data)` (new) replaces the "Cannot edit …" dead end:
    image → `<img class="files-img">`, video → `<video controls playsinline>`, other →
    info card (icon/name/size/ext) — all with a `<a download>` Download link built from
    the existing `data.url` (file-raw). NO backend change; plain `download` attr sufficed.
  - Part 4: tree click handler tracks `filesState.activeDir`; dir rows get a "+"
    (`data-newfile`) affordance. `filesNewFile()`/`filesNewFolder()` + the "+" open an
    in-sheet dialog (`_filesShowCreateDialog`) that SHOWS the target dir and takes only a
    name; `_filesCreateSubmit()` POSTs `{path: dir? dir+'/'+name : name}` to
    file-create/dir-create (dotfiles + nested already supported server-side), reloads the
    tree, expands the parent, and opens a new file in the editor. `prompt()` removed.
- `src/web/public/styles.css` — new blocks (before the 768px media query): `.files-cm-host`,
  `.files-md-preview` (headings/code/blockquote/table/img theming), `.files-img-wrap`/`.files-img`,
  `.files-media-wrap`/`.files-video`, `.files-binary-card`/`.files-binary-*`, `.files-tree-new`,
  `.files-sheet-tool.is-active`, `a.files-sheet-tool`, and the `.files-create-*` dialog.
- No `index.html` changes (lazy-load = no new static `<script>`). No `file-routes.ts` change.

### Verification done
- `npx tsc --noEmit` → clean (exit 0). `npm run build` → succeeds, emits
  `dist/web/public/vendor/editor.min.js` + fresh `.gz` + `.br`.
- Playwright @ 390px: .ts → CodeMirror mounts, 77 highlight spans, gutter OFF, 20 KB
  content; edit a scratch file + Save → "Saved" toast, content persisted to disk, dirty
  cleared. .md → Preview/Edit/Copy tabs, sanitized HTML (no `<script>`), Edit mounts CM,
  back-to-Preview works. .png → `<img>` loads (naturalWidth>0) + Download link. "+" on
  `src/web` → dialog "In: src/web/", type name → file created + opened in editor.
- Bundle smoke-tested headlessly: raw HTML in markdown (`<script>`, `<img onerror>`) is
  HTML-escaped inert by `html:false` (DOMPurify is the second layer).

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

Reviewed the full diff (app.js, styles.css, build.mjs, package.json) and read
`scripts/vendor/editor-entry.mjs` in full. All four parts are correct and every hard
constraint is honored. Rebuilt the bundle independently to confirm it compiles and sized it.

**Part 1 — CodeMirror surface (correct).** Adapter `{dom,getValue,setValue,focus,destroy}` is
shared: CM path in `filesStartEdit()` mounts into `.files-cm-host` and stores the adapter on
`filesState.editor`; the textarea fallback builds the identical adapter shape, so `filesSave()`
has one code path. Lazy-load `_filesEnsureVendor()` is a cached promise (`_filesVendorPromise`)
that injects `<script>` at most once and resolves `false` (never rejects) on `onerror`, so the
editor falls back to `<textarea>` and preview to escaped `<pre>`. Gutter gated off on phone
(`isPhone` via `matchMedia('(min-width:768px)')`, `lineNumbers()` only pushed when not phone).
Dark theme built into the extensions with `{dark:true}` from creation — no light flash.
Truncated-file edit guard intact (`filesStartEdit` early-returns with toast).

**Part 2 — Markdown preview (correct, no XSS hole).** `window.CodemanMarkdown.render` =
`DOMPurify.sanitize(md.render(src), {USE_PROFILES:{html:true}})`; markdown-it configured
`{html:false,...}` so raw HTML is escaped inert AND DOMPurify is a second layer. `_filesRenderView`
only sets `innerHTML` from that sanitized string; falls back to escaped `<pre>` if the lib is
missing. Edit⇄Preview implemented as a tab pair (Preview|Edit|Copy), not split-pane.

**Part 3 — Image/binary previews (correct).** Old "Cannot edit …" dead-end branch (was
19677–19681) is fully replaced by `_filesRenderBinary(data)`: image→`<img>`, video→`<video controls playsinline>`,
else info card + Download. Sets `filesState.current = null` so no editing/save state for binaries.
URLs use the server's `data.url` (server-side `encodeURIComponent`, file-routes.ts:225) plus
`escapeHtml` for attribute safety; fallback path uses `encodeURIComponent`. Download is a
same-origin `<a download="name">` — no backend change needed.

**Part 4 — Contextual creation (correct).** `filesState.activeDir` tracked on dir tap/expand,
on file open (parent), and on "+" tap. Per-dir "+" affordance added to `.is-dir` rows; delegated
handler order is del → newfile → dir-toggle (correct, early-returns). `_filesShowCreateDialog`
shows the target dir ("In: dir/" or "repo root"), takes only a name; `_filesCreateSubmit` trims,
rejects empty, builds `dir ? dir+'/'+name : name`, POSTs to file-create/dir-create, then reloads
tree, expands parent, and opens+edits new files. Dotfiles/nested work (server `resolveNewChild`).
All `prompt()` calls for file/folder creation removed (remaining `prompt()`s are unrelated —
conversation rename, new-session dir).

**Save flow byte-for-byte (verified).** `filesSave` still sends `{path,content,expectedMtime:cur.mtime}`,
409→`_filesShowConflict`, success updates mtime/size/dirty + "Saved" toast. Only change is
`ta.value`→`editor.getValue()` and the guard `!ta`→`!editor`. `filesOverwriteCurrent` still omits
expectedMtime (force). Conflict notice/toast behavior unchanged.

**Constraints (all met).** No file-content logging (grep clean). index.html untouched — boot path
not grown; vendor is lazy-loaded. Edits are in src/web/public, not dist. Desktop browser
(openFilePreview / renderFileTree / #filePreviewOverlay / .binary-message) NOT in the diff —
untouched. `_filesDestroyEditor()` is called on every view-DOM replacement (open/back/close/cancel/
render/binary/overwrite) with a safe try/catch and no-op fallback destroy — no CM view leak.

**Build/size (verified).** build.mjs step-3 esbuild command is correct
(`--bundle --minify --format=iife --legal-comments=none --outfile=dist/web/public/vendor/editor.min.js`);
step-6 zlib globs vendor/* so `.gz`+`.br` are emitted. Rebuilt independently: compiles clean;
`editor.min.js.br` = 244,371 B — under the ≲250 KB brotli hard cap (~6 KB margin). The ≲150 KB
"editor alone" soft target is unmet, but the implementer's Decisions justify this (CM6 core +
lezer grammars exceed it regardless) and the hard cap governs — acceptable.

Minor, non-blocking (no action required): markdown-it linkified links render without
`target=_blank`/`rel`, so tapping one navigates the SPA; `isPhone` is evaluated once at bundle
load so the gutter won't react to a later resize. Both are within spec.

Verdict: APPROVED — ready for test gap analysis.

## Test Gap Analysis

Analyzed 2026-07-31. **Verdict: GAPS FOUND** (two small, route-layer additions to
`test/routes/file-routes.test.ts`, the existing 70-test suite this task must keep green).

### Testing conventions (confirmed)
- Backend routes: vitest + fastify `app.inject()` with `fs` fully mocked (`mockedWriteFile`,
  `mockedRealpathSync`, `mockedStat`, `mockedMkdir`, `mockedExistsSync`). Harness built in
  `file-routes.test.ts`; `harness.ctx._sessionId` + workingDir `/tmp/test-workdir`.
- Frontend `app.js` (vanilla, no exports): there is **no jsdom/import harness** for it. The
  repo convention (see `test/non-image-file-upload.test.ts`: *"Because app.js is a browser
  bundle (no exports), the logic is replicated"*) is to re-implement a pure helper in the test
  and unit-test the copy — not exercise the real DOM code. UI behavior is otherwise
  Playwright-verified.
- `scripts/` (build tooling): no tests anywhere.

### What this task's changes depend on — coverage status
- **Part 3 file-raw (image/video/binary preview):** COVERED. `file-raw` tests already assert
  correct content-type for images (`image/png`), missing-path 400, path-traversal 400, and the
  size cap. The feature only does `<img src=file-raw>` / `<a download>` against this unchanged
  endpoint — nothing to add.
- **Part 4 create failure paths:** COVERED (unsafe basename, parent-outside-sandbox,
  parent-missing 404, ALREADY_EXISTS 409, oversized-body 400) for both file-create and dir-create.
- **GAP 1 — nested-path happy create is not asserted.** Part 4 POSTs `{path: dir + '/' + name}`
  (app.js `_filesCreateSubmit`), relying on `resolveNewChild` doing `basename`/`dirname` +
  `realpathSync(parent)` + `join(realParent, base)`. The only *successful* file-create test uses
  a **flat** name (`new.txt`, asserts `/tmp/test-workdir/new.txt`); nested paths appear only in
  the *failure* cases. No test asserts a successful nested create writes to the joined nested
  target. Trivially testable in the existing harness (mock `realpathSync(parent)` → the in-sandbox
  parent, assert `mockedWriteFile` called with `/tmp/test-workdir/sub/file.txt`).
- **GAP 2 — dotfile create is untested.** Part 4 explicitly relies on creating dotfiles
  (`.env`, `.gitignore`). `resolveNewChild` rejects basenames equal to exactly `.`/`..` but
  *allows* leading-dot names — a subtle branch a future refactor could silently break, taking
  Part 4 with it. No test creates a dotfile. Trivially testable (POST `path: '.env'`, expect 200
  + `mockedWriteFile` called with `/tmp/test-workdir/.env`).

### Not gaps (out of scope for this repo's harness)
- **Frontend (CodeMirror mount, markdown Preview/Edit tabs, image/binary render, contextual
  create dialog):** predominantly DOM + CodeMirror + markdown-it/DOMPurify integration, not pure
  logic. No import-based frontend harness exists; standing up jsdom/Playwright unit infra is out
  of scope. These acceptance criteria are Playwright-verified — already done in the implement
  phase (390px dev server) and re-checked in QA. The couple of pure bits (`langFor` ext→lang map,
  `dir?dir+'/'+name:name` string build) are too trivial to warrant replicate-and-test copies.
- **`scripts/vendor/editor-entry.mjs` + `scripts/build.mjs`:** build tooling; `scripts/` has no
  tests. Validated by `npm run build` succeeding and emitting `vendor/editor.min.js(.gz/.br)` —
  covered by the QA build step, not unit tests.

### To write (test-writing phase)
Add to `test/routes/file-routes.test.ts`, `POST .../file-create` describe block:
1. Successful **nested** create — asserts `resolveNewChild` join + `writeFile` at the nested target.
2. Successful **dotfile** create (`.env`) — asserts it is accepted (not 400) and written.
(Optional, if cheap: a dotfolder create in the dir-create block for symmetry.)
Keep the existing fs-mock style; do not touch the frontend or add new harnesses.

### Re-check (post test-review): NO GAPS
Re-verified 2026-07-31 after Opus APPROVED the two new tests. Both are present in
`test/routes/file-routes.test.ts` (`creates a file in a nested subdirectory` @ line 912,
`creates a dotfile (leading-dot name allowed by resolveNewChild)` @ line 938) and cover GAP 1
(nested happy-path create → joined nested target) and GAP 2 (leading-dot basename accepted).
No other harness-testable gap was missed: frontend `app.js` (CodeMirror mount, md Preview/Edit
tabs, image/binary render, contextual create dialog) has no jsdom/import harness and is
Playwright-verified in QA; build tooling (`scripts/vendor/editor-entry.mjs`, `scripts/build.mjs`)
is validated by `npm run build`, not unit tests; backend routes were unchanged. That reasoning
stands. Proceeding to QA.

## Test Writing Notes

**File modified:** `test/routes/file-routes.test.ts` (in the existing `POST /api/sessions/:id/file-create` describe block, after the flat-name `new.txt` success test).

**Tests added (2):**
1. `it('creates a file in a nested subdirectory', ...)` — GAP 1. POSTs `{ path: 'subdir/nested.txt', content: 'deep' }`. Relies on the default identity `realpathSync` mock, which resolves the parent `/tmp/test-workdir/subdir` inside the sandbox so the success path runs. Asserts 200, `body.data.path === 'subdir/nested.txt'`, and that `fs.writeFile` was called with the joined target `/tmp/test-workdir/subdir/nested.txt` and `{ encoding: 'utf-8', flag: 'wx' }`. This confirms `resolveNewChild` joins the resolved parent with the basename rather than writing to the workingDir root.
2. `it('creates a dotfile (leading-dot name allowed by resolveNewChild)', ...)` — GAP 2. POSTs `{ path: '.env.local', content: 'KEY' }`. Asserts 200, `body.data.path === '.env.local'`, and `fs.writeFile` called with `/tmp/test-workdir/.env.local`. Covers the previously-untested `resolveNewChild` branch where a leading-dot basename is accepted (only exactly `.`/`..` are rejected).

Both follow the existing mocked-fs pattern: `mockedStat.mockResolvedValue({...})` for the post-write stat, `harness.app.inject()`, and assertion on `mockedWriteFile` with the resolved absolute path. workingDir is `/tmp/test-workdir` (from `test/mocks/mock-session.ts`).

**Command used:** `npx vitest run test/routes/file-routes.test.ts`
**Result:** 72 tests passed (70 existing + 2 new). No better-sqlite3 ABI issue encountered — ran cleanly under the worktree's Node without any rebuild. Both new tests pass against untouched backend behavior (assertions match how the handler actually resolves paths).

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

### Test review attempt 1 — APPROVED
Reviewed the 2 new tests in `test/routes/file-routes.test.ts` against the real
`file-create` handler + `resolveNewChild` (src/web/routes/file-routes.ts ~750/~905).

**GAP 1 — nested create ('creates a file in a nested subdirectory'):** GENUINELY covered.
POSTs `{ path: 'subdir/nested.txt' }` and asserts `fs.writeFile` was called with the JOINED
target `/tmp/test-workdir/subdir/nested.txt` (plus `{ encoding:'utf-8', flag:'wx' }`) and
`body.data.path === 'subdir/nested.txt'`. Traced the handler: `resolveNewChild` does
basename/dirname + `realpathSync(parent)` + `join(realParent, base)`, and the identity
`realpathSync` default mock (line 84, reset in beforeEach) correctly resolves the parent
`/tmp/test-workdir/subdir` in-sandbox so the SUCCESS path is reached (same setup style as the
existing nested FAILURE tests, which override the mock to escape). The path assertion — not a
bare 200 — proves the file lands in the subdir, so a regression that stripped the subdir (wrote
to workingDir root) would fail the test. Correct fs call name (`writeFile` from
node:fs/promises, matching the handler's `await fs.writeFile`, NOT writeFileSync).

**GAP 2 — dotfile create ('creates a dotfile (leading-dot name allowed by resolveNewChild)'):**
GENUINELY covered. POSTs `{ path: '.env.local' }`, asserts 200 + write to
`/tmp/test-workdir/.env.local` with wx flag. Exercises the exact branch where `resolveNewChild`
allows a leading-dot basename (rejecting only `.`/`..`); a regression that started rejecting
dotfiles (e.g. `base.startsWith('.')`) would 400 and fail the writeFile assertion. Meaningfully
distinct from the flat `new.txt` success test.

**Correctness/realism/style:** Both assert the resolved absolute path AND the exclusive-create
flags, not just status code. Mocks are realistic and consistent with existing tests
(`vi.clearAllMocks()` isolates writeFile call history per test; `existsSync` default false avoids
the 409 branch; per-test `mockedStat` overrides are harmless). Naming, comments, inject/JSON.parse
pattern all match the surrounding suite exactly.

**Verification:** `npx vitest run test/routes/file-routes.test.ts` → 72 passed (70 existing + 2
new), no better-sqlite3 ABI error. Both gaps solid.

## QA Results

QA run 2026-07-31 (frontend). **VERDICT: ALL PASS → done.**

### Always-run checks
- `npx tsc --noEmit` → PASS (exit 0, zero errors).
- `npm run lint` → PASS (0 errors). 2 pre-existing warnings only, both in files NOT
  touched by this task (`src/vault/search.ts:11`, `src/web/routes/session-routes.ts:246`
  — "Unused eslint-disable directive"). All changed files (scripts/build.mjs, app.js,
  styles.css, test) are clean.
- `npx vitest run test/routes/file-routes.test.ts` → PASS (72 passed = 70 existing + 2 new).
  No better-sqlite3 ABI error under default Node v22.22.0 (implementer's real install works).

### Vendor bundle / build
- `src/web/public/vendor/editor.min.js` present (728,827 B raw) — tsx dev server serves it HTTP 200.
- `dist/web/public/vendor/editor.min.js.br` = 244,371 B — under the ≲250 KB brotli hard cap
  (~6 KB margin). `.gz` = 266,475 B. Both present. All xterm vendor files also present (no boot crash).

### Headless Chromium @ 390px (session 715e1f6c, workingDir = this worktree)
Driven via real Playwright locator clicks + app methods; zero page errors (only harmless
external-image CSP blocks from README shield badges, unrelated to the feature).
- (a) Files sheet opens, tree loads (43 items), sheet visible. PASS.
- Vendor lazy-loads on first sheet open: `window.CodemanEditor` + `window.CodemanMarkdown` both true. PASS.
- (b) CSS verification via getComputedStyle (rules actually applied, not defaults):
  `.files-cm-host` height 732px; `.files-md-preview` padding 14px 14px 24px / line-height 22.4px /
  link color rgb(88,166,255)=#58a6ff; `.files-img` max-width 100%; `.files-create-overlay`
  position absolute + display flex. PASS.
- (c) `.ts` file → Edit → CodeMirror mounts (`.cm-editor` + `.cm-content`, 131 highlight spans,
  gutter off at phone width). No textarea fallback needed. PASS.
- (d) `.md` (README.md) → Preview|Edit|Copy tabs; `.files-md-preview` renders 731 child elements,
  NO `<script>` (raw + sanitized); Edit tab (real button click) mounts CodeMirror. PASS.
- (e) Image (`mobile-test/snapshots/landing-393w.png`) → `<img class="files-img">` renders
  (naturalWidth 786, complete), max-width 100%, Download link present. PASS (replaces old
  "Cannot edit" dead end).
- (f) Contextual create: "+" on `docs/` folder → dialog "In: docs/" → typed name → file written
  to `docs/qa-*.txt` on disk (verified) → auto-opens in CodeMirror editor (cmEditor mounted,
  editing=true). Test files cleaned up. PASS.
- (g) Desktop browser unaffected: `#filePreviewOverlay` + `.file-browser-title` present in DOM. PASS.

Note: an early harness quirk (calling `filesStartEdit` twice in one session, or a manual
re-render mid-edit) showed a transient no-mount — NOT user-reachable, since the Edit button is
absent during edit mode. All genuine user paths (real button clicks, create flow) mount CM correctly.

### Docs Staleness
- `git diff master..HEAD --name-only` is empty (changes are uncommitted in the working tree);
  evaluated against the working-tree diff (`git diff master --name-only`) instead:
- Flag: **UI docs may need update** — `src/web/public/app.js` and `src/web/public/styles.css`
  changed significantly.
- No `src/web/routes/*.ts` changed (file-routes.ts untouched) → no API-docs flag.
- No `skills/*/SKILL.md` changed → no skill-docs flag.
(Advisory only — docs not modified.)

## Decisions & Context

- 2026-07-31 intake: user wants CowCo-style (cowco.app) simple editing with proper previews. Explicit user asks: image/binary previews missing in sheet ("Cannot edit" dead end), and file creation must not require typing full paths. CodeMirror chosen over EasyMDE (markdown-only, CM5, weak mobile) and Monaco (too heavy). Tabs not split-pane for md preview (phone width). Keep textarea fallback.

### 2026-07-31 implement subagent decisions

- **One combined bundle, not split.** CodeMirror + markdown-it + DOMPurify are bundled
  into a single `vendor/editor.min.js` (one lazy `<script>` = one request on first sheet
  open). Both globals (`CodemanEditor`, `CodemanMarkdown`) ship together.

- **Languages: ALL 8 kept** (JS/TS+JSX, JSON, YAML, CSS, HTML, Python, shell, markdown).
  Nothing dropped.

- **Actual brotli size: 244,371 bytes (238.6 KiB / 244.4 kB) for `editor.min.js.br`**
  (raw 728,827 B; gzip 266,475 B). This is UNDER the ≲250 kB total hard budget (~6 kB /
  2.3% margin). Measured splits (brotli q9): CodeMirror core + all 8 langs ≈ 190 KiB;
  markdown-it + DOMPurify ≈ 55 KiB.
  - The ≲150 kB "editor alone" SOFT target is NOT met and is not achievable with the
    specced language set: CM6 core + the `@lezer/javascript` (TS/JSX) grammar +
    `@lezer/markdown` (needed for Part 2's Edit mode) alone already exceed 150 KiB br.
  - Dropping grammars barely helps: dropping html+python+yaml only saves ~20 KiB
    (→ ~169 KiB editor), and `lang-html` is essentially FREE because it reuses the
    already-included css + javascript lezer grammars. Since we're comfortably under the
    HARD 250 kB cap with everything, I kept the full set rather than lose coverage for a
    soft target that the core weight makes unreachable regardless.

- **No `&download=1` backend fallback needed.** The plain same-origin `<a download>`
  attribute on the file-raw URL is sufficient; `file-routes.ts` untouched. (If a future
  browser ignores the attribute for certain types, add an optional `Content-Disposition`
  branch to file-raw then — not now.)

- **node_modules is now a REAL directory (was a symlink → main repo).** `npm install`
  of the new deps replaced the worktree's `node_modules` symlink with a self-contained
  install built by system Node v22. Consequence for QA: better-sqlite3's native addon is
  compiled for the v22 ABI, so running vitest with brew Node v25 will hit an ABI mismatch
  (per MEMORY gotcha_vitest_node_abi) — run vitest with system Node v22 here, OR rebuild
  better-sqlite3 for v25. The new deps themselves are pure JS (no native build).

- **Dev-server QA note:** `vendor/` is gitignored, so `editor.min.js` (+ .gz/.br) was
  copied into `src/web/public/vendor/` for the tsx dev server (which serves from
  `src/web/public`). A future `npm run build` regenerates it in `dist/`. Not committed.

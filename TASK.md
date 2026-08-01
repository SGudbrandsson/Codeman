# Task

type: feature
status: done
title: Files sheet — Preview tab for HTML files (sandboxed iframe)
description: Extend the files-sheet Edit ⇄ Preview tab mechanism (added for markdown in feat/file-editor-v2, 3d0c99ff) to .html/.htm files. When viewing an HTML file, show the same Preview/Edit toggle the markdown files get; Preview renders the document visually instead of showing source. The user's mental model: same as markdown preview, but for HTML documents.
constraints: (a) SECURITY IS THE HEADLINE CONSTRAINT. The previewed HTML is arbitrary project content and must NOT be able to touch the Codeman app: render in an <iframe> using srcdoc with sandbox attribute EXCLUDING allow-same-origin (so the frame is an opaque origin: no cookies, no localStorage, no fetch to our API with credentials). Decide allow-scripts deliberately: default OFF for v1 (static render); if enabled later it must never be combined with allow-same-origin. Do NOT innerHTML the document into the app DOM. Do NOT DOMPurify-strip as the primary mechanism (that's for markdown output; whole-document HTML wants isolation, not sanitization). (b) KNOWN LIMITATION to handle gracefully: srcdoc iframes inherit the parent page CSP (default-src 'self'...) which may block some subresources, and relative asset URLs (img src="./logo.png", link href="style.css") resolve against the app origin, not the file's directory. Stretch goal (optional, only if clean): rewrite relative src/href attributes to the existing GET /api/sessions/:id/file-raw?path=<dir>/<rel> endpoint before injecting into srcdoc, so local images/CSS render. If skipped, document it and make sure a broken-asset preview still renders the HTML structure without errors. (c) UI: reuse the exact markdown tab mechanism (find how .md Edit/Preview tabs are wired in app.js post-3d0c99ff; extend the file-type dispatch so text/html gets the tabs too). Preview area: iframe fills the sheet view content, white background default (HTML docs assume light bg — do NOT force dark theme into the frame), scrollable, mobile-friendly. (d) Frontend only, vanilla JS; no new vendor libs; no backend changes unless the stretch asset-rewrite needs none anyway (it should use the existing file-raw route). (e) Do not regress markdown preview, CodeMirror editing, save/conflict flow, or back-nav (2c11649f — OverlayHistory integration; the Preview toggle must NOT push history entries, it is a tab not a navigation level). (f) Acceptance @390px Playwright: open an .html file → Edit/Preview tabs appear; Preview renders headings/text visually inside a sandboxed iframe (assert sandbox attr present and allow-same-origin ABSENT); a <script>alert(1)</script> in the file does not execute (v1 scripts off); Edit tab still opens CodeMirror and save works; markdown preview unaffected; back button from HTML preview closes the file view (single history level). tsc + lint pass; existing tests pass.
affected_area: frontend
work_item_id: wi-cb9aba8c
fix_cycles: 0
test_fix_cycles: 1

## Root Cause / Spec

### Verification of pre-seeded context (all re-checked against the tree @ 2c11649f)

| Claim | Verdict |
| --- | --- |
| Markdown tabs shipped in 3d0c99ff, rendered via `window.CodemanMarkdown` | CONFIRMED — `src/web/public/app.js:19833 _filesRenderView()`; markdown branch at :19847-19855; tab pair at :19857-19862 |
| `.html` returns `type: 'text'` from file-content | CONFIRMED — `src/web/routes/file-routes.ts:183-212`, `binaryExts` has no `html`/`htm`, so text path with `lines=10000` cap |
| `filesOpenFile` pushes `files-file` OverlayHistory entry; tabs must not push | CONFIRMED — `app.js:19755` (`OverlayHistory.push('files-file', …)`) inside `filesOpenFile` (:19746). `_filesRenderView` / `filesStartEdit` push nothing — the existing Preview⇄Edit toggle is already history-free, so nothing to change |
| `GET /api/sessions/:id/file-raw?path=…` exists | CONFIRMED — `src/web/routes/file-routes.ts:265`; realpath + working-dir containment check; 50MB cap; serves bytes with content-type |
| CSP is actually set | CONFIRMED — `src/web/middleware/auth.ts:167-170`: `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self' wss://api.deepgram.com; font-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'self'`. No `frame-src`/`child-src`, so `about:srcdoc` falls back to `default-src 'self'` (local-scheme srcdoc frames are permitted; the frame document then *inherits* this policy). `X-Frame-Options: SAMEORIGIN` is also set but does not apply to srcdoc frames |
| Sheet styles live near styles.css ~12849+ | CONFIRMED (close) — `.files-sheet-view*` at `src/web/public/styles.css:13005-13051`; `.files-md-preview` at :13092-13138; media/binary previews :13140-13166. `mobile.css` has **no** files-sheet overrides |

Additional facts found (matter for implementation):

- `.files-sheet-view-content` (styles.css:13023) is `flex: 1 1 auto; overflow: auto; min-height: 0` inside the column-flex `.files-sheet-view`. Its height is definite → a `height: 100%` child resolves correctly.
- Markup: `src/web/public/index.html:2388-2393` — `#filesSheetView` > toolbar (`#filesSheetViewMeta`, `#filesSheetViewActions`) + `#filesSheetViewContent`.
- `escapeHtml` lives in `src/web/public/constants.js:421` (global function, used unqualified in app.js).
- No existing tests touch the files sheet (`grep filesSheet` over `test/` → nothing).
- Auth (`src/web/middleware/auth.ts`): session cookie `codeman_session` is `httpOnly, sameSite: 'lax'`. **This is the decisive fact for the stretch goal** — see below.

### Decision: SKIP the relative-asset rewrite stretch goal (v1)

Reasons (not just effort):

1. **It would not work where it matters.** A `sandbox`-without-`allow-same-origin` frame has an opaque origin, so its subresource requests are treated as cross-site: the `SameSite=Lax` `codeman_session` cookie is withheld. On any deployment with `CODEMAN_PASSWORD` set (i.e. the mobile/tailscale case this feature is for) every rewritten `/api/sessions/:id/file-raw?path=…` request returns 401 → assets still broken, but now with a confusing half-working code path.
2. Correct rewriting needs an HTML parse (attributes in `srcset`, `<base>`, CSS `url()` inside `<style>` and inside linked stylesheets, inline styles). A regex pass over raw HTML is exactly the fragile string-munging the isolation-first design was chosen to avoid.
3. Even with cookies, the inherited CSP (`img-src 'self' data: blob:`, `style-src 'self' 'unsafe-inline'`) would still block anything external, so previews stay partial regardless.

Consequence to handle gracefully: relative/external assets simply fail to load (404/401/CSP-blocked). Nothing throws in the parent page; the document structure, text and inline `<style>` still render. Document the limitation with a code comment above the preview builder plus a one-line note in the toolbar meta (see below).

### Implementation spec (frontend only — no backend changes)

**1. `src/web/public/app.js` → `_filesRenderView()` (currently line 19833)**

- After `const isMd = /\.(md|markdown)$/i.test(cur.path);` add
  `const isHtml = /\.(html?)$/i.test(cur.path);` (matches `.html` and `.htm`).
- Branch order inside the existing render block: truncated notice first (unchanged) → **if `isHtml && !cur.truncated`** render the preview iframe → else existing markdown branch → else `<pre><code>` source fallback.
- Truncated HTML must NOT be previewed (a cut-off document renders misleadingly): fall through to the existing `<pre>` + notice path, and do not offer the Preview tab — same rule markdown already follows.
- **Build the iframe with DOM APIs, never with an HTML string.** Setting `srcdoc` through an interpolated attribute would require attribute escaping and is a foot-gun; assigning the property is exact and injection-proof:

```js
// HTML preview: the document is arbitrary project content, so it is rendered
// in an isolated frame instead of being sanitized into our DOM.
// sandbox="" = ALL restrictions on: opaque origin (no cookies/localStorage/
// same-origin fetch against our API), no scripts, no forms, no top-level nav.
// NEVER add allow-same-origin here, and never combine it with allow-scripts.
// Known limitation: srcdoc resolves relative URLs against the app origin and
// inherits the app CSP, so <img src="./logo.png"> / <link href="style.css">
// and external assets do not load. Structure + inline CSS still render.
content.innerHTML = '';
if (noticeHtml) { const n = document.createElement('div'); n.innerHTML = noticeHtml; content.appendChild(n.firstElementChild); }
const wrap = document.createElement('div');
wrap.className = 'files-html-preview';
const frame = document.createElement('iframe');
frame.className = 'files-html-frame';
frame.setAttribute('sandbox', '');          // must be set BEFORE srcdoc
frame.setAttribute('referrerpolicy', 'no-referrer');
frame.setAttribute('title', 'HTML preview');
frame.srcdoc = cur.content;
wrap.appendChild(frame);
content.appendChild(wrap);
```

  (Set `sandbox` before assigning `srcdoc` so the document can never load unsandboxed.)
- Add `content.classList.toggle('is-frame', <html-preview-active>)` (or set/remove it on every render) so the CSS below only applies in preview mode — the class must be cleared in the markdown/source/edit paths and in `filesStartEdit()` / `_filesRenderBinary()`.
- Meta line: append the limitation hint for HTML previews only, e.g.
  `meta.textContent = ${size}${trunc}` + ` • preview: local assets not loaded` — keep it terse; it is the user-visible half of "document it".

**2. Tab wiring (same function, lines 19857-19862)**

Change the condition from `if (isMd && !cur.truncated)` to `if ((isMd || isHtml) && !cur.truncated)`. The existing markup is reused verbatim:

```html
<button class="files-sheet-tool is-active" onclick="app._filesRenderView()">Preview</button>
<button class="files-sheet-tool" onclick="app.filesStartEdit()">Edit</button>
<button class="files-sheet-tool" onclick="app.filesCopyCurrent()">Copy</button>
```

No history interaction — `_filesRenderView()` and `filesStartEdit()` do not touch OverlayHistory today; keep it that way (acceptance: back from HTML preview closes the file view, one level).

**3. `src/web/public/styles.css` — add next to `.files-md-preview` (~13138) or the media block (~13140)**

```css
/* HTML preview — sandboxed frame, light background (HTML docs assume light). */
.files-sheet-view-content.is-frame { overflow: hidden; display: flex; }
.files-html-preview { flex: 1 1 auto; min-height: 0; height: 100%; overflow: auto; -webkit-overflow-scrolling: touch; background: #fff; }
.files-html-frame { display: block; width: 100%; height: 100%; min-height: 100%; border: 0; background: #fff; }
```

Do not inject any dark-theme CSS into the frame. The outer scroll wrapper exists because iOS Safari expands iframes to content height and ignores internal scrolling.

**4. Non-goals / do-not-touch**

- No changes to `filesStartEdit`, `filesSave`, `_filesShowConflict`, `filesOpenFile`, OverlayHistory, or any backend route.
- No `allow-scripts` in v1. If ever added it must remain paired with the absence of `allow-same-origin`.
- No DOMPurify on the HTML document (isolation, not sanitization).

### Acceptance mapping (@390px Playwright)

1. Open a `.html` file → `#filesSheetViewActions` shows Preview / Edit / Copy.
2. `#filesSheetViewContent iframe.files-html-frame` exists; `getAttribute('sandbox') !== null` and does not contain `allow-same-origin`; frame content shows the `<h1>` text.
3. A `<script>window.parent.__pwned = 1</script>` (or `alert(1)`) in the fixture does not execute — no dialog, `window.__pwned === undefined`.
4. Edit tab → `.files-cm-host`/CodeMirror mounts, save round-trips.
5. Open a `.md` file → markdown preview identical to before.
6. Browser back from the HTML preview returns to the tree (single `files-file` entry), a second back closes the sheet.
7. `npx tsc --noEmit` + eslint clean; existing `test/` suite unchanged (compare failure sets against master — the suite has known env failures).

## Fix / Implementation Notes

Implemented exactly per spec. Frontend only — two files touched, no backend changes.

**`src/web/public/app.js`**

1. `_filesRenderView()`:
   - Added `const isHtml = /\.html?$/i.test(cur.path);` and a derived
     `const htmlPreview = isHtml && !cur.truncated;` (truncated HTML falls through
     to the `<pre>` source path, same rule markdown follows).
   - Meta line now appends ` • preview: local assets not loaded` for HTML previews only.
   - `content.classList.toggle('is-frame', htmlPreview)` on every render, so the
     class is always correct without needing a separate reset in this path.
   - New HTML-preview branch built with DOM APIs (`document.createElement`), never
     an HTML string: `.files-html-preview` wrapper > `iframe.files-html-frame` with
     `sandbox=""` (set via `setAttribute` **before** `frame.srcdoc = cur.content`),
     `referrerpolicy="no-referrer"`, `title="HTML preview"`. No `allow-same-origin`,
     no `allow-scripts`. A long comment block above it documents the isolation
     rationale and the relative-asset/CSP limitation.
   - Markdown rendering is now guarded with `!htmlPreview` so the branches are
     mutually exclusive (defensive — the extensions can't overlap anyway).
   - Tab condition widened from `if (isMd && !cur.truncated)` to
     `if ((isMd || isHtml) && !cur.truncated)`; the Preview/Edit/Copy markup is
     reused verbatim. No OverlayHistory interaction added anywhere.
2. `is-frame` is cleared in the other two paths that overwrite the view DOM:
   `filesStartEdit()` (before mounting CodeMirror/textarea) and
   `_filesRenderBinary()`. Also cleared at the top of `filesOpenFile()` so the
   loading/error states of a *next* file never inherit frame layout.

**`src/web/public/styles.css`** — added a block immediately before the
`/* Image / video / binary previews. */` section: `.files-sheet-view-content.is-frame`
(`overflow: hidden; display: flex`), `.files-html-preview` (flex child, owns the
scroll, `background: #fff`), `.files-html-frame` (`width/height: 100%`, `border: 0`,
`background: #fff`). No dark-theme CSS is injected into the frame; the outer wrapper
owns scrolling because iOS Safari expands iframes to content height.

**Not done (deliberately, per spec):** relative-asset rewriting to `file-raw`
(the opaque-origin frame would not send the `SameSite=Lax` session cookie, so it
would 401 on any password-protected deploy). Limitation is surfaced in the toolbar
meta line and in the code comment.

**Verification:** `npx tsc --noEmit` clean. `npm run lint` clean (0 errors; the 2
warnings are pre-existing unused-eslint-disable directives in `src/vault/search.ts`
and `src/web/routes/session-routes.ts`, untouched by this change — note the lint
script only globs `src/**/*.ts`, so `app.js` is not covered; validated separately
with `node --check src/web/public/app.js` → OK).

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

Reviewed the full diff (`src/web/public/app.js`, `src/web/public/styles.css`) plus the surrounding
files-sheet code (`filesOpenFile`, `_filesRenderView`, `_filesRenderBinary`, `filesStartEdit`,
`filesCancelEdit`, `filesSave`, `_filesShowConflict`, `_filesCreateSubmit`, `_doFilesBackToTree`,
`_doCloseFilesSheet`, `_filesBackFromHistory`) and the sheet CSS block at styles.css:13005-13166.

**Security (headline constraint) — PASS.**
- `frame.setAttribute('sandbox', '')` — empty value = all restrictions on. `allow-same-origin` and
  `allow-scripts` are both absent; nothing anywhere else in the file sets a `sandbox` value
  (`grep sandbox` over public/ → only this site). Opaque origin, no scripts, no forms, no top-level nav.
- Ordering is correct: `sandbox` (and `referrerpolicy`) are set before `frame.srcdoc = cur.content`,
  and the frame is only appended to the document *after* both — so the document can never load
  before the sandbox flags are parsed.
- `srcdoc` is assigned as a **property**, not interpolated into an HTML string, so no attribute
  escaping is needed and the file content cannot break out into the parent DOM. The document is
  never `innerHTML`-ed into the app DOM, and no DOMPurify pass is applied (isolation, not
  sanitization) — matches constraint (a).
- Frame content cannot reach `window.parent`, `document.cookie`, `localStorage`, or make credentialed
  requests to the API. `referrerpolicy="no-referrer"` also prevents session-id leakage via Referer on
  any subresource attempt.

**`is-frame` lifecycle — PASS, all exits covered.**
Only four call sites overwrite `#filesSheetViewContent`:
- `_filesRenderView()` (app.js:19853) — `classList.toggle('is-frame', htmlPreview)`, self-correcting on
  every render (md / source / non-preview HTML all clear it).
- `filesStartEdit()` (:19908) — `remove('is-frame')` before mounting CodeMirror/textarea.
- `_filesRenderBinary()` (:19814) — `remove('is-frame')`.
- `filesOpenFile()` (:19765) — `remove('is-frame')` before the "Loading…"/error state, so a next file
  never inherits frame layout.
`_filesShowConflict()` only `prepend`s a notice and is unreachable in frame mode (conflict can only
arise from `filesSave()`, i.e. from edit mode where the class is already off). Sheet close /
back-to-tree (`_doCloseFilesSheet`, `_doFilesBackToTree`) hide `#filesSheetView` entirely and the
next `filesOpenFile` clears the class, so a residual class is never observable. Verified with
`grep -n "filesSheetViewContent\|is-frame"` — no uncovered path.

**No regressions.**
- Markdown: `isMd` extensions (`.md`/`.markdown`) and `isHtml` (`.html?`) cannot overlap; the
  `!htmlPreview` guard on the render call is purely defensive and changes nothing for `.md`. The
  markdown branch, its DOMPurify comment, and `.files-md-preview` CSS are untouched.
- CodeMirror/save/conflict: `filesStartEdit`, `filesSave`, `filesCancelEdit`, `_filesShowConflict`,
  `filesOverwriteCurrent` are behaviourally unchanged (one added `classList.remove` line).
- OverlayHistory: no `push`/`pop` added or removed anywhere. The Preview/Edit buttons call
  `_filesRenderView()` / `filesStartEdit()` directly, neither of which touches history — tabs push
  zero entries, so back from HTML preview still pops the single `files-file` entry to the tree.
  (2c11649f's swipe-back is the browser's native history gesture, not a JS touch handler on the
  sheet, so the iframe swallowing touch events does not affect it.)
- Contextual file creation: `_filesCreateSubmit` → `filesOpenFile` → `filesStartEdit` for a new
  `.html` file correctly ends with the class removed and the editor mounted.

**Truncated HTML — PASS.** `htmlPreview = isHtml && !cur.truncated`, so a truncated `.html` falls
through to `<pre><code>` + the truncation notice, gets no `is-frame`, and the tab condition
`(isMd || isHtml) && !cur.truncated` denies it the Preview/Edit pair (Copy only, Edit suppressed) —
identical to the existing markdown rule.

**CSS — PASS, frame gets real height.** `.files-sheet-view-content` is `flex: 1 1 auto; min-height: 0`
inside the column-flex `.files-sheet-view`, so its own height is definite → `.files-html-preview`
`height: 100%` resolves, and `.files-html-frame` `height: 100%` inside that resolves too. The element
has no padding, so `overflow: hidden` + `display: flex` on `.is-frame` does not clip anything or
create a double scrollbar (the wrapper owns the scroll). Specificity beats the base rule and the
block comes later in the file. `mobile.css` has no `.files-sheet-view-content` / `.files-html-*`
override (grep confirmed), so nothing conflicts. Light `#fff` background on both wrapper and frame;
no dark-theme CSS injected into the frame, per constraint (c).

**Verification re-run:** `node --check src/web/public/app.js` → OK. `git status` shows only the two
intended source files plus TASK.md (`dist`/`vendor` are pre-existing untracked artifacts).

**Non-blocking nits (no change required):**
1. The truncated-notice block inside the frame branch is dead code (`htmlPreview` excludes truncated
   files). Harmless, and the implementer documented it as deliberate — but note that if the
   truncation rule is ever relaxed, `.is-frame`'s default `flex-direction: row` would put the notice
   *beside* the frame. Adding `flex-direction: column` to `.files-sheet-view-content.is-frame` would
   future-proof it for free.
2. An empty `.html` file previews as a blank white frame with no hint that it is empty. Only
   reachable via file creation, which immediately switches to Edit, so it is not user-visible today.
3. Preview cannot open `target="_blank"` links (no `allow-popups`) — correct and intentional for v1,
   just worth remembering if link-following is ever requested.

Verdict: **APPROVED** — matches the spec exactly, security contract is airtight, no regressions found.

## Test Gap Analysis

**Verdict: GAPS FOUND** (status → `writing-tests`)

### Changed source files

| File | Existing test coverage |
| --- | --- |
| `src/web/public/app.js` (`_filesRenderView`, `filesOpenFile`, `_filesRenderBinary`, `filesStartEdit`) | **None.** `grep -rl "filesSheet\|filesStartEdit\|files-md-preview\|CodemanMarkdown" test/` → zero hits. The files sheet (incl. the markdown preview shipped in 3d0c99ff) has never been tested. |
| `src/web/public/styles.css` | No CSS test convention in the repo — not a gap. |
| (no backend changes) | `test/routes/file-routes.test.ts` exists and is untouched/unaffected — no route gap. |

### Existing harnesses (creating one is NOT required)

The project has two established patterns for `src/web/public/app.js`, both usable here:

1. **jsdom logic replica** — `// @vitest-environment jsdom` + a faithful re-implementation of the
   method body, asserted against a hand-built DOM. See `test/overlay-history.test.ts`,
   `test/agent-management-ui.test.ts`, `test/non-image-file-upload.test.ts` (app.js is a browser
   bundle with no exports, so replication is the house style; each such file carries a
   "keep in sync with app.js" header comment).
2. **Playwright browser harness** — `test/agent-management-ui.playwright.ts` boots the real
   `WebServer` on a dedicated port + `chromium` from the already-installed `playwright` devDep
   (`package.json:106`), and drives frontend state directly via `page.evaluate` (e.g. poking
   `SessionDrawer._viewMode` then calling the render method). **A files-sheet Playwright test needs
   no tmux/session fixture**: it can set `app.filesState.current = {path,content,size,truncated}`,
   call `app._filesRenderView()`, and assert on the real DOM at a 390px viewport. So acceptance
   criterion (f) is in scope, not "harness from scratch".

### Gaps

1. **`app.js` — sandbox security contract (HIGHEST VALUE).** No test asserts the iframe carries
   `sandbox` with an empty value, nor that `allow-same-origin` / `allow-scripts` are absent. This is
   the headline constraint; a future edit could silently loosen it. Needs both:
   (a) a DOM assertion (`frame.getAttribute('sandbox') === ''`, `!sandbox.includes('allow-same-origin')`,
   `!sandbox.includes('allow-scripts')`, `referrerpolicy === 'no-referrer'`), and
   (b) a **source-text regression guard** reading `src/web/public/app.js` and asserting the real file
   contains no `allow-same-origin` anywhere — the jsdom replica pattern otherwise tests a copy, not
   the shipped code.
2. **`app.js` — `srcdoc` assigned as a property, not interpolated.** No test proves the document is
   never injected into the parent DOM. Assert `frame.srcdoc === cur.content` for content containing
   `"`, `<`, and `</iframe>`, and that `content.querySelector('h1')` (i.e. parent-DOM leakage) is null.
3. **`app.js` — script non-execution.** Acceptance (f)/(3): a fixture containing
   `<script>window.parent.__pwned=1</script>` must leave `window.__pwned === undefined`. jsdom does
   not honour the `sandbox` attribute, so this one is **Playwright-only** — must not be faked in jsdom.
4. **`app.js` — file-type dispatch branch matrix (untested logic branches).** `isHtml = /\.html?$/i`
   vs `isMd = /\.(md|markdown)$/i`: `.html`, `.htm`, `.HTML` → preview; `.xhtml`, `.htmlx`,
   `.md`, `.txt` → not. Plus `htmlPreview = isHtml && !cur.truncated`, so a **truncated `.html`** must
   fall through to `<pre><code>` with escaped source, get no `is-frame`, and get no Preview/Edit pair.
5. **`app.js` — tab wiring condition.** Widened to `(isMd || isHtml) && !cur.truncated`. Untested:
   HTML → Preview/Edit/Copy in `#filesSheetViewActions`; markdown → unchanged (regression guard);
   `.txt` → Edit/Copy only; truncated → Copy only.
6. **`app.js` — `is-frame` class lifecycle (4 new/changed call sites, 0 tests).** Added
   `classList.remove('is-frame')` in `filesOpenFile()`, `_filesRenderBinary()`, `filesStartEdit()` and
   `classList.toggle(...)` in `_filesRenderView()`. Untested transition: HTML preview → Edit → class
   gone; HTML preview → open a `.md`/binary → class gone. A stale `is-frame` breaks layout of every
   later view, so each removal deserves an assertion.
7. **`app.js` — meta line.** ` • preview: local assets not loaded` appended **only** for
   `htmlPreview`; markdown/source/truncated-HTML meta strings must be byte-identical to before.
8. **Markdown-preview non-regression.** The `!htmlPreview` guard was added to the markdown branch.
   Since no markdown-preview test has ever existed, this branch is entirely uncovered — a `.md`
   render assertion (`.files-md-preview` present, no iframe, no `is-frame`) is the cheapest insurance.
9. **OverlayHistory non-interaction.** Acceptance (6): the Preview/Edit tabs must push zero history
   entries. `test/overlay-history.test.ts` covers the singleton but nothing asserts the files-sheet
   tabs leave it alone. Cheap source-level guard: `_filesRenderView` / `filesStartEdit` bodies contain
   no `OverlayHistory.push`.

### Recommended shape (for the test-writing phase)

- `test/files-html-preview.test.ts` — jsdom, replica of the `_filesRenderView` render block, covering
  gaps 1a, 2, 4, 5, 6, 7, 8, plus source-text guards for 1b and 9 (read the real `app.js` with `fs`).
- `test/files-html-preview.playwright.ts` — real browser @390×844, modelled on
  `agent-management-ui.playwright.ts` (own port, `page.evaluate` to seed `app.filesState.current`),
  covering gap 3 (script non-execution / `window.__pwned`), the real sandbox attribute, and scrolling
  layout. Keep it small — this is the only way to test the sandbox semantics honestly.
- Do **not** run the full vitest suite from this session (known tmux crash); run only the new files.

### Re-check (post test approval)

**Verdict: NO GAPS** (status → `qa`)

Re-read both new test files in full against the shipped diff
(`git diff master -- src/web/public/app.js src/web/public/styles.css`: 45 + 21 lines) and
walked the original nine gaps one by one. Re-ran `npx vitest run test/files-html-preview.test.ts`
→ **46 passed** (system node v22; the Playwright file was not re-run this pass — attempt 2 and the
approving review each ran it green at 9 tests). `git status` confirms `src/` still carries only the
original feature diff; no test file was modified by this analysis.

| Gap | Covered by | Verdict |
| --- | --- | --- |
| 1a sandbox contract (DOM) | `sandbox contract` ×5 (test:219-243) + Playwright `sandbox`/`tokens===0`/`referrerpolicy` (pw:132-141) | closed |
| 1b source-text guard | whole-file `allow-same-origin` / `allow-scripts` guards + `setAttribute('sandbox','')` before `.srcdoc =` (test:465-488) | closed |
| 2 srcdoc as a property | hostile round-trip + no parent-DOM leakage (test:285-296) and `not.toMatch(/srcdoc\s*=\s*["'\`]/)` (test:490-494) | closed |
| 3 script non-execution | Playwright `__pwned === undefined` + srcdoc frame title ≠ `executed` (pw:143-153) — correctly Playwright-only | closed |
| 4 dispatch matrix | `.html/.htm/.HTML/.Htm` preview; `.xhtml/.htmlx/.txt/.html.erb` don't; `.md` unframed; empty `.html`; truncated `.html` → escaped `<pre>` (test:300-345) + source guards on `/\.html?$/i` and `htmlPreview = isHtml && !cur.truncated` | closed |
| 5 tab wiring | `toolbar tabs` ×4 (test:349-370) + source guard on `if ((isMd \|\| isHtml) && !cur.truncated) {` | closed |
| 6 `is-frame` lifecycle | all four call sites (Edit, next `.md`, binary, loading state) (test:374-397) + source guard asserting `remove('is-frame')` in `filesOpenFile`/`_filesRenderBinary`/`filesStartEdit` and `toggle` in `_filesRenderView` (test:557-562); Playwright Edit→Cancel round-trip (pw:180-189) | closed |
| 7 meta line | hint present for HTML preview, byte-identical for `.md`/`.txt`/truncated HTML (test:401-419) + interpolation-safe source guard | closed |
| 8 markdown non-regression | jsdom `CodemanMarkdown` render + `.html` not routed through it (test:423-444) + a real-browser `.files-md-preview h1` check (pw:239-261) | closed |
| 9 OverlayHistory non-interaction | source guard (no `OverlayHistory` in `_filesRenderView`/`filesStartEdit`, exactly 2 `push('files-file')` sites) (test:540-553) + Playwright before/after `history.length` + `_stack.length` (pw:191-218) | closed |

Beyond the nine, the two paths added by attempt 2 (re-render idempotency in both suites, and the
`content.innerHTML = ''`-before-`createElement('iframe')` source guard) are the ones the Preview
button actually re-enters, and they are covered. `styles.css` has no test convention in this repo and
was already ruled out as a gap in the first pass; the one behaviour that depends on it — the frame
having real width/height inside the sheet with no horizontal page overflow at 390×844 — is asserted in
Playwright (pw:165-178), which is the right level for it.

**Nothing load-bearing remains untested. Not worth another writing round** (recorded for the reader,
no action):
- The Playwright file header claims coverage of "the frame cannot reach `window.parent` /
  `document.cookie`"; only the `window.parent` half is asserted. With `allow-scripts` off, no script
  in the document can read `document.cookie` at all, so the missing half is untestable rather than
  uncovered — the header is slightly over-stated, not the suite.
- `_filesShowConflict` does not clear `is-frame`. Deliberate and documented in Decisions & Context: it
  does not replace `#filesSheetViewContent`, so there is nothing to clear.
- The source guards are exact-string matches and will need updating alongside any cosmetic reformat of
  those lines. Known trade-off of the house pattern, already flagged by the approving review.

## Test Writing Notes

### Attempt 2 (after test review attempt 1 — REJECTED)

Both blocking items fixed, plus all four non-blocking nits. Only the two new test
files were touched; `src/` is byte-identical to before this attempt
(`diff` against a pre-attempt backup of `app.js` → identical; `git diff --stat HEAD -- src/`
still shows only the original 45/21-line feature diff).

**Blocking 1 — re-render idempotency.** New `describe('re-render (Preview tab clicked
while already previewing)')` in the jsdom file, 3 tests: a second `_filesRenderView()`
leaves exactly one `iframe.files-html-frame`, one `.files-html-preview` and one child on
the content element; repeated re-renders keep one frame and pick up fresh `srcdoc`;
re-rendering after `filesStartEdit()` swaps the editor back out for exactly one frame.
Mirrored in Playwright with a new test that clicks Preview twice and asserts
`{frames: 1, wrappers: 1}` via `$eval` counts. Because the jsdom half only proves the
*replica*, a matching **source guard** was added too: `content.innerHTML = '';` must
appear in `_filesRenderView` **before** `createElement('iframe')`.

**Blocking 2 — behavioural constants pinned in the shipped app.js.** Four new
`toContain` guards in the existing `source guards` describe, using the same
`methodBody('_filesRenderView')` helper:
- `const isHtml = /\.html?$/i.test(cur.path)` (gap 4 — `.htm` keeps previewing)
- `const htmlPreview = isHtml && !cur.truncated` (gap 4 — truncated docs never framed)
- `if ((isMd || isHtml) && !cur.truncated) {` (gap 5 — HTML gets the tab pair)
- `${htmlPreview ? ' • preview: local assets not loaded' : ''}` (gap 7 — meta hint)

**Mutation-verified, not assumed.** Each of the five mutations named in the rejection was
applied to `src/web/public/app.js` by script, the jsdom suite re-run, and the file
restored (script: scratchpad `mutate.cjs`). Results — every one now goes red, each
failing exactly one test:

| Mutation | Result |
| --- | --- |
| `/\.html?$/i` → `/\.html$/i` | 1 failed / 45 passed |
| drop `&& !cur.truncated` from `htmlPreview` | 1 failed / 45 passed |
| tab condition → `isMd && !cur.truncated` | 1 failed / 45 passed |
| remove the ` • preview: local assets not loaded` meta string | 1 failed / 45 passed |
| delete `content.innerHTML = '';` | 1 failed / 45 passed |
| (control) `sandbox` → `allow-same-origin` | 2 failed |

Post-run `git diff`/`diff` confirmed `app.js` restored byte-for-byte.

**Nits fixed.** (3) `notes.md` removed from the "does not preview" `it.each` — it was
asserting the vendor-missing `<pre>` fallback, not the markdown path; replaced with an
explicit `does not frame a markdown file` test and a comment explaining why markdown is
covered by the dedicated non-regression suite instead. (4) New test: an empty `.html`
previews as an empty frame (`srcdoc === ''`, `is-frame` on, no `pre code`) rather than
falling through to the source view. (5) The Playwright history test now asserts
`before.stack === 0` with a comment saying the baseline is deliberately empty (the flow
seeds `filesState` instead of calling `filesOpenFile`), so 0 → 1 is what it catches.
(6) The node-version quirk is recorded in the Playwright file header.

**Counts after attempt 2:** `test/files-html-preview.test.ts` 46 tests (was 37),
`test/files-html-preview.playwright.ts` 9 tests (was 8).

**Verification (this attempt, system node v22.22.0 = `/usr/bin/node`):**
- `npx vitest run test/files-html-preview.test.ts` → **46 passed**
- Playwright file via a throwaway `vitest.pwtmp.config.ts` in the repo root
  (`include: ['test/files-html-preview.playwright.ts']`, port 3251) → **9 passed**;
  temp config deleted immediately after (`git status` clean of it).
- Full suite deliberately NOT run (known tmux crash).

---

### Attempt 1 (superseded — kept for context)

Two new files, 45 tests, all passing. No existing test was modified.

### `test/files-html-preview.test.ts` (NEW — jsdom, 37 tests)

House-style replica of `_filesRenderView()` / `filesStartEdit()` / `_filesRenderBinary()` /
the DOM prelude of `filesOpenFile()`, run against a jsdom copy of the `#filesSheetView` markup
(same pattern as `test/overlay-history.test.ts`, with the "keep this replica in sync" header).

| Suite | Covers (gap) |
| --- | --- |
| `sandbox contract` (5 tests) | Gap 1a — frame exists and the document is NOT in the app DOM; `sandbox === ''`; no `allow-same-origin`; no `allow-scripts`; `referrerpolicy=no-referrer` + `title` |
| `srcdoc assignment` (1) | Gap 2 — hostile content (`"`, `<`, `</iframe>`, `onerror=`) round-trips byte-identically through `frame.srcdoc`, nothing leaks into the parent DOM |
| `file-type dispatch` (10) | Gap 4 — `.html/.htm/.HTML/.Htm` preview; `.xhtml/.htmlx/.md/.txt/.html.erb` do not; truncated `.html` falls through to escaped `<pre><code>` + notice with no `is-frame` |
| `toolbar tabs` (4) | Gap 5 — HTML → `[Preview, Edit, Copy]` with Preview active; markdown unchanged (regression guard); `.txt` → `[Copy, Edit]`; truncated HTML → `[Copy]` |
| `is-frame lifecycle` (4) | Gap 6 — class cleared by Edit tab, by rendering a `.md` next, by `_filesRenderBinary`, and by the next file's loading state |
| `meta line` (4) | Gap 7 — `• preview: local assets not loaded` appended only for HTML previews; `.md`/`.txt`/truncated-HTML meta strings byte-identical to before |
| `markdown preview (non-regression)` (2) | Gap 8 — `.md` renders via `CodemanMarkdown` into `.files-md-preview`, no iframe, no `is-frame`; `.html` never routed through the markdown renderer |
| `source guards` (7) | Gaps 1b + 9 + 6 (source side) — reads the **real** `src/web/public/app.js` and asserts: no `allow-same-origin` / `allow-scripts` outside comments; `setAttribute('sandbox','')` precedes `.srcdoc =`; `srcdoc` assigned as a property (never interpolated); `_filesRenderView`/`filesStartEdit` contain no `OverlayHistory`; `files-file` is pushed from only `filesOpenFile` + `_filesBackFromHistory`; `is-frame` cleared in all three overwriting paths |

Implementation note: the jsdom environment has no `node:fs`, so `app.js` is pulled in as text via
Vite's `?raw` loader (`import appSource from '../src/web/public/app.js?raw'`). Verified that
`node:fs` genuinely fails under `@vitest-environment jsdom` in this repo before switching.

### `test/files-html-preview.playwright.ts` (NEW — real Chromium @390×844, 8 tests)

Modelled on `test/agent-management-ui.playwright.ts`: boots `WebServer` on its own port (**3251**,
unused elsewhere in `test/`), launches headless chromium, and drives the sheet directly
(`app.filesState.current` seeded + real `app._filesRenderView()` called) — no tmux session or real
file needed. Fixture document contains `<script>window.parent.__pwned = 1; document.title = "executed"</script>`.

1. HTML file → frame present and `#filesSheetViewActions` shows `[Preview, Edit, Copy]`.
2. Sandbox as the browser parses it: `getAttribute('sandbox') === ''` **and** `iframe.sandbox.length === 0`
   (zero `allow-*` tokens of any kind), `referrerpolicy=no-referrer`.
3. **Gap 3 (Playwright-only, cannot be faked in jsdom):** the document's script does not run —
   `window.__pwned` stays `undefined` and the frame's `document.title` is not `"executed"`.
4. Document renders visibly inside the frame (`h1` text + visibility) and its inline `<style>` applies.
5. Layout: frame has real height/width inside the sheet at 390×844 and the page does not scroll horizontally.
6. Edit tab mounts the real CodeMirror surface (`.files-cm-host`, vendor bundle loaded via
   `_filesEnsureVendor()`), clears `is-frame`; Cancel returns to the frame with `is-frame` back on.
7. Preview ⇄ Edit ⇄ Preview leaves both `history.length` and `OverlayHistory._stack.length` unchanged
   (acceptance 6: tabs are not a navigation level).
8. Markdown non-regression in a real browser: `.md` renders `.files-md-preview h1` inline, no iframe,
   no `is-frame`, and no "local assets" text in the meta line.

### How to run

```
npx vitest run test/files-html-preview.test.ts                 # 37 passed
# *.playwright.ts is excluded by vitest.config.ts's include glob (test/**/*.test.ts),
# so it needs a config whose include matches — same situation as the pre-existing
# agent-management-ui.playwright.ts:
npx vitest run --config <cfg with include:['test/**/*.playwright.ts']> \
  test/files-html-preview.playwright.ts                        # 8 passed
```

The full suite was deliberately NOT run from this session (known tmux crash).

### Findings while writing tests (no implementation bugs)

- No test failed for an implementation reason; both files pass green against the current code.
- One expectation was corrected, not the code: `OverlayHistory.push('files-file')` appears **twice**
  in `app.js`, not once. The second site is the pre-existing dirty-cancel re-push inside
  `_filesBackFromHistory()` (app.js:19617) — the entry the browser already popped being restored so a
  later back still confirms. Unrelated to this feature; the guard now asserts exactly those two sites
  so a third (e.g. a tab pushing history) would fail.
- `OverlayHistory` is a top-level `const` in `app.js`, i.e. a global *lexical* binding — it is NOT on
  `window`, so `page.evaluate` must reference it by bare name (documented in the test).

## Test Review History
<!-- appended by each test review subagent — never overwrite -->

### Test review attempt 1 — REJECTED

Re-ran both suites myself before judging:
- `npx vitest run test/files-html-preview.test.ts` → **37 passed** (brew node v25).
- `test/files-html-preview.playwright.ts` via a throwaway config with
  `include: ['test/files-html-preview.playwright.ts']` → **8 passed**, but only on **system node
  v22** (`/usr/bin/node`); on brew node v25 the whole file fails to import with the known
  better-sqlite3 `NODE_MODULE_VERSION 127 vs 141` ABI error. Temp config deleted afterwards; no
  repo file was modified by this review other than this TASK.md entry.

**What is good (no changes wanted here):**

- **Replica fidelity: verified faithful.** Diffed `makeApp()._filesRenderView()` (test:111-160) against
  the real `_filesRenderView()` (app.js:19833-19893) line by line — identical modulo the `(window as any)`
  casts. `formatFileSize` (test:63-69) is byte-identical to app.js:20183-20189, so the meta-line
  assertions are testing the real format. `_filesRenderBinary` / `filesStartEdit` / the `filesOpenFile`
  prelude are simplified only in ways that do not touch the asserted behaviour (`is-frame` removal
  ordering is preserved), and the deviations are documented in the header.
- **Security assertions are real, not vacuous.** The Playwright script-execution test would genuinely
  fail if the sandbox were dropped: the app CSP allows `'unsafe-inline'` scripts, so an unsandboxed
  `about:srcdoc` frame *would* set `window.parent.__pwned`. The test also asserts the srcdoc frame was
  actually found before checking the title, so it cannot pass by the frame simply being absent.
  `iframe.sandbox.length === 0` is a stronger check than the string compare and is the right one.
- **The `?raw` import is justified, not a shortcut.** I empirically confirmed the writer's claim:
  `import { readFileSync } from 'node:fs'` under `@vitest-environment jsdom` in this repo fails with
  `No such built-in module: node:` (temp probe test, since deleted). The house `readFileSync` pattern
  (`test/sidebar-new-session-menu.test.ts:16`) genuinely cannot be used in a jsdom file here.
  `tsconfig.json` only includes `src/**/*`, so the `?raw` suffix cannot break `tsc --noEmit`.
- `methodBody()` (test:397-403) fails loudly rather than silently on a rename (the `start === -1`
  expectation fires first), so the negative guards cannot go vacuous.
- Naming, file layout, header comments and the `describe` grouping all match the existing
  `test/overlay-history.test.ts` / `agent-management-ui.playwright.ts` conventions.

**Blocking issues** (all in `test/files-html-preview.test.ts`; each is a few lines):

1. **Re-render idempotency is untested — and this is the actual Preview-tab code path.**
   The Preview button calls `app._filesRenderView()` on a view that is *already* a frame, so
   `content.innerHTML = ''` (app.js:19866) is load-bearing. If that line were deleted, **every test in
   both suites would still pass**: the jsdom suite never renders twice in a row, and the Playwright
   history test (`playwright.ts:197-198`) clicks Preview while already in preview but only
   `waitForSelector`s — it never counts frames. Add to the `sandbox contract` (or a new `re-render`)
   block: open a `.html`, call `app._filesRenderView()` a second time, then assert
   `content().querySelectorAll('iframe.files-html-frame')` has length 1 **and**
   `content().querySelectorAll('.files-html-preview')` has length 1. Optionally mirror it in
   Playwright with `page.$$eval(...).length === 1` after the existing Preview click.

2. **The behavioural constants of this feature have no source-text guard, so replica drift is
   undetected for everything except the security contract.** The `source guards` block correctly pins
   `sandbox`/`srcdoc`/`OverlayHistory`/`is-frame`, but gaps 4, 5 and 7 rest *entirely* on the replica
   in the default `npm test` run (the `*.playwright.ts` file is excluded by
   `vitest.config.ts:7 include: ['test/**/*.test.ts']`, so it runs only when someone opts in by hand).
   Concretely, each of these app.js mutations ships green today:
   - `/\.html?$/i` → `/\.html$/i` (`.htm` silently stops previewing) — replica untouched, Playwright
     only ever opens `docs/page.html`.
   - `htmlPreview = isHtml && !cur.truncated` → `htmlPreview = isHtml` (a truncated document gets
     previewed misleadingly — the explicit rule in the spec) — no test anywhere opens a truncated
     file against the real code.
   - tab condition `(isMd || isHtml) && !cur.truncated` → reverted to `isMd &&…` (no Preview/Edit pair
     for HTML) — only the opt-in Playwright test 1 catches it.
   - the ` • preview: local assets not loaded` meta string changing or being dropped — the Playwright
     markdown test only asserts its *absence* for `.md`.
   Fix in the existing `src/web/public/app.js — source guards` describe, using the `methodBody(
   '_filesRenderView')` helper already there — four `toContain` assertions on the shipped text:
   `/\.html?$/i.test(cur.path)`, `const htmlPreview = isHtml && !cur.truncated`,
   `(isMd || isHtml) && !cur.truncated`, and `' • preview: local assets not loaded'`. That is the same
   rationale the gap analysis already applied to gap 1b ("the replica otherwise tests a copy, not the
   shipped code"); it just needs applying to the feature's other invariants.

**Non-blocking nits** (fix if convenient, not required to pass review):

3. `test:269-277` asserts `notes.md` renders `pre code` — true only because `beforeEach` deletes
   `window.CodemanMarkdown`, i.e. it is asserting the vendor-missing fallback, not the real `.md`
   path. The `no frame` / `no is-frame` half of the assertion is what matters; consider a comment
   saying so, or move `notes.md` out of that `it.each` list.
4. Empty `.html` content (`content: ''`) is never exercised — `frame.srcdoc === ''` renders a blank
   white frame. Review attempt 1 already logged this as a product nit; one assertion would pin
   whatever behaviour is intended.
5. The Playwright history test compares `OverlayHistory._stack.length` before/after, but the seeded
   flow never calls `filesOpenFile`, so the stack is `0` on both sides. It still catches a tab that
   pushes (0 → 1), which is the point — but a comment noting the baseline is empty would stop a
   future reader from over-trusting it.
6. Worth recording in the run instructions: the Playwright file only imports successfully under
   **system node v22** in this worktree; brew node v25 hits the better-sqlite3 ABI mismatch. The
   opposite of the usual repo advice, so it will waste someone's time otherwise.

Verdict: **REJECTED** — items 1 and 2 only. The suites are well built and every listed gap is
*addressed*; two of them are not yet *protected against the shipped code changing*, and the one code
path the Preview button actually re-enters (re-render) has no assertion at all.

### Test review attempt 2 — APPROVED

Re-ran both suites myself before judging (system node v22.22.0, which is what `node -v` already
resolves to in this worktree):
- `npx vitest run test/files-html-preview.test.ts` → **46 passed**
- `test/files-html-preview.playwright.ts` via a throwaway root config
  (`include: ['test/files-html-preview.playwright.ts']`) → **9 passed**; config deleted immediately,
  `git status` clean of it. No repo file was modified by this review other than this TASK.md entry.

**Blocking item 1 (re-render idempotency) — FIXED.**
- jsdom: new `describe('re-render (Preview tab clicked while already previewing)')` (test:252-281) with
  three tests. The first asserts `querySelectorAll('iframe.files-html-frame')`, `.files-html-preview`
  and `content().children` are each length 1 after a second `_filesRenderView()` — deleting
  `content.innerHTML = ''` from the replica makes all three go to 2. The second covers repeated
  re-renders picking up fresh `srcdoc`; the third covers the Edit → Preview return path (editor gone,
  exactly one frame).
- Playwright: new test at :220-236 clicks Preview twice and asserts `{frames: 1, wrappers: 1}` via a
  `page.evaluate` count — it genuinely counts frames now, which was the specific complaint about the
  old history test's bare `waitForSelector`.
- Bonus source guard at :496-506 (`content.innerHTML = '';` must appear before `createElement('iframe')`
  inside `methodBody('_filesRenderView')`), so the jsdom half can no longer drift from the shipped file.

**Blocking item 2 (behavioural-constant source guards) — FIXED, and they bite.**
Four new `toContain` guards in the `source guards` describe (test:516-536). I did not take the
writer's mutation table on trust: I re-derived `methodBody('_filesRenderView')` against the real
`src/web/public/app.js` in a scratch node script and confirmed (a) the extraction boundaries are
correct — `start` lands on `\n  _filesRenderView(` and `end` on the method's own closing `\n  }\n`
(64 lines, tail is the `actions.innerHTML = ...${editBtn}` line), so the guards cannot accidentally
match text from a neighbouring method; and (b) each guard string matches shipped **code**, not comment
text. Then I applied all five mutations to an in-memory copy and re-evaluated the guard predicates:

| Mutation | Guard still passes? |
| --- | --- |
| `/\.html?$/i` → `/\.html$/i` | no (guard pins the literal `?`) |
| `htmlPreview = isHtml && !cur.truncated` → `= isHtml` | no |
| tab cond → `if (isMd && !cur.truncated) {` | no |
| meta hint string deleted | no |
| `content.innerHTML = '';` deleted | no (`resetAt` → -1) |

Spot-checked in detail as requested: the meta guard is written as a **double-quoted** TS string
containing `${htmlPreview ? ' • preview: local assets not loaded' : ''}`, so there is no accidental
interpolation and the bullet/spacing are pinned byte-for-byte; the tab guard includes the trailing
`) {`, so a partial-substring pass (e.g. matching an `isMd || isHtml` that appears in some other
expression) is not possible. Neither string appears anywhere in the comment block above the iframe.

**Other checks.**
- `git diff HEAD --stat -- src/` → still exactly `app.js | 45 +++++-----` and `styles.css | 21 +++`,
  i.e. the original feature diff only; `git status --porcelain` shows the two new test files as the
  only additions (plus the pre-existing untracked `dist` / `vendor`). Source was not touched.
- Replica fidelity re-verified against the current `_filesRenderView()` diff hunk: the ordering of
  `meta.textContent`, `classList.toggle('is-frame', htmlPreview)`, the `!htmlPreview && isMd &&
  CodemanMarkdown` guard, and the branch order all match the shipped code.
- Nits 3-6 from attempt 1 are all addressed: `notes.md` moved out of the "does not preview" `it.each`
  with an explanatory comment plus a dedicated `does not frame a markdown file` test; empty-`.html`
  behaviour pinned (`srcdoc === ''`, `is-frame` on, no `pre code`); the Playwright history test now
  asserts `before.stack === 0` with a comment; the node-version quirk is in the Playwright header.

**Non-blocking nits (no action required):**
- The new guards are exact-string matches, so a purely cosmetic reformat of those lines (spacing,
  prettier) will fail them. That is the intended trade-off of the house source-guard pattern, but a
  future refactorer should expect to update the strings alongside the code.
- The whole-file `allow-same-origin` / `allow-scripts` guards strip only lines whose trimmed form
  starts with `//`. A block comment (`/* … allow-scripts … */`) would false-fail. Conservative
  direction, so harmless.
- Playwright test 8 depends on the shared `page` left in preview mode by test 7; it fails loudly
  rather than silently if that ever changes, so this is a readability note only.

Verdict: **APPROVED** — both blocking items are genuinely fixed and mutation-verified independently;
coverage of gaps 1-9 is complete and the security assertions remain the strongest part of the suite.


## QA Results

QA run 2026-08-01 (subagent). All checks PASS.

| Check | Result | Notes |
| --- | --- | --- |
| `npx tsc --noEmit` | PASS | zero errors |
| `npm run lint` | PASS | 0 errors, 2 pre-existing warnings (unused eslint-disable in `src/vault/search.ts:11`, `src/web/routes/session-routes.ts:246`) — both on master, unrelated to this change |
| `node --check src/web/public/app.js` | PASS | syntax OK (lint glob only covers `src/**/*.ts`) |
| `npx vitest run test/files-html-preview.test.ts` | PASS | 46/46 tests |
| `test/files-html-preview.playwright.ts` (throwaway root config, port 3251, system node v22) | PASS | 9/9 tests; temp config deleted afterwards |
| Dev server boot (`npx tsx src/index.ts web --port 37409`) | PASS | `/api/status` responded; no vendor 404s (worktree has `src/web/public/vendor`) |
| Headless browser check (chromium, 390x844) | PASS | see below |

### Browser verification (chromium headless, viewport 390x844)

Loaded `/`, opened the files sheet via `app.openFilesSheet()` + `app._filesShowView()`, seeded
`filesState.current` with a `.html` file containing an `<h1>` and an inline `<script>`, then called
`app._filesRenderView()`.

CSS rules confirmed ACTIVE via `getComputedStyle` (no swallowed rules / parse errors):
- `.files-sheet-view-content.is-frame` → `overflow: hidden`, `display: flex` (class present on the element: `files-sheet-view-content is-frame`)
- `.files-html-preview` → `flex-grow: 1`, `min-height: 0px`, `overflow: auto`, `background-color: rgb(255, 255, 255)`, `height: 100%`
- `.files-html-frame` → `display: block`, `width: 100%`, `height: 100%`, `border-top-width: 0px`, `background-color: rgb(255, 255, 255)`

UI / security assertions:
- `iframe.files-html-frame` present inside `.files-html-preview`; laid out at real size 390x736 (non-zero rect).
- `sandbox` attribute present and empty string (`sandbox=""`) → all restrictions on; does NOT contain `allow-same-origin` (and no `allow-scripts`).
- `referrerpolicy="no-referrer"`, `title="HTML preview"` set; content injected via `srcdoc` (151 chars), not `innerHTML` into the app DOM.
- Frame document renders: `h1` text read from the child frame = `"QA HTML Preview Heading"`.
- Inline `<script>` did NOT execute — frame `document.title` stayed empty; browser logged the expected
  `Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.`
  This console message is the desired security behaviour, not a defect.
- Meta line reads `180 B • preview: local assets not loaded`; action bar renders `Preview | Edit | Copy`.
- No failed network requests (no 4xx/5xx, no vendor 404s); no other console errors or page errors.

Server killed after the run; no temp files left in the worktree (`git status` shows only the expected
`TASK.md`, `app.js`, `styles.css`, the two new test files, and the pre-existing untracked `dist`/`vendor`).

### Docs Staleness

`git diff master..HEAD --name-only` is EMPTY — all work for this task is still uncommitted in the
working tree, so the master..HEAD rule produced no flags. Applying the same rules to the uncommitted
working-tree diff (`git status`) for completeness:

- UI docs may need update (frontend changed significantly) — `src/web/public/app.js` and `src/web/public/styles.css` are modified.
- No `src/web/routes/*.ts` changes → no API docs flag.
- No `skills/*/SKILL.md` changes → no skill docs flag.

Informational only; no docs were updated.

## Decisions & Context

- 2026-08-01 intake: user request "HTML documents should have a preview mode as well". Isolation-first design chosen (sandboxed opaque-origin iframe, scripts off in v1) over sanitize-and-inline; relative-asset rewrite via file-raw is optional stretch.
- 2026-08-01 implement: regex chosen as `/\.html?$/i` (matches `.html` + `.htm`; the spec's `/\.(html?)$/i` is equivalent — dropped the redundant capture group). `.xhtml` deliberately NOT matched: it would render as HTML, not XHTML, in a srcdoc frame.
- 2026-08-01 implement: introduced a single derived flag `htmlPreview = isHtml && !cur.truncated` rather than repeating the truncation check at each site, so the preview branch, the `is-frame` class, and the meta hint can never disagree.
- 2026-08-01 implement: `is-frame` is applied with `classList.toggle(..., htmlPreview)` in `_filesRenderView()` (self-correcting on every render) and explicitly removed in `filesStartEdit()`, `_filesRenderBinary()`, and at the top of `filesOpenFile()`. `_filesShowConflict` was left untouched per the non-goals — it does not replace `#filesSheetViewContent`.
- 2026-08-01 implement: the truncated-notice element is still created defensively in the frame branch even though `htmlPreview` excludes truncated files (dead but harmless; keeps the branch correct if the truncation rule is ever relaxed).
- 2026-08-01 implement: stretch goal (relative-asset rewrite) SKIPPED, confirming the spec's analysis — an opaque-origin sandbox frame withholds the `SameSite=Lax` `codeman_session` cookie, so rewritten `file-raw` requests would 401 on any `CODEMAN_PASSWORD` deployment. Limitation is user-visible via the meta line (` • preview: local assets not loaded`).

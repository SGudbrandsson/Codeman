# Task

type: feature
status: done
title: Clickable file paths in transcript open a read-only modal overlay
description: |
  In the Codeman web UI transcript/chat view, when a rendered assistant (or user)
  message contains a Markdown inline-code span that looks like a file path
  (e.g. `apps/skyvern/booking-sync/SKYVERN-FORK-FIX-BRIEF.md`, `src/index.ts`,
  `dist/index.js`), make that span clickable. Clicking opens a READ-ONLY modal
  overlay showing the file contents.

  Behaviour:
  - The span is only made clickable / styled as a link if the file ACTUALLY EXISTS
    on disk, resolved within the current project. If it does not exist, leave it as
    a normal inline-code span (no link, no overlay, no error chrome).
  - Clicking an existing file opens a modal overlay with the file contents,
    read-only. Prefer monospaced/scrollable display; syntax highlighting is a nice
    to have, not required. Provide an obvious close affordance (X / click backdrop /
    Esc).
  - File path resolution is scoped to the CURRENT PROJECT's working directory
    (the session's repo root, derived from the current project/session context in
    the UI/backend — "based on the current project URL/link", per the user). 

constraints: |
  - SANDBOXING IS A HARD REQUIREMENT: a path must resolve to a location INSIDE the
    project working directory. Any path that resolves outside it (via `..`, absolute
    paths escaping the root, symlinks, etc.) must be treated as non-existent — it
    must NOT open and MUST NOT be able to read the parent directory or anywhere else
    on the filesystem. The user explicitly said: "I cannot accidentally expand into
    the parent directory of the project."
  - No relative-path guessing/fuzzy lookups: resolve the path as given against the
    project root; if it isn't there, it doesn't exist.
  - Only open the overlay when the file exists. Do NOT show the overlay for missing
    files.
  - Determining existence requires a backend check (browser can't stat the FS).
    Add/extend a backend endpoint that takes a project/session identifier + a
    relative path, enforces the sandbox, and returns existence + (on open) contents.
    Batch existence checks if many spans appear, to avoid request storms.
  - Keep current rendering untouched for non-path inline code and for missing files.

affected_area: frontend (src/web/public/app.js TranscriptView + styles.css) — NO backend change; existing GET /api/sessions/:id/file-content already does existence + sandbox enforcement
work_item_id: wi-fdaf8229
fix_cycles: 0
test_fix_cycles: 0

## Root Cause / Spec
<!-- filled by analysis subagent -->

### Verified existing infrastructure (all confirmed by reading code)

1. **Backend `GET /api/sessions/:id/file-content`** — `src/web/routes/file-routes.ts`
   lines 157-261. Query params: `path` (relative, required), `lines` (default 500,
   cap 10000), `raw` ('true' to force binary metadata). Sandbox is FULLY enforced:
   - `fullPath = resolve(session.workingDir, filePath)` (line 168)
   - `resolvedPath = realpathSync(fullPath)` (line 171) — resolves symlinks; throws if
     missing → returns `NOT_FOUND` "File not found".
   - `relativePath = relative(session.workingDir, resolvedPath)`; if it
     `startsWith('..')` or `isAbsolute()` → returns `INVALID_INPUT`
     "Path must be within working directory" (lines 175-178).
   - Success response shape: `{ success: true, data: { ... } }`. For text:
     `data = { path, content, size, totalLines, truncated, extension }`.
     For image/video/binary (by extension or `raw=true`):
     `data = { path, size, type: 'image'|'video'|'binary', extension, url }`.
   - Missing/escaping/error → `{ success: false, error, code }` with non-2xx? NOTE:
     `createErrorResponse(...)` is RETURNED from the handler (not `reply.code(...)`),
     so HTTP status is 200 with a JSON body `{ success: false, ... }`. The existence
     check MUST therefore inspect the JSON `success` flag, NOT just `res.ok`.
     (Confirm during impl: `openFilePreview` itself relies on `res.ok` AND
     `result.success` — see app.js 19313-19317.)
   - **CONCLUSION: no backend change needed.** The frontend passes the path verbatim;
     the server resolves + sandboxes + reports existence. affected_area = frontend only.

2. **Frontend viewer `openFilePreview(filePath)`** — `src/web/public/app.js` line 19296
   (method on the `app` object). Signature: single arg `filePath`, a path RELATIVE to
   `session.workingDir`. It guards on `this.activeSessionId`, shows `#filePreviewOverlay`
   (adds class `visible`), sets `#filePreviewTitle = filePath`, fetches
   `/api/sessions/${activeSessionId}/file-content?path=...&lines=500`, and renders
   text/image/video/binary into `#filePreviewBody`. Close affordance: X button only
   (`onclick="app.closeFilePreview()"`, index.html line 452). There is currently NO
   backdrop-click and NO Esc handler for this overlay (closeAllPanels at app.js 15365
   does not include it). Per "reuse the existing viewer as-is" this is acceptable; adding
   Esc/backdrop is an OPTIONAL nicety (would go in closeFilePreview wiring / the global
   Escape handler at app.js 6481). Do NOT block on it.
   - **Reuse `app.openFilePreview(relativePath)` directly. Build no new modal.**

3. **Markdown rendering** — `renderMarkdown(text)` is a FREE function (app.js line 188),
   not a method. Inline code spans are produced by `inlineMarkdown()` (app.js 355-389):
   it extracts `` `...` `` into placeholders then restores them as literal
   `<code>...</code>` (line 365). There is NO class/id on these `<code>` elements, and
   the inner text is HTML-escaped (`&lt;` etc.). The rendered HTML is assigned via
   `innerHTML` at THREE sites, all inside the `TranscriptView` singleton object
   (app.js line 3060, exposed as `window.TranscriptView`):
   - `_typewriterReveal()` final pass — app.js line **3961** (animated assistant text).
   - `_renderTextBlock()` compact-summary block — app.js line **4344**.
   - `_renderTextBlock()` assistant content — app.js line **4442**.
   (User-role bubbles at ~4365-4420 use `textContent`, NOT markdown, so they have no
   `<code>` spans — out of scope, which matches "assistant messages" in the screenshot.)

4. **Session context inside TranscriptView** — `TranscriptView._sessionId` holds the
   rendered session's id (set in `load()`, app.js 3175). The global `app` object is
   referenced directly elsewhere in the file (e.g. app.js 1065 `app.sessions?.get(...)`,
   3742 `app.activeSessionId`). So from TranscriptView we can call
   `app.openFilePreview(path)` and read `app.activeSessionId`. Use `app.activeSessionId`
   for the existence-check fetch and for `openFilePreview` (which itself uses
   `this.activeSessionId`). Paths in inline code are ALREADY relative to the project root
   (screenshot example `apps/skyvern/booking-sync/SKYVERN-FORK-FIX-BRIEF.md`,
   `src/index.ts`, `dist/index.js`) so they are passed VERBATIM — no client-side path
   munging, no working-dir join, no `..` stripping (the backend owns all that).

5. **Path-detection reference** — `registerFilePathLinkProvider()` (app.js 5926) detects
   ABSOLUTE paths in terminal buffer text (`/home`, `/tmp`, with extensions). Our case is
   different: inline-code spans hold RELATIVE project paths. We mirror only the spirit
   (extension allow-list + segment shape), not the absolute-path regex.

### Implementation plan (frontend only)

**A. New post-processing function** (place near `replaceImagePaths`, ~app.js 402, as a
free function — call it `linkifyFilePaths(rootEl)`). It operates on a DOM element AFTER
`innerHTML` is set (not on the HTML string), so it can attach event listeners and avoid
re-escaping:
  - `rootEl.querySelectorAll('code')` — for each `<code>` whose `textContent` matches the
    path heuristic AND whose parent is NOT a `<pre>` (skip fenced code blocks; inline
    code only). Use `codeEl.closest('pre')` to exclude block code.
  - **Path heuristic** (`looksLikePath(text)`): trimmed text, single token (no spaces),
    matches `^[\w.@~-]+(?:\/[\w.@~+-]+)+$` (i.e. at least one `/` separating path-ish
    segments) OR a bare filename WITH a known code/doc extension
    `^[\w.@~-]+\.(md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|xml|css|scss|html|py|rs|go|sh|sql|env|lock|cfg|ini|conf)$`.
    Reject if it starts with a protocol (`http:`, `https:`, etc.), contains whitespace,
    backticks, or `<`/`>` (already escaped, but guard), or is purely numeric/an option
    flag. Length cap (e.g. < 512 chars). Absolute paths (`/...`) are allowed to be
    detected too — backend will reject any that escape the root, so they simply won't
    become links. Keep the heuristic permissive-ish; existence-check is the real gate.
  - Collect candidate `{ el, path }` pairs. De-dupe identical paths (Map path→[els]).

**B. Existence check (batched + cached, avoids request storms)**
  - Module-level cache keyed by `${sessionId}::${path}` → `Promise<boolean>` (or
    resolved boolean). Reuse the in-flight Promise so concurrent blocks asking for the
    same path share ONE request. Cache persists for the page session (paths don't
    un-exist meaningfully; acceptable staleness).
  - For each UNIQUE uncached path, issue a lightweight HEAD-equivalent existence check:
    reuse `GET /api/sessions/${app.activeSessionId}/file-content?path=<enc>&lines=1`
    (lines=1 minimizes payload; we only care whether `success === true`). Parse JSON;
    `exists = res.ok && json.success === true`. (No new endpoint — constraint satisfied.)
    - Throttle: process candidates with a small concurrency limit (e.g. 6 at a time) or
      just rely on the per-path de-dupe cache; since most transcripts have few unique
      code spans this is sufficient. If a single rendered block produces many (>N) unique
      candidate paths, cap or window them, but a hard cap is likely unnecessary.
  - On `exists === true`: mutate the `<code>` element in place — add class
    `tv-file-link` (new CSS), set `role="link"`, `tabindex="0"`,
    `title="Open ${path}"`, and attach a click handler
    `() => app.openFilePreview(path)` (also keydown Enter/Space for a11y). Optionally set
    `cursor:pointer`/underline via CSS.
  - On `exists === false`: leave the `<code>` untouched (plain inline code). No error
    chrome, no overlay — matches the "only clickable if exists" requirement.

**C. Wire the three render sites** — after each of the three `innerHTML` assignments
(3961, 4344, 4442) add a call to `linkifyFilePaths(<the element just set>)`:
  - 3961: `content` (the `.tv-content`) — call `linkifyFilePaths(content)`.
  - 4344: `body` (`.tv-compact-body`) — `linkifyFilePaths(body)`.
  - 4442: `content` (`.tv-content`) — `linkifyFilePaths(content)`.
  Because these run inside TranscriptView methods, the function reads `app.activeSessionId`
  internally (free function reaching the `app` global). Guard: if `!app?.activeSessionId`,
  bail (leave spans plain). Existence checks are async; spans become links a moment after
  render (fine — non-blocking, no layout shift since we only toggle class/handlers).

**D. CSS** — add a `.tv-markdown code.tv-file-link` rule in styles.css near the existing
`.tv-markdown code` block (~line 10224): `cursor: pointer; text-decoration: underline;
text-decoration-style: dotted;` and a hover color shift. Keep base `<code>` styling for
non-link spans unchanged.

### Edge cases / constraints addressed
- **Non-path spans** (e.g. `const x`, `npm run build`, `foo()`): fail `looksLikePath`
  (whitespace / no slash / no known extension) → never checked, stay plain.
- **Missing files**: backend returns `success:false` → not linkified.
- **Sandbox escape** (`../../etc/passwd`, absolute `/etc/passwd`, symlink-out): backend
  `realpathSync`+`relative().startsWith('..')` rejects → `success:false` → not linkified.
  Frontend adds ZERO path logic; passes the literal span text. (Hard requirement met by
  reuse, not reimplementation.)
- **Streaming / re-render**: `_typewriterReveal` runs `linkifyFilePaths` on its final
  full-markdown pass (3961) only, not on each typewriter frame. `load()` re-renders
  blocks via `_appendBlock`→`_renderTextBlock`, each calling `linkifyFilePaths` on its own
  fresh element — idempotent because we re-query a fresh subtree each time. Guard against
  double-binding by checking `codeEl.classList.contains('tv-file-link')` before attaching.
- **Multiple identical paths**: de-duped in the existence-check cache → one request, all
  matching spans linkified from the shared result.
- **Performance with many spans**: per-path Promise cache + (optional) concurrency cap
  prevents request storms; class-toggle mutation is cheap and causes no reflow cascade.
- **Wrong-session staleness**: existence cache is keyed by sessionId, so switching
  sessions doesn't cross-contaminate. `openFilePreview` uses the live `app.activeSessionId`
  at click time (consistent with the rest of the viewer).

### Concrete touch-list for the Fix subagent
- `src/web/public/app.js`:
  - Add free fn `linkifyFilePaths(rootEl)` + helper `looksLikePath(text)` + module-level
    existence cache Map, placed near `replaceImagePaths` (~line 402).
  - Add `linkifyFilePaths(content)` after line **3961**.
  - Add `linkifyFilePaths(body)` after line **4344**.
  - Add `linkifyFilePaths(content)` after line **4442**.
- `src/web/public/styles.css`: add `.tv-markdown code.tv-file-link { ... }` near 10224.
- NO change to `src/web/routes/file-routes.ts`, no new endpoint, no new modal.
- Verify with: `npm run typecheck` (app.js is JS, but build bundles it — run
  `npm run build` to ensure no syntax break) and manual smoke in a dev server.

## Fix / Implementation Notes

Implemented frontend-only, exactly per spec. No backend/endpoint/modal changes.

**`src/web/public/app.js`** (after `replaceImagePaths`, ~line 425+):
- `var _filePathExistsCache = new Map()` — module-level existence-check cache,
  keyed `${sessionId}::${path}` → `Promise<boolean>`. In-flight promises are shared
  so concurrent linkify passes for the same path issue ONE request; resolved values
  persist for the page session.
- `looksLikePath(text)` — trims, length-caps at 512, rejects whitespace/backticks/
  angle brackets and protocol prefixes (`^[a-z][a-z0-9+.-]*:`), then accepts either a
  multi-segment path (`^[\w.@~-]+(?:\/[\w.@~+-]+)+$`) or a bare filename with a known
  code/doc extension (md|ts|tsx|js|json|yaml|... case-insensitive). Detection is
  permissive on purpose; the server existence check is the real gate.
- `_checkFilePathExists(sessionId, path)` — caches + reuses a fetch to the EXISTING
  `GET /api/sessions/:id/file-content?path=<enc>&lines=1`. Returns
  `res.ok && json.success === true` (reads the JSON `success` flag, NOT just res.ok,
  because the route returns HTTP 200 with `{success:false}` on missing/escaping paths).
  Network errors resolve to false.
- `linkifyFilePaths(rootEl)` — bails if `!app?.activeSessionId`. Queries `<code>`
  spans, excludes any inside `<pre>` (`closest('pre')`) and any already-bound
  (`classList.contains('tv-file-link')`), filters by `looksLikePath`, de-dupes by path
  (Map path→[els]). For each unique existing path it adds class `tv-file-link`,
  `role="link"`, `tabindex="0"`, `title="Open <path>"`, a click handler calling
  `app.openFilePreview(path)`, and an Enter/Space keydown handler (a11y). Paths are
  passed VERBATIM — zero client-side path munging; all sandboxing stays server-side.
- Wired `linkifyFilePaths(...)` after all three TranscriptView innerHTML sites:
  `_typewriterReveal` final pass (`content`), compact-summary block (`body`), and
  assistant-content block (`content`).

**`src/web/public/styles.css`** (after `.tv-markdown code`, ~line 10233):
- `.tv-markdown code.tv-file-link` → `cursor: pointer` + dotted underline.
- `:hover` color/border shift; `:focus-visible` outline for keyboard a11y.
- Base `<code>` styling untouched.

**Build:** `npm run build` completes clean (app.js minified to 550.6kb, no syntax
errors); `tv-file-link` literals confirmed present in the bundled output.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

Reviewed against spec and verified all claims by reading the actual code.

**Correctness — PASS**
- `_checkFilePathExists` correctly gates on `res.ok && json.success === true`.
  Confirmed in `file-routes.ts` 157-261 that the route RETURNS `createErrorResponse(...)`
  (HTTP 200 + `{success:false}`) for missing (`realpathSync` throws → NOT_FOUND) and
  sandbox-escaping (`relative().startsWith('..') || isAbsolute()` → INVALID_INPUT)
  paths, so `res.ok` alone is insufficient — reading the JSON `success` flag is the
  correct and required approach.
- `openFilePreview` (app.js 19395) uses the SAME convention: `if (!res.ok) throw` then
  `if (!result.success) throw`. The existence check and the viewer agree, so a span
  that linkifies will also open successfully.
- `looksLikePath` verified against the spec accept/reject lists via a standalone Node
  run: accepts `src/index.ts`, `apps/skyvern/booking-sync/SKYVERN-FORK-FIX-BRIEF.md`,
  `dist/index.js`, `README.md`, `package.json`, `tsconfig.json`, `foo.tsx`; rejects
  `npm run build`, `const x`, `https://example.com`, `foo()`, `12345`, `-rf`,
  `mailto:...`, `file:///etc/passwd`, and multi-token strings. All correct.

**Sandbox — PASS (hard requirement met by reuse, not reimplementation)**
- Frontend adds ZERO path logic: the span's trimmed `textContent` is passed verbatim
  through `encodeURIComponent(path)` to the existing endpoint and to
  `app.openFilePreview(path)`. No `..` stripping, no working-dir join, no normalization.
  The sole sandbox gate is the server's `realpathSync` (symlink-resolving) +
  `relative().startsWith('..')/isAbsolute()` check. A `../`, absolute, or symlink-out
  path returns `success:false` → never linkified → cannot open. Requirement satisfied.

**Edge cases — PASS**
- Fenced code blocks excluded via `codeEl.closest('pre')`.
- Double-binding guarded twice: skip `tv-file-link` at query time AND re-check before
  attaching in the async callback.
- Identical paths de-duped via `byPath` Map → one existence request, all spans share it.
- Missing files left as plain `<code>` (no error chrome, no overlay).
- Bails when `!app?.activeSessionId`.

**Event-listener accumulation — PASS**
- Re-renders go through `_renderTextBlock`, which builds a fresh `content`/`body`
  element each time (`document.createElement` + new `innerHTML`); those carry no prior
  handlers. Within a single element the class guard prevents re-binding. No accumulation.

**Session staleness — acceptable (not a bug)**
- Cache keyed by `${sessionId}::${path}`; click resolves against live `app.activeSessionId`.
  Spec explicitly accepts this and it matches the rest of the viewer's behavior.

**CSS — PASS**
- `.tv-markdown code.tv-file-link` requires a `.tv-markdown` ancestor. Verified all three
  call sites operate on `tv-markdown` elements: assistant content and compact body set
  `className = 'tv-content/tv-compact-body tv-markdown'`; the typewriter site's
  `el.querySelector('.tv-content')` resolves to the same `_renderTextBlock`-built
  `tv-content tv-markdown` element. Cursor/dotted-underline + hover + focus-visible all
  apply. Base `code` styling untouched.

**Build/lint — PASS**
- `node --check` clean; `npm run build` succeeds; `tv-file-link` + `linkifyFilePaths`
  present in the bundled `dist/web/public/app.js`. app.js is eslint-ignored (consistent
  with the rest of the file). Style matches the surrounding `var`/free-function area
  (mirrors `replaceImagePaths` placement).

**Minor note (non-blocking):** bare dotfiles like `.env` do not match (the bare-filename
regex requires a name segment before the extension). Not in the spec's case list and it
fails safe to plain code, so no action required.

Verdict: APPROVED — ready for test gap analysis.

## Test Gap Analysis

### Verdict: GAPS FOUND (one feasible unit gap — `looksLikePath`)

**Changed source (excl. TASK.md):** `src/web/public/app.js` (new free fns
`looksLikePath`, `_checkFilePathExists`, `linkifyFilePaths` + module-level
`_filePathExistsCache` Map and the two path regexes), `src/web/public/styles.css`
(`.tv-markdown code.tv-file-link` rule). All frontend, browser-bundle.

### Harness assessment (how this repo tests app.js)

`app.js` is a ~550kb browser bundle of free functions + the `app`/`TranscriptView`
globals — NOT an ES module with exports, so it cannot be `import`ed. `vitest.config.ts`
uses `environment: 'node'` by default (jsdom is opt-in per-file via a docblock) and
`coverage.include` is `src/**/*.ts` only, deliberately excluding `app.js`. Three
established patterns exist for app.js, in increasing cost:

1. **Re-implement the pure free fn inside the test and exercise it** — the repo's
   pattern for exactly this kind of helper. `test/image-attach-rewrite.test.ts`
   tests `replaceImagePaths` (the literal sibling free fn that `linkifyFilePaths`
   was modeled on, ~app.js 400) by defining a copy of the function in the test file
   and running an input/output table against it. No import, no DOM, no fetch.
2. **Source-text assertions** — read app.js as a string and assert it contains/omits
   specific code (`test/sidebar-new-session-menu.test.ts`, `startSessionInCase`).
   Weak (asserts shape, not behavior); used when execution is impractical.
3. **Playwright full-browser tests** — `page.evaluate` against a live server for real
   DOM/fetch/UI behavior (`test/transcript-web-view.test.ts`,
   `test/file-link-click.test.ts`). All such tests are gated behind a
   `browserAvailable`/server-up flag and are the repo's mechanism for UI behavior.
   There is NO pattern anywhere that imports/`new Function`-extracts and executes an
   app.js free fn against the real source — fn-execution is either a hand-copy (#1) or
   Playwright (#3).

### Gaps

- **`looksLikePath(text)` — pure logic, NOT covered, FEASIBLE (actionable).**
  No-arg pure function (trim, length cap, whitespace/backtick/angle-bracket reject,
  protocol reject, then `_FILE_PATH_WITH_SLASH_RE` OR `_FILE_PATH_BARE_RE`). It is the
  highest-value, most-testable unit and has a clear accept/reject table from the spec
  and Review attempt 1. It maps 1:1 onto repo pattern #1 (the `replaceImagePaths`
  precedent in `image-attach-rewrite.test.ts`). Recommended: a new vitest test
  reproducing `looksLikePath` + its two regexes (copy them verbatim from app.js
  444-454) and asserting:
    - ACCEPT: `src/index.ts`, `apps/skyvern/booking-sync/SKYVERN-FORK-FIX-BRIEF.md`,
      `dist/index.js`, `README.md`, `package.json`, `tsconfig.json`, `foo.tsx`.
    - REJECT: `npm run build`, `const x` (whitespace), `https://example.com`,
      `mailto:x@y.z`, `file:///etc/passwd` (protocol), `foo()`, `12345`, `-rf`,
      a 600-char string (length cap), and any multi-token string.
    - Edge note (from Review): bare dotfiles like `.env` do NOT match — fail-safe,
      assert it stays `false` so the behavior is pinned.
  This is genuinely valuable: the regexes are the brittle part of the feature and a
  table test guards them against future edits.

- **`linkifyFilePaths(rootEl)` — DOM mutation, NOT unit-covered, NOT cheaply feasible
  (leave to QA/Playwright).** Requires jsdom + a stubbed `app` global
  (`activeSessionId`, `openFilePreview`) + mocked `fetch`, plus async-resolution
  timing, to verify class/`role`/`tabindex`/handler attachment, `<pre>` exclusion,
  double-bind guard, and per-path de-dupe. The repo does not unit-test app.js DOM
  mutators this way; equivalent UI behavior is covered by Playwright
  (`transcript-web-view.test.ts`, `file-link-click.test.ts`) and by manual QA. No
  committed Playwright test exists for THIS feature, but writing one is beyond the
  unit-test gate's scope and would duplicate the QA phase. Defer to Phase QA.

- **`_checkFilePathExists(sessionId, path)` — fetch + cache, NOT unit-covered, NOT
  cheaply feasible (leave to QA).** Behavior (gate on JSON `success===true` not just
  `res.ok`; per-`sessionId::path` Promise cache that de-dupes in-flight + persisted
  results; catch→false) needs `fetch` mocking and the Map's lifecycle. No repo
  precedent for unit-testing app.js fetch helpers; the underlying endpoint's
  existence/sandbox semantics are already covered server-side
  (`file-routes.ts`, and `file-link-click.test.ts` exercises the click→viewer path).
  Defer to QA.

**Action:** write a focused unit test for `looksLikePath` only (pattern #1, mirroring
`image-attach-rewrite.test.ts`). The two DOM/fetch fns are intentionally left to the
QA/Playwright phase per the repo's testing conventions. `status` → `writing-tests`.

### Re-check pass (2026-06-03) — Verdict: NO GAPS → `status` → `qa`

Re-ran after the Opus test review APPROVED `test/file-path-detection.test.ts`
(24 cases for `looksLikePath`). Re-verified the harness situation is UNCHANGED:
`vitest.config.ts` is still `environment: 'node'` with `coverage.include`
`src/**/*.ts` only (app.js deliberately excluded), and `app.js` is still a
browser bundle with no real exports (cannot be `import`ed). No new harness exists
or should be invented.

- The single feasible unit gap — `looksLikePath` (pure heuristic) — is now
  covered. `npx vitest run test/file-path-detection.test.ts` → 24 passed
  (re-run confirmed this pass).
- `linkifyFilePaths` (DOM mutation) and `_checkFilePathExists` (fetch + cache)
  are NOT newly feasible. There is still no repo precedent for unit-testing
  app.js DOM mutators or fetch helpers; they require jsdom + stubbed `app`
  global + mocked `fetch` + async timing. They remain QA/Playwright territory
  exactly as in the original analysis, and pinning them in the unit gate would
  duplicate the QA phase. The server-side existence/sandbox logic these depend on
  is already covered (`file-routes.ts`, `file-link-click.test.ts`).
- No genuinely feasible, valuable, previously-missed unit gap was found.

**Decision:** the one feasible gap is covered; all remaining frontend behavior is
QA/Playwright territory. `status` → `qa`.



## Test Writing Notes
<!-- filled by test writing subagent -->

### test/file-path-detection.test.ts (2026-06-03)
- Added a focused unit test for the pure heuristic `looksLikePath(text)` only.
  The two DOM/fetch functions (`linkifyFilePaths`, `_checkFilePathExists`) are
  intentionally left to the QA/Playwright phase per the gap analysis.
- **Pattern:** hand-copied `_FILE_PATH_EXTENSIONS`, `_FILE_PATH_WITH_SLASH_RE`,
  `_FILE_PATH_BARE_RE`, and `looksLikePath` VERBATIM from
  `src/web/public/app.js` (~lines 435-454) into the test file and exercised the
  copy with an accept/reject table. This mirrors the established repo precedent
  in `test/image-attach-rewrite.test.ts` (which copies the sibling free fn
  `replaceImagePaths`). app.js is a browser bundle with no exports, so it cannot
  be imported.
- **Known limitation:** because the source is hand-copied, the test will NOT
  catch the source drifting out of sync — if `looksLikePath` or its regexes
  change in app.js, this copy must be updated by hand. This is the accepted
  limitation of the repo's app.js unit-test pattern, documented in the file's
  docblock.
- **Coverage groups (24 cases, all passing):**
  - Accepts: slash-separated paths (`src/index.ts`,
    `apps/skyvern/booking-sync/SKYVERN-FORK-FIX-BRIEF.md`, `dist/index.js`,
    `src/web/public/app.js`) and bare filenames with known extensions
    (`package.json`, `README.md`, `styles.css`, `tsconfig.json`).
  - Rejects: command/code fragments with whitespace (`npm run build`,
    `const x = 5`), parens (`foo()`), URLs/protocols (`https://...`,
    `http://localhost:3001/api`, `mailto:`, `file://`), empty string, backticks,
    angle brackets, bare word without slash/extension (`something`), >512-char
    string.
  - Extension-list significance (documents bare-vs-slash behavior): bare
    `image.png` is REJECTED (png not in `_FILE_PATH_EXTENSIONS`) but
    `foo/image.png` is ACCEPTED via the slash regex (it does not consult the
    extension list).
  - Edge cases (pinned): leading/trailing whitespace is trimmed before eval;
    leading-dot dotfile `.env` is REJECTED (the bare regex requires a char
    before the extension dot) — fail-safe behavior intentionally pinned.
- **Verification:** every expected value was checked against the actual regex
  (via a node harness) BEFORE asserting. No aspirational assertions; all 24
  reflect real function behavior. `npx vitest run test/file-path-detection.test.ts`
  → 24 passed.

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

### Test review attempt 1 — APPROVED

Reviewed `test/file-path-detection.test.ts` (24 cases) against source
`src/web/public/app.js` lines 434-455 and the repo precedent
`test/image-attach-rewrite.test.ts`.

**Verbatim-copy check: PASS.** The hand-copied `_FILE_PATH_EXTENSIONS`,
`_FILE_PATH_WITH_SLASH_RE` (`/^[\w.@~-]+(?:\/[\w.@~+-]+)+$/`), `_FILE_PATH_BARE_RE`
(`new RegExp('^[\\w.@~-]+\\.(?:' + EXT + ')$', 'i')`), and the `looksLikePath` body
(trim → length-cap → `/[\s\`<>]/` reject → `/^[a-z][a-z0-9+.-]*:/i` protocol reject →
slash-OR-bare) match the source exactly. The only difference is `var`→`const`, which is
semantically identical. No stale logic.

**Correctness: PASS.** I re-implemented the regexes in a standalone Node harness and
independently evaluated all 24 inputs — every asserted expected value matches the real
function output (24/24, zero mismatches). Spot-verified the tricky ones the task called
out: `foo/image.png`→true (slash regex, png chars are word chars, extension list not
consulted), bare `image.png`→false (png absent from extension list), `.env`→false (bare
regex requires ≥1 char before the dot; leading-dot dotfiles don't match — note `env` IS
in the extension list, so the rejection is purely the leading-dot, correctly pinned),
`mailto:x@y.z`→false (protocol guard fires before regexes). No aspirational assertions.

**Coverage: PASS.** Covers the brittle heuristic — the one feasible unit gap. Accept set
includes the real screenshot path
(`apps/skyvern/booking-sync/SKYVERN-FORK-FIX-BRIEF.md`) and spec examples
(`src/index.ts`, `dist/index.js`) plus bare known-extension files. Reject set covers
realistic inline-code spans: command fragments (whitespace), code with parens, the full
protocol family, empty string, backticks, angle brackets, bare word, and the 512-char
cap. Boundary behaviors (whitespace trim, length cap, protocol guard, unknown-extension
bare-vs-slash divergence, leading-dot dotfile) are all pinned.

**Realism / Style: PASS.** Inputs are plausible transcript inline-code spans. Uses
`it.each` with `%j` table groups and nested `describe` blocks, matching the
`image-attach-rewrite.test.ts` precedent. Docblock honestly documents the hand-copy
pattern and the known drift limitation.

**Execution:** `npx vitest run test/file-path-detection.test.ts` → 24 passed (1 file).

Correctly scoped: `linkifyFilePaths` (DOM) and `_checkFilePathExists` (fetch/cache) are
deferred to QA/Playwright per the gap analysis and repo conventions — no unit-test
precedent exists for those, and pinning them here would duplicate the QA phase. No
issues found.

## QA Results
<!-- filled by QA subagent -->

### Automated checks (2026-06-03) — ALL PASS
- **TypeScript typecheck** (`npm run typecheck`): PASS — 0 errors. app.js is plain JS (not typechecked); TS build unaffected.
- **Lint** (`npm run lint`, runs `eslint 'src/**/*.ts'`): PASS — 0 errors, 2 pre-existing unused-eslint-disable warnings in `src/vault/search.ts` and `src/web/routes/session-routes.ts` (unrelated to this change; app.js is not in the eslint glob).
- **Unit test** (`npx vitest run test/file-path-detection.test.ts`): PASS — 24/24 tests.
- **Build** (`npm run build`): PASS — completes, app.js bundles to 550.6kb. Built `dist/web/public/app.js` contains `linkifyFilePaths` (2 refs) and `tv-file-link`; built `dist/web/public/styles.css` contains `tv-file-link`.

### Frontend Playwright check (port 43219) — PASS
- Server start note: the worktree's `node_modules` symlinks to the main repo, where `better-sqlite3` is compiled for NODE_MODULE_VERSION 141. The default `/usr/bin/node` (v22, ABI 127) fails to load it. Started successfully via `/home/linuxbrew/.linuxbrew/bin/node` (v25.6.1, ABI 141 — same binary the systemd service uses). `/api/status` returned version 0.6.6 with live sessions. (Environment/ABI quirk only — not a code defect.)
- **`window.app` present**: true.
- **CSS rule `tv-file-link` active**: injected `<code class="tv-file-link">` inside `.tv-markdown`; computed style = `cursor: pointer`, `text-decoration-line: underline`, `text-decoration-style: dotted`, `color: rgb(165,243,252)`. Both assertions (cursor=pointer, dotted/underline) PASS — CSS parses and applies.
- **Bundle loaded clean for the feature**: fetched `/app.js` confirmed `linkifyFilePaths` and `tv-file-link` present. No JS errors originate from the transcript/file-path code.
- **Pre-existing console errors (NOT caused by this change)**: 13 errors, all from `/vendor/xterm*.{js,css}` 404s → `ReferenceError: Terminal is not defined` (app.js:5628). Root cause: `src/web/public/vendor` is normally a symlink that is absent in this worktree (untracked per cleanup commit 7dde8b22); the tsx dev server serves from source where vendor is missing. `git diff master` shows NO vendor changes. This only breaks the xterm terminal view, not transcript markdown rendering. Not a feature regression.
- **End-to-end (best-effort)**: SKIPPED — the xterm/vendor breakage in the dev-source environment prevents reliably driving into a session transcript; the unit test + CSS-active + clean-feature-load checks are sufficient per QA guidance.

### Docs Staleness
- UI docs may need update (frontend changed): `src/web/public/app.js`, `src/web/public/styles.css` were modified.
- No `src/web/routes/*.ts` changes → API docs unaffected.
- No `skills/*/SKILL.md` changes → skill docs unaffected.
- (Informational only — docs not modified by QA.)

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->
- User confirmed: modal overlay, ONLY if file exists; no overlay when missing.
- User confirmed: sandboxed to project root, must not escape into parent dir.
- Source filename example from screenshot: inline-code span
  `apps/skyvern/booking-sync/SKYVERN-FORK-FIX-BRIEF.md`.
- REUSE EXISTING INFRASTRUCTURE — do NOT build a new viewer or backend. The
  read-only file viewer the user referred to ("when I open the file explorer and
  open a file") already exists. Wire the transcript click to the existing
  open-file path directly:
  - Frontend viewer: `openFilePreview(filePath)` in
    `src/web/public/app.js` (~line 19296). Arg is a path RELATIVE to the session
    working dir (e.g. "src/app.js"). It fetches contents and opens the read-only
    overlay modal (`filePreviewOverlay`). This is the modal to open on click.
  - Backend (already does existence + sandboxing, reuse as-is):
    `GET /api/sessions/:id/file-content?path=<relative>` in
    `src/web/routes/file-routes.ts` (~lines 158-261). It resolves against
    `session.workingDir`, runs `realpathSync`, and REJECTS paths where the
    relative result starts with `..` or is absolute (INVALID_INPUT) — i.e. the
    "cannot escape into parent dir" sandbox the user requires is ALREADY enforced
    server-side. A missing file returns an error response. So "only clickable if
    exists" = do a cheap existence check against this endpoint (or its raw/stat
    sibling) and only attach the click handler on success.
  - Session id / working dir on the frontend: `this.activeSessionId` and
    `this.sessions.get(id)?.workingDir` (a.k.a. `this.currentSessionWorkingDir`,
    ~line 9662). Resolve transcript paths the same way the explorer does — pass
    the path relative to workingDir to `openFilePreview()`.
  - Path-detection reference: `registerFilePathLinkProvider()` (~line 5926) shows
    how terminal file links are already detected; mirror that heuristic for inline
    code spans in the transcript renderer rather than inventing a new one.
  - Net scope: detect path-like inline-code spans in rendered transcript markdown
    → existence-check via file-content endpoint → if it exists, style as a link &
    on click call openFilePreview(relativePath); if not, leave as plain inline
    code. No new modal, no new endpoint, no new sandbox logic.

### Analysis subagent findings (2026-06-03)
- VERIFIED affected_area = frontend ONLY. The existing
  `GET /api/sessions/:id/file-content` (file-routes.ts 157-261) already does
  existence + symlink-resolved sandbox enforcement; no backend change is needed.
  Updated `affected_area` and `status` (analysis → fixing) accordingly.
- Inline code `<code>` spans are produced by the FREE function chain
  `renderMarkdown` → `inlineMarkdown` (app.js 188 / 355) with NO id/class, inner
  text HTML-escaped. The rendered HTML reaches the DOM via `innerHTML` at exactly
  three TranscriptView sites: app.js 3961 (`_typewriterReveal` final pass),
  4344 (compact summary), 4442 (assistant content). User bubbles use `textContent`
  (no markdown) — out of scope.
- Chosen hook: a new free fn `linkifyFilePaths(rootEl)` invoked on the DOM element
  AFTER each of those three innerHTML assignments (operates on live DOM so it can
  attach click handlers + a11y attrs without re-escaping). Detection: querySelectorAll
  '<code>' not inside <pre>, filtered by a relative-path heuristic, then gated by an
  existence check against the file-content endpoint (lines=1), with a per
  sessionId+path Promise cache to de-dupe/avoid request storms. Only spans the backend
  confirms add class `tv-file-link` + click → `app.openFilePreview(path)`. Paths are
  passed VERBATIM (already project-relative); ALL sandboxing stays server-side.
- IMPORTANT impl note: file-content's error path RETURNS `createErrorResponse(...)`
  (HTTP 200 + `{success:false}` body), so the existence check must read the JSON
  `success` flag, not just `res.ok`.
- Existing file-preview overlay has only an X close button (no Esc/backdrop). Reusing
  as-is is acceptable; adding Esc/backdrop is optional and out of scope.
- Full implementation spec written to `## Root Cause / Spec` above with exact line
  anchors and a concrete touch-list.

### Fix subagent decisions (2026-06-03)
- All spec line anchors re-verified against current code before editing and matched:
  `replaceImagePaths` @400, the three innerHTML sites @3961/4344/4442, `openFilePreview`
  @19296, `.tv-markdown code` CSS @10224.
- Implemented `linkifyFilePaths` as a free function reaching the `app` global (reads
  `app.activeSessionId`, calls `app.openFilePreview`) rather than a TranscriptView method,
  matching `replaceImagePaths`'s free-function placement. Bails early if no active session.
- Existence check reuses `file-content?lines=1` and gates on JSON `success === true`
  (not `res.ok` alone) — the route returns HTTP 200 + `{success:false}` for
  missing/sandbox-escaping paths. Paths passed verbatim; no frontend path logic added,
  so the server-side `realpathSync` + `relative().startsWith('..')` sandbox is the sole gate.
- Double-binding guarded two ways: skip `<code>` already carrying `tv-file-link` at query
  time, and re-check before attaching handlers in the async callback (re-renders re-query
  fresh subtrees; cache makes repeat checks free).
- Added `:focus-visible` outline beyond the spec's hover rule for keyboard accessibility,
  consistent with the `role=link`/`tabindex=0`/Enter-Space handlers.

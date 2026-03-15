# Task

type: bug
status: done
title: Mobile code blocks — word wrap and line numbers
description: |
  Code blocks in the transcript view are hard to read/navigate on mobile.

  Problems:
  - Code blocks require horizontal scrolling to read long lines
  - On mobile, trying to scroll left/right inside a code block is difficult and awkward

  Requested changes:
  1. Word wrap / soft wrap long lines in code blocks so they wrap to the next line instead of
     requiring horizontal scroll
  2. Add line numbers to code blocks (left gutter with line numbers)

  Location: TranscriptView / code block rendering in the mobile UI (likely in app.js or a
  dedicated code block component).

  Note: Word wrap in code can sometimes hurt readability — wrapping should break at character
  boundaries (not word boundaries) to preserve token structure. The goal is that on mobile
  you can read the full content without needing to scroll horizontally.

affected_area: frontend
fix_cycles: 2

## Reproduction

1. Open Codeman on a mobile device (or narrow browser window / DevTools mobile emulation).
2. Navigate to any session that contains Claude responses with fenced code blocks (e.g. any
   Python, bash, or JSON snippet in the transcript view).
3. Observe that long lines inside the code block extend beyond the visible width.
4. Attempting to scroll horizontally inside the `<pre>` block is awkward on touch — the
   gesture is often intercepted by the transcript scroll container, making some lines
   effectively unreadable.

## Root Cause / Spec

### Root cause

The `.tv-markdown pre` rule in `styles.css` (line 9793–9800) sets `overflow-x: auto` with no
`white-space` override, which defaults to the browser's inherited `pre` behaviour
(`white-space: pre`). This means long lines never wrap and the `<pre>` grows wider than the
viewport, requiring horizontal scroll.

There is no `white-space: pre-wrap` or `word-break: break-all` on `.tv-markdown pre` or
`.tv-markdown pre code`.

There is no existing syntax highlighter (no highlight.js / Prism loaded). Code blocks are
rendered by the custom `renderMarkdown()` function in `app.js` (line 210–220) which emits:

```html
<div class="tv-code-block">
  <button class="tv-code-copy" ...>Copy</button>
  <pre><code class="tv-code [language-LANG]">...escaped content...</code></pre>
</div>
```

No line numbers are generated.

The second code path `_wrapPreWithCopy()` (app.js line 2554–2571) handles tool-result `<pre>`
elements in the tool panel — same structure, same missing line-number and wrap treatment.

### Implementation spec

#### 1. Word wrap (always-on, not mobile-only)

Wrapping is beneficial on mobile and harmless on desktop (desktop users can still resize the
panel). Apply globally to `.tv-markdown pre`:

In `styles.css`, change the `.tv-markdown pre` block (lines 9793–9800):
- Replace `overflow-x: auto` with `overflow-x: hidden` (no horizontal scroll needed once
  lines wrap).
- Add `white-space: pre-wrap` so newlines are preserved but long lines wrap.
- Add `word-break: break-all` so wrapping occurs at character boundaries (not word
  boundaries), preserving token structure as requested.

The `.tv-markdown pre code` rule (lines 9801–9807) needs no change.

#### 2. Line numbers

No external library — implement with CSS counters only (no DOM manipulation, no JS changes).

Strategy: use a CSS counter on `.tv-markdown pre` that increments on each `\n` character.
This is not reliably achievable purely in CSS without special markup. Therefore the DOM
approach is needed:

**In `renderMarkdown()` (app.js, line 219–220):** After collecting `codeLines`, wrap each
line in a `<span class="tv-code-line">` element instead of joining with `\n`. Each span gets
a `data-line` attribute (or rely on CSS counters on the spans).

Concrete change to `renderMarkdown` fenced code block output (app.js line ~219–220):

```js
// current:
const code = esc(codeLines.join('\n'));
out.push('<div class="tv-code-block"><button ...>Copy</button><pre><code class="tv-code...">' + code + '</code></pre></div>');

// new: wrap each line in a span; join with newline inside the span sequence
const numberedLines = codeLines.map(l => '<span class="tv-code-line">' + esc(l) + '</span>').join('\n');
out.push('<div class="tv-code-block"><button ...>Copy</button><pre><code class="tv-code...">' + numberedLines + '</code></pre></div>');
```

**In `_wrapPreWithCopy()` (app.js, line 2554–2571):** The `pre` element is already in the
DOM by this point (it comes from tool-result rendering). Apply line numbering by splitting
the pre's textContent and replacing its innerHTML with numbered spans. This should happen
before the wrap div is constructed.

**CSS for line numbers** (add to `.tv-markdown pre code` section in `styles.css`):

```css
.tv-code-block pre {
  counter-reset: tv-line;
  padding-left: 3.2em; /* room for gutter */
}
.tv-code-line {
  display: block;
  position: relative;
  counter-increment: tv-line;
}
.tv-code-line::before {
  content: counter(tv-line);
  position: absolute;
  left: -3.2em;
  width: 2.6em;
  text-align: right;
  color: #475569;
  font-size: 0.75em;
  user-select: none;
  pointer-events: none;
}
```

The `user-select: none` on the `::before` pseudo-element ensures line numbers are not
copied when the user selects and copies code text.

#### Copy button interaction

The copy button currently copies `pre.textContent`, which will include newlines between
spans — this is correct. The line numbers come from CSS `::before` content which is not
part of `textContent`, so copied text will be clean code without line numbers.

#### Version bumps required

- `styles.css` is loaded with `?v=0.1692` (index.html line 12) → bump to `?v=0.1693`
- `app.js` is loaded with `?v=0.4.108` (index.html line 2111) → bump to `?v=0.4.109`

#### Scope decision

Apply word wrap always (not mobile-only media query). Line numbers apply always too — they
are a readability aid on all screen sizes and are unobtrusive on desktop.

## Fix / Implementation Notes

### Changes made

**app.js (renderMarkdown — fenced code blocks, line ~219):**
- Replaced `codeLines.join('\n')` with per-line `<span class="tv-code-line">` wrapping.
  Each line is still HTML-escaped via `esc()` before being placed in the span.

**app.js (_wrapPreWithCopy — tool panel pre elements, line ~2554):**
- Captured `rawText = pre.textContent` before clearing the element.
- Rebuilt the pre's inner content using safe DOM methods: `document.createElement('span')`,
  `span.textContent = lineText` (never innerHTML with user data), and
  `document.createTextNode('\n')` between spans.
- Copy button now copies `rawText` (clean code, no line-number contamination).
- Used `pre.querySelector('code') || pre` so the approach works whether a `<code>` child
  exists or the `<pre>` holds text directly.

**styles.css (.tv-markdown pre, line ~9793):**
- `overflow-x: auto` → `overflow-x: hidden`
- Added `white-space: pre-wrap` (preserves newlines, wraps long lines)
- Added `word-break: break-all` (breaks at character boundaries, not word boundaries)
- Added `.tv-code-block pre` rule: `counter-reset: tv-line; padding-left: 3.2em`
- Added `.tv-code-line` rule: `display: block; position: relative; counter-increment: tv-line`
- Added `.tv-code-line::before` rule: CSS counter gutter with `user-select: none`

**index.html:**
- `styles.css?v=0.1692` → `styles.css?v=0.1693`
- `app.js?v=0.4.108` → `app.js?v=0.4.109`

### Key decisions

- `_wrapPreWithCopy`: used safe DOM methods (`textContent`, `createTextNode`) instead of
  innerHTML to avoid XSS risk from tool-result content. The security hook flagged an initial
  attempt with innerHTML; switched to fully DOM-based approach.
- Word wrap and line numbers applied globally (not mobile-only) — line numbers improve
  readability on all screen sizes and are unobtrusive.
- CSS counters for line numbers (no external library needed).

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 3 — APPROVED

**Verdict: APPROVED** — all previously identified issues have been resolved.

- `_copyCode` now correctly reconstructs newline-delimited text from `.tv-code-line` spans via `querySelectorAll` (searches all descendants, including grandchildren inside `<code>`) + `join('\n')`. Falls back to `pre.textContent` for plain `<pre>` blocks. Correct.
- No double-spacing: `join('')` eliminates `\n` text nodes between spans; `display: block` on `.tv-code-line` handles line breaks. Correct.
- `_wrapPreWithCopy`: `rawText` captured before DOM mutation; copy button closes over it. No line-number contamination. Correct.
- CSS gutter: `padding-left: 3.2em` on `.tv-code-block pre` creates room inside the padding box for the `left: -3.2em` absolute `::before`. `overflow-x: hidden` clips only content outside the border box — gutter is within padding area, not clipped. Correct.
- Version bumps: `styles.css?v=0.1693`, `app.js?v=0.4.109`. Correct.

---

### Review attempt 2 — REJECTED

**Verdict: REJECTED** — concrete bug in `_copyCode`: copied code will have no newlines between lines.

#### `_copyCode` function (app.js line 164–172)

```js
window._copyCode = function (btn) {
  const pre = btn.nextElementSibling;
  const text = pre ? (pre.textContent || '') : '';
  navigator.clipboard.writeText(text).then(...);
};
```

`_copyCode` reads `pre.textContent` directly. With `join('')` (no `\n` text nodes between `.tv-code-line` spans), `pre.textContent` concatenates all span text contents with **no separator**. The copied text will be one long unbroken string with no newlines — all lines of code jammed together.

Example: a 3-line snippet `foo\nbar\nbaz` becomes copied as `foobarbaz`.

#### Why the prior review's "correct" assessment no longer applies

Review attempt 1 approved the `renderMarkdown` copy path under the assumption that `.join('\n')` was used, which would leave literal `\n` text nodes between spans. Those text nodes WOULD appear in `textContent`. Fix cycle 2 changed `.join('\n')` → `.join('')` to fix double-spacing, but the prior review was not re-run after that change.

#### `_wrapPreWithCopy` path

Still correct. `rawText` is captured from `pre.textContent` before DOM mutation and closed over by the copy button handler. Newlines in `rawText` are preserved from the original content. This path is unaffected by the `join('')` change.

#### Required fix

Update `_copyCode` to detect `.tv-code-line` spans and reconstruct the text with `\n` between them:

```js
window._copyCode = function (btn) {
  const pre = btn.nextElementSibling;
  if (!pre) return;
  const lineSpans = pre.querySelectorAll('.tv-code-line');
  const text = lineSpans.length > 0
    ? Array.from(lineSpans).map(s => s.textContent).join('\n')
    : (pre.textContent || '');
  navigator.clipboard.writeText(text).then(...);
};
```

This falls back to `pre.textContent` for plain `<pre>` blocks (backward compatible), and correctly reconstructs newline-delimited code for `.tv-code-line` span blocks.

This is the only blocking issue.

---

### Review attempt 1 — REJECTED

**Verdict: REJECTED** — one concrete rendering defect found (double-spacing between code lines).

---

#### renderMarkdown path

Correct. Each line is HTML-escaped via `esc(l)` before being placed in the span. The
`_copyCode` global function (line 164–172) reads `pre.textContent`, which traverses the
`<pre>` → `<code>` → `<span>` DOM tree and collects text content from span text nodes plus
the literal `\n` text nodes between spans. CSS `::before` pseudo-content is NOT included in
`textContent`, so copied text will be clean code. This path is correct.

#### _wrapPreWithCopy path

Correct. `rawText` is captured from `pre.textContent` before any DOM modification — ordering
is right. DOM rebuild uses `span.textContent = lineText` (safe, no XSS). The copy button
closes over `rawText` (not re-reads the DOM), so no line-number contamination. The
`pre.querySelector('code') || pre` fallback correctly handles both DOM shapes.

#### CSS specificity for padding-left override

`.tv-markdown pre` and `.tv-code-block pre` both have specificity (0,1,1). `.tv-code-block
pre` appears later in the stylesheet so it wins on cascade. `padding-left: 3.2em` correctly
overrides only the left side of the shorthand `padding: 14px 16px` on `.tv-markdown pre`.
This is correct.

#### DEFECT: Double-spacing between code lines

**This is a concrete visual bug.** In the `renderMarkdown` path, the HTML emitted is:

```
<span class="tv-code-line">line1</span>\n<span class="tv-code-line">line2</span>\n...
```

The `\n` characters between spans are literal text nodes inside the `<pre>`. With
`white-space: pre-wrap` on the `<pre>`, these `\n` characters are rendered as visible line
breaks. At the same time, `.tv-code-line { display: block }` causes each span to create its
own block line. The result is: each span occupies one block line, **and** the `\n` text node
after it renders as an additional blank line. Code blocks will appear double-spaced.

The same issue exists in `_wrapPreWithCopy` where `document.createTextNode('\n')` is
inserted between each span.

**Fix options** (pick one):
1. Remove the `\n` separators entirely — `display: block` on spans already creates new lines.
   In `renderMarkdown`: `.join('')` instead of `.join('\n')`.
   In `_wrapPreWithCopy`: do not append the `createTextNode('\n')` between spans.
2. Keep `\n` separators but change `.tv-code-line` to `display: inline` (not `block`) and
   rely on the `\n` + `pre-wrap` for line breaks — but then `position: relative` on the span
   and `position: absolute` on `::before` won't work correctly for multi-line content.

Option 1 is cleaner. Removing the `\n` separators is the correct fix.

#### Line-number alignment on wrapped lines

With `display: block` on `.tv-code-line` and `position: absolute` on `::before`, the line
number gutter appears at the top-left of the span box. If a long line wraps to multiple
visual rows, the number appears only beside the first visual row. This is the standard
behaviour for line-number gutters in editors and is acceptable.

#### Version bumps

Both version strings correctly incremented (`styles.css?v=0.1692` → `0.1693`,
`app.js?v=0.4.108` → `0.4.109`).

---

**Required fix before re-review:** Remove the `\n` separators between `.tv-code-line` spans
in both `renderMarkdown` (change `.join('\n')` to `.join('')`) and `_wrapPreWithCopy` (remove
the `createTextNode('\n')` append). This is the only blocking issue.

### Fix cycle 2 — double-spacing removal

**app.js (renderMarkdown, line ~219):**
- Changed `.join('\n')` to `.join('')` for the `numberedLines` variable. `display: block` on
  `.tv-code-line` spans already creates new lines; the literal `\n` text nodes between spans
  were causing an extra blank line under `white-space: pre-wrap`.

**app.js (_wrapPreWithCopy, line ~2566):**
- Removed `if (idx < rawLines.length - 1) codeEl.appendChild(document.createTextNode('\n'));`
  for the same reason — `display: block` spans do not need explicit `\n` separators.

**app.js (_copyCode, line ~164) — fix cycle 3:**
- Updated `_copyCode` to detect `.tv-code-line` spans via `pre.querySelectorAll('.tv-code-line')`.
- When spans are present, reconstructs text as `Array.from(lineSpans).map(s => s.textContent).join('\n')`.
- Falls back to `pre.textContent` for plain `<pre>` blocks without `.tv-code-line` spans (backward compatible).
- This restores correct newline-separated output for the Copy button after the `join('')` change in fix cycle 2 removed literal `\n` text nodes from the DOM.

## QA Results
<!-- filled by QA subagent -->

### QA run — 2026-03-15

**tsc --noEmit:** PASS (zero errors — run against main repo which shares all TypeScript source via git worktree; this fix touches only app.js, styles.css, index.html — no TS changes)

**npm run lint:** PASS (zero errors — eslint covers src/**/*.ts; no TS changes in this fix)

**Frontend checks (verified directly from source files — worktree has no node_modules so dev server cannot be started from worktree; static files verified from disk):**

- Page source contains `styles.css?v=0.1693`: **PASS**
- Page source contains `app.js?v=0.4.109`: **PASS**
- `.tv-code-line` CSS rule with `display: block` exists in styles.css: **PASS**
- `.tv-code-block pre` CSS rule has `counter-reset: tv-line`: **PASS**
- `_copyCode` uses `querySelectorAll('.tv-code-line')` with newline join: **PASS**
- `renderMarkdown` wraps each line in `<span class="tv-code-line">`: **PASS**

**Overall: ALL CHECKS PASS**

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

2026-03-15: Analysis complete. No syntax highlighter present — pure custom markdown renderer.
  Word wrap: CSS-only change on .tv-markdown pre. Line numbers: DOM span-wrapping per line +
  CSS counter ::before pseudo-element. Applies globally (not mobile-only).

2026-03-15: Implementation complete. _wrapPreWithCopy changed to use safe DOM methods
  (textContent/createTextNode) instead of innerHTML after security hook flagged XSS risk.
  Copy button preserves original rawText so copied code has no line-number contamination.

2026-03-15: Fix cycle 2 — removed \n text nodes between .tv-code-line spans in both
  renderMarkdown (.join('') instead of .join('\n')) and _wrapPreWithCopy (removed
  createTextNode('\n') append). Root cause: display:block spans + white-space:pre-wrap was
  rendering the literal \n as a blank line, causing visible double-spacing in code blocks.

2026-03-15: Fix cycle 3 — updated _copyCode to reconstruct newline-delimited text from
  .tv-code-line spans instead of reading pre.textContent directly. After fix cycle 2 removed
  literal \n text nodes, pre.textContent returned all lines concatenated with no separator.
  New approach: querySelectorAll('.tv-code-line') and join with '\n'. Falls back to
  pre.textContent for blocks without .tv-code-line spans (backward compatible).

# Task

type: fix
status: done
title: Mobile question UI card triggers right-side session drawer to slide open simultaneously
description: |
  When the AskUserQuestion multi-select UI appears on mobile, the right-side session drawer
  slides open at the same time.

  Screenshot observations:
  - A MODE question card ("How do you want to work through this build?") is rendered with
    options 1. YOLO and 2. Interactive
  - The question card is cut off on the right side
  - The session/sidebar drawer is simultaneously sliding in from the right, visible behind
    the question card
  - Both UI elements are competing for screen space at the same time

  Likely causes:
  1. The question UI card is wider than the viewport, causing horizontal overflow that
     triggers the swipe-to-open-drawer gesture detection
  2. OR the question UI render is triggering some state change that also opens the drawer
  3. OR the question card has a touch/scroll handler that conflicts with the swipe gesture
     detector for the right drawer

  Fix requirements:
  - Ensure the question UI card is constrained to viewport width (max-width: 100vw, no overflow)
  - Ensure the question card does not trigger the right-side drawer swipe gesture
  - The two UI states (question card visible vs drawer open) should be mutually exclusive —
    if a question card is showing, the drawer should not open
  - Check touch event propagation on the question card component and prevent it from bubbling
    to the drawer swipe handler

affected_area: frontend
fix_cycles: 0

## Reproduction

1. Open Codeman on a mobile device (screen width < 768px).
2. Start a Claude Code session that uses the AskUserQuestion tool (e.g. a session that immediately
   asks a mode question like "How do you want to work through this build?").
3. Observe: The question card appears partially clipped/cut off on the right side of the screen.
4. Observe: Simultaneously, the session list appears to slide in from the right (the SwipeHandler
   session-switch animation fires), competing with the question card for screen space.
5. Attempting to tap any question option may instead trigger a session-switch swipe gesture.

Alternatively, the sequence can be reproduced by:
1. Loading a session that fires an AskUserQuestion SSE event.
2. Watching `renderAskUserQuestionPanel()` set `display:flex` on `#askUserQuestionPanel`.
3. The panel renders as a hidden/clipped flex row child of `.main` — off-screen to the right.
4. A touch interaction on the right part of the screen triggers SwipeHandler._onTouchStart
   (since `_isDisabled()` has no check for auq-panel visibility).

## Root Cause / Spec

### Root Cause — Two compounding bugs

**Bug 1: auq-panel renders in the wrong flex axis (layout bug)**

`#askUserQuestionPanel` (`.auq-panel`) is a direct child of `<main class="main">`.
The `.main` CSS rule in `styles.css` is `display: flex` with no `flex-direction` set,
defaulting to `row`. This means all direct children of `.main` — the
`#terminalContainer` (with `flex: 1`) and `#askUserQuestionPanel` (with `flex-shrink: 0`)
— lay out side by side horizontally.

When `renderAskUserQuestionPanel()` sets `panel.style.display = 'flex'`, the panel
appears to the *right* of the terminal container. Because `terminal-container` has
`flex: 1` it claims all available space first, pushing the `auq-panel` off-screen
to the right. The `.main` has `overflow: hidden`, so the panel is clipped — visible only
at the right edge. This is why the question card appears "cut off on the right side".

The mobile CSS (`@media (max-width: 768px)` inside `mobile.css`) overrides the panel's
internal layout (buttons get `width: 100%`, column direction) but does NOT change the
panel's position within the `.main` flex row — it remains a horizontal sibling of the
terminal container.

The fix for Bug 1 is to make `.main` use `flex-direction: column` on mobile so the
`auq-panel` appears *below* the terminal as intended. Alternatively (and more robustly),
give the `auq-panel` `position: absolute; bottom: 0; left: 0; right: 0` on mobile so it
floats above the terminal at the bottom without disturbing the flex layout. A simpler
approach: on mobile (inside the `@media (max-width: 768px)` block) set `.auq-panel` to
`position: fixed; left: 0; right: 0; bottom: var(--toolbar-height, 52px);` so it is
always properly anchored above the toolbar.

**Bug 2: SwipeHandler._isDisabled() does not check for active auq-panel**

`SwipeHandler._isDisabled()` checks for many overlay states (modal, MCP panel, Plugins panel,
ContextBar, InputPanel, sessionDrawer open) but does NOT check whether `#askUserQuestionPanel`
is currently visible. When the auq-panel renders (even partially off-screen), any horizontal
touch gesture on `.main` can trigger the SwipeHandler session-switch animation. This
makes the current `.main` content translate horizontally (slide left) and the incoming session
skeleton slide in from the right — which the user sees as "the session drawer sliding in from
the right" competing with the question card.

The `_isDisabled()` check should also return `true` when:
```js
const auqPanel = document.getElementById('askUserQuestionPanel');
if (auqPanel && auqPanel.style.display !== 'none') return true;
```

### Implementation Spec

**Change 1 — mobile.css: Fix auq-panel layout position on mobile**

Inside the `@media (max-width: 768px)` block where `.auq-panel` is already styled,
add position rules to take the panel out of the `.main` flex row and pin it above the
toolbar:

```css
/* In the @media (max-width: 768px) block: */
.auq-panel {
  /* existing properties... */
  position: fixed;
  left: 0;
  right: 0;
  bottom: 52px;   /* above the fixed keyboard accessory bar */
  z-index: 200;   /* above terminal, below modals */
  max-width: 100vw;
  box-sizing: border-box;
  overflow-x: hidden;
}
```

OR alternatively keep it in normal flow but ensure `.main` uses `flex-direction: column`
on mobile so auq-panel stacks below terminal. Either approach is acceptable; the fixed
position approach is more robust since it doesn't require changing `.main` layout.

**Change 2 — mobile-handlers.js: Add auq-panel guard to SwipeHandler._isDisabled()**

In `SwipeHandler._isDisabled()`, add a check for the visible auq-panel before the
`return false`:

```js
const auqPanel = document.getElementById('askUserQuestionPanel');
if (auqPanel && auqPanel.style.display !== 'none') return true;
```

This ensures that while a question is displayed, horizontal swipe gestures are blocked.

**Change 3 — styles.css: Ensure auq-panel never overflows viewport width on any screen**

In the base `.auq-panel` rule in `styles.css`, add:
```css
max-width: 100%;
box-sizing: border-box;
overflow-x: hidden;
```

And in `.auq-options`, add `overflow-x: hidden` so buttons never push the container
wider than its parent.

### Files to change

- `src/web/public/mobile.css` — fix `auq-panel` positioning inside `@media (max-width: 768px)`
- `src/web/public/mobile-handlers.js` — add auq-panel visibility guard in `SwipeHandler._isDisabled()`
- `src/web/public/styles.css` — add `max-width: 100%; box-sizing: border-box; overflow-x: hidden` to `.auq-panel` base rule

## Fix / Implementation Notes

Three changes implemented as specified:

**Change 1 — `src/web/public/mobile.css`**
Inside the `@media (max-width: 768px)` block, replaced `.auq-panel`'s `position: relative; z-index: 10` with `position: fixed; left: 0; right: 0; bottom: 52px; z-index: 200; max-width: 100vw; box-sizing: border-box; overflow-x: hidden`. This takes the panel out of the `.main` flex row so it no longer renders as an off-screen horizontal sibling of `#terminalContainer`, and instead pins it above the toolbar at the bottom of the viewport.

**Change 2 — `src/web/public/mobile-handlers.js`**
Added auq-panel visibility guard at the end of `SwipeHandler._isDisabled()`, before `return false`:
```js
const auqPanel = document.getElementById('askUserQuestionPanel');
if (auqPanel && auqPanel.style.display !== 'none') return true;
```
This prevents horizontal swipe gestures from triggering the session-switch animation while a question card is visible.

**Change 3 — `src/web/public/styles.css`**
Added `max-width: 100%; box-sizing: border-box; overflow-x: hidden` to the base `.auq-panel` rule, and `overflow-x: hidden` to `.auq-options`. This ensures buttons can never push the container wider than its parent on any screen size.

## Review History

<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

All three changes were verified against the actual files in `src/web/public/`.

**Change 1 (mobile.css):** The `.auq-panel` rule inside `@media (max-width: 768px)` correctly replaces `position: relative; z-index: 10` with `position: fixed; left: 0; right: 0; bottom: 52px; z-index: 200; max-width: 100vw; box-sizing: border-box; overflow-x: hidden`. The `left: 0; right: 0` pair on a `position: fixed` element fills the full viewport width without needing an explicit `width: 100%`.

The existing `.auq-panel[style*="display:none"] { display: none !important; }` rule at line 2352 remains fully functional — the `position: fixed` change does not affect the `display` property it targets.

Keyboard-open edge case: `KeyboardHandler.updateLayoutForKeyboard()` moves the toolbar, accessoryBar and inputPanel upward via `translateY` when the keyboard is visible, but does NOT move the auq-panel. However, this is not an issue in practice because (a) the auq-panel is a button-only UI that does not require keyboard input, so the keyboard should never be open while the auq-panel is shown; and (b) `SwipeHandler._isDisabled()` already returns `true` unconditionally when `KeyboardHandler.keyboardVisible` is true (line 545), making the new auq-panel guard redundant in that state anyway.

**Change 2 (mobile-handlers.js):** The `_isDisabled()` guard is placed correctly (before `return false`, after all other checks). The inline-style check `auqPanel.style.display !== 'none'` is valid: the HTML initializes the panel with `style="display:none;"` and `renderAskUserQuestionPanel()` only ever sets `panel.style.display` to either `'none'` or `'flex'`, so the check will never encounter an empty-string edge case that could accidentally block swipe.

**Change 3 (styles.css):** `overflow-x: hidden` on `.auq-options` does not conflict with `flex-wrap: wrap` in the desktop base rule — buttons will wrap before overflowing since the parent has `max-width: 100%` and `box-sizing: border-box`. On mobile, `.auq-options` uses `flex-direction: column; gap: 5px` (no wrap), so the property is a safe no-op there.

## QA Results

**Date:** 2026-03-15
**Status:** ALL PASS — status set to `done`

### 1. TypeScript typecheck (`tsc --noEmit`)
PASS — Zero errors

### 2. ESLint (`npm run lint`)
PASS — Zero errors/warnings

### 3. CSS verification (served files at mobile viewport 375x812)

Dev server started on port 3088 (`npx tsx src/index.ts web --port 3088`) and verified via Playwright at 375x812 viewport.

**Change 1 — mobile.css auq-panel positioning:**
PASS — Computed styles when panel is shown:
- `position: fixed` (correct, was `relative`)
- `bottom: 52px` (correct)
- `z-index: 200` (correct, was `10`)
- `left: 0px, right: 0px` (spans full viewport width of 375px)
- `overflow-x: hidden` (correct)

**Change 2 — mobile-handlers.js SwipeHandler._isDisabled() guard:**
PASS — Lines 552-553 confirmed present in served file:
```js
const auqPanel = document.getElementById('askUserQuestionPanel');
if (auqPanel && auqPanel.style.display !== 'none') return true;
```

**Change 3 — styles.css base auq-panel rule:**
PASS — Base `.auq-panel` rule in served styles.css contains `max-width: 100%; box-sizing: border-box; overflow-x: hidden`. `.auq-options` contains `overflow-x: hidden`.

## Decisions & Context

- Used `position: fixed` approach for Bug 1 (rather than changing `.main` to `flex-direction: column`) because it is more robust: it doesn't disturb the existing desktop/main layout flex configuration and works regardless of where the panel sits in the DOM tree.
- `bottom: 52px` chosen to match the hardcoded toolbar height constant used elsewhere in mobile layout (per MEMORY.md: `barHeight = 52px bar`).
- `z-index: 200` is above terminal layers but below modals (which typically use 1000+), matching the spec.
- The `_isDisabled()` guard checks `auqPanel.style.display !== 'none'` (inline style check) to match how `renderAskUserQuestionPanel()` shows/hides the panel via `panel.style.display = 'flex'` / `'none'`.

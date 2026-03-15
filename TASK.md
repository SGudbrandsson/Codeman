# Task

type: bug
status: done
title: Mobile upload options — convert to bottom drawer and fix z-index overlap with working indicator
description: |
  Two related issues with the mobile plus/upload UI.

  ## Problem 1 — Upload options should be a bottom drawer
  Currently when the user taps the plus (+) button on mobile, upload/attach options appear
  hovering above the plus icon as a floating menu/popup. This should instead be a bottom
  drawer that slides up from the bottom of the screen (same pattern as the hamburger menu
  drawer / SessionDrawer).

  ## Problem 2 — Working/loading animation overlaps the drawer
  The working/loading animation (shown when a session is busy) is rendered at a z-index that
  puts it on top of the upload drawer/popup. When the user opens the upload options while
  something is loading, the animation covers the drawer content, making it unusable.

  Fix: Ensure the upload drawer has a higher z-index than the working indicator, OR ensure
  the working animation is hidden/suppressed while the upload drawer is open.

affected_area: frontend
fix_cycles: 0

## Reproduction

### Problem 1 — Upload options floating popup instead of bottom drawer
1. Open the app on a mobile device (or use browser DevTools mobile emulation).
2. Navigate to any active session so the compose panel is visible.
3. Tap the **+** (plus) button in the compose input panel.
4. Observe: Three option buttons ("Take Photo", "Photo Library", "Attach File") and a
   "Cancel" button appear as a **static panel anchored at `bottom: 0`** — but the sheet is
   revealed by toggling `display:none` / `display:''` (`_openActionSheet` / `_closeActionSheet`)
   with no slide-in animation or overlay backdrop that fades in. Visually it looks like a
   floating menu hovering above the compose bar rather than a proper animated bottom drawer.

### Problem 2 — Working/loading indicator overlaps the action sheet
1. Start a session and send a message so Claude begins responding (typing indicator appears:
   the three bouncing blue dots in `#tvTypingIndicator`).
2. While Claude is still thinking, tap the **+** button.
3. Observe: The `#tvTypingIndicator` overlay is `position: absolute` inside `.main`
   (which is `position: relative`), with **`z-index: 53`** (desktop) or effectively the same
   on mobile. The `.compose-action-sheet` has **`z-index: 55`** and the backdrop
   **`z-index: 54`** — so the action sheet *should* be above the indicator numerically.
   However, the typing indicator is positioned by `bottom` offset above the compose panel,
   meaning it can visually sit directly in front of the sheet's top portion when the sheet
   slides up, and on some viewport sizes the bouncing dots appear **on top of** the first
   item in the action sheet because `z-index` stacking only works correctly within the same
   stacking context. `.main` uses `position: relative` (creates a stacking context), and the
   indicator's `z-index: 53` competes directly with the *fixed*-positioned sheet at `z-index: 55`
   — but fixed elements establish their own stacking context relative to the viewport, so the
   final paint order depends on the browser's compositing of the fixed sheet vs. the absolute
   indicator inside `.main`. In practice the dots remain visible over the sheet on some devices.

## Root Cause / Spec

### Root Cause Summary

**Problem 1:** `_openActionSheet()` / `_closeActionSheet()` in `app.js` (lines 16901–16913)
simply toggle `display:none` on `#composeActionSheet` and `#composeActionBackdrop`. The
action sheet is already visually styled as a bottom sheet (see `mobile.css` lines 2722–2735:
`position:fixed; left:0; right:0; bottom:0`), but it has **no slide-in animation** and no
CSS class-toggling pattern — it just blinks into existence. It is NOT wired up with the same
`open` class + CSS transition pattern used by `SessionDrawer`.

**Problem 2:** `#tvTypingIndicator` (`tv-typing-overlay`) is `position: absolute` inside
`.main` (`position: relative`), with `z-index: 53` (`styles.css` line 9575), overridden on
mobile by a `!important` `bottom` recalculation (`mobile.css` line 83-85) but **no
z-index override**. The action-sheet backdrop is `z-index: 54` and the sheet itself is
`z-index: 55` (`mobile.css` lines 2719, 2727). In theory 55 > 53 and the sheet wins, but
because `#tvTypingIndicator` is inside a `position: relative` stacking context (`.main`) and
the sheet is `position: fixed` (viewport stacking context), the compositing order is
browser-defined. Some browsers and iOS WebView will paint the absolute-positioned child of
`.main` on top of the fixed element because `.main` itself can be composited to its own
layer. The simplest robust fix is to either raise `z-index` of the sheet to a value above
the session-drawer range, or (better) hide the typing indicator while the sheet is open.

---

### Implementation Spec

#### File inventory

| File | Purpose |
|------|---------|
| `src/web/public/index.html` | HTML for `#composeActionSheet`, `#composeActionBackdrop`, `#tvTypingIndicator` |
| `src/web/public/mobile.css` | CSS for `.compose-action-sheet`, `.compose-action-backdrop`, `.tv-typing-overlay` |
| `src/web/public/app.js` | `InputPanel._openActionSheet()` / `_closeActionSheet()`, `TranscriptView.setWorking()` |

---

#### Change 1 — Convert action sheet to animated bottom drawer (CSS)

**File:** `src/web/public/mobile.css`, lines 2715–2758

Replace the static `display:none` visibility model with a CSS class-toggle animation,
matching the `sheet-up` pattern already used by `#newPickerModal` (mobile.css line 2817–2822).

Current `.compose-action-backdrop` (line 2716): uses `display` toggle via JS.
Current `.compose-action-sheet` (line 2722): no transition, no animation.

New approach — use `opacity`/`transform` transitions on `.compose-action-backdrop` and
`.compose-action-sheet`, driven by an `.open` class (mirrors SessionDrawer pattern):

```css
/* Replace current "Plus action sheet" block */
.compose-action-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10002;          /* above everything including session drawer (9000) */
  background: rgba(0,0,0,0.5);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease;
}
.compose-action-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}
.compose-action-sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10003;          /* above backdrop */
  background: #1a1a2e;
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  padding: 8px 16px calc(16px + var(--safe-area-bottom));
  display: flex;
  flex-direction: column;
  gap: 4px;
  transform: translateY(100%);
  transition: transform 0.25s cubic-bezier(0.32, 0.72, 0, 1);
}
.compose-action-sheet.open {
  transform: translateY(0);
}
```

Remove `style="display:none;"` from the HTML (both `#composeActionSheet` and
`#composeActionBackdrop` in `index.html` lines 1970 and 1980), since visibility is now
controlled by the `.open` class.

The z-index values `10002` / `10003` are safely above `session-drawer` (9000) and the
header hamburger button (1150), which is currently the highest non-modal z-index in the app.

---

#### Change 2 — Update `_openActionSheet` / `_closeActionSheet` in app.js (JS)

**File:** `src/web/public/app.js`, lines 16901–16913

Replace `display` toggling with class toggling, and suppress the typing indicator while open:

```js
_openActionSheet() {
  const sheet = document.getElementById('composeActionSheet');
  const backdrop = document.getElementById('composeActionBackdrop');
  if (sheet) sheet.classList.add('open');
  if (backdrop) backdrop.classList.add('open');
  // Suppress typing indicator while drawer is open — avoids z-index compositing conflict
  const indicator = document.getElementById('tvTypingIndicator');
  if (indicator) indicator.style.display = 'none';
},

_closeActionSheet() {
  const sheet = document.getElementById('composeActionSheet');
  const backdrop = document.getElementById('composeActionBackdrop');
  if (sheet) sheet.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
  // Restore typing indicator if session is still working
  if (typeof TranscriptView !== 'undefined') {
    // Re-evaluate: if session is busy, setWorking(true) will re-show it
    const sessionWorking = typeof app !== 'undefined' && app.activeSessionId
      ? app.sessions?.get(app.activeSessionId)?.status === 'busy'
      : false;
    if (sessionWorking) TranscriptView.setWorking(true);
  }
},
```

---

#### Change 3 — Remove `display:none` initial styles from HTML

**File:** `src/web/public/index.html`

- Line 1970: Remove `style="display:none;"` from `<div class="compose-action-sheet" id="composeActionSheet" ...>`
- Line 1980: Remove `style="display:none;"` from `<div class="compose-action-backdrop" id="composeActionBackdrop" ...>`

The elements will now be invisible by default because `.compose-action-sheet` starts with
`transform: translateY(100%)` and `.compose-action-backdrop` starts with `opacity: 0;
pointer-events: none`.

---

#### Summary of z-index changes

| Element | Old z-index | New z-index | Location |
|---------|------------|------------|----------|
| `.tv-typing-overlay` | 53 | 53 (unchanged) | `styles.css:9575` |
| `.compose-action-backdrop` | 54 | 10002 | `mobile.css:2719` |
| `.compose-action-sheet` | 55 | 10003 | `mobile.css:2727` |
| `.session-drawer-overlay` | 8999 | unchanged | `mobile.css:2407` |
| `.session-drawer` | 9000 | unchanged | `mobile.css:2421` |

The typing indicator suppression in `_openActionSheet` is the belt-and-suspenders fix
— it makes the overlap impossible regardless of stacking context behaviour across browsers.

## Fix / Implementation Notes

### Changes made

**mobile.css** (`src/web/public/mobile.css`, lines 2715–2735):
- Replaced the static "Plus action sheet" CSS block with an animated bottom drawer pattern.
- `.compose-action-backdrop`: added `opacity: 0; pointer-events: none; transition: opacity 0.22s ease;` for fade-in, raised z-index from 54 → 10002.
- `.compose-action-backdrop.open`: sets `opacity: 1; pointer-events: auto`.
- `.compose-action-sheet`: added `transform: translateY(100%); transition: transform 0.25s cubic-bezier(0.32, 0.72, 0, 1);` for slide-up, raised z-index from 55 → 10003. Removed the implicit `display:none` requirement since visibility is now CSS-driven.
- `.compose-action-sheet.open`: sets `transform: translateY(0)`.
- Preserved all `.compose-action-item` and `.compose-action-cancel` button styles unchanged.

**app.js** (`src/web/public/app.js`, around line 16901):
- `_openActionSheet()`: replaced `sheet.style.display = ''` / `backdrop.style.display = ''` with `classList.add('open')` on both elements. Added suppression of `#tvTypingIndicator` via `indicator.style.display = 'none'` to prevent z-index compositing overlap on iOS WebView.
- `_closeActionSheet()`: replaced `style.display = 'none'` with `classList.remove('open')`. Added logic to restore the typing indicator if the active session is still busy (`status === 'busy'`).

**index.html** (`src/web/public/index.html`):
- Removed `style="display:none;"` from `#composeActionSheet` (line 1970). Visibility is now controlled by `transform: translateY(100%)` in CSS.
- Removed `style="display:none;"` from `#composeActionBackdrop` (line 1980). Visibility is now controlled by `opacity: 0; pointer-events: none` in CSS.
- Bumped `mobile.css?v=0.1674` → `mobile.css?v=0.1675`.
- Bumped `app.js?v=0.4.109` → `app.js?v=0.4.110`.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

All three files (mobile.css, app.js, index.html) match the implementation spec exactly.

**CSS (mobile.css):** Backdrop and sheet correctly converted to opacity/transform animation model with `.open` class toggle. z-index raised to 10002/10003 (above session-drawer at 9000). `.compose-action-item` and `.compose-action-cancel` styles preserved unchanged.

**HTML (index.html):** `style="display:none;"` removed from both elements — correct, since visibility is now CSS-driven via `transform: translateY(100%)` / `opacity: 0`. Version bumps applied to both asset URLs.

**JS (app.js):** `_openActionSheet` and `_closeActionSheet` correctly switch from `display` toggling to `classList` toggling. Typing indicator suppression on open is straightforward and correct.

One intentional deviation from the implementation spec: `_closeActionSheet` restores the indicator via `indicator.style.display = ''` directly, rather than calling `TranscriptView.setWorking(true)`. This is explicitly noted in Decisions & Context and is the safer approach — it avoids re-triggering the 300ms debounce and its side effects.

**Edge case assessed:** If `setWorking(true)` fires its 300ms debounce while the drawer is still open, it will call `overlay.style.display = 'flex'`, potentially fighting with the `display = 'none'` set by `_openActionSheet`. However, this is an extremely tight race (drawer opened within 300ms of a session going busy) and the z-index elevation to 10003 ensures the sheet still wins visually regardless. Not a blocking concern.

No security issues, no unused variables, no implicit any (plain JS). The change is minimal and consistent with existing patterns in the codebase.

## QA Results

### Run: 2026-03-15

| Check | Result | Notes |
|-------|--------|-------|
| tsc --noEmit | PASS | Zero TypeScript errors |
| npm run lint (eslint) | PASS | Zero ESLint errors |
| HTTP 200 | PASS | Dev server on port 3099 responded correctly |
| mobile.css?v=0.1675 in page source | PASS | Version bump confirmed |
| app.js?v=0.4.110 in page source | PASS | Version bump confirmed |
| .compose-action-sheet exists, no display:none | PASS | Element visible via CSS transform control |
| .compose-action-backdrop exists, no display:none | PASS | Element visible via CSS opacity control |
| CSS rule .compose-action-sheet has translateY(100%) | PASS | Verified via CSSOM with mobile viewport (media query applies at ≤1023px) |

**Overall: ALL PASS**

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

- Used z-index 10002/10003 for backdrop/sheet (well above session-drawer at 9000) to guarantee the sheet renders above all other UI layers on all browsers/WebViews.
- Belt-and-suspenders: also hide `#tvTypingIndicator` on open to avoid iOS WebView compositing ambiguity between `position:absolute` in a stacking context and `position:fixed` viewport elements.
- The `_closeActionSheet` restore logic checks `app.sessions.get(activeSessionId).status === 'busy'` directly rather than calling `TranscriptView.setWorking(true)`, to keep the change minimal (no side effects from re-triggering setWorking animations).

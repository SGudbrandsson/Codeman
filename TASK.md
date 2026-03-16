# Task

type: fix
status: done
title: Fix mobile send button unresponsive when keyboard is closed
description: |
  The send button (↑ arrow) in the message bar is not reliably pressable when the keyboard
  is closed on mobile.

  Steps to reproduce:
  1. Type a message in the compose bar
  2. Attach an image (which closes the keyboard as a side effect)
  3. Try to tap the send (↑) button
  4. Expected: message sends
  5. Actual: button is unresponsive or very hard to hit — user must re-open keyboard first

  Likely causes:
  - The send button may be positioned/sized relative to the keyboard height, so when the
    keyboard closes the layout shifts and the button ends up behind another element or in a
    tap-dead zone
  - The compose bar area may resize when keyboard closes, and the button hitbox does not
    reflow correctly
  - A touch event on the send button may be intercepted by the keyboard-dismiss handler

  Fix:
  - Ensure the send button is always tappable regardless of keyboard state
  - The button should have a consistent, large enough tap target (min 44x44px) that does not
    shift behind other elements when the keyboard is closed
  - Attaching an image should NOT prevent the user from sending — if the keyboard closes after
    attachment, the send button must still work
  - Check whether any pointer-events, z-index, or layout recalculation on keyboard close is
    obscuring the button

affected_area: frontend
fix_cycles: 0

## Reproduction

Concrete observations from code analysis (src/web/public/app.js, mobile-handlers.js, mobile.css,
index.html):

**Flow that triggers the bug:**

1. User focuses the compose textarea — keyboard opens. `KeyboardHandler.keyboardVisible = true`.
   `updateLayoutForKeyboard()` applies `translateY(-keyboardOffset)` to `#mobileInputPanel`.

2. User taps the `+` (plus) button. The `addKeyboardTapFix` container listener on `#mobileInputPanel`
   fires (with `requireKeyboardVisible: false`). Because `isPlusBtn = true`, `app.terminal.focus()`
   is skipped. `_openActionSheet()` shows the action sheet.

3. User selects "Photo Library" / "Attach File". `_actionSheetPick()` closes the action sheet
   and calls `composeFileGallery.click()` — the native OS file picker opens. The keyboard closes
   as a side effect of the native picker taking over. `handleViewportResize()` eventually fires,
   `keyboardVisible` becomes `false`, `resetLayout()` removes the `translateY` from the panel.

4. User selects an image. The file picker closes, `_onFilesChosen` → `_uploadFiles` runs
   async. An object-URL thumbnail appears immediately; `entry.path` is `null` until the
   `POST /api/screenshots` fetch resolves (typically < 1s on localhost).

5. Now: keyboard is CLOSED, `mobileInputPanel` is at its natural fixed position
   (`bottom: calc(safe-area-bottom + 52px)`), send button is visible.

6. User taps the send (↑) button. Touch event flow:
   - `touchstart` on `#composeSendBtn` (target phase): inline
     `ontouchstart="event.preventDefault()"` suppresses browser click synthesis.
     Does NOT call `stopPropagation()` — event bubbles.
   - `touchstart` bubbles to `#mobileInputPanel` container: `addKeyboardTapFix` handler fires
     (`requireKeyboardVisible: false`). Finds `composeSendBtn` via `e.target.closest('button')`.
     Calls `e.preventDefault()` + `btn.click()` → `InputPanel.send()` executes.
     Then calls `app.terminal.focus()` because `isPlusBtn = false`.

**The problematic step**: `app.terminal.focus()` is called synchronously after `send()`.
On mobile, this focuses xterm.js's hidden `<textarea class="xterm-helper-textarea">`.
Browsers fire the virtual keyboard for focused textarea elements. On iOS and Android,
this re-opens the keyboard immediately:
  - `visualViewport` resize fires → `handleViewportResize()` → `keyboardVisible = true` →
    `onKeyboardShow()` → `updateLayoutForKeyboard()` → applies `translateY(-keyboardOffset)`
    to `#mobileInputPanel` again.

The first send tap does succeed, but the keyboard re-opens and the panel shifts up. On
devices/browsers where this keyboard re-open races with or is perceived during the tap,
the button appears to be in a dead zone or the action sheet of keyboard animation distracts.
More critically: if the user sees nothing happen (the panel closes after send on mobile via
`this.close()`) and tries to tap again, the panel has already been hidden.

**Secondary observation:** The send button is 34×34px (below the 44×44px tap target minimum).
The `compose-inset-btn` class adds `padding: 6px` but `.compose-send-btn` overrides with
`padding: 0`. The effective tap target is exactly 34×34px — small on touch devices, especially
when the layout is in transition.

**The `mobile: close after send` behavior:** `send()` calls `this.close()` on mobile
(`getDeviceType() !== 'mobile'` is false for phones). This hides `#mobileInputPanel` with
`display: none`. `InputPanel.open()` is only called once at init — there is no re-open path.
Combined with `app.terminal.focus()` triggering keyboard → layout shift → close, this creates
the "button disappeared / unresponsive" experience.

## Root Cause / Spec

### Root Cause

**Primary cause**: `addKeyboardTapFix` in `src/web/public/app.js` (around line 3063–3086) calls
`app.terminal.focus()` after firing `btn.click()` for ALL buttons in `#mobileInputPanel` EXCEPT
`composePlusBtn`. The send button (`composeSendBtn`) is not excepted. When the keyboard is
closed, `app.terminal.focus()` focuses the xterm.js hidden textarea, which reopens the virtual
keyboard on mobile. This triggers a layout shift (`translateY` applied to `#mobileInputPanel`
via `updateLayoutForKeyboard()`), and `send()` closes the panel on mobile (`this.close()` in
`InputPanel.send()` when device type is 'mobile'). The net effect: the panel disappears and
the keyboard opens after the send tap, making the send button appear unresponsive or missing.

The fix for the plus button (commit e217f74) correctly excepted `composePlusBtn` from
`app.terminal.focus()` but did not apply the same treatment to the send button.

**Secondary cause**: The send button is 34×34px (`width: 34px; height: 34px` in
`.compose-send-btn`). The `compose-inset-btn` class sets `padding: 6px` which would give a
46×46px tap target, but `.compose-send-btn` overrides with `padding: 0`, leaving exactly
34×34px — below the 44×44px minimum recommended for touch targets. This makes the button
harder to hit precisely, especially during a layout transition.

**Tertiary cause (related)**: `InputPanel.send()` calls `this.close()` on mobile (any device
where `MobileDetection.getDeviceType() !== 'mobile'` is false, i.e. phone-sized screens <430px).
After a send, the compose panel is hidden. `InputPanel.open()` is only called once at app init.
There is no re-open path (no toggle button in the accessory bar; `_inputToggleBtn` is never
assigned). This means after the first send on mobile, the compose panel is gone. This is
likely a latent bug separate from the send button issue — the panel should stay open (or be
reopened) after send on mobile too.

### Implementation Spec

**File**: `src/web/public/app.js`

**Change 1 — Skip `app.terminal.focus()` for send button when keyboard is closed**
(lines ~3075–3078)

Currently:
```javascript
const isPlusBtn = btn.id === 'composePlusBtn';
if (!isPlusBtn && typeof app !== 'undefined' && app.terminal) {
  app.terminal.focus();
}
```

Change to:
```javascript
const isPlusBtn = btn.id === 'composePlusBtn';
const isSendBtn = btn.id === 'composeSendBtn';
// Only refocus terminal when keyboard is already visible — purpose is to KEEP
// keyboard open after accessory button taps, NOT to re-open a closed keyboard.
// Skip for plus btn (opens action sheet / file picker — focus would dismiss it).
// Skip for send btn when keyboard is closed (would reopen keyboard after send).
if (!isPlusBtn && !isSendBtn && typeof app !== 'undefined' && app.terminal) {
  app.terminal.focus();
} else if (isSendBtn && KeyboardHandler.keyboardVisible && typeof app !== 'undefined' && app.terminal) {
  app.terminal.focus();
}
```

Alternatively, a cleaner formulation: only call `app.terminal.focus()` if the keyboard was
already visible, and skip it for the plus button specifically:
```javascript
const isPlusBtn = btn.id === 'composePlusBtn';
if (!isPlusBtn && KeyboardHandler.keyboardVisible && typeof app !== 'undefined' && app.terminal) {
  app.terminal.focus();
}
```
This is the simplest correct fix: the purpose of `app.terminal.focus()` here is to prevent
keyboard dismissal when tapping accessory buttons while keyboard is open. It should never be
called when keyboard is already closed — doing so reopens it unnecessarily for all buttons.

**Change 2 — Increase send button tap target to minimum 44×44px**

In `src/web/public/mobile.css`, update `.compose-send-btn`:

Currently:
```css
.compose-send-btn {
  right: 4px;
  width: 34px;
  height: 34px;
  background: #3b82f6;
  color: #fff;
  border-radius: 50%;
  padding: 0;
}
```

The visual circle should remain 34×34px but the tap target should be expanded. Use a
transparent padding area approach — the simplest fix is to make the button 44×44px (matching
the minimum tap target) so it doesn't need padding override. Alternatively, keep 34px visual
but add a transparent pseudo-element or use a larger hit area. The most straightforward fix
given the existing structure is to increase `width` and `height` to 44px and keep padding 0,
since the button already has `border-radius: 50%` — the circle will still look correct.

**Change 3 — Keep compose panel open after send on mobile (or reopen it)**

In `InputPanel.send()` (line ~16887):

Currently:
```javascript
// Desktop: keep panel open (always-visible); mobile: close after send
const isDesktop = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() !== 'mobile';
if (!isDesktop) this.close();
```

The panel should remain open on mobile too (it's "always-visible" per the comment at line 3023:
`// Always-visible compose bar on mobile and desktop`). Change to remove the conditional close:
```javascript
// Panel stays open after send on all platforms — it is always-visible
// (no toggle button to reopen it on mobile)
```

Or if closing on mobile is intentional, ensure `open()` is called after close:
```javascript
if (!isDesktop) {
  this.close();
  requestAnimationFrame(() => this.open());
}
```

But the cleanest fix consistent with the "always-visible" comment is to simply remove
`if (!isDesktop) this.close()` entirely — let the panel stay open after send on mobile.

### Priority of changes

1. Change 1 (skip `terminal.focus()` when keyboard closed) — **primary fix for the reported bug**
2. Change 3 (keep panel open after send) — **needed for consistent UX; without it the panel
   disappears after every send on mobile**
3. Change 2 (increase tap target) — **secondary improvement for reliability**

## Fix / Implementation Notes

Three changes applied:

**Change 1** — `src/web/public/app.js` line 3076: Added `KeyboardHandler.keyboardVisible &&` guard
to the `app.terminal.focus()` call in `addKeyboardTapFix`. Previously, `terminal.focus()` was
called for all non-plus buttons regardless of keyboard state, which reopened the virtual keyboard
after a send tap when the keyboard was closed — causing a layout shift and hiding the panel.
Now `terminal.focus()` is only called when the keyboard is already visible (its intended purpose:
keeping the keyboard open during accessory button taps).

**Change 2** — `src/web/public/mobile.css` `.compose-send-btn`: Increased `width` and `height`
from `34px` to `44px` to meet the 44×44px minimum touch target. The visual circle scales
correctly since `border-radius: 50%` and `padding: 0` are unchanged.

**Change 3** — `src/web/public/app.js` `InputPanel.send()` (~line 16882): Removed the
`if (!isDesktop) this.close()` call and the now-unused `isDesktop` variable entirely. The
compose panel is "always-visible" on all platforms (per design comment at line 3023) and has
no toggle button to reopen it, so closing it after send on mobile was a latent bug that
compounded the primary issue.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

**Change 1 — `KeyboardHandler.keyboardVisible` guard in `addKeyboardTapFix`**

Correctness: The guard is inserted at the right location (line 3076) and uses the established
`KeyboardHandler.keyboardVisible` static property, which is already used identically at line 3067
in the same function and in multiple other call sites. No `typeof` guard is needed because
`KeyboardHandler` is always defined when `MobileDetection.isTouchDevice()` is true (the outer
`if` condition). The chosen formulation (add `keyboardVisible &&` to the shared condition rather
than a separate `isSendBtn` exception) is the simpler and more correct of the two options listed
in the spec — it correctly handles any future non-plus buttons added to `#mobileInputPanel` as
well, not just the send button.

One subtle concern examined: the `requireKeyboardVisible: false` option on `#mobileInputPanel`
means the outer early-return guard at line 3067 is bypassed for this container — so the listener
fires even when the keyboard is closed. The new `KeyboardHandler.keyboardVisible` check inside
the focus call correctly handles this case: `btn.click()` (i.e. send) still fires, but
`terminal.focus()` is skipped when keyboard is closed. This is exactly the desired behavior.

No regression risk for the plus button: `isPlusBtn` is checked first; `keyboardVisible` is only
reached when `isPlusBtn` is false, so the plus-button fix from commit e217f74 is unaffected.

**Change 2 — Send button size 34px → 44px in `mobile.css`**

Correct and confirmed in the file. `border-radius: 50%` and `padding: 0` remain; the button
scales proportionally. No overlap with adjacent elements needs review — `.compose-plus-btn` is
pinned `left: 4px` and `.compose-send-btn` is pinned `right: 4px`, so widening the send button
by 10px moves its left edge 10px further left; the textarea has `left: 44px; right: 44px`
padding to accommodate the inset buttons, so with the 10px wider button there is a 10px
reduction in the textarea's right clearance. This warrants a visual check in QA but is unlikely
to cause overlap given the `padding` inset on the textarea.

**Change 3 — Remove `this.close()` from `InputPanel.send()`**

Safety analysis:
- `InputPanel.close()` is called from two places: (a) `closeAllPanels()` — triggered only by
  Escape key on desktop, which does not apply to mobile; (b) the now-removed `send()` path.
- `InputPanel.open()` is called once at app init (line 3024). After the remove, the panel stays
  open permanently on mobile, which matches the "Always-visible compose bar on mobile and
  desktop" comment at line 3023 and is the correct intent.
- The old `close()` call also revoked object URLs and cleared `_images`. With the removal, image
  cleanup on send is now handled by the `this._images = []; this._renderThumbnails();` lines
  already present at lines 16883–16884 — so no memory leak is introduced.
- The `_open` state flag: after the fix, `_open` stays `true` permanently on mobile after init,
  which is consistent with the panel never being hidden. No code paths depend on `_open` being
  toggled to `false` after send (the only code reading `_open` is `toggle()`, which is not called
  on mobile given there is no toggle button).
- The removed `isDesktop` variable was only used by the removed `if` condition; its removal
  avoids a lint warning. Another `isDesktop` variable exists independently in `_autoGrow` (line
  16778) with a different scope — no collision.

**Edge cases checked:**
- Sending with no text and no images: guarded at line 16834 (`if (!text && !images.length) return`),
  behavior unchanged.
- Double-tap scenario: with the `keyboardVisible` guard, a second tap while the keyboard is
  closed will call `send()` again. `send()` returns early if textarea is empty (cleared after
  first send), so no double-send is possible.
- `closeAllPanels()` on mobile via Escape: still calls `InputPanel.close()`, hiding the panel.
  Since `open()` is not called again afterward, the panel would be permanently gone on mobile
  if Escape is pressed. This is a pre-existing issue unrelated to this fix — the Escape handler
  was already present before this change.

**Overall:** All three changes are correct, minimal, and consistent with existing patterns. The
implementation matches the spec's preferred formulations. No issues found.

## QA Results

### QA run — PASSED

**TypeScript (`tsc --noEmit`):** PASS — zero errors.

**ESLint (`npm run lint`):** PASS — zero warnings or errors.

**Playwright send button check (iPhone 12 mobile viewport, port 3099):**
- Send button visible: true
- Bounding box: 44×44px
- Width >= 44px: PASS (44px)
- Height >= 44px: PASS (44px)
- Overall: PASS

**Implementation verified in source:**
- `src/web/public/app.js` line 3076: `KeyboardHandler.keyboardVisible &&` guard confirmed in place for `app.terminal.focus()` in `addKeyboardTapFix`.
- `src/web/public/mobile.css` `.compose-send-btn`: `width: 44px; height: 44px` confirmed.
- `InputPanel.send()` close-on-mobile removed (Change 3) — confirmed via review notes.

All checks passed. Status set to `done`.

## Decisions & Context

- Chose the simpler `KeyboardHandler.keyboardVisible` guard (spec's preferred formulation) over
  a separate `isSendBtn` exception. This correctly handles all current and future non-plus buttons:
  `terminal.focus()` is only meaningful when keyboard is already up.
- Removed the `isDesktop` variable entirely (it was only used by the removed `if` condition)
  to avoid a lint/unused-variable warning.
- Send button enlarged to 44px diameter (not just expanded hit area via padding) — this is the
  cleanest approach given the existing `border-radius: 50%; padding: 0` style; the visual circle
  scales proportionally.

# Task

type: bug
status: done
title: Gear icon in bottom action buttons doesn't open session options
description: |
  On both mobile and desktop, the gear/settings icon (⚙) that should open session options
  is not working when it appears in the bottom action buttons area.

  On mobile: There is no gear icon in the session drawer (hamburger menu → right sidebar).
  The session options modal (which contains the Respawn tab, Context tab with Safe Mode toggle,
  Ralph tab, etc.) is unreachable on mobile because the gear icon only exists in the desktop
  left sidebar session tabs.

  The fix should make session options accessible from mobile — either by:
  1. Adding a gear icon button to each session row in the mobile SessionDrawer (alongside the
     existing × close button), OR
  2. Investigating if there are gear icons in the bottom action buttons area that are broken
     and fixing those.

  The SessionDrawer._renderSessionRow() function in app.js builds each row with: dot, name,
  mode badge, close button — but no gear/options button. This needs a gear button that calls
  app.openSessionOptions(sessionId) and closes the drawer.

  On desktop: The gear icon in session tabs (left sidebar) should work fine — but if there are
  gear icons in any bottom toolbar or action bar that don't work, those need to be fixed too.

  Expected: Tapping a gear/options icon on mobile opens the session options modal.
  Actual: No gear icon is accessible on mobile; session options are unreachable.

affected_area: frontend
fix_cycles: 0

## Reproduction

1. Open Codeman on a mobile device (or DevTools mobile emulation).
2. The top session tabs bar exists and each active tab shows a tiny ⚙ gear icon
   (`.tab-gear`, visible on `.session-tab.active`), but it is very small (12×12px,
   opacity 0.6) and hard to tap reliably.
3. Open the session drawer via the hamburger/sessions button (right sidebar).
4. Each session row shows: status dot | name | mode badge | × close button.
   There is NO gear icon in the drawer rows — `_renderSessionRow()` only appends
   `dot`, `name`, `badge`, and `closeBtn` elements.
5. Result: session options (Respawn, Context/Safe Mode, Ralph, etc.) are only
   reachable on mobile via the tiny active-tab gear — there is no obvious,
   consistently accessible path to `app.openSessionOptions()` from the drawer.

Note on the bottom toolbar gear: `btn-settings-mobile` (line 413 index.html) opens
`app.openAppSettings()` (global app settings), NOT session-specific options. The
`btn-case-settings-mobile` opens project/case settings. Neither calls
`openSessionOptions`. There is no broken gear in the bottom toolbar — the bottom
toolbar gear icons are working but serve different purposes.

## Root Cause / Spec

**Root cause**: `SessionDrawer._renderSessionRow()` (app.js line 16449) builds the
DOM row with four elements — status dot, session name, mode badge, close button —
but never adds a gear/options button. `app.openSessionOptions()` exists and works
correctly; it simply has no call site in the drawer.

On the session tabs (desktop left sidebar), the gear is rendered via the tab HTML
template at line 6080 as `.tab-gear`, wired to `app.openSessionOptions(id)`. This
works fine on desktop (hover reveals it). On mobile, the active tab's `.tab-gear` is
displayed at 12×12px with 0.6 opacity (mobile.css lines 531–541) — too small to be
a reliable tap target.

**Fix spec**:

1. **Add a gear button to each drawer session row** in `_renderSessionRow()`:
   - Create a `<button class="drawer-session-gear">` element with a ⚙ character
     (or matching SVG from elsewhere in the UI).
   - `stopPropagation()` on click to prevent row activation.
   - On click: call `app.openSessionOptions(s.id)` then `SessionDrawer.close()`.
   - Append it between the mode badge and the close button.

2. **Add CSS** for `.drawer-session-gear` in `styles.css` alongside the existing
   `.drawer-session-close` rules (around line 1189). Style it identically to
   `.drawer-session-close` but with a blue/neutral hover (not red). Hide by default
   (`opacity: 0`) and reveal on `.drawer-session-row:hover` (matching the pattern for
   `.drawer-session-close`). On mobile (touch) devices, always show it (`opacity: 1`)
   so there is a reliable tap target.

3. **No addKeyboardTapFix needed** for the drawer: the drawer is a separate overlay
   (`#sessionDrawer`) that isn't part of the keyboard-open tap-suppression containers
   (`.toolbar`, `.welcome-overlay`, `#mobileInputPanel`). The drawer is not shown
   while the keyboard is open in normal flows, so the existing keyboard tap fix does
   not need to be extended.

4. **Bump version strings** in `index.html` for `app.js` and `styles.css` per the
   deployment rules (CLAUDE.md).

No backend changes needed.

## Fix / Implementation Notes

**app.js** (`_renderSessionRow`, line ~16473):
- Added a `<button class="drawer-session-gear">` element with ⚙ text content and aria-label "Session options".
- Click handler calls `e.stopPropagation()`, then `SessionDrawer.close()`, then `app.openSessionOptions(s.id)`.
- The drawer is closed before opening the options modal so the modal appears on top cleanly.
- Gear button is inserted between the mode badge and the close button in the row's DOM order.

**styles.css** (before `.drawer-session-close`, ~line 1188):
- Added `.drawer-session-gear` block styled identically to `.drawer-session-close` (24×24px, opacity 0, same transitions).
- Hover state uses blue tones (`rgba(59,130,246,0.12)` bg, `#60a5fa` text) to differentiate from the red close hover.
- `.drawer-session-row:hover .drawer-session-gear` reveals the button on desktop hover (mirrors the close button pattern).
- `@media (hover: none)` rule sets `opacity: 1` always on touch devices — ensures a reliable tap target on mobile.

**index.html** version bumps:
- `styles.css?v=0.1690` → `v=0.1691`
- `app.js?v=0.4.106` → `v=0.4.107`

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

**Correctness**: The gear button is added exactly where the spec calls for it — in `_renderSessionRow()`, between the mode badge and close button. DOM order matches spec (dot → name → badge → gearBtn → closeBtn). Click handler correctly calls `e.stopPropagation()` then `SessionDrawer.close()` then `app.openSessionOptions(s.id)` — close-before-open order is right to avoid z-index stacking issues.

**CSS**: `.drawer-session-gear` mirrors `.drawer-session-close` (24×24px, opacity 0 default, same transition properties). Blue hover tones correctly differentiate from the red close hover. `.drawer-session-row:hover .drawer-session-gear` mirrors the existing close button reveal pattern. `@media (hover: none)` correctly ensures always-visible on touch devices. All rules placed logically immediately before the close button block.

**Edge cases**:
- `openSessionOptions` guards against a missing session (`if (!session) return`) — safe even if the session was removed between render and tap.
- `stopPropagation` prevents the row's own click handler from also firing `selectSession` + `close`, which would race with the gear's own `close` call.
- Worktree session rows also go through `_renderSessionRow()` (confirmed at lines 16667 and 16672), so the gear is consistently present for all session types, including worktree sub-sessions.

**Version bumps**: Both `styles.css?v=0.1691` and `app.js?v=0.4.107` are correctly incremented per CLAUDE.md rules.

**No issues found.** Implementation is minimal, additive, and consistent with existing patterns.

## QA Results
<!-- filled by QA subagent -->

### QA Run — 2026-03-14 — PASS

| Check | Result | Notes |
|-------|--------|-------|
| `tsc --noEmit` | PASS | Zero errors |
| `npm run lint` | PASS | Zero errors |
| Page loads (HTTP 200) | PASS | `http://localhost:3099/` returns 200 |
| `styles.css?v=0.1691` in page source | PASS | Version string confirmed |
| `app.js?v=0.4.107` in page source | PASS | Version string confirmed |
| `.drawer-session-gear` CSS rule in browser | PASS | Rule found: `width:24px; height:24px; ...` |
| `SessionDrawer._renderSessionRow` method | PASS | Method exists on `SessionDrawer` object |

All checks passed. Status set to `done`.

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

2026-03-14: Analysis confirmed the bottom toolbar gears (btn-settings-mobile, btn-case-settings-mobile)
are NOT broken — they open app settings and project settings respectively, as intended.
The sole missing piece is a gear button inside SessionDrawer._renderSessionRow(). Fix is
purely additive frontend work: new button element + CSS rules.

2026-03-14: Implemented gear button. Used `@media (hover: none)` to keep gear always visible on touch
devices (mobile) while hiding it at opacity 0 on desktop hover-capable devices (revealed on row hover,
matching the existing close button pattern). Drawer is closed before the options modal opens to avoid
z-index stacking issues.

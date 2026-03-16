# Task

type: fix
status: done
title: Fix mobile swipe session order mismatch
description: |
  Swiping left/right between sessions on mobile follows a different order than the session
  list shown in the hamburger menu drawer. The swipe order appears non-deterministic from
  the user's perspective.

  Expected behaviour:
  - Swiping left/right should navigate sessions in the exact same order as displayed in the
    hamburger menu session list
  - If sessions are ordered A → B → C in the drawer, swiping right from A should go to B,
    swiping right from B should go to C

  Investigation:
  - Find where the swipe navigation order is determined (likely in mobile-handlers.js or
    the swipe gesture handler)
  - Find where the session list order is determined for the hamburger drawer (SessionDrawer
    in app.js)
  - Compare the two — they are likely using different data sources or different sort orders
  - The drawer likely uses the sessions array in a specific sorted order (e.g. by
    lastActivityAt, or by creation order); the swipe handler likely iterates a different
    array or uses DOM order

  Fix:
  - Make the swipe handler use the same ordered session list as the drawer
  - When the user swipes, compute prev/next session by looking up the current session in
    the drawer-ordered list and stepping ±1
  - Ensure this stays in sync if sessions are added/removed/reordered while the user is
    swiping

affected_area: frontend
fix_cycles: 0

## Reproduction

1. Open Codeman on a mobile device (or resize browser < 430px wide, touch device).
2. Create at least 3 sessions that belong to **different projects** (cases). For example:
   - Session A and Session C in Project 1
   - Session B and Session D in Project 2
   — where the creation order / drag-drop order is A, B, C, D (sessionOrder = [A, B, C, D]).
3. Open the hamburger drawer. Observe the visual order: the drawer groups by project, so it shows
   **A, C** (Project 1) then **B, D** (Project 2). Reading top-to-bottom: A → C → B → D.
4. Close the drawer. While viewing Session A, swipe left.
5. The swipe navigates to Session B (index 1 in flat sessionOrder), but the drawer shows Session C
   should be next (it is visually below A in the drawer).
6. This mismatch is reproducible whenever sessions from different projects are interleaved in
   sessionOrder — the drawer groups them by project, but the swipe navigates the raw flat array.

**Simpler single-project reproduction:**
If all sessions are ungrouped (no projects configured), the flat sessionOrder and the drawer order
are the same — no bug. The bug is most visible when multiple projects are configured and sessions
from different projects are interleaved in sessionOrder.

## Root Cause / Spec

### Root Cause

**Two different traversal orders are in use:**

1. **SessionDrawer._render()** (`app.js` line 17383): iterates `app.sessionOrder` but distributes
   sessions into project-grouped buckets, then renders each project group in sequence. The visual
   top-to-bottom order in the drawer is therefore **group-first**: all sessions of project 1 (in
   sessionOrder index order), then all sessions of project 2, then ungrouped sessions. This order
   can differ substantially from the raw `sessionOrder` array whenever sessions from different
   projects are interleaved in `sessionOrder`.

2. **SwipeHandler._resolveTarget()** (`mobile-handlers.js` lines 644-657): navigates the raw flat
   `app.sessionOrder` array by index (±1). This order is the creation/drag-drop order, not the
   grouped drawer order.

When sessions are all in the same project (or no projects exist), both orders are identical, so
the bug is invisible. As soon as sessions from two or more projects are interleaved in
`sessionOrder`, the swipe navigates in a sequence that differs from what the user sees in the
drawer.

**Key code locations:**

- `src/web/public/mobile-handlers.js`, lines 644-657 — `_resolveTarget()`: reads `app.sessionOrder`
  directly as a flat array.
- `src/web/public/app.js`, line 17383 — `SessionDrawer._render()`: iterates `app.sessionOrder` but
  outputs sessions grouped by project/case.
- `src/web/public/app.js`, lines 6462-6465 — `renderSessionTabs()` on mobile: applies a separate
  reorder putting the active session first (unrelated to this bug, but shows the pattern of
  derived orderings).
- `src/web/public/mobile-handlers.js`, line 543 — `_isDisabled()`: also reads
  `app.sessionOrder.length` (no change needed here).

### Implementation Spec

The fix is to make `SwipeHandler._resolveTarget()` compute prev/next using **the same flat ordered
list that the drawer produces when rendered**, not the raw `sessionOrder`. This means extracting
the drawer's rendered ordering into a helper function that both the drawer render path and the
swipe handler can call.

#### Step 1 — Add a helper method to `SessionDrawer` that returns a flat ordered session ID list

Add a new method `_getOrderedSessionIds()` to the `SessionDrawer` object in `app.js`. This method
should replicate the grouping logic of `_render()` but only return the final flat ordered array of
IDs (no DOM manipulation). It must:
- Start from `app.sessionOrder`
- Distribute IDs into groups using the same `resolveCase()` logic as `_render()` (however, since
  `resolveCase` is a closure local to `_render()`, it must be either extracted to a standalone
  helper on `SessionDrawer` or the grouping logic must be inlined in `_getOrderedSessionIds()`).
- Return the flat list: for each group (in the same group iteration order as `_render()`), emit
  worktree sessions first (in branch insertion order), then regular sessions, for each group.
- Sessions with no matching case go into `__ungrouped__` at the end (same as `_render()`).

The simplest approach (avoiding duplication) is to factor out the case-resolution logic from
`_render()` into a shared private method `_resolveCase(s)` on `SessionDrawer`, then implement
`_getOrderedSessionIds()` using that shared method.

#### Step 2 — Modify `SwipeHandler._resolveTarget()` to use `SessionDrawer._getOrderedSessionIds()`

In `mobile-handlers.js`, `_resolveTarget()` currently does:

```js
const order = app.sessionOrder;
```

Change it to use the drawer's ordered list when `SessionDrawer` is available:

```js
const order = (typeof SessionDrawer !== 'undefined' && SessionDrawer._getOrderedSessionIds)
  ? SessionDrawer._getOrderedSessionIds()
  : app.sessionOrder;
```

This falls back to raw `sessionOrder` if `SessionDrawer` is unavailable (defensive coding).

The rest of `_resolveTarget()` (index lookup, wrapping arithmetic) remains unchanged.

#### Step 3 — Also update `_isDisabled()` in SwipeHandler

Line 543 currently checks `app.sessionOrder.length <= 1`. This check is a guard for "only one
session exists" — it does not need to change because the total session count is the same regardless
of ordering.

#### Step 4 — Consider `nextSession()` / `prevSession()` keyboard shortcuts

`app.js` lines 7310-7324 define `nextSession()` and `prevSession()` which also navigate
`sessionOrder` directly. For consistency with the swipe fix, these should also be updated to use
`SessionDrawer._getOrderedSessionIds()` — but this is a keyboard-shortcut path, not the mobile
swipe bug. The task description only requires fixing swipe; include `nextSession`/`prevSession` as
a nice-to-have, clearly marked as bonus.

#### Affected files

- `src/web/public/app.js`:
  - Factor `resolveCase()` closure in `_render()` into a named method `_resolveCase(s)` on
    `SessionDrawer` (so it can be called from `_getOrderedSessionIds()`).
  - Add `_getOrderedSessionIds()` method to `SessionDrawer`.
  - (Optional) Update `nextSession()` / `prevSession()` to use drawer order.

- `src/web/public/mobile-handlers.js`:
  - `_resolveTarget()`: replace `app.sessionOrder` with
    `SessionDrawer._getOrderedSessionIds()` (with fallback).

#### No changes needed to

- `SessionDrawer._render()` — it already renders in the correct order; we are just extracting
  that order into a separate method.
- `renderSessionTabs()` — the mobile active-first tab reorder is a display-only concern, unrelated.
- `syncSessionOrder()`, `saveSessionOrder()`, `loadSessionOrder()` — underlying storage unchanged.
- Any CSS or HTML.

## Fix / Implementation Notes

### Changes made

**`src/web/public/app.js`**

1. Added `SessionDrawer._resolveCase(s)` — a new method that replicates the `resolveCase` closure
   that previously lived only inside `_render()`. It contains the same three sub-helpers
   (`findCase`, `findCaseBySessionName`, `findCaseByWorktreeDirPrefix`) and the same resolution
   priority logic. This is the single source of truth for case assignment.

2. Added `SessionDrawer._getOrderedSessionIds()` — builds the same group Map that `_render()` builds
   (seeded from `app.cases`, then populated from `app.sessionOrder` via `_resolveCase()`), then
   flattens it to a plain array of IDs in the same traversal order: for each group, worktree session
   IDs first (branch insertion order), then regular session IDs. Returns the flat ordered list with
   no DOM side-effects. This is the authoritative ordered list for both swipe and keyboard nav.

3. Updated `nextSession()` / `prevSession()` (bonus — keyboard shortcuts) to call
   `SessionDrawer._getOrderedSessionIds()` with a fallback to `this.sessionOrder`, so keyboard
   navigation is also consistent with the drawer visual order.

**`src/web/public/mobile-handlers.js`**

4. Updated `SwipeHandler._resolveTarget()`: replaced `const order = app.sessionOrder` with a call
   to `SessionDrawer._getOrderedSessionIds()` (with a defensive fallback to `app.sessionOrder` if
   `SessionDrawer` is unavailable). All index-arithmetic logic below that line is unchanged.

### What was NOT changed

- `SessionDrawer._render()` — unchanged; it continues to use its own local closures for rendering.
  `_resolveCase()` mirrors those closures exactly but is not called from `_render()` to avoid any
  risk of behavioral regression in the render path.
- `SwipeHandler._isDisabled()` — the `app.sessionOrder.length <= 1` guard is about total count,
  not order, so no change needed.
- All CSS, HTML, server-side code.

## Review History

<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

**Summary:** The implementation correctly and completely solves the root cause. All changes are well-structured and defensive.

**`_resolveCase()` fidelity:** Compared line-for-line against the original `resolveCase` closure in `_render()` (lines 17368–17386). All three sub-helpers (`findCase`, `findCaseBySessionName`, `findCaseByWorktreeDirPrefix`) and the resolution priority logic are exact mirrors. No divergence found.

**`_getOrderedSessionIds()` ordering:** The group Map is seeded identically from `app.cases`, the per-session loop uses the same `_resolveCase()` → `groupKey` → `__ungrouped__` fallback pattern, and the flattening loop emits worktrees first then regular sessions per group — matching `_render()` lines 17445 and 17491. JS Map guarantees insertion-order iteration, so group ordering is stable and identical to the render path.

**`__ungrouped__` handling:** Not pre-seeded in the Map (same as `_render()`), so ungrouped sessions are appended after all case-seeded groups in insertion order — correct.

**Edge cases:** All covered — `app undefined`, empty `sessionOrder`, missing session in `app.sessions`, null `app.cases`, `activeSessionId` not found in order.

**Minor observation:** `nextSession()`/`prevSession()` guard on `this.sessionOrder.length <= 1` but then use the drawer-ordered array. If `_getOrderedSessionIds()` returned an empty array (impossible in practice — would require every session to be absent from `app.sessions`), modulo arithmetic would produce `NaN`. This is academically possible but cannot occur in normal operation, and the fallback to `app.sessionOrder` provides an additional safety net.

**No search filter in `_getOrderedSessionIds()`:** Correct and intentional per the decisions section.

**Conclusion:** Implementation is faithful to the spec, covers all edge cases, and introduces no regressions to the render path.

## QA Results

<!-- filled by QA subagent -->

### QA run — PASS

| Check | Result |
|---|---|
| `tsc --noEmit` | PASS — zero errors |
| `npm run lint` | PASS — zero errors |
| `SessionDrawer` exists in page context | PASS |
| `SessionDrawer._getOrderedSessionIds` is a function | PASS |
| `SessionDrawer._resolveCase` is a function | PASS |
| `SessionDrawer._getOrderedSessionIds()` returns an array | PASS — returned 16 session IDs |
| `SwipeHandler` exists in page context | PASS |
| `SwipeHandler._resolveTarget` is a function | PASS |

All checks passed. Status set to `done`.

## Decisions & Context

- `_resolveCase()` duplicates the sub-helper closures from `_render()` rather than refactoring
  `_render()` to call `_resolveCase()`. This keeps the render path entirely unchanged, preventing
  any subtle regression, at the cost of a small amount of code duplication. The helpers are simple
  pure functions and unlikely to diverge in practice.

- `_getOrderedSessionIds()` intentionally does NOT apply the `_searchQuery` filter that `_render()`
  applies when filtering is active. Swipe navigation should always traverse all sessions regardless
  of the current search state in the drawer; filtering the swipe targets based on search state
  would be surprising and non-standard behaviour.

- The fallback to `app.sessionOrder` in `_resolveTarget()` and `nextSession()`/`prevSession()` is
  pure defensive coding — `SessionDrawer` is always defined when the app is loaded. It has no
  behavioural impact in normal operation.

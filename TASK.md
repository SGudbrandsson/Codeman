# Task

type: feature
status: done
<<<<<<< HEAD
title: Mobile swipe animation between sessions
description: |
  Add smooth iOS/Android-style horizontal swipe gesture to switch between sessions on mobile.
  Swiping right goes to the previous session; swiping left goes to the next.
  The animation should NOT be jerky — use CSS transform: translateX with momentum easing.
  If the adjacent session is not pre-rendered, show a loading skeleton instead of a blank screen.

  Implementation requirements:
  - Touch event handling: touchstart, touchmove, touchend in mobile-handlers.js
  - Track swipe distance and velocity (for momentum/fling detection)
  - Animate current session sliding out + next session sliding in simultaneously
  - Threshold: commit to switch if swipe > 30% of screen width OR fast fling velocity
  - Cancel animation (spring back) if threshold not met
  - Show skeleton/loading state for the incoming session while xterm initializes
  - Prevent vertical scroll from triggering horizontal swipe
  - Only active on mobile (guard with MobileDetection.isMobile())
  - Session order: follow the order sessions appear in the sidebar
  - Disable swipe when session drawer is open or a modal/panel is visible

constraints: |
  - Must not break existing touch handlers (keyboard accessory bar, compose panel, iOS tap fix)
  - Must not interfere with xterm.js touch/scroll behavior inside the terminal
  - No new npm dependencies — use vanilla CSS transitions
  - Follow existing MobileDetection.isMobile() guard pattern
  - addKeyboardTapFix must still work on all interactive containers post-swipe
  - Swipe should work in portrait and landscape

affected_area: frontend (mobile-handlers.js, app.js, styles.css/mobile.css)
=======
title: Resume previously closed sessions
description: |
  Allow users to resume sessions that were previously closed/removed from the sidebar.

  ## Discovery
  When a session is deleted (DELETE /api/sessions/:id), its state is removed from memory
  but the Claude conversation UUID (claudeResumeId) and JSONL transcript file still exist
  on disk at ~/.claude/projects/<escaped-dir>/*.jsonl.

  Also check: ~/.codeman/session-lifecycle.jsonl for audit log of past sessions.

  ## Feature
  Add a "Resume session" flow:
  1. User opens a "Closed Sessions" section (in the session drawer or a dedicated button)
  2. Shows a list of past sessions discovered from:
     - session-lifecycle.jsonl (has sessionId, workingDir, timestamps)
     - ~/.claude/projects/ scan for JSONL files with their modification dates
  3. Each entry shows:
     - Project / workingDir
     - Last active time
     - Conversation UUID (truncated)
     - Branch name if known
  4. User picks one → Codeman spawns a new session in that workingDir with --resume <uuid>

  ## Implementation
  Backend:
  - New endpoint: GET /api/sessions/history — returns past sessions from lifecycle log + JSONL scan
  - New endpoint: POST /api/sessions/resume { workingDir, resumeId, branch? } — creates session
    with --resume flag pointed at the given conversation UUID

  Frontend:
  - "Resume" button/icon in the session creation area or session drawer header
  - Opens a searchable list (fuzzy search by project name, reuse search UI from feat/search-sessions
    if that lands first, otherwise implement standalone)
  - Shows metadata: project, time ago, UUID snippet
  - "Resume" button per entry → POST to create session → navigate to it

constraints: |
  - Scanning ~/.claude/projects/ should be bounded (cap at 100 entries, most recent first)
  - Must not resurrect sessions that are already active (check against current session list)
  - session-lifecycle.jsonl may be large — read only last N lines (e.g. 500)
  - The new session must use --resume <uuid> so Claude picks up the conversation
  - No new npm dependencies
  - Bump CSS/JS ?v= strings per CLAUDE.md versioning rules

affected_area: backend+frontend
>>>>>>> feat/resume-closed-sessions
fix_cycles: 1

## Root Cause / Spec

<<<<<<< HEAD
### Current State

The existing `SwipeHandler` in `mobile-handlers.js` (lines 458–527) is a minimal gesture detector: it records `touchstart`, then on `touchend` checks if the elapsed time, delta-X, and vertical drift meet fixed thresholds (80px min, 300ms max, 100px max vertical), and then calls `app.prevSession()` or `app.nextSession()`. There is **no animation** — the session switch is instant.

`app.prevSession()` / `app.nextSession()` (lines 6879–6893) look up the adjacent session ID in `app.sessionOrder[]` and call `app.selectSession()`. `selectSession()` is an async function that clears state, hides the current terminal buffer, reloads the new session's buffer from SSE cache, and does a terminal fit/resize. This is the right entry point; we must hook into it without breaking it.

The `<main class="main">` element (single element in `index.html` line 260) contains a single `#terminalContainer` div. There is no concept of multiple rendered session containers — xterm.js is shared and re-used across sessions. This means the animation must be **UI-layer only**: overlay divs (or CSS transforms on `.main`) that simulate the sliding of two sessions, while the actual `selectSession()` call happens at the right moment.

### Constraints Gathered from Code

1. **No `MobileDetection.isMobile()` method exists.** The correct guard pattern, used throughout `app.js`, is `MobileDetection.getDeviceType() === 'mobile'` or `MobileDetection.isTouchDevice()`. The task description says "guard with MobileDetection.isMobile()" but that method does not exist. Use `MobileDetection.isTouchDevice()` (as `SwipeHandler.init()` already does) for the gesture handler.

2. **`terminalContainer` has `will-change: transform` already set** (`styles.css` line 2531) — do not add `will-change` redundantly to the same element; instead use a wrapper or sibling overlay approach.

3. **`terminalContainer.buffer-loading` sets `visibility: hidden`** during buffer loads. The skeleton must not rely on the terminal container being visible during a swipe animation; it needs to be a separate overlay.

4. **`app._isLoadingBuffer`** is the flag that blocks live SSE writes during `selectSession()`. The swipe animation should start before `selectSession()` is called and the transition completes at a predictable time (e.g., 300ms), so the UI never shows a blank screen.

5. **`SwipeHandler` is NOT re-initialized on SSE reconnect** (lines 5695–5698 only call `MobileDetection` and `KeyboardHandler` cleanup/init). The new implementation must be compatible with this — either add `SwipeHandler.cleanup()/init()` to the reconnect block, or make the handler self-contained enough that stale listeners are safe.

6. **Session drawer open check**: use `document.getElementById('sessionDrawer')?.classList.contains('open')`. Panels (McpPanel, PluginsPanel, ContextBar) expose `_panel?.classList.contains('open')`. Active modals use `.modal.active`. Keyboard accessory bar compose panel: `document.getElementById('mobileInputPanel')` open state is managed by `InputPanel`.

7. **xterm.js touch handling**: xterm's canvas element (`#terminalContainer .xterm-screen canvas`) handles its own pointer events. The swipe must be detected on the `.main` element (or a sibling overlay) — NOT on the xterm canvas — to avoid interfering with xterm's internal scroll/selection touch handling. The existing `SwipeHandler` already attaches to `.main`; keep this approach but replace passive `touchend`-only detection with active `touchmove` tracking.

8. **`addKeyboardTapFix`** is applied to `.toolbar`, `.welcome-overlay`, and `#mobileInputPanel` — all containers that may have buttons. The swipe gesture container (`.main`) does not have `addKeyboardTapFix` applied, so no conflict there.

9. **Version bump required**: per CLAUDE.md, `mobile-handlers.js?v=0.4.11` must be bumped to `v=0.4.12`, `mobile.css?v=0.1671` to `v=0.1672`, and if styles.css is changed, `styles.css?v=0.1688` to `v=0.1689`.

### Implementation Plan

#### 1. Animated swipe overlay approach

Since xterm.js is a single shared instance, the animation must be **cosmetic only**. The approach:

- On `touchstart` on `.main`, snapshot the current session's visual state as a screenshot-like layer (a fixed-position overlay div with the terminal's rendered content cloned, or simply a semi-transparent "ghost" layer).
- More practical: instead of cloning canvas (expensive), create **two overlay divs** that slide:
  - `.swipe-current` — absolutely positioned over `.main`, initially at `translateX(0)`, represents the current session sliding out.
  - `.swipe-incoming` — absolutely positioned over `.main`, initially at `translateX(+100%)` (next) or `translateX(-100%)` (prev), represents the incoming session.
- During `touchmove`, translate both divs in real time with `transform: translateX(deltaX + offset)px` — no CSS `transition`, raw JS updates for 60fps feel.
- On `touchend`:
  - If threshold met (>30% screen width or velocity > 0.5px/ms): run commit animation (CSS transition 200ms ease-out to ±100% / 0), then call `app.nextSession()` / `app.prevSession()`, then remove overlays.
  - If threshold not met: spring-back animation (CSS transition 300ms cubic-bezier(0.25, 0.46, 0.45, 0.94) back to 0 / ±100%), then remove overlays.

**Problem**: `.swipe-current` needs to show the current terminal. Since we cannot clone the WebGL canvas, it will be transparent/black unless we use a different approach.

**Better approach — slide the actual `.main` element itself**:

Since `.main` contains everything (terminal, transcript view, overlays), we can:
1. Create a `.swipe-incoming-skeleton` div as a **sibling** to `.main`, absolutely positioned to fill the same space, showing a skeleton or session name pill. It starts offscreen (right or left).
2. During the swipe gesture, apply `transform: translateX` **directly to `.main`** (sliding out) and to `.swipe-incoming-skeleton` (sliding in simultaneously). Both move together.
3. On commit: animate to final positions, then immediately call `selectSession()`. After `selectSession()` completes, remove the skeleton and reset `.main`'s transform to identity (no visible jump because `selectSession` clears and reloads the buffer while main is off-screen or at the final position).
4. On cancel: spring both back to start positions.

This is safe because `.main`'s `paddingBottom` (managed by `KeyboardHandler`) uses inline styles, not transforms — no conflict. The `will-change: transform` on `.terminal-container` is a child of `.main`; sliding `.main` itself will not trigger xterm's compositor layer issues.

**Refined commit sequence**:
1. `touchend` with threshold met → start CSS transition on `.main` (slide to ±viewport width) + skeleton (slide to 0).
2. After transition ends (200–250ms `transitionend` event) → call `selectSession()`. At this moment `.main` is fully off-screen (good — no visual glitch from buffer load).
3. After `selectSession()` resolves: remove skeleton, reset `.main` transform to `translateX(0)` with `transition: none` (instant, since `.main` is already at the new position offscreen, bringing it back to 0 is invisible).

Wait — step 3 has a visual problem: `.main` was translated to `-100vw` (swipe left, next session), but the buffer is now loaded. Setting transform back to `0` with `transition: none` would teleport it back while the new content is already rendered. That's correct and invisible if done in one rAF.

Actually simpler: reset `.main` transform to `translateX(0)` with `transition: none` **before** calling `selectSession()` but **after** the slide-out completes. Then `selectSession()` runs with `.main` back to identity and the skeleton is removed.

**Simplest correct sequence**:
1. Slide `.main` out (transition), slide skeleton in simultaneously.
2. `transitionend` fires → synchronously: reset `.main` `transform: none; transition: none`. Remove skeleton. Call `app.selectSession()`.
3. `selectSession()` runs normally. User sees the new session appear in place.

This avoids any jump because the skeleton was covering `.main` the whole time during step 2, and `.main` is reset before any repaint.

#### 2. Vertical scroll disambiguation

On `touchmove`, track both `deltaX` and `deltaY`. After the first few pixels of movement, lock the gesture as horizontal or vertical:
- If `|deltaY| > |deltaX|` after 10px total movement: cancel swipe (do not slide `.main`), allow native vertical scroll to propagate.
- If `|deltaX| > |deltaY|`: lock as horizontal swipe. Call `e.preventDefault()` on `touchmove` (requires `{ passive: false }` listener) to prevent scroll.

`touchstart` and `touchend` can remain passive; only `touchmove` needs `passive: false`.

#### 3. Disable conditions

Check at `touchstart`:
- `MobileDetection.isTouchDevice()` — only on touch devices.
- `MobileDetection.getDeviceType() === 'mobile'` — only on mobile (not tablet/desktop).
- `app.sessionOrder.length <= 1` — only if there are multiple sessions.
- Session drawer open: `document.getElementById('sessionDrawer')?.classList.contains('open')`.
- Any panel open: `[McpPanel, PluginsPanel, ContextBar].some(p => p._panel?.classList.contains('open'))`.
- Any modal active: `document.querySelector('.modal.active')`.
- `KeyboardHandler.keyboardVisible` — disable swipe while keyboard is up (compose panel is in use).
- `app._isLoadingBuffer` — do not start a new swipe while a buffer load is in progress.

#### 4. Skeleton content

The incoming skeleton div (`.swipe-session-skeleton`) contains:
- Background: `var(--bg-dark)` to match the terminal background.
- A centered pill showing the target session name (from `app.getSessionName(session)`), styled like the session tabs.
- 3–4 horizontal skeleton lines (grey shimmer) to suggest terminal content loading.
- CSS shimmer animation (`@keyframes skeleton-shimmer`) already used in the McpPanel skeleton (`.mcp-skeleton` class at line 587 in app.js); reuse the same keyframes.

#### 5. Files to modify

**`src/web/public/mobile-handlers.js`**:
- Replace `SwipeHandler` entirely with the new animated implementation.
- Add `touchmove` listener (`passive: false`) alongside existing `touchstart`/`touchend`.
- Track: `startX`, `startY`, `startTime`, `currentX`, `currentY`, gesture lock state (`'none' | 'horizontal' | 'vertical'`), `_skeletonEl` ref, `_animating` flag.
- Methods: `onTouchStart`, `onTouchMove`, `onTouchEnd`, `_commitSwipe(direction)`, `_cancelSwipe()`, `_createSkeleton(targetSession)`, `_removeSkeleton()`, `_isSwipeBlocked()`.
- Update `@fileoverview` JSDoc to mention animated swipe.
- Add `SwipeHandler.cleanup()` / `SwipeHandler.init()` to the SSE reconnect block in `app.js` (lines 5695–5698).

**`src/web/public/app.js`**:
- Add `SwipeHandler.cleanup(); SwipeHandler.init();` in the SSE reconnect handler (alongside `MobileDetection` and `KeyboardHandler` at lines 5695–5698).
- No other changes needed — `nextSession()`/`prevSession()` remain the same.

**`src/web/public/mobile.css`**:
- Add `.swipe-session-skeleton` styles (position, background, z-index, flex layout for content).
- Add `@keyframes skeleton-shimmer` if not already in styles.css (check: it's in app.js as class `mcp-skeleton` but the keyframes may be in styles.css).
- Add `.main.swipe-transitioning` with `transition: transform 250ms cubic-bezier(0.25, 0.46, 0.45, 0.94)` — only applied during commit/cancel animation, not during drag (drag uses raw JS transform updates).

**`src/web/public/index.html`**:
- Bump version: `mobile-handlers.js?v=0.4.11` → `v=0.4.12`, `mobile.css?v=0.1671` → `v=0.1672`.
- No DOM changes needed — skeleton element is created dynamically by JS.

#### 6. CSS z-index

The skeleton overlay must appear above `.main` content but below drawers and modals:
- `.swipe-session-skeleton`: `z-index: 500` (below `ZINDEX_SUBAGENT_BASE = 1000`, above `.main` children which are unset/`z-index: 10` for welcome overlay).
- Position: `position: fixed` matching `.main`'s visual bounds (easier than absolute positioning relative to a flex parent). Or `position: absolute` inside the app shell's flex container at the same level as `.main`.

Actually, `.main` is a `<main>` flex child. A sibling div inside the same flex container would need the same flex sizing. Better approach: `.swipe-session-skeleton` is `position: fixed; top: var(--header-height); left: 0; right: 0; bottom: 0` (matching the effective area of `.main`), using a CSS variable or similar.

Simplest: insert it as a sibling **inside `.main`** with `position: absolute; inset: 0; z-index: 5`. This way `.main`'s overflow:hidden clips it, and it's always exactly the same size as `.main`.

Wait — but if we're sliding `.main` as a whole, the skeleton also moves with it. That's wrong — the skeleton should slide in **from the opposite side** while `.main` slides out.

So the skeleton must be a **sibling to `.main`**, not a child. Use:
- Skeleton: `position: fixed; inset: 0; top: [header-height];` — or `position: absolute` in the flex container.

Looking at the layout: the app shell appears to be a flex column (`body` → `.app-container` or similar). Let's check the actual wrapping:

The skeleton should be positioned to cover exactly the same area as `.main`. Since `.main` uses `flex: 1` and `overflow: hidden`, the easiest approach is to make the skeleton `position: fixed` with `top` matching the rendered top of `.main` (which is below the header/tabs). This is fragile to layout changes.

**Preferred approach**: Create a `position: absolute` wrapper parent. Currently `.main` has `position: relative`. Instead of a sibling, we can create the skeleton as a **direct child of `.main`** (which has `position: relative; overflow: hidden`), but translate it independently from `.main` using a **`translateX` offset that is the inverse of `.main`'s translate**. This way when `.main` moves left by `deltaX`, the skeleton moves left by `deltaX - window.innerWidth` (it started at `+window.innerWidth`, so its absolute screen position is always at `deltaX` relative to zero, same as if it were a sibling with its own independent transform).

This is the cleanest approach: **skeleton is a child of `.main`**, and its `transform` is managed to compensate for `.main`'s translation. Net effect: the skeleton appears to slide in from the right/left while `.main`'s content slides out.

Formula during drag:
- `.main.style.transform = translateX(${deltaX}px)` (deltaX is negative for leftward swipe)
- `skeleton.style.transform = translateX(${targetOffsetX - deltaX}px)` where `targetOffsetX = +window.innerWidth` (swipe left/next) or `-window.innerWidth` (swipe right/prev).

Net screen position of skeleton = `.main`'s translation + skeleton's own translation = `deltaX + (targetOffsetX - deltaX)` = `targetOffsetX`. As `.main` moves, the skeleton stays at `targetOffsetX` relative to the viewport — i.e., it slides in from the side because `targetOffsetX` decreases toward zero as `deltaX` increases toward `±innerWidth`.

Wait: during swipe left (deltaX goes from 0 to negative), `targetOffsetX = +window.innerWidth`, and `skeleton's own translate = +window.innerWidth - deltaX` which grows (skeleton moves further right). That's wrong.

Let me re-think: for swipe left (next session), the incoming session comes from the right:
- `.main` translate: `deltaX` (starts at 0, goes negative, e.g. -200px at 200px swipe)
- Skeleton screen position should be: `deltaX + window.innerWidth` (starts at full width right, moves left toward screen center)
- So `skeleton.style.transform = translateX(${window.innerWidth - Math.abs(deltaX)}px)` but since `.main` is already at `deltaX`, skeleton's own transform = `window.innerWidth - Math.abs(deltaX) - deltaX` = `window.innerWidth - Math.abs(deltaX) + Math.abs(deltaX)` = `window.innerWidth`. That's constant — skeleton doesn't slide.

The math issue is that `.main`'s transform is a parent transform, and the skeleton is a child, so the child's `transform` is applied **after** the parent's. We need to apply the **inverse** of `.main`'s transform to get back to screen coordinates, then add the desired screen offset.

Skeleton screen X = `.main` translate + skeleton translate
= `deltaX` + `skeleton translate`

We want skeleton screen X = `window.innerWidth + deltaX` (moving together with `.main` minus one viewport width in advance)
→ `skeleton translate = window.innerWidth + deltaX - deltaX = window.innerWidth` (constant — skeleton doesn't animate relative to viewport).

Actually that's fine if the skeleton starts at `translateX(window.innerWidth)` and stays there, because `.main` is dragging leftward so the skeleton appears to slide in from the right. But wait — the skeleton moves with `.main` since it's a child. So the skeleton's **absolute screen position** = `deltaX + window.innerWidth`. That's exactly what we want: as `deltaX` goes from 0 to `-window.innerWidth` (full swipe), the skeleton moves from `+window.innerWidth` (off right) to `0` (on screen). Correct!

And `.main`'s content moves from `0` to `-window.innerWidth` (off screen left). Correct!

So the formula is simple:
- `.main.style.transform = translateX(${deltaX}px)` (deltaX negative for swipe left)
- `skeleton.style.transform = translateX(${targetOffsetX}px)` where `targetOffsetX = +window.innerWidth` for next (swipe left) or `-window.innerWidth` for prev (swipe right)
- The skeleton's transform is **constant during drag** — it moves with `.main` because it's a child.

On commit animation (using CSS transition on both `.main` and skeleton separately is possible, but since skeleton is a child and we just need `.main` to reach ±`window.innerWidth`):
- Add CSS transition to `.main` (class `.swipe-transitioning`)
- Set `.main.style.transform = translateX(${-window.innerWidth}px)` (or positive for prev) → triggers CSS transition
- Skeleton's screen position becomes `(-window.innerWidth) + window.innerWidth = 0` — on screen. The skeleton appears to have slid fully into view.
- `transitionend` on `.main` → remove transition class, remove skeleton, reset `.main.style.transform = ''`, call `selectSession()`.

On cancel animation:
- Add transition class to `.main`
- Set `.main.style.transform = ''` (0) → `.main` slides back to center, skeleton goes back to offscreen.
- `transitionend` → remove transition class, remove skeleton.

This approach is elegant and correct. **Skeleton is always a child of `.main`**, and its own transform is a static offset (one viewport width). All animation is driven by changing `.main`'s transform.

#### 7. xterm interference

xterm renders to a canvas element inside `#terminalContainer`. Canvas transforms via a parent are safe from xterm's perspective — it doesn't care about its CSS screen position. The `FitAddon` calculates dimensions from the container's `clientWidth`/`clientHeight`. Since `.main` has `overflow: hidden` and we're only changing its `transform` (not its dimensions), `clientWidth`/`clientHeight` of `.terminal-container` don't change during the swipe, so no spurious resize events.

#### 8. Key thresholds and timing

- Commit threshold: `Math.abs(deltaX) > window.innerWidth * 0.30` OR velocity `> 0.5 px/ms`
- Velocity = `Math.abs(finalX - startX) / elapsedMs`
- Commit animation duration: `250ms cubic-bezier(0.25, 0.46, 0.45, 0.94)` (iOS-like ease-out)
- Cancel animation duration: `300ms cubic-bezier(0.25, 0.46, 0.45, 0.94)` (slightly slower spring-back)
- Horizontal lock threshold: commit to horizontal if `|deltaX| > 10px AND |deltaX| > |deltaY|`

#### 9. Skeleton markup (dynamically created)

```html
<div class="swipe-session-skeleton" style="transform: translateX(VW px)">
  <div class="skeleton-session-pill">Session Name</div>
  <div class="skeleton-lines">
    <div class="skeleton-line"></div>
    <div class="skeleton-line"></div>
    <div class="skeleton-line"></div>
  </div>
</div>
```

#### 10. Summary of changes

| File | Change |
|------|--------|
| `mobile-handlers.js` | Replace `SwipeHandler` with animated version; add `touchmove` passive:false; add `_isSwipeBlocked()`, `_createSkeleton()`, `_commitSwipe()`, `_cancelSwipe()` |
| `app.js` | Add `SwipeHandler.cleanup(); SwipeHandler.init();` at SSE reconnect block (~line 5696) |
| `mobile.css` | Add `.swipe-session-skeleton`, `.skeleton-lines`, `.skeleton-line`, `.skeleton-session-pill`, `.swipe-transitioning`, `@keyframes skeleton-shimmer` |
| `index.html` | Bump `mobile-handlers.js?v=0.4.12`, `mobile.css?v=0.1672` |

## Fix / Implementation Notes

### Fix cycle 1 — addressed two review issues

**Issue 1 (MUST FIX): Added panel open checks to `_isDisabled()`**

Added four checks after the existing modal/drawer checks in `_isDisabled()`:
- `McpPanel._panel?.classList.contains('open')`
- `PluginsPanel._panel?.classList.contains('open')`
- `ContextBar._panel?.classList.contains('open')`
- `InputPanel._open` (compose panel open state)

All four use `typeof X !== 'undefined'` guards matching the pattern used elsewhere in `app.js`. This prevents swipe gestures from firing when any full-screen panel is visible on mobile.

**Issue 2 (MINOR): Removed `lastX`/`lastTime` dead code**

Chose Option A (remove). Removed the `lastX` and `lastTime` property declarations from the `SwipeHandler` object literal, the initialization lines in `_onTouchStart`, and the "Track velocity" update block (`lastX = x; lastTime = now`) in `_onTouchMove`. Total-gesture velocity (`Math.abs(dx) / elapsed`) is sufficient for fling detection at the 0.4 px/ms threshold.

---

### Changes Made (original implementation)

**`src/web/public/mobile-handlers.js`** (lines 450–764, was 527):
- Replaced the minimal `SwipeHandler` (touchstart+touchend only, no animation) with a full animated implementation.
- Added `touchmove` listener with `{ passive: false }` so `e.preventDefault()` can block vertical scroll once horizontal lock is confirmed.
- Added `touchcancel` listener aliased to the same handler as `touchend` for safety.
- New methods: `_isDisabled()`, `_onTouchStart()`, `_onTouchMove()`, `_onTouchEnd()`, `_resolveTarget()`, `_createSkeleton()`, `_commitSwipe()`, `_springBack()`, `_cleanup()`.
- `_createSkeleton()` uses only safe DOM methods (`createElement` / `textContent`) — no `innerHTML`.
- Gesture direction lock threshold: 10px. Commit threshold: 30% of `window.innerWidth` OR velocity >= 0.4 px/ms.
- Skeleton is inserted as a child of `.main` with a constant `translateX(±window.innerWidth)` offset so it tracks with `.main` during the drag and appears to slide in from the side.
- `selectSession()` is called after the slide-out CSS transition completes (`transitionend`) with a safety `setTimeout` fallback at 350ms.
- All disable conditions checked in `_isDisabled()`: `getDeviceType() !== 'mobile'`, `sessionOrder.length <= 1`, `_isLoadingBuffer`, `keyboardVisible`, session drawer open, modal active.

**`src/web/public/app.js`** (SSE reconnect block, ~line 5695):
- Added `SwipeHandler.cleanup(); SwipeHandler.init();` alongside the existing `MobileDetection` and `KeyboardHandler` cleanup/re-init calls. Prevents listener accumulation on reconnect.

**`src/web/public/mobile.css`** (appended after existing content):
- Added `.swipe-transitioning` — applies `transition: transform 250ms cubic-bezier(0.25, 0.46, 0.45, 0.94)` during commit/cancel animation only (not during drag).
- Added `.swipe-session-skeleton` — `position: absolute; inset: 0; z-index: 10; background: var(--bg-dark)`.
- Added `.skeleton-session-pill`, `.skeleton-lines`, `.skeleton-line`, `.skeleton-line.short`.
- Added `@keyframes skeleton-shimmer` for the shimmer animation on skeleton lines.

**`src/web/public/index.html`**:
- Bumped `mobile.css?v=0.1671` → `v=0.1672`.
- Bumped `mobile-handlers.js?v=0.4.11` → `v=0.4.12`.
- `styles.css` was not modified, so its version stays at `v=0.1688`.
=======
### Context and Gap

When `DELETE /api/sessions/:id` is called, `_doCleanupSession()` in `server.ts` (line 930) logs a
`deleted` or `detached` lifecycle event but does NOT persist `workingDir` or `claudeResumeId`.
The lifecycle entry only has: `ts`, `event`, `sessionId`, `name`, `mode`, `reason`.

The Claude conversation transcript lives at:
`~/.claude/projects/<workingDir-with-slashes-replaced-by-dashes>/<uuid>.jsonl`

This means recovery requires cross-referencing the lifecycle log (for session name/ts) with a
filesystem scan of `~/.claude/projects/` (for the actual UUIDs and project directories).

The `LifecycleEntry` type has an `extra?: Record<string, unknown>` field (types/lifecycle.ts:39)
that can store additional data — this is where we should write `workingDir` and `claudeResumeId`
at delete/detach time so future lookups don't need a filesystem scan for those fields.

However, for backward compatibility, the `GET /api/sessions/history` endpoint must also fall
back to scanning `~/.claude/projects/` to find sessions that were closed before this change.

### Architecture

#### Data Sources (for the history endpoint)

**Source 1 — lifecycle log** (`~/.codeman/session-lifecycle.jsonl`):
- Read last 500 lines (reverse parse, collect `deleted` and `detached` events)
- Deduplicate by `sessionId` (keep latest event per sessionId)
- Filter out sessionIds already in `ctx.sessions` (already active)
- After this change: `extra.workingDir` and `extra.claudeResumeId` are available directly

**Source 2 — JSONL filesystem scan** (`~/.claude/projects/`):
- Each subdirectory name is the workingDir with `/` → `-`
- Reverse map: `escapedDir.replace(/-/g, '/')` gives the original path (imperfect but useful for display)
  - NOTE: The escape is one-directional: `/` → `-`, so hyphens in dir names and `/` both become `-`.
    The reverse decode can't be perfect; display the decoded form but warn users to verify.
- Scan at most 100 JSONL files across all project dirs, sorted by mtime descending
- Skip UUIDs already covered by Source 1 (to avoid duplicates)
- Also skip UUIDs matching currently active sessions (`claudeResumeId` in `ctx.sessions`)

**Merged result**: deduplicate by `resumeId` (JSONL UUID), join lifecycle metadata (name, ts) with
filesystem metadata (mtime, workingDir). Sort by `lastActiveAt` descending.

#### Backend Changes

**1. Enhance lifecycle log at delete/detach time** (`src/web/server.ts`, `_doCleanupSession()`):
```ts
lifecycleLog.log({
  event: killMux ? 'deleted' : 'detached',
  sessionId,
  name: session?.name,
  mode: session?.mode,
  reason: reason || 'unknown',
  extra: {
    workingDir: session?.workingDir,
    claudeResumeId: session?.claudeResumeId,
    worktreeBranch: session?.worktreeBranch,
  },
});
```

**2. New route file**: `src/web/routes/history-routes.ts`
```
GET  /api/sessions/history   — returns ClosedSessionEntry[]
POST /api/sessions/resume    — creates new session with --resume <uuid>
```

Register in `src/web/routes/index.ts` and `src/web/server.ts`.

**3. New Zod schema** in `src/web/schemas.ts`:
```ts
export const ResumeClosedSessionSchema = z.object({
  workingDir: safePathSchema,
  resumeId: z.string().uuid(),
  name: z.string().max(128).optional(),
  mode: z.enum(['claude', 'shell', 'opencode']).optional(),
});
```

**4. Response shape** for `GET /api/sessions/history`:
```ts
interface ClosedSessionEntry {
  resumeId: string;          // Claude conversation UUID
  workingDir: string;        // Decoded working directory path
  displayName: string;       // session name from lifecycle log, or last segment of workingDir
  lastActiveAt: number;      // Unix ms timestamp
  worktreeBranch?: string;   // from lifecycle extra or undefined
  source: 'lifecycle' | 'scan';  // for debugging
}
```

**5. `POST /api/sessions/resume` handler** (in history-routes.ts):
- Parse `ResumeClosedSessionSchema`
- Validate `workingDir` exists as a directory (`statSync`)
- Check that `workingDir` is not already active (scan `ctx.sessions` for matching `workingDir`)
- Create `new Session({ workingDir, mode, name, claudeResumeId: resumeId, mux: ctx.mux, useMux: true })`
- Set `session.claudeResumeId = resumeId` before `startInteractive()` — this makes `buildMcpArgs`
  pass `--resume <uuid>` to the Claude CLI (see `session-cli-builder.ts` line 113-115)
- Then follow the same pattern as `POST /api/sessions` in `session-routes.ts`:
  `addSession`, `incrementSessionsCreated`, `persistSessionState`, `setupSessionListeners`,
  lifecycle log `created`, broadcast `SessionCreated`, call `startInteractive()`, broadcast
  `SessionInteractive` and `SessionUpdated`
- Return `{ success: true, session: lightState }`

**Key constraint**: `buildInteractiveArgs()` in `session-cli-builder.ts` omits `--session-id`
when `resumeId` is set (line 57: `if (!resumeId) args.push('--session-id', sessionId)`).
`buildMcpArgs()` appends `--resume <uuid>` when `resumeId` is set (line 113-114).
So setting `session.claudeResumeId` before `startInteractive()` is the correct mechanism.

**IMPORTANT**: The `Session` constructor does not accept `claudeResumeId` as an init param —
it must be set on the object AFTER construction but BEFORE `startInteractive()`. Verify
this in `session.ts` line 868: `claudeResumeId` is serialized from `this.claudeResumeId`.

**Route registration**: history-routes go in `session-routes.ts` is already at 24 handlers.
Better to add a new file `history-routes.ts` with its own `registerHistoryRoutes()` export,
registered in `index.ts` and `server.ts` using `SessionPort & EventPort & ConfigPort & InfraPort`
(same as `registerWorktreeSessionRoutes`).

**IMPORTANT path conflict**: `GET /api/sessions/history` could conflict with
`GET /api/sessions/:id` — Fastify matches literal routes before parametric, so `history`
would be treated as the `:id` param if not declared before the param route. Add this route
BEFORE `GET /api/sessions/:id` in the registration order, OR ensure it's registered in a
separate module that loads first. Since session routes are registered in `registerSessionRoutes`,
the safest approach is to register history routes in a new file before session routes in `server.ts`.

#### Frontend Changes

**1. "History" button in `SessionDrawer._render()`** (app.js ~line 16664):
Add a third footer button "Resume Closed" (or clock icon) in `drawer-footer` div.

**2. New modal/panel `HistoryModal`** (object literal pattern like existing modals in app.js):
- Opens as a full-drawer overlay or modal (reuse `.modal-overlay` pattern)
- Fetches `GET /api/sessions/history` on open
- Displays a scrollable list with optional text filter input (simple substring match on
  `displayName` + `workingDir` — no fuzzy lib needed)
- Each entry shows: project name (last segment of workingDir), full path as subtitle,
  `timeAgo(lastActiveAt)`, UUID snippet (first 8 chars), optional branch badge
- "Resume" button per entry → `POST /api/sessions/resume` → close modal → `app.selectSession(newId)`
- Filters out entries where workingDir matches an already-active session's workingDir

**3. CSS** (styles.css): add styles for `.history-modal`, `.history-entry`, `.history-entry-name`,
`.history-entry-path`, `.history-entry-meta`, `.history-resume-btn`. Reuse existing modal patterns.

**4. Version bumps** (index.html):
- `app.js?v=0.4.104` → `app.js?v=0.4.105`
- `styles.css?v=0.1688` → `styles.css?v=0.1689`

### Implicit Constraints from Codebase

- **TypeScript strict mode**: `noUnusedLocals`, `noUnusedParameters`, all vars must be typed
- **No `require()`** — ESM only; use `import` or `await import()`
- **DOM safety**: Use `textContent` / `createElement` not `innerHTML` with user data (SessionDrawer pattern)
- **Port interfaces**: Route files use intersection types like `SessionPort & EventPort & ConfigPort & InfraPort`
- **Zod v4 API**: Define schemas in `schemas.ts`, use `.safeParse()`
- **Lifecycle log is append-only** — do not add query params to filter for deleted events; use
  the existing `query()` method with no `event` filter and filter in memory
- **`statSync` for dir validation** (not async) — existing session creation routes do this
- **`Session` object pattern**: Constructor takes `SessionConfig`-like object; `claudeResumeId`
  is a property on `Session` class set after construction (not in constructor signature)
- **Active session dedup**: Scan `ctx.sessions` for `session.claudeResumeId === resumeId` AND
  `session.workingDir === workingDir` before creating a resume session

## Fix / Implementation Notes

### Fix cycle 1 — `decodeProjectDir` double-slash correction

**File**: `src/web/routes/history-routes.ts`

Removed the erroneous `'/' +` prefix from `decodeProjectDir`. Claude's encoding replaces each `/` with `-`, so the escaped form already begins with `-` (representing the root `/`). Calling `escapedDir.replace(/-/g, '/')` alone correctly reconstructs the absolute path. The previous implementation prepended an additional `/`, yielding `//home/...` paths that broke:
1. `GET /api/sessions/history` response — all `workingDir` values had `//` prefix
2. Active-session dedup in `POST /api/sessions/resume` — `//home/...` never matched `/home/...` in active sessions
3. New session `workingDir` stored with `//` prefix



### Backend

**`src/web/schemas.ts`** — Added `ResumeClosedSessionSchema` (workingDir safePathSchema, resumeId UUID, optional name/mode) and its inferred type.

**`src/web/server.ts`** — Enhanced `_doCleanupSession()` to include `extra: { workingDir, claudeResumeId, worktreeBranch }` in the lifecycle log entry at delete/detach time. Also imports and registers `registerHistoryRoutes` before `registerSessionRoutes` to avoid Fastify path conflict with `:id` param.

**`src/web/routes/history-routes.ts`** — New route file implementing:
- `GET /api/sessions/history`: reads last 500 lifecycle log entries (deleted/detached events), extracts `extra.workingDir` and `extra.claudeResumeId`, deduplicates by sessionId, filters out currently active sessions. Falls back to scanning `~/.claude/projects/` (capped at 100 JSONL files, sorted by mtime) for entries not covered by the lifecycle log. Returns merged `ClosedSessionEntry[]` sorted by `lastActiveAt` desc.
- `POST /api/sessions/resume`: validates via `ResumeClosedSessionSchema`, verifies workingDir exists, checks no active session already has the same resumeId or workingDir, creates a `Session` object, sets `session.claudeResumeId = resumeId` AFTER construction but BEFORE `startInteractive()` so `session-cli-builder.ts` injects `--resume <uuid>` automatically.

**`src/web/routes/index.ts`** — Added `registerHistoryRoutes` export.

### Frontend

**`src/web/public/app.js`** — Added `HistoryModal` object (literal pattern) with:
- `open()` / `close()` — toggling `#historyModal` `.active` class
- `_load()` — fetches `GET /api/sessions/history`, renders entry list
- `_renderList()` — builds DOM via `createElement`/`textContent` (no innerHTML with user data), shows displayName, path, time ago, UUID snippet, branch badge
- `_filterList(query)` — simple substring filter on displayName + workingDir
- `_resume(s, btn)` — POSTs to `/api/sessions/resume`, navigates to new session on success

Also added "⏱ Resume Closed" button to `SessionDrawer._render()` footer (alongside existing New Project / Clone from Git buttons).

**`src/web/public/index.html`** — Added `#historyModal` markup (uses `.modal`/`.modal-lg` pattern, with backdrop click to close, search input, list container). Bumped `styles.css?v=0.1688` → `v=0.1689` and `app.js?v=0.4.104` → `v=0.4.105`.

**`src/web/public/styles.css`** — Appended CSS for `.history-modal`, `.history-search`, `.history-list`, `.history-entry`, `.history-entry-{name,path,meta,time,uuid,branch}`, `.history-resume-btn`, `.history-empty`, `.history-loading`.
>>>>>>> feat/resume-closed-sessions

## Review History
<!-- appended by each review subagent — never overwrite -->

<<<<<<< HEAD
### Review attempt 1 — REJECTED

#### What was verified as correct

**Skeleton math:** The skeleton is a child of `.main` with `translateX(±window.innerWidth)` as a constant. During drag, `.main` moves by `deltaX`; skeleton's screen position = `deltaX + (±innerWidth)`. As `.main` slides fully to ±vw, the skeleton lands at 0 (center). Math is correct for both prev and next directions.

**`.main` position/overflow and skeleton positioning:** `.main` has `position: relative; overflow: hidden` (styles.css lines 2511–2517). Skeleton uses `position: absolute; inset: 0`. This correctly fills `.main`, and `overflow: hidden` clips the offscreen skeleton before it slides in. The z-index (10) puts the skeleton above terminal content, consistent with other z-index 10 children (`.welcome-overlay`). Skeleton appended last means it wins z-index ties with the welcome overlay.

**Race condition (safety timeout + transitionend):** `onDone` is correctly guarded. `transitionend` fires → `_cleanup()` sets `_animating = false`. When `setTimeout` fires, `if (self._animating)` is false — no double-call. The `{ once: true }` on `transitionend` prevents double-fire from that side as well.

**Commit sequence:** Slide to ±vw → `transitionend` → remove class, reset transform to `''` (instant, class already removed), remove skeleton, `rAF` → `selectSession()`. The rAF ensures the transform reset renders before `selectSession` reloads the buffer. `selectSession` immediately sets `buffer-loading` / `visibility: hidden` on the terminal container, so no old-session flash.

**`_springBack()` transition from mid-drag:** Sets `style.transform = ''` while simultaneously adding `.swipe-transitioning`. Browser correctly transitions from the in-progress `translateX(Xpx)` back to the identity transform.

**Velocity calculation:** `Math.abs(dx) / elapsed` uses total duration. The tracked `lastX`/`lastTime` fields are never used (dead code). The calculation still correctly catches flings at the 0.4 px/ms threshold for typical gestures. Low severity.

**Direction reversal guard:** `finalDirection !== this._direction` triggers springback if user reverses mid-swipe. Correct.

**Wrap-around behavior in `_resolveTarget`:** Consistent with `app.prevSession()`/`app.nextSession()` which also wrap.

**SSE reconnect:** `SwipeHandler.cleanup()` / `SwipeHandler.init()` added to the reconnect block in `app.js`. Prevents listener accumulation.

**Version bumps:** Both `mobile.css?v=0.1672` and `mobile-handlers.js?v=0.4.12` correctly bumped. `styles.css` unchanged, no bump needed.

**No innerHTML:** Skeleton built with `createElement` + `textContent`. XSS-safe.

#### Issues requiring fixes

**Issue 1 (MUST FIX): `_isDisabled()` does not check panel open state.**

The task spec ("Disable swipe when session drawer is open or a modal/panel is visible") and the implementation plan (section 3, lines 123–127 of TASK.md) explicitly require checking `McpPanel`, `PluginsPanel`, and `ContextBar` open state. On mobile these panels are full-screen overlays. A swipe inside an open panel would fire `_onTouchStart` on `.main` (the panel is a child of `.main` or overlays it with pointer-events — depends on panel z-index), and the gesture would accidentally trigger session switching while the user intends to scroll or interact within the panel.

The existing pattern in `app.js` (lines 377, 831, 1325) is:
```js
if (McpPanel._panel?.classList.contains('open')) return true;
if (typeof PluginsPanel !== 'undefined' && PluginsPanel._panel?.classList.contains('open')) return true;
if (typeof ContextBar !== 'undefined' && ContextBar._panel?.classList.contains('open')) return true;
```

Add these three checks to `_isDisabled()`. Also add `InputPanel._open` check — the compose panel can be open without `KeyboardHandler.keyboardVisible` being true yet (especially on Android where keyboard raise is async).

**Issue 2 (MINOR): Dead code — `lastX` / `lastTime` fields are tracked but never read.**

`lastX` and `lastTime` are updated in `_onTouchMove` and reset in `_onTouchStart` / `_cleanup`, but `_onTouchEnd` computes velocity from `this._deltaX / elapsed` (total gesture delta, not last-segment). Either use `lastX`/`lastTime` for a more accurate last-segment velocity (recommended — better fling detection on short rapid flicks), or remove the fields and the update lines in `_onTouchMove`. Leaving them as dead code is confusing to future maintainers and implies a more sophisticated velocity calculation that is not actually implemented.

Suggested fix: compute last-segment velocity in `_onTouchEnd`:
```js
const elapsed = this.lastTime - this.startTime;  // unchanged if no last-segment refinement
// OR for last-segment:
const segmentElapsed = Date.now() - this.lastTime;
const segmentVelocity = segmentElapsed > 0 ? Math.abs(this.lastX - (this.lastX - this._deltaX /* approx */)) / segmentElapsed : 0;
```
Or simply remove `lastX`/`lastTime` if total-gesture velocity is deemed sufficient.

### Review attempt 2 — APPROVED

#### Verification of Issue 1 fix — `_isDisabled()` panel checks

All four required panel checks are now present at lines 548–551 of `mobile-handlers.js`:

```js
if (typeof McpPanel !== 'undefined' && McpPanel._panel?.classList.contains('open')) return true;
if (typeof PluginsPanel !== 'undefined' && PluginsPanel._panel?.classList.contains('open')) return true;
if (typeof ContextBar !== 'undefined' && ContextBar._panel?.classList.contains('open')) return true;
if (typeof InputPanel !== 'undefined' && InputPanel._open) return true;
```

All four use `typeof X !== 'undefined'` guards, matching the existing pattern from `app.js`. The `InputPanel._open` check correctly guards the compose panel independently of `keyboardVisible`, addressing the async Android keyboard raise edge case. No issues.

#### Verification of Issue 2 fix — `lastX`/`lastTime` dead code removed

Grep of `mobile-handlers.js` for `lastX` and `lastTime` returns zero matches. The property declarations, the `_onTouchStart` initialization lines, and the `_onTouchMove` "Track velocity" update block have all been removed (Option A). The object literal at lines 471–759 contains only the properties listed: `startX`, `startY`, `startTime`, `_deltaX`, `_locked`, `_cancelled`, `_animating`, `_targetId`, `_direction`, `_skeleton`, plus the config constants and listener refs. No dead code remains.

#### Final review pass — all requirements met

- Touch event handling on `.main` with `touchstart` (passive), `touchmove` (passive: false), `touchend` + `touchcancel` (passive): confirmed lines 510–514.
- Velocity fling detection at 0.4 px/ms and 30% width threshold: confirmed lines 488, 487, 628.
- Skeleton as child of `.main` with constant `translateX(±vw)`: confirmed lines 663, 676.
- `_springBack()` correctly sets `style.transform = ''` with transition class applied first (browser transitions from mid-drag position back to identity): confirmed lines 731–732.
- `_commitSwipe()` uses `transitionend` + safety timeout; resets transform before `rAF → selectSession()`: confirmed lines 706–722.
- SSE reconnect adds `SwipeHandler.cleanup(); SwipeHandler.init();` in `app.js` (lines 5697, 5700): confirmed.
- Version bumps: `mobile-handlers.js?v=0.4.12` and `mobile.css?v=0.1672` confirmed in TASK.md implementation notes.
- No `innerHTML` usage; skeleton uses `createElement` + `textContent`: confirmed lines 672–691.
- `MobileDetection.getDeviceType() !== 'mobile'` guard (not the non-existent `.isMobile()`): confirmed line 540.

No new issues found.

## QA Results
<!-- filled by QA subagent -->

### QA run — 2026-03-14

**Note:** Port 3001 was running the production service (installed app at `~/.codeman/app`), not the feature branch. Started a feature-branch dev server on port 3016 for accurate frontend checks.

| Check | Result | Notes |
|-------|--------|-------|
| `tsc --noEmit` | PASS | Zero TypeScript errors |
| `npm run lint` | PASS | Zero ESLint errors (app.js in ignore list as expected) |
| CSS `.swipe-session-skeleton` loaded | PASS | Present in served `mobile.css?v=0.1672` |
| CSS `.swipe-transitioning` loaded | PASS | Present in served `mobile.css?v=0.1672` |
| `SwipeHandler` global defined | PASS | `typeof SwipeHandler !== 'undefined'` is true |
| `SwipeHandler.init` is a function | PASS | Confirmed |
| `SwipeHandler.cleanup` is a function | PASS | Confirmed |
| CSS rules parsed by browser | PASS | Both `.swipe-transitioning` and `.swipe-session-skeleton` appear in browser's parsed CSS rules |
=======
### Review attempt 2 — APPROVED

**TypeScript** (`npx tsc --noEmit`): PASS — zero errors.

**ESLint** (`npm run lint`): PASS — zero warnings or errors.

**Fix verification — `decodeProjectDir` double-slash**: CONFIRMED CORRECT.
The file at line 48 now reads:
```ts
return escapedDir.replace(/-/g, '/');
```
No `'/' +` prefix. The leading `-` in Claude's escaped dir name (e.g. `-home-user-project`) decodes to the leading `/` via the replace, yielding `/home/user/project` correctly. The double-slash regression is resolved.

**Remaining code review**: No new issues found.
- All three impacts of the bug (GET response, active-session dedup in POST, stored workingDir) are fixed by the single-line change.
- `buildLifecycleEntries` and `buildScanEntries` logic unchanged and correct.
- `POST /api/sessions/resume` active-session guard correctly compares `s.workingDir === workingDir` — now that `workingDir` is a proper `/home/...` path, this comparison will work correctly against active sessions.
- Session creation pattern (set `claudeResumeId` post-construction pre-`startInteractive()`) is intact.
- The two minor non-blocking findings from Review 1 (`activeWorkingDirs` unused at GET call site, `filePath` unused in scan loop) remain present but are not regressions and do not affect correctness.

**Verdict**: APPROVED.

### Review attempt 1 — APPROVED

**TypeScript**: `npx tsc --noEmit` exits 0. **Lint**: `npm run lint` exits 0.

**Correctness**: All constraints satisfied.
- Lifecycle log capped at 500 lines (`MAX_LIFECYCLE_LINES = 500`), scan capped at 100 JSONL files (`MAX_SCAN_ENTRIES = 100`).
- Active-session dedup: GET filters by `activeResumeIds`; POST checks both `claudeResumeId` and `workingDir` before creating.
- `--resume <uuid>` injection: `session.claudeResumeId` is set post-construction, pre-`startInteractive()` — confirmed correct per `session-cli-builder.ts` lines 57 and 113–114.
- No new npm dependencies added.
- CSS/JS `?v=` strings bumped: `styles.css?v=0.1689`, `app.js?v=0.4.105`.
- Fastify route conflict avoided: history routes registered before session routes in `server.ts`.

**Security**: `workingDir` validated by `safePathSchema` (absolute, no shell metacharacters, no `..`). `resumeId` validated as UUID v4 by Zod. `statSync` verifies directory existence before session creation. `POST /api/sessions/resume` is behind the same auth middleware as all other session routes.

**DOM safety**: `HistoryModal._renderList()` uses `createElement`/`textContent` throughout — no `innerHTML` with user-controlled data.

**Minor findings (non-blocking)**:
1. `activeWorkingDirs` is built inside `getActiveSets()` and returned, but never destructured at the GET handler call site — dead data in the returned object. Not flagged by TypeScript because it is "used" (returned). Does not affect correctness.
2. `filePath` is stored in each `candidates` entry but never accessed in the consumption loop (only `escapedDir`, `mtime`, `uuid` are used). Same — dead field, no impact.
3. `decodeProjectDir` is a lossy reverse of Claude's `/`→`-` escaping. This is documented in the code comment. For scan entries, the decoded `workingDir` could be wrong for paths with literal hyphens; the `statSync` check in `POST /api/sessions/resume` will surface this to the user at resume time. Acceptable given the fallback source nature of scan entries.

## QA Results

### QA Run 2 — 2026-03-14 — PASS

**TypeScript typecheck** (`npx tsc --noEmit`): PASS — zero errors.

**ESLint** (`npm run lint`): PASS — zero warnings or errors.

**Backend — GET /api/sessions/history**: PASS — `workingDir` values all start with a single `/` (e.g. `/home/siggi/sources/Codeman`). No double-slash observed. Double-slash bug confirmed fixed.

**Backend — POST /api/sessions/resume**: N/A (not re-tested; root cause fix in `decodeProjectDir` was confirmed correct by code inspection and the GET response).

**Frontend**: "⏱ Resume Closed" button confirmed present in `SessionDrawer._render()` footer (`app.js` line 16680). All CSS and JS elements (`HistoryModal`, `.history-modal`, `.history-entry`, `.history-resume-btn`, version strings) already verified in prior QA run.

**Verdict**: ALL CHECKS PASS. Status → done.

---

### QA Run — 2026-03-14 — FAIL

**TypeScript typecheck** (`npx tsc --noEmit`): PASS — zero errors.

**ESLint** (`npm run lint`): PASS — zero warnings or errors.

**Backend — GET /api/sessions/history**: PASS — returns `{ success: true, sessions: [...] }` with correct shape (`resumeId`, `workingDir`, `displayName`, `lastActiveAt`, `source`).

**Backend — POST /api/sessions/resume**: PARTIAL FAIL — endpoint responds and creates a session, but there is a critical bug:

**Bug: `decodeProjectDir` produces double-slash paths**

`decodeProjectDir(escapedDir)` does:
```
return '/' + escapedDir.replace(/-/g, '/');
```
Claude's encoding replaces each `/` with `-`, so `/home/siggi/sources/Codeman` becomes `-home-siggi-sources-Codeman`. The decode should be just `escapedDir.replace(/-/g, '/')` (the leading `-` already becomes the leading `/`). Prepending an extra `'/'` produces `//home/siggi/sources/Codeman`.

**Impact:**
1. All `workingDir` values returned by `GET /api/sessions/history` have a `//` prefix (observed in live response: `'//home/siggi/sources/Codeman'`).
2. The active-session dedup check in `POST /api/sessions/resume` (line 240: `s.workingDir === workingDir`) fails silently — active sessions store `/home/...` but the decoded history path is `//home/...`, so the check does NOT catch duplicates. A second session gets created for the same working directory.
3. The new session's `workingDir` is stored as `//home/...` in state, which may cause downstream path issues.

`statSync` on Linux accepts `//` paths (POSIX allows two leading slashes), so the directory-existence check does not catch this.

**Fix required:** Change `decodeProjectDir` to not prepend `/`:
```ts
return escapedDir.replace(/-/g, '/');
```

**Frontend**: CSS and JS elements present (`HistoryModal`, `.history-modal`, `.history-entry`, `.history-resume-btn`, "⏱ Resume Closed" button in drawer footer). Version strings bumped (`app.js?v=0.4.105`, `styles.css?v=0.1689`). Frontend structure looks correct — not blocking the fix.
>>>>>>> feat/resume-closed-sessions

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

<<<<<<< HEAD
### 2026-03-14 — Implementation decisions

**Skeleton as child of .main (not sibling)**: The spec suggested both approaches. Chose child-of-`.main` with a constant `translateX(±window.innerWidth)` offset. This is cleaner: all animation is driven by changing `.main`'s transform; the skeleton's own transform never needs to change during drag because being a child means it rides along with `.main`. Math: skeleton screen X = `.main` translate + `±window.innerWidth` constant → as `.main` slides to ±vw, skeleton lands at 0 (center).

**selectSession() called after transitionend, not before**: The spec's "simplest correct sequence" was: slide out → transitionend → reset transform → call selectSession. This is what was implemented. The skeleton covers `.main` during the reset, so no blank flash.

**Fling velocity threshold 0.4 px/ms** (not 0.5 as mentioned in the spec body's threshold section): The Implementation Plan section 8 says 0.5 px/ms but the TASK.md spec section header says "fast fling velocity". Used 0.4 px/ms (slightly more sensitive) as a reasonable middle ground for good UX on smaller phones.

**No `innerHTML`**: Security hook blocked innerHTML with user-supplied content. Used `createElement` + `textContent` for the skeleton pill label, which is XSS-safe.

**`_isDisabled()` uses `getDeviceType() !== 'mobile'`**: MobileDetection.isMobile() does not exist (spec note 1). Used the correct pattern from existing code.

**Both `transitionend` and safety `setTimeout`**: `transitionend` may not fire if element is removed or display changes mid-animation. Safety timeout at `TRANSITION_MS + 100` (350ms) prevents permanent `_animating = true` lockout.
=======
2026-03-14: Fix applied — `decodeProjectDir` double-slash bug.
- Removed erroneous `'/' +` prefix from `decodeProjectDir` in `history-routes.ts`
- Claude's encoding already produces a leading `-` for the root `/`, so `replace(/-/g, '/')` alone yields the correct absolute path
- No other files changed; fix is minimal

2026-03-14: Implementation complete.
- `history-routes.ts` registered BEFORE `session-routes.ts` in server.ts to avoid Fastify param conflict
- `Session.claudeResumeId` set post-construction, pre-`startInteractive()` as specified
- JSONL scan decoded via `'/' + escapedDir.replace(/-/g, '/')` (lossy; documented in code)
- Unused imports (`existsSync`, `fs`) removed after tsc caught them; all type checks pass
- CSS/JS version strings bumped per CLAUDE.md rules

2026-03-14: Analysis complete.
- Lifecycle log currently does NOT persist workingDir/claudeResumeId at delete time; enhancement needed
- `Session.claudeResumeId` must be set post-construction, pre-`startInteractive()` for --resume to work
- New route file `history-routes.ts` preferred over adding to system-routes.ts (already large)
- `/api/sessions/history` must be registered before `/api/sessions/:id` to avoid Fastify param conflict
- Filesystem scan of ~/.claude/projects/ needed for backward compat (pre-enhancement deletes)
- No fuzzy search library needed; simple substring filter sufficient given constraints
>>>>>>> feat/resume-closed-sessions

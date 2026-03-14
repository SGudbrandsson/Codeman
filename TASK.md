# Task

type: feature
status: done
fix_cycles: 0
title: Session and project indicator bar
description: |
  Add a persistent header element that displays the current session's name and project context.

  Design intent:
  - The indicator should appear ABOVE the existing top bar (MCP/CTX/skills bar), so it reads as
    "this is the session you're in, and the controls below belong to it"
  - Show: session display name (e.g. "feat/dark-mode") + project folder / git repo name
  - Optionally show git branch if different from session name
  - Should update when the active session changes (via SSE session switch events)
  - Subtle, minimal design — not competing with terminal content
  - On mobile: must not push content down too far; keep height ≤ 32px
  - On desktop: can be slightly taller, can show more info (repo path, branch, session status dot)

  Data available on SessionState:
  - name (session name / branch)
  - workingDir (project path)
  - worktreeBranch (git branch)
  - status (idle/busy)

  UX notes from user:
  "User experience makes more sense to have that name above, so that the MCP and skills and
   contacts belong to that, or have the name below and above it is the relevant CTX."
  Decision: indicator above MCP bar. MCP/CTX/skills bar reads as "tools for this session."

constraints: |
  - Must not break existing MCP/CTX bar layout
  - Must update reactively when switching sessions (use SSE SESSION_SELECTED or equivalent)
  - Should be hidden / minimal on very small screens if space is critical
  - Respect existing z-index layering (accessory bar: 1150, panels: 1199+)
  - No new npm dependencies
  - Bump relevant CSS/JS ?v= query strings per CLAUDE.md versioning rules

affected_area: frontend (app.js, styles.css, index.html)
fix_cycles: 1

## Root Cause / Spec

### Context

This is a new UI element, not a bug fix. The existing header (`<header class="header">`) is a flex row containing: `.header-brand` (logo), `.session-tabs` (tab strip), and `.header-right` (MCP/CTX chips, font controls, settings, etc.). It lives at `z-index: 1150` and is `34px` tall (`--header-height`). There is no concept of a "session indicator bar" anywhere in the codebase today.

The task asks for a second bar **inside the existing `<header>`** (or directly below it as a sibling), displayed above where the MCP/CTX chips appear, that shows:
- Session name (from `session.name` via `getSessionName()`)
- Project folder name (last segment of `session.workingDir`)
- Optionally: git branch (`session.worktreeBranch`) if it differs from `session.name`
- Status dot (idle/busy from `session.status` / `session.displayStatus`)

**Clarification:** The design intent says "above MCP bar." The MCP/CTX chips are part of `.header-right` which is already in the header. The header is a single row, so "above" means a second row/flex-wrap row inside the header, or a separate `<div>` element inserted between `</header>` and `<!-- Context Warning Banner -->`. The cleanest approach is a new `<div id="sessionIndicatorBar">` as a direct sibling of `<header>`, immediately after `</header>`, before `#contextBanner`. This keeps the existing header intact and unchanged.

### Implementation Plan

#### 1. HTML — `src/web/public/index.html`

Insert a new element immediately after `</header>` (line 118), before `<!-- Context Warning Banner -->`:

```html
<!-- Session / Project Indicator Bar -->
<div id="sessionIndicatorBar" class="session-indicator-bar" style="display:none;" aria-label="Active session" aria-live="polite">
  <span class="sib-status-dot" id="sibStatusDot" aria-hidden="true"></span>
  <span class="sib-session-name" id="sibSessionName"></span>
  <span class="sib-sep" aria-hidden="true">·</span>
  <span class="sib-project" id="sibProject"></span>
  <span class="sib-branch" id="sibBranch" style="display:none;"></span>
</div>
```

Bump `styles.css?v=` by 1 (0.1688 → 0.1689) and `app.js?v=` by 1 patch (0.4.104 → 0.4.105).

#### 2. CSS — `src/web/public/styles.css`

Add a new section near the header styles (after `.header` block, around line 143):

```css
/* ========== Session Indicator Bar ========== */
.session-indicator-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  height: 28px;           /* desktop height */
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
  font-size: 0.75rem;
  color: var(--text-dim);
  flex-shrink: 0;
  contain: layout style;
}

.sib-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-dim);
  transition: background 0.25s;
}
.sib-status-dot.idle  { background: #4ade80; }  /* green */
.sib-status-dot.busy  { background: #fbbf24; animation: sib-pulse 1.2s ease-in-out infinite; }

@keyframes sib-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.35; }
}

.sib-session-name {
  font-weight: 600;
  color: var(--text);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sib-sep { color: var(--text-dim); opacity: 0.5; }

.sib-project {
  color: var(--text-dim);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sib-branch {
  color: var(--accent);
  font-size: 0.7rem;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(96,165,250,0.12);
  border: 1px solid rgba(96,165,250,0.25);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Mobile: reduce height, hide project path on very small screens */
@media (max-width: 600px) {
  .session-indicator-bar {
    height: 24px;
    font-size: 0.7rem;
  }
  .sib-project { display: none; }
  .sib-sep { display: none; }
}
```

#### 3. JS — `src/web/public/app.js`

Add a `SessionIndicatorBar` singleton object (similar to `ContextBar`, `McpPanel`), added near the other singleton definitions (around line 420–1300 region). It should:

- Cache DOM refs (`#sessionIndicatorBar`, `#sibStatusDot`, `#sibSessionName`, `#sibProject`, `#sibBranch`) in an `init()` method called from `app.init()`.
- Expose an `update(sessionId)` method that:
  1. Gets `app.sessions.get(sessionId)` (or hides bar if null).
  2. Reads `session.name`, `session.workingDir`, `session.worktreeBranch`, `session.displayStatus ?? session.status`.
  3. Sets `#sibSessionName` to `app.getSessionName(session)`.
  4. Sets `#sibProject` to the last path segment of `workingDir` (i.e. `workingDir.split('/').pop()`), or empty.
  5. Shows `#sibBranch` only when `worktreeBranch` is non-empty and differs from `session.name`.
  6. Sets `.sib-status-dot` class to `idle` or `busy`.
  7. Shows the bar (`style.display = 'flex'`); hides it when `sessionId` is null.
- Call `SessionIndicatorBar.update(sessionId)` in **two places**:
  1. In `selectSession()`, right after `this.activeSessionId = sessionId` (alongside existing calls to `McpPanel.showForSession`, `ContextBar.onSessionSelected`).
  2. In `_onSessionUpdated()`, when `session.id === this.activeSessionId` (after `this.renderSessionTabs()`).
- Also call `SessionIndicatorBar.update(null)` when `activeSessionId` is cleared (in `_onSessionDeleted` and `showWelcome`/`goHome` paths — check lines 4062–4066 and 5852–5856).

#### Key data access pattern (no new API needed)

All needed data is already in the in-memory `app.sessions` Map, populated via SSE `session:created` / `session:updated` events. No backend changes required.

#### Files to modify

| File | Change |
|------|--------|
| `src/web/public/index.html` | Add `#sessionIndicatorBar` div after `</header>`; bump `styles.css?v=0.1689`, `app.js?v=0.4.105` |
| `src/web/public/styles.css` | Add `.session-indicator-bar` and related CSS rules |
| `src/web/public/app.js` | Add `SessionIndicatorBar` singleton; wire into `selectSession()` and `_onSessionUpdated()` |

#### Verification

After implementation, use Playwright to:
1. Load `http://localhost:3000` (dev server, `npx tsx src/index.ts web`).
2. Assert the indicator bar is visible with correct session name and project folder when a session is active.
3. Switch sessions (click a different tab) and assert text updates.
4. Assert bar is hidden on the welcome screen (no active session).
5. Assert mobile layout (≤600px width) hides `.sib-project` and `.sib-sep`.

## Fix / Implementation Notes

### Changes Made

**`src/web/public/index.html`**
- Added `#sessionIndicatorBar` div (with child spans for status dot, session name, separator, project, and branch) immediately after `</header>`, before `<!-- Context Warning Banner -->`. Bar starts hidden (`display:none`).
- Bumped `styles.css?v=0.1688` → `v=0.1689`
- Bumped `app.js?v=0.4.104` → `v=0.4.105`

**`src/web/public/styles.css`**
- Added `.session-indicator-bar` block and all related rules (`.sib-status-dot`, `.sib-session-name`, `.sib-sep`, `.sib-project`, `.sib-branch`, `@keyframes sib-pulse`) directly after the `.header {}` closing brace (line 143), before `.header-brand`.
- Mobile breakpoint (`max-width: 600px`) reduces height to 24px and hides project + separator spans.

**`src/web/public/app.js`**
- Added `SessionIndicatorBar` singleton object before the `ContextBar` definition (around line 1196). Exposes `init()` and `update(sessionId)`.
- `init()` wired into `app.init()` alongside `McpPanel.init()`, `ContextBar.init()`.
- `update(sessionId)` called in:
  1. `selectSession()` — immediately after `this.activeSessionId = sessionId`
  2. `_onSessionUpdated()` — when `session.id === this.activeSessionId`
  3. `_onSessionDeleted()` — calls `update(null)` when the deleted session was active

### Why these locations

- `selectSession()` is the primary path for tab switches — bar updates instantly when user switches sessions.
- `_onSessionUpdated()` handles SSE-driven updates (status changes, renames) — bar stays in sync without requiring a tab switch.
- `_onSessionDeleted()` ensures the bar hides when the last session disappears and the welcome screen is shown.

### Fix Cycle 2 — Changes Made (addressing Review attempt 1 rejections)

**Issue 1 fixed (`app.js` — `_updateTabStatusDebounced`)**
- In the `busy` timer callback (line ~4381): after `this.renderSessionTabs()`, added `if (sessionId === this.activeSessionId) SessionIndicatorBar.update(sessionId);`
- In the `idle` timer callback (line ~4391): same guard + call added after `this.renderSessionTabs()`
- This ensures the status dot in the indicator bar stays in sync with the debounced display transitions, not just SSE session:updated events.

**Issue 2 fixed (`app.js` — `showWelcome()`)**
- Added `SessionIndicatorBar.update(null);` as the first line of `showWelcome()`.
- This covers all paths that lead to the welcome screen: `goHome()`, kill-session when no sessions remain, kill-all-sessions — since they all ultimately call `showWelcome()`.

**Issue 3 fixed (`app.js` — `SessionIndicatorBar.update()`)**
- Changed branch pill visibility check from `branch !== name` (where `name = app.getSessionName(session)`) to `branch !== session.name` (raw session name).
- Display name (`app.getSessionName(session)`) is still used for `#sibSessionName` text content; only the comparison uses the raw name.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — REJECTED

#### Summary

The implementation is well-structured and follows existing patterns correctly. HTML, CSS, and JS are all consistent with the codebase. However, there is one real defect and several minor gaps that should be fixed before QA.

---

#### Issue 1 (DEFECT) — Status dot does not update reactively during session activity

The status dot reads `session.displayStatus ?? session.status ?? 'idle'`, which is correct. However, `displayStatus` is updated exclusively through the debounced timers inside `_updateTabStatusDebounced()` (lines 4371–4393). Those timers call `renderSessionTabs()` but do NOT call `SessionIndicatorBar.update()`. As a result:

- When a session transitions busy→idle or idle→busy, `renderSessionTabs()` fires and the tab dot updates, but the indicator bar dot remains stale.
- `_onSessionUpdated()` (the only place `SessionIndicatorBar.update()` is called for status changes) uses the SSE `session:updated` event which carries `session.status`, not `displayStatus`. So the bar dot only updates when the server emits a full session update, not on the debounced client-side display transitions.
- Net effect: the indicator bar dot may lag behind by 4 seconds or never transition if only `SESSION_WORKING`/`SESSION_IDLE` SSE events fire (which route through `_updateTabStatusDebounced`, not `_onSessionUpdated`).

Fix: inside the two debounced timer callbacks in `_updateTabStatusDebounced`, after calling `this.renderSessionTabs()`, add a call to `SessionIndicatorBar.update(sessionId)` if `sessionId === this.activeSessionId`.

---

#### Issue 2 (MINOR) — `goHome()` does not hide the indicator bar

`goHome()` (line 6962) sets `this.activeSessionId = null` and calls `showWelcome()`, but does NOT call `SessionIndicatorBar.update(null)`. The bar will remain visible showing the previous session's info. The same applies to:
- The kill-session path at lines 6813–6821 (sets `activeSessionId = null` then calls `showWelcome()` when no sessions remain — does not go through `selectSession`, so the bar is not cleared).
- The "kill all sessions" path at lines 7955–7964 (sets `activeSessionId = null`, calls `showWelcome()`, no `update(null)`).
- Lines 15099–15113 (another kill-all path with two branches, neither calls `update(null)`).

`showWelcome()` itself does not call `update(null)`, so none of these paths clear the bar. Only `_onSessionDeleted` (for single-session delete of the active session) and `selectSession()` are covered.

Fix: either call `SessionIndicatorBar.update(null)` in each uncovered path, or add `SessionIndicatorBar.update(this.activeSessionId)` at the start of `showWelcome()` (which is already the canonical "no session" display call).

---

#### Issue 3 (MINOR) — `worktreeBranch` comparison uses session.name, not getSessionName

The branch pill visibility check at line 1237 is:
```js
const showBranch = branch && branch !== name;
```
where `name = app.getSessionName(session)`. This is correct per the spec ("show only when `worktreeBranch` differs from `session.name`"). However, `getSessionName()` may return a display-formatted version of the name (e.g. the custom label). If a user sets a custom session label that matches `worktreeBranch`, the pill would incorrectly be hidden. This is a minor UX edge case, not a crash, but worth being consistent: the spec says compare against `session.name` (raw), not the display name. Consider using `session.name` directly for the comparison.

---

#### What is correct

- HTML placement (after `</header>`, before `#contextBanner`) matches the spec exactly.
- Accessibility attributes (`aria-label`, `aria-live="polite"`, `aria-hidden="true"` on decorative elements) are well done.
- CSS is minimal, uses existing CSS variables (`--bg-card`, `--border`, `--text-dim`, `--text`, `--accent`), respects the ≤32px mobile height constraint (24px at ≤600px), and hides project/separator on small screens.
- No z-index is assigned to the indicator bar (it's `position: static` in normal flow), so it does not interfere with the existing z-index layering.
- Version bumps are correct: `styles.css` 0.1688→0.1689, `app.js` 0.4.104→0.4.105.
- `init()` wired into `app.init()` in the correct location alongside peer singletons.
- `selectSession()` and `_onSessionDeleted()` coverage is correct.
- `displayStatus ?? status ?? 'idle'` fallback chain matches the pattern used in `renderSessionTabs()` and subagent windows.

### Review attempt 2 — REJECTED

#### Summary

All three issues from Review attempt 1 are addressed correctly, and the overall implementation remains sound. However, one path explicitly called out in Issue 2 of Review attempt 1 (lines 15099–15113) is still not covered by the `showWelcome()` fix, leaving a stale indicator bar after `confirmKillAll()` is invoked.

---

#### Issue 1 — FIXED

Both debounced timer callbacks in `_updateTabStatusDebounced` now include `if (sessionId === this.activeSessionId) SessionIndicatorBar.update(sessionId)` after `renderSessionTabs()`. The 300ms busy timer and 4000ms idle timer are both covered. This is correct.

---

#### Issue 2 — PARTIALLY FIXED (one path still missing)

`SessionIndicatorBar.update(null)` was added as the first line of `showWelcome()`. This correctly covers:
- `goHome()` — calls `showWelcome()` ✓
- `killAllSessions()` (Ctrl+K path) — calls `showWelcome()` ✓
- `closeSession()` with no remaining sessions — calls `showWelcome()` ✓

However, `confirmKillAll()` at lines 15091–15123 (the admin kill-all modal) does NOT call `showWelcome()`. It has two code paths (killMux=true at line 15099 and killMux=false at line 15110) that both set `activeSessionId = null` and call `renderSessionTabs()` + `terminal.clear()`, but neither calls `showWelcome()` nor `SessionIndicatorBar.update(null)`. The bar remains visible showing the previous session after this admin action.

This path was explicitly listed in the Issue 2 description of Review attempt 1 ("Lines 15099–15113, another kill-all path with two branches, neither calls `update(null)`"), so the fix is incomplete.

Fix: add `SessionIndicatorBar.update(null)` after each `this.activeSessionId = null` assignment inside `confirmKillAll()` (lines 15102 and 15113).

---

#### Issue 3 — FIXED

The branch pill comparison now uses `branch !== session.name` (raw name) rather than the display name from `getSessionName()`. The display name is still used for `#sibSessionName` text content. This is correct.

---

#### What is correct (unchanged from Review attempt 1)

- HTML, CSS, and JS structure and patterns are consistent with the codebase.
- `selectSession()`, `_onSessionDeleted()`, `_onSessionUpdated()`, and the main `killAllSessions()` path are all correctly covered.
- Status dot reads `displayStatus ?? status ?? 'idle'` matching the pattern in `renderSessionTabs()`.
- Version bumps (`styles.css` 0.1688→0.1689, `app.js` 0.4.104→0.4.105) are correct.
- Accessibility attributes are well done.
- Mobile height (24px at ≤600px) is within the ≤32px constraint.

### Review attempt 3 — APPROVED

#### Summary

The fix applied in cycle 3 is correct and complete. Both branches of `confirmKillAll()` now call `SessionIndicatorBar.update(null)` immediately after `this.activeSessionId = null` (line 15103 in the `killMux=true` branch inside `if (data.success)`, and line 15115 in the `killMux=false` branch). This directly addresses the remaining gap identified in Review attempt 2.

All three issues from Review attempt 1 are now fully resolved:

1. **Status dot reactivity** — FIXED: Both timer callbacks inside `_updateTabStatusDebounced` (300ms busy, 4000ms idle) now call `SessionIndicatorBar.update(sessionId)` after `renderSessionTabs()`, guarded by `sessionId === this.activeSessionId`.

2. **Missing `update(null)` calls** — FIXED: `showWelcome()` calls `update(null)` covering `goHome()`, `killAllSessions()` (Ctrl+K), and `closeSession()` with no remaining sessions. `confirmKillAll()` both branches now call `update(null)` explicitly, since this function does not go through `showWelcome()`.

3. **Branch comparison** — FIXED: `showBranch` uses `branch !== session.name` (raw name) rather than the display name from `getSessionName()`.

No additional issues found. The implementation is consistent with codebase patterns, the coverage of `update()` call sites is comprehensive, and no session-clearing path is left unhandled.

## QA Results

### TypeScript typecheck (`tsc --noEmit`) — PASS
Zero errors, zero output.

### ESLint (`npm run lint`) — PASS
Clean run, no warnings or errors.

### Playwright UI test (11 checks) — ALL PASS
Dev server started on port 3002 with 15 sessions loaded.

| # | Check | Result |
|---|-------|--------|
| 1 | `#sessionIndicatorBar` exists in DOM | PASS |
| 2 | Bar visible (`display:flex`) when sessions exist | PASS |
| 3 | Height is 28px (<=28px on desktop) | PASS |
| 4 | Font-size is 12px | PASS |
| 5 | Child `.sib-status-dot` exists | PASS |
| 6 | Child `.sib-session-name` exists | PASS |
| 7 | Child `.sib-sep` exists | PASS |
| 8 | Child `.sib-project` exists | PASS |
| 9 | Session name has content ("w1-keeps-monorepo") | PASS |
| 10 | Project has content ("keeps") | PASS |
| 11 | Status dot has state class ("sib-status-dot idle") | PASS |

**Overall: ALL CHECKS PASS — status set to `done`.**

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

### 2026-03-14 — Implementation

- **Placement**: `#sessionIndicatorBar` inserted as sibling after `</header>`, not inside it. This leaves the existing header row completely unchanged and avoids any flex/layout interaction with the existing header elements.
- **No new SSE event needed**: All data (`name`, `workingDir`, `worktreeBranch`, `displayStatus`) is already present in the in-memory `app.sessions` Map updated by existing SSE events. The `_onSessionUpdated` hook is sufficient for reactive updates.
- **Branch pill visibility**: Shown only when `session.worktreeBranch` is non-empty AND differs from `getSessionName(session)` — avoids redundancy for sessions whose name IS the branch name.
- **Status dot**: Uses `displayStatus ?? status` (mirrors existing pattern in other UI elements) so debounced status doesn't flicker during SSE updates.
- **Version bumps**: `styles.css` 0.1688→0.1689, `app.js` 0.4.104→0.4.105 per CLAUDE.md rules.

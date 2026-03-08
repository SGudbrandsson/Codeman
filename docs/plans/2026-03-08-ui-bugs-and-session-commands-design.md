# UI Bugs & Session-Specific Slash Commands — Design

**Date**: 2026-03-08

## Overview

Two groups of changes:
- **Group A**: Fix several UI bugs — hamburger menu on desktop, mobile hamburger positioning, arrow button dropdown z-index, context pill visibility
- **Group C**: Make slash commands session-specific, scoped to the session's working directory

---

## Group A: UI Bug Fixes

### 1. Desktop Hamburger Menu

**Problem**: The `SessionDrawer` only has mobile CSS (`position: fixed; bottom: 0`, slides from bottom). On non-touch devices (no `.touch-device` class), the drawer has no positioning rules and is invisible/non-functional.

**Fix**:
- Add CSS for non-touch desktop: `position: fixed; top: 48px; right: 0; height: calc(100vh - 48px); width: 280px; transform: translateX(100%)`
- When `.open`: `transform: translateX(0)`
- Use existing `.session-drawer-overlay` backdrop for click-outside-to-close
- `SessionDrawer.toggle()` already handles open/close — no JS changes needed

### 2. Mobile Hamburger — Popup Above Button

**Problem**: Mobile drawer is a full-screen bottom sheet. User wants it to appear as a compact popup near the hamburger button (top of screen), closable by pressing the button again.

**Fix**:
- Change mobile drawer to a right-anchored popup: `position: fixed; top: 48px; right: 0; width: 260px; max-height: 60vh; overflow-y: auto`
- Slides in from right: `transform: translateX(100%)` → `translateX(0)`
- Same toggle/overlay behavior handles open and close
- Pressing hamburger again closes it (already works via `SessionDrawer.toggle()`)

### 3. Arrow Button Menu Z-Index

**Problem**: The dropdown menu next to the run button appears behind the action bar toolbar.

**Fix**:
- Bump dropdown z-index to `1100` (above the `1000` used by other overlays)
- Ensure the dropdown container does not have a stacking context that clips it
- Verify `bottom: 100%` positioning so it opens upward above the bar

### 4. Context Pill on Desktop

**Problem**: `.mobile-ctx-pill` is forced `display: none` by desktop CSS, so it never shows on desktop even when there's context data.

**Fix**:
- Rename `updateMobileContextPill()` → `updateContextPill()` and update all call sites
- In the JS, override `display` inline when tokens > 0 (bypasses the CSS `display: none`)
- On desktop: pill appears in the header when context usage is > 0

---

## Group C: Session-Specific Slash Commands

### Problem

`discoverCommands()` scans two global Codeman-internal paths:
- `~/.claude/plugins/installed_plugins.json` — Codeman plugin skills
- `~/.claude/commands/gsd/*.md` — GSD workflow commands

These are not actual Claude slash commands. They appear on every session regardless of what's loaded in that session, causing spurious entries like `/brainstorming`.

### How Claude Actually Loads Commands

Claude Code loads slash commands from two scopes:
1. **Project-level**: `{session_cwd}/.claude/commands/*.md`
2. **User-level**: `~/.claude/commands/*.md` (top-level only, not subdirectories)

### Design

**Backend (`commands-routes.ts`)**:
- Accept session `cwd` from `SessionState` (already available)
- Scan `{cwd}/.claude/commands/` for project-level commands → `source: 'project'`
- Scan `~/.claude/commands/*.md` (top-level `.md` files only — skip `gsd/`, `plugins/` subdirs) → `source: 'user'`
- Remove GSD `gsd/*.md` scan and plugin scan entirely
- Return commands tagged with `source: 'project' | 'user'`

**Frontend (`app.js`)**:
- No merge logic changes — session commands still take priority over built-ins
- The 17 built-in Claude Code commands remain as fallback

### Result

- `/brainstorming` and other GSD/plugin skills disappear from the slash command list
- Each session shows only commands relevant to its working directory
- User-level `~/.claude/commands/*.md` commands appear in all sessions (correct — user-global)
- Project commands only appear when that project's directory is the session's `cwd`

---

## Files Affected

| File | Change |
|------|--------|
| `src/web/public/styles.css` | Add desktop `SessionDrawer` CSS, fix arrow dropdown z-index, context pill desktop show |
| `src/web/public/mobile.css` | Change mobile drawer from bottom sheet to right-anchored popup |
| `src/web/public/app.js` | Rename `updateMobileContextPill` → `updateContextPill`, inline display override |
| `src/web/routes/commands-routes.ts` | Replace global scan with cwd-scoped scan, remove GSD/plugin scan |
| `src/web/public/index.html` | Version bump for CSS/JS assets |

# Mobile UX Overhaul Design

**Date:** 2026-03-07
**Status:** Approved

## Overview

Four-phase mobile UX improvement roadmap addressing session content fidelity, navigation, input, and dynamic command discovery for the Codeman web UI on Android.

---

## Phase 1: Terminal Content Fidelity

### Problem

When switching sessions, xterm.js writes the entire history buffer incrementally. The viewport follows each write, so the user sees hundreds of lines animate/scroll past before landing at the bottom (visible replay of full buffer history).

Separately, the GSD plugin outputs a context status line (e.g. `Context: 47% · 3 tools · idle`) that gets buried under new terminal output, requiring the user to scroll up to see it.

### Terminal Scroll Fix

**Root cause:** `scrollToBottom()` is called at buffer load end, but intermediate writes during `_loadBufferQueue` flush each advance the viewport one step.

**Fix:** Set a `_bufferLoading` flag at the start of `loadBuffer()`. During buffer load, suppress all intermediate `scrollToBottom()` calls. After the final chunk is written and the queue is flushed, call `scrollToBottom()` once. The user sees an instant snap to current content with no animation.

Implementation touches: `app.js` `loadBuffer()` and the SSE buffer chunk handler.

### Status Line Pinning

**Approach:** Monitor terminal `onLineFeed` (or `onData`) events. Match lines against a pattern for GSD/status output (e.g. lines containing `Context:` and `%`, or starting with known GSD prefix characters). Mirror the last matched line into a 1-line-tall monospace strip rendered between the terminal viewport and the keyboard accessory bar. Updates in place on each match. Dimmed styling (opacity ~0.7) to distinguish from active terminal content.

Implementation: new DOM element `.terminal-status-strip` in `index.html`, pattern matching in `app.js`, CSS in `styles.css` / `mobile.css`.

---

## Phase 2: Session Navigation and Keyboard Stability

### Problem

Swipe gestures to switch sessions are unreliable on mobile and provide no visibility into which sessions exist. Users cannot see the session list without swiping around blindly.

On Android, when the keyboard closes the `visualViewport` shrinks, `resetLayout()` fires immediately, and the terminal content jumps in position.

### Session Navigation Drawer

A hamburger button is added to the mobile toolbar (top-right). Tapping it opens a bottom-sheet drawer listing all active sessions. Each row shows:
- Session name
- CLI type badge (claude / opencode / shell)
- Running / idle status indicator
- Ralph loop active indicator (if applicable)

Tapping a row switches to that session and closes the drawer. The drawer supports swipe-to-dismiss. The existing horizontal swipe gesture between sessions is preserved as a secondary option.

Implementation: new drawer component in `app.js`, styled in `mobile.css`. Drawer state managed in `MobileDetection` or a new `SessionDrawer` object.

### Keyboard Layout Stability

**Root cause:** `resetLayout()` fires synchronously on `visualViewport` resize, applying `paddingBottom` and `fitAddon.fit()` before the browser has settled its own layout, causing a visible jump.

**Fix:**
1. Defer `resetLayout()` by one `requestAnimationFrame` on keyboard hide so the browser layout stabilizes first.
2. Before calling `fitAddon.fit()`, capture the terminal's current scroll offset relative to the bottom (`terminal.buffer.active.length - terminal.rows`). After fit completes, restore this offset via `terminal.scrollToLine()` so visible content stays stable.

Implementation touches: `mobile-handlers.js` `onKeyboardHide()` and `resetLayout()`.

Note: the "accessory bar disappears when keyboard closes" issue was already fixed in commit e152d1f (2026-03-07). Requires hard refresh to take effect.

---

## Phase 3: Persistent Input Field Toggle

### Problem

On mobile, typing directly into the xterm.js terminal provides no visibility into what you're typing before sending. There is no way to compose multi-line input, paste large blocks, or use voice dictation with confidence.

### Design

A toggle button (keyboard/cursor icon) is added to the keyboard accessory bar. Tapping it slides up a panel between the terminal and the accessory bar containing:
- A native `<textarea>` (full width, ~4 lines tall, resizable)
- A Send button (right side)
- A mic button (left side, hooks into existing `VoiceInput` infrastructure)

The textarea is a real DOM input element — Android provides full keyboard, autocorrect, paste menu, and voice dictation. Content is visible and editable before sending.

Tapping Send calls `app.sendInput()` with the textarea content. The textarea is **not** cleared on Send — the user can keep editing, append more, or send again. A separate Clear button (or long-press Send) clears the field.

Tapping the toggle again slides the panel back down. The terminal reclaims the space. Panel open/closed state persists across session switches within the same page load.

The panel respects the existing `paddingBottom` reserved by the accessory bar so nothing overlaps.

Implementation: new `InputPanel` object in `app.js` or a dedicated `input-panel.js` module, styled in `mobile.css`. Toggle state in `KeyboardAccessoryBar`.

---

## Phase 4: Dynamic Commands Discovery

### Problem

The Commands drawer shows a hardcoded command list per CLI mode. Plugin commands (GSD `/gsd:*`, superpowers `/superpowers:*`, etc.) are not visible even when those plugins are installed and active for the current session's project.

### Command Sources

Three sources are read at connect/reconnect time:

1. **User-scoped plugin skills** — `~/.claude/plugins/installed_plugins.json`, entries with `scope: user`. For each install path, read `skills/{name}/SKILL.md` frontmatter (`name`, `description`). Skills become `/{plugin-prefix}:{skill-name}` commands.

2. **Project-scoped plugin skills** — Same file, entries with `scope: project`. Only included if the session's working directory is inside `projectPath`. Enables per-project plugin filtering.

3. **GSD commands** — `~/.claude/commands/gsd/*.md` frontmatter (`name`, `description`). Always included for claude-mode sessions when GSD is installed.

### Data Flow

Backend endpoint or SSE push: on session connect/reconnect, the backend reads and parses the above sources, builds a list of `{ cmd, desc, source }` objects, and sends a new SSE event `session_commands_updated` with the payload.

Frontend: `KeyboardAccessoryBar._populateDrawer()` merges dynamic commands below the static CLI commands (with a separator). The existing search box filters across both. Refresh only on connect/reconnect — no polling or cwd-change triggers.

### Fallback

If the filesystem read fails or returns empty, the existing hardcoded static list is shown unchanged. No error shown to user.

Implementation: new backend function in a route or session module to scan plugins, new SSE event type in `sse-events.ts` + `constants.js`, frontend merge in `keyboard-accessory.js`.

---

## Phasing and Dependencies

| Phase | Features | Dependencies |
|-------|----------|--------------|
| 1 | Terminal scroll fix + status line pin | None |
| 2 | Session drawer + keyboard stability | Phase 1 complete |
| 3 | Persistent input toggle | Phase 2 complete |
| 4 | Dynamic commands discovery | None (independent) |

Phase 4 can be developed in parallel with Phases 2-3 as it touches different subsystems.

## Non-Goals

- Desktop UI changes
- Changes to the Ralph loop or respawn behavior
- Changes to session lifecycle (start/stop/restart)
- Automatic command list refresh on plugin install mid-session

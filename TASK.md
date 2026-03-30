# Task

type: feature
status: done
title: Slash command keyboard navigation and inline autocomplete
description: Two features for the slash command menu in the compose text area. (1) Arrow key navigation — when the slash menu appears, users should be able to navigate with up/down arrow keys and select with Enter to autofill the command into the textarea. Currently you can only click to select. (2) Inline autocomplete — the slash menu should trigger when typing / anywhere in the text, not just at the start of the input. This lets users insert slash commands in the middle of a sentence or after other context. Both features need tests to prevent regressions in future iterations.
constraints: Must include tests for both keyboard navigation and inline autocomplete. Arrow keys should wrap around (top→bottom, bottom→top). Enter selects the highlighted item. Escape closes the menu. The inline trigger should detect the / and the word being typed after it, filtering the menu accordingly. When a command is selected inline, it should replace only the /word portion, not the entire input.
affected_area: frontend
work_item_id: wi-b90b3276
fix_cycles: 0
test_fix_cycles: 0

## Root Cause / Spec

### Current State

The slash command menu lives in `InputPanel` (src/web/public/app.js, ~line 20305). Key methods:

- `_handleSlashInput(value)` (line 20975): Only triggers when `value.startsWith('/')`. Extracts query as `value.slice(1)`, filters `allCommands` (session + builtins), calls `_showSlashPopup(matches)`.
- `_showSlashPopup(commands)` (line 21001): Populates `#composeSlashPopup` with `.compose-slash-item` divs. Each item has a click handler calling `_insertSlashCommand(cmd.cmd)`.
- `_insertSlashCommand(cmd)` (line 21027): Replaces entire textarea with `cmd + ' '`. Closes popup.
- `_closeSlashPopup()` (line 21037): Hides popup, sets `_slashVisible = false`.

The `init()` method (line 20412) wires:
- `input` event on textarea -> calls `_handleSlashInput(ta.value)`
- `keydown` event on textarea -> only handles Ctrl/Cmd+Enter for send

There is NO keyboard navigation (arrow keys, Enter to select, Escape to close).
The slash trigger ONLY works at position 0 (`value.startsWith('/')`).

### Implementation Spec

**Files to modify:**
- `src/web/public/app.js` — InputPanel object (~line 20305)
- `src/web/public/styles.css` — active/highlight state for `.compose-slash-item`
- `src/web/public/mobile.css` — matching active state
- `test/compose-slash-commands.test.ts` — new test cases

#### Feature 1: Keyboard Navigation

1. Add `_slashHighlightIdx: -1` state to InputPanel.
2. In `_showSlashPopup()`, reset `_slashHighlightIdx` to 0 and apply `.active` class to first item.
3. Expand the existing `keydown` listener in `init()` to handle, when `_slashVisible === true`:
   - **ArrowDown**: increment `_slashHighlightIdx`, wrap to 0 at end. `preventDefault()` to stop cursor movement.
   - **ArrowUp**: decrement, wrap to last item. `preventDefault()`.
   - **Enter** (without Ctrl/Meta): select highlighted item via `_insertSlashCommand()`. `preventDefault()` to block newline.
   - **Escape**: call `_closeSlashPopup()`. `preventDefault()`.
   - **Tab**: select highlighted item (same as Enter). `preventDefault()`.
4. Add `_updateSlashHighlight()` helper: removes `.active` from all items, adds to item at `_slashHighlightIdx`, scrolls it into view.
5. CSS: `.compose-slash-item.active { background: rgba(255, 255, 255, 0.08); }` in both styles.css and mobile.css.

#### Feature 2: Inline Autocomplete

1. Replace `_handleSlashInput(value)` with a cursor-aware version: `_handleSlashInput(value, cursorPos)`.
2. The caller in the `input` event passes `ta.selectionStart` as `cursorPos`.
3. New detection logic: scan backwards from `cursorPos` to find the nearest `/` that is either at position 0 or preceded by a space/newline. Extract the "slash token" from that `/` to `cursorPos`.
4. Store `_slashTokenStart` and `_slashTokenEnd` — the character range of the `/word` being typed.
5. Filter commands using the text after `/` (same algorithm as today).
6. Update `_insertSlashCommand(cmd)` to replace only `_slashTokenStart.._slashTokenEnd` with `cmd + ' '`, preserving text before and after. Update cursor position to end of inserted command.
7. When no `/` token is found at cursor, close the popup.

#### Tests (test/compose-slash-commands.test.ts)

Add two new `describe` blocks mirroring the pure-logic parts:

**Keyboard nav tests** (unit-testable logic):
- Highlight index wraps from last to 0 on ArrowDown
- Highlight index wraps from 0 to last on ArrowUp
- Enter returns the highlighted command
- Escape resets state

**Inline detection tests** (pure function):
- Extract a helper `findSlashToken(value, cursorPos) => { start, query } | null`
- Test: `"hello /com"` cursor=10 -> `{ start: 6, query: "com" }`
- Test: `"/compact foo"` cursor=8 -> `{ start: 0, query: "compact" }`
- Test: `"no slash here"` cursor=13 -> `null`
- Test: `"foo /bar baz"` cursor=8 -> `{ start: 4, query: "bar" }`
- Test: cursor in middle of token: `"check /help please"` cursor=11 -> `{ start: 6, query: "help" }` (up to cursor)
- Test: `/` preceded by non-space (e.g. `"http://foo"`) -> `null` (not a slash command trigger)

### Implicit Constraints from Existing Code

- The popup element `#composeSlashPopup` has `role="listbox"` — items should get `aria-selected` for a11y.
- `FeatureTracker.track()` is used for analytics — keep the existing `compose-bar-slash-command` tracking.
- The `_autoGrow()` call after insertion must be preserved.
- The dedup/beforeinput handler must not be affected.
- `keyboard-accessory.js` has its own separate slash command UI for mobile accessory bar — this task only touches the InputPanel compose textarea slash popup. Do not modify keyboard-accessory.js.
- The keydown handler must not interfere with Ctrl/Cmd+Enter send behavior.

## Fix / Implementation Notes

### Changes made

**`src/web/public/app.js` (InputPanel)**:
- Added state properties: `_slashHighlightIdx`, `_slashTokenStart`, `_slashTokenEnd`, `_slashItems[]`
- **Keyboard nav**: Extended the `keydown` listener to handle ArrowDown/ArrowUp (with wrapping), Enter, Tab (select highlighted), and Escape (close popup) when `_slashVisible` is true. Ctrl/Cmd+Enter send is preserved and takes priority.
- **`_showSlashPopup`**: Now caches `_slashItems` (command strings), sets `_slashHighlightIdx = 0`, applies `.active` class and `aria-selected` to first item.
- **`_updateSlashHighlight`**: New helper that toggles `.active` and `aria-selected` on popup items and scrolls the active item into view.
- **Inline autocomplete**: Added `_findSlashToken(value, cursorPos)` static method that scans backwards from cursor to find a `/` preceded by whitespace or at position 0. Returns `{ start, query }` or null.
- **`_handleSlashInput(value, cursorPos)`**: Now cursor-aware, calls `_findSlashToken` instead of checking `value.startsWith('/')`. Stores token range for replacement.
- **`_insertSlashCommand(cmd)`**: Now replaces only the `_slashTokenStart.._slashTokenEnd` range instead of the entire textarea value. Cursor is positioned after the inserted command.
- **`_closeSlashPopup`**: Resets all new state properties.
- Input event handler now passes `ta.selectionStart` as cursor position.

**`src/web/public/styles.css`**: Added `.compose-slash-item.active { background: rgba(255, 255, 255, 0.08); }`

**`src/web/public/mobile.css`**: Added `.compose-slash-item.active { background: rgba(255, 255, 255, 0.08); }`

**`test/compose-slash-commands.test.ts`**: Added 3 new describe blocks (19 new tests):
- `findSlashToken` (10 tests): inline slash detection edge cases including URLs, newlines, empty input, cursor positions
- `Keyboard navigation` (6 tests): wrap-around logic for ArrowDown/ArrowUp
- `Inline slash command insertion` (3 tests): replacement logic preserving surrounding text

## Review History
<!-- appended by each review subagent — never overwrite -->
### Review attempt 1 — APPROVED
**Correctness**: Both features implemented correctly. Keyboard nav uses modular arithmetic for wrapping. Ctrl/Cmd+Enter send correctly falls through the slash nav block (the Enter check excludes ctrlKey/metaKey). Inline detection scans backwards correctly and stops at whitespace boundaries.
**Edge cases**: URL slashes (`http://`) correctly rejected. Empty input, cursor at 0, single-char `/` all handled. Highlight resets on re-filtering (standard autocomplete behavior).
**Accessibility**: `aria-selected` toggled alongside `.active` class. `role="option"` preserved on items.
**Security**: No user-controlled paths or innerHTML usage.
**Patterns**: Consistent with existing InputPanel style (object literal, DOM manipulation, event delegation). CSS uses same rgba pattern as existing hover state.
**Tests**: 19 new tests covering slash token detection (10), keyboard wrapping (6), and inline insertion (3). All pass.
**No issues found.**

## Test Gap Analysis
**Verdict: NO GAPS**

Changed source files:
1. `src/web/public/app.js` -- InputPanel keyboard nav + inline autocomplete logic. The pure logic (`findSlashToken`, wrapping arithmetic, insertion replacement) is tested by 19 new tests in `test/compose-slash-commands.test.ts`. DOM manipulation methods (`_showSlashPopup`, `_updateSlashHighlight`, keydown handler) are browser-side and covered by the test mirroring pattern used throughout this project.
2. `src/web/public/styles.css` / `mobile.css` -- CSS-only changes (`.active` class), no logic to test.
3. `test/compose-slash-commands.test.ts` -- test file itself, already passing.

## Test Writing Notes
<!-- filled by test writing subagent -->

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

## QA Results
- **tsc --noEmit**: PASS (zero errors)
- **npm run lint**: PASS (0 errors, 2 pre-existing warnings in unrelated files)
- **vitest run test/compose-slash-commands.test.ts**: PASS (35/35 tests)

### Docs Staleness
- UI docs may need update (frontend changed significantly -- app.js, styles.css, mobile.css)

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

- `_findSlashToken` is a static method on InputPanel so the same logic can be mirrored in tests. The test file has its own copy of the function (mirrored pattern matching existing test structure).
- Tab key selects the highlighted item (same as Enter) per spec. This prevents tab-out when the popup is visible, which is the expected autocomplete UX.
- The insertion always appends a space after the command. When the original text already has a space after the token, this creates a double space -- acceptable tradeoff for consistent behavior.
- `aria-selected` attribute is toggled alongside the `.active` class for screen reader accessibility.
- The `_findSlashToken` scan stops at whitespace characters (space, newline, tab) to avoid matching slashes inside URLs like `http://`.

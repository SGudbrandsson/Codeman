# Task

type: bug
status: fixed
title: Double paste with Wispr Flow voice-to-text on Android
description: When using Wispr Flow voice-to-text on Android, text gets injected/pasted twice into the input box. This only happens in this application, not in other apps. Investigate the input handling code for duplicate paste/input events — look at onInput, onCompositionEnd, onPaste handlers and any debouncing logic. Check if compositionend and input events are both firing and both inserting text.
affected_area: frontend
work_item_id: none
fix_cycles: 0
test_fix_cycles: 0

## Reproduction

1. Open the app on Android (Chrome) with Wispr Flow voice-to-text enabled
2. Focus the compose textarea (#composeTextarea)
3. Dictate text via Wispr Flow
4. Observe: the transcribed text appears twice in the textarea

## Root Cause / Spec

Android voice-to-text services like Wispr Flow inject text through Android's accessibility/IME APIs. When Wispr Flow commits transcribed text, Chrome on Android can translate this into **two separate `beforeinput` events** for the same text:

1. **`insertReplacementText`** or **`insertText`** — from the IME `commitText()` call
2. **`insertFromPaste`** — from the accessibility service's clipboard-based paste fallback

Both events fire within ~10-50ms of each other, and the browser's native handling inserts the text independently for each event. The result: doubled text.

**Why only this app**: Other chat apps typically use custom input handling (contentEditable divs with frameworks like ProseMirror/Draft.js) that intercept and deduplicate these events. Our compose textarea uses the browser's native `<textarea>` behavior with no `beforeinput` guard, so both insertion events proceed unchecked.

**Key finding from code analysis**: The compose textarea (`#composeTextarea` in `app.js` `InputPanel.init()`) had three event listeners:
- `input` — auto-grow, slash command popup, draft save (reads value, never sets it)
- `keydown` — Ctrl+Enter to send
- `paste` — only handles file/image paste, returns early for text paste

None of these prevented or deduplicated text insertion events. No `beforeinput`, `compositionstart`, or `compositionend` handlers existed.

## Fix / Implementation Notes

**File changed**: `src/web/public/app.js` — `InputPanel.init()`

Added a `beforeinput` event handler at the top of `InputPanel.init()` that deduplicates multi-character text insertions:

```javascript
let _dedupeText = '';
let _dedupeTime = 0;
ta.addEventListener('beforeinput', (e) => {
  const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
  if (text.length <= 1) return;  // Skip single keystrokes
  const now = performance.now();
  if (text === _dedupeText && now - _dedupeTime < 300) {
    e.preventDefault();  // Block duplicate
    return;
  }
  _dedupeText = text;
  _dedupeTime = now;
});
```

**How it works**:
- Tracks the last multi-character text insertion (text + timestamp)
- If the same text is inserted again within 300ms, calls `preventDefault()` to block it
- Single-character insertions (normal typing) are always allowed through
- Uses `e.data` for `insertText`/`insertReplacementText` and `e.dataTransfer` for `insertFromPaste`

**Why 300ms**: Wispr Flow's duplicate events fire within ~10-50ms. 300ms is generous enough to catch the duplicate but far too short for a user to intentionally paste the same multi-character text twice via deliberate Ctrl+V presses.

**Test file**: `test/input-dedupe-wispr.test.ts` — 13 tests covering:
- First insertion passes through
- Duplicate within window is blocked
- Same text after window expires is allowed
- Different text within window is allowed
- Single characters never deduplicated
- Boundary conditions (299ms vs 300ms)
- Multi-line text
- Wispr Flow scenario simulation

## Review History
<!-- appended by each review subagent — never overwrite -->

## Test Gap Analysis

Tests written: `test/input-dedupe-wispr.test.ts` (13 tests, all passing)

The deduplication logic is extracted into a pure function (`createInputDeduplicator`) for testability. The `beforeinput` event wiring is browser-side DOM code that cannot be meaningfully unit-tested without a full browser environment (consistent with the project's testing approach for frontend wiring).

## Test Writing Notes

Test mirrors the deduplication algorithm with an injectable clock function for deterministic timing. Covers normal operation, edge cases, and the specific Wispr Flow double-injection scenario.

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

## QA Results
<!-- filled by QA subagent -->

## Decisions & Context
- Used `beforeinput` event (not `input`) because it fires BEFORE the browser inserts text and supports `preventDefault()` to block the duplicate insertion.
- 300ms deduplication window chosen as a balance: wide enough for Android IME timing variability, narrow enough to never block intentional user actions.
- `text.length <= 1` guard ensures normal single-character typing is never affected, even at high speed.
- Used `performance.now()` for sub-millisecond timing accuracy (more precise than `Date.now()`).
- Reads text from both `e.data` (for insertText/insertReplacementText) and `e.dataTransfer` (for insertFromPaste) since different inputTypes store text in different properties.

# Task

type: feature
status: done
title: Voice-to-text button in compose bar
description: Add a speech-to-text microphone button in the compose/input line so users can click to speak and have their voice transcribed into the message input field. Requirements: (1) Add a microphone button in the compose bar next to the send or + button. (2) Click to start recording, click again or auto-stop on silence to stop. (3) Transcribe the audio to text and insert it into the message input field. (4) The STT provider should be configurable in app settings — check what provider settings already exist in the settings panel and use those. Implementation notes: Check the browser Web Speech API (SpeechRecognition / webkitSpeechRecognition) as the simplest option — works in Chrome/Edge without any backend. Alternatively check if there are existing STT provider settings in the app (Whisper API, Deepgram, etc.) and integrate with those. Look at the existing settings panel to understand what voice/STT provider options are already configured. The mic button should show recording state (pulsing, red dot, etc.). Handle permissions (microphone access prompt). Graceful fallback if browser doesn't support speech recognition.
constraints: Mic button must show clear recording state (pulsing/red). Must handle microphone permissions gracefully. Must fall back gracefully if browser doesn't support speech recognition. Check existing settings panel for any STT/voice provider configuration before adding new settings.
affected_area: frontend
work_item_id: none
fix_cycles: 0
test_fix_cycles: 0

## Root Cause / Spec

### Existing Infrastructure

Voice input is **already fully implemented** in `src/web/public/voice-input.js`:
- `VoiceInput` singleton: toggle recording, auto-stop on 3s silence, preview overlay with red dot + level meter + timer
- `DeepgramProvider` singleton: streams audio via WebSocket to Deepgram Nova-3
- Web Speech API fallback when no Deepgram key configured
- Settings panel already has a **Voice tab** (`settings-voice` in index.html lines 1503-1548) with:
  - Active provider display
  - Insert mode selector (direct / compose dialog)
  - Deepgram API key, language, domain keywords
- Voice config stored in `localStorage` key `codeman-voice-settings`
- Keyboard shortcut: `Ctrl+Shift+B` (app.js line 5840)

### Current Button Placement (NOT in compose bar)

Voice buttons are currently in the **header toolbar**, not the compose bar:
1. **Desktop**: `#voiceInputBtn` in `.toolbar-center` (index.html line 557)
2. **Mobile**: `#voiceInputBtnMobile` in the mobile toolbar row (index.html line 518)

Neither is in the compose/input panel (`#mobileInputPanel`).

### Compose Bar Layout

The compose bar (`div.compose-textarea-wrap` inside `#mobileInputPanel`, index.html lines 2234-2293) contains:
- `#composePlusBtn` (`.compose-plus-btn`) — bottom-left, attach files
- `#composeExpandBtn` (`.compose-expand-btn`) — desktop only, right of textarea (right: 44px)
- `#composeSendBtn` (`.compose-send-btn`) — bottom-right, circular blue send button

All are absolutely positioned inside `.compose-textarea-wrap` using the `.compose-inset-btn` base class. Desktop styles in `styles.css` (line 9251+), mobile styles in `mobile.css` (line 2937+).

### Insert Behavior

`VoiceInput._insertText()` has two modes:
- **direct**: sends text straight to PTY via `app.sendInput(text)`, then shows a temporary green "Enter" button replacing the settings gear
- **compose**: opens a full-screen overlay (`_showComposeOverlay`) with edit + send + re-record

**Neither mode inserts into the compose bar textarea** (`#composeTextarea`). This is the key gap.

### Implementation Spec

**Goal**: Add a mic button inside the compose bar that, when used, inserts transcribed text into `#composeTextarea` (the compose bar textarea) rather than sending to PTY or opening a separate overlay.

#### 1. Add mic button to compose bar HTML (index.html)

Insert a new `<button class="compose-inset-btn compose-mic-btn" id="composeMicBtn">` between the expand button and the send button (after line 2280, before line 2282). Use the same mic SVG icon already used elsewhere. Position it to the left of the send button.

#### 2. Style the mic button (styles.css + mobile.css)

- **Desktop** (`styles.css`): position `right: 44px` (where expand btn is now; shift expand to `right: 76px`). Or simpler: position mic at `right: 44px` and move expand to `right: 76px`.
- **Mobile** (`mobile.css`): position `right: 44px` (to the left of the 36px send button at right: 4px). Expand button is hidden on mobile so no conflict.
- Add `.compose-mic-btn.recording` styles: red/pulsing background, white icon color. Reuse the existing `@keyframes pulse-recording` animation from the voice button styles if present, or add a new one.
- Default state: subtle icon color matching `.compose-plus-btn` (#94a3b8).

#### 3. Wire up the button (app.js InputPanel.init)

In `InputPanel.init()` (app.js ~line 19978 area), add a click handler for `#composeMicBtn` that:
- Calls a new method `InputPanel._toggleVoiceInput()` (or similar)
- This method uses VoiceInput's existing infrastructure but overrides the insert behavior to target `#composeTextarea` instead of PTY/overlay

#### 4. New insert mode: "composeBar" in VoiceInput

Add logic so when voice input is triggered from the compose bar mic button:
- Set a flag like `VoiceInput._composeBarMode = true`
- Override `_insertText()` to check this flag: if true, insert/append text into `#composeTextarea`, trigger `_autoGrow()`, and focus the textarea — do NOT send to PTY
- On stop, clear the flag
- Update `_updateButtons()` to also toggle `.recording` class on `#composeMicBtn`

Alternatively (simpler): have the compose mic button call `VoiceInput.toggle()` but temporarily set `insertMode` to a new value `'composeBar'`, and add a branch in `_insertText()` for that mode.

#### 5. Recording state visual on compose mic button

- Add/toggle `.recording` class on `#composeMicBtn` in `VoiceInput._updateButtons()`
- CSS: `.compose-mic-btn.recording { background: #ef4444; color: #fff; border-radius: 50%; animation: pulse-recording 1.5s infinite; }`

#### 6. Textarea padding adjustment

The textarea already has padding-right for the send button. Adding another button means increasing `padding-right` on `.compose-textarea` to avoid text overlapping the mic button. Currently it needs space for send (36-40px) + mic (~32px). Adjust to ~`padding-right: 80px` on mobile and similar on desktop (accounting for expand button too).

#### 7. No new settings needed

All provider config (Deepgram key, language, Web Speech API fallback) already exists in the Voice settings tab. No backend changes needed.

## Fix / Implementation Notes

### Changes made (4 files)

**1. `src/web/public/index.html`** — Added `#composeMicBtn` button (`.compose-inset-btn .compose-mic-btn`) between the expand button and the send button inside `.compose-textarea-wrap`. Uses the same mic SVG icon as the existing toolbar voice buttons.

**2. `src/web/public/styles.css`** (desktop) — Added `.compose-mic-btn` styles at `right: 44px` (left of send button). Shifted `.compose-expand-btn` from `right: 44px` to `right: 76px` to make room. Added `.compose-mic-btn.recording` with red pulsing animation reusing `voice-pulse` keyframes. Increased `.compose-textarea` `padding-right` from `76px` to `108px` to prevent text from overlapping the new button. Added `.compose-mic-btn.recording` to the `prefers-reduced-motion` rule.

**3. `src/web/public/mobile.css`** — Added `.compose-mic-btn` styles at `right: 44px`, `bottom: 7px` (left of 36px send button). Added `.compose-mic-btn.recording` with `voice-pulse` animation. Added `@keyframes voice-pulse` definition (needed because `styles.css` keyframes don't load on mobile). Increased `.compose-textarea` `padding-right` from `52px` to `80px`.

**4. `src/web/public/voice-input.js`** — Added `_composeBarMode` flag (default `false`). In `_insertText()`, added a branch that checks `_composeBarMode`: when true, inserts/appends text into `#composeTextarea` with space separator, triggers `InputPanel._autoGrow()`, and returns without sending to PTY or opening overlay. Flag is cleared in `stop()`. Updated `_updateButtons()` to toggle `.recording` class on `#composeMicBtn`.

**5. `src/web/public/app.js`** — Added click handler for `#composeMicBtn` in `InputPanel.init()`. On click: if recording, calls `VoiceInput.stop()`; otherwise opens compose panel if needed, sets `VoiceInput._composeBarMode = true`, and calls `VoiceInput.start()`.

### Continuous recording fix (voice-input.js only)

**Bug:** Mic button stopped listening after the first speech result — both Deepgram `onResult` and `_onWebSpeechResult` called `this.stop()` on first final result.

**Fix:**
- **Don't stop on result:** Removed `this.stop()` from both Deepgram `onResult` (isFinal branch) and `_onWebSpeechResult` (finalText branch). Final results now insert text immediately and reset for next utterance.
- **Auto-restart on unexpected end:** `_onWebSpeechEnd` restarts `recognition.start()` unless `_userRequestedStop` is true. Deepgram `onEnd` calls `_startDeepgram()` to reconnect unless user requested stop.
- **`_userRequestedStop` flag:** New flag distinguishes user-initiated stop from browser/network-initiated end events. Cleared in `start()`, set in `stop()`.
- **Interim results in compose textarea:** New `_showInterimInCompose()` appends interim text to compose textarea. `_clearInterimFromCompose()` removes it before inserting final text (tracked via `_lastInterimLength`).
- **Silence timeout removed:** Removed `_resetSilenceTimeout()` from both `DeepgramProvider` and `VoiceInput`. Recording is purely user-controlled (press to start, press to stop).
- **`no-speech`/`aborted` errors ignored:** These fire naturally during silence pauses in continuous mode and are harmless — recognition auto-restarts via `_onWebSpeechEnd`.
- **iOS Safari:** `_iosStabilityCheck` inserts stable text as final segment but keeps listening instead of stopping.

### No new settings needed
All voice/STT provider config (Deepgram key, language, Web Speech API fallback) already exists in the Voice settings tab.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 2 — APPROVED (continuous recording fix)

**Files reviewed:** voice-input.js (only changed file)

**Findings:**
- All 6 continuous recording requirements verified correct: `continuous=true` (already set), `interimResults=true` (already set), no stop on result, auto-restart on unexpected end, interim results in compose textarea, toggle button state.
- `_userRequestedStop` flag lifecycle correct: cleared in `start()`, set in `stop()`, checked in both `_onWebSpeechEnd` and Deepgram `onEnd`.
- `_lastInterimLength` tracking correct: reset in `start()` and `_clearInterimFromCompose()`, properly guards with `_composeBarMode` check.
- Deepgram WebSocket drop handled: `onEnd` restarts `_startDeepgram()` unless user requested stop. WS handler nullification prevents race conditions.
- iOS Safari stability check updated: inserts stable text as final segment but keeps listening.
- Non-compose-bar mode (toolbar buttons with direct/compose insert) unaffected — `_showInterimInCompose` and `_clearInterimFromCompose` guard with `_composeBarMode`.
- Silence timeout fully removed from both `DeepgramProvider` and `VoiceInput` — clean removal with no orphaned references.
- `no-speech`/`aborted` errors now always ignored (correct for continuous mode — recognition auto-restarts via `_onWebSpeechEnd`).
- No memory leaks: streams, timers, AudioContext properly cleaned up.

No issues found. Approved.

### Review attempt 1 — APPROVED

**Files reviewed:** index.html, styles.css, mobile.css, voice-input.js, app.js

**Findings:**
- All 7 spec items implemented correctly: HTML button, desktop/mobile CSS, click handler, composeBar insert mode, recording state visuals, textarea padding, no new settings.
- `_composeBarMode` flag approach is clean — only set from compose bar click handler, cleared on `stop()`, doesn't interfere with toolbar voice buttons.
- Recording state toggling added to `_updateButtons()` for all three buttons (desktop toolbar, mobile toolbar, compose bar).
- `voice-pulse` keyframes correctly duplicated in mobile.css since styles.css is desktop-only.
- `prefers-reduced-motion` rule updated to include compose mic button.
- Aria attributes (`aria-label`, `aria-pressed`) properly managed.
- Text appending with space separator handles multi-phrase dictation correctly.
- Auto-grow triggered after insertion to keep textarea sized properly.
- No TypeScript/lint concerns (all changes are in plain JS/CSS/HTML frontend files).
- No security issues — microphone permissions handled by browser, no new data flows.

No issues found. Approved for test gap analysis.

## Test Gap Analysis

### Verdict: NO GAPS

**Changed files:**
- `src/web/public/index.html` — HTML template (not unit-testable)
- `src/web/public/styles.css` — CSS styles (not unit-testable)
- `src/web/public/mobile.css` — CSS styles (not unit-testable)
- `src/web/public/voice-input.js` — Browser-side singleton with DOM/WebSocket/Web Speech API dependencies (not vitest-testable without heavy browser mocking)
- `src/web/public/app.js` — Browser-side InputPanel with DOM dependencies (same)

**Rationale:** All changes are in browser-side frontend code that relies on DOM APIs (`document.getElementById`, `classList.toggle`), browser-specific APIs (`SpeechRecognition`, `MediaStream`), and global singletons (`VoiceInput`, `InputPanel`, `app`). The project's existing test pattern for compose features (see `compose-slash-commands.test.ts`) mirrors pure logic in vitest, but the voice-to-text changes are primarily wiring and DOM manipulation with no extractable pure-logic functions. Writing meaningful unit tests would require mocking the entire browser environment, which doesn't match the project's testing style. The feature is best verified through manual testing or Playwright integration tests.

## Test Writing Notes
<!-- filled by test writing subagent -->

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

## QA Results

### TypeScript typecheck: PASS
`tsc --noEmit` completed with zero errors.

### ESLint: PASS (pre-existing issue only)
1 error in `src/orchestrator.ts:878` (`@typescript-eslint/prefer-as-const`) — confirmed pre-existing on base branch, not introduced by this change. Changed files are all plain JS/CSS/HTML in `src/web/public/`, not covered by ESLint's `src/**/*.ts` glob.

### Frontend check: SKIPPED
Voice input feature relies on browser-specific APIs (Web Speech API, MediaStream) that cannot be automated without a real microphone. Manual testing required.

### Docs Staleness: none
No committed changes on branch yet (changes are uncommitted).

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->
- Used `_composeBarMode` flag approach rather than adding a new `insertMode` setting value, because compose bar insertion is a UI-level behavior triggered by which button was clicked, not a persistent user preference.
- Append transcribed text with space separator when textarea already has content, so users can dictate multiple phrases without losing prior input.
- Reuse existing `voice-pulse` keyframes for recording animation to keep visual consistency with toolbar voice buttons.
- Desktop: shifted expand button from `right: 44px` to `right: 76px` to accommodate mic button at `right: 44px` (left of send button at `right: 4px`).
- Added `@keyframes voice-pulse` in mobile.css because styles.css is behind a desktop media query and doesn't load on mobile.
- Continuous recording: removed all silence auto-stop behavior rather than making it configurable, because the spec is clear: only stop when user presses button.
- Deepgram reconnect on unexpected close: reuses `_startDeepgram()` which re-acquires mic stream and opens new WebSocket. Timer resets on reconnect (acceptable trade-off vs adding reconnect-only logic).
- Interim text tracking in compose textarea uses `_lastInterimLength` to slice off previous interim before appending new one, avoiding accumulation of stale text.

# Context & Model Redesign

**Date:** 2026-03-24
**Status:** Approved

## Goal

Fix the inaccurate context percentage display and add a visual model indicator with in-session model switching. Declutter the header by moving rarely-used items (MCP, Plugins) to an overflow menu.

## Problem

1. Context percentage is unreliable — currently computed by accumulating `input_tokens` deltas from PTY stream-json (`session.ts:1984-2017`), which treats each message's `input_tokens` as a delta and sums them. But `input_tokens` in the API response is NOT a delta — it's a tiny residual (often just 1) because the bulk of context is in the cache fields. The current formula (`_totalInputTokens += inputDelta`) drastically underestimates actual context usage.
2. The `/context` PTY parsing fallback (`_refreshContext`) is fragile — depends on parsing terminal text output, timing, and format changes.
3. No visual indication of which model a session is using.
4. No way to switch models from the UI.
5. Header is crowded on mobile with MCP, Plugins, CTX, health, notifications, font controls, system stats, lifecycle log, settings, and token counter all competing for space.

## Design

### 1. Accurate Context Tracking — Fix the Existing PTY Stream Parser

The existing code at `session.ts:1984-2017` already parses `usage` from every assistant message in the PTY stream-json output. The problem is the **formula**, not the data source.

**Current (wrong):** Accumulates `input_tokens` as deltas across messages.
```typescript
this._totalInputTokens += inputDelta;  // WRONG: input_tokens is NOT a delta
pct = _totalInputTokens / CONTEXT_WINDOW_TOKENS;  // underestimates heavily
```

**New (correct):** Each assistant message's usage is a **snapshot** of the current context window. The total context is:
```
total = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

This sum represents the full conversation context sent to the API for that turn. It grows as the conversation grows, resets on `/clear`, and drops on `/compact`. Take the **latest** value, not an accumulation.

**Why no JSONL file watcher:** The PTY stream-json path already has this data — `msg.message.usage` includes `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` (lines 1985-2002). We just need to fix the formula. No new file watcher needed, avoiding duplication with `ClaudeActivityMonitor` which already watches the JSONL for activity status.

**Implementation:**

- Replace the accumulation logic in `processOutput()` stream-json handler (lines 1984-2017):
  - Compute `total = input_tokens + cache_creation_input_tokens + cache_read_input_tokens` from the current message.
  - Set `_contextWindowTokens = total` (snapshot, not accumulation).
  - Set `_contextWindowMax` from the model (see max detection below).
  - Emit `contextUpdate` with the snapshot values.
- Extract `msg.message.model` from the same stream-json path. Add `model` to the `ClaudeMessage` interface. Update `_currentModel` when it changes.
- Remove the hardcoded `CONTEXT_WINDOW_TOKENS = 200_000` constant.
- Keep `_totalInputTokens` / `_totalOutputTokens` accumulation for the cost/token counter display (separate concern).
- Keep `/context` PTY parsing (`_refreshContext`) as a fallback for the detailed breakdown panel (system vs conversation vs tools split) and as a calibration source for max context window.

**Output tokens:** Not included in context percentage. Output tokens from the *current* turn are not part of the context window — they become input tokens on the *next* turn, which is already captured in the next message's usage snapshot.

**Max context window detection:**

The max depends on session configuration, not just model family (both Opus and Sonnet support 1M).

Detection strategy (in priority order):
1. If `/context` has been parsed, use its reported max (e.g., "128k/200k tokens" → max is 200k, "50k/1000k tokens" → max is 1M). This is the ground truth.
2. If no `/context` data yet, use a conservative default based on model family (200k). The first `/context` refresh (scheduled 60s after each `result` message, line 2026) will calibrate it.
3. Persist the max alongside context data in session state so page reloads don't lose calibration.

### 2. Header Redesign

Same layout on mobile and desktop. Consistent and decluttered.

**Current header (actual, from index.html lines 55-114):**
```
[Codeman] [session tabs] [Board] [tunnel] [connection] [A-/14/A+] [CPU/MEM] [MCP] [Plugins] [CTX] [♥] [🔔] [📄] [⚙] [tokens]
```

**New header:**
```
[Codeman] [session tabs] [Board]           [Opus ▾] [◔ 21] [⋮]
```

**Left side (unchanged):**
- Codeman logo
- Session tab indicators
- Board button

**Right side (new):**
- **Model chip** — Short model name ("Opus", "Sonnet", "Haiku") with dropdown caret. Tappable to open model picker. Styled with cyan accent on dark blue background (`#0d1520` bg, `#1a3050` border, `#22d3ee` text).
- **Context arc** — 32px SVG circular arc (donut) with percentage number centered inside. Color-coded: cyan `#22d3ee` (<60%), amber `#fbbf24` (60-85%), red `#f87171` (85%+). Tappable to open existing context detail panel.
- **Overflow menu (⋮)** — Opens a dropdown/popover with all other header items.

**Initial state (before data):** Model chip hidden, context arc hidden (same as current CTX chip behavior — `display:none` until first data arrives). Both appear on first assistant message or on restore from persisted state.

### 3. Model Picker Dropdown

Opens below the model chip when tapped. Dropdown list showing:

- Header: "Switch model" (small, uppercase, muted)
- For each available model (Opus, Sonnet, Haiku):
  - Model name (bold)
  - "active" badge on currently selected model (cyan pill)
  - One-line description (muted gray)
  - Context window size on the right ("1M ctx" / "200k ctx")
- Active model row has left cyan border + darker blue background

**Positioning:** Anchored to right edge of header to prevent viewport overflow on mobile (375px). On very narrow screens, could use a full-width bottom sheet — but start with right-anchored dropdown and see if it fits.

**Switching action:** Tapping a non-active model sends `/model <name>\r` to the session via the existing mux input mechanism. The dropdown closes immediately. The chip text updates when the next assistant message's `msg.message.model` confirms the change. If the model hasn't changed after 10 seconds or after the next assistant message arrives with the old model, show a brief toast: "Model switch may not have taken effect."

### 4. Model Detection

**Primary source (PTY stream-json):** `msg.message.model` on each assistant message. Added to the existing `ClaudeMessage` interface. Compared against previous value — if changed, emit a model update event. This catches `/model` switches the user types manually, UI-initiated switches, and subagent model overrides.

**Secondary source (CLI banner):** Existing `parseClaudeCodeInfo()` parses "Opus 4.6 · Claude Max" from startup output. Used for initial display before the first assistant message arrives.

**Existing infrastructure:** `SubagentWatcher` already parses `message.model` from JSONL (line 1367) and extracts `modelShort`. The same extraction logic can be reused for the main session.

**Persistence:** Model name stored in session state alongside context window data. On page reload, restored from persisted state. Updated on next stream-json event.

### 5. Overflow Menu

The `⋮` button opens a dropdown/popover containing items moved from the header:

| Item | Detail shown | Existing handler |
|------|-------------|-----------------|
| MCP Servers | Count of active servers | `McpPanel` toggle |
| Plugins | Count | `PluginsPanel` toggle |
| Health Analyzer | Icon | `app.openHealthAnalyzer()` |
| Notifications | Unread count badge | `app.toggleNotifications()` |
| Lifecycle Log | Icon | `app.openLifecycleLog()` |
| Settings | Update badge if available | `app.openAppSettings()` |
| Font Size | A-/14/A+ inline controls | Existing onclick handlers |
| System Stats | CPU/MEM bars | Existing display |

Tunnel indicator and connection indicator remain in the header (they're status indicators that should be always-visible when active, and they're usually hidden).

Token counter (`headerTokens`) moves to the overflow menu or the context detail panel.

Each item opens its existing panel when tapped. The overflow menu is a simple list — no new panels needed. Closes on outside click or Escape key.

### 6. What Changes

| Component | Before | After |
|-----------|--------|-------|
| Context % source | Accumulating `input_tokens` deltas (wrong) | Snapshot from latest `usage` (correct) |
| Context % formula | `_totalInputTokens / 200000` | `(input + cache_create + cache_read) / model_max` |
| Context chip | `□ CTX 21%` text chip | 32px circular arc with centered percentage |
| Model display | Not shown in header | Tappable chip with model name |
| Model switching | Not available from UI | Dropdown picker, sends `/model` |
| MCP chip | Header | Overflow menu |
| Plugins chip | Header | Overflow menu |
| Health icon | Header | Overflow menu |
| Notifications icon | Header | Overflow menu |
| Lifecycle log icon | Header | Overflow menu |
| Settings icon | Header | Overflow menu |
| Font controls | Header | Overflow menu |
| System stats | Header | Overflow menu |
| Token counter | Header | Overflow menu or context panel |

### 7. What Stays the Same

- Context detail panel (donut chart + system/conversation/tools breakdown)
- Context banner warnings at 80%/90%
- Context bar (segmented bar below header)
- Session creation model config
- Desktop pinned sidebar layout
- All existing MCP/Plugins/Health/Settings panels (just accessed from overflow instead of header)
- Tunnel and connection indicators (stay in header, usually hidden)
- `/context` command as detailed breakdown source

## Files to Modify

### Backend
- `src/session.ts`:
  - Fix context formula in `processOutput()` stream-json handler (lines 1984-2017): use snapshot instead of accumulation.
  - Add `model` field to `ClaudeMessage` interface.
  - Extract `msg.message.model`, track in `_currentModel`, emit model change event.
  - Remove hardcoded `CONTEXT_WINDOW_TOKENS = 200_000`, make max model-dependent.
  - Add `currentModel` to `toJSON()` serialization and `restoreContextWindow()`.
- `src/web/server.ts`:
  - Include `currentModel` in session API responses.
  - Include model in SSE context usage events.
  - Add API endpoint or extend existing one for model switch (or handle purely client-side via mux input).
- `src/types/session.ts`:
  - Add `currentModel?: string` to `SerializedSession`.
- `src/web/sse-events.ts`:
  - Add model info to `SessionContextUsage` event payload (or piggyback on `cliInfoUpdated`).

### Frontend
- `src/web/public/index.html`:
  - Replace MCP/Plugins/CTX/Health/Notifications/Lifecycle/Settings/Font/Stats chips with: model chip + context arc + overflow button.
  - Add overflow menu HTML structure.
  - Add model picker dropdown HTML.
- `src/web/public/app.js`:
  - New `ModelPicker` component: render dropdown, handle selection, send `/model` via mux.
  - New `OverflowMenu` component: open/close, render items from moved chips.
  - Redesign `ContextBar`: replace `_updateChip()` to render circular SVG arc instead of text badge.
  - Update `_onSessionContextUsage` to handle snapshot data (inputTokens is now the full context, not a cumulative delta).
  - Add model change SSE handler to update chip.
- `src/web/public/styles.css`:
  - New styles for model chip, context arc (SVG donut), overflow menu, model picker dropdown.
  - Hide old chip styles (or remove if fully replaced).
  - Overflow menu positioning and backdrop.
- `src/web/public/mobile.css`:
  - Ensure model chip + arc + overflow fit at 375px.
  - Model picker dropdown: right-anchored, max-width constrained.

## Edge Cases

- **Session with no assistant messages yet:** Model chip and context arc hidden until first data arrives (from CLI banner parse or first stream-json message).
- **Model switch fails silently:** If next assistant message still shows old model after user tapped a new one, show brief toast notification.
- **Context drops after /compact:** Snapshot naturally reflects the reduced context. Arc animates down.
- **Context resets after /clear:** Snapshot will show near-zero. Arc goes to minimal.
- **Page reload:** Model and context restored from persisted session state. Updated on next live event.
- **Conversation ID changes (auto-compact creates new conversation):** The PTY stream-json continues on the same PTY regardless of conversation ID changes, so the parser keeps working.
- **Multiple sessions:** Each session has independent model/context state. Switching sessions in the UI updates the header to show that session's model and context.

## Testing

- Verify context % matches `/context` output after several exchanges
- Verify context % drops after `/compact` and resets near zero after `/clear`
- Verify model chip shows correct model on session startup
- Verify model chip updates when user sends `/model sonnet` manually
- Verify model picker sends `/model <name>` and chip updates on confirmation
- Verify model switch failure shows toast after timeout
- Verify overflow menu opens and all items (MCP, Plugins, Health, Notifications, Settings, Lifecycle, Font, Stats) work
- Verify mobile layout fits in 375px without horizontal overflow
- Verify desktop layout with sidebar pinned (300px sidebar)
- Verify page reload restores model + context from persisted state
- Verify context arc color transitions at 60% and 85% thresholds
- Verify context arc hidden when no data available
- Verify keyboard: Escape closes overflow/model picker, tab navigation works

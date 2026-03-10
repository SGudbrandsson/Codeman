# Context Window Visualization — Design

**Date**: 2026-03-10
**Branch**: feat/ui-overhaul

## Overview

Three complementary UI components that give users a clear, always-visible picture of context window usage per session:

- **A — Stacked context bar**: 3px bar in session header, segments by category
- **C — 80% warning banner**: dismissible amber banner when context is nearly full
- **D — Context chip + detail panel**: on-demand breakdown panel (like Plugins/MCP)

---

## Architecture & Data Flow

### Three-layer system

**Layer 1 — Passive token tracking**
Claude's JSON result messages include `usage.input_tokens`. `session.ts` extracts this on every result message and emits a `ContextUsage` SSE event immediately. No extra commands needed.

**Layer 2 — Background `/context` refresh**
Every ~60s while the session is idle (after the last completion), `session.ts` sends `/context` via `writeViaMux()` and parses the structured text output for full category breakdown: system / conversation / tools / total / max. Emits an enriched `ContextUsage` event with per-category data. Cancelled on session stop.

**Layer 3 — Frontend state**
`app.js` stores the latest `ContextUsage` per session in a Map. On update: re-renders bar, evaluates banner threshold, updates panel if open.

### New SSE event

Add to `src/web/sse-events.ts`:

```typescript
ContextUsage: {
  sessionId: string;
  pct: number;           // 0–100, derived from inputTokens / maxTokens
  inputTokens: number;
  maxTokens: number;
  system?: number;       // tokens — present after /context refresh
  conversation?: number;
  tools?: number;
}
```

### Context window size lookup

Small map in `session.ts` keyed by model ID prefix. All current Claude models: 200k tokens. Fallback: 200k.

---

## UI Components

### A — Stacked context bar

- **Position**: 3px tall bar spanning full width of session header, directly below the existing header border
- **Segments** (proportional widths, smooth 0.4s transition):
  - System: `#c084fc` (purple)
  - Conversation: `#22d3ee` (cyan)
  - Tools: `#fbbf24` (amber)
  - Free: `#1e293b` (dark)
- **Before breakdown data**: single cyan segment showing total fill only
- **Hidden**: when no context data yet for session

### C — Warning banner

- **Trigger**: `pct >= 80`, slides down into session area (32px, `transform: translateY` animation)
- **Re-trigger**: at 90% even if dismissed at 80%
- **Appearance**: amber background `rgba(251,191,36,0.12)`, amber top border
- **Content**: `"Context ~{pct}% full — consider /clear"` + `[Clear]` button + `[×]` dismiss
- **[Clear]** button sends `/clear` to the session via existing writeViaMux API

### D — Context chip + detail panel

**Chip (`#ctxChipBtn`)**:
- Position: session header, right of Plugins chip
- Label: `CTX`, badge shows `{pct}%`
- Color states (CSS classes): green <60%, amber 60–85%, red >85%

**Panel (`#contextPanel`)**:
- 300px wide, slides in from right, `z-index: 602` (above Plugins at 601)
- Opening closes MCP and Plugins panels
- Three sections:
  1. **Donut arc**: SVG arc showing total fill, `{pct}%` in center
  2. **Breakdown table**: System / Conversation / Tools / Free — token counts + percentages
  3. **Suggestions**: "At 90%+ consider `/clear` or `/compact`"

---

## Backend Changes

### `src/session.ts`

1. **Passive tracking**: In `processOutput()`, when a result message with `usage.input_tokens` is parsed, emit `ContextUsage` SSE event (pct = inputTokens / maxTokens × 100).

2. **`_refreshContext()` method**: Sends `/context` via `writeViaMux()`, watches next ~10 output lines for context report, parses with regex (`System:\s+([\d,]+)` etc.), emits enriched `ContextUsage`.

3. **Background timer**: Fires `_refreshContext()` 60s after each session completion if session is still idle. Cleared on session stop.

### `src/web/sse-events.ts`

Add `ContextUsage` event.

### `src/web/routes/system-routes.ts`

Add `GET /api/sessions/:id/context` — triggers immediate `_refreshContext()`, returns the result. Used when the context panel opens for fresh on-demand data.

---

## Frontend Changes

### `app.js` — `ContextBar` singleton (~250 lines)

| Method | Purpose |
|--------|---------|
| `init()` | Grab DOM refs, register SSE listener, chip click handler |
| `onContextUsage(data)` | Update Map, call render methods |
| `_updateBar(sessionId)` | Animate segment widths (current session only) |
| `_checkBanner(data)` | Show/re-show banner at 80% / 90% thresholds |
| `_updateChip(data)` | Update badge text and color class |
| `open(sessionId)` | Close MCP+Plugins, fetch fresh data, render panel |
| `close()` | Slide panel out |

### `index.html`

- `#ctxChipBtn` — chip after `#pluginsChipBtn`
- `#contextBar` — 3px bar inside session header
- `#contextBanner` — 32px dismissible banner inside session content
- `#contextPanel` — 300px slide-in panel

### `styles.css`

New `/* ── Context Bar ──` section:
- Bar segment transitions, color variables
- Banner slide-down animation
- Chip color state classes (`.ctx-green`, `.ctx-amber`, `.ctx-red`)
- Panel styles matching Plugins/MCP pattern

**Version bumps**: `styles.css?v=0.1682`, `app.js?v=0.4.93`

---

## Visual Design

| Element | Value |
|---------|-------|
| Bar height | 3px |
| System segment | `#c084fc` (purple) |
| Conversation segment | `#22d3ee` (cyan) |
| Tools segment | `#fbbf24` (amber) |
| Free segment | `#1e293b` (dark) |
| Chip green | `#4ade80` (<60%) |
| Chip amber | `#fbbf24` (60–85%) |
| Chip red | `#f87171` (>85%) |
| Banner bg | `rgba(251,191,36,0.12)` |
| Panel z-index | 602 |
| Bar transition | 0.4s ease |
| Banner animation | `translateY(-100%)` → `translateY(0)`, 0.25s |

---

## Out of Scope

- Per-model max token configuration (all current models use 200k)
- Historical context usage graphs
- Automatic `/compact` triggering (just suggest it)
- Context usage alerts/notifications

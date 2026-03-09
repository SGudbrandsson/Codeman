# Transcript Web View — Design Document

Date: 2026-03-09
Branch: feat/ui-overhaul
Status: **Approved — ready for implementation**

---

## Overview

Replace the raw xterm.js terminal rendering for Claude Code sessions with a structured, beautiful web view that parses the Claude Code JSONL transcript file and renders conversation history as rich markdown with foldable tool-use blocks. A toggle in the accessory bar switches between web view and terminal view per session.

Core goal: reduce UI freezes caused by xterm rendering high-frequency PTY output, while presenting session activity in a far more readable format. Input still flows through the existing compose bar → xterm → tmux pipeline unchanged.

---

## User Experience

### Toggle

A mode button in the bottom accessory bar (visible only on Claude Code sessions, not shell):
- **Web mode**: `✦` sparkle icon, tooltip "Switch to terminal view"
- **Terminal mode**: `⌨` terminal icon, tooltip "Switch to web view"

State is stored in `localStorage` keyed by `sessionId`. New sessions default to web view for Claude Code sessions.

### Web View Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  You                                              10:42 AM       │
│  Can you refactor the auth middleware?                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Claude                                           10:42 AM       │
│                                                                  │
│  Sure! Here's the plan:                                          │
│                                                                  │
│  - Extract token validation into a helper                        │
│  - Move rate limiting to a separate middleware                   │
│                                                                  │
│  ▶  Read  ·  src/web/middleware/auth.ts           [collapsed]    │
│  ▶  Bash  ·  tsc --noEmit                        [collapsed]    │
│                                                                  │
│  Here's the updated file:                                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ typescript                                               │    │
│  │ export function validateToken(token: string) { … }      │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘

  ✓  Completed  ·  $0.042  ·  2m 14s
```

### Block Rendering

- **User blocks**: Right-aligned label "You", plain text, subtle background
- **Assistant text blocks**: Markdown rendered — headings, bold, italic, lists, inline code, fenced code blocks with syntax highlighting
- **Tool use + result**: Fused into a single collapsible row `▶ ToolName · key-input-arg`. Collapsed by default. Click expands to show full input JSON and output content. Error results styled in red. Truncated at 10 KB when expanded, with a "Show full output" link.
- **Result block**: Subtle footer line — cost, duration, success/error status
- **Per-block pop-in**: Each block renders as it completes (one JSONL entry at a time). Auto-scrolls to bottom unless user has scrolled up.

---

## Architecture

### Data Flow

```
Claude Code JSONL file  (~/.claude/projects/{hash}/{sessionId}.jsonl)
       ↓  tail-watch (existing TranscriptWatcher)
TranscriptWatcher
       ├─→  SSE: transcript:block   { sessionId, block: Block }   [NEW]
       └─→  SSE: transcript:clear   { sessionId }                 [NEW — on respawn]

GET /api/sessions/:id/transcript                                   [NEW REST endpoint]
       → reads + parses full JSONL, returns Block[]

Frontend (per-session):
  viewMode: 'terminal' | 'web'    (localStorage by sessionId)
  blocks: Block[]                  (REST load + SSE deltas)
  xterm: attached | detached       (destroyed on web mode, re-created on terminal mode)
```

### Block Wire Format

```typescript
type Block =
  | { type: 'text';        role: 'user'|'assistant'; text: string;     timestamp: string }
  | { type: 'tool_use';    name: string; input: Record<string,unknown>; id: string; timestamp: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; timestamp: string }
  | { type: 'result';      cost?: number; durationMs?: number; error?: string; timestamp: string }
```

The REST endpoint reads the JSONL and maps to this flat array. SSE emits one event per new block.

---

## Backend Changes

### 1. Extend `TranscriptWatcher` (`src/transcript-watcher.ts`)

Add `transcript:block` event emission when a new JSONL entry is parsed. Emit `transcript:clear` when the watcher is reset (respawn). Existing events and `lastAssistantMessage` truncation are untouched — additive only.

### 2. New SSE events (`src/web/sse-events.ts`)

```typescript
export const TranscriptBlock = 'transcript:block';   // { sessionId, block }
export const TranscriptClear = 'transcript:clear';   // { sessionId }
```

### 3. New REST endpoint

`GET /api/sessions/:id/transcript` — reads `session.transcriptPath` (already stored on session when hook fires), parses all JSONL lines, returns `Block[]`. Returns `[]` if no transcript yet. Added to `src/web/routes/` as part of the sessions route group.

### 4. `constants.js`

Add `TranscriptBlock` and `TranscriptClear` to the `SSE_EVENTS` frontend constant.

**Files changed:** `src/transcript-watcher.ts`, `src/web/sse-events.ts`, `src/web/routes/sessions-routes.ts` (or new file), `src/web/public/constants.js`

---

## Frontend Changes

### `TranscriptView` singleton (`app.js`)

Manages the `<div class="transcript-view">` container. Responsibilities:
- `load(sessionId)` — fetches `GET /api/sessions/:id/transcript`, renders all blocks
- `append(block)` — renders a single new block, scrolls to bottom (unless `scrolledUp`)
- `clear()` — empties block list, reloads via `load()`
- `show()` / `hide()` — toggles visibility; show also detaches xterm, hide re-attaches xterm

Per-session state stored in `app._transcriptState[sessionId]`:
```js
{ viewMode: 'terminal'|'web', blocks: Block[], scrolledUp: boolean }
```

### Markdown + syntax highlighting

Markdown rendered via a small inline parser (no new deps). Fenced code blocks highlighted via `highlight.js` (already vendored at `src/web/public/vendor/`).

### Accessory bar toggle button

New button added to `KeyboardAccessoryBar`. Visible only when active session type is `claude` (not `shell` or `opencode`). Calls `TranscriptView.show()` / `.hide()` and saves to localStorage.

### xterm lifecycle

- **Switch to web**: call `term.dispose()`, remove xterm DOM element. Keep the pty/session alive server-side.
- **Switch to terminal**: re-create `Terminal`, re-attach to DOM, call `term.write(bufferedOutput)` with buffered output since detach (server already buffers last N bytes), re-fit.

### Scroll anchor

On each `append()`, if `scrolledUp === false`, scroll the transcript container to `scrollTop = scrollHeight`. A `scroll` event listener sets `scrolledUp = true` when the user is >100px from the bottom; resets to `false` when they scroll back down.

### SSE reconnect

On reconnect, re-fetch `GET /api/sessions/:id/transcript` and re-render from scratch. No deduplication complexity needed.

**Files changed:** `src/web/public/app.js`, `src/web/public/keyboard-accessory.js`, `src/web/public/styles.css` (or `mobile.css`), `src/web/public/index.html` (new transcript-view div)

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| No transcript yet | REST returns `[]`; show "Waiting for Claude to start…" placeholder |
| JSONL unreadable | REST returns `[]` + error flag; show subtle warning banner |
| Session respawns | `transcript:clear` SSE → clear + re-fetch |
| SSE reconnect | Re-fetch full transcript via REST, re-render from scratch |
| Very long sessions | `content-visibility: auto` on each block for off-screen paint skipping |
| Tool result > 10 KB | Truncated in expanded view; "Show full output" link loads rest |
| Shell/OpenCode sessions | Toggle button hidden; web view never activates |

---

## Testing (Playwright)

1. Load page in web view mode — confirm transcript renders, xterm not visible
2. Switch to terminal view — confirm xterm re-attaches and renders
3. Simulate `transcript:block` SSE event — confirm block appends and scrolls
4. Expand a tool use row — confirm input + output appear
5. Scroll up, trigger new block — confirm auto-scroll does NOT fire
6. Scroll back to bottom — confirm auto-scroll resumes

---

## Open Questions (all resolved)

- ✅ Live update granularity: per-block (Option A)
- ✅ Toggle location: accessory bar (Option B)
- ✅ Tool use display: collapsed by default (Option A)
- ✅ xterm on web view switch: detached/destroyed (Option B)
- ✅ View preference scope: per-session (Option A)
- ✅ Data delivery: REST initial load + SSE incremental (Option C)

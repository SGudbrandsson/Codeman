# Session–Transcript Sync Design

**Date:** 2026-03-17
**Status:** Approved
**Problem:** The transcript view displays the wrong session (a stale, archived, or unrelated session) in all lifecycle scenarios: server restart, SSE reconnect, session clear, archive, and respawn. This happens because the frontend trusts a stale `localStorage` key as the primary source of truth for which session to display, and no backend mechanism exists to correct it.

---

## Root Cause Analysis

### Primary cause: `localStorage` as sole session identity source
On every `handleInit` (page load, SSE reconnect), the frontend restores the active session via:
1. In-memory `previousActiveId`
2. `localStorage.getItem('codeman-active-session')`
3. `this.sessionOrder[0]`

After a server restart, `localStorage` holds a session ID that no longer exists in the server's session store. The code correctly checks `this.sessions.has(restoreId)` and falls through to `sessionOrder[0]` — but `sessionOrder[0]` is an arbitrary ordering, not the session the user was working in.

### Secondary cause: no backend-persisted "active session" pointer
The server has no record of which session was last active. It cannot authoritatively answer "which session should the frontend show right now?". The frontend is flying blind.

### Tertiary cause: clear/archive race condition (minor)
`_onSessionCleared` sets `_pendingClearSwitchTo` and waits for `session:created` SSE. If `session:created` arrived before `session:cleared` (possible under SSE reordering), the pending switch is never set, and no auto-switch happens. The existing guard (`this.sessions.has(newSessionId)`) handles this, but the deferred path has no timeout fallback — a missed event leaves the frontend stuck on the archived session indefinitely.

---

## Solution Overview

Two phases, delivered in a single feature branch:

- **Phase 1** — Backend-authoritative active session: backend tracks which session is active, frontend asks the backend on every reconnect instead of trusting `localStorage`.
- **Phase 2** — Screen snapshot analysis: a tmux-based screen capture + parser that classifies what Claude is doing right now, used as a verification layer and exposed as a standalone API.

---

## Architecture

### New modules

#### `src/session-resolver.ts`
Single-responsibility: given the current session map and a list of live tmux sessions, return the best candidate for the active session.

```typescript
export interface ResolvedSession {
  sessionId: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  source: 'persisted' | 'tmux-verified' | 'activity-timestamp' | 'fallback';
}

export async function resolveActiveSession(params: {
  persistedActiveId: string | null;
  sessions: Map<string, SessionState>;
  liveTmuxNames: Set<string>;        // from tmuxManager.listAllTmuxSessions()
}): Promise<ResolvedSession>
```

Priority order:
1. `persistedActiveId` if non-null AND session exists AND has a live tmux session → `confidence: high, source: persisted`
2. Non-archived sessions with live tmux sessions, sorted by `lastActivityAt` descending → `confidence: medium, source: tmux-verified`
3. Non-archived sessions sorted by `lastActivityAt` descending (no tmux check) → `confidence: low, source: activity-timestamp`. Note: `lastActivityAt` is a required field on `SessionState` so all live sessions have it; step 4 is only reachable if the session store contains sessions from a very old state file written before `lastActivityAt` was introduced.
4. Any non-archived session (no timestamp available) → `confidence: low, source: fallback`
5. No sessions → `{ sessionId: null, confidence: 'none' }`

#### `src/screen-analyzer.ts`
Captures the **current visible screen** of a tmux pane (not scrollback) and parses it.

```typescript
export type ClaudeScreenState =
  | 'waiting_for_input'    // ❯ prompt visible
  | 'asking_question'      // y/n or numbered options visible
  | 'running_tool'         // tool execution in progress (Bash, Read, Write, etc.)
  | 'thinking'             // spinner or "Thinking..." visible
  | 'completion'           // "Worked for Xm Xs" visible
  | 'shell_prompt'         // $ or % prompt, Claude not present
  | 'unknown';             // no recognizable pattern

export interface ScreenAnalysis {
  state: ClaudeScreenState;
  lastVisibleText: string;    // last non-empty line, ANSI stripped
  hasClaudePresence: boolean; // true if any Claude-specific pattern found
  questionText?: string;      // set when state === 'asking_question'
  optionLines?: string[];     // set when state === 'asking_question'
  confidence: number;         // 0–100
}

export function captureScreen(muxName: string): string | null;  // tmux capture-pane, no -S flag (current screen only)
export function analyzeScreen(rawScreen: string): ScreenAnalysis;
export function stripAnsi(raw: string): string;
```

**All patterns are applied to ANSI-stripped text.** `stripAnsi` must be called on the raw screen before any pattern matching. This ensures patterns work correctly regardless of color codes or bold markers between characters.

Detection patterns (in priority order, applied after ANSI stripping):
1. `COMPLETION_PATTERN`: `/Worked for \d+[hms]/` → `completion`
2. `TOOL_PATTERN`: `/⏺\s+(?:Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|TodoWrite|Agent)\(/` → `running_tool`
3. `QUESTION_PATTERN`: `/\[y\/n\]|\[Y\/n\]|\(y\/n\)/i` or numbered option list (`/^\s*\d+\.\s+\w/m`) → `asking_question`
4. `THINKING_PATTERN`: spinner chars (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) or `/Thinking/i` → `thinking`
5. `CLAUDE_PROMPT_PATTERN`: `❯` or `\u276f` → `waiting_for_input`
6. `SHELL_PROMPT_PATTERN`: `/[$%#]\s*$/m` → `shell_prompt`
7. None of the above → `unknown`

---

### Backend changes

#### State store: persist active session ID
Add `activeSessionId: string | null` to `AppState` in `src/types/app-state.ts` (defaults to `null`).

`StateStore` gets two methods:
- `getActiveSessionId(): string | null`
- `setActiveSessionId(id: string | null): void` — triggers debounced save

#### New route file: `src/web/routes/active-session-routes.ts`

**`GET /api/sessions/resolve-active`**

Response:
```json
{ "sessionId": "abc123...", "confidence": "high", "source": "persisted" }
```

Implementation:
1. Load `store.getActiveSessionId()`
2. Call `tmuxManager.listAllTmuxSessions()` to get live tmux names
3. Pass to `resolveActiveSession()`
4. Return result

**`POST /api/sessions/:id/mark-active`**

Body: none required (session ID is in path).
Response: `{ "ok": true }`

Implementation:
1. Verify session exists and is not archived
2. Call `store.setActiveSessionId(id)`

**`GET /api/sessions/:id/screen-snapshot`**

Response (success):
```json
{
  "muxName": "codeman-abc12345",
  "rawScreen": "...",
  "analysis": {
    "state": "waiting_for_input",
    "lastVisibleText": "❯",
    "hasClaudePresence": true,
    "confidence": 95
  }
}
```

Error responses:
- `404` — session not found, or session has no associated mux session
- `503` — session has a mux session but `captureScreen` returned null (pane exited or tmux error); body: `{ "error": "screen_capture_failed" }`

Implementation:
1. Look up mux session for this session ID → 404 if absent
2. Call `captureScreen(muxName)` → 503 if null
3. Call `analyzeScreen(rawScreen)` (operates on stripped text internally)
4. Return muxName + rawScreen + analysis

Also update `_onSessionCleared` handler in server to call `store.setActiveSessionId(newSessionId)` after emitting the SSE event. Note: at the moment this is called, `newSessionId` may not yet exist in the session map (it arrives via `session:created` shortly after). This means a `resolve-active` call made in the brief window between `session:cleared` and `session:created` will have `persistedActiveId` set to `newSessionId` but will not find it in the session map — it will fall through to `tmux-verified` fallback, which is still correct. The `confidence: high` path is simply not available in this narrow window, which is acceptable.

---

### Frontend changes (`src/web/public/app.js`)

#### 1. Replace localStorage-first restore with backend-first resolve

**Important:** `handleInit` must be converted from a plain function to an `async` function. All call sites (`_onInit`, `loadState`) already tolerate this — `_onInit` is fire-and-forget and `loadState` already awaits nothing from `handleInit`.

At the very top of `handleInit`, capture the current generation counter: `const gen = ++this._initGeneration;`. All async continuations inside `handleInit` must compare against this value to detect and abort stale calls. Without this, two overlapping `handleInit` calls can both call `selectSession`, with the first (stale) call winning if its `fetch` resolves first.

Current `handleInit` restore logic (line ~6511):
```js
let restoreId = previousActiveId;
if (!restoreId || !this.sessions.has(restoreId)) {
  try { restoreId = localStorage.getItem('codeman-active-session'); } catch {}
}
if (restoreId && this.sessions.has(restoreId)) {
  this.selectSession(restoreId);
} else {
  this.selectSession(this.sessionOrder[0]);
}
```

Replace with:
```js
let restoreId = previousActiveId;
if (restoreId && this.sessions.has(restoreId)) {
  // Already have a valid in-memory active session — use it (soft reconnect path)
  this.selectSession(restoreId);
} else {
  // Ask backend for authoritative answer
  try {
    const res = await fetch('/api/sessions/resolve-active');
    // Re-check generation after await — a newer handleInit may have already run
    if (gen !== this._initGeneration) return;
    const data = await res.json();
    restoreId = data.sessionId && this.sessions.has(data.sessionId) ? data.sessionId : null;
  } catch {}
  // Re-check generation again after any catch path
  if (gen !== this._initGeneration) return;
  // Fall back to localStorage, then first session
  if (!restoreId) {
    try { restoreId = localStorage.getItem('codeman-active-session'); } catch {}
  }
  this.selectSession(
    (restoreId && this.sessions.has(restoreId)) ? restoreId : this.sessionOrder[0]
  );
}
```

#### 2. Persist selection to backend

In `selectSession` (line ~7220), after the `localStorage.setItem('codeman-active-session', sessionId)` call, add:
```js
fetch(`/api/sessions/${encodeURIComponent(sessionId)}/mark-active`, { method: 'POST' }).catch(() => {});
```
Fire-and-forget. No await, no error handling needed — this is best-effort persistence.

Note: `selectSession` is also called programmatically during clear/archive transitions when the session being selected may transiently be in an archived state. The route returns 400 in this case. This is intentionally swallowed by the `.catch(() => {})` — it causes no harm since `resolve-active` will compute the correct session anyway on the next reconnect.

#### 3. Fix deferred clear switch timeout

In `_onSessionCleared`, when `_pendingClearSwitchTo` is set, add a 5-second timeout fallback:
```js
this._pendingClearSwitchTo = newSessionId;
this._pendingClearSwitchToTimer = setTimeout(async () => {
  if (this._pendingClearSwitchTo === newSessionId) {
    this._pendingClearSwitchTo = null;
    // Missed session:created — ask backend
    // Edge case: if the new session is also slow to respawn, resolve-active may return
    // a different session (the tmux-verified fallback). This is still better than staying
    // stuck on the archived session.
    try {
      const res = await fetch('/api/sessions/resolve-active');
      const data = await res.json();
      if (data.sessionId && this.sessions.has(data.sessionId)) {
        this.selectSession(data.sessionId);
      }
    } catch {}
  }
}, 5000);
```
Clear the timer in `_onSessionCreated` when `_pendingClearSwitchTo` matches.

---

## Test Plan

### Unit: `test/session-resolver.test.ts`

- Returns `null` when session map is empty
- Returns persisted session with `confidence: high` when it exists and has live tmux
- Ignores persisted session when it doesn't exist in session map
- Ignores persisted session when its tmux name isn't in live set
- Falls back to most-recently-active tmux-verified session
- Falls back to activity-timestamp ordering when no tmux verification
- Ignores archived sessions in all paths
- Returns first non-archived session as fallback when no timestamps

### Unit: `test/screen-analyzer.test.ts`

- `captureScreen` returns null when mux name is not found (process throws)
- `analyzeScreen` detects `completion` from "Worked for 2m 31s"
- `analyzeScreen` detects `running_tool` from "⏺ Bash(npm test)"
- `analyzeScreen` detects `asking_question` from "[y/n]" line
- `analyzeScreen` detects `asking_question` from numbered option list
- `analyzeScreen` detects `thinking` from spinner character
- `analyzeScreen` detects `waiting_for_input` from ❯ prompt
- `analyzeScreen` detects `shell_prompt` from `$ ` line
- `analyzeScreen` returns `unknown` for empty/unrecognized screen
- `stripAnsi` removes ANSI escape codes correctly
- Completion pattern takes priority over tool pattern
- `lastVisibleText` is the last non-empty line after stripping ANSI

### Integration: `test/routes/active-session-routes.test.ts`

Using the existing `createRouteTestHarness` pattern:

- `GET /api/sessions/resolve-active` returns `{ sessionId: null, confidence: 'none' }` when no sessions
- `GET /api/sessions/resolve-active` returns persisted ID when it matches a live session
- `GET /api/sessions/resolve-active` ignores persisted ID when session is archived
- `GET /api/sessions/resolve-active` falls back to most recent non-archived session (by `lastActivityAt`)
- `GET /api/sessions/resolve-active` ignores persisted ID when not in live tmux set
- `POST /api/sessions/:id/mark-active` returns 200 and persists to store
- `POST /api/sessions/:id/mark-active` returns 404 for unknown session ID
- `POST /api/sessions/:id/mark-active` returns 400 for archived session
- `GET /api/sessions/:id/screen-snapshot` returns analysis when tmux responds
- `GET /api/sessions/:id/screen-snapshot` returns 404 when session has no mux session
- `GET /api/sessions/:id/screen-snapshot` returns 503 when `captureScreen` returns null

### Manual QA

The following scenario is not unit-testable (frontend async behavior) and must be verified manually:

**Concurrent SSE reconnect during `handleInit` fetch:** Simulate two rapid SSE reconnects in quick succession. The second `handleInit` call should win — the first should be cancelled by the generation guard after the `await fetch` resolves. Verify the terminal shows the session selected by the second init, not the first.

**Recommended test steps:**
1. Open the app with 2+ active sessions
2. Force-close and reopen the SSE connection twice in rapid succession (e.g. via browser devtools → Network → block/unblock the SSE stream)
3. Confirm the transcript shows the most recently active session

---

## Files Changed

| File | Change |
|------|--------|
| `src/types/app-state.ts` | Add `activeSessionId: string \| null` to `AppState` |
| `src/state-store.ts` | Add `getActiveSessionId()` / `setActiveSessionId()` |
| `src/session-resolver.ts` | **New** — active session resolution logic |
| `src/screen-analyzer.ts` | **New** — tmux screen capture + state classification |
| `src/web/routes/active-session-routes.ts` | **New** — 3 new endpoints |
| `src/web/server.ts` | Register new route module; call `setActiveSessionId` on clear |
| `src/web/public/app.js` | Backend-first restore; mark-active on select; clear race fix |
| `test/session-resolver.test.ts` | **New** — unit tests |
| `test/screen-analyzer.test.ts` | **New** — unit tests |
| `test/routes/active-session-routes.test.ts` | **New** — integration tests |

---

## Out of Scope

- Multi-user / multi-browser support (single user app)
- Full terminal diff / transcript reconciliation (future milestone)
- Changing SSE event structure or adding new SSE events (avoided to minimize blast radius)

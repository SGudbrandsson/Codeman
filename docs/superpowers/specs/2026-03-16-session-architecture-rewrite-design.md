# Session Architecture Rewrite — Design Spec
**Date:** 2026-03-16
**Status:** Draft

## Problem

The transcript view and terminal view can diverge after a session is cleared or when switching between sessions. The browser holds too much session state in localStorage and in-memory caches that can become stale, leading to:

- Transcript view showing the wrong session's content
- State that "resets eventually" but not reliably
- Multi-tab inconsistency
- Fragile behavior when clearing sessions mid-use

The root cause: **dual sources of truth**. The terminal (PTY/tmux) is always live and correct. The transcript view is driven by client-cached state that can rot.

---

## Goals

1. Eliminate divergence between terminal view and transcript view
2. Make session state server-authoritative; browser is a rendering layer
3. Make "clear" a first-class, well-defined operation (archive + new child session)
4. Preserve conversation history across clears via parent-child hierarchy
5. Allow fast session switching with stale-while-revalidate caching

---

## Approach: Server-Authoritative State + Archive-on-Clear

### Session Identity Model

A session is permanently bound to one `(Claude process, transcript file)` pair. Its history never mutates — it only accumulates.

**Clearing** creates a child session:

```
Session A (parent, archived)
  └── Session B (child, archived)
        └── Session C (active, current)
```

Viewing an archived parent session is possible via a read-only transcript view — the full conversation before each clear is preserved and navigable via a breadcrumb/chain UI.

---

## Data Model

### SessionStatus

`'archived'` is added as a distinct status:

| Status | Meaning |
|--------|---------|
| `'idle'` | Process running, waiting for input |
| `'busy'` | Process running, Claude is responding |
| `'stopped'` | Process died unexpectedly or was killed externally |
| `'error'` | Process exited with an error |
| `'archived'` | Intentionally cleared; process gone, history preserved read-only |

`'archived'` differs from `'stopped'` in that it is intentional and the transcript is guaranteed intact. UI renders archived sessions as read-only history, not as restartable sessions.

### SessionState additions

```typescript
interface SessionState {
  // existing fields unchanged...
  status: 'idle' | 'busy' | 'stopped' | 'error' | 'archived'  // archived is new

  // new fields (all optional; undefined = legacy session pre-rewrite)
  parentSessionId?: string    // session that was cleared to create this one
  childSessionId?: string     // set when this session is cleared (points forward)
  clearedAt?: string          // ISO timestamp when archived
  transcriptPath?: string     // absolute path; captured at archive time for reliable serving
}
```

### Migration

Existing sessions in `state.json` lack the new fields. All new fields are optional — `undefined` is treated as a legacy session with no chain history. No migration script required. The reattachment logic on server restart already checks for a running tmux session; `archived` sessions have no pane and are simply loaded from state as-is. A guard is added: if `status === 'archived'`, skip all reattachment logic unconditionally.

### state.json growth

Archived sessions accumulate in state.json indefinitely. Pruning of old archived sessions is **deferred** to a future cleanup feature and is out of scope for this spec.

---

## Frontend State Model

The frontend holds **one piece of persistent state**: the currently selected session ID (in localStorage, advisory — server overrides if session doesn't exist).

Everything else is fetched on demand or pushed via SSE:

| Data | Source | Delivery |
|------|--------|----------|
| Session list + metadata | Server | SSE push on change |
| Transcript content | Server (reads `transcriptPath` from SessionState) | Fetched on switch, streamed via SSE |
| Terminal output | Server (PTY/tmux) | Live SSE stream |
| Session status (busy/idle) | Server | SSE push |
| Parent/child chain | Server | Fetched with session metadata |

### Client-Side Cache (stale-while-revalidate)

Transcript content and session metadata are cached in an **in-memory JS Map** (never localStorage) with a ~60s TTL per session.

**On session switch:**
1. Render cached state immediately (no flash/spinner)
2. Fire background fetch to `GET /api/sessions/:id/state`
3. Patch UI if server state differs
4. SSE updates continue arriving in real-time regardless

### Removed from localStorage

- All per-session transcript/terminal state
- `transcriptViewMode:{sessionId}`
- Session order (server owns this)
- Terminal buffers, offsets, caches
- Ralph state snapshots

---

## Clear Action Flow

### Waiting behavior

The "waiting to clear" state is **client-side**: the client monitors SSE for `session:idle` before sending the clear request. This avoids blocking the server on a long-running response.

Flow:
1. User presses **Clear**
2. If session is `busy`: client shows "waiting to clear…" indicator; waits for `session:idle` SSE event
3. Once idle (or immediately if already idle): client sends `POST /api/sessions/:id/clear`
4. If user presses **Clear again** while waiting: client sends `POST /api/sessions/:id/clear` with `{ force: true }` → server sends SIGKILL immediately

### Server-side clear (`POST /api/sessions/:id/clear`)

1. Stop `RespawnController` (if active) — do not transfer to child; child starts fresh
2. Stop `RalphTracker`, `SubagentWatcher`, `RunSummaryTracker` for this session
3. If `force: true`: SIGKILL the Claude process immediately
   Else: SIGINT; wait up to 5s for clean exit; SIGKILL if timeout
4. Close the tmux pane
5. Capture `transcriptPath` from the session watcher (the last known path) and store it in `SessionState`
6. Mark session `status: 'archived'`, set `clearedAt`, persist to state.json
7. Create child session:
   - `parentSessionId = archivedId`
   - Inherits: `workingDir`, `name` (with " (2)" / " (3)" suffix), `color`, `mcpServers`, `respawnConfig`, `ralphEnabled`
   - Does **not** inherit: tokens, cost, messages, `claudeResumeId`, `safeMode`
8. Start new tmux pane + fresh Claude process for child
9. Broadcast `session:cleared` SSE: `{ archivedId, newSessionId }`

**Response:** `200 { archivedSession: SessionState, newSession: SessionState }`

### All tabs

On receiving `session:cleared` SSE: switch active session to `newSessionId`, invalidate cache for `archivedId`.

### Terminal `/clear` command

If the user types `/clear` in the terminal, the server intercepts it (same as the button) and treats it identically to `POST /api/sessions/:id/clear` with `force: false`. This ensures the archive model is consistent regardless of how clear is triggered. The raw `/clear` is **not** passed through to Claude.

### Auto-clear and respawn `sendClear`

`autoClearEnabled` and `RespawnConfig.sendClear` currently send `/clear` as a terminal command. Under the new model these are updated to call the clear API endpoint directly. This gives them full archive semantics. This is included in scope for this rewrite.

---

## Archived Session Viewing

- Archived sessions do **not** appear in the main session sidebar
- They are accessible only via the **history chain UI**: a breadcrumb at the top of an active session ("Continued from: Session A › Session B › this session")
- Clicking a breadcrumb entry opens that archived session's transcript in a **read-only overlay/panel**
- No terminal is shown; no input is accepted
- The overlay fetches `GET /api/sessions/:id/state` (which reads from `transcriptPath`)
- Chain is fetched via `GET /api/sessions/:id/chain`

---

## New API Endpoints

```
POST /api/sessions/:id/clear
  Body: { force?: boolean }
  → 200 { archivedSession: SessionState, newSession: SessionState }

GET  /api/sessions/:id/chain
  → 200 { sessions: SessionState[] }   // ordered root→current

GET  /api/sessions/:id/state
  → 200 { session: SessionState, transcript: TranscriptBlock[] }
  // supersedes ad-hoc transcript fetches; coexists with existing /transcript for compatibility
```

---

## SSE Events

| Event | Payload | Purpose |
|-------|---------|---------|
| `session:cleared` | `{ archivedId, newSessionId }` | All tabs switch to new session |
| (all existing events unchanged) | | |

---

## Testing Criteria

- **Mid-response clear**: "waiting to clear" shown, clear fires after `session:idle` received
- **Force-clear** (second press during wait): immediate SIGKILL, archive proceeds
- **Two tabs**: clearing in tab A switches both tabs to new session via SSE
- **Archived session viewing**: breadcrumb shown, transcript renders read-only, no input field
- **Chain navigation**: 3+ clears produce navigable breadcrumb chain
- **Stale-while-revalidate**: cached state shown instantly on switch; background fetch patches if different
- **Hard browser refresh**: clean state from server; no stale localStorage artifacts
- **Server restart**: archived sessions load from state.json with no reattachment attempt
- **Terminal `/clear` command**: triggers archive+new-session, identical to button
- **Auto-clear / respawn sendClear**: calls clear API, produces archived parent + new child
- **Clear during respawn cycle**: respawn stops cleanly before archive proceeds
- **Legacy sessions** (no parentSessionId): load and function normally; no chain UI shown

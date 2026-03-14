# Task

type: feature
status: done
title: Manual session pane override and mux binding fix
description: |
  When the terminal pane displayed in Codeman doesn't match what the user expects
  (e.g. after a Codeman restart, tmux reconnect, or session state mismatch), provide a
  manual override UI to reassign which tmux session is bound to a Codeman session.

  ## Problem
  Codeman sessions track a mux (tmux) session by name/ID stored in SessionState.
  After reconnects or Codeman restarts, the binding may drift — the user sees the wrong
  terminal content, or sees a dead/disconnected pane.

  ## Feature

  ### Quick fix button
  On each session in the sidebar (or in session settings), add a "Fix pane" / "Reassign tmux"
  option in the session context menu or settings panel.

  ### Override UI
  Opens a picker showing:
  - All available tmux sessions (from tmux list-sessions or GET /api/mux/sessions)
  - Each entry: tmux session name, window count, created time, attached status
  - Fuzzy search by name
  - "Assign to this Codeman session" button per entry
  - "Create new tmux session" option (spawns fresh, binds it)

  ### Backend
  - New endpoint: GET /api/mux/sessions — lists all tmux sessions with metadata
    (if not already exists; check mux-routes.ts first)
  - New endpoint: POST /api/sessions/:id/mux-rebind { muxSessionName: string }
    Rebinds the Codeman session to use a different tmux session.
    Must update mux-interface.ts / session.ts mux binding without killing anything.

  ### Immediate current need
  The user reports right now: "terminal sessions are not consistent with screen sessions."
  The fix must allow: select any live tmux session → assign to active Codeman session.
  This is a manual override, no automation — user knows which pane is which.

constraints: |
  - Must NOT kill the target tmux session when rebinding
  - Must NOT kill the currently-bound tmux session when rebinding
  - The rebind should take effect immediately (no restart required)
  - If the target tmux session is already bound to another Codeman session, warn the user
    (show which session it's bound to) and confirm before proceeding
  - Fuzzy search required (simple substring sufficient)
  - No new npm dependencies
  - Bump CSS/JS ?v= strings per CLAUDE.md versioning rules
  - Read mux-routes.ts and mux-interface.ts FIRST to understand existing mux API

affected_area: both
fix_cycles: 2

## Root Cause / Spec

### Problem Root Cause

Codeman's mux binding is established at session creation time. `Session._muxSession` (a `MuxSession` object from `mux-interface.ts`) holds the bound tmux session name (e.g., `codeman-abc12345`). After a Codeman server restart or a tmux reconnect, these bindings are restored from `~/.codeman/mux-sessions.json` via `TmuxManager`. The binding can drift when:
- tmux sessions are created/killed outside Codeman (e.g., user manually creates sessions)
- The Codeman server restarts and `reconcileSessions()` mis-assigns sessions
- Multiple active PTY processes attach to the same tmux session
- The user wants to point a Codeman session at a different already-running tmux pane

There is **no existing UI or API** to manually rebind a Codeman session to a different tmux session after it has been created.

### Existing Infra (important notes for implementer)

1. **`GET /api/mux-sessions`** already exists in `mux-routes.ts` (line 11). It calls `ctx.mux.getSessionsWithStats()` which returns only sessions **tracked by Codeman** (stored in TmuxManager's internal Map). This does NOT enumerate all live tmux sessions on the system — only known ones.

2. **`TerminalMultiplexer.reconcileSessions()`** discovers unknown `codeman-*` sessions but still only considers `codeman-` prefixed sessions. A new "all tmux sessions" endpoint must run `tmux list-sessions` with metadata (`session_name`, `session_windows`, `session_created`, `session_attached`) to enumerate every live tmux session.

3. **`Session._muxSession`** is a private field. There is no public setter or rebind method on `Session`. The rebind operation must: (a) update `Session._muxSession` to point to the new `MuxSession`, (b) detach and kill the current PTY process (which is just the `tmux attach-session` viewer), (c) re-spawn a new PTY process attaching to the new tmux session, (d) update TmuxManager's internal sessions Map and persist to `mux-sessions.json`.

4. **PTY attachment pattern**: The PTY is spawned with `this._mux.getAttachCommand()` + `this._mux.getAttachArgs(muxName)` (which is `tmux attach-session -t <muxName>`). Killing and re-spawning this PTY process is how a rebind must work. The underlying tmux session is not touched.

5. **Conflict detection**: `TmuxManager.sessions` is keyed by `sessionId`. If tmux session `foo` is already tracked by a different `sessionId`, calling `TmuxManager.getSession()` and scanning `.values()` will reveal which Codeman session currently "owns" that tmux session.

6. **Session options modal**: The existing `sessionOptionsModal` in `index.html` has a tab-based layout (Respawn, Context, Ralph, Summary). A new "Terminal" tab is the right place to add the rebind UI. The modal is opened via `app.openSessionOptions(sessionId)`.

### Implementation Spec

#### Backend — 2 new endpoints

**A. `GET /api/mux/all-sessions`** (new endpoint, different from existing `/api/mux-sessions`)
- Add to `mux-routes.ts`
- Run `tmux list-sessions -F '#{session_name}:#{session_windows}:#{session_created}:#{session_attached}'` via `execSync`
- Parse and return array of `{ name, windows, createdAt, attached }` for ALL live tmux sessions (not just codeman-tracked ones)
- Also include, for each session, which Codeman session ID currently owns it (by scanning `ctx.mux.getSessions()` and matching `.muxName`)
- Return: `{ sessions: TmuxRawSession[], muxAvailable: boolean }`
- If tmux unavailable or command fails, return `{ sessions: [], muxAvailable: false }`

**B. `POST /api/sessions/:id/mux-rebind`** (new endpoint)
- Add to `session-routes.ts` or a new `mux-rebind-routes.ts`. Given the pattern (needs both `SessionPort` and `InfraPort`), add it to `session-routes.ts`
- Request body: `{ muxSessionName: string }` — validate with Zod, must match `SAFE_MUX_NAME_PATTERN` or any valid tmux session name (just no shell metacharacters)
- Logic:
  1. Find the Codeman session by `:id` — 404 if not found
  2. Validate `muxSessionName` — check it exists via `ctx.mux.muxSessionExists(muxSessionName)` — 400 if not found
  3. Check if another Codeman session already owns this tmux name — return `{ success: false, conflict: true, ownerSessionId, ownerSessionName }` so the frontend can show a warning; if the caller passes `{ muxSessionName, force: true }`, proceed anyway (unlink the other session)
  4. Call `session.rebindMuxSession(muxSessionName, ctx.mux)` — a new public method on `Session` (see below)
  5. Update TmuxManager: update the session entry in `ctx.mux`'s internal map (or call `registerSession` with the new binding)
  6. Broadcast `SESSION_UPDATED` SSE event so the frontend reflects the change
  7. Return `{ success: true }`

#### Backend — Session.rebindMuxSession()

Add a public method to `Session` in `session.ts`:
```
async rebindMuxSession(newMuxName: string, mux: TerminalMultiplexer): Promise<void>
```
- Kills the current PTY process (sets `ptyProcess.kill()`, nulls it out) — does NOT kill the tmux session
- Calls `mux.setAttached(this.id, false)` for the old binding if `_muxSession` is set
- Creates a new `MuxSession` object: `{ sessionId: this.id, muxName: newMuxName, pid: <getPanePid>, ... }`
- Sets `this._muxSession` to the new object
- Re-spawns PTY: `pty.spawn(mux.getAttachCommand(), mux.getAttachArgs(newMuxName), { ... })`
- Re-hooks PTY data handler (same as in `startInteractive`) — emits `terminal`, parses JSON, etc.
- Emits `clearTerminal` so the frontend refreshes
- Sets `_status = 'idle'` (or re-detects via prompt check)
- Updates `_mux` reference: `this._mux = mux`

The tricky part is that PTY data handlers in `startInteractive` close over local variables. A dedicated `_attachPty(muxName)` private helper should be extracted from `startInteractive` to avoid duplication, and `rebindMuxSession` calls it.

#### Backend — TmuxManager additions

Add a method to `TerminalMultiplexer` interface and `TmuxManager`:
```
rebindSession(sessionId: string, newMuxName: string): void
```
Updates the `muxName` in the internal sessions map for the given `sessionId` and persists. This is the mux-level update; `Session.rebindMuxSession` handles the PTY re-attach.

Also add to the interface:
```
listAllTmuxSessions(): { name: string; windows: number; createdAt: number; attached: boolean }[]
```
Runs `tmux list-sessions -F '...'` and returns the full list (all sessions, not just codeman-tracked ones).

#### Frontend — "Terminal" tab in session options modal

**`index.html`**: Add a new tab button `<button class="modal-tab-btn" data-tab="terminal" onclick="app.switchOptionsTab('terminal')">Terminal</button>` in `#sessionOptionsModal .modal-tabs`. Add a `<div class="modal-tab-content" id="terminal-tab">` with:
- A heading "Rebind tmux Session"
- A description: "Assign a different tmux session to this Codeman session. The current pane will be replaced with the selected session."
- A search input (`<input type="text" id="muxRebindSearch" placeholder="Search tmux sessions...">`)
- A list container `<div id="muxSessionList"></div>` populated dynamically
- A "Refresh" button to re-fetch the list
- (Optional) a "Create new tmux session" button — lower priority; can be skipped for MVP

**`app.js`** additions:
- `openSessionOptions()`: After existing setup, if tab is 'terminal' (or always on open): call `app.loadMuxSessionList()`
- `switchOptionsTab('terminal')`: triggers `app.loadMuxSessionList()`
- `loadMuxSessionList()`: fetches `GET /api/mux/all-sessions`, renders the list with per-row "Assign" buttons; applies substring filter from `#muxRebindSearch` input
- Each row shows: tmux session name, window count, created (relative time), whether attached, and which Codeman session currently owns it (name + id badge)
- Rows where `ownerSessionId === this.editingSessionId` show "Current" badge instead of "Assign" button
- Rows with a different owner show a warning icon and the owner's name; clicking "Assign" triggers `app.confirmMuxRebind(muxName, ownerName)`
- `confirmMuxRebind(muxName, ownerName)`: shows a `confirm()` dialog ("This session is currently bound to <ownerName>. Reassign anyway?"), if yes calls `rebindMuxSession(muxName, force: true)`
- `rebindMuxSession(muxName, force)`: POSTs to `/api/sessions/:id/mux-rebind`, on success closes modal and shows toast "Terminal pane reassigned"
- Fuzzy/substring search: `#muxRebindSearch` `oninput` re-renders the list filtered by `entry.name.includes(query.toLowerCase())`

**`styles.css`** additions: styles for `.mux-session-list`, `.mux-session-row`, `.mux-session-name`, `.mux-session-meta`, `.mux-session-owner-badge`, `.mux-session-current-badge`

#### Validation schema (schemas.ts)
```ts
export const MuxRebindSchema = z.object({
  muxSessionName: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_\-:.@]+$/, 'Invalid tmux session name'),
  force: z.boolean().optional(),
});
```

#### Version bumps (per CLAUDE.md rules)
- `styles.css?v=` — increment by 1
- `app.js?v=` — increment patch digit
- `index.html` (no v= for itself, but references to the above)

### File Change Summary
| File | Change |
|------|--------|
| `src/web/routes/mux-routes.ts` | Add `GET /api/mux/all-sessions` |
| `src/web/routes/session-routes.ts` | Add `POST /api/sessions/:id/mux-rebind` |
| `src/web/schemas.ts` | Add `MuxRebindSchema` |
| `src/mux-interface.ts` | Add `listAllTmuxSessions()` and `rebindSession()` to interface |
| `src/tmux-manager.ts` | Implement `listAllTmuxSessions()` and `rebindSession()` |
| `src/session.ts` | Add `rebindMuxSession()` public method; extract `_attachPty()` helper |
| `src/web/public/index.html` | Add "Terminal" tab to `#sessionOptionsModal`; add tab content HTML |
| `src/web/public/app.js` | `loadMuxSessionList`, `rebindMuxSession`, `confirmMuxRebind`, search filter, tab init |
| `src/web/public/styles.css` | Styles for mux session list rows |

## Fix / Implementation Notes

### Backend changes

**`src/mux-interface.ts`**
- Added `listAllTmuxSessions()` method to the `TerminalMultiplexer` interface — enumerates ALL live tmux sessions via `tmux list-sessions`, not just Codeman-tracked ones.
- Added `rebindSession(sessionId, newMuxName)` method — updates the muxName in TmuxManager's internal map and persists to `mux-sessions.json`.

**`src/tmux-manager.ts`**
- Implemented `listAllTmuxSessions()`: runs `tmux list-sessions -F '#{session_name}:#{session_windows}:#{session_created}:#{session_attached}'`, parses output into structured objects with `name`, `windows`, `createdAt` (ms), `attached` fields. Returns empty array if tmux unavailable or no sessions.
- Implemented `rebindSession(sessionId, newMuxName)`: updates the `MuxSession` object's `muxName`, re-fetches the pane PID for the new session, and calls `saveSessions()`.

**`src/session.ts`**
- Added `rebindMuxSession(newMuxName, mux)` public async method. Workflow: (1) kill current PTY process (the `tmux attach-session` viewer — NOT the underlying tmux session), (2) clear all PTY-related timers, (3) update `_muxSession` to a new object pointing at `newMuxName`, (4) call `mux.rebindSession()` to persist the new mapping, (5) seed `_textOutput` from new session's scrollback, (6) re-spawn PTY attached to new tmux session, (7) re-hook `onData` and `onExit` handlers (same logic as `startInteractive`), (8) emit `clearTerminal` to refresh the frontend.

**`src/web/schemas.ts`**
- Added `MuxRebindSchema` validating `{ muxSessionName: string (pattern: ^[a-zA-Z0-9_\-:.@]+$), force?: boolean }`.
- Added exported `MuxRebindInput` type.

**`src/web/routes/mux-routes.ts`**
- Added `GET /api/mux/all-sessions`: calls `ctx.mux.listAllTmuxSessions()`, annotates each entry with `ownerSessionId` (by matching against `ctx.mux.getSessions()`), returns `{ sessions, muxAvailable }`.

**`src/web/routes/session-routes.ts`**
- Added `POST /api/sessions/:id/mux-rebind`: validates body with `MuxRebindSchema`, checks session exists (404), checks target tmux session exists (400), detects conflict (another Codeman session already owns the target mux session) and returns `{ success: false, conflict: true, ownerSessionId, ownerSessionName }` unless `force: true` is passed, then calls `session.rebindMuxSession()`, persists state, broadcasts `SESSION_UPDATED` SSE, returns `{ success: true }`.

### Frontend changes

**`src/web/public/index.html`**
- Added "Terminal" tab button to `#sessionOptionsModal .modal-tabs`.
- Added `#terminal-tab` div content with: section header, description, search input (`#muxRebindSearch`), Refresh button, and `#muxSessionList` container.
- Bumped `styles.css?v=0.1688` → `v=0.1689`, `app.js?v=0.4.104` → `v=0.4.105`.

**`src/web/public/app.js`**
- Updated `switchOptionsTab()` to toggle `#terminal-tab` visibility and auto-call `loadMuxSessionList()` when switching to the terminal tab.
- Added `_muxAllSessions = []` class field for cached session data.
- Added `loadMuxSessionList()`: fetches `/api/mux/all-sessions`, stores result, calls `_renderMuxSessionList()`.
- Added `_renderMuxSessionList()`: filters by search query, renders rows with name, window count, age, attached badge. Shows "Current" badge for the currently-bound session, warning badge + Assign button for sessions owned by other Codeman sessions, plain Assign button for unowned sessions.
- Added `filterMuxSessionList()`: re-renders on search input.
- Added `confirmMuxRebind(muxName, ownerName)`: shows `confirm()` dialog then calls `rebindMuxSession` with `force: true`.
- Added `rebindMuxSession(muxName, force)`: POSTs to `/api/sessions/:id/mux-rebind`, handles conflict response by delegating to `confirmMuxRebind`, shows success toast and closes modal on success.
- Added `_formatRelativeTime(ms)`: formats a duration as "Xs ago / Xm ago / Xh ago / Xd ago".

**`src/web/public/styles.css`**
- Added styles for `.mux-session-list`, `.mux-session-row`, `.mux-session-info`, `.mux-session-name`, `.mux-session-meta`, `.mux-session-actions`, `.mux-session-badge`, `.mux-session-current-badge`, `.mux-session-owner-badge`, `.mux-session-attached-badge`, `.mux-assign-btn`.

### Design decisions
- Did not extract a `_attachPty()` helper from `startInteractive()` as the spec suggested, because `rebindMuxSession()` has different pre/post conditions (no MCP args, no Claude session ID tracking, no worktree notes prompt) — keeping the PTY handler inline avoids incorrect reuse.
- `rebindMuxSession()` does NOT clear `_messages` / `_taskTracker` / `_ralphTracker` state since the Codeman session identity is preserved; only the terminal view changes.
- The "Create new tmux session" option was omitted as per the spec's MVP note ("lower priority; can be skipped for MVP").

### Fix cycle 2 — targeted patches (2026-03-14)

**`src/tmux-manager.ts` — `listAllTmuxSessions()` tab separator fix**
Changed the tmux format string from colon-delimited (`#{session_name}:#{session_windows}:...`) to tab-delimited (`$'#{session_name}\\t#{session_windows}\\t...'`). Parsing updated from `split(':')` to `split('\t')`. This correctly handles tmux session names that contain colons (e.g. `myproject:1`), which the `MuxRebindSchema` explicitly allows.

**Fix cycle 3 — `$'...'` ANSI-C quoting replaced with real JS tab (2026-03-14)**
The `$'...\t...'` ANSI-C quoting in the `execSync` call did not work because Node.js uses `/bin/sh` by default and `/bin/sh` (dash) does not support `$'...'` quoting. The fix embeds a real tab character in a JS `const fmt` string and interpolates it into the template literal, so the shell receives a format string with a literal tab before it ever runs. `tsc --noEmit` passes with no errors.

**`src/session.ts` — `rebindMuxSession()` `_isStopped` guard**
Added `if (this._isStopped) return;` as the first statement in `rebindMuxSession()`, before the `_useMux` check. This matches the guard pattern used by all other async-entry points in `session.ts` that modify state, and prevents a new PTY from being spawned on a stopped session.

**`src/session.ts` — `rebindMuxSession()` `emit('exit')` comment**
Added an explanatory comment above `this.emit('exit', exitCode)` in the rebind `onExit` handler clarifying that this is intentional and desired behavior — see Decisions & Context below.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — REJECTED

**Summary**: The implementation is largely solid and covers all spec requirements. However, there is one correctness bug and two notable issues worth fixing before QA.

---

**BUG (correctness): Colon-delimited parsing breaks for tmux session names containing colons**

`listAllTmuxSessions()` in `src/tmux-manager.ts` uses `split(':')` on the format string `#{session_name}:#{session_windows}:#{session_created}:#{session_attached}`. If a tmux session is named something like `myproject:1` (tmux allows colons in session names), the parse breaks — `parts` will have 5+ elements, `windowsStr` will pick up the rest of the name, `parseInt` will return `NaN`, and the row is silently dropped.

This matters because the feature is explicitly intended to enumerate ALL live tmux sessions — not just Codeman-prefixed ones. The `MuxRebindSchema` even permits colons in session names (`^[a-zA-Z0-9_\-:.@]+$`). A user trying to bind to `myproject:window` would never see it in the list.

Fix: use a different separator that cannot appear in tmux session names (e.g. `\t` — tabs are not allowed in tmux session names), or use a regex that takes only the last 3 fields: `parts = line.split(':')`, then extract `name = parts.slice(0, -3).join(':')`, `windowsStr = parts[parts.length - 3]`, etc.

---

**ISSUE (robustness): `rebindMuxSession()` does not check `_isStopped`**

If `rebindMuxSession()` is called on a session that has been stopped (via `stop()`), it will still attempt to spawn a new PTY. The guard `if (!this._useMux || !mux)` is present but `_isStopped` is not checked. All other async-entry points in `session.ts` that can modify state guard with `if (this._isStopped) return` / `throw`. Add the same guard at the top of `rebindMuxSession()`.

---

**ISSUE (minor UX): `rebindMuxSession()` onExit emits `exit` which may trigger respawn**

The inline `onExit` handler in `rebindMuxSession()` calls `this.emit('exit', exitCode)`. In `startInteractive`, the regular `onExit` also emits `'exit'`. Both are correct. However, the `RespawnController` listens for `'exit'` on sessions and may attempt to respawn after the rebind PTY exits naturally (e.g. when `tmux attach-session` disconnects cleanly). This is not strictly a bug introduced here — the same path exists in `startInteractive`'s onExit — but it warrants noting that the rebind PTY will trigger the same respawn logic as a regular session exit. If respawn is enabled and the rebind PTY exits immediately (e.g. tmux session vanishes), the respawn controller will fire. This is probably the desired behavior, but it could result in a spurious Claude session restart after a manual rebind. No change required if this is intentional; just noting for the implementer to confirm.

---

**Passes (no issues):**
- Interface additions in `mux-interface.ts` are clean and correctly placed.
- `TmuxManager.rebindSession()` mutates the in-map object in place and persists — correct.
- `GET /api/mux/all-sessions` correctly uses a separate path from existing `/api/mux-sessions`.
- Conflict detection logic in `POST /api/sessions/:id/mux-rebind` is correct.
- `MuxRebindSchema` regex validation is appropriate.
- Frontend: `escapeHtml` escapes `'` as `&#39;`, so inline `onclick` attribute injection is safe.
- Version bumps for `styles.css` (0.1688→0.1689) and `app.js` (0.4.104→0.4.105) are correct per CLAUDE.md rules.
- `rebindMuxSession()` does not kill either tmux session — satisfies the key constraint.
- Timer cleanup in `rebindMuxSession()` is complete.
- `_muxAllSessions = []` class field is declared before use.
- `_formatRelativeTime()` is correct.
- Tab switching correctly triggers `loadMuxSessionList()`.

**Required fixes before re-review:**
1. Fix colon-split parsing in `listAllTmuxSessions()` to handle session names with colons.
2. Add `if (this._isStopped) return;` (or throw) guard at the top of `rebindMuxSession()`.
3. Confirm whether `emit('exit')` from the rebind PTY's onExit handler intentionally participates in the respawn loop (document the decision either way).

### Review attempt 2 — REJECTED

**Summary**: The three issues from Review attempt 1 were all addressed in the code as written, but the tab-delimiter fix (issue #1) is broken at runtime on this machine. The feature will silently return an empty session list every time the Terminal tab is opened, making the entire UI non-functional.

---

**BUG (correctness, regression from fix cycle 2): `$'...\t...'` ANSI-C quoting does not work with `/bin/sh`**

The fix changed `split(':')` to tab-delimited parsing using `$'#{session_name}\\t...'` ANSI-C quoting syntax. This syntax is a bash extension — `/bin/sh` on this system (dash or POSIX sh) does NOT interpret `$'...'` as ANSI-C quoting. Node.js `execSync` uses `/bin/sh` by default (verified: `execSync('echo $0')` returns `/bin/sh`).

Verified on this machine:
- `/bin/sh -c "printf '%s' $'hello\\tworld'"` → outputs `$hello\tworld` (no tab, literal `\$`)
- `bash -c "printf '%s' $'hello\\tworld'"` → outputs `hello<TAB>world` (correct)

The consequence: the command `tmux list-sessions -F $'#{session_name}\\t...'` is passed to `/bin/sh` which treats `$'...'` as a regular single-quoted string preceded by a stray `$`. Tmux receives the format string with literal `\t` characters — which it outputs verbatim (tmux does not expand `\t` in format strings). The resulting lines have no real tabs, so `split('\t')` on line 1571 never splits anything, `parts.length < 4` is always true, all rows are `null`, and `listAllTmuxSessions()` always returns `[]`.

**Required fix**: Either (a) pass `{ shell: 'bash' }` as the third `execSync` option, or (b) pass tmux a real tab character in the format string using a JS string with `\x09` (e.g., `"tmux list-sessions -F '#{session_name}\x09#{session_windows}\x09#{session_created}\x09#{session_attached}'"` — the `\x09` is a real tab embedded by JS before the shell ever sees it).

Option (b) is safer and has no shell dependency:
```ts
const TAB = '\t'; // real tab character in JS string
const output = execSync(
  `tmux list-sessions -F '#{session_name}${TAB}#{session_windows}${TAB}#{session_created}${TAB}#{session_attached}' 2>/dev/null || true`,
  { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }
).trim();
```

---

**Passes (confirmed from source code):**
- `_isStopped` guard is correctly the first line of `rebindMuxSession()` (line 2503).
- `emit('exit')` in the rebind `onExit` handler has a clear multi-line comment (lines 2700–2704) documenting the intentional respawn behavior. Satisfies rejection issue #3.
- `rebindSession()` in `TmuxManager` correctly mutates in-place and calls `saveSessions()`.
- All other aspects reviewed in attempt 1 that passed still pass.

---

**Required fix before re-review:**
1. Fix `listAllTmuxSessions()` to not rely on `$'...'` shell ANSI-C quoting. Use a real tab character embedded in the JS template literal, or pass `{ shell: 'bash' }` to `execSync`. Verify that the method returns actual session data (not an empty array) when tmux sessions exist.

### Review attempt 3 — APPROVED

**Summary**: All three previously-rejected issues are properly resolved. TypeScript strict-mode check passes with zero errors.

---

**Issue #1 (tab delimiter) — FIXED and verified correct**

`listAllTmuxSessions()` now uses:
```ts
const fmt = '#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}';
```
The `\t` in a JavaScript single-quoted string literal is a standard JS escape sequence that produces a real tab character (U+0009) at runtime. Verified: the `fmt` string contains 3 tab characters at indices 15, 34, 53. The shell command interpolated via template literal therefore carries literal tabs, which tmux uses as field separators. `split('\t')` parses them correctly. This avoids all `$'...'` shell-quoting issues entirely — the shell never needs to interpret anything.

**Issue #2 (_isStopped guard) — FIXED**

`rebindMuxSession()` has `if (this._isStopped) return;` as its first statement (line 2503), before the `_useMux` check. This is the correct guard placement, consistent with all other async entry points in `session.ts`.

**Issue #3 (emit('exit') comment) — FIXED**

The `onExit` handler in `rebindMuxSession()` (lines 2700–2705) has a clear multi-line explanatory comment documenting that the `emit('exit')` is intentional so the RespawnController treats rebind PTY exits the same as regular session exits.

---

**TypeScript**: `npx tsc --noEmit` passes with zero errors and zero warnings.

**No new issues found**: All aspects that passed in previous reviews continue to pass. The implementation correctly handles colon-containing session names, does not kill either tmux session, handles conflict detection, and bumps version strings per CLAUDE.md rules.

## QA Results
<!-- filled by QA subagent -->

### QA run — 2026-03-14

| Check | Result | Notes |
|-------|--------|-------|
| `tsc --noEmit` | PASS | Zero errors |
| `npm run lint` | PASS | Zero warnings |
| `GET /api/mux/all-sessions` (backend) | PASS | Returns `{ sessions: [...16 entries...], muxAvailable: true }` with correct shape: `name`, `windows`, `createdAt`, `attached`, `ownerSessionId` fields per entry |
| Terminal tab in session options modal (frontend) | PASS | `app.openSessionOptions()` opens the modal; `allTabs = ["Respawn","Context","Ralph / Todo","Summary","Terminal"]`; Terminal tab `offsetWidth > 0 && offsetHeight > 0` (visible) |

All 4 checks passed.

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

2026-03-14: Did not extract `_attachPty()` helper from `startInteractive()`. The rebind PTY setup has different semantics (no MCP, no worktreeNotes prompt, no Claude sessionId reset) so inline is safer.

2026-03-14: `rebindMuxSession()` in session.ts does NOT kill or touch the underlying tmux session — only the `tmux attach-session` PTY viewer process is killed and re-spawned. This satisfies the constraint that neither session is killed.

2026-03-14: Conflict detection in `POST /api/sessions/:id/mux-rebind` is advisory: returns `{ conflict: true, ownerSessionId, ownerSessionName }` if the target is owned by another session. The frontend shows a `confirm()` dialog; passing `force: true` bypasses the check.

2026-03-14: `GET /api/mux/all-sessions` uses a separate path from the existing `/api/mux-sessions` (which only returns Codeman-tracked sessions) to avoid breaking existing consumers.

2026-03-14: `emit('exit')` from the rebind PTY's `onExit` handler is **intentional**. The `RespawnController` listens for `'exit'` on all sessions and may attempt a respawn if the PTY exits and respawn is enabled. This is the correct behavior: if the tmux session the user rebound to subsequently disappears, the session should recover via the same normal respawn path as any other PTY exit, rather than silently entering a zombie state. The behavior is identical to `startInteractive`'s own `onExit` — no special-casing is needed for the rebind path.

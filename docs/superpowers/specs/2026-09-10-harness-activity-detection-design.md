# Harness Activity Detection (busy/idle for codex and pi)

**Date:** 2026-09-10
**Status:** Design, revision 4 (after three codex reviews)
**Scope:** Correct busy/idle status for `codex` and `pi` sessions, and stream pi's first turn live.

## Problem

Observed live on the deployed app (2026-09-10, sessions `e1861751` pi, `6daa4ee2` codex):

- **pi is busy forever.** After its turn finished, `/api/sessions` reported
  `status: busy, isWorking: true`. The header dot stayed amber and the transcript view showed
  "Engaging cortex..." indefinitely, although pi's pane was static and showed the finished turn.
- **codex never shows busy** while working.

### Root cause

`src/session.ts` has two activity mechanisms:

1. **`claude`** gets `ClaudeActivityMonitor` in `startInteractive()`, which tails Claude's JSONL.
2. **Every other harness** falls back to PTY heuristics, which run only when no monitor exists
   (`if (!this._activityMonitor && …)`). There are **two copies**: in `startInteractive()` and in
   `rebindMuxSession()`.
   - **busy** when output matches `SPINNER_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧]/`
     (`src/utils/regex-patterns.ts:81`)
   - **idle** only when output contains Claude's prompt glyph `❯` (U+276F)

pi draws braille spinner frames, so it goes busy, and never prints `❯`, so it never goes idle.
codex draws `·` and `•`, which do not match; its prompt is `›` (U+203A). The keyword detector
("Thinking", "Writing", …) lives in `_processExpensiveParsers`, which returns early without
`caps.claudeParsers`.

This predates the transcript feature; `src/session.ts` was not modified by it.

### Consequences of fixing it

Once codex and pi emit real `working`/`idle` events, these fire for them (`server.ts` session
listeners; `app.js` `_onSessionIdle` / `_onSessionWorking`):

- SSE status → header dot, tab status, transcript working bubble.
- Frontend "Session Idle" warning timer (default 10 min), cancelled by `working`.
- `RunSummaryTracker.recordWorking` / `recordIdle`.
- **Auto-compact-and-continue**: `session.compactContinue.onIdle()` has no harness gate. If enabled
  it types Claude's `/compact\r` when a fresh `COMPACT.md` exists — which Codeman worktrees use.
  No session has it enabled today (checked `~/.codeman/state.json`); nothing prevents enabling it.

**A premature idle has real side effects**, so the design uses authoritative signals, and separates
"the turn finished" from "we lost track of it" (§4).

## Decision: an authoritative signal per harness

### pi: its own lifecycle, via a Codeman extension

**Inference from pi's session file cannot work.** Verified in pi 0.85.1's installed source
(`dist/core/agent-session.js`): whether an errored attempt will be retried is decided at runtime and
never persisted; `_retryAttempt` resets on any non-error assistant message; messages are persisted
only at `message_end`, and with the default `httpIdleTimeoutMs` of 300,000 ms a retry can run
minutes with no write; and compaction can either continue a run or finish with nothing following.

**pi exposes its lifecycle to extensions** (`dist/core/extensions/types.d.ts`):

| event | meaning | verified |
|---|---|---|
| `agent_start` | a low-level agent loop starts | forwarded to extensions; **fires again for each retry/compaction continuation** |
| `agent_settled` | "no retry/compaction/follow-up left" (pi docs) | sent from `_emitAgentSettled()` in the `finally` of `_runAgentPrompt()`, the only place a run begins |
| `session_before_compact` | a compaction is starting | emitted to extensions only when a handler exists; **handler must return `undefined`** — a result object can `cancel` or replace the compaction |
| `session_compact` | a compaction succeeded | manual and automatic paths |
| `session_compact_failed` | a compaction failed or was aborted | manual failure, automatic failure, both abort paths, failed overflow recovery |
| `session_start`, `session_shutdown` | session lifecycle | `/new`, `/resume` and `/reload` rebuild the runtime and re-run extension factories |

**Guarantees, stated precisely:**

- `agent_start` and `agent_settled` are **not** one-to-one. Retries and overflow recovery produce
  `start → start → settled`. `_runAgentPrompt()` can also settle without any start if
  `agent.prompt()` rejects first. The extension therefore tracks **state**, never counts events.
- `agent_settled` fires on the normal completing path, after all retries and continuations. It is
  **not** guaranteed if a flush in that `finally` throws before `_emitAgentSettled()`, or if another
  extension's handler never resolves (handlers are awaited sequentially without a timeout). §4's
  staleness rule covers those cases without declaring completion.
- **Compaction runs outside `_runAgentPrompt()`**: manual `/compact` first aborts the current run
  (a real run end), then compacts; pre-prompt automatic compaction happens before the run's first
  `agent_start`. The compaction events cover these.
- One gap: a successful **manual** compaction whose saved entry cannot be found emits no
  `session_compact`. The extension also clears its compacting flag on `agent_start` and
  `session_shutdown`.

Other verified facts:

- The extension runner dispatches by `event.type` and catches handler rejections; a failing handler
  does not crash pi.
- `-e <path>` loads through `jiti`, which requires a default-exported function; codex exercised pi's
  real loader with a tsc-style ESM `.js` `export default function` — one extension loaded, zero
  errors. `-e` works alongside discovered extensions and with `--no-extensions`.
- Extension dispatch is runner-local: an instance does not receive other sessions' or subagents'
  events. But a second runtime in the same process inherits `CODEMAN_SESSION_ID`, so payloads need a
  producer identity (§3).
- pi requires Node ≥ 22.19 and runs on v24.19.0 here: global `fetch` and `AbortSignal.timeout` exist.
- A pi process spawned by Codeman has `CODEMAN_SESSION_ID` and `CODEMAN_API_URL=http://localhost:3001`
  in its environment (read from the live process).
- `ctx.sessionManager.getSessionFile()` is public and returns the session file path **before** pi
  creates the file (pi defers creating it until the first assistant message).
- pi's bash tool spawns a child process asynchronously, so heartbeats run during long commands.
  Custom extension tools run in-process and can block the event loop.

### codex: its transcript records

codex's rollout has explicit, persisted boundaries:

```
event_msg/task_started          <- turn begins
response_item/… (messages, tool calls, tool outputs)
event_msg/task_complete         <- turn ends
event_msg/turn_aborted          <- turn interrupted
```

Local counts: `task_started` 493, `task_complete` 475, `turn_aborted` 4. No codex error records exist
locally, so no error mapping is inferred. Record size is unbounded: rollout
`2026-08-28T11-29-16-01a04821…` has a **311,955-byte** single line after its `task_started`.

## Design

### 1. Activity source is a harness property

`HarnessDefinition` gains `activity: 'claudeTranscript' | 'hook' | 'transcript' | 'pty'`:

| harness | `activity` |
|---|---|
| claude | `claudeTranscript` |
| pi | `hook` |
| codex | `transcript` |
| opencode, shell | `pty` |

### 2. The pi extension

`src/harnesses/pi/codeman-activity-extension.ts`, compiled by the build's `tsc` step to
`dist/harnesses/pi/codeman-activity-extension.js`. **No imports** — it runs in pi's process.

**State:** `runActive` and `compacting`; reported state is `working` if either is true, else `idle`.

| event | action |
|---|---|
| `agent_start` | `runActive = true`; `compacting = false`; post |
| `agent_settled` | `runActive = false`; post |
| `session_before_compact` | `compacting = true`; post; **return `undefined`** |
| `session_compact`, `session_compact_failed` | `compacting = false`; post |
| `session_start` | post (carries the session file path) |
| `session_shutdown` | both false; post; clear heartbeat |
| heartbeat, every 30 s | post current state |

Posts go only when the state or session file changed, or on the heartbeat.

- If `CODEMAN_SESSION_ID` or `CODEMAN_API_URL` is missing, the factory registers nothing.
- **Payload:** `POST {CODEMAN_API_URL}/api/hook-event` with
  ```json
  { "event": "harness_activity", "sessionId": "…",
    "data": { "state": "working", "producerId": "<uuid>", "producerStartedAt": 1789043157634,
              "seq": 12, "sessionFile": "/home/…/.pi/agent/sessions/…/….jsonl" } }
  ```
  `producerId` is a random UUID per factory invocation; `producerStartedAt` is its creation time;
  `seq` increases on every post from that producer.
- Fire-and-forget with `AbortSignal.timeout(2000)`; every error swallowed; the extension never throws.
  The heartbeat interval is `unref()`'d.
- The URL is exactly `/api/hook-event` with no query string — the localhost auth exemption compares
  `req.url` exactly (`src/web/middleware/auth.ts`).

**Spawn:** `piHarness.buildCommand` appends `-e <shellQuote(absolutePath)>`, resolved from
`import.meta.url` (`.js` under `dist`, `.ts` from source). If the file is missing, log one warning and
spawn without it.

### 3. Server: one ordered, activity-only hook event

`HookEventSchema` adds `harness_activity`. In `POST /api/hook-event`, branch **immediately after the
session lookup and paused check** — before the existing `transcript_path` handling, which would
otherwise start a watcher:

1. Accept only when the session's harness has `activity: 'hook'`.
2. Validate `data`: `state` is `working` or `idle`; `producerId` a UUID; `producerStartedAt` and `seq`
   finite non-negative integers.
3. **Order and producer check**, per session:
   - `producerStartedAt` newer than the current producer's → this producer replaces it;
   - same producer → accept only if `seq` is greater than the last accepted;
   - otherwise (older producer, or stale `seq`) → ignore.
   This rejects a delayed heartbeat arriving after `idle`, and an old session's shutdown arriving after
   its replacement started working.
4. If `sessionFile` is present and the session has no transcript watcher, start one (§6).
5. Call `session.applyHookActivity(state)` and **return** — no `hook:*` broadcast, push notification,
   run-summary hook record, vault capture or orchestrator call.

`applyHookActivity` emits `working`/`idle` like any monitor, so the session listeners still run; that is
intended.

The route is auth-exempt only for `127.0.0.1`, `::1` and `::ffff:127.0.0.1`. Local processes can already
forge Claude hook events; these only change activity for pi sessions.

### 4. `Session` activity lifecycle

```ts
interface ActivityMonitor extends EventEmitter {
  readonly state: 'working' | 'idle' | 'unknown';
  start(): Promise<void>;
  stop(): void;
  setHarnessSessionId?(id: string): void;
}
type IdleReason = 'completed' | 'stale';
```

Implementations: `ClaudeActivityMonitor` (**detection unchanged**; gains a `state` getter over
`_isBusy`), `HookActivityMonitor` (pi), `CodexTranscriptActivityMonitor` (§5).

**Completion vs staleness.** `Session` emits `idle` with `{ reason }`:

- `completed` — an authoritative end: Claude's turn records, pi's `idle` report, codex
  `task_complete`/`turn_aborted`.
- `stale` — tracking was lost: pi sent nothing for **90 s** while `working` (three missed heartbeats),
  or codex wrote nothing for **5 minutes** while `working`.

The server `idle` listener always broadcasts `SessionIdle` and the debounced session state. **Only for
`completed`** does it call `RunSummaryTracker.recordIdle` and `compactContinue.onIdle()`. A stale idle
therefore updates the UI without claiming the turn finished. A later authoritative report corrects it.

**One attach and one detach path**, for every harness and lifecycle entry:

- `_attachActivityMonitor()` detaches any existing monitor, sets both `_isWorking = false` and
  `_status = 'idle'` **without emitting**, creates the monitor for the harness's `activity`, and
  starts it. Initial state `working` → set both fields, emit `working`. Initial `idle` or `unknown` →
  set fields, emit **nothing**.
- `_detachActivityMonitor()` is idempotent. Each monitor has a generation that its callbacks check, and
  the generation also bumps on identity change, so late callbacks change nothing.
- This **fixes a pre-existing Claude leak**: PTY `onExit` and `prepareForRestart()` do not stop the
  monitor today, so the next `startInteractive()` allocates another watcher.

**Every writer of `_status` / `_isWorking`:**

| Writer | Monitored sessions (`activity !== 'pty'`) |
|---|---|
| `startInteractive()` entry | replaces the Claude-only branch with `_attachActivityMonitor()` |
| `startInteractive()` failure | detach; both fields idle; no event |
| settle timer | emits `needsRefresh` only; does not write `_status` |
| restored mux session | covered by attach |
| PTY `onExit` | detach; both fields idle; no event (server `exit` handler finalises the summary) |
| `prepareForRestart()` | detach; both fields idle; no event |
| `rebindMuxSession()` | **increment `_ptyGeneration` before killing the old PTY** (today it increments only after spawning the replacement, so the old exit callback can run as current for ~300 ms); then detach and re-attach, because the target mux session may run a different process |
| `rebindMux()` | unchanged: `stop` + `startInteractive` re-attach |
| `recordHarnessSessionId(id)` | `this._activityMonitor?.setHarnessSessionId?.(id)`; a restored session supplies its constructor-seeded id at attach |
| PTY fallback (×2) | unchanged; runs only when `activity === 'pty'` |
| `sendInput()`, `assignTask()`, `clearTask()`, legacy `start()` | skip their `_status` writes when a monitor is attached |
| `startShell()`, `runPrompt()` | out of scope: shell mode and Claude one-shot only, never a monitored interactive harness |
| `pause` / `clearPaused` | unchanged (pause is capability-blocked for codex and pi) |

A mux PTY exit is an attach-client exit, not proof the harness stopped. Activity is not tracked while
detached; the next attach recovers it (codex by scanning, pi within one heartbeat).

### 5. `CodexTranscriptActivityMonitor`

Emits only on transitions. Classification is a `classifyActivity(record)` hook on the codex transcript
adapter:

| record | signal |
|---|---|
| `event_msg` / `task_started` | working |
| `event_msg` / `task_complete` | idle (`completed`) |
| `event_msg` / `turn_aborted` | idle (`completed`) |
| anything else | null |

**Locating:** `codexTranscriptAdapter.locate({ workingDir, sessionId, harnessSessionId })`; retried every
2 s while null. `setHarnessSessionId(id)` bumps the generation and re-locates at once.

**Initial state — backward scan:**

1. `stat` the file and record its **inode and size** as the scan identity; the size is the captured EOF.
2. Read backward from EOF in 256 KB chunks. Keep each chunk's incomplete leading fragment and prepend
   the next earlier chunk. At byte 0 the fragment is a complete line.
3. A trailing fragment after the last newline at EOF is **not** scanned; it seeds the pending buffer.
4. Process reconstructed complete lines newest-first; stop at the first non-null signal.
5. Budget 16 MB total. If exhausted, or if the budget cuts through a record that has not been
   classified, the result is `unknown`. **Never skip a split record and accept an older boundary.**
6. Before publishing, `stat` again. If the inode differs, or the size is below the captured EOF,
   discard the result and rescan.

**Runtime:**

- **Offsets:** the consumed offset is the captured EOF; pending-buffer bytes are counted once, as part
  of that offset. Arm the watcher, then read from the consumed offset to the current size before
  handling events.
- **Pending buffer:** capped at 4 MB. On overflow, drop it, set a discard-until-newline flag so the
  remainder of that record is never parsed as a record, and warn once.
- **Bounded reads:** at most 4 MB per pass, looping until caught up.
- **Replacement and truncation:** on every change event and every 2 s poll, `stat`. If the inode changed
  or the size dropped below the offset, clear the pending buffer and discard flag, cancel timers, rescan,
  and re-arm the watcher on the new file. On rename or delete, re-run `locate()`.
- **Staleness:** working with no write for 5 minutes → idle (`stale`).
- **Watch errors:** fall back to the 2 s poll.

### 6. Streaming pi's first turn live

pi creates its session file only at its first assistant message, so a locator finds nothing during
the first turn, and `startHarnessTranscriptWatcher()` returns before creating a watcher.

1. **Use pi's own path.** The extension sends `sessionFile` from `ctx.sessionManager.getSessionFile()`.
   The server canonicalises it and requires it to lie under pi's sessions root — `PI_CODING_AGENT_DIR`
   if set in Codeman's environment, else `~/.pi/agent`, plus `/sessions`. Since the file may not exist,
   containment is checked on the resolved **parent directory**. A path failing containment is ignored.
2. **Watch before the file exists.** `TranscriptWatcher` already starts at offset 0 and polls when the
   file is missing (verified). When the file already exists, start with a new
   `start(path, { fromOffset: 0 })`.
3. **Transcript identity.** Today REST sends only `X-Total-Blocks`, and SSE carries
   `{ sessionId, block }`. Add a `transcriptId`, generated whenever a watcher starts on a file or detects
   replacement: sent as `X-Transcript-Id` on `GET /api/sessions/:id/transcript`, and included in
   `transcript:block`, `transcript:clear` and `transcript:ready`. The client stores it per session.
4. **Deduplicate within an identity.** `TranscriptView.append()` and the inactive-view push in
   `_onTranscriptBlock` both:
   - if the block's `transcriptId` differs from the stored one → treat as a clear, reset stored blocks,
     adopt the new id, then append;
   - otherwise skip the block unless `_isNewerBlock(block, lastStoredBlock)`.

   `seq` is `byteOffset × 1000 + blockIndex`. (Correction to revision 3: the periodic incremental sync
   already uses `_isNewerBlock`; the live `append` path does not.) Comparing `seq` only within one
   `transcriptId` prevents a missed `transcript:clear` from rejecting a new file's lower `seq` values.
5. **Detect equal-size replacement.** `TranscriptWatcher` resets only when a file shrinks. Also compare
   the inode on each read; on change, emit `transcript:clear` with a new `transcriptId` and read from 0.

### 7. Gate auto-compact-and-continue to Claude

Skip `compactContinue.onIdle()` unless `caps.claudeTranscript`, and reject enabling it in
`POST /api/sessions/:id/auto-compact-continue` for other harnesses.

## Non-goals

- Changing `ClaudeActivityMonitor`'s detection logic.
- opencode and shell (they keep the PTY fallback).
- Mapping codex error records.
- Hermes `done` detection, orchestrator stall nudging, Board card movement.

## Known limitations

1. **pi sessions started before deployment** lack the extension until restarted.
2. **A pi custom tool that blocks the event loop for over 90 s** produces a stale idle. It is marked
   `stale`, so no completion side effects fire, and the next heartbeat corrects it.
3. **Codex identity delay:** discovery normally lands within ~150 ms of `task_started`, but backs off
   up to 30 s, and the adapter caches locate misses for 15 s.
4. **Concurrent codex sessions in one directory** can be misassociated.
5. **An errored codex turn** writing neither `task_complete` nor `turn_aborted` goes `stale` after
   5 minutes.
6. **Localhost processes can forge activity reports** for pi sessions, as they can Claude hooks.

## Testing

**pi extension** (unit; fake `pi.on` registry, fake timers, mocked `fetch`):
- no env vars → registers nothing;
- `agent_start, agent_start, agent_settled` → working then idle, never a count mismatch;
- `agent_settled` with no prior start → idle, no error;
- `session_before_compact` → working, and the handler returns `undefined`;
- `session_compact` and `session_compact_failed` → idle when no run is active;
- manual-compact gap: compacting then `agent_start` clears compacting;
- `seq` strictly increases; `producerId` is stable per factory invocation;
- heartbeat re-posts; `session_shutdown` posts idle and clears the interval;
- a rejecting or hanging `fetch` never throws;
- the payload URL has no query string.

**pi harness:** `buildCommand` includes `-e '<path>'`; missing file → no `-e`, one warning.

**Route:**
- pi `harness_activity` updates activity; rejected for claude, codex, shell and opencode;
- **zero** `hook:*` broadcasts, push notifications, run-summary hook records, vault captures and
  orchestrator calls — asserted separately from the intended `working`/`idle` listener effects;
- the branch runs before `transcript_path` handling;
- ordering: stale `seq` ignored; an older producer's `idle` after a newer producer's `working` ignored;
  a newer producer supersedes;
- `sessionFile` outside the pi sessions root is ignored; inside it starts a watcher on a missing file.

**Session lifecycle:**
- monitor type per `activity`; shell/opencode keep the PTY fallback;
- initial idle emits **zero** `idle`; initial working emits exactly one `working`;
- restored-idle, restored-working, no-file/no-id and working-before-settle end correctly;
- the settle timer does not overwrite a monitor-reported `working`;
- PTY exit, `prepareForRestart` and `startInteractive` failure set both fields idle, emit nothing, and
  dispose the monitor; **repeated restarts leave exactly one live watcher** (the Claude leak);
- `rebindMuxSession` bumps the PTY generation before killing: a late exit from the old PTY changes
  nothing; the monitor is re-attached;
- `sendInput`/`assignTask`/`clearTask` do not write status while a monitor is attached;
- `stale` idle broadcasts `SessionIdle` but does **not** call `recordIdle` or `compactContinue.onIdle`;
  `completed` idle does both;
- auto-compact-and-continue never runs for codex/pi and cannot be enabled for them.

**Codex monitor** (temp dirs, fake timers, real fixture lines):
- classification per row, unknown and malformed lines;
- initial scan idle, working, `unknown`;
- a record over 256 KB spanning chunks; a complete first line at byte 0; a budget cut through an
  unclassified record → `unknown`;
- a trailing unterminated fragment at EOF seeds the pending buffer and is parsed once completed;
- replacement between scan and publish triggers a rescan;
- writes between scan and watch are not skipped;
- oversized pending line: the remainder is discarded, not parsed as a record;
- truncation and **equal-size replacement** (inode change) reset and rescan;
- 5 minutes of silence → `stale` idle; watch error falls back to polling;
- `setHarnessSessionId` on a file containing `task_started` → working.

**Transcript streaming:**
- pi's watcher starts from `sessionFile` before the file exists, and the first turn's blocks are
  broadcast;
- replaying from 0 renders no duplicates in the visible view or the inactive-view buffer;
- a block with a new `transcriptId` after a missed clear resets and renders;
- equal-size replacement emits `transcript:clear` with a new id.

**Live verification (acceptance), on the deployed app:**
a new pi session goes busy when a turn starts and idle when it settles — dot turns green, working
bubble clears; a codex session shows busy mid-turn and idle after `task_complete`; a new pi session's
first turn streams into the transcript view without a reload.

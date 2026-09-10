# Harness Activity Detection (busy/idle for codex and pi)

**Date:** 2026-09-10
**Status:** Design, revision 3 (after two codex reviews)
**Scope:** Correct busy/idle status for `codex` and `pi` sessions.

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
   (`if (!this._activityMonitor && …)`). **There are two copies**: in `startInteractive()` and in
   `rebindMuxSession()`.
   - **busy** when output matches `SPINNER_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧]/`
     (`src/utils/regex-patterns.ts:81`)
   - **idle** only when output contains Claude's prompt glyph `❯` (U+276F)

pi draws braille spinner frames, so it goes busy, and never prints `❯`, so it never goes idle.
codex draws `·` and `•` (captured from its pane), which do not match; its prompt is `›` (U+203A).
The keyword detector ("Thinking", "Writing", …) does not apply: it lives in
`_processExpensiveParsers`, which returns early without `caps.claudeParsers`.

This predates the transcript feature; `src/session.ts` was not modified by it.

### Every path that writes activity state today

Locate these by content; line numbers shift.

| Path | Effect on `_status` / `_isWorking` |
|---|---|
| Construction | `_isWorking = false` |
| `startInteractive()` entry | `_status = 'busy'`; `_isWorking` untouched |
| New-session settle timer (`readiness.kind === 'settle'`) | `_status = 'idle'` only; emits `needsRefresh`, not `idle` |
| Restored mux session branch | no settle timer — keeps `busy` from entry |
| Interactive PTY `onExit` | `_status = 'idle'` unless paused; `_isWorking` untouched; **monitor not stopped** |
| `stop()` | stops and nulls the monitor |
| `prepareForRestart()` | kills the PTY; **monitor not stopped** |
| `rebindMuxSession()` | forces `idle` / `false`; keeps the old monitor |
| `rebindMux()` | `stop(false)` then `startInteractive()` |
| PTY fallback (×2) | spinner → busy; `❯` → idle |
| `pause` / `clearPaused` | stopped / idle (pause is capability-blocked for codex and pi) |

### Consequences of fixing it

Once codex and pi emit real `working`/`idle` events, these fire for them (`server.ts` session
listeners; `app.js` `_onSessionIdle` / `_onSessionWorking`):

- SSE status → header dot, tab status, transcript working bubble (`TranscriptView.setWorking`).
- Frontend "Session Idle" warning timer (default 10 min), cancelled by `working`.
- `RunSummaryTracker.recordWorking` / `recordIdle`; a false idle ends active-time accounting.
- **Auto-compact-and-continue**: `session.compactContinue.onIdle()` has no harness gate. If enabled,
  it types Claude's `/compact\r` when a fresh `COMPACT.md` exists — which Codeman worktrees use.
  No session has it enabled today (checked `~/.codeman/state.json`); nothing prevents enabling it.
- pi's view-only transcript watcher attaches on idle (§6).

**A premature idle now has real side effects**, so the design favours authoritative signals over
inference.

## Decision: an authoritative signal per harness

Two review rounds established that the two harnesses need different sources of truth.

### pi: its own lifecycle events, via a Codeman extension

**Inference from pi's session file cannot work reliably.** Verified in pi 0.85.1's installed source
(`dist/core/agent-session.js`):

- Failed attempts are persisted as `stopReason: error` records, then pi retries with backoff
  `baseDelayMs × 2^(k−1)` up to `maxRetries`. Whether a given error will be retried is decided at
  runtime and **never persisted**; the final failure is a runtime-only `auto_retry_end` event.
- `_retryAttempt` resets on any non-error assistant message and on cancellation — not derivable from
  record counts.
- Assistant messages are persisted only at `message_end`. With the default `httpIdleTimeoutMs`
  of 300,000 ms, a legitimate retry can run minutes with no write, so transcript silence proves
  nothing.
- Compaction cuts both ways: overflow compaction can continue a run even with retries disabled,
  while threshold compaction persists its `compaction` record *after* completing, with no
  continuation.
- Retry settings can come from `PI_CODING_AGENT_DIR`, project settings that are skipped when the
  project is untrusted, and in-memory overrides, so files on disk need not match the running process.

**pi exposes the exact signal we need to extensions:**

- `_runAgentPrompt()` is the single place a run starts (the only `_isAgentRunActive = true`). It runs
  the prompt and then every retry and compaction continuation inside
  `while (await this._handlePostAgentRun()) await this.agent.continue()`, and calls
  `_emitAgentSettled()` in its `finally`. **`agent_settled` therefore fires exactly once per run,
  after all retries and compaction, on every exit path including aborts and exceptions.**
- `_emitAgentSettled()` sends it to extensions: `this._extensionRunner.emit({ type: "agent_settled" })`.
- `agent_start` is forwarded to extensions when a run begins.
- Both are public, typed extension API (`dist/core/extensions/types.d.ts`:
  `on(event: "agent_start" | "agent_settled", …)`), and pi's docs describe `agent_settled` as
  "no retry/compaction/follow-up left".
- The extension runner dispatches by `event.type` and catches handler exceptions, so a failing
  handler cannot crash pi.
- Extensions are loaded with `-e <path>` via `jiti`, which accepts `.ts` and `.js`.
- A pi process spawned by Codeman already has `CODEMAN_SESSION_ID` and
  `CODEMAN_API_URL=http://localhost:3001` in its environment (read from the live pi process's
  `/proc/<pid>/environ`).

This mirrors how Codeman already uses Claude Code hooks.

### codex: its transcript records

codex's rollout has explicit, persisted turn boundaries, so reading the file is sound:

```
event_msg/task_started          <- turn begins
response_item/… (messages, tool calls, tool outputs)
event_msg/task_complete         <- turn ends
event_msg/turn_aborted          <- turn interrupted
```

Local counts: `task_started` 493, `task_complete` 475, `turn_aborted` 4. No codex error records
exist locally, so **no error mapping is inferred**.

Record size is unbounded: rollout `2026-08-28T11-29-16-01a04821…` has a **311,955-byte** single line
right after its `task_started` (§5).

## Design

### 1. Activity source is a harness property

`HarnessDefinition` (`src/harnesses/types.ts`) gains:

```ts
/** Where busy/idle comes from for this harness. */
activity: 'claudeTranscript' | 'hook' | 'transcript' | 'pty';
```

| harness | `activity` |
|---|---|
| claude | `claudeTranscript` |
| pi | `hook` |
| codex | `transcript` |
| opencode, shell | `pty` |

### 2. The pi extension

New file `src/harnesses/pi/codeman-activity-extension.ts`, compiled by the build's `tsc` step into
`dist/harnesses/pi/codeman-activity-extension.js`. **No imports** — it runs inside pi's process, not
Codeman's.

```ts
export default function (pi) {
  // no-op outside Codeman
  // agent_start      -> post 'harness_working'
  // agent_settled    -> post 'harness_idle'
  // session_shutdown -> post 'harness_idle'
  // heartbeat        -> every 30 s, post the current state
}
```

- Reads `CODEMAN_SESSION_ID` and `CODEMAN_API_URL` from `process.env`; if either is missing, it
  registers nothing.
- Posts `POST {CODEMAN_API_URL}/api/hook-event` with `{ event, sessionId }`, fire-and-forget, with a
  2-second `AbortSignal.timeout`. Every error is swallowed; the extension never throws.
- **Heartbeat:** every 30 s it re-posts its current state. This recovers after a Codeman restart
  (which does not restart pi) and after a lost request. Codeman applies only transitions, so repeats
  cost nothing.
- The interval timer is `unref()`'d and cleared on `session_shutdown`.

**Spawn:** `piHarness.buildCommand` appends `-e <shellQuote(absolutePath)>`. The path is resolved from
`import.meta.url` (the pattern `server.ts` already uses), picking `.js` under `dist` or `.ts` when
running from source. If the file is missing, log one warning and spawn without it.

**Existing pi sessions** started before deployment lack the extension; they are fixed on their next
start. Known limitation, not migrated.

### 3. Server: activity-only hook events

`HookEventSchema` (`src/web/schemas.ts`) adds `harness_working` and `harness_idle`.

In `POST /api/hook-event`, these two events:

1. are accepted only when the session's harness has `activity: 'hook'` — a forged event cannot change
   a Claude session's status;
2. call `session.applyHookActivity('working' | 'idle')`;
3. **return immediately** — no `hook:*` SSE broadcast, no push notification, no run-summary hook
   record, no vault capture, no orchestrator completion. Those are Claude `stop` semantics and must
   not fire twice per pi turn or on every heartbeat.

The route is already exempt from auth **only for localhost** (`127.0.0.1`, `::1`,
`::ffff:127.0.0.1`; `src/web/middleware/auth.ts`). Any local process can already forge Claude hook
events; these events only change activity status, so the trust model is unchanged.

**Staleness:** if a hook-sourced session reports `working` and no `harness_*` event arrives for 90 s
(three missed heartbeats), it goes idle. This covers pi being killed mid-run, when `agent_settled`
never fires.

### 4. `Session` activity lifecycle

```ts
interface ActivityMonitor extends EventEmitter {
  readonly state: 'working' | 'idle' | 'unknown';
  start(): Promise<void>;
  stop(): void;
  setHarnessSessionId?(id: string): void;
}
```

Implementations:

- `ClaudeActivityMonitor` — **detection logic unchanged**; gains only a `state` getter over its
  existing `_isBusy`.
- `HookActivityMonitor` (pi) — state fed by `applyHookActivity`; owns the 90 s staleness timer.
- `CodexTranscriptActivityMonitor` (codex) — §5.

**One attach path and one detach path**, used by every lifecycle entry and every harness:

- `_attachActivityMonitor()` detaches any existing monitor first, sets both `_isWorking = false` and
  `_status = 'idle'` **without emitting**, creates the monitor for the harness's `activity`, and
  starts it. When initial state resolves to `working`, it sets both fields and emits `working`; for
  `idle` or `unknown` it sets the fields and emits **nothing**. An idle event at startup would fire
  completion side effects for a turn that did not just end.
- `_detachActivityMonitor()` is idempotent. Every monitor carries a generation number that its
  callbacks check, so a late callback from a disposed monitor, or from before an identity change,
  changes nothing.
- This **fixes a pre-existing leak for Claude**: PTY `onExit` and `prepareForRestart()` do not stop the
  monitor today, and the next `startInteractive()` allocates another watcher.
- The PTY fallback copies stay unchanged and apply only when `activity === 'pty'`.

**Per path:**

| Path | New behaviour for monitored harnesses |
|---|---|
| `startInteractive()` | `_attachActivityMonitor()` (replaces the Claude-only branch) |
| settle timer | emits `needsRefresh` only; does not write `_status` |
| restored mux session | covered by attach: initial state decides |
| PTY `onExit` | detach; set both fields idle, no idle event (the server `exit` handler already finalises the summary and removes listeners) |
| `prepareForRestart()` | detach; set both fields idle, no event |
| `rebindMuxSession()` | keep the monitor — rebind keeps the same session id, working directory, mode and harness identity, so there is nothing new to locate; re-synchronise both fields from `monitor.state` instead of forcing idle |
| `rebindMux()` | unchanged (`stop` + `startInteractive` re-attaches) |
| `recordHarnessSessionId(id)` | `this._activityMonitor?.setHarnessSessionId?.(id)`; a restored session passes its constructor-seeded id at attach time |

A mux PTY exit is an attach-client exit, not proof the harness stopped. Activity is not tracked while
detached; the next attach recovers it (codex by scanning, pi within one 30 s heartbeat).

### 5. `CodexTranscriptActivityMonitor`

Emits only on transitions.

**Classification** (a `classifyActivity(record)` hook on the codex transcript adapter):

| record | signal |
|---|---|
| `event_msg` / `task_started` | working |
| `event_msg` / `task_complete` | idle |
| `event_msg` / `turn_aborted` | idle |
| anything else | null |

**Locating:** `codexTranscriptAdapter.locate({ workingDir, sessionId, harnessSessionId })`. While it
returns null, re-run every 2 s. `setHarnessSessionId(id)` bumps the generation and re-locates
immediately.

**Initial state — backward scan with a carry rule:**

- Read backward from end of file in 256 KB chunks.
- Keep the incomplete leading fragment of each chunk and prepend the next earlier chunk to it.
- Process reconstructed complete lines newest-first; stop at the first non-null signal.
- A trailing incomplete line at end of file goes to the pending buffer, not the scan.
- Total budget 16 MB. If exhausted, or if the budget cuts through a record that has not been
  classified, the result is `unknown`. **Never skip a split record and accept an older boundary.**

**Runtime:**

- **Offset reconciliation:** arm the watcher first, then read from the scan's consumed offset up to the
  current size before handling events, so writes between scan and watch are not lost.
- **Partial lines:** a pending buffer carries the trailing incomplete record, capped at 4 MB; an
  oversized line is dropped with one warning and the monitor resynchronises at the next newline.
- **Bounded reads:** at most 4 MB per pass, looping until caught up.
- **Replacement and truncation:** on every change event and every 2 s poll, `stat` the path. If the size
  is below the offset or the inode changed, clear the pending buffer, cancel timers, rescan, and re-arm
  the watcher on the new file. On rename or delete, re-run `locate()`.
- **Crash recovery:** 5 minutes working with no writes → idle; reset on every write.
- **Watch errors:** fall back to the 2 s poll.

### 6. Streaming pi's first turn live

1. **Attach on first activity.** On a pi session's first `harness_working`, the server calls
   `startHarnessTranscriptWatcher`. The attach on idle stays as a fallback.
2. **Read from the start.** `TranscriptWatcher.start()` begins at end-of-file when the file exists.
   Add `start(path, { fromOffset })`; pass `fromOffset: 0` when the session had no watcher before.
   (When the file does not exist yet the watcher already polls from offset 0 — verify during
   implementation.)
3. **Deduplicate live blocks.** Today only the load-buffer replay checks `_isNewerBlock`; the live path
   does not. `TranscriptView.append()` and the inactive-view push in `_onTranscriptBlock` must skip a
   block that is not newer than the last stored block (`_isNewerBlock`, which compares `seq` when both
   blocks have one, else timestamp). `seq` is `byteOffset × 1000 + blockIndex`. Without this, replaying
   from 0 duplicates blocks already fetched over REST.

### 7. Gate auto-compact-and-continue to Claude

Skip `compactContinue.onIdle()` unless `caps.claudeTranscript`, and reject enabling it in
`POST /api/sessions/:id/auto-compact-continue` for other harnesses.

## Non-goals

- Changing `ClaudeActivityMonitor`'s detection logic.
- opencode and shell (they keep the PTY fallback).
- Mapping codex error records (none to validate against).
- Hermes `done` detection, orchestrator stall nudging, Board card movement.

## Known limitations

1. **pi sessions started before deployment** lack the extension until restarted.
2. **Codex identity delay:** discovery normally lands within ~150 ms of `task_started`, but backs off up
   to 30 s, and the adapter caches locate misses for 15 s.
3. **Concurrent codex sessions in one directory** can be misassociated: discovery matches `cwd` and file
   time, not the process.
4. **An errored codex turn** that writes neither `task_complete` nor `turn_aborted` goes idle via crash
   recovery after 5 minutes.
5. **Localhost processes can forge activity events** for hook-sourced sessions, as they already can for
   Claude hooks.

## Testing

**pi extension** (unit, with a fake `pi.on` registry, fake timers and a mocked `fetch`):
no env vars → registers nothing; `agent_start` → one `harness_working` post; `agent_settled` → one
`harness_idle` post; heartbeat re-posts current state; `session_shutdown` posts idle and clears the
interval; a rejecting or hanging `fetch` never throws.

**pi harness:** `buildCommand` includes `-e '<path>'`; missing file → no `-e` and one warning.

**Route:** `harness_working`/`harness_idle` update activity for a pi session; are rejected for claude,
codex, shell and opencode; produce **zero** `hook:*` broadcasts, push notifications, run-summary hook
records, vault captures and orchestrator calls.

**Session lifecycle:**
- claude → `ClaudeActivityMonitor`, pi → `HookActivityMonitor`, codex →
  `CodexTranscriptActivityMonitor`, shell/opencode → none plus PTY fallback;
- initial idle emits **zero** `idle` events; initial working emits exactly one `working`;
- restored-idle, restored-working, no-file/no-id and working-before-settle all end correctly;
- the settle timer does not overwrite a monitor-reported `working`;
- `rebindMuxSession` re-synchronises from `monitor.state`;
- PTY exit and `prepareForRestart` set both fields idle, emit nothing, and dispose the monitor;
  **repeated restarts leave exactly one live watcher** (the Claude leak);
- pi: `harness_working` then 90 s of silence → idle (staleness);
- a late callback from a disposed monitor changes nothing;
- auto-compact-and-continue never runs for codex/pi and cannot be enabled for them.

**Codex monitor** (temp dirs, fake timers, real fixture lines):
classification for every row plus unknown and malformed lines; initial scan idle, working and
`unknown`; **a single record larger than 256 KB spanning chunk boundaries**; a budget cut through an
unclassified record → `unknown`; runtime cycle working → idle once; `turn_aborted` → idle; writes
between scan and watch are not skipped; partial line across writes; oversized line resynchronises;
truncation, and **replacement with an equal-sized file** (inode change), reset and rescan; crash
recovery after 5 minutes; watch error falls back to polling; `setHarnessSessionId` on a file containing
`task_started` → working.

**Transcript streaming:** pi's watcher attaches on first `harness_working` and broadcasts the first
turn's blocks; replaying from 0 renders no duplicate block in the **visible** view or in the
**inactive-view** buffer.

**Live verification (acceptance), on the deployed app:**
a new pi session goes busy when a turn starts and idle when it settles — dot turns green, working
bubble clears; a codex session shows busy mid-turn and idle after `task_complete`; a new pi session's
first turn streams into the transcript view without a reload.

# Harness Activity Detection (busy/idle for codex and pi)

**Date:** 2026-09-10
**Status:** Design, revision 2 (after codex review)
**Scope:** Correct busy/idle status for `codex` and `pi` sessions by deriving it from their
transcript files, the way `claude` sessions already do.

## Problem

Observed live on the deployed app (2026-09-10, sessions `e1861751` pi, `6daa4ee2` codex):

- **pi is busy forever.** After its turn finished, `/api/sessions` reported
  `status: busy, isWorking: true`. The header dot stayed amber and the transcript view showed
  "Engaging cortex..." indefinitely, although pi's pane was static and showed the finished turn.
- **codex never shows busy** while working.

### Root cause

`src/session.ts` has two activity mechanisms:

1. **`claude`** gets `ClaudeActivityMonitor` (in `startInteractive()`, the
   `if (this.mode === 'claude')` branch), which tails Claude's JSONL.
2. **Every other harness** falls back to PTY heuristics, which run only when no monitor exists
   (`if (!this._activityMonitor && …)`). **There are two copies** of this fallback: one in
   `startInteractive()` and one in `rebindMuxSession()`.
   - **busy** when output matches `SPINNER_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧]/`
     (`src/utils/regex-patterns.ts:81`)
   - **idle** only when output contains Claude's prompt glyph `❯` (U+276F)

pi draws braille spinner frames, so it goes busy, and never prints `❯`, so it never goes idle.
codex draws `·` and `•` (captured from its pane), which do not match, and its prompt is `›`
(U+203A). The text keyword detector ("Thinking", "Writing", …) does not help either: it lives in
`_processExpensiveParsers`, which returns early for harnesses without `caps.claudeParsers`.

This predates the transcript feature; `src/session.ts` was not modified by it.

### Every path that writes activity state today

Locate these by content; line numbers shift.

| Path | Effect on `_status` / `_isWorking` |
|---|---|
| Construction | `_isWorking = false` |
| `startInteractive()` entry | `_status = 'busy'`; `_isWorking` untouched |
| New-session settle timer (`readiness.kind === 'settle'`) | `_status = 'idle'` only; emits `needsRefresh`, **not** `idle` |
| Restored mux session branch | **no** settle timer — keeps `busy` from entry |
| Interactive PTY `onExit` | `_status = 'idle'` unless paused; `_isWorking` untouched; **monitor not stopped** |
| `stop()` | stops and nulls the monitor |
| `prepareForRestart()` | kills the PTY; **monitor not stopped** |
| `rebindMuxSession()` | forces `idle` / `false`; keeps the old monitor |
| `rebindMux()` | `stop(false)` then `startInteractive()` |
| PTY fallback (×2) | spinner → busy; `❯` → idle |
| `pause` / `clearPaused` | stopped / idle (pause is capability-blocked for codex and pi) |

### Consequences of fixing it

Once codex and pi emit real `working`/`idle` events, these fire for them (`server.ts` session
listeners, `app.js` `_onSessionIdle` / `_onSessionWorking`):

- SSE status → header dot, tab status, transcript working bubble
  (`TranscriptView.setWorking`).
- Frontend "Session Idle" warning timer (default 10 min), cancelled by `working`.
- `RunSummaryTracker.recordWorking` / `recordIdle`. A false idle ends active-time accounting.
- **Auto-compact-and-continue**: `session.compactContinue.onIdle()` has no harness gate. If
  enabled, it types Claude's `/compact\r` when a fresh `COMPACT.md` exists in the working
  directory — which Codeman worktrees use. No session has it enabled today (checked
  `~/.codeman/state.json`), but nothing prevents enabling it.
- pi's view-only transcript watcher attaches on idle (see §6).

Correctness therefore matters more than it did while these harnesses never emitted anything:
**a premature idle has real side effects**, so the design prefers a delayed idle over a false one.

## Evidence: turn boundaries in each format

Verified against real files and, for pi, against its installed source.

### codex 0.154.0 rollout

```
event_msg/task_started          <- turn begins
response_item/… (messages, tool calls, tool outputs)
event_msg/task_complete         <- turn ends
```

Local `event_msg` counts: `task_started` 493, `task_complete` 475, **`turn_aborted` 4**, plus
non-boundary types. No local codex error records exist, so **no error mapping is inferred**;
unknown records are ignored (§2).

Record size is unbounded: rollout `2026-08-28T11-29-16-01a04821…` has a **311,955-byte** single
line immediately after its `task_started`. Any fixed tail window smaller than that can miss the
boundary entirely (§4).

### pi 0.85.1 session

```
message role=user                          <- turn begins
message role=assistant stopReason=toolUse  <- still working
message role=toolResult                    <- still working
message role=assistant stopReason=stop     <- turn ends
```

`stopReason` values in pi's source: `stop`, `toolUse`, `error`, `length`, `aborted`, `pending`.

**Retries** (`dist/core/agent-session.js`, `_prepareRetry`; `settings-manager.js`,
`getRetrySettings`):

- Failed attempts **stay in the session file** as `stopReason: error` records.
- Retry delay before attempt *k* is `baseDelayMs × 2^(k−1)`; pi stops after `maxRetries`.
- Defaults: `retry.maxRetries = 3`, `retry.baseDelayMs = 2000`, overridable in
  `~/.pi/agent/settings.json` (and project settings). `retry.enabled` can disable retries.
- The final failure is signalled only by a runtime event (`auto_retry_end`), **never persisted**.
- Context-overflow errors are not retried; they go to compaction.

Observed in `2026-09-08T09-35-40…01a0805f`: 4 consecutive `error` records per streak (1 attempt +
3 retries) with gaps of 5.0 s, 6.5 s, 10.4 s — the 2 s / 4 s / 8 s backoff plus request time.

**Compaction and `length`:** a recoverable `length` stop or a context overflow triggers one
compact-and-retry; the compaction is persisted as `type: "compaction"`
(`session-manager.js`, `appendCompaction`).

## Design

### 1. Classification lives on the transcript adapter

`TranscriptAdapter` (`src/harnesses/transcripts/types.ts`) gains an optional hook:

```ts
type ActivitySignal =
  | { kind: 'working' }
  | { kind: 'idle' }
  /** Turn attempt ended but the harness may continue on its own; see §3. */
  | { kind: 'maybeIdle'; attempt: 'error' | 'length' }
  | null;

/** Activity implied by one parsed JSONL record. Must never throw. */
classifyActivity?(record: unknown): ActivitySignal;
```

It takes the already-parsed record so the monitor parses each line once.

**codex:**

| record | signal |
|---|---|
| `event_msg` / `task_started` | working |
| `event_msg` / `task_complete` | idle |
| `event_msg` / `turn_aborted` | idle |
| anything else, including any future error type | null |

**pi:**

| record | signal |
|---|---|
| `message` role `user` | working |
| `message` role `toolResult` | working |
| `message` role `assistant`, `stopReason` `toolUse` or `pending` | working |
| `compaction` | working |
| `message` role `assistant`, `stopReason` `stop` or `aborted` | idle |
| `message` role `assistant`, `stopReason` `error` | maybeIdle (`error`) |
| `message` role `assistant`, `stopReason` `length` | maybeIdle (`length`) |
| anything else, including unknown `stopReason` | null |

### 2. `HarnessActivityMonitor`

New `src/harness-activity-monitor.ts`. Emits `working` and `idle` on **transitions only**, and
exposes a synchronous `state: 'working' | 'idle' | 'unknown'` getter.

**`ClaudeActivityMonitor`'s detection logic is not modified.** It is the most-used path.
Only its lifecycle is brought under the shared setup/teardown in §5.

Mechanism:

- **Path from the adapter.** `adapter.locate({ workingDir, sessionId, harnessSessionId })`.
  While it returns null, a poller re-runs `locate()` every 2 s. pi's file name carries a
  timestamp and codex's location depends on a discovered id, so a fixed path cannot be used.
- **`setHarnessSessionId(id)`** re-runs `locate()` immediately. It is declared on the shared
  interface (§5).
- **Offset reconciliation.** The initial scan records the byte offset it actually consumed up
  to. The watcher is armed first, then any bytes between that offset and the current size are
  read before handling events, so writes landing between scan and watch are not skipped.
- **Partial lines.** A trailing incomplete record is kept in a pending buffer across the scan and
  later appends. The buffer is capped (4 MB); an oversized line is dropped with one warning and
  the monitor resynchronises at the next newline.
- **Bounded runtime reads.** Each change event reads at most 4 MB per pass and loops until
  caught up, rather than allocating the whole unread delta.
- **Truncation or replacement.** Track size **and inode**. If the size drops below the offset or
  the inode changes, clear the pending buffer, cancel the retry and crash-recovery timers, and
  re-run the initial scan.
- **Crash recovery.** 5 minutes with no writes while working → idle, reset on every write.
  Same limit as Claude: a tool call silent for over 5 minutes goes idle early.
- **Watch errors.** If `fs.watch` fails or emits `error`, fall back to polling the file size
  every 2 s.
- **Generation guard.** Each monitor instance carries a generation number checked by every
  callback, so a late callback from a disposed monitor cannot change state.

### 3. pi retries: a computed window, not a fixed debounce

A `maybeIdle` signal does not change state immediately. The monitor counts **consecutive**
`maybeIdle(error)` records since the last `working` record that was not itself an error
(`attempt = n`), reads pi's retry settings, and decides:

- `retry.enabled === false`, or `n > maxRetries` → **idle now** (pi will not retry).
- Otherwise → arm an **expected-retry timer** for
  `baseDelayMs × 2^(n−1) + RETRY_LATENCY_MARGIN_MS` (margin 60 s, covering request time and
  pi's own HTTP idle timeout). Any further record cancels it: another error re-evaluates with
  `n + 1`; any working record keeps the session working; `stop` / `aborted` go idle. If the timer
  fires with no new record → idle.

`maybeIdle(length)` allows exactly one compact-and-retry: arm the same timer with
`n = 1`. A following `compaction` or new assistant record cancels it.

**Settings resolution:** read `retry` from `~/.pi/agent/settings.json`, overlaid by the project's
`.pi/settings.json` if present, with pi's defaults (`maxRetries 3`, `baseDelayMs 2000`,
`enabled true`) for anything missing. Re-read on each `maybeIdle`; settings are tiny.

**Why this is conservative rather than exact:** pi does not persist whether an error was
retryable. Non-retryable errors therefore wait out the window instead of going idle
immediately. That delays an idle by at most one window, and never produces a false idle.

### 4. Initial state: scan backward to a boundary

On first locating the file (and after truncation), recover state by reading **backward** in
256 KB chunks from the end, parsing complete lines, until a non-null signal is found:

- `working` → state working; emit **nothing** yet (§5 decides what to publish).
- `idle` → state idle.
- `maybeIdle` → state working, then evaluate §3 as if that record had just arrived, using the
  record's own timestamp to shorten the remaining window.
- **Scan budget:** 16 MB total. If exhausted without a boundary → state `unknown`.

`unknown` publishes as idle to the Session fields (§5) but arms no timers, and the first
classified record afterwards decides the real state.

### 5. `Session` wiring and lifecycle

**One setup and one teardown path**, used by every lifecycle entry, for Claude and harness
monitors alike:

```ts
interface ActivityMonitor extends EventEmitter {
  readonly state: 'working' | 'idle' | 'unknown';
  start(): Promise<void>;
  stop(): void;
  setHarnessSessionId?(id: string): void;
}

private _attachActivityMonitor(): void   // disposes any existing monitor first
private _detachActivityMonitor(): void   // idempotent
```

- `_attachActivityMonitor()` stops any existing monitor before creating a new one. This fixes a
  **pre-existing leak for Claude**: PTY `onExit` and `prepareForRestart()` do not stop the
  monitor, and the next `startInteractive()` allocates another.
- The harness monitor is created with the **current** `harnessSessionId`. A restored session
  gets that from the constructor, not through `recordHarnessSessionId()`, and pi records its id
  before the monitor exists. Waiting for a discovery event would never locate those files.
- `recordHarnessSessionId(id)` calls `this._activityMonitor?.setHarnessSessionId?.(id)`.

**Initial synchronisation is not an event.** Before `start()`, set both
`_isWorking = false` and `_status = 'idle'` (as the Claude branch does). When the initial scan
resolves to `working`, set both fields and emit `working`. When it resolves to `idle` or
`unknown`, set the fields and emit **nothing** — an idle event would fire completion side
effects for a turn that did not just end.

**Monitor ownership of activity.** For a session with a monitor:

- The settle timer emits only `needsRefresh`; it no longer writes `_status`.
- `rebindMuxSession()` re-synchronises the fields from `monitor.state` instead of forcing idle.
  Rebinding attaches a different mux session, which may run a different conversation, so it
  calls `_attachActivityMonitor()` to re-locate rather than keeping the old one.
- PTY `onExit` and `prepareForRestart()` call `_detachActivityMonitor()`.
- The PTY fallback copies stay as they are and remain the path for shell and opencode.

### 6. Server changes

1. **Attach pi's view-only transcript watcher when the file is located**, not on idle. The monitor
   emits `located(path)`; the server listens and calls `startHarnessTranscriptWatcher`. The idle
   attach stays as a fallback.
2. **Stream the first turn.** `TranscriptWatcher.start()` begins at end-of-file for an existing
   file. Add `start(path, { fromOffset })` and pass `fromOffset: 0` when the session had no
   transcript file before. Blocks already fetched over REST are deduplicated by the client's
   `seq` (a byte offset), so re-reading from 0 cannot duplicate them.
3. **Gate auto-compact-and-continue to Claude.** Skip `compactContinue.onIdle()` unless
   `caps.claudeTranscript`, and reject enabling it in `POST /api/sessions/:id/auto-compact-continue`
   for other harnesses.

## Non-goals

- Changing `ClaudeActivityMonitor`'s detection logic.
- opencode (no transcript adapter) and shell.
- Hermes `done` detection for codex and pi (their view-only watchers report no completion state).
- Orchestrator stall nudging and Board card movement (driven by other signals).

## Known limitations

1. **Concurrent codex sessions in one directory** can be misassociated: discovery matches `cwd`
   and file time, not the process. Activity now depends on that identity, which raises the cost
   of a mismatch. Documented, not fixed here.
2. **Codex error records are unmapped** until real fixtures exist. An errored codex turn that
   writes neither `task_complete` nor `turn_aborted` goes idle via crash recovery after 5 minutes.
3. **Codex identity delay.** Discovery normally lands within about 150 ms of `task_started`, but
   backs off up to 30 s, and the adapter caches locate misses for 15 s. Status can lag by that much
   on a first turn.
4. **Non-retryable pi errors** go idle only after one retry window (§3).

## Testing

Mirror `test/claude-activity-monitor.test.ts` (temp dirs, `vi.useFakeTimers`).

**Classification (per adapter, real fixture lines):** every table row; unknown record → null;
malformed line → null without throwing; unknown pi `stopReason` → null.

**Monitor (per harness):**
- initial state: idle, working, `maybeIdle` with a partly elapsed window, `unknown` after budget;
- **backward scan across a single line larger than 256 KB** (the 311,955-byte case);
- runtime cycle emits working once, then idle once;
- pi tool loop stays working;
- **pi retry streak** `error, error, error, stop` → no idle until `stop`;
- **pi exhausted retries** `error ×4` → idle only after the 4th, with `maxRetries: 3`;
- pi `retry.enabled: false` → idle on the first error;
- pi `length` then `compaction` then `stop` → working throughout, idle at the end;
- codex `turn_aborted` → idle;
- writes between scan and watch are not skipped;
- partial line across writes; oversized line dropped and resynchronised;
- truncation and replacement (inode change) reset buffer, timers and state;
- crash recovery after 5 minutes;
- watch error falls back to polling;
- a late callback from a disposed monitor changes nothing.

**Late and restored identity:** codex monitor with no id emits nothing; `setHarnessSessionId`
on a file containing `task_started` → working. A monitor constructed with a persisted id locates
immediately.

**Session wiring and side-effect counts:**
- codex/pi get `HarnessActivityMonitor`; shell/opencode get none and keep the PTY fallback; claude
  still gets `ClaudeActivityMonitor`;
- restored-idle, restored-working, no-file/no-id, and working-before-settle each end in the right
  state;
- **initial idle sync emits zero `idle` events**;
- a pi retry streak emits zero `idle` events until the final one;
- `rebindMuxSession` re-synchronises from monitor state and re-locates;
- PTY exit and `prepareForRestart` dispose the monitor, and repeated restarts leave exactly one
  live watcher (covers the Claude leak);
- auto-compact-and-continue does not run for codex/pi and cannot be enabled for them.

**Server:** pi's view watcher attaches on `located`, and the first turn's blocks are broadcast.

**Live verification (acceptance):** on the deployed app, a pi session goes busy during a turn and
back to idle after it, with the dot turning green and the working bubble clearing; a codex session
shows busy mid-turn and idle after `task_complete`; a new pi session's first turn streams into the
transcript view without a reload.

# Harness Activity Detection (busy/idle for codex and pi)

**Date:** 2026-09-10
**Status:** Design, revision 5 (after four codex reviews)
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

Once codex and pi emit real `working`/`idle` events, these run for them. The only production
subscriber to a session's `idle`/`working` events is the server's session listener
(`src/web/server.ts`, subscribed in `setupSessionListeners`):

- SSE `session:idle` / `session:working` → header dot, tab status, transcript working bubble;
  frontend "Session Idle" warning timer (default 10 min), cancelled by `working`.
- `RunSummaryTracker.recordWorking` / `recordIdle`, and token recording.
- pi's view-only transcript watcher attach.
- **Auto-compact-and-continue**: `session.compactContinue.onIdle()` has no harness gate. If enabled it
  types Claude's `/compact\r` when a fresh `COMPACT.md` exists — which Codeman worktrees use. No
  session has it enabled today (checked `~/.codeman/state.json`); nothing prevents enabling it.

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
| `session_before_compact` | a compaction is starting | emitted only when a handler exists; the runner uses a before-event's result only when truthy, so **returning `undefined` is a no-op** |
| `session_compact` | a compaction succeeded | manual and automatic paths |
| `session_compact_failed` | a compaction failed or was aborted | manual failure, automatic failure, both abort paths, failed overflow recovery |
| `session_start`, `session_shutdown` | session lifecycle | `/new`, `/resume` and `/reload` rebuild the runtime and re-run extension factories |

**Guarantees, stated precisely:**

- `agent_start` and `agent_settled` are **not** one-to-one. Retries and overflow recovery produce
  `start → start → settled`. `_runAgentPrompt()` can settle without any start if `agent.prompt()`
  rejects first. The extension tracks **state**, never counts events.
- `agent_settled` fires on the normal completing path, after all retries and continuations. It is **not**
  guaranteed if a flush in that `finally` throws before `_emitAgentSettled()`.
- **If another extension's handler never resolves**, handlers are awaited sequentially without a timeout,
  so this extension may never receive `agent_settled` — and its heartbeat keeps reporting `working`. No
  timeout can detect that from outside. **Known limitation.**
- **Compaction runs outside `_runAgentPrompt()`**: manual `/compact` first aborts the current run (a
  real run end), then compacts; pre-prompt automatic compaction happens before the run's first
  `agent_start`. The compaction events cover these.
- One gap: a successful **manual** compaction whose saved entry cannot be found emits no
  `session_compact`. The extension also clears its compacting flag on `agent_start` and
  `session_shutdown`.

Other verified facts:

- The extension runner dispatches by `event.type` and catches handler rejections.
- `-e <path>` loads through `jiti`, which requires a default-exported function; codex exercised pi's real
  loader with a tsc-style ESM `.js` `export default function` — one extension loaded, zero errors. `-e`
  works alongside discovered extensions and with `--no-extensions`.
- pi caches the factory per path, but the cache is invalidated on `/reload`, and modules are imported with
  `moduleCache: false` — **module-level state does not survive `/reload`**. Process-wide state must live on
  `globalThis`.
- Extension dispatch is runner-local, but a second runtime in the same process inherits
  `CODEMAN_SESSION_ID`.
- pi requires Node ≥ 22.19 and runs on v24.19.0 here: global `fetch` and `AbortSignal.timeout` exist.
- Codeman exports `CODEMAN_SESSION_ID`, `CODEMAN_MUX_NAME` and `CODEMAN_API_URL` in the spawn command for
  new sessions and respawned panes (`src/tmux-manager.ts`). A live pi process had
  `CODEMAN_API_URL=http://localhost:3001`.
- `ctx.sessionManager.getSessionFile()` is public and returns the path before pi creates the file. pi
  creates the session **directory** eagerly and defers the **file** to the first assistant message.
- pi's bash tool spawns a child asynchronously, so heartbeats run during long commands. Custom extension
  tools run in-process and can block the event loop.

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

### 2. Process ownership: a spawn token

Every time `Session` spawns or respawns a pi process it generates a random **activity token** (32 hex
chars), persists it as `SessionState.activityToken`, and passes it in the spawn context. `tmux-manager.ts`
exports it beside the existing variables, in both the create and respawn command prefixes:

```sh
export CODEMAN_ACTIVITY_TOKEN=<token>
```

The token identifies **the process Codeman launched**, independent of clocks and of pi's own session
switching. It is not a secret-grade credential — the hook route is already localhost-only — but it makes
reports from any other process, including a different process behind a re-attached pane, fail to match.

### 3. The pi extension

`src/harnesses/pi/codeman-activity-extension.ts`, compiled by the build's `tsc` step to
`dist/harnesses/pi/codeman-activity-extension.js`. **No imports** — it runs in pi's process.

**Process-wide counters** on `globalThis.__codemanActivity ??= { seq: 0, gen: 0 }`, so they survive
`/reload`'s module re-import. Each factory invocation takes `gen = ++g.gen`; every post takes
`seq = ++g.seq`.

**Per-runtime state:** `runActive`, `compacting`; reported state is `working` if either is true, else `idle`.

| event | action |
|---|---|
| `agent_start` | `runActive = true`; `compacting = false`; post |
| `agent_settled` | `runActive = false`; post |
| `session_before_compact` | `compacting = true`; post; **return `undefined`** |
| `session_compact`, `session_compact_failed` | `compacting = false`; post |
| `session_start` | post (carries the session file path) |
| `session_shutdown` | both false; post; clear heartbeat |
| heartbeat, every 30 s | post current state |

Posts go when the state or session file changed, or on the heartbeat.

- If `CODEMAN_SESSION_ID`, `CODEMAN_API_URL` or `CODEMAN_ACTIVITY_TOKEN` is missing, the factory registers
  nothing.
- **Payload:** `POST {CODEMAN_API_URL}/api/hook-event`
  ```json
  { "event": "harness_activity", "sessionId": "…",
    "data": { "state": "working", "token": "<32 hex>", "gen": 2, "seq": 17,
              "sessionFile": "/home/…/.pi/agent/sessions/…/….jsonl" } }
  ```
- Fire-and-forget with `AbortSignal.timeout(2000)`; every error swallowed; never throws. The heartbeat
  interval is `unref()`'d.
- The URL is exactly `/api/hook-event` with no query string — the localhost auth exemption compares
  `req.url` exactly (`src/web/middleware/auth.ts`).

**Spawn:** `piHarness.buildCommand` appends `-e <shellQuote(absolutePath)>`, resolved from
`import.meta.url` (`.js` under `dist`, `.ts` from source). If the file is missing, log one warning and spawn
without it; the session then has no activity tracking (§5 — `unknown`, no false busy or idle).

### 4. Server: one ordered, activity-only hook event

`HookEventSchema` adds `harness_activity`. In `POST /api/hook-event`, branch **immediately after the
session lookup and paused check** — before the existing `transcript_path` handling, which would otherwise
start a watcher:

1. Accept only when the session's harness has `activity: 'hook'`.
2. Validate `data`: `state` is `working` or `idle`; `token` 32 hex chars; `gen` and `seq` positive integers.
3. **Ownership and order**, per session, in memory:
   - `token` must equal `session.activityToken`; otherwise ignore. This rejects other processes, including
     after a re-attach.
   - `seq` must exceed the last accepted `seq`; otherwise ignore. `seq` is monotonic across the whole pi
     process, so a delayed heartbeat or an old runtime's late shutdown cannot overwrite newer state.
   - `gen` must be at least the highest accepted `gen`; a lower `gen` is a superseded runtime (`/new`,
     `/resume`, `/reload`) and is ignored even if its `seq` is higher.
   - **No prior state** (new session, or after a Codeman restart): the first valid report is accepted and
     initialises `lastSeq` and `ownerGen`.
4. Record `sessionFile` if present (§7).
5. Call `session.applyHookActivity(state)` and **return** — no `hook:*` broadcast, push notification,
   run-summary hook record, vault capture or orchestrator call.

`applyHookActivity` emits `working`/`idle` like any monitor, so the session listener still runs. That is
intended, and tests assert it separately from the suppressed hook effects.

**Residual:** a second in-process runtime created later than the primary (e.g. an in-process sub-agent that
loads this extension) would take ownership by `gen`. Codeman does not load the extension into other
runtimes; documented as a limitation.

### 5. `Session` activity lifecycle

```ts
interface ActivityMonitor extends EventEmitter {
  readonly state: 'working' | 'idle' | 'unknown';
  start(): Promise<void>;
  stop(): void;
  setHarnessSessionId?(id: string): void;
}
type IdleReason = 'completed' | 'stale';
```

Implementations: `ClaudeActivityMonitor` (**detection unchanged**; gains a `state` getter over `_isBusy`),
`HookActivityMonitor` (pi), `CodexTranscriptActivityMonitor` (§6).

#### Completion versus staleness

`Session` emits `idle` with `{ reason }`:

- `completed` — an authoritative end: Claude's turn records, pi's `idle` report, codex
  `task_complete`/`turn_aborted`.
- `stale` — tracking was lost while a turn was open: pi sent nothing for **90 s** while `working`, or codex
  wrote nothing for **5 minutes** while `working`.

**A stale idle must not swallow the real completion.** Monitors track `turnOpen`: set on working, cleared
only by an authoritative end. A stale timeout emits `idle { stale }` and leaves `turnOpen` true. A later
authoritative end emits `idle { completed }` **even though state is already idle**, then clears `turnOpen`.
A later authoritative `working` resumes normally.

**Legacy emitters stay compatible.** The PTY fallback copies and other existing `emit('idle')` calls pass no
argument. The server listener becomes `idle: (info?: { reason?: IdleReason }) => …` and treats a missing
reason as `completed`, preserving today's behaviour for Claude, shell and opencode.

The listener always broadcasts `SessionIdle`, updates debounced session state, records tokens, and runs the
pi transcript-watcher fallback. **Only for `completed`** does it call `RunSummaryTracker.recordIdle` and
`compactContinue.onIdle()`. Repeated `SessionIdle` delivery is safe in the frontend: it repeats UI updates,
restarts the warning timer, and consumes a pending Ctrl-L once.

#### One attach and one detach path

- `_attachActivityMonitor()` detaches any existing monitor, sets `_isWorking = false` and `_status = 'idle'`
  **without emitting**, creates the monitor for the harness's `activity`, and starts it. Initial `working`
  → set both fields and emit `working`. Initial `idle` or `unknown` → set fields, emit **nothing**.
- `_detachActivityMonitor()` is idempotent. Each monitor has a generation that its callbacks check; it also
  bumps on identity change.
- This **fixes a pre-existing Claude leak**: PTY `onExit` and `prepareForRestart()` do not stop the monitor
  today, so the next `startInteractive()` allocates another watcher.

#### Every writer of `_status` / `_isWorking`

| Writer | Monitored sessions (`activity !== 'pty'`) |
|---|---|
| `startInteractive()` entry | `_attachActivityMonitor()`, replacing the Claude-only branch; for pi, a new `activityToken` first |
| `startInteractive()` failure | detach; both fields idle; no event |
| settle timer | emits `needsRefresh` only; does not write `_status` |
| restored mux session | covered by attach |
| PTY `onExit` | detach; both fields idle; no event (the server `exit` handler finalises the summary) |
| `prepareForRestart()` | detach; both fields idle; no event |
| `rebindMuxSession()` | **increment `_ptyGeneration` before killing the old PTY** (today it increments only after spawning the replacement, so the old exit callback runs as current for ~300 ms); then detach. pi: re-attach — reports from a different process fail the token check. codex: **do not re-attach**; activity is not tracked until the next `startInteractive()`, because the target pane may run a different conversation and the retained `harnessSessionId` cannot be verified |
| `rebindMux()` | unchanged: `stop` + `startInteractive` re-attach |
| `recordHarnessSessionId(id)` | `this._activityMonitor?.setHarnessSessionId?.(id)`; a restored session supplies its constructor-seeded id at attach |
| PTY fallback (×2) | unchanged; runs only when `activity === 'pty'` |
| `sendInput()`, `assignTask()`, `clearTask()`, legacy `start()` | skip their `_status` writes when a monitor is attached |
| `stop()` | unchanged: stops the monitor, sets stopped |
| `markPaused()`, `markStopped()`, `pause()`, `clearPaused()` | unchanged (pause is capability-blocked for codex and pi) |
| `startShell()`, `runPrompt()` | out of scope: shell mode and Claude one-shot only |

A mux PTY exit is an attach-client exit, not proof the harness stopped. Activity is not tracked while
detached; the next attach recovers it (codex by scanning, pi within one heartbeat).

### 6. `CodexTranscriptActivityMonitor`

Emits on transitions, plus the completion rule in §5. Classification is a `classifyActivity(record)` hook on
the codex transcript adapter:

| record | signal |
|---|---|
| `event_msg` / `task_started` | working |
| `event_msg` / `task_complete` | idle (`completed`) |
| `event_msg` / `turn_aborted` | idle (`completed`) |
| anything else | null |

**Locating:** `codexTranscriptAdapter.locate({ workingDir, sessionId, harnessSessionId })`; retried every 2 s
while null. `setHarnessSessionId(id)` bumps the generation and re-locates at once.

**Initial state — backward scan:**

1. `stat` the file; record its **inode and size**. The size is the captured EOF.
2. Read backward from EOF in 256 KB chunks. Keep each chunk's incomplete leading fragment and prepend the
   next earlier chunk. At byte 0 the fragment is a complete line.
3. A trailing fragment after the last newline at EOF is **not** scanned; it seeds the pending buffer.
4. Process reconstructed complete lines newest-first; stop at the first non-null signal.
5. Budget 16 MB total. If exhausted, or if the budget cuts through a record that has not been classified,
   the result is `unknown`. **Never skip a split record and accept an older boundary.**
6. Before publishing, `stat` again. If the inode differs or the size is below the captured EOF, discard and
   rescan.

A scan ending in `working` sets `turnOpen`.

**Runtime:**

- **Offsets:** the consumed offset is the captured EOF; pending-buffer bytes are counted once, within it.
  Arm the watcher, then read from the consumed offset to the current size before handling events.
- **Pending buffer:** capped at 4 MB. On overflow, drop it, set a discard-until-newline flag so the rest of
  that record is never parsed, and warn once.
- **Bounded reads:** at most 4 MB per pass, looping until caught up.
- **Replacement and truncation:** on every change event and every 2 s poll, `stat`. If the inode changed or
  the size dropped below the offset, clear the pending buffer and discard flag, cancel timers, rescan, and
  re-arm the watcher on the new file. On rename or delete, re-run `locate()`.
- **Staleness:** working with no write for 5 minutes → `idle { stale }`.
- **Watch errors:** fall back to the 2 s poll.

### 7. Streaming pi's transcript live

pi creates its session file only at its first assistant message, so a locator finds nothing during the first
turn, and `startHarnessTranscriptWatcher()` returns before creating a watcher. After `/new` or `/resume` the
file changes.

1. **One authoritative path.** An accepted report's `sessionFile` is canonicalised and required to lie under
   pi's sessions root — `PI_CODING_AGENT_DIR` if set in Codeman's environment, else `~/.pi/agent`, plus
   `/sessions`. Containment is checked on the resolved parent directory, which pi creates eagerly. A report
   whose parent is missing or outside the root is ignored for path purposes; the next report retries. The
   accepted path is persisted as `SessionState.harnessTranscriptPath`.

   **Configuration requirement:** Codeman and the pi processes it spawns must resolve the same pi agent
   directory. pi inherits Codeman's environment, so this holds unless `PI_CODING_AGENT_DIR` is changed inside
   pi's own configuration. Documented.
2. **Watch it, and follow changes.** When the accepted path differs from the watcher's current path (or there
   is no watcher), call `watcher.updatePath(path, { fromOffset: 0 })`. `TranscriptWatcher` already starts at
   offset 0 and polls when the file is missing (verified); add `fromOffset` for a file that already exists.
3. **REST uses the same path.** For `activity: 'hook'` sessions, `GET /api/sessions/:id/transcript` and
   `GET /api/sessions/:id/state` read `harnessTranscriptPath`, not an independent `locate()`.
4. **Detect equal-size replacement.** `TranscriptWatcher` resets only when a file shrinks. Also compare the
   inode on each read; on change, emit `transcript:clear` and read from 0.

#### Transcript identity: the client reconciliation contract

Today REST sends only `X-Total-Blocks`, and SSE carries `{ sessionId, block }`, so the client cannot tell two
files apart. `seq` is `byteOffset × 1000 + blockIndex` and restarts in every file.

**Server.** A `transcriptId` (random) is generated whenever a watcher starts on a file, changes path, or
detects replacement. It is sent as `X-Transcript-Id` on `GET …/transcript`, and included in
`transcript:block`, `transcript:clear` and `transcript:ready`.

**Client.** Each session's transcript state stores `transcriptId`. The rules, per code path in
`src/web/public/app.js`:

| path | rule |
|---|---|
| `_onTranscriptBlock`, while `load()` is in flight | buffer `{ block, transcriptId }`, not the bare block |
| `_onTranscriptBlock`, view visible, not loading | id differs from stored → drop the block and call `load()`; else `append()` |
| `_onTranscriptBlock`, view not visible | id differs → reset stored blocks and adopt the id; then push only if newer than the stored tail |
| `append()` | skip unless `_isNewerBlock(block, lastStoredBlock)` |
| `load()` response | adopt `X-Transcript-Id`. If the session's stored id changed while the request was in flight, discard the response and reload |
| `load()` buffer replay, **both** the empty and non-empty snapshot paths | skip entries whose `transcriptId` ≠ the adopted id; append only if newer than the **current** stored tail, not the snapshot's fixed last block |
| periodic incremental sync | read `X-Transcript-Id`; differs from stored → discard and `load()`; else keep the existing cached-tail check |
| older-block pagination | read `X-Transcript-Id`; differs from stored → discard the page and `load()` instead of prepending |
| `transcript:clear` | reset blocks and adopt the event's `transcriptId` |

Blocks without `seq` keep today's timestamp comparison.

### 8. Gate auto-compact-and-continue to Claude

Skip `compactContinue.onIdle()` unless `caps.claudeTranscript`, and reject enabling it in
`POST /api/sessions/:id/auto-compact-continue` for other harnesses.

## Non-goals

- Changing `ClaudeActivityMonitor`'s detection logic.
- opencode and shell (they keep the PTY fallback).
- Mapping codex error records.
- Hermes `done` detection, orchestrator stall nudging, Board card movement.

## Known limitations

1. **pi sessions started before deployment** lack the extension and token until restarted.
2. **Another pi extension whose handler never resolves** can block `agent_settled`; the heartbeat then keeps
   reporting `working` indefinitely.
3. **A pi custom tool that blocks the event loop for over 90 s** produces `idle { stale }`: the UI updates,
   no completion side effects run, and the next report corrects it.
4. **A later in-process pi runtime that loads this extension** would take ownership by `gen`.
5. **After `rebindMuxSession()`, codex activity is not tracked** until the session is restarted.
6. **Codex identity delay:** discovery normally lands within ~150 ms of `task_started`, but backs off up to
   30 s, and the adapter caches locate misses for 15 s.
7. **Concurrent codex sessions in one directory** can be misassociated.
8. **An errored codex turn** writing neither `task_complete` nor `turn_aborted` goes `stale` after 5 minutes.
9. **Codeman and pi must resolve the same pi agent directory** for pi's transcript path to be accepted.
10. **Localhost processes that learn a session's token** could forge its activity reports.

## Testing

**pi extension** (unit; fake `pi.on` registry, fake timers, mocked `fetch`, a fresh `globalThis` per test):
- missing any of the three env vars → registers nothing;
- `agent_start, agent_start, agent_settled` → working then idle;
- `agent_settled` with no prior start → idle, no error;
- `session_before_compact` → working, handler returns `undefined`;
- `session_compact` / `session_compact_failed` → idle when no run is active;
- compacting then `agent_start` clears compacting;
- `seq` strictly increases **across two factory invocations** (simulating `/reload` with a fresh module and
  the same `globalThis`); `gen` increments per invocation;
- heartbeat re-posts; `session_shutdown` posts idle and clears the interval;
- a rejecting or hanging `fetch` never throws;
- the URL has no query string.

**pi harness and spawn:** `buildCommand` includes `-e '<path>'`; missing file → no `-e`, one warning. Both
tmux command prefixes export `CODEMAN_ACTIVITY_TOKEN`; the token is 32 hex chars and changes per spawn.

**Route:**
- pi `harness_activity` updates activity; rejected for claude, codex, shell and opencode;
- **zero** `hook:*` broadcasts, push notifications, run-summary hook records, vault captures and orchestrator
  calls — asserted separately from the intended session-listener effects;
- the branch runs before `transcript_path` handling;
- wrong `token` ignored; non-increasing `seq` ignored; lower `gen` ignored even with higher `seq`; the first
  valid report after a simulated restart is accepted;
- `sessionFile` outside the root ignored; missing parent ignored and retried on the next report; a changed
  path re-targets the watcher and persists `harnessTranscriptPath`.

**Session lifecycle:**
- monitor type per `activity`; shell/opencode keep the PTY fallback;
- initial idle emits **zero** `idle`; initial working emits exactly one `working`;
- restored-idle, restored-working, no-file/no-id and working-before-settle end correctly;
- the settle timer does not overwrite a monitor-reported `working`;
- PTY exit, `prepareForRestart` and `startInteractive` failure set both fields idle, emit nothing and dispose
  the monitor; **repeated restarts leave exactly one live watcher**;
- `rebindMuxSession`: a late exit from the old PTY changes nothing; pi re-attaches; codex does not;
- `sendInput`/`assignTask`/`clearTask` do not write status while a monitor is attached;
- **stale then completed**: `idle { stale }` followed by an authoritative end emits `idle { completed }` once,
  and `recordIdle` runs exactly once;
- an argument-free `emit('idle')` from the PTY fallback is treated as `completed`;
- `stale` idle broadcasts `SessionIdle` but does not call `recordIdle` or `compactContinue.onIdle`;
- auto-compact-and-continue never runs for codex/pi and cannot be enabled for them.

**Codex monitor** (temp dirs, fake timers, real fixture lines):
- classification per row, unknown and malformed lines;
- initial scan idle, working, `unknown`;
- a record over 256 KB spanning chunks; a complete first line at byte 0; a budget cut through an unclassified
  record → `unknown`;
- a trailing unterminated fragment at EOF seeds the pending buffer and parses once completed;
- replacement between scan and publish triggers a rescan;
- writes between scan and watch are not skipped;
- oversized pending line: the remainder is discarded, not parsed;
- truncation and **equal-size replacement** reset and rescan;
- 5 minutes of silence → `idle { stale }`, then `task_complete` → `idle { completed }`;
- watch error falls back to polling;
- `setHarnessSessionId` on a file containing `task_started` → working.

**Transcript streaming** (server and real `app.js` in the browser test harness):
- pi's watcher starts from `sessionFile` before the file exists; the first turn's blocks are broadcast;
- after a simulated `/new`, the watcher re-targets and REST serves the new path;
- replaying from 0 renders no duplicates in the visible view or the inactive-view state;
- each row of the reconciliation table: buffered blocks with a stale id are skipped; empty-snapshot replay
  deduplicates; an in-flight `load()` superseded by a new id is discarded; incremental sync and pagination
  with a changed `X-Transcript-Id` reload instead of mixing files;
- equal-size replacement emits `transcript:clear` with a new id.

**Live verification (acceptance), on the deployed app:**
a new pi session goes busy when a turn starts and idle when it settles — dot turns green, working bubble
clears; a codex session shows busy mid-turn and idle after `task_complete`; a new pi session's first turn
streams into the transcript view without a reload; after `/new` inside pi, the transcript view follows the
new session file.

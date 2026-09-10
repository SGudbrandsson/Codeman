# Harness Activity Detection (busy/idle for codex and pi)

**Date:** 2026-09-10
**Status:** Design
**Scope:** Correct busy/idle status for `codex` and `pi` sessions by deriving it from their
transcript files, the way `claude` sessions already do.

## Problem

Observed live on the deployed app (2026-09-10, sessions `e1861751` pi, `6daa4ee2` codex):

- **pi is busy forever.** After its turn finished, `/api/sessions` still reported
  `status: busy, isWorking: true`. The header dot stayed amber and the transcript view showed
  "Engaging cortex..." indefinitely. pi's pane was static for 4 s and showed the completed turn.
- **codex is never busy.** It reported `idle` throughout, including mid-turn.

### Root cause

`src/session.ts` has two activity mechanisms:

1. **`claude`** gets `ClaudeActivityMonitor` (`session.ts:1363-1384`), which tails Claude's
   JSONL and emits `working`/`idle` from turn records.
2. **Every other harness** falls back to PTY heuristics, which run only when no monitor exists
   (`if (!this._activityMonitor && …)`):
   - **busy** when output matches `SPINNER_PATTERN` = `/[⠋⠙⠹⠸⠼⠴⠦⠧]/`
     (`src/utils/regex-patterns.ts:81`)
   - **idle** only when output contains Claude's prompt glyph `❯` (`session.ts:1536-1560`)

pi draws braille spinner frames while working, so it goes busy, and it never prints `❯`, so it
never goes idle. codex's working indicators are `·` and `•` (captured from its pane), which the
pattern does not match, so it never goes busy. Its prompt is `›` (U+203A), not `❯` (U+276F).

This predates the transcript feature: `src/session.ts` was not modified by it.

### What depends on it

`server.ts:1901-1925`:

- `session:working` / `session:idle` SSE drive the header status dot and the transcript
  view's working bubble (`TranscriptView.setWorking`, `app.js:4574`).
- `RunSummaryTracker.recordWorking/recordIdle` — run summaries are wrong for both harnesses.
- **pi's live transcript watcher only attaches on idle** (`server.ts:1914`): *"pi writes its
  session file on the first submitted turn and emits no discovery event; attach the view-only
  watcher on the first idle after that turn."* Because pi never goes idle, its transcript never
  streams live over SSE today. Fixing idle fixes this as a side effect.

## Evidence: turn boundaries in each format

Verified against real files on this machine.

### codex 0.154.0 rollout

The live demo turn, in order:

```
event_msg/task_started          <- turn begins
response_item/message/developer ×3, user, world_state, turn_context, …
response_item/message/assistant
response_item/custom_tool_call
response_item/custom_tool_call_output
response_item/message/assistant
event_msg/task_complete         <- turn ends
```

Across all local rollouts, `event_msg` types seen: `token_count` 3233, `agent_message` 1038,
`task_started` 493, `task_complete` 475, `user_message` 462, `item_completed` 446,
`agent_reasoning` 150, `web_search_end` 141, `mcp_tool_call_end` 14, `patch_apply_end` 8,
`thread_settings_applied` 5, **`turn_aborted` 4**.

`task_started` 493 vs `task_complete` 475 + `turn_aborted` 4 leaves 14 turns with no terminal
record — sessions killed mid-turn. This is exactly what the crash-recovery timer covers.

### pi 0.85.1 session

The live demo turn:

```
message role=user                          <- turn begins
message role=assistant stopReason=toolUse  <- still working
message role=toolResult                    <- still working
message role=assistant stopReason=stop     <- turn ends
```

`stopReason` values confirmed in pi's own dist: `stop`, `toolUse`, `error`, `length`,
`aborted`, `pending`. Observed locally: `toolUse` 151, `stop` 8, `error` 8 (all
`529 System is overloaded`).

## Design

### 1. Classification lives on the transcript adapter

`TranscriptAdapter` (`src/harnesses/transcripts/types.ts:30`) gains:

```ts
/**
 * Activity implied by one raw JSONL line: 'working', 'idle', or null for no change.
 * Must never throw.
 */
classifyActivity?(raw: string): 'working' | 'idle' | null;
```

The adapter already parses these exact formats; classification belongs beside `parseLine`.

**codex:**

| record | activity |
|---|---|
| `event_msg` / `task_started` | working |
| `event_msg` / `task_complete` | idle |
| `event_msg` / `turn_aborted` | idle |
| anything else | null |

**pi:**

| record | activity |
|---|---|
| `message` role `user` | working |
| `message` role `assistant`, `stopReason` `toolUse` or `pending` | working |
| `message` role `toolResult` | working |
| `message` role `assistant`, `stopReason` `stop`, `error`, `length`, `aborted` | idle |
| anything else (incl. unknown `stopReason`) | null |

An unknown `stopReason` is `null`, not idle: a future non-terminal value must not flip a working
session to idle. The crash-recovery timer bounds the cost of that choice.

### 2. `HarnessActivityMonitor`

New `src/harness-activity-monitor.ts`. Same shape and mechanism as `ClaudeActivityMonitor`:
`start()`, `stop()`, emits `working` / `idle`, `fs.watch` plus offset tailing, a pending buffer
for partial lines, a creation poller while the file does not exist, and a 5-minute
crash-recovery timer reset on every write while busy.

**`ClaudeActivityMonitor` is not modified.** It is the most-used path, and generalising it now
would risk Claude's status for no gain here. Unifying the two is a possible later cleanup.

Differences from the Claude monitor:

- **Path comes from the adapter.** `adapter.locate({ workingDir, sessionId, harnessSessionId })`
  replaces the hard-coded `~/.claude/projects/...` path. The creation poller re-runs `locate()`
  every 2 s rather than checking a fixed path, because pi's file name includes a timestamp and
  codex's location depends on a discovered id.
- **Late identity for codex.** `setHarnessSessionId(id)` re-runs `locate()` immediately. Codex's
  id is discovered only after its first turn writes the rollout (`session.ts:1154`,
  `harnessSessionIdDiscovered`). Discovery lands about 150 ms after `task_started` is written
  (measured 2026-09-09), so the initial scan on attach catches the in-progress turn and emits
  `working`.
- **Bounded initial scan.** Codex rollouts embed base64 `encrypted_content` and pi embeds images,
  so the startup scan reads a bounded window from the end of the file (256 KB, discarding the
  first partial line) and classifies forward, taking the last non-null result. The Claude monitor
  reads the whole file; that is not acceptable for these formats.
- **Truncation.** If the file shrinks below the stored offset, reset the offset to 0 and rescan.

### 3. Wiring in `Session`

At `session.ts:1363`, after the existing claude branch:

```ts
} else {
  const caps = getHarness(this.mode).caps;
  const adapter = getTranscriptAdapter(this.mode);
  if (caps.transcript && !caps.claudeTranscript && adapter?.classifyActivity) {
    this._activityMonitor = new HarnessActivityMonitor(adapter, {
      workingDir: this.workingDir,
      sessionId: this.id,
      harnessSessionId: this.harnessSessionId,
    });
    // same working/idle handlers as the claude branch
  }
}
```

`_activityMonitor` is retyped to a shared `ActivityMonitor` interface (`start`, `stop`, `on`).

Because a monitor now exists for codex and pi, the PTY fallback (`session.ts:1536`, `:1562`) is
disabled for them automatically. No change to that fallback — shell and opencode keep it.

On `harnessSessionIdDiscovered` (`session.ts:1154`), call
`this._activityMonitor?.setHarnessSessionId?.(id)`.

**Settle-readiness ordering.** `readiness: settle` harnesses mark the session idle after a
fixed delay (`session.ts:1314`, `:1426`). If a restored session is mid-turn, the monitor's
initial `working` must not be overwritten by that later settle timer. The settle path must not
set idle when a monitor exists and has already reported working.

### 4. Server

No change required to `server.ts` listeners. pi's view-only transcript watcher now attaches on
the first real idle (`server.ts:1914`), so pi's transcript streams live.

## Non-goals

- Modifying `ClaudeActivityMonitor`.
- opencode (no transcript adapter).
- Changing the PTY fallback for shell and opencode.
- Tracking codex sub-turns or pi tool progress beyond working/idle.
- Detecting a codex `/new` or pi session switch mid-session (a new file under the same Codeman
  session). Out of scope; the monitor keeps following the located file.

## Risks

1. **Settle timer overwriting `working`** on restore. Covered in §3 and by a test.
2. **Long tool calls over 5 minutes with no writes** flip to idle early. Same limitation as
   Claude today; the timer resets on every write.
3. **Codex identity never discovered** (discovery gives up after 1 hour). The session then has a
   monitor that never locates a file, so it stays in its initial idle state, which matches
   today's behaviour for codex. Logged once.
4. **Unknown future record types.** Classification returns null, never throws.
5. **Double emission.** The monitor tracks its own busy flag and emits only on transitions, like
   the Claude monitor.

## Testing

Mirror `test/claude-activity-monitor.test.ts` (temp dirs, `vi.useFakeTimers` for crash recovery):

- **Classification unit tests, per adapter**, over real fixture lines: every row of both tables,
  unknown record → null, malformed line → null without throwing, unknown pi `stopReason` → null.
- **Monitor, per harness:** initial state idle vs mid-turn; runtime turn cycle
  (working → idle once); tool loop stays busy (pi toolUse → toolResult → toolUse); codex
  `turn_aborted` → idle; pi `stopReason: error` → idle; partial line across writes; creation
  poller finds a late file; `stop()` leaks no watcher or interval; crash recovery after 5 minutes;
  truncation resets offset; bounded initial scan on a file larger than the window.
- **Late identity (codex):** monitor started with no id emits nothing; `setHarnessSessionId`
  on a file already containing `task_started` emits working.
- **Session wiring:** codex/pi get a `HarnessActivityMonitor`; shell/opencode get none and keep
  the PTY fallback; claude still gets `ClaudeActivityMonitor`; the settle timer does not
  overwrite a monitor-reported `working`.
- **Live verification (acceptance):** on the deployed app, a pi session goes busy during a turn
  and back to idle after it, with the dot turning green and the working bubble clearing; a codex
  session shows busy mid-turn and idle after `task_complete`; pi's transcript now updates live
  during a turn without a reload.

# Claude Activity Monitor — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Scope:** Replace PTY-based busy/idle detection with JSONL file tail for claude-mode sessions

---

## Problem

The current busy indicator is driven by parsing PTY output for braille spinner characters and work keywords. This is fragile:

- **False positives:** Historical spinner chars in tmux scrollback replay trigger `session:working` SSE even when Claude is idle.
- **False negatives:** Claude Code's own terminal UI (status bar chrome) emits spinners continuously, preventing idle detection from stabilising.
- **Fundamental brittleness:** Terminal output parsing is not a semantic signal — it is a heuristic that breaks whenever Claude's UI changes.

## Solution

Replace PTY-based detection with semantic events from Claude's own session log.

Claude writes a `.jsonl` file for each session at:
```
~/.claude/projects/{projectHash}/{sessionId}.jsonl
```

Where `projectHash = workingDir.replace(/^\//, '').replace(/\//g, '-')`.

Since Codeman always passes `--session-id ${session.id}` to Claude, the file path is fully predictable. The file contains two events that precisely signal state transitions:

| Event | Meaning |
|---|---|
| `{type:"user", isSidechain:false}` with non-tool-result content | Claude turn started → **busy** |
| `{type:"system", subtype:"turn_duration"}` | Claude turn completed → **idle** |

---

## Architecture

### New class: `ClaudeActivityMonitor` (`src/claude-activity-monitor.ts`)

A focused class that monitors a single session's JSONL file and emits `working` and `idle` events. Extends `EventEmitter`.

**Constructor:**
```ts
new ClaudeActivityMonitor(sessionId: string, workingDir: string)
```

**Public API:**
- `start(): Promise<void>` — determine initial state, arm file watcher
- `stop(): void` — close watcher, cancel timers
- Events: `'working'`, `'idle'`

**Internal state:**
- `_filePath: string` — computed JSONL path
- `_offset: number` — bytes read so far (tail position)
- `_watcher: fs.FSWatcher | null`
- `_crashRecoveryTimer: NodeJS.Timeout | null` — 5-minute fallback

### Startup state logic

```
if file does not exist:
  initial state = idle
  poll for file creation (2s interval)
else:
  scan from file end backwards for last meaningful event
  if last meaningful event is turn_duration → idle
  if last meaningful event is user (no subsequent turn_duration) → busy
  set _offset = file size (watch from current end)
```

### Runtime event detection

On every `fs.watch` `change` event:
1. Read bytes from `_offset` to EOF
2. Update `_offset`
3. Reset crash-recovery timer
4. Split into lines, parse each as JSON
5. For each line:
   - `type === 'user' && isSidechain === false` and content is not purely tool_results → emit `'working'`
   - `type === 'system' && subtype === 'turn_duration'` → emit `'idle'`

### Crash recovery

If the monitor is in a busy state and the JSONL file has not been modified for 5 minutes, emit `'idle'`. This handles Claude crashes where `turn_duration` is never written. The timer resets on every file write.

### Session integration

In `Session` (`src/session.ts`), claude-mode only:

- **Remove:** `_isLoadingScrollback` flag, spinner detection (`SPINNER_PATTERN`), keyword detection in `_processExpensiveParsers`, `isInitialReady` idle path
- **Add:** `_activityMonitor: ClaudeActivityMonitor | null`
- `startInteractive()`: create monitor, call `monitor.start()`, forward `working`/`idle` events to existing `emit('working')` / `emit('idle')` paths
- `stop()`: call `monitor.stop()`
- Keep `❯`-based idle timer as belt-and-suspenders for sessions where no monitor could start (non-claude modes, unexpected errors)

---

## Test Plan

File: `test/claude-activity-monitor.test.ts`

All tests use **real temp files** (no `fs.watch` mocks, no `fs.stat` mocks). Tests write actual JSONL to temp directories and assert emitted events. This ensures tests catch real filesystem behavior.

### Test matrix

| # | Scenario | Setup | Expected |
|---|---|---|---|
| 1 | File missing at start | No file | Initial state idle, no events |
| 2 | File exists, last event `turn_duration` | File with user+turn_duration | Initial state idle |
| 3 | File exists, last event `user` (no subsequent `turn_duration`) | File with user only | Initial state busy |
| 4 | `user` line appended at runtime | Monitor running, append user line | Emits `working` |
| 5 | `turn_duration` line appended | Monitor running, append turn_duration | Emits `idle` |
| 6 | Multiple turn cycles | Append user, turn_duration, user, turn_duration | Alternates working/idle correctly |
| 7 | `isSidechain: true` user lines ignored | Append sidechain user line | No event |
| 8 | Tool-result-only user lines ignored | Append user with tool_result content only | No event |
| 9 | `turn_duration` with no prior `user` | Append turn_duration to fresh monitor | Still emits idle |
| 10 | Crash recovery | Start busy, advance fake timer 5min | Emits idle |
| 11 | File created after monitor start | Start with no file, then create + append | Monitor detects creation and events |
| 12 | `stop()` prevents further events | Append lines after stop() | No events emitted |
| 13 | Concurrent appends (large chunk) | Write multiple lines in one write | All lines parsed correctly |

### Helper utilities (shared in test file)

```ts
function writeLine(path: string, obj: object): void  // appends one JSONL line
function userLine(opts?): object  // builds a user turn entry
function turnDurationLine(): object  // builds a turn_duration entry
function monitorEvents(monitor): string[]  // collects events in order
```

---

## What is NOT changed

- SSE broadcast mechanism (`server.ts`) — unchanged
- Frontend SSE handlers — unchanged
- OpenCode session detection — PTY-based detection retained as-is
- Shell session detection — unchanged
- `session:working` / `session:idle` SSE event names and payloads — unchanged

---

## Files changed

| File | Change |
|---|---|
| `src/claude-activity-monitor.ts` | New — the monitor class |
| `src/session.ts` | Remove PTY detection for claude-mode, add monitor lifecycle |
| `test/claude-activity-monitor.test.ts` | New — full test matrix |
| `test/busy-indicator-scrollback-guard.test.ts` | Delete — replaced by above |

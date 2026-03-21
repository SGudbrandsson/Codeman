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

**Path computation** (verified against production filesystem — `/home/siggi/sources/X` → `-home-siggi-sources-X`):
```ts
import { homedir } from 'os';
const projectHash = workingDir.replace(/\//g, '-');
const filePath = `${homedir()}/.claude/projects/${projectHash}/${sessionId}.jsonl`;
```
Note: `~` is NOT used — `os.homedir()` must be called explicitly. A test must verify the computed path resolves to an existing file for a known `workingDir`/`sessionId` pair.

Since Codeman always passes `--session-id ${session.id}` to Claude, the file path is fully predictable. The file contains two events that precisely signal state transitions:

| Event | Meaning |
|---|---|
| `{type:"user", isSidechain:false}` where content is not purely tool_results | Claude turn started → **busy** |
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
- `stop(): void` — close watcher, cancel all timers and intervals
- Events: `'working'`, `'idle'`

**Internal state:**
- `_filePath: string` — computed JSONL path (via `os.homedir()`, not `~`)
- `_offset: number` — bytes successfully parsed so far (tail position)
- `_pendingBuffer: string` — incomplete line held across `change` events
- `_isBusy: boolean` — current state; events only emitted on transitions
- `_watcher: fs.FSWatcher | null`
- `_creationPoller: NodeJS.Timeout | null` — 2s interval waiting for file creation
- `_crashRecoveryTimer: NodeJS.Timeout | null` — 5-minute fallback, only active while busy

---

### Startup state logic

```
if file does not exist:
  emit nothing (initial state = idle)
  start _creationPoller (2s interval, calls _onFileCreated when file appears)
else:
  run _determineInitialState()
  set _offset = file size
  arm fs.watch
```

**`_determineInitialState()`:** Read the entire file, split on `\n`, parse each line with `JSON.parse` inside a `try/catch` — malformed or partial lines are silently skipped. Track the last `user` entry and last `turn_duration` entry seen (by line index). Compare positions:
- If `turn_duration` comes after the last `user` → initial state idle (do not emit)
- If `user` is last (no subsequent `turn_duration`) → initial state busy (set `_isBusy = true`, emit `'working'`, start crash-recovery timer)
- If neither found → idle (do not emit)

Reading the entire file is acceptable; JSONL files are typically under 10MB. If performance becomes a concern, cap to the last 64KB.

**`_onFileCreated()`:**
1. Clear `_creationPoller` (stop the interval)
2. Run `_determineInitialState()` — file may already have content
3. Set `_offset = file size`
4. Arm `fs.watch`

**`stop()` must clear `_creationPoller`** if called before the file appears, to prevent interval leaks.

---

### Runtime event detection

The monitor tracks `_isBusy: boolean` internally. Events are only emitted on **state transitions** — `'working'` when transitioning idle→busy, `'idle'` when transitioning busy→idle. Redundant events (e.g. `turn_duration` while already idle) are suppressed.

On every `fs.watch` `change` event:
1. Read bytes from `_offset` to EOF; append to `_pendingBuffer`
2. Update `_offset += bytesRead` (using actual bytes read, not re-statting file size, to avoid races with concurrent writes)
3. Split `_pendingBuffer` on `\n`; keep last element (possibly incomplete line) as new `_pendingBuffer`
4. Reset crash-recovery timer if `_isBusy` (file is being written, Claude is still alive)
5. Parse each complete line as JSON (skip lines that fail `JSON.parse`); for each line:
   - `type === 'user' && isSidechain === false` and content is not purely tool_results → emit `'working'`, start crash-recovery timer
   - `type === 'system' && subtype === 'turn_duration'` → emit `'idle'`, cancel crash-recovery timer

**Partial line handling:** A `write()` syscall may not include a trailing `\n`. Any content after the last `\n` is held in `_pendingBuffer` and prepended to the next read. This prevents `JSON.parse` failures on partial lines.

---

### Crash recovery timer

The timer is only active while the monitor is in busy state:
- **Started:** when `'working'` is emitted
- **Reset:** on every file `change` event while busy (Claude is writing, not crashed)
- **Cancelled:** when `'idle'` is emitted
- **Fires:** if 5 minutes elapse with no file writes while busy → emit `'idle'`

This handles Claude crashes where `turn_duration` is never written. Outside of busy state, the timer does not run.

---

### Session integration (`src/session.ts`)

**Claude-mode sessions only:**

- **Remove:** `_isLoadingScrollback` flag and all related logic, spinner detection (`SPINNER_PATTERN`), keyword detection in `_processExpensiveParsers`
- **Add:** `_activityMonitor: ClaudeActivityMonitor | null = null`
- `startInteractive()` (mux path): create monitor, call `await monitor.start()`, forward events:
  ```ts
  monitor.on('working', () => { this._isWorking = true; this._status = 'busy'; this.emit('working'); });
  monitor.on('idle', () => { this._isWorking = false; this._status = 'idle'; this.emit('idle'); });
  ```
- `stop()`: call `_activityMonitor?.stop()`

**Fallback:** The `❯`-based idle timer (the `isInitialReady` path) is **retained but conditioned**: it runs only if `_activityMonitor` is null (i.e., monitor failed to start or session is not claude-mode). If the monitor is active, the `❯` block is skipped entirely to avoid conflicting state changes.

---

## Test Plan

File: `test/claude-activity-monitor.test.ts`

All tests use **real temp files** — no mocking of `fs`, `fs.watch`, or `os`. Tests write actual JSONL to temp directories created with `fs.mkdtempSync`. `vitest` fake timers are used for the crash-recovery timer only (applied to `setTimeout`/`setInterval`, not to fs operations).

**Async event assertions** use a `waitForEvent(emitter, event, timeoutMs = 1000)` helper that rejects if the event does not fire within the timeout. This prevents tests from hanging silently.

### Shared helpers

```ts
function writeLine(path: string, obj: object): void  // fs.appendFileSync with JSON + '\n'
function userLine(opts?: { isSidechain?: boolean; toolResultOnly?: boolean }): object
function turnDurationLine(): object
async function waitForEvent(emitter: EventEmitter, event: string, ms = 1000): Promise<void>
```

### Path verification test (runs first)

Verify the projectHash formula against the real filesystem. Use `test.skipIf` so CI machines without a live Claude session skip gracefully:
```ts
const knownWorkingDir = '/home/siggi/sources/Codeman-fix-busy-indicator-accuracy';
const knownSessionId = '5800cee6-0917-495a-a5d0-d167269e2f59';
const knownPath = new ClaudeActivityMonitor(knownSessionId, knownWorkingDir)._filePath;
test.skipIf(!fs.existsSync(knownPath))(
  'projectHash formula resolves to existing jsonl',
  () => { expect(fs.existsSync(knownPath)).toBe(true); }
);
```

### Test matrix

| # | Scenario | Setup | Expected |
|---|---|---|---|
| 1 | File missing at start | No file | No events; `stop()` clears creation poll without error |
| 2 | File exists, last event `turn_duration` | File with user+turn_duration | No event emitted on start |
| 3 | File exists, last event `user` (no `turn_duration`) | File with user only | Emits `working` on start |
| 4 | `user` line appended at runtime | Monitor running on empty file, append user line | Emits `working` |
| 5 | `turn_duration` line appended | Monitor running, emit working first, append turn_duration | Emits `idle` |
| 6 | Multiple turn cycles | Append user, turn_duration, user, turn_duration | Alternates working/idle correctly |
| 7 | `isSidechain: true` user lines ignored | Append sidechain user line | No event |
| 8 | Tool-result-only user lines ignored | Append user with only tool_result content | No event |
| 9 | `turn_duration` while already idle | Append turn_duration to fresh monitor (already idle) | No event (suppressed — already idle) |
| 10 | Crash recovery | Start busy, fake-advance timer 5min | Emits `idle`; timer cancelled after emission |
| 11 | File created after monitor start (new session) | Start with no file, create file, append user+turn_duration | Emits working then idle; creation poll is cleared |
| 12 | `stop()` during creation poll | Start with no file, call stop() before file appears | No events; no interval leak |
| 13 | `stop()` prevents further events | Append lines after `stop()` | No events emitted |
| 14 | Partial line across two writes | Write half a JSON line, then the rest | Parsed as one line; correct event |
| 15 | Multiple lines in one write | Write user+turn_duration in single `appendFileSync` call | Both events emitted in order |

---

## What is NOT changed

- SSE broadcast mechanism (`server.ts`) — unchanged
- Frontend SSE handlers — unchanged
- OpenCode session detection — PTY-based detection retained as-is (monitor is claude-mode only)
- Shell session detection — unchanged
- `❯`-based idle timer — retained as fallback when `_activityMonitor` is null
- `session:working` / `session:idle` SSE event names and payloads — unchanged

---

## Files changed

| File | Change |
|---|---|
| `src/claude-activity-monitor.ts` | New — the monitor class |
| `src/session.ts` | Remove PTY detection for claude-mode, add monitor lifecycle, condition `❯` fallback |
| `test/claude-activity-monitor.test.ts` | New — full test matrix above |
| `test/busy-indicator-scrollback-guard.test.ts` | Delete — replaced by above |

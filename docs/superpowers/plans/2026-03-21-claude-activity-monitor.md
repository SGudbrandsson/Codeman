# Claude Activity Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PTY-based busy/idle detection with semantic events from Claude's own JSONL session file, eliminating scrollback false-positives and terminal-chrome false-negatives.

**Architecture:** A new `ClaudeActivityMonitor` class watches `~/.claude/projects/{projectHash}/{sessionId}.jsonl` using `fs.watch`, tails new bytes on each change event, and emits `'working'`/`'idle'` on state transitions detected from `user` and `system/turn_duration` JSONL entries. `Session` instantiates one monitor per claude-mode session and removes all PTY spinner/keyword detection.

**Tech Stack:** Node.js `fs.watch` (inotify), TypeScript, vitest, existing `Session` EventEmitter pattern.

**Spec:** `docs/superpowers/specs/2026-03-21-claude-activity-monitor-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/claude-activity-monitor.ts` | **Create** | Monitor class — JSONL tail, state machine, fs.watch lifecycle |
| `test/claude-activity-monitor.test.ts` | **Create** | Full test matrix from spec (15 tests) |
| `src/session.ts` | **Modify** | Remove PTY detection for claude-mode; add monitor lifecycle |
| `test/busy-indicator-scrollback-guard.test.ts` | **Delete** | Replaced by above |

---

## Task 1: Create `ClaudeActivityMonitor` — path computation + skeleton

**Files:**
- Create: `src/claude-activity-monitor.ts`
- Create: `test/claude-activity-monitor.test.ts`

- [ ] **Step 1: Write the path computation test**

```typescript
// test/claude-activity-monitor.test.ts
import { describe, it, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeActivityMonitor } from '../src/claude-activity-monitor.js';

// Path formula verification — skipped on CI where the file won't exist
const knownWorkingDir = '/home/siggi/sources/Codeman-fix-busy-indicator-accuracy';
const knownSessionId = '5800cee6-0917-495a-a5d0-d167269e2f59';

describe('path computation', () => {
  it('derives correct projectHash from workingDir', () => {
    const monitor = new ClaudeActivityMonitor(knownSessionId, knownWorkingDir);
    const expected = path.join(
      os.homedir(),
      '.claude/projects',
      knownWorkingDir.replace(/\//g, '-'),
      `${knownSessionId}.jsonl`
    );
    expect((monitor as any)._filePath).toBe(expected);
  });

  test.skipIf(!fs.existsSync(
    path.join(os.homedir(), '.claude/projects',
      knownWorkingDir.replace(/\//g, '-'),
      `${knownSessionId}.jsonl`)
  ))('projectHash resolves to existing file on this machine', () => {
    const monitor = new ClaudeActivityMonitor(knownSessionId, knownWorkingDir);
    expect(fs.existsSync((monitor as any)._filePath)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/siggi/sources/Codeman-fix-busy-indicator-accuracy
npx vitest run test/claude-activity-monitor.test.ts 2>&1 | head -20
```
Expected: error — `ClaudeActivityMonitor` not found.

- [ ] **Step 3: Create the skeleton with path computation**

```typescript
// src/claude-activity-monitor.ts
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class ClaudeActivityMonitor extends EventEmitter {
  readonly _filePath: string;
  private _offset: number = 0;
  private _pendingBuffer: string = '';
  private _isBusy: boolean = false;
  private _watcher: fs.FSWatcher | null = null;
  private _creationPoller: ReturnType<typeof setInterval> | null = null;
  private _crashRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopped: boolean = false;

  constructor(sessionId: string, workingDir: string) {
    super();
    const projectHash = workingDir.replace(/\//g, '-');
    this._filePath = path.join(
      os.homedir(),
      '.claude', 'projects',
      projectHash,
      `${sessionId}.jsonl`
    );
  }

  async start(): Promise<void> {
    // TODO
  }

  stop(): void {
    this._stopped = true;
    this._watcher?.close();
    this._watcher = null;
    if (this._creationPoller) { clearInterval(this._creationPoller); this._creationPoller = null; }
    if (this._crashRecoveryTimer) { clearTimeout(this._crashRecoveryTimer); this._crashRecoveryTimer = null; }
  }
}
```

- [ ] **Step 4: Run test — should pass**

```bash
npx vitest run test/claude-activity-monitor.test.ts 2>&1 | tail -10
```
Expected: `2 passed` (or `1 passed, 1 skipped` if the known file doesn't exist).

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/claude-activity-monitor.ts test/claude-activity-monitor.test.ts
git commit -m "feat: ClaudeActivityMonitor skeleton with path computation"
```

---

## Task 2: Startup state — `_determineInitialState()`

**Files:**
- Modify: `src/claude-activity-monitor.ts`
- Modify: `test/claude-activity-monitor.test.ts`

Helper functions to add at the top of the test file:

```typescript
import * as os from 'os';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-test-'));
  return path.join(dir, 'session.jsonl');
}

function writeLine(filePath: string, obj: object): void {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function userLine(opts: { isSidechain?: boolean; toolResultOnly?: boolean } = {}) {
  const content = opts.toolResultOnly
    ? [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]
    : [{ type: 'text', text: 'hello' }];
  return { type: 'user', isSidechain: opts.isSidechain ?? false, message: { role: 'user', content } };
}

function turnDurationLine() {
  return { type: 'system', subtype: 'turn_duration', durationMs: 1000 };
}

function monitorOn(filePath: string): ClaudeActivityMonitor {
  // Create monitor pointing at a specific file path via internal override
  const m = new ClaudeActivityMonitor('test-id', '/test/workdir');
  (m as any)._filePath = filePath;
  return m;
}
```

- [ ] **Step 1: Write startup state tests**

```typescript
describe('startup state — _determineInitialState', () => {
  it('test 2: file exists, last event is turn_duration → no event emitted', async () => {
    const f = tmpFile();
    writeLine(f, userLine());
    writeLine(f, turnDurationLine());
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    m.on('idle', () => events.push('idle'));
    await m.start();
    m.stop();
    expect(events).toEqual([]);
    expect((m as any)._isBusy).toBe(false);
  });

  it('test 3: file exists, last event is user (no turn_duration) → emits working', async () => {
    const f = tmpFile();
    writeLine(f, userLine());
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    await m.start();
    m.stop();
    expect(events).toEqual(['working']);
    expect((m as any)._isBusy).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npx vitest run test/claude-activity-monitor.test.ts 2>&1 | tail -15
```

- [ ] **Step 3: Implement `_determineInitialState` and `start()`**

```typescript
private _determineInitialState(): void {
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(this._filePath, 'utf8');
  } catch {
    return; // file gone between existence check and read — stay idle
  }
  const lines = fileContent.split('\n');
  let lastUserIdx = -1;
  let lastTurnDurationIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && obj.isSidechain === false && this._isHumanTurn(obj)) {
        lastUserIdx = i;
      } else if (obj.type === 'system' && obj.subtype === 'turn_duration') {
        lastTurnDurationIdx = i;
      }
    } catch { /* skip malformed lines */ }
  }
  if (lastUserIdx > lastTurnDurationIdx) {
    // Claude was mid-turn when we last saw this file — treat as busy
    this._isBusy = true;
    this.emit('working');
    this._startCrashRecoveryTimer();
  }
  // else: idle (turn_duration after user, or neither) — emit nothing
}

private _isHumanTurn(obj: Record<string, unknown>): boolean {
  const msg = obj.message as { content?: unknown } | undefined;
  if (!msg) return false;
  const content = msg.content;
  if (!Array.isArray(content)) return typeof content === 'string';
  return content.some((c: unknown) =>
    typeof c === 'object' && c !== null && (c as Record<string, unknown>).type !== 'tool_result'
  );
}

async start(): Promise<void> {
  if (fs.existsSync(this._filePath)) {
    this._determineInitialState();
    this._offset = fs.statSync(this._filePath).size;
    this._armWatcher();
  } else {
    this._creationPoller = setInterval(() => {
      if (fs.existsSync(this._filePath)) {
        this._onFileCreated();
      }
    }, 2000);
  }
}

private _onFileCreated(): void {
  if (this._creationPoller) { clearInterval(this._creationPoller); this._creationPoller = null; }
  this._determineInitialState();
  this._offset = fs.statSync(this._filePath).size;
  this._armWatcher();
}

private _armWatcher(): void {
  try {
    this._watcher = fs.watch(this._filePath, { persistent: false }, (event) => {
      if (event === 'change') this._onFileChange();
    });
  } catch { /* file gone */ }
}
```

- [ ] **Step 4: Run tests — should pass**

```bash
npx vitest run test/claude-activity-monitor.test.ts 2>&1 | tail -10
```
Expected: all passing.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/claude-activity-monitor.ts test/claude-activity-monitor.test.ts
git commit -m "feat: ClaudeActivityMonitor startup state detection"
```

---

## Task 3: Runtime event detection — file tail + JSONL parsing

**Files:**
- Modify: `src/claude-activity-monitor.ts`
- Modify: `test/claude-activity-monitor.test.ts`

- [ ] **Step 1: Write runtime event tests**

```typescript
// Add helper
async function waitForEvent(emitter: EventEmitter, event: string, ms = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), ms);
    emitter.once(event, () => { clearTimeout(t); resolve(); });
  });
}

describe('runtime event detection', () => {
  it('test 4: user line appended → emits working', async () => {
    const f = tmpFile(); fs.writeFileSync(f, '');
    const m = monitorOn(f);
    await m.start();
    const p = waitForEvent(m, 'working');
    writeLine(f, userLine());
    await p;
    m.stop();
  });

  it('test 5: turn_duration appended → emits idle', async () => {
    const f = tmpFile();
    writeLine(f, userLine()); // start busy
    const m = monitorOn(f);
    await m.start();
    expect((m as any)._isBusy).toBe(true);
    const p = waitForEvent(m, 'idle');
    writeLine(f, turnDurationLine());
    await p;
    m.stop();
  });

  it('test 6: multiple turn cycles — alternates correctly', async () => {
    const f = tmpFile(); fs.writeFileSync(f, '');
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    m.on('idle', () => events.push('idle'));
    await m.start();

    writeLine(f, userLine());
    await waitForEvent(m, 'working');
    writeLine(f, turnDurationLine());
    await waitForEvent(m, 'idle');
    writeLine(f, userLine());
    await waitForEvent(m, 'working');
    writeLine(f, turnDurationLine());
    await waitForEvent(m, 'idle');

    m.stop();
    expect(events).toEqual(['working', 'idle', 'working', 'idle']);
  });

  it('test 7: isSidechain:true user lines ignored', async () => {
    const f = tmpFile(); fs.writeFileSync(f, '');
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    await m.start();
    writeLine(f, userLine({ isSidechain: true }));
    await new Promise(r => setTimeout(r, 300));
    m.stop();
    expect(events).toEqual([]);
  });

  it('test 8: tool-result-only user lines ignored', async () => {
    const f = tmpFile(); fs.writeFileSync(f, '');
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    await m.start();
    writeLine(f, userLine({ toolResultOnly: true }));
    await new Promise(r => setTimeout(r, 300));
    m.stop();
    expect(events).toEqual([]);
  });

  it('test 9: turn_duration while already idle → no event', async () => {
    const f = tmpFile(); fs.writeFileSync(f, '');
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('idle', () => events.push('idle'));
    await m.start();
    writeLine(f, turnDurationLine());
    await new Promise(r => setTimeout(r, 300));
    m.stop();
    expect(events).toEqual([]);
  });

  it('test 13: stop() prevents further events', async () => {
    const f = tmpFile(); fs.writeFileSync(f, '');
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    await m.start();
    m.stop();
    writeLine(f, userLine());
    await new Promise(r => setTimeout(r, 300));
    expect(events).toEqual([]);
  });

  it('test 14: partial line across two writes → parsed as one', async () => {
    const f = tmpFile(); fs.writeFileSync(f, '');
    const m = monitorOn(f);
    await m.start();
    const p = waitForEvent(m, 'working');
    const line = JSON.stringify(userLine());
    fs.appendFileSync(f, line.slice(0, 10));
    await new Promise(r => setTimeout(r, 100));
    fs.appendFileSync(f, line.slice(10) + '\n');
    await p;
    m.stop();
  });

  it('test 15: multiple lines in one write → all parsed', async () => {
    const f = tmpFile(); fs.writeFileSync(f, '');
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    m.on('idle', () => events.push('idle'));
    await m.start();
    // Write both lines atomically
    const p = waitForEvent(m, 'idle');
    fs.appendFileSync(f, JSON.stringify(userLine()) + '\n' + JSON.stringify(turnDurationLine()) + '\n');
    await p;
    m.stop();
    expect(events).toEqual(['working', 'idle']);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail (missing `_onFileChange`)**

```bash
npx vitest run test/claude-activity-monitor.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Implement `_onFileChange`**

```typescript
private _onFileChange(): void {
  if (this._stopped) return;
  let newBytes: Buffer;
  try {
    const fd = fs.openSync(this._filePath, 'r');
    const stat = fs.fstatSync(fd);
    const toRead = stat.size - this._offset;
    if (toRead <= 0) { fs.closeSync(fd); return; }
    newBytes = Buffer.alloc(toRead);
    const bytesRead = fs.readSync(fd, newBytes, 0, toRead, this._offset);
    fs.closeSync(fd);
    this._offset += bytesRead;
  } catch { return; }

  this._pendingBuffer += newBytes.toString('utf8');

  // Reset crash-recovery timer on every write while busy
  if (this._isBusy) this._startCrashRecoveryTimer();

  const lines = this._pendingBuffer.split('\n');
  this._pendingBuffer = lines.pop() ?? ''; // keep incomplete last line

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    if (obj.type === 'user' && obj.isSidechain === false && this._isHumanTurn(obj)) {
      if (!this._isBusy) {
        this._isBusy = true;
        this.emit('working');
        this._startCrashRecoveryTimer();
      }
    } else if (obj.type === 'system' && obj.subtype === 'turn_duration') {
      if (this._isBusy) {
        this._isBusy = false;
        if (this._crashRecoveryTimer) { clearTimeout(this._crashRecoveryTimer); this._crashRecoveryTimer = null; }
        this.emit('idle');
      }
    }
  }
}

private _startCrashRecoveryTimer(): void {
  if (this._crashRecoveryTimer) clearTimeout(this._crashRecoveryTimer);
  this._crashRecoveryTimer = setTimeout(() => {
    if (this._isBusy && !this._stopped) {
      this._isBusy = false;
      this.emit('idle');
    }
  }, 5 * 60 * 1000);
}
```

- [ ] **Step 4: Run tests — should pass**

```bash
npx vitest run test/claude-activity-monitor.test.ts 2>&1 | tail -15
```
Expected: all passing.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/claude-activity-monitor.ts test/claude-activity-monitor.test.ts
git commit -m "feat: ClaudeActivityMonitor runtime file tail and event detection"
```

---

## Task 4: File creation poller + crash recovery tests

**Files:**
- Modify: `test/claude-activity-monitor.test.ts`

- [ ] **Step 1: Write creation poller and crash recovery tests**

```typescript
import { vi } from 'vitest';

describe('file creation poller', () => {
  it('test 1: file missing at start — no events, stop() cleans up', async () => {
    const f = '/tmp/does-not-exist-' + Date.now() + '.jsonl';
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    m.on('idle', () => events.push('idle'));
    await m.start();
    expect(events).toEqual([]);
    m.stop(); // must not throw
    expect((m as any)._creationPoller).toBeNull();
  });

  it('test 12: stop() during creation poll — no interval leak', async () => {
    const f = '/tmp/never-created-' + Date.now() + '.jsonl';
    const m = monitorOn(f);
    await m.start();
    expect((m as any)._creationPoller).not.toBeNull();
    m.stop();
    expect((m as any)._creationPoller).toBeNull();
    expect((m as any)._watcher).toBeNull();
  });

  it('test 11: file created after monitor start → creation poll clears, then detects runtime events', async () => {
    const f = '/tmp/late-create-' + Date.now() + '.jsonl';
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    m.on('idle', () => events.push('idle'));
    await m.start();
    expect((m as any)._creationPoller).not.toBeNull();

    // Create the file with no content (new session — no prior turns)
    fs.writeFileSync(f, '');
    // Trigger _onFileCreated directly (avoids 2s poll delay in tests)
    (m as any)._onFileCreated();
    // Creation poll must be cleared
    expect((m as any)._creationPoller).toBeNull();
    // Watcher is now armed — write runtime events and verify detection
    const p = waitForEvent(m, 'idle');
    writeLine(f, userLine());
    await waitForEvent(m, 'working');
    writeLine(f, turnDurationLine());
    await p;
    m.stop();
    expect(events).toEqual(['working', 'idle']);
    fs.unlinkSync(f);
  });
});

describe('crash recovery', () => {
  it('test 10: busy state with no writes for 5 minutes → emits idle', async () => {
    vi.useFakeTimers();
    const f = tmpFile();
    writeLine(f, userLine()); // start busy
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('idle', () => events.push('idle'));
    await m.start();
    expect((m as any)._isBusy).toBe(true);
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    expect(events).toEqual(['idle']);
    expect((m as any)._isBusy).toBe(false);
    expect((m as any)._crashRecoveryTimer).toBeNull();
    m.stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests — confirm crash recovery and creation tests pass**

```bash
npx vitest run test/claude-activity-monitor.test.ts 2>&1 | tail -20
```
Expected: all passing (15 tests total).

- [ ] **Step 3: Commit**

```bash
git add test/claude-activity-monitor.test.ts
git commit -m "test: complete ClaudeActivityMonitor test matrix (15 tests)"
```

---

## Task 5: Integrate into `Session` — remove PTY detection, add monitor

**Files:**
- Modify: `src/session.ts`
- Delete: `test/busy-indicator-scrollback-guard.test.ts`

The goal is: for claude-mode mux sessions, delegate working/idle to the monitor. Keep `❯`-based idle as fallback only when `_activityMonitor` is null.

- [ ] **Step 1: Add monitor field and import to Session**

In `src/session.ts`, add near the top imports:
```typescript
import { ClaudeActivityMonitor } from './claude-activity-monitor.js';
```

Add field near `_isWorking`:
```typescript
private _activityMonitor: ClaudeActivityMonitor | null = null;
```

- [ ] **Step 2: Wire monitor into `startInteractive()` mux path**

Find where the mux PTY is spawned (around line 1072). After `this._isLoadingScrollback = true` is removed and before or after the PTY spawn, add:

```typescript
// Start activity monitor for claude-mode (replaces PTY-based detection)
if (this.mode === 'claude') {
  this._activityMonitor = new ClaudeActivityMonitor(this.id, this.workingDir);
  this._activityMonitor.on('working', () => {
    if (this._isStopped) return;
    this._isWorking = true;
    this._status = 'busy';
    this.emit('working');
  });
  this._activityMonitor.on('idle', () => {
    if (this._isStopped) return;
    this._isWorking = false;
    this._status = 'idle';
    this._lastPromptTime = Date.now();
    this.emit('idle');
  });
  void this._activityMonitor.start();
}
```

- [ ] **Step 3: Remove PTY-based detection for claude-mode**

In the `onData` handler inside `startInteractive()` mux path:
- Remove: the entire `_isLoadingScrollback` flag set/check
- Remove: `const hasSpinner = ...` spinner check block
- Keep: the `❯` idle timer block, but wrap it with `if (!this._activityMonitor) { ... }` so it only runs as fallback

In `_processExpensiveParsers()`:
- Remove: the `!this._isLoadingScrollback` guard
- Wrap the entire work-keyword detection block with `if (!this._activityMonitor) { ... }`

Remove the `_isLoadingScrollback` field declaration.

- [ ] **Step 4: Wire monitor stop into `stop()`**

Find the `stop()` method. Add:
```typescript
this._activityMonitor?.stop();
this._activityMonitor = null;
```

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Run full test suite**

```bash
npx vitest run 2>&1 | tail -20
```
Expected: all passing. `busy-indicator-scrollback-guard.test.ts` will now fail (its sessions are no longer running PTY detection).

- [ ] **Step 7: Delete the replaced test file**

```bash
git rm test/busy-indicator-scrollback-guard.test.ts
```

- [ ] **Step 8: Run full test suite again**

```bash
npx vitest run 2>&1 | tail -20
```
Expected: all passing, no reference to deleted file.

- [ ] **Step 9: Run lint**

```bash
npm run lint
```

- [ ] **Step 10: Commit**

```bash
git add src/session.ts src/claude-activity-monitor.ts
git commit -m "feat: wire ClaudeActivityMonitor into Session, remove PTY busy detection"
```

---

## Task 6: Build, deploy, and verify

- [ ] **Step 1: Build**

```bash
npm run build 2>&1 | grep -v "cp -r src/web/public\|Error: Command failed\|at " | head -20
```
Expected: TypeScript compiles without errors (the cp vendor error is a pre-existing artifact — ignore it).

- [ ] **Step 2: Kill and restart dev server**

```bash
kill $(lsof -ti:3074) 2>/dev/null; sleep 1
nohup npx tsx src/index.ts web --port 3074 > /tmp/codeman-3074.log 2>&1 &
sleep 7 && curl -s http://localhost:3074/api/status | python3 -c "
import sys, json
d = json.load(sys.stdin)
for s in d['sessions'][:8]:
    print(f'{s[\"name\"]}: status={s[\"status\"]} isWorking={s[\"isWorking\"]}')
"
```
Expected: all sessions showing `status=idle isWorking=False` on startup.

- [ ] **Step 3: Final commit if any straggler files**

```bash
git status
# if clean, nothing to do
# if dirty: git add -A && git commit -m "chore: cleanup after monitor integration"
```

- [ ] **Step 4: Run full QA**

```bash
npx tsc --noEmit && npm run lint && npx vitest run
```
Expected: all green.

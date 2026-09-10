# Harness Activity Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Correct busy/idle status for `codex` and `pi` sessions, and stream pi's transcript live from its first turn.

**Architecture:** Each harness declares an `activity` source. Claude keeps `ClaudeActivityMonitor`. pi reports its own lifecycle (`agent_start` / `agent_settled` / compaction events) through a small Codeman pi extension posting ordered, token-authenticated `harness_activity` hook events. codex is read from its rollout records (`task_started` / `task_complete` / `turn_aborted`). `Session` gets one attach/detach path for all monitors, and idle events carry a `completed` or `stale` reason so a lost signal never fires completion side effects.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Fastify, vitest, tmux, vanilla JS frontend (`src/web/public/app.js`), pi 0.85.1 extension API.

**Spec:** `docs/superpowers/specs/2026-09-10-harness-activity-detection-design.md` (revision 5.1). **Read it in full before Task 1.** It records the verified pi and codex behaviour this plan depends on; do not re-derive it, and do not reintroduce transcript-based inference for pi.

## Global Constraints

- Node: brew Node v25 on PATH for vitest (better-sqlite3 ABI). **Never run the full vitest suite** — individual files only (it crashes tmux from a Codeman session).
- Full suite has ~115 pre-existing env failures plus two known-red tests on master: `test/server-restore-mux-sessions.test.ts` ("workingDir dedup") and `test/routes/session-routes.test.ts` ("rejects empty payload"). Compare failure SETS vs master, never against zero.
- NodeNext ESM: every relative import ends in `.js`.
- **Do not change `ClaudeActivityMonitor`'s detection logic.** Only add a `state` getter and bring it under the shared attach/detach path.
- **Shell and opencode keep the PTY fallback unchanged.**
- **Missing idle reason means `completed`.** Existing argument-free `emit('idle')` calls must keep today's behaviour.
- **A `stale` idle must never call `RunSummaryTracker.recordIdle` or `compactContinue.onIdle()`.**
- pi extension file: **no imports**, never throws, returns `undefined` from `session_before_compact`, process-wide counters on `globalThis.__codemanActivity`.
- Activity token: 32 lowercase hex chars; rotated **only** on tmux create-session and dead-pane respawn; **never** on attach to a surviving pane.
- Hook POST URL is exactly `/api/hook-event` — the localhost auth exemption compares `req.url` exactly.
- Commit after every task, conventional-commit prefixes, ending `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Activity source property and idle reasons

**Files:**
- Modify: `src/harnesses/types.ts` — `HarnessDefinition`
- Modify: `src/harnesses/{claude,codex,pi,opencode,shell}.ts`
- Modify: `src/web/server.ts` — `SessionListeners.idle` type and the `idle` listener in `setupSessionListeners`
- Create: `src/types/activity.ts`
- Test: `test/harness-activity-source.test.ts`, extend `test/harness-registry.test.ts`

**Interfaces:**
- Produces: `type ActivitySource = 'claudeTranscript' | 'hook' | 'transcript' | 'pty'`; `HarnessDefinition.activity: ActivitySource`; `type IdleReason = 'completed' | 'stale'`; `interface IdleInfo { reason?: IdleReason }`; `export function normalizeIdleReason(info?: IdleInfo): IdleReason`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/harness-activity-source.test.ts
import { describe, it, expect } from 'vitest';
import { getHarness } from '../src/harnesses/registry.js';
import { normalizeIdleReason } from '../src/types/activity.js';

describe('harness activity source', () => {
  it.each([
    ['claude', 'claudeTranscript'],
    ['pi', 'hook'],
    ['codex', 'transcript'],
    ['opencode', 'pty'],
    ['shell', 'pty'],
  ] as const)('%s uses %s', (mode, source) => {
    expect(getHarness(mode).activity).toBe(source);
  });
});

describe('normalizeIdleReason', () => {
  it('treats a missing argument as completed (legacy emit("idle"))', () => {
    expect(normalizeIdleReason()).toBe('completed');
    expect(normalizeIdleReason({})).toBe('completed');
  });
  it('keeps stale', () => {
    expect(normalizeIdleReason({ reason: 'stale' })).toBe('stale');
  });
  it('rejects unknown values as completed', () => {
    expect(normalizeIdleReason({ reason: 'bogus' as never })).toBe('completed');
  });
});
```

Add a server-listener test (extend `test/server-harness-transcript-watcher.test.ts` or a new `test/server-idle-reason.test.ts` using the same server-construction helper) asserting:
- `session.emit('idle')` → `broadcast('session:idle')`, `tracker.recordIdle` called once, `compactContinue.onIdle` called when enabled;
- `session.emit('idle', { reason: 'stale' })` → `broadcast('session:idle')`, `recordIdle` **not** called, `onIdle` **not** called.

- [ ] **Step 2:** Run `npx vitest run test/harness-activity-source.test.ts` — expect FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/types/activity.ts
/** Where a harness's busy/idle status comes from. See the activity-detection spec, §1. */
export type ActivitySource = 'claudeTranscript' | 'hook' | 'transcript' | 'pty';

/**
 * Why a session went idle.
 * - completed: an authoritative end of turn.
 * - stale: tracking was lost while a turn was open; must not fire completion side effects.
 */
export type IdleReason = 'completed' | 'stale';

export interface IdleInfo {
  reason?: IdleReason;
}

/** Existing emitters call emit('idle') with no argument; that has always meant completion. */
export function normalizeIdleReason(info?: IdleInfo): IdleReason {
  return info?.reason === 'stale' ? 'stale' : 'completed';
}
```

Add `activity: ActivitySource` to `HarnessDefinition` with a doc comment, and set it in each harness file per the table. In `server.ts` change the listener type to `idle: (info?: IdleInfo) => void` and the listener to:

```typescript
idle: (info?: IdleInfo) => {
  const reason = normalizeIdleReason(info);
  this.broadcast(SseEvent.SessionIdle, { id: session.id });
  if (!this.transcriptWatchers.has(session.id)) this.startHarnessTranscriptWatcher(session.id);
  this.broadcastSessionStateDebounced(session.id);
  const tracker = this.runSummaryTrackers.get(session.id);
  if (tracker) {
    // A stale idle means tracking was lost, not that the turn finished.
    if (reason === 'completed') tracker.recordIdle();
    tracker.recordTokens(session.inputTokens, session.outputTokens);
  }
  if (reason === 'completed' && session.autoCompactAndContinue) {
    void session.compactContinue.onIdle(session.workingDir, session.textOutput);
  }
},
```

- [ ] **Step 4:** Run both test files — expect PASS. `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(harnesses): declare activity source per harness and idle reasons`.

---

### Task 2: Session activity lifecycle (one attach/detach path)

**Files:**
- Create: `src/activity-monitor.ts`
- Modify: `src/claude-activity-monitor.ts` — add `get state()` only
- Modify: `src/session.ts` — `startInteractive()`, PTY `onExit`, `prepareForRestart()`, `rebindMuxSession()`, settle timer, `sendInput()`, `assignTask()`, `clearTask()`, legacy `start()`, `recordHarnessSessionId()`
- Test: `test/session-activity-lifecycle.test.ts`

**Interfaces:**
- Consumes: `ActivitySource`, `IdleInfo` (Task 1).
- Produces:
```typescript
// src/activity-monitor.ts
export type ActivityState = 'working' | 'idle' | 'unknown';
export interface ActivityMonitor extends EventEmitter {
  readonly state: ActivityState;
  start(): Promise<void>;
  stop(): void;
  setHarnessSessionId?(id: string): void;
}
export type ActivityMonitorFactory = (session: ActivityMonitorHost) => ActivityMonitor | null;
export interface ActivityMonitorHost {
  readonly id: string;
  readonly workingDir: string;
  readonly harnessSessionId?: string;
}
```
- `Session` private methods: `_attachActivityMonitor(): void`, `_detachActivityMonitor(): void`, `_setActivityFieldsIdleSilently(): void`. Tasks 3 and 6 register their monitors through a factory map keyed by `ActivitySource`, so this task ships with only the Claude entry wired and `hook`/`transcript` returning `null` until then.

- [ ] **Step 1: Write the failing tests.** Use a mock mux (follow `test/harness-spawn-plumbing.test.ts`) and a fake monitor factory that records instances. Assert:
  - claude attaches a `ClaudeActivityMonitor`; shell/opencode attach none;
  - **initial `idle` emits zero `idle` events; initial `working` emits exactly one `working`** (fake monitor resolving its initial state);
  - calling `startInteractive()` → PTY exit → `startInteractive()` three times leaves **exactly one** non-stopped monitor (the pre-existing Claude leak);
  - PTY exit and `prepareForRestart()` set both `_status` and `_isWorking` idle and emit nothing;
  - the settle timer does not overwrite a monitor-reported `working`;
  - with a monitor attached, `sendInput`/`assignTask`/`clearTask` leave `_status` unchanged;
  - `rebindMuxSession`: a late `onExit` from the killed PTY does not detach or change state;
  - a late callback from a detached monitor (emit on the old instance) changes nothing.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement.**
  - Add `get state(): ActivityState { return this._isBusy ? 'working' : 'idle'; }` to `ClaudeActivityMonitor`. No other change there.
  - In `Session`, replace the `if (this.mode === 'claude') { … }` monitor block in `startInteractive()` with `this._attachActivityMonitor()`.
  - `_attachActivityMonitor()`:

```typescript
private _attachActivityMonitor(): void {
  this._detachActivityMonitor();
  this._setActivityFieldsIdleSilently();
  const monitor = createActivityMonitor(getHarness(this.mode).activity, this);
  if (!monitor) return; // 'pty': the PTY fallback remains in charge
  const gen = ++this._activityGeneration;
  this._activityMonitor = monitor;
  monitor.on('working', () => {
    if (this._isStopped || gen !== this._activityGeneration) return;
    if (this._isWorking) return;
    this._isWorking = true;
    this._status = 'busy';
    this.emit('working');
  });
  monitor.on('idle', (info?: IdleInfo) => {
    if (this._isStopped || gen !== this._activityGeneration) return;
    // A completed idle is emitted even when already idle: it may close a turn that went stale.
    const reason = normalizeIdleReason(info);
    if (!this._isWorking && reason === 'stale') return;
    this._isWorking = false;
    this._status = 'idle';
    this._lastPromptTime = Date.now();
    this.emit('idle', { reason });
    if (reason === 'completed') this._maybeRefreshContextAfterCompact();
  });
  void monitor.start();
}

private _detachActivityMonitor(): void {
  this._activityGeneration++;
  this._activityMonitor?.stop();
  this._activityMonitor?.removeAllListeners();
  this._activityMonitor = null;
}

private _setActivityFieldsIdleSilently(): void {
  this._isWorking = false;
  this._status = 'idle';
}
```

  - The monitor, not the session, decides whether a `completed` idle is a duplicate: monitors emit `completed` only when an authoritative end closes an open turn (`turnOpen`, Tasks 3 and 6). `ClaudeActivityMonitor` already emits idle only on a real transition, which satisfies that.
  - PTY `onExit` (current generation only), `prepareForRestart()`, and the `startInteractive()` catch path: call `_detachActivityMonitor()` then `_setActivityFieldsIdleSilently()`.
  - Settle timer: when `getHarness(this.mode).activity !== 'pty'`, emit `needsRefresh` only and leave `_status` alone.
  - `sendInput()`, `assignTask()`, `clearTask()`, legacy `start()`: wrap their `_status` writes in `if (!this._activityMonitor)`.
  - `rebindMuxSession()`: move `const ptyGeneration = ++this._ptyGeneration;` to **before** the old PTY is killed, and use that value for the new PTY's callbacks. After re-spawning the attach PTY: if the harness `activity` is `'hook'`, call `_attachActivityMonitor()`; if `'transcript'`, call `_detachActivityMonitor()` and `_setActivityFieldsIdleSilently()` and do not re-attach (spec §5); if `'claudeTranscript'`, keep today's behaviour but re-synchronise fields from `this._activityMonitor.state` instead of forcing idle.
  - `recordHarnessSessionId(id)`: after recording, `this._activityMonitor?.setHarnessSessionId?.(id)`.
- [ ] **Step 4:** Run the new test plus `test/claude-activity-monitor.test.ts`, `test/harness-spawn-plumbing.test.ts`, `test/harness-session-id-persistence.test.ts` — expect PASS with the same failure set as master. `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `refactor(sessions): single attach/detach path for activity monitors`.

---

### Task 3: `CodexTranscriptActivityMonitor`

**Files:**
- Modify: `src/harnesses/transcripts/types.ts` — optional `classifyActivity`
- Modify: `src/harnesses/transcripts/codex.ts` — implement it
- Create: `src/codex-transcript-activity-monitor.ts`
- Modify: `src/activity-monitor.ts` — register the `transcript` factory
- Test: `test/codex-transcript-activity-monitor.test.ts`, fixture `test/fixtures/codex-activity/`

**Interfaces:**
- `TranscriptAdapter.classifyActivity?(record: unknown): 'working' | 'idle' | null` (pure; never throws).
- `new CodexTranscriptActivityMonitor(adapter, ctx: { workingDir; sessionId; harnessSessionId? }, opts?: { chunkBytes?: number; scanBudgetBytes?: number; pendingCapBytes?: number; pollMs?: number; staleMs?: number })` — options exist so tests can use small sizes and fake timers.

- [ ] **Step 1: Write the failing tests.** Use temp directories and override `locate` via a tiny fake adapter that wraps `codexTranscriptAdapter.classifyActivity` and returns the temp path. Build fixtures from real rollout lines (redact content). Cover every row of spec §6's test list:
  - classification: `task_started` working, `task_complete` idle, `turn_aborted` idle, other records null, malformed line null;
  - initial scan: idle, working (emits one `working`), `unknown` (emits nothing);
  - **a record larger than `chunkBytes` spanning chunk boundaries** (use `chunkBytes: 64`, a 300-byte line after `task_started`);
  - a complete first line at byte 0 with no preceding newline;
  - budget cutting through an unclassified record → `unknown`;
  - trailing unterminated fragment at EOF seeds the pending buffer and parses once its newline is appended;
  - replacement between scan and publish → rescan (swap the file inode between the two `stat` calls via an injected `statFn`);
  - writes between scan and watch are not skipped;
  - oversized pending line (`pendingCapBytes: 128`): the rest of that record is discarded, the next record parses;
  - truncation, and **equal-size replacement** (write a new file of identical size, rename over) → reset and rescan;
  - `staleMs` of silence while working → `idle { reason: 'stale' }`, then `task_complete` → `idle { reason: 'completed' }` exactly once;
  - `fs.watch` throwing → polling still detects appends;
  - `setHarnessSessionId` on a file already containing `task_started` → `working`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement.** Classification:

```typescript
classifyActivity(record) {
  const rec = obj(record);
  if (!rec || rec.type !== 'event_msg') return null;
  const t = obj(rec.payload)?.type;
  if (t === 'task_started') return 'working';
  if (t === 'task_complete' || t === 'turn_aborted') return 'idle';
  return null;
},
```

Monitor, following spec §6 exactly:
  - `state`, `turnOpen`, `generation`, `offset`, `inode`, `pending: string`, `discardUntilNewline: boolean`.
  - `start()`: `locate()`; if null, poll every `pollMs`. When found: `scanBackward()`, then arm `fs.watch`, then `readForward()` from the consumed offset, then publish initial state (emit `working` only if the scan result is `working`; set `turnOpen`).
  - `scanBackward()`: `stat` → `{ ino, size }`; read chunks from `size` backward; carry the leading fragment; at position 0 treat the fragment as a complete line; exclude the trailing fragment after the last newline at EOF and seed `pending` with it; iterate complete lines newest-first; return the first non-null classification; stop at `scanBudgetBytes` → `unknown` (also `unknown` when the budget boundary splits an unclassified record). `stat` again before returning; on inode change or shrink, restart the scan.
  - `readForward()`: read at most 4 MB per pass (a constant, looping until caught up), append to `pending`, split on `\n`, and keep the last fragment. If `pending` exceeds `pendingCapBytes`, drop it and set `discardUntilNewline`; while that flag is set, drop bytes up to and including the next newline.
  - On each change event and each poll tick: `stat`; inode change or `size < offset` → reset pending, flag and timers, rescan, re-arm watcher; missing file → re-run `locate()`.
  - Transitions: classification `working` → if not working, set working, `turnOpen = true`, emit `working`; reset the stale timer. `idle` → if `turnOpen`, set idle, `turnOpen = false`, emit `idle { completed }`. Any write while working resets the stale timer; on expiry emit `idle { stale }` and keep `turnOpen`.
  - Every callback checks `generation`; `setHarnessSessionId` and `stop()` bump it.
  - Register `transcript: (host) => new CodexTranscriptActivityMonitor(codexTranscriptAdapter, host)` in the factory map.
- [ ] **Step 4:** Run the new tests plus `test/transcript-adapter-codex.test.ts` — expect PASS. `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(codex): derive busy/idle from rollout turn records`.

---

### Task 4: Activity token

**Files:**
- Modify: `src/mux-interface.ts` — `CreateSessionOptions`, `RespawnPaneOptions`
- Modify: `src/tmux-manager.ts` — both `envExports` arrays
- Modify: `src/session.ts` — generate in the create and respawn branches; persist; restore
- Modify: `src/types/session.ts` — `SessionState.activityToken?: string`
- Test: `test/activity-token.test.ts`, extend `test/tmux-spawn-outer-shell.test.ts`

**Interfaces:** `activityToken?: string` on both option types and on `SessionState`; `export function newActivityToken(): string` (uses `crypto.randomBytes(16).toString('hex')`); `export const ACTIVITY_TOKEN_PATTERN = /^[0-9a-f]{32}$/`.

- [ ] **Step 1: Write the failing tests:**
  - both tmux command prefixes contain `export CODEMAN_ACTIVITY_TOKEN=<token>` when a valid token is passed, and omit it (never interpolate) for an invalid one;
  - `startInteractive()` on a pi session with no mux session → `createSession` receives a 32-hex token, and `toState().activityToken` equals it;
  - dead pane → `respawnPane` receives a **new** token;
  - **restored session (existing live pane) → no new token; the persisted `activityToken` is kept**;
  - a claude session passes no token.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement.** In `startInteractive()`: in the dead-pane branch before `respawnPane(...)` and in the create branch before `createSession(...)`, when `getHarness(this.mode).activity === 'hook'`, set `this.activityToken = newActivityToken()` and pass it. Do nothing in the `isRestoredSession` attach branch. Serialise `activityToken` in `toState()` and restore it in both server restore construction paths, as `harnessSessionId` is. In `tmux-manager.ts` append to both arrays:

```typescript
if (activityToken && ACTIVITY_TOKEN_PATTERN.test(activityToken)) {
  envExports.push(`export CODEMAN_ACTIVITY_TOKEN=${activityToken}`);
}
```

- [ ] **Step 4:** Run tests; typecheck.
- [ ] **Step 5:** Commit `feat(pi): per-process activity token exported at spawn`.

---

### Task 5: The pi extension and its launch flag

**Files:**
- Create: `src/harnesses/pi/codeman-activity-extension.ts`
- Modify: `src/harnesses/pi.ts` — `buildCommand`
- Test: `test/pi-activity-extension.test.ts`, extend `test/harness-codex-pi.test.ts`

- [ ] **Step 1: Write the failing tests.** Import the default export and call it with a fake `pi` (`{ on(event, handler) { handlers[event] = handler } }`). Mock `global.fetch`; use `vi.useFakeTimers()`; reset `globalThis.__codemanActivity` in `beforeEach`; set/unset the three env vars per test. Cover every bullet under "pi extension" in the spec's Testing section, including: `agent_start, agent_start, agent_settled` → posts `working` then `idle`; `session_before_compact` handler returns `undefined`; **`seq` strictly increases across two factory invocations** (call the factory twice with the same `globalThis`, as `/reload` does) and `gen` is 1 then 2; a hanging fetch (`new Promise(() => {})`) and a rejecting fetch never throw; posted URL is exactly `${CODEMAN_API_URL}/api/hook-event`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement.**

```typescript
/**
 * Codeman activity reporter for pi.
 *
 * Loaded by Codeman with `pi -e <this file>`. Reports whether pi is working to the Codeman
 * session that launched it, using pi's own lifecycle events. See
 * docs/superpowers/specs/2026-09-10-harness-activity-detection-design.md §3.
 *
 * Runs inside pi's process: no imports, never throws.
 */

type Handler = (event: unknown, ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }) => unknown;
interface PiLike {
  on(event: string, handler: Handler): void;
}
interface Counters {
  seq: number;
  gen: number;
}

const HEARTBEAT_MS = 30_000;
const POST_TIMEOUT_MS = 2_000;

export default function codemanActivity(pi: PiLike): void {
  const sessionId = process.env.CODEMAN_SESSION_ID;
  const apiUrl = process.env.CODEMAN_API_URL;
  const token = process.env.CODEMAN_ACTIVITY_TOKEN;
  if (!sessionId || !apiUrl || !token) return;

  // Process-wide: pi re-imports extension modules on /reload, so module state would reset.
  const g = globalThis as { __codemanActivity?: Counters };
  const counters = (g.__codemanActivity ??= { seq: 0, gen: 0 });
  const gen = ++counters.gen;

  let runActive = false;
  let compacting = false;
  let sessionFile: string | undefined;
  let lastPosted: string | undefined;

  const state = (): 'working' | 'idle' => (runActive || compacting ? 'working' : 'idle');

  const post = (force: boolean): void => {
    const current = `${state()}|${sessionFile ?? ''}`;
    if (!force && current === lastPosted) return;
    lastPosted = current;
    try {
      void fetch(`${apiUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'harness_activity',
          sessionId,
          data: { state: state(), token, gen, seq: ++counters.seq, sessionFile },
        }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      }).catch(() => {});
    } catch {
      /* never throw into pi */
    }
  };

  const noteFile = (ctx: Parameters<Handler>[1]): void => {
    try {
      sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? sessionFile;
    } catch {
      /* ignore */
    }
  };

  const heartbeat = setInterval(() => post(true), HEARTBEAT_MS);
  heartbeat.unref?.();

  pi.on('session_start', (_e, ctx) => { noteFile(ctx); post(true); });
  pi.on('agent_start', (_e, ctx) => { noteFile(ctx); runActive = true; compacting = false; post(false); });
  pi.on('agent_settled', (_e, ctx) => { noteFile(ctx); runActive = false; post(false); });
  pi.on('session_before_compact', (_e, ctx) => { noteFile(ctx); compacting = true; post(false); return undefined; });
  pi.on('session_compact', (_e, ctx) => { noteFile(ctx); compacting = false; post(false); });
  pi.on('session_compact_failed', (_e, ctx) => { noteFile(ctx); compacting = false; post(false); });
  pi.on('session_shutdown', () => {
    runActive = false;
    compacting = false;
    clearInterval(heartbeat);
    post(true);
  });
}
```

  In `src/harnesses/pi.ts`, resolve the extension path once at module load:

```typescript
const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION_CANDIDATES = [
  join(here, 'pi', 'codeman-activity-extension.js'),
  join(here, 'pi', 'codeman-activity-extension.ts'),
];
export function resolvePiActivityExtension(exists = existsSync): string | null {
  return EXTENSION_CANDIDATES.find((p) => exists(p)) ?? null;
}
```

  and in `buildCommand` append `'-e', shellQuote(path)` when it resolves; log one warning (module-level flag) when it does not.
- [ ] **Step 4:** Run tests; typecheck; `npm run build` and confirm `dist/harnesses/pi/codeman-activity-extension.js` exists.
- [ ] **Step 5:** Commit `feat(pi): report agent lifecycle to Codeman via a pi extension`.

---

### Task 6: `harness_activity` route and `HookActivityMonitor`

**Files:**
- Modify: `src/web/schemas.ts` — `HookEventSchema` enum
- Modify: `src/web/routes/hook-event-routes.ts` — early branch
- Create: `src/hook-activity-monitor.ts`
- Modify: `src/session.ts` — `applyHookActivity(state, report)`
- Modify: `src/activity-monitor.ts` — register the `hook` factory
- Test: extend `test/routes/hook-event-routes.test.ts` (and its mock context), `test/hook-activity-monitor.test.ts`

**Interfaces:**
- `export interface HarnessActivityReport { state: 'working' | 'idle'; token: string; gen: number; seq: number; sessionFile?: string }`
- `export function acceptActivityReport(owner: { lastSeq?: number; ownerGen?: number }, expectedToken: string | undefined, r: HarnessActivityReport): boolean` — pure, exported for tests.
- `Session.applyHookActivity(report: HarnessActivityReport): 'accepted' | 'rejected'`.
- `HookActivityMonitor` — `state`, `turnOpen`, `report(state)`, 90 s staleness (`staleMs` option).

- [ ] **Step 1: Write the failing tests:**
  - `acceptActivityReport`: wrong token → false; first valid report with no prior state → true and initialises `lastSeq`/`ownerGen`; `seq` ≤ `lastSeq` → false; `gen` < `ownerGen` → false even when `seq` is higher; higher `gen` → true.
  - Route: pi session + valid `harness_activity` → 200, activity applied; same payload for claude/codex/shell/opencode sessions → ignored; invalid `data` shapes → 400; **zero** `broadcast('hook:harness_activity')`, `sendPushNotifications`, `recordHookEvent`, vault capture and orchestrator calls; a payload that also carries `transcript_path` does **not** start a watcher through the legacy branch.
  - `HookActivityMonitor`: `working` report → one `working`; `idle` → `idle { completed }`; 90 s without any report while working → `idle { stale }`; a later `idle` report → `idle { completed }` exactly once; repeated `working` heartbeats emit nothing new.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement.** Add `'harness_activity'` to the schema enum. In the route, directly after the session-exists and paused checks:

```typescript
if (event === 'harness_activity') {
  const session = ctx.sessions.get(sessionId);
  if (!session || getHarness(session.mode).activity !== 'hook') return { success: true };
  const parsed = HarnessActivityDataSchema.safeParse(data);
  if (!parsed.success) {
    return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid harness_activity payload');
  }
  const outcome = session.applyHookActivity(parsed.data);
  if (outcome === 'accepted' && parsed.data.sessionFile) {
    ctx.acceptHarnessTranscriptPath(sessionId, parsed.data.sessionFile); // Task 7
  }
  return { success: true };
}
```

  with `HarnessActivityDataSchema = z.object({ state: z.enum(['working','idle']), token: z.string().regex(/^[0-9a-f]{32}$/), gen: z.number().int().positive(), seq: z.number().int().positive(), sessionFile: z.string().max(4096).optional() })`. Until Task 7, `acceptHarnessTranscriptPath` is a no-op on the port. `Session.applyHookActivity` keeps `{ lastSeq, ownerGen }` in memory, calls `acceptActivityReport(owner, this.activityToken, report)`, and forwards accepted states to the attached `HookActivityMonitor`.
- [ ] **Step 4:** Run tests; typecheck.
- [ ] **Step 5:** Commit `feat(pi): ordered harness_activity hook events drive pi busy/idle`.

---

### Task 7: pi transcript path, watcher retargeting and `transcriptId` (server)

**Files:**
- Modify: `src/transcript-watcher.ts` — `start(path, opts?)`, `updatePath(path, opts?)`, inode replacement, `transcriptId`
- Modify: `src/web/server.ts` — `acceptHarnessTranscriptPath`, `startHarnessTranscriptWatcher`, SSE payloads
- Modify: `src/web/ports/*` — add `acceptHarnessTranscriptPath` to the port
- Modify: `src/web/routes/session-routes.ts` — `/transcript` and `/state` use the persisted path for `activity: 'hook'`; `X-Transcript-Id` header
- Modify: `src/types/session.ts` — `SessionState.harnessTranscriptPath?: string`
- Test: extend `test/transcript-watcher.test.ts`, `test/server-harness-transcript-watcher.test.ts`, `test/routes/transcript-routes-harness.test.ts`

**Interfaces:**
- `TranscriptWatcher.start(path: string, opts?: { fromOffset?: number }): void`; `updatePath(path: string, opts?: { fromOffset?: number }): void`; `readonly transcriptId: string`.
- `export function isUnderPiSessionsRoot(candidate: string, env = process.env, home = homedir()): string | null` — returns the canonical path or null; checks the resolved **parent directory**.
- SSE payloads: `transcript:block { sessionId, block, transcriptId }`, `transcript:clear { sessionId, transcriptId }`, `transcript:ready { sessionId, transcriptId }`.

- [ ] **Step 1: Write the failing tests:**
  - watcher: `start(existing, { fromOffset: 0 })` emits existing blocks; `start(existing)` still starts at EOF (unchanged default); a new `transcriptId` on start, on `updatePath` to a different path, and on replacement; **equal-size replacement** (rename a same-size file over) emits `transcript:clear` and re-reads from 0;
  - `isUnderPiSessionsRoot`: honours `PI_CODING_AGENT_DIR`; rejects `..` traversal and symlinked escapes; returns null when the parent is missing;
  - server: the first accepted `sessionFile` for a missing file starts a polling watcher and persists `harnessTranscriptPath`; creating the file later broadcasts its blocks; a changed `sessionFile` retargets with `fromOffset: 0` and a new `transcriptId`; an out-of-root path is ignored;
  - REST: for a pi session, `/transcript` and `/state` read `harnessTranscriptPath` (not `locate()`), and `/transcript` sends `X-Transcript-Id` matching the watcher.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** per spec §7. In `start()`, replace the existing-file branch's `this.filePosition = stat.size` with `this.filePosition = opts?.fromOffset ?? stat.size`, record `this._inode = stat.ino`, and set `this._transcriptId = randomUUID()`. In `processNewContent()`, `stat` and treat `stat.ino !== this._inode` like the existing shrink branch (reset position, new id, emit clear). `acceptHarnessTranscriptPath(sessionId, raw)`: canonicalise with `isUnderPiSessionsRoot`; if null, return; if it differs from `session.harnessTranscriptPath` or no watcher exists, persist it and `watcher.updatePath(path, { fromOffset: 0 })` (creating the watcher as `startHarnessTranscriptWatcher` does).
- [ ] **Step 4:** Run tests; typecheck.
- [ ] **Step 5:** Commit `feat(transcript): follow pi's authoritative session file with transcript identity`.

---

### Task 8: Client reconciliation contract

**Files:**
- Modify: `src/web/public/app.js` — `_onTranscriptBlock`, `_onTranscriptClear`, `_onTranscriptReady`, `TranscriptView.append`, `TranscriptView.load` (response, DOM reuse, both replay paths), periodic incremental sync, older-block pagination
- Test: extend `test/transcript-ui-harness.test.ts` (real `app.js` via its Playwright harness)

- [ ] **Step 1: Write the failing tests** — one per row of the spec's reconciliation table, plus:
  - replaying blocks from seq 0 after a REST load renders no duplicates, in the visible view and in the inactive-view state;
  - **`load()` with a new `transcriptId` whose snapshot matches the cache's block count, last `seq` and type clears the container and renders the new text; no old message remains** (seed the DOM with "OLD", respond with "NEW" at identical seqs);
  - an in-flight `load()` whose session id changes before it resolves discards its response;
  - incremental sync and pagination responses with a different `X-Transcript-Id` trigger `load()` and do not append or prepend.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement.** Store `state.transcriptId`. Buffer `{ block, transcriptId }`. Add two helpers and use them in every row:

```javascript
/** The newest block we have accepted for this session, or undefined. */
_acceptedTail(state) {
  return state.blocks[state.blocks.length - 1];
},

/** True when a block from `transcriptId` may be appended after the accepted tail. */
_shouldAppend(state, block, transcriptId) {
  if (transcriptId && state.transcriptId && transcriptId !== state.transcriptId) return false;
  return this._isNewerBlock(block, this._acceptedTail(state));
},
```

  In `load()`: capture `const requestedId = state.transcriptId` before fetching; on response, if `state.transcriptId !== requestedId` (changed by an SSE clear or block meanwhile), discard and call `load()` again; read `X-Transcript-Id`; **only take the existing DOM-reuse shortcut when the header id equals the cached id**; replay buffered entries in both the empty and non-empty branches with `_shouldAppend(state, entry.block, entry.transcriptId)`. Blocks without `seq` keep today's timestamp comparison inside `_isNewerBlock`.
- [ ] **Step 4:** Run `npx vitest run test/transcript-ui-harness.test.ts`.
- [ ] **Step 5:** Commit `fix(transcript-ui): reconcile live and fetched blocks by transcript identity`.

---

### Task 9: Gate auto-compact-and-continue to Claude

**Files:** `src/web/server.ts` (already reason-gated in Task 1), `src/web/routes/session-routes.ts` (`POST /api/sessions/:id/auto-compact-continue`), test in `test/session-compact-continue.test.ts` or `test/routes/session-routes.test.ts`.

- [ ] **Step 1:** Failing tests: enabling for a codex or pi session returns an error and leaves it disabled; a codex/pi session with the flag forced on in state never calls `onIdle` on a completed idle.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** In the route, reject when `!getHarness(session.mode).caps.claudeTranscript`. In the server idle listener, add `getHarness(session.mode).caps.claudeTranscript` to the `onIdle` condition.
- [ ] **Step 4:** Run; typecheck.
- [ ] **Step 5:** Commit `fix(sessions): auto-compact-and-continue is Claude-only`.

---

### Task 10: Live verification and docs

- [ ] **Step 1: Isolated dev server.** A dev server on the real `HOME` adopts the user's live production sessions. Use the proven recipe:

```sh
env -u TMUX HOME=$SCRATCH/home TMUX_TMPDIR=/tmp/cmact \
  nohup npx tsx src/index.ts web --port 3431 > /tmp/codeman-3431.log 2>&1 &
```

  where `$SCRATCH/home` symlinks every entry of the real `$HOME` **except** `.codeman`, which is a fresh empty directory. Confirm `GET /api/status` shows `sessions: []` before continuing; if it lists `Restored: codeman-*`, kill it immediately. Use `/usr/local/bin/codex` (0.154.0); bare `codex` resolves to a stale 0.144.5 that the account's default model rejects.
- [ ] **Step 2: pi.** Create a pi session, send one turn (input, then a separate `"\r"` with `useMux: true`). Record: `/api/sessions` shows `busy` during the turn and `idle` after; the transcript view streams the first turn without a reload; server log shows accepted `harness_activity` reports; `ps e` for the pi process shows `CODEMAN_ACTIVITY_TOKEN`. Then run `/new` inside pi and send a turn: the transcript view follows the new file.
- [ ] **Step 3: codex.** Create a codex session, accept the directory-trust prompt **before** sending input (typed text can select "No, quit"), send a turn. Record busy mid-turn, idle after `task_complete`.
- [ ] **Step 4: Regression.** A claude session still goes busy/idle; shell and opencode behave as before; restart the dev server with a pi session mid-idle and confirm its next report is accepted (token kept on attach).
- [ ] **Step 5:** Write results to `docs/superpowers/plans/2026-09-10-harness-activity-detection-smoke.md`; stop the dev server and its tmux socket.
- [ ] **Step 6:** Update `CHANGELOG.md`, `FEATURES.md`, and a `.changeset/` entry: pi and codex now report accurate busy/idle; pi sessions need a restart to pick up the extension; auto-compact-and-continue is Claude-only. Commit `docs: harness activity detection`.

## Self-Review

**Spec coverage.** §1 → Task 1. §2 → Task 4. §3 → Task 5. §4 → Task 6. §5 (completion vs staleness, lifecycle table, rebind) → Tasks 1, 2, 3, 6. §6 → Task 3. §7 → Tasks 7, 8. §8 → Task 9. Acceptance → Task 10. Known limitations are documented in the spec and not implemented.

**Placeholders.** None: each step names files, functions and the exact change; the extension, classification, token export, route branch and reconciliation helpers are given in full.

**Type consistency.** `ActivitySource`, `IdleReason`, `IdleInfo`, `normalizeIdleReason` (Task 1); `ActivityMonitor`, `ActivityState` (Task 2); `HarnessActivityReport`, `acceptActivityReport` (Task 6); `activityToken`, `newActivityToken`, `ACTIVITY_TOKEN_PATTERN` (Task 4); `harnessTranscriptPath`, `transcriptId`, `isUnderPiSessionsRoot` (Task 7) are used with the same names and shapes throughout.

**Ordering.** Task 2 needs Task 1's types. Tasks 3 and 6 register factories created in Task 2. Task 6 calls Task 7's port method, which is a no-op until Task 7. Task 8 needs Task 7's `transcriptId`. Task 10 needs everything.

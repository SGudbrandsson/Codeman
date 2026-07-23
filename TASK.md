# Task

type: bug
status: done
title: Event-loop blocking execSync polling loops in TmuxManager cause severe UI slowness with many sessions
description: With ~22 sessions running, the web UI is extremely slow, especially opening a new window. Root cause already investigated and confirmed (2026-07-23): timer loops shell out to tmux/ps/pgrep with SYNCHRONOUS execSync, freezing Node's single-threaded event loop so all HTTP requests queue. Measured: /api/status ~5s idle, 30-50s with 2 concurrent requests; GET /api/sessions/:id/terminal hung 131s returning 128B; static files 2ms (handlers are in-memory + cached, so latency is pure event-loop starvation).

Confirmed blocking sites (verify line numbers against current code):
1. Stats collection, every 2s — startStatsCollection (src/tmux-manager.ts:1144, wired server.ts:3553; STATS_COLLECTION_INTERVAL_MS=2000 in src/config/server-timing.ts). getSessionsWithStats() runs a pgrep shell loop over all session PIDs (execSync, tmux-manager.ts:1055) + one big ps (execSync, :1086), each with timeout EXEC_TIMEOUT_MS=5000 (src/config/exec-timeout.ts:10). WORST PART — the catch-block fallback (:1128-1136) calls per-session getProcessStats() = 2 more execSync each (ps :1006, pgrep :1015) = 44 sequential blocking calls every 2s once the batched call starts timing out. Self-reinforcing death spiral under load.
2. Mouse-mode sync, every 5s — startMouseModeSync (tmux-manager.ts:1172): execSync tmux list-panes per session via listPanes (:1424/1432). 22 sequential blocking spawns per tick.
3. Dead-pane check, every 30s — server.ts:2375 checkAndRecoverDeadPanes: isPaneDead() execSync tmux display-message (tmux-manager.ts:620/624) per busy session.
Also per-request: GET /api/sessions/:id/screen-snapshot -> captureScreen() execFileSync tmux capture-pane (screen-analyzer.ts:106).

Fix direction (agreed): convert these timer/probe paths from execSync/execFileSync to async exec (promisified pattern already used correctly by sendInput at tmux-manager.ts:1334 via execAsync). Specifically: (a) make getSessionsWithStats + getProcessStats async; (b) remove or gate the 44-call fallback (e.g. skip fallback entirely, or make it async + concurrency-limited); (c) make mouse-mode sync listPanes async; (d) make isPaneDead async for the dead-pane timer; (e) consider shortening timeouts for these lightweight probes. Preserve behavior/return shapes; update callers to await. Do NOT convert one-shot lifecycle calls (session create/kill) unless trivial — focus on the recurring timers and hot request paths. Avoid overlapping timer ticks (guard with an in-flight flag so a slow tick is skipped, not stacked).
affected_area: backend
work_item_id: wi-00e58c7e
fix_cycles: 0
test_fix_cycles: 0

## Reproduction
With 22 sessions: curl -s -o /dev/null -w "%{time_total}" http://localhost:3001/api/status -> ~5s; two concurrent -> 30-50s. Static assets 2ms. (Live production server on 3001 — reproduce against a dev server in this worktree, or reason from code; do not restart the production service.)

## Root Cause / Spec

VERIFIED 2026-07-23 (analysis subagent). All claimed blocking sites confirmed against current code. One path deviation from the description: the web server is `src/web/server.ts`, NOT `src/server.ts`. All tmux-manager.ts line numbers matched exactly.

### Root cause (confirmed)
Recurring timers and hot request paths shell out via synchronous `execSync`/`execFileSync` (each with `timeout: EXEC_TIMEOUT_MS = 5000`, src/config/exec-timeout.ts:11). Every call blocks Node's single event loop for the full duration of the child process (up to 5s each on timeout). With 22 sessions the stats tick alone can chain 2–44 sequential blocking spawns every 2s; all HTTP handling queues behind them. The `sendInput` method (tmux-manager.ts:1325–1351) already demonstrates the correct async pattern: `execAsync` = `promisify(exec)` defined at tmux-manager.ts:28 (import at :25).

### Verified blocking sites

**Site 1 — Stats collection (every 2s), src/tmux-manager.ts**
- `startStatsCollection(intervalMs = DEFAULT_STATS_INTERVAL_MS /* 2000, :79 */)` at **:1144**. `setInterval` with an async callback awaiting `getSessionsWithStats()` (:1151) then `this.emit('statsUpdated', ...)`. **No in-flight guard — slow ticks stack.**
- `getSessionsWithStats()` at **:1035** (already `async`/Promise-returning, but internally blocking):
  - pgrep shell loop over all session PIDs: `execSync` at **:1055–1061**
  - single batched ps: `execSync` at **:1086**
  - catch-block fallback at **:1128–1136**: `sessions.map(s => this.getProcessStats(s.sessionId))` — with 22 sessions = up to 44 sequential execSync calls (getProcessStats is async-signatured but internally synchronous, so the Promise.allSettled parallelism is illusory). This is the death-spiral amplifier.
- `getProcessStats(sessionId)` at **:997** (already `async` signature): ps `execSync` at **:1006**, pgrep `execSync` at **:1015**.
- Timer wiring: `src/web/server.ts:3553` (inside `private async restoreMuxSessions()`, :3287) and `src/web/routes/mux-routes.ts:50` (POST /api/mux-sessions/stats/start). Constant `STATS_COLLECTION_INTERVAL_MS = 2000` at src/config/server-timing.ts:65.
- Hot request path also hits this: `GET /api/mux-sessions` calls `ctx.mux.getSessionsWithStats()` per-request (src/web/routes/mux-routes.ts:12) — fixed for free by converting internals.
- `statsUpdated` event consumer: src/web/server.ts:374 (SSE broadcast) — event payload shape must not change.

**Site 2 — Mouse-mode sync (every 5s), src/tmux-manager.ts**
- `startMouseModeSync(intervalMs = 5000)` at **:1172**. `setInterval` with a SYNC closure: loops all sessions calling `this.listPanes(session.muxName)` (:1181) then `enableMouseMode`/`disableMouseMode` on pane-count change. No in-flight guard.
- `listPanes(muxName)` at **:1424**: `execSync tmux list-panes` at **:1432–1435**.
- `enableMouseMode` at **:1361** (execSync :1369), `disableMouseMode` at **:1385** (execSync :1393), `syncMouseMode` at **:1410** (calls listPanes at :1412).
- Wiring: src/web/server.ts:3559–3561 via duck-typing (`'startMouseModeSync' in this.mux`) — startMouseModeSync/listPanes/enableMouseMode/disableMouseMode/syncMouseMode are NOT on the TerminalMultiplexer interface.
- **No external callers**: listPanes, syncMouseMode, enableMouseMode, disableMouseMode, sendInputToPane are only called within tmux-manager.ts (the doc comment "Called by TeamWatcher" on syncMouseMode is stale — grep confirms no team-watcher call). Signature changes here are contained to tmux-manager.ts.

**Site 3 — Dead-pane check (every 30s), src/web/server.ts**
- `checkAndRecoverDeadPanes()` at **src/web/server.ts:2375**; calls `this.mux.isPaneDead(muxName)` at **:2396** inside an async IIFE per session (fine to `await`). Per-session `_recoveringSessionIds` guard already exists, but the isPaneDead probes themselves are blocking.
- Timer wiring: src/web/server.ts:3044–3050, `this.cleanup.setInterval(() => this.checkAndRecoverDeadPanes(), DEAD_PANE_CHECK_INTERVAL_MS /* 30_000, server-timing.ts:82 */)`.
- `isPaneDead(muxName)` at **src/tmux-manager.ts:620**: `execSync tmux display-message -p '#{pane_dead}'` at **:624–627**.
- ALL isPaneDead callers (each must become `await`):
  1. src/web/server.ts:2396 — inside async IIFE in checkAndRecoverDeadPanes ✓ easy
  2. src/web/server.ts:3535 — inside `private async restoreMuxSessions()` (:3287) ✓ easy
  3. src/session.ts:1065 — inside `async startInteractive()` (:1035) ✓ easy
  4. src/session.ts:1544 — inside `async startShell()` (:1513) ✓ easy
  5. Interface: src/mux-interface.ts:209 — change `isPaneDead(muxName: string): boolean` → `Promise<boolean>`
  6. Test mocks: test/server-dead-pane-recovery.test.ts:29/:238 and test/server-restore-mux-sessions.test.ts:27/:244 mock isPaneDead returning plain booleans — `await` of a plain boolean works, so behavior-wise these keep passing, but the `vi.fn<[string], boolean>` type annotations should be updated to satisfy tsc.

**Site 4 — Per-request screen snapshot, src/screen-analyzer.ts**
- `captureScreen(muxName)` at **:103**: `execFileSync('tmux', ['capture-pane', ...])` at **:106**, hardcoded timeout 5000.
- Sole caller: src/web/routes/active-session-routes.ts:71 in the async handler for `GET /api/sessions/:id/screen-snapshot` (:63) — make captureScreen async (promisified execFile), `await` at the call site. Import at active-session-routes.ts:13.

### Implementation spec

(a) **getSessionsWithStats internals** (tmux-manager.ts:1035): replace the two execSync calls (:1055, :1086) with `await execAsync(...)` (same commands, same parsing, same return shape `MuxSessionWithStats[]`). Signature already `async` — no interface change (mux-interface.ts:123 already `Promise<MuxSessionWithStats[]>`).

(b) **Fallback (:1128–1136)**: per agreed direction, remove the per-session fallback entirely OR keep it async + concurrency-limited. Recommended: on batch failure, log once and return sessions with `stats: undefined` (frontend already tolerates undefined stats — the non-fallback path returns `stats: undefined` for unmatched PIDs). If keeping a fallback, cap concurrency (e.g. 4) and rely on the now-async getProcessStats.

(c) **getProcessStats internals** (tmux-manager.ts:997): replace execSync at :1006 and :1015 with `await execAsync(...)`. Signature already async (mux-interface.ts:126). No other callers besides the fallback.

(d) **isPaneDead** (tmux-manager.ts:620): convert to `async isPaneDead(muxName): Promise<boolean>` using execAsync; update mux-interface.ts:209 and the 4 call sites + 2 test-mock type annotations listed above. Preserve semantics: IS_TEST_MODE → false; invalid name → false; error → false.

(e) **Mouse-mode sync** (tmux-manager.ts:1172): make listPanes async (`Promise<PaneInfo[]>` via execAsync); make enableMouseMode/disableMouseMode async (`Promise<boolean>`); update syncMouseMode to async; rewrite the startMouseModeSync interval callback as async and process sessions sequentially or with small concurrency (sequential is fine — non-blocking now). All contained within tmux-manager.ts (no external callers, not on interface).

(f) **captureScreen** (screen-analyzer.ts:103): convert to `async` via `promisify(execFile)`; await at active-session-routes.ts:71. Preserve null-on-failure contract.

(g) **In-flight guards (required)** — prevent tick stacking on all three timers:
- `startStatsCollection`: add `private statsTickInFlight = false`; at tick start, `if (this.statsTickInFlight) return;` set true, `finally` set false.
- `startMouseModeSync`: same pattern with its own flag (`mouseSyncInFlight`).
- `checkAndRecoverDeadPanes` (web/server.ts): make the method async-aware with a `private _deadPaneCheckInFlight = false` flag around the whole sweep (the per-session `_recoveringSessionIds` guard stays as-is). The `cleanup.setInterval` callback stays sync — call `void this.checkAndRecoverDeadPanes()`.

(h) **Timeouts (optional, per task)**: for the lightweight probes (isPaneDead, listPanes, mouse toggles) a shorter timeout (e.g. 2000ms) is reasonable now that they don't block; keep EXEC_TIMEOUT_MS for everything else. Low priority — non-blocking makes the 5s timeout mostly harmless.

### Explicitly OUT OF SCOPE (per task)
- One-shot lifecycle execSync calls: createSession (:486/:495/:511), killSession (:853), respawn env setup (:240/:287), sessionExists (:713), getPanePid (:598), reconcileSessions'/discoverSessions' `tmux list-sessions` (:936), capturePaneContent (:1523/:1533/:1544), pipe-pane (:1576/:1604), listAllTmuxSessions (:1627), sendInputToPane's execSync (:1478–1492), isTmuxAvailable (:1681). These are one-shot or rare paths; convert only if trivial.
- Frontend changes (duplicate GET /api/work-items etc.).

### Verification notes for QA
- tsc must pass (interface signature change ripples are enumerated above).
- Existing tests touching isPaneDead: test/server-dead-pane-recovery.test.ts, test/server-restore-mux-sessions.test.ts — should still pass with awaited boolean mocks; fix type annotations if tsc complains.
- Behavior invariants: `statsUpdated` event payload shape unchanged; GET /api/mux-sessions response shape unchanged; screen-snapshot response shape unchanged; dead-pane auto-recovery flow unchanged.

## Fix / Implementation Notes
<!-- filled by fix subagent -->

Implemented 2026-07-23 per spec items (a)–(g). Item (h) (shorter probe timeouts) NOT applied — kept EXEC_TIMEOUT_MS everywhere since non-blocking calls make the 5s timeout harmless (spec marked it low priority/optional).

**src/tmux-manager.ts**
- (a) `getSessionsWithStats()`: the batched pgrep loop and the single `ps` call now use `await execAsync(...)` (same commands, same parsing, same `MuxSessionWithStats[]` return shape).
- (b) Fallback removed: on batch failure, log once (`Batched stats collection failed, skipping this tick`) and return all sessions with `stats: undefined` (same shape the non-fallback path uses for unmatched PIDs). Eliminates the 2N-execSync death-spiral amplifier.
- (c) `getProcessStats()`: internal `ps` and `pgrep` converted to `await execAsync`. Still on the interface (`Promise<ProcessStats|null>`), signature unchanged.
- (d) `isPaneDead()` → `async ... Promise<boolean>` via execAsync. Semantics preserved: IS_TEST_MODE → false, invalid name → false, any error → false.
- (e) `listPanes()` → `Promise<PaneInfo[]>`, `enableMouseMode`/`disableMouseMode` → `Promise<boolean>`, `syncMouseMode` → async; `startMouseModeSync` interval callback rewritten async, sessions processed sequentially with awaits. The failure-retry semantics (don't update `lastPaneCount` when toggle fails) preserved. All contained in tmux-manager.ts (no external callers, confirmed by grep).
- (g) In-flight guards: new private fields `statsTickInFlight` and `mouseSyncInFlight`; both interval callbacks return early if the previous tick is still running, reset in `finally`.

**src/mux-interface.ts**
- `isPaneDead(muxName): boolean` → `Promise<boolean>` (:209).

**src/web/server.ts**
- `checkAndRecoverDeadPanes()` → async with new `_deadPaneCheckInFlight` whole-sweep guard; the sweep body extracted to `sweepDeadPanes()` so the flag is set/reset in a try/finally that covers the entire sweep (a throw anywhere cannot permanently stick the flag). `await this.mux.isPaneDead(muxName)` inside the per-session async IIFE; `await Promise.allSettled(recoveryTasks)` at the end. Per-session `_recoveringSessionIds` guard untouched. Timer callback now `void this.checkAndRecoverDeadPanes()`.
- `restoreMuxSessions()`: `if (!(await this.mux.isPaneDead(...)))` (was sync call).

**src/session.ts**
- Two `isPaneDead` call sites (startInteractive ~:1065, startShell ~:1544) → `await this._mux.isPaneDead(...)` (both already inside async methods).

**src/screen-analyzer.ts**
- `captureScreen()` → `async ... Promise<string | null>` via `promisify(execFile)`. Null-on-failure and mux-name-validation contracts preserved; still shell-free execFile.

**src/web/routes/active-session-routes.ts**
- `await captureScreen(...)` at the screen-snapshot handler (:71).

**Tests updated**
- test/screen-analyzer.test.ts: `await captureScreen(...)` in both tests; node:child_process mock factory extended with an `execFile` that invokes the node-style callback with an error (required — the hoisted mock previously only provided execSync, and `promisify(undefined)` would throw at module load).
- test/server-dead-pane-recovery.test.ts and test/server-restore-mux-sessions.test.ts: FakeMux `isPaneDead` mock made `async` so it fulfills the new Promise-returning interface; `isPaneDeadImpl` boolean control fns unchanged (all `.mockReturnValue(bool)` call sites keep working).
- test/routes/active-session-routes.test.ts needed no change: the route awaits the mocked sync return values (null / string), which awaits fine.

**Verification**
- `npx tsc --noEmit`: clean.
- `npx eslint` on all changed src files: clean. `prettier --check`: clean after `--write` on tmux-manager.ts.
- Vitest (brew Node v25): test/server-dead-pane-recovery.test.ts, test/screen-analyzer.test.ts, test/routes/active-session-routes.test.ts, test/routes/mux-routes.test.ts — all 45 pass. test/server-restore-mux-sessions.test.ts: 35/36 pass; the 1 failure ("skips a state.json session whose workingDir is already covered by a mux-recovered session") is PRE-EXISTING — verified by stashing all changes and re-running (fails identically on the unmodified tree).

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 1 — APPROVED

Reviewed diff against spec items (a)–(h). Verified by grep, full-diff read, `npx tsc --noEmit` (clean), `npx eslint` on all 6 changed src files (clean), and vitest runs.

**Spec conformance**
- (a) getSessionsWithStats: both execSync sites (pgrep loop, batched ps) now `await execAsync` with byte-identical command strings; parsing moved to `.trim()` on stdout — logic unchanged. Return shape `MuxSessionWithStats[]` preserved; empty-session early return preserved.
- (b) Fallback removed per the spec-recommended option: batch failure logs once (`Batched stats collection failed, skipping this tick`) and returns all sessions with `stats: undefined` — same shape consumers already tolerate for unmatched PIDs. Death-spiral amplifier eliminated. `statsUpdated` SSE payload and GET /api/mux-sessions shapes unchanged.
- (c) getProcessStats: ps + pgrep converted to execAsync; outer catch still returns null, inner pgrep catch still defaults childCount 0, IS_TEST_MODE stub unchanged. No remaining internal callers (fallback gone) but correctly kept — it's on the TerminalMultiplexer interface.
- (d) isPaneDead → `Promise<boolean>`; semantics preserved exactly (IS_TEST_MODE → false, invalid name → false, catch → false, `stdout.trim() === '1'`). Interface updated (mux-interface.ts:209). All 4 call sites awaited: server.ts:2411 (sweep IIFE), server.ts:3548 (restoreMuxSessions), session.ts:1065, session.ts:1544. Grep confirms no un-awaited call site remains (the always-truthy-Promise trap does not occur).
- (e) listPanes/enableMouseMode/disableMouseMode/syncMouseMode all async; startMouseModeSync callback async + sequential with awaits; failure-retry semantics (don't update lastPaneCount on failed toggle) preserved. Grep confirms no callers outside tmux-manager.ts.
- (f) captureScreen async via `promisify(execFile)` — still shell-free, mux-name regex guard and null-on-failure preserved; awaited at active-session-routes.ts:71 (sole caller, confirmed by grep).
- (g) All three in-flight guards present and correct: `statsTickInFlight` and `mouseSyncInFlight` reset in `finally`; `_deadPaneCheckInFlight` set/reset in a try/finally wrapper around the extracted `sweepDeadPanes()`, so no path can stick a flag true. Timer callback uses `void this.checkAndRecoverDeadPanes()`. `Promise.allSettled(recoveryTasks)` now properly awaited inside the guard.
- (h) Skipped — explicitly optional per spec; acceptable.

**Other checks**
- No execSync/execFileSync remains on any recurring-timer or converted hot-request path. All remaining execSync sites in tmux-manager.ts match the spec's out-of-scope list (createSession, killSession, setenv, sendInputToPane, capture with scrollback, pipe-pane, etc.); execSync imports in tmux-manager.ts and web/server.ts (startup cert generation) are still needed. execFileSync import removed from screen-analyzer.ts.
- exec vs execSync semantics: execAsync rejects on non-zero exit and on timeout — every converted site wraps in try/catch mirroring the old behavior; default maxBuffer (1 MB) and utf8 stdout match execSync defaults; commands using `|| true` / `|| echo` / `2>/dev/null` behave identically under exec's /bin/sh.
- House style matches sendInput's existing execAsync pattern.
- Tests: screen-analyzer (19), server-dead-pane-recovery, active-session-routes (9), mux-routes (7) — 45/45 pass. server-restore-mux-sessions: 35/36; the 1 failure independently re-verified as PRE-EXISTING by this reviewer (stashed src/+test/ changes, re-ran on unmodified tree: fails identically; stash popped, tree restored). Mock updates (async isPaneDead fns, execFile mock factory for promisify-at-module-load) are correct and minimal.

No issues found. Ready for test gap analysis.

## Test Gap Analysis

**Verdict: GAPS FOUND** (2026-07-23)

Changed source files: src/mux-interface.ts, src/screen-analyzer.ts, src/session.ts, src/tmux-manager.ts, src/web/routes/active-session-routes.ts, src/web/server.ts (+3 test files already updated by the fix).

Key testability constraint discovered: `IS_TEST_MODE = !!process.env.VITEST` (tmux-manager.ts:94) short-circuits `getSessionsWithStats` (:1040 stub), `getProcessStats` (:1001), `isPaneDead` (:625), `listPanes` (:1448), and the mouse-sync tick (`if (IS_TEST_MODE) return;` at :1193, BEFORE the in-flight guard). The converted execAsync internals are therefore unreachable under vitest unless a test bypasses it via `vi.stubEnv('VITEST', '')` + `vi.resetModules()` + dynamic import + a `node:child_process` mock providing `exec` (the existing tmux-manager.test.ts mock only provides `execSync`/`spawn`).

### Gaps (ordered by priority)

1. **src/web/server.ts — `_deadPaneCheckInFlight` sweep guard untested.** test/server-dead-pane-recovery.test.ts has a complete harness (FakeMux, direct `checkAndRecoverDeadPanes()` calls) but no test for the new guard. Needed: (a) while a sweep is in flight (isPaneDeadImpl returns a pending promise), a second `checkAndRecoverDeadPanes()` call returns without probing (isPaneDead call count unchanged); (b) after the first sweep resolves, a subsequent call runs again (proves the `finally` reset — a stuck flag would silently disable auto-recovery forever).

2. **src/tmux-manager.ts — `statsTickInFlight` guard untested.** Testable WITHOUT the env bypass: use fake timers, replace `manager.getSessionsWithStats` on the instance with a controllable pending promise (the guard check runs before the method is invoked). Assert: overlapping tick skipped (getSessionsWithStats called once across two intervals while pending); after resolution the next tick runs and `statsUpdated` is emitted; a rejecting tick still resets the flag (finally path).

3. **src/tmux-manager.ts — batch-failure → `stats: undefined` path untested.** This is the fallback-removal behavior change (the core of the fix) and currently has zero coverage. Requires the IS_TEST_MODE bypass described above: stubEnv + resetModules + dynamic import of TmuxManager with a child_process mock whose `exec` errors for the pgrep/ps batch. Assert: all registered sessions returned with `stats: undefined`, and no per-session fallback probes occur (exec called for the batch only, not 2N times). Same bypass suite can cheaply also cover: happy-path ps parsing → populated stats, and async `isPaneDead` semantics (stdout '1' → true, exec error → false).

4. **(minor) test/screen-analyzer.test.ts — captureScreen success path untested.** Only invalid-name→null and execFile-failure→null are covered; the changed success path (`{ stdout }` extraction from promisified execFile) has no test. Cheap: execFile mock calling back `(null, { stdout })`-style — note promisify callback shape is `(err, stdout, stderr)` args → resolves to `{ stdout, stderr }`; assert returned string equals stdout.

### Explicitly NOT gaps (proportionality)

- **`mouseSyncInFlight` guard**: unreachable under vitest — `if (IS_TEST_MODE) return;` precedes the guard in the interval callback, and bypassing requires the full env-bypass + exec-mock machinery for listPanes/set-option. Identical pattern to the statsTickInFlight guard (gap 2 proves the pattern). Optional; skip unless trivial once the bypass suite from gap 3 exists.
- **src/mux-interface.ts** — type-only signature change; tsc covers it.
- **src/session.ts** — two `await` insertions inside already-async methods; behavior covered by existing session/server tests.
- **src/web/routes/active-session-routes.ts** — one `await`; test/routes/active-session-routes.test.ts passes unchanged (9 tests) and covers null/string responses.
- **execAsync command-string fidelity in getSessionsWithStats/getProcessStats/mouse toggles** — byte-identical commands verified by review attempt 1; unit-testing exact shell strings would be change-detector testing.
- Pre-existing failure in test/server-restore-mux-sessions.test.ts ("skips a state.json session whose workingDir is already covered...") — verified pre-existing on unmodified tree; not a gap of this task.

### Re-check (2026-07-23, after approved test round)

**Verdict: NO GAPS.**

Re-walked the full `git diff HEAD -- src/` against the 10 approved tests and re-ran the four touched suites (64/64 pass: server-dead-pane-recovery 12, tmux-manager-exec-async 4, tmux-manager 28, screen-analyzer 20).

Per-file coverage confirmation:
- **src/tmux-manager.ts** — statsTickInFlight guard (3 tests: skip/resume+emit/reject-reset), batch-failure → `stats: undefined` with no per-session fallback (the core death-spiral removal, exec called exactly once), happy-path pgrep/ps aggregation, and async isPaneDead true/false semantics all covered. `enableMouseMode`/`disableMouseMode`/`syncMouseMode`/`listPanes`/`getProcessStats` sync→async conversions are byte-identical commands behind IS_TEST_MODE stubs — correctly ruled out on proportionality in the original analysis; nothing new found. Noted (non-gap, informational): `getProcessStats` has no remaining internal callers after the fallback removal — it survives only as a TerminalMultiplexer interface method; tsc covers its signature.
- **src/web/server.ts** — `_deadPaneCheckInFlight` guard (skip + finally-reset tests), `sweepDeadPanes` extraction and `await Promise.allSettled` covered by the 10 pre-existing recovery tests plus the 2 new ones; the restore-time `await isPaneDead` (line ~3548) exercised by server-restore-mux-sessions.test.ts with its FakeMux correctly async-ified. `void checkAndRecoverDeadPanes()` interval wiring is trivial glue.
- **src/screen-analyzer.ts** — captureScreen now has all three paths: invalid name → null, execFile failure → null, success → exact stdout passthrough (which also pins the promisify `{stdout}` destructure).
- **src/mux-interface.ts / src/session.ts / src/web/routes/active-session-routes.ts** — unchanged verdicts from original analysis (type-only / await insertions inside existing async flows / covered by passing route tests); verified no callers of the newly-async methods were missed anywhere in src (grep confirmed only awaited call sites remain; TmuxManager is the sole TerminalMultiplexer implementer).
- **mouseSyncInFlight** — remains not-a-gap: `if (IS_TEST_MODE) return;` precedes the guard, the pattern is identical to the statsTickInFlight guard which is proven by 3 tests, and the original analysis explicitly deemed it optional. Testing it would require extending the bypass suite with fake timers + listPanes/set-option exec choreography for no new behavioral proof.

Status moved to `qa`.

## Test Writing Notes
<!-- filled by test writing subagent -->

Written 2026-07-23. All four gaps from Test Gap Analysis filled; no source files modified.

**test/server-dead-pane-recovery.test.ts** (modified — gap 1)
- Widened `isPaneDeadImpl` hoisted mock type to `vi.fn<[string], boolean | Promise<boolean>>()` so tests can hold a sweep open on a pending probe (FakeMux's async `isPaneDead` awaits the impl's return value, so existing `.mockReturnValue(bool)` call sites are unaffected).
- New `describe('sweep in-flight guard (_deadPaneCheckInFlight)')`:
  - "skips a sweep started while a previous sweep is still in flight" — first `checkAndRecoverDeadPanes()` blocks on a pending isPaneDead promise; a second call resolves immediately without probing (isPaneDeadImpl count stays 1); probe then resolved and first sweep awaited.
  - "resets the in-flight flag after a sweep completes so the next sweep probes again" — two sequential awaited sweeps both probe (count 2), proving the `finally` reset (a stuck flag would silently disable auto-recovery).

**test/tmux-manager.test.ts** (modified — gap 2)
- New nested `describe('statsTickInFlight guard')` inside 'stats collection', using `vi.useFakeTimers()` + `vi.spyOn(manager, 'getSessionsWithStats')` with a controllable promise (guard check runs before the method call, so no IS_TEST_MODE bypass needed):
  - "skips overlapping ticks while a previous tick is still awaiting getSessionsWithStats" — 3 interval firings while pending → method called once.
  - "resumes ticking and emits statsUpdated after the pending tick resolves" — resolution → `statsUpdated` emitted once; next interval calls the method again (flag reset).
  - "resets the in-flight flag when getSessionsWithStats rejects" — rejection on tick 1 still allows tick 2 to run (finally path).

**test/tmux-manager-exec-async.test.ts** (NEW — gap 3, IS_TEST_MODE bypass suite)
- Bypasses `IS_TEST_MODE` via `vi.stubEnv('VITEST', '')` + `vi.resetModules()` + dynamic import per test; node:child_process fully mocked (exec/execSync/spawn) and node:fs + node:fs/promises mocked so no real tmux/files are touched despite the bypass.
- Key mock detail: the `exec` mock carries `Symbol.for('nodejs.util.promisify.custom')` returning `Promise<{ stdout, stderr }>` — a plain callback-style vi.fn would make `promisify(exec)` resolve to the bare stdout string (promisify only forwards the first callback value), breaking `const { stdout } = await execAsync(...)`. (TASK gap note said a plain callback mock works — it does not for the success paths; documented here for the reviewer.)
- Tests:
  - "returns all sessions with stats undefined, logs once, and makes no per-session fallback probes" — batch pgrep throws → both sessions returned with `stats: undefined`, exec called exactly once (the batch), console.error exactly once ("Batched stats collection failed"). Covers the fallback-removal core of the fix.
  - "aggregates batched pgrep/ps output into per-session stats" — happy path: pgrep child map + ps rss/pcpu lines → correct memoryMB/cpuPercent/childCount aggregation including a child process.
  - "resolves true when tmux reports pane_dead=1" and "resolves false when the tmux probe fails" — async isPaneDead semantics.

**test/screen-analyzer.test.ts** (modified — gap 4)
- Restructured the file's node:child_process mock into a top-level `vi.hoisted` controllable `execFileImpl` (default: throws) with the same `promisify.custom` symbol pattern so promisified execFile resolves `{ stdout, stderr }` like real node. Existing invalid-name and failure tests preserved (now via static import; the old in-test `vi.mock` was file-hoisted anyway, so semantics are unchanged).
- New test: "returns the captured pane text when execFile succeeds" — `execFileImpl.mockReturnValueOnce({ stdout })` → captureScreen returns the exact string; also asserts execFile was invoked with `tmux capture-pane -t <muxName>`.

**Run results** (brew Node v25, `PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npx vitest run`):
- test/tmux-manager.test.ts: 28/28 pass (25 existing + 3 new)
- test/tmux-manager-exec-async.test.ts: 4/4 pass (new file)
- test/server-dead-pane-recovery.test.ts: 12/12 pass (10 existing + 2 new)
- test/screen-analyzer.test.ts: 20/20 pass (19 existing + 1 new; failure test simplified, count unchanged +1)
- test/server-restore-mux-sessions.test.ts (untouched, run for regression): 35/36 — the 1 failure is the documented PRE-EXISTING one ("skips a state.json session whose workingDir is already covered..."), unaffected by these changes.
- prettier --write applied to test/tmux-manager.test.ts and test/tmux-manager-exec-async.test.ts; all four touched files pass `prettier --check`.
- Note: tsconfig.json only includes `src/**/*`, so test files are not tsc-checked; test typings kept clean regardless.

No implementation bugs found — all new tests pass against the implemented fix.

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

### Test review attempt 1 — APPROVED

Reviewed all 10 new tests in the 4 touched files against the 4 gaps from Test Gap Analysis. Read the source under review (tmux-manager.ts:1039-1176 getSessionsWithStats/startStatsCollection, :624-635 isPaneDead; server.ts:2377-2453 checkAndRecoverDeadPanes/sweepDeadPanes; screen-analyzer.ts:106-117 captureScreen) and mentally ran each test against a version of the code WITHOUT the fix. Ran the suite: 64/64 pass (server-dead-pane-recovery 12, tmux-manager 28, tmux-manager-exec-async 4, screen-analyzer 20).

**Gap 1 — sweep guard (server-dead-pane-recovery.test.ts): covered, correct.**
- Skip test: holds sweep 1 open on a pending isPaneDead promise, asserts probe count stays 1 across a second `checkAndRecoverDeadPanes()` call. Without the guard, the second call's IIFE synchronously invokes isPaneDeadImpl (count→2) and the awaited call then hangs on the shared pending probe — the test fails either by assertion or timeout. The "synchronously reached the pending probe" assumption is valid: the sweep body and per-session IIFEs execute synchronously up to the first `await`.
- Reset test: two sequential awaited sweeps both probe (count 2) — fails against a stuck-flag mutant. Both proofs are real behavior, not smoke.
- FakeMux `isPaneDead` made async with `boolean | Promise<boolean>` impl widening — existing `.mockReturnValue(bool)` sites unaffected; matches the interface change. Same async-ification correctly mirrored in server-restore-mux-sessions.test.ts.

**Gap 2 — statsTickInFlight (tmux-manager.test.ts): covered, correct.**
- The interval callback has no IS_TEST_MODE early return before the guard (verified :1153-1170), so the instance-method spy approach is sound.
- Skip test: 3 interval firings while pending → spy called once (would be 3 without the guard). Resume test: proves `statsUpdated` emitted once on resolution AND the next tick runs (finally reset). Rejection test: tick 2 runs after tick 1 rejects — proves the finally path specifically. All three fail against the corresponding no-guard / no-reset mutants.

**Gap 3 — exec-async bypass suite (tmux-manager-exec-async.test.ts, NEW): covered, correct, realistic.**
- IS_TEST_MODE bypass (`vi.stubEnv('VITEST','')` + resetModules + dynamic import) verified against `IS_TEST_MODE = !!process.env.VITEST` (:94); child_process, fs, fs/promises fully mocked so no real tmux/file IO despite the bypass — safety comment is accurate.
- The `promisify.custom` symbol on the exec mock is the right call: `promisify(exec)` at module load (:28) picks it up and resolves `{stdout, stderr}` exactly like real node — a plain callback mock would break `const { stdout } = await execAsync(...)`. The Test Writing Notes correction of the gap-analysis claim is right.
- Batch-failure test is the core-of-the-fix test: exec called exactly once (the pgrep batch), console.error exactly once, all sessions `stats: undefined`. Against the OLD fallback code this fails hard (2 extra probes per session → count 5). This is the death-spiral-removal proof.
- Happy path: pgrep fixture `'100:300,\n200:\n'` matches the real `echo "$p:$children"` + `tr '\n' ','` trailing-comma format; ps fixture matches `ps -o pid=,rss=,pcpu=` columns. Expected aggregation values (3 MB/7.5%/1 child; 0.5 MB/1%/0) independently recomputed against the rounding math at :1128-1133 — correct.
- isPaneDead: `'1\n'`→true exercises the `.trim() === '1'` logic; error→false exercises the catch. Both are real-shape inputs.

**Gap 4 — captureScreen success path (screen-analyzer.test.ts): covered, correct.**
- Success test asserts exact stdout passthrough and that execFile was invoked with `tmux capture-pane ... -t <muxName>` — fails against a promisify-shape regression (bare-string resolution → destructured `stdout` undefined). Mock restructure to a hoisted controllable `execFileImpl` preserves the two pre-existing tests' semantics (the old in-test `vi.mock` was file-hoisted anyway) and adds a `not.toHaveBeenCalled()` assertion to the injection-guard test — a strict improvement.

**Style**: matches house patterns (vi.hoisted mock blocks, fileoverview headers with SAFETY/Port notes, nested describes, prettier-clean). Proportionality respected — the "Explicitly NOT gaps" items (mouseSyncInFlight, type-only changes, await insertions) were correctly left alone.

**Minor, non-blocking observations** (no action required):
- The sweep skip test leaves `resolveProbe(false); await firstSweep` cleanup at the end — correct hygiene, noted approvingly.
- MaxListenersExceededWarning noise in server-dead-pane-recovery runs is pre-existing harness behavior (FakeMux accumulating listeners across 12 tests), not introduced by the new tests.

No issues found. All four gaps are genuinely covered with tests that fail without the fix. Status moved to test-analysis.

## QA Results
QA run 2026-07-23 — ALL CHECKS PASS.

### Static checks
- `npx tsc --noEmit`: PASS (0 errors).
- `npm run lint`: PASS (0 errors; 2 pre-existing warnings for unused eslint-disable directives in src/vault/search.ts and src/web/routes/session-routes.ts — files untouched by this task).

### Tests (brew Node v25 on PATH)
`npx vitest run test/tmux-manager.test.ts test/tmux-manager-exec-async.test.ts test/server-dead-pane-recovery.test.ts test/screen-analyzer.test.ts test/server-restore-mux-sessions.test.ts`
- Result: 99 passed / 1 failed of 100.
- test/tmux-manager.test.ts: 28/28 PASS
- test/tmux-manager-exec-async.test.ts: 4/4 PASS
- test/server-dead-pane-recovery.test.ts: 12/12 PASS
- test/screen-analyzer.test.ts: 20/20 PASS
- test/server-restore-mux-sessions.test.ts: 1 failure — "skips a state.json session whose workingDir is already covered by a mux-recovered session" — the documented pre-existing failure (verified on unmodified tree via stash); NOT a QA failure. All other tests in the file pass.

### Targeted backend check (QA port 45653; production 3001 untouched)
Dev server started with `npx tsx src/index.ts web --port 45653` (brew Node v25 on PATH required — system Node v22 hits better-sqlite3 NODE_MODULE_VERSION mismatch and the server aborts; same ABI gotcha as vitest). Server restored the full set of real mux sessions, giving realistic load for the latency test.
- `GET /api/status`: valid JSON, 0.002–0.003s. PASS.
- `GET /api/status` latency x3 sequential: 0.0029s / 0.0031s / 0.0024s — well under 1s. PASS.
- `GET /api/mux-sessions`: valid JSON array with sessions incl. per-session stats, no error; 1.64s total (endpoint awaits many tmux probes — non-blocking, see next line). PASS.
- Event-loop starvation probe: 3x `GET /api/status` fired WHILE `/api/mux-sessions` (1.69s) was in flight → 0.0036s / 0.0025s / 0.0019s. The slow tmux work no longer blocks the event loop — this is the core fix, verified. PASS.
- 4 concurrent `GET /api/status`: 0.0038s / 0.0021s / 0.0033s / 0.0062s — no starvation. PASS.
- Server log: no errors, no unhandledRejection noise (only benign "Rejected token count" session-parse messages, pre-existing). PASS.
- Server killed after checks; confirmed stopped via curl.

### Docs Staleness
- API docs may need update (src/web/routes/ changed: src/web/routes/active-session-routes.ts)

## Decisions & Context
- 2026-07-23: Root cause pre-investigated in parent session with Opus tracers; frontend confirmed O(1) in session count (only active session buffer fetched at boot). Frontend cleanups (duplicate GET /api/work-items in handleInit) are OUT OF SCOPE for this fix.
- 2026-07-23 (fix): Chose the spec-recommended option for (b): removed the per-session fallback entirely rather than making it concurrency-limited. Rationale: the fallback only fires when the batched path fails (system already overloaded), and returning `stats: undefined` for one 2s tick is invisible in the UI while 44 extra process spawns are exactly the death spiral being fixed. `getProcessStats` kept (it is on the TerminalMultiplexer interface) and converted to async internals anyway.
- 2026-07-23 (fix): `checkAndRecoverDeadPanes` split into guard wrapper + `sweepDeadPanes()` so the `_deadPaneCheckInFlight` flag reset lives in a `finally` covering the whole sweep — a stuck flag would silently disable auto-recovery forever. Note: while a slow recovery is in flight, whole sweeps are skipped (per spec item g); the 30s interval retries.
- 2026-07-23 (fix): Item (h) (shorter probe timeouts) intentionally skipped — optional per spec, and non-blocking probes make the 5s timeout mostly harmless; keeping EXEC_TIMEOUT_MS avoids introducing a second timeout constant.
- 2026-07-23 (fix): test/screen-analyzer.test.ts's hoisted node:child_process mock had to gain an `execFile` entry (callback-erroring) because `promisify(execFile)` runs at screen-analyzer module load; with the old execSync-only mock both captureScreen tests would crash on import.
- 2026-07-23 (fix): Pre-existing test failure documented: test/server-restore-mux-sessions.test.ts "skips a state.json session whose workingDir is already covered by a mux-recovered session" fails on the unmodified tree too (verified via git stash) — unrelated to this change, left for QA to triage.

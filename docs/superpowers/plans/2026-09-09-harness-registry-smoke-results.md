# Harness registry — manual smoke test results (Task 8)

Date: 2026-09-09
Branch: `feat/harness-registry` @ `c245c1d0` (Tasks 1–7 complete)
Runner: dev server from source, `npx tsx src/index.ts web --port 3417`

## Test environment

The host already runs the production Codeman on port 3001 against `~/.codeman/state.json`
and a live tmux server with ~36 real `codeman-*` sessions. `StateStore` has no data-dir
override and `TmuxManager` has no socket override, so a naive dev server **adopts the
user's live sessions** — the first attempt did exactly that:

```
$ curl -s http://localhost:3417/api/status
{"version":"0.6.6","sessions":[{"id":"restored-05d82243", ... "name":"Restored: codeman-05d82243" ...
```

It was killed immediately and the run was redone under isolation:

* `HOME` → a scratch dir whose entries are symlinks to the real `$HOME` **except**
  `.codeman`, which is a fresh empty directory (isolates state.json / mux-sessions.json
  while keeping real `.codex`, `.claude`, `.npm-global`, `.local`, `.bun` auth+binaries).
* `TMUX_TMPDIR=/tmp/cmsmoke` **and `-u TMUX`** → a private tmux server.
  (`TMUX_TMPDIR` alone is ignored when `$TMUX` is set; a long `TMUX_TMPDIR` also fails
  with `error connecting to … (File name too long)`, hence the short path.)

Launch command actually used:

```
env -u TMUX HOME=$SCRATCH/home TMUX_TMPDIR=/tmp/cmsmoke \
  nohup npx tsx src/index.ts web --port 3417 > /tmp/codeman-3417.log 2>&1 &
```

`vendor/` did not need copying — this worktree serves `src/web/public/vendor/`
(7 files) directly when run under tsx.

Fresh start was clean: `version 0.6.6 sessions 0`.

---

## Results table

| # | Check | Result |
|---|---|---|
| 1 | `GET /api/harnesses` lists all five with correct caps | PASS |
| 2 | `GET /api/harness/:id/status`, unknown → 404, `/api/opencode/status` alias | PASS |
| 3 | Codex session spawns, TUI renders (non-blank `capture-pane`) | PASS |
| 4 | Codex input reaches the agent | PASS |
| 5 | Codex buffer survives a page reload (`--no-alt-screen`) | PASS |
| 6 | Codex `harnessSessionId` discovered within 15 s | **FAIL** (see Defect 1) |
| 7 | `codex resume <id>` actually restores the conversation | PASS (verified manually) |
| 8 | Pi found via harness `searchDirs` (not on `sh` PATH) | PASS |
| 9 | Pi session spawns, renders, accepts input | PASS |
| 10 | Server restart — all six sessions reattach with buffers intact | PASS |
| 11 | Input still reaches every harness after the restart | PASS |
| 12 | Claude regression: spawn, prompt, transcript id, restore | PASS |
| 13 | OpenCode regression: spawn + restore | PASS |
| 14 | Shell regression: spawn, command echo, restore | PASS |
| 15 | Pause offered only for claude (shell/opencode/codex/pi refused) | PASS |
| 16 | Ralph + respawn offered only for claude | PASS (behaviour) / **FAIL** (error copy — Defect 2) |
| 17 | Frontend registry wiring, no console errors | PASS |
| 18 | Pi `harnessSessionId` persisted for the state.json restore path | **FAIL** (see Defect 3) |

---

## Check details

### 1. `GET /api/harnesses`

```
$ curl -s http://localhost:3417/api/harnesses
claude    label "Claude Code" short cc  ralph:true  respawn:true  claudeTranscript:true  claudeParsers:true
          requiresMux:false preassignsSessionId:true pausable:true claudeHooks:true usesClaudeModelDefaults:true
shell     label "Shell"      short sh   all nine caps false
opencode  label "OpenCode"   short oc   requiresMux:true, all other caps false
codex     label "Codex"      short cx   requiresMux:true, all other caps false
pi        label "Pi"         short pi   requiresMux:true, preassignsSessionId:true, all other caps false
```

All five `available: true`. **PASS**

### 2. `GET /api/harness/:id/status`

```
claude    {"available":true,"path":"/home/siggi/.local/bin"}
shell     {"available":true,"path":null}
opencode  {"available":true,"path":".../home/.bun/bin"}
codex     {"available":true,"path":"/home/siggi/.local/bin"}
pi        {"available":true,"path":".../home/.npm-global/bin"}
bogus     {"success":false,"error":"Unknown harness: bogus","errorCode":"NOT_FOUND"}
alias /api/opencode/status  {"available":true,"path":".../home/.bun/bin"}
```

**PASS**

### 3–5. Codex session

```
$ curl -s -X POST http://localhost:3417/api/sessions -d '{"workingDir":".../wd-codex","mode":"codex","name":"smoke-codex"}'
{"success":true,"session":{"id":"3c0cf9b8-b5ee-4143-9808-0a77ebf1b4a7", ... "mode":"codex" ...}}
$ curl -s -X POST http://localhost:3417/api/sessions/3c0cf9b8-.../interactive -d '{}'
{"success":true}
```

Log line: `[Session] Starting interactive Codex session (with tmux)`

`tmux capture-pane` is **not blank** — the `--no-alt-screen` flag does its job. Codex 0.144.5
opens with two first-run prompts (update notice, directory-trust), both answered through the
app's own input route, then the TUI paints:

```
╭──────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.144.5)                               │
│ model:       gpt-5.6-terra medium   /model to change     │
│ directory:   /tmp/claude-1000/…try/…/scratchpad/wd-codex │
│ permissions: YOLO mode                                   │
╰──────────────────────────────────────────────────────────╯
```

Input reaching the agent:

```
$ curl -s -X POST .../input -d '{"input":"say hi in one word","submit":true}'
› say hi in one word
• Hi
```

Note: `{"useMux":true}` alone typed the text into the composer but did **not** submit it;
`{"submit":true}` (which appends `\r`) did. Single-keystroke menu answers ("1"/"2") worked
with `useMux:true`.

Page-reload buffer (`GET /api/sessions/:id/terminal`, what the client refetches on load):
48 779 bytes of live TUI content. **PASS**

### 6. Codex `harnessSessionId` discovery — **FAIL**

```
$ curl -s http://localhost:3417/api/sessions/3c0cf9b8-... | jq .harnessSessionId
None
$ grep codex /tmp/codeman-3417.log
[Session] Starting interactive Codex session (with tmux)
[Session] codex session id not discovered for 3c0cf9b8-b5ee-4143-9808-0a77ebf1b4a7; not resumable
```

Reproduced deliberately with a second session in the (now trusted) same directory, so no
first-run prompts were in the way:

```
12:36:08  POST /api/sessions/79b8d221-.../interactive   -> {"success":true}
12:36:28  harnessSessionId= None
          newest rollout: rollout-2026-09-09T12-34-30-01a08629-….jsonl   (the PREVIOUS session)
```

Root cause, measured on the file system:

```
$ stat -c '%w' ~/.codex/sessions/2026/09/09/rollout-2026-09-09T12-34-30-01a08629-….jsonl
2026-09-09 12:35:40.186091643 +0000        <- file BIRTH
```

The session started at 12:34:09 and the filename encodes 12:34:30, but the file is not
created until **the first user turn is submitted** (12:35:40). The same was confirmed for
session 2: no rollout file after the TUI was fully painted and idle; a new
`rollout-2026-09-09T12-36-38-01a0862b-….jsonl` appeared only after a prompt was sent.

`discoverCodexSessionId()` polls for 15 s from spawn, so for an interactive codex TUI it can
never see the file. Every fresh codex session ends up with `harnessSessionId: null`, and the
state.json restore gate (`wasRunning && !savedState.paused && session.harnessSessionId`)
therefore never resumes a codex session when its tmux pane is gone.

Sub-check that *does* pass: the discovery predicate itself is correct. The rollout's first
line matches what the implementation looks for —

```
{"timestamp":"2026-09-09T12:34:30…","type":"session_meta","payload":{"session_id":"01a08629-a013-75c2-9516-c8a56cbbf140",
 "cwd":"/tmp/…/scratchpad/wd-codex","originator":"codex-tui", …}}
```

so the discovery would work if it were still watching. This is a **timing/lifetime** defect,
not a matching defect.

### 7. `codex resume <id>` — PASS

Command generation (`getHarness('codex').buildCommand(...)`):

```
codex fresh  : codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen
codex resume : codex resume '01a08629-a013-75c2-9516-c8a56cbbf140' --dangerously-bypass-approvals-and-sandbox --no-alt-screen
pi fresh     : pi --approve --session-id 's1'
```

That exact resume command was run in the isolated tmux and restored the conversation:

```
› say hi in one word
• Hi
› reply with the word alpha
• alpha
```

So the resume mechanism is sound — only the id discovery is broken.

### 8–9. Pi session

`sh -c 'which pi'` exits 1 on this host; `pi` lives at `~/.npm-global/bin/pi`.
The registry resolved it through `searchDirs`:

```
$ curl -s http://localhost:3417/api/harness/pi/status
{"available":true,"path":"/…/home/.npm-global/bin"}
```

Spawn + render + a full round trip:

```
[Session] Starting interactive Pi session (with tmux)
 reply with just the word ok
 ok
↑16k ↓3 $0.002 1.6%/1.0M (auto)      (nebius-token-factory) zai-org/GLM-5.3-Flash • low
```

**PASS** — this is the check that specifically exercises the `searchDirs` fallback.

### 10–11. Server restart

State before restart (`/api/status` + `tmux ls` on the private socket):

```
3c0cf9b8 codex    smoke-codex     idle  pid=1125909  hsid=None
79b8d221 codex    smoke-codex2    idle  pid=1142219  hsid=None
a83a0b94 pi       smoke-pi        busy  pid=1150546  hsid=None
ceba73bb claude   smoke-claude    idle  pid=1156204  hsid=ceba73bb-08bf-4e03-9334-c0524e158705
64e6dd74 opencode smoke-opencode  idle  pid=1156280  hsid=None
4b232fc2 shell    smoke-shell     idle  pid=1156369  hsid=None
```

`pkill -f "tsx src/index.ts web --port 3417"` → `SIGTERM received, shutting down gracefully…`;
all six tmux sessions survived. After relaunching the same command:

```
[Server] Restored session 3c0cf9b8-… from mux codeman-3c0cf9b8
[Server] Restored session 79b8d221-… from mux codeman-79b8d221
[Server] Restored session a83a0b94-… from mux codeman-a83a0b94
[Server] Restored tokens for session ceba73bb-…: 2 tokens, $0.0000
[Server] Restored respawn controller for session ceba73bb-… from state.json (will start in 120s)
[Server] Restored session ceba73bb-… from mux codeman-ceba73bb
[Server] Restored session 64e6dd74-… from mux codeman-64e6dd74
[Server] Restored session 4b232fc2-… from mux codeman-4b232fc2
count 6   (all six, correct modes, names and harnessSessionId preserved)
```

Every pane still held its pre-restart content (codex `• Hi`, pi's transcript, claude's prompt
line, opencode's composer, the shell prompt). Post-restart input round trips:

```
codex   › reply with the word alpha   • alpha
pi        reply with the word beta      beta
claude  ✻ Sautéed for 2s · done 12:40 PM
shell   $ echo delta-ok / delta-ok
```

**PASS.** Note this exercises the `restoreMuxSessions()` reattach path (tmux survived), which
is mode-independent; the `harnessSessionId`-gated state.json path is only reached when the
mux is gone, and that is where Defects 1 and 3 bite.

### 12–14. Regression pass

* **claude** — spawned, trust prompt answered, `reply with just the word ok` → `● ok`.
  `harnessSessionId` was populated (`ceba73bb-08bf-4e03-9334-c0524e158705`, i.e. the mirror
  of `claudeResumeId` written by the `conversationId` listener), so the flagged
  "Claude restore breaks" risk did **not** materialise. It appears a few tens of seconds after
  the first turn, not at spawn — the same as on master; the restore gate on master was
  `session.claudeResumeId && session.mode !== 'opencode'`, which is equivalent for claude.
  Ralph config and `respawn/start` both accepted (`{"success":true}`, controller
  `state: "watching"`), then stopped again.
* **opencode** — spawned into its TUI ("Ask anything…", `Build  Claude Sonnet 4.6 Anthropic`),
  restored after restart.
* **shell** — plain `bash` prompt, `echo delta-ok` → `delta-ok`, restored after restart.

**PASS**

### 15. Pause is claude-only

```
shell     {"success":false,"error":"Shell sessions cannot be paused","errorCode":"OPERATION_FAILED"}
codex     {"success":false,"error":"Codex sessions cannot be paused","errorCode":"OPERATION_FAILED"}
pi        {"success":false,"error":"Pi sessions cannot be paused","errorCode":"OPERATION_FAILED"}
opencode  {"success":false,"error":"OpenCode sessions cannot be paused","errorCode":"OPERATION_FAILED"}
claude    {"success":false,"error":"No resumable conversation ID yet — pausing would lose the conversation"}
```

The claude refusal is the pre-existing `transcriptPreflight` (no resume id yet at that
moment), not a capability refusal. Labels come from the registry. **PASS**

### 16. Ralph / respawn are claude-only

```
shell     ralph-config:   {"success":false,"error":"Ralph tracker is not supported for opencode sessions"}
shell     respawn/start:  {"success":false,"error":"Respawn is not supported for opencode sessions"}
opencode  (same two)
pi        (same two)
codex     (same two)
claude    ralph-config:   {"success":true}
claude    respawn/start:  {"success":true,"status":{"state":"watching",…}}
```

Gating behaviour is **correct**. The message text is wrong for every non-opencode harness —
see Defect 2.

### 17. Frontend

Headless Chromium against the dev server (`http://localhost:3417`):

```
app._harnesses keys : ["claude","shell","opencode","codex","pi"]
harnessMeta caps    : claude pausable/ralph/respawn = true,true,true
                      shell/opencode/codex/pi       = false,false,false
run-mode menu       : ["claude","opencode","codex","pi"]
welcome buttons     : ["Run Claude Code","Cloudflare Tunnel","Run OpenCode","Run Codex","Run Pi"]
sessions loaded     : smoke-codex(codex), smoke-codex2(codex), smoke-pi(pi),
                      smoke-claude(claude), smoke-opencode(opencode), smoke-shell(shell)
CONSOLE ERRORS      : []
```

`npx vitest run test/harness-ui.test.ts` (system Node v24 — brew Node v25 hits the
better-sqlite3 `NODE_MODULE_VERSION` mismatch on this file): **12 passed**. **PASS**

### 18. Pi identity is never persisted — **FAIL** (minor)

`piHarness` has `preassignsSessionId: true` and spawns `pi --approve --session-id <sessionId>`,
but nothing writes that id into `session.harnessSessionId`; the field stayed `None` for the
whole run and across the restart. Consequence is the same as Defect 1: a running pi session
whose tmux pane is gone will not be auto-restarted by the state.json restore gate, even
though relaunching it with the same `--session-id` is exactly what would restore it.

---

## Defects found

**Defect 1 (functional, codex) — codex `harnessSessionId` is never discovered.**
`discoverCodexSessionId()` polls for 15 s after spawn, but codex 0.144.5's TUI creates
`~/.codex/sessions/**/rollout-*.jsonl` only when the first user turn is submitted (measured
file birth 91 s after spawn in one case, and absent entirely after 20 s of an idle TUI in a
pre-trusted directory). Result: `harnessSessionId` stays null, `codex resume` is never used,
and codex restore silently starts a fresh conversation. The matching logic and the
`codex resume <id>` command itself are both correct and verified. Fix direction: keep watching
past the first turn — e.g. re-run discovery on first output/turn, or watch the sessions dir
for the lifetime of the session rather than for a fixed 15 s window.

**Defect 2 (cosmetic, all harnesses) — hardcoded "opencode" in capability refusals.**
`src/web/routes/ralph-routes.ts:54` and `src/web/routes/respawn-routes.ts:98,252,320` still
say *"not supported for opencode sessions"*, so a shell, codex or pi session is told it is an
opencode session. Task 2 replaced the guard with `caps.*` but left the literal copy. The pause
route already interpolates `getHarness(mode).label`; these four should too.

**Defect 3 (functional, pi, minor) — `preassignsSessionId` is not persisted.**
See check 18.

Nothing else turned up: no crash, no console error, no regression on claude / opencode / shell,
and the deliberate behaviour change (shell has no ralph/respawn/pause) is in place.

## Environment artefacts (not product defects)

* Codex printed `WARNING: proceeding, even though we could not create PATH aliases: Refusing
  to create helper binaries under temporary dir "/tmp"` because the isolation harness put
  `CODEX_HOME` under `/tmp`. It does not occur with a normal `$HOME`.
* Codex re-shows its "Update available" prompt on every launch; "Skip" is not remembered.
  This costs a couple of seconds of first-run interaction but does not block the harness.
* Claude Code and codex both show a directory-trust prompt on a never-before-seen working
  directory; both were answered through the app's own input route.

## Cleanup

Dev server on 3417 stopped, all seven private tmux sessions (`codeman-*` plus the manual
`resumetest`) killed on the `/tmp/cmsmoke` socket, and the scratch `HOME` removed. No process
or session belonging to the user's real Codeman was created, modified or killed by this run
(verified: `tmux ls | grep -c codeman` = 36 before and after).

---

## Defect resolution (2026-09-09, follow-up fix pass)

The findings above are the original evidence and are left untouched. All three defects
have since been fixed on `feat/harness-registry`.

**Defect 1 (codex `harnessSessionId` never discovered) — FIXED.**
`src/harnesses/codex-session-discovery.ts` no longer polls for a fixed 15 s from spawn.
`discoverCodexSessionId()` is now a long-lived watch:

* an `fs.watch` on `$CODEX_HOME/sessions` (`recursive: true`, `persistent: false`) wakes a
  rescan the moment codex writes the rollout, so detection after the first submitted turn
  is effectively instant;
* a backing-off poll (1 s, doubling to a 30 s ceiling, reset to 1 s on any filesystem
  event, 100 ms debounce) is the fallback where recursive watch is unavailable and covers
  the case where `$CODEX_HOME/sessions` does not exist yet — the watcher is created lazily
  and re-created after an error;
* the watch ends on the first match, on an `AbortSignal`, or at
  `CODEX_DISCOVERY_DEFAULT_TIMEOUT_MS` (1 hour). `Session` holds the AbortController and
  aborts it in `stop()`, so teardown ends the watch; timer, watcher and abort listener are
  released in a `finally` on every path.

The match predicate (`session_meta` + `payload.cwd` + start-time floor) and the strict
`/^[a-zA-Z0-9-]{1,128}$/` validation in front of the `codex resume '<id>'` interpolation are
unchanged — the smoke test had already verified both.

Verification honesty: this is proven by unit tests over temp fixture directories
(`test/codex-session-discovery.test.ts`, 14 passed) — a rollout that only appears several
poll gaps after the call IS found, a lazily-created sessions dir IS picked up, an aborted
watch resolves null promptly, and no handles leak. **No new live codex session was spawned
for the fix**, so the end-to-end "real codex first turn → resume id persisted" path has not
been re-observed on a real TUI; it rests on the measured root cause above plus the
already-verified predicate and resume command.

**Defect 2 (hardcoded "opencode" in capability refusals) — FIXED.**
`ralph-routes.ts:54` and `respawn-routes.ts:98,252,320` now interpolate
`getHarness(session.mode).label`, matching the pause route. A shell session is told
"Ralph tracker is not supported for Shell sessions", codex "Codex", pi "Pi". Covered by new
cases in `test/routes/ralph-routes.test.ts` and `test/routes/respawn-routes.test.ts`.

**Defect 3 (`preassignsSessionId` not persisted) — FIXED.**
`Session.startInteractive()` now sets `harnessSessionId` to the Codeman session id and emits
`harnessSessionIdDiscovered` (which the server persists) whenever the harness declares
`caps.preassignsSessionId` and no id is known yet. This is capability-driven, not a pi
name check. Harnesses that also declare `caps.claudeTranscript` (claude) are excluded: their
id is authoritatively published by the transcript-filename hook via `setClaudeResumeId()`,
and inventing it at spawn would widen Claude's restore gate — out of scope for a defect fix.
Covered by two new cases in `test/harness-spawn-plumbing.test.ts`.

---

## Defect 1 end-to-end verification

Date: 2026-09-09, ~12:55–13:04 UTC. Branch `feat/harness-registry` @ `72e19290`.
Purpose: the Defect 1 fix above was proven by unit tests over temp fixtures only. This run
watches a **real codex 0.144.5 TUI** produce an id and follows it through persistence,
restart-restore and teardown.

### Environment

Same isolation recipe as the original run: symlink-farm `HOME` (every entry of `/home/siggi`
symlinked except `.codeman`, which is a fresh empty dir), private tmux server via
`env -u TMUX TMUX_TMPDIR=/tmp/cme2e`. `$CODEX_HOME` therefore resolves through the symlink to
the **real** `~/.codex` (auth + trust intact; only new rollout files were added, nothing
deleted or rewritten).

```
env -u TMUX HOME=$S/home TMUX_TMPDIR=/tmp/cme2e \
  nohup npx tsx src/index.ts web --port 3419 > /tmp/codeman-3419.log 2>&1 &
$ curl -s http://localhost:3419/api/status
{"version":"0.6.6","sessions":[],...}          <- clean, 0 adopted sessions
```

User tmux session count before: `tmux ls | grep -c codeman` = **36**.

### Step 1 — codex session spawns and the pane renders — **PASS**

```
$ curl -s -X POST http://localhost:3419/api/sessions -d \
  '{"workingDir":"…/e2e/wd-codex","mode":"codex","name":"e2e-codex"}'
{"success":true,"session":{"id":"0bfee5c9-f02e-4257-8cc6-48f8029e0dfb", … "mode":"codex" …}}
$ curl -s -X POST http://localhost:3419/api/sessions/0bfee5c9-…/interactive -d '{}'
{"success":true}          (12:55:39.102)
```

First capture (265 bytes, non-blank) is the update prompt; answered with `"2"` + `"\r"`
through the app's own input route. Then:

```
$ tmux capture-pane -p -t codeman-0bfee5c9
╭──────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.144.5)                               │
│ model:       gpt-5.6-terra medium   /model to change     │
│ directory:   /tmp/claude-1000/…s-registry/…/e2e/wd-codex │
│ permissions: YOLO mode                                   │
╰──────────────────────────────────────────────────────────╯
  Tip: You can resume a previous conversation by running codex resume
› Implement {feature}
```

### Step 2 — submitting the first user turn — **PASS** (with a correction)

`{"useMux":true}` **does not submit**; it only types. Confirmed again here — after

```
12:56:11.256  POST …/input {"input":"say hi in one word","useMux":true}  -> {"success":true}
```

the pane showed the text sitting in the composer (`› say hi in one word`) and, over a
**120 s** poll of `GET /api/sessions/:id`, `harnessSessionId` stayed `null` and **no new
rollout file appeared** — codex had not been given the turn. Enter has to be sent
separately (`{"input":"\r","useMux":true}`) or via `{"submit":true}`. This is also a second,
independent confirmation of the root cause: an idle-but-typed-into codex TUI writes no rollout.

### Step 3 — `harnessSessionId` populated after the turn — **PASS**

```
12:58:45.041  POST …/input {"input":"\r","useMux":true}   -> {"success":true}
              (poll loop: GET /api/sessions/0bfee5c9-… | jq -r .harnessSessionId)
FOUND 01a0863d-5708-77e2-9048-e69ac9faa27d after .142687878s
```

Filesystem evidence for the same id:

```
$ stat -c 'birth %w  mtime %y' ~/.codex/sessions/2026/09/09/rollout-*01a0863d*.jsonl
birth 2026-09-09 12:58:45.163517335 +0000  mtime 2026-09-09 12:58:47.975530303 +0000
```

**Measured latency: rollout file born 122 ms after the Enter; the API reported
`harnessSessionId` 143 ms after the Enter — i.e. within ~21 ms of the file appearing.**
The `fs.watch` wake path, not the poll, is what fires. Compare with the old behaviour: the
turn was submitted **186 s** after spawn, far outside the previous 15 s window, and the old
implementation would have found nothing. Defect 1 is genuinely fixed in reality.

Second turn for an unambiguous restore check:

```
› say hi in one word
• Hi
› reply with just the word alpha
• alpha
```

### Step 4 — persisted to state.json — **FAIL at discovery time / PASS at shutdown** (new Defect 4)

45+ s after the id was live in the API, state.json had **not** been written:

```
$ jq '.sessions[] | {id, mode, harnessSessionId}' $HOME/.codeman/state.json
{ "id": "0bfee5c9-…", "mode": "codex", "harnessSessionId": null }
$ stat -c %y state.json      2026-09-09 12:55:36.054645007 +0000   <- still the spawn-time write
$ curl -s …/api/sessions/0bfee5c9-… | jq -r .harnessSessionId
01a0863d-5708-77e2-9048-e69ac9faa27d                              <- in memory only
```

Root cause, `src/web/server.ts:2005`:

```ts
harnessSessionIdDiscovered: (id: string) => {
  if (session.harnessSessionId === id) return;   // <- ALWAYS true
  session.harnessSessionId = id;
  this.persistSessionState(session);
},
```

Both emitters set the field **before** emitting — `src/session.ts:1663` (codex discovery)
and `src/session.ts:1260` (the `preassignsSessionId` path added for Defect 3) — so the
dedupe guard short-circuits on every event and `persistSessionState()` is never called.

It is saved anyway on a **graceful** shutdown, because `stopServer()` calls
`_persistSessionStateNow()` for every session (`src/web/server.ts:4045`):

```
SIGTERM received, shutting down gracefully…
$ jq '.sessions[] | {id,harnessSessionId,status}' state.json
{ "id": "0bfee5c9-…", "harnessSessionId": "01a0863d-5708-77e2-9048-e69ac9faa27d", "status": "idle" }
```

So the normal restart path works (Step 5 below), but an ungraceful exit (SIGKILL, OOM,
power loss, container stop) between discovery and shutdown loses the id and the codex
session becomes unresumable — exactly the outcome Defect 1 was fixed to prevent. Recorded
as **Defect 4** below. Marked FAIL because the deliverable was "persisted when discovered".

### Step 5 — restart restores via `codex resume '<id>'` — **PASS**

Server stopped (SIGTERM), then the mux session was **killed** so the reattach path could not
be used and the `harnessSessionId`-gated state.json path was the only one left:

```
$ tmux kill-session -t codeman-0bfee5c9 ; tmux ls
no server running on /tmp/cme2e/tmux-1000/default
```

Relaunching the same command:

```
[Server] Restoring 1 stopped session(s) from state.json (no tmux pane found)
[Session] Starting interactive Codex session (with tmux)
[Server] Auto-resuming session 0bfee5c9-f02e-4257-8cc6-48f8029e0dfb (was running, claudeResumeId=undefined)
```

The actual process command line:

```
$ ps -eo args | grep 'codex resume'
node /home/siggi/.local/bin/codex resume 01a0863d-5708-77e2-9048-e69ac9faa27d --dangerously-bypass-approvals-and-sandbox --no-alt-screen
```

and after dismissing the update prompt the restored pane really holds the earlier
conversation:

```
  Tip: Use /personality to customize how Codex communicates.
› say hi in one word
• Hi
› reply with just the word alpha
• alpha
```

### Step 6 — the watch does not leak — **PASS**

Measured with the inotify watch-descriptor count of the real node process
(`/proc/<pid>/fdinfo/<inotify fd>`; note `npx`/`tsx` wrappers are separate pids — the leaf
`/usr/bin/node … src/index.ts` is the one to inspect):

```
settled baseline (no codex watch active)   :  761
POST /api/sessions -> codex + /interactive :  1317   (+556 = recursive watch on ~/.codex/sessions)
DELETE /api/sessions/<id>  (Session.stop)  :   761   (immediately, within 10 s)
+30 s later                                :   761
```

Two separate sessions (`e2e-codex-leak`, `e2e-codex-leak2`) gave the identical
761 → 1317 → 761 profile. The `AbortController` in `stop()` closes the watcher and clears
the backoff timer deterministically; no rescanning, no lingering handle, and no
`codex session id not discovered` warning is logged on the aborted path (correct — abort
returns silently).

Side observation (not a defect, worth knowing): a recursive watch over a long-lived
`~/.codex/sessions` tree costs ~550 inotify watch descriptors *per active codex session*
here. With many concurrent codex sessions this can approach
`fs.inotify.max_user_watches`. Watching only the current day's shard, or a single
non-recursive watch shared by all sessions, would avoid that.

### Result summary

| Step | Check | Result |
|---|---|---|
| 1 | Real codex session spawns, pane non-blank | PASS |
| 2 | First user turn submitted (`useMux` types, `\r` submits) | PASS |
| 3 | `harnessSessionId` populated from a real rollout | **PASS — 143 ms after the Enter** |
| 4 | Persisted to state.json when discovered | **FAIL** (only at graceful shutdown — Defect 4) |
| 5 | Restart restores with `codex resume '<id>'`, conversation intact | PASS |
| 6 | No timer/watcher leak after `stop()` | PASS |

**Defect 4 (functional, codex + pi) — `harnessSessionIdDiscovered` never persists.**
`src/web/server.ts:2005` guards with `if (session.harnessSessionId === id) return;`, but both
emit sites (`src/session.ts:1260`, `src/session.ts:1663`) assign the field before emitting, so
the guard always fires and `persistSessionState()` is never reached. The id survives only
because graceful shutdown re-persists every session. Fix: compare against the value *before*
assignment (or drop the guard and let the debounce coalesce). Also affects the Defect 3 fix
for pi.

### Cleanup

Dev server on 3419 killed, the private tmux server on `/tmp/cme2e` killed
(`tmux kill-server`, then `no server running on /tmp/cme2e/tmux-1000/default`), scratch
`HOME` and `/tmp/cme2e` removed. `tmux ls | grep -c codeman` = **36** before and after — no
real Codeman session was created, modified or killed. Three new rollout files were added to
`~/.codex/sessions/2026/09/09/` as the normal by-product of running codex; nothing in the
user's codex history was deleted or rewritten.

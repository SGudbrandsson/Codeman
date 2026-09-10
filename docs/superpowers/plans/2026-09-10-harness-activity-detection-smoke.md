# Harness Activity Detection — Live Smoke Results (plan Task 10)

Date: 2026-09-10. Isolated dev server on port 3431 (symlink-farm `HOME` with an empty `.codeman`, private tmux socket via `env -u TMUX TMUX_TMPDIR=/tmp/cmact`).

Source verified: `src/` at `8026c3af`, identical to `dd8fdfd0` (the regression run used `dd8fdfd0`) (`git diff --stat 8026c3af dd8fdfd0 -- src/` is empty). Binaries: pi 0.85.1, codex 0.154.0.

## Isolation

- First `GET /api/status` returned `sessions: []`; the log had no `Restored: codeman-*` lines.
- The production tmux session count was 35 before and after the run.

## Step 2 — pi: PASS

| Check | Result |
|---|---|
| Launched with the extension | Pane command has `-e .../codeman-activity-extension.ts`; `/proc/<pid>/environ` has `CODEMAN_ACTIVITY_TOKEN`, `CODEMAN_SESSION_ID`, `CODEMAN_API_URL`; pi's `[Extensions]` list includes the file. |
| First turn busy → idle | Submitted 15:55:03.2 → busy 15:55:04.3 → idle 15:55:05.4. JSONL reply at 15:55:04.8. |
| Reports accepted | The server doesn't log accepted reports. Evidence: `harnessTranscriptPath` is set from the report's `sessionFile`; SSE showed `session:working` then `session:idle`; typing text without submitting never set busy (PTY heuristics are off). |
| Transcript streams the first turn | `GET /transcript` → 200, `X-Transcript-Id` present, 2 blocks (user + assistant). |
| Second turn | busy → idle. |
| `/new` then a turn | Busy 15:57:03 to 15:57:10, idle 15:57:11. `X-Transcript-Id` changed and the new file's blocks were served; `harnessTranscriptPath` was updated. |

## Step 3 — codex: PASS

| Check | Result |
|---|---|
| Trust prompt | Answered with a lone `\r` ("Yes, continue"). |
| Turn 1 | Busy 15:55:11.9 to 15:55:12.9, idle 15:55:14.0; the rollout has `task_started` and `task_complete` for the same `turn_id`. |
| Turn 2 | Busy for ~4 s, then idle. |

## Negative cases: PASS

| Check | Result |
|---|---|
| `harness_activity` with an invalid payload or no `data` | HTTP 400, `INVALID_INPUT` |
| Well-formed report with a wrong token | HTTP 200, ignored; status stayed idle |

## Step 4 — Regression

| Check | Result |
|---|---|
| Server restart with pi idle (token kept on attach) | PASS. Both sessions were restored idle. The next two pi turns went busy → idle, so reports from the surviving pi process, still on its original token, were accepted. |
| claude busy/idle | PASS. Folder-trust prompt answered deliberately. Two turns went busy ~1 s after submit and idle ~0.5 s after the reply was written. Typed text without a submit left it idle even with `❯` on screen, so ClaudeActivityMonitor drives it. |
| shell unchanged | PASS. Via the UI `/shell` route: busy, then idle after 500 ms, and idle through `sleep 3; echo done`, the same as base `38037ecb`. (A shell started with `/interactive` stays busy because bash never prints `❯`; also true at base, and the UI never starts shells that way.) |
| opencode unchanged | PASS for startup only (opencode 1.18.30): busy, then idle after the 3 s settle, the same as base. A real turn failed with "API key is invalid", so busy/idle during an opencode turn was not tested. |

## Observations

- **Persisted status lags.** The `idle` listener broadcasts but doesn't persist immediately, so `state.json` kept codex as `busy` for more than 30 s after the API reported idle. A graceful shutdown flushes it. It could matter only after a crash while a stale `busy` is on disk.
- **Test hazard.** Inside a Codeman session `$TMUX` takes precedence over `TMUX_TMPDIR`, so tmux commands aimed at the isolated server must use `env -u TMUX` and create the socket directory first. Otherwise they hit the production tmux server.

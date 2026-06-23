# Hermes ↔ Codeman Interface — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorming), pending implementation plan

## Problem

Hermes (an external OpenClaw-style agent) needs to interact with Codeman: see
the status of running sessions, spin up new work in any project, and nudge
running sessions. Hermes knows nothing about Claude, Codeman's skills, or the
internal `TASK.md`/worktree workflow — and it should not have to. The interface
must keep Codeman's "how" (skills, worktree orchestration) hidden behind a small
catalog of "what" operations.

## Key finding that shapes the design

Codeman already exposes the needed substrate:

- A REST API (~150 endpoints) covering sessions, worktrees, subagents, input,
  and an SSE event stream (`/api/events`).
- A stdio MCP server (`src/mcp-server.ts`) that today wraps two of those
  endpoints as MCP tools (`list_sessions`, `send_message`).

So this is not a greenfield "build an interface" project. It is: **add a thin
high-level layer on top of the existing REST API, and expose it through the
existing MCP server.**

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Connection model | MCP as the agent-facing layer, REST as the substrate (future-proofs raw-HTTP callers too) |
| Where Hermes runs | Same machine, same trust boundary → **no auth, no new transport** (stdio MCP, `localhost:3001`) |
| Tool altitude | **High-level** — tools encapsulate workflows; Hermes never touches `TASK.md`/branch/worktree mechanics |
| Where workflow logic lives | **In new REST endpoints** (TypeScript), not in `mcp-server.ts` and not in skill-markdown only |
| Intake intelligence | **Template-fill** — endpoints render `TASK.md` from structured fields; no LLM in the intake path |
| Lifecycle (merge/close) | **Out of scope for v1** — spin up + monitor + nudge only; merge stays human |

## Architecture

```
Hermes ──MCP(stdio)──▶ codeman-mcp ──HTTP──▶ Codeman REST API ──▶ sessions/worktrees
         (typed tools)   (thin facade)        (localhost:3001)
```

Three layers:

1. **REST API** — existing; remains the single source of truth.
2. **New high-level REST endpoints** — `POST /api/feature`, `POST /api/fix`,
   `GET /api/sessions/:id/digest`. Each encapsulates a multi-step workflow
   server-side in TypeScript. Callable by *anything* that does HTTP, which is
   the "future-proof / both" requirement satisfied for free.
3. **`src/mcp-server.ts`** — stays a thin facade. Each MCP tool is one HTTP call
   to layer 2 or to an existing endpoint.

**Why the logic goes in REST endpoints, not the MCP server:** keeping it in REST
means raw-HTTP consumers get the same capability, the logic is unit-testable
without an MCP client, and the existing skills can later be slimmed to call these
same endpoints — so the feature/fix orchestration is maintained in exactly one
place instead of duplicated between skill-markdown and the MCP facade.

## Tool catalog (the MCP surface Hermes sees)

### Read / monitor

| Tool | Returns | Backed by |
|---|---|---|
| `list_projects` | Repos Hermes can start work in: name, path, idle parent session id | `GET /api/sessions`, filtered to main sessions (no `worktreeBranch`) |
| `list_sessions` | All active work: id, name, project, branch, status (`working`/`idle`/`stopped`) | `GET /api/sessions` (exists) |
| `get_session_digest(id)` | The "is it done?" answer (see below) | new `GET /api/sessions/:id/digest` |

`get_session_digest` is the heart of the integration — one call answers the three
questions named in the request ("what's the latest message", "is it done
working", "does it have subagents"). It returns:

- `status` — `working` / `idle` / `stopped` (mapped from internal
  `SessionStatus`: `busy`→`working`, `idle`→`idle`, `stopped`/`error`/`archived`→`stopped`)
- `lastAssistantMessage` — the most recent assistant text (trimmed/length-capped)
- `subagents` — count and a short list of `{ name, doing }` for currently active
  subagents (sourced from `subagentWatcher.getRecentSubagents`)
- `phase` — current task/phase string if the session is running a task workflow
  (from `TASK.md` `status` / task tracker), else null
- `lastActivityAt` — timestamp of last output, so Hermes can detect stalls

Status mapping note: the internal enum has five values
(`idle|busy|stopped|error|archived`); the digest collapses them into the
three-state model above so Hermes deals with a simple vocabulary.

### Act

| Tool | Does | Backed by |
|---|---|---|
| `start_feature(project, title, description, acceptance?)` | Full feature intake → returns new session id | new `POST /api/feature` |
| `start_fix(project, title, description)` | Full fix intake → returns new session id | new `POST /api/fix` |
| `send_message(target, message)` | Nudge / answer a running session | `POST /api/sessions/:id/input` (exists, with `useMux:true` + `\r`) |

## Workflow endpoints — behaviour (template-fill)

`POST /api/feature` and `POST /api/fix` perform, server-side and
deterministically (no LLM):

1. **Resolve parent session** — match `project` against main sessions'
   `workingDir` (case-insensitive); prefer `idle` over `busy`, prefer the
   shorter `workingDir` (closer to repo root). Error `NO_PROJECT_MATCH` with the
   candidate list if none/ambiguous.
2. **Derive branch name** — slug the title (lowercase, hyphenate, ≤37 chars),
   prefix `feat/` or `fix/`. On "branch already exists", append `-2`, `-3`, …
3. **Render `TASK.md`** — from a fixed template using `title`, `description`,
   `acceptance`; render `CLAUDE.md` from the standard worktree bootstrap string.
4. **Create the worktree** — `POST /api/sessions/:parentId/worktree` with
   `isNew:true`, `autoStart:false`, and `taskMd`/`claudeMd` passed inline (atomic
   write before return — avoids the known race).
5. **Register a work item** — best-effort (`POST /api/work-items`); never blocks.
6. **Start Claude** — `POST /api/sessions/:newId/interactive`.
7. **Return** `{ sessionId, branch, worktreePath }`.

These steps are exactly what the `codeman-feature` / `codeman-fix` skills do
today; this ports the mechanical parts into TypeScript. The *implementing* Claude
inside the worktree still does all real reasoning via `codeman-task-runner` — only
the intake step is de-LLM'd.

`TASK.md` template (feature) — fields interpolated, no model involved:

```
# <title>

## status
phase: analysis

## Description
<description>

## Acceptance Criteria
<acceptance, or "See description.">

## Workflow
Invoke the codeman-task-runner skill and proceed through its phases.
```

## Error handling

- Endpoints return structured JSON errors with a `code`
  (`NO_PROJECT_MATCH`, `BRANCH_EXISTS`, `INVALID_INPUT`, `OPERATION_FAILED`) and
  a human-readable `message`. MCP tools surface `message` to Hermes verbatim.
- Work-item registration failure is logged and swallowed — it must never fail the
  spin-up.
- `get_session_digest` on an unknown id → `404` → MCP tool returns a clear
  "no such session" error rather than throwing.

## Testing

- **Unit (template-fill):** branch slugging (length cap, collision suffix,
  invalid chars), parent-session resolution (idle-preference, shortest-path
  tie-break, no-match), `TASK.md` rendering with/without `acceptance`. Pure
  functions, no server needed.
- **Unit (digest):** status collapse mapping (all five enum values), subagent
  list shaping, empty/stopped sessions.
- **Integration:** against a running `localhost:3001` — `start_feature` returns a
  real session id whose worktree contains the expected `TASK.md`; `send_message`
  reaches the session; `get_session_digest` reflects a working vs idle session.
- **MCP smoke:** drive `mcp-server.ts` over stdio with an `initialize` +
  `tools/call` for each tool, assert shapes.

## Explicitly out of scope (v1, YAGNI)

- Auth / tokens and HTTP/SSE MCP transport (only needed if Hermes goes remote).
- Lifecycle tools (`merge_worktree`, `close_session`) — merge stays human.
- Push/streaming digest as an MCP resource — Hermes polls `get_session_digest`
  for now; revisit if polling proves insufficient.
- Low-level escape-hatch tools (`create_session`, raw `get_output`) — add only if
  a concrete need appears.
```

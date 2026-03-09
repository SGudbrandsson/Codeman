# Voice Command System — Design

A voice-driven command interface for controlling Codeman itself (not dictating text to Claude).
Press a button, speak a command, Codeman executes it.

## Goal

A dedicated "command mode" mic button in the Codeman web UI that lets you:
- Open Claude/shell/OpenCode sessions in projects
- Create, open, merge, and delete worktrees
- Add and clone projects
- Control the Ralph autonomous loop
- Send compact commands and arbitrary input to sessions

All via natural speech, without touching the keyboard.

## Architecture

```
[mic button] → Deepgram transcription → POST /api/voice-command
    → Claude Haiku intent parser → structured {command, args}
    → execute existing Codeman API → confirmation toast in UI
```

### Why Claude Haiku as the intent parser

- Handles natural language variation ("spin up a branch for the auth bug" just works)
- ~300ms latency, essentially free
- Anthropic API key already available on the server
- Returns structured JSON — backend maps directly to existing API calls
- No custom NLP vocabulary to maintain

The transcription layer (Deepgram + Web Speech API fallback) already exists in `voice-input.js`.

## What's New to Build

1. **`/api/voice-command` endpoint** — receives transcript, calls Haiku, executes API, returns result
2. **Haiku system prompt** — describes the 6 command families and their args
3. **Command mode mic button** — visually distinct from the existing "type for Claude" mic
4. **Confirmation UI** — small toast/modal before executing destructive or ambiguous commands

Everything else (transcription, underlying APIs) already exists.

## Command Families

### 1. `open_session`
Open Claude, a shell, or OpenCode in a project — optionally on a specific branch.

| Voice example | API |
|---|---|
| "Open Claude in [project name]" | `POST /api/quick-start` |
| "Open Claude in [project] on [branch]" | `POST /api/quick-start` + worktree |
| "Open a shell in [project name]" | `POST /api/sessions` → `POST /api/sessions/:id/shell` |
| "Open OpenCode in [project]" | `POST /api/sessions` with `cli: opencode` |

### 2. `worktree`
Create, open, merge, or delete git worktrees.

| Voice example | API |
|---|---|
| "Create a worktree for [branch name]" | `POST /api/sessions/:id/worktree` |
| "Open Claude in the [branch] worktree" | Resume dormant or create new |
| "Merge [branch] back" | `POST /api/sessions/:id/worktree/merge` |
| "Delete the [branch] worktree" | `DELETE /api/sessions/:id/worktree` |

### 3. `project`
Add, link, or clone projects (cases).

| Voice example | API |
|---|---|
| "Add project at [path]" | `POST /api/cases` |
| "Link [path] as [name]" | `POST /api/cases/link` |
| "Clone [repo URL] and add it" | `git clone` via shell → `POST /api/cases` |
| "Search GitHub for [query] and clone it" | GitHub search API → pick repo → clone → `POST /api/cases` |

The GitHub clone flow requires a disambiguation step — backend returns top 3 matches,
UI presents them, user confirms before cloning.

### 4. `session_control`
Kill, rename, or clear sessions.

| Voice example | API |
|---|---|
| "Kill this session" | `DELETE /api/sessions/:id` |
| "Kill all sessions" | `DELETE /api/sessions` |
| "Rename this session to [name]" | `PUT /api/sessions/:id/name` |
| "Clear the terminal" | send clear command via input |

### 5. `input`
Send text or shortcuts to the active session.

| Voice example | API |
|---|---|
| "Send a compact" | send `/compact` to `POST /api/sessions/:id/input` |
| "Send [text] to Claude" | `POST /api/sessions/:id/input` |
| "Run [shell command]" | send to shell session |

### 6. `ralph`
Start, stop, or reset the autonomous loop.

| Voice example | API |
|---|---|
| "Start Ralph loop" | `POST /api/ralph-loop/start` |
| "Stop respawn" | `POST /api/sessions/:id/respawn/stop` |
| "Reset the circuit breaker" | `POST /api/sessions/:id/ralph-circuit-breaker/reset` |

## Haiku Intent Router — System Prompt Shape

```
You are a command router for Codeman, an AI session manager.
Given a voice transcript, return JSON with this shape:
{ "command": "<family>/<action>", "args": { ... }, "confirm": true/false }

Available commands:
- open_session/claude  — args: project (string), branch? (string)
- open_session/shell   — args: project (string)
- open_session/opencode — args: project (string)
- worktree/create      — args: branch (string), fromSession? (string)
- worktree/merge       — args: branch (string)
- worktree/delete      — args: branch (string)
- project/add          — args: path (string), name? (string)
- project/clone        — args: url? (string), query? (string)
- session/kill         — args: target ("this" | "all")
- session/rename       — args: name (string)
- input/compact        — no args
- input/send           — args: text (string)
- ralph/start          — no args
- ralph/stop           — no args
- ralph/reset-breaker  — no args

Set confirm: true for destructive actions (kill, delete, merge).
If you cannot map the transcript to a command, return { "error": "unrecognized" }.
```

## UI Behaviour

- **Trigger**: A second mic button in the toolbar, distinct from the existing voice-input mic.
  Consider a keyboard shortcut too (e.g. `Ctrl+Shift+V`).
- **Recording**: Same Deepgram/Web Speech flow as existing voice-input, auto-stops on silence.
- **Confirmation modal**: For destructive commands (`confirm: true`), show:
  > *"Heard: 'delete the auth-fixes worktree'"*
  > *"→ Delete worktree `feature/auth-fixes`?"*
  > **[Confirm]** **[Cancel]**
- **Toast on success**: "Worktree created — opening new session."
- **Toast on failure**: "Didn't understand that. Try: 'open Claude in [project name]'."

## What Not to Voice-Command (v1 scope)

Skip in v1 — faster to click than speak:
- Resize terminal, change session color, toggle flicker filter, configure respawn timing,
  push notification settings, tmux stats, debug memory.

## Implementation Notes

- The existing `voice-input.js` handles all transcription — reuse `DeepgramProvider` directly.
- The new endpoint `/api/voice-command` lives in `system-routes.ts` or a new `voice-routes.ts`.
- Active session context (`:id`) is passed from the frontend so "this session" resolves correctly.
- GitHub clone disambiguation can use the GitHub REST search API (`/search/repositories`) —
  no auth required for basic queries, rate limit is 10 req/min unauthenticated.
- Require HTTPS or localhost for mic access (already enforced by Deepgram provider).

## Open Questions for Implementation

1. Should the command mic be global (always visible) or per-session (in the session toolbar)?
2. Should "send [text] to Claude" bypass intent routing and go straight to input?
3. For the GitHub clone flow — present matches in a modal or read them back as a toast?
4. v1: skip GitHub search and require exact URL, add search in v2?

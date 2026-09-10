# Multi-Harness Transcript View

**Date:** 2026-09-10
**Status:** Design
**Scope:** Show the web transcript view for `codex` and `pi` sessions, not just `claude`.

## Problem

A codex or pi session offers only the raw tmux terminal. The transcript view — the readable,
structured conversation with collapsible tool calls — is Claude-only.

The cause is one flag doing two jobs. `HarnessCapabilities.claudeTranscript` currently means
both:

1. *"this harness has a transcript worth viewing"*, and
2. *"this harness uses Claude's `--resume`, Claude's hooks, Claude's JSONL schema, and the
   Claude-specific state machine in `TranscriptWatcher`"*.

Codex and pi need (1) but must not get (2), so both were set `false` and lost the view.

Three consumers read it: `src/web/server.ts:268`, `src/web/public/app.js:10729`, and
`src/web/public/keyboard-accessory.js:390` (which hides the toggle button entirely).

## Why this is an adapter problem, not a rearchitecture

The view does not consume Claude JSONL. It consumes `TranscriptBlock[]` — a harness-neutral
union of `text` / `tool_use` / `tool_result` / `result` (`src/types/transcript-blocks.ts`).
Both feed paths funnel through one Claude-shaped parser:

- `GET /api/sessions/:id/transcript` (`session-routes.ts:1493`) → `parseTranscriptJSONL`
- `TranscriptWatcher` tailing the file (`transcript-watcher.ts:392`) → `parseTranscriptEntry`
  → `transcript:block` SSE → `app.js` renderer (`app.js:4738-4800`)

Give each harness a **locator** (where is the file) and an **adapter** (raw line →
`TranscriptBlock[]`) and the whole view works unchanged.

## Evidence: what each harness actually stores

Verified against real session files on this machine, not inferred from docs.

### pi 0.85.1 — nearly Claude's format already

`~/.pi/agent/sessions/<escaped-cwd>/<ISO-ts>_<sessionId>.jsonl`

```json
{"type":"message","timestamp":"…","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
```

- roles: `user`, `assistant`, `toolResult`
- content blocks: `text`, `thinking`, `toolCall`, `image`
- `toolCall` = `{id, name, arguments}` (Claude uses `{id, name, input}`)
- **`thinking` is plaintext** — richer than Claude's transcript, which has no thinking block.

`--session-id` is honoured. Verified directly:

```
$ pi --session-id 11111111-2222-4333-8444-555555555555 --session-dir … -p ""
Warning: No project session found with id '1111…'; creating a new session with that id.
```

So the locator globs `*_<harnessSessionId>.jsonl`, and Codeman already sets
`harnessSessionId` for pi (`preassignsSessionId: true`).

### codex 0.144.5 — different envelope, complete data

`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`, already located by
`discoverCodexSessionId()` and stored in `harnessSessionId`.

Records are `{type, timestamp, payload}`:

| record | maps to |
|---|---|
| `event_msg` / `user_message` | `text` (role user) |
| `event_msg` / `agent_message` | `text` (role assistant) |
| `response_item` / `custom_tool_call` | `tool_use` (`call_id`, `name`, `input`) |
| `response_item` / `custom_tool_call_output` | `tool_result` (`call_id`, concatenated `output[].text`) |
| `event_msg` / `token_count` | `result` (token usage) |
| `event_msg` / `task_complete` | `result` |
| `response_item` / `message` role `developer` | **filtered** — system prompt, never displayed |
| `response_item` / `reasoning` | **unavailable** — `encrypted_content`, `summary` empty |

Codex reasoning is encrypted, so codex transcripts show no thinking. This is a hard
limitation of the format, not a shortcut.

## Design

### 1. Split the capability

`claudeTranscript` splits in two:

```ts
/** Harness has a viewable transcript; the view and its toggle are offered. */
transcript: boolean;
/** Harness speaks Claude's JSONL schema, --resume, hooks, and the Claude state machine. */
claudeTranscript: boolean;
```

| | claude | codex | pi | opencode | shell |
|---|---|---|---|---|---|
| `transcript` | yes | **yes** | **yes** | no | no |
| `claudeTranscript` | yes | no | no | no | no |

Every existing `claudeTranscript` consumer keeps its current meaning. The three view gates
switch to `transcript`. opencode stays `false` for both: its storage format is not in scope
here, and adding it later is a fourth adapter, not a redesign.

### 2. `src/harnesses/transcripts/`

```
src/harnesses/transcripts/
  types.ts       TranscriptAdapter
  claude.ts      wraps the existing parseTranscriptEntry (no behaviour change)
  codex.ts       rollout envelope -> blocks
  pi.ts          pi message records -> blocks
  index.ts       getTranscriptAdapter(mode): TranscriptAdapter | null
```

```ts
interface TranscriptAdapter {
  /** Absolute path to this session's transcript file, or null if not yet written. */
  locate(ctx: { workingDir: string; sessionId: string; harnessSessionId?: string }): string | null;
  /** Convert one raw JSONL line into zero or more blocks. */
  parseLine(raw: string): TranscriptBlock[];
}
```

`parseLine` returning `[]` for uninteresting records (system prompts, `world_state`,
`turn_context`, `model_change`) is normal and expected.

### 3. New block type: `thinking`

```ts
export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  timestamp: string;
}
```

Added to the `TranscriptBlock` union, rendered in `app.js` beside the existing branches as a
dimmed, collapsed-by-default section. Only pi emits it today; Claude and codex never will, so
this is additive and cannot regress Claude rendering.

### 4. Separate the block feed from the Claude state machine

**This is the load-bearing decision.** `TranscriptWatcher` (490 lines) does far more than
emit blocks: completion detection, plan-mode detection, AskUserQuestion resolution, and it
feeds idle detection. Those are Claude semantics driven by Claude's `type: user|assistant|
system|result` envelope.

Running them against codex or pi would recreate exactly the bug class the harness registry
just removed — Claude-only machinery firing on a harness that does not speak it.

So `TranscriptWatcher` gains a mode:

- **always:** tail the file, run the harness's `parseLine`, emit `transcript:block`.
- **only when `caps.claudeTranscript`:** `handleAssistantEntry` / `handleResultEntry`,
  `checkPlanMode`, AskUserQuestion tracking, completion detection.

Concretely: the Claude state-machine call sites in `handleEntry` become conditional on the
harness, while the `parseLine` → `emit('transcript:block')` tail stays unconditional.

### 5. Generalise path resolution

`ctx.getTranscriptPath(id)` and the `~/.claude/projects/...` fallback inside the transcript
endpoint (`session-routes.ts:1500-1508`) both become
`getTranscriptAdapter(session.mode)?.locate(...)`. The Claude adapter keeps today's exact
lookup order, including the session-id fallback, so Claude behaviour is unchanged.

### 6. Empty state

Neither harness writes its file until the **first submitted turn** — verified for codex
(measured 122ms after Enter, but nothing at all before it) and observed for pi. A fresh
session therefore has no transcript file at all.

The endpoint returns `[]` today, which renders a blank panel. Instead the view shows
"No transcript yet — send a message to start the conversation." when `locate()` returns null
and the harness's `transcript` capability is true.

## Non-goals

- opencode transcripts. A fourth adapter, out of scope.
- Making codex reasoning visible. Encrypted at source; impossible.
- Generalising pause/resume. Still Claude-only, unchanged.
- Rewriting `TranscriptWatcher`'s Claude state machine. It is gated, not touched.

## Risks

1. **The watcher split.** If a Claude state-machine path is left ungated, codex/pi output
   could trip completion or plan-mode detection and mark a session idle at the wrong time.
   Mitigated by a test asserting the Claude handlers never run for codex/pi.
2. **Adapter drift.** Both formats are versioned by tools we do not control (pi's records
   carry `"version":3`). An unrecognised record must yield `[]`, never throw — a malformed
   or future record shape must not break the whole view.
3. **Large transcripts.** The endpoint reads the whole file; codex rollouts embed
   base64 `encrypted_content` and pi embeds base64 images, so files are bigger than Claude's.
   The existing `?tail=` parameter already covers this; the adapters must skip image and
   encrypted payload data rather than passing it through to the client.

## Testing

- **Adapter unit tests, per harness**, over committed fixture lines taken from real files:
  every record type in the tables above, plus an unknown record (expect `[]`) and a malformed
  line (expect `[]`, no throw).
- **Capability split regression:** every current `claudeTranscript` consumer still sees the
  same value for all five harnesses; only the three view gates change.
- **Watcher isolation:** given codex and pi lines, `transcript:block` fires and the Claude
  state-machine handlers do not.
- **Locator tests:** pi finds `*_<id>.jsonl` in the escaped-cwd dir; codex finds its rollout;
  both return null when the file does not exist yet.
- **Live verification:** a real codex session and a real pi session in the deployed app, each
  showing a populated transcript view. This is the acceptance criterion.

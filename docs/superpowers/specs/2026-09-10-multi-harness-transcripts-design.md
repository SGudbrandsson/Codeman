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

### The consumer inventory (corrected)

There are **six** `caps.claudeTranscript` consumers, and **five of them must not change**:

| site | verdict |
|---|---|
| `server.ts:268` (`harnessAllowsClaudeTranscript`) | **stays Claude-only** — protects claudeResumeId + Claude state |
| `session.ts:1280` | **stays** — excludes Claude from preassigning `harnessSessionId` |
| `session.ts:1310`, `:1353`, `:1488` | **stays** — injects Claude MCP args |
| `app.js:13029` | **stays** — hides the Respawn and Ralph tabs (`index.html:718,720`) |

**The trap:** a blanket rename of `claudeTranscript` → `transcript` hands codex and pi the
Respawn and Ralph tabs back, undoing exactly what the harness registry fixed. Only the two
view gates below change.

The two actual view gates do **not** read the capability at all — they hard-code the mode:

- `app.js:10729` — `const _tvIsClaude = !_tvSession?.mode || _tvSession.mode === 'claude'`
- `keyboard-accessory.js:390` — `const isClaude = !mode || mode === 'claude'`

Both switch to a `caps.transcript` check.

**Metadata-load race:** `harnessMeta()` returns `caps: {}` until `/api/harnesses` resolves
(`app.js:11777-11808`). A naive `meta.caps.transcript` check therefore hides the view for
*Claude* during startup. The gate must treat unknown metadata as "claude-like": fall back to
the existing `mode === 'claude'` test when `caps` is empty.

## Why this is an adapter problem, not a rearchitecture

The view does not consume Claude JSONL. It consumes `TranscriptBlock[]` — a harness-neutral
union of `text` / `tool_use` / `tool_result` / `result` (`src/types/transcript-blocks.ts`).
There are **three** parser paths, not two:

- `GET /api/sessions/:id/transcript` (`session-routes.ts:1493`) → `parseTranscriptJSONL`
- `GET /api/sessions/:id/state` (`session-routes.ts:400-413`) → `parseTranscriptJSONL`.
  This one also honours an **archived** session's persisted `sessionState.transcriptPath`,
  so the adapter must accept a caller-supplied path as well as locating one.
- `TranscriptWatcher` tailing the file (`transcript-watcher.ts:392`) → `parseTranscriptEntry`
  → `transcript:block` SSE (`server.ts:957`) → `app.js` renderer (`app.js:4738-4800`)

SSE is not a fourth parser — it is the watcher's output. Subagent transcripts
(`system-routes.ts:679`, `subagent-watcher.ts:845`) are a separate Claude-specific system and
are explicitly **out of scope**.

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

Added to the `TranscriptBlock` union and **exported from the `src/types/index.ts` barrel**
(`:68`) alongside the other block types, or consumers of the public barrel cannot import it.

There is no exhaustive `TranscriptBlock` switch in TypeScript, so adding the member compiles
silently — the risk is the opposite one: without a new branch at `app.js:4735-4815` a
thinking block renders as **nothing at all**. The renderer branch is mandatory, not optional.

Rendered as a dimmed, collapsed-by-default section. Only pi emits it today; Claude and codex
never will, so this is additive and cannot regress Claude rendering.

### 4. Separate the block feed from the Claude state machine

**This is the load-bearing decision.** `TranscriptWatcher` (490 lines) does far more than
emit blocks, and all of it is driven by Claude's `type: user|assistant|system|result`
envelope. Running it against codex or pi would recreate exactly the bug class the harness
registry just removed.

The watcher takes a `claudeState: boolean` construction flag. Everything below runs **only**
when it is true:

| lines | behaviour |
|---|---|
| `transcript-watcher.ts:360-386` | type dispatch + state mutation for `assistant`/`result`/`user`, incl. AskUserQuestion resolution |
| `:391-395` | the Claude parser invocation itself |
| `:398-436` | `handleAssistantEntry` — tool start/end, errors, AskUserQuestion |
| `:438-450` | `handleResultEntry` — completion |
| `:452-485` | `checkPlanMode` |

**Structural change the first draft missed:** the watcher parses each line into a
Claude-typed `TranscriptEntry` *before* processing (`:314-343`). An adapter API of
`parseLine(raw)` therefore requires retaining and passing the **raw line** through, not
merely swapping the call at `:392`. The read loop must hand the adapter the raw string and
only build a `TranscriptEntry` on the Claude path.

**What depends on the gated events, verified:** only respawn consumes `transcript:complete`
and `transcript:plan_mode` (`server.ts:927-941` → `respawn-controller.ts:2513-2540`). Idle
detection and compact-continue come from `Session`'s activity monitor and `session:idle`
(`session.ts:1363-1384`, `server.ts:1839-1851`), **not** from watcher events. Ralph is gated
separately (`server.ts:1650`). The tool SSE events have no consumer beyond their broadcast
declaration. So gating is safe, and codex/pi (both `respawn: false`) lose nothing.

### 4a. Stable block identity

The client's periodic recovery appends only blocks with `b.timestamp > lastTs`
(`app.js:3767-3781`), and its cache identity compares only the final timestamp
(`app.js:3856-3872`).

This is already fragile for Claude — `parseTranscriptEntry` stamps every block from one entry
with that entry's single timestamp, so sibling blocks tie. Codex and pi amplify it: a single
codex record can yield a tool_use and its output at the same millisecond.

Each block therefore gains a monotonic `seq` (source line index, then block index within the
line), and the client dedups on `seq` rather than `timestamp >`. Claude blocks get `seq` too,
which fixes the pre-existing sibling-drop as a side effect.

### 5. Generalise path resolution

`ctx.getTranscriptPath(id)` and the `~/.claude/projects/...` fallback inside the transcript
endpoint (`session-routes.ts:1500-1508`) both become
`getTranscriptAdapter(session.mode)?.locate(...)`. The Claude adapter keeps today's exact
lookup order, including the session-id fallback, so Claude behaviour is unchanged.

`getTranscriptPath` serves both `/state` (`:403`) and `/transcript` (`:1496`), and archive
records the watcher's current path into session state (`server.ts:1368-1445`) — all three
must go through the adapter.

**`startTranscriptWatcher`'s Claude-specific callers must NOT be generalised.** These stay
gated on `claudeTranscript`, because they are about Claude's hooks and resume id, not about
viewing a transcript:

- hook events (`hook-event-routes.ts:49-54`)
- `conversationId` handling (`server.ts:2015-2033`)
- restore/recovery (`server.ts:3750-3806`, `:3978-3983`)
- resume (`session-routes.ts:847-855`)

Only the `/transcript` endpoint's own call (`session-routes.ts:1513-1516`) starts a watcher
for a codex/pi session, and it constructs it with `claudeState: false`.

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
3. **Large transcripts — `?tail=` does NOT bound the server.** The endpoint reads the entire
   file and parses every line before slicing blocks (`session-routes.ts:1512-1524`,
   `transcript-blocks.ts:123-133`); the watcher likewise parses every appended line
   (`transcript-watcher.ts:324-343`). Codex rollouts embed base64 `encrypted_content` and pi
   embeds base64 images, so these files are far larger than Claude's.

   Two requirements: adapters must **drop** image data and encrypted payloads rather than
   forwarding them (protects the client), and `?tail=` must read a bounded **byte** window
   from the end of the file rather than the whole thing (protects the server's memory and
   CPU). Dropping base64 alone leaves the full-file read, JSON.parse and allocation in place.

4. **Path safety.** Locators build paths from persisted or discovered session fields. Each
   locator must validate its harness id against the expected UUID shape, never interpolate a
   raw value into a glob, resolve symlinks, and assert the final canonical path stays under
   that harness's transcript root (`~/.claude/projects`, `$CODEX_HOME/sessions`,
   `~/.pi/agent/sessions`). A path failing containment yields null, not a read.

   Noted while reviewing, **pre-existing and out of scope**: `hook-event-routes.ts:49-54`
   accepts any absolute `transcript_path` that passes `isValidWorkingDir`, which checks
   syntax and `..` only, not root containment (`schemas.ts:17-39`). That is a local file-read
   exposure on the unauthenticated localhost hook route today. This spec does not widen it —
   the new adapters do containment checks the hook route does not — but it should be filed
   separately.

## Testing

- **Adapter unit tests, per harness**, over committed fixture lines taken from real files:
  every record type in the tables above, plus an unknown record (expect `[]`) and a malformed
  line (expect `[]`, no throw).
- **Capability split regression:** every current `claudeTranscript` consumer still sees the
  same value for all five harnesses; only the three view gates change.
- **Watcher isolation:** given codex and pi lines, `transcript:block` fires and the Claude
  state-machine handlers do not.
- **Locator tests:** pi finds `*_<id>.jsonl` in the escaped-cwd dir; codex finds its rollout;
  both return null when the file does not exist yet; both return null for a traversal or
  out-of-root path.
- **Consumer-inventory regression:** the five `claudeTranscript` sites that must not change
  still read `claudeTranscript`, and codex/pi still get no Respawn or Ralph tab.
- **Metadata-race test:** with `caps` empty (pre-`/api/harnesses`), a claude session still
  shows the transcript toggle.
- **Block identity test:** two blocks sharing a timestamp both survive the client's recovery
  dedup.
- **Live verification:** a real codex session and a real pi session in the deployed app, each
  showing a populated transcript view. This is the acceptance criterion.

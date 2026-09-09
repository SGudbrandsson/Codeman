# Harness Registry + Codex & Pi Support

**Date:** 2026-09-09
**Status:** Approved (design); implementation pending
**Scope:** Add `codex` and `pi` as session harnesses, via a harness registry that
replaces the ad-hoc `mode !== 'opencode'` guards scattered across the codebase.

## Problem

`SessionMode` is `'claude' | 'shell' | 'opencode'` (`src/types/session.ts:72`).
Adding a harness today means editing ~58 sites that branch on the literal
`'opencode'`. Most of those are negative guards — `if (session.mode !== 'opencode')`
— that actually mean *"this is a Claude-only feature"*: the ralph/todo tracker, the
respawn controller, the transcript view and `claudeResumeId` resume, and the Claude
output parsers.

Extending the union without touching those guards would silently enable all four
Claude-only subsystems for `codex` and `pi`, which do not produce Claude's transcript
JSONL or terminal output format. The guards must become explicit capabilities before
new harnesses are added.

## Non-goals

- Removing the ralph loop. It is unused and slated for removal, but that is a separate
  actionable. This design only marks it `ralph: false` for new harnesses.
- Generalising `OpenCodeConfig` into a single `harnessConfig` blob. See §4.
- Per-harness permission/sandbox pickers in the UI. See §3.

## 1. The registry — `src/harnesses/`

```
src/harnesses/
  types.ts      HarnessDefinition, HarnessCapabilities, HarnessSpawnContext
  registry.ts   HARNESSES record, getHarness(mode), listHarnesses()
  resolver.ts   generic binary resolver (which -> searchDirs fallback, cached)
  claude.ts  opencode.ts  codex.ts  pi.ts  shell.ts
```

```ts
interface HarnessCapabilities {
  /** Ralph / todo loop tracker is meaningful for this harness. */
  ralph: boolean;
  /** Respawn controller may be armed for this harness. */
  respawn: boolean;
  /** Harness writes Claude-format transcript JSONL; enables transcript view + claudeResumeId. */
  claudeTranscript: boolean;
  /** Terminal output can be fed to Claude-specific parsers (BashToolParser, tokens, CLI info). */
  claudeParsers: boolean;
  /** Harness cannot run under a direct PTY; requires tmux (env injection / TUI). */
  requiresMux: boolean;
  /** Harness accepts a caller-chosen session id, so Codeman's id can be reused. */
  preassignsSessionId: boolean;
  /** Session may be paused/parked (requires a resumable harness session identity). */
  pausable: boolean;
  /** Claude-format hooks (.claude/settings.local.json) should be written for this harness's cases. */
  claudeHooks: boolean;
  /** Global Claude default model applies to this harness. Today's code says "not shell",
   *  which silently hands Claude model names to every non-shell harness. */
  usesClaudeModelDefaults: boolean;
}

interface HarnessDefinition {
  id: SessionMode;
  label: string;        // 'Codex'  — UI + error messages
  shortLabel: string;   // 'cx'     — tab badge
  binary: string | null;// null for shell
  searchDirs: string[]; // resolver fallbacks
  installHint: string;  // shown in the 422 when the binary is missing
  buildCommand(ctx: HarnessSpawnContext): string;
  setupMuxEnv?(muxName: string, cfg?: unknown): void;
  readiness: { kind: 'prompt' } | { kind: 'settle'; ms: number };
  caps: HarnessCapabilities;
}
```

`resolver.ts` replaces the duplicated `which`-then-search-dirs logic in
`utils/claude-cli-resolver.ts` and `utils/opencode-cli-resolver.ts` with one cached
generic function parameterised by binary name and search dirs.

**`pi` PATH hazard:** `pi` is installed at `~/.npm-global/bin/pi`, which is on the
user's fish PATH but not on the `/bin/sh` PATH that `execSync('which pi')` sees.
`~/.npm-global/bin` must be in pi's `searchDirs` or pi will appear uninstalled.

## 2. Capability table

| capability | claude | opencode | codex | pi | shell |
|---|---|---|---|---|---|
| `ralph` | yes | no | no | no | **no** (changed) |
| `respawn` | yes | no | no | no | **no** (changed) |
| `claudeTranscript` | yes | no | no | no | **no** (changed) |
| `claudeParsers` | yes | no | no | no | **no** (changed) |
| `requiresMux` | no | yes | yes | yes | no |
| `preassignsSessionId` | yes | no | no | yes | no |
| `pausable` | yes | no | no | no | no |
| `claudeHooks` | yes | no | no | no | no |
| `usesClaudeModelDefaults` | yes | no | no | no | no |
| `readiness` | prompt | settle 3000ms | settle 3000ms | settle 2000ms | prompt |

Every `session.mode !== 'opencode'` guard becomes a capability read, e.g.
`getHarness(session.mode).caps.respawn`.

**Behaviour change, deliberate and approved:** today's guards are written as
`mode !== 'opencode'`, which is *true* for shell sessions. Shell sessions therefore
currently get a ralph tracker working-dir, a restorable respawn controller, and the
full Claude parser stack run against raw shell output. The table above sets all four
to `false` for shell. This is a fix, not a regression, but it is a real change in
observable behaviour and must be called out in the changelog.

For `claude` and `opencode` the table reproduces today's truth values exactly.

## 3. Spawn commands

Permission depth is "minimal + model only": every Codeman session already runs as an
autonomous, externally-sandboxed agent, so the bypass flags are hardcoded rather than
exposed as UI knobs. Model is the one knob that genuinely varies per session.

**codex** (v0.144.5)
```
codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen [-m <model>]
codex resume <id> --dangerously-bypass-approvals-and-sandbox --no-alt-screen
```
`--no-alt-screen` is required, not cosmetic: codex's TUI uses the alternate screen by
default, and tmux `capture-pane` scrollback — how Codeman restores terminal buffers and
implements pause/resume — is empty for an alt-screen application.

codex has no flag to preassign a session id (`preassignsSessionId: false`); resume is by
recorded id via the `resume` subcommand.

**pi** (v0.85.1, `@earendil-works/pi-coding-agent`)
```
pi --approve --session-id <codemanSessionId> [--model <model>]
```
`--session-id` creates the session if it does not exist, so a single command both starts
and resumes. pi therefore gets the same "Codeman session id == harness session id"
property Claude has, making restart-after-server-reboot work rather than being a stub.

Both harnesses build their command string with the existing validate-with-regex-then-
interpolate approach used by `buildOpenCodeCommand` and the claude branch of
`buildSpawnCommand` (`src/tmux-manager.ts`). The model regex is extended to permit `/`
and `:` so pi's `provider/id:thinking` form is accepted; anything failing the regex is
dropped rather than interpolated.

## 4. Config and persisted state

`SessionMode` becomes `'claude' | 'shell' | 'opencode' | 'codex' | 'pi'`.

### Neutral harness session identity

Restore is currently gated on `session.claudeResumeId` being set
(`src/web/server.ts:3886`), and `Session.toState()` serializes only `openCodeConfig`
(`src/session.ts:1074`). As written, codex and pi sessions would never auto-restore after
a server restart, and their config would not survive a reload at all.

Fix: add a neutral field to `SessionState`:

```ts
/** Harness-native session id used to resume this session, for any harness. */
harnessSessionId?: string;
```

The restore path keys off `harnessSessionId` rather than `claudeResumeId`.
`claudeResumeId` is kept and still written for claude sessions (back-compat with existing
`state.json` entries and every current reader); claude populates both.

**Backfill is restricted to legacy Claude entries.** `CreateSessionSchema` currently accepts
`claudeResumeId: z.string().uuid().optional()` alongside any `mode` (`schemas.ts:140,152`).
Once the enum grows, a caller could pair a Claude UUID with `mode: 'codex'`; an unconditional
backfill would then run `codex resume <Claude UUID>`. Two guards:

1. The schema rejects `claudeResumeId` when `mode` is anything other than `'claude'`
   (or absent, which defaults to claude). Enforced with a zod `superRefine`.
2. The migration backfills `harnessSessionId` from `claudeResumeId` **only** when the stored
   entry's `mode` is absent or `'claude'`.

**Migration location.** `StateStore.load()` raw-merges JSON and performs no per-session
migration (`state-store.ts:135,150`); the restore path separately copies `claudeResumeId`
into the in-memory session (`server.ts:3462`). The backfill goes in the restore path next to
that copy, and must mark the session dirty so the migrated value is written back — otherwise
it re-runs on every boot.

**`harnessSessionId` is a restore identity, not a general pause identity.** Pause and
`/resume` still go through `transcriptPreflight()` and a
`.claude/projects/<dir>/<claudeResumeId>.jsonl` lookup (`session-routes.ts:593,703,823,840`).
Those paths stay Claude-only and are unreachable for codex/pi because `pausable: false`.
Generalising pause is explicitly out of scope.

**Claude-specific `claudeResumeId` readers stay Claude-specific**, guarded by
`caps.claudeTranscript` where they are not already: transcript watcher setup
(`server.ts:933,989`), transcript fallback endpoint (`session-routes.ts:1480`), history
resume (`history-routes.ts:244,263`), Claude CLI arg building
(`session-cli-builder.ts:64,128`), MCP restart reporting (`mcp-routes.ts:77`).

- `pi` sets `harnessSessionId` to the Codeman session id (it is passed as `--session-id`).
- `codex` discovers its id after start (protocol below).
- `opencode` and `shell` leave it unset, exactly as today.

**Codex identity discovery protocol.** Codex has no flag to preassign a session id, but it
writes a rollout file per session at
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl` (default `CODEX_HOME` is
`~/.codex`). Its first line is a `session_meta` record carrying both `session_id` and `cwd`:

```json
{"timestamp":"...","type":"session_meta","payload":{"session_id":"01a085e9-...","cwd":"/home/siggi/sources/Codeman","cli_version":"0.144.5", ...}}
```

Discovery mirrors the existing Claude approach in `src/web/transcript-path-resolver.ts`:
after `startInteractive()` returns, poll for up to 15s (1s interval) for the newest rollout
file whose `session_meta.payload.cwd` equals the session's `workingDir` **and** whose file
mtime is at or after the recorded session start time. On a match, set `harnessSessionId`
and persist. On timeout, leave it unset, log a warning, and mark the session
non-resumable — the session still runs; only restore-after-reboot is lost. The `cwd` +
start-time pair is what prevents attaching a concurrently-started codex session's id.

### Per-harness config

`OpenCodeConfig` keeps its current name and shape, so existing `state.json` entries load
unchanged with no migration. Two new optional fields are added alongside it on
`SessionConfig` / `SessionState`:

```ts
codexConfig?: { model?: string };
piConfig?: { model?: string };
```

Deliberately *not* unified into a single `harnessConfig` blob: at this config depth the
generalisation buys nothing and would require a state migration.

**`Session` class plumbing.** Declaring the fields on `SessionState` is not enough. `Session`
today stores only `claudeResumeId` (`session.ts:415`) and `_openCodeConfig` (`session.ts:403`),
and its constructor accepts neither codex/pi config nor a harness identity
(`session.ts:452,523`). All three need a private field, a constructor input, a public
accessor, and serialization.

**`Session.toState()` must serialize `codexConfig`, `piConfig`, and `harnessSessionId`**
alongside the existing `openCodeConfig` (`src/session.ts:1074`). Omitting this is silent —
the state store spreads raw JSON, so nothing errors; the config simply vanishes on reload.

Zod schemas in `src/web/schemas.ts` (lines 142, 217, 682, 719) extend their `mode` enums
and gain the two optional config objects.

## 4a. Route and CLI audit

Sites that branch on mode and must be updated. Each was verified against source.

| site | today | required change |
|---|---|---|
| `src/tmux-manager.ts:224` | `buildSpawnCommand` default branch `return '$SHELL'` | **throw** on unknown mode — today an unhandled harness silently launches a shell |
| `src/web/routes/history-routes.ts:245` | `resolvedMode !== 'shell'` assigns Claude's default model | only assign the Claude default when the harness is claude; codex/pi take their own config model or none |
| `src/web/routes/session-routes.ts:730` | pause blocked for `shell \| opencode` | gate on `caps.pausable` — codex/pi are not pausable and must be rejected, not silently accepted and broken |
| `src/web/routes/session-routes.ts:1358` | `mode !== 'opencode'` writes Claude hooks | gate on `caps.claudeHooks` |
| `src/web/routes/worktree-session-routes.ts:334,654` | `resolvedMode === 'shell'` else `startInteractive()` | works structurally, but never validates harness availability and never passes harness config — both must be added. This is the main Codeman worktree pipeline. |
| `src/web/routes/system-routes.ts:241` | `/api/opencode/status` only | generalise to `/api/harness/:id/status`, driven by the registry. Keep the old path as an alias so existing tests and clients keep working. |
| `src/cli.ts:111` | labels only `[shell]` | label every non-claude harness from `shortLabel`, else codex/pi are indistinguishable from claude in `codeman list` |
| `src/web/server.ts:3886` | restore gated on `claudeResumeId` | gate on `harnessSessionId` (see §4) |
| `src/session.ts:1364` | direct-PTY rejection is opencode-only | gate on `caps.requiresMux` |
| `src/session.ts:1261` | Claude parsers / readiness | gate on `caps.claudeParsers` |
| `src/session.ts:1562` | `_processExpensiveParsers` early return | gate on `caps.claudeParsers` |
| `src/web/routes/session-routes.ts:131` | opencode-only availability check | generic registry availability check |
| `src/web/routes/session-routes.ts:145` | `mode !== 'shell'` -> Claude default model | gate on `caps.usesClaudeModelDefaults` |
| `src/web/routes/session-routes.ts:157,1384,1389` | passes only `openCodeConfig` | pass the harness's own config blob |
| `src/web/routes/session-routes.ts:604` | ralph guard | `caps.ralph` |
| `src/web/routes/session-routes.ts:1311,1373` | quick-start availability + model default | registry availability + `caps.usesClaudeModelDefaults` |
| `src/web/routes/ralph-routes.ts:52` | ralph route gate | `caps.ralph` |
| `src/web/routes/respawn-routes.ts:96,250,318` | respawn route gates | `caps.respawn` |
| `src/web/server.ts:1559,1599,3427,3634,3647` | ralph lifecycle/restore gates | `caps.ralph` |
| `src/web/server.ts:1574,3473,3617` | respawn restore/resume gates | `caps.respawn` |
| `src/web/server.ts:1406,1408,1428` | archive/clear child-session model + startup selection | `caps.usesClaudeModelDefaults`, registry startup dispatch |
| `src/tmux-manager.ts:429,435,509,653,693` | create + respawn PATH export and env/config setup know only claude and opencode | driven by `binary`/`searchDirs` and `setupMuxEnv()` from the registry |

**Sites deliberately left alone.** `src/web/public/app.js:10720` and
`src/web/public/keyboard-accessory.js:390` suppress the transcript view with *positive*
`mode === 'claude'` checks. Positive checks are already correct for new harnesses and need
no change. (An earlier draft of this spec cited `app.js:10718`, which is the comment above
the predicate.)

**Latent, not addressed here.** `src/tmux-manager.ts:1367` applies Ink-tuned send-keys
settle delays to every non-shell mode. Those delays already serve opencode's Bubble Tea
TUI, so codex's ratatui and pi are expected to work unchanged. If the manual smoke test
shows dropped or doubled input, a per-harness `sendKeyDelayMs` is the fix; it is not added
pre-emptively.

## 5. UI

`app.js:11454` — `run()` currently dispatches only opencode; every other mode falls through
to `runClaude()`, so codex and pi would launch Claude. `runOpenCode()` (`app.js:11771`) is
already generic apart from three things: the status URL, the install hint, and the config
blob. All three now live in the registry.

Replace both with a single `runHarness(mode)` driven by registry metadata fetched from
`/api/harnesses`. `runClaude()` stays as-is (it carries claude-specific quick-start
behaviour); `runOpenCode()` becomes a thin alias for `runHarness('opencode')` so existing
callers (`app.js:11455`, `:13285`, the welcome button) keep working.

Also:
- `index.html`: two welcome buttons and two run-mode options beside OpenCode's.
- `app.js:10178`: `cx` / `pi` tab badges from `shortLabel`.
- `app.js:11084`: kill-dialog copy is hardcoded to "Kill Tmux & Claude Code" for anything
  that is not opencode; drive it from the harness `label`.
- `app.js:11504`: run-button label is `mode === 'opencode' ? 'Run OC' : 'Run'`; drive from
  `shortLabel`.
- `app.js:12609`: pause-menu eligibility tests `isShell` only, so codex/pi would appear
  pausable; gate on `caps.pausable`.
- `app.js:12938,12960,12967`: options-modal default tab and section visibility are
  claude-vs-opencode; drive from `caps.respawn` / `caps.claudeTranscript`.
- `app.js:13137,13211,13284`: session-creator mode buttons and their opencode-only
  shortcut.
- `app.js:13353`: worktree-creator mode selector.

Button markup stays static — templating five buttons is more machinery than it saves.

## 6. Error handling

- Missing binary: `POST /api/sessions` returns 422 with the harness's `installHint`,
  matching today's opencode behaviour (`session-routes.ts:131`).
- Unsafe model string: silently dropped from the command (existing opencode behaviour),
  not an error.
- `requiresMux` harness with tmux unavailable: throws with the harness label, matching
  today's opencode message (`session.ts:1367`).
- Pause requested on a non-`pausable` harness: 422 naming the harness, replacing today's
  "Only Claude sessions can be paused" (`session-routes.ts:730`).
- Unknown mode reaching `buildSpawnCommand`: throws. Today it silently returns `$SHELL`.

## 7. Testing

- **Registry unit tests** — `buildCommand` for every harness x (fresh / resume / model
  set / model rejected as unsafe).
- **Capability regression test** — assert `claude` and `opencode` capability values equal
  the pre-refactor guard truth table. This is the test that makes the ~30-site refactor
  safe; shell's four changed values are asserted at their new values with a comment
  pointing at §2.
- **Resolver test** — search-dir fallback finds a binary that is not on `/bin/sh`'s PATH
  (the `pi` case).
- **State round-trip test** — `toState()` preserves `codexConfig`, `piConfig`, and
  `harnessSessionId`; a legacy entry with only `claudeResumeId` backfills
  `harnessSessionId` without clobbering anything.
- **Spawn fallback test** — `buildSpawnCommand` throws on an unknown mode rather than
  returning `$SHELL`.
- **Parameterized capability-consumer tests** — the registry-table test proves the *data*;
  these prove each consumer actually reads it. One parameterized suite per capability,
  asserting the guarded behaviour for all five harnesses: ralph (route + lifecycle +
  restore), respawn (route + resume + restore), `claudeParsers`, `claudeTranscript`,
  `requiresMux` direct-PTY rejection, `pausable`, `claudeHooks`, `usesClaudeModelDefaults`,
  across the create / quick-start / worktree / archive paths.
- **Migration test** — backfill applies to a legacy entry with no `mode`, and to `claude`;
  it must NOT apply to a `codex`/`pi` entry that carries a `claudeResumeId`. Asserts the
  migrated value is written back so it does not repeat every boot.
- **Schema test** — `CreateSessionSchema` rejects `claudeResumeId` paired with a non-claude
  mode.
- **Codex discovery test** — `session_meta` matching by `cwd` + start time picks the right
  rollout file, ignores one from another cwd, and times out cleanly to "unset, non-resumable"
  rather than throwing.
- **Live smoke: server restart** — the manual test must restart the Codeman server, not just
  reload the page, since restore-after-reboot is the stated requirement for
  `harnessSessionId`.
- **Live smoke test (manual)** — launch a codex session and a pi session in the worktree's
  Codeman instance; confirm the TUI renders in the web terminal, input reaches the agent,
  and buffer restore survives a page reload. Not automatable; results reported by hand.

## Risks

1. **codex alt-screen.** If `--no-alt-screen` proves insufficient and codex still renders
   in a way `capture-pane` cannot recover, codex sessions will restore blank. Mitigation:
   the manual smoke test covers exactly this; fallback is to mark codex as
   restore-unsupported rather than ship a broken restore.
2. **The 30-site refactor.** Mechanical but broad, spanning `server.ts`,
   `session-routes.ts`, `session.ts`, `respawn-routes.ts`, `ralph-routes.ts`. The
   capability regression test is the guard.
3. **The neutral `harnessSessionId` migration.** Backfilling from `claudeResumeId` on load
   must be idempotent and must not clobber a claude session's existing resume id. Covered
   by a state-store round-trip test.
4. **pi resume semantics.** `--session-id ... creating it if missing` is taken from
   `pi --help`; if in practice it does not resume cleanly, pi drops to
   `preassignsSessionId: false` and resume becomes a stub, as codex's would be.

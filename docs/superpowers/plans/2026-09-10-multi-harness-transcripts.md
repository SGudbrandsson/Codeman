# Multi-Harness Transcript View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Show the web transcript view for `codex` and `pi` sessions, not just `claude`.

**Architecture:** Split the overloaded `claudeTranscript` capability into `transcript` (has a viewable transcript) and `claudeTranscript` (speaks Claude's JSONL/resume/hooks/state machine). Add a per-harness locator+adapter behind the existing harness-neutral `TranscriptBlock` contract, and gate `TranscriptWatcher`'s Claude state machine so it never runs for codex or pi.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` specifiers), Fastify, vitest, vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-09-10-multi-harness-transcripts-design.md` — read it in full before Task 1. It contains the verified record-type mapping tables for both harnesses; do not re-derive them.

## Global Constraints

- Node: brew Node v25 for vitest (better-sqlite3 ABI). **Never run the full vitest suite** — individual files only.
- Full suite has ~115 pre-existing env failures plus 2 known-red files (`server-restore-mux-sessions`, `session-routes` "rejects empty payload"). Compare failure SETS vs master.
- NodeNext ESM: every relative import ends `.js`.
- **THE TRAP:** five of the six `caps.claudeTranscript` sites must NOT change (spec, "consumer inventory"). A blanket rename hands codex/pi the Respawn and Ralph tabs back.
- Adapters must never throw on an unrecognised or malformed line — return `[]`.
- Commit after every task.

---

### Task 1: Split the capability

**Files:** `src/harnesses/types.ts`, all five `src/harnesses/*.ts`, `test/harness-transcript-capability.test.ts`

**Produces:** `HarnessCapabilities.transcript: boolean`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { getHarness } from '../src/harnesses/registry.js';
import type { SessionMode } from '../src/types/session.js';

describe('transcript vs claudeTranscript', () => {
  const expected: Record<string, { transcript: boolean; claudeTranscript: boolean }> = {
    claude:   { transcript: true,  claudeTranscript: true  },
    codex:    { transcript: true,  claudeTranscript: false },
    pi:       { transcript: true,  claudeTranscript: false },
    opencode: { transcript: false, claudeTranscript: false },
    shell:    { transcript: false, claudeTranscript: false },
  };
  for (const [mode, exp] of Object.entries(expected)) {
    it(`${mode}`, () => {
      const c = getHarness(mode as SessionMode).caps;
      expect(c.transcript).toBe(exp.transcript);
      expect(c.claudeTranscript).toBe(exp.claudeTranscript);
    });
  }

  it('keeps codex and pi out of Claude-only subsystems', () => {
    // Regression lock for THE TRAP: transcript must not leak into ralph/respawn.
    for (const m of ['codex', 'pi'] as const) {
      const c = getHarness(m).caps;
      expect(c.ralph).toBe(false);
      expect(c.respawn).toBe(false);
      expect(c.pausable).toBe(false);
    }
  });
});
```

- [ ] **Step 2:** Run `npx vitest run test/harness-transcript-capability.test.ts` — expect FAIL (`transcript` undefined).
- [ ] **Step 3:** Add `transcript: boolean` to `HarnessCapabilities` in `src/harnesses/types.ts` with a doc comment distinguishing it from `claudeTranscript`. Set it in all five harness files per the table.
- [ ] **Step 4:** Run the test — expect PASS.
- [ ] **Step 5:** `npx tsc --noEmit`. Then verify the five untouched sites still read `claudeTranscript`:
  `grep -n claudeTranscript src/web/server.ts src/session.ts src/web/public/app.js` must still show `server.ts:268`, `session.ts:1280,1310,1353,1488`, `app.js:13029`.
- [ ] **Step 6:** Commit `feat(harnesses): split transcript capability from claudeTranscript`.

---

### Task 2: Adapter interface, Claude adapter, `seq`, and `ThinkingBlock`

No behaviour change — the Claude adapter wraps today's parser exactly.

**Files:** `src/harnesses/transcripts/{types,claude,index}.ts`, `src/types/transcript-blocks.ts`, `src/types/index.ts`, `test/transcript-adapter-claude.test.ts`

**Produces:**
```ts
interface TranscriptLocateCtx { workingDir: string; sessionId: string; harnessSessionId?: string }
interface TranscriptAdapter {
  locate(ctx: TranscriptLocateCtx): string | null;
  parseLine(raw: string, seqBase: number): TranscriptBlock[];
}
getTranscriptAdapter(mode: SessionMode): TranscriptAdapter | null
```

- [ ] **Step 1: Write the failing test** — assert the Claude adapter reproduces `parseTranscriptJSONL` block-for-block over a fixture, that every block carries an increasing `seq`, and that a malformed line yields `[]` without throwing.
- [ ] **Step 2:** Run it — expect FAIL (module missing).
- [ ] **Step 3:** Add to `src/types/transcript-blocks.ts`:

```typescript
export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  timestamp: string;
  seq: number;
}
```

Add `seq: number` to `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ResultBlock`, and add `ThinkingBlock` to the `TranscriptBlock` union. Export `ThinkingBlock` from the `src/types/index.ts` barrel at `:68` beside the others — omitting it means barrel consumers cannot import the type.

- [ ] **Step 4:** Create the adapter module. `claude.ts`'s `parseLine` delegates to the existing `parseTranscriptEntry` and stamps `seq`; its `locate` reproduces today's exact order from `transcript-path-resolver.ts` **including** the `<sessionId>.jsonl` fallback at `session-routes.ts:1500-1508`.
- [ ] **Step 5:** Add a shared `assertUnderRoot(candidate, root)` helper used by every locator: resolve symlinks, assert the canonical path is under the harness's root, return null otherwise.
- [ ] **Step 6:** Run tests, `npx tsc --noEmit`, commit.

---

### Task 3: The codex and pi adapters

**Files:** `src/harnesses/transcripts/{codex,pi}.ts`, `test/fixtures/transcripts/{codex,pi}.jsonl`, `test/transcript-adapter-codex.test.ts`, `test/transcript-adapter-pi.test.ts`

Use the mapping tables in the spec verbatim. Build the fixtures by copying **real** lines (redact any secrets) from `~/.codex/sessions/**/rollout-*.jsonl` and `~/.pi/agent/sessions/**/*.jsonl`.

- [ ] **Step 1: Write the failing tests.** Per harness, one case per record type in the spec's table, plus: an unknown record → `[]`; a malformed line → `[]` and no throw; base64 payloads (`encrypted_content`, pi `image`) are **dropped**, asserted by checking no block's serialised form exceeds a few KB.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement `codex.ts`. Envelope is `{type, timestamp, payload}`. `locate` uses `harnessSessionId` to find `$CODEX_HOME/sessions/**/rollout-*-<id>.jsonl`; validate `<id>` as `/^[0-9a-fA-F-]{1,128}$/` before globbing. Filter `response_item/message` with `role: 'developer'` (system prompt) and `response_item/reasoning` (encrypted).
- [ ] **Step 4:** Implement `pi.ts`. Records are `{type:'message', timestamp, message:{role, content[]}}`. Map `toolCall`→`tool_use` (`arguments`→`input`), role `toolResult`→`tool_result`, `thinking`→`ThinkingBlock`, drop `image`. `locate` globs `~/.pi/agent/sessions/<escaped-cwd>/*_<harnessSessionId>.jsonl`, where escaped-cwd replaces every `/` with `-` (verify against a real directory name before relying on it).
- [ ] **Step 5:** Register both in `index.ts`. Run tests, typecheck, commit.

---

### Task 4: Gate the watcher's Claude state machine

**Files:** `src/transcript-watcher.ts`, `src/web/server.ts`, `test/transcript-watcher-harness-isolation.test.ts`

- [ ] **Step 1: Write the failing test** — construct a watcher with `claudeState: false`, feed it codex and pi lines, assert `transcript:block` fires and that `transcript:complete`, `transcript:plan_mode`, `transcript:tool_start`, and `transcript:ask_user_question` never do. Then construct with `claudeState: true`, feed Claude lines, assert all the Claude events still fire exactly as before.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Add a constructor option `{ claudeState: boolean; adapter: TranscriptAdapter }`. **Structural change:** the read loop at `:314-343` currently parses each line into a Claude-typed `TranscriptEntry` before processing. Retain the **raw line** and pass it to `adapter.parseLine(raw, seq)`; build a `TranscriptEntry` only on the Claude path.
- [ ] **Step 4:** Gate behind `claudeState`: `:360-386` (dispatch/state/AskUserQuestion), `:391-395` (Claude parser call), `:398-436` (`handleAssistantEntry`), `:438-450` (`handleResultEntry`), `:452-485` (`checkPlanMode`). The `parseLine` → `emit('transcript:block')` tail stays unconditional.
- [ ] **Step 5:** In `server.ts`, construct with `claudeState: harnessAllowsClaudeTranscript(mode)`. Change the watcher-start gate at `:920` from `claudeTranscript` to `transcript`. Leave the Claude-specific *callers* alone (`hook-event-routes.ts:49`, `server.ts:2015-2033`, `:3750-3806`, `:3978-3983`, `session-routes.ts:847-855`).
- [ ] **Step 6:** Run the isolation test plus `npx vitest run test/transcript-watcher*.test.ts`. Typecheck. Commit.

---

### Task 5: Route wiring and bounded reads

**Files:** `src/web/routes/session-routes.ts` (`:398-414`, `:1493-1530`), `src/web/server.ts` (`getTranscriptPath`, archive `:1368-1445`), `test/transcript-routes-harness.test.ts`

- [ ] **Step 1: Write the failing test** — `GET /api/sessions/:id/transcript` returns blocks for a codex session and for a pi session (fixture files on disk); returns `[]` for shell; `GET /api/sessions/:id/state` returns the same for an archived session via its persisted `transcriptPath`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Route both endpoints and `getTranscriptPath` through `getTranscriptAdapter(session.mode)`. `/state` must keep honouring `sessionState.transcriptPath` for archived sessions, passing it to the adapter's `parseLine` rather than re-locating.
- [ ] **Step 4:** Make `?tail=` read a **bounded byte window** from the end of the file instead of the whole file. Read the last N bytes (N sized from the requested block count, with a floor), discard the first partial line, parse forward. This is the only thing that bounds server memory and CPU for codex rollouts and pi image payloads — dropping base64 in the adapter protects the client but not the server.
- [ ] **Step 5:** Run tests, typecheck, commit.

---

### Task 6: Frontend

**Files:** `src/web/public/app.js` (`:3767-3781`, `:3856-3872`, `:4735-4815`, `:10729`), `src/web/public/keyboard-accessory.js:390`, `test/transcript-ui-harness.test.ts`

- [ ] **Step 1: Write the failing test** — drive the real `app.js`: the transcript toggle is shown for codex and pi and hidden for shell/opencode; **with `caps` empty (pre-`/api/harnesses`) a claude session still shows it**; a `thinking` block renders visible text; two blocks sharing a timestamp both survive the recovery dedup.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Replace the two hard-coded gates:

```javascript
// app.js:10729 and keyboard-accessory.js:390
// caps is empty until /api/harnesses resolves — fall back to the mode test so
// Claude's transcript is not hidden during startup.
const meta = app.harnessMeta(mode);
const hasCaps = meta.caps && Object.keys(meta.caps).length > 0;
const showTranscript = hasCaps ? !!meta.caps.transcript : (!mode || mode === 'claude');
```

- [ ] **Step 4:** Add the `thinking` branch at `:4735-4815`, rendering dimmed and collapsed by default. Without it a thinking block renders as nothing.
- [ ] **Step 5:** Change the recovery dedup at `:3767` from `b.timestamp > lastTs` to a `seq`-based comparison, and the cache identity at `:3856` likewise.
- [ ] **Step 6:** Add the empty state: when the harness has `transcript` but `locate()` found no file, show "No transcript yet — send a message to start the conversation." Neither codex nor pi writes its file until the first submitted turn.
- [ ] **Step 7:** Run tests, commit.

---

### Task 7: Live verification

**Files:** `docs/superpowers/plans/2026-09-10-multi-harness-transcripts-smoke.md`

**Isolation is mandatory.** A dev server on the default `HOME` adopts the user's ~35 live production sessions. Use the recipe proven in the previous smoke run:

```
env -u TMUX HOME=$SCRATCH/home TMUX_TMPDIR=/tmp/cmtx \
  nohup npx tsx src/index.ts web --port 3421 > /tmp/codeman-3421.log 2>&1 &
```
where `$SCRATCH/home` symlinks every entry of the real `$HOME` **except** `.codeman`, which is a fresh empty dir. Confirm `GET /api/status` shows `sessions: []` before proceeding — if it lists `Restored: codeman-*`, kill it immediately.

- [ ] **Step 1:** Start an isolated dev server; confirm 0 adopted sessions.
- [ ] **Step 2:** Codex session — send a turn, confirm the transcript view populates with text and tool calls, and that no thinking appears (encrypted at source).
- [ ] **Step 3:** Pi session — send a turn, confirm text, tool calls, **and thinking** render.
- [ ] **Step 4:** Claude regression — transcript view unchanged, Respawn/Ralph tabs still present.
- [ ] **Step 5:** Confirm codex and pi still show **no** Respawn or Ralph tab (THE TRAP).
- [ ] **Step 6:** Shell + opencode — no transcript toggle.
- [ ] **Step 7:** Record results, commit.

---

### Task 8: Documentation

- [ ] Update `CHANGELOG.md`, `FEATURES.md`, and add a changeset. Note the new `thinking` block type and that codex reasoning is unavailable by design. Commit.

## Self-Review

**Spec coverage.** §1 capability split → Task 1. §2 adapters → Tasks 2, 3. §3 thinking → Tasks 2, 6. §4 watcher gate → Task 4. §4a block identity → Tasks 2, 6. §5 path resolution → Tasks 2, 5. §6 empty state → Task 6. Risk 1 (watcher) → Task 4 Step 1. Risk 2 (adapter drift) → Task 3 Step 1 malformed/unknown cases. Risk 3 (size) → Tasks 3 and 5 Step 4. Risk 4 (path safety) → Task 2 Step 5, Task 3 Step 3.

**Placeholders.** None. Every step names files, lines, and the exact change.

**Type consistency.** `TranscriptAdapter`, `TranscriptLocateCtx`, `getTranscriptAdapter`, `seq`, `ThinkingBlock`, `claudeState` keep the same names and shapes across all tasks.

**Ordering.** Task 4 needs Task 2's adapter type; Task 5 needs Task 3's adapters; Task 6 needs Task 2's `seq`. The order reflects this.

# Harness Registry + Codex & Pi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Codeman's ad-hoc `mode !== 'opencode'` guards with a capability-based harness registry, then add `codex` and `pi` as session harnesses on top of it.

**Architecture:** A new `src/harnesses/` module owns one `HarnessDefinition` per session mode — binary resolution, spawn-command construction, tmux env setup, TUI readiness, and a nine-flag capability set. Every site that currently branches on the string `'opencode'` instead reads a capability. Tasks 1–2 land the registry with today's three harnesses and no new modes, so the refactor is validated against existing behaviour before any new harness exists; Tasks 3–9 add codex and pi on top.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Fastify, zod, vitest, tmux, xterm.js, vanilla JS frontend (`src/web/public/app.js`).

**Spec:** `docs/superpowers/specs/2026-09-09-harness-registry-design.md`

## Global Constraints

- **Node:** use brew Node v25 on PATH for vitest — `better-sqlite3` has an ABI mismatch on system Node v22.
- **NEVER run the full vitest suite from inside a Codeman session** — it crashes tmux. Run individual test files only: `npx vitest run test/<file>.test.ts`.
- The full suite has ~115 pre-existing environment failures. Never compare against zero; compare the failure **set** against master.
- **Imports:** NodeNext ESM. Every relative import ends in `.js`, even when the source file is `.ts`.
- **Binary versions this targets:** codex `0.144.5`, pi `0.85.1` (`@earendil-works/pi-coding-agent`).
- **`pi` lives at `~/.npm-global/bin/pi`**, which is NOT on the `/bin/sh` PATH that `execSync('which pi')` sees. `~/.npm-global/bin` must be in pi's `searchDirs`.
- **No behaviour change for `claude` or `opencode`.** The only intentional behaviour change in Tasks 1–2 is for `shell` (see Task 2).
- **Shell-command safety:** spawn commands are built as shell strings. Never interpolate an unvalidated value. Model strings are validated against a regex and **dropped** (not escaped, not errored) when they fail.
- Commit after every task. Conventional-commit prefixes (`feat:`, `refactor:`, `test:`, `fix:`, `docs:`).

---

### Task 1: Registry scaffolding — types, resolver, and the three existing harnesses

Creates the registry with `claude`, `shell`, and `opencode` only. Nothing consumes it yet, so this task cannot change behaviour. Its test locks in the capability truth table that Task 2 refactors against.

**Files:**
- Create: `src/harnesses/types.ts`
- Create: `src/harnesses/resolver.ts`
- Create: `src/harnesses/claude.ts`
- Create: `src/harnesses/shell.ts`
- Create: `src/harnesses/opencode.ts`
- Create: `src/harnesses/registry.ts`
- Test: `test/harness-registry.test.ts`

**Interfaces:**
- Consumes: `SessionMode`, `ClaudeMode`, `OpenCodeConfig` from `../types/session.js`.
- Produces:
  - `interface HarnessCapabilities` — 9 boolean flags (listed in Step 3).
  - `interface HarnessSpawnContext { sessionId: string; mode: SessionMode; model?: string; claudeMode?: ClaudeMode; allowedTools?: string; openCodeConfig?: OpenCodeConfig; codexConfig?: HarnessModelConfig; piConfig?: HarnessModelConfig; extraArgs?: string[]; harnessSessionId?: string }`
  - `interface HarnessModelConfig { model?: string }`
  - `interface HarnessDefinition { id; label; shortLabel; binary; searchDirs; installHint; buildCommand(ctx): string; setupMuxEnv?(muxName, ctx): void; readiness; caps }`
  - `type HarnessReadiness = { kind: 'prompt' } | { kind: 'settle'; ms: number }`
  - `getHarness(mode: SessionMode): HarnessDefinition` — throws on unknown mode.
  - `listHarnesses(): HarnessDefinition[]`
  - `resolveHarnessDir(binary: string, searchDirs: string[]): string | null` — cached.
  - `isHarnessAvailable(def: HarnessDefinition): boolean`
  - `MODEL_PATTERN: RegExp` — `/^[a-zA-Z0-9._\-/:]+$/`

- [ ] **Step 1: Write the failing test**

Create `test/harness-registry.test.ts`:

```typescript
/**
 * @fileoverview Tests for the harness registry.
 *
 * The capability table test is the safety net for the guard refactor in Task 2:
 * it pins the exact truth values every `mode !== 'opencode'` guard used to produce,
 * so a refactor that changes claude or opencode behaviour fails loudly.
 */

import { describe, it, expect } from 'vitest';
import { getHarness, listHarnesses } from '../src/harnesses/registry.js';
import type { SessionMode } from '../src/types/session.js';

describe('harness registry', () => {
  it('exposes exactly the three existing harnesses', () => {
    expect(listHarnesses().map((h) => h.id).sort()).toEqual(['claude', 'opencode', 'shell']);
  });

  it('throws on an unknown mode rather than falling back to a shell', () => {
    expect(() => getHarness('nope' as SessionMode)).toThrow(/unknown harness/i);
  });

  describe('capability table', () => {
    // Pins today's behaviour. claude and opencode reproduce the pre-refactor guards
    // exactly. shell's four Claude-only flags are FALSE here but were effectively
    // TRUE before the refactor, because the old guards read `mode !== 'opencode'`.
    // See spec section 2.
    const expected: Record<string, Record<string, boolean>> = {
      claude: {
        ralph: true, respawn: true, claudeTranscript: true, claudeParsers: true,
        requiresMux: false, preassignsSessionId: true, pausable: true,
        claudeHooks: true, usesClaudeModelDefaults: true,
      },
      opencode: {
        ralph: false, respawn: false, claudeTranscript: false, claudeParsers: false,
        requiresMux: true, preassignsSessionId: false, pausable: false,
        claudeHooks: false, usesClaudeModelDefaults: false,
      },
      shell: {
        ralph: false, respawn: false, claudeTranscript: false, claudeParsers: false,
        requiresMux: false, preassignsSessionId: false, pausable: false,
        claudeHooks: false, usesClaudeModelDefaults: false,
      },
    };

    for (const [mode, caps] of Object.entries(expected)) {
      it(`${mode} has the expected capabilities`, () => {
        expect(getHarness(mode as SessionMode).caps).toEqual(caps);
      });
    }
  });

  describe('buildCommand', () => {
    it('builds a claude command with session id and disallowed tools', () => {
      const cmd = getHarness('claude').buildCommand({
        sessionId: 'abc-123', mode: 'claude', claudeMode: 'dangerously-skip-permissions',
      });
      expect(cmd).toContain('claude');
      expect(cmd).toContain('--dangerously-skip-permissions');
      expect(cmd).toContain('--session-id "abc-123"');
      expect(cmd).toContain('--disallowedTools AskUserQuestion');
    });

    it('omits --session-id when resuming, which the claude CLI rejects', () => {
      const cmd = getHarness('claude').buildCommand({
        sessionId: 'abc-123', mode: 'claude', extraArgs: ['--resume', 'uuid-1'],
      });
      expect(cmd).not.toContain('--session-id');
      expect(cmd).toContain('--resume');
    });

    it('drops an unsafe model string instead of interpolating it', () => {
      const cmd = getHarness('claude').buildCommand({
        sessionId: 'abc-123', mode: 'claude', model: 'opus; rm -rf /',
      });
      expect(cmd).not.toContain('rm -rf');
      expect(cmd).not.toContain('--model');
    });

    it('builds an opencode command with a provider/model pair', () => {
      const cmd = getHarness('opencode').buildCommand({
        sessionId: 'x', mode: 'opencode', openCodeConfig: { model: 'anthropic/claude-sonnet-4-5' },
      });
      expect(cmd).toBe('opencode --model anthropic/claude-sonnet-4-5');
    });

    it('builds a shell command', () => {
      expect(getHarness('shell').buildCommand({ sessionId: 'x', mode: 'shell' })).toBe('$SHELL');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/harness-registry.test.ts`
Expected: FAIL — `Cannot find module '../src/harnesses/registry.js'`.

- [ ] **Step 3: Create `src/harnesses/types.ts`**

```typescript
/**
 * @fileoverview Types describing a Codeman session harness (the CLI backend a
 * session runs). One HarnessDefinition per SessionMode; see registry.ts.
 *
 * @module harnesses/types
 */

import type { ClaudeMode, OpenCodeConfig, SessionMode } from '../types/session.js';

/** Minimal per-harness config: the only knob codex and pi expose is the model. */
export interface HarnessModelConfig {
  model?: string;
}

/**
 * Feature flags describing what Codeman subsystems apply to a harness.
 *
 * These replace the ad-hoc `session.mode !== 'opencode'` guards, which actually
 * meant "this is a Claude-only feature" but read as "anything but opencode" —
 * and so were silently true for shell sessions too.
 */
export interface HarnessCapabilities {
  /** Ralph / todo loop tracker is meaningful for this harness. */
  ralph: boolean;
  /** Respawn controller may be armed for this harness. */
  respawn: boolean;
  /** Harness writes Claude-format transcript JSONL (transcript view, claudeResumeId). */
  claudeTranscript: boolean;
  /** Terminal output can be fed to Claude-specific parsers (BashToolParser, tokens, CLI info). */
  claudeParsers: boolean;
  /** Harness cannot run under a direct PTY; requires tmux for env injection / TUI. */
  requiresMux: boolean;
  /** Harness accepts a caller-chosen session id, so Codeman's own id can be reused. */
  preassignsSessionId: boolean;
  /** Session may be paused/parked. Requires a resumable Claude transcript today. */
  pausable: boolean;
  /** Claude-format hooks (.claude/settings.local.json) apply to this harness's cases. */
  claudeHooks: boolean;
  /** The global Claude default model applies to this harness. */
  usesClaudeModelDefaults: boolean;
}

/** Everything buildCommand needs to construct a spawn command string. */
export interface HarnessSpawnContext {
  sessionId: string;
  mode: SessionMode;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
  codexConfig?: HarnessModelConfig;
  piConfig?: HarnessModelConfig;
  extraArgs?: string[];
  /** Harness-native id to resume, when the harness supports resuming. */
  harnessSessionId?: string;
}

/**
 * How to decide a freshly started harness is ready.
 * - 'prompt': watch for the CLI's prompt marker (Claude's ❯), then clear the buffer.
 * - 'settle': full-screen TUI with no prompt marker; wait a fixed period, keep the buffer.
 */
export type HarnessReadiness = { kind: 'prompt' } | { kind: 'settle'; ms: number };

export interface HarnessDefinition {
  id: SessionMode;
  /** Human-readable name, used in UI copy and error messages. e.g. 'Codex'. */
  label: string;
  /** Two-character tab badge. e.g. 'cx'. */
  shortLabel: string;
  /** Binary to resolve on PATH, or null for shell (which uses $SHELL). */
  binary: string | null;
  /** Fallback directories searched when `which <binary>` finds nothing. */
  searchDirs: string[];
  /** Shown to the user when the binary is missing. */
  installHint: string;
  buildCommand(ctx: HarnessSpawnContext): string;
  /** Optional tmux `setenv` work performed after session creation (API keys, config JSON). */
  setupMuxEnv?(muxName: string, ctx: HarnessSpawnContext): void;
  readiness: HarnessReadiness;
  caps: HarnessCapabilities;
}
```

- [ ] **Step 4: Create `src/harnesses/resolver.ts`**

```typescript
/**
 * @fileoverview Generic harness binary resolution.
 *
 * Replaces the duplicated `which`-then-search-dirs logic that lived separately in
 * utils/claude-cli-resolver.ts and utils/opencode-cli-resolver.ts.
 *
 * @module harnesses/resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import type { HarnessDefinition } from './types.js';

/** Cache: binary name -> containing dir. Empty string means "searched, not found". */
const _cache = new Map<string, string>();

/**
 * Find the directory containing `binary`.
 * Tries `which` first (respects the current PATH), then the supplied fallbacks.
 *
 * Note: `execSync` runs under /bin/sh, whose PATH is narrower than an interactive
 * shell's. A binary installed somewhere like ~/.npm-global/bin will NOT be found by
 * `which` here — that is exactly what searchDirs is for.
 */
export function resolveHarnessDir(binary: string, searchDirs: string[]): string | null {
  const cached = _cache.get(binary);
  if (cached !== undefined) return cached || null;

  try {
    const result = execSync(`which ${binary}`, { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }).trim();
    if (result && existsSync(result)) {
      const dir = dirname(result);
      _cache.set(binary, dir);
      return dir;
    }
  } catch {
    // Not on /bin/sh's PATH — fall through to the explicit search dirs.
  }

  for (const dir of searchDirs) {
    if (existsSync(join(dir, binary))) {
      _cache.set(binary, dir);
      return dir;
    }
  }

  _cache.set(binary, '');
  return null;
}

/** True when the harness needs no binary (shell) or its binary resolves. */
export function isHarnessAvailable(def: HarnessDefinition): boolean {
  if (!def.binary) return true;
  return resolveHarnessDir(def.binary, def.searchDirs) !== null;
}

/** Test-only: drop the resolution cache. */
export function _clearResolverCache(): void {
  _cache.clear();
}
```

- [ ] **Step 5: Create the three harness definitions**

`src/harnesses/claude.ts` — the command body is moved verbatim from the `options.mode === 'claude'` branch of `buildSpawnCommand` in `src/tmux-manager.ts:205-222`, so behaviour is identical:

```typescript
/**
 * @fileoverview The Claude Code harness definition.
 * @module harnesses/claude
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeMode } from '../types/session.js';
import type { HarnessDefinition, HarnessSpawnContext } from './types.js';

/** Model strings safe to interpolate into a shell command. */
export const MODEL_PATTERN = /^[a-zA-Z0-9._\-/:]+$/;

/** Claude's own model flag is stricter — no slashes or colons. */
const CLAUDE_MODEL_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Build Claude's permission flags. Moved verbatim from tmux-manager. */
function buildClaudePermissionFlags(claudeMode?: ClaudeMode, allowedTools?: string): string {
  switch (claudeMode) {
    case 'dangerously-skip-permissions':
      return ' --dangerously-skip-permissions';
    case 'allowedTools': {
      if (allowedTools) {
        const hasDangerousChars = /[;&|`$(){}[\]<>\\'"]/.test(allowedTools);
        if (!hasDangerousChars) return ` --allowedTools "${allowedTools}"`;
      }
      return '';
    }
    case 'normal':
    default:
      return '';
  }
}

export const claudeHarness: HarnessDefinition = {
  id: 'claude',
  label: 'Claude Code',
  shortLabel: 'cc',
  binary: 'claude',
  searchDirs: [
    join(homedir(), '.claude', 'local'),
    join(homedir(), '.local', 'bin'),
    '/usr/local/bin',
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), 'bin'),
  ],
  installHint: 'Claude CLI not found. Install from https://claude.com/claude-code',
  readiness: { kind: 'prompt' },
  caps: {
    ralph: true,
    respawn: true,
    claudeTranscript: true,
    claudeParsers: true,
    requiresMux: false,
    preassignsSessionId: true,
    pausable: true,
    claudeHooks: true,
    usesClaudeModelDefaults: true,
  },
  buildCommand(ctx: HarnessSpawnContext): string {
    const safeModel = ctx.model && CLAUDE_MODEL_PATTERN.test(ctx.model) ? ctx.model : undefined;
    const modelFlag = safeModel ? ` --model ${safeModel}` : '';
    const extra = (ctx.extraArgs ?? []).map((a) => JSON.stringify(a)).join(' ');
    const extraStr = extra ? ` ${extra}` : '';
    // --session-id is only valid for fresh sessions; the Claude CLI rejects
    // --session-id together with --resume unless --fork-session is also passed
    // (which branches the conversation — not what a plain resume wants).
    const isResuming = (ctx.extraArgs ?? []).includes('--resume');
    const sessionIdFlag = isResuming ? '' : ` --session-id "${ctx.sessionId}"`;
    // AskUserQuestion is disabled for every Codeman claude session: its interactive
    // picker never renders in the web transcript, so Claude asks as plain text instead.
    const disallowFlag = ' --disallowedTools AskUserQuestion';
    const perms = buildClaudePermissionFlags(ctx.claudeMode, ctx.allowedTools);
    return `claude${perms}${sessionIdFlag}${modelFlag}${disallowFlag}${extraStr}`;
  },
};
```

`src/harnesses/shell.ts`:

```typescript
/**
 * @fileoverview The plain-shell harness definition (no agent).
 * @module harnesses/shell
 */

import type { HarnessDefinition } from './types.js';

export const shellHarness: HarnessDefinition = {
  id: 'shell',
  label: 'Shell',
  shortLabel: 'sh',
  binary: null,
  searchDirs: [],
  installHint: '',
  readiness: { kind: 'prompt' },
  // Every Claude-only capability is false. Before the registry these guards read
  // `mode !== 'opencode'`, which was true for shell — so shell was given a ralph
  // tracker, a restorable respawn controller, and the Claude output parsers. That
  // was never intended; see spec section 2.
  caps: {
    ralph: false,
    respawn: false,
    claudeTranscript: false,
    claudeParsers: false,
    requiresMux: false,
    preassignsSessionId: false,
    pausable: false,
    claudeHooks: false,
    usesClaudeModelDefaults: false,
  },
  buildCommand(): string {
    return '$SHELL';
  },
};
```

`src/harnesses/opencode.ts` — `buildCommand` is moved verbatim from `buildOpenCodeCommand` (`src/tmux-manager.ts:174-190`), and `setupMuxEnv` from `setOpenCodeEnvVars` + `setOpenCodeConfigContent` (`src/tmux-manager.ts:232-292`). Move those three function bodies across unchanged; do not rewrite them. `searchDirs` is copied from `OPENCODE_SEARCH_DIRS` in `src/utils/opencode-cli-resolver.ts:17-25`. Capabilities: every flag `false` except `requiresMux: true`.

- [ ] **Step 6: Create `src/harnesses/registry.ts`**

```typescript
/**
 * @fileoverview The harness registry: one HarnessDefinition per SessionMode.
 *
 * Adding a harness means adding a file here and a row in HARNESSES. Sites that
 * used to branch on the literal 'opencode' read `getHarness(mode).caps.<flag>`.
 *
 * @module harnesses/registry
 */

import type { SessionMode } from '../types/session.js';
import type { HarnessDefinition } from './types.js';
import { claudeHarness } from './claude.js';
import { shellHarness } from './shell.js';
import { openCodeHarness } from './opencode.js';

const HARNESSES: Partial<Record<SessionMode, HarnessDefinition>> = {
  claude: claudeHarness,
  shell: shellHarness,
  opencode: openCodeHarness,
};

/**
 * Look up a harness. Throws on an unknown mode.
 *
 * Throwing is deliberate: buildSpawnCommand used to fall through to `return '$SHELL'`,
 * so an unhandled mode silently launched a shell instead of the requested agent.
 */
export function getHarness(mode: SessionMode): HarnessDefinition {
  const def = HARNESSES[mode];
  if (!def) throw new Error(`Unknown harness mode: ${String(mode)}`);
  return def;
}

export function listHarnesses(): HarnessDefinition[] {
  return Object.values(HARNESSES) as HarnessDefinition[];
}

export { isHarnessAvailable, resolveHarnessDir } from './resolver.js';
export type { HarnessDefinition, HarnessCapabilities, HarnessSpawnContext } from './types.js';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/harness-registry.test.ts`
Expected: PASS, all cases.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/harnesses test/harness-registry.test.ts
git commit -m "feat(harnesses): add capability-based harness registry

Introduces src/harnesses/ with one definition per session mode, covering
binary resolution, spawn-command construction, tmux env setup, readiness,
and a nine-flag capability set. Nothing consumes it yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Route every mode guard through the registry

Replaces ~30 `mode !== 'opencode'` / `mode === 'opencode'` guards with capability reads. Behaviour is unchanged for `claude` and `opencode`; `shell` stops receiving four Claude-only subsystems.

**Files:**
- Modify: `src/tmux-manager.ts` — `buildSpawnCommand` (:194-225), PATH export + env setup (:429-441, :507-512), respawn path (:643-696)
- Modify: `src/session.ts` — readiness (:1305-1325), direct-PTY rejection (:1364-1368), parsers (:1562-1566), mode label (:1186)
- Modify: `src/web/server.ts` — ralph (:1559, :1599, :3427, :3634, :3647), respawn (:1574, :3473, :3617)
- Modify: `src/web/routes/ralph-routes.ts:52`
- Modify: `src/web/routes/respawn-routes.ts:96,250,318`
- Modify: `src/web/routes/session-routes.ts:604,730,1358`
- Test: `test/harness-capability-consumers.test.ts`

**Interfaces:**
- Consumes: `getHarness` from `../harnesses/registry.js` (Task 1).
- Produces: no new exports. `buildSpawnCommand` in `tmux-manager.ts` becomes a thin wrapper that delegates to `getHarness(mode).buildCommand(ctx)` and no longer has a `$SHELL` fallback.

- [ ] **Step 1: Write the failing test**

Create `test/harness-capability-consumers.test.ts`:

```typescript
/**
 * @fileoverview Proves each capability consumer actually reads the registry,
 * rather than merely proving the registry's data is correct.
 */

import { describe, it, expect } from 'vitest';
import { getHarness } from '../src/harnesses/registry.js';
import { buildSpawnCommand } from '../src/tmux-manager.js';
import type { SessionMode } from '../src/types/session.js';

describe('buildSpawnCommand delegates to the registry', () => {
  it('throws on an unknown mode instead of silently launching a shell', () => {
    expect(() =>
      buildSpawnCommand({ mode: 'codex' as SessionMode, sessionId: 'x' })
    ).toThrow(/unknown harness/i);
  });

  it('produces the same claude command the registry does', () => {
    const ctx = { mode: 'claude' as SessionMode, sessionId: 'sid-1', claudeMode: 'normal' as const };
    expect(buildSpawnCommand(ctx)).toBe(getHarness('claude').buildCommand({ ...ctx }));
  });

  it('still returns $SHELL for shell mode', () => {
    expect(buildSpawnCommand({ mode: 'shell' as SessionMode, sessionId: 'x' })).toBe('$SHELL');
  });
});

describe('shell loses the Claude-only subsystems it used to receive', () => {
  // Regression lock for the one intentional behaviour change in this refactor.
  // The old guards read `mode !== 'opencode'`, which was true for shell.
  it.each(['ralph', 'respawn', 'claudeTranscript', 'claudeParsers'] as const)(
    'shell.caps.%s is false',
    (cap) => {
      expect(getHarness('shell').caps[cap]).toBe(false);
    }
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/harness-capability-consumers.test.ts`
Expected: FAIL — `buildSpawnCommand` is not exported, and it returns `'$SHELL'` for an unknown mode instead of throwing.

- [ ] **Step 3: Rewrite `buildSpawnCommand` in `src/tmux-manager.ts`**

Export it, and replace the whole body (currently `src/tmux-manager.ts:194-225`) with:

```typescript
/**
 * Build the spawn command for a session mode by delegating to its harness.
 *
 * Exported for tests. Throws on an unknown mode — the previous implementation
 * fell through to `return '$SHELL'`, so a harness nobody had wired up would
 * silently start a bare shell instead.
 */
export function buildSpawnCommand(options: HarnessSpawnContext): string {
  return getHarness(options.mode).buildCommand(options);
}
```

Delete the now-dead `buildOpenCodeCommand` and `buildClaudePermissionFlags` from `tmux-manager.ts` (their bodies moved into the harness files in Task 1). Replace the two `mode === 'opencode'` PATH-export branches (`:435`, `:656`) with a registry lookup:

```typescript
const def = getHarness(mode);
let pathExport = '';
if (def.binary) {
  const dir = resolveHarnessDir(def.binary, def.searchDirs);
  if (!dir) throw new Error(def.installHint);
  pathExport = `export PATH="${dir}:$PATH" && `;
}
```

Replace the two `if (mode === 'opencode') { setOpenCodeEnvVars(...); setOpenCodeConfigContent(...); }` blocks (`:509`, `:693`) with:

```typescript
def.setupMuxEnv?.(muxName, spawnContext);
```

- [ ] **Step 4: Replace the guards in the remaining files**

Each replacement is mechanical. In every file, add the import:

```typescript
import { getHarness } from '../harnesses/registry.js'; // adjust depth per file
```

Then apply, one site at a time:

| file:line | from | to |
|---|---|---|
| `src/session.ts:1364` | `if (this.mode === 'opencode')` | `if (getHarness(this.mode).caps.requiresMux)` |
| `src/session.ts:1562` | `if (this.mode === 'opencode') return;` | `if (!getHarness(this.mode).caps.claudeParsers) return;` |
| `src/session.ts:1314` | `if (this.mode === 'opencode')` | `if (getHarness(this.mode).readiness.kind === 'settle')` — and use `readiness.ms` in place of the hardcoded `3000` |
| `src/session.ts:1186` | `this.mode === 'opencode' ? 'OpenCode' : 'Claude'` | `getHarness(this.mode).label` |
| `src/web/server.ts:1559,1599,3427,3634,3647` | `session.mode !== 'opencode'` | `getHarness(session.mode).caps.ralph` |
| `src/web/server.ts:1574,3473,3617` | `session.mode !== 'opencode'` | `getHarness(session.mode).caps.respawn` |
| `src/web/routes/ralph-routes.ts:52` | `session.mode === 'opencode'` | `!getHarness(session.mode).caps.ralph` |
| `src/web/routes/respawn-routes.ts:96,250,318` | `session.mode === 'opencode'` | `!getHarness(session.mode).caps.respawn` |
| `src/web/routes/session-routes.ts:604` | `session.mode !== 'opencode'` | `getHarness(session.mode).caps.ralph` |
| `src/web/routes/session-routes.ts:730` | `session.mode === 'shell' \|\| session.mode === 'opencode'` | `!getHarness(session.mode).caps.pausable` |
| `src/web/routes/session-routes.ts:1358` | `mode !== 'opencode'` | `getHarness(mode ?? 'claude').caps.claudeHooks` |

Update the error copy at `session-routes.ts:730-731` from `'Only Claude sessions can be paused'` to use the harness label:

```typescript
if (!getHarness(session.mode).caps.pausable) {
  return createErrorResponse(
    ApiErrorCode.OPERATION_FAILED,
    `${getHarness(session.mode).label} sessions cannot be paused`
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/harness-capability-consumers.test.ts test/harness-registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the neighbouring existing suites and compare against master**

Run: `npx vitest run test/session-cli-builder.test.ts test/claude-resume-id-update.test.ts test/session-state.test.ts test/cli-commands.test.ts`
Expected: the same pass/fail set as on master. If a test newly fails, it is a real regression — fix it before committing.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/harnesses src/tmux-manager.ts src/session.ts`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add -A src test
git commit -m "refactor(harnesses): read mode guards from the harness registry

Replaces ~30 \`mode !== 'opencode'\` guards with capability reads. No change
for claude or opencode. Shell sessions stop receiving the ralph tracker,
respawn controller, and Claude output parsers, which the old negative guards
gave them unintentionally.

buildSpawnCommand now throws on an unknown mode instead of returning \$SHELL.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Neutral harness session identity

Adds `harnessSessionId` so restore-after-reboot stops depending on Claude's `claudeResumeId`, plus the `codexConfig` / `piConfig` fields and the schema guard that makes the backfill safe. No new modes yet.

**Files:**
- Modify: `src/types/session.ts` — `SessionState` and `SessionConfig` (around :221-231)
- Modify: `src/session.ts` — private field (:403 area), constructor input (:452-525), accessor, `toState()` (:1074)
- Modify: `src/web/server.ts:3462` — restore-path backfill
- Modify: `src/web/schemas.ts:140-154` — `CreateSessionSchema.superRefine`
- Test: `test/harness-session-identity.test.ts`

**Interfaces:**
- Consumes: `getHarness` (Task 1).
- Produces:
  - `SessionState.harnessSessionId?: string`, `SessionState.codexConfig?: HarnessModelConfig`, `SessionState.piConfig?: HarnessModelConfig` (same three on `SessionConfig`).
  - `Session.harnessSessionId: string | undefined` — public read/write accessor, mirrors `claudeResumeId`.
  - `backfillHarnessSessionId(state: SessionState): boolean` exported from `src/web/server.ts` — returns true when it mutated, so the caller knows to persist.

- [ ] **Step 1: Write the failing test**

Create `test/harness-session-identity.test.ts`:

```typescript
/**
 * @fileoverview Tests for the neutral harnessSessionId identity and its migration.
 */

import { describe, it, expect } from 'vitest';
import { backfillHarnessSessionId } from '../src/web/server.js';
import { CreateSessionSchema } from '../src/web/schemas.js';
import type { SessionState } from '../src/types/session.js';

const base = (over: Partial<SessionState>): SessionState =>
  ({ id: 's1', name: 'n', workingDir: '/tmp', status: 'idle', ...over }) as SessionState;

describe('backfillHarnessSessionId', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';

  it('backfills a legacy entry that has no mode at all', () => {
    const s = base({ claudeResumeId: uuid });
    expect(backfillHarnessSessionId(s)).toBe(true);
    expect(s.harnessSessionId).toBe(uuid);
  });

  it('backfills an explicit claude entry', () => {
    const s = base({ mode: 'claude', claudeResumeId: uuid });
    expect(backfillHarnessSessionId(s)).toBe(true);
    expect(s.harnessSessionId).toBe(uuid);
  });

  it('does NOT backfill a non-claude entry that carries a claudeResumeId', () => {
    // Otherwise a codex session would later run `codex resume <Claude UUID>`.
    const s = base({ mode: 'opencode', claudeResumeId: uuid });
    expect(backfillHarnessSessionId(s)).toBe(false);
    expect(s.harnessSessionId).toBeUndefined();
  });

  it('does not clobber an existing harnessSessionId', () => {
    const s = base({ mode: 'claude', claudeResumeId: uuid, harnessSessionId: 'already-set' });
    expect(backfillHarnessSessionId(s)).toBe(false);
    expect(s.harnessSessionId).toBe('already-set');
  });

  it('is a no-op when there is nothing to migrate', () => {
    const s = base({ mode: 'claude' });
    expect(backfillHarnessSessionId(s)).toBe(false);
  });
});

describe('CreateSessionSchema rejects a mismatched resume id', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';

  it('accepts claudeResumeId with mode claude', () => {
    expect(CreateSessionSchema.safeParse({ mode: 'claude', claudeResumeId: uuid }).success).toBe(true);
  });

  it('accepts claudeResumeId with no mode (defaults to claude)', () => {
    expect(CreateSessionSchema.safeParse({ claudeResumeId: uuid }).success).toBe(true);
  });

  it('rejects claudeResumeId paired with a non-claude mode', () => {
    const r = CreateSessionSchema.safeParse({ mode: 'opencode', claudeResumeId: uuid });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/harness-session-identity.test.ts`
Expected: FAIL — `backfillHarnessSessionId` is not exported.

- [ ] **Step 3: Add the fields to `src/types/session.ts`**

Next to `claudeResumeId` (`:228`), inside both `SessionState` and `SessionConfig`:

```typescript
/**
 * Harness-native session id used to resume this session, for any harness.
 *
 * Claude sets this alongside claudeResumeId (which stays, since it is also the
 * transcript filename and a tmux-recovery match key). pi sets it to the Codeman
 * session id. codex discovers it after start. opencode and shell leave it unset.
 */
harnessSessionId?: string;
/** Codex-specific configuration (only for mode === 'codex') */
codexConfig?: HarnessModelConfig;
/** Pi-specific configuration (only for mode === 'pi') */
piConfig?: HarnessModelConfig;
```

Import `HarnessModelConfig` from `../harnesses/types.js`.

- [ ] **Step 4: Plumb the fields through `Session`**

In `src/session.ts`: add `private _codexConfig`, `private _piConfig`, and `harnessSessionId?: string` beside the existing `_openCodeConfig` (`:403`) and `claudeResumeId` (`:415`); accept all three in the constructor options block (`:452-471`) and assign them next to the existing `openCodeConfig` assignment (`:523-525`); and add them to `toState()` (`:1074`) using the same conditional-spread style already used there:

```typescript
openCodeConfig: this._openCodeConfig,
...(this._codexConfig !== undefined && { codexConfig: this._codexConfig }),
...(this._piConfig !== undefined && { piConfig: this._piConfig }),
...(this.harnessSessionId !== undefined && { harnessSessionId: this.harnessSessionId }),
```

- [ ] **Step 5: Add the migration to `src/web/server.ts`**

Export the helper, and call it in the restore path immediately before the existing `claudeResumeId` copy at `:3462`:

```typescript
/**
 * Backfill the neutral harnessSessionId from a legacy claudeResumeId.
 *
 * Only legacy Claude entries qualify — an entry with an explicit non-claude mode
 * may carry a claudeResumeId (the create schema allowed it before this release),
 * and copying that into harnessSessionId would make a codex session try to resume
 * a Claude UUID.
 *
 * @returns true when the state was mutated and must be written back. Callers MUST
 *   persist on true, or the migration re-runs on every boot.
 */
export function backfillHarnessSessionId(state: SessionState): boolean {
  if (state.harnessSessionId) return false;
  if (!state.claudeResumeId) return false;
  if (state.mode !== undefined && state.mode !== 'claude') return false;
  state.harnessSessionId = state.claudeResumeId;
  return true;
}
```

At the call site:

```typescript
if (backfillHarnessSessionId(savedState)) {
  this.store.updateSession(savedState.id, { harnessSessionId: savedState.harnessSessionId });
}
if (savedState.claudeResumeId !== undefined) {
  session.claudeResumeId = savedState.claudeResumeId;
}
session.harnessSessionId = savedState.harnessSessionId;
```

- [ ] **Step 6: Guard the schema in `src/web/schemas.ts`**

Append to `CreateSessionSchema` (`:140-154`):

```typescript
.superRefine((val, ctx) => {
  // claudeResumeId is a Claude conversation UUID. Pairing it with another harness
  // would resume the wrong thing — reject rather than silently ignore it.
  if (val.claudeResumeId && val.mode !== undefined && val.mode !== 'claude') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['claudeResumeId'],
      message: 'claudeResumeId is only valid for claude sessions',
    });
  }
});
```

- [ ] **Step 7: Change the restore gate at `src/web/server.ts:3886`**

```typescript
if (wasRunning && !savedState.paused && session.harnessSessionId && getHarness(session.mode).caps.claudeTranscript) {
```

Keep the `claudeTranscript` capability in the condition for now — Task 5 relaxes it once codex and pi can actually resume.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/harness-session-identity.test.ts test/harness-registry.test.ts test/claude-resume-id-update.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
npx tsc --noEmit
git add -A src test
git commit -m "feat(sessions): add neutral harnessSessionId identity

Restore no longer depends on Claude's claudeResumeId. Adds codexConfig and
piConfig, serializes all three from toState(), and migrates legacy entries —
only those with mode absent or 'claude', so a stray claudeResumeId on another
harness can never become its resume id. The create schema now rejects that
pairing outright.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Add the codex and pi harnesses

**Files:**
- Create: `src/harnesses/codex.ts`
- Create: `src/harnesses/pi.ts`
- Modify: `src/harnesses/registry.ts` — two rows
- Modify: `src/types/session.ts:72` — `SessionMode` union
- Modify: `src/web/schemas.ts:142,217,682,719` — four mode enums, plus `codexConfig` / `piConfig` fields
- Test: `test/harness-codex-pi.test.ts`

**Interfaces:**
- Consumes: `HarnessDefinition`, `MODEL_PATTERN` (Task 1).
- Produces: `codexHarness`, `piHarness`; `SessionMode` gains `'codex' | 'pi'`.

- [ ] **Step 1: Write the failing test**

Create `test/harness-codex-pi.test.ts`:

```typescript
/**
 * @fileoverview Tests for the codex and pi harness definitions.
 */

import { describe, it, expect } from 'vitest';
import { getHarness, listHarnesses } from '../src/harnesses/registry.js';

describe('codex harness', () => {
  const h = () => getHarness('codex');

  it('is registered', () => {
    expect(listHarnesses().map((x) => x.id)).toContain('codex');
  });

  it('bypasses approvals and disables the alternate screen', () => {
    const cmd = h().buildCommand({ sessionId: 's', mode: 'codex' });
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    // Without this, tmux capture-pane sees an empty scrollback and buffer
    // restore returns a blank terminal.
    expect(cmd).toContain('--no-alt-screen');
  });

  it('adds a validated model flag', () => {
    expect(h().buildCommand({ sessionId: 's', mode: 'codex', codexConfig: { model: 'gpt-5.2' } }))
      .toContain('-m gpt-5.2');
  });

  it('drops an unsafe model string', () => {
    const cmd = h().buildCommand({ sessionId: 's', mode: 'codex', codexConfig: { model: 'x; rm -rf /' } });
    expect(cmd).not.toContain('rm -rf');
    expect(cmd).not.toContain('-m ');
  });

  it('resumes via the resume subcommand when an id is known', () => {
    const cmd = h().buildCommand({ sessionId: 's', mode: 'codex', harnessSessionId: '01a085e9-15f5-7b80-8af1-411de2591ffe' });
    expect(cmd).toMatch(/^codex resume 01a085e9-15f5-7b80-8af1-411de2591ffe /);
  });

  it('cannot preassign its session id', () => {
    expect(h().caps.preassignsSessionId).toBe(false);
  });
});

describe('pi harness', () => {
  const h = () => getHarness('pi');

  it('passes the Codeman session id straight through as --session-id', () => {
    // pi creates the session when the id does not exist, so the same command
    // both starts and resumes.
    const cmd = h().buildCommand({ sessionId: 'codeman-sid-1', mode: 'pi' });
    expect(cmd).toContain('--session-id codeman-sid-1');
    expect(cmd).toContain('--approve');
    expect(h().caps.preassignsSessionId).toBe(true);
  });

  it('accepts a provider/model:thinking model string', () => {
    const cmd = h().buildCommand({ sessionId: 's', mode: 'pi', piConfig: { model: 'anthropic/sonnet:high' } });
    expect(cmd).toContain('--model anthropic/sonnet:high');
  });

  it('searches ~/.npm-global/bin, which is not on /bin/sh PATH', () => {
    expect(h().searchDirs.some((d) => d.endsWith('.npm-global/bin'))).toBe(true);
  });
});

describe('both new harnesses opt out of every Claude-only subsystem', () => {
  it.each(['codex', 'pi'] as const)('%s', (mode) => {
    const c = getHarness(mode).caps;
    expect(c.ralph).toBe(false);
    expect(c.respawn).toBe(false);
    expect(c.claudeTranscript).toBe(false);
    expect(c.claudeParsers).toBe(false);
    expect(c.claudeHooks).toBe(false);
    expect(c.usesClaudeModelDefaults).toBe(false);
    expect(c.pausable).toBe(false);
    expect(c.requiresMux).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/harness-codex-pi.test.ts`
Expected: FAIL — `Unknown harness mode: codex`.

- [ ] **Step 3: Extend `SessionMode`**

`src/types/session.ts:72`:

```typescript
export type SessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'pi';
```

Update the doc comment at `:11` to match.

- [ ] **Step 4: Create `src/harnesses/codex.ts`**

```typescript
/**
 * @fileoverview The Codex CLI harness definition. Targets codex-cli 0.144.5.
 * @module harnesses/codex
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessDefinition, HarnessSpawnContext } from './types.js';
import { MODEL_PATTERN } from './claude.js';

/** Codex session ids are UUIDs; anything else must not reach the shell. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

export const codexHarness: HarnessDefinition = {
  id: 'codex',
  label: 'Codex',
  shortLabel: 'cx',
  binary: 'codex',
  searchDirs: [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.codex', 'bin'),
    '/usr/local/bin',
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), 'bin'),
  ],
  installHint: 'Codex CLI not found. Install with: npm i -g @openai/codex',
  // Codex renders a full-screen ratatui TUI with no prompt marker to watch for.
  readiness: { kind: 'settle', ms: 3000 },
  caps: {
    ralph: false,
    respawn: false,
    claudeTranscript: false,
    claudeParsers: false,
    requiresMux: true,
    // Codex has no flag to preassign a session id; it is discovered after start.
    preassignsSessionId: false,
    pausable: false,
    claudeHooks: false,
    usesClaudeModelDefaults: false,
  },
  buildCommand(ctx: HarnessSpawnContext): string {
    // --no-alt-screen is required, not cosmetic: codex's TUI uses the alternate
    // screen by default, and tmux capture-pane scrollback — how Codeman restores
    // terminal buffers — is empty for an alt-screen application.
    const flags = ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'];

    const model = ctx.codexConfig?.model;
    if (model && MODEL_PATTERN.test(model)) flags.push('-m', model);

    const resumeId = ctx.harnessSessionId;
    if (resumeId && SESSION_ID_PATTERN.test(resumeId)) {
      return `codex resume ${resumeId} ${flags.join(' ')}`;
    }
    return `codex ${flags.join(' ')}`;
  },
};
```

- [ ] **Step 5: Create `src/harnesses/pi.ts`**

```typescript
/**
 * @fileoverview The Pi CLI harness definition (@earendil-works/pi-coding-agent).
 * Targets pi 0.85.1.
 * @module harnesses/pi
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessDefinition, HarnessSpawnContext } from './types.js';
import { MODEL_PATTERN } from './claude.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const piHarness: HarnessDefinition = {
  id: 'pi',
  label: 'Pi',
  shortLabel: 'pi',
  binary: 'pi',
  searchDirs: [
    // pi installs here via npm -g. This directory is on an interactive shell's
    // PATH but NOT on the /bin/sh PATH that `which` sees from execSync, so the
    // fallback search is the only thing that finds it.
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    '/usr/local/bin',
    join(homedir(), '.bun', 'bin'),
    join(homedir(), 'bin'),
  ],
  installHint: 'Pi CLI not found. Install with: npm i -g @earendil-works/pi-coding-agent',
  readiness: { kind: 'settle', ms: 2000 },
  caps: {
    ralph: false,
    respawn: false,
    claudeTranscript: false,
    claudeParsers: false,
    requiresMux: true,
    // pi's --session-id creates the session when it does not exist, so Codeman's
    // own session id can be used directly and resume needs no discovery step.
    preassignsSessionId: true,
    pausable: false,
    claudeHooks: false,
    usesClaudeModelDefaults: false,
  },
  buildCommand(ctx: HarnessSpawnContext): string {
    const parts = ['pi', '--approve'];
    if (SESSION_ID_PATTERN.test(ctx.sessionId)) {
      parts.push('--session-id', ctx.sessionId);
    }
    const model = ctx.piConfig?.model;
    if (model && MODEL_PATTERN.test(model)) parts.push('--model', model);
    return parts.join(' ');
  },
};
```

- [ ] **Step 6: Register both and extend the zod enums**

In `src/harnesses/registry.ts` add `codex: codexHarness,` and `pi: piHarness,` to `HARNESSES` with the matching imports.

In `src/web/schemas.ts`, change all four enums (`:142`, `:217`, `:682`, `:719`) to:

```typescript
mode: z.enum(['claude', 'shell', 'opencode', 'codex', 'pi']).optional(),
```

Add beside the existing `openCodeConfig` field on `CreateSessionSchema` and the quick-start schema:

```typescript
const HarnessModelConfigSchema = z.object({ model: z.string().max(200).optional() }).optional();
// ...
codexConfig: HarnessModelConfigSchema,
piConfig: HarnessModelConfigSchema,
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/harness-codex-pi.test.ts test/harness-registry.test.ts test/harness-capability-consumers.test.ts`
Expected: PASS. Note `test/harness-registry.test.ts` asserts exactly three harnesses — update that assertion to the five-entry list as part of this step.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. Any error here is valuable — it marks a place that switches on `SessionMode` and has not been updated.

- [ ] **Step 9: Commit**

```bash
git add -A src test
git commit -m "feat(harnesses): add codex and pi harnesses

codex runs with --dangerously-bypass-approvals-and-sandbox --no-alt-screen
(the latter is required for tmux capture-pane buffer restore). pi runs with
--approve and reuses Codeman's own session id via --session-id, which pi
creates on demand.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Codex session-identity discovery

Codex cannot be told its session id, so Codeman reads it back from the rollout file codex writes.

**Files:**
- Create: `src/harnesses/codex-session-discovery.ts`
- Modify: `src/session.ts` — call discovery after `startInteractive()` for harnesses with `preassignsSessionId: false` and `requiresMux: true`
- Modify: `src/web/server.ts:3886` — drop the `claudeTranscript` condition added in Task 3 Step 7
- Test: `test/codex-session-discovery.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks beyond types.
- Produces: `discoverCodexSessionId(workingDir: string, startedAtMs: number, opts?: { codexHome?: string; timeoutMs?: number; intervalMs?: number }): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

Create `test/codex-session-discovery.test.ts`:

```typescript
/**
 * @fileoverview Tests for reading a codex session id back out of its rollout file.
 *
 * Codex writes $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl whose first
 * line is a session_meta record carrying both session_id and cwd.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCodexSessionId } from '../src/harnesses/codex-session-discovery.js';

let home: string;

/** Write a rollout file with the given session id, cwd, and mtime. */
function writeRollout(sessionId: string, cwd: string, mtimeMs: number): string {
  const dir = join(home, 'sessions', '2026', '09', '09');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-09-09T11-24-00-${sessionId}.jsonl`);
  const meta = {
    timestamp: '2026-09-09T11:24:00.577Z',
    type: 'session_meta',
    payload: { session_id: sessionId, cwd, cli_version: '0.144.5' },
  };
  writeFileSync(file, JSON.stringify(meta) + '\n');
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('discoverCodexSessionId', () => {
  const opts = () => ({ codexHome: home, timeoutMs: 1500, intervalMs: 100 });

  it('finds the session id for a matching cwd', async () => {
    const started = Date.now();
    writeRollout('01a085e9-15f5-7b80-8af1-411de2591ffe', '/work/proj', started + 100);
    await expect(discoverCodexSessionId('/work/proj', started, opts()))
      .resolves.toBe('01a085e9-15f5-7b80-8af1-411de2591ffe');
  });

  it('ignores a rollout from a different cwd', async () => {
    const started = Date.now();
    writeRollout('other-uuid', '/somewhere/else', started + 100);
    await expect(discoverCodexSessionId('/work/proj', started, opts())).resolves.toBeNull();
  });

  it('ignores a rollout written before the session started', async () => {
    // A pre-existing codex session in the same directory must not be adopted.
    const started = Date.now();
    writeRollout('stale-uuid', '/work/proj', started - 60_000);
    await expect(discoverCodexSessionId('/work/proj', started, opts())).resolves.toBeNull();
  });

  it('picks the newest when several match', async () => {
    const started = Date.now();
    writeRollout('older', '/work/proj', started + 100);
    writeRollout('newer', '/work/proj', started + 900);
    await expect(discoverCodexSessionId('/work/proj', started, opts())).resolves.toBe('newer');
  });

  it('resolves null on timeout rather than throwing', async () => {
    await expect(discoverCodexSessionId('/work/proj', Date.now(), opts())).resolves.toBeNull();
  });

  it('resolves null when the sessions directory does not exist', async () => {
    await expect(
      discoverCodexSessionId('/work/proj', Date.now(), { codexHome: join(home, 'nope'), timeoutMs: 300, intervalMs: 100 })
    ).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/codex-session-discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/harnesses/codex-session-discovery.ts`**

```typescript
/**
 * @fileoverview Recover a codex session id after start.
 *
 * Codex has no flag to preassign a session id, but it writes one rollout file per
 * session at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl. Its first
 * line is a `session_meta` record carrying both `session_id` and `cwd`.
 *
 * This mirrors how Codeman already locates Claude transcripts in
 * src/web/transcript-path-resolver.ts. Matching on cwd AND a start-time floor is what
 * keeps a concurrently running codex session in the same directory from being adopted.
 *
 * @module harnesses/codex-session-discovery
 */

import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface DiscoveryOptions {
  codexHome?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

/** Read only the first line of a file — rollouts can be large. */
async function readFirstLine(file: string): Promise<string | null> {
  const stream = createReadStream(file, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) return line;
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** Recursively collect .jsonl files under dir. The tree is date-sharded and shallow. */
function collectRollouts(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) collectRollouts(full, out);
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * Poll for the rollout file codex wrote for a session started in `workingDir`.
 *
 * @param workingDir  - the session's cwd, matched against session_meta.payload.cwd
 * @param startedAtMs - epoch ms the session was started; older rollouts are ignored
 * @returns the codex session id, or null if none appeared before the timeout
 */
export async function discoverCodexSessionId(
  workingDir: string,
  startedAtMs: number,
  opts: DiscoveryOptions = {}
): Promise<string | null> {
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const sessionsDir = join(codexHome, 'sessions');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(sessionsDir)) {
      const candidates: { id: string; mtimeMs: number }[] = [];

      for (const file of collectRollouts(sessionsDir)) {
        let mtimeMs: number;
        try {
          mtimeMs = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        // Allow 1s of slack: the file's mtime can land marginally before the
        // timestamp we recorded for the spawn.
        if (mtimeMs < startedAtMs - 1_000) continue;

        try {
          const first = await readFirstLine(file);
          if (!first) continue;
          const rec = JSON.parse(first) as {
            type?: string;
            payload?: { session_id?: string; cwd?: string };
          };
          if (rec.type !== 'session_meta') continue;
          if (rec.payload?.cwd !== workingDir) continue;
          if (!rec.payload?.session_id) continue;
          candidates.push({ id: rec.payload.session_id, mtimeMs });
        } catch {
          // Partially written or malformed file — skip it and retry next poll.
          continue;
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return candidates[0]!.id;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return null;
}
```

- [ ] **Step 4: Wire discovery into `src/session.ts`**

At the end of `startInteractive()`, after the mux session is created and readiness is scheduled, add a fire-and-forget discovery for codex:

```typescript
// Codex cannot be told its session id, so read it back from the rollout file it
// writes. Fire-and-forget: a failure only costs restore-after-reboot, not the session.
if (this.mode === 'codex' && !this.harnessSessionId) {
  const startedAt = Date.now();
  void discoverCodexSessionId(this.workingDir, startedAt)
    .then((id) => {
      if (!id) {
        console.warn(`[Session] codex session id not discovered for ${this.id}; not resumable`);
        return;
      }
      this.harnessSessionId = id;
      this.emit('stateChanged');
    })
    .catch((err) => console.error(`[Session] codex discovery failed for ${this.id}:`, err));
}
```

Confirm `'stateChanged'` is the event the server already listens to for persisting session state; if the codebase uses a different event name for "persist me", use that one instead.

- [ ] **Step 5: Relax the restore gate**

`src/web/server.ts:3886` — drop the `claudeTranscript` clause added in Task 3:

```typescript
if (wasRunning && !savedState.paused && session.harnessSessionId) {
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/codex-session-discovery.test.ts test/harness-session-identity.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add -A src test
git commit -m "feat(codex): discover the codex session id from its rollout file

Codex has no --session-id flag, so Codeman polls \$CODEX_HOME/sessions for the
rollout whose session_meta names this session's cwd and post-dates its start.
Matching on cwd plus a start-time floor keeps a concurrent codex session in the
same directory from being adopted. On timeout the session still runs; only
restore-after-reboot is lost.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Route and CLI audit

Fixes the server-side sites that mean "Claude" but are written as "not shell" or "not opencode", and generalises the availability endpoint.

**Files:**
- Modify: `src/web/routes/session-routes.ts:131,145,157,1311,1373,1384`
- Modify: `src/web/routes/history-routes.ts:245`
- Modify: `src/web/routes/worktree-session-routes.ts:236,334,654`
- Modify: `src/web/routes/system-routes.ts:241`
- Modify: `src/web/server.ts:1406,1408,1428`
- Modify: `src/cli.ts:111`
- Test: `test/harness-route-audit.test.ts`

**Interfaces:**
- Consumes: `getHarness`, `isHarnessAvailable`, `listHarnesses`.
- Produces: `GET /api/harnesses` → `{ harnesses: { id, label, shortLabel, available, installHint, caps }[] }`; `GET /api/harness/:id/status` → `{ available: boolean, path: string | null }`. `GET /api/opencode/status` is kept as an alias.

- [ ] **Step 1: Write the failing test**

Create `test/harness-route-audit.test.ts`:

```typescript
/**
 * @fileoverview Tests for the harness availability endpoints and the model-default guard.
 */

import { describe, it, expect } from 'vitest';
import { getHarness } from '../src/harnesses/registry.js';
import type { SessionMode } from '../src/types/session.js';

/** Mirrors the model-selection rule the routes now share. */
function pickModel(mode: SessionMode, defaultModel: string | undefined, harnessModel?: string): string | undefined {
  if (harnessModel) return harnessModel;
  return getHarness(mode).caps.usesClaudeModelDefaults ? defaultModel : undefined;
}

describe('model default selection', () => {
  it('gives claude the global default', () => {
    expect(pickModel('claude', 'opus')).toBe('opus');
  });

  it.each(['codex', 'pi', 'opencode', 'shell'] as const)(
    'does not hand the Claude default model to %s',
    (mode) => {
      expect(pickModel(mode, 'opus')).toBeUndefined();
    }
  );

  it('prefers an explicit harness model over the default', () => {
    expect(pickModel('codex', 'opus', 'gpt-5.2')).toBe('gpt-5.2');
  });
});

describe('harness metadata is serialisable for the UI', () => {
  it('every harness exposes the fields the frontend needs', () => {
    for (const h of [getHarness('claude'), getHarness('codex'), getHarness('pi')]) {
      expect(typeof h.label).toBe('string');
      expect(h.shortLabel.length).toBeLessThanOrEqual(2);
      expect(typeof h.installHint).toBe('string');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/harness-route-audit.test.ts`
Expected: FAIL — `pi.shortLabel` is fine, but the suite fails to import until Task 4 is in place. If Task 4 is committed, this test passes immediately; in that case add the route changes first and re-run.

- [ ] **Step 3: Replace the availability checks in `session-routes.ts`**

At `:131` and `:1311`, replace the opencode-specific block with a generic one:

```typescript
const def = getHarness(mode ?? 'claude');
if (!isHarnessAvailable(def)) {
  return createErrorResponse(ApiErrorCode.OPERATION_FAILED, def.installHint);
}
```

- [ ] **Step 4: Fix model selection at `session-routes.ts:145,1373`, `history-routes.ts:245`, and `server.ts:1408`**

Every one currently reads "not shell". Replace each with the capability, keeping each call site's own source for an explicit harness model:

```typescript
// session-routes.ts:145
const harnessModel =
  mode === 'opencode' ? body.openCodeConfig?.model
  : mode === 'codex' ? body.codexConfig?.model
  : mode === 'pi' ? body.piConfig?.model
  : undefined;
const model = harnessModel ?? (getHarness(mode ?? 'claude').caps.usesClaudeModelDefaults ? modelConfig?.defaultModel : undefined);
```

```typescript
// history-routes.ts:245
const model = getHarness(resolvedMode).caps.usesClaudeModelDefaults ? modelConfig?.defaultModel : undefined;
```

```typescript
// server.ts:1408
model: getHarness(archivedState.mode ?? 'claude').caps.usesClaudeModelDefaults
  ? (modelConfig?.defaultModel ?? undefined)
  : undefined,
```

- [ ] **Step 5: Pass the harness config through at `session-routes.ts:157,1384`**

```typescript
openCodeConfig: mode === 'opencode' ? body.openCodeConfig : undefined,
codexConfig: mode === 'codex' ? body.codexConfig : undefined,
piConfig: mode === 'pi' ? body.piConfig : undefined,
```

- [ ] **Step 6: Fix the worktree creation path**

`src/web/routes/worktree-session-routes.ts` — after `const resolvedMode = mode ?? session.mode;` (`:236`), add the availability check:

```typescript
const harnessDef = getHarness(resolvedMode);
if (!isHarnessAvailable(harnessDef)) {
  return createErrorResponse(ApiErrorCode.OPERATION_FAILED, harnessDef.installHint);
}
```

At both `:334` and `:654`, replace `if (resolvedMode === 'shell')` with `if (!getHarness(resolvedMode).binary)` so the shell branch is registry-driven, and pass the harness config into the `new Session({...})` call in the same way as Step 5.

- [ ] **Step 7: Generalise the availability endpoint in `system-routes.ts`**

Keep `/api/opencode/status` as an alias so existing tests (`test/routes/system-routes.test.ts:657-672`) and clients keep working:

```typescript
app.get('/api/harnesses', async () => ({
  harnesses: listHarnesses().map((h) => ({
    id: h.id,
    label: h.label,
    shortLabel: h.shortLabel,
    installHint: h.installHint,
    available: isHarnessAvailable(h),
    caps: h.caps,
  })),
}));

app.get<{ Params: { id: string } }>('/api/harness/:id/status', async (req, reply) => {
  let def;
  try {
    def = getHarness(req.params.id as SessionMode);
  } catch {
    reply.code(404);
    return createErrorResponse(ApiErrorCode.NOT_FOUND, `Unknown harness: ${req.params.id}`);
  }
  return {
    available: isHarnessAvailable(def),
    path: def.binary ? resolveHarnessDir(def.binary, def.searchDirs) : null,
  };
});

// Retained alias — existing clients and tests call this path.
app.get('/api/opencode/status', async () => {
  const def = getHarness('opencode');
  return { available: isHarnessAvailable(def), path: resolveHarnessDir(def.binary!, def.searchDirs) };
});
```

- [ ] **Step 8: Fix the CLI label at `src/cli.ts:111`**

```typescript
const mode = session.mode && session.mode !== 'claude'
  ? chalk.gray(` [${getHarness(session.mode).shortLabel}]`)
  : '';
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run test/harness-route-audit.test.ts test/routes/system-routes.test.ts test/api-responses.test.ts`
Expected: PASS, with the same failure set as master for the two pre-existing files.

- [ ] **Step 10: Typecheck and commit**

```bash
npx tsc --noEmit
git add -A src test
git commit -m "feat(harnesses): audit routes and CLI for the new harnesses

Availability checks, model defaults, and config plumbing now read the registry
instead of testing for 'not shell' or 'not opencode'. Adds /api/harnesses and
/api/harness/:id/status, keeping /api/opencode/status as an alias. The worktree
creation path — the main Codeman pipeline — now validates harness availability
and passes harness config, which it never did.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend

**Files:**
- Modify: `src/web/public/app.js:10178,11084,11452-11460,11504,11771,12609,12938,12960,12967,13137,13211,13284,13353`
- Modify: `src/web/public/index.html:390,463`
- Test: `test/harness-ui.test.ts`

**Interfaces:**
- Consumes: `GET /api/harnesses` (Task 6).
- Produces: `app.runHarness(mode)`; `app._harnesses` — a `Map<string, HarnessMeta>` populated at startup.

- [ ] **Step 1: Write the failing test**

Create `test/harness-ui.test.ts`. Follow the jsdom setup used by `test/transcript-mode-guard.test.ts` for loading `app.js`. Assert:

```typescript
import { describe, it, expect } from 'vitest';

/** Mirrors the run-mode dispatch rule in app.js run(). */
function dispatchTarget(mode: string): string {
  return mode === 'claude' ? 'runClaude' : 'runHarness';
}

describe('run-mode dispatch', () => {
  it('sends claude to runClaude', () => {
    expect(dispatchTarget('claude')).toBe('runClaude');
  });

  it.each(['opencode', 'codex', 'pi'])('sends %s to runHarness, not runClaude', (mode) => {
    // Before this change run() special-cased only opencode, so codex and pi
    // silently launched Claude.
    expect(dispatchTarget(mode)).toBe('runHarness');
  });
});

describe('pause-menu eligibility', () => {
  const caps: Record<string, { pausable: boolean }> = {
    claude: { pausable: true }, shell: { pausable: false }, opencode: { pausable: false },
    codex: { pausable: false }, pi: { pausable: false },
  };
  it.each(['shell', 'opencode', 'codex', 'pi'])('%s is not offered pause', (mode) => {
    expect(caps[mode]!.pausable).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/harness-ui.test.ts`
Expected: FAIL.

- [ ] **Step 3: Fetch harness metadata at startup**

In `app.js`, alongside the other startup fetches:

```javascript
/** Harness metadata from the registry, keyed by mode. Populated once at startup. */
this._harnesses = new Map();

async loadHarnesses() {
  try {
    const res = await fetch('/api/harnesses');
    const data = await res.json();
    for (const h of data.harnesses || []) this._harnesses.set(h.id, h);
  } catch (err) {
    console.error('Failed to load harness metadata:', err);
  }
}

/** Harness metadata with a safe fallback, so UI code never throws on an unknown mode. */
harnessMeta(mode) {
  return this._harnesses.get(mode || 'claude')
    || { id: mode, label: 'Claude Code', shortLabel: 'cc', caps: {}, available: true, installHint: '' };
}
```

- [ ] **Step 4: Replace `runOpenCode` with a generic `runHarness`**

```javascript
/** Run any non-claude harness. Generic version of the old runOpenCode(). */
async runHarness(mode) {
  const meta = this.harnessMeta(mode);
  const caseName = document.getElementById('quickStartCase').value || 'testcase';

  this.terminal.clear();
  this.terminal.writeln(`\x1b[1;32m Starting ${meta.label} session in ${caseName}...\x1b[0m`);
  this.terminal.writeln('');

  try {
    const statusRes = await fetch(`/api/harness/${encodeURIComponent(mode)}/status`);
    const status = await statusRes.json();
    if (!status.available) {
      this.terminal.writeln(`\x1b[1;31m ${meta.label} CLI not found.\x1b[0m`);
      this.terminal.writeln(`\x1b[90m ${meta.installHint}\x1b[0m`);
      return;
    }

    const body = { caseName, mode };
    if (mode === 'opencode') body.openCodeConfig = { autoAllowTools: true };

    const res = await fetch('/api/quick-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || `Failed to start ${meta.label}`);

    if (data.sessionId) {
      fetch(`/api/sessions/${data.sessionId}/auto-name`, { method: 'POST' }).catch(() => {});
      await this.selectSession(data.sessionId);
    }
    this.terminal.focus();
  } catch (err) {
    this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
  }
}

/** Retained for existing callers (welcome button, quick-start case flow). */
async runOpenCode() {
  return this.runHarness('opencode');
}
```

Change `run()` (`:11452`):

```javascript
async run() {
  const mode = this._runMode || 'claude';
  return mode === 'claude' ? this.runClaude() : this.runHarness(mode);
}
```

- [ ] **Step 5: Update the remaining UI sites**

| line | from | to |
|---|---|---|
| `:10178` | `mode === 'shell' ? 'sh' : mode === 'opencode' ? 'oc' : ''` | badge from `this.harnessMeta(mode).shortLabel`, empty for `claude` |
| `:11084` | `session.mode === 'opencode' ? 'Kill Tmux & OpenCode' : 'Kill Tmux & Claude Code'` | `` `Kill Tmux & ${this.harnessMeta(session.mode).label}` `` |
| `:11504` | `mode === 'opencode' ? 'Run OC' : 'Run'` | `` mode === 'claude' ? 'Run' : `Run ${this.harnessMeta(mode).shortLabel.toUpperCase()}` `` |
| `:12609` | `const isShell = session.mode === 'shell';` | `const canPause = this.harnessMeta(session.mode).caps.pausable === true;` and use `!canPause` where `isShell` gated the pause entry |
| `:12938` | `session.mode === 'opencode' ? 'summary' : 'respawn'` | `this.harnessMeta(session.mode).caps.respawn ? 'respawn' : 'summary'` |
| `:12960,:12967` | `session.mode === 'claude'` | leave unchanged — positive claude checks are already correct |
| `:13211` | `if (mode === 'opencode')` in the session creator | `if (mode !== 'claude' && mode !== 'shell')`, passing the mode through |
| `:13284` | opencode-only quick-start shortcut | `await this.runHarness(mode)` for any non-claude, non-shell mode |
| `:13137,:13353` | static mode-selector markup | render one button per entry of `this._harnesses`, marking unavailable ones disabled with the install hint as the title |

- [ ] **Step 6: Add the buttons to `index.html`**

After the OpenCode welcome button (`:390`):

```html
<button class="welcome-btn welcome-btn-codex" onclick="app.setRunMode('codex'); app.runHarness('codex')">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
  Run Codex
</button>
<button class="welcome-btn welcome-btn-pi" onclick="app.setRunMode('pi'); app.runHarness('pi')">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
  Run Pi
</button>
```

After the OpenCode run-mode option (`:463`):

```html
<button class="run-mode-option" data-mode="codex" onclick="app.setRunMode('codex')">
  <span class="run-mode-dot codex"></span>Codex
</button>
<button class="run-mode-option" data-mode="pi" onclick="app.setRunMode('pi')">
  <span class="run-mode-dot pi"></span>Pi
</button>
```

Add `.run-mode-dot.codex` and `.run-mode-dot.pi` colours next to the existing `.opencode` rule, and matching `.session-mode-badge[data-mode="codex"|"pi"]` rules.

- [ ] **Step 7: Run the tests and commit**

Run: `npx vitest run test/harness-ui.test.ts test/transcript-mode-guard.test.ts`
Expected: PASS.

```bash
git add -A src test
git commit -m "feat(ui): drive run modes from the harness registry

run() dispatched only opencode, so codex and pi would have launched Claude.
Replaces runOpenCode() with a generic runHarness(mode) and drives badges, kill
copy, run-button label, pause eligibility, options tabs, and both mode
selectors from registry metadata.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Manual smoke test

Not automatable. Run it, record the results, and fix what it turns up before Task 9.

**Files:**
- Create: `docs/superpowers/plans/2026-09-09-harness-registry-smoke-results.md`

- [ ] **Step 1: Build and start the worktree's Codeman**

```bash
npm run build
PORT=3011 node dist/index.js
```

Copy `vendor/` from the main `dist` first — it is gitignored, and a 404 on `/vendor/*` crashes `app.js`.

- [ ] **Step 2: Codex session**

Start a codex session from the UI. Record: does the TUI render in the web terminal; does typed input reach the agent; does the buffer survive a page reload (this is what `--no-alt-screen` is for); does `~/.codex/sessions/.../rollout-*.jsonl` appear and does the session's `harnessSessionId` get set within 15s.

- [ ] **Step 3: Pi session**

Same checks. Additionally confirm `pi` is found at all — it lives in `~/.npm-global/bin`, which `which` under `/bin/sh` does not see, so this specifically exercises the `searchDirs` fallback.

- [ ] **Step 4: Server restart**

With one codex and one pi session running, stop and restart the Codeman server. Confirm both sessions reattach. This is the requirement `harnessSessionId` exists for; a page reload does not test it.

- [ ] **Step 5: Regression pass on the existing harnesses**

Start one claude, one opencode, and one shell session. Confirm claude still shows the transcript view and can be paused; confirm shell no longer offers pause and no longer gets a respawn controller.

- [ ] **Step 6: Record results and commit**

Write each check and its outcome into the results file. If codex's buffer restores blank despite `--no-alt-screen`, mark codex restore-unsupported and note it — do not ship a broken restore.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/plans/2026-09-09-harness-registry-smoke-results.md
git commit -m "docs: record harness smoke-test results

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `FEATURES.md`
- Modify: `README.md`
- Modify: `TODO.md`

- [ ] **Step 1: Add the CHANGELOG entry**

Include the shell behaviour change explicitly — it is the one user-visible regression risk:

```markdown
### Added
- Codex and Pi are now supported session harnesses alongside Claude Code, OpenCode, and shell.
- `GET /api/harnesses` and `GET /api/harness/:id/status` report harness availability.

### Changed
- Session modes are now defined by a capability registry (`src/harnesses/`) rather than
  scattered `mode !== 'opencode'` checks.
- **Shell sessions no longer receive Claude-only subsystems.** They previously got a ralph
  tracker, a restorable respawn controller, and the Claude output parsers, because the old
  guards read "not opencode" rather than "is claude". Shell sessions can no longer be paused.
```

- [ ] **Step 2: Update `FEATURES.md` and `README.md`**

Add codex and pi wherever the supported harnesses are listed, including their install commands (`npm i -g @openai/codex`, `npm i -g @earendil-works/pi-coding-agent`).

- [ ] **Step 3: Add the ralph-removal actionable to `TODO.md`**

```markdown
- [ ] Remove the ralph loop entirely. Unused. The harness registry already marks it
      `caps.ralph`, so removal is now: delete the ralph modules, drop the capability,
      and delete its route file. See docs/superpowers/specs/2026-09-09-harness-registry-design.md.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md FEATURES.md README.md TODO.md
git commit -m "docs: document codex and pi harness support

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** §1 registry → Task 1. §2 capability table → Tasks 1, 2, 4. §3 spawn commands → Task 4. §4 identity and config → Tasks 3, 5. §4a route audit → Tasks 2, 6. §5 UI → Task 7. §6 error handling → Tasks 2 (pause copy, spawn throw), 6 (install hints). §7 testing → every task's test step plus Task 8. Risk 1 (codex alt-screen) → Task 8 Step 2 with a stated fallback. Risk 2 (30-site refactor) → Task 2's consumer test. Risk 3 (migration) → Task 3's five migration cases. Risk 4 (pi resume) → Task 8 Step 4.

**Placeholders.** None. Every code step carries real code; the three table-driven steps (Task 2 Step 4, Task 6, Task 7 Step 5) name each file, line, and exact replacement.

**Type consistency.** `HarnessSpawnContext` is defined once (Task 1) and consumed unchanged by Tasks 2 and 4. `harnessSessionId` is the same name across `SessionState`, `Session`, `HarnessSpawnContext`, and the discovery call. `getHarness` / `listHarnesses` / `isHarnessAvailable` / `resolveHarnessDir` / `MODEL_PATTERN` keep the same signatures throughout. `HarnessModelConfig` is the single shape behind both `codexConfig` and `piConfig`.

**Known ordering constraint.** Task 6's test imports the codex and pi harnesses, so Task 4 must land first. The task order already reflects this.

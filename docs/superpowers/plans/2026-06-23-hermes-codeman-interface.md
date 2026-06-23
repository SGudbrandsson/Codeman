# Hermes ↔ Codeman Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an external agent (Hermes) drive Codeman over MCP — list projects/sessions, read a per-session "is it done / what's the latest / any subagents" digest, and spin up feature/fix worktrees — without knowing anything about Claude or Codeman's skills.

**Architecture:** A thin MCP facade (`src/mcp-server.ts`, stdio JSON-RPC, already exists) calls new high-level REST endpoints (`POST /api/feature`, `POST /api/fix`, `GET /api/sessions/:id/digest`). The endpoints encapsulate the worktree feature/fix dance in TypeScript and reuse the existing, battle-tested `POST /api/sessions/:id/worktree` machinery (which already writes `TASK.md`/`CLAUDE.md` inline before start, allocates a port, registers the session, starts Claude, and sends a first prompt via `autoStart:true` + `notes`). Pure logic (parent resolution, slugging, template rendering, digest shaping, auth header) lives in small focused modules that are unit-tested in isolation.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Fastify routes, Zod schemas, Vitest. Node built-ins only in `mcp-server.ts` (zero deps — keep it that way).

## Global Constraints

- Codeman REST base URL: `http://localhost:3001` (the MCP facade reads `CODEMAN_URL`, default `http://localhost:3001`).
- ESM project: every relative import MUST use a `.js` suffix (e.g. `import { x } from './foo.js'`).
- Route response convention: success returns `{ success: true, ... }` (often `{ success: true, data }`); errors return `createErrorResponse(ApiErrorCode.X, message)` from `src/web/types/...` (already imported in route files). Error codes in use: `NOT_FOUND`, `INVALID_INPUT`, `OPERATION_FAILED`, `SESSION_BUSY`.
- Auth: the REST API enforces Basic Auth only when `process.env.CODEMAN_PASSWORD` is set (`src/web/middleware/auth.ts:46`). The MCP facade MUST forward `Authorization: Basic base64(USERNAME:PASSWORD)` when a password is present, reading `CODEMAN_USERNAME` (default `admin`) and `CODEMAN_PASSWORD`. When no password is set, send no auth header.
- Status vocabulary exposed to Hermes is three-state: `working` / `idle` / `stopped`. Internal enum is `idle|busy|stopped|error|archived` (`src/types/session.ts:61`); collapse `busy→working`, `idle→idle`, `stopped|error|archived→stopped`.
- "Done" is NOT raw status — it is transcript `isComplete && !toolExecuting && status==='idle'`.
- Branch names must satisfy the existing `BRANCH_PATTERN` used in `worktree-session-routes.ts`; slugs are lowercase, hyphenated, ≤37 chars, prefixed `feat/` or `fix/`.
- Tests live in `test/*.test.ts`, run with `npm test` (vitest). Per project memory, run vitest with brew Node v25 on PATH to avoid a better-sqlite3 ABI mismatch.
- Build/deploy after merge is out of scope for this plan (handled by the normal Codeman deploy flow).

---

## File Structure

**New files:**
- `src/web/hermes/parent-resolver.ts` — pure: pick the parent session for a project, or list candidates.
- `src/web/hermes/branch-slug.ts` — pure: title → `feat/…` or `fix/…` slug.
- `src/web/hermes/task-templates.ts` — pure: render `TASK.md` and the worktree `CLAUDE.md`.
- `src/web/hermes/digest.ts` — pure: assemble the session digest object.
- `src/web/routes/hermes-routes.ts` — Fastify routes `POST /api/feature`, `POST /api/fix`, `GET /api/sessions/:id/digest`; owns the per-parent serialization lock.
- `test/hermes-parent-resolver.test.ts`, `test/hermes-branch-slug.test.ts`, `test/hermes-task-templates.test.ts`, `test/hermes-digest.test.ts`, `test/mcp-auth.test.ts` — unit tests.

**Modified files:**
- `src/web/ports/config-port.ts` — add `getTranscriptState(sessionId: string): TranscriptStateLite | null` to the `ConfigPort` interface.
- `src/web/server.ts` — implement `getTranscriptState` (reads `this.transcriptWatchers`), add it to the `ctx` object, and call `registerHermesRoutes(this.app, ctx)`.
- `src/mcp-server.ts` — add auth header helper; add tools `list_projects`, `get_session_digest`, `start_feature`, `start_fix`; switch `send_message` to `submit:true`.

---

## Task 1: Parent-session resolver (pure)

**Files:**
- Create: `src/web/hermes/parent-resolver.ts`
- Test: `test/hermes-parent-resolver.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface ResolverSession { id: string; name: string; status: string; workingDir?: string; worktreeBranch?: string | null; }
  export type ResolveResult =
    | { ok: true; sessionId: string }
    | { ok: false; code: 'NOT_FOUND' | 'AMBIGUOUS' | 'INVALID_INPUT'; message: string; candidates?: Array<{ id: string; name: string; workingDir?: string }> };
  export function resolveParentSession(sessions: ResolverSession[], project: string, parentSessionId?: string): ResolveResult;
  ```
  Rules: a "main" session has no `worktreeBranch`. If `parentSessionId` is given, it must match a main session (else `INVALID_INPUT`). Otherwise match `project` (case-insensitive) against the basename of `workingDir`; among matches prefer `status === 'idle'`. Exactly one → ok; zero → `NOT_FOUND`; more than one after the idle-preference → `AMBIGUOUS` with `candidates`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/hermes-parent-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { resolveParentSession, type ResolverSession } from '../src/web/hermes/parent-resolver.js';

const main = (id: string, dir: string, status = 'idle', branch: string | null = null): ResolverSession =>
  ({ id, name: id, status, workingDir: dir, worktreeBranch: branch });

describe('resolveParentSession', () => {
  it('matches a single main session by project basename', () => {
    const r = resolveParentSession([main('a', '/home/u/Codeman')], 'codeman');
    expect(r).toEqual({ ok: true, sessionId: 'a' });
  });

  it('ignores worktree sessions (those with a branch)', () => {
    const sessions = [main('a', '/home/u/Codeman'), main('b', '/home/u/Codeman-feat', 'idle', 'feat/x')];
    expect(resolveParentSession(sessions, 'codeman')).toEqual({ ok: true, sessionId: 'a' });
  });

  it('prefers an idle main session over a busy one', () => {
    const sessions = [main('busy', '/home/u/Codeman', 'busy'), main('idle', '/home/u/Codeman', 'idle')];
    expect(resolveParentSession(sessions, 'codeman')).toEqual({ ok: true, sessionId: 'idle' });
  });

  it('returns AMBIGUOUS with candidates when >1 idle match', () => {
    const sessions = [main('a', '/home/u/Codeman'), main('b', '/srv/Codeman')];
    const r = resolveParentSession(sessions, 'codeman');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('AMBIGUOUS');
      expect(r.candidates?.map((c) => c.id).sort()).toEqual(['a', 'b']);
    }
  });

  it('returns NOT_FOUND when no project matches', () => {
    const r = resolveParentSession([main('a', '/home/u/Other')], 'codeman');
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('honors an explicit parentSessionId', () => {
    const sessions = [main('a', '/home/u/Codeman'), main('b', '/srv/Codeman')];
    expect(resolveParentSession(sessions, 'codeman', 'b')).toEqual({ ok: true, sessionId: 'b' });
  });

  it('rejects a parentSessionId that is a worktree session', () => {
    const sessions = [main('wt', '/home/u/Codeman-feat', 'idle', 'feat/x')];
    expect(resolveParentSession(sessions, 'codeman', 'wt')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- hermes-parent-resolver`
Expected: FAIL — "Cannot find module '../src/web/hermes/parent-resolver.js'".

- [ ] **Step 3: Implement the resolver**

```ts
// src/web/hermes/parent-resolver.ts
export interface ResolverSession {
  id: string;
  name: string;
  status: string;
  workingDir?: string;
  worktreeBranch?: string | null;
}

export type ResolveResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'AMBIGUOUS' | 'INVALID_INPUT';
      message: string;
      candidates?: Array<{ id: string; name: string; workingDir?: string }>;
    };

const isMain = (s: ResolverSession): boolean => !s.worktreeBranch;
const basename = (p: string | undefined): string => (p ?? '').replace(/\/+$/, '').split('/').pop() ?? '';

export function resolveParentSession(
  sessions: ResolverSession[],
  project: string,
  parentSessionId?: string
): ResolveResult {
  const mains = sessions.filter(isMain);

  if (parentSessionId) {
    const hit = mains.find((s) => s.id === parentSessionId);
    if (!hit) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `parentSessionId "${parentSessionId}" is not a main (non-worktree) session`,
      };
    }
    return { ok: true, sessionId: hit.id };
  }

  const needle = project.trim().toLowerCase();
  const matches = mains.filter((s) => basename(s.workingDir).toLowerCase() === needle);

  if (matches.length === 0) {
    return { ok: false, code: 'NOT_FOUND', message: `No main session found for project "${project}"` };
  }

  const idle = matches.filter((s) => s.status === 'idle');
  const pool = idle.length > 0 ? idle : matches;
  if (pool.length === 1) return { ok: true, sessionId: pool[0].id };

  return {
    ok: false,
    code: 'AMBIGUOUS',
    message: `Multiple sessions match project "${project}" — pass parentSessionId to disambiguate`,
    candidates: pool.map((s) => ({ id: s.id, name: s.name, workingDir: s.workingDir })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- hermes-parent-resolver`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/hermes/parent-resolver.ts test/hermes-parent-resolver.test.ts
git commit -m "feat(hermes): pure parent-session resolver for /api/feature"
```

---

## Task 2: Branch slug (pure)

**Files:**
- Create: `src/web/hermes/branch-slug.ts`
- Test: `test/hermes-branch-slug.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function slugifyBranch(title: string, prefix: 'feat' | 'fix'): string;` — lowercases, replaces any run of non-alphanumeric chars with a single `-`, trims leading/trailing `-`, caps the slug body at 37 chars (no trailing `-` after the cut), returns `` `${prefix}/${body}` ``. Empty/garbage title → body `task`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/hermes-branch-slug.test.ts
import { describe, it, expect } from 'vitest';
import { slugifyBranch } from '../src/web/hermes/branch-slug.js';

describe('slugifyBranch', () => {
  it('slugs a normal title', () => {
    expect(slugifyBranch('Add dark mode toggle to settings panel', 'feat'))
      .toBe('feat/add-dark-mode-toggle-to-settings');
  });
  it('uses the fix prefix', () => {
    expect(slugifyBranch('Fix the login crash', 'fix')).toBe('fix/fix-the-login-crash');
  });
  it('collapses punctuation and whitespace', () => {
    expect(slugifyBranch('  Rate-limit   API!! endpoints  ', 'feat')).toBe('feat/rate-limit-api-endpoints');
  });
  it('caps the body at 37 chars with no trailing hyphen', () => {
    const out = slugifyBranch('a'.repeat(60), 'feat');
    expect(out.startsWith('feat/')).toBe(true);
    expect(out.slice('feat/'.length).length).toBeLessThanOrEqual(37);
    expect(out.endsWith('-')).toBe(false);
  });
  it('falls back to "task" for empty/garbage', () => {
    expect(slugifyBranch('!!!', 'feat')).toBe('feat/task');
    expect(slugifyBranch('', 'fix')).toBe('fix/task');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- hermes-branch-slug`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/web/hermes/branch-slug.ts
export function slugifyBranch(title: string, prefix: 'feat' | 'fix'): string {
  let body = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (body.length > 37) {
    body = body.slice(0, 37);
    // Cut back to the last word boundary so we never end on a partial word.
    // (If there's no hyphen within 37 chars, keep the hard slice.)
    const lastHyphen = body.lastIndexOf('-');
    if (lastHyphen > 0) body = body.slice(0, lastHyphen);
    body = body.replace(/-+$/g, '');
  }
  if (!body) body = 'task';
  return `${prefix}/${body}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- hermes-branch-slug`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/hermes/branch-slug.ts test/hermes-branch-slug.test.ts
git commit -m "feat(hermes): pure branch slug helper"
```

---

## Task 3: TASK.md / CLAUDE.md templates (pure)

**Files:**
- Create: `src/web/hermes/task-templates.ts`
- Test: `test/hermes-task-templates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface TaskSpec { title: string; description: string; acceptance?: string; }
  export function renderTaskMd(kind: 'feature' | 'fix', spec: TaskSpec): string;
  export const WORKTREE_CLAUDE_MD: string;
  ```
  `renderTaskMd` outputs a `# <title>` doc with a `## status` block whose first line is `phase: analysis`, plus Description, Acceptance Criteria (the `acceptance` text or `See description.`), and a Workflow line instructing the codeman-task-runner skill. `WORKTREE_CLAUDE_MD` is the standard worktree bootstrap string.

- [ ] **Step 1: Write the failing tests**

```ts
// test/hermes-task-templates.test.ts
import { describe, it, expect } from 'vitest';
import { renderTaskMd, WORKTREE_CLAUDE_MD } from '../src/web/hermes/task-templates.js';

describe('renderTaskMd', () => {
  it('includes title, phase, description, and the runner instruction', () => {
    const md = renderTaskMd('feature', { title: 'Dark mode', description: 'Add a toggle.' });
    expect(md).toContain('# Dark mode');
    expect(md).toMatch(/## status\nphase: analysis/);
    expect(md).toContain('Add a toggle.');
    expect(md).toContain('codeman-task-runner');
  });
  it('renders acceptance when provided, else a placeholder line', () => {
    expect(renderTaskMd('feature', { title: 'T', description: 'D', acceptance: 'Must do X' }))
      .toContain('Must do X');
    expect(renderTaskMd('fix', { title: 'T', description: 'D' }))
      .toContain('See description.');
  });
  it('labels fixes as a bug fix', () => {
    expect(renderTaskMd('fix', { title: 'T', description: 'D' }).toLowerCase()).toContain('fix');
  });
});

describe('WORKTREE_CLAUDE_MD', () => {
  it('tells the worktree Claude to read TASK.md and run the task-runner skill', () => {
    expect(WORKTREE_CLAUDE_MD).toContain('TASK.md');
    expect(WORKTREE_CLAUDE_MD).toContain('codeman-task-runner');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- hermes-task-templates`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/web/hermes/task-templates.ts
export interface TaskSpec {
  title: string;
  description: string;
  acceptance?: string;
}

export const WORKTREE_CLAUDE_MD =
  'You are working autonomously in a Codeman worktree.\n' +
  'Before doing ANYTHING else, re-read `TASK.md` in this directory\n' +
  'and resume from the phase in `status`.\n' +
  'Do not rely on conversation history.\n' +
  'Then invoke the codeman-task-runner skill.\n';

export function renderTaskMd(kind: 'feature' | 'fix', spec: TaskSpec): string {
  const heading = kind === 'fix' ? 'Bug fix' : 'Feature';
  const acceptance = spec.acceptance?.trim() || 'See description.';
  return [
    `# ${spec.title}`,
    '',
    '## status',
    'phase: analysis',
    '',
    `## Type`,
    heading,
    '',
    '## Description',
    spec.description.trim(),
    '',
    '## Acceptance Criteria',
    acceptance,
    '',
    '## Workflow',
    'Invoke the codeman-task-runner skill and proceed through its phases.',
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- hermes-task-templates`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/hermes/task-templates.ts test/hermes-task-templates.test.ts
git commit -m "feat(hermes): TASK.md / CLAUDE.md template renderers"
```

---

## Task 4: Digest shaper (pure)

**Files:**
- Create: `src/web/hermes/digest.ts`
- Test: `test/hermes-digest.test.ts`

**Interfaces:**
- Consumes: nothing (callers pass plain data).
- Produces:
  ```ts
  export interface TranscriptStateLite { isComplete: boolean; toolExecuting: boolean; lastAssistantMessage: string | null; }
  export interface DigestSubagent { name: string; doing: string | null; status: string; }
  export interface DigestInput {
    id: string;
    name: string;
    status: string;                 // raw internal enum
    transcript: TranscriptStateLite | null;
    subagents: Array<{ description?: string; status: string; agentId: string; lastActivityAt: number }>;
    phase: string | null;
    lastActivityAt: number | null;
  }
  export interface Digest {
    id: string; name: string;
    status: 'working' | 'idle' | 'stopped';
    done: boolean;
    toolExecuting: boolean;
    lastAssistantMessage: string | null;
    subagents: { count: number; active: DigestSubagent[] };
    phase: string | null;
    lastActivityAt: number | null;
  }
  export function buildDigest(input: DigestInput): Digest;
  export function mapStatus(raw: string): 'working' | 'idle' | 'stopped';
  ```
  `mapStatus`: `busy→working`, `idle→idle`, everything else (`stopped|error|archived|unknown`) → `stopped`. `done` is `true` only when `transcript?.isComplete && !transcript.toolExecuting && mapStatus(status) === 'idle'`. `subagents.active` includes only subagents whose status is `active` or `idle` (not `completed`), mapping `description` → `doing`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/hermes-digest.test.ts
import { describe, it, expect } from 'vitest';
import { buildDigest, mapStatus, type DigestInput } from '../src/web/hermes/digest.js';

const base: DigestInput = {
  id: 's1', name: 'sess', status: 'idle', transcript: null, subagents: [], phase: null, lastActivityAt: 100,
};

describe('mapStatus', () => {
  it('collapses the five-value enum into three', () => {
    expect(mapStatus('busy')).toBe('working');
    expect(mapStatus('idle')).toBe('idle');
    expect(['stopped', 'error', 'archived', 'weird'].map(mapStatus)).toEqual(['stopped', 'stopped', 'stopped', 'stopped']);
  });
});

describe('buildDigest', () => {
  it('reports done only when transcript complete + idle + no tool running', () => {
    expect(buildDigest({ ...base, status: 'idle', transcript: { isComplete: true, toolExecuting: false, lastAssistantMessage: 'hi' } }).done).toBe(true);
    expect(buildDigest({ ...base, status: 'busy', transcript: { isComplete: true, toolExecuting: false, lastAssistantMessage: 'hi' } }).done).toBe(false);
    expect(buildDigest({ ...base, status: 'idle', transcript: { isComplete: true, toolExecuting: true, lastAssistantMessage: 'x' } }).done).toBe(false);
    expect(buildDigest({ ...base, transcript: null }).done).toBe(false);
  });

  it('surfaces lastAssistantMessage and null when no transcript', () => {
    expect(buildDigest({ ...base, transcript: { isComplete: true, toolExecuting: false, lastAssistantMessage: 'done!' } }).lastAssistantMessage).toBe('done!');
    expect(buildDigest({ ...base, transcript: null }).lastAssistantMessage).toBeNull();
  });

  it('lists only non-completed subagents and maps description→doing', () => {
    const d = buildDigest({
      ...base,
      subagents: [
        { agentId: 'a1', description: 'Explore code', status: 'active', lastActivityAt: 1 },
        { agentId: 'a2', description: 'old', status: 'completed', lastActivityAt: 1 },
      ],
    });
    expect(d.subagents.count).toBe(1);
    expect(d.subagents.active).toEqual([{ name: 'a1', doing: 'Explore code', status: 'active' }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- hermes-digest`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/web/hermes/digest.ts
export interface TranscriptStateLite {
  isComplete: boolean;
  toolExecuting: boolean;
  lastAssistantMessage: string | null;
}
export interface DigestSubagent { name: string; doing: string | null; status: string; }
export interface DigestInput {
  id: string;
  name: string;
  status: string;
  transcript: TranscriptStateLite | null;
  subagents: Array<{ description?: string; status: string; agentId: string; lastActivityAt: number }>;
  phase: string | null;
  lastActivityAt: number | null;
}
export interface Digest {
  id: string;
  name: string;
  status: 'working' | 'idle' | 'stopped';
  done: boolean;
  toolExecuting: boolean;
  lastAssistantMessage: string | null;
  subagents: { count: number; active: DigestSubagent[] };
  phase: string | null;
  lastActivityAt: number | null;
}

export function mapStatus(raw: string): 'working' | 'idle' | 'stopped' {
  if (raw === 'busy') return 'working';
  if (raw === 'idle') return 'idle';
  return 'stopped';
}

export function buildDigest(input: DigestInput): Digest {
  const status = mapStatus(input.status);
  const t = input.transcript;
  const active = input.subagents
    .filter((s) => s.status !== 'completed')
    .map((s) => ({ name: s.agentId, doing: s.description ?? null, status: s.status }));
  return {
    id: input.id,
    name: input.name,
    status,
    done: Boolean(t?.isComplete && !t.toolExecuting && status === 'idle'),
    toolExecuting: Boolean(t?.toolExecuting),
    lastAssistantMessage: t?.lastAssistantMessage ?? null,
    subagents: { count: active.length, active },
    phase: input.phase,
    lastActivityAt: input.lastActivityAt,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- hermes-digest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/hermes/digest.ts test/hermes-digest.test.ts
git commit -m "feat(hermes): pure session-digest shaper"
```

---

## Task 5: Expose transcript state on the ConfigPort

**Files:**
- Modify: `src/web/ports/config-port.ts` (add one method to the `ConfigPort` interface, near the existing `getTranscriptPath`/`startTranscriptWatcher` declarations, ~lines 21-23)
- Modify: `src/web/server.ts` (implement the method using `this.transcriptWatchers`; the map is declared at `server.ts:256` as `private transcriptWatchers: Map<string, TranscriptWatcher>`)

**Interfaces:**
- Consumes: `TranscriptStateLite` from `src/web/hermes/digest.ts` (Task 4).
- Produces: `getTranscriptState(sessionId: string): import('../hermes/digest.js').TranscriptStateLite | null` on `ConfigPort` — returns `{ isComplete, toolExecuting, lastAssistantMessage }` from the session's `TranscriptWatcher.getState()`, or `null` when no watcher is attached.

- [ ] **Step 1: Add the method to the ConfigPort interface**

In `src/web/ports/config-port.ts`, alongside the existing transcript methods (after `getTranscriptPath(sessionId: string): string | null;`):

```ts
  /** Lite transcript state for the Hermes digest; null when no watcher is attached. */
  getTranscriptState(sessionId: string): import('../hermes/digest.js').TranscriptStateLite | null;
```

- [ ] **Step 2: Implement it on the server**

In `src/web/server.ts`, add a private method next to `stopTranscriptWatcher` (around line 904):

```ts
  private getTranscriptState(
    sessionId: string
  ): import('./hermes/digest.js').TranscriptStateLite | null {
    const watcher = this.transcriptWatchers.get(sessionId);
    if (!watcher) return null;
    const s = watcher.getState();
    return {
      isComplete: s.isComplete,
      toolExecuting: s.toolExecuting,
      lastAssistantMessage: s.lastAssistantMessage,
    };
  }
```

- [ ] **Step 3: Wire it into the `ctx` object**

In `src/web/server.ts`, find where the ctx object literal is built (the same place `startTranscriptWatcher: this.startTranscriptWatcher.bind(this)` appears, ~line 580) and add:

```ts
      getTranscriptState: this.getTranscriptState.bind(this),
```

- [ ] **Step 4: Typecheck**

Run: `npm run build` (or `npx tsc --noEmit`)
Expected: no type errors. (If `tsc` reports the ELOOP/self-symlink issue from project memory, ensure `dist`/`node_modules` are not committed self-symlinks per commit 7dde8b22.)

- [ ] **Step 5: Commit**

```bash
git add src/web/ports/config-port.ts src/web/server.ts
git commit -m "feat(hermes): expose lite transcript state via ConfigPort"
```

---

## Task 6: Hermes REST routes (`/api/feature`, `/api/fix`, digest)

**Files:**
- Create: `src/web/routes/hermes-routes.ts`
- Modify: `src/web/server.ts` (call `registerHermesRoutes(this.app, ctx)` next to the other `register…Routes(this.app, ctx)` calls, ~line 775)

**Interfaces:**
- Consumes: `resolveParentSession` (Task 1), `slugifyBranch` (Task 2), `renderTaskMd` + `WORKTREE_CLAUDE_MD` (Task 3), `buildDigest` (Task 4), `ctx.getTranscriptState` (Task 5), `subagentWatcher.getSubagentsForSession` (`src/subagent-watcher.ts`), and the existing `POST /api/sessions/:id/worktree` handler shape.
- Produces: three routes. `POST /api/feature` and `POST /api/fix` return `{ success: true, data: { sessionId, branch, worktreePath, started } }`. `GET /api/sessions/:id/digest` returns `{ success: true, data: Digest }`.

**Design notes (read before implementing):**
- The route does NOT re-implement worktree creation. It resolves the parent, renders templates, then performs an **in-process call to the server's own worktree endpoint** via Fastify's `app.inject` (no network, runs the real handler incl. port allocation, session registration, and start). Use `autoStart: true` and pass the kickoff prompt as `notes` so the existing handler starts Claude and sends the first message.
- Serialize per resolved parent id with a module-level `Map<string, Promise<unknown>>` lock so two concurrent calls against the same parent can't race on branch reservation.
- Branch-collision retry: the worktree handler already detects collisions (`handleBranchCollision`); on a collision response, retry with `-2`, `-3`, … suffixes (max 5 attempts) before failing.

- [ ] **Step 1: Implement the routes**

```ts
// src/web/routes/hermes-routes.ts
import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js'; // same source session-routes.ts uses
import type { ConfigPort } from '../ports/config-port.js';
import type { SessionPort } from '../ports/session-port.js';
import { subagentWatcher } from '../../subagent-watcher.js';
import { resolveParentSession, type ResolverSession } from '../hermes/parent-resolver.js';
import { slugifyBranch } from '../hermes/branch-slug.js';
import { renderTaskMd, WORKTREE_CLAUDE_MD } from '../hermes/task-templates.js';
import { buildDigest } from '../hermes/digest.js';

// One in-flight worktree-create per parent session id.
const parentLocks = new Map<string, Promise<unknown>>();
function withParentLock<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = parentLocks.get(parentId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  parentLocks.set(parentId, next.catch(() => {}));
  return next;
}

interface StartBody {
  project: string;
  title: string;
  description: string;
  acceptance?: string;
  parentSessionId?: string;
}

export function registerHermesRoutes(app: FastifyInstance, ctx: SessionPort & ConfigPort): void {
  const startHandler = (kind: 'feature' | 'fix') => async (req: { body: unknown }) => {
    const body = req.body as Partial<StartBody>;
    if (!body?.project || !body?.title || !body?.description) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'project, title, and description are required');
    }

    const sessions = (ctx.getLightSessionsState() as ResolverSession[]);
    const resolved = resolveParentSession(sessions, body.project, body.parentSessionId);
    if (!resolved.ok) {
      const code = resolved.code === 'INVALID_INPUT' ? ApiErrorCode.INVALID_INPUT : ApiErrorCode.NOT_FOUND;
      return { ...createErrorResponse(code, resolved.message), candidates: resolved.candidates };
    }
    const parentId = resolved.sessionId;

    const taskMd = renderTaskMd(kind, { title: body.title, description: body.description, acceptance: body.acceptance });
    const notes = 'Read TASK.md in this directory, then invoke the codeman-task-runner skill.';

    return withParentLock(parentId, async () => {
      const prefix = kind === 'fix' ? 'fix' : 'feat';
      let lastErr = 'unknown error';
      for (let attempt = 1; attempt <= 5; attempt++) {
        const branch = attempt === 1
          ? slugifyBranch(body.title!, prefix)
          : `${slugifyBranch(body.title!, prefix)}-${attempt}`;

        const res = await app.inject({
          method: 'POST',
          url: `/api/sessions/${parentId}/worktree`,
          payload: { branch, isNew: true, autoStart: true, notes, taskMd, claudeMd: WORKTREE_CLAUDE_MD },
        });
        const json = res.json() as
          | { success: true; session: { id: string }; worktreePath: string }
          | { success: false; errorCode?: string; error?: string; message?: string };

        if (json.success) {
          return {
            success: true,
            data: { sessionId: json.session.id, branch, worktreePath: json.worktreePath, started: true },
          };
        }
        // Worktree route error shape: { success:false, errorCode: 'ALREADY_EXISTS',
        //   error: 'BRANCH_EXISTS_UNMERGED: ...' } (see worktree-session-routes.ts handleBranchCollision)
        lastErr = json.error ?? json.message ?? json.errorCode ?? `HTTP ${res.statusCode}`;
        const isCollision = json.errorCode === 'ALREADY_EXISTS' || /BRANCH_EXISTS|already exist/i.test(lastErr);
        if (!isCollision) break; // non-collision failure — stop retrying
      }
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Could not create worktree: ${lastErr}`);
    });
  };

  app.post('/api/feature', startHandler('feature'));
  app.post('/api/fix', startHandler('fix'));

  app.get('/api/sessions/:id/digest', async (req) => {
    const { id } = req.params as { id: string };
    const sessions = ctx.getLightSessionsState() as Array<{
      id: string; name: string; status: string; workingDir?: string;
      worktreeBranch?: string | null; lastActivityAt?: number; taskPhase?: string | null;
    }>;
    const s = sessions.find((x) => x.id === id);
    if (!s) return createErrorResponse(ApiErrorCode.NOT_FOUND, `No session "${id}"`);

    const subagents = s.workingDir ? subagentWatcher.getSubagentsForSession(s.workingDir) : [];
    const digest = buildDigest({
      id: s.id,
      name: s.name,
      status: s.status,
      transcript: ctx.getTranscriptState(id),
      subagents,
      phase: s.taskPhase ?? null,
      lastActivityAt: s.lastActivityAt ?? null,
    });
    return { success: true, data: digest };
  });
}
```

> Implementer note: confirm the exact import path/symbols for `createErrorResponse`/`ApiErrorCode` by copying the import block from `src/web/routes/session-routes.ts` (lines ~13-16), and confirm the `ctx` port-union type matches how neighboring `register…Routes` functions type their `ctx` parameter (e.g. `SessionPort & EventPort & ConfigPort & InfraPort`). Use the same union. If `getLightSessionsState()` items do not include `lastActivityAt`/`taskPhase`, pass `null` for those fields (the digest tolerates nulls) — do not block on them.

- [ ] **Step 2: Register the routes in the server**

In `src/web/server.ts`, near the other registrations (~line 775, after `registerWorktreeSessionRoutes(this.app, ctx);`):

```ts
    registerHermesRoutes(this.app, ctx);
```

Add the import at the top with the other route imports:

```ts
import { registerHermesRoutes } from './routes/hermes-routes.js';
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 4: Smoke-test against a dev server**

Start a dev server on a spare port (per project memory):

```bash
nohup npx tsx src/index.ts web --port 3009 > /tmp/codeman-3009.log 2>&1 &
sleep 6
# Need a main (non-worktree) session for a project first — list what's available:
curl -s http://localhost:3009/api/sessions | npx --yes json -a id name status workingDir worktreeBranch 2>/dev/null || curl -s http://localhost:3009/api/sessions
```

Then exercise the digest on any existing session id and (optionally) a feature spin-up against a real project session:

```bash
curl -s http://localhost:3009/api/sessions/SOME_ID/digest
curl -s -X POST http://localhost:3009/api/feature \
  -H 'Content-Type: application/json' \
  -d '{"project":"PROJECT_BASENAME","title":"hermes smoke test","description":"no-op smoke test feature"}'
```

Expected: digest returns `{ success: true, data: { status, done, lastAssistantMessage, subagents, ... } }`; `/api/feature` returns `{ success: true, data: { sessionId, branch, worktreePath, started: true } }` and a new worktree session appears in `/api/sessions`. Clean up the test worktree afterward. Kill the dev server: `pkill -f "tsx src/index.ts web --port 3009"`.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/hermes-routes.ts src/web/server.ts
git commit -m "feat(hermes): /api/feature, /api/fix, and /api/sessions/:id/digest routes"
```

---

## Task 7: MCP facade — auth forwarding + new tools

**Files:**
- Modify: `src/mcp-server.ts`
- Test: `test/mcp-auth.test.ts`

**Interfaces:**
- Consumes: the REST endpoints from Task 6, plus existing `/api/sessions`.
- Produces: a pure, exported `buildAuthHeaders(env)` helper, and four new MCP tools (`list_projects`, `get_session_digest`, `start_feature`, `start_fix`); `send_message` switched to `{ input, submit: true }`.

- [ ] **Step 1: Write the failing test for the auth helper**

```ts
// test/mcp-auth.test.ts
import { describe, it, expect } from 'vitest';
import { buildAuthHeaders } from '../src/mcp-server.js';

describe('buildAuthHeaders', () => {
  it('returns no auth header when no password is set', () => {
    expect(buildAuthHeaders({})).toEqual({ 'Content-Type': 'application/json' });
  });
  it('adds Basic auth from CODEMAN_PASSWORD with default admin user', () => {
    const h = buildAuthHeaders({ CODEMAN_PASSWORD: 'secret' });
    expect(h.Authorization).toBe('Basic ' + Buffer.from('admin:secret').toString('base64'));
  });
  it('honors CODEMAN_USERNAME', () => {
    const h = buildAuthHeaders({ CODEMAN_USERNAME: 'siggi', CODEMAN_PASSWORD: 'pw' });
    expect(h.Authorization).toBe('Basic ' + Buffer.from('siggi:pw').toString('base64'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- mcp-auth`
Expected: FAIL — `buildAuthHeaders` is not exported.

- [ ] **Step 3: Add the auth helper and route all fetches through it**

At the top of `src/mcp-server.ts`, after `const BASE = …`:

```ts
export function buildAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const password = env.CODEMAN_PASSWORD;
  if (password) {
    const user = env.CODEMAN_USERNAME || 'admin';
    headers.Authorization = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  }
  return headers;
}

const AUTH = buildAuthHeaders();
```

Then update every `fetch` to send `AUTH`:
- `listSessions`: `fetch(\`${BASE}/api/sessions\`, { headers: AUTH })`
- `resolveSessionId`: same.
- `sendMessage`: change body to `JSON.stringify({ input: message, submit: true })` and `headers: AUTH` (drop the manual `+ '\r'` and `useMux` — `submit:true` makes the server append `\r`).

- [ ] **Step 4: Add the new tool definitions**

Append to the `TOOLS` array:

```ts
  {
    name: 'list_projects',
    description: 'List repos you can start work in. Returns each main (non-worktree) session: id, name, project (workingDir basename), status, workingDir.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_session_digest',
    description: "Digest of one session: status (working/idle/stopped), done (true only when truly finished), toolExecuting, lastAssistantMessage, active subagents, phase. Poll this to answer 'is it done?'.",
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Session id.' } },
      required: ['id'],
    },
  },
  {
    name: 'start_feature',
    description: 'Spin up a new feature worktree in a project and start it working autonomously. Returns the new session id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project name (workingDir basename), e.g. "Codeman".' },
        title: { type: 'string', description: 'One-line feature title.' },
        description: { type: 'string', description: 'What it should do.' },
        acceptance: { type: 'string', description: 'Optional acceptance criteria.' },
        parentSessionId: { type: 'string', description: 'Optional: pick the exact parent session if a project has several.' },
      },
      required: ['project', 'title', 'description'],
    },
  },
  {
    name: 'start_fix',
    description: 'Spin up a new fix worktree in a project and start it working autonomously. Returns the new session id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project name (workingDir basename).' },
        title: { type: 'string', description: 'One-line bug title.' },
        description: { type: 'string', description: 'What is broken / how to reproduce.' },
        parentSessionId: { type: 'string', description: 'Optional explicit parent session id.' },
      },
      required: ['project', 'title', 'description'],
    },
  },
```

- [ ] **Step 5: Add the handlers and dispatch cases**

Add handler functions near `listSessions`:

```ts
async function listProjects(): Promise<unknown> {
  const res = await fetch(`${BASE}/api/sessions`, { headers: AUTH });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const sessions = (await res.json()) as Session[];
  return sessions
    .filter((s) => !s.worktreeBranch)
    .map((s) => ({
      id: s.id,
      name: s.name,
      project: (s.workingDir ?? '').replace(/\/+$/, '').split('/').pop() ?? '',
      status: s.status,
      workingDir: s.workingDir,
    }));
}

async function getSessionDigest(args: Record<string, unknown>): Promise<unknown> {
  const id = args.id as string;
  if (!id) throw new Error('id is required');
  const res = await fetch(`${BASE}/api/sessions/${id}/digest`, { headers: AUTH });
  if (!res.ok) throw new Error(`No digest for "${id}": ${res.status}`);
  return (await res.json());
}

async function startWork(path: 'feature' | 'fix', args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as { success?: boolean }).success === false) {
    throw new Error(`start_${path} failed: ${JSON.stringify(body)}`);
  }
  return body;
}
```

Add cases to the `tools/call` switch:

```ts
          case 'list_projects':
            result = await listProjects();
            break;
          case 'get_session_digest':
            result = await getSessionDigest(args);
            break;
          case 'start_feature':
            result = await startWork('feature', args);
            break;
          case 'start_fix':
            result = await startWork('fix', args);
            break;
```

- [ ] **Step 6: Run the auth test + typecheck**

Run: `npm test -- mcp-auth` → Expected: PASS (3 tests).
Run: `npm run build` → Expected: no type errors.

> Note: `mcp-server.ts` previously had no exports (it's an entrypoint). Exporting `buildAuthHeaders` is safe — the stdin handler still runs on import. Verify the server still starts: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/mcp-server.js` lists all 6 tools.

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server.ts test/mcp-auth.test.ts
git commit -m "feat(hermes): MCP auth forwarding + list_projects/get_session_digest/start_feature/start_fix tools"
```

---

## Task 8: End-to-end MCP smoke test + docs

**Files:**
- Create: `docs/hermes-integration.md` (how to point Hermes at the MCP server)
- No code; this task verifies the whole path and documents it.

- [ ] **Step 1: Drive the MCP server over stdio against a live dev server**

Start a dev server (Task 6 Step 4), then:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}' \
  | CODEMAN_URL=http://localhost:3009 node dist/mcp-server.js
```

Expected: `initialize` returns serverInfo; `tools/list` shows 6 tools; `list_projects` returns the main sessions. Then call `get_session_digest` with a real id and confirm `done`/`status`/`lastAssistantMessage` fields are present.

- [ ] **Step 2: Verify auth forwarding**

Restart the dev server with a password and confirm the facade still works:

```bash
pkill -f "tsx src/index.ts web --port 3009"
CODEMAN_PASSWORD=testpw nohup npx tsx src/index.ts web --port 3009 > /tmp/codeman-3009.log 2>&1 &
sleep 6
# Without auth → 401:
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3009/api/sessions   # expect 401
# Via MCP facade with matching env → works:
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}' \
  | CODEMAN_URL=http://localhost:3009 CODEMAN_PASSWORD=testpw node dist/mcp-server.js
```

Expected: the raw curl returns `401`; the MCP call returns the project list. Kill the dev server afterward.

- [ ] **Step 3: Write the integration doc**

`docs/hermes-integration.md` — document: the MCP server command (`node dist/mcp-server.js`), the `CODEMAN_URL`/`CODEMAN_USERNAME`/`CODEMAN_PASSWORD` env vars, the six tools with one-line descriptions and example arguments, and the recommended Hermes loop (`start_feature` → poll `get_session_digest` until `done` → `send_message` to nudge). Note that merge/close stays a human step in v1.

- [ ] **Step 4: Run the full unit suite**

Run: `npm test`
Expected: all new `hermes-*` and `mcp-auth` tests pass; no regressions.

- [ ] **Step 5: Commit**

```bash
git add docs/hermes-integration.md
git commit -m "docs(hermes): integration guide for driving Codeman over MCP"
```

---

## Self-Review

**Spec coverage:**
- Architecture (MCP facade → REST → substrate) → Tasks 6, 7. ✓
- `list_projects`, `list_sessions`, `get_session_digest` → Task 7 (list_sessions already exists), Task 6 (digest). ✓
- `start_feature`/`start_fix` with template-fill, parentSessionId, branch retry, per-parent serialization, `started` flag → Tasks 1-3, 6, 7. ✓
- `send_message` via `submit:true` → Task 7. ✓
- Digest `done`/`toolExecuting`/`lastAssistantMessage` from transcript watcher; null when absent → Tasks 4, 5, 6. ✓
- Status collapse 5→3 → Task 4. ✓
- Auth forwarding → Task 7, verified Task 8. ✓
- Parent resolution precision + candidate list on ambiguity → Task 1, surfaced in Task 6. ✓
- Out of scope (merge/close, remote transport) → not implemented; documented in Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the two implementer notes point to exact existing files/lines to copy import shapes from, not vague instructions. ✓

**Type consistency:** `TranscriptStateLite` defined in Task 4, reused by Tasks 5 & 6. `ResolverSession`/`ResolveResult` (Task 1), `TaskSpec`/`WORKTREE_CLAUDE_MD` (Task 3), `DigestInput`/`Digest` (Task 4) used consistently downstream. `buildAuthHeaders` (Task 7) name matches its test. Route return shape `{ success, data: { sessionId, branch, worktreePath, started } }` consistent between Task 6 producer and Task 7 consumer. ✓

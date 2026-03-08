# Worktree Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add git worktree support so users can spawn isolated Claude sessions on parallel branches via a `+` button in the session tab bar.

**Architecture:** Thin layer on top of existing session infrastructure. Worktree sessions are normal sessions with three extra metadata fields (`worktreePath`, `worktreeBranch`, `worktreeOriginId`). A new `WorktreeStore` persists dormant worktrees. New API routes handle git operations. Frontend adds a `+` button → picker modal → worktree creator + cleanup modal on session exit.

**Tech Stack:** TypeScript, Node.js `execFile` (promisified via `promisify`, same pattern as `update-routes.ts`) for git ops, Zod v4 for validation, vanilla JS + HTML for frontend modals.

---

## Task 1: Add worktree fields to SessionState and SessionConfig types

**Files:**
- Modify: `src/types/session.ts`

**Step 1: Add three optional fields to SessionConfig**

In `src/types/session.ts`, after the `workingDir: string` field on `SessionConfig` (around line 64), add:

```typescript
  /** Path to git worktree directory if this is a worktree session */
  worktreePath?: string;
  /** Git branch checked out in this worktree */
  worktreeBranch?: string;
  /** Session ID that spawned this worktree session */
  worktreeOriginId?: string;
```

**Step 2: Add same fields to SessionState**

After the `workingDir: string` field on `SessionState` (around line 85), add the same three fields.

**Step 3: Type-check**

```bash
tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

**Step 4: Commit**

```bash
git add src/types/session.ts
git commit -m "feat: add worktree metadata fields to SessionState and SessionConfig"
```

---

## Task 2: Wire worktree fields through Session class

**Files:**
- Modify: `src/session.ts`

**Step 1: Add instance fields near other readonly fields (around line 360)**

```typescript
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  readonly worktreeOriginId?: string;
```

**Step 2: Assign in constructor after `this.workingDir = config.workingDir` (line ~397)**

```typescript
    this.worktreePath = config.worktreePath;
    this.worktreeBranch = config.worktreeBranch;
    this.worktreeOriginId = config.worktreeOriginId;
```

**Step 3: Include in `toState()` (line ~761) after `workingDir: this.workingDir`**

```typescript
      worktreePath: this.worktreePath,
      worktreeBranch: this.worktreeBranch,
      worktreeOriginId: this.worktreeOriginId,
```

**Step 4: Type-check**

```bash
tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add src/session.ts
git commit -m "feat: wire worktree fields through Session class and toState()"
```

---

## Task 3: Create git utility module

**Files:**
- Create: `src/utils/git-utils.ts`

**Step 1: Write the file**

Follow the same pattern as `update-routes.ts` — use `promisify` + `execFile` from `node:child_process`.

All git args are passed as arrays (never interpolated into shell strings), preventing injection.

```typescript
/**
 * @fileoverview Git utility functions for worktree management.
 * Uses execFile (array args, no shell) to prevent injection.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const execFileP = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, timeout: 30_000 });
  return stdout.trim();
}

/**
 * Walk up from startDir to find the directory containing .git.
 * Returns null if not found.
 */
export function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * List all branches (local + remote), deduped, HEAD filtered.
 */
export async function listBranches(repoDir: string): Promise<string[]> {
  const output = await git(['branch', '-a', '--format=%(refname:short)'], repoDir);
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const raw of output.split('\n')) {
    const branch = raw.trim().replace(/^origin\//, '');
    if (!branch || branch === 'HEAD' || branch.includes('->')) continue;
    if (!seen.has(branch)) { seen.add(branch); branches.push(branch); }
  }
  return branches;
}

/** Get current branch name in repoDir. */
export async function getCurrentBranch(repoDir: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
}

/**
 * Create a git worktree.
 * @param isNew - true = create new branch, false = checkout existing
 */
export async function addWorktree(
  repoDir: string, worktreePath: string, branch: string, isNew: boolean
): Promise<void> {
  const args = isNew
    ? ['worktree', 'add', worktreePath, '-b', branch]
    : ['worktree', 'add', worktreePath, branch];
  await git(args, repoDir);
}

/** Remove a git worktree. Pass force=true to handle uncommitted changes. */
export async function removeWorktree(
  repoDir: string, worktreePath: string, force = false
): Promise<void> {
  const args = ['worktree', 'remove', worktreePath, ...(force ? ['--force'] : [])];
  await git(args, repoDir);
}

/** Returns true if the worktree has uncommitted changes. */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  try {
    const status = await git(['status', '--porcelain'], worktreePath);
    return status.length > 0;
  } catch { return false; }
}

/** Merge branch into the current branch at targetDir. Returns stdout. */
export async function mergeBranch(targetDir: string, branch: string): Promise<string> {
  return git(['merge', branch, '--no-edit'], targetDir);
}
```

**Step 2: Type-check**

```bash
tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/utils/git-utils.ts
git commit -m "feat: add git utilities for worktree management"
```

---

## Task 4: Create WorktreeStore for dormant worktrees

**Files:**
- Create: `src/worktree-store.ts`

**Step 1: Write the file**

```typescript
/**
 * @fileoverview Persistent store for dormant (kept) worktrees.
 * Saves to ~/.codeman/worktrees.json. Synchronous reads, synchronous writes
 * (file is small, infrequently written — mirrors push-store.ts pattern).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface DormantWorktree {
  id: string;
  path: string;
  branch: string;
  originSessionId: string;
  projectName: string;
  createdAt: string;
}

export class WorktreeStore {
  private readonly filePath: string;
  private worktrees: DormantWorktree[] = [];

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(homedir(), '.codeman', 'worktrees.json');
    this._load();
  }

  private _load(): void {
    try {
      if (existsSync(this.filePath)) {
        this.worktrees = JSON.parse(readFileSync(this.filePath, 'utf8')) as DormantWorktree[];
      }
    } catch { this.worktrees = []; }
  }

  private _save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.worktrees, null, 2), 'utf8');
  }

  getAll(): DormantWorktree[] { return [...this.worktrees]; }

  get(id: string): DormantWorktree | undefined {
    return this.worktrees.find((w) => w.id === id);
  }

  add(entry: Omit<DormantWorktree, 'id' | 'createdAt'>): DormantWorktree {
    const w: DormantWorktree = { id: randomUUID(), createdAt: new Date().toISOString(), ...entry };
    this.worktrees.push(w);
    this._save();
    return w;
  }

  remove(id: string): boolean {
    const before = this.worktrees.length;
    this.worktrees = this.worktrees.filter((w) => w.id !== id);
    if (this.worktrees.length !== before) { this._save(); return true; }
    return false;
  }
}

let _instance: WorktreeStore | null = null;
export function getWorktreeStore(): WorktreeStore {
  if (!_instance) _instance = new WorktreeStore();
  return _instance;
}
```

**Step 2: Type-check**

```bash
tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/worktree-store.ts
git commit -m "feat: add WorktreeStore for dormant worktree persistence"
```

---

## Task 5: Add Zod schemas for worktree routes

**Files:**
- Modify: `src/web/schemas.ts`

**Step 1: Add at the bottom of the file**

```typescript
export const CreateWorktreeSchema = z.object({
  branch: z.string().min(1).max(200),
  isNew: z.boolean(),
});

export const RemoveWorktreeSchema = z.object({
  force: z.boolean().optional(),
});

export const DeleteDormantWorktreeSchema = z.object({
  removeDisk: z.boolean().optional(),
});

export const MergeWorktreeSchema = z.object({
  branch: z.string().min(1).max(200),
});

export const SaveDormantWorktreeSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
  originSessionId: z.string(),
  projectName: z.string(),
});
```

**Step 2: Type-check and commit**

```bash
tsc --noEmit && git add src/web/schemas.ts && git commit -m "feat: add Zod schemas for worktree API routes"
```

---

## Task 6: Create session-scoped worktree routes

**Files:**
- Create: `src/web/routes/worktree-session-routes.ts`

**Step 1: Write the file**

```typescript
/**
 * @fileoverview Session-scoped worktree routes.
 *
 * GET    /api/sessions/:id/worktree/branches  — list branches
 * POST   /api/sessions/:id/worktree           — create worktree + new session
 * POST   /api/sessions/:id/worktree/merge     — merge branch into session's dir
 * DELETE /api/sessions/:id/worktree           — remove worktree from disk
 */

import { FastifyInstance } from 'fastify';
import { dirname, join } from 'node:path';
import { Session } from '../../session.js';
import { SseEvent } from '../sse-events.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import {
  CreateWorktreeSchema,
  RemoveWorktreeSchema,
  MergeWorktreeSchema,
} from '../schemas.js';
import {
  findGitRoot,
  listBranches,
  getCurrentBranch,
  addWorktree,
  removeWorktree,
  isWorktreeDirty,
  mergeBranch,
} from '../../utils/git-utils.js';
import type { SessionPort, EventPort, ConfigPort } from '../ports/index.js';

// Validate branch name: alphanumeric, dots, hyphens, forward slashes only
const BRANCH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

export function registerWorktreeSessionRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort
): void {

  // GET /api/sessions/:id/worktree/branches
  app.get('/api/sessions/:id/worktree/branches', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);
    if (!session) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');

    const gitRoot = findGitRoot(session.workingDir);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Not a git repository');

    try {
      const [branches, current] = await Promise.all([
        listBranches(gitRoot),
        getCurrentBranch(gitRoot),
      ]);
      return { success: true, branches, current };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `git error: ${String(err)}`);
    }
  });

  // POST /api/sessions/:id/worktree
  app.post('/api/sessions/:id/worktree', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);
    if (!session) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');

    const parsed = CreateWorktreeSchema.safeParse(req.body);
    if (!parsed.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');

    const { branch, isNew } = parsed.data;
    if (!BRANCH_PATTERN.test(branch)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid branch name');
    }

    const gitRoot = findGitRoot(session.workingDir);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Not a git repository');

    const projectName = gitRoot.split('/').pop() ?? 'project';
    const safeBranch = branch.replace(/\//g, '-');
    const worktreePath = join(dirname(gitRoot), `${projectName}-${safeBranch}`);

    try {
      await addWorktree(gitRoot, worktreePath, branch, isNew);
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create worktree: ${String(err)}`);
    }

    const [globalNice, modelConfig, claudeModeConfig] = await Promise.all([
      ctx.getGlobalNiceConfig(),
      ctx.getModelConfig(),
      ctx.getClaudeModeConfig(),
    ]);

    const newSession = new Session({
      workingDir: worktreePath,
      mode: session.mode,
      name: branch,
      useMux: true,
      niceConfig: globalNice,
      model: modelConfig?.defaultModel,
      claudeMode: claudeModeConfig.claudeMode,
      allowedTools: claudeModeConfig.allowedTools,
      worktreePath,
      worktreeBranch: branch,
      worktreeOriginId: id,
    });

    ctx.addSession(newSession);
    ctx.persistSessionState(newSession);
    await ctx.setupSessionListeners(newSession);

    const lightState = ctx.getSessionStateWithRespawn(newSession);
    ctx.broadcast(SseEvent.SessionCreated, lightState);
    return { success: true, session: lightState, worktreePath };
  });

  // POST /api/sessions/:id/worktree/merge
  app.post('/api/sessions/:id/worktree/merge', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);
    if (!session) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');

    const parsed = MergeWorktreeSchema.safeParse(req.body);
    if (!parsed.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    if (!BRANCH_PATTERN.test(parsed.data.branch)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid branch name');
    }

    try {
      const output = await mergeBranch(session.workingDir, parsed.data.branch);
      return { success: true, output };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Merge failed: ${String(err)}`);
    }
  });

  // DELETE /api/sessions/:id/worktree
  app.delete('/api/sessions/:id/worktree', async (req) => {
    const { id } = req.params as { id: string };
    const session = ctx.sessions.get(id);
    if (!session) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    if (!session.worktreePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Session is not a worktree session');
    }

    const parsed = RemoveWorktreeSchema.safeParse(req.body);
    const force = parsed.success ? (parsed.data.force ?? false) : false;

    // Find git root from origin session or from worktree path
    const originSession = session.worktreeOriginId
      ? ctx.sessions.get(session.worktreeOriginId)
      : undefined;
    const gitRoot = findGitRoot(originSession?.workingDir ?? session.worktreePath ?? session.workingDir);
    if (!gitRoot) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Cannot find git root');

    if (!force) {
      const dirty = await isWorktreeDirty(session.worktreePath);
      if (dirty) {
        return {
          success: false,
          dirty: true,
          message: 'Worktree has uncommitted changes. Pass force:true to remove anyway.',
        };
      }
    }

    try {
      await removeWorktree(gitRoot, session.worktreePath, force);
      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to remove worktree: ${String(err)}`);
    }
  });
}
```

**Step 2: Type-check**

```bash
tsc --noEmit 2>&1 | head -30
```
Fix any type errors (the `mux` field is internal to Session — the constructor accepts it via config, so passing `useMux: true` without `mux` uses the server's registered mux via the session-manager). If there are errors about missing `ConfigPort` methods, check `src/web/ports/config-port.ts` for the exact method names (`getGlobalNiceConfig`, `getModelConfig`, `getClaudeModeConfig`).

**Step 3: Commit**

```bash
git add src/web/routes/worktree-session-routes.ts
git commit -m "feat: add session-scoped worktree routes"
```

---

## Task 7: Create dormant worktree CRUD routes

**Files:**
- Create: `src/web/routes/worktree-routes.ts`

**Step 1: Write the file**

```typescript
/**
 * @fileoverview Dormant worktree management routes.
 *
 * GET    /api/worktrees            — list dormant worktrees
 * POST   /api/worktrees            — save a worktree as dormant ("Keep" action)
 * POST   /api/worktrees/:id/resume — resume a dormant worktree (spawn new session)
 * DELETE /api/worktrees/:id        — remove dormant entry (and optionally disk)
 */

import { FastifyInstance } from 'fastify';
import { Session } from '../../session.js';
import { SseEvent } from '../sse-events.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getWorktreeStore } from '../../worktree-store.js';
import { findGitRoot, removeWorktree } from '../../utils/git-utils.js';
import { SaveDormantWorktreeSchema, DeleteDormantWorktreeSchema } from '../schemas.js';
import type { SessionPort, EventPort, ConfigPort } from '../ports/index.js';

export function registerWorktreeRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort
): void {
  const store = getWorktreeStore();

  // GET /api/worktrees
  app.get('/api/worktrees', async () => {
    return { success: true, worktrees: store.getAll() };
  });

  // POST /api/worktrees — save dormant
  app.post('/api/worktrees', async (req) => {
    const parsed = SaveDormantWorktreeSchema.safeParse(req.body);
    if (!parsed.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    const entry = store.add(parsed.data);
    return { success: true, worktree: entry };
  });

  // POST /api/worktrees/:id/resume
  app.post('/api/worktrees/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    const entry = store.get(id);
    if (!entry) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Dormant worktree not found');

    const [globalNice, modelConfig, claudeModeConfig] = await Promise.all([
      ctx.getGlobalNiceConfig(),
      ctx.getModelConfig(),
      ctx.getClaudeModeConfig(),
    ]);

    const session = new Session({
      workingDir: entry.path,
      name: entry.branch,
      useMux: true,
      niceConfig: globalNice,
      model: modelConfig?.defaultModel,
      claudeMode: claudeModeConfig.claudeMode,
      allowedTools: claudeModeConfig.allowedTools,
      worktreePath: entry.path,
      worktreeBranch: entry.branch,
      worktreeOriginId: entry.originSessionId,
    });

    ctx.addSession(session);
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    store.remove(id);

    const lightState = ctx.getSessionStateWithRespawn(session);
    ctx.broadcast(SseEvent.SessionCreated, lightState);
    return { success: true, session: lightState };
  });

  // DELETE /api/worktrees/:id
  app.delete('/api/worktrees/:id', async (req) => {
    const { id } = req.params as { id: string };
    const entry = store.get(id);
    if (!entry) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Dormant worktree not found');

    const parsed = DeleteDormantWorktreeSchema.safeParse(req.body);
    const removeDisk = parsed.success ? (parsed.data.removeDisk ?? false) : false;

    if (removeDisk) {
      const gitRoot = findGitRoot(entry.path);
      if (gitRoot) {
        try { await removeWorktree(gitRoot, entry.path, true); } catch { /* best-effort */ }
      }
    }

    store.remove(id);
    return { success: true };
  });
}
```

**Step 2: Type-check and commit**

```bash
tsc --noEmit 2>&1 | head -20
git add src/web/routes/worktree-routes.ts
git commit -m "feat: add dormant worktree CRUD routes"
```

---

## Task 8: Register routes in barrel and server

**Files:**
- Modify: `src/web/routes/index.ts`
- Modify: `src/web/server.ts`

**Step 1: Add to barrel (`src/web/routes/index.ts`)**

Append after the last export:

```typescript
export { registerWorktreeSessionRoutes } from './worktree-session-routes.js';
export { registerWorktreeRoutes } from './worktree-routes.js';
```

**Step 2: Import in server (`src/web/server.ts`)**

Find the existing route imports (around line 103) and add:

```typescript
  registerWorktreeSessionRoutes,
  registerWorktreeRoutes,
```

**Step 3: Register after `registerUpdateRoutes` (around line 714)**

```typescript
    registerWorktreeSessionRoutes(this.app, ctx);
    registerWorktreeRoutes(this.app, ctx);
```

**Step 4: Type-check and commit**

```bash
tsc --noEmit 2>&1 | head -20
git add src/web/routes/index.ts src/web/server.ts
git commit -m "feat: register worktree routes in server"
```

---

## Task 9: Add SSE event for worktree session ended

**Files:**
- Modify: `src/web/sse-events.ts`
- Modify: `src/web/public/constants.js`
- Modify: `src/web/server.ts` (emit the event)

**Step 1: Add to sse-events.ts**

After the last `SessionX` export constant, add:

```typescript
/** Emitted when a worktree session exits — triggers cleanup modal on frontend */
export const WorktreeSessionEnded = 'worktree:sessionEnded' as const;
```

Also add `WorktreeSessionEnded` to the array at the bottom of the file (`ALL_SSE_EVENTS` or equivalent export list).

**Step 2: Add to SSE_EVENTS in constants.js**

In the `SSE_EVENTS` object (around line 191), add:

```javascript
  WORKTREE_SESSION_ENDED: 'worktree:sessionEnded',
```

**Step 3: Emit the event on session exit**

In `src/web/server.ts`, find where `SseEvent.SessionExit` is broadcast. After that broadcast, add:

```typescript
if (session.worktreeBranch) {
  ctx.broadcast(SseEvent.WorktreeSessionEnded, {
    id: session.id,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    worktreeOriginId: session.worktreeOriginId,
  });
}
```

**Step 4: Type-check and commit**

```bash
tsc --noEmit 2>&1 | head -20
git add src/web/sse-events.ts src/web/public/constants.js src/web/server.ts
git commit -m "feat: add WorktreeSessionEnded SSE event and emit on session exit"
```

---

## Task 10: Add branch badge to session tabs

**Files:**
- Modify: `src/web/public/styles.css`
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/index.html`

**Step 1: Add CSS to styles.css (after .tab-badge styles)**

```css
.tab-worktree-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  background: var(--color-success, #22c55e);
  color: #fff;
  border-radius: 3px;
  padding: 1px 4px;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
```

**Step 2: In `_fullRenderSessionTabs()` in app.js (around line 3665), compute badge**

After the `subagentBadge` variable:

```javascript
      const worktreeBadge = session.worktreeBranch
        ? `<span class="tab-worktree-badge" title="Worktree: ${escapeHtml(session.worktreeBranch)}">🌿 ${escapeHtml(session.worktreeBranch)}</span>`
        : '';
```

Then in the tab HTML template (around line 3688), add after `${subagentBadge}`:

```javascript
${worktreeBadge}
```

**Step 3: Bump versions in index.html**

- `styles.css?v=0.1638` → `styles.css?v=0.1639`
- `app.js?v=0.4.18` → `app.js?v=0.4.19`

**Step 4: Commit**

```bash
git add src/web/public/styles.css src/web/public/app.js src/web/public/index.html
git commit -m "feat: add worktree branch badge to session tabs"
```

---

## Task 11: Add + button to session tab bar

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/styles.css`

**Step 1: In index.html, add button after the `#sessionTabs` div**

Find `<div class="session-tabs" id="sessionTabs" ...>` (line 58) and after the closing `</div>`, add:

```html
<button class="tab-add-btn" onclick="app.openNewPicker()" title="New session or worktree" aria-label="New session or worktree">+</button>
```

**Step 2: Add CSS to styles.css**

```css
.tab-add-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 18px;
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
  align-self: center;
  line-height: 1;
}
.tab-add-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
```

**Step 3: Bump styles.css version**

`styles.css?v=0.1639` → `styles.css?v=0.1640`

**Step 4: Commit**

```bash
git add src/web/public/index.html src/web/public/styles.css
git commit -m "feat: add + button to session tab bar"
```

---

## Task 12: Add modal HTML for picker, creator, and cleanup

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/styles.css`

**Step 1: Add three modals to index.html before `</body>`**

```html
<!-- New Session/Worktree Picker -->
<div class="modal" id="newPickerModal">
  <div class="modal-backdrop" onclick="app.closeNewPicker()"></div>
  <div class="modal-content modal-content-sm">
    <div class="modal-header">
      <h3>New</h3>
      <button class="modal-close" onclick="app.closeNewPicker()" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body new-picker-body">
      <button class="new-picker-tile" onclick="app.closeNewPicker(); app.quickStart()">
        <span class="new-picker-icon">🖥</span>
        <span class="new-picker-label">Session</span>
      </button>
      <button class="new-picker-tile" onclick="app.openWorktreeCreator()">
        <span class="new-picker-icon">🌿</span>
        <span class="new-picker-label">Worktree</span>
      </button>
    </div>
  </div>
</div>

<!-- Worktree Creator -->
<div class="modal" id="worktreeCreatorModal">
  <div class="modal-backdrop" onclick="app.closeWorktreeCreator()"></div>
  <div class="modal-content">
    <div class="modal-header">
      <h3>New Worktree</h3>
      <button class="modal-close" onclick="app.closeWorktreeCreator()" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body" id="worktreeCreatorBody"></div>
  </div>
</div>

<!-- Worktree Cleanup -->
<div class="modal" id="worktreeCleanupModal">
  <div class="modal-backdrop"></div>
  <div class="modal-content">
    <div class="modal-header">
      <h3>Worktree ended: <span id="worktreeCleanupBranch"></span></h3>
    </div>
    <div class="modal-body">
      <p>What should happen to the worktree?</p>
      <div class="worktree-cleanup-actions">
        <button class="btn btn-danger" onclick="app.worktreeCleanupRemove()">Remove worktree</button>
        <button class="btn btn-secondary" onclick="app.worktreeCleanupKeep()">Keep worktree</button>
        <button class="btn btn-primary" id="worktreeCleanupMergeBtn" onclick="app.worktreeCleanupMerge()">
          Merge into <span id="worktreeCleanupMergeTarget"></span>
        </button>
      </div>
      <div id="worktreeCleanupOutput" class="worktree-cleanup-output" style="display:none"></div>
    </div>
  </div>
</div>
```

**Step 2: Add CSS to styles.css**

```css
.modal-content-sm { max-width: 320px; }

.new-picker-body {
  display: flex;
  gap: 16px;
  padding: 24px;
  justify-content: center;
}
.new-picker-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 32px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
  cursor: pointer;
  transition: background 0.15s;
}
.new-picker-tile:hover { background: var(--color-hover); }
.new-picker-icon { font-size: 28px; }
.new-picker-label { font-weight: 500; font-size: 14px; }

.worktree-cleanup-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.worktree-cleanup-output {
  margin-top: 12px;
  padding: 8px;
  background: var(--color-code-bg, #1e1e1e);
  border-radius: 4px;
  font-family: monospace;
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}
.worktree-section-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--color-text-muted); margin-bottom: 6px; }
.worktree-resume-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-surface);
  cursor: pointer;
  text-align: left;
  margin-bottom: 4px;
}
.worktree-resume-btn:hover { background: var(--color-hover); }
.worktree-resume-project { color: var(--color-text-muted); font-size: 12px; }
.worktree-divider { margin: 12px 0; border: none; border-top: 1px solid var(--color-border); }
.worktree-session-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.worktree-session-radio { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.worktree-branch-type { display: flex; gap: 16px; margin-bottom: 8px; }
.worktree-branch-type label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.worktree-path-preview { font-size: 12px; color: var(--color-text-muted); margin: 6px 0 12px; font-family: monospace; }
.worktree-creator-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
```

**Step 3: Bump styles.css version**

`styles.css?v=0.1640` → `styles.css?v=0.1641`

**Step 4: Commit**

```bash
git add src/web/public/index.html src/web/public/styles.css
git commit -m "feat: add worktree modals to HTML (picker, creator, cleanup)"
```

---

## Task 13: Implement picker and creator JS methods

**Files:**
- Modify: `src/web/public/app.js`

**Step 1: Add the following methods to the App class (near `openSessionOptions`)**

```javascript
  openNewPicker() {
    document.getElementById('newPickerModal').classList.add('active');
  }

  closeNewPicker() {
    document.getElementById('newPickerModal').classList.remove('active');
  }

  async openWorktreeCreator() {
    this.closeNewPicker();
    // Only non-worktree sessions can be source
    const gitSessions = [...this.sessions.values()].filter(s => !s.worktreeBranch);
    this._worktreeCreatorSessions = gitSessions;
    this._worktreeCreatorSourceId = gitSessions.length === 1 ? gitSessions[0].id : null;

    let dormant = [];
    try {
      const res = await fetch('/api/worktrees');
      const data = await res.json();
      if (data.success) dormant = data.worktrees;
    } catch {}
    this._dormantWorktrees = dormant;

    this._renderWorktreeCreator();
    document.getElementById('worktreeCreatorModal').classList.add('active');
  }

  closeWorktreeCreator() {
    document.getElementById('worktreeCreatorModal').classList.remove('active');
  }

  _renderWorktreeCreator() {
    const body = document.getElementById('worktreeCreatorBody');
    const dormant = this._dormantWorktrees || [];
    const sessions = this._worktreeCreatorSessions || [];
    const sourceId = this._worktreeCreatorSourceId;
    let html = '';

    if (dormant.length > 0) {
      html += `<div class="worktree-section-label">Resume</div>`;
      dormant.forEach(w => {
        html += `<button class="worktree-resume-btn" onclick="app._resumeWorktree('${escapeHtml(w.id)}')">🌿 ${escapeHtml(w.branch)} <span class="worktree-resume-project">${escapeHtml(w.projectName)}</span></button>`;
      });
      html += `<hr class="worktree-divider">`;
    }

    if (!sourceId && sessions.length > 1) {
      html += `<div class="worktree-section-label">Branch from</div><div class="worktree-session-list">`;
      sessions.forEach(s => {
        html += `<label class="worktree-session-radio"><input type="radio" name="worktreeSource" value="${escapeHtml(s.id)}" onchange="app._worktreeCreatorSourceId=this.value; app._loadWorktreeBranches(this.value);"> ${escapeHtml(this.getSessionName(s))}</label>`;
      });
      html += `</div>`;
    } else if (sourceId) {
      this._loadWorktreeBranches(sourceId);
    }

    html += `<div id="worktreeBranchPicker" style="display:${sourceId ? 'block' : 'none'}">
      <div class="worktree-section-label">Branch</div>
      <div class="worktree-branch-type">
        <label><input type="radio" name="worktreeBranchType" value="new" checked onchange="app._onWorktreeBranchTypeChange(this.value)"> New branch</label>
        <label><input type="radio" name="worktreeBranchType" value="existing" onchange="app._onWorktreeBranchTypeChange(this.value)"> Existing</label>
      </div>
      <input type="text" id="worktreeNewBranchInput" class="form-input" placeholder="feature/my-thing" oninput="app._updateWorktreePathPreview()">
      <select id="worktreeExistingBranchSelect" class="form-select" style="display:none" onchange="app._updateWorktreePathPreview()"><option value="">Loading...</option></select>
      <div class="worktree-path-preview" id="worktreePathPreview"></div>
      <div class="worktree-creator-actions">
        <button class="btn btn-secondary" onclick="app.closeWorktreeCreator()">Cancel</button>
        <button class="btn btn-primary" onclick="app._submitCreateWorktree()">Create</button>
      </div>
    </div>`;

    body.innerHTML = html;
  }

  async _loadWorktreeBranches(sessionId) {
    const picker = document.getElementById('worktreeBranchPicker');
    if (picker) picker.style.display = 'block';
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/worktree/branches`);
      const data = await res.json();
      if (!data.success) return;
      const sel = document.getElementById('worktreeExistingBranchSelect');
      if (sel) sel.innerHTML = data.branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    } catch {}
  }

  _onWorktreeBranchTypeChange(type) {
    const newInput = document.getElementById('worktreeNewBranchInput');
    const existSel = document.getElementById('worktreeExistingBranchSelect');
    if (newInput) newInput.style.display = type === 'new' ? '' : 'none';
    if (existSel) existSel.style.display = type === 'existing' ? '' : 'none';
    this._updateWorktreePathPreview();
  }

  _updateWorktreePathPreview() {
    const type = document.querySelector('input[name="worktreeBranchType"]:checked')?.value ?? 'new';
    const branch = type === 'new'
      ? (document.getElementById('worktreeNewBranchInput')?.value ?? '')
      : (document.getElementById('worktreeExistingBranchSelect')?.value ?? '');
    const preview = document.getElementById('worktreePathPreview');
    if (preview) preview.textContent = branch ? `Path: ../project-${branch.replace(/\//g, '-')}` : '';
  }

  async _resumeWorktree(id) {
    this.closeWorktreeCreator();
    try {
      const res = await fetch(`/api/worktrees/${encodeURIComponent(id)}/resume`, { method: 'POST' });
      const data = await res.json();
      if (data.success) this.selectSession(data.session.id);
      else alert('Failed to resume worktree: ' + (data.error || 'Unknown error'));
    } catch (err) { alert('Failed to resume worktree: ' + err.message); }
  }

  async _submitCreateWorktree() {
    const sourceId = this._worktreeCreatorSourceId;
    if (!sourceId) { alert('Please select a source session'); return; }
    const type = document.querySelector('input[name="worktreeBranchType"]:checked')?.value ?? 'new';
    const isNew = type === 'new';
    const branch = (isNew
      ? document.getElementById('worktreeNewBranchInput')?.value
      : document.getElementById('worktreeExistingBranchSelect')?.value
    )?.trim() ?? '';
    if (!branch) { alert('Please enter a branch name'); return; }

    const btn = document.querySelector('#worktreeCreatorBody .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sourceId)}/worktree`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch, isNew }),
      });
      const data = await res.json();
      if (data.success) { this.closeWorktreeCreator(); this.selectSession(data.session.id); }
      else {
        alert('Failed to create worktree: ' + (data.error || 'Unknown error'));
        if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
      }
    } catch (err) {
      alert('Failed to create worktree: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
    }
  }
```

**Step 2: Bump app.js version in index.html**

`app.js?v=0.4.19` → `app.js?v=0.4.20`

**Step 3: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html
git commit -m "feat: implement worktree creator UI (picker, branch select, resume)"
```

---

## Task 14: Implement cleanup modal JS and SSE handler

**Files:**
- Modify: `src/web/public/app.js`

**Step 1: Register SSE handler in the listener map (around line 174)**

```javascript
[SSE_EVENTS.WORKTREE_SESSION_ENDED, '_onWorktreeSessionEnded'],
```

**Step 2: Add handler and cleanup methods to App class**

```javascript
  _onWorktreeSessionEnded(data) {
    this._pendingWorktreeCleanup = data;
    document.getElementById('worktreeCleanupBranch').textContent = data.worktreeBranch;
    const originSession = data.worktreeOriginId ? this.sessions.get(data.worktreeOriginId) : null;
    document.getElementById('worktreeCleanupMergeTarget').textContent =
      originSession ? this.getSessionName(originSession) : 'origin';
    const out = document.getElementById('worktreeCleanupOutput');
    out.style.display = 'none';
    out.textContent = '';
    document.getElementById('worktreeCleanupModal').classList.add('active');
  }

  _closeWorktreeCleanupModal() {
    document.getElementById('worktreeCleanupModal').classList.remove('active');
    this._pendingWorktreeCleanup = null;
  }

  async worktreeCleanupRemove() {
    const data = this._pendingWorktreeCleanup;
    if (!data) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(data.id)}/worktree`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: false }),
      });
      const result = await res.json();
      if (result.dirty) {
        if (!confirm('The worktree has uncommitted changes. Remove anyway?')) return;
        await fetch(`/api/sessions/${encodeURIComponent(data.id)}/worktree`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        });
      }
      this._closeWorktreeCleanupModal();
    } catch (err) { alert('Failed to remove worktree: ' + err.message); }
  }

  async worktreeCleanupKeep() {
    const data = this._pendingWorktreeCleanup;
    if (!data) return;
    const originSession = data.worktreeOriginId ? this.sessions.get(data.worktreeOriginId) : null;
    const projectName = originSession?.workingDir?.split('/').pop() ?? 'project';
    try {
      await fetch('/api/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: data.worktreePath,
          branch: data.worktreeBranch,
          originSessionId: data.worktreeOriginId ?? '',
          projectName,
        }),
      });
    } catch {}
    this._closeWorktreeCleanupModal();
  }

  async worktreeCleanupMerge() {
    const data = this._pendingWorktreeCleanup;
    if (!data) return;
    const originSession = data.worktreeOriginId ? this.sessions.get(data.worktreeOriginId) : null;
    if (!originSession) { alert('Origin session not found. Cannot merge.'); return; }
    const out = document.getElementById('worktreeCleanupOutput');
    out.style.display = 'block';
    out.textContent = 'Merging...';
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(originSession.id)}/worktree/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: data.worktreeBranch }),
      });
      const result = await res.json();
      out.textContent = result.success
        ? (result.output || 'Merge successful.')
        : ('Merge failed: ' + (result.error || 'Unknown error') + '\n\nWorktree kept on disk.');
      if (result.success) setTimeout(() => this._closeWorktreeCleanupModal(), 2000);
    } catch (err) {
      out.textContent = 'Merge error: ' + err.message + '\n\nWorktree kept on disk.';
    }
  }
```

**Step 3: Bump app.js version in index.html**

`app.js?v=0.4.20` → `app.js?v=0.4.21`

**Step 4: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html
git commit -m "feat: implement worktree cleanup modal (remove, keep, merge)"
```

---

## Task 15: Write route tests for dormant worktree CRUD

**Files:**
- Create: `test/routes/worktree-routes.test.ts`

**Step 1: Check available port numbers (no conflicts)**

```bash
grep -r "const PORT = " test/ | head -20
```
Pick an unused port (e.g. 3099 if available — but these tests use `app.inject()` so no port needed).

**Step 2: Write tests**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerWorktreeRoutes } from '../../src/web/routes/worktree-routes.js';
import { WorktreeStore } from '../../src/worktree-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

// Mock git ops so no real git repo needed
vi.mock('../../src/utils/git-utils.js', () => ({
  findGitRoot: () => '/tmp/test-repo',
  removeWorktree: vi.fn().mockResolvedValue(undefined),
}));

let _mockStore: WorktreeStore;
vi.mock('../../src/worktree-store.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/worktree-store.js')>();
  return {
    ...mod,
    getWorktreeStore: () => _mockStore,
  };
});

describe('worktree routes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codeman-wt-test-'));
    _mockStore = new WorktreeStore(join(tmpDir, 'worktrees.json'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/worktrees returns empty list initially', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/worktrees' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.worktrees).toEqual([]);
  });

  it('POST /api/worktrees saves a dormant worktree', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/api/worktrees',
      payload: { path: '/tmp/proj-feat', branch: 'feat', originSessionId: 'abc', projectName: 'proj' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.worktree.branch).toBe('feat');
    expect(body.worktree.id).toBeTruthy();
  });

  it('DELETE /api/worktrees/:id removes entry', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeRoutes);

    const saveRes = await app.inject({
      method: 'POST', url: '/api/worktrees',
      payload: { path: '/tmp/proj-feat', branch: 'feat', originSessionId: 'abc', projectName: 'proj' },
    });
    const { worktree } = JSON.parse(saveRes.body);

    const delRes = await app.inject({
      method: 'DELETE', url: `/api/worktrees/${worktree.id}`,
      payload: { removeDisk: false },
    });
    expect(JSON.parse(delRes.body).success).toBe(true);

    const listRes = await app.inject({ method: 'GET', url: '/api/worktrees' });
    expect(JSON.parse(listRes.body).worktrees).toHaveLength(0);
  });

  it('DELETE /api/worktrees/:id returns not-found for unknown id', async () => {
    const { app } = await createRouteTestHarness(registerWorktreeRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/worktrees/00000000-0000-0000-0000-000000000000',
      payload: {},
    });
    expect(JSON.parse(res.body).success).toBe(false);
  });
});
```

**Step 3: Run tests**

```bash
npx vitest run test/routes/worktree-routes.test.ts
```
Expected: 4 tests pass.

**Step 4: Commit**

```bash
git add test/routes/worktree-routes.test.ts
git commit -m "test: add route tests for dormant worktree CRUD"
```

---

## Task 16: Smoke test and deploy

**Step 1: Type-check and lint the full project**

```bash
tsc --noEmit && npm run lint
```
Expected: no errors.

**Step 2: Run dev server**

```bash
npx tsx src/index.ts web --port 3001
```

**Step 3: Verify + button appears and API works**

```bash
# In a separate terminal:
curl -s localhost:3001/api/worktrees | jq
# Expected: { "success": true, "worktrees": [] }
```

Open browser at `http://localhost:3001` and confirm:
- `+` button is visible in the tab bar
- Clicking `+` opens the "New" picker with Session and Worktree tiles
- Clicking Worktree opens the creator modal

**Step 4: Deploy**

```bash
npm run build
cp -r dist /home/siggi/.codeman/app/
cp package.json /home/siggi/.codeman/app/package.json
systemctl --user restart codeman-web
```

**Step 5: Verify production**

```bash
curl -s localhost:3001/api/worktrees | jq
```

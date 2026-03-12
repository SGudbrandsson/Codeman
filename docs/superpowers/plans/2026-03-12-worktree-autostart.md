# Worktree Auto-Start Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `autoStart` boolean to `POST /api/sessions/:id/worktree` (and the cases variant) so the Claude process spawns immediately on worktree creation without user interaction.

**Architecture:** Add `autoStart` to `CreateWorktreeSchema`, write failing tests, then implement: destructure `autoStart` in both worktree route handlers and after broadcasting `SessionCreated` call `startInteractive()`/`startShell()` + broadcast `SessionInteractive`/`SessionUpdated`. Pattern follows `session-routes.ts:867-888` (quick-start). Both skill doc copies updated.

**Tech Stack:** TypeScript strict mode, Zod v4, Fastify, node-pty, tmux. Tests use Vitest + `app.inject()` (no live port). Run single test files only — **never** `npx vitest run` without a file path (it spawns tmux and will crash the managed session).

---

## Chunk 1: Schema

### Task 1: Add `autoStart` to `CreateWorktreeSchema`

**Files:**
- Modify: `src/web/schemas.ts`

- [ ] **Step 1.1: Read the schema**

  Read `src/web/schemas.ts` and find `CreateWorktreeSchema` (around line 594).

- [ ] **Step 1.2: Add the field**

  Add `autoStart: z.boolean().optional()` after `notes`. Result:
  ```typescript
  export const CreateWorktreeSchema = z.object({
    branch: z.string().min(1).max(200),
    isNew: z.boolean(),
    mode: z.enum(['claude', 'opencode', 'shell']).optional(),
    notes: z.string().max(2000).optional(),
    autoStart: z.boolean().optional(),
  });
  ```

- [ ] **Step 1.3: Type-check**

  ```bash
  tsc --noEmit 2>&1 | head -20
  ```
  Expected: no errors.

- [ ] **Step 1.4: Commit**

  ```bash
  git add src/web/schemas.ts
  git commit -m "feat(schema): add autoStart field to CreateWorktreeSchema"
  ```

---

## Chunk 2: Tests (write before implementation — TDD)

### Task 2: Extend mock setup and write failing tests

**Files:**
- Modify: `test/routes/worktree-session-routes.test.ts` (file already exists)

**Context:** The existing `MockSessionConstructor` (lines 16–27 of the test file) does not have `startInteractive` or `startShell` methods. Tests for `autoStart: true` will throw unless these are added. The `session-lifecycle-log.js` module also needs to be mocked since the route will call `getLifecycleLog().log(...)` after our changes.

- [ ] **Step 2.1: Read the test file**

  Read `test/routes/worktree-session-routes.test.ts` — understand the existing mock setup and `describe` block structure.

- [ ] **Step 2.2: Add mock for `session-lifecycle-log.js`**

  At the top of the file, after the existing `vi.mock('../../src/utils/git-utils.js', ...)` block, add:
  ```typescript
  vi.mock('../../src/session-lifecycle-log.js', () => ({
    getLifecycleLog: vi.fn().mockReturnValue({ log: vi.fn() }),
  }));
  ```

- [ ] **Step 2.3: Add `startInteractive` and `startShell` to `MockSessionConstructor`**

  The existing mock object inside `vi.mock('../../src/session.js', ...)` assigns properties via `Object.assign`. Add `startInteractive` and `startShell` to the assigned object:
  ```typescript
  Object.assign(this as object, {
    id: 'new-session-id',
    workingDir: '/tmp/worktree',
    worktreePath: '/tmp/worktree',
    worktreeBranch: 'feature/test',
    worktreeOriginId: 'origin-id',
    mode: 'claude',
    toState: () => ({ id: 'new-session-id' }),
    startInteractive: vi.fn().mockResolvedValue(undefined),
    startShell: vi.fn().mockResolvedValue(undefined),
  });
  ```

- [ ] **Step 2.4: Write failing tests for autoStart behaviour**

  Add the following tests inside the existing `describe('worktree-session routes', ...)` block, after the existing POST worktree tests (around line 124):

  ```typescript
  // ---------------------------------------------------------------------------
  // POST /api/sessions/:id/worktree — autoStart behaviour
  // ---------------------------------------------------------------------------

  it('POST worktree — autoStart omitted → startInteractive NOT called', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/test', isNew: true, notes: 'do something' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // MockSessionConstructor always assigns id: 'new-session-id'
    const newSession = ctx.sessions.get('new-session-id') as { startInteractive: ReturnType<typeof vi.fn> };
    expect(newSession.startInteractive).not.toHaveBeenCalled();
  });

  it('POST worktree — autoStart:true, claude mode → startInteractive called', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/test', isNew: true, notes: 'do something', autoStart: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    const newSession = ctx.sessions.get('new-session-id') as { startInteractive: ReturnType<typeof vi.fn> };
    expect(newSession.startInteractive).toHaveBeenCalledOnce();
  });

  it('POST worktree — autoStart:true, shell mode → startShell called, not startInteractive', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/test', isNew: true, mode: 'shell', autoStart: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    const newSession = ctx.sessions.get('new-session-id') as {
      startShell: ReturnType<typeof vi.fn>;
      startInteractive: ReturnType<typeof vi.fn>;
    };
    expect(newSession.startShell).toHaveBeenCalledOnce();
    expect(newSession.startInteractive).not.toHaveBeenCalled();
  });

  it('POST worktree — autoStart:true, startInteractive throws → still success:true', async () => {
    const { app, ctx } = await createRouteTestHarness(registerWorktreeSessionRoutes);
    // Patch addSession to override startInteractive with a rejecting mock before the route calls it.
    const origAddSession = ctx.addSession.bind(ctx);
    ctx.addSession = vi.fn().mockImplementation((s: unknown) => {
      (s as { startInteractive: () => Promise<void> }).startInteractive = vi
        .fn()
        .mockRejectedValue(new Error('spawn failed'));
      return origAddSession(s);
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${ctx._sessionId}/worktree`,
      payload: { branch: 'feature/test', isNew: true, autoStart: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });
  ```

  > `ctx.sessions.get('new-session-id')` reliably retrieves the newly created session because `MockSessionConstructor` always assigns `id: 'new-session-id'`. No changes to `_route-test-utils.ts` are needed.

- [ ] **Step 2.5: Run tests to confirm they fail (expected red state)**

  ```bash
  npx vitest run test/routes/worktree-session-routes.test.ts 2>&1 | tail -30
  ```
  Expected: the 4 new autoStart tests fail because the route doesn't yet destructure or use `autoStart`.

- [ ] **Step 2.6: Commit the failing tests**

  ```bash
  git add test/routes/worktree-session-routes.test.ts
  git commit -m "test(worktree): add failing tests for autoStart behaviour (TDD red state)"
  ```

---

## Chunk 3: Implementation

### Task 3: Add `getLifecycleLog` import to route file

**Files:**
- Modify: `src/web/routes/worktree-session-routes.ts`

- [ ] **Step 3.1: Read the imports section**

  Read `src/web/routes/worktree-session-routes.ts` lines 1–35.

- [ ] **Step 3.2: Add import**

  Add after the existing imports:
  ```typescript
  import { getLifecycleLog } from '../../session-lifecycle-log.js';
  ```

- [ ] **Step 3.3: Type-check**

  ```bash
  tsc --noEmit 2>&1 | head -20
  ```
  Expected: no errors.

- [ ] **Step 3.4: Commit**

  ```bash
  git add src/web/routes/worktree-session-routes.ts
  git commit -m "feat(worktree): import getLifecycleLog for auto-start lifecycle logging"
  ```

---

### Task 4: Implement autoStart in the sessions route

**Files:**
- Modify: `src/web/routes/worktree-session-routes.ts`

- [ ] **Step 4.1: Read the sessions route handler**

  Read `src/web/routes/worktree-session-routes.ts` lines 78–145.

- [ ] **Step 4.2: Destructure `autoStart` at line 87**

  Change:
  ```typescript
  const { branch, isNew, mode, notes } = parsed.data;
  ```
  To:
  ```typescript
  const { branch, isNew, mode, notes, autoStart } = parsed.data;
  ```

- [ ] **Step 4.3: Insert auto-start block before the return statement**

  The return at line ~143 reads:
  ```typescript
  return { success: true, session: lightState, worktreePath };
  ```

  Insert immediately before it:
  ```typescript
  if (autoStart) {
    try {
      if (newSession.mode === 'shell') {
        await newSession.startShell();
        getLifecycleLog().log({ event: 'started', sessionId: newSession.id, name: newSession.name, mode: 'shell' });
        ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: 'shell' });
      } else {
        await newSession.startInteractive();
        getLifecycleLog().log({ event: 'started', sessionId: newSession.id, name: newSession.name, mode: newSession.mode });
        ctx.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: newSession.mode });
      }
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(newSession) });
    } catch (err) {
      console.error(`[worktree] autoStart failed for session ${newSession.id}:`, err);
    }
  }
  ```

  > **Note on `SessionInteractive` payload:** The non-shell branch uses `{ id, mode }` matching the quick-start pattern at `session-routes.ts:886`. The start-existing-session pattern at line 412 omits `mode` — but that's for restarting an already-known session; here (like quick-start) mode is new information for the UI.

- [ ] **Step 4.4: Type-check**

  ```bash
  tsc --noEmit 2>&1 | head -20
  ```
  Expected: no errors.

- [ ] **Step 4.5: Commit**

  ```bash
  git add src/web/routes/worktree-session-routes.ts
  git commit -m "feat(worktree): implement autoStart in sessions worktree route"
  ```

---

### Task 5: Implement autoStart in the cases route

**Files:**
- Modify: `src/web/routes/worktree-session-routes.ts`

- [ ] **Step 5.1: Read the cases route handler**

  Read `src/web/routes/worktree-session-routes.ts` lines 238–290.

- [ ] **Step 5.2: Destructure `autoStart` at line ~245**

  Change:
  ```typescript
  const { branch, isNew, mode, notes } = parsed.data;
  ```
  To:
  ```typescript
  const { branch, isNew, mode, notes, autoStart } = parsed.data;
  ```

- [ ] **Step 5.3: Insert identical auto-start block before the cases return**

  Insert the same block from Task 4, step 4.3 immediately before:
  ```typescript
  return { success: true, session: lightState, worktreePath };
  ```

- [ ] **Step 5.4: Type-check**

  ```bash
  tsc --noEmit 2>&1 | head -20
  ```
  Expected: no errors.

- [ ] **Step 5.5: Commit**

  ```bash
  git add src/web/routes/worktree-session-routes.ts
  git commit -m "feat(worktree): implement autoStart in cases worktree route"
  ```

---

### Task 6: Run tests — confirm green

- [ ] **Step 6.1: Run the worktree route tests**

  ```bash
  npx vitest run test/routes/worktree-session-routes.test.ts 2>&1 | tail -30
  ```
  Expected: all tests pass, including the 4 new autoStart tests.

---

## Chunk 4: Skill Docs

### Task 7: Update both skill doc copies

**Files:**
- Modify: `skills/codeman-worktrees/SKILL.md`
- Modify: `~/.claude/skills/codeman-worktrees/SKILL.md`

- [ ] **Step 7.1: Verify the installed copy exists**

  ```bash
  ls ~/.claude/skills/codeman-worktrees/
  ```
  Expected: `SKILL.md` is listed.

- [ ] **Step 7.2: Read the current skill file**

  Read `skills/codeman-worktrees/SKILL.md` — focus on the body fields table and the Step 3 curl example.

- [ ] **Step 7.3: Add `autoStart` row to the body fields table**

  The table ends with the `notes` row. Add after it:
  ```
  | `autoStart` | boolean | no | `true` = immediately spawn Claude process after creation (default: omitted/false) |
  ```

- [ ] **Step 7.4: Update the example curl to include `autoStart`**

  Find the Step 3 curl example. Change the `-d` payload from:
  ```
  -d '{"branch": "feat/my-feature", "isNew": true, "notes": "Bug: hamburger menu blocked by overlay"}'
  ```
  To:
  ```
  -d '{"branch": "feat/my-feature", "isNew": true, "notes": "Bug: hamburger menu blocked by overlay", "autoStart": true}'
  ```

- [ ] **Step 7.5: Copy to the installed location**

  ```bash
  cp /home/siggi/sources/Codeman-feat-worktree-auto-start/skills/codeman-worktrees/SKILL.md ~/.claude/skills/codeman-worktrees/SKILL.md
  ```

- [ ] **Step 7.6: Verify both files match**

  ```bash
  diff /home/siggi/sources/Codeman-feat-worktree-auto-start/skills/codeman-worktrees/SKILL.md ~/.claude/skills/codeman-worktrees/SKILL.md
  ```
  Expected: no output.

- [ ] **Step 7.7: Commit**

  ```bash
  git add skills/codeman-worktrees/SKILL.md
  git commit -m "docs(skill): document autoStart field in codeman-worktrees skill"
  ```

---

## Final Verification

- [ ] **Type-check passes**

  ```bash
  tsc --noEmit 2>&1 | head -20
  ```

- [ ] **Lint passes**

  ```bash
  npm run lint 2>&1 | tail -10
  ```

- [ ] **All worktree route tests pass**

  ```bash
  npx vitest run test/routes/worktree-session-routes.test.ts 2>&1 | tail -20
  ```

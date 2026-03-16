# Session Architecture Rewrite Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate terminal/transcript view divergence by making session state server-authoritative and making "clear" an archive+new-child operation with navigable history.

**Architecture:** All session state lives on the server; the frontend is a stateless rendering layer with a short in-memory stale-while-revalidate cache. Clearing a session archives it and creates a linked child session, preserving history via a parent→child chain accessible through a breadcrumb UI.

**Tech Stack:** TypeScript, Fastify, vitest, SSE, tmux/PTY, vanilla JS frontend (app.js)

**Spec:** `docs/superpowers/specs/2026-03-16-session-architecture-rewrite-design.md`

---

## Chunk 1: Data Model + SSE Event

### Task 1: Extend SessionStatus and SessionState types

**Files:**
- Modify: `src/types/session.ts:30` (SessionStatus)
- Modify: `src/types/session.ts:196` (SessionState — add fields before closing brace)
- Test: `test/session-state.test.ts`

- [ ] **Step 1: Write failing tests for new fields**

Add to `test/session-state.test.ts`:
```typescript
it('SessionState accepts archived status', () => {
  const s: SessionState = {
    id: 'test-id', pid: null, status: 'archived',
    workingDir: '/tmp', currentTaskId: null,
    createdAt: Date.now(), lastActivityAt: Date.now(),
  };
  expect(s.status).toBe('archived');
});

it('SessionState accepts chain fields', () => {
  const s: SessionState = {
    id: 'child', pid: 123, status: 'idle',
    workingDir: '/tmp', currentTaskId: null,
    createdAt: Date.now(), lastActivityAt: Date.now(),
    parentSessionId: 'parent-id',
    childSessionId: 'grandchild-id',
    clearedAt: new Date().toISOString(),
    transcriptPath: '/home/user/.claude/transcripts/abc.jsonl',
  };
  expect(s.parentSessionId).toBe('parent-id');
  expect(s.transcriptPath).toContain('.jsonl');
});
```

- [ ] **Step 2: Run to verify fails**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/session-state.test.ts 2>&1 | tail -15
```
Expected: TypeScript type error — `'archived'` not assignable to `SessionStatus`

- [ ] **Step 3: Add `'archived'` to SessionStatus at line 30**

```typescript
// Before:
export type SessionStatus = 'idle' | 'busy' | 'stopped' | 'error';
// After:
export type SessionStatus = 'idle' | 'busy' | 'stopped' | 'error' | 'archived';
```

- [ ] **Step 4: Add four new optional fields to SessionState after `safeMode?: boolean;` (line 195)**

```typescript
  /** ID of the session that was cleared to create this one (archive chain) */
  parentSessionId?: string;
  /** ID of the child session created when this session was cleared */
  childSessionId?: string;
  /** ISO timestamp when this session was archived via clear */
  clearedAt?: string;
  /** Absolute path to Claude transcript file; captured at archive time */
  transcriptPath?: string;
```

- [ ] **Step 5: Run tests**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/session-state.test.ts 2>&1 | tail -15
```
Expected: PASS

- [ ] **Step 6: Run typecheck — fix any exhaustiveness warnings for new status value**

```bash
cd /home/siggi/sources/Codeman && npx tsc --noEmit 2>&1 | head -30
```
Fix any `switch` statements that are exhaustive over `SessionStatus` by adding an `'archived'` case.

- [ ] **Step 7: Commit**

```bash
git add src/types/session.ts test/session-state.test.ts
git commit -m "feat(types): add archived status and chain fields to SessionState"
```

---

### Task 2: Add `session:cleared` SSE event

**Files:**
- Modify: `src/web/sse-events.ts`
- Test: `test/sse-events.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/sse-events.test.ts`:
```typescript
it('defines session:cleared event constant', () => {
  expect(SessionCleared).toBe('session:cleared');
  expect(SseEvent.SessionCleared).toBe('session:cleared');
});
```

- [ ] **Step 2: Run to verify fails**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/sse-events.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Add the event constant in `src/web/sse-events.ts`**

Following the existing pattern (all events are `export const Name = 'event:name' as const`), add alongside `SessionDeleted`:

```typescript
/** Session was cleared; old session archived, new child session created. */
export const SessionCleared = 'session:cleared' as const;
```

Add the payload interface alongside other payload interfaces in the same file:

```typescript
/** Payload for the SessionCleared SSE event. */
export interface SessionClearedPayload {
  archivedId: string;
  newSessionId: string;
}
```

Add `SessionCleared` to the `SseEvent` namespace object (the `export const SseEvent = { ... } as const` block):

```typescript
SessionCleared,
```

- [ ] **Step 4: Run test**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/sse-events.test.ts 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/sse-events.ts test/sse-events.test.ts
git commit -m "feat(sse): add session:cleared event constant, payload type, and SseEvent entry"
```

---

### Task 3: Guard server startup from reattaching archived sessions

**Files:**
- Modify: `src/web/server.ts` (session startup reattachment loop)

Export a helper for the guard so it can be tested without spinning up a live server.

- [ ] **Step 1: Add `shouldAttemptReattach` to `src/web/server.ts` as a named export**

Find the startup session load loop (where stopped sessions are marked stopped and pids nulled). Add the guard and export the helper:

```typescript
/** Returns false for sessions that must never have tmux reattachment attempted. */
export function shouldAttemptReattach(session: SessionState): boolean {
  return session.status !== 'archived';
}
```

In the startup loop, before the reattachment logic:
```typescript
if (!shouldAttemptReattach(sessionState)) {
  // Archived sessions: load from state.json as-is, no tmux pane exists
  continue;
}
```

- [ ] **Step 2: Write a unit test for the helper**

Add to `test/session-state.test.ts` (already open):
```typescript
import { shouldAttemptReattach } from '../src/web/server.js';

it('shouldAttemptReattach returns false for archived sessions', () => {
  const s: SessionState = {
    id: 'x', pid: null, status: 'archived',
    workingDir: '/tmp', currentTaskId: null,
    createdAt: Date.now(), lastActivityAt: Date.now(),
  };
  expect(shouldAttemptReattach(s)).toBe(false);
});

it('shouldAttemptReattach returns true for stopped sessions', () => {
  const s: SessionState = {
    id: 'x', pid: null, status: 'stopped',
    workingDir: '/tmp', currentTaskId: null,
    createdAt: Date.now(), lastActivityAt: Date.now(),
  };
  expect(shouldAttemptReattach(s)).toBe(true);
});
```

- [ ] **Step 3: Run tests**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/session-state.test.ts 2>&1 | tail -15
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/web/server.ts test/session-state.test.ts
git commit -m "feat(server): skip tmux reattachment for archived sessions on restart"
```

---

## Chunk 2: Backend Clear Endpoint

### Task 4: Add `clearSession()` method to WebServer and MockRouteContext

**Files:**
- Modify: `src/web/server.ts`
- Modify: `test/mocks/mock-route-context.ts`
- Test: `test/session-cleanup.test.ts`

`clearSession` is the shared implementation: archives the old session, creates the child, broadcasts SSE. Both the route endpoint and the `/clear` terminal intercept call it.

- [ ] **Step 1: Write failing integration test**

`test/session-cleanup.test.ts` uses a live `WebServer` started on port 3120. Add a test at the end of the describe block:

```typescript
it('POST /api/sessions/:id/clear archives session and creates child', async () => {
  // Create a session first
  const createRes = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workingDir: '/tmp' }),
  });
  expect(createRes.status).toBe(200);
  const created = await createRes.json();
  const sessionId = created.id;
  createdSessions.push(sessionId);

  // Clear it
  const clearRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true }),
  });
  expect(clearRes.status).toBe(200);
  const { archivedSession, newSession } = await clearRes.json();

  expect(archivedSession.status).toBe('archived');
  expect(archivedSession.clearedAt).toBeDefined();
  expect(archivedSession.childSessionId).toBe(newSession.id);
  expect(newSession.parentSessionId).toBe(sessionId);
  createdSessions.push(newSession.id);
}, 20000);
```

- [ ] **Step 2: Run to verify fails**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/session-cleanup.test.ts -t "clear" 2>&1 | tail -20
```
Expected: 404 — endpoint does not exist yet

- [ ] **Step 3: Implement `clearSession()` in `src/web/server.ts`**

Add as a public method on `WebServer` (so it can be called from routes via `ctx`). Use the exact property names present in the class (`this.respawnControllers`, `this.runSummaryTrackers`, `this.transcriptWatchers`, `this.store`, `this.sessions`, `this.stopTranscriptWatcher`):

```typescript
async clearSession(sessionId: string, force: boolean): Promise<{
  archivedSession: SessionState;
  newSession: Session;
}> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  // 1. Stop RespawnController
  const respawnController = this.respawnControllers.get(sessionId);
  if (respawnController) {
    respawnController.stop();
    this.respawnControllers.delete(sessionId);
  }

  // 2. Stop Ralph tracker, subagents, run summary
  session.ralphTracker.fullReset();
  await subagentWatcher.killSubagentsForSession(session.workingDir, sessionId);
  const summaryTracker = this.runSummaryTrackers.get(sessionId);
  if (summaryTracker) {
    summaryTracker.recordSessionStopped();
    summaryTracker.stop();
    this.runSummaryTrackers.delete(sessionId);
  }

  // 3. Capture transcript path before stopping watcher
  const transcriptPath = this.transcriptWatchers.get(sessionId)?.transcriptPath ?? undefined;
  this.stopTranscriptWatcher(sessionId);

  // 4. Kill Claude process and tmux pane (session.stop(killMux) handles both)
  // The client only calls clearSession after the session is idle (waiting for idle SSE),
  // so we always call stop(true) to kill mux pane. The `force` param already handled
  // client-side (force=true skips the idle wait). Pass killMux=true always.
  await session.stop(true);

  // 5. Remove from live sessions map (stays in state.json as archived)
  this.sessions.delete(sessionId);

  // 6. Write archived state
  const archivedState = session.toState();
  archivedState.status = 'archived';
  archivedState.clearedAt = new Date().toISOString();
  archivedState.pid = null;
  if (transcriptPath) archivedState.transcriptPath = transcriptPath;
  this.store.setSession(sessionId, archivedState);

  // 7. Create child session inheriting safe config fields
  const childSession = new Session({
    workingDir: archivedState.workingDir,
    mux: this.mux,
    useMux: true,
    name: incrementSessionName(archivedState.name),
    color: archivedState.color,
    mode: archivedState.mode,
    mcpServers: archivedState.mcpServers,
    ralphEnabled: archivedState.ralphEnabled,
    // Do NOT inherit: tokens, cost, claudeResumeId, safeMode, draft
  });
  // Start the session, register listeners, persist
  await this.setupSessionListeners(childSession);
  this.sessions.set(childSession.id, childSession);
  const childState = childSession.toState();
  childState.parentSessionId = sessionId;
  this.store.setSession(childSession.id, childState);

  // 8. Link archived → child
  archivedState.childSessionId = childSession.id;
  this.store.setSession(sessionId, archivedState);
  this.store.save();

  // 9. Broadcast
  this.broadcast(SseEvent.SessionCleared, {
    archivedId: sessionId,
    newSessionId: childSession.id,
  } satisfies SessionClearedPayload);

  return { archivedSession: archivedState, newSession: childSession };
}
```

Note: `incrementSessionName` helper — add as a module-level function:
```typescript
function incrementSessionName(name?: string): string {
  if (!name) return 'Session';
  const match = name.match(/^(.*)\s\((\d+)\)$/);
  if (match) return `${match[1]!} (${parseInt(match[2]!) + 1})`;
  return `${name} (2)`;
}
```

Note: Adapt `new Session({...})` constructor options to match the exact `SessionConfig` fields used in the existing `POST /api/sessions` route handler (session-routes.ts lines 140-165). Copy the pattern from there.

- [ ] **Step 4: Add `clearSession` to `test/mocks/mock-route-context.ts`**

In the returned mock object, add alongside `cleanupSession`:
```typescript
clearSession: vi.fn(async (_id: string, _force: boolean) => ({
  archivedSession: { ...createMockSessionState({ status: 'archived', clearedAt: new Date().toISOString() }) },
  newSession: createMockSession('new-child-session'),
})),
```

- [ ] **Step 5: Run integration test**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/session-cleanup.test.ts -t "clear" 2>&1 | tail -20
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/server.ts test/mocks/mock-route-context.ts test/session-cleanup.test.ts
git commit -m "feat(server): add clearSession() method with archive+child creation"
```

---

### Task 5: Add `POST /api/sessions/:id/clear` route

**Files:**
- Modify: `src/web/routes/session-routes.ts`
- Test: `test/routes/session-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Add to `test/routes/session-routes.test.ts`:
```typescript
describe('POST /api/sessions/:id/clear', () => {
  it('calls ctx.clearSession and returns archived + new session', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/clear`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.archivedSession).toBeDefined();
    expect(body.newSession).toBeDefined();
    expect(harness.ctx.clearSession).toHaveBeenCalledWith(
      harness.ctx._sessionId,
      false
    );
  });

  it('passes force:true when requested', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/clear`,
      payload: { force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(harness.ctx.clearSession).toHaveBeenCalledWith(
      harness.ctx._sessionId,
      true
    );
  });

  it('returns 404 for unknown session', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/clear',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify fails**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/routes/session-routes.test.ts -t "clear" 2>&1 | tail -20
```

- [ ] **Step 3: Add the route in `session-routes.ts` after the DELETE endpoint (~line 230)**

```typescript
// POST /api/sessions/:id/clear — archive session and create child
app.post('/api/sessions/:id/clear', async (request, reply) => {
  const { id } = request.params as { id: string };
  const { force = false } = (request.body ?? {}) as { force?: boolean };

  if (!ctx.sessions.has(id)) {
    return reply.send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found'));
  }

  try {
    const result = await ctx.clearSession(id, force);
    return reply.send({
      archivedSession: result.archivedSession,
      newSession: result.newSession.toState(),
    });
  } catch (err) {
    request.log.error(err, 'clearSession failed');
    return reply.send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Clear failed'));
  }
});
```

- [ ] **Step 4: Run route tests**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/routes/session-routes.test.ts 2>&1 | tail -20
```
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/session-routes.ts test/routes/session-routes.test.ts
git commit -m "feat(routes): add POST /api/sessions/:id/clear endpoint"
```

---

### Task 6: Intercept `/clear` terminal command

**Files:**
- Modify: `src/web/routes/session-routes.ts` (or wherever `POST /api/sessions/:id/input` is handled)
- Test: `test/routes/session-routes.test.ts`

- [ ] **Step 1: Find the input handler**

In `session-routes.ts`, search for `/input` to locate the `POST /api/sessions/:id/input` handler (or the mux write handler). Identify the exact line where input data is written to the PTY.

- [ ] **Step 2: Write failing test**

Add to `test/routes/session-routes.test.ts`:
```typescript
describe('POST /api/sessions/:id/input with /clear command', () => {
  it('intercepts /clear and calls clearSession instead of writing to PTY', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/input`,
      payload: { input: '/clear\r', useMux: true },
    });
    expect(res.statusCode).toBe(200);
    expect(harness.ctx.clearSession).toHaveBeenCalledWith(
      harness.ctx._sessionId,
      false
    );
    // PTY write should NOT have been called
    expect(harness.ctx.batchTerminalData).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify fails**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/routes/session-routes.test.ts -t "intercepts /clear" 2>&1 | tail -15
```

- [ ] **Step 4: Add intercept in the input handler**

Before the PTY write, add:
```typescript
// Intercept /clear — route to archive+child flow
if ((input as string).replace(/\r?\n?$/, '').trim() === '/clear') {
  void ctx.clearSession(id, false);
  return reply.send({ ok: true });
}
```

- [ ] **Step 5: Run test**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/routes/session-routes.test.ts -t "intercepts /clear" 2>&1 | tail -15
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/session-routes.ts test/routes/session-routes.test.ts
git commit -m "feat(routes): intercept /clear terminal input to trigger archive flow"
```

---

### Task 7: Update respawn `sendClear` to use `clearSession`

**Files:**
- Modify: `src/respawn-controller.ts` (~line 2814)
- Modify: `src/web/server.ts` (where RespawnController is created — pass clearSession callback)
- Test: `test/respawn-controller.test.ts`

`RespawnController` receives only `(session, config)` — it has no `ctx` reference. The solution: add an optional `onClear?: () => Promise<void>` callback to `RespawnConfig`, passed in from the server when creating the controller.

- [ ] **Step 1: Add `onClear` to `RespawnConfig` in `src/types/respawn.ts`**

Find the `RespawnConfig` interface in `src/types/respawn.ts`. Add:
```typescript
/** Callback to invoke instead of writing /clear to PTY. Set by server. */
onClear?: () => Promise<void>;
```

- [ ] **Step 2: Write failing test**

Add to `test/respawn-controller.test.ts`:
```typescript
it('sendClear calls onClear callback when provided', async () => {
  const onClear = vi.fn().mockResolvedValue(undefined);
  const { controller } = createTestController({
    sendClear: true,
    onClear,
  });

  // Trigger sendClear through a respawn cycle
  // (or expose as a test helper if the method is private)
  await (controller as any)._sendClear_testHook?.();

  expect(onClear).toHaveBeenCalledOnce();
});
```

Note: if `sendClear()` is purely private with no test hook, add a minimal test hook method `_sendClear_testHook = () => this.sendClear()` in the class body, or use `vi.spyOn` on the session write method to verify it is NOT called.

- [ ] **Step 3: Run to verify fails**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/respawn-controller.test.ts -t "onClear" 2>&1 | tail -15
```

- [ ] **Step 4: Update `sendClear()` in `respawn-controller.ts`**

Find `sendClear()` around line 2814. Change from writing `/clear\r` to the PTY to:

```typescript
private async sendClear(): Promise<void> {
  if (this.config.onClear) {
    await this.config.onClear();
  } else {
    // Legacy fallback: write /clear to PTY directly
    this.session.writeViaMux('/clear\r');
  }
}
```

- [ ] **Step 5: Pass `onClear` callback when creating RespawnController in `server.ts`**

Find where `new RespawnController(session, config)` is called (in the server or routes). Add the callback:

```typescript
new RespawnController(session, {
  ...respawnConfig,
  onClear: () => this.clearSession(session.id, false).then(() => undefined),
})
```

- [ ] **Step 6: Run test**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/respawn-controller.test.ts -t "onClear" 2>&1 | tail -15
```
Expected: PASS

- [ ] **Step 7: Run full respawn-controller tests (no regressions)**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/respawn-controller.test.ts 2>&1 | tail -20
```

- [ ] **Step 8: Commit**

```bash
git add src/types/respawn.ts src/respawn-controller.ts src/web/server.ts test/respawn-controller.test.ts
git commit -m "feat(respawn): sendClear uses onClear callback for proper archive semantics"
```

---

### Task 8: `GET /api/sessions/:id/chain` and `GET /api/sessions/:id/state`

**Files:**
- Modify: `src/web/routes/session-routes.ts`
- Test: `test/routes/session-routes.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/routes/session-routes.test.ts`:
```typescript
describe('GET /api/sessions/:id/chain', () => {
  it('returns single-item chain for session with no parent', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/chain`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe(harness.ctx._sessionId);
  });

  it('returns ordered chain [root, ..., current] for sessions with parent', async () => {
    // Set up: parent (archived, NOT in sessions Map) → current session
    const parentState = harness.ctx.sessions.get(harness.ctx._sessionId)!.toState();
    parentState.id = 'parent-id';
    parentState.status = 'archived';
    parentState.childSessionId = harness.ctx._sessionId;
    // Parent must NOT be in sessions Map (it's archived — only in store)
    // store.getSession mock: return parentState when queried for 'parent-id'
    harness.ctx.store.getSession.mockImplementation((id: string) =>
      id === 'parent-id' ? parentState : undefined
    );
    // Set parentSessionId on the current session's toState()
    const session = harness.ctx.sessions.get(harness.ctx._sessionId)!;
    vi.spyOn(session, 'toState').mockReturnValue({
      ...session.toState(),
      parentSessionId: 'parent-id',
    });

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/chain`,
    });
    const body = JSON.parse(res.body);
    expect(body.sessions[0].id).toBe('parent-id');
    expect(body.sessions[1].id).toBe(harness.ctx._sessionId);
  });

  it('returns 404 for unknown session', async () => {
    const res = await harness.app.inject({
      method: 'GET', url: '/api/sessions/nonexistent/chain',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/sessions/:id/state', () => {
  it('returns session state and transcript array', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/state`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.session.id).toBe(harness.ctx._sessionId);
    expect(Array.isArray(body.transcript)).toBe(true);
  });

  it('returns 404 for unknown session', async () => {
    const res = await harness.app.inject({
      method: 'GET', url: '/api/sessions/nonexistent/state',
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify fails**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/routes/session-routes.test.ts -t "chain|/state" 2>&1 | tail -20
```

- [ ] **Step 3: Add `getTranscriptBlocks` to `MockRouteContext`**

In `test/mocks/mock-route-context.ts`, add:
```typescript
getTranscriptBlocks: vi.fn(async (_id: string) => []),
loadTranscriptBlocks: vi.fn(async (_path: string) => []),
```

Also add these as methods on WebServer's ctx interface (check what interface `ctx` implements in routes and add the signatures there).

- [ ] **Step 4: Implement both endpoints in `session-routes.ts`**

```typescript
// GET /api/sessions/:id/chain — root-to-current ancestry
app.get('/api/sessions/:id/chain', async (request, reply) => {
  const { id } = request.params as { id: string };

  const leafState = ctx.sessions.get(id)?.toState() ?? ctx.store.getSession(id);
  if (!leafState) return reply.send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found'));

  // Walk backwards to root
  const chain: SessionState[] = [];
  let current: SessionState | undefined = leafState;
  while (current) {
    chain.unshift(current);
    const parentId = current.parentSessionId;
    if (!parentId) break;
    current = ctx.sessions.get(parentId)?.toState() ?? ctx.store.getSession(parentId);
  }

  return reply.send({ sessions: chain });
});

// GET /api/sessions/:id/state — full snapshot for stale-while-revalidate
app.get('/api/sessions/:id/state', async (request, reply) => {
  const { id } = request.params as { id: string };

  const sessionState = ctx.sessions.get(id)?.toState() ?? ctx.store.getSession(id);
  if (!sessionState) return reply.send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found'));

  // Read transcript blocks. The existing transcript route uses ctx.getTranscriptPath(id)
  // then reads + parses the JSONL file. Mirror that pattern here:
  let transcript: TranscriptBlock[] = [];
  const transcriptPath = sessionState.transcriptPath   // archived session: path stored at clear time
    ?? ctx.getTranscriptPath(id);                      // active session: resolved from watcher
  if (transcriptPath) {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(transcriptPath, 'utf8');
      transcript = parseTranscriptJSONL(raw);          // use the existing parseTranscriptJSONL utility
    } catch (_e) {
      transcript = [];
    }
  }

  return reply.send({ session: sessionState, transcript });
});
```

Note: `parseTranscriptJSONL` — search for this function in the codebase (it parses JSONL transcript files into `TranscriptBlock[]` arrays). If named differently, use the same function the existing `/transcript` route uses.

- [ ] **Step 5: Run all session route tests**

```bash
cd /home/siggi/sources/Codeman && npx vitest run test/routes/session-routes.test.ts 2>&1 | tail -20
```
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/session-routes.ts test/routes/session-routes.test.ts test/mocks/mock-route-context.ts
git commit -m "feat(routes): add GET /api/sessions/:id/chain and /state endpoints"
```

---

## Chunk 3: Frontend State Management

### Task 9: In-memory stale-while-revalidate cache + remove per-session localStorage

**Files:**
- Modify: `src/web/public/app.js`

- [ ] **Step 1: Add `_sessionStateCache` near existing Map declarations**

Find where `this.sessions` and other Maps are initialized (near the top of the constructor or init method). Add:

```javascript
// In-memory stale-while-revalidate cache. Never written to localStorage.
// Key: sessionId, Value: { state, transcript, cachedAt: number }
this._sessionStateCache = new Map();
```

- [ ] **Step 2: Add three cache helper methods to the app class**

```javascript
_getCachedSession(sessionId) {
  const CACHE_TTL_MS = 60_000;
  const entry = this._sessionStateCache.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    this._sessionStateCache.delete(sessionId);
    return null;
  }
  return entry;
}

_setCachedSession(sessionId, state, transcript) {
  this._sessionStateCache.set(sessionId, {
    state, transcript, cachedAt: Date.now(),
  });
}

_invalidateCachedSession(sessionId) {
  this._sessionStateCache.delete(sessionId);
}
```

- [ ] **Step 3: Remove per-session localStorage writes/reads**

Search for each of these and replace with in-memory alternatives:

**`transcriptViewMode:{sessionId}`** (lines ~1875, ~1881):
```javascript
// Replace localStorage.setItem(`transcriptViewMode:${sessionId}`, mode)
// with:
if (!this._transcriptViewModes) this._transcriptViewModes = new Map();
this._transcriptViewModes.set(sessionId, mode);

// Replace localStorage.getItem(`transcriptViewMode:${sessionId}`)
// with:
this._transcriptViewModes?.get(sessionId) ?? null
```

**`codeman-session-order`** (lines ~6728, ~6738):
Remove localStorage reads/writes for session order. Session order is fetched from the server session list (already loaded via SSE/init). If ordering was being saved locally, remove those calls — the server is now authoritative.

- [ ] **Step 4: Add `_refreshSessionState()` method**

```javascript
async _refreshSessionState(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/state`);
    if (!res.ok) return;
    const data = await res.json();
    this._setCachedSession(sessionId, data.session, data.transcript);
    if (this._activeSessionId === sessionId) {
      this._renderSessionState(sessionId, data.session, data.transcript);
    }
  } catch (_e) {
    // Network error — cached state remains valid
  }
}
```

- [ ] **Step 5: Update `selectSession()` to use stale-while-revalidate**

In `selectSession()` (line ~6855), after activating the session ID, add:

```javascript
// Show cached state immediately (no flash/spinner)
const cached = this._getCachedSession(sessionId);
if (cached) {
  this._renderSessionState(sessionId, cached.state, cached.transcript);
}
// Background refresh
this._refreshSessionState(sessionId);
```

- [ ] **Step 6: Invalidate cache in SSE mutation handlers**

In the handlers for `session:updated`, `session:deleted`, `session:cleared`:
```javascript
this._invalidateCachedSession(/* sessionId from event data */);
```

- [ ] **Step 7: Build**

```bash
cd /home/siggi/sources/Codeman && npm run build 2>&1 | tail -20
```
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat(frontend): in-memory stale-while-revalidate cache, remove per-session localStorage"
```

---

## Chunk 4: Frontend Clear Flow

### Task 10: Clear button waiting state + `session:cleared` SSE handler

**Files:**
- Modify: `src/web/public/app.js`

- [ ] **Step 1: Add `_pendingClear` Set**

Near session state declarations in the constructor/init:
```javascript
this._pendingClear = new Set(); // sessionIds queued for clear after idle
```

- [ ] **Step 2: Replace clear button handler body**

Find the clear button click handler (search for the clear button event registration or `clearTerminal`). Replace its body:

```javascript
_onClearButtonPressed(sessionId) {
  if (this._pendingClear.has(sessionId)) {
    // Second press while waiting = force clear immediately
    this._pendingClear.delete(sessionId);
    this._setClearWaiting(sessionId, false);
    void this._sendClearRequest(sessionId, true);
    return;
  }

  const session = this.sessions.get(sessionId);
  if (session && session.status === 'busy') {
    this._pendingClear.add(sessionId);
    this._setClearWaiting(sessionId, true);
  } else {
    void this._sendClearRequest(sessionId, false);
  }
}

async _sendClearRequest(sessionId, force) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    if (!res.ok) console.error('Clear failed:', await res.text());
    // SSE session:cleared handles tab switching
  } catch (e) {
    console.error('Clear request error:', e);
  }
}

_setClearWaiting(sessionId, waiting) {
  const btn = document.querySelector(`[data-clear-session="${sessionId}"]`);
  if (!btn) return;
  btn.classList.toggle('clear-waiting', waiting);
  btn.setAttribute(
    'title',
    waiting
      ? 'Waiting for response\u2026 (press again to force)'
      : 'Clear session'
  );
}
```

Ensure the clear button element has `data-clear-session="${session.id}"` in its HTML. Find where clear buttons are rendered and add this attribute if missing.

- [ ] **Step 3: Trigger queued clear on `session:idle` SSE**

In the `session:idle` SSE handler, add at the end:

```javascript
if (this._pendingClear.has(sessionId)) {
  this._pendingClear.delete(sessionId);
  this._setClearWaiting(sessionId, false);
  void this._sendClearRequest(sessionId, false);
}
```

- [ ] **Step 4: Add `session:cleared` SSE handler**

In `_SSE_HANDLER_MAP` (or wherever SSE listeners are registered):
```javascript
'session:cleared': (data) => this._onSessionCleared(data),
```

```javascript
_onSessionCleared({ archivedId, newSessionId }) {
  this._invalidateCachedSession(archivedId);

  // Update local status for the archived session
  const archived = this.sessions.get(archivedId);
  if (archived) archived.status = 'archived';

  // Switch active tab to the new child session
  if (this._activeSessionId === archivedId) {
    void this.selectSession(newSessionId);
  }
}
```

- [ ] **Step 5: Build and smoke test**

```bash
cd /home/siggi/sources/Codeman && npm run build 2>&1 | tail -20
nohup npx tsx src/index.ts web --port 3099 > /tmp/codeman-3099.log 2>&1 &
sleep 6 && curl -s http://localhost:3099/api/status | jq .status
# Access at http://100.69.214.73:3099
```

Manual test: open a session, press Clear, verify new child session appears and both tabs switch.

- [ ] **Step 6: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat(frontend): clear button waiting state, force-clear, session:cleared SSE handler"
```

---

## Chunk 5: Frontend History Chain UI

### Task 11: Breadcrumb and read-only archived session overlay

**Files:**
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/app.css` (or wherever styles are defined)
- Modify: the HTML template that contains the transcript view container

- [ ] **Step 1: Add HTML for breadcrumb and overlay**

Find the transcript view container element in the HTML template. Add these two elements inside or adjacent to it:

```html
<!-- Session chain breadcrumb — shown when session has parent history -->
<div id="session-chain-breadcrumb" class="session-chain-breadcrumb" hidden></div>

<!-- Read-only archived session overlay -->
<div id="archived-session-overlay" class="archived-session-overlay" hidden>
  <div class="archived-session-header">
    <span class="archived-session-title"></span>
    <span class="archived-session-date"></span>
    <button class="archived-session-close" aria-label="Close archived session">&#x2715;</button>
  </div>
  <div class="archived-transcript"></div>
</div>
```

- [ ] **Step 2: Add CSS**

```css
.session-chain-breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-secondary, #888);
  border-bottom: 1px solid var(--border, #333);
  overflow: hidden;
  flex-shrink: 0;
}
.session-chain-breadcrumb[hidden] { display: none; }
.chain-btn {
  background: none;
  border: none;
  color: var(--accent, #4a9eff);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.chain-btn:hover { background: var(--hover-bg, rgba(255,255,255,0.05)); }
.chain-label { padding: 2px 4px; }
.chain-sep { opacity: 0.5; user-select: none; }

.archived-session-overlay {
  position: absolute;
  inset: 0;
  background: var(--bg, #1e1e1e);
  z-index: 50;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.archived-session-overlay[hidden] { display: none; }
.archived-session-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #333);
  flex-shrink: 0;
}
.archived-session-title { font-weight: 600; }
.archived-session-date {
  font-size: 12px;
  color: var(--text-secondary, #888);
  margin-left: auto;
}
.archived-session-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary, #888);
  font-size: 16px;
  padding: 2px 6px;
}
.archived-transcript { flex: 1; overflow-y: auto; padding: 12px; }
```

- [ ] **Step 3: Implement `_renderSessionChain()` using safe DOM methods (no user data in innerHTML)**

```javascript
async _renderSessionChain(sessionId) {
  const container = document.getElementById('session-chain-breadcrumb');
  if (!container) return;

  let chain = [];
  try {
    const res = await fetch(`/api/sessions/${sessionId}/chain`);
    if (res.ok) chain = (await res.json()).sessions;
  } catch (_e) { return; }

  if (chain.length <= 1) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  // Clear children safely (no innerHTML)
  while (container.firstChild) container.removeChild(container.firstChild);

  chain.forEach((s, i) => {
    const isLast = i === chain.length - 1;
    if (isLast) {
      const label = document.createElement('span');
      label.className = 'chain-label';
      label.textContent = s.name || `Session ${i + 1}`;
      container.appendChild(label);
    } else {
      const btn = document.createElement('button');
      btn.className = 'chain-btn';
      btn.textContent = s.name || `Session ${i + 1}`;
      btn.dataset.sessionId = s.id;
      btn.addEventListener('click', () => this._openArchivedSession(s.id));
      container.appendChild(btn);

      const sep = document.createElement('span');
      sep.className = 'chain-sep';
      sep.textContent = '\u203a'; // ›
      container.appendChild(sep);
    }
  });
}
```

- [ ] **Step 4: Implement `_openArchivedSession()` and `_closeArchivedSession()`**

```javascript
async _openArchivedSession(sessionId) {
  const overlay = document.getElementById('archived-session-overlay');
  if (!overlay) return;

  let data;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/state`);
    if (!res.ok) return;
    data = await res.json();
  } catch (_e) { return; }

  // Set title using textContent (safe — no user content in HTML context)
  const titleEl = overlay.querySelector('.archived-session-title');
  if (titleEl) titleEl.textContent = data.session.name || 'Archived Session';

  const dateEl = overlay.querySelector('.archived-session-date');
  if (dateEl && data.session.clearedAt) {
    dateEl.textContent = 'Cleared ' + new Date(data.session.clearedAt).toLocaleString();
  }

  const closeBtn = overlay.querySelector('.archived-session-close');
  if (closeBtn) closeBtn.onclick = () => this._closeArchivedSession();

  // Render transcript blocks using the existing _appendBlock method (app.js line ~2344).
  // _appendBlock(block, scroll) appends to the currently active transcript container.
  // Temporarily redirect rendering to the overlay container:
  const transcriptEl = overlay.querySelector('.archived-transcript');
  if (transcriptEl) {
    // Clear existing content safely
    while (transcriptEl.firstChild) transcriptEl.removeChild(transcriptEl.firstChild);
    const prevContainer = this._transcriptContainer;
    this._transcriptContainer = transcriptEl;
    for (const block of data.transcript) {
      this._appendBlock(block, false);
    }
    this._transcriptContainer = prevContainer;
  }

  overlay.hidden = false;
}

_closeArchivedSession() {
  const overlay = document.getElementById('archived-session-overlay');
  if (overlay) overlay.hidden = true;
}
```

Note: if `_transcriptContainer` is not a directly settable property, look at how the existing transcript panel switches sessions (search for `_appendBlock` callsites in app.js) and mirror that setup pattern instead.

- [ ] **Step 5: Hook up on session switch**

In `selectSession()` (line ~6855), add after activating the session:
```javascript
// Close any open archived overlay and render chain for the new session
this._closeArchivedSession();
void this._renderSessionChain(sessionId);
```

- [ ] **Step 6: Build and test history navigation**

```bash
cd /home/siggi/sources/Codeman && npm run build 2>&1 | tail -20
```

Manual test flow at http://100.69.214.73:3099:
1. Create session, clear it → child appears
2. Clear child → grandchild appears
3. Grandchild shows breadcrumb: parent name › current
4. Click parent breadcrumb → overlay opens, shows read-only transcript
5. Close button dismisses overlay
6. Switch sessions → overlay closes, breadcrumb updates

- [ ] **Step 7: Kill dev server, commit**

```bash
pkill -f "tsx src/index.ts web --port 3099" 2>/dev/null
git add src/web/public/app.js src/web/public/app.css
git commit -m "feat(frontend): breadcrumb chain UI and read-only archived session overlay"
```

---

## Chunk 6: Integration & Deploy

### Task 12: Full QA and production deploy

- [ ] **Step 1: Run full test suite**

```bash
cd /home/siggi/sources/Codeman && npx vitest run 2>&1 | tail -30
```
Expected: All pass (or only pre-existing failures).

- [ ] **Step 2: TypeScript check**

```bash
cd /home/siggi/sources/Codeman && npx tsc --noEmit 2>&1 | head -30
```
Expected: No errors.

- [ ] **Step 3: Manual QA checklist**

Start dev server:
```bash
nohup npx tsx src/index.ts web --port 3099 > /tmp/codeman-3099.log 2>&1 &
sleep 6 && curl -s http://localhost:3099/api/status | jq .status
```

- [ ] Clear idle session → new child session appears, both browser tabs switch
- [ ] Clear busy session → "Waiting…" shown on button, clears after idle
- [ ] Press Clear again while waiting → immediate force-clear
- [ ] Open two browser tabs; clear in tab A → both switch to child session
- [ ] Child session breadcrumb shows parent session name
- [ ] Click parent in breadcrumb → read-only overlay with archived transcript
- [ ] Close button dismisses overlay
- [ ] Three clears deep → full chain shown in breadcrumb
- [ ] Restart server → archived sessions load, no tmux reattachment errors in logs
- [ ] Terminal view matches transcript view after clear (no divergence)
- [ ] Type `/clear` in terminal → triggers archive identically to button
- [ ] Respawn `sendClear` config: verify respawn cycle uses archive flow
- [ ] Legacy sessions (no parentSessionId): work normally, no breadcrumb
- [ ] Fast session switching: cached state shown instantly, background refresh patches

- [ ] **Step 4: Deploy**

```bash
pkill -f "tsx src/index.ts web --port 3099" 2>/dev/null
cd /home/siggi/sources/Codeman
npm run build
cp -r dist /home/siggi/.codeman/app/
cp package.json /home/siggi/.codeman/app/package.json
systemctl --user restart codeman-web
sleep 3 && curl -s http://localhost:3001/api/status | jq .status
```

- [ ] **Step 5: Verify no stale brotli files**

```bash
find /home/siggi/.codeman/app/dist -name "*.br" | head -5
# If any exist: find /home/siggi/.codeman/app/dist -name "*.br" -delete && systemctl --user restart codeman-web
```

- [ ] **Step 6: Commit any stragglers**

```bash
git status
git add -p
git commit -m "chore: session architecture rewrite complete"
```

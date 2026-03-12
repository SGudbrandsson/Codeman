# Worktree Auto-Start Design

**Date:** 2026-03-12
**Branch:** feat/worktree-auto-start
**Status:** Approved

## Problem

`POST /api/sessions/:id/worktree` creates a session with `status: idle` and no running process. The Claude process only spawns when the user manually opens the session tab. For automated/skill-driven workflows, this requires a second API call or UI interaction.

## Solution

Add an optional `autoStart` boolean to `CreateWorktreeSchema`. When `true`, the route handler calls `session.startInteractive()` (or `startShell()`) immediately after creating the session, so Claude begins working on the `notes` prompt without user interaction.

## Changes

### 1. `src/web/schemas.ts`
Add to `CreateWorktreeSchema`:
```typescript
autoStart: z.boolean().optional(),
```

### 2. `src/web/routes/worktree-session-routes.ts` — add import

`getLifecycleLog` is not currently imported. Add:
```typescript
import { getLifecycleLog } from '../../session-lifecycle-log.js';
```

### 3. `src/web/routes/worktree-session-routes.ts` — sessions route (`POST /api/sessions/:id/worktree`)

Line 87 currently reads:
```typescript
const { branch, isNew, mode, notes } = parsed.data;
```
Change to:
```typescript
const { branch, isNew, mode, notes, autoStart } = parsed.data;
```

After `ctx.broadcast(SseEvent.SessionCreated, lightState)` and before `return`, add:

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
    // Session was created successfully; log start failure but still return success.
    // The session will remain idle; callers can observe this via SSE.
    console.error(`[worktree] autoStart failed for session ${newSession.id}:`, err);
  }
}
```

Note: `newSession.mode` in the lifecycle log reflects the resolved mode (inheriting from parent if not specified). No additional `persistSessionState` call is needed after start — the pre-creation call at line 138 already ran.

### 4. `src/web/routes/worktree-session-routes.ts` — cases route (`POST /api/cases/:name/worktree`)

Line 245 currently reads:
```typescript
const { branch, isNew, mode, notes } = parsed.data;
```
Change to:
```typescript
const { branch, isNew, mode, notes, autoStart } = parsed.data;
```

Apply identical `autoStart` block after `ctx.broadcast(SseEvent.SessionCreated, lightState)` and before `return`. Note: the cases route does not set `worktreeOriginId` (it has no parent session) — this is a pre-existing asymmetry; don't add it.

### 5. Skill docs — both copies

Per CLAUDE.md, both copies must be updated. Verify the home-directory copy exists first (`ls ~/.claude/skills/codeman-worktrees/`).

- `skills/codeman-worktrees/SKILL.md`
- `~/.claude/skills/codeman-worktrees/SKILL.md`

Add `autoStart` to the body fields table:
> `autoStart` — `true` = immediately spawn Claude process after creation (optional, default: omitted/false)

Update the example `curl` command in Step 3 to include `"autoStart": true`.

## Behaviour

- `autoStart` omitted or `false`: existing behaviour — session starts idle
- `autoStart: true`: session spawns immediately; `worktreeNotes` sent as initial Claude prompt via existing `extraArgs` path in `startInteractive()`
- Start failure: session is created (returns `success: true`), error is logged, session remains idle

## Out of Scope

- No changes to respawn config
- No new SSE events

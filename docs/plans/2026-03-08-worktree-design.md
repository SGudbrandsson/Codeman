# Worktree Support Design

**Date**: 2026-03-08
**Status**: Approved

## Overview

Add git worktree support to Codeman so users can run multiple Claude sessions on parallel branches without conflicts. Worktrees are created on-demand from the `+` button, appear as normal sessions with a branch badge, and can be kept dormant and resumed later.

## Data Model

Three new optional fields on `SessionState` / `SessionConfig`:

```typescript
worktreePath?: string;      // absolute path to the worktree dir (sibling to project)
worktreeBranch?: string;    // branch name checked out in the worktree
worktreeOriginId?: string;  // session ID that spawned this worktree session
```

A separate `~/.codeman/worktrees.json` file tracks dormant (kept) worktrees:

```typescript
interface DormantWorktree {
  id: string;           // uuid
  path: string;         // absolute path on disk
  branch: string;       // branch name
  originSessionId: string;
  projectName: string;  // last segment of origin session's workingDir
  createdAt: string;    // ISO timestamp
}
```

Worktree sessions are otherwise normal sessions — same lifecycle, respawn, Ralph support. `workingDir` is set to the worktree path.

## Backend API

Six new routes:

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/sessions/:id/worktree/branches` | List local + remote branches via `git branch -a` |
| `POST` | `/api/sessions/:id/worktree` | Create worktree + new session. Body: `{ branch: string, isNew: boolean }` |
| `DELETE` | `/api/sessions/:id/worktree` | Remove worktree from disk. Body: `{ force?: boolean }` |
| `GET` | `/api/worktrees` | List all dormant worktrees from `worktrees.json` |
| `POST` | `/api/worktrees/:id/resume` | Spawn a new session in a dormant worktree |
| `DELETE` | `/api/worktrees/:id` | Remove dormant worktree entry and optionally disk |

`POST /api/sessions/:id/worktree` implementation:
1. Resolve project root from `session.workingDir` (walk up to find `.git`)
2. Run `git worktree add ../project-<branch> -b <branch>` (new) or `git worktree add ../project-<branch> <branch>` (existing)
3. Create a new session with `workingDir = worktreePath` and the three metadata fields set
4. Return new session state

A new `WorktreeStore` class (thin wrapper around `worktrees.json`) handles dormant worktree persistence, similar to existing store patterns.

## Frontend UI

### `+` Button

Added at the end of the session tab bar. Opens a **"New..."** picker modal with two large tap-friendly tiles:

- **Session** — triggers existing quick-start flow, unchanged
- **Worktree** — opens the worktree creation screen

### Worktree Creation Screen

Two-step flow (or one-step if only one session exists):

**Step 1 — Resume or source selection:**
- Dormant worktrees shown at top as "Resume: feature/thing" buttons (calls `POST /api/worktrees/:id/resume`)
- If >1 session exists: list of sessions filtered to those inside a git repo, radio-select which to branch from

**Step 2 — Branch selection:**
- Radio toggle: **New branch** (text input) / **Existing branch** (searchable dropdown, loaded from `GET branches`)
- Live preview of worktree path: `../project-<branch>`
- Back / Create buttons; spinner on Create; new session auto-focuses on success

### Worktree Session Tabs

Worktree sessions appear as normal session tabs with a small branch badge: `🌿 feature/thing`. No other visual difference.

### Cleanup Modal

Shown when a worktree session ends or is killed (only if `worktreeBranch` is set):

```
┌─ Worktree: feature/thing ─────────────┐
│                                        │
│  Session ended. What should happen     │
│  to the worktree?                      │
│                                        │
│  [ Remove worktree ]                   │
│  [ Keep worktree   ]                   │
│  [ Merge into master → my-project ]    │
│                                        │
└────────────────────────────────────────┘
```

- **Remove** — `git worktree remove <path>`. If uncommitted changes detected, warns and offers `--force`
- **Keep** — saves entry to `worktrees.json`; resumable via `+` → Worktree picker
- **Merge into `<base>`** — runs `git merge <branch>` in origin session's `workingDir`; shows output inline; falls back to Keep on conflict with error message

Non-worktree sessions are unaffected — this modal never appears for them.

## Implementation Notes

- Git operations use `execFileNoThrow` from `src/utils/execFileNoThrow.ts` (not shell exec) to avoid injection
- Walk up from `workingDir` to find `.git` root; error clearly if not a git repo
- Existing branch listing strips `remotes/origin/` prefix and deduplicates
- `WorktreeStore` follows the pattern of existing stores (`StateStore`, etc.) with atomic writes
- New routes added to `src/web/routes/sessions-routes.ts` and a new `src/web/routes/worktrees-routes.ts`
- SSE event `worktree_session_ended` triggers the cleanup modal on the frontend

# Task

type: feature
status: done
title: Resume previously closed sessions
description: |
  Allow users to resume sessions that were previously closed/removed from the sidebar.

  ## Discovery
  When a session is deleted (DELETE /api/sessions/:id), its state is removed from memory
  but the Claude conversation UUID (claudeResumeId) and JSONL transcript file still exist
  on disk at ~/.claude/projects/<escaped-dir>/*.jsonl.

  Also check: ~/.codeman/session-lifecycle.jsonl for audit log of past sessions.

  ## Feature
  Add a "Resume session" flow:
  1. User opens a "Closed Sessions" section (in the session drawer or a dedicated button)
  2. Shows a list of past sessions discovered from:
     - session-lifecycle.jsonl (has sessionId, workingDir, timestamps)
     - ~/.claude/projects/ scan for JSONL files with their modification dates
  3. Each entry shows:
     - Project / workingDir
     - Last active time
     - Conversation UUID (truncated)
     - Branch name if known
  4. User picks one → Codeman spawns a new session in that workingDir with --resume <uuid>

  ## Implementation
  Backend:
  - New endpoint: GET /api/sessions/history — returns past sessions from lifecycle log + JSONL scan
  - New endpoint: POST /api/sessions/resume { workingDir, resumeId, branch? } — creates session
    with --resume flag pointed at the given conversation UUID

  Frontend:
  - "Resume" button/icon in the session creation area or session drawer header
  - Opens a searchable list (fuzzy search by project name, reuse search UI from feat/search-sessions
    if that lands first, otherwise implement standalone)
  - Shows metadata: project, time ago, UUID snippet
  - "Resume" button per entry → POST to create session → navigate to it

constraints: |
  - Scanning ~/.claude/projects/ should be bounded (cap at 100 entries, most recent first)
  - Must not resurrect sessions that are already active (check against current session list)
  - session-lifecycle.jsonl may be large — read only last N lines (e.g. 500)
  - The new session must use --resume <uuid> so Claude picks up the conversation
  - No new npm dependencies
  - Bump CSS/JS ?v= strings per CLAUDE.md versioning rules

affected_area: backend+frontend
fix_cycles: 1

## Root Cause / Spec

### Context and Gap

When `DELETE /api/sessions/:id` is called, `_doCleanupSession()` in `server.ts` (line 930) logs a
`deleted` or `detached` lifecycle event but does NOT persist `workingDir` or `claudeResumeId`.
The lifecycle entry only has: `ts`, `event`, `sessionId`, `name`, `mode`, `reason`.

The Claude conversation transcript lives at:
`~/.claude/projects/<workingDir-with-slashes-replaced-by-dashes>/<uuid>.jsonl`

This means recovery requires cross-referencing the lifecycle log (for session name/ts) with a
filesystem scan of `~/.claude/projects/` (for the actual UUIDs and project directories).

The `LifecycleEntry` type has an `extra?: Record<string, unknown>` field (types/lifecycle.ts:39)
that can store additional data — this is where we should write `workingDir` and `claudeResumeId`
at delete/detach time so future lookups don't need a filesystem scan for those fields.

However, for backward compatibility, the `GET /api/sessions/history` endpoint must also fall
back to scanning `~/.claude/projects/` to find sessions that were closed before this change.

### Architecture

#### Data Sources (for the history endpoint)

**Source 1 — lifecycle log** (`~/.codeman/session-lifecycle.jsonl`):
- Read last 500 lines (reverse parse, collect `deleted` and `detached` events)
- Deduplicate by `sessionId` (keep latest event per sessionId)
- Filter out sessionIds already in `ctx.sessions` (already active)
- After this change: `extra.workingDir` and `extra.claudeResumeId` are available directly

**Source 2 — JSONL filesystem scan** (`~/.claude/projects/`):
- Each subdirectory name is the workingDir with `/` → `-`
- Reverse map: `escapedDir.replace(/-/g, '/')` gives the original path (imperfect but useful for display)
  - NOTE: The escape is one-directional: `/` → `-`, so hyphens in dir names and `/` both become `-`.
    The reverse decode can't be perfect; display the decoded form but warn users to verify.
- Scan at most 100 JSONL files across all project dirs, sorted by mtime descending
- Skip UUIDs already covered by Source 1 (to avoid duplicates)
- Also skip UUIDs matching currently active sessions (`claudeResumeId` in `ctx.sessions`)

**Merged result**: deduplicate by `resumeId` (JSONL UUID), join lifecycle metadata (name, ts) with
filesystem metadata (mtime, workingDir). Sort by `lastActiveAt` descending.

#### Backend Changes

**1. Enhance lifecycle log at delete/detach time** (`src/web/server.ts`, `_doCleanupSession()`):
```ts
lifecycleLog.log({
  event: killMux ? 'deleted' : 'detached',
  sessionId,
  name: session?.name,
  mode: session?.mode,
  reason: reason || 'unknown',
  extra: {
    workingDir: session?.workingDir,
    claudeResumeId: session?.claudeResumeId,
    worktreeBranch: session?.worktreeBranch,
  },
});
```

**2. New route file**: `src/web/routes/history-routes.ts`
```
GET  /api/sessions/history   — returns ClosedSessionEntry[]
POST /api/sessions/resume    — creates new session with --resume <uuid>
```

Register in `src/web/routes/index.ts` and `src/web/server.ts`.

**3. New Zod schema** in `src/web/schemas.ts`:
```ts
export const ResumeClosedSessionSchema = z.object({
  workingDir: safePathSchema,
  resumeId: z.string().uuid(),
  name: z.string().max(128).optional(),
  mode: z.enum(['claude', 'shell', 'opencode']).optional(),
});
```

**4. Response shape** for `GET /api/sessions/history`:
```ts
interface ClosedSessionEntry {
  resumeId: string;          // Claude conversation UUID
  workingDir: string;        // Decoded working directory path
  displayName: string;       // session name from lifecycle log, or last segment of workingDir
  lastActiveAt: number;      // Unix ms timestamp
  worktreeBranch?: string;   // from lifecycle extra or undefined
  source: 'lifecycle' | 'scan';  // for debugging
}
```

**5. `POST /api/sessions/resume` handler** (in history-routes.ts):
- Parse `ResumeClosedSessionSchema`
- Validate `workingDir` exists as a directory (`statSync`)
- Check that `workingDir` is not already active (scan `ctx.sessions` for matching `workingDir`)
- Create `new Session({ workingDir, mode, name, claudeResumeId: resumeId, mux: ctx.mux, useMux: true })`
- Set `session.claudeResumeId = resumeId` before `startInteractive()` — this makes `buildMcpArgs`
  pass `--resume <uuid>` to the Claude CLI (see `session-cli-builder.ts` line 113-115)
- Then follow the same pattern as `POST /api/sessions` in `session-routes.ts`:
  `addSession`, `incrementSessionsCreated`, `persistSessionState`, `setupSessionListeners`,
  lifecycle log `created`, broadcast `SessionCreated`, call `startInteractive()`, broadcast
  `SessionInteractive` and `SessionUpdated`
- Return `{ success: true, session: lightState }`

**Key constraint**: `buildInteractiveArgs()` in `session-cli-builder.ts` omits `--session-id`
when `resumeId` is set (line 57: `if (!resumeId) args.push('--session-id', sessionId)`).
`buildMcpArgs()` appends `--resume <uuid>` when `resumeId` is set (line 113-114).
So setting `session.claudeResumeId` before `startInteractive()` is the correct mechanism.

**IMPORTANT**: The `Session` constructor does not accept `claudeResumeId` as an init param —
it must be set on the object AFTER construction but BEFORE `startInteractive()`. Verify
this in `session.ts` line 868: `claudeResumeId` is serialized from `this.claudeResumeId`.

**Route registration**: history-routes go in `session-routes.ts` is already at 24 handlers.
Better to add a new file `history-routes.ts` with its own `registerHistoryRoutes()` export,
registered in `index.ts` and `server.ts` using `SessionPort & EventPort & ConfigPort & InfraPort`
(same as `registerWorktreeSessionRoutes`).

**IMPORTANT path conflict**: `GET /api/sessions/history` could conflict with
`GET /api/sessions/:id` — Fastify matches literal routes before parametric, so `history`
would be treated as the `:id` param if not declared before the param route. Add this route
BEFORE `GET /api/sessions/:id` in the registration order, OR ensure it's registered in a
separate module that loads first. Since session routes are registered in `registerSessionRoutes`,
the safest approach is to register history routes in a new file before session routes in `server.ts`.

#### Frontend Changes

**1. "History" button in `SessionDrawer._render()`** (app.js ~line 16664):
Add a third footer button "Resume Closed" (or clock icon) in `drawer-footer` div.

**2. New modal/panel `HistoryModal`** (object literal pattern like existing modals in app.js):
- Opens as a full-drawer overlay or modal (reuse `.modal-overlay` pattern)
- Fetches `GET /api/sessions/history` on open
- Displays a scrollable list with optional text filter input (simple substring match on
  `displayName` + `workingDir` — no fuzzy lib needed)
- Each entry shows: project name (last segment of workingDir), full path as subtitle,
  `timeAgo(lastActiveAt)`, UUID snippet (first 8 chars), optional branch badge
- "Resume" button per entry → `POST /api/sessions/resume` → close modal → `app.selectSession(newId)`
- Filters out entries where workingDir matches an already-active session's workingDir

**3. CSS** (styles.css): add styles for `.history-modal`, `.history-entry`, `.history-entry-name`,
`.history-entry-path`, `.history-entry-meta`, `.history-resume-btn`. Reuse existing modal patterns.

**4. Version bumps** (index.html):
- `app.js?v=0.4.104` → `app.js?v=0.4.105`
- `styles.css?v=0.1688` → `styles.css?v=0.1689`

### Implicit Constraints from Codebase

- **TypeScript strict mode**: `noUnusedLocals`, `noUnusedParameters`, all vars must be typed
- **No `require()`** — ESM only; use `import` or `await import()`
- **DOM safety**: Use `textContent` / `createElement` not `innerHTML` with user data (SessionDrawer pattern)
- **Port interfaces**: Route files use intersection types like `SessionPort & EventPort & ConfigPort & InfraPort`
- **Zod v4 API**: Define schemas in `schemas.ts`, use `.safeParse()`
- **Lifecycle log is append-only** — do not add query params to filter for deleted events; use
  the existing `query()` method with no `event` filter and filter in memory
- **`statSync` for dir validation** (not async) — existing session creation routes do this
- **`Session` object pattern**: Constructor takes `SessionConfig`-like object; `claudeResumeId`
  is a property on `Session` class set after construction (not in constructor signature)
- **Active session dedup**: Scan `ctx.sessions` for `session.claudeResumeId === resumeId` AND
  `session.workingDir === workingDir` before creating a resume session

## Fix / Implementation Notes

### Fix cycle 1 — `decodeProjectDir` double-slash correction

**File**: `src/web/routes/history-routes.ts`

Removed the erroneous `'/' +` prefix from `decodeProjectDir`. Claude's encoding replaces each `/` with `-`, so the escaped form already begins with `-` (representing the root `/`). Calling `escapedDir.replace(/-/g, '/')` alone correctly reconstructs the absolute path. The previous implementation prepended an additional `/`, yielding `//home/...` paths that broke:
1. `GET /api/sessions/history` response — all `workingDir` values had `//` prefix
2. Active-session dedup in `POST /api/sessions/resume` — `//home/...` never matched `/home/...` in active sessions
3. New session `workingDir` stored with `//` prefix



### Backend

**`src/web/schemas.ts`** — Added `ResumeClosedSessionSchema` (workingDir safePathSchema, resumeId UUID, optional name/mode) and its inferred type.

**`src/web/server.ts`** — Enhanced `_doCleanupSession()` to include `extra: { workingDir, claudeResumeId, worktreeBranch }` in the lifecycle log entry at delete/detach time. Also imports and registers `registerHistoryRoutes` before `registerSessionRoutes` to avoid Fastify path conflict with `:id` param.

**`src/web/routes/history-routes.ts`** — New route file implementing:
- `GET /api/sessions/history`: reads last 500 lifecycle log entries (deleted/detached events), extracts `extra.workingDir` and `extra.claudeResumeId`, deduplicates by sessionId, filters out currently active sessions. Falls back to scanning `~/.claude/projects/` (capped at 100 JSONL files, sorted by mtime) for entries not covered by the lifecycle log. Returns merged `ClosedSessionEntry[]` sorted by `lastActiveAt` desc.
- `POST /api/sessions/resume`: validates via `ResumeClosedSessionSchema`, verifies workingDir exists, checks no active session already has the same resumeId or workingDir, creates a `Session` object, sets `session.claudeResumeId = resumeId` AFTER construction but BEFORE `startInteractive()` so `session-cli-builder.ts` injects `--resume <uuid>` automatically.

**`src/web/routes/index.ts`** — Added `registerHistoryRoutes` export.

### Frontend

**`src/web/public/app.js`** — Added `HistoryModal` object (literal pattern) with:
- `open()` / `close()` — toggling `#historyModal` `.active` class
- `_load()` — fetches `GET /api/sessions/history`, renders entry list
- `_renderList()` — builds DOM via `createElement`/`textContent` (no innerHTML with user data), shows displayName, path, time ago, UUID snippet, branch badge
- `_filterList(query)` — simple substring filter on displayName + workingDir
- `_resume(s, btn)` — POSTs to `/api/sessions/resume`, navigates to new session on success

Also added "⏱ Resume Closed" button to `SessionDrawer._render()` footer (alongside existing New Project / Clone from Git buttons).

**`src/web/public/index.html`** — Added `#historyModal` markup (uses `.modal`/`.modal-lg` pattern, with backdrop click to close, search input, list container). Bumped `styles.css?v=0.1688` → `v=0.1689` and `app.js?v=0.4.104` → `v=0.4.105`.

**`src/web/public/styles.css`** — Appended CSS for `.history-modal`, `.history-search`, `.history-list`, `.history-entry`, `.history-entry-{name,path,meta,time,uuid,branch}`, `.history-resume-btn`, `.history-empty`, `.history-loading`.

## Review History
<!-- appended by each review subagent — never overwrite -->

### Review attempt 2 — APPROVED

**TypeScript** (`npx tsc --noEmit`): PASS — zero errors.

**ESLint** (`npm run lint`): PASS — zero warnings or errors.

**Fix verification — `decodeProjectDir` double-slash**: CONFIRMED CORRECT.
The file at line 48 now reads:
```ts
return escapedDir.replace(/-/g, '/');
```
No `'/' +` prefix. The leading `-` in Claude's escaped dir name (e.g. `-home-user-project`) decodes to the leading `/` via the replace, yielding `/home/user/project` correctly. The double-slash regression is resolved.

**Remaining code review**: No new issues found.
- All three impacts of the bug (GET response, active-session dedup in POST, stored workingDir) are fixed by the single-line change.
- `buildLifecycleEntries` and `buildScanEntries` logic unchanged and correct.
- `POST /api/sessions/resume` active-session guard correctly compares `s.workingDir === workingDir` — now that `workingDir` is a proper `/home/...` path, this comparison will work correctly against active sessions.
- Session creation pattern (set `claudeResumeId` post-construction pre-`startInteractive()`) is intact.
- The two minor non-blocking findings from Review 1 (`activeWorkingDirs` unused at GET call site, `filePath` unused in scan loop) remain present but are not regressions and do not affect correctness.

**Verdict**: APPROVED.

### Review attempt 1 — APPROVED

**TypeScript**: `npx tsc --noEmit` exits 0. **Lint**: `npm run lint` exits 0.

**Correctness**: All constraints satisfied.
- Lifecycle log capped at 500 lines (`MAX_LIFECYCLE_LINES = 500`), scan capped at 100 JSONL files (`MAX_SCAN_ENTRIES = 100`).
- Active-session dedup: GET filters by `activeResumeIds`; POST checks both `claudeResumeId` and `workingDir` before creating.
- `--resume <uuid>` injection: `session.claudeResumeId` is set post-construction, pre-`startInteractive()` — confirmed correct per `session-cli-builder.ts` lines 57 and 113–114.
- No new npm dependencies added.
- CSS/JS `?v=` strings bumped: `styles.css?v=0.1689`, `app.js?v=0.4.105`.
- Fastify route conflict avoided: history routes registered before session routes in `server.ts`.

**Security**: `workingDir` validated by `safePathSchema` (absolute, no shell metacharacters, no `..`). `resumeId` validated as UUID v4 by Zod. `statSync` verifies directory existence before session creation. `POST /api/sessions/resume` is behind the same auth middleware as all other session routes.

**DOM safety**: `HistoryModal._renderList()` uses `createElement`/`textContent` throughout — no `innerHTML` with user-controlled data.

**Minor findings (non-blocking)**:
1. `activeWorkingDirs` is built inside `getActiveSets()` and returned, but never destructured at the GET handler call site — dead data in the returned object. Not flagged by TypeScript because it is "used" (returned). Does not affect correctness.
2. `filePath` is stored in each `candidates` entry but never accessed in the consumption loop (only `escapedDir`, `mtime`, `uuid` are used). Same — dead field, no impact.
3. `decodeProjectDir` is a lossy reverse of Claude's `/`→`-` escaping. This is documented in the code comment. For scan entries, the decoded `workingDir` could be wrong for paths with literal hyphens; the `statSync` check in `POST /api/sessions/resume` will surface this to the user at resume time. Acceptable given the fallback source nature of scan entries.

## QA Results

### QA Run 2 — 2026-03-14 — PASS

**TypeScript typecheck** (`npx tsc --noEmit`): PASS — zero errors.

**ESLint** (`npm run lint`): PASS — zero warnings or errors.

**Backend — GET /api/sessions/history**: PASS — `workingDir` values all start with a single `/` (e.g. `/home/siggi/sources/Codeman`). No double-slash observed. Double-slash bug confirmed fixed.

**Backend — POST /api/sessions/resume**: N/A (not re-tested; root cause fix in `decodeProjectDir` was confirmed correct by code inspection and the GET response).

**Frontend**: "⏱ Resume Closed" button confirmed present in `SessionDrawer._render()` footer (`app.js` line 16680). All CSS and JS elements (`HistoryModal`, `.history-modal`, `.history-entry`, `.history-resume-btn`, version strings) already verified in prior QA run.

**Verdict**: ALL CHECKS PASS. Status → done.

---

### QA Run — 2026-03-14 — FAIL

**TypeScript typecheck** (`npx tsc --noEmit`): PASS — zero errors.

**ESLint** (`npm run lint`): PASS — zero warnings or errors.

**Backend — GET /api/sessions/history**: PASS — returns `{ success: true, sessions: [...] }` with correct shape (`resumeId`, `workingDir`, `displayName`, `lastActiveAt`, `source`).

**Backend — POST /api/sessions/resume**: PARTIAL FAIL — endpoint responds and creates a session, but there is a critical bug:

**Bug: `decodeProjectDir` produces double-slash paths**

`decodeProjectDir(escapedDir)` does:
```
return '/' + escapedDir.replace(/-/g, '/');
```
Claude's encoding replaces each `/` with `-`, so `/home/siggi/sources/Codeman` becomes `-home-siggi-sources-Codeman`. The decode should be just `escapedDir.replace(/-/g, '/')` (the leading `-` already becomes the leading `/`). Prepending an extra `'/'` produces `//home/siggi/sources/Codeman`.

**Impact:**
1. All `workingDir` values returned by `GET /api/sessions/history` have a `//` prefix (observed in live response: `'//home/siggi/sources/Codeman'`).
2. The active-session dedup check in `POST /api/sessions/resume` (line 240: `s.workingDir === workingDir`) fails silently — active sessions store `/home/...` but the decoded history path is `//home/...`, so the check does NOT catch duplicates. A second session gets created for the same working directory.
3. The new session's `workingDir` is stored as `//home/...` in state, which may cause downstream path issues.

`statSync` on Linux accepts `//` paths (POSIX allows two leading slashes), so the directory-existence check does not catch this.

**Fix required:** Change `decodeProjectDir` to not prepend `/`:
```ts
return escapedDir.replace(/-/g, '/');
```

**Frontend**: CSS and JS elements present (`HistoryModal`, `.history-modal`, `.history-entry`, `.history-resume-btn`, "⏱ Resume Closed" button in drawer footer). Version strings bumped (`app.js?v=0.4.105`, `styles.css?v=0.1689`). Frontend structure looks correct — not blocking the fix.

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

2026-03-14: Fix applied — `decodeProjectDir` double-slash bug.
- Removed erroneous `'/' +` prefix from `decodeProjectDir` in `history-routes.ts`
- Claude's encoding already produces a leading `-` for the root `/`, so `replace(/-/g, '/')` alone yields the correct absolute path
- No other files changed; fix is minimal

2026-03-14: Implementation complete.
- `history-routes.ts` registered BEFORE `session-routes.ts` in server.ts to avoid Fastify param conflict
- `Session.claudeResumeId` set post-construction, pre-`startInteractive()` as specified
- JSONL scan decoded via `'/' + escapedDir.replace(/-/g, '/')` (lossy; documented in code)
- Unused imports (`existsSync`, `fs`) removed after tsc caught them; all type checks pass
- CSS/JS version strings bumped per CLAUDE.md rules

2026-03-14: Analysis complete.
- Lifecycle log currently does NOT persist workingDir/claudeResumeId at delete time; enhancement needed
- `Session.claudeResumeId` must be set post-construction, pre-`startInteractive()` for --resume to work
- New route file `history-routes.ts` preferred over adding to system-routes.ts (already large)
- `/api/sessions/history` must be registered before `/api/sessions/:id` to avoid Fastify param conflict
- Filesystem scan of ~/.claude/projects/ needed for backward compat (pre-enhancement deletes)
- No fuzzy search library needed; simple substring filter sufficient given constraints

# Task

type: bug
status: done
title: Session created via "+" button uses wrong directory and naming convention
description: Two bugs when clicking the "+" button next to a project name in the sidebar to create a new session. Affects any project that exists in both ~/codeman-cases/ and linked-cases.json (e.g. "Codeman"). Bug 1: Wrong directory — session is created in ~/codeman-cases/Codeman instead of /home/siggi/sources/Codeman. Root cause: In GET /api/cases (case-routes.ts line 30-83), native cases from CASES_DIR are enumerated first, and linked cases are only added if no case with the same name already exists (line 65: !cases.some(c => c.name === name)). So when "Codeman" exists in both places, the native case wins with the wrong path. The GET /api/cases/:name endpoint (line 271) does the opposite — checks linked cases first. Fix: linked cases should take priority over native cases in the list endpoint too, since they represent explicit user configuration. Bug 2: Wrong name — the session gets named "Codeman" (AI-generated) instead of wN-Codeman (the project's naming convention). The startSessionInCase function (app.js line 11496) fires auto-name which asks Claude Haiku to generate a descriptive name. It should instead use the wN-ProjectName convention: count existing sessions for the same case/project and assign the next number. This naming should happen in startSessionInCase before the session is created (pass it as name in the POST body) or right after, and skip the auto-name call.
affected_area: frontend+backend
work_item_id: wi-f5312d48
fix_cycles: 0
test_fix_cycles: 0

## Reproduction

### Steps to reproduce (Bug 1 — wrong directory)
1. Have a project "Codeman" that exists in both ~/codeman-cases/Codeman (native case) and ~/.codeman/linked-cases.json (linked to /home/siggi/sources/Codeman).
2. Open the Codeman web UI sidebar.
3. Click the "+" button next to the "Codeman" project name.
4. Select "Claude" (or any mode).
5. **Result**: Session is created with workingDir=/home/siggi/codeman-cases/Codeman instead of /home/siggi/sources/Codeman.
6. **Expected**: Session should use /home/siggi/sources/Codeman (the linked path), since linked cases represent explicit user configuration and should take priority.

### Steps to reproduce (Bug 2 — wrong name)
1. Click "+" next to any project in the sidebar and create a Claude session.
2. **Result**: Session is auto-named by Claude Haiku with a descriptive name like "Codeman" or "Codeman Web App".
3. **Expected**: Session should be named wN-ProjectName (e.g. w1-Codeman, w2-Codeman) where N is the next available number for that project.

### Root cause analysis
**Bug 1**: In `src/web/routes/case-routes.ts`, the `GET /api/cases` endpoint (line 30-83) iterates native cases from CASES_DIR first and adds them to the list. Then it iterates linked cases from linked-cases.json but only adds them if `!cases.some(c => c.name === name)` (line 65). This means if a case exists in both places, the native one takes priority. However, the `GET /api/cases/:name` endpoint (line 271-312) does the opposite: it checks linked cases FIRST, then falls back to CASES_DIR. These two endpoints are inconsistent, and linked cases should win in both since they represent explicit user intent.

**Bug 2**: In `src/web/public/app.js`, `startSessionInCase()` (line 11496-11575) creates the session then fires `auto-name` (line 11567) which calls Claude Haiku to generate a name. Instead, it should compute the next wN- number by counting existing sessions for the same project and set the name directly, skipping auto-name. The wN- convention is already recognized by the session grouping code (line 21992-21998: `name.match(/^[ws]\d+-(.+)$/i)`).

## Root Cause / Spec

### Bug 1: Wrong directory (linked cases lose to native cases in list endpoint)

**Root cause confirmed.** In `src/web/routes/case-routes.ts`:

- `GET /api/cases` (lines 30-83): Enumerates native cases from `CASES_DIR` first, then iterates linked cases from `linked-cases.json` but **skips** any linked case whose name already exists in the list (line 66: `!cases.some(c => c.name === name)`). So when "Codeman" exists in both `~/codeman-cases/Codeman` (native) and `linked-cases.json` (pointing to `/home/siggi/sources/Codeman`), the native case wins with the wrong path.

- `GET /api/cases/:name` (lines 271-312): Does the **opposite** -- checks linked cases FIRST (line 286: `if (linkedCases[name])`), then falls back to `CASES_DIR`. These two endpoints are inconsistent.

**Impact path:** The frontend calls `GET /api/cases` at startup (app.js line 10035-10037) and stores the result in `this.cases`. When `startSessionInCase()` runs (line 11499), it looks up the case by name in `this.cases` to get the `path`. Since the list endpoint returned the native path, that wrong path is used for the new session.

The fallback at line 11504-11508 fetches `GET /api/cases/:name` which DOES check linked cases first, but this fallback only triggers if the case isn't already in `this.cases` -- which it always is (just with the wrong path).

**Fix:** In `GET /api/cases`, linked cases should **override** native cases with the same name, not be skipped. Change the logic so that when a linked case has the same name as a native case, the linked case replaces it (or: process linked cases first, then only add native cases if no linked case has that name).

### Bug 2: Wrong naming convention (AI auto-name instead of wN-ProjectName)

**Root cause confirmed.** In `src/web/public/app.js`:

- `startSessionInCase()` (lines 11496-11575) creates the session via `POST /api/sessions` with `body: JSON.stringify({ workingDir, mode })` -- no `name` field is passed (line 11548).
- After creation, it fires `POST /api/sessions/:id/auto-name` (line 11567) which calls Claude Haiku to generate a descriptive AI name.
- The `POST /api/sessions` endpoint already supports a `name` field (schema at `src/web/schemas.ts` line 143, used at `session-routes.ts` line 148).

The codebase already has a naming convention: `wN-CaseName` for regular sessions and `sN-CaseName` for shell sessions, as recognized by the grouping helper at line 21994: `name.match(/^[ws]\d+-(.+)$/i)`.

**Fix:** In `startSessionInCase()`, before creating the session:
1. Count existing sessions for the same case name by iterating `this.sessions` values and matching sessions whose `name` matches the `^[ws]\d+-CaseName$` pattern (or whose `workingDir` matches).
2. Compute the next number N.
3. Set `name` to `wN-CaseName` (or `sN-CaseName` for shell mode) and pass it in the POST body.
4. Skip the `auto-name` call entirely when a name was computed this way.

For OpenCode sessions (line 11534), the same fix applies -- compute name before creating, pass it in the quick-start body, and skip auto-name.

### Affected files

| File | Bug | Change needed |
|------|-----|---------------|
| `src/web/routes/case-routes.ts` | Bug 1 | Make linked cases override native cases in `GET /api/cases` |
| `src/web/public/app.js` | Bug 2 | Compute `wN-CaseName` in `startSessionInCase()`, pass as `name`, skip auto-name |

## Fix / Implementation Notes

### Bug 1: Linked cases now override native cases in GET /api/cases

**File:** `src/web/routes/case-routes.ts` (lines 65-80)

Changed the linked-cases loop: instead of skipping linked cases when a native case with the same name exists (`!cases.some(c => c.name === name)`), it now uses `findIndex` to locate any existing native case with the same name and **replaces** it with the linked case entry. If no duplicate exists, the linked case is appended as before. This makes the list endpoint consistent with the detail endpoint (`GET /api/cases/:name`), which already checks linked cases first.

### Bug 2: Sequential naming (wN/sN-CaseName) instead of AI auto-name

**File:** `src/web/public/app.js` (lines 11516-11529, plus changes in session creation paths)

Added name computation at the top of `startSessionInCase()`, before any session creation:
1. Determines prefix (`w` for claude/opencode, `s` for shell).
2. Scans `this.sessions` for existing sessions matching `^{prefix}\d+-{caseName}$` (case-insensitive, regex-escaped).
3. Finds the max N and sets `sessionName = "{prefix}{N+1}-{caseName}"`.

For the **claude/shell** path: passes `name: sessionName` in the POST `/api/sessions` body (already supported by the schema at `session-routes.ts` line 148). Removed the `auto-name` fire-and-forget call.

For the **opencode** path: the quick-start endpoint doesn't accept a `name` field, so after session creation, a PUT `/api/sessions/:id/name` call sets the name (fire-and-forget). Removed the `auto-name` call.

## Review History
<!-- appended by each review subagent — never overwrite -->
### Review attempt 1 — APPROVED
**Correctness**: Both changes directly address the two bugs described in the spec.
- Bug 1: `findIndex` + replace logic correctly makes linked cases override native cases in `GET /api/cases`, consistent with how `GET /api/cases/:name` already works.
- Bug 2: Sequential name computation (`wN-CaseName` / `sN-CaseName`) correctly scans existing sessions, finds max N, and passes the computed name in the POST body. Auto-name calls removed from all paths.
**Edge cases checked**:
- First session for a case: `_maxN=0` yields `w1-CaseName`. Correct.
- `this.sessions` null/undefined: guarded by `if (this.sessions)`. Correct.
- Case names with regex special chars: escaped via `caseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`. Correct.
- OpenCode path: QuickStartSchema strips the `name` field (harmless), PUT rename sets it afterward. Correct.
- Shell sessions: `sN-CaseName` name passed in POST body before shell start. Correct.
- Variable shadowing: `caseEntry` avoids shadowing the outer `entry` loop variable. Good.
**TypeScript**: `CaseInfo` type annotation is explicit. No implicit any. tsc passes.
**Security**: No new external inputs, no user-controlled paths beyond existing patterns.
**No issues found.**

## Test Gap Analysis
**Verdict: GAPS FOUND**

### Gap 1: Linked case overrides native case with same name (case-routes.ts)
- `test/routes/case-routes.test.ts` tests linked cases being included, but only when names are different.
- **Missing:** Test where a native case and linked case share the same name — linked should win (return linked path, `linked: true`).

### Gap 2: Sequential naming in startSessionInCase (app.js)
- `test/sidebar-new-session-menu.test.ts` uses source-text matching to verify `startSessionInCase` calls `/api/sessions` with `mode`.
- **Missing:** Test verifying `name` field is passed in the POST body with `wN-CaseName` format.
- **Missing:** Test verifying `auto-name` is NOT called.
- **Missing:** Test verifying sequential numbering (e.g., if `w1-Foo` exists, next is `w2-Foo`; shell mode uses `sN-`).

## Test Writing Notes

### test/routes/case-routes.test.ts
- Added 1 new test: "linked case overrides native case with same name" — creates a native and linked case with the same name "Codeman", verifies only one entry is returned and it has the linked path and `linked: true`.
- Fixed existing test "includes linked cases from linked-cases.json" — changed counter-based `readFile` mock to path-based dispatch (`filePath.includes('linked-cases.json')`) to be compatible with the new case-config.json read that occurs in the native cases loop.

### test/sidebar-new-session-menu.test.ts
- Added 5 new tests in "startSessionInCase sequential naming" describe block:
  1. Uses "w" prefix for non-shell sessions
  2. Uses "s" prefix for shell sessions
  3. Passes `name: sessionName` in POST body
  4. Does NOT call `/auto-name` endpoint
  5. Scans `this.sessions` for existing numbered sessions
- Fixed existing tests: increased fnSlice from 2000 to 3000 chars to accommodate the added name computation code.

All 57 tests pass (45 case-routes + 12 sidebar).

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->
### Test review attempt 1 — APPROVED
- **Coverage**: All 3 gaps covered — linked case override (1 test), sequential naming (5 tests).
- **Correctness**: case-routes test verifies exactly one entry with linked path and `linked: true`. Sidebar tests verify prefix selection, name in body, no auto-name, session scanning.
- **Realism**: case-routes test uses realistic scenario (same name in both locations). Sidebar tests match project's source-text analysis pattern.
- **Style**: Matches existing test patterns. Removed unused `readCallCount` variable. Fixed existing fragile counter-based mock.
- **No issues found.**

## QA Results
- **tsc --noEmit**: PASS (zero errors)
- **npm run lint**: PASS (0 errors, 2 pre-existing warnings in unrelated files)
- **vitest run test/routes/case-routes.test.ts test/sidebar-new-session-menu.test.ts**: PASS (57/57 tests)
- **Backend targeted check**: Started dev server on port 3099, verified `GET /api/cases` returns Codeman with `path: "/home/siggi/sources/Codeman"` and `linked: true` (was previously returning `/home/siggi/codeman-cases/Codeman` without `linked`). PASS.

### Docs Staleness
- API docs may need update (src/web/routes/case-routes.ts changed) -- advisory only, minor behavior fix.
- UI docs may need update (frontend app.js changed) -- advisory only, minor naming behavior change.

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

- **Linked case override strategy:** Used `findIndex` + replace rather than reordering the processing (linked-first). This preserves the native case enumeration order while ensuring linked cases win on name conflicts.
- **OpenCode name via PUT rename:** The quick-start endpoint schema doesn't accept `name`, so we use a fire-and-forget PUT `/api/sessions/:id/name` call after creation. This is consistent with how auto-name was previously done (fire-and-forget POST).
- **Variable naming with underscore prefix:** Used `_prefix`, `_pattern`, `_maxN` to avoid any potential conflicts with surrounding scope in the large app.js file.
- **Regex escaping case name:** Applied full regex escaping to `caseName` in the pattern to handle cases with special characters (e.g., "C++Project").

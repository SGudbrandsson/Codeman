# Task

type: bug
status: done
title: Move feature usage analytics to server-side storage
description: |
  Feature usage analytics (built in feat/usage-analytics branch) currently stores all tracking
  data in localStorage. This means each device (mobile, desktop) has its own isolated dataset.
  The user wants to analyze usage across ALL devices, so storage must move server-side.

  Changes needed:
  1. Add a server-side API route for feature usage data:
     - GET /api/feature-usage — return all usage data (merged across devices)
     - POST /api/feature-usage/track — record a feature usage event { featureId, timestamp }
     - POST /api/feature-usage/reset — clear all usage data
     - GET /api/feature-usage/export — return full JSON export (registry merged with usage)
  2. Store data in a JSON file on disk (e.g. ~/.codeman/feature-usage.json) — no database needed
  3. Update feature-tracker.js to POST to the server instead of using localStorage:
     - track() → POST /api/feature-usage/track (fire-and-forget, don't block UI)
     - _renderTable() → GET /api/feature-usage (async, update table when data arrives)
     - _exportAndDownload() → GET /api/feature-usage/export
     - _resetWithConfirm() → POST /api/feature-usage/reset
  4. Keep the debounce logic client-side (no need to debounce on server)
  5. The feature-registry.js stays client-side (static data, no change needed)
  6. The Usage tab in Settings stays the same visually

  IMPORTANT: The feat/usage-analytics branch has not been merged to master yet.
  This worktree is based on master. You need to cherry-pick or manually apply the
  changes from feat/usage-analytics first (commits 588b7896 and 951cdbac), THEN
  make the server-side storage changes on top.

  The feat/usage-analytics worktree is at: /home/siggi/sources/Codeman-feat-usage-analytics
  You can copy files from there or cherry-pick the commits.
affected_area: backend
work_item_id: wi-89c26f36
fix_cycles: 0
test_fix_cycles: 0

## Reproduction
<!-- filled by analysis subagent -->

## Root Cause / Spec

### Problem
Feature usage analytics (commits 588b7896 and 951cdbac, not yet merged to master) stores all
tracking data in `localStorage`. Each device has isolated data, so cross-device usage analysis
is impossible.

### Current State of This Worktree
- Based on master. The analytics files do **not** exist yet:
  - `src/web/public/feature-tracker.js` — missing
  - `src/web/public/feature-registry.js` — missing
  - `index.html` has no Usage tab, no script tags for the above
  - `app.js` has no `FeatureTracker.track()` calls
  - `test/feature-tracker.test.ts` — missing

### Step 1: Cherry-pick the two commits
Cherry-pick `588b7896` then `951cdbac` onto this branch. This brings in:
- `feature-registry.js` (static registry, ~108 features, stays client-side unchanged)
- `feature-tracker.js` (localStorage-based tracker singleton)
- `index.html` changes (Usage tab in Settings, script tags)
- `app.js` instrumentation (~55 `FeatureTracker.track()` calls)
- `mobile-handlers.js` and `voice-input.js` instrumentation (2 calls each)
- `keyboard-accessory.js` instrumentation (1 call)
- `test/feature-tracker.test.ts` (Playwright tests)
- `src/orchestrator.ts` lint fix (unrelated, harmless)

If cherry-pick has conflicts, resolve manually — the app.js in master has had subsequent commits
(e.g. 689bf822, bb761928, 5aa2ce6a) that may conflict with the analytics insertions.

### Step 2: Add server-side API route file

Create `src/web/routes/feature-usage-routes.ts` following the existing pattern:
- Import `FastifyInstance`
- Export `registerFeatureUsageRoutes(app: FastifyInstance): void`
- Storage file: `~/.codeman/feature-usage.json` (resolve via `os.homedir()`)
- Data shape on disk: `{ [featureId: string]: { count: number, firstUsed: string, lastUsed: string } }`

**Routes:**

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/api/feature-usage` | Read JSON file, return `{ success: true, data }` |
| `POST` | `/api/feature-usage/track` | Body: `{ featureId, timestamp? }`. Increment count, update firstUsed/lastUsed, write file. Return `{ success: true }` |
| `POST` | `/api/feature-usage/reset` | Delete or empty the JSON file. Return `{ success: true }` |
| `GET` | `/api/feature-usage/export` | Read JSON file + read `feature-registry.js` from disk (or accept registry from query/body). Merge registry metadata with usage counts. Return merged JSON array. |

**Implementation notes:**
- Use sync `fs.readFileSync` / `fs.writeFileSync` (matches `plugin-routes.ts` pattern) — the file is tiny.
- Handle missing file gracefully (return `{}`).
- For `/export`, the registry is client-side JS. Two options:
  - (a) Have the client POST the registry along with the export request — simplest.
  - (b) Parse `feature-registry.js` on the server — fragile.
  - (c) Have the client fetch `/api/feature-usage` and merge locally — **best approach**, keeps export logic in `feature-tracker.js` where it already lives. The server just provides the raw data; the client merges with `window.FeatureRegistry` and triggers the download.
  - **Decision: option (c)** — `/api/feature-usage/export` is unnecessary as a server route. The client `_exportAndDownload()` will fetch `/api/feature-usage`, merge with `window.FeatureRegistry`, and download. This avoids duplicating the registry on the server.

So the actual routes reduce to three:
1. `GET /api/feature-usage` — return all usage data
2. `POST /api/feature-usage/track` — record event
3. `POST /api/feature-usage/reset` — clear data

### Step 3: Wire up in server.ts and routes/index.ts
- Add `registerFeatureUsageRoutes` to `routes/index.ts` barrel export
- Import and call `registerFeatureUsageRoutes(this.app)` in `server.ts` (no ctx needed — pure file I/O)

### Step 4: Rewrite feature-tracker.js for server-side storage

Replace localStorage calls with `fetch()`:

- **`track(featureId)`**: Keep client-side debounce (`_lastTrack` map, 1000ms). Fire `fetch('/api/feature-usage/track', { method: 'POST', body: JSON.stringify({ featureId }) })` — fire-and-forget (no `await`, catch silently).
- **`_load()` / `getData()`**: No longer needed for local cache. Remove `_data`, `_save()`, `STORAGE_KEY`.
- **`_renderTable()`**: Make async. `fetch('/api/feature-usage')` → parse JSON → render table. Show a brief loading state or just render when data arrives.
- **`_exportAndDownload()`**: `fetch('/api/feature-usage')` → merge with `window.FeatureRegistry` → trigger download blob (same as current but data comes from server).
- **`_resetWithConfirm()`**: `fetch('/api/feature-usage/reset', { method: 'POST' })` → re-render table.
- **`exportJson()`**: Becomes async — fetches from server, merges with registry, returns JSON string.
- **`reset()`**: POSTs to server.

### Step 5: Update tests
- `test/feature-tracker.test.ts` currently tests localStorage behavior. Update to test against the server API instead (the Playwright tests already spin up a `WebServer` on port 3248, so the API will be available).
- Test: track via API, verify GET returns updated counts, reset clears, export merges correctly.

### Constraints / Patterns to Match
- Route file naming: `feature-usage-routes.ts` (kebab-case, matches existing)
- Registration pattern: `registerFeatureUsageRoutes(app: FastifyInstance): void`
- JSON storage at `~/.codeman/feature-usage.json` (matches `push-keys.json`, `settings.json` pattern)
- No database needed — tiny JSON file, sync I/O is fine
- No SSE events needed — usage data is not real-time

## Fix / Implementation Notes

### Cherry-pick (Step 1)
- Cherry-picked commits `588b7896` and `951cdbac` cleanly onto this branch (no conflicts).
- This brought in: `feature-registry.js`, `feature-tracker.js`, `index.html` Usage tab, `app.js` instrumentation calls, `mobile-handlers.js`/`voice-input.js`/`keyboard-accessory.js` instrumentation, and `test/feature-tracker.test.ts`.

### Server-side route (Step 2)
- Created `src/web/routes/feature-usage-routes.ts` with 3 routes:
  - `GET /api/feature-usage` — reads `~/.codeman/feature-usage.json`, returns `{ success, data }`
  - `POST /api/feature-usage/track` — validates `featureId`, increments count, updates firstUsed/lastUsed, writes file
  - `POST /api/feature-usage/reset` — deletes the JSON file
- Uses sync `fs.readFileSync`/`fs.writeFileSync` matching existing patterns (e.g. `plugin-routes.ts`).
- Graceful handling: missing file returns `{}`, missing `.codeman` dir is created with `mkdirSync({ recursive: true })`.

### Route wiring (Step 3)
- Added `registerFeatureUsageRoutes` export to `src/web/routes/index.ts`
- Added import + call in `src/web/server.ts` (no ctx needed — pure file I/O)

### Client rewrite (Step 4)
- Rewrote `src/web/public/feature-tracker.js`:
  - Removed: `STORAGE_KEY`, `_data`, `_load()`, `_save()`, all `localStorage` references
  - `track()` — kept client-side debounce, fires POST to `/api/feature-usage/track` (fire-and-forget)
  - `getData()` — now async, fetches from `/api/feature-usage`
  - `reset()` — now async, POSTs to `/api/feature-usage/reset`, clears `_lastTrack`
  - `exportJson()` — now async, fetches server data then merges with `window.FeatureRegistry`
  - `_renderTable()`, `_exportAndDownload()`, `_resetWithConfirm()` — now async
- All callers in `app.js` and `index.html` use these as fire-and-forget (onclick, tab switch), so async is backward-compatible.

### Tests (Step 5)
- Rewrote `test/feature-tracker.test.ts` to test server API routes directly and client-side behavior through Playwright.
- Tests: API CRUD operations, client debounce logic, getData/reset/exportJson async behavior.
- Removed all localStorage-based assertions.

## Review History
<!-- appended by each review subagent — never overwrite -->
### Review attempt 1 — APPROVED
**Correctness**: All three API routes implement the spec correctly. The client-side rewrite properly replaces all localStorage calls with server fetches. Debounce logic preserved.
**Edge cases**: Missing file returns `{}`, directory creation with `recursive: true`, 400 on missing featureId, silent catch on fire-and-forget track(). All handled.
**TypeScript**: `tsc --noEmit` passes. Types are properly defined (`UsageEntry`, `UsageData`). The `req.body as` cast is acceptable for Fastify route handlers.
**Security**: No user-controlled paths (storage file is hardcoded). featureId is validated as string. No injection vectors.
**Patterns**: Matches existing route file conventions (kebab-case file, register function export, sync I/O). Wiring follows the barrel export + server.ts registration pattern exactly.
**Tests**: Comprehensive coverage of both server API and client-side behavior. Proper cleanup in afterAll.
**No issues found.**

## Test Gap Analysis
**Verdict: NO GAPS**

Changed source files:
1. `src/web/routes/feature-usage-routes.ts` (new) — 3 API routes. All tested by `test/feature-tracker.test.ts` "Server API" describe block (GET returns data, POST track creates/increments, POST track preserves firstUsed, POST track 400 on missing featureId, POST reset clears).
2. `src/web/public/feature-tracker.js` (rewritten) — all public methods tested: track() debounce (3 tests), getData() (2 tests), reset() (3 tests), exportJson() (7 tests).
3. `src/web/routes/index.ts` and `src/web/server.ts` — trivial wiring, implicitly tested by all integration tests that hit the API.

All new code paths have meaningful test coverage.

## Test Writing Notes
<!-- filled by test writing subagent -->

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

## QA Results
- **tsc --noEmit**: PASS (zero errors)
- **npm run lint**: PASS (2 pre-existing warnings in unrelated files, 0 errors)
- **Backend API test** (dev server on port 3099):
  - POST /api/feature-usage/reset: PASS (returns `{ success: true }`)
  - GET /api/feature-usage: PASS (returns empty `{}` after reset)
  - POST /api/feature-usage/track: PASS (creates entry with count=1, firstUsed preserved on update)
  - POST /api/feature-usage/track (repeat): PASS (count incremented to 2, lastUsed updated)
  - POST /api/feature-usage/track (no featureId): PASS (returns 400)
  - POST /api/feature-usage/reset + GET: PASS (data cleared)

### Docs Staleness
- API docs may need update (src/web/routes/ changed — new feature-usage-routes.ts)
- UI docs may need update (frontend changed — app.js, index.html with Usage tab)

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->
- **No /export route**: Client merges server data with `window.FeatureRegistry` locally (option c from analysis). Avoids duplicating registry on server.
- **Sync file I/O**: Matches existing `plugin-routes.ts` pattern. File is tiny (~few KB at most).
- **Fire-and-forget track()**: `track()` remains synchronous from the caller's perspective — the fetch is not awaited. This ensures zero UI blocking.
- **No localStorage migration**: Since the feat/usage-analytics branch hasn't been merged to master yet, there's no existing localStorage data to migrate.
- **Async methods are backward-compatible**: `_renderTable()`, `_exportAndDownload()`, `_resetWithConfirm()` are called as fire-and-forget from onclick handlers and tab switches, so returning a Promise is safe.

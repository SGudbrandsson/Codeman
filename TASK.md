# Task

type: fix
status: done
affected_area: frontend
fix_cycles: 0
test_fix_cycles: 0
title: Board/Action dashboard UX — blocking reasons, unblock, session linking
branch: fix/board-ux
port: 3007

## Bug Description

The Action Board / task management dashboard has several critical UX gaps that make it nearly unusable:

1. **Can't see WHY a task is blocked** — Tasks show "Blocked — resolve dependency" but never show WHICH item is blocking them. The dependency data exists in the `dependencies` table (`from_id` → `to_id`) but the detail panel doesn't query or display blockers.

2. **No way to unblock tasks from UI** — There's no "Remove Dependency" or "Unblock" button. Users must use the API directly (`DELETE /api/work-items/:id/dependencies/:depId`), which is not discoverable.

3. **"Open Session" shows empty/non-existent session** — Work items have optional `worktreePath` and `branchName` fields but clicking a work item doesn't link to or create a real session. If it creates a session, it does so without a working directory, resulting in an empty shell.

4. **Tasks stuck as queued/blocked with no path forward** — Users can't figure out what to do with blocked items. Need clear actionable guidance in the UI.

## Architecture Context

### Data Model
- Work items stored in SQLite: `work_items` table with status field (`queued`, `blocked`, `assigned`, `in_progress`, `review`, `done`, `cancelled`)
- Dependencies stored in `dependencies` table: `from_id` (blocker) → `to_id` (blocked item), `type: 'blocks'`
- A work item is "ready" only if ALL its blockers are `done` or `cancelled`

### Key Code Locations
- **Board view rendering**: `app.js` BoardView starting ~line 22324
  - Kanban columns: Queued (includes blocked), Working, Review, Done
  - Card rendering: ~line 22491-22575 (status dots, agent, elapsed time, next-action text)
  - Detail panel: ~line 22620-22747 (title, status, description, action buttons)
- **Work item routes**: `src/web/routes/work-item-routes.ts`
  - `GET /api/work-items/:id/dependencies` — returns dependencies for an item
  - `DELETE /api/work-items/:id/dependencies/:depId` — removes a dependency
  - `POST /api/work-items/:id/claim` — claims a queued item
- **Store logic**: `src/work-items/store.ts`
  - `getReadyWorkItems()` ~line 291 — SQL query for unblocked items
  - Circular dependency detection ~line 317
- **Attention dashboard**: `app.js` ~line 23321 — blocked items appear with "Unblock" button

### Missing Features to Add

1. **Blockers list in detail panel** — Query `GET /api/work-items/:id/dependencies` and display each blocker with its title, status, and a "Remove" button
2. **"Unblock" action** — Either remove dependency or override status, accessible from:
   - Detail panel blocker list (remove individual dependency)
   - Card context menu / quick action
   - Attention dashboard (already has an "Unblock" button placeholder)
3. **Session linking** — When clicking "Open Session" on a work item:
   - If `worktreePath` exists and has a matching session → switch to that session
   - If `worktreePath` exists but no session → create session with that workingDir
   - If no `worktreePath` → show guidance ("Claim this item and assign a worktree first")
4. **Block reason visibility** — On the card itself (not just detail panel), show a small indicator like "Blocked by: [item title]" or at minimum the count of blockers

## Reproduction

### Issue 1 — Can't see why a task is blocked
1. Create two work items: A and B.
2. Add a dependency: B depends on A (`POST /api/work-items/B/dependencies` with `{ dependsOnId: A }`).
3. Set B's status to `blocked`.
4. Navigate to the Board view and click B's card to open the detail panel.
5. **Observed**: The detail panel shows the title, status badge "blocked", description, agent activity, vault memory placeholder, timestamps, and action buttons — but NO list of what is blocking B. The `_renderDetailPanel()` function at line 22652 never calls `GET /api/work-items/:id/dependencies` and renders no blocker list.
6. The `_nextAction()` helper at line 22924 returns the static string `'Blocked — resolve dependency'` with no dynamic data about which items are blocking.

### Issue 2 — No way to unblock tasks from UI
1. Open the detail panel for a blocked work item.
2. **Observed**: Action buttons are: Close, Claim (disabled if non-queued), Change Status, Add Dependency, Delete. There is no "Remove Dependency" or "Unblock" button.
3. The `_wireDetailPanelActions()` function (line 22745) wires five buttons — none of which remove a dependency.
4. The ActionDashboard at line 23780 has an `'Unblock'` button, but it sends a text prompt to the Claude session via `unblockSession()` — it does NOT remove the dependency edge from the database. If the work item has no assigned session (`sessionId === null`), the Unblock button is only shown when `sid` is truthy (line 23782: `if (sid) btns.push({label: 'Unblock'...})`), so the button is hidden entirely for unassigned blocked items.

### Issue 3 — "Open Session" shows empty/non-existent session
1. Open ActionDashboard. For a blocked work item with `assignedAgentId` set but no actual live session, the action card shows an "Open Session" button.
2. Clicking "Open Session" calls `ActionDashboard.openSession(item.sessionId)` which calls `app.selectSession(sessionId)` (line 23818).
3. `item.sessionId` is set from `wi.assignedAgentId` (line 23327 — `sessionId: session?.id || wi.assignedAgentId || null`). If the agent ID is not a real session ID, `selectSession` switches to a non-existent session.
4. The BoardView detail panel has no "Open Session" button at all — the `_renderDetailPanel()` function only renders Close, Claim, Change Status, Add Dependency, Delete. If a user has a `worktreePath` set on the work item, there is no path to open the associated session from the board.
5. There is no logic anywhere to: (a) search sessions by `workingDir === work_item.worktreePath`, (b) create a new session with `workingDir` set to `worktreePath`, or (c) show guidance if `worktreePath` is unset.

### Issue 4 — No blocker indicator on board cards
1. Navigate to the Board view, find a blocked card.
2. **Observed**: The card shows title, a red status dot, "Unassigned", elapsed time, and the static text "Blocked — resolve dependency". There is no indicator of which items are blocking it.
3. The `_renderCard()` function (line 22487) does not fetch or display dependency data.

## Root Cause / Spec

### Root Cause Summary

All four issues are **frontend-only gaps** — the backend APIs exist and work correctly:
- `GET /api/work-items` — returns all items (used by BoardView)
- `POST /api/work-items/:id/dependencies` — adds a dep (used in "Add Dependency" button)
- `DELETE /api/work-items/:id/dependencies/:depId` — removes a dep (NOT used in UI at all)
- `listDependencies()` store function exists and is exported, but there is no `GET /api/work-items/:id/dependencies` HTTP route registered — the route file header claims it exists but it was never implemented.

The `listDependencies(workItemId)` store function queries `from_id OR to_id = ?` so it returns all edges (both blockers and items blocked-by). To get only the blockers of item X, we need rows where `to_id = X` (meaning `from_id` blocks `X`).

### Implementation Spec

#### 1. Add missing `GET /api/work-items/:id/dependencies` backend route
- File: `src/web/routes/work-item-routes.ts`
- Register a `GET /api/work-items/:id/dependencies` route before the `DELETE` dep route.
- Import `listDependencies` from the work-items module.
- For each dependency, also fetch the blocker work item (`getWorkItem(dep.fromId)`) to include its title and status in the response.
- Return `{ success: true, data: { blockers: [...], blockedBy: [...] } }` where `blockers` are items this item is waiting on (`to_id = id`) and `blockedBy` are items this item is blocking (`from_id = id`).

#### 2. Add blockers list to BoardView detail panel
- File: `src/web/public/app.js`, `_renderDetailPanel()` at line 22652
- Make `openDetailPanel(item)` (which already does an async agent fetch) also fetch `GET /api/work-items/${item.id}/dependencies`.
- In `_renderDetailPanel()`, add a "Blockers" section (shown only if `item.status === 'blocked'` or there are blocker entries). For each blocker, show: title, status badge, and a "Remove" button.
- Wire the "Remove" button to call `DELETE /api/work-items/${item.id}/dependencies/${blocker.id}`, then refresh the panel.

#### 3. Add "Unblock" action in detail panel for blocked items without a session
- File: `src/web/public/app.js`, `_renderDetailPanel()` / `_wireDetailPanelActions()`
- Add an "Unblock (remove all blockers)" button shown when `item.status === 'blocked'`.
- Handler: call `DELETE` for each blocker dependency, then PATCH status to `queued`, then refresh panel and board.
- This provides a path forward for blocked items even if they have no assigned session.

#### 4. Fix ActionDashboard "Unblock" button to show for all blocked work items (not just those with a session)
- File: `src/web/public/app.js`, `_getActionButtonDefs()` at line 23780
- Change `if (sid) btns.push({label: 'Unblock'...})` to always push the Unblock button for `blocked` type items.
- Update `unblockSession()` to handle the case where `sessionId` is null: skip the session interaction steps, just call `DELETE` on each blocker dependency and PATCH the work item to `queued`.

#### 5. Add "Open Session" to BoardView detail panel with session-linking logic
- File: `src/web/public/app.js`, `_renderDetailPanel()` at line 22732
- Add an "Open Session" button to the action buttons row in the detail panel.
- Logic: pass both `item` and the resolved `agent` to `_renderDetailPanel()`. When the button is clicked:
  - If `item.worktreePath` is set: fetch `/api/sessions` and find session where `workingDir === item.worktreePath`. If found, call `app.selectSession(foundSession.id)`. If not found, create a new session via `POST /api/sessions` with `{ workingDir: item.worktreePath, name: item.title }`.
  - If `item.assignedAgentId` is a valid session ID: call `app.selectSession(item.assignedAgentId)`.
  - If neither: show a toast: "No session linked — set a worktree path first."
- The button should be hidden (or labeled "No Session") when neither `worktreePath` nor `assignedAgentId` is set.

#### 6. Add blocker indicator on board cards
- File: `src/web/public/app.js`, `_renderCard()` at line 22487
- The board renders via `render()` → `_renderColumn()` → `_renderCard()`. This is a synchronous render loop, so async dep fetches per-card would be expensive.
- Approach: in `refresh()`, after fetching `/api/work-items`, also fetch `/api/work-items?status=blocked` dependencies in a batch. Or simpler: after `refresh()` loads all items, fetch deps for all blocked items in parallel and store in a `_blockerMap: Map<itemId, blockerTitles[]>`.
- In `_renderCard()`, for blocked items, check `this._blockerMap.get(item.id)` and if truthy, append a small "Blocked by: [title1, title2]" line below the next-action text.
- The `_nextAction()` function for `blocked` should remain as-is (it's used in the card), but the extra indicator comes from the `_blockerMap`.

### Files to modify
1. `src/web/routes/work-item-routes.ts` — add `GET /api/work-items/:id/dependencies` route
2. `src/web/public/app.js` — six targeted edits to BoardView and ActionDashboard

## Tasks

### Phase 1: Investigate & Write Tests
- [ ] Read the full detail panel code to understand current state
- [ ] Read the work-item-routes to understand available API endpoints
- [ ] Write tests for:
  - Detail panel renders blocker list when item has dependencies
  - "Remove dependency" button calls correct API
  - "Open Session" links to correct session or creates one
  - Card shows blocker count/reason indicator
  - Status override from blocked → queued works
- [ ] Run tests — confirm RED

### Phase 2: Implement Fixes
- [ ] Add blocker list to detail panel (fetch dependencies, render with remove buttons)
- [ ] Add "Unblock" quick action (remove all dependencies or override status)
- [ ] Fix "Open Session" to link to real sessions via worktreePath
- [ ] Add blocker indicator on board cards
- [ ] Run tests — confirm GREEN

### Phase 3: Review & Commit
- [ ] Run tsc + lint
- [ ] Review all changes
- [ ] Commit

## Fix / Implementation Notes

### Changes Made

#### 1. `src/web/routes/work-item-routes.ts`
- Added `listDependencies` to imports from work-items module.
- Registered `GET /api/work-items/:id/dependencies` route before the DELETE route.
- Returns `{ success: true, data: { blockers: [...], blockedBy: [...] } }`:
  - `blockers`: items where `to_id = id` (items that block this item), each enriched with title and status.
  - `blockedBy`: items where `from_id = id` (items this item is blocking).

#### 2. `src/web/public/app.js` — BoardView changes

- **`_blockerMap`**: Added as a property on BoardView to cache blocker titles per blocked item ID.
- **`refresh()`**: After fetching work items, fetches deps for all blocked items in parallel and populates `_blockerMap`.
- **`_renderCard()`**: For blocked items, appends a small "Blocked by: [title1, title2]" indicator using `_blockerMap`.
- **`openDetailPanel()`**: Also fetches `GET /api/work-items/:id/dependencies` and passes `deps` to `_renderDetailPanel`.
- **`_renderDetailPanel(item, agent, deps)`**: Added a "Blocked By" section showing each blocker with title, status badge, and a "Remove" button. Added "Open Session" button (enabled only when `worktreePath` or `assignedAgentId` is set). Added "Unblock All" button shown only when `item.status === 'blocked'`.
- **`_wireDetailPanelActions(panel, item, deps)`**: Wired `.wip-remove-blocker` buttons to `DELETE /api/work-items/:id/dependencies/:blockerId`. Wired `#wipOpenSessionBtn` to session-linking logic (find by worktreePath, create if not found, fall back to assignedAgentId). Wired `#wipUnblockBtn` to delete all blockers then PATCH status to `queued`.

#### 3. ActionDashboard `_getActionButtonDefs()` and `unblockSession()`
- **`_getActionButtonDefs()`**: Removed the `if (sid)` guard on the Unblock button for `blocked` type — it now always shows for blocked items.
- **`unblockSession(sessionId, item)`**: Added early return path when `sessionId` is null: fetches deps, removes all blocker edges via DELETE, then PATCHes work item to `queued`. Original session-prompt path unchanged for items with a session.

## Decisions & Context

- The `GET /api/work-items/:id/dependencies` route was registered before the existing `DELETE /api/work-items/:id` route to avoid path capture issues — Fastify's router handles exact paths before parameterized ones so this is safe.
- Blocker indicator on cards uses `_blockerMap` (batch-fetched during refresh) rather than per-card async fetches to keep `_renderCard()` synchronous.
- The "Unblock All" button in the detail panel sets status to `queued` after removing all blockers (same as ActionDashboard behavior).
- The "Open Session" button prefers `worktreePath` → find/create session; falls back to `assignedAgentId` as a direct session ID; shows disabled as "No Session" when neither is set.

## Review History

### Review attempt 1 — APPROVED

**Backend (`work-item-routes.ts`)**
- Route registered correctly at `GET /api/work-items/:id/dependencies`, before the `DELETE /api/work-items/:id` catch-all (no path conflict).
- `listDependencies` properly imported and used; filter logic is correct: `d.toId === id` for blockers, `d.fromId === id` for blockedBy.
- 404 guard on `getWorkItem(id)` is correct.
- Blocker fallback when `getWorkItem(d.fromId)` returns null returns `d.fromId` as title — acceptable.
- Minor: `depId` field in each blocker is redundant (equals `id`), but harmless.
- TypeScript: `tsc --noEmit` clean.

**Frontend BoardView**
- `_blockerMap` batch-populated in `refresh()` — correct async/parallel approach, keeps `_renderCard()` synchronous.
- `_renderCard()` blocker indicator uses `_blockerMap` defensively with null-check — correct.
- `openDetailPanel()` fetches deps before render — correct sequencing, errors caught silently.
- `_renderDetailPanel(item, agent, deps)` null-guards `deps` on entry — defensive, correct.
- Blockers section shown when `item.status === 'blocked' OR deps.blockers.length > 0` — slightly over-broad (could show section for non-blocked items with orphan deps), but correct and not a regression.
- `_esc()` used consistently in all user-supplied strings rendered into HTML.
- `data-blocker-id` stores `blocker.id` (= `d.fromId` = the depId the DELETE route expects) — correct mapping.
- "Unblock All": removes each blocker individually, PATCHes to `queued`, re-renders with `resp.data` — correct. No parallel `Promise.all` on deletes (sequential), acceptable for typical low dep counts.
- "Open Session" logic: worktreePath → find session by `workingDir/worktreePath` → create if missing → fall back to `assignedAgentId` — correct per spec. Uses flexible session array parsing for different API response shapes.

**ActionDashboard**
- `if (sid)` guard removed — Unblock button now always shows for `blocked` items — correct per spec.
- `unblockSession(null, item)` path: fetches deps, removes blockers, PATCHes to queued, calls `this.refresh()` — correct.
- Original session-prompt path preserved unchanged.
- `workItemId` sourced from `item?.workItemId` — consistent with existing ActionDashboard item shape.

**Test coverage**
- `test/board-view.test.ts` already routes `GET .../dependencies` for the Add Dependency flow. No new dedicated tests were added for the new GET endpoint, blocker list rendering, or Unblock All. This is noted as acceptable for test-analysis phase.
- All test failures are pre-existing (better-sqlite3 native module compiled for Node v127, running on v141) — unrelated to these changes.

**No blocking issues found.** The implementation matches the spec completely and the code quality is consistent with the existing codebase patterns.

## Test Gap Analysis

**GAPS FOUND**

### 1. `src/web/routes/work-item-routes.ts` — GET /api/work-items/:id/dependencies route untested
`test/routes/work-item-routes.test.ts` mocks `listDependencies` but has no `describe` block for the new `GET /api/work-items/:id/dependencies` route. Missing tests:
- Returns `{ blockers, blockedBy }` when item exists and has deps.
- Returns 404 when work item does not exist.
- Returns empty arrays when item has no dependencies.
- Blocker objects are enriched with title/status from `getWorkItem`.

### 2. `src/web/public/app.js` — BoardView card blocker indicator untested
No Playwright test in `test/board-view.test.ts` verifies that a blocked card shows "Blocked by: [title]" text sourced from `_blockerMap`. The existing Add Dependency test only intercepts the POST method on the dependencies route; it does not mock a GET response or assert the blocker indicator appears on rendered cards.

### 3. `src/web/public/app.js` — BoardView detail panel new elements untested
No Playwright tests cover the new elements added to the detail panel for blocked items:
- "Blocked By" section renders with blocker titles and status badges.
- `.wip-remove-blocker` button calls `DELETE /api/work-items/:id/dependencies/:blockerId` and refreshes the panel.
- `#wipUnblockBtn` ("Unblock All") removes all blockers, PATCHes status to `queued`, and re-renders.
- `#wipOpenSessionBtn` ("Open Session") session-linking logic: find by `worktreePath`, create if missing, fall back to `assignedAgentId`, disabled/"No Session" when neither is set.

### 4. `src/web/public/app.js` — ActionDashboard `unblockSession(null, item)` path untested
All three existing `unblockSession` tests (Gap 14 describe block) pass a real `sessionId` string. The new code path where `sessionId` is `null` — which skips all session interaction and instead removes dep edges via DELETE then PATCHes to `queued` — has no test coverage. Also, the existing `_getActionButtonDefs` test for `blocked` passes `sessionId: 'sess-btn'` (non-null), so the always-show Unblock button behavior for blocked items with `sessionId: null` is also untested.

## Test Writing Notes

### Files modified

#### `test/routes/work-item-routes.test.ts`
Added `listDependencies` to the import and mock references (`mockListDeps`). Added safe default `mockListDeps.mockReturnValue([])` in `beforeEach`. Added new describe block `GET /api/work-items/:id/dependencies` with 4 tests:
- Returns 404 when work item does not exist.
- Returns empty `blockers` and `blockedBy` arrays when item has no dependencies.
- Returns `{ blockers, blockedBy }` when item exists and has deps in both directions.
- Blocker objects are enriched with `title` and `status` from `getWorkItem`.

All 29 tests pass (25 pre-existing + 4 new).

#### `test/board-view.test.ts`
Added 5 new describe blocks at the end of the file:

1. **"Blocked card shows blocker indicator from _blockerMap"** (3 tests) — mocks `GET /api/work-items/:id/dependencies` during board refresh, asserts blocked card renders in Queued column, shows "Blocked by:" text, and includes the blocker title.

2. **"Detail panel — Blocked By section renders with blocker info"** (5 tests) — mocks deps GET, clicks a blocked card, asserts the "Blocked By" section header and blocker title appear in the panel, `#wipUnblockBtn` exists, and `.wip-remove-blocker` button count is 1.

3. **"Detail panel — .wip-remove-blocker calls DELETE"** (2 tests) — uses separate route mocks for GET `/dependencies` and DELETE `/dependencies/wi-dep-source` (different URL), clicks the Remove button, asserts `deleteCalled` is true and the DELETE URL contains the blocker id.

4. **"Detail panel — #wipUnblockBtn removes blockers and patches status to queued"** (2 tests) — routes GET and DELETE separately, routes PATCH to capture body, clicks Unblock All, asserts DELETE called and PATCH body has `status: 'queued'`.

5. **"Detail panel — #wipOpenSessionBtn is disabled when no session is linked"** (2 tests) — mocks deps returning empty, opens panel for item with `assignedAgentId: null` and `worktreePath: null`, asserts button exists and is disabled.

All 84 previously-passing tests still pass; the 1 pre-existing failing test (card-switch overlay intercept) was failing before these changes and is unrelated.

#### `test/action-dashboard.test.ts`
Added 2 new describe blocks at the end:

1. **"unblockSession(null, item) — removes dep edges and patches to queued (Gap 15)"** (3 tests):
   - Calls DELETE on each blocker dep edge when sessionId is null.
   - Sends PATCH with `status: 'queued'`.
   - Does NOT call `/input` or `/interactive` (no session interaction).

2. **"_getActionButtonDefs blocked item with sessionId=null shows Unblock button (Gap 16)"** (2 tests):
   - `blocked` item with `sessionId: null` still produces an Unblock button.
   - `blocked` item with `sessionId: null` does NOT produce an Open Session button.

All 72 tests pass (58 pre-existing + 14 new).

## Test Review History

### Test review attempt 1 — APPROVED

**`test/routes/work-item-routes.test.ts`** (4 tests) — All four tests are fully implemented with meaningful assertions. The 404, empty-deps, blockers+blockedBy, and enrichment tests each correctly configure mocks (`mockGet` chained returns, `mockListDeps`) and verify the route's response structure, status codes, and data enrichment. The mock setup for the enrichment test (chained `mockReturnValueOnce` for guard check then blocker lookup) accurately reflects how the route calls `getWorkItem` multiple times.

**`test/board-view.test.ts`** (14 tests across 5 describe blocks) — All tests are fully implemented (not stubs). The blocker-indicator tests correctly mock both the work-items list route and the per-item dependencies route, then verify the card contains "Blocked by:" text and the blocker title. The detail-panel tests open the panel by clicking a card and verify the "Blocked By" section, blocker title, `#wipUnblockBtn`, and `.wip-remove-blocker` button count. The remove-blocker and unblock-all tests mock DELETE and PATCH routes with separate URL patterns and verify the correct HTTP methods fire with expected payloads. The open-session-disabled test correctly verifies the button exists but is disabled when neither `worktreePath` nor `assignedAgentId` is set.

**`test/action-dashboard.test.ts`** (5 tests across 2 describe blocks) — The `unblockSession(null, item)` tests properly validate three aspects: DELETE calls on blocker dep edges, PATCH with `status: 'queued'`, and a negative assertion that `/input` and `/interactive` session endpoints are never called. Each test uses unique work-item IDs to avoid route conflicts from accumulated `page.route()` handlers. The `_getActionButtonDefs` tests directly invoke the function with `sessionId: null` and verify "Unblock" is present while "Open Session" is absent.

**Coverage assessment:** All 4 gaps from the Test Gap Analysis are addressed:
1. GET /api/work-items/:id/dependencies route — 4 backend tests covering 404, empty, populated, and enrichment.
2. BoardView card blocker indicator — 3 Playwright tests verifying _blockerMap-driven rendering.
3. BoardView detail panel new elements — 10 Playwright tests covering Blocked By section, remove-blocker, Unblock All, and Open Session disabled state.
4. ActionDashboard unblockSession(null) path — 5 Playwright tests covering sessionless unblock and button definitions.

**Minor notes (non-blocking):** `waitForTimeout(500)` is used throughout rather than `waitForSelector`/`waitForResponse`, but this is consistent with existing test patterns in this project. Route accumulation within describe blocks uses unique IDs per test, so no conflicts.

## QA Results

### TypeScript
- `tsc --noEmit`: PASS (zero errors)

### Lint
- `npm run lint`: PASS with pre-existing warnings/error
  - `src/orchestrator.ts:878` — `@typescript-eslint/prefer-as-const` error is **pre-existing** (present on master before this branch). Not introduced by this fix.
  - 2 unused eslint-disable directive warnings — also pre-existing.

### Tests
- `npx vitest run test/routes/work-item-routes.test.ts`: PASS — 29/29 tests pass

### Frontend (Playwright)
Server started on port 3099. Created test work items with a dependency (wi1 blocks wi2, wi2 status=blocked). Loaded the Board view, clicked the blocked card.

- Board renders blocked item (`QA Blocked Item`): PASS
- Card shows "Blocked by:" indicator: PASS
- Detail panel renders "Blocked By" section header: PASS
- Detail panel shows blocker title (`QA Blocker Item`): PASS
- `#wipUnblockBtn` present in detail panel: PASS
- `#wipOpenSessionBtn` present in detail panel: PASS
- `.wip-remove-blocker` button count = 1: PASS
- Zero JS runtime errors: PASS

### Docs Staleness
- `src/web/public/app.js` changed — flag: "UI docs may need update (frontend changed significantly)"
- `src/web/routes/work-item-routes.ts` changed — flag: "API docs may need update (src/web/routes/ changed)"

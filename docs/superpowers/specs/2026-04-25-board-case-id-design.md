# Board Work Item Creation — Case ID Assignment

**Date**: 2026-04-25
**Status**: Approved
**Scope**: Single-file change (app.js)

## Problem

Work items created from the Board UI via `openNewItemDialog()` never include a `caseId`. The orchestrator (orchestrator.ts:282-286) requires a non-null `caseId` to dispatch items, so UI-created items are permanently orphaned in the queue.

## Solution

Add a required "Case" `<select>` dropdown to the new-item dialog in `openNewItemDialog()` (app.js ~line 23919).

### Behavior

1. On dialog open, fetch available cases from `GET /api/cases`
2. Build a `<select>` populated with case names
3. Pre-select the currently active case from the toolbar (`localStorage.getItem('lastUsedCase')` or the toolbar's case selector value)
4. Include the selected value as `caseId` in the `POST /api/work-items` request body
5. No empty/none option — a case is required for the item to be dispatched

### Placement

The Case dropdown goes between the Title field and the Description textarea, matching the existing form layout style.

### Data

- Cases come from `GET /api/cases`, same endpoint the toolbar case selector uses
- `caseId` is the case directory name (string), not a numeric ID
- The REST API already accepts `caseId` — no backend changes needed

## Files Changed

| File | Change |
|------|--------|
| `src/web/public/app.js` | Add case `<select>` to `openNewItemDialog()`, include `caseId` in POST body |

## Out of Scope

- Backend changes (API already supports `caseId`)
- External integration flows (Clockwork, Asana, etc. set `caseId` via API directly)
- Board filtering by case (separate concern)

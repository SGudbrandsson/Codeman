# Run Summary Feature - Implementation Plan

## Overview

The Run Summary feature provides users with a consolidated view of what happened in their session while they were away. It tracks significant events, issues, and statistics, presenting them in an easy-to-digest format.

## Data Structures

### RunSummaryEventType
```typescript
type RunSummaryEventType =
  | 'session_started'
  | 'session_stopped'
  | 'respawn_cycle_started'
  | 'respawn_cycle_completed'
  | 'respawn_state_change'
  | 'error'
  | 'warning'
  | 'token_milestone'
  | 'auto_compact'
  | 'auto_clear'
  | 'idle_detected'
  | 'working_detected'
  | 'ralph_completion'
  | 'ai_check_result'
  | 'hook_event'
  | 'state_stuck';
```

### RunSummaryEvent
```typescript
interface RunSummaryEvent {
  id: string;
  timestamp: number;
  type: RunSummaryEventType;
  severity: 'info' | 'warning' | 'error' | 'success';
  title: string;
  details?: string;
  metadata?: Record<string, unknown>;
}
```

### RunSummary
```typescript
interface RunSummary {
  sessionId: string;
  sessionName: string;
  startedAt: number;
  lastUpdatedAt: number;
  events: RunSummaryEvent[];
  stats: {
    totalRespawnCycles: number;
    totalTokensUsed: number;
    peakTokens: number;
    totalTimeActiveMs: number;
    totalTimeIdleMs: number;
    errorCount: number;
    warningCount: number;
    aiCheckCount: number;
    lastIdleAt: number | null;
    lastWorkingAt: number | null;
    stateTransitions: number;
  };
}
```

## Files to Create/Modify

### 1. `src/run-summary.ts` (NEW)
- `RunSummaryTracker` class
- Event tracking and aggregation
- Statistics calculation
- Max 1000 events per session (FIFO trimming)

### 2. `src/types.ts` (MODIFY)
- Add `RunSummaryEvent`, `RunSummaryEventType`, `RunSummary` interfaces
- Add `RunSummaryEventSeverity` type

### 3. `src/web/server.ts` (MODIFY)
- Create `RunSummaryTracker` per session
- Subscribe to session events and forward to tracker
- Subscribe to respawn controller events
- Add API endpoint: `GET /api/sessions/:id/run-summary`
- Broadcast `session:runSummaryUpdate` SSE event

### 4. `src/web/public/app.js` (MODIFY)
- Add "Run Summary" button to session header
- Create modal to display summary
- Handle `session:runSummaryUpdate` SSE event
- Timeline view for events
- Stats cards at top

### 5. `src/web/public/index.html` (MODIFY)
- Add modal HTML structure for run summary

### 6. `src/web/public/styles.css` (MODIFY)
- Styles for run summary modal and timeline

## Event Sources

| Event Type | Source | Trigger |
|------------|--------|---------|
| session_started | Session | `startInteractive()` / `startShell()` |
| session_stopped | Session | `stop()` |
| respawn_cycle_started | RespawnController | State → `sending_update` |
| respawn_cycle_completed | RespawnController | State → `watching` (after cycle) |
| respawn_state_change | RespawnController | Any state transition |
| error | Various | Errors caught in try/catch |
| warning | RunSummaryTracker | State stuck > 5min, high tokens |
| token_milestone | Session | Every 50k tokens |
| auto_compact | Session | `autoCompact` event |
| auto_clear | Session | `autoClear` event |
| idle_detected | Session | `idle` event |
| working_detected | Session | `working` event |
| ralph_completion | RalphTracker | `completionDetected` event |
| ai_check_result | RespawnController | AI check completes |
| hook_event | Server | `/api/hook-event` endpoint |
| state_stuck | RunSummaryTracker | Same state > 10min |

## API Endpoint

### GET /api/sessions/:id/run-summary
Returns the full run summary for a session.

Response:
```json
{
  "success": true,
  "summary": {
    "sessionId": "...",
    "sessionName": "...",
    "startedAt": 1234567890,
    "lastUpdatedAt": 1234567890,
    "events": [...],
    "stats": {...}
  }
}
```

## UI Design

### Summary Modal
- Header: Session name, duration, status indicator
- Stats Cards Row:
  - Respawn Cycles: count
  - Tokens Used: peak / current
  - Active Time: formatted duration
  - Issues: errors + warnings count
- Timeline:
  - Vertical timeline of events
  - Color-coded by severity (green=success, blue=info, yellow=warning, red=error)
  - Expandable details
  - Filter by event type
- Footer: "Close" button

## Implementation Steps

1. Add types to `types.ts`
2. Create `run-summary.ts` with RunSummaryTracker class
3. Integrate tracker with server.ts (create per session, wire events)
4. Add API endpoint
5. Add frontend modal and button
6. Test with live session

## Storage

Run summaries are kept in memory only (not persisted to disk) since:
- They're session-specific and regenerated on session start
- Persisting thousands of events would bloat state.json
- Server restart = fresh session anyway

If persistence is needed later, could add to `state-inner.json` with per-session limits.

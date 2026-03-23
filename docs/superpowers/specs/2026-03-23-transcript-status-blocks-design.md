# Design: Inline Task & Agent Status Blocks in Transcript View

**Date:** 2026-03-23
**Status:** Approved

---

## Overview

Add two live-updating status blocks to the transcript view that show the current state of background tasks and subagents while Claude is working. The blocks are pinned to the bottom of the transcript scroll area (not in the message stream, not attached to the input bar). They disappear when all work is complete, leaving a clean transcript history.

---

## User-Visible Behaviour

1. When `taskStats.running > 0`, a **Tasks block** appears pinned at the bottom of the transcript viewport. It lists each task with its status icon, name, and elapsed time. It live-updates as tasks progress and is removed when `taskStats.running === 0`.

2. When any subagent is active (not completed/idle), an **Agents block** appears pinned directly above or below the Tasks block. It lists each active agent by name and current activity string. It live-updates and is removed when all agents are completed or idle.

3. Each block appears and disappears independently — if tasks finish before agents, only the Agents block remains.

4. Both blocks are read-only. No tapping, no expansion, no interaction.

5. A soft gradient (`transparent → background`) fades the bottom of the message stream behind the blocks so messages don't hard-clip against the block edges.

6. The blocks sit inside the transcript scroll container with `position: sticky` or `position: absolute; bottom: 0` — new messages scroll above them, the blocks stay put.

---

## Visual Design

### Tasks block
- Border: `1px solid #0e4a6e` (cyan-dark)
- Background: `#051927` with slight transparency
- Header: `▣ TASKS` in `#38bdf8` (cyan), right-aligned summary e.g. `2 running · 1 done` in muted grey
- Each task row: status icon + name + elapsed time
  - Running: amber `●` icon, normal text, `Xs…` timer
  - Completed: green `✓` icon, struck-through text, final duration
  - Failed: red `✗` icon, struck-through text

### Agents block
- Border: `1px solid #3b1d6e` (purple-dark)
- Background: `#0e0520` with slight transparency
- Header: `⬡ AGENTS` in `#a78bfa` (purple), right-aligned count
- Each agent row: `⬡` icon + agent name + current activity string (last tool call summary)

### Gradient overlay
- Applied to a wrapper div behind the blocks: `background: linear-gradient(transparent, <bg-color> 28%)`
- Ensures messages fade cleanly behind the blocks rather than hard-stopping

---

## Implementation Approach

**DOM injection (not transcript block pipeline).** The two blocks are plain `<div>` elements injected directly into the TranscriptView scroll container — they are not part of the JSONL block stream. This avoids modifying the append-only transcript pipeline.

### Files to change
- `src/web/public/app.js` — all logic
- `src/web/public/styles.css` — block styles

### Data sources
Both are already available in the existing session object received via SSE:
- `session.taskTree` / `session.taskStats` — task data
- `app.subagents` Map — agent data (keyed by agentId, contains `status`, `activity` array)

### Trigger
The existing `SESSION_UPDATED` SSE event already fires whenever `taskTree` changes. Subagent changes fire `SUBAGENT_UPDATED`/`SUBAGENT_COMPLETED` events. Both are already handled in `app.js`. The new rendering function hooks into these existing handlers.

### Rendering logic (`renderTranscriptStatusBlocks`)

```
function renderTranscriptStatusBlocks(sessionId):
  if sessionId !== TranscriptView._sessionId: return  // only for visible session

  container = TranscriptView scroll container element
  session = app.sessions.get(sessionId)

  // --- TASK BLOCK ---
  taskStats = session.taskStats || {}
  if taskStats.running > 0:
    inject/update #tv-live-tasks block in container
    render task rows from session.taskTree (running first, then completed)
  else:
    remove #tv-live-tasks if present

  // --- AGENT BLOCK ---
  activeAgents = [...app.subagents.values()]
    .filter(a => a.parentSessionId === sessionId && a.status !== 'completed')
  if activeAgents.length > 0:
    inject/update #tv-live-agents block in container
    render agent rows (name + last activity string)
  else:
    remove #tv-live-agents if present
```

### DOM structure

```html
<!-- injected into .tv-scroll-container, position:sticky bottom:0 -->
<div id="tv-live-status-wrapper">
  <div class="tv-live-gradient"></div>          <!-- fade overlay -->
  <div id="tv-live-tasks" class="tv-live-block tv-live-block--tasks">
    <div class="tv-live-header">▣ TASKS <span>2 running · 1 done</span></div>
    <div class="tv-live-rows">
      <div class="tv-live-row tv-live-row--running">● Write auth middleware <span>14s…</span></div>
      <div class="tv-live-row tv-live-row--done">✓ Setup DB schema <span>4.2s</span></div>
    </div>
  </div>
  <div id="tv-live-agents" class="tv-live-block tv-live-block--agents">
    <div class="tv-live-header">⬡ AGENTS <span>2 active</span></div>
    <div class="tv-live-rows">
      <div class="tv-live-row">⬡ code-writer <span>reading files…</span></div>
    </div>
  </div>
</div>
```

### CSS approach
**Primary:** The wrapper uses `position: sticky; bottom: 0` within the transcript scroll container so it sticks to the bottom as the user scrolls. Padding is added to the scroll container equal to the wrapper's height so the last message isn't permanently hidden behind the blocks.

**Fallback (if sticky misbehaves):** Inject the wrapper outside the scroll flow as `position: absolute; bottom: 0` on the transcript container (which already has `position: relative`), and add equivalent bottom padding to the scroll container.

### Elapsed time
Task rows show elapsed time. `session.taskTree` entries already carry `startTime` (ms epoch) and `endTime` (ms epoch or null). For running tasks, compute elapsed client-side as `((Date.now() - task.startTime) / 1000).toFixed(0) + 's…'`. For completed tasks use `((task.endTime - task.startTime) / 1000).toFixed(1) + 's'`. Update running timers via a `setInterval` (1 s) that re-renders only the elapsed-time spans, or re-render the whole block on each SESSION_UPDATED tick (simpler, acceptable given low frequency).

### Agent row ordering
Agents are rendered in Map insertion order (the order they were first seen via SSE). No sorting required.

---

## Edge Cases

- **Session switch:** On session switch, remove both blocks immediately (they belong to the previous session).
- **TranscriptView hidden:** Skip rendering when `TranscriptView._sessionId` doesn't match the updated session.
- **Zero tasks, zero agents:** Both blocks absent — no wrapper element injected at all.
- **Task tree with only completed tasks:** `taskStats.running === 0` → task block removed immediately.
- **Agent with no activity string:** Show agent name only, no activity suffix.

---

## What Is Not In Scope

- Interactivity (tap to expand, tap to open subagent panel) — deferred
- Collapsing/minimising blocks — deferred
- Showing completed agents after they finish — blocks disappear on completion
- Mobile-specific layout changes — blocks use the same CSS as desktop

---

## Acceptance Criteria

1. Tasks block appears when `taskStats.running > 0` for the visible session.
2. Tasks block updates live as tasks complete (running → done).
3. Tasks block disappears when `taskStats.running === 0`.
4. Agents block appears when any subagent belonging to the visible session is active.
5. Agents block updates live as agents change activity.
6. Agents block disappears when all agents are completed/idle.
7. Both blocks are pinned to the bottom of the transcript scroll area; new messages appear above them.
8. Switching sessions clears both blocks immediately.
9. No visual regressions in the existing transcript rendering.

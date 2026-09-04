---
'aicodeman': minor
---

Sessions can now be paused and resumed from the gear menu. Pausing kills the
Claude process and its tmux session — freeing the memory and CPU a parked
session was holding — while keeping the session entry, name, worktree, working
directory, settings, terminal buffer and `claudeResumeId`. Resuming relaunches
Claude with `--resume`, so the conversation continues exactly where it left off.
Paused sessions are dimmed and carry a pause badge in both the desktop tab strip
and the mobile session drawer, they survive a Codeman server restart without
being auto-started, and they are excluded from respawn, Ralph, orchestrator
stall handling and dead-pane recovery. Typing into a paused session resumes it
automatically; pausing while Claude is mid-turn asks for confirmation first.

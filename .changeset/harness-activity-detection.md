---
'aicodeman': minor
---

Codex and Pi sessions now report accurate busy/idle status. Pi sessions no longer stay busy
forever after a turn, and codex sessions show busy while working. Codex status comes from its
rollout's own turn records (`task_started`, `task_complete`, `turn_aborted`). Pi status comes
from a small Codeman pi extension, loaded with `-e`, that posts token-authenticated, ordered
`harness_activity` events to `/api/hook-event`. Idle events now distinguish a completed turn
from lost tracking (`stale`), and a stale idle never counts as a completed run. The pi
extension also reports pi's session file, so a new pi session's transcript streams live from
its first turn and follows `/new` and `/resume`. Transcript streams carry a `transcriptId`
(SSE and the `X-Transcript-Id` header) so the web view never mixes blocks from two files.
Existing pi sessions pick up the extension only when restarted. Auto-compact-and-continue is
now Claude-only and cannot be enabled for other harnesses.

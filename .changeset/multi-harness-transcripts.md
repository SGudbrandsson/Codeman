---
'aicodeman': minor
---

The web transcript view now works for Codex and Pi sessions, not just Claude Code. The
harness capability `claudeTranscript` is split in two: a new `transcript` flag ("this
harness has a viewable transcript", true for claude, codex and pi) drives the transcript
view and its toggle, while `claudeTranscript` keeps meaning "speaks Claude's JSONL,
`--resume`, hooks and state machine" — so codex and pi still get no Respawn or Ralph tab.
Each harness has a transcript adapter (`src/harnesses/transcripts/`) that locates its file
(`$CODEX_HOME/sessions/**/rollout-*-<id>.jsonl`, `~/.pi/agent/sessions/--<cwd>--/*_<id>.jsonl`)
with root-containment checks, and maps its records onto the existing block types. A new
`thinking` block type carries Pi's plaintext reasoning and renders dimmed and collapsed;
Codex reasoning is encrypted at source and is never shown. Every transcript block now
carries a `seq` (line byte offset × 1000 + index), and the client dedups on it, which also
fixes sibling Claude blocks sharing a timestamp being dropped by periodic recovery.
`GET /api/sessions/:id/transcript?tail=N` now reads a bounded window from the end of the
file instead of the whole file; `X-Total-Blocks` is exact once the window reaches the start
of the file and an over-estimate otherwise. Codex and Pi sessions with no transcript file
yet (neither writes one before the first submitted turn) show "No transcript yet".

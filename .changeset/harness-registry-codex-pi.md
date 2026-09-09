---
'aicodeman': minor
---

Codex and Pi join Claude Code, OpenCode and plain shell as session harnesses, selectable
from the welcome screen, the run-mode menu, the New Session modal and the worktree creator
(`npm i -g @openai/codex`, `npm i -g @earendil-works/pi-coding-agent`). Each accepts an
optional model via `codexConfig` / `piConfig`, and a codex session that has taken its first
turn is restored after a restart with `codex resume <id>`, the way Claude sessions restore
with `--resume`. Behind them is a capability registry (`src/harnesses/`): every harness
declares whether it supports pause, respawn, Ralph, the Claude transcript, the Claude
parsers, Claude hooks and Claude model defaults, and every route, guard and UI element now
reads those flags instead of branching on a mode string. `GET /api/harnesses` and
`GET /api/harness/:id/status` report what is installed; `GET /api/opencode/status` keeps
working as an alias. Refusals now name the harness you are running ("Shell sessions cannot
be paused") instead of always blaming OpenCode, and `codeman list` badges non-Claude
sessions `[sh]` / `[oc]` / `[cx]` / `[pi]`. One deliberate behaviour change: shell sessions
no longer get a Ralph tracker, a respawn controller, the Claude transcript wiring or the
Claude output parsers, and can no longer be paused — they were only ever getting those
because the old guards read "not opencode" rather than "is claude". A pre-existing command-injection hole
in session spawning is also closed: arguments interpolated into a spawned harness command
are now POSIX single-quoted rather than passed through `JSON.stringify` (which left
`$(...)`, backticks and backslashes live), and both spawn sites hand tmux its arguments via
`execFile` instead of a shell-interpolated `execSync` string, so free-form worktree notes
are no longer evaluated by an outer `/bin/sh` at spawn time.

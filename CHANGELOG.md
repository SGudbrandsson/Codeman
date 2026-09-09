# aicodeman

## Unreleased

<!--
  Hand-written notes for the harness registry work. `changeset version` folds
  `.changeset/*.md` into a real version section above this block — delete this
  block at that point so the notes are not duplicated.
-->

### Added

- **Codex and Pi are now supported session harnesses**, alongside Claude Code, OpenCode and
  plain shell. Pick one from the welcome screen, the run-mode menu, the New Session modal
  or the worktree creator. Install them with `npm i -g @openai/codex` and
  `npm i -g @earendil-works/pi-coding-agent`. Each takes an optional model
  (`codexConfig` / `piConfig` on `POST /api/sessions` and `POST /api/quick-start`).
- **`GET /api/harnesses`** — every registered harness with its label, short label, install
  hint, availability and capability flags.
- **`GET /api/harness/:id/status`** — `{ available, path }` for one harness; 404 on an
  unknown id.
- **Capability-based harness registry** (`src/harnesses/`). Each harness declares what it
  supports — pause, respawn, Ralph, Claude transcript, Claude parsers, Claude hooks, Claude
  model defaults — and every route, guard and UI element now reads those flags instead of
  branching on a mode string.
- **Codex conversation resume.** Once a codex session has had its first turn, Codeman learns
  its rollout id from `~/.codex/sessions` and restores the session with
  `codex resume <id>` after a restart, the same way Claude sessions restore with `--resume`.

### Changed

- **Shell sessions no longer receive Claude-only subsystems, and can no longer be paused.**
  They previously got a Ralph tracker, a restorable respawn controller, the Claude transcript
  wiring and the Claude output parsers, because the old guards read "not opencode" rather
  than "is claude". This is a deliberate correction, and the one user-visible behaviour
  change in this release.
- Capability refusals now name the harness you are actually running. Pausing a shell session
  answers "Shell sessions cannot be paused", and the Ralph and respawn endpoints no longer
  tell a shell, codex or pi session that it is an OpenCode session.
- `codeman list` badges every non-Claude session: `[sh]`, `[oc]`, `[cx]`, `[pi]`. Shell
  sessions previously rendered `[shell]`; the others had no badge at all.
- `GET /api/opencode/status` is unchanged and still works — it is now a registry-backed
  alias of `GET /api/harness/opencode/status`, with the same `{ available, path }` response.

### Fixed

- **Closed a command-injection hole in session spawning.** Free-form user text — notably the
  worktree notes that reach a harness command as `extraArgs` — was interpolated into the
  spawned command line with `JSON.stringify`, which leaves `$(...)`, backticks and
  backslashes live inside double quotes. It was then executed *twice*: once by the outer
  `/bin/sh` that `execSync` uses to run `tmux respawn-pane ... bash -c "<cmd>"`, and once by
  bash inside the pane. A note containing `$(` or a backtick ran at spawn time. Both layers
  are fixed: every interpolated argument is now POSIX single-quoted, and both spawn sites
  invoke tmux through the argv form (`execFile`), so there is no outer shell at all.
  Pre-existing behaviour, not a regression introduced here.

### Known limitations

- Codex session-id discovery watches `~/.codex/sessions` recursively, which costs roughly
  550 inotify watch descriptors per active codex session on Linux. Many concurrent codex
  sessions can approach `fs.inotify.max_user_watches` (65536 by default, shared with every
  other watcher on the machine).

## 0.6.4

### Patch Changes

- Fix merge endpoint to warn on uncommitted worktree changes; add merge & close workflow to skill and CLAUDE.md

## 0.6.3

### Patch Changes

- Fix context pill to use Claude's reported status line percentage instead of accumulated token math

## 0.6.2

### Patch Changes

- Fix context pill percentage to include cache tokens in context window usage total

## 0.6.1

### Patch Changes

- Fix desktop hamburger menu, mobile drawer popup, run-mode dropdown z-index, context pill on desktop, and scope slash commands to session working directory

## 0.6.0

### Minor Changes

- Add git worktree support: spawn isolated Claude sessions on parallel branches from the + button, with branch badge, dormant worktree persistence, and cleanup modal (remove/keep/merge).

## 0.5.4

### Patch Changes

- Redesign mobile compose panel with auto-growing textarea, inset + and send buttons, multi-image thumbnail support, slash command popup, and pencil icon replacing lock

## 0.5.3

### Patch Changes

- Add Tab button and image picker to mobile UI; fix compose panel positioning and send behavior

## 0.5.2

### Patch Changes

- Mobile layout fixes: Android keyboard resize detection, correct bottom padding (124px + safeAreaBottom), hamburger moved to desktop header and mobile accessory bar, tab-switch keyboard preservation, terminal flash fix on tab switch

## 0.5.1

### Patch Changes

- Reduce terminal scrollback from 5000 to 500 lines; remove redundant keyboard-visible padding that caused last lines to be hidden off-screen

## 0.5.0

### Minor Changes

- Mobile UX overhaul: fix terminal scroll animation on session switch, add persistent GSD status line strip, add session navigation hamburger drawer, fix Android keyboard layout jump, add persistent input panel toggle, and add dynamic plugin/GSD command discovery in the Commands drawer

## 0.4.1

### Patch Changes

- Fix stale brotli-compressed assets causing outdated UI over Tailscale/HTTPS
  - Build script now removes stale `.br` files when brotli is unavailable, preventing
    browsers that prefer brotli (Chrome) from receiving outdated compressed assets
  - Ctrl+Shift+V paste now falls back to a dialog when clipboard API access is denied
    (e.g. after a tab freeze/recovery) instead of showing an error toast
  - Updated Cloudflare tunnel service to use correct `http://localhost:3001` URL

## 0.4.0

### Minor Changes

- feat: 8 UX improvements — configurable mobile hotbar, newline insertion (Shift+Enter + hotbar ↵ button), Ctrl+Shift+B voice input, Ctrl+Shift+V clipboard paste, Ctrl+X copy selection, mobile Copy hotbar button, keyboard shortcuts tab in Settings, and Close-on-Clean-Exit toggle (auto-removes session tab when process exits with code 0)

## 0.3.8

### Patch Changes

- Add tunnel status indicator with control panel — green pulsing dot in header when Cloudflare tunnel is active, dropdown with URL, remote clients, auth sessions, and start/stop/QR/revoke controls

## 0.3.7

### Patch Changes

- Operation Lightspeed: 5 parallel performance optimizations — multi-layer backpressure to prevent terminal write freezes, TERMINAL_TAIL_SIZE constant with client-drop recovery, tab switching SSE gating, and local echo improvements
- Codebase cleanup: remove dead code (unused token validation exports, PlanPhase alias), add execPattern() regex helper to eliminate repetitive .lastIndex resets, centralize 11 magic number constants into config files, fix CLAUDE.md inaccuracies, and add 316 new tests for utilities, respawn helpers, and system-routes

## 0.3.6

### Patch Changes

- Re-enable WebGL renderer with 48KB/frame flush cap protection against GPU stalls

## 0.3.5

### Patch Changes

- Fix Chrome "page unresponsive" crashes caused by xterm.js WebGL renderer GPU stalls during heavy terminal output. Disable WebGL by default (canvas renderer used instead), gate SSE terminal writes during tab switches, and add crash diagnostics with server-side breadcrumb collection.

## 0.3.4

### Patch Changes

- Fix Chrome tab freeze from flicker filter buffer accumulation during active sessions, and fix shell mode feedback delay by excluding shell sessions from cursor-up filter

## 0.3.3

### Patch Changes

- fix: eliminate WebGL re-render flicker during tab switch by keeping renderer active instead of toggling it off/on around large buffer writes

## 0.3.2

### Patch Changes

- Make file browser panel draggable by its header

## 0.3.1

### Patch Changes

- LLM context optimization and performance improvements: compress CLAUDE.md 21%, MEMORY.md 61%; SSE broadcast early return, cached tunnel state, cache invalidation fix, ralph todo cleanup timer; frontend SSE listener leak fix, short ID caching, subagent window handle cleanup; 100% @fileoverview coverage

## 0.3.0

### Minor Changes

- QR code authentication for tunnel access, 7-phase codebase refactor (route extraction, type domain modules, frontend module split, config consolidation, managed timers, test infrastructure), overlay rendering fixes, and security hardening

## 0.2.9

### Patch Changes

- System-level performance optimizations (Phase 4): stream parent transcripts instead of full reads, consolidate subagent file watchers from 500 to ~50 using directory-level inotify, incremental state persistence with per-session JSON caching, and replace team watcher polling with chokidar fs events

## 0.2.8

### Patch Changes

- Remove 159 lines of dead code: unused interfaces, functions, config constants, legacy no-op timer, and stale barrel re-exports

## 0.2.7

### Patch Changes

- Fix race condition in StateStore where dirty flag was overwritten after async write, silently discarding mutations
- Fix PlanOrchestrator session leak by adding session.stop() in finally blocks and centralizing cleanup
- Fix symlink path traversal in file-content and file-raw endpoints by adding realpathSync validation
- Fix PTY exit handler to clean up sessionListenerRefs, transcriptWatchers, runSummaryTrackers, and terminal batching state
- Fix sendInput() fire-and-forget by propagating runPrompt errors to task queue via taskError event
- Fix Ralph Loop tick() race condition by running checkTimeouts/assignTasks sequentially with per-iteration error handling
- Fix shell injection in hook scripts by piping HOOK_DATA via printf to curl stdin instead of inline embedding
- Narrow tail-file allowlist to remove ~/.cache and ~/.local/share paths that exposed credentials
- Fix stored XSS in quick-start dropdown by escaping case names with escapeHtml()

## 0.2.6

### Patch Changes

- Disable tunnel auto-start on boot; tunnel now only starts when user clicks the UI toggle

## 0.2.5

### Patch Changes

- Fix 3 minor memory leaks: clear respawn timers in stop(), clean up persistDebounceTimers on session cleanup, reset \_parentNameCache on SSE reconnect

## 0.2.4

### Patch Changes

- Fix tunnel button not working: settings PUT was rejected by strict Zod validation when sending full settings blob; now sends only `{tunnelEnabled}`. Added polling fallback for tunnel status in case SSE events are missed.

## 0.2.3

### Patch Changes

- Fix tunnel button stuck on "Connecting..." when tunnel is already running on the server

## 0.2.2

### Patch Changes

- Update CLAUDE.md app.js line count references

## 0.2.1

### Patch Changes

- Integrate @changesets/cli for automated releases with changelogs, GitHub Releases, and npm publishing

## 0.2.0

### Minor Changes

- Initial public release with changesets-based versioning

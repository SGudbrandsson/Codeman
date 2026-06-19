# Codeman — Developer Guide

## Project Overview
- **Name**: Codeman (npm: `aicodeman`)
- **Description**: Control plane for AI coding agents — real-time monitoring, multi-session dashboard, mobile-first UI
- **Tech Stack**: TypeScript backend (Fastify 5), vanilla JS/CSS frontend, tmux for session muxing
- **Repo**: Fork at `maupet/Codeman`, upstream at `SGudbrandsson/Codeman`
- **Version**: 0.6.6

## Commands

```bash
npm run build         # Build everything (TS + frontend assets) → dist/
npm run dev           # Dev mode with tsx (live reload)
npm start             # Run built app: node dist/index.js
npm run web           # Run web server: node dist/index.js web
npm test              # Run tests (vitest)
npm run test:watch    # Tests in watch mode
npm run typecheck     # TypeScript type checking (tsc --noEmit)
npm run lint          # ESLint on src/**/*.ts
npm run lint:fix      # ESLint with auto-fix
npm run format:check  # Prettier check
npm run format        # Prettier write
```

### Running a dev instance

Codeman production runs on port 3000 via systemd (`codeman.service`) — it hosts every Claude Code session on this server, **including this one**. Never restart production to test dev changes.

The dev instance runs on port 3001 from the `codeman-dev` checkout:
```bash
node dist/index.js web --port 3001   # Dev instance — safe to restart
```

**Deploy to dev:** `npm run build && rsync -a --delete dist/ ~/.codeman/app/dist/` then restart the dev process (not systemd).
**Deploy to prod:** Only after testing on dev. `sudo systemctl restart codeman` picks up the new dist.

## Architecture

```
src/
├── index.ts              # Entry point
├── cli.ts                # CLI command definitions (commander)
├── web/
│   ├── server.ts         # Fastify web server
│   └── public/           # Frontend (vanilla JS/CSS, no framework)
│       ├── index.html    # Main HTML
│       ├── styles.css    # Desktop styles
│       ├── mobile.css    # Mobile/tablet styles (<1024px)
│       ├── app.js        # Main app logic
│       ├── keyboard-accessory.js  # Bottom bar / accessory buttons
│       ├── mobile-handlers.js     # Touch/mobile detection
│       └── ...
├── session-manager.ts    # Claude/OpenCode session lifecycle
├── orchestrator.ts       # Session health monitoring
├── respawn-controller.ts # Auto-respawn logic (Ralph loops)
├── mux-factory.ts        # tmux backend abstraction
├── vault/                # Session persistence / token tracking
├── config/               # App configuration
├── integrations/         # External service connectors
└── utils/                # Shared utilities
```

## Key Patterns

### Frontend
- **No framework** — vanilla JS with manual DOM manipulation
- **CSS breakpoints** in `mobile.css`:
  - `<430px` — phone
  - `430-768px` — tablet
  - `768-1023px` — large tablet
  - `>=1024px` — desktop (uses `styles.css` only)
- `mobile.css` only loads for `<1024px` screens; global styles outside `@media` blocks apply to all mobile/tablet sizes
- **Keyboard accessory bar** — bottom action bar, built programmatically in `keyboard-accessory.js`
- Build step minifies CSS and injects content hashes into `index.html`

### Backend
- Fastify 5 web server serving static files + WebSocket for real-time updates
- tmux sessions managed via `mux-factory.ts` / `mux-interface.ts`
- CLI uses `commander` with subcommands (`web`, `session`, etc.)
- Default web port: `3000` (configurable via `--port`)

## Testing
- **Framework**: Vitest
- **Run**: `npm test` (or `npm run test:watch` for dev)
- Test files co-located or in `__tests__/` directories

## Git Workflow
- Fork: `origin` → `maupet/Codeman` (GitHub)
- Upstream: `upstream` → `SGudbrandsson/Codeman` (GitHub)
- Branch naming: `fix/<description>`, `feat/<description>`
- PRs go from fork branches → upstream `master`
- Use `gh` CLI for GitHub operations (authenticated via `gh auth`)

### After pushing a PR
1. Merge the fix branch into local `master`: `git merge fix/<branch> --no-edit`
2. Rebuild: `npm run build`
3. Test on dev (port 3001) first — never deploy untested changes to prod
4. Update production: `rsync -a --delete dist/ ~/.codeman/app/dist/`
5. CSS/JS changes take effect on browser hard-refresh
6. Backend changes (orchestrator, server, etc.) need: `sudo systemctl restart codeman`
   - **Never** `kill` + `nohup` the production process — it's managed by systemd
   - **Never** restart prod to test — use the dev instance on port 3001

## Gotchas
- The upstream default branch is `master`, not `main`
- Build output goes to `dist/` — always rebuild after source changes
- CSS changes require `npm run build` then browser hard-refresh
- For quick CSS hotfixes to production: copy `dist/web/public/<file>.css` directly
- Orchestrator dispatch worktrees go to `~/.codeman/dispatch-worktrees/`, not `~/codeman-cases/`
- `sendInput()` on a Session calls `runPrompt()` which spawns a NEW process — for interactive sessions use `writeViaMux()` instead
- Local `master` may be ahead of `origin/master` with unmerged PR fixes — this is intentional

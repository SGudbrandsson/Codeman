# Container Isolation & Stability Plan

## Goal

Make Codeman more stable and robust by isolating dev sessions from each other and from the web server. Crashes in one session should not affect others. Each worktree should run in a clean environment with its own Node version, tools, and filesystem.

## Problem Statement

### Current architecture
- Single Fastify web server process — SPOF for all API and SSE connectivity
- All Claude sessions share the same machine resources (memory, CPU)
- An OOM or uncaught exception in any session can degrade or crash everything
- No environment isolation — all worktrees share the same Node version and global tools

### What already works
- tmux sessions survive web server crashes and auto-reconnect on restart
- Each Claude CLI process is independent — one crash doesn't kill others
- RespawnController auto-detects and cycles dead sessions
- The SPOF is the web server process itself, not the Claude processes

---

## Architecture Target

```
Codeman Web Server (Fastify)          ← thin control plane only
    ↓ Docker API (dockerode)
Container per worktree session        ← isolated environment
    ↓ docker exec --interactive --tty
Claude CLI (inside container)         ← runs against mounted worktree
    ↓ stdout/stderr streamed via Docker PTY attach
Codeman SSE → browser                 ← unchanged from user perspective
```

Key principle: the web server becomes a **thin orchestrator** — it manages container lifecycle and bridges PTY streams to SSE, but does not host Claude processes itself.

---

## Phases

### Phase 1: Separate web server stability from session crashes

**Problem:** A bad session (memory spike, uncaught exception in session code) can take down the Fastify process.

**Approach:** Move session PTY management into Node.js worker threads. Each session worker owns its PTY, tmux communication, transcript watching, and respawn logic. The main thread only does routing, SSE broadcast, and state coordination.

**Changes:**
- Extract `Session`, `RespawnController`, `TranscriptWatcher` into a `SessionWorker` (worker_threads)
- Main thread communicates with workers via `MessageChannel`
- Worker crash = that session's worker exits; main thread detects and restarts just that worker
- No Docker yet — this is a pure internal refactor

**Outcome:** A crashing session can no longer take down the web server or other sessions.

---

### Phase 2: Docker container per worktree session

**Problem:** No environment isolation — different projects need different Node versions, clean tool installs, separate `~/.claude` state.

**Approach:** Replace direct PTY spawning with Docker container lifecycle. Codeman uses the Docker daemon (via `dockerode`) to create, start, attach to, and destroy containers.

**Container model:**
- One container per active session
- Base image: configurable per worktree (default: `node:lts` or a Codeman-provided image)
- Mounts:
  - Worktree source directory → `/workspace` (read-write)
  - `~/.claude` per-session directory → `/root/.claude` (isolated Claude state)
  - `~/.codeman/sessions/{id}` → `/root/.codeman` (session metadata)
- Environment: `ANTHROPIC_API_KEY` injected, no other host env leaked
- Resource limits: configurable CPU shares + memory limit per container (default: 2 CPU, 4GB)

**PTY bridge:**
- Use `docker exec --interactive --tty` via dockerode's exec API
- Stream container stdout/stderr directly into the existing SSE terminal broadcast pipeline
- Send keystrokes via the exec stream's stdin
- Replaces `node-pty` + tmux for containerized sessions; tmux remains available inside containers for persistence

**Session lifecycle:**
```
POST /api/sessions → create container → attach PTY → stream to SSE
DELETE /api/sessions/:id → detach PTY → stop container → remove container
Server restart → containers survive (Docker daemon keeps them) → reattach on startup
```

**Changes:**
- Add `DockerSessionManager` alongside existing `TmuxManager`
- Session config gains `runtime: 'docker' | 'tmux'` (default remains `tmux` until stable)
- Codeman-provided base Docker image with Claude CLI pre-installed
- `restoreMuxSessions()` extended to also reattach to running containers on startup

**Outcome:** Full environment isolation per worktree. A container OOM is handled by Docker, not the Node process. Different projects can use different Node versions.

---

### Phase 3: Resource limits and observability

**Problem:** No per-session resource visibility or enforcement today.

**Approach:** Expose Docker container stats in the Codeman UI.

**Changes:**
- Poll `docker stats` (or use Docker events API) per active container
- Add per-session CPU%, memory usage, and memory limit to the existing stats endpoint (`/api/sessions/:id/stats`)
- UI: show container resource usage in session sidebar (similar to existing CPU display)
- Config: allow per-session and per-worktree resource limit overrides in session config
- Alert (SSE event) when a container approaches its memory limit so the user can act before OOM

**Outcome:** Visibility into what each session is consuming. Ability to cap a runaway session without it affecting others.

---

### Phase 4: Multi-machine / remote sessions (future)

**Note:** This is speculative — only worth doing if the single-machine model becomes a bottleneck.

With containers already as the session unit, remote execution becomes feasible:
- Docker contexts allow targeting remote Docker daemons
- A second machine running just the Docker daemon + Claude CLI image could host overflow sessions
- Codeman web server remains on the primary machine, proxying PTY streams from remote containers
- No orchestrator (Nomad, Kubernetes) needed for 1-2 machines; add one at 3+ machines

---

## What We're Not Doing

- **NanoClaw as orchestrator:** Filesystem-based IPC is incompatible with real-time PTY streaming. The container isolation idea is right; NanoClaw's specific IPC mechanism is not.
- **Kubernetes/Nomad now:** Operational overhead not justified for a single-machine personal dev tool. Revisit at Phase 4.
- **Replacing tmux entirely:** tmux inside containers gives persistence within a container session. Keep it as the inner layer; Docker is the outer isolation layer.

---

## Implementation Notes

### Key npm package
`dockerode` — Docker API client for Node.js. Supports container lifecycle, exec with PTY, streaming, and event subscription.

### Graceful degradation
Sessions should fall back to the existing tmux model if Docker is not available or not configured. The `runtime` flag on each session enables a gradual rollout.

### Base image
A minimal Codeman base image needs:
- Node.js (version pinned per project, or passed as build arg)
- Claude CLI (`npm install -g @anthropic-ai/claude-code`)
- Standard dev tools: git, curl, jq, ripgrep
- User `codeman` with UID matching host user (avoids file permission issues on mounts)

### File permission handling
Worktree files are owned by the host user. The container user UID must match. Pass `--user $(id -u):$(id -g)` or build the image with matching UID.

---

## Success Criteria

- A session that OOMs or crashes does not affect any other session or the web server
- Each worktree can specify its own Node version and have a clean tool environment
- Server restart reconnects to all running containers without losing session state
- Per-session resource usage is visible in the UI
- The existing tmux-based sessions continue to work as a fallback

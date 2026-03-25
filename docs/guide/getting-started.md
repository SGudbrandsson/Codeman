# Codeman — Getting Started Guide

From zero to a fully autonomous AI development workflow.

---

## What is Codeman?

Codeman is a web-based platform that wraps Claude Code (Anthropic's CLI) in a browser UI. It manages multiple Claude sessions, tracks work items on a kanban board, and can automatically assign tasks to AI agents that work in isolated git worktrees.

The key workflow: you create work items (tasks/bugs), the orchestrator assigns them to agents, agents work in worktrees autonomously, and you merge the results.

---

## 1. Installation

### Prerequisites

- **Node.js** 22+ (tested with 22 and 25)
- **Git** 2.30+
- **Claude Code CLI** installed and authenticated (`claude --version` should work)
- **tmux** (used for session management)
- **Linux** (tested on Ubuntu; macOS should work but is less tested)

### Install Codeman

```bash
# Clone the repo
git clone https://github.com/SGudbrandsson/Codeman.git
cd Codeman

# Install dependencies
npm install

# Build
npm run build

# Set up the app directory
mkdir -p ~/.codeman/app
cp -r dist ~/.codeman/app/
cp package.json ~/.codeman/app/package.json
cd ~/.codeman/app && npm install --production && cd -
```

### Run as a service (recommended)

Create a systemd user service for persistent operation:

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/codeman-web.service << 'EOF'
[Unit]
Description=Codeman Web Server
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.codeman/app
ExecStart=/usr/bin/node dist/index.js web --port 3001
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable codeman-web
systemctl --user start codeman-web
```

### Or run directly

```bash
cd ~/.codeman/app
node dist/index.js web --port 3001
```

### Verify

Open `http://localhost:3001` in your browser. You should see the Codeman UI.

---

## 2. Adding Your First Project

Codeman organizes work around **cases** (projects). A case is a pointer to a git repository on disk.

### Link a project

```bash
# Link an existing git repo as a case
curl -s -X POST http://localhost:3001/api/cases \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-project",
    "path": "/home/you/sources/my-project"
  }'
```

Or use the UI: click the project picker in the bottom bar, then "+" to add a new project.

### Create your first session

Click the "+" button in the sidebar or use the quick-start panel on the home screen. Select your project and a Claude session starts in the project directory.

You can now interact with Claude in the browser — type messages, attach files, see the terminal output. This is the basic usage.

---

## 3. Setting Up Agents

Agents are persistent AI profiles that specialize in different tasks. They're optional for manual use but required for automated orchestration.

### Create agents via the UI

1. Open the sidebar (hamburger menu)
2. Switch to the **Agents** tab
3. Click **+ New Agent**
4. Fill in:
   - **Role**: A short identifier like `dev`, `qa`, `devops`
   - **Display Name**: Human-readable name like "Feature Developer"
   - **Role Prompt**: Instructions for the agent, e.g., "You implement features and fix bugs. Always write tests alongside code."

### Create agents via API

```bash
curl -s -X POST http://localhost:3001/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "role": "dev",
    "displayName": "Feature Developer",
    "rolePrompt": "Implements features and fixes bugs. Always writes tests."
  }'
```

### Recommended agent setup

For a typical project, start with 1-2 agents:

| Agent | Role | Purpose |
|-------|------|---------|
| Feature Developer | `dev` | Implements features and fixes bugs |
| QA / Reviewer | `qa` | Reviews code, writes tests |

You can add more specialized agents later (devops, docs, security, etc.).

---

## 4. The Work Item Board

Work items are tasks tracked on a kanban board. They flow through statuses:

```
queued → assigned → in_progress → done
                                → cancelled
```

### Create work items manually

Via API:
```bash
curl -s -X POST http://localhost:3001/api/work-items \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Add dark mode toggle",
    "description": "Add a toggle in settings to switch between light and dark themes",
    "source": "manual"
  }'
```

Via the UI: click the Board button in the header, then "New Work Item".

### View the board

Click **Board** in the header to see the kanban view. Work items are organized by status columns.

---

## 5. Enabling Automated Orchestration

This is where Codeman becomes powerful. The orchestrator watches for queued work items, assigns them to the best available agent, creates isolated git worktrees, and runs the full task workflow autonomously.

### Enable orchestration for a case

```bash
curl -s -X POST http://localhost:3001/api/orchestrator/toggle \
  -H "Content-Type: application/json" \
  -d '{"caseId": "my-project", "enabled": true}'
```

### Check orchestrator status

```bash
curl -s http://localhost:3001/api/orchestrator/status | jq
```

You should see:
```json
{
  "mode": "hybrid",
  "activeCases": [],
  "activeDispatches": 0,
  "lastActionAt": null,
  "recentDecisions": []
}
```

### Configure the orchestrator (optional)

```bash
curl -s -X PATCH http://localhost:3001/api/orchestrator/config \
  -H "Content-Type: application/json" \
  -d '{
    "pollIntervalMs": 30000,
    "maxConcurrentDispatches": 5,
    "stallThresholdMs": 900000
  }'
```

| Setting | Default | Description |
|---------|---------|-------------|
| `pollIntervalMs` | 30000 (30s) | How often the orchestrator checks for new work |
| `maxConcurrentDispatches` | 5 | Max simultaneous worktrees running |
| `stallThresholdMs` | 900000 (15min) | Time before nudging a stuck session |
| `nudgeThresholdMs` | 1800000 (30min) | Time before marking a session as blocked |
| `mode` | `hybrid` | `hybrid` (mechanical + LLM) or `autonomous` |
| `matchingThreshold` | 3 | Score gap needed for a clear agent match |

---

## 6. The Automated Workflow

Once orchestration is enabled and agents are defined, here's the end-to-end flow:

### Step 1: Create a work item

```bash
curl -s -X POST http://localhost:3001/api/work-items \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix login timeout on slow connections",
    "description": "Users on slow connections get a timeout error during login. The timeout should be extended from 5s to 30s.",
    "source": "manual"
  }'
```

### Step 2: The orchestrator picks it up

Within 30 seconds (the poll interval), the orchestrator:
1. Sees the queued work item
2. Checks if its case has orchestration enabled
3. Selects the best agent (scoring by role keywords, capabilities, availability)
4. Claims the work item for that agent
5. Creates a git worktree from the project's main branch
6. Writes `TASK.md` and `CLAUDE.md` to the worktree
7. Starts a Claude session in the worktree

### Step 3: The agent works autonomously

The agent (Claude) reads `TASK.md`, invokes the `codeman-task-runner` skill, and runs through:
1. **Analysis** — understands the bug/feature
2. **Implementation** — writes the fix/feature
3. **Review** — self-reviews the code
4. **Testing** — writes and runs tests
5. **QA** — final quality check
6. **Commit** — commits the changes

### Step 4: You review and merge

When the task status reaches `done`:
- Check the worktree's work in the Codeman UI
- Merge using the skill or API:
  ```bash
  curl -s -X POST http://localhost:3001/api/sessions/ORIGIN_SESSION_ID/worktree/merge \
    -H "Content-Type: application/json" \
    -d '{"branch": "fix/login-timeout"}'
  ```
- Or ask Claude in your main session: "merge the worktree for fix/login-timeout"

### Step 5: Monitor

Watch the Board view to see work items move through statuses. The orchestrator also:
- **Nudges** stuck sessions after 15 minutes of inactivity
- **Recovers** assigned-but-not-started items after 5 minutes
- **Broadcasts** status changes via SSE so the UI updates in real-time

---

## 7. Using Codeman Skills (Claude Code Integration)

If you're using Claude Code with Codeman skills installed, you can do everything conversationally:

```
"create a worktree to fix the login timeout bug"
→ invokes codeman-fix skill, creates worktree, starts autonomous session

"merge the worktree for fix/login-timeout"
→ invokes codeman-merge-worktree skill, merges, deploys

"what worktrees are running?"
→ lists active worktree sessions
```

Skills available:
- `codeman-feature` — create a feature worktree
- `codeman-fix` — create a bug fix worktree
- `codeman-task-runner` — autonomous task execution inside worktrees
- `codeman-merge-prep` — pre-merge quality gate
- `codeman-merge-worktree` — merge and deploy

---

## 8. Deployment & Updates

### Updating Codeman

```bash
cd /path/to/Codeman
git pull
npm install
npm run build
cp -r dist ~/.codeman/app/
cp package.json ~/.codeman/app/package.json
systemctl --user restart codeman-web
```

### Accessing remotely

Codeman binds to `0.0.0.0` by default. For remote access:
- **Tailscale**: Access via your Tailscale IP (e.g., `http://100.x.x.x:3001`)
- **Cloudflare Tunnel**: Set up a tunnel to `localhost:3001`

### Backups

Codeman stores data in `~/.codeman/`:
- `state.json` — session state
- `work-items.db` — SQLite database for work items
- `vaults/` — agent memory vaults

A backup script is included:
```bash
# Run manually
./scripts/backup.sh

# Or set up daily cron
crontab -e
# Add: 0 3 * * * /path/to/Codeman/scripts/backup.sh
```

---

## Quick Reference

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/sessions` | List all sessions |
| `POST /api/sessions/:id/worktree` | Create a worktree |
| `POST /api/sessions/:id/worktree/merge` | Merge a worktree |
| `GET /api/work-items` | List work items |
| `POST /api/work-items` | Create a work item |
| `GET /api/agents` | List agents |
| `POST /api/agents` | Create an agent |
| `GET /api/orchestrator/status` | Orchestrator status |
| `POST /api/orchestrator/toggle` | Enable/disable orchestration per case |
| `PATCH /api/orchestrator/config` | Update orchestrator config |
| `POST /api/orchestrator/dispatch` | Manual dispatch trigger |

### Architecture

```
Browser UI (app.js)
    ↕ SSE + REST
Codeman Server (Node.js/Fastify, port 3001)
    ↕
tmux (session multiplexer)
    ↕
Claude Code CLI (per-session process)
    ↕
Git Worktrees (isolated branches per task)
```

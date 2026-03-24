# Agent Orchestration — 5-Minute Quickstart

Prerequisites: Codeman running on `http://localhost:3001`.

---

## The modern workflow

Codeman's skill-based workflow automates the full lifecycle: an agent picks up a
task, a work item is created and tracked on the board, and the board reflects each
phase as the autonomous task runner progresses. You invoke a single skill and watch
the board — no manual curl calls required for day-to-day work.

The five steps below cover the automated path. A [manual curl reference](#manual-workflow-curl) is included at the bottom for debugging or scripting.

---

## Step 1 — Create an agent

Agents are persistent profiles that claim work items and run tasks. Create one via
the UI or via curl.

**Via UI:** click **Agents** in the Codeman sidebar header, then click **+ New Agent**.
Fill in the role (`codeman-dev`), display name, and role prompt. Save.

**Via curl:**

```bash
curl -s -X POST http://localhost:3001/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "role": "codeman-dev",
    "displayName": "Feature Dev",
    "rolePrompt": "Implements features and fixes bugs. Always writes tests alongside code."
  }'
```

Save the returned `agentId` — you will link it to a session in the next step.

---

## Step 2 — Start a feature or fix

Invoke the `codeman-feature` skill (for new functionality) or the `codeman-fix`
skill (for bugs) in the session that is linked to your agent. The skills handle
everything automatically:

1. Creates a work item via `POST /api/work-items` with your title and description.
2. Claims the work item for the session's agent if one is configured.
3. Creates a git worktree and starts a new session running `codeman-task-runner`.
4. Links `worktreePath`, `branchName`, and `taskMdPath` to the work item so the
   board card shows the branch name.
5. Stores the work item ID in `TASK.md` as `work_item_id` for status tracking.

To invoke: in the Codeman session linked to your agent, type:
> "Implement a dark mode toggle for the settings panel"

or

> "Fix the hamburger menu being blocked by the overlay on mobile"

The skill will ask for any missing details and then proceed automatically.

---

## Step 3 — Watch progress on the board

Open `http://localhost:3001` in your browser and click **Board** in the header.

![Board showing work item in Working column](images/board-with-work-item.png)

The board columns map to task-runner phases:

| Board column | Work item status | Task-runner phase |
|-------------|-----------------|------------------|
| Queued | `queued` | Intake complete, not yet started |
| Working | `assigned` | Analysis running |
| Working | `in_progress` | Implementing / reviewing |
| Review | `review` | Test review phase |
| Done | `done` | Committed clean |

The card shows the branch name, the assigned agent, and the elapsed time.
Click any card to open the detail panel with all fields.

As `codeman-task-runner` advances through phases, it automatically PATCHes the
work item status — the board updates in real time via SSE with no page refresh.

---

## Step 4 — Merge when done

When the task runner finishes and outputs the testing instructions, verify the
feature manually, then invoke `codeman-merge-worktree`:

> "merge the worktree for feat/dark-mode-toggle"

The skill:
1. Runs the pre-merge safety check.
2. Merges the branch into master.
3. PATCHes the work item status to `done` (fires the Clockwork OS webhook if configured).
4. Deletes the worktree and session.
5. Rebuilds and deploys if this is the Codeman repo itself.

After the merge the card moves to the **Done** column.

---

## Manual workflow (curl)

The steps below show what the skills do under the hood. Use these for debugging,
scripting, or when you want manual control over a specific step.

### Create two agents

```bash
# Create the orchestrator
curl -s -X POST http://localhost:3001/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "role": "orchestrator",
    "displayName": "Main Orchestrator",
    "rolePrompt": "Coordinates tasks and monitors overall progress."
  }'
```

Example response — copy the `agentId`:

```json
{
  "success": true,
  "data": {
    "agentId": "f26ab3a0-f8fa-4961-87d7-4ea34cfaf30d",
    "role": "orchestrator",
    "displayName": "Main Orchestrator"
  }
}
```

```bash
# Create the developer agent
curl -s -X POST http://localhost:3001/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "role": "codeman-dev",
    "displayName": "Feature Dev",
    "rolePrompt": "Implements features and writes tests."
  }'
```

You now have two agents. In the Codeman sidebar, click **Agents** to see them
grouped by role.

### Create a work item

```bash
curl -s -X POST http://localhost:3001/api/work-items \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Add dark mode toggle",
    "description": "Implement a persistent dark/light mode toggle in the settings panel.",
    "source": "manual"
  }'
```

Example response — copy the `id`:

```json
{
  "success": true,
  "data": {
    "id": "wi-a1b2c3d4",
    "title": "Add dark mode toggle",
    "status": "queued"
  }
}
```

The item appears in the **Queued** column on the board.

### Claim the work item

Replace `<DEV_AGENT_ID>` and `<WORK_ITEM_ID>` with your actual values.

```bash
curl -s -X POST http://localhost:3001/api/work-items/<WORK_ITEM_ID>/claim \
  -H "Content-Type: application/json" \
  -d '{"agentId": "<DEV_AGENT_ID>"}'
```

The item status changes to `assigned` and moves to the **Working** column.

```bash
# Advance to in_progress
curl -s -X PATCH http://localhost:3001/api/work-items/<WORK_ITEM_ID> \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress"}'
```

### Send a message between agents

Replace `<ORCH_AGENT_ID>`, `<DEV_AGENT_ID>`, and `<WORK_ITEM_ID>` with your values.

```bash
curl -s -X POST http://localhost:3001/api/agents/<DEV_AGENT_ID>/messages \
  -H "Content-Type: application/json" \
  -d '{
    "fromAgentId": "<ORCH_AGENT_ID>",
    "type": "handoff",
    "subject": "Dark mode toggle — context and design notes",
    "body": "Use CSS custom properties (--color-bg, --color-fg). Store preference in localStorage key '\''theme'\''. Toggle button goes in #settingsPanel.",
    "workItemId": "<WORK_ITEM_ID>"
  }'
```

Check the developer agent's inbox:

```bash
curl -s "http://localhost:3001/api/agents/<DEV_AGENT_ID>/inbox?unreadOnly=true"
```

In the Codeman sidebar (**Agents** view), the developer agent row shows an unread
message badge. Click the row to expand the inline inbox panel.

---

## What to explore next

- **Memory vault** — capture session notes with `POST /api/agents/:id/vault/capture`
  and retrieve them later with `GET /api/agents/:id/vault/query?q=<text>`
- **Dependencies** — block a work item until another finishes with
  `POST /api/work-items/:id/dependencies`
- **Clockwork OS** — push items from an external orchestrator with
  `POST /api/clockwork/work-items` (requires `X-Clockwork-Token` header)
- **Broadcasting** — alert all agents with `POST /api/agents/broadcast`

See the full [Agent Orchestration User Guide](agent-orchestration.md) for complete
documentation of every feature.

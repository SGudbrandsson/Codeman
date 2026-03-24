# Agent Orchestration — 5-Minute Quickstart

This quickstart walks through the core agent orchestration workflow using only
`curl`. By the end you will have two agents, a work item claimed by one agent,
the item visible on the board, and a message sent between agents.

Prerequisites: Codeman running on `http://localhost:3001`.

---

## Step 1 — Create two agents

Create an orchestrator and a developer agent. Save the `agentId` values from the
responses — you will use them in the remaining steps.

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
    "displayName": "Main Orchestrator",
    ...
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

---

## Step 2 — Create a work item

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
    "status": "queued",
    ...
  }
}
```

The item appears in the **Queued** column on the board. Open the board by clicking
**Board** in the Codeman header.

---

## Step 3 — Claim the work item

Use the developer agent's ID and the work item ID from the previous steps.
Replace `<DEV_AGENT_ID>` and `<WORK_ITEM_ID>` with your actual values.

```bash
curl -s -X POST http://localhost:3001/api/work-items/<WORK_ITEM_ID>/claim \
  -H "Content-Type: application/json" \
  -d '{"agentId": "<DEV_AGENT_ID>"}'
```

The item status changes to `assigned` and the item moves to the **Working** column.

```bash
# Optionally advance to in_progress
curl -s -X PATCH http://localhost:3001/api/work-items/<WORK_ITEM_ID> \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress"}'
```

---

## Step 4 — View the board

Open `http://localhost:3001` in your browser and click **Board** in the header.
You will see:

- The work item card in the **Working** column
- The developer agent's name on the card
- An `in_progress` (green) status dot

Click the card to open the detail panel and see all fields.

---

## Step 5 — Send a message between agents

The orchestrator sends a handoff message to the developer linking to the work item.
Replace `<ORCH_AGENT_ID>`, `<DEV_AGENT_ID>`, and `<WORK_ITEM_ID>` with your actual
values.

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

# Codeman Messaging MCP Server

Lightweight MCP server that lets Claude agents list sessions and send messages to each other. Zero external dependencies.

## Tools

| Tool | Description |
|------|-------------|
| `list_sessions` | List active sessions (id, name, branch, status, workingDir). Optional `status` filter. |
| `send_message` | Send a message to another session by ID, name, or branch. |

## Install

### Claude Code (`~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "codeman": {
      "command": "node",
      "args": ["/home/YOU/.codeman/app/dist/mcp-server.js"],
      "env": {
        "CODEMAN_URL": "http://localhost:3001"
      }
    }
  }
}
```

### Per-session (Codeman UI)

Add via the MCP panel in any session, or select "Codeman Messaging" from the MCP library.

- **Command:** `node`
- **Args:** `dist/mcp-server.js` (relative to installed app dir)
- **Env:** `CODEMAN_URL=http://localhost:3001` (optional, this is the default)

### Cursor / other editors

```json
{
  "mcpServers": {
    "codeman": {
      "command": "node",
      "args": ["/home/YOU/.codeman/app/dist/mcp-server.js"]
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEMAN_URL` | `http://localhost:3001` | Codeman API base URL |

## Usage Examples

An agent can call:

```
list_sessions()
→ [{id: "abc", name: "feat/auth", branch: "feat/auth", status: "busy", ...}]

send_message(target: "feat/auth", message: "Your auth changes broke my API tests — check test/api.test.ts")
→ {success: true, sessionId: "abc", message: "..."}
```

Target resolution: exact ID → exact name → exact branch → substring match (errors if ambiguous).

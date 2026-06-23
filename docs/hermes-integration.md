# Hermes ↔ Codeman MCP Integration Guide

This guide explains how an autonomous agent (Hermes or similar) can drive Codeman sessions over the MCP protocol.

---

## Quick Start

### 1. Launch the MCP server

```bash
node dist/mcp-server.js
```

The server speaks JSON-RPC 2.0 over stdio (newline-delimited). By default it connects to Codeman at `http://localhost:3001`.

### 2. Configure via environment variables

| Variable            | Default                  | Description                                      |
|---------------------|--------------------------|--------------------------------------------------|
| `CODEMAN_URL`       | `http://localhost:3001`  | Base URL of the Codeman REST API                 |
| `CODEMAN_USERNAME`  | `admin`                  | HTTP Basic auth username (only used if `CODEMAN_PASSWORD` is set) |
| `CODEMAN_PASSWORD`  | _(none)_                 | HTTP Basic auth password; omit if auth is disabled |

Example with a remote, password-protected Codeman instance:

```bash
CODEMAN_URL=http://codeman-host:3001 \
CODEMAN_PASSWORD=secret \
node dist/mcp-server.js
```

---

## MCP Tools (6 total)

### `list_projects`

List the main (non-worktree) Codeman sessions — each represents a project Hermes can start work in.

```json
{
  "method": "tools/call",
  "params": {
    "name": "list_projects",
    "arguments": {}
  }
}
```

Returns: array of `{ id, name, project, status, workingDir }`.

---

### `list_sessions`

List all sessions (including worktrees), with optional status filter.

```json
{
  "method": "tools/call",
  "params": {
    "name": "list_sessions",
    "arguments": { "status": "busy" }
  }
}
```

`status` accepts `idle`, `busy`, or `stopped`. Omit for all sessions.

Returns: array of `{ id, name, branch, status, workingDir }`.

---

### `get_session_digest`

Poll a session to check whether it is finished, what it is doing, and what it last said.

```json
{
  "method": "tools/call",
  "params": {
    "name": "get_session_digest",
    "arguments": { "id": "SESSION_ID" }
  }
}
```

Returns:

```json
{
  "id": "...",
  "name": "feat/my-feature",
  "status": "working",      // "working" | "idle" | "stopped"
  "done": false,            // true only when the task is genuinely complete
  "toolExecuting": false,   // true when a tool call is in-flight
  "lastAssistantMessage": null,  // latest assistant text, or null
  "subagents": { "count": 1, "active": [...] },
  "phase": null,
  "lastActivityAt": 1782231506014
}
```

`done: true` is the definitive signal to stop polling.

---

### `start_feature`

Spin up a new feature worktree in a project and start it working autonomously.

```json
{
  "method": "tools/call",
  "params": {
    "name": "start_feature",
    "arguments": {
      "project": "Codeman",
      "title": "Add dark mode toggle",
      "description": "Add a dark/light mode toggle to the top bar. Use a CSS class on <body>.",
      "acceptance": "Toggle persists across reloads. Works in Firefox and Chrome.",
      "parentSessionId": "51dfd53f-6c88-4519-9ccb-3743dcbe7f07"
    }
  }
}
```

`acceptance` and `parentSessionId` are optional. Omit `parentSessionId` if the project has only one main session.

Returns: `{ success: true, data: { sessionId, branch, worktreePath, started } }`.

---

### `start_fix`

Spin up a fix worktree for a bug.

```json
{
  "method": "tools/call",
  "params": {
    "name": "start_fix",
    "arguments": {
      "project": "Codeman",
      "title": "Session list not refreshing after reconnect",
      "description": "After the WebSocket reconnects, the session list stays stale until a manual page reload. Reproduce: disconnect network cable for 5 s, reconnect."
    }
  }
}
```

Returns: same shape as `start_feature`.

---

### `send_message`

Send a text message to a running session (by ID, name, or branch substring). The agent in that session receives it as user input.

```json
{
  "method": "tools/call",
  "params": {
    "name": "send_message",
    "arguments": {
      "target": "feat/dark-mode",
      "message": "Please prioritise the Firefox rendering fix before committing."
    }
  }
}
```

Returns: `{ success: true, sessionId: "...", message: "..." }`.

---

## Recommended Hermes Loop

```
1. list_projects                → pick target project (and parent session id if needed)
2. start_feature / start_fix    → get back the new session id
3. loop:
     get_session_digest(id)
     if done == true → break
     if status == "idle" and the task seems stuck:
       send_message(id, "Please continue — summarise progress and carry on.")
     sleep 30–60 s
4. Report completion to user / trigger review
```

> **Important:** Merge and close (deleting the worktree, opening a PR, deploying) remain **human steps** in v1. Hermes must not attempt to merge or delete worktrees autonomously.

---

## Stdin/stdout transport notes

The MCP server reads newline-delimited JSON-RPC 2.0 from stdin and writes responses to stdout. Because async tool handlers (all tools except `initialize` and `tools/list`) make HTTP requests to the Codeman REST API, you must keep stdin open until responses arrive. When driving the server from a shell pipe, add a short `sleep` after sending the last message so the process doesn't exit before the fetch completes:

```bash
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}'; \
  sleep 3) \
  | CODEMAN_URL=http://localhost:3001 node dist/mcp-server.js
```

An MCP client (e.g. Claude Desktop, a long-running agent) keeps stdin open naturally and will not hit this issue.

---

## Auth verification

If Codeman is started with `CODEMAN_PASSWORD=secret`, direct REST calls return `401`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/sessions
# → 401
```

The MCP facade forwards credentials automatically when `CODEMAN_PASSWORD` is set in its own environment:

```bash
CODEMAN_URL=http://localhost:3001 CODEMAN_PASSWORD=secret node dist/mcp-server.js
# → authenticated, tools work normally
```

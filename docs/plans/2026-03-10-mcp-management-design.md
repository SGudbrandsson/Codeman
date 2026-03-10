# MCP Server Management Design

**Goal:** Per-session MCP server configuration with a full UI — curated library, live marketplace
browser, and on-the-fly apply via Claude restart with `--resume`.

**Architecture:** Codeman stores each session's MCP server list in `SessionState`. On apply,
it writes a temp config file, reads the Claude session UUID from the active transcript path,
kills the Claude process, and relaunches with `--mcp-config` + `--resume` so the conversation
continues seamlessly with the new servers active.

**Tech Stack:** TypeScript backend (Fastify routes, session state), vanilla JS frontend
(slide-in panel, tab UI), Smithery.ai REST API for marketplace browse.

---

## 1. Data Model

```typescript
interface McpServerEntry {
  name: string;
  enabled: boolean;
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;      // sensitive values stored as-is, masked in UI
  // http/sse transport
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
}
```

`SessionState` gains a new optional field:

```typescript
mcpServers?: McpServerEntry[];   // absent = no MCP config; empty array = explicitly none
```

Persisted in `~/.codeman/state.json` alongside all other session state. No migration
needed — sessions without the field start with an empty list.

**Generated temp config** (written to `/tmp/codeman-mcp-<sessionId>.json` on apply):

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "github": {
      "command": "npx",
      "args": ["@github/mcp-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

Only `enabled: true` entries are written — disabled servers remain in Codeman state for
quick re-enabling but are invisible to Claude.

---

## 2. Resume ID

The Claude session UUID needed for `--resume` is the filename of the active JSONL transcript.
`TranscriptWatcher` already tracks the transcript file path — extract the UUID from the
filename (`path.basename(transcriptPath, '.jsonl')`).

If no transcript exists yet (session never ran), omit `--resume` and Claude starts fresh
with the configured MCP servers.

---

## 3. Backend Changes

### 3a. SessionState

```typescript
// src/types/session.ts
mcpServers?: McpServerEntry[];
```

Include in `session.toState()` and `persistSessionState()`.

### 3b. API Routes (`src/web/routes/mcp-routes.ts` — new file)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions/:id/mcp` | Return session's `mcpServers` array |
| `PUT` | `/api/sessions/:id/mcp` | Replace full `mcpServers` array, persist |
| `POST` | `/api/sessions/:id/mcp/restart` | Apply config + restart Claude with --resume |
| `GET` | `/api/mcp/library` | Return built-in curated server list |
| `GET` | `/api/mcp/marketplace?q=<query>` | Proxy Smithery.ai search (adds caching) |

Proxying the marketplace search through the backend avoids CORS issues and lets Codeman
cache results server-side.

### 3c. CLI Builder (`src/session-cli-builder.ts`)

When `session.mcpServers` contains enabled entries:

1. Write `/tmp/codeman-mcp-<sessionId>.json` with filtered enabled entries
2. Append `--mcp-config /tmp/codeman-mcp-<sessionId>.json` to the Claude command
3. If `session.claudeResumeId` is set, append `--resume <id>`

New field on `SessionState`:

```typescript
claudeResumeId?: string;   // set after first transcript entry is seen
```

`TranscriptWatcher` sets this via a new `session.setClaudeResumeId(uuid)` call when the
first JSONL entry is parsed.

### 3d. Restart Flow (`POST /api/sessions/:id/mcp/restart`)

```
1. Validate and persist new mcpServers array
2. Read session.claudeResumeId from state
3. Write temp MCP config file (enabled servers only)
4. session.kill()  — sends SIGTERM to Claude process
5. Await process exit (or 3s timeout then SIGKILL)
6. session.start() — CLI builder picks up new --mcp-config + --resume flags
7. Broadcast SSE: session:mcp_restarted { sessionId }
8. Return { ok: true, resumeId }
```

---

## 4. Frontend UI

### 4a. Entry Point

An `⚡ MCP` chip button in the session header toolbar, between the respawn and settings
buttons. When ≥1 server is enabled, shows count badge: `⚡ MCP 2`. Pulses for 2s after
a successful restart.

### 4b. MCP Panel

Slides in from the right on desktop (320px wide), bottom sheet on mobile. Divided into
two areas:

**Active servers** (top):
- List of `McpServerEntry` cards, each showing:
  - Icon + name (from library metadata if matched, else generic icon)
  - Transport summary (e.g. `npx @playwright/mcp@latest` or `https://...`)
  - Toggle switch (enabled/disabled — does not restart, just marks dirty)
  - Edit pencil → opens Add/Edit form pre-filled
  - Remove × button
- Empty state: "No MCP servers configured. Add one below."

**Add server** (bottom):
- Two tabs: **Library** | **Marketplace**
- Search field (filters curated list locally; fires API call in Marketplace tab)
- Grid of server cards (name, description, category pill)
- Click → opens Add/Edit form

**Primary action bar** (fixed at bottom of panel):
- `[Apply & Restart Claude 🔄]` — enabled only when there are unsaved changes
- On click: shows inline "Restarting…" spinner, then "Resumed ✓" on SSE confirmation
- `[Cancel]` — reverts unsaved changes

### 4c. Add/Edit Server Form

Modal or inline expansion. Fields:

**For stdio:**
- Name (text, required)
- Command (text, e.g. `npx`)
- Args (tag-input or comma-separated, e.g. `@playwright/mcp@latest`)
- Environment variables (key/value pairs, value field masked with show toggle)

**For HTTP/SSE:**
- Name (text, required)
- Type (radio: HTTP | SSE)
- URL (text)
- Headers (key/value pairs, value masked)

**Paste JSON tab** within the form:
- Textarea accepting a raw `mcpServers` JSON block or single server object
- Parses on blur/paste, auto-fills the fields above
- Validation error shown inline if JSON is malformed

### 4d. Library Tab (curated)

Static list of ~15 servers defined in `src/web/public/mcp-library.js`:

| Category | Servers |
|----------|---------|
| Dev Tools | Playwright, GitHub, GitLab |
| Data & Infra | Supabase, PostgreSQL, AWS |
| Project Mgmt | Linear, Asana, Sentry |
| Communication | Slack |
| Custom | Blank stdio template, Blank HTTP template |

Each entry includes: `name`, `description`, `icon`, `category`, `transport`, pre-filled
`command`/`args`/`url`, and an `envVars` array with `{ key, description, required, sensitive }`.

### 4e. Marketplace Tab (Smithery.ai)

- Debounced search (300ms) → `GET /api/mcp/marketplace?q=<query>`
- Results cached in memory per query key for the browser session
- Each result card shows: name, description, weekly installs, transport badge
- "Add" button maps Smithery metadata to the Add/Edit form fields
- Offline/error state: "Marketplace unavailable — using curated library"
- Loading skeleton cards during fetch

---

## 5. Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Claude fails to restart | Show error in panel: "Restart failed — Claude exited with code X" |
| No transcript yet (no resume ID) | Restart without `--resume`, warn user: "Starting fresh — no previous session to resume" |
| Marketplace API unreachable | Show offline state in Marketplace tab, curated list unaffected |
| Invalid JSON paste | Inline validation error, form fields not updated |
| Env var missing at runtime | Claude surfaces the error itself in its output — Codeman does not validate env var values |
| Temp config file write fails | Return 500, show error in panel, do not restart |

---

## 6. SSE Events

```typescript
SESSION_MCP_RESTARTED: 'session:mcpRestarted'  // { sessionId, serverCount }
```

Frontend listens and updates panel state + chip badge + plays the "Resumed ✓" animation.

---

## 7. Curated Library Source (`src/web/public/mcp-library.js`)

Exported as a plain JS array, loaded as a static asset. Easy to extend without touching
backend code. Community contributions can be PRs against this file.

---

## 8. Out of Scope (for now)

- Project-level MCP config (`.mcp.json` in repo) — can layer on later
- Importing from Claude Desktop — separate feature
- MCP server health/status indicators — future enhancement
- Per-env-var secret storage (vault integration) — future enhancement

# MCP Server Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Per-session MCP server configuration with a full UI — curated library, Smithery.ai marketplace browser, and on-the-fly apply via Claude restart with `--resume`.

**Architecture:** Codeman stores each session's MCP server list in `SessionState.mcpServers`. On apply, writes a temp config file, reads the Claude session UUID from the active transcript path, kills the Claude process, and relaunches with `--mcp-config` + `--resume` so the conversation continues seamlessly.

**Tech Stack:** TypeScript backend (Fastify routes, session state), vanilla JS frontend (slide-in panel, tab UI), Smithery.ai REST API for marketplace browse.

---

## Task 1: Add `McpServerEntry` type and `SessionState` field

**Files:**
- Modify: `src/types/session.ts`

**Step 1: Open `src/types/session.ts` and locate `SessionState`**

Run: `grep -n "mcpServers\|SessionState\|interface" src/types/session.ts | head -30`

**Step 2: Add `McpServerEntry` interface and fields to `SessionState`**

Add before the `SessionState` interface (or in the appropriate domain types file):

```typescript
export interface McpServerEntry {
  name: string;
  enabled: boolean;
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse transport
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
}
```

Add to `SessionState`:

```typescript
mcpServers?: McpServerEntry[];
claudeResumeId?: string;
```

**Step 3: Type-check**

Run: `tsc --noEmit`
Expected: no new errors

**Step 4: Commit**

```bash
git add src/types/session.ts
git commit -m "feat(mcp): add McpServerEntry type and SessionState fields"
```

---

## Task 2: Persist `mcpServers` and `claudeResumeId` in session state

**Files:**
- Modify: `src/session.ts` (search for `toState()` and `persistSessionState`)

**Step 1: Locate `toState()` in `src/session.ts`**

Run: `grep -n "toState\|mcpServers\|claudeResumeId" src/session.ts | head -20`

**Step 2: Include new fields in `toState()`**

In `toState()`, add the two new fields alongside other optional fields:

```typescript
...(this.mcpServers !== undefined && { mcpServers: this.mcpServers }),
...(this.claudeResumeId !== undefined && { claudeResumeId: this.claudeResumeId }),
```

**Step 3: Restore them when loading state**

Find where session state is loaded from `StateStore` (typically in a `fromState()` or constructor). Add:

```typescript
this.mcpServers = state.mcpServers;
this.claudeResumeId = state.claudeResumeId;
```

**Step 4: Add setter for `claudeResumeId`**

```typescript
setClaudeResumeId(id: string): void {
  this.claudeResumeId = id;
  this._persistState();
}
```

**Step 5: Type-check and commit**

Run: `tsc --noEmit`

```bash
git add src/session.ts
git commit -m "feat(mcp): persist mcpServers and claudeResumeId in session state"
```

---

## Task 3: Extract resume ID from transcript watcher

**Files:**
- Modify: `src/transcript-watcher.ts`

**Step 1: Locate where the transcript path is first resolved**

Run: `grep -n "transcriptPath\|basename\|\.jsonl\|resumeId\|setClaudeResumeId" src/transcript-watcher.ts | head -20`

**Step 2: Extract UUID from filename when first JSONL entry is parsed**

When `TranscriptWatcher` first observes a transcript file, extract the UUID:

```typescript
import path from 'path';

// When transcript file path is resolved:
const uuid = path.basename(transcriptPath, '.jsonl');
if (uuid && uuid.length === 36) {  // basic UUID format check
  this._session.setClaudeResumeId(uuid);
}
```

The transcript filename is the Claude session UUID (e.g., `abc123de-f456-...`).

**Step 3: Type-check and commit**

Run: `tsc --noEmit`

```bash
git add src/transcript-watcher.ts
git commit -m "feat(mcp): extract and store Claude resume ID from transcript filename"
```

---

## Task 4: CLI builder — write MCP config file and pass flags

**Files:**
- Modify: `src/session-cli-builder.ts`

**Step 1: Inspect current CLI builder**

Run: `grep -n "mcp\|resume\|args\|command\|claudeArgs" src/session-cli-builder.ts | head -30`

**Step 2: Add MCP config file writing and flag injection**

In the function that builds the Claude CLI arguments, add after the existing arg construction:

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';

// Write MCP config if session has enabled servers
const enabledServers = (session.mcpServers ?? []).filter(s => s.enabled);
if (enabledServers.length > 0) {
  const configPath = path.join(os.tmpdir(), `codeman-mcp-${session.id}.json`);
  const mcpConfig: Record<string, unknown> = { mcpServers: {} };
  for (const srv of enabledServers) {
    const entry: Record<string, unknown> = {};
    if (srv.command) {
      entry.command = srv.command;
      if (srv.args?.length) entry.args = srv.args;
      if (srv.env && Object.keys(srv.env).length) entry.env = srv.env;
    } else if (srv.type && srv.url) {
      entry.type = srv.type;
      entry.url = srv.url;
      if (srv.headers && Object.keys(srv.headers).length) entry.headers = srv.headers;
    }
    (mcpConfig.mcpServers as Record<string, unknown>)[srv.name] = entry;
  }
  fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  args.push('--mcp-config', configPath);
}

// Add --resume if we have a prior session ID
if (session.claudeResumeId) {
  args.push('--resume', session.claudeResumeId);
}
```

**Step 3: Type-check and commit**

Run: `tsc --noEmit`

```bash
git add src/session-cli-builder.ts
git commit -m "feat(mcp): write MCP config file and pass --mcp-config/--resume to Claude"
```

---

## Task 5: Create MCP API routes

**Files:**
- Create: `src/web/routes/mcp-routes.ts`
- Modify: `src/web/routes/index.ts` (barrel — add export)
- Modify: `src/web/server.ts` (register routes)

**Step 1: Check existing route structure**

Run: `cat src/web/routes/index.ts`
Run: `grep -n "registerRoutes\|import.*routes" src/web/server.ts | head -20`

**Step 2: Create `src/web/routes/mcp-routes.ts`**

```typescript
/**
 * @fileoverview MCP server management routes.
 *
 * Endpoints:
 *   GET  /api/sessions/:id/mcp            — get session MCP server list
 *   PUT  /api/sessions/:id/mcp            — replace MCP server list
 *   POST /api/sessions/:id/mcp/restart    — apply config + restart Claude with --resume
 *   GET  /api/mcp/library                 — return curated server list
 *   GET  /api/mcp/marketplace?q=<query>   — proxy Smithery.ai search
 */
import { FastifyInstance } from 'fastify';
import { SessionPort } from '../ports/session-port.js';
import { EventPort } from '../ports/event-port.js';
import { createErrorResponse } from '../route-helpers.js';
import { MCP_LIBRARY } from '../../mcp-library.js';

const SMITHERY_BASE = 'https://registry.smithery.ai';
const marketplaceCache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function registerMcpRoutes(app: FastifyInstance & SessionPort & EventPort) {
  // GET session MCP servers
  app.get('/api/sessions/:id/mcp', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = app.getSession(id);
    if (!session) return reply.code(404).send(createErrorResponse('Session not found'));
    return reply.send(session.mcpServers ?? []);
  });

  // PUT session MCP servers
  app.put('/api/sessions/:id/mcp', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = app.getSession(id);
    if (!session) return reply.code(404).send(createErrorResponse('Session not found'));
    const servers = req.body as unknown[];
    if (!Array.isArray(servers)) return reply.code(400).send(createErrorResponse('Body must be array'));
    session.mcpServers = servers as typeof session.mcpServers;
    await session.persistState();
    return reply.send({ ok: true });
  });

  // POST restart Claude with updated MCP config
  app.post('/api/sessions/:id/mcp/restart', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = app.getSession(id);
    if (!session) return reply.code(404).send(createErrorResponse('Session not found'));

    // Persist incoming servers if provided
    const body = req.body as { mcpServers?: unknown[] } | null;
    if (body?.mcpServers !== undefined) {
      if (!Array.isArray(body.mcpServers)) {
        return reply.code(400).send(createErrorResponse('mcpServers must be array'));
      }
      session.mcpServers = body.mcpServers as typeof session.mcpServers;
      await session.persistState();
    }

    const resumeId = session.claudeResumeId;
    try {
      await session.kill();
      await session.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(createErrorResponse('Restart failed: ' + msg));
    }

    const enabledCount = (session.mcpServers ?? []).filter(s => s.enabled).length;
    app.broadcast({ type: 'session:mcpRestarted', sessionId: id, serverCount: enabledCount });
    return reply.send({ ok: true, resumeId: resumeId ?? null });
  });

  // GET curated library
  app.get('/api/mcp/library', async (_req, reply) => {
    return reply.send(MCP_LIBRARY);
  });

  // GET marketplace proxy (Smithery.ai)
  app.get('/api/mcp/marketplace', async (req, reply) => {
    const { q = '' } = req.query as { q?: string };
    const cacheKey = q.trim().toLowerCase();
    const cached = marketplaceCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return reply.send(cached.data);
    }
    try {
      const url = `${SMITHERY_BASE}/servers?q=${encodeURIComponent(q)}&pageSize=24`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('Smithery returned ' + res.status);
      const data = await res.json();
      marketplaceCache.set(cacheKey, { data, ts: Date.now() });
      return reply.send(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(502).send(createErrorResponse('Marketplace unavailable: ' + msg));
    }
  });
}
```

**Step 3: Add to routes barrel (`src/web/routes/index.ts`)**

```typescript
export { registerMcpRoutes } from './mcp-routes.js';
```

**Step 4: Register in `src/web/server.ts`**

Find where other routes are registered and add:

```typescript
import { registerMcpRoutes } from './routes/index.js';
// ...
await registerMcpRoutes(app);
```

**Step 5: Type-check and commit**

Run: `tsc --noEmit`

```bash
git add src/web/routes/mcp-routes.ts src/web/routes/index.ts src/web/server.ts
git commit -m "feat(mcp): add MCP API routes (list, update, restart, library, marketplace)"
```

---

## Task 6: Create curated MCP library

**Files:**
- Create: `src/mcp-library.ts`

**Step 1: Create the file**

```typescript
/**
 * @fileoverview Curated MCP server library.
 * Static list served at GET /api/mcp/library.
 * To add a server: append an entry to MCP_LIBRARY and commit.
 */

export interface McpLibraryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  envVars?: { key: string; description: string; required: boolean; sensitive: boolean }[];
}

export const MCP_LIBRARY: McpLibraryEntry[] = [
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation — navigate, click, screenshot, test web UIs',
    category: 'Dev Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read/write GitHub repos, issues, PRs, and code search',
    category: 'Dev Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['@github/mcp-github'],
    envVars: [
      { key: 'GITHUB_TOKEN', description: 'Personal access token', required: true, sensitive: true },
    ],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Interact with GitLab projects, merge requests, and pipelines',
    category: 'Dev Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['@gitlab/mcp-gitlab'],
    envVars: [
      { key: 'GITLAB_TOKEN', description: 'GitLab personal access token', required: true, sensitive: true },
      { key: 'GITLAB_URL', description: 'GitLab instance URL (default: gitlab.com)', required: false, sensitive: false },
    ],
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Query and manage Supabase databases and storage',
    category: 'Data & Infra',
    transport: 'stdio',
    command: 'npx',
    args: ['@supabase/mcp-server-supabase@latest'],
    envVars: [
      { key: 'SUPABASE_URL', description: 'Project URL', required: true, sensitive: false },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', description: 'Service role key', required: true, sensitive: true },
    ],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Run SQL queries against a PostgreSQL database',
    category: 'Data & Infra',
    transport: 'stdio',
    command: 'npx',
    args: ['@modelcontextprotocol/server-postgres'],
    envVars: [
      { key: 'DATABASE_URL', description: 'postgres://user:pass@host/db', required: true, sensitive: true },
    ],
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Create and update Linear issues, projects, and cycles',
    category: 'Project Management',
    transport: 'stdio',
    command: 'npx',
    args: ['@linear/mcp-server'],
    envVars: [
      { key: 'LINEAR_API_KEY', description: 'Linear API key', required: true, sensitive: true },
    ],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Query Sentry errors, events, and performance data',
    category: 'Project Management',
    transport: 'stdio',
    command: 'npx',
    args: ['@sentry/mcp-server@latest'],
    envVars: [
      { key: 'SENTRY_AUTH_TOKEN', description: 'Sentry auth token', required: true, sensitive: true },
      { key: 'SENTRY_ORG', description: 'Sentry organization slug', required: true, sensitive: false },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read channels, send messages, search Slack workspace',
    category: 'Communication',
    transport: 'stdio',
    command: 'npx',
    args: ['@modelcontextprotocol/server-slack'],
    envVars: [
      { key: 'SLACK_BOT_TOKEN', description: 'Bot User OAuth Token (xoxb-...)', required: true, sensitive: true },
      { key: 'SLACK_TEAM_ID', description: 'Workspace team ID', required: true, sensitive: false },
    ],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files in specified directories',
    category: 'Dev Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['@modelcontextprotocol/server-filesystem', '/allowed/path'],
  },
  {
    id: 'blank-stdio',
    name: 'Custom (stdio)',
    description: 'Blank template — configure your own stdio MCP server',
    category: 'Custom',
    transport: 'stdio',
    command: 'npx',
    args: [],
  },
  {
    id: 'blank-http',
    name: 'Custom (HTTP)',
    description: 'Blank template — configure your own HTTP/SSE MCP server',
    category: 'Custom',
    transport: 'http',
    url: '',
  },
];
```

**Step 2: Type-check and commit**

Run: `tsc --noEmit`

```bash
git add src/mcp-library.ts
git commit -m "feat(mcp): add curated MCP server library (11 servers)"
```

---

## Task 7: HTML structure for MCP panel

**Files:**
- Modify: `src/web/public/index.html`

**Step 1: Find where the session header toolbar is defined**

Run: `grep -n "respawn\|settings\|toolbar\|session-header\|chip\|btn-respawn" src/web/public/index.html | head -20`

**Step 2: Add MCP chip button in the session header toolbar**

Find the respawn/settings buttons area and add after them:

```html
<button id="mcpChipBtn" class="mcp-chip" title="MCP Servers" style="display:none">
  <span class="mcp-chip-icon">&#x26a1;</span>
  <span class="mcp-chip-label">MCP</span>
  <span class="mcp-chip-badge" style="display:none"></span>
</button>
```

**Step 3: Add MCP panel markup (before `</body>` or alongside other panels)**

```html
<!-- MCP Server Management Panel -->
<div id="mcpPanel" class="mcp-panel" style="display:none" aria-label="MCP Servers">
  <div class="mcp-panel-header">
    <span class="mcp-panel-title">MCP Servers</span>
    <button class="mcp-panel-close" id="mcpPanelClose" title="Close">&#x2715;</button>
  </div>

  <div class="mcp-section-label">Active for this session</div>
  <div id="mcpActiveList" class="mcp-active-list">
    <div class="mcp-empty-state" id="mcpEmptyState">No MCP servers configured. Add one below.</div>
  </div>

  <div class="mcp-action-bar" id="mcpActionBar">
    <button class="mcp-btn-apply" id="mcpApplyBtn" disabled>Apply &amp; Restart Claude</button>
    <button class="mcp-btn-cancel" id="mcpCancelBtn" style="display:none">Cancel</button>
  </div>

  <div class="mcp-section-label" style="margin-top:12px">Add server</div>
  <div class="mcp-tabs">
    <button class="mcp-tab active" data-tab="library">Library</button>
    <button class="mcp-tab" data-tab="marketplace">Marketplace</button>
  </div>
  <input type="text" class="mcp-search" id="mcpSearch" placeholder="Search..." autocomplete="off">
  <div id="mcpLibraryPane" class="mcp-pane mcp-library-grid"></div>
  <div id="mcpMarketplacePane" class="mcp-pane" style="display:none">
    <div id="mcpMarketplaceResults" class="mcp-library-grid"></div>
  </div>
</div>

<!-- MCP Add/Edit Server Form -->
<div id="mcpFormOverlay" class="mcp-form-overlay" style="display:none">
  <div class="mcp-form">
    <div class="mcp-form-header">
      <span id="mcpFormTitle">Add Server</span>
      <button class="mcp-panel-close" id="mcpFormClose">&#x2715;</button>
    </div>
    <div class="mcp-form-tabs">
      <button class="mcp-form-tab active" data-ftab="fields">Configure</button>
      <button class="mcp-form-tab" data-ftab="json">Paste JSON</button>
    </div>
    <div id="mcpFieldsPane">
      <div class="mcp-form-row">
        <label>Name</label>
        <input type="text" id="mcpFName" placeholder="my-server">
      </div>
      <div class="mcp-form-row mcp-transport-row">
        <label>Transport</label>
        <div class="mcp-radio-group">
          <label><input type="radio" name="mcpTransport" value="stdio" checked> stdio</label>
          <label><input type="radio" name="mcpTransport" value="http"> HTTP</label>
          <label><input type="radio" name="mcpTransport" value="sse"> SSE</label>
        </div>
      </div>
      <div id="mcpStdioFields">
        <div class="mcp-form-row">
          <label>Command</label>
          <input type="text" id="mcpFCommand" placeholder="npx">
        </div>
        <div class="mcp-form-row">
          <label>Args (space-separated)</label>
          <input type="text" id="mcpFArgs" placeholder="@playwright/mcp@latest">
        </div>
        <div class="mcp-form-row">
          <label>Environment variables</label>
          <div id="mcpEnvVars" class="mcp-kv-list"></div>
          <button class="mcp-add-kv" id="mcpAddEnvVar">+ Add variable</button>
        </div>
      </div>
      <div id="mcpHttpFields" style="display:none">
        <div class="mcp-form-row">
          <label>URL</label>
          <input type="text" id="mcpFUrl" placeholder="https://...">
        </div>
        <div class="mcp-form-row">
          <label>Headers</label>
          <div id="mcpHeaders" class="mcp-kv-list"></div>
          <button class="mcp-add-kv" id="mcpAddHeader">+ Add header</button>
        </div>
      </div>
    </div>
    <div id="mcpJsonPane" style="display:none">
      <div class="mcp-form-row">
        <label>Paste mcpServers JSON</label>
        <textarea id="mcpJsonInput" class="mcp-json-textarea" placeholder='{"command":"npx","args":["@playwright/mcp@latest"]}'></textarea>
        <div id="mcpJsonError" class="mcp-json-error" style="display:none"></div>
      </div>
    </div>
    <div class="mcp-form-actions">
      <button class="mcp-btn-apply" id="mcpFormSave">Add to session</button>
      <button class="mcp-btn-cancel" id="mcpFormCancel">Cancel</button>
    </div>
  </div>
</div>
```

**Step 4: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat(mcp): add MCP panel and form HTML markup"
```

---

## Task 8: CSS for MCP panel

**Files:**
- Modify: `src/web/public/styles.css`

**Step 1: Find the end of the transcript view styles**

Run: `grep -n "tv-auq\|tv-empty" src/web/public/styles.css | tail -5`

**Step 2: Append MCP styles at the end of the file**

```css
/* ── MCP chip button ─────────────────────────────────────── */
.mcp-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 20px;
  border: 1px solid rgba(6,182,212,0.35);
  background: rgba(6,182,212,0.08);
  color: #22d3ee;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  position: relative;
}
.mcp-chip:hover { background: rgba(6,182,212,0.16); border-color: rgba(6,182,212,0.6); }
.mcp-chip.active { background: rgba(6,182,212,0.22); border-color: rgba(6,182,212,0.8); }
.mcp-chip-badge {
  background: #22d3ee;
  color: #0f172a;
  border-radius: 10px;
  font-size: 0.6rem;
  font-weight: 700;
  padding: 1px 5px;
  min-width: 16px;
  text-align: center;
}
@keyframes mcp-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(34,211,238,0.4); }
  50% { box-shadow: 0 0 0 6px rgba(34,211,238,0); }
}
.mcp-chip.pulsing { animation: mcp-pulse 1s ease 2; }

/* ── MCP panel ───────────────────────────────────────────── */
.mcp-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 320px;
  height: 100%;
  background: #0f172a;
  border-left: 1px solid rgba(255,255,255,0.08);
  z-index: 600;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform: translateX(100%);
  transition: transform 0.25s ease;
}
.mcp-panel.open { transform: translateX(0); }
.mcp-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
}
.mcp-panel-title { font-size: 0.9rem; font-weight: 600; color: #f1f5f9; }
.mcp-panel-close {
  background: none;
  border: none;
  color: #64748b;
  font-size: 1rem;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.mcp-panel-close:hover { color: #f1f5f9; background: rgba(255,255,255,0.08); }
.mcp-section-label {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #475569;
  padding: 10px 16px 4px;
  flex-shrink: 0;
}
.mcp-active-list {
  flex: 0 0 auto;
  max-height: 200px;
  overflow-y: auto;
  padding: 0 8px;
}
.mcp-empty-state {
  color: #475569;
  font-size: 0.78rem;
  padding: 12px 8px;
  text-align: center;
}
.mcp-server-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  margin-bottom: 2px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
}
.mcp-server-name { flex: 1; font-size: 0.8rem; color: #e2e8f0; font-weight: 500; }
.mcp-server-cmd {
  font-size: 0.65rem;
  color: #475569;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}
.mcp-toggle {
  width: 28px;
  height: 16px;
  border-radius: 8px;
  background: #1e293b;
  border: 1px solid rgba(255,255,255,0.1);
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
  transition: background 0.2s;
}
.mcp-toggle::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #64748b;
  transition: transform 0.2s, background 0.2s;
}
.mcp-toggle.on { background: rgba(6,182,212,0.3); border-color: rgba(6,182,212,0.5); }
.mcp-toggle.on::after { transform: translateX(12px); background: #22d3ee; }
.mcp-server-edit, .mcp-server-remove {
  background: none;
  border: none;
  color: #475569;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 2px 4px;
  border-radius: 3px;
}
.mcp-server-edit:hover { color: #94a3b8; }
.mcp-server-remove:hover { color: #f87171; }
.mcp-action-bar {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.mcp-btn-apply {
  flex: 1;
  background: rgba(6,182,212,0.15);
  border: 1px solid rgba(6,182,212,0.4);
  color: #22d3ee;
  border-radius: 6px;
  padding: 7px 12px;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.mcp-btn-apply:hover:not(:disabled) { background: rgba(6,182,212,0.25); }
.mcp-btn-apply:disabled { opacity: 0.4; cursor: default; }
.mcp-btn-cancel {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  color: #64748b;
  border-radius: 6px;
  padding: 7px 12px;
  font-size: 0.78rem;
  cursor: pointer;
}
.mcp-btn-cancel:hover { color: #94a3b8; background: rgba(255,255,255,0.08); }
.mcp-tabs {
  display: flex;
  gap: 4px;
  padding: 4px 12px 0;
  flex-shrink: 0;
}
.mcp-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #475569;
  font-size: 0.78rem;
  font-weight: 500;
  padding: 4px 8px;
  cursor: pointer;
  transition: color 0.15s;
}
.mcp-tab.active { color: #22d3ee; border-bottom-color: #22d3ee; }
.mcp-tab:hover:not(.active) { color: #94a3b8; }
.mcp-search {
  width: calc(100% - 24px);
  margin: 8px 12px 6px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  color: #e2e8f0;
  font-size: 0.78rem;
  padding: 6px 10px;
  outline: none;
  flex-shrink: 0;
  box-sizing: content-box;
}
.mcp-search:focus { border-color: rgba(6,182,212,0.5); }
.mcp-pane {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 12px;
}
.mcp-library-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mcp-lib-card {
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.mcp-lib-card:hover { background: rgba(6,182,212,0.07); border-color: rgba(6,182,212,0.25); }
.mcp-lib-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.mcp-lib-card-name { font-size: 0.8rem; font-weight: 600; color: #e2e8f0; flex: 1; }
.mcp-lib-card-cat {
  font-size: 0.6rem;
  font-weight: 600;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 10px;
  background: rgba(6,182,212,0.12);
  color: #22d3ee;
}
.mcp-lib-card-desc { font-size: 0.72rem; color: #64748b; }
.mcp-skeleton {
  height: 52px;
  border-radius: 6px;
  background: linear-gradient(
    90deg,
    rgba(255,255,255,0.04) 25%,
    rgba(255,255,255,0.08) 50%,
    rgba(255,255,255,0.04) 75%
  );
  background-size: 200% 100%;
  animation: mcp-shimmer 1.5s infinite;
}
@keyframes mcp-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ── MCP form overlay ────────────────────────────────────── */
.mcp-form-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  z-index: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mcp-form {
  background: #0f172a;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  width: 400px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow-y: auto;
}
.mcp-form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  font-size: 0.9rem;
  font-weight: 600;
  color: #f1f5f9;
}
.mcp-form-tabs { display: flex; gap: 4px; padding: 10px 20px 0; }
.mcp-form-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #475569;
  font-size: 0.78rem;
  font-weight: 500;
  padding: 4px 8px;
  cursor: pointer;
}
.mcp-form-tab.active { color: #22d3ee; border-bottom-color: #22d3ee; }
.mcp-form-row {
  padding: 10px 20px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mcp-form-row label { font-size: 0.72rem; color: #64748b; font-weight: 500; }
.mcp-form-row input[type=text],
.mcp-form-row input[type=password] {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  color: #e2e8f0;
  font-size: 0.8rem;
  padding: 6px 10px;
  outline: none;
}
.mcp-form-row input[type=text]:focus,
.mcp-form-row input[type=password]:focus { border-color: rgba(6,182,212,0.5); }
.mcp-radio-group { display: flex; gap: 12px; }
.mcp-radio-group label {
  color: #94a3b8;
  font-size: 0.78rem;
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.mcp-kv-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px; }
.mcp-kv-row { display: flex; gap: 4px; }
.mcp-kv-row input { flex: 1; }
.mcp-kv-remove {
  background: none;
  border: none;
  color: #475569;
  cursor: pointer;
  font-size: 0.9rem;
  padding: 0 4px;
}
.mcp-kv-remove:hover { color: #f87171; }
.mcp-add-kv {
  background: none;
  border: 1px dashed rgba(255,255,255,0.1);
  border-radius: 4px;
  color: #475569;
  font-size: 0.72rem;
  padding: 4px 8px;
  cursor: pointer;
  margin-top: 4px;
  width: 100%;
}
.mcp-add-kv:hover { color: #94a3b8; border-color: rgba(255,255,255,0.2); }
.mcp-json-textarea {
  width: 100%;
  min-height: 120px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  color: #e2e8f0;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  padding: 8px 10px;
  outline: none;
  resize: vertical;
  box-sizing: border-box;
}
.mcp-json-textarea:focus { border-color: rgba(6,182,212,0.5); }
.mcp-json-error { color: #f87171; font-size: 0.72rem; margin-top: 4px; }
.mcp-form-actions {
  display: flex;
  gap: 8px;
  padding: 14px 20px 16px;
  border-top: 1px solid rgba(255,255,255,0.06);
  margin-top: 14px;
}
```

**Step 3: Bump `styles.css?v=` in `index.html`**

Increment the trailing number by 1.

**Step 4: Commit**

```bash
git add src/web/public/styles.css src/web/public/index.html
git commit -m "feat(mcp): add MCP panel and form CSS styles"
```

---

## Task 9: JavaScript — MCP panel logic (`app.js`)

**Files:**
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/constants.js`

This is the largest task. The MCP panel logic lives in a single `McpPanel` object literal, similar to how `TranscriptView` is structured.

**Step 1: Find a good insertion point**

Run: `grep -n "TranscriptView\|const.*=.*{$" src/web/public/app.js | grep "const.*=.*{" | head -10`

**Step 2: Add the `McpPanel` object before the `App` class**

The full McpPanel implementation (insert before the App class definition):

```javascript
// ===================================================================
// MCP Panel
// ===================================================================
const McpPanel = {
  _sessionId: null,
  _savedServers: [],
  _draftServers: [],
  _dirty: false,
  _editingIndex: -1,

  init() {
    this._panel      = document.getElementById('mcpPanel');
    this._chip       = document.getElementById('mcpChipBtn');
    this._activeList = document.getElementById('mcpActiveList');
    this._applyBtn   = document.getElementById('mcpApplyBtn');
    this._cancelBtn  = document.getElementById('mcpCancelBtn');
    this._tabs       = this._panel ? Array.from(this._panel.querySelectorAll('.mcp-tab')) : [];
    this._search     = document.getElementById('mcpSearch');
    this._libPane    = document.getElementById('mcpLibraryPane');
    this._mktPane    = document.getElementById('mcpMarketplacePane');
    this._mktResults = document.getElementById('mcpMarketplaceResults');
    this._formOverlay = document.getElementById('mcpFormOverlay');
    this._library    = [];
    this._mktDebounce = null;

    if (!this._panel) return;

    document.getElementById('mcpPanelClose')?.addEventListener('click', () => this.close());
    this._chip?.addEventListener('click', () => this.toggle());
    this._applyBtn?.addEventListener('click', () => this._applyAndRestart());
    this._cancelBtn?.addEventListener('click', () => this._cancelChanges());

    this._tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this._tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const pane = tab.dataset.tab;
        this._libPane.style.display  = pane === 'library' ? '' : 'none';
        this._mktPane.style.display  = pane === 'marketplace' ? '' : 'none';
        if (pane === 'marketplace' && !this._mktResults.children.length) {
          this._searchMarketplace('');
        }
      });
    });

    this._search?.addEventListener('input', () => {
      const q = this._search.value;
      const activeTab = this._panel.querySelector('.mcp-tab.active')?.dataset.tab;
      if (activeTab === 'library') {
        this._renderLibrary(q);
      } else {
        clearTimeout(this._mktDebounce);
        this._mktDebounce = setTimeout(() => this._searchMarketplace(q), 300);
      }
    });

    this._initForm();
    this._loadLibrary();
  },

  async open(sessionId) {
    this._sessionId = sessionId;
    this._panel.style.display = '';
    requestAnimationFrame(() => this._panel.classList.add('open'));
    this._chip?.classList.add('active');
    await this._loadServers();
  },

  close() {
    this._panel.classList.remove('open');
    this._chip?.classList.remove('active');
    const panel = this._panel;
    setTimeout(() => {
      if (!panel.classList.contains('open')) panel.style.display = 'none';
    }, 260);
  },

  toggle() {
    if (this._panel.classList.contains('open')) this.close();
    else if (this._sessionId) this.open(this._sessionId);
  },

  showForSession(sessionId) {
    if (!this._chip) return;
    this._chip.style.display = '';
    if (this._sessionId !== sessionId) {
      this._sessionId = sessionId;
      this._savedServers = [];
      this._draftServers = [];
      this._dirty = false;
      this._renderActiveList();
      this._updateApplyBtn();
    }
  },

  hide() {
    if (!this._chip) return;
    this._chip.style.display = 'none';
    this.close();
  },

  async _loadServers() {
    if (!this._sessionId) return;
    try {
      const res = await fetch('/api/sessions/' + encodeURIComponent(this._sessionId) + '/mcp');
      if (res.ok) {
        this._savedServers = await res.json();
        this._draftServers = this._savedServers.map(s => Object.assign({}, s));
        this._dirty = false;
        this._renderActiveList();
        this._updateApplyBtn();
        this._updateChipBadge();
      }
    } catch (_e) { /* network error — ignore */ }
  },

  _markDirty() {
    this._dirty = true;
    this._updateApplyBtn();
    if (this._cancelBtn) this._cancelBtn.style.display = '';
  },

  _updateApplyBtn() {
    if (this._applyBtn) this._applyBtn.disabled = !this._dirty;
  },

  _cancelChanges() {
    this._draftServers = this._savedServers.map(s => Object.assign({}, s));
    this._dirty = false;
    this._updateApplyBtn();
    if (this._cancelBtn) this._cancelBtn.style.display = 'none';
    this._renderActiveList();
  },

  _renderActiveList() {
    if (!this._activeList) return;
    this._activeList.textContent = '';
    if (!this._draftServers.length) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty-state';
      empty.textContent = 'No MCP servers configured. Add one below.';
      this._activeList.appendChild(empty);
      return;
    }
    this._draftServers.forEach((srv, idx) => {
      const card = document.createElement('div');
      card.className = 'mcp-server-card';

      const toggle = document.createElement('button');
      toggle.className = 'mcp-toggle' + (srv.enabled ? ' on' : '');
      toggle.title = srv.enabled ? 'Disable' : 'Enable';
      toggle.addEventListener('click', () => {
        srv.enabled = !srv.enabled;
        toggle.classList.toggle('on', srv.enabled);
        toggle.title = srv.enabled ? 'Disable' : 'Enable';
        this._markDirty();
        this._updateChipBadge();
      });

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      const name = document.createElement('div');
      name.className = 'mcp-server-name';
      name.textContent = srv.name;
      const cmd = document.createElement('div');
      cmd.className = 'mcp-server-cmd';
      cmd.textContent = srv.command
        ? (srv.command + ' ' + (srv.args || []).join(' '))
        : (srv.url || '');
      info.appendChild(name);
      info.appendChild(cmd);

      const editBtn = document.createElement('button');
      editBtn.className = 'mcp-server-edit';
      editBtn.title = 'Edit';
      editBtn.textContent = '\u270e';
      editBtn.addEventListener('click', () => this._openForm(srv, idx));

      const removeBtn = document.createElement('button');
      removeBtn.className = 'mcp-server-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '\u2715';
      removeBtn.addEventListener('click', () => {
        this._draftServers.splice(idx, 1);
        this._markDirty();
        this._renderActiveList();
        this._updateChipBadge();
      });

      card.appendChild(toggle);
      card.appendChild(info);
      card.appendChild(editBtn);
      card.appendChild(removeBtn);
      this._activeList.appendChild(card);
    });
  },

  _updateChipBadge() {
    const badge = this._chip?.querySelector('.mcp-chip-badge');
    if (!badge) return;
    const count = this._draftServers.filter(s => s.enabled).length;
    badge.style.display = count > 0 ? '' : 'none';
    badge.textContent = String(count);
  },

  async _applyAndRestart() {
    if (!this._applyBtn) return;
    this._applyBtn.disabled = true;
    this._applyBtn.textContent = 'Restarting\u2026';
    try {
      const res = await fetch('/api/sessions/' + encodeURIComponent(this._sessionId) + '/mcp/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServers: this._draftServers }),
      });
      if (!res.ok) {
        this._applyBtn.textContent = 'Restart failed \u2717';
        setTimeout(() => {
          this._applyBtn.textContent = 'Apply & Restart Claude';
          this._applyBtn.disabled = false;
        }, 3000);
        return;
      }
      this._savedServers = this._draftServers.map(s => Object.assign({}, s));
      this._dirty = false;
      if (this._cancelBtn) this._cancelBtn.style.display = 'none';
      this._applyBtn.textContent = 'Resumed \u2713';
      this._chip?.classList.add('pulsing');
      setTimeout(() => {
        this._applyBtn.textContent = 'Apply & Restart Claude';
        this._applyBtn.disabled = true;
        this._chip?.classList.remove('pulsing');
      }, 2000);
    } catch (_e) {
      this._applyBtn.textContent = 'Error \u2014 see console';
      setTimeout(() => {
        this._applyBtn.textContent = 'Apply & Restart Claude';
        this._applyBtn.disabled = false;
      }, 3000);
    }
  },

  async _loadLibrary() {
    try {
      const res = await fetch('/api/mcp/library');
      if (res.ok) {
        this._library = await res.json();
        this._renderLibrary('');
      }
    } catch (_e) { /* offline */ }
  },

  _renderLibrary(filter) {
    if (!this._libPane) return;
    const q = filter.toLowerCase();
    const items = q
      ? this._library.filter(e =>
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q))
      : this._library;
    this._libPane.textContent = '';
    items.forEach(entry => this._libPane.appendChild(this._makeLibCard(entry)));
  },

  _makeLibCard(entry) {
    const card = document.createElement('div');
    card.className = 'mcp-lib-card';
    const hdr = document.createElement('div');
    hdr.className = 'mcp-lib-card-header';
    const name = document.createElement('span');
    name.className = 'mcp-lib-card-name';
    name.textContent = entry.name;
    const cat = document.createElement('span');
    cat.className = 'mcp-lib-card-cat';
    cat.textContent = entry.category;
    hdr.appendChild(name);
    hdr.appendChild(cat);
    const desc = document.createElement('div');
    desc.className = 'mcp-lib-card-desc';
    desc.textContent = entry.description;
    card.appendChild(hdr);
    card.appendChild(desc);
    card.addEventListener('click', () => this._openFormFromLibrary(entry));
    return card;
  },

  async _searchMarketplace(q) {
    if (!this._mktResults) return;
    this._mktResults.textContent = '';
    for (let i = 0; i < 4; i++) {
      const sk = document.createElement('div');
      sk.className = 'mcp-skeleton';
      this._mktResults.appendChild(sk);
    }
    try {
      const res = await fetch('/api/mcp/marketplace?q=' + encodeURIComponent(q));
      this._mktResults.textContent = '';
      if (!res.ok) throw new Error('unavailable');
      const data = await res.json();
      const items = Array.isArray(data) ? data : (data.servers || data.results || []);
      if (!items.length) {
        const msg = document.createElement('div');
        msg.className = 'mcp-empty-state';
        msg.textContent = 'No results.';
        this._mktResults.appendChild(msg);
        return;
      }
      items.slice(0, 24).forEach(item => {
        const entry = {
          id: item.qualifiedName || item.name || '',
          name: item.displayName || item.name || item.qualifiedName || '',
          description: item.description || '',
          category: 'Marketplace',
          transport: item.transport || 'stdio',
          command: item.command,
          args: item.args,
          url: item.url,
        };
        this._mktResults.appendChild(this._makeLibCard(entry));
      });
    } catch (_e) {
      this._mktResults.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'mcp-empty-state';
      msg.textContent = 'Marketplace unavailable \u2014 using curated library only.';
      this._mktResults.appendChild(msg);
    }
  },

  _openFormFromLibrary(entry) {
    this._openForm({
      name: entry.name,
      enabled: true,
      command: entry.command,
      args: entry.args,
      url: entry.url,
      type: (entry.transport !== 'stdio') ? entry.transport : undefined,
    }, -1);
  },

  _openForm(srv, idx) {
    if (!this._formOverlay) return;
    this._editingIndex = idx;
    this._formOverlay.style.display = '';

    const ftabs = Array.from(this._formOverlay.querySelectorAll('.mcp-form-tab'));
    ftabs.forEach((t, i) => t.classList.toggle('active', i === 0));
    const fieldsPane = document.getElementById('mcpFieldsPane');
    const jsonPane   = document.getElementById('mcpJsonPane');
    if (fieldsPane) fieldsPane.style.display = '';
    if (jsonPane)   jsonPane.style.display   = 'none';

    const titleEl = document.getElementById('mcpFormTitle');
    const saveBtn = document.getElementById('mcpFormSave');
    if (titleEl) titleEl.textContent = idx >= 0 ? 'Edit Server' : 'Add Server';
    if (saveBtn)  saveBtn.textContent = idx >= 0 ? 'Save changes' : 'Add to session';

    const nameEl    = document.getElementById('mcpFName');
    const cmdEl     = document.getElementById('mcpFCommand');
    const argsEl    = document.getElementById('mcpFArgs');
    const urlEl     = document.getElementById('mcpFUrl');
    if (nameEl) nameEl.value = srv.name || '';
    if (cmdEl)  cmdEl.value  = srv.command || '';
    if (argsEl) argsEl.value = (srv.args || []).join(' ');
    if (urlEl)  urlEl.value  = srv.url || '';

    const transport = srv.type || (srv.url && !srv.command ? 'http' : 'stdio');
    this._formOverlay.querySelectorAll('input[name=mcpTransport]').forEach(r => {
      r.checked = r.value === transport;
    });
    this._updateTransportFields(transport);

    this._renderKvList('mcpEnvVars', srv.env || {}, true);
    this._renderKvList('mcpHeaders', srv.headers || {}, false);
  },

  _updateTransportFields(transport) {
    const stdioEl = document.getElementById('mcpStdioFields');
    const httpEl  = document.getElementById('mcpHttpFields');
    if (stdioEl) stdioEl.style.display = transport === 'stdio' ? '' : 'none';
    if (httpEl)  httpEl.style.display  = transport === 'stdio' ? 'none' : '';
  },

  _renderKvList(containerId, obj, sensitive) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.textContent = '';
    Object.entries(obj).forEach(([k, v]) => this._addKvRow(container, k, v, sensitive));
  },

  _addKvRow(container, k, v, sensitive) {
    const row = document.createElement('div');
    row.className = 'mcp-kv-row';
    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.placeholder = 'KEY';
    keyInput.value = k;
    const valInput = document.createElement('input');
    valInput.type = sensitive ? 'password' : 'text';
    valInput.placeholder = 'value';
    valInput.value = v;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'mcp-kv-remove';
    removeBtn.textContent = '\u2715';
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(keyInput);
    row.appendChild(valInput);
    row.appendChild(removeBtn);
    container.appendChild(row);
  },

  _collectKvList(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return {};
    const result = {};
    container.querySelectorAll('.mcp-kv-row').forEach(row => {
      const inputs = row.querySelectorAll('input');
      const k = inputs[0]?.value?.trim();
      const v = inputs[1]?.value ?? '';
      if (k) result[k] = v;
    });
    return result;
  },

  _initForm() {
    if (!this._formOverlay) return;

    this._formOverlay.querySelectorAll('input[name=mcpTransport]').forEach(r => {
      r.addEventListener('change', () => this._updateTransportFields(r.value));
    });

    this._formOverlay.querySelectorAll('.mcp-form-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this._formOverlay.querySelectorAll('.mcp-form-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const isJson = tab.dataset.ftab === 'json';
        const fieldsPane = document.getElementById('mcpFieldsPane');
        const jsonPane   = document.getElementById('mcpJsonPane');
        if (fieldsPane) fieldsPane.style.display = isJson ? 'none' : '';
        if (jsonPane)   jsonPane.style.display   = isJson ? '' : 'none';
      });
    });

    document.getElementById('mcpAddEnvVar')?.addEventListener('click', () => {
      const container = document.getElementById('mcpEnvVars');
      if (container) this._addKvRow(container, '', '', true);
    });
    document.getElementById('mcpAddHeader')?.addEventListener('click', () => {
      const container = document.getElementById('mcpHeaders');
      if (container) this._addKvRow(container, '', '', false);
    });

    document.getElementById('mcpJsonInput')?.addEventListener('blur', () => this._parseJsonPaste());
    document.getElementById('mcpFormSave')?.addEventListener('click', () => this._saveForm());
    document.getElementById('mcpFormCancel')?.addEventListener('click', () => this._closeForm());
    document.getElementById('mcpFormClose')?.addEventListener('click', () => this._closeForm());
  },

  _parseJsonPaste() {
    const input = document.getElementById('mcpJsonInput');
    const errEl  = document.getElementById('mcpJsonError');
    if (!input || !errEl) return;
    const raw = input.value.trim();
    if (!raw) return;
    try {
      let parsed = JSON.parse(raw);
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const entries = Object.entries(parsed.mcpServers);
        if (entries.length) {
          const [firstName, firstEntry] = entries[0];
          parsed = Object.assign({ name: firstName }, firstEntry);
        }
      }
      errEl.style.display = 'none';
      const nameEl = document.getElementById('mcpFName');
      const cmdEl  = document.getElementById('mcpFCommand');
      const argsEl = document.getElementById('mcpFArgs');
      const urlEl  = document.getElementById('mcpFUrl');
      if (nameEl) nameEl.value = parsed.name || '';
      if (cmdEl)  cmdEl.value  = parsed.command || '';
      if (argsEl) argsEl.value = (parsed.args || []).join(' ');
      if (urlEl)  urlEl.value  = parsed.url || '';
      const transport = parsed.type || (parsed.url ? 'http' : 'stdio');
      this._formOverlay.querySelectorAll('input[name=mcpTransport]').forEach(r => {
        r.checked = r.value === transport;
      });
      this._updateTransportFields(transport);
      if (parsed.env)     this._renderKvList('mcpEnvVars', parsed.env, true);
      if (parsed.headers) this._renderKvList('mcpHeaders', parsed.headers, false);
    } catch (_e) {
      errEl.textContent = 'Invalid JSON \u2014 check format';
      errEl.style.display = '';
    }
  },

  _saveForm() {
    const nameEl = document.getElementById('mcpFName');
    if (!nameEl) return;
    const name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    const transport = this._formOverlay?.querySelector('input[name=mcpTransport]:checked')?.value || 'stdio';
    const server = { name, enabled: true };
    if (transport === 'stdio') {
      const cmd  = document.getElementById('mcpFCommand')?.value.trim();
      const args = document.getElementById('mcpFArgs')?.value.trim();
      if (cmd) server.command = cmd;
      server.args = args ? args.split(/\s+/) : [];
      const env = this._collectKvList('mcpEnvVars');
      if (Object.keys(env).length) server.env = env;
    } else {
      server.type = transport;
      const url = document.getElementById('mcpFUrl')?.value.trim();
      if (url) server.url = url;
      const headers = this._collectKvList('mcpHeaders');
      if (Object.keys(headers).length) server.headers = headers;
    }
    if (this._editingIndex >= 0) {
      this._draftServers[this._editingIndex] = server;
    } else {
      this._draftServers.push(server);
    }
    this._markDirty();
    this._renderActiveList();
    this._updateChipBadge();
    this._closeForm();
  },

  _closeForm() {
    if (this._formOverlay) this._formOverlay.style.display = 'none';
  },
};
```

**Step 3: Initialize McpPanel in the App constructor**

Find the constructor `init()` or `constructor()` where TranscriptView and other components are initialized, and add:

```javascript
McpPanel.init();
```

**Step 4: Call `McpPanel.showForSession(sessionId)` when a session tab is activated**

Find the method that switches the active session (look for `this.activeSessionId =` or `setActiveSession`) and add:

```javascript
McpPanel.showForSession(sessionId);
```

**Step 5: Add `SESSION_MCP_RESTARTED` to `constants.js`**

Run: `grep -n "SESSION_MCP\|SSE_EVENTS" src/web/public/constants.js | head -10`

In the `SSE_EVENTS` object, add:
```javascript
SESSION_MCP_RESTARTED: 'session:mcpRestarted',
```

**Step 6: Handle the SSE event in `app.js`**

Find the SSE event switch/if-else block and add:

```javascript
} else if (eventType === SSE_EVENTS.SESSION_MCP_RESTARTED) {
  if (data.sessionId === this.activeSessionId) {
    McpPanel._loadServers();
  }
```

**Step 7: Bump `app.js?v=` and `constants.js?v=` in `index.html`**

**Step 8: Commit**

```bash
git add src/web/public/app.js src/web/public/constants.js src/web/public/index.html
git commit -m "feat(mcp): add McpPanel JS — panel, form, library, marketplace tabs"
```

---

## Task 10: Playwright smoke test

**Files:**
- Create: `/tmp/playwright-mcp-test.js` (temp, auto-cleaned)

**Step 1: Start dev server** (in separate terminal)

Run: `npx tsx src/index.ts web`

**Step 2: Write verification script to /tmp**

```javascript
const { chromium } = require('playwright');
const TARGET_URL = 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Check MCP chip exists (hidden initially, no session selected)
  const chipExists = await page.$('#mcpChipBtn') !== null;
  console.log('Chip DOM exists:', chipExists ? 'PASS' : 'FAIL');

  // Check MCP panel exists
  const panelExists = await page.$('#mcpPanel') !== null;
  console.log('Panel DOM exists:', panelExists ? 'PASS' : 'FAIL');

  // Check library API
  const libRes = await page.request.get(TARGET_URL + '/api/mcp/library');
  const libOk = libRes.status() === 200;
  const libBody = await libRes.json().catch(() => null);
  console.log('Library API:', libOk && Array.isArray(libBody) ? 'PASS (' + libBody.length + ' entries)' : 'FAIL');

  if (errors.length) console.log('JS Errors:', errors);
  else console.log('No JS errors: PASS');

  await browser.close();
})();
```

**Step 3: Run from skill directory**

```bash
SKILL_DIR=~/.claude/plugins/cache/playwright-skill/playwright-skill/4.1.0/skills/playwright-skill
cd "$SKILL_DIR" && node run.js /tmp/playwright-mcp-test.js
```

Expected output: all PASS, 0 JS errors.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat(mcp): MCP server management complete"
```

---

## Summary

| Task | Scope |
|------|-------|
| 1 | `McpServerEntry` type + `SessionState` fields |
| 2 | Persist in `session.ts` |
| 3 | Extract resume ID from transcript filename |
| 4 | CLI builder: `--mcp-config` / `--resume` flags |
| 5 | API routes: GET/PUT servers, POST restart, library, marketplace |
| 6 | Curated library file (`src/mcp-library.ts`) |
| 7 | HTML markup for panel, chip, form |
| 8 | CSS for all MCP components |
| 9 | `McpPanel` JS object + constants.js SSE event |
| 10 | Playwright smoke test |

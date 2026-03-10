# Plugin Management UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Plugins" chip + slide-in panel to Codeman that lets users install/remove plugins from a curated library, and enable/disable individual skills per project — mirroring the existing MCP panel UX.

**Architecture:** New `src/plugin-library.ts` (curated list) + `src/web/routes/plugin-routes.ts` (7 API endpoints) wired into `server.ts`/`routes/index.ts`. Frontend: `PluginsPanel` singleton in `app.js` (after `McpPanel`), HTML panel added to `index.html`, CSS in `styles.css`. Skill disables stored in `~/.codeman/settings.json` under `disabledSkills` keyed by project path. The existing `discoverCommands()` in `commands-routes.ts` gains a filter step for disabled skills.

**Tech Stack:** TypeScript (ESM, strict), Fastify, vanilla JS frontend, `child_process.spawn` for `claude plugin` CLI calls, `~/.claude/plugins/installed_plugins.json` for plugin registry.

---

## Task 1: Create `src/plugin-library.ts`

**Files:**
- Create: `src/plugin-library.ts`

**Step 1: Write the file**

```typescript
/**
 * @fileoverview Curated plugin library.
 * Static list served at GET /api/plugins/library.
 * To add a plugin: append an entry and commit.
 */

export interface PluginLibraryEntry {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  installName: string; // passed to `claude plugin install`
}

export const PLUGIN_LIBRARY: PluginLibraryEntry[] = [
  {
    id: 'superpowers',
    name: 'superpowers',
    description: 'Core skills library — TDD, debugging, planning, git worktrees and more',
    keywords: ['skills', 'tdd', 'debugging', 'planning'],
    installName: 'superpowers',
  },
  {
    id: 'gsd',
    name: 'gsd',
    description: 'Get Stuff Done — structured project planning and execution workflow',
    keywords: ['workflow', 'planning', 'project'],
    installName: 'gsd',
  },
  {
    id: 'claude-plugins-official',
    name: 'claude-plugins-official',
    description: 'Official Claude plugin collection — frontend-design, playwright, and more',
    keywords: ['official', 'design', 'playwright'],
    installName: 'claude-plugins-official',
  },
];
```

**Step 2: Verify TypeScript compiles**

```bash
cd /home/siggi/sources/Codeman-feat-ui-overhaul
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 3: Commit**

```bash
git add src/plugin-library.ts
git commit -m "feat(plugins): add curated plugin library"
```

---

## Task 2: Create `src/web/routes/plugin-routes.ts`

**Files:**
- Create: `src/web/routes/plugin-routes.ts`

This module provides 7 endpoints. Plugin installation spawns `claude plugin install <name>` as a subprocess. Skill disables are stored in `~/.codeman/settings.json` under key `disabledSkills`.

**Step 1: Write the file**

```typescript
/**
 * @fileoverview Plugin management routes.
 *
 * Endpoints:
 *   GET  /api/plugins                       — list installed plugins (enriched with metadata)
 *   POST /api/plugins/install               — install a plugin via `claude plugin install`
 *   DELETE /api/plugins/:encodedName        — uninstall a plugin via `claude plugin uninstall`
 *   GET  /api/plugins/library               — curated plugin list
 *   GET  /api/plugins/skills                — all skills from installed plugins
 *   GET  /api/plugins/skills/disabled       — get disabled skills (optionally ?project=<path>)
 *   PUT  /api/plugins/skills/disabled       — update disabled skills for a project
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { PLUGIN_LIBRARY } from '../../plugin-library.js';
import { SETTINGS_PATH } from '../route-helpers.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface PluginInstallEntry {
  scope: 'user' | 'project';
  projectPath?: string;
  installPath: string;
  version?: string;
  installedAt?: string;
}

interface InstalledPluginsJson {
  version?: number;
  plugins: Record<string, PluginInstallEntry[]>;
}

interface PluginMeta {
  name: string;
  description?: string;
  version?: string;
  author?: { name?: string; email?: string } | string;
  keywords?: string[];
}

interface InstalledPlugin {
  key: string;         // registry key e.g. "superpowers@superpowers-marketplace"
  pluginName: string;  // name portion before @
  installPath: string;
  scope: 'user' | 'project';
  projectPath?: string;
  version?: string;
  installedAt?: string;
  meta: PluginMeta;
}

interface SkillEntry {
  pluginName: string;
  skillName: string;
  fullName: string;  // e.g. "superpowers:brainstorming"
  description: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const PLUGINS_FILE = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

function readPluginsJson(): InstalledPluginsJson {
  try {
    return JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8')) as InstalledPluginsJson;
  } catch {
    return { plugins: {} };
  }
}

function readPluginMeta(installPath: string): PluginMeta {
  try {
    const metaPath = path.join(installPath, '.claude-plugin', 'plugin.json');
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as PluginMeta;
  } catch {
    return { name: path.basename(installPath) };
  }
}

function listInstalledPlugins(): InstalledPlugin[] {
  const data = readPluginsJson();
  const seen = new Set<string>();
  const result: InstalledPlugin[] = [];
  for (const [key, entries] of Object.entries(data.plugins ?? {})) {
    const pluginName = key.split('@')[0];
    for (const entry of entries) {
      if (seen.has(entry.installPath)) continue;
      seen.add(entry.installPath);
      result.push({
        key,
        pluginName,
        installPath: entry.installPath,
        scope: entry.scope,
        projectPath: entry.projectPath,
        version: entry.version,
        installedAt: entry.installedAt,
        meta: readPluginMeta(entry.installPath),
      });
    }
  }
  return result;
}

function listAllSkills(): SkillEntry[] {
  const plugins = listInstalledPlugins();
  const skills: SkillEntry[] = [];
  for (const plugin of plugins) {
    const skillsDir = path.join(plugin.installPath, 'skills');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let content = '';
      try {
        content = fs.readFileSync(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf-8');
      } catch {
        continue;
      }
      // Parse description from frontmatter
      let description = '';
      if (content.startsWith('---')) {
        const end = content.indexOf('\n---', 3);
        if (end !== -1) {
          const fm = content.slice(3, end);
          description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
        }
      }
      const skillName = entry.name;
      skills.push({
        pluginName: plugin.pluginName,
        skillName,
        fullName: `${plugin.pluginName}:${skillName}`,
        description,
      });
    }
  }
  return skills;
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function getDisabledSkills(settings: Record<string, unknown>): Record<string, string[]> {
  const raw = settings.disabledSkills;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, string[]>;
  }
  return {};
}

/** Run `claude plugin <subcommand> <arg>` and resolve with { ok, output }. */
function runClaudePlugin(subcommand: string, arg: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['plugin', subcommand, arg], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => chunks.push(d));
    proc.on('close', (code) => {
      resolve({ ok: code === 0, output: Buffer.concat(chunks).toString('utf-8').trim() });
    });
    proc.on('error', (err) => {
      resolve({ ok: false, output: err.message });
    });
  });
}

// ── Route registration ─────────────────────────────────────────────────────

export async function registerPluginRoutes(app: FastifyInstance): Promise<void> {
  // GET installed plugins
  app.get('/api/plugins', async (_req, reply) => {
    return reply.send(listInstalledPlugins());
  });

  // POST install a plugin
  app.post('/api/plugins/install', async (req, reply) => {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'name is required'));
    }
    const result = await runClaudePlugin('install', name.trim());
    if (!result.ok) {
      return reply.code(500).send(createErrorResponse(ApiErrorCode.INTERNAL_ERROR, result.output || 'Install failed'));
    }
    return reply.send({ ok: true, output: result.output });
  });

  // DELETE uninstall a plugin
  app.delete('/api/plugins/:encodedName', async (req, reply) => {
    const { encodedName } = req.params as { encodedName: string };
    const name = decodeURIComponent(encodedName);
    const result = await runClaudePlugin('uninstall', name);
    if (!result.ok) {
      return reply.code(500).send(createErrorResponse(ApiErrorCode.INTERNAL_ERROR, result.output || 'Uninstall failed'));
    }
    return reply.send({ ok: true });
  });

  // GET curated library
  app.get('/api/plugins/library', async (_req, reply) => {
    return reply.send(PLUGIN_LIBRARY);
  });

  // GET all skills from installed plugins
  app.get('/api/plugins/skills', async (_req, reply) => {
    return reply.send(listAllSkills());
  });

  // GET disabled skills (optional ?project=<path> query param)
  app.get('/api/plugins/skills/disabled', async (req, reply) => {
    const { project } = req.query as { project?: string };
    const settings = readSettings();
    const disabledSkills = getDisabledSkills(settings);
    const key = project || '__global__';
    return reply.send({ project: key, disabled: disabledSkills[key] ?? [] });
  });

  // PUT disabled skills for a project
  app.put('/api/plugins/skills/disabled', async (req, reply) => {
    const { project, disabled } = req.body as { project?: string; disabled?: unknown };
    if (!Array.isArray(disabled)) {
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'disabled must be an array'));
    }
    const key = (typeof project === 'string' && project) ? project : '__global__';
    const settings = readSettings();
    const disabledSkills = getDisabledSkills(settings);
    disabledSkills[key] = disabled.filter((s): s is string => typeof s === 'string');
    settings.disabledSkills = disabledSkills;
    writeSettings(settings);
    return reply.send({ ok: true });
  });
}
```

**Step 2: Type-check**

```bash
cd /home/siggi/sources/Codeman-feat-ui-overhaul
npx tsc --noEmit 2>&1 | head -20
```
Expected: no new errors

**Step 3: Commit**

```bash
git add src/web/routes/plugin-routes.ts
git commit -m "feat(plugins): add plugin API routes"
```

---

## Task 3: Wire plugin routes into server

**Files:**
- Modify: `src/web/routes/index.ts`
- Modify: `src/web/server.ts`

**Step 1: Add export to `src/web/routes/index.ts`**

Append to the end of the file (after line 21):

```typescript
export { registerPluginRoutes } from './plugin-routes.js';
```

**Step 2: Import and call in `src/web/server.ts`**

In the import block at line ~109 (where `registerMcpRoutes` is imported), add:
```typescript
  registerPluginRoutes,
```
(Add it after `registerMcpRoutes,` on line 113.)

At line ~733 (where `registerMcpRoutes` is called), add below it:
```typescript
    await registerPluginRoutes(this.app);
```

**Step 3: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 4: Smoke-test the endpoints**

Start dev server:
```bash
npx tsx src/index.ts web &
sleep 2
curl -s localhost:3000/api/plugins | jq 'length'
curl -s localhost:3000/api/plugins/library | jq '.[0].name'
curl -s localhost:3000/api/plugins/skills | jq 'length'
curl -s "localhost:3000/api/plugins/skills/disabled?project=/tmp/test" | jq
kill %1
```
Expected: numeric counts (may be 0 if no plugins installed), library returns `"superpowers"`, disabled returns `{ project: "/tmp/test", disabled: [] }`.

**Step 5: Commit**

```bash
git add src/web/routes/index.ts src/web/server.ts
git commit -m "feat(plugins): wire plugin routes into server"
```

---

## Task 4: Filter disabled skills in `discoverCommands()`

**Files:**
- Modify: `src/web/routes/commands-routes.ts`

The `discoverCommands()` function currently returns all plugin skills regardless of disable list. We need to filter out skills disabled for the session's project.

**Step 1: Write a test first**

Open `test/routes/commands-routes.test.ts` and add a test (pick a port not already used — search `const PORT =` first to confirm `3095` is free):

```typescript
it('filters disabled skills for project', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cmtest-'));
  // Set up a fake plugin with one skill
  const pluginDir = path.join(tmpHome, '.claude', 'plugins', 'cache', 'test', 'myplugin', '1.0.0');
  await fs.mkdir(path.join(pluginDir, 'skills', 'my-skill'), { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'skills', 'my-skill', 'SKILL.md'),
    '---\nname: my-skill\ndescription: A skill\n---\n');
  await fs.writeFile(
    path.join(tmpHome, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'myplugin@test': [{ scope: 'user', installPath: pluginDir }] } })
  );
  // Disable that skill for /my/project
  const codemandDir = path.join(tmpHome, '.codeman');
  await fs.mkdir(codemandDir, { recursive: true });
  await fs.writeFile(
    path.join(codemandDir, 'settings.json'),
    JSON.stringify({ disabledSkills: { '/my/project': ['myplugin:my-skill'] } })
  );

  const commands = discoverCommands('/my/project', tmpHome);
  expect(commands.find(c => c.cmd === '/myplugin:my-skill')).toBeUndefined();

  // But skill shows up for other projects
  const otherCommands = discoverCommands('/other/project', tmpHome);
  expect(otherCommands.find(c => c.cmd === '/myplugin:my-skill')).toBeDefined();

  await fs.rm(tmpHome, { recursive: true });
});
```

**Step 2: Run test to confirm it fails**

```bash
npx vitest run test/routes/commands-routes.test.ts 2>&1 | tail -20
```
Expected: FAIL (the filter doesn't exist yet)

**Step 3: Implement the filter**

In `src/web/routes/commands-routes.ts`, add a helper after `applicablePluginPaths()`:

```typescript
/** Read disabled skill names for a given project path from ~/.codeman/settings.json. */
function disabledSkillsForProject(cwd: string, userHomeOverride?: string): Set<string> {
  const settingsPath = path.join(userHomeOverride ?? os.homedir(), '.codeman', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    const raw = settings.disabledSkills;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Set();
    const map = raw as Record<string, string[]>;
    const global_ = map['__global__'] ?? [];
    const project = map[cwd] ?? [];
    return new Set([...global_, ...project]);
  } catch {
    return new Set();
  }
}
```

Then in `discoverCommands()`, after building the commands array, add a filter step before `return commands`:

```typescript
  // Filter out disabled skills
  const disabled = disabledSkillsForProject(cwd, userHomeOverride);
  if (disabled.size > 0) {
    return commands.filter(cmd => {
      // Only filter plugin skills (namespaced with colon)
      if (cmd.source !== 'plugin') return true;
      const bare = cmd.cmd.startsWith('/') ? cmd.cmd.slice(1) : cmd.cmd;
      return !disabled.has(bare);
    });
  }
  return commands;
```

**Step 4: Run test to confirm it passes**

```bash
npx vitest run test/routes/commands-routes.test.ts 2>&1 | tail -20
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/web/routes/commands-routes.ts test/routes/commands-routes.test.ts
git commit -m "feat(plugins): filter disabled skills in discoverCommands"
```

---

## Task 5: Add Plugin chip and panel HTML to `index.html`

**Files:**
- Modify: `src/web/public/index.html`

**Step 1: Add the chip button**

Find the MCP chip button (line ~89):
```html
        <button id="mcpChipBtn" class="mcp-chip" title="MCP Servers" style="display:none" aria-label="MCP Servers">
```

Insert the Plugins chip **after** the closing `</button>` of the MCP chip (after line 93):

```html
        <button id="pluginsChipBtn" class="mcp-chip plugins-chip" title="Plugins" style="display:none" aria-label="Plugins">
          <span class="mcp-chip-icon">&#x25a6;</span>
          <span class="mcp-chip-label">Plugins</span>
          <span class="mcp-chip-badge" style="display:none"></span>
        </button>
```

**Step 2: Add the panel HTML**

Find the MCP panel comment (line ~2025):
```html
<!-- MCP Server Management Panel -->
```

Insert the Plugins panel **before** that comment:

```html
<!-- Plugin Management Panel -->
<div id="pluginsPanel" class="mcp-panel plugins-panel" style="display:none" aria-label="Plugins">
  <div class="mcp-panel-header">
    <span class="mcp-panel-title">&#x25a6; Plugins</span>
    <button class="mcp-panel-close" id="pluginsPanelClose" title="Close">&#x2715;</button>
  </div>
  <!-- Tabs -->
  <div class="mcp-tabs" id="pluginsTabs">
    <button class="mcp-tab active" data-ptab="active">Active</button>
    <button class="mcp-tab" data-ptab="library">Library</button>
    <button class="mcp-tab" data-ptab="skills">Skills</button>
  </div>

  <!-- Active tab -->
  <div id="pluginsActivePane" class="mcp-pane">
    <div id="pluginsActiveList" class="mcp-active-list">
      <div class="mcp-empty-state" id="pluginsEmptyState">No plugins installed. Browse the Library tab.</div>
    </div>
    <div class="mcp-section-label" style="margin-top:12px">Install from name or URL</div>
    <div class="plugins-install-row">
      <input type="text" class="mcp-search" id="pluginsInstallInput" placeholder="superpowers or https://..." autocomplete="off">
      <button class="mcp-btn-apply plugins-install-btn" id="pluginsInstallBtn">Install</button>
    </div>
    <div id="pluginsInstallStatus" class="plugins-install-status" style="display:none"></div>
  </div>

  <!-- Library tab -->
  <div id="pluginsLibraryPane" class="mcp-pane" style="display:none">
    <div id="pluginsLibraryList" class="mcp-library-grid"></div>
    <div class="plugins-footer-link">
      <a href="https://claude.ai/plugins" target="_blank" rel="noopener">Browse more plugins &#x2197;</a>
    </div>
  </div>

  <!-- Skills tab -->
  <div id="pluginsSkillsPane" class="mcp-pane" style="display:none">
    <div class="mcp-section-label">Project</div>
    <select id="pluginsProjectSelect" class="plugins-project-select"></select>
    <div id="pluginsSkillsList" class="plugins-skills-list"></div>
  </div>
</div>

```

**Step 3: Bump version strings**

In `index.html`:
- Change `styles.css?v=0.1679` → `styles.css?v=0.1680`
- Change `app.js?v=0.4.91` → `app.js?v=0.4.92`

**Step 4: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat(plugins): add plugin chip and panel HTML"
```

---

## Task 6: Add CSS styles to `styles.css`

**Files:**
- Modify: `src/web/public/styles.css`

Find the end of the MCP styles section. Search for `/* ── End MCP ──` or find the last `.mcp-` rule. Append the following styles **after** all existing MCP styles:

```css
/* ── Plugins Panel ────────────────────────────────────────────────────── */

.plugins-chip {
  border-color: rgba(168, 85, 247, 0.35);
  background: rgba(168, 85, 247, 0.08);
  color: #c084fc;
}
.plugins-chip:hover, .plugins-chip.active {
  background: rgba(168, 85, 247, 0.22);
  border-color: rgba(168, 85, 247, 0.6);
}

.plugins-panel {
  z-index: 601;
}

.plugins-install-row {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.plugins-install-row .mcp-search {
  flex: 1;
  margin: 0;
}
.plugins-install-btn {
  flex-shrink: 0;
  padding: 6px 12px;
  font-size: 0.75rem;
}

.plugins-install-status {
  font-size: 0.72rem;
  color: #94a3b8;
  padding: 4px 2px;
  white-space: pre-wrap;
  word-break: break-all;
}
.plugins-install-status.error { color: #f87171; }
.plugins-install-status.success { color: #4ade80; }

/* Plugin card — reuses mcp-server-card with small additions */
.plugin-card-avatar {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
  flex-shrink: 0;
  color: #fff;
}

.plugin-card-scope {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
}
.plugin-card-scope.user {
  background: rgba(59, 130, 246, 0.15);
  color: #93c5fd;
}
.plugin-card-scope.project {
  background: rgba(234, 179, 8, 0.15);
  color: #fbbf24;
}

.plugin-card-version {
  font-size: 0.62rem;
  color: #475569;
}

/* Library card keywords */
.plugins-lib-keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.plugins-footer-link {
  padding: 10px 2px 4px;
  text-align: center;
}
.plugins-footer-link a {
  font-size: 0.72rem;
  color: #475569;
  text-decoration: none;
}
.plugins-footer-link a:hover { color: #94a3b8; }

/* Skills tab */
.plugins-project-select {
  width: 100%;
  background: #1e293b;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  color: #e2e8f0;
  padding: 6px 8px;
  font-size: 0.78rem;
  margin-bottom: 10px;
  outline: none;
}
.plugins-project-select:focus { border-color: rgba(168,85,247,0.5); }

.plugins-skills-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.plugins-skill-group-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #475569;
  padding: 8px 0 4px;
  font-weight: 600;
}

.plugins-skill-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 5px;
  background: rgba(255,255,255,0.02);
}
.plugins-skill-row:hover { background: rgba(255,255,255,0.04); }

.plugins-skill-name {
  flex: 1;
  font-size: 0.75rem;
  color: #94a3b8;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.plugins-skill-desc {
  font-size: 0.68rem;
  color: #475569;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}
```

**Step 2: Commit**

```bash
git add src/web/public/styles.css
git commit -m "feat(plugins): add plugin panel CSS"
```

---

## Task 7: Implement `PluginsPanel` in `app.js`

**Files:**
- Modify: `src/web/public/app.js`

**Step 1: Insert `PluginsPanel` object after `McpPanel` ends (after line 769)**

The `McpPanel` object ends at line 769 (`};`). Insert the following **after line 769**:

```javascript
// Plugins Panel
// ===================================================================
const PluginsPanel = {
  _sessionId: null,
  _library: [],
  _skills: [],
  _projectPaths: [],   // known project paths from sessions
  _selectedProject: '__global__',
  _disabledMap: {},    // { [project]: Set<string> }

  init() {
    this._panel        = document.getElementById('pluginsPanel');
    this._chip         = document.getElementById('pluginsChipBtn');
    this._tabs         = this._panel ? Array.from(this._panel.querySelectorAll('[data-ptab]')) : [];
    this._activePane   = document.getElementById('pluginsActivePane');
    this._libraryPane  = document.getElementById('pluginsLibraryPane');
    this._skillsPane   = document.getElementById('pluginsSkillsPane');
    this._activeList   = document.getElementById('pluginsActiveList');
    this._libraryList  = document.getElementById('pluginsLibraryList');
    this._skillsList   = document.getElementById('pluginsSkillsList');
    this._installInput = document.getElementById('pluginsInstallInput');
    this._installBtn   = document.getElementById('pluginsInstallBtn');
    this._installStatus= document.getElementById('pluginsInstallStatus');
    this._projectSelect= document.getElementById('pluginsProjectSelect');
    if (!this._panel) return;

    document.getElementById('pluginsPanelClose')?.addEventListener('click', () => this.close());
    this._chip?.addEventListener('click', () => this.toggle());
    this._installBtn?.addEventListener('click', () => this._installPlugin());
    this._installInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._installPlugin(); });
    this._projectSelect?.addEventListener('change', () => {
      this._selectedProject = this._projectSelect.value;
      this._renderSkills();
    });

    this._tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this._tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const pane = tab.dataset.ptab;
        this._activePane.style.display  = pane === 'active' ? '' : 'none';
        this._libraryPane.style.display = pane === 'library' ? '' : 'none';
        this._skillsPane.style.display  = pane === 'skills' ? '' : 'none';
        if (pane === 'library' && !this._library.length) this._loadLibrary();
        if (pane === 'skills' && !this._skills.length) this._loadSkills();
      });
    });

    this._loadLibrary();
  },

  open(sessionId) {
    this._sessionId = sessionId;
    // Close MCP panel if open
    if (McpPanel._panel?.classList.contains('open')) McpPanel.close();
    this._panel.style.display = '';
    requestAnimationFrame(() => this._panel.classList.add('open'));
    this._chip?.classList.add('active');
    this._loadInstalled();
  },

  close() {
    this._panel.classList.remove('open');
    this._chip?.classList.remove('active');
    const panel = this._panel;
    setTimeout(() => { if (!panel.classList.contains('open')) panel.style.display = 'none'; }, 260);
  },

  toggle() {
    if (this._panel.classList.contains('open')) this.close();
    else this.open(this._sessionId);
  },

  showChip() {
    if (this._chip) this._chip.style.display = '';
    this._loadInstalled();
  },

  hideChip() {
    if (!this._chip) return;
    this._chip.style.display = 'none';
    this.close();
  },

  // ── Data loading ──────────────────────────────────────────────────

  async _loadInstalled() {
    try {
      const res = await fetch('/api/plugins');
      if (!res.ok) return;
      const plugins = await res.json();
      this._renderActiveList(plugins);
      this._updateChipBadge(plugins.length);
    } catch (_e) { /* network */ }
  },

  async _loadLibrary() {
    try {
      const res = await fetch('/api/plugins/library');
      if (res.ok) { this._library = await res.json(); this._renderLibrary(); }
    } catch (_e) { /* offline */ }
  },

  async _loadSkills() {
    try {
      const [skillsRes, disabledRes] = await Promise.all([
        fetch('/api/plugins/skills'),
        fetch('/api/plugins/skills/disabled'),
      ]);
      if (skillsRes.ok) this._skills = await skillsRes.json();
      if (disabledRes.ok) {
        const d = await disabledRes.json();
        this._disabledMap['__global__'] = new Set(d.disabled);
      }
      // Collect known project paths from sessions
      this._projectPaths = [];
      if (app.sessions) {
        for (const s of app.sessions.values()) {
          if (s.workingDir && !this._projectPaths.includes(s.workingDir)) {
            this._projectPaths.push(s.workingDir);
          }
        }
      }
      this._populateProjectSelect();
      this._renderSkills();
    } catch (_e) { /* offline */ }
  },

  // ── Install / uninstall ───────────────────────────────────────────

  async _installPlugin() {
    const name = this._installInput?.value.trim();
    if (!name) { this._installInput?.focus(); return; }
    if (this._installBtn) { this._installBtn.disabled = true; this._installBtn.textContent = 'Installing\u2026'; }
    this._showInstallStatus('', '');
    try {
      const res = await fetch('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        this._showInstallStatus(data.message || 'Install failed', 'error');
      } else {
        this._showInstallStatus('\u2713 Installed: ' + name, 'success');
        if (this._installInput) this._installInput.value = '';
        this._loadInstalled();
      }
    } catch (_e) {
      this._showInstallStatus('Network error', 'error');
    } finally {
      if (this._installBtn) { this._installBtn.disabled = false; this._installBtn.textContent = 'Install'; }
    }
  },

  async _uninstallPlugin(pluginName) {
    if (!confirm('Uninstall plugin "' + pluginName + '"?')) return;
    try {
      const res = await fetch('/api/plugins/' + encodeURIComponent(pluginName), { method: 'DELETE' });
      if (res.ok) this._loadInstalled();
    } catch (_e) { /* network */ }
  },

  _showInstallStatus(msg, type) {
    if (!this._installStatus) return;
    this._installStatus.textContent = msg;
    this._installStatus.className = 'plugins-install-status' + (type ? ' ' + type : '');
    this._installStatus.style.display = msg ? '' : 'none';
  },

  // ── Rendering ─────────────────────────────────────────────────────

  _updateChipBadge(count) {
    const badge = this._chip?.querySelector('.mcp-chip-badge');
    if (!badge) return;
    badge.style.display = count > 0 ? '' : 'none';
    badge.textContent = String(count);
  },

  _renderActiveList(plugins) {
    if (!this._activeList) return;
    this._activeList.textContent = '';
    if (!plugins.length) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty-state';
      empty.textContent = 'No plugins installed. Browse the Library tab.';
      this._activeList.appendChild(empty);
      return;
    }
    plugins.forEach(p => {
      const card = document.createElement('div');
      card.className = 'mcp-server-card';

      // Avatar (colored by plugin name)
      const colors = ['#3b82f6','#a855f7','#22c55e','#f97316','#ec4899','#eab308','#06b6d4'];
      const colorIdx = p.pluginName.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length;
      const avatar = document.createElement('div');
      avatar.className = 'plugin-card-avatar';
      avatar.style.background = colors[colorIdx] + '33';
      avatar.style.color = colors[colorIdx];
      avatar.textContent = (p.pluginName[0] || '?').toUpperCase();

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';

      const nameRow = document.createElement('div');
      nameRow.style.cssText = 'display:flex;align-items:center;gap:5px;flex-wrap:wrap';

      const nameEl = document.createElement('div');
      nameEl.className = 'mcp-server-name';
      nameEl.textContent = p.pluginName;

      const scopeBadge = document.createElement('span');
      scopeBadge.className = 'plugin-card-scope ' + (p.scope || 'user');
      scopeBadge.textContent = p.scope === 'project' ? 'Project' : 'User';

      const versionEl = document.createElement('span');
      versionEl.className = 'plugin-card-version';
      versionEl.textContent = p.version ? 'v' + p.version : '';

      nameRow.appendChild(nameEl);
      nameRow.appendChild(scopeBadge);
      nameRow.appendChild(versionEl);

      const desc = document.createElement('div');
      desc.className = 'mcp-server-cmd';
      desc.textContent = p.meta?.description || p.installPath || '';

      info.appendChild(nameRow);
      info.appendChild(desc);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'mcp-server-remove';
      removeBtn.title = 'Uninstall';
      removeBtn.textContent = '\u2715';
      removeBtn.addEventListener('click', () => this._uninstallPlugin(p.pluginName));

      card.appendChild(avatar);
      card.appendChild(info);
      card.appendChild(removeBtn);
      this._activeList.appendChild(card);
    });
  },

  _renderLibrary() {
    if (!this._libraryList) return;
    this._libraryList.textContent = '';
    this._library.forEach(entry => {
      const card = document.createElement('div');
      card.className = 'mcp-lib-card';

      const hdr = document.createElement('div');
      hdr.className = 'mcp-lib-card-header';

      const name = document.createElement('span');
      name.className = 'mcp-lib-card-name';
      name.textContent = entry.name;

      const installBtn = document.createElement('button');
      installBtn.className = 'mcp-btn-apply plugins-install-btn';
      installBtn.style.cssText = 'padding:3px 8px;font-size:0.7rem';
      installBtn.textContent = 'Install \u2193';
      installBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._installInput) this._installInput.value = entry.installName;
        // Switch to Active tab and trigger install
        this._tabs.forEach(t => t.classList.remove('active'));
        const activeTab = this._tabs.find(t => t.dataset.ptab === 'active');
        if (activeTab) activeTab.classList.add('active');
        this._activePane.style.display = '';
        this._libraryPane.style.display = 'none';
        this._skillsPane.style.display = 'none';
        this._installPlugin();
      });

      hdr.appendChild(name);
      hdr.appendChild(installBtn);

      const desc = document.createElement('div');
      desc.className = 'mcp-lib-card-desc';
      desc.textContent = entry.description;

      const keywords = document.createElement('div');
      keywords.className = 'plugins-lib-keywords';
      (entry.keywords || []).forEach(kw => {
        const tag = document.createElement('span');
        tag.className = 'mcp-lib-card-cat';
        tag.textContent = kw;
        keywords.appendChild(tag);
      });

      card.appendChild(hdr);
      card.appendChild(desc);
      card.appendChild(keywords);
      this._libraryList.appendChild(card);
    });
  },

  _populateProjectSelect() {
    if (!this._projectSelect) return;
    this._projectSelect.textContent = '';
    const globalOpt = document.createElement('option');
    globalOpt.value = '__global__';
    globalOpt.textContent = 'Global (all projects)';
    this._projectSelect.appendChild(globalOpt);
    this._projectPaths.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p.replace(os?.homedir?.() || '', '~') || p;
      this._projectSelect.appendChild(opt);
    });
    this._projectSelect.value = this._selectedProject;
  },

  _renderSkills() {
    if (!this._skillsList) return;
    this._skillsList.textContent = '';
    if (!this._skills.length) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty-state';
      empty.textContent = 'No plugin skills found.';
      this._skillsList.appendChild(empty);
      return;
    }
    // Group by pluginName
    const groups = {};
    this._skills.forEach(s => {
      if (!groups[s.pluginName]) groups[s.pluginName] = [];
      groups[s.pluginName].push(s);
    });
    const projectKey = this._selectedProject;
    const projectDisabled = this._disabledMap[projectKey] ?? new Set();
    const globalDisabled = this._disabledMap['__global__'] ?? new Set();

    Object.entries(groups).forEach(([pluginName, skills]) => {
      const label = document.createElement('div');
      label.className = 'plugins-skill-group-label';
      label.textContent = pluginName;
      this._skillsList.appendChild(label);

      skills.forEach(skill => {
        const row = document.createElement('div');
        row.className = 'plugins-skill-row';

        const isDisabled = projectDisabled.has(skill.fullName) || globalDisabled.has(skill.fullName);
        const toggle = document.createElement('button');
        toggle.className = 'mcp-toggle' + (isDisabled ? '' : ' on');
        toggle.title = isDisabled ? 'Enable' : 'Disable';
        toggle.addEventListener('click', async () => {
          const nowDisabled = !toggle.classList.contains('on');
          if (!this._disabledMap[projectKey]) this._disabledMap[projectKey] = new Set();
          if (nowDisabled) {
            this._disabledMap[projectKey].add(skill.fullName);
          } else {
            this._disabledMap[projectKey].delete(skill.fullName);
          }
          toggle.classList.toggle('on', !nowDisabled);
          // Persist
          await fetch('/api/plugins/skills/disabled', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project: projectKey,
              disabled: Array.from(this._disabledMap[projectKey]),
            }),
          });
        });

        const nameEl = document.createElement('span');
        nameEl.className = 'plugins-skill-name';
        nameEl.textContent = skill.skillName;

        const descEl = document.createElement('span');
        descEl.className = 'plugins-skill-desc';
        descEl.textContent = skill.description;
        descEl.title = skill.description;

        row.appendChild(toggle);
        row.appendChild(nameEl);
        row.appendChild(descEl);
        this._skillsList.appendChild(row);
      });
    });
  },
};
```

**Step 2: Wire `PluginsPanel.init()` into the app init**

Find the line (around 1845):
```javascript
    McpPanel.init();
```
Add below it:
```javascript
    PluginsPanel.init();
```

**Step 3: Wire `PluginsPanel.showChip()` where sessions are shown**

Find where `McpPanel.showForSession(sessionId)` is called (search for it in app.js). Add after each call:
```javascript
    PluginsPanel.showChip();
```

Also find `McpPanel.hide()` calls and add after each:
```javascript
    PluginsPanel.hideChip();
```

**Step 4: Wire McpPanel to close when Plugins opens**

The `PluginsPanel.open()` already calls `McpPanel.close()` if open. We also need McpPanel.open() to close the plugins panel. Find `McpPanel.open()` (around line 376) and add at the start of the method body:

```javascript
    // Close Plugins panel if open
    if (typeof PluginsPanel !== 'undefined' && PluginsPanel._panel?.classList.contains('open')) PluginsPanel.close();
```

**Step 5: Type-check and lint (JS file, so just lint)**

```bash
npm run lint 2>&1 | grep plugin-routes -A3 | head -20
```
Expected: no new errors for plugin-related code

**Step 6: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat(plugins): implement PluginsPanel frontend"
```

---

## Task 8: Verify the full feature with Playwright

**Files:**
- None (verification only)

**Step 1: Start dev server**

```bash
npx tsx src/index.ts web &
sleep 2
```

**Step 2: Run Playwright verification**

```bash
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Create a session to make the chip visible
  const btn = page.locator('[title=\"New Session\"], .btn-new-session, button:has-text(\"New\")').first();
  if (await btn.count()) await btn.click();
  await page.waitForTimeout(1500);

  // Check chip exists (may be hidden until session is active)
  const chip = page.locator('#pluginsChipBtn');
  console.log('Chip exists:', await chip.count() > 0);

  // Check panel HTML is present
  const panel = page.locator('#pluginsPanel');
  console.log('Panel exists:', await panel.count() > 0);

  // Check library endpoint
  const libRes = await page.evaluate(() => fetch('/api/plugins/library').then(r => r.json()));
  console.log('Library entries:', libRes.length);

  // Check skills endpoint
  const skillsRes = await page.evaluate(() => fetch('/api/plugins/skills').then(r => r.json()));
  console.log('Skills entries:', skillsRes.length);

  await browser.close();
  process.exit(0);
})();
"
```
Expected: `Chip exists: true`, `Panel exists: true`, `Library entries: 3`, `Skills entries: <number>`

**Step 3: Kill dev server**

```bash
kill %1
```

---

## Task 9: Final cleanup and version bump

**Files:**
- Modify: `src/web/public/index.html` (already done in Task 5)

**Step 1: Confirm version strings were bumped**

```bash
grep -E "styles\.css\?v=|app\.js\?v=" src/web/public/index.html
```
Expected: `styles.css?v=0.1680` and `app.js?v=0.4.92`

**Step 2: Final typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```
Expected: no errors

**Step 3: Final commit**

```bash
git add -p
git commit -m "feat(plugins): plugin management panel — chip, active/library/skills tabs"
```

---

## Summary of Files Changed

| File | Change |
|------|--------|
| `src/plugin-library.ts` | NEW — curated library |
| `src/web/routes/plugin-routes.ts` | NEW — 7 API endpoints |
| `src/web/routes/index.ts` | +1 export |
| `src/web/server.ts` | +1 import, +1 route registration |
| `src/web/routes/commands-routes.ts` | Add `disabledSkillsForProject()` + filter |
| `test/routes/commands-routes.test.ts` | New test for skill filtering |
| `src/web/public/index.html` | Chip HTML + panel HTML + version bumps |
| `src/web/public/styles.css` | Plugin panel CSS |
| `src/web/public/app.js` | `PluginsPanel` singleton + init wiring |

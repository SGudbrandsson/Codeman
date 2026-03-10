# Plugin Management UI — Design

**Date**: 2026-03-10
**Branch**: feat/ui-overhaul

## Overview

A "Plugins" panel for Codeman that lets users browse, install, and manage Claude Code plugins and skills. Modeled after the existing MCP panel — same chip-in-header + slide-in-panel pattern, same color scheme.

Key distinction from MCP: plugins are **global** (user or project scope in `~/.claude/plugins/installed_plugins.json`), while skill disables are **per-project** (stored in `~/.codeman/settings.json`).

---

## Architecture

### Backend — `src/web/routes/plugin-routes.ts`

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/plugins` | Read `installed_plugins.json`, enrich with `plugin.json` metadata |
| `POST` | `/api/plugins/install` | Spawn `claude plugin install <url>`, stream stdout |
| `DELETE` | `/api/plugins/:encodedName` | Spawn `claude plugin uninstall <name>` |
| `GET` | `/api/plugins/library` | Return curated plugin list |
| `GET` | `/api/plugins/skills` | Scan all installed plugins, return full skill list |
| `GET` | `/api/plugins/skills/disabled?project=<path>` | Read per-project disabled list |
| `PUT` | `/api/plugins/skills/disabled` | Write per-project disabled list |

### Storage

Disabled skills stored in `~/.codeman/settings.json`:

```json
{
  "disabledSkills": {
    "__global__": [],
    "/home/siggi/sources/my-app": ["superpowers:brainstorming"]
  }
}
```

### Frontend — `PluginsPanel` singleton in `app.js`

- Chip: `#pluginsChipBtn` in session header, right of MCP chip
- Panel: `#pluginsPanel`, 320px wide, slides in from right, `z-index: 601`
- Opening Plugins closes MCP panel and vice versa

---

## UI Components

### Chip Button

Same styling as MCP chip but labeled "Plugins". Shows count badge with number of installed plugins. Cyan accent (`#22d3ee`) on active/hover state. Pulses once after a successful install.

### Panel Tabs

Three tabs: **Active** | **Library** | **Skills**

---

## Tab Designs

### Active Tab (default)

One **plugin card** per entry in `installed_plugins.json`:

- Letter avatar (colored by name hash from session color palette)
- Name + version badge + scope badge (`User` = blue, `Project` = amber)
- Description from `plugin.json`
- Project-scoped: shows truncated `projectPath`
- **Remove** button — red on hover, confirms before calling `claude plugin uninstall`

**Install from URL** row at bottom: text input + "Install" button. During install: spinner + last line of stdout. On success: new card appears. On error: inline error text.

**Empty state**: "No plugins installed. Browse the Library tab to find plugins."

---

### Library Tab

Scrollable list of curated plugin cards:

- Name + keyword tags (cyan category badges, same as MCP)
- Short description
- **Install** button — triggers `POST /api/plugins/install`, inline spinner
- Already-installed state: grey "Installed ✓" (non-interactive)
- Hover: cyan border glow

**Curated initial list**:
1. `superpowers` — Core skills library (TDD, debugging, planning, git worktrees)
2. `gsd` — Get Stuff Done workflow
3. `frontend-design` — UI/component design guidance
4. `playwright-skill` — Browser automation
5. *(expand as ecosystem grows)*

**Footer**: External link to browse more plugins.

---

### Skills Tab

Per-project skill enable/disable. Changes apply immediately (command picker reads on demand — no restart needed).

**Project selector** dropdown at top:
- Populated from known session `cwd` paths
- Default: "Global (all projects)"
- Selecting a project shows that project's overrides

**Skill list** grouped by plugin (collapsible sections):
- Toggle switch per skill — same animated pill as MCP toggles
- Green = enabled, grey = disabled
- Global view: all enabled by default; toggling sets `__global__` default
- Project view: per-project overrides only

---

## Visual Design

Follows existing MCP panel conventions exactly:

| Element | Value |
|---------|-------|
| Panel background | `#0f172a` |
| Border | `rgba(255,255,255,0.08)` |
| Chip accent | `rgba(6,182,212,0.08)` / `#22d3ee` |
| Scope badge — User | `rgba(59,130,246,0.15)` / `#93c5fd` |
| Scope badge — Project | `rgba(234,179,8,0.15)` / `#fbbf24` |
| Toggle on | `rgba(6,182,212,0.3)` / `#22d3ee` knob |
| Toggle off | `#1e293b` / `#64748b` knob |
| Card hover | `rgba(6,182,212,0.07)` bg + `rgba(6,182,212,0.25)` border |
| Transition | 0.25s ease (panel), 0.15s ease (cards/toggles) |
| Z-index | 601 (above MCP at 600) |

---

## Skill Discovery

`GET /api/plugins/skills` scans all installed plugins:
- Reads `installed_plugins.json` for install paths
- For each plugin: lists `skills/*/SKILL.md` files
- Returns: `{ pluginName, skillName, fullName (e.g. "superpowers:brainstorming"), description }`

The existing command picker (`_sessionCommands`) already filters by session — the Skills tab disable list is applied at the `GET /api/sessions/:id/commands` level by filtering out disabled skills for the session's `cwd`.

---

## Out of Scope

- Per-session plugin enable/disable (plugins are global by design)
- Plugin version pinning or upgrading
- Custom marketplace configuration
- Skill configuration/parameters

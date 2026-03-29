/**
 * @fileoverview Commands route — returns available slash commands and skills for a session.
 *
 * Discovers commands from five sources, in order:
 *   1. Project-level: {session_cwd}/.claude/commands/
 *   2. User-level:    ~/.claude/commands/
 *   3. Plugin-level:  ~/.claude/plugins/installed_plugins.json → each applicable plugin's
 *                     commands/ (slash commands) and skills/ (skill invocations)
 *   4. Manual skills: ~/.claude/skills/ (manually installed skills with SKILL.md)
 *   5. GSD workflows: ~/.claude/get-shit-done/workflows/ (.md workflow files)
 *
 * Command/skill directories are scanned two levels deep:
 *   - Top-level .md files → /command-name
 *   - Subdirectory .md files → /namespace:command-name
 *
 * Plugin scope filtering:
 *   - scope "user"    → included in all sessions
 *   - scope "project" → only included when session cwd is inside projectPath
 *
 * Plugin skills are named /{pluginName}:{skillName} to match Claude Code's convention.
 *
 * @endpoints
 *   GET /api/sessions/:id/commands → { commands: CommandEntry[] }
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { SessionPort } from '../ports/session-port.js';

export interface CommandEntry {
  cmd: string;
  desc: string;
  source: 'project' | 'user' | 'plugin';
}

// ── Installed plugins JSON shape ──────────────────────────────────────────────

interface PluginInstallEntry {
  scope: 'user' | 'project';
  projectPath?: string;
  installPath: string;
}

interface InstalledPluginsJson {
  plugins: Record<string, PluginInstallEntry[]>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse name and description from YAML frontmatter in a markdown file. */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};
  const fm = content.slice(3, end);
  const name = fm
    .match(/^name:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  const desc = fm
    .match(/^description:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  return { name, description: desc };
}

/** Normalise a raw command token to have a leading slash. */
function toSlashCmd(raw: string): string {
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Scan a commands directory for .md files, one level deep.
 *   Top-level files → /cmd-name
 *   Subdirectory files → /namespace:cmd-name  (Claude Code convention)
 */
function scanCommandDir(dir: string, source: CommandEntry['source']): CommandEntry[] {
  const results: CommandEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subDir = path.join(dir, entry.name);
      let subEntries: fs.Dirent[];
      try {
        subEntries = fs.readdirSync(subDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const subEntry of subEntries) {
        if (!subEntry.isFile() || !subEntry.name.endsWith('.md')) continue;
        let content: string;
        try {
          content = fs.readFileSync(path.join(subDir, subEntry.name), 'utf-8');
        } catch {
          continue;
        }
        const { name, description } = parseFrontmatter(content);
        const rawCmd = name ?? `${entry.name}:${subEntry.name.replace(/\.md$/, '')}`;
        results.push({ cmd: toSlashCmd(rawCmd), desc: description ?? '', source });
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
      } catch {
        continue;
      }
      const { name, description } = parseFrontmatter(content);
      const rawCmd = name ?? entry.name.replace(/\.md$/, '');
      results.push({ cmd: toSlashCmd(rawCmd), desc: description ?? '', source });
    }
  }
  return results;
}

/**
 * Scan a plugin's skills/ directory.
 * Each subdirectory is a skill; the SKILL.md file provides name and description.
 * Skills are named /{pluginName}:{skillName} matching Claude Code's convention.
 */
function scanSkillsDir(skillsDir: string, pluginName: string): CommandEntry[] {
  const results: CommandEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf-8');
    } catch {
      continue;
    }
    const { name, description } = parseFrontmatter(content);
    const skillName = name ?? entry.name;
    // Prefix with pluginName if not already namespaced
    const rawCmd = skillName.includes(':') ? skillName : `${pluginName}:${skillName}`;
    results.push({ cmd: toSlashCmd(rawCmd), desc: description ?? '', source: 'plugin' });
  }
  return results;
}

/** Parse description from GSD workflow `<purpose>...</purpose>` tag */
function parseGsdPurpose(content: string): string {
  const m = content.match(/<purpose>\s*([\s\S]*?)\s*<\/purpose>/);
  if (!m) return '';
  return m[1].split('\n')[0].trim();
}

/**
 * Scan a GSD workflows directory for .md files (flat, not subdirectories with SKILL.md).
 * Each .md file is a workflow skill named /gsd:{filename}.
 */
function scanGsdWorkflowsDir(dir: string): CommandEntry[] {
  const results: CommandEntry[] = [];
  let filenames: string[];
  try {
    filenames = fs.readdirSync(dir);
  } catch {
    return results;
  }
  for (const filename of filenames) {
    if (!filename.endsWith('.md')) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, filename), 'utf-8');
    } catch {
      continue;
    }
    const skillName = filename.replace(/\.md$/, '');
    results.push({
      cmd: toSlashCmd(`gsd:${skillName}`),
      desc: parseGsdPurpose(content),
      source: 'plugin',
    });
  }
  return results;
}

/**
 * Read installed_plugins.json and return plugin entries that apply to the given cwd.
 * Deduplicates by installPath so the same plugin installed at multiple scopes
 * (e.g. once user-scoped, once project-scoped) only yields one set of commands.
 */
function applicablePluginPaths(
  cwd: string,
  userHomeOverride?: string
): Array<{ installPath: string; pluginName: string }> {
  const pluginsFile = path.join(userHomeOverride ?? os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let data: InstalledPluginsJson;
  try {
    data = JSON.parse(fs.readFileSync(pluginsFile, 'utf-8')) as InstalledPluginsJson;
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const applicable: Array<{ installPath: string; pluginName: string }> = [];

  for (const [key, entries] of Object.entries(data.plugins ?? {})) {
    const pluginName = key.split('@')[0];
    for (const entry of entries) {
      if (entry.scope === 'project') {
        if (!entry.projectPath || !cwd.startsWith(entry.projectPath)) continue;
      }
      if (seen.has(entry.installPath)) continue;
      seen.add(entry.installPath);
      applicable.push({ installPath: entry.installPath, pluginName });
    }
  }

  return applicable;
}

/** Read disabled skill names for a given project path from ~/.codeman/settings.json. */
function disabledSkillsForProject(cwd: string, userHomeOverride?: string): Set<string> {
  const settingsPath = path.join(userHomeOverride ?? os.homedir(), '.codeman', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    const raw = settings.disabledSkills;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Set();
    const map = raw as Record<string, string[]>;
    const global_ = Array.isArray(map['__global__']) ? map['__global__'] : [];
    const project = Array.isArray(map[cwd]) ? map[cwd] : [];
    return new Set([...global_, ...project]);
  } catch {
    return new Set();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Build the full command list for a session.
 *
 * @param cwd - The session's working directory.
 * @param userHomeOverride - Override for os.homedir() — used in tests.
 */
export function discoverCommands(cwd: string, userHomeOverride?: string): CommandEntry[] {
  const userClaudeDir = path.join(userHomeOverride ?? os.homedir(), '.claude');
  const commands: CommandEntry[] = [
    // 1. Project-level commands
    ...scanCommandDir(path.join(cwd, '.claude', 'commands'), 'project'),
    // 2. User-level commands
    ...scanCommandDir(path.join(userClaudeDir, 'commands'), 'user'),
  ];

  // 3. Plugin commands + skills
  for (const { installPath, pluginName } of applicablePluginPaths(cwd, userHomeOverride)) {
    commands.push(...scanCommandDir(path.join(installPath, 'commands'), 'plugin'));
    commands.push(...scanSkillsDir(path.join(installPath, 'skills'), pluginName));
  }

  // 4. Manually installed skills (~/.claude/skills/)
  commands.push(...scanSkillsDir(path.join(userClaudeDir, 'skills'), 'local'));

  // 5. GSD workflow skills (~/.claude/get-shit-done/workflows/)
  commands.push(...scanGsdWorkflowsDir(path.join(userClaudeDir, 'get-shit-done', 'workflows')));

  // Filter out disabled skills
  const disabled = disabledSkillsForProject(cwd, userHomeOverride);
  if (disabled.size === 0) return commands;
  return commands.filter((cmd) => {
    if (cmd.source !== 'plugin') return true;
    const bare = cmd.cmd.startsWith('/') ? cmd.cmd.slice(1) : cmd.cmd;
    return !disabled.has(bare);
  });
}

export function registerCommandsRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.get<{ Params: { id: string } }>('/api/sessions/:id/commands', async (request, reply) => {
    const { id } = request.params;
    const session = ctx.sessions.get(id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    const cwd = session.workingDir ?? os.homedir();
    const commands = discoverCommands(cwd);
    return reply.send({ commands });
  });
}

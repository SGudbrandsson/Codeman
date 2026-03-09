/**
 * @fileoverview Commands route — returns available slash commands and skills for a session.
 *
 * Discovers commands from three sources, in order:
 *   1. Project-level: {session_cwd}/.claude/commands/
 *   2. User-level:    ~/.claude/commands/
 *   3. Plugin-level:  ~/.claude/plugins/installed_plugins.json → each applicable plugin's
 *                     commands/ (slash commands) and skills/ (skill invocations)
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

  return commands;
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

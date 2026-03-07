/**
 * @fileoverview Commands route — returns available slash commands for a session.
 *
 * Discovers commands from the filesystem at request time:
 *   1. Plugin skills: ~/.claude/plugins/installed_plugins.json
 *   2. GSD commands: ~/.claude/commands/gsd/*.md
 *
 * No CLI interaction — reads SKILL.md frontmatter directly.
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
  source: 'plugin' | 'gsd';
}

interface InstalledPlugin {
  scope: 'user' | 'project';
  installPath: string;
  projectPath?: string;
}

interface PluginsManifest {
  version: number;
  plugins: Record<string, InstalledPlugin[]>;
}

/** Parse name and description from YAML frontmatter in a markdown file. */
function parseFrontmatter(filePath: string): { name?: string; description?: string } {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
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

/** Build the command list for a session's working directory. */
function discoverCommands(sessionWorkingDir?: string): CommandEntry[] {
  const commands: CommandEntry[] = [];
  const claudeDir = path.join(os.homedir(), '.claude');

  // 1. Plugin skills
  const manifestPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  if (fs.existsSync(manifestPath)) {
    let manifest: PluginsManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      manifest = { version: 2, plugins: {} };
    }

    const seen = new Set<string>();

    for (const [, installs] of Object.entries(manifest.plugins)) {
      for (const install of installs) {
        if (install.scope === 'project' && install.projectPath) {
          if (!sessionWorkingDir) continue;
          const proj = install.projectPath.replace(/\/$/, '');
          const sess = sessionWorkingDir.replace(/\/$/, '');
          if (sess !== proj && !sess.startsWith(proj + '/')) continue;
        }

        const skillsDir = path.join(install.installPath, 'skills');
        let skillNames: string[];
        try {
          skillNames = fs.readdirSync(skillsDir);
        } catch {
          continue;
        }

        for (const skillName of skillNames) {
          const skillMd = path.join(skillsDir, skillName, 'SKILL.md');
          if (!fs.existsSync(skillMd)) continue;
          const { name, description } = parseFrontmatter(skillMd);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          commands.push({ cmd: `/${name}`, desc: description ?? '', source: 'plugin' });
        }
      }
    }
  }

  // 2. GSD commands
  const gsdDir = path.join(claudeDir, 'commands', 'gsd');
  let gsdFiles: string[];
  try {
    gsdFiles = fs.readdirSync(gsdDir).filter((f) => f.endsWith('.md'));
  } catch {
    gsdFiles = [];
  }

  for (const file of gsdFiles) {
    const { name, description } = parseFrontmatter(path.join(gsdDir, file));
    if (!name) continue;
    commands.push({ cmd: `/${name}`, desc: description ?? '', source: 'gsd' });
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
    const commands = discoverCommands(session.workingDir);
    return reply.send({ commands });
  });
}

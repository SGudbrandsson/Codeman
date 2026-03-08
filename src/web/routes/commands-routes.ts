/**
 * @fileoverview Commands route — returns available slash commands for a session.
 *
 * Discovers commands from the filesystem at request time:
 *   1. Project-level: {session_cwd}/.claude/commands/*.md (top-level files only)
 *   2. User-level: ~/.claude/commands/*.md (top-level files only, subdirs like gsd/ skipped)
 *
 * No CLI interaction — reads YAML frontmatter directly.
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
  source: 'project' | 'user';
}

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

/** Build the command list for a session's working directory.
 *
 * @param cwd - The session's working directory (for project-level scan).
 * @param userHomeOverride - Override for os.homedir() — used in tests.
 */
export function discoverCommands(cwd: string, userHomeOverride?: string): CommandEntry[] {
  const commands: CommandEntry[] = [];
  const userClaudeDir = path.join(userHomeOverride ?? os.homedir(), '.claude');

  // 1. Project-level commands: {cwd}/.claude/commands/*.md (top-level files only)
  const projectCmdDir = path.join(cwd, '.claude', 'commands');
  try {
    const entries = fs.readdirSync(projectCmdDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(projectCmdDir, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      const { name, description } = parseFrontmatter(content);
      const cmd = name ?? entry.name.replace(/\.md$/, '');
      commands.push({ cmd, desc: description ?? '', source: 'project' });
    }
  } catch {
    // no project commands — fine
  }

  // 2. User-level commands: ~/.claude/commands/*.md (top-level files only, skip subdirs)
  const userCmdDir = path.join(userClaudeDir, 'commands');
  try {
    const entries = fs.readdirSync(userCmdDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(userCmdDir, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      const { name, description } = parseFrontmatter(content);
      const cmd = name ?? entry.name.replace(/\.md$/, '');
      commands.push({ cmd, desc: description ?? '', source: 'user' });
    }
  } catch {
    // no user commands — fine
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

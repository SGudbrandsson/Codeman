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
import { isValidWorkingDir } from '../schemas.js';

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
  key: string; // registry key e.g. "superpowers@superpowers-marketplace"
  pluginName: string; // name portion before @
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
  fullName: string; // e.g. "superpowers:brainstorming"
  description: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const PLUGINS_FILE = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
const PLUGIN_SPAWN_TIMEOUT_MS = 3 * 60 * 1000;

function isSafeInstallPath(p: string): boolean {
  return path.isAbsolute(p) && p.startsWith(os.homedir());
}

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
      if (!isSafeInstallPath(entry.installPath)) continue;
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
          description =
            fm
              .match(/^description:\s*(.+)$/m)?.[1]
              ?.trim()
              .replace(/^["']|["']$/g, '') ?? '';
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
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      proc.kill();
      resolve({ ok: false, output: 'Timed out' });
    }, PLUGIN_SPAWN_TIMEOUT_MS);
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => chunks.push(d));
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, output: Buffer.concat(chunks).toString('utf-8').trim() });
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    const trimmed = name.trim();
    // Validate: npm package name characters only (scoped names like @scope/pkg allowed)
    if (!/^(@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9._-]+$/.test(trimmed) || trimmed.length > 214) {
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid plugin name format'));
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
      return reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.INTERNAL_ERROR, result.output || 'Uninstall failed'));
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
    if (project !== undefined) {
      if (
        project === '__proto__' ||
        project === 'constructor' ||
        project === 'prototype' ||
        !isValidWorkingDir(project)
      ) {
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid project path'));
      }
    }
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
    if (project !== undefined && typeof project === 'string' && project) {
      if (
        project === '__proto__' ||
        project === 'constructor' ||
        project === 'prototype' ||
        !isValidWorkingDir(project)
      ) {
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid project path'));
      }
    }
    const key = typeof project === 'string' && project ? project : '__global__';
    const settings = readSettings();
    const disabledSkills = getDisabledSkills(settings);
    disabledSkills[key] = disabled.filter((s): s is string => typeof s === 'string');
    settings.disabledSkills = disabledSkills;
    writeSettings(settings);
    return reply.send({ ok: true });
  });
}

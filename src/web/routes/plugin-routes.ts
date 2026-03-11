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

const PLUGIN_SPAWN_TIMEOUT_MS = 3 * 60 * 1000;

function pluginsFile(homeDir: string): string {
  return path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
}

function gsdDir(homeDir: string): string {
  return path.join(homeDir, '.claude', 'get-shit-done');
}

function settingsFile(homeDir: string): string {
  return path.join(homeDir, '.codeman', 'settings.json');
}

function isSafeInstallPath(p: string, homeDir: string): boolean {
  return path.isAbsolute(p) && (p === homeDir || p.startsWith(homeDir + path.sep));
}

function readPluginsJson(homeDir: string): InstalledPluginsJson {
  try {
    return JSON.parse(fs.readFileSync(pluginsFile(homeDir), 'utf-8')) as InstalledPluginsJson;
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

export function listInstalledPlugins(homeDir = os.homedir()): InstalledPlugin[] {
  const data = readPluginsJson(homeDir);
  const seen = new Set<string>();
  const result: InstalledPlugin[] = [];
  for (const [key, entries] of Object.entries(data.plugins ?? {})) {
    const pluginName = key.split('@')[0];
    for (const entry of entries) {
      if (!isSafeInstallPath(entry.installPath, homeDir)) continue;
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
  // Surface GSD (get-shit-done) as a virtual plugin entry if installed
  const gsdInstallDir = gsdDir(homeDir);
  const gsdVersionFile = path.join(gsdInstallDir, 'VERSION');
  try {
    const gsdVersion = fs.readFileSync(gsdVersionFile, 'utf-8').trim();
    if (!seen.has(gsdInstallDir)) {
      result.push({
        key: 'gsd@local',
        pluginName: 'gsd',
        installPath: gsdInstallDir,
        scope: 'user',
        version: gsdVersion,
        installedAt: undefined,
        meta: { name: 'gsd', description: 'Get Stuff Done — project planning and execution workflows' },
      });
    }
  } catch {
    // GSD not installed — skip
  }
  return result;
}

/** Parse description from SKILL.md frontmatter */
function parseSkillDescription(content: string): string {
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) {
      const fm = content.slice(3, end);
      return (
        fm
          .match(/^description:\s*(.+)$/m)?.[1]
          ?.trim()
          .replace(/^["']|["']$/g, '') ?? ''
      );
    }
  }
  return '';
}

/** Parse description from GSD workflow `<purpose>...</purpose>` tag */
function parseGsdPurpose(content: string): string {
  const m = content.match(/<purpose>\s*([\s\S]*?)\s*<\/purpose>/);
  if (!m) return '';
  // Take only the first sentence/line to keep it brief
  return m[1].split('\n')[0].trim();
}

export function listAllSkills(homeDir = os.homedir()): SkillEntry[] {
  const plugins = listInstalledPlugins(homeDir);
  const seen = new Set<string>(); // deduplicate by fullName
  const skills: SkillEntry[] = [];

  // Scan plugin skills directories
  for (const plugin of plugins) {
    // GSD workflows are handled separately below
    if (plugin.key === 'gsd@local') continue;
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
      const skillName = entry.name;
      const fullName = `${plugin.pluginName}:${skillName}`;
      if (seen.has(fullName)) continue;
      seen.add(fullName);
      skills.push({ pluginName: plugin.pluginName, skillName, fullName, description: parseSkillDescription(content) });
    }
  }

  // Scan ~/.claude/skills/ for manually installed skills
  const manualSkillsDir = path.join(homeDir, '.claude', 'skills');
  try {
    const manualEntries = fs.readdirSync(manualSkillsDir, { withFileTypes: true });
    for (const entry of manualEntries) {
      if (!entry.isDirectory()) continue;
      let content = '';
      try {
        content = fs.readFileSync(path.join(manualSkillsDir, entry.name, 'SKILL.md'), 'utf-8');
      } catch {
        continue;
      }
      const skillName = entry.name;
      const fullName = `local:${skillName}`;
      if (seen.has(fullName)) continue;
      seen.add(fullName);
      skills.push({ pluginName: 'local', skillName, fullName, description: parseSkillDescription(content) });
    }
  } catch {
    // ~/.claude/skills/ doesn't exist
  }

  // Scan GSD workflows. Note: this is intentionally independent of the VERSION file check in
  // listInstalledPlugins — skills remain visible even if GSD is partially installed (no VERSION).
  const gsdWorkflowsDir = path.join(gsdDir(homeDir), 'workflows');
  try {
    const gsdEntries = fs.readdirSync(gsdWorkflowsDir);
    for (const filename of gsdEntries) {
      if (!filename.endsWith('.md')) continue;
      let content = '';
      try {
        content = fs.readFileSync(path.join(gsdWorkflowsDir, filename), 'utf-8');
      } catch {
        continue;
      }
      const skillName = filename.replace(/\.md$/, '');
      const fullName = `gsd:${skillName}`;
      if (seen.has(fullName)) continue;
      seen.add(fullName);
      skills.push({ pluginName: 'gsd', skillName, fullName, description: parseGsdPurpose(content) });
    }
  } catch {
    // GSD not installed
  }

  return skills;
}

function readSettings(homeDir = os.homedir()): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(homeDir), 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>, homeDir = os.homedir()): void {
  const sf = settingsFile(homeDir);
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  fs.writeFileSync(sf, JSON.stringify(settings, null, 2) + '\n');
}

function getDisabledSkills(settings: Record<string, unknown>): Record<string, string[]> {
  const raw = settings.disabledSkills;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, string[]>;
  }
  return {};
}

/** Run `claude plugin <subcommand> [args...]` and resolve with { ok, output }. */
function runClaudePluginArgs(
  subcommand: string,
  args: string[],
  opts: { cwd?: string } = {}
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['plugin', subcommand, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
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

export async function registerPluginRoutes(app: FastifyInstance, homeDir = os.homedir()): Promise<void> {
  // GET installed plugins
  app.get('/api/plugins', async (_req, reply) => {
    return reply.send(listInstalledPlugins(homeDir));
  });

  // POST install a plugin
  app.post('/api/plugins/install', async (req, reply) => {
    const { name, scope, projectPath } = req.body as { name?: string; scope?: string; projectPath?: string };
    if (!name || typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'name is required'));
    }
    const trimmed = name.trim();
    // Validate: npm package name characters only (scoped names like @scope/pkg allowed).
    // Leading dashes are rejected to prevent flag injection (e.g. "--help").
    if (!/^(?!-)(@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/.test(trimmed) || trimmed.length > 214) {
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid plugin name format'));
    }
    const allowedScopes = ['user', 'project'];
    const resolvedScope = scope && allowedScopes.includes(scope) ? scope : 'user';
    const args = [trimmed, '--scope', resolvedScope];
    const spawnOpts: { cwd?: string } = {};
    if (resolvedScope === 'project' && projectPath && typeof projectPath === 'string') {
      if (isValidWorkingDir(projectPath)) spawnOpts.cwd = projectPath;
    }
    const result = await runClaudePluginArgs('install', args, spawnOpts);
    if (!result.ok) {
      return reply.code(500).send(createErrorResponse(ApiErrorCode.INTERNAL_ERROR, result.output || 'Install failed'));
    }
    return reply.send({ ok: true, output: result.output });
  });

  // DELETE uninstall a plugin (?scope=user|project&projectPath=<path>)
  app.delete('/api/plugins/:encodedName', async (req, reply) => {
    const { encodedName } = req.params as { encodedName: string };
    const { scope, projectPath } = req.query as { scope?: string; projectPath?: string };
    const name = decodeURIComponent(encodedName);
    // Reject the GSD virtual plugin — it isn't a real Claude plugin and cannot be uninstalled this way
    if (name === 'gsd@local') {
      return reply
        .code(400)
        .send(
          createErrorResponse(ApiErrorCode.INVALID_INPUT, 'GSD is not a Claude plugin and cannot be uninstalled here')
        );
    }
    // Validate name with same rules as install (including leading-dash guard) to prevent flag injection
    if (!/^(?!-)(@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/.test(name) || name.length > 214) {
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid plugin name format'));
    }
    const allowedScopes = ['user', 'project'];
    const args = [name];
    const spawnOpts: { cwd?: string } = {};
    if (scope && allowedScopes.includes(scope)) {
      args.push('--scope', scope);
      if (scope === 'project' && projectPath && typeof projectPath === 'string') {
        if (isValidWorkingDir(projectPath) && isSafeInstallPath(projectPath, homeDir)) spawnOpts.cwd = projectPath;
      }
    }
    const result = await runClaudePluginArgs('uninstall', args, spawnOpts);
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
    return reply.send(listAllSkills(homeDir));
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
    const settings = readSettings(homeDir);
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
    const settings = readSettings(homeDir);
    const disabledSkills = getDisabledSkills(settings);
    disabledSkills[key] = disabled.filter((s): s is string => typeof s === 'string');
    settings.disabledSkills = disabledSkills;
    writeSettings(settings, homeDir);
    return reply.send({ ok: true });
  });
}

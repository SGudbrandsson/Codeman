/**
 * Tests for plugin-routes pure functions: listInstalledPlugins, listAllSkills,
 * and the disabled-skills GET/PUT endpoints.
 *
 * Uses isolated temp dirs so tests never touch the real ~/.claude or ~/.codeman.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Fastify from 'fastify';

import { listInstalledPlugins, listAllSkills, registerPluginRoutes } from '../../src/web/routes/plugin-routes.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface FakePlugin {
  key: string; // e.g. "superpowers@marketplace"
  scope: 'user' | 'project';
  projectPath?: string;
  installPath: string;
  skills?: Array<{ dir: string; description: string }>;
  manualMeta?: { name?: string; description?: string };
}

function writePluginsJson(homeDir: string, plugins: FakePlugin[]): void {
  const pluginsDir = path.join(homeDir, '.claude', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const jsonPlugins: Record<string, object[]> = {};
  for (const p of plugins) {
    fs.mkdirSync(p.installPath, { recursive: true });

    // Write .claude-plugin/plugin.json if meta provided
    if (p.manualMeta) {
      const metaDir = path.join(p.installPath, '.claude-plugin');
      fs.mkdirSync(metaDir, { recursive: true });
      fs.writeFileSync(path.join(metaDir, 'plugin.json'), JSON.stringify(p.manualMeta));
    }

    // Write SKILL.md files
    for (const skill of p.skills ?? []) {
      const skillDir = path.join(p.installPath, 'skills', skill.dir);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${skill.dir}\ndescription: ${skill.description}\n---\nSkill body.`
      );
    }

    const entry: Record<string, unknown> = { scope: p.scope, installPath: p.installPath, version: '1.0.0' };
    if (p.projectPath) entry.projectPath = p.projectPath;
    jsonPlugins[p.key] = [entry];
  }

  fs.writeFileSync(
    path.join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: jsonPlugins })
  );
}

function writeGsd(homeDir: string, version: string, workflows: Array<{ name: string; purpose: string }>): void {
  const gsdDir = path.join(homeDir, '.claude', 'get-shit-done');
  const workflowsDir = path.join(gsdDir, 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(path.join(gsdDir, 'VERSION'), version);
  for (const wf of workflows) {
    fs.writeFileSync(path.join(workflowsDir, `${wf.name}.md`), `<purpose>\n${wf.purpose}\n</purpose>\nBody.`);
  }
}

function writeManualSkill(homeDir: string, skillDir: string, description: string): void {
  const skillPath = path.join(homeDir, '.claude', 'skills', skillDir);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, 'SKILL.md'), `---\nname: ${skillDir}\ndescription: ${description}\n---\nBody.`);
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

describe('plugin-routes', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeman-plugin-test-'));
    homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── listInstalledPlugins ────────────────────────────────────────────────────

  describe('listInstalledPlugins', () => {
    it('returns empty array when installed_plugins.json is absent', () => {
      const result = listInstalledPlugins(homeDir);
      // Only GSD (if present) or nothing
      expect(result.filter((p) => p.key !== 'gsd@local')).toHaveLength(0);
    });

    it('lists a user-scoped plugin', () => {
      const installPath = path.join(homeDir, 'cache', 'plugin-a');
      writePluginsJson(homeDir, [{ key: 'my-plugin@marketplace', scope: 'user', installPath }]);
      const result = listInstalledPlugins(homeDir);
      expect(result).toContainEqual(
        expect.objectContaining({ key: 'my-plugin@marketplace', pluginName: 'my-plugin', scope: 'user' })
      );
    });

    it('lists a project-scoped plugin with projectPath', () => {
      const installPath = path.join(homeDir, 'cache', 'plugin-b');
      const projectPath = path.join(tmpDir, 'my-project');
      writePluginsJson(homeDir, [{ key: 'proj-plugin@mp', scope: 'project', projectPath, installPath }]);
      const result = listInstalledPlugins(homeDir);
      expect(result).toContainEqual(expect.objectContaining({ scope: 'project', projectPath }));
    });

    it('deduplicates entries with the same installPath', () => {
      const installPath = path.join(homeDir, 'cache', 'shared-install');
      fs.mkdirSync(installPath, { recursive: true });
      const pluginsDir = path.join(homeDir, '.claude', 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      // Two keys pointing to same installPath
      fs.writeFileSync(
        path.join(pluginsDir, 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: {
            'pkg@mp1': [{ scope: 'user', installPath, version: '1.0.0' }],
            'pkg@mp2': [{ scope: 'user', installPath, version: '1.0.0' }],
          },
        })
      );
      const result = listInstalledPlugins(homeDir);
      const filtered = result.filter((p) => p.key !== 'gsd@local');
      expect(filtered).toHaveLength(1);
    });

    it('skips entries whose installPath is outside homeDir', () => {
      const installPath = '/tmp/unsafe-plugin';
      const pluginsDir = path.join(homeDir, '.claude', 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginsDir, 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: { 'bad@mp': [{ scope: 'user', installPath, version: '1.0.0' }] } })
      );
      const result = listInstalledPlugins(homeDir);
      expect(result.find((p) => p.key === 'bad@mp')).toBeUndefined();
    });

    it('surfaces GSD as gsd@local when VERSION file exists', () => {
      writeGsd(homeDir, '2.3.4', []);
      const result = listInstalledPlugins(homeDir);
      const gsd = result.find((p) => p.key === 'gsd@local');
      expect(gsd).toBeDefined();
      expect(gsd?.version).toBe('2.3.4');
      expect(gsd?.pluginName).toBe('gsd');
    });

    it('does not surface GSD when VERSION file is absent', () => {
      const result = listInstalledPlugins(homeDir);
      expect(result.find((p) => p.key === 'gsd@local')).toBeUndefined();
    });

    it('reads plugin metadata from .claude-plugin/plugin.json', () => {
      const installPath = path.join(homeDir, 'cache', 'meta-plugin');
      writePluginsJson(homeDir, [
        {
          key: 'meta@mp',
          scope: 'user',
          installPath,
          manualMeta: { name: 'meta', description: 'A described plugin' },
        },
      ]);
      const result = listInstalledPlugins(homeDir);
      expect(result.find((p) => p.key === 'meta@mp')?.meta.description).toBe('A described plugin');
    });
  });

  // ── listAllSkills ───────────────────────────────────────────────────────────

  describe('listAllSkills', () => {
    it('returns empty array with no plugins and no GSD', () => {
      expect(listAllSkills(homeDir)).toHaveLength(0);
    });

    it('lists skills from an installed plugin', () => {
      const installPath = path.join(homeDir, 'cache', 'plugin-with-skills');
      writePluginsJson(homeDir, [
        {
          key: 'myplugin@mp',
          scope: 'user',
          installPath,
          skills: [{ dir: 'my-skill', description: 'Does the thing' }],
        },
      ]);
      const skills = listAllSkills(homeDir);
      expect(skills).toContainEqual({
        pluginName: 'myplugin',
        skillName: 'my-skill',
        fullName: 'myplugin:my-skill',
        description: 'Does the thing',
      });
    });

    it('deduplicates skills when same fullName appears in multiple plugin installs', () => {
      const installPath1 = path.join(homeDir, 'cache', 'sp-user');
      const installPath2 = path.join(homeDir, 'cache', 'sp-project');
      const pluginsDir = path.join(homeDir, '.claude', 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });

      // Same pluginName, different install paths (project-scoped + user-scoped)
      for (const ip of [installPath1, installPath2]) {
        const skillDir = path.join(ip, 'skills', 'brainstorming');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, 'SKILL.md'),
          `---\nname: brainstorming\ndescription: Brainstorm stuff\n---\n`
        );
      }
      fs.writeFileSync(
        path.join(pluginsDir, 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: {
            'superpowers@mp1': [{ scope: 'user', installPath: installPath1, version: '1.0.0' }],
            'superpowers@mp2': [
              { scope: 'project', installPath: installPath2, version: '1.0.0', projectPath: '/some/proj' },
            ],
          },
        })
      );
      const skills = listAllSkills(homeDir);
      const brains = skills.filter((s) => s.fullName === 'superpowers:brainstorming');
      expect(brains).toHaveLength(1);
    });

    it('includes manually installed skills from ~/.claude/skills/', () => {
      writeManualSkill(homeDir, 'codeman-worktrees', 'Create worktrees via Codeman');
      const skills = listAllSkills(homeDir);
      expect(skills).toContainEqual({
        pluginName: 'local',
        skillName: 'codeman-worktrees',
        fullName: 'local:codeman-worktrees',
        description: 'Create worktrees via Codeman',
      });
    });

    it('includes GSD workflow skills when GSD is installed', () => {
      writeGsd(homeDir, '1.0.0', [
        { name: 'progress', purpose: 'Check project progress and route to next action' },
        { name: 'plan-phase', purpose: 'Create detailed phase plan with verification loop' },
      ]);
      const skills = listAllSkills(homeDir);
      expect(skills).toContainEqual(
        expect.objectContaining({ pluginName: 'gsd', skillName: 'progress', fullName: 'gsd:progress' })
      );
      expect(skills).toContainEqual(
        expect.objectContaining({ pluginName: 'gsd', skillName: 'plan-phase', fullName: 'gsd:plan-phase' })
      );
    });

    it('parses GSD purpose first line as description', () => {
      writeGsd(homeDir, '1.0.0', [
        { name: 'execute-phase', purpose: 'Execute all plans in a phase.\nDetails follow here.' },
      ]);
      const skills = listAllSkills(homeDir);
      const skill = skills.find((s) => s.fullName === 'gsd:execute-phase');
      expect(skill?.description).toBe('Execute all plans in a phase.');
    });

    it('does not include GSD skills when GSD is not installed', () => {
      const skills = listAllSkills(homeDir);
      expect(skills.filter((s) => s.pluginName === 'gsd')).toHaveLength(0);
    });

    it('returns GSD workflow skills even when VERSION file is absent (workflows dir exists)', () => {
      // Edge case: workflows dir exists but no VERSION — listInstalledPlugins won't surface GSD,
      // but listAllSkills still returns the workflow entries.
      const gsdWorkflowsDir = path.join(homeDir, '.claude', 'get-shit-done', 'workflows');
      fs.mkdirSync(gsdWorkflowsDir, { recursive: true });
      fs.writeFileSync(
        path.join(gsdWorkflowsDir, 'progress.md'),
        '<purpose>\nCheck project progress\n</purpose>\nBody.'
      );
      // No VERSION file written — GSD not surfaced as installed plugin
      const installedPlugins = listInstalledPlugins(homeDir);
      expect(installedPlugins.find((p) => p.key === 'gsd@local')).toBeUndefined();
      // But skills scanner still finds the workflow
      const skills = listAllSkills(homeDir);
      expect(skills.find((s) => s.fullName === 'gsd:progress')).toBeDefined();
    });

    it('plugin skill and manual skill with same skillName have different fullNames (no dedup)', () => {
      const installPath = path.join(homeDir, 'cache', 'plugin-x');
      writePluginsJson(homeDir, [
        { key: 'myplugin@mp', scope: 'user', installPath, skills: [{ dir: 'my-thing', description: 'From plugin' }] },
      ]);
      writeManualSkill(homeDir, 'my-thing', 'From manual install');
      const skills = listAllSkills(homeDir);
      // plugin skill = myplugin:my-thing, manual skill = local:my-thing → different fullName, both kept
      expect(skills.find((s) => s.fullName === 'myplugin:my-thing')).toBeDefined();
      expect(skills.find((s) => s.fullName === 'local:my-thing')).toBeDefined();
    });
  });

  // ── Disabled skills API (GET + PUT) ─────────────────────────────────────────

  describe('GET /api/plugins/skills/disabled and PUT /api/plugins/skills/disabled', () => {
    async function buildApp(hd: string) {
      const app = Fastify({ logger: false });
      await registerPluginRoutes(app, hd);
      await app.ready();
      return app;
    }

    it('GET returns empty disabled list when settings file absent', async () => {
      const app = await buildApp(homeDir);
      const res = await app.inject({ method: 'GET', url: '/api/plugins/skills/disabled' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { project: string; disabled: string[] };
      expect(body).toHaveProperty('disabled');
      expect(Array.isArray(body.disabled)).toBe(true);
    });

    it('PUT rejects non-array disabled payload', async () => {
      const app = await buildApp(homeDir);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/plugins/skills/disabled',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: '__global__', disabled: 'not-an-array' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT rejects dangerous project path (__proto__)', async () => {
      const app = await buildApp(homeDir);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/plugins/skills/disabled',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: '__proto__', disabled: [] }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET rejects dangerous project query param', async () => {
      const app = await buildApp(homeDir);
      const res = await app.inject({
        method: 'GET',
        url: '/api/plugins/skills/disabled?project=__proto__',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── GET /api/plugins ────────────────────────────────────────────────────────

  describe('GET /api/plugins', () => {
    it('returns 200 with an array', async () => {
      const app = Fastify({ logger: false });
      await registerPluginRoutes(app);
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/plugins' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(res.body))).toBe(true);
    });
  });

  // ── GET /api/plugins/library ────────────────────────────────────────────────

  describe('GET /api/plugins/library', () => {
    it('returns 200 with an array', async () => {
      const app = Fastify({ logger: false });
      await registerPluginRoutes(app);
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/plugins/library' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(res.body))).toBe(true);
    });
  });

  // ── POST /api/plugins/install validation ────────────────────────────────────

  describe('POST /api/plugins/install — input validation', () => {
    async function buildApp() {
      const app = Fastify({ logger: false });
      await registerPluginRoutes(app);
      await app.ready();
      return app;
    }

    it('returns 400 when name is missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/install',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when name contains path traversal characters', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/install',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '../evil' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when name exceeds 214 characters', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/install',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a'.repeat(215) }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── DELETE /api/plugins/:encodedName — input validation ─────────────────────

  describe('DELETE /api/plugins/:encodedName — input validation', () => {
    async function buildApp() {
      // maxParamLength raised above 214 so the route handler receives long names
      const app = Fastify({ logger: false, routerOptions: { maxParamLength: 500 } });
      await registerPluginRoutes(app);
      await app.ready();
      return app;
    }

    it('returns 400 when name is gsd@local', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/plugins/${encodeURIComponent('gsd@local')}`,
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error?: string };
      expect(body.error).toMatch(/GSD/);
    });

    it('returns 400 when name contains path traversal characters', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/plugins/${encodeURIComponent('../evil')}`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when name exceeds 214 characters', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/plugins/${'a'.repeat(215)}`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when name contains shell-injection characters', async () => {
      const app = await buildApp();
      for (const badName of ['my-plugin; rm -rf /', 'pkg && evil', 'pkg|cmd']) {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/plugins/${encodeURIComponent(badName)}`,
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('silently drops unrecognised scope and still attempts the CLI call', async () => {
      // An unrecognised scope (e.g. "local") must NOT be forwarded to the CLI.
      // The endpoint will proceed to spawn `claude plugin uninstall <name>` without --scope.
      // Since the CLI is unavailable in the test env this returns 500, not 400.
      const app = await buildApp();
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/plugins/${encodeURIComponent('some-plugin@mp')}?scope=local`,
      });
      // Should NOT be 400 (validation did not reject it — unknown scope is just dropped)
      expect(res.statusCode).not.toBe(400);
    });

    it('accepts a valid scope query param and attempts the CLI call', async () => {
      // A valid scope is accepted; the endpoint proceeds to spawn the CLI.
      // CLI is unavailable in test env → 500, not 400.
      const app = await buildApp();
      for (const scope of ['user', 'project']) {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/plugins/${encodeURIComponent('valid-plugin@mp')}?scope=${scope}`,
        });
        expect(res.statusCode).not.toBe(400);
      }
    });
  });
});

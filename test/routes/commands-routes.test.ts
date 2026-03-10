import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { discoverCommands } from '../../src/web/routes/commands-routes';

// ── Test helpers ──────────────────────────────────────────────────────────────

function writeCmd(dir: string, filename: string, name?: string, description?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter =
    name !== undefined ? `---\nname: ${name}${description ? `\ndescription: ${description}` : ''}\n---\n` : '';
  fs.writeFileSync(path.join(dir, filename), frontmatter + 'Command body.');
}

function writeSkill(dir: string, skillDir: string, name: string, description: string): void {
  const skillPath = path.join(dir, skillDir);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(
    path.join(skillPath, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nSkill body.`
  );
}

interface FakePlugin {
  name: string;
  scope: 'user' | 'project';
  projectPath?: string;
  installPath: string;
  commands?: Array<{ file: string; name?: string; desc?: string }>;
  skills?: Array<{ dir: string; name: string; desc: string }>;
}

/** Create a fake installed_plugins.json and populate plugin directories. */
function setupPlugins(homeDir: string, plugins: FakePlugin[]): void {
  const pluginsDir = path.join(homeDir, '.claude', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const jsonPlugins: Record<string, object[]> = {};

  for (const plugin of plugins) {
    const key = `${plugin.name}@test-marketplace`;
    fs.mkdirSync(plugin.installPath, { recursive: true });

    // Write command files
    for (const cmd of plugin.commands ?? []) {
      writeCmd(path.join(plugin.installPath, 'commands'), cmd.file, cmd.name, cmd.desc);
    }

    // Write skill directories
    for (const skill of plugin.skills ?? []) {
      writeSkill(path.join(plugin.installPath, 'skills'), skill.dir, skill.name, skill.desc);
    }

    const entry: Record<string, unknown> = {
      scope: plugin.scope,
      installPath: plugin.installPath,
      version: '1.0.0',
    };
    if (plugin.scope === 'project') entry.projectPath = plugin.projectPath;

    jsonPlugins[key] = [entry];
  }

  fs.writeFileSync(
    path.join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: jsonPlugins })
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('discoverCommands', () => {
  let tmpDir: string;
  let projectDir: string;
  let homeDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeman-cmds-'));
    projectDir = path.join(tmpDir, 'project');
    homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Project-level commands ─────────────────────────────────────────────────

  describe('project-level (cwd/.claude/commands/)', () => {
    it('finds a top-level .md file and marks it source=project', () => {
      writeCmd(path.join(projectDir, '.claude', 'commands'), 'deploy.md', 'deploy', 'Deploy app');
      const cmds = discoverCommands(projectDir, homeDir);
      expect(cmds).toContainEqual({ cmd: '/deploy', desc: 'Deploy app', source: 'project' });
    });

    it('finds a namespaced command in a subdirectory', () => {
      writeCmd(path.join(projectDir, '.claude', 'commands', 'tools'), 'build.md', 'tools:build', 'Build project');
      const cmds = discoverCommands(projectDir, homeDir);
      expect(cmds).toContainEqual({ cmd: '/tools:build', desc: 'Build project', source: 'project' });
    });

    it('returns no project commands when project has no .claude/commands/', () => {
      const cmds = discoverCommands(projectDir, homeDir);
      expect(cmds.filter((c) => c.source === 'project')).toHaveLength(0);
    });
  });

  // ── User-level commands ────────────────────────────────────────────────────

  describe('user-level (~/.claude/commands/)', () => {
    it('finds a top-level .md file and marks it source=user', () => {
      writeCmd(path.join(homeDir, '.claude', 'commands'), 'mycommand.md', 'mycommand', 'My custom command');
      const cmds = discoverCommands('/nonexistent', homeDir);
      expect(cmds).toContainEqual({ cmd: '/mycommand', desc: 'My custom command', source: 'user' });
    });

    it('finds commands in any namespace subdirectory', () => {
      writeCmd(path.join(homeDir, '.claude', 'commands', 'acme'), 'deploy.md', 'acme:deploy', 'Deploy via acme');
      const cmds = discoverCommands('/nonexistent', homeDir);
      expect(cmds).toContainEqual({ cmd: '/acme:deploy', desc: 'Deploy via acme', source: 'user' });
    });

    it('finds commands across multiple namespace subdirectories', () => {
      writeCmd(path.join(homeDir, '.claude', 'commands', 'alpha'), 'cmd1.md', 'alpha:cmd1', 'Alpha command');
      writeCmd(path.join(homeDir, '.claude', 'commands', 'beta'), 'cmd2.md', 'beta:cmd2', 'Beta command');
      const cmds = discoverCommands('/nonexistent', homeDir);
      expect(cmds).toContainEqual({ cmd: '/alpha:cmd1', desc: 'Alpha command', source: 'user' });
      expect(cmds).toContainEqual({ cmd: '/beta:cmd2', desc: 'Beta command', source: 'user' });
    });
  });

  // ── Plugin commands ────────────────────────────────────────────────────────

  describe('plugin commands (from installed_plugins.json)', () => {
    it('includes commands from a user-scoped plugin in all sessions', () => {
      const installPath = path.join(tmpDir, 'plugin-a');
      setupPlugins(homeDir, [
        { name: 'plugin-a', scope: 'user', installPath, commands: [{ file: 'run.md', name: 'run', desc: 'Run it' }] },
      ]);
      const cmds = discoverCommands('/any/project', homeDir);
      expect(cmds).toContainEqual({ cmd: '/run', desc: 'Run it', source: 'plugin' });
    });

    it('includes commands from a project-scoped plugin when cwd matches', () => {
      const installPath = path.join(tmpDir, 'plugin-b');
      setupPlugins(homeDir, [
        {
          name: 'plugin-b',
          scope: 'project',
          projectPath: projectDir,
          installPath,
          commands: [{ file: 'build.md', name: 'build', desc: 'Build it' }],
        },
      ]);
      const cmds = discoverCommands(projectDir, homeDir);
      expect(cmds).toContainEqual({ cmd: '/build', desc: 'Build it', source: 'plugin' });
    });

    it('excludes commands from a project-scoped plugin when cwd does not match', () => {
      const installPath = path.join(tmpDir, 'plugin-c');
      setupPlugins(homeDir, [
        {
          name: 'plugin-c',
          scope: 'project',
          projectPath: '/some/other/project',
          installPath,
          commands: [{ file: 'secret.md', name: 'secret', desc: 'Should not appear' }],
        },
      ]);
      const cmds = discoverCommands(projectDir, homeDir);
      expect(cmds.some((c) => c.cmd === '/secret')).toBe(false);
    });

    it('deduplicates plugins installed at the same installPath under multiple scopes', () => {
      const installPath = path.join(tmpDir, 'shared-plugin');
      fs.mkdirSync(installPath, { recursive: true });
      writeCmd(path.join(installPath, 'commands'), 'shared.md', 'shared', 'Shared cmd');

      // Manually write installed_plugins.json with same installPath twice (user + project)
      const pluginsDir = path.join(homeDir, '.claude', 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginsDir, 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: {
            'myplugin@test': [
              { scope: 'user', installPath, version: '1.0' },
              { scope: 'project', projectPath: projectDir, installPath, version: '1.0' },
            ],
          },
        })
      );

      const cmds = discoverCommands(projectDir, homeDir);
      expect(cmds.filter((c) => c.cmd === '/shared')).toHaveLength(1);
    });

    it('returns no plugin commands when installed_plugins.json is absent', () => {
      const cmds = discoverCommands(projectDir, homeDir);
      expect(cmds.filter((c) => c.source === 'plugin')).toHaveLength(0);
    });
  });

  // ── Plugin skills ──────────────────────────────────────────────────────────

  describe('plugin skills (from skills/*/SKILL.md)', () => {
    it('surfaces skills as /pluginName:skillName entries', () => {
      const installPath = path.join(tmpDir, 'skills-plugin');
      setupPlugins(homeDir, [
        {
          name: 'mytools',
          scope: 'user',
          installPath,
          skills: [{ dir: 'debugging', name: 'debugging', desc: 'Systematic debugging' }],
        },
      ]);
      const cmds = discoverCommands('/any', homeDir);
      expect(cmds).toContainEqual({ cmd: '/mytools:debugging', desc: 'Systematic debugging', source: 'plugin' });
    });

    it('does not double-prefix if SKILL.md name already contains a colon', () => {
      const installPath = path.join(tmpDir, 'prefixed-plugin');
      setupPlugins(homeDir, [
        {
          name: 'mytools',
          scope: 'user',
          installPath,
          skills: [{ dir: 'ns-skill', name: 'mytools:ns-skill', desc: 'Already namespaced' }],
        },
      ]);
      const cmds = discoverCommands('/any', homeDir);
      const matches = cmds.filter((c) => c.desc === 'Already namespaced');
      expect(matches).toHaveLength(1);
      expect(matches[0].cmd).toBe('/mytools:ns-skill');
    });

    it('surfaces skills only for applicable scope', () => {
      const installPath = path.join(tmpDir, 'scoped-skills');
      setupPlugins(homeDir, [
        {
          name: 'devtools',
          scope: 'project',
          projectPath: '/other/project',
          installPath,
          skills: [{ dir: 'linter', name: 'linter', desc: 'Project linter' }],
        },
      ]);
      const cmds = discoverCommands(projectDir, homeDir); // projectDir != /other/project
      expect(cmds.some((c) => c.cmd === '/devtools:linter')).toBe(false);
    });

    it('skips skills subdirectories without a SKILL.md', () => {
      const installPath = path.join(tmpDir, 'incomplete-plugin');
      setupPlugins(homeDir, [{ name: 'x', scope: 'user', installPath }]);
      // Create a skills subdirectory with no SKILL.md
      fs.mkdirSync(path.join(installPath, 'skills', 'orphan'), { recursive: true });
      const cmds = discoverCommands('/any', homeDir);
      expect(cmds.filter((c) => c.source === 'plugin')).toHaveLength(0);
    });
  });

  // ── Naming conventions ─────────────────────────────────────────────────────

  describe('command naming', () => {
    it('uses filename stem when no frontmatter name present', () => {
      writeCmd(path.join(homeDir, '.claude', 'commands'), 'hello.md');
      const cmds = discoverCommands('/nonexistent', homeDir);
      expect(cmds).toContainEqual(expect.objectContaining({ cmd: '/hello' }));
    });

    it('uses namespace:filename for subdir files without frontmatter name', () => {
      writeCmd(path.join(homeDir, '.claude', 'commands', 'ns'), 'greet.md');
      const cmds = discoverCommands('/nonexistent', homeDir);
      expect(cmds).toContainEqual(expect.objectContaining({ cmd: '/ns:greet' }));
    });

    it('does not double-prepend / when frontmatter name already has it', () => {
      writeCmd(path.join(homeDir, '.claude', 'commands'), 'bar.md', '/bar', 'Bar command');
      const cmds = discoverCommands('/nonexistent', homeDir);
      expect(cmds.filter((c) => c.desc === 'Bar command')).toHaveLength(1);
      expect(cmds.find((c) => c.desc === 'Bar command')?.cmd).toBe('/bar');
    });

    it('sets empty description when frontmatter has none', () => {
      writeCmd(path.join(homeDir, '.claude', 'commands'), 'nodesc.md', 'nodesc');
      const cmds = discoverCommands('/nonexistent', homeDir);
      expect(cmds.find((c) => c.cmd === '/nodesc')?.desc).toBe('');
    });
  });

  // ── Disabled skills filtering ──────────────────────────────────────────────

  describe('disabled skills filtering (disabledSkills in ~/.codeman/settings.json)', () => {
    it('excludes a skill disabled for the current project', () => {
      const installPath = path.join(tmpDir, 'filter-plugin');
      setupPlugins(homeDir, [
        {
          name: 'myplugin',
          scope: 'user',
          installPath,
          skills: [{ dir: 'my-skill', name: 'my-skill', desc: 'My Skill' }],
        },
      ]);
      // Write settings.json with the skill disabled for /my/project
      const codemanDir = path.join(homeDir, '.codeman');
      fs.mkdirSync(codemanDir, { recursive: true });
      fs.writeFileSync(
        path.join(codemanDir, 'settings.json'),
        JSON.stringify({ disabledSkills: { '/my/project': ['myplugin:my-skill'] } })
      );

      const cmds = discoverCommands('/my/project', homeDir);
      expect(cmds.some((c) => c.cmd === '/myplugin:my-skill')).toBe(false);
    });

    it('includes the skill for a different project', () => {
      const installPath = path.join(tmpDir, 'filter-plugin2');
      setupPlugins(homeDir, [
        {
          name: 'myplugin',
          scope: 'user',
          installPath,
          skills: [{ dir: 'my-skill', name: 'my-skill', desc: 'My Skill' }],
        },
      ]);
      const codemanDir = path.join(homeDir, '.codeman');
      fs.mkdirSync(codemanDir, { recursive: true });
      fs.writeFileSync(
        path.join(codemanDir, 'settings.json'),
        JSON.stringify({ disabledSkills: { '/my/project': ['myplugin:my-skill'] } })
      );

      const cmds = discoverCommands('/other/project', homeDir);
      expect(cmds).toContainEqual({ cmd: '/myplugin:my-skill', desc: 'My Skill', source: 'plugin' });
    });

    it('excludes a globally disabled skill', () => {
      const installPath = path.join(tmpDir, 'global-filter-plugin');
      setupPlugins(homeDir, [
        {
          name: 'myplugin',
          scope: 'user',
          installPath,
          skills: [{ dir: 'global-skill', name: 'global-skill', desc: 'Global Skill' }],
        },
      ]);
      const codemanDir = path.join(homeDir, '.codeman');
      fs.mkdirSync(codemanDir, { recursive: true });
      fs.writeFileSync(
        path.join(codemanDir, 'settings.json'),
        JSON.stringify({ disabledSkills: { __global__: ['myplugin:global-skill'] } })
      );

      const cmds = discoverCommands('/any/project', homeDir);
      expect(cmds.some((c) => c.cmd === '/myplugin:global-skill')).toBe(false);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('ignores non-.md files', () => {
      const dir = path.join(homeDir, '.claude', 'commands');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'script.sh'), '#!/bin/bash');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'notes');
      expect(discoverCommands('/nonexistent', homeDir)).toHaveLength(0);
    });

    it('does not recurse deeper than one subdirectory level', () => {
      writeCmd(path.join(homeDir, '.claude', 'commands', 'ns', 'deep'), 'hidden.md', 'hidden', 'Too deep');
      const cmds = discoverCommands('/nonexistent', homeDir);
      expect(cmds.some((c) => c.cmd === '/hidden')).toBe(false);
    });

    it('returns all three sources together', () => {
      const installPath = path.join(tmpDir, 'plugin-multi');
      writeCmd(path.join(projectDir, '.claude', 'commands'), 'proj.md', 'proj', 'Project');
      writeCmd(path.join(homeDir, '.claude', 'commands'), 'user.md', 'user', 'User');
      setupPlugins(homeDir, [
        {
          name: 'myplugin',
          scope: 'user',
          installPath,
          commands: [{ file: 'plugin.md', name: 'plugin', desc: 'Plugin' }],
          skills: [{ dir: 'myskill', name: 'myskill', desc: 'Skill' }],
        },
      ]);
      const cmds = discoverCommands(projectDir, homeDir);
      expect(cmds).toContainEqual({ cmd: '/proj', desc: 'Project', source: 'project' });
      expect(cmds).toContainEqual({ cmd: '/user', desc: 'User', source: 'user' });
      expect(cmds).toContainEqual({ cmd: '/plugin', desc: 'Plugin', source: 'plugin' });
      expect(cmds).toContainEqual({ cmd: '/myplugin:myskill', desc: 'Skill', source: 'plugin' });
    });

    it('returns empty array when no commands exist anywhere', () => {
      expect(discoverCommands('/nonexistent', homeDir)).toHaveLength(0);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { discoverCommands } from '../../src/web/routes/commands-routes';

describe('discoverCommands', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeman-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns project-level commands from cwd/.claude/commands/', () => {
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'deploy.md'), '---\nname: deploy\ndescription: Deploy app\n---\n');

    const commands = discoverCommands(tmpDir, tmpDir);
    expect(commands.some((c) => c.cmd === 'deploy' && c.source === 'project')).toBe(true);
  });

  it('excludes gsd/ subdirectory from user-level scan', () => {
    const gsdDir = path.join(tmpDir, '.claude', 'commands', 'gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'brainstorming.md'), '---\nname: brainstorming\n---\n');

    const commands = discoverCommands('/nonexistent-project', tmpDir);
    expect(commands.some((c) => c.cmd === 'brainstorming')).toBe(false);
  });

  it('returns user-level commands from top-level ~/.claude/commands/*.md', () => {
    const userCmdDir = path.join(tmpDir, '.claude', 'commands');
    fs.mkdirSync(userCmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(userCmdDir, 'mycommand.md'),
      '---\nname: mycommand\ndescription: My custom command\n---\n'
    );

    const commands = discoverCommands('/nonexistent-project', tmpDir);
    expect(commands.some((c) => c.cmd === 'mycommand' && c.source === 'user')).toBe(true);
  });

  it('returns empty array when no commands found', () => {
    const commands = discoverCommands('/nonexistent-project', tmpDir);
    expect(commands).toEqual([]);
  });
});

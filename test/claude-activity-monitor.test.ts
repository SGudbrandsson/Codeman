import { describe, it, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeActivityMonitor } from '../src/claude-activity-monitor.js';

// Path formula verification — skipped on CI where the file won't exist
const knownWorkingDir = '/home/siggi/sources/Codeman-fix-busy-indicator-accuracy';
const knownSessionId = '5800cee6-0917-495a-a5d0-d167269e2f59';

describe('path computation', () => {
  it('derives correct projectHash from workingDir', () => {
    const monitor = new ClaudeActivityMonitor(knownSessionId, knownWorkingDir);
    const expected = path.join(
      os.homedir(),
      '.claude/projects',
      knownWorkingDir.replace(/\//g, '-'),
      `${knownSessionId}.jsonl`
    );
    expect((monitor as any)._filePath).toBe(expected);
  });

  test.skipIf(
    !fs.existsSync(
      path.join(os.homedir(), '.claude/projects', knownWorkingDir.replace(/\//g, '-'), `${knownSessionId}.jsonl`)
    )
  )('projectHash resolves to existing file on this machine', () => {
    const monitor = new ClaudeActivityMonitor(knownSessionId, knownWorkingDir);
    expect(fs.existsSync((monitor as any)._filePath)).toBe(true);
  });
});

import { describe, it, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeActivityMonitor } from '../src/claude-activity-monitor.js';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-test-'));
  return path.join(dir, 'session.jsonl');
}

function writeLine(filePath: string, obj: object): void {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function userLine(opts: { isSidechain?: boolean; toolResultOnly?: boolean } = {}) {
  const content = opts.toolResultOnly
    ? [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]
    : [{ type: 'text', text: 'hello' }];
  return { type: 'user', isSidechain: opts.isSidechain ?? false, message: { role: 'user', content } };
}

function turnDurationLine() {
  return { type: 'system', subtype: 'turn_duration', durationMs: 1000 };
}

function monitorOn(filePath: string): ClaudeActivityMonitor {
  // Create monitor pointing at a specific file path via internal override
  const m = new ClaudeActivityMonitor('test-id', '/test/workdir');
  (m as any)._filePath = filePath;
  return m;
}

describe('startup state — _determineInitialState', () => {
  it('test 2: file exists, last event is turn_duration → no event emitted', async () => {
    const f = tmpFile();
    writeLine(f, userLine());
    writeLine(f, turnDurationLine());
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    m.on('idle', () => events.push('idle'));
    await m.start();
    m.stop();
    expect(events).toEqual([]);
    expect((m as any)._isBusy).toBe(false);
  });

  it('test 3: file exists, last event is user (no turn_duration) → emits working', async () => {
    const f = tmpFile();
    writeLine(f, userLine());
    const m = monitorOn(f);
    const events: string[] = [];
    m.on('working', () => events.push('working'));
    await m.start();
    m.stop();
    expect(events).toEqual(['working']);
    expect((m as any)._isBusy).toBe(true);
  });
});

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

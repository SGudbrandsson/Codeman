import { describe, it, expect, vi } from 'vitest';

const cpMocks = vi.hoisted(() => {
  /** Controllable impl for promisified execFile: return { stdout } or throw to reject. */
  const execFileImpl = vi.fn((_file: string, _args: readonly string[]): { stdout: string } => {
    throw new Error('tmux: no such session');
  });

  // promisify(execFile) runs at screen-analyzer module load and picks up this custom
  // implementation, matching real node execFile's { stdout, stderr } resolution shape.
  // (A plain callback mock would resolve to the bare stdout string instead.)
  const execFile = Object.assign(
    vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout?: string, stderr?: string) => void;
      try {
        const { stdout } = execFileImpl(args[0] as string, args[1] as readonly string[]);
        cb(null, stdout, '');
      } catch (err) {
        cb(err as Error);
      }
    }),
    {
      [Symbol.for('nodejs.util.promisify.custom')]: (file: string, args: readonly string[]) => {
        try {
          const { stdout } = execFileImpl(file, args);
          return Promise.resolve({ stdout, stderr: '' });
        } catch (err) {
          return Promise.reject(err);
        }
      },
    }
  );

  return { execFileImpl, execFile };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('tmux: no such session');
  }),
  execFile: cpMocks.execFile,
}));

import { analyzeScreen, stripAnsi, captureScreen } from '../src/screen-analyzer.js';

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    expect(stripAnsi('\u001b[32mHello\u001b[0m')).toBe('Hello');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('analyzeScreen', () => {
  it('detects completion state', () => {
    const result = analyzeScreen('Worked for 2m 31s\n⏺ Done');
    expect(result.state).toBe('completion');
    expect(result.hasClaudePresence).toBe(true);
  });

  it('detects running_tool state', () => {
    const result = analyzeScreen('⏺ Bash(npm test)\n  running...');
    expect(result.state).toBe('running_tool');
    expect(result.hasClaudePresence).toBe(true);
  });

  it('detects asking_question from y/n prompt', () => {
    const result = analyzeScreen('Do you want to continue? [y/n]');
    expect(result.state).toBe('asking_question');
    expect(result.questionText).toContain('Do you want to continue?');
  });

  it('detects asking_question from numbered list', () => {
    const screen = 'Choose an option:\n1. Option A\n2. Option B\n3. Option C';
    const result = analyzeScreen(screen);
    expect(result.state).toBe('asking_question');
    expect(result.optionLines).toHaveLength(3);
  });

  it('detects thinking state from spinner', () => {
    const result = analyzeScreen('⠋ Processing...');
    expect(result.state).toBe('thinking');
  });

  it('detects thinking state from Thinking text', () => {
    const result = analyzeScreen('Thinking about your request...');
    expect(result.state).toBe('thinking');
  });

  it('detects waiting_for_input from claude prompt char', () => {
    const result = analyzeScreen('some output\n❯');
    expect(result.state).toBe('waiting_for_input');
    expect(result.hasClaudePresence).toBe(true);
  });

  it('detects waiting_for_input from unicode prompt char', () => {
    const result = analyzeScreen('\u276f ');
    expect(result.state).toBe('waiting_for_input');
  });

  it('detects shell_prompt', () => {
    const result = analyzeScreen('user@host:~$ ');
    expect(result.state).toBe('shell_prompt');
    expect(result.hasClaudePresence).toBe(false);
  });

  it('returns unknown for empty screen', () => {
    const result = analyzeScreen('');
    expect(result.state).toBe('unknown');
  });

  it('returns unknown for unrecognized content', () => {
    const result = analyzeScreen('some random log output');
    expect(result.state).toBe('unknown');
  });

  it('completion takes priority over tool pattern', () => {
    const result = analyzeScreen('⏺ Bash(ls)\nWorked for 1m 0s');
    expect(result.state).toBe('completion');
  });

  it('sets lastVisibleText to last non-empty line after ANSI strip', () => {
    const result = analyzeScreen('\u001b[32mline one\u001b[0m\nline two\n\n');
    expect(result.lastVisibleText).toBe('line two');
  });

  it('strips ANSI before pattern matching for tool detection', () => {
    // Simulate ANSI bold codes between bullet and tool name (real tmux output)
    const withAnsi = '⏺\u001b[1m \u001b[0mRead(file.ts)';
    const result = analyzeScreen(withAnsi);
    expect(result.state).toBe('running_tool');
  });
});

describe('captureScreen', () => {
  it('returns null for invalid mux name (injection guard)', async () => {
    const result = await captureScreen('../../etc/passwd');
    expect(result).toBeNull();
    expect(cpMocks.execFileImpl).not.toHaveBeenCalled();
  });

  it('returns null when execFile fails', async () => {
    // Default execFileImpl throws — simulates the tmux pane not existing
    const result = await captureScreen('codeman-abc12345');
    expect(result).toBeNull();
  });

  it('returns the captured pane text when execFile succeeds', async () => {
    const screenText = '⏺ Bash(npm test)\n  running...';
    cpMocks.execFileImpl.mockReturnValueOnce({ stdout: screenText });

    const result = await captureScreen('codeman-abc12345');

    expect(result).toBe(screenText);
    expect(cpMocks.execFileImpl).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['capture-pane', '-t', 'codeman-abc12345'])
    );
  });
});

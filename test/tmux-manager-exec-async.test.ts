/**
 * @fileoverview Tests for TmuxManager's async exec internals with IS_TEST_MODE bypassed.
 *
 * `IS_TEST_MODE = !!process.env.VITEST` (tmux-manager.ts) normally stubs out
 * getSessionsWithStats / isPaneDead under vitest, making the converted execAsync
 * internals unreachable. These tests bypass the stub via vi.stubEnv('VITEST', '')
 * + vi.resetModules() + dynamic import so the real code paths run against a fully
 * mocked node:child_process.
 *
 * Covers:
 * - Batch-failure path: getSessionsWithStats returns sessions with `stats: undefined`,
 *   logs once, and does NOT fall back to per-session probes (the removed death-spiral
 *   amplifier).
 * - Happy path: batched pgrep/ps output is aggregated into per-session stats.
 * - Async isPaneDead semantics: pane_dead=1 → true, exec error → false.
 * - listPaneDeathStates parsing: one `tmux list-panes -a` (execFile) keyed by session name,
 *   lowest pane_index wins, malformed lines skipped, exec failure → empty map.
 *
 * SAFETY: node:child_process (exec/execSync/spawn) and node:fs / node:fs/promises
 * are fully mocked, so no real tmux commands run and no files are written even
 * though the VITEST test-mode stub is bypassed.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TmuxManager as TmuxManagerType } from '../src/tmux-manager.js';

const mocks = vi.hoisted(() => {
  /** Controllable impl for promisified exec: return { stdout } or throw to reject. */
  const execImpl = vi.fn((_cmd: string): { stdout: string } => ({ stdout: '' }));

  // promisify(exec) at tmux-manager module load picks up this custom implementation,
  // matching real node exec's { stdout, stderr } resolution shape. (A plain callback
  // mock would resolve to the bare stdout string, breaking `const { stdout } = ...`.)
  const exec = Object.assign(
    vi.fn((cmd: string, optsOrCb: unknown, maybeCb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      const cb = typeof optsOrCb === 'function' ? (optsOrCb as typeof maybeCb) : maybeCb;
      try {
        const { stdout } = execImpl(cmd);
        cb?.(null, stdout, '');
      } catch (err) {
        cb?.(err as Error, '', '');
      }
    }),
    {
      [Symbol.for('nodejs.util.promisify.custom')]: (cmd: string, _opts?: unknown) => {
        try {
          const { stdout } = execImpl(cmd);
          return Promise.resolve({ stdout, stderr: '' });
        } catch (err) {
          return Promise.reject(err);
        }
      },
    }
  );

  /** Controllable impl for promisified execFile (argv form): return { stdout } or throw to reject. */
  const execFileImpl = vi.fn((_file: string, _args: readonly string[]): { stdout: string } => ({ stdout: '' }));
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: (file: string, args: readonly string[], _opts?: unknown) => {
      try {
        const { stdout } = execFileImpl(file, args);
        return Promise.resolve({ stdout, stderr: '' });
      } catch (err) {
        return Promise.reject(err);
      }
    },
  });

  return {
    execImpl,
    exec,
    execFileImpl,
    execFile,
    execSync: vi.fn((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('which')) return '/usr/bin/tmux\n';
      return '';
    }),
    spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn(), pid: 12345 })),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, exec: mocks.exec, execFile: mocks.execFile, execSync: mocks.execSync, spawn: mocks.spawn };
});

// Mock fs so the non-test-mode load/save paths (loadSessions, saveSessions,
// saveSessionsSync) never touch the real ~/.codeman/mux-sessions.json.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('[]'),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
});

function makeSession(sessionId: string, pid: number) {
  return {
    sessionId,
    muxName: `codeman-${pid.toString(16).padStart(8, '0')}`,
    pid,
    createdAt: Date.now(),
    workingDir: '/tmp',
    mode: 'claude' as const,
    attached: false,
  };
}

describe('TmuxManager async exec internals (VITEST test-mode bypassed)', () => {
  let manager: TmuxManagerType;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Restore the default (empty stdout) impl in case a prior test overrode it.
    mocks.execImpl.mockImplementation(() => ({ stdout: '' }));
    mocks.execFileImpl.mockImplementation(() => ({ stdout: '' }));
    // IS_TEST_MODE = !!process.env.VITEST → false for the freshly imported module
    vi.stubEnv('VITEST', '');
    vi.resetModules();
    const { TmuxManager } = await import('../src/tmux-manager.js');
    manager = new TmuxManager();
  });

  afterEach(() => {
    manager.destroy();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe('getSessionsWithStats — batch failure', () => {
    it('returns all sessions with stats undefined, logs once, and makes no per-session fallback probes', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      manager.registerSession(makeSession('s1', 101));
      manager.registerSession(makeSession('s2', 102));
      mocks.execImpl.mockImplementation(() => {
        throw new Error('pgrep timed out');
      });

      const result = await manager.getSessionsWithStats();

      expect(result).toHaveLength(2);
      expect(result.map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
      expect(result.every((s) => s.stats === undefined)).toBe(true);
      // Only the batched pgrep attempt — NO 2-per-session getProcessStats fallback
      expect(mocks.execImpl).toHaveBeenCalledTimes(1);
      expect(String(mocks.execImpl.mock.calls[0][0])).toContain('pgrep -P');
      // Logged exactly once for the whole tick
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleSpy.mock.calls[0][0])).toContain('Batched stats collection failed');
      consoleSpy.mockRestore();
    });
  });

  describe('getSessionsWithStats — happy path', () => {
    it('aggregates batched pgrep/ps output into per-session stats', async () => {
      manager.registerSession(makeSession('s1', 100));
      manager.registerSession(makeSession('s2', 200));
      mocks.execImpl.mockImplementation((cmd: string) => {
        if (cmd.includes('pgrep -P')) {
          // Session 100 has one child (300); session 200 has none
          return { stdout: '100:300,\n200:\n' };
        }
        if (cmd.includes('ps -o pid=,rss=,pcpu=')) {
          return { stdout: '100 2048 5.0\n300 1024 2.5\n200 512 1.0\n' };
        }
        throw new Error(`unexpected command: ${cmd}`);
      });

      const result = await manager.getSessionsWithStats();

      const s1 = result.find((s) => s.sessionId === 's1');
      expect(s1?.stats).toEqual({
        memoryMB: 3, // (2048 + 1024) / 1024
        cpuPercent: 7.5, // 5.0 + 2.5
        childCount: 1,
        updatedAt: expect.any(Number),
      });
      const s2 = result.find((s) => s.sessionId === 's2');
      expect(s2?.stats).toEqual({
        memoryMB: 0.5, // 512 / 1024
        cpuPercent: 1,
        childCount: 0,
        updatedAt: expect.any(Number),
      });
    });
  });

  describe('isPaneDead (async)', () => {
    it('resolves true when tmux reports pane_dead=1', async () => {
      mocks.execImpl.mockImplementation((cmd: string) => {
        if (cmd.includes('#{pane_dead}')) return { stdout: '1\n' };
        return { stdout: '' };
      });
      await expect(manager.isPaneDead('codeman-abc12345')).resolves.toBe(true);
    });

    it('resolves false when the tmux probe fails', async () => {
      mocks.execImpl.mockImplementation(() => {
        throw new Error('no such session');
      });
      await expect(manager.isPaneDead('codeman-abc12345')).resolves.toBe(false);
    });
  });

  describe('listPaneDeathStates (async)', () => {
    const paneLine = (name: string, index: string, dead: string, status: string) =>
      `${name}\t${index}\t${dead}\t${status}`;

    it('makes one list-panes call and maps dead/alive panes by session name', async () => {
      mocks.execFileImpl.mockImplementation(() => ({
        stdout:
          [
            paneLine('codeman-dead0001', '0', '1', '3'),
            paneLine('codeman-live0001', '0', '0', ''),
            paneLine('codeman-nost0001', '0', '1', ''),
          ].join('\n') + '\n',
      }));

      const states = await manager.listPaneDeathStates();

      expect(mocks.execFileImpl).toHaveBeenCalledTimes(1);
      const [file, args] = mocks.execFileImpl.mock.calls[0];
      expect(file).toBe('tmux');
      expect(args.slice(0, 2)).toEqual(['list-panes', '-a']);
      expect(states).toEqual(
        new Map([
          ['codeman-dead0001', { dead: true, exitStatus: 3 }],
          ['codeman-live0001', { dead: false, exitStatus: null }],
          // Dead with no reported status → exit status unknown
          ['codeman-nost0001', { dead: true, exitStatus: null }],
        ])
      );
    });

    it('uses the lowest pane_index per session regardless of listing order', async () => {
      mocks.execFileImpl.mockImplementation(() => ({
        stdout: [
          // Split pane (index 1) is dead but listed first; the harness pane (index 0) is alive
          paneLine('codeman-aaaa0001', '1', '1', '9'),
          paneLine('codeman-aaaa0001', '0', '0', ''),
          // Harness pane dead, a later split alive
          paneLine('codeman-bbbb0001', '0', '1', '5'),
          paneLine('codeman-bbbb0001', '2', '0', ''),
        ].join('\n'),
      }));

      const states = await manager.listPaneDeathStates();

      expect(states.get('codeman-aaaa0001')).toEqual({ dead: false, exitStatus: null });
      expect(states.get('codeman-bbbb0001')).toEqual({ dead: true, exitStatus: 5 });
      expect(states.size).toBe(2);
    });

    it('skips blank and malformed lines', async () => {
      mocks.execFileImpl.mockImplementation(() => ({
        stdout: [
          '',
          'no-tabs-at-all',
          paneLine('codeman-badindex', 'abc', '1', '2'),
          paneLine('', '0', '1', '2'),
          paneLine('codeman-good0001', '0', '1', '0'),
          '',
        ].join('\n'),
      }));

      const states = await manager.listPaneDeathStates();

      expect(states).toEqual(new Map([['codeman-good0001', { dead: true, exitStatus: 0 }]]));
    });

    it('resolves an empty map when the tmux call fails', async () => {
      mocks.execFileImpl.mockImplementation(() => {
        throw new Error('no server running');
      });

      const states = await manager.listPaneDeathStates();

      expect(states.size).toBe(0);
    });
  });
});

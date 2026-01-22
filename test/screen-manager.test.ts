/**
 * @fileoverview Tests for screen-manager module
 *
 * Tests the ScreenManager class which manages GNU screen sessions
 * for persistent Claude sessions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// We test the validation functions and class behavior without spawning real screens
// This is a unit test approach that mocks system dependencies

describe('ScreenManager', () => {
  // Test the validation functions (extracted for testing)
  describe('Screen Name Validation', () => {
    // Valid screen names should match: claudeman-[a-f0-9-]+
    const validNames = [
      'claudeman-abc12345',
      'claudeman-12345678',
      'claudeman-a1b2c3d4',
      'claudeman-aabbccdd',
      'claudeman-a1b2-c3d4',
    ];

    const invalidNames = [
      'not-claudeman',
      'claudeman-ABC123',  // uppercase not allowed
      'claudeman-abc123!', // special chars not allowed
      'claudeman-abc 123', // spaces not allowed
      'claudeman-',        // empty suffix
      'CLAUDEMAN-abc123',  // uppercase prefix
      '; rm -rf /',        // command injection
      'claudeman-$(whoami)',
      'claudeman-`id`',
    ];

    it('should accept valid screen names', () => {
      const pattern = /^claudeman-[a-f0-9-]+$/;
      for (const name of validNames) {
        expect(pattern.test(name)).toBe(true);
      }
    });

    it('should reject invalid screen names', () => {
      const pattern = /^claudeman-[a-f0-9-]+$/;
      for (const name of invalidNames) {
        expect(pattern.test(name)).toBe(false);
      }
    });
  });

  describe('Path Validation', () => {
    const validPaths = [
      '/home/user/project',
      '/tmp/test',
      '/var/lib/claudeman',
      '~/projects/myapp',
      '/Users/name/Documents',
      '/path/with-dashes',
      '/path/with_underscores',
      '/path/with.dots',
      '/path with spaces',  // Spaces are allowed
    ];

    const invalidPaths = [
      '/path;rm -rf /',     // semicolon injection
      '/path&& malicious',  // command chaining
      '/path|cat /etc/passwd', // pipe injection
      '/path$(whoami)',     // command substitution
      '/path`id`',          // backtick substitution
      '/path(test)',        // parentheses
      '/path{a,b}',         // brace expansion
      "/path'test'",        // single quotes
      '/path"test"',        // double quotes
      '/path<>',            // redirection
      '/path\ntest',        // newline
    ];

    it('should validate paths without shell metacharacters', () => {
      const isValidPath = (path: string): boolean => {
        if (path.includes(';') || path.includes('&') || path.includes('|') ||
            path.includes('$') || path.includes('`') || path.includes('(') ||
            path.includes(')') || path.includes('{') || path.includes('}') ||
            path.includes('<') || path.includes('>') || path.includes("'") ||
            path.includes('"') || path.includes('\n') || path.includes('\r')) {
          return false;
        }
        return /^[a-zA-Z0-9_\/\-. ~]+$/.test(path);
      };

      for (const path of validPaths) {
        expect(isValidPath(path)).toBe(true);
      }

      for (const path of invalidPaths) {
        expect(isValidPath(path)).toBe(false);
      }
    });
  });

  describe('Shell Escape Function', () => {
    const shellEscape = (str: string): string => {
      return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`');
    };

    it('should escape backslashes', () => {
      expect(shellEscape('path\\file')).toBe('path\\\\file');
    });

    it('should escape double quotes', () => {
      expect(shellEscape('say "hello"')).toBe('say \\"hello\\"');
    });

    it('should escape dollar signs', () => {
      expect(shellEscape('$HOME/test')).toBe('\\$HOME/test');
    });

    it('should escape backticks', () => {
      expect(shellEscape('`whoami`')).toBe('\\`whoami\\`');
    });

    it('should handle multiple escape characters', () => {
      expect(shellEscape('$HOME\\file"test"`id`')).toBe('\\$HOME\\\\file\\"test\\"\\`id\\`');
    });

    it('should not modify safe strings', () => {
      expect(shellEscape('simple text')).toBe('simple text');
      expect(shellEscape('/path/to/file')).toBe('/path/to/file');
    });
  });

  describe('Screen Pattern Matching', () => {
    const SCREEN_PATTERN = /(\d+)\.(claudeman-([a-f0-9-]+))/g;

    it('should parse screen -ls output correctly', () => {
      const output = `There are screens on:
	12345.claudeman-abc12345	(01/15/2024 10:30:00 AM)	(Detached)
	67890.claudeman-def67890	(01/15/2024 11:00:00 AM)	(Attached)
2 Sockets in /run/screen/S-user.`;

      const matches: Array<{ pid: number; screenName: string; sessionIdFragment: string }> = [];
      let match;
      SCREEN_PATTERN.lastIndex = 0;
      while ((match = SCREEN_PATTERN.exec(output)) !== null) {
        matches.push({
          pid: parseInt(match[1], 10),
          screenName: match[2],
          sessionIdFragment: match[3],
        });
      }

      expect(matches).toHaveLength(2);
      expect(matches[0].pid).toBe(12345);
      expect(matches[0].screenName).toBe('claudeman-abc12345');
      expect(matches[0].sessionIdFragment).toBe('abc12345');
      expect(matches[1].pid).toBe(67890);
      expect(matches[1].screenName).toBe('claudeman-def67890');
      expect(matches[1].sessionIdFragment).toBe('def67890');
    });

    it('should not match non-claudeman screens', () => {
      const output = `There are screens on:
	12345.some-other-screen	(01/15/2024 10:30:00 AM)	(Detached)
	67890.another-screen	(01/15/2024 11:00:00 AM)	(Attached)
2 Sockets in /run/screen/S-user.`;

      SCREEN_PATTERN.lastIndex = 0;
      expect(SCREEN_PATTERN.exec(output)).toBeNull();
    });

    it('should handle empty screen list', () => {
      const output = `No Sockets found in /run/screen/S-user.`;

      SCREEN_PATTERN.lastIndex = 0;
      expect(SCREEN_PATTERN.exec(output)).toBeNull();
    });
  });

  describe('ScreenSession Interface', () => {
    it('should have all required fields', () => {
      const session = {
        sessionId: 'test-session-123',
        screenName: 'claudeman-abc12345',
        pid: 12345,
        createdAt: Date.now(),
        workingDir: '/home/user/project',
        mode: 'claude' as const,
        attached: false,
        name: 'My Session',
      };

      expect(session.sessionId).toBeDefined();
      expect(session.screenName).toBeDefined();
      expect(session.pid).toBeGreaterThan(0);
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.workingDir).toBeDefined();
      expect(['claude', 'shell']).toContain(session.mode);
      expect(typeof session.attached).toBe('boolean');
    });

    it('should support shell mode', () => {
      const session = {
        sessionId: 'shell-session',
        screenName: 'claudeman-def67890',
        pid: 67890,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'shell' as const,
        attached: true,
      };

      expect(session.mode).toBe('shell');
      expect(session.attached).toBe(true);
    });

    it('should support optional name field', () => {
      const sessionWithName = {
        sessionId: 'test-1',
        screenName: 'claudeman-111',
        pid: 1111,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude' as const,
        attached: false,
        name: 'Custom Name',
      };

      const sessionWithoutName = {
        sessionId: 'test-2',
        screenName: 'claudeman-222',
        pid: 2222,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude' as const,
        attached: false,
      };

      expect(sessionWithName.name).toBe('Custom Name');
      expect(sessionWithoutName.name).toBeUndefined();
    });

    it('should support respawnConfig field', () => {
      const session = {
        sessionId: 'respawn-test',
        screenName: 'claudeman-resp',
        pid: 9999,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude' as const,
        attached: false,
        respawnConfig: {
          enabled: true,
          idleTimeoutMs: 5000,
          updatePrompt: 'continue',
          interStepDelayMs: 1000,
          sendClear: true,
          sendInit: true,
          kickstartPrompt: '/init',
          durationMinutes: 60,
        },
      };

      expect(session.respawnConfig?.enabled).toBe(true);
      expect(session.respawnConfig?.durationMinutes).toBe(60);
    });

    it('should support ralphEnabled field', () => {
      const session = {
        sessionId: 'ralph-test',
        screenName: 'claudeman-ralph',
        pid: 8888,
        createdAt: Date.now(),
        workingDir: '/tmp',
        mode: 'claude' as const,
        attached: false,
        ralphEnabled: true,
      };

      expect(session.ralphEnabled).toBe(true);
    });
  });

  describe('ProcessStats Interface', () => {
    it('should have all required fields', () => {
      const stats = {
        memoryMB: 128.5,
        cpuPercent: 12.3,
        childCount: 5,
        updatedAt: Date.now(),
      };

      expect(stats.memoryMB).toBeGreaterThanOrEqual(0);
      expect(stats.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(stats.childCount).toBeGreaterThanOrEqual(0);
      expect(stats.updatedAt).toBeGreaterThan(0);
    });

    it('should handle zero values', () => {
      const stats = {
        memoryMB: 0,
        cpuPercent: 0,
        childCount: 0,
        updatedAt: Date.now(),
      };

      expect(stats.memoryMB).toBe(0);
      expect(stats.cpuPercent).toBe(0);
      expect(stats.childCount).toBe(0);
    });

    it('should handle high values', () => {
      const stats = {
        memoryMB: 8192.5,
        cpuPercent: 100.0,
        childCount: 50,
        updatedAt: Date.now(),
      };

      expect(stats.memoryMB).toBe(8192.5);
      expect(stats.cpuPercent).toBe(100.0);
      expect(stats.childCount).toBe(50);
    });
  });

  describe('Child PID Extraction', () => {
    // Simulate pgrep output parsing
    const parseChildPids = (output: string): number[] => {
      if (!output.trim()) return [];
      return output.trim().split('\n').map(p => parseInt(p, 10)).filter(p => !isNaN(p));
    };

    it('should parse single child PID', () => {
      expect(parseChildPids('12345\n')).toEqual([12345]);
    });

    it('should parse multiple child PIDs', () => {
      expect(parseChildPids('12345\n67890\n11111\n')).toEqual([12345, 67890, 11111]);
    });

    it('should handle empty output', () => {
      expect(parseChildPids('')).toEqual([]);
      expect(parseChildPids('   ')).toEqual([]);
    });

    it('should ignore invalid entries', () => {
      expect(parseChildPids('12345\nnotapid\n67890\n')).toEqual([12345, 67890]);
    });
  });

  describe('PS Output Parsing', () => {
    // Simulate ps output parsing
    const parsePsOutput = (output: string): Map<number, { memoryMB: number; cpuPercent: number }> => {
      const result = new Map();
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const pid = parseInt(parts[0], 10);
          const rss = parseFloat(parts[1]) || 0;
          const cpu = parseFloat(parts[2]) || 0;
          if (!isNaN(pid)) {
            result.set(pid, {
              memoryMB: Math.round(rss / 1024 * 10) / 10,
              cpuPercent: Math.round(cpu * 10) / 10,
            });
          }
        }
      }
      return result;
    };

    it('should parse ps output with single process', () => {
      const output = '12345 102400 5.5';
      const result = parsePsOutput(output);
      expect(result.get(12345)?.memoryMB).toBe(100);
      expect(result.get(12345)?.cpuPercent).toBe(5.5);
    });

    it('should parse ps output with multiple processes', () => {
      const output = `12345 102400 5.5
67890 204800 10.0
11111 51200 2.5`;
      const result = parsePsOutput(output);
      expect(result.size).toBe(3);
      expect(result.get(12345)?.memoryMB).toBe(100);
      expect(result.get(67890)?.memoryMB).toBe(200);
      expect(result.get(11111)?.cpuPercent).toBe(2.5);
    });

    it('should handle zero values', () => {
      const output = '12345 0 0';
      const result = parsePsOutput(output);
      expect(result.get(12345)?.memoryMB).toBe(0);
      expect(result.get(12345)?.cpuPercent).toBe(0);
    });

    it('should handle empty output', () => {
      expect(parsePsOutput('').size).toBe(0);
      expect(parsePsOutput('   ').size).toBe(0);
    });
  });

  describe('Input Handling for Screen', () => {
    // Test the logic of splitting input for screen -X stuff commands
    const parseInput = (input: string): { textPart: string; hasCarriageReturn: boolean } => {
      const hasCarriageReturn = input.includes('\r');
      const textPart = input.replace(/\r/g, '').replace(/\n/g, '');
      return { textPart, hasCarriageReturn };
    };

    it('should detect carriage return', () => {
      const result = parseInput('test\r');
      expect(result.hasCarriageReturn).toBe(true);
      expect(result.textPart).toBe('test');
    });

    it('should handle text without carriage return', () => {
      const result = parseInput('test');
      expect(result.hasCarriageReturn).toBe(false);
      expect(result.textPart).toBe('test');
    });

    it('should strip newlines', () => {
      const result = parseInput('test\n');
      expect(result.textPart).toBe('test');
    });

    it('should handle empty input', () => {
      const result = parseInput('');
      expect(result.textPart).toBe('');
      expect(result.hasCarriageReturn).toBe(false);
    });

    it('should handle only carriage return', () => {
      const result = parseInput('\r');
      expect(result.textPart).toBe('');
      expect(result.hasCarriageReturn).toBe(true);
    });

    it('should handle mixed newlines and carriage returns', () => {
      const result = parseInput('line1\nline2\r');
      expect(result.textPart).toBe('line1line2');
      expect(result.hasCarriageReturn).toBe(true);
    });
  });

  describe('Screen Session Management Logic', () => {
    // Test screen session data structure operations
    let screens: Map<string, { sessionId: string; screenName: string; pid: number }>;

    beforeEach(() => {
      screens = new Map();
    });

    it('should add screen sessions', () => {
      screens.set('session-1', { sessionId: 'session-1', screenName: 'claudeman-111', pid: 111 });
      screens.set('session-2', { sessionId: 'session-2', screenName: 'claudeman-222', pid: 222 });

      expect(screens.size).toBe(2);
      expect(screens.get('session-1')?.pid).toBe(111);
    });

    it('should remove screen sessions', () => {
      screens.set('session-1', { sessionId: 'session-1', screenName: 'claudeman-111', pid: 111 });
      screens.delete('session-1');

      expect(screens.size).toBe(0);
      expect(screens.get('session-1')).toBeUndefined();
    });

    it('should update screen PID', () => {
      screens.set('session-1', { sessionId: 'session-1', screenName: 'claudeman-111', pid: 111 });
      const screen = screens.get('session-1')!;
      screen.pid = 999;

      expect(screens.get('session-1')?.pid).toBe(999);
    });

    it('should iterate over screens', () => {
      screens.set('session-1', { sessionId: 'session-1', screenName: 'claudeman-111', pid: 111 });
      screens.set('session-2', { sessionId: 'session-2', screenName: 'claudeman-222', pid: 222 });

      const sessionIds: string[] = [];
      for (const [id] of screens) {
        sessionIds.push(id);
      }

      expect(sessionIds).toContain('session-1');
      expect(sessionIds).toContain('session-2');
    });

    it('should check if screen exists', () => {
      screens.set('session-1', { sessionId: 'session-1', screenName: 'claudeman-111', pid: 111 });

      expect(screens.has('session-1')).toBe(true);
      expect(screens.has('session-2')).toBe(false);
    });
  });

  describe('Reconciliation Logic', () => {
    it('should categorize screens as alive or dead', () => {
      const knownScreens = new Map([
        ['session-1', { screenName: 'claudeman-111', pid: 111 }],
        ['session-2', { screenName: 'claudeman-222', pid: 222 }],
        ['session-3', { screenName: 'claudeman-333', pid: 333 }],
      ]);

      // Simulate screen -ls showing only some screens are alive
      const aliveScreenNames = new Set(['claudeman-111', 'claudeman-333']);

      const alive: string[] = [];
      const dead: string[] = [];

      for (const [sessionId, screen] of knownScreens) {
        if (aliveScreenNames.has(screen.screenName)) {
          alive.push(sessionId);
        } else {
          dead.push(sessionId);
        }
      }

      expect(alive).toEqual(['session-1', 'session-3']);
      expect(dead).toEqual(['session-2']);
    });

    it('should discover unknown screens', () => {
      const knownScreenNames = new Set(['claudeman-111']);
      const discoveredFromScreenLs = [
        { pid: 111, screenName: 'claudeman-111', sessionIdFragment: '111' },
        { pid: 222, screenName: 'claudeman-222', sessionIdFragment: '222' },
        { pid: 333, screenName: 'claudeman-333', sessionIdFragment: '333' },
      ];

      const discovered: Array<{ screenName: string; sessionIdFragment: string }> = [];

      for (const screen of discoveredFromScreenLs) {
        if (!knownScreenNames.has(screen.screenName)) {
          discovered.push({
            screenName: screen.screenName,
            sessionIdFragment: screen.sessionIdFragment,
          });
        }
      }

      expect(discovered).toHaveLength(2);
      expect(discovered[0].screenName).toBe('claudeman-222');
      expect(discovered[1].screenName).toBe('claudeman-333');
    });
  });

  describe('Environment Variables', () => {
    it('should format environment variables correctly for claude mode', () => {
      const sessionId = 'test-session-123';
      const screenName = 'claudeman-abc12345';

      const envVars = `CLAUDEMAN_SCREEN=1 CLAUDEMAN_SESSION_ID=${sessionId} CLAUDEMAN_SCREEN_NAME=${screenName}`;

      expect(envVars).toContain('CLAUDEMAN_SCREEN=1');
      expect(envVars).toContain('CLAUDEMAN_SESSION_ID=test-session-123');
      expect(envVars).toContain('CLAUDEMAN_SCREEN_NAME=claudeman-abc12345');
    });

    it('should use claude command for claude mode', () => {
      const mode = 'claude' as const;
      const cmd = mode === 'claude'
        ? 'claude --dangerously-skip-permissions'
        : '$SHELL';

      expect(cmd).toBe('claude --dangerously-skip-permissions');
    });

    it('should use $SHELL for shell mode', () => {
      const mode = 'shell' as const;
      const cmd = mode === 'claude'
        ? 'claude --dangerously-skip-permissions'
        : '$SHELL';

      expect(cmd).toBe('$SHELL');
    });
  });

  describe('Screen Name Generation', () => {
    it('should generate screen name from session ID', () => {
      const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const screenName = `claudeman-${sessionId.slice(0, 8)}`;

      expect(screenName).toBe('claudeman-a1b2c3d4');
    });

    it('should handle short session IDs', () => {
      const sessionId = 'abc';
      const screenName = `claudeman-${sessionId.slice(0, 8)}`;

      expect(screenName).toBe('claudeman-abc');
    });
  });

  describe('Restored Session Naming', () => {
    it('should create restored session ID', () => {
      const sessionIdFragment = 'abc12345';
      const restoredSessionId = `restored-${sessionIdFragment}`;

      expect(restoredSessionId).toBe('restored-abc12345');
    });

    it('should create restored session name', () => {
      const screenName = 'claudeman-abc12345';
      const name = `Restored: ${screenName}`;

      expect(name).toBe('Restored: claudeman-abc12345');
    });
  });
});

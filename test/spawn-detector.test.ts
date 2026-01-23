import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpawnDetector } from '../src/spawn-detector.js';

describe('SpawnDetector', () => {
  let detector: SpawnDetector;

  beforeEach(() => {
    detector = new SpawnDetector();
  });

  describe('Initialization', () => {
    it('should start disabled', () => {
      expect(detector.enabled).toBe(false);
    });

    it('should start with initial state', () => {
      const state = detector.state;
      expect(state.enabled).toBe(false);
      expect(state.activeCount).toBe(0);
      expect(state.totalSpawned).toBe(0);
    });
  });

  describe('Auto-Enable', () => {
    it('should auto-enable on spawn tag detection', () => {
      detector.processTerminalData('<spawn1337>task.md</spawn1337>\n');
      expect(detector.enabled).toBe(true);
    });

    it('should not enable on unrelated data', () => {
      detector.processTerminalData('Hello world\nsome output\n');
      expect(detector.enabled).toBe(false);
    });

    it('should auto-enable on status tag', () => {
      detector.processTerminalData('<spawn1337-status agentId="test-001"/>\n');
      expect(detector.enabled).toBe(true);
    });

    it('should auto-enable on cancel tag', () => {
      detector.processTerminalData('<spawn1337-cancel agentId="test-001"/>\n');
      expect(detector.enabled).toBe(true);
    });
  });

  describe('Spawn Request Detection', () => {
    it('should detect spawn tag and emit event', () => {
      const handler = vi.fn();
      detector.on('spawnRequested', handler);

      detector.processTerminalData('<spawn1337>tasks/auth-explore.md</spawn1337>\n');

      expect(handler).toHaveBeenCalledWith('tasks/auth-explore.md', expect.any(String));
    });

    it('should detect spawn tag with path containing slashes', () => {
      const handler = vi.fn();
      detector.on('spawnRequested', handler);

      detector.processTerminalData('<spawn1337>src/tasks/deep/nested.md</spawn1337>\n');

      expect(handler).toHaveBeenCalledWith('src/tasks/deep/nested.md', expect.any(String));
    });

    it('should handle spawn tag with surrounding text', () => {
      const handler = vi.fn();
      detector.on('spawnRequested', handler);

      detector.processTerminalData('Starting agent: <spawn1337>task.md</spawn1337> done\n');

      expect(handler).toHaveBeenCalledWith('task.md', expect.any(String));
    });

    it('should increment totalSpawned count', () => {
      detector.processTerminalData('<spawn1337>task1.md</spawn1337>\n');
      detector.processTerminalData('<spawn1337>task2.md</spawn1337>\n');
      detector.flushPendingEvents();

      expect(detector.state.totalSpawned).toBe(2);
    });

    it('should handle multiple spawn tags in one chunk', () => {
      const handler = vi.fn();
      detector.on('spawnRequested', handler);

      detector.processTerminalData(
        '<spawn1337>task1.md</spawn1337>\n<spawn1337>task2.md</spawn1337>\n'
      );

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should strip ANSI codes before parsing', () => {
      const handler = vi.fn();
      detector.on('spawnRequested', handler);

      detector.processTerminalData('\x1b[32m<spawn1337>task.md</spawn1337>\x1b[0m\n');

      expect(handler).toHaveBeenCalledWith('task.md', expect.any(String));
    });

    it('should trim whitespace from file path', () => {
      const handler = vi.fn();
      detector.on('spawnRequested', handler);

      detector.processTerminalData('<spawn1337>  task.md  </spawn1337>\n');

      expect(handler).toHaveBeenCalledWith('task.md', expect.any(String));
    });
  });

  describe('Status Request Detection', () => {
    it('should detect status query and emit event', () => {
      const handler = vi.fn();
      detector.on('statusRequested', handler);

      detector.processTerminalData('<spawn1337-status agentId="auth-001"/>\n');

      expect(handler).toHaveBeenCalledWith('auth-001');
    });

    it('should handle status with complex agent ID', () => {
      const handler = vi.fn();
      detector.on('statusRequested', handler);

      detector.processTerminalData('<spawn1337-status agentId="my-complex-agent-123"/>\n');

      expect(handler).toHaveBeenCalledWith('my-complex-agent-123');
    });
  });

  describe('Cancel Request Detection', () => {
    it('should detect cancel request and emit event', () => {
      const handler = vi.fn();
      detector.on('cancelRequested', handler);

      detector.processTerminalData('<spawn1337-cancel agentId="test-agent"/>\n');

      expect(handler).toHaveBeenCalledWith('test-agent');
    });
  });

  describe('Message Detection', () => {
    it('should detect single-line message', () => {
      const handler = vi.fn();
      detector.on('messageToChild', handler);

      detector.processTerminalData(
        '<spawn1337-message agentId="agent-001">Focus on the JWT flow</spawn1337-message>\n'
      );

      expect(handler).toHaveBeenCalledWith('agent-001', 'Focus on the JWT flow');
    });

    it('should detect multi-line message via checkMultiLinePatterns', () => {
      const handler = vi.fn();
      detector.on('messageToChild', handler);

      const multiline = '<spawn1337-message agentId="agent-001">Line 1\nLine 2\nLine 3</spawn1337-message>';
      detector.processTerminalData(multiline + '\n');

      expect(handler).toHaveBeenCalledWith('agent-001', 'Line 1\nLine 2\nLine 3');
    });
  });

  describe('Enable/Disable', () => {
    it('should emit stateUpdate when enabled', async () => {
      const handler = vi.fn();
      detector.on('stateUpdate', handler);

      detector.enable();
      detector.flushPendingEvents();

      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].enabled).toBe(true);
    });

    it('should emit stateUpdate when disabled', () => {
      detector.enable();
      detector.flushPendingEvents();

      const handler = vi.fn();
      detector.on('stateUpdate', handler);

      detector.disable();
      detector.flushPendingEvents();

      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].enabled).toBe(false);
    });
  });

  describe('Reset', () => {
    it('should reset all state', () => {
      detector.processTerminalData('<spawn1337>task.md</spawn1337>\n');
      detector.flushPendingEvents();
      expect(detector.enabled).toBe(true);

      detector.reset();

      expect(detector.enabled).toBe(false);
      expect(detector.state.totalSpawned).toBe(0);
    });
  });

  describe('State Update', () => {
    it('should allow external state updates', () => {
      detector.updateState({ activeCount: 3, queuedCount: 2 });
      detector.flushPendingEvents();

      expect(detector.state.activeCount).toBe(3);
      expect(detector.state.queuedCount).toBe(2);
    });
  });

  describe('Line Buffer', () => {
    it('should handle data split across chunks', () => {
      const handler = vi.fn();
      detector.on('spawnRequested', handler);

      // Send in two chunks (split in the middle of the tag)
      detector.processTerminalData('<spawn13');
      detector.processTerminalData('37>task.md</spawn1337>\n');

      expect(handler).toHaveBeenCalledWith('task.md', expect.any(String));
    });

    it('should handle partial lines without emitting', () => {
      const handler = vi.fn();
      detector.on('spawnRequested', handler);

      // No newline - data stays in buffer
      detector.processTerminalData('<spawn1337>task.md</spawn1337>');

      // Should not emit until newline
      expect(handler).not.toHaveBeenCalled();
    });

    it('should emit on subsequent newline', () => {
      const handler = vi.fn();
      detector.on('spawnRequested', handler);

      detector.processTerminalData('<spawn1337>task.md</spawn1337>');
      detector.processTerminalData('\n');

      expect(handler).toHaveBeenCalledWith('task.md', expect.any(String));
    });
  });
});

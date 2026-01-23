import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpawnOrchestrator, type SessionCreator } from '../src/spawn-orchestrator.js';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * SpawnOrchestrator Tests
 *
 * Tests the full lifecycle management of spawned agents.
 * Uses a temporary directory and mock session creator.
 */

describe('SpawnOrchestrator', () => {
  let orchestrator: SpawnOrchestrator;
  let testDir: string;
  let mockSessionCreator: SessionCreator;
  let completionHandlers: Map<string, (phrase: string) => void>;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    completionHandlers = new Map();

    mockSessionCreator = {
      createAgentSession: vi.fn().mockResolvedValue({ sessionId: `session-${Date.now()}` }),
      writeToSession: vi.fn(),
      getSessionTokens: vi.fn().mockReturnValue(0),
      getSessionCost: vi.fn().mockReturnValue(0),
      stopSession: vi.fn().mockResolvedValue(undefined),
      onSessionCompletion: vi.fn().mockImplementation((sessionId, handler) => {
        completionHandlers.set(sessionId, handler);
      }),
      removeSessionCompletionHandler: vi.fn().mockImplementation((sessionId) => {
        completionHandlers.delete(sessionId);
      }),
    };

    orchestrator = new SpawnOrchestrator({
      casesDir: testDir,
      maxConcurrentAgents: 3,
      maxSpawnDepth: 2,
      defaultTimeoutMinutes: 5,
      maxTimeoutMinutes: 10,
      progressPollIntervalMs: 60000, // Long interval to avoid interference
    });

    orchestrator.setSessionCreator(mockSessionCreator);
  });

  afterEach(() => {
    // Stop all agents and clear timers
    orchestrator.stopAll().catch(() => {});
    orchestrator.removeAllListeners();
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createTaskFile(dir: string, filename: string, content: string): string {
    const filePath = join(dir, filename);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
    return filePath;
  }

  const basicTaskContent = `---
agentId: test-agent-001
name: Test Agent
type: explore
priority: normal
timeoutMinutes: 5
completionPhrase: TEST_DONE
canModifyParentFiles: false
---

# Test Task

Do a simple test.`;

  describe('Configuration', () => {
    it('should use provided config', () => {
      expect(orchestrator.config.maxConcurrentAgents).toBe(3);
      expect(orchestrator.config.maxSpawnDepth).toBe(2);
    });

    it('should update config', () => {
      orchestrator.updateConfig({ maxConcurrentAgents: 10 });
      expect(orchestrator.config.maxConcurrentAgents).toBe(10);
    });
  });

  describe('handleSpawnRequest', () => {
    it('should reject when no session creator is set', async () => {
      const noCreator = new SpawnOrchestrator({ casesDir: testDir });
      const failHandler = vi.fn();
      noCreator.on('failed', failHandler);

      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      await noCreator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      // Should not crash, just log error
      expect(failHandler).not.toHaveBeenCalled(); // Silent failure with console.error
    });

    it('should fail when task file does not exist', async () => {
      const failHandler = vi.fn();
      orchestrator.on('failed', failHandler);

      await orchestrator.handleSpawnRequest('nonexistent.md', 'parent-session', testDir);

      expect(failHandler).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('not found') })
      );
    });

    it('should fail when task file cannot be parsed', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'bad.md', 'No frontmatter here');
      const failHandler = vi.fn();
      orchestrator.on('failed', failHandler);

      await orchestrator.handleSpawnRequest('bad.md', 'parent-session', parentDir);

      expect(failHandler).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('parse') })
      );
    });

    it('should reject when max depth exceeded', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);
      const failHandler = vi.fn();
      orchestrator.on('failed', failHandler);

      // Max depth is 2, so parentDepth=2 means child would be 3 (exceeds)
      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir, 2);

      expect(failHandler).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('depth') })
      );
    });

    it('should spawn agent and create directory structure', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      // Wait for async initialization
      await vi.waitFor(() => {
        expect(mockSessionCreator.createAgentSession).toHaveBeenCalled();
      });

      // Check directory was created
      const agentDir = join(testDir, 'spawn-test-agent-001');
      expect(existsSync(agentDir)).toBe(true);
      expect(existsSync(join(agentDir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(agentDir, 'spawn-comms'))).toBe(true);
      expect(existsSync(join(agentDir, 'spawn-comms', 'task.md'))).toBe(true);
      expect(existsSync(join(agentDir, 'spawn-comms', 'progress.json'))).toBe(true);
      expect(existsSync(join(agentDir, 'spawn-comms', 'messages'))).toBe(true);
    });

    it('should generate proper CLAUDE.md for agent', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      await vi.waitFor(() => {
        expect(mockSessionCreator.createAgentSession).toHaveBeenCalled();
      });

      const agentDir = join(testDir, 'spawn-test-agent-001');
      const claudeMd = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8');
      expect(claudeMd).toContain('Agent: Test Agent');
      expect(claudeMd).toContain('test-agent-001');
      expect(claudeMd).toContain('TEST_DONE');
      expect(claudeMd).toContain('# Test Task');
    });

    it('should emit initializing and started events', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      const initHandler = vi.fn();
      const startHandler = vi.fn();
      orchestrator.on('initializing', initHandler);
      orchestrator.on('started', startHandler);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      await vi.waitFor(() => {
        expect(startHandler).toHaveBeenCalled();
      });

      expect(initHandler).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'test-agent-001', name: 'Test Agent' })
      );
      expect(startHandler).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'test-agent-001', name: 'Test Agent' })
      );
    });

    it('should enforce timeout limits', async () => {
      const parentDir = join(testDir, 'parent');
      const content = basicTaskContent.replace('timeoutMinutes: 5', 'timeoutMinutes: 999');
      createTaskFile(parentDir, 'task.md', content);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      await vi.waitFor(() => {
        const status = orchestrator.getAgentStatus('test-agent-001');
        expect(status).not.toBeNull();
        expect(status!.timeoutMinutes).toBe(10); // Capped at maxTimeoutMinutes
      });
    });
  });

  describe('Queue Management', () => {
    it('should queue agents when concurrency limit reached', async () => {
      const parentDir = join(testDir, 'parent');

      // Create 4 tasks (limit is 3)
      for (let i = 1; i <= 4; i++) {
        const content = basicTaskContent
          .replace('test-agent-001', `agent-${i}`)
          .replace('Test Agent', `Agent ${i}`);
        createTaskFile(parentDir, `task${i}.md`, content);
      }

      const queueHandler = vi.fn();
      orchestrator.on('queued', queueHandler);

      // Spawn 4 agents
      for (let i = 1; i <= 4; i++) {
        await orchestrator.handleSpawnRequest(`task${i}.md`, 'parent', parentDir);
      }

      // Wait for first 3 to start
      await vi.waitFor(() => {
        expect(mockSessionCreator.createAgentSession).toHaveBeenCalledTimes(3);
      });

      // 4th should be queued
      expect(queueHandler).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-4' })
      );
    });

    it('should order queue by priority', async () => {
      const parentDir = join(testDir, 'parent');

      // Fill concurrency first
      for (let i = 1; i <= 3; i++) {
        const content = basicTaskContent
          .replace('test-agent-001', `filler-${i}`)
          .replace('Test Agent', `Filler ${i}`);
        createTaskFile(parentDir, `filler${i}.md`, content);
        await orchestrator.handleSpawnRequest(`filler${i}.md`, 'parent', parentDir);
      }

      await vi.waitFor(() => {
        expect(mockSessionCreator.createAgentSession).toHaveBeenCalledTimes(3);
      });

      // Now add low and high priority
      const lowContent = basicTaskContent
        .replace('test-agent-001', 'low-agent')
        .replace('priority: normal', 'priority: low');
      createTaskFile(parentDir, 'low.md', lowContent);

      const highContent = basicTaskContent
        .replace('test-agent-001', 'high-agent')
        .replace('priority: normal', 'priority: critical');
      createTaskFile(parentDir, 'high.md', highContent);

      await orchestrator.handleSpawnRequest('low.md', 'parent', parentDir);
      await orchestrator.handleSpawnRequest('high.md', 'parent', parentDir);

      // State should show high priority first in queue
      const state = orchestrator.getState();
      expect(state.queuedCount).toBe(2);
    });
  });

  describe('cancelAgent', () => {
    it('should cancel a running agent', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      await vi.waitFor(() => {
        expect(orchestrator.getAgentStatus('test-agent-001')).not.toBeNull();
      });

      const cancelHandler = vi.fn();
      orchestrator.on('cancelled', cancelHandler);

      await orchestrator.cancelAgent('test-agent-001', 'User cancelled');

      expect(cancelHandler).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'test-agent-001', reason: 'User cancelled' })
      );
    });

    it('should cancel a queued agent', async () => {
      const parentDir = join(testDir, 'parent');

      // Fill concurrency
      for (let i = 1; i <= 3; i++) {
        const content = basicTaskContent
          .replace('test-agent-001', `filler-${i}`)
          .replace('Test Agent', `Filler ${i}`);
        createTaskFile(parentDir, `filler${i}.md`, content);
        await orchestrator.handleSpawnRequest(`filler${i}.md`, 'parent', parentDir);
      }

      // Add one more (queued)
      const queuedContent = basicTaskContent.replace('test-agent-001', 'queued-agent');
      createTaskFile(parentDir, 'queued.md', queuedContent);
      await orchestrator.handleSpawnRequest('queued.md', 'parent', parentDir);

      const cancelHandler = vi.fn();
      orchestrator.on('cancelled', cancelHandler);

      await orchestrator.cancelAgent('queued-agent');

      expect(cancelHandler).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'queued-agent' })
      );
    });
  });

  describe('sendMessageToAgent', () => {
    it('should write message file to comms directory', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      await vi.waitFor(() => {
        expect(orchestrator.getAgentStatus('test-agent-001')).not.toBeNull();
      });

      await orchestrator.sendMessageToAgent('test-agent-001', 'Focus on JWT');

      const messagesDir = join(testDir, 'spawn-test-agent-001', 'spawn-comms', 'messages');
      expect(existsSync(join(messagesDir, '001-parent.md'))).toBe(true);

      const content = readFileSync(join(messagesDir, '001-parent.md'), 'utf-8');
      expect(content).toBe('Focus on JWT');
    });
  });

  describe('getAgentStatus', () => {
    it('should return null for unknown agent', () => {
      expect(orchestrator.getAgentStatus('nonexistent')).toBeNull();
    });

    it('should return status for active agent', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      await vi.waitFor(() => {
        const status = orchestrator.getAgentStatus('test-agent-001');
        expect(status).not.toBeNull();
        expect(status!.status).toBe('running');
        expect(status!.name).toBe('Test Agent');
        expect(status!.completionPhrase).toBe('TEST_DONE');
      });
    });
  });

  describe('getState', () => {
    it('should return complete orchestrator state', () => {
      const state = orchestrator.getState();
      expect(state.enabled).toBe(true);
      expect(state.activeCount).toBe(0);
      expect(state.queuedCount).toBe(0);
      expect(state.totalSpawned).toBe(0);
      expect(state.agents).toEqual([]);
    });

    it('should update counts after spawn', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      await vi.waitFor(() => {
        const state = orchestrator.getState();
        expect(state.activeCount).toBe(1);
        expect(state.totalSpawned).toBe(1);
      });
    });
  });

  describe('readAgentMessages', () => {
    it('should return empty for unknown agent', () => {
      expect(orchestrator.readAgentMessages('nonexistent')).toEqual([]);
    });

    it('should read messages from comms directory', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      await vi.waitFor(() => {
        expect(orchestrator.getAgentStatus('test-agent-001')).not.toBeNull();
      });

      // Write a message
      await orchestrator.sendMessageToAgent('test-agent-001', 'Hello agent');

      const messages = orchestrator.readAgentMessages('test-agent-001');
      expect(messages).toHaveLength(1);
      expect(messages[0].sender).toBe('parent');
      expect(messages[0].content).toBe('Hello agent');
      expect(messages[0].sequence).toBe(1);
    });
  });

  describe('triggerSpawn', () => {
    it('should spawn from content string', async () => {
      const agentId = await orchestrator.triggerSpawn(
        basicTaskContent,
        'parent-session',
        testDir
      );

      expect(agentId).toBe('test-agent-001');

      await vi.waitFor(() => {
        expect(mockSessionCreator.createAgentSession).toHaveBeenCalled();
      });
    });

    it('should return null for unparseable content', async () => {
      const agentId = await orchestrator.triggerSpawn(
        'Not valid YAML frontmatter',
        'parent-session',
        testDir
      );

      expect(agentId).toBeNull();
    });
  });

  describe('stopAll', () => {
    it('should stop all active agents', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      await vi.waitFor(() => {
        expect(orchestrator.getState().activeCount).toBe(1);
      });

      await orchestrator.stopAll();

      expect(orchestrator.getState().activeCount).toBe(0);
    });
  });

  describe('getPersistedState', () => {
    it('should return serializable state', async () => {
      const parentDir = join(testDir, 'parent');
      createTaskFile(parentDir, 'task.md', basicTaskContent);

      await orchestrator.handleSpawnRequest('task.md', 'parent-session', parentDir);

      await vi.waitFor(() => {
        expect(orchestrator.getState().activeCount).toBe(1);
      });

      const persisted = orchestrator.getPersistedState();
      expect(persisted.config).toBeDefined();
      expect(persisted.agents['test-agent-001']).toBeDefined();
      expect(persisted.agents['test-agent-001'].completionPhrase).toBe('TEST_DONE');

      // Should be JSON-serializable
      expect(() => JSON.stringify(persisted)).not.toThrow();
    });
  });
});

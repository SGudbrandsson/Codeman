/**
 * @fileoverview Tests for the Execution Bridge system.
 *
 * Tests the core functionality of:
 * - ModelSelector
 * - GroupScheduler
 * - ExecutionBridge
 *
 * Uses mocks to avoid spawning real Claude sessions.
 *
 * Port: none (unit tests, no server)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ModelSelector,
  resetModelSelector,
  createDefaultModelConfig,
  type ModelConfig,
  type AgentType,
} from '../src/model-selector.js';
import {
  GroupScheduler,
  resetGroupScheduler,
  type GroupTask,
} from '../src/group-scheduler.js';
import {
  ExecutionBridge,
  resetExecutionBridge,
  type PlanItem,
} from '../src/execution-bridge.js';

describe('ModelSelector', () => {
  let selector: ModelSelector;

  beforeEach(() => {
    resetModelSelector();
    selector = new ModelSelector();
  });

  afterEach(() => {
    resetModelSelector();
  });

  it('should use default model when no overrides', () => {
    const selection = selector.selectModel('task-1', { agentType: 'explore' });
    expect(selection.model).toBe('sonnet');
    expect(selection.usedUserDefault).toBe(true);
  });

  it('should respect user default model', () => {
    selector.updateConfig({ defaultModel: 'opus' });
    const selection = selector.selectModel('task-1', { agentType: 'explore' });
    expect(selection.model).toBe('opus');
    expect(selection.usedUserDefault).toBe(true);
  });

  it('should use agent type override when set', () => {
    selector.updateConfig({
      agentTypeOverrides: { explore: 'haiku' },
    });
    const selection = selector.selectModel('task-1', { agentType: 'explore' });
    expect(selection.model).toBe('haiku');
    expect(selection.usedUserDefault).toBe(false);
  });

  it('should include optimizer recommendation when different', () => {
    selector.updateConfig({ defaultModel: 'opus' });
    const selection = selector.selectModel('task-1', {
      agentType: 'explore',
      recommendedModel: 'haiku',
    });
    expect(selection.model).toBe('opus');
    expect(selection.optimizerRecommendation).toBe('haiku');
  });

  it('should select session mode for high token tasks', () => {
    const mode = selector.selectExecutionMode({ estimatedTokens: 60000 });
    expect(mode.mode).toBe('session');
  });

  it('should select task-tool mode for low token explore tasks', () => {
    const mode = selector.selectExecutionMode({
      estimatedTokens: 10000,
      agentType: 'explore',
    });
    expect(mode.mode).toBe('task-tool');
  });

  it('should return correct cost multipliers', () => {
    expect(selector.getModelCostMultiplier('opus')).toBe(5.0);
    expect(selector.getModelCostMultiplier('sonnet')).toBe(1.0);
    expect(selector.getModelCostMultiplier('haiku')).toBe(0.04);
  });
});

describe('GroupScheduler', () => {
  let scheduler: GroupScheduler;

  beforeEach(() => {
    resetGroupScheduler();
    scheduler = new GroupScheduler();
  });

  afterEach(() => {
    resetGroupScheduler();
  });

  it('should build schedule from plan items', () => {
    const items: PlanItem[] = [
      { id: 't1', title: 'Task 1', description: 'Desc 1', parallelGroup: 0 },
      { id: 't2', title: 'Task 2', description: 'Desc 2', parallelGroup: 0 },
      { id: 't3', title: 'Task 3', description: 'Desc 3', parallelGroup: 1 },
    ];

    const schedule = scheduler.buildSchedule(items);

    expect(schedule.groups).toHaveLength(2);
    expect(schedule.groups[0].tasks).toHaveLength(2);
    expect(schedule.groups[1].tasks).toHaveLength(1);
    expect(schedule.totalTasks).toBe(3);
  });

  it('should order groups by number', () => {
    const items: PlanItem[] = [
      { id: 't1', title: 'Task 1', description: 'Desc 1', parallelGroup: 2 },
      { id: 't2', title: 'Task 2', description: 'Desc 2', parallelGroup: 0 },
      { id: 't3', title: 'Task 3', description: 'Desc 3', parallelGroup: 1 },
    ];

    const schedule = scheduler.buildSchedule(items);

    expect(schedule.groups[0].groupNumber).toBe(0);
    expect(schedule.groups[1].groupNumber).toBe(1);
    expect(schedule.groups[2].groupNumber).toBe(2);
  });

  it('should track group dependencies', () => {
    const items: PlanItem[] = [
      { id: 't1', title: 'Task 1', description: 'Desc 1', parallelGroup: 0 },
      { id: 't2', title: 'Task 2', description: 'Desc 2', parallelGroup: 1, dependencies: ['t1'] },
    ];

    const schedule = scheduler.buildSchedule(items);

    expect(schedule.groups[1].dependsOnGroups).toContain(0);
  });

  it('should return first group as ready initially', () => {
    const items: PlanItem[] = [
      { id: 't1', title: 'Task 1', description: 'Desc 1', parallelGroup: 0 },
      { id: 't2', title: 'Task 2', description: 'Desc 2', parallelGroup: 1 },
    ];

    scheduler.buildSchedule(items);
    const nextGroup = scheduler.getNextReadyGroup();

    expect(nextGroup).not.toBeNull();
    expect(nextGroup!.groupNumber).toBe(0);
  });

  it('should update task status', () => {
    const items: PlanItem[] = [
      { id: 't1', title: 'Task 1', description: 'Desc 1', parallelGroup: 0 },
    ];

    scheduler.buildSchedule(items);
    scheduler.startGroup(0);
    scheduler.updateTaskStatus('t1', 'completed');

    const stats = scheduler.getStats();
    expect(stats.completedTasks).toBe(1);
  });

  it('should determine execution mode based on task characteristics', () => {
    const items: PlanItem[] = [
      {
        id: 't1',
        title: 'High token task',
        description: 'Desc',
        parallelGroup: 0,
        estimatedTokens: 60000,
      },
    ];

    const schedule = scheduler.buildSchedule(items);
    expect(schedule.groups[0].executionMode).toBe('session');
  });
});

describe('ExecutionBridge', () => {
  let bridge: ExecutionBridge;

  beforeEach(() => {
    resetExecutionBridge();
    resetGroupScheduler();
    resetModelSelector();
    bridge = new ExecutionBridge();
  });

  afterEach(() => {
    bridge.reset();
    resetExecutionBridge();
    resetGroupScheduler();
    resetModelSelector();
  });

  it('should have idle status initially', () => {
    expect(bridge.status).toBe('idle');
  });

  it('should load a plan', () => {
    const items: PlanItem[] = [
      { id: 't1', title: 'Task 1', description: 'Desc 1', parallelGroup: 0 },
      { id: 't2', title: 'Task 2', description: 'Desc 2', parallelGroup: 1 },
    ];

    const schedule = bridge.loadPlan(items);

    expect(schedule).not.toBeNull();
    expect(schedule.totalTasks).toBe(2);
    expect(bridge.status).toBe('idle');
  });

  it('should report progress', () => {
    const items: PlanItem[] = [
      { id: 't1', title: 'Task 1', description: 'Desc 1' },
    ];

    bridge.loadPlan(items);
    const progress = bridge.getProgress();

    expect(progress.totalTasks).toBe(1);
    expect(progress.completedTasks).toBe(0);
    expect(progress.status).toBe('idle');
  });

  it('should update model config', () => {
    bridge.updateModelConfig({ defaultModel: 'opus' });
    const config = bridge.getModelConfig();
    expect(config.defaultModel).toBe('opus');
  });

  it('should reset properly', () => {
    const items: PlanItem[] = [
      { id: 't1', title: 'Task 1', description: 'Desc 1' },
    ];

    bridge.loadPlan(items);
    bridge.reset();

    expect(bridge.status).toBe('idle');
    expect(bridge.getProgress().totalTasks).toBe(0);
  });

  it('should throw when starting without a spawner', async () => {
    const items: PlanItem[] = [
      { id: 't1', title: 'Task 1', description: 'Desc 1' },
    ];

    bridge.loadPlan(items);

    await expect(bridge.start()).rejects.toThrow('No agent spawner configured');
  });

  it('should track execution history', () => {
    const history = bridge.getHistory();
    expect(Array.isArray(history)).toBe(true);
  });
});

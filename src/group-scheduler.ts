/**
 * @fileoverview Group Scheduler - Topological ordering and dependency management.
 *
 * Builds execution schedules from parallel groups, manages dependencies
 * between groups, and tracks group-level completion status.
 *
 * @module group-scheduler
 */

import { EventEmitter } from 'node:events';
import type { ExecutionMode } from './model-selector.js';
import type { ModelTier, AgentType } from './model-selector.js';

// ========== Types ==========

/** Status of a task within a group */
export type GroupTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';

/** Status of an execution group */
export type ExecutionGroupStatus = 'pending' | 'ready' | 'running' | 'completed' | 'partial' | 'failed';

/**
 * A task within an execution group.
 */
export interface GroupTask {
  /** Task ID from the plan */
  id: string;
  /** Task title/description */
  title: string;
  /** Full task description */
  description: string;
  /** Parallel group number */
  parallelGroup: number;
  /** Agent type for model selection */
  agentType: AgentType;
  /** Recommended model */
  recommendedModel?: ModelTier;
  /** Whether task requires fresh context */
  requiresFreshContext: boolean;
  /** Estimated token usage */
  estimatedTokens?: number;
  /** Input files (read-only) */
  inputFiles?: string[];
  /** Output files (will be modified) */
  outputFiles?: string[];
  /** Current status */
  status: GroupTaskStatus;
  /** Task dependencies (other task IDs) */
  dependencies: string[];
  /** Error message if failed */
  error?: string;
  /** Retry count */
  retryCount: number;
}

/**
 * An execution group containing tasks that can run in parallel.
 */
export interface ExecutionGroup {
  /** Group number (from parallelGroup) */
  groupNumber: number;
  /** Tasks in this group */
  tasks: GroupTask[];
  /** Group status */
  status: ExecutionGroupStatus;
  /** Execution mode for this group */
  executionMode: ExecutionMode;
  /** Rationale for execution mode choice */
  executionModeRationale: string;
  /** Groups that must complete before this one */
  dependsOnGroups: number[];
  /** When group started executing */
  startedAt?: number;
  /** When group completed */
  completedAt?: number;
  /** Number of tasks completed */
  completedCount: number;
  /** Number of tasks failed */
  failedCount: number;
  /** Number of tasks skipped due to dependency failures */
  skippedCount: number;
}

/**
 * Full execution schedule.
 */
export interface ExecutionSchedule {
  /** Ordered groups (by dependency order) */
  groups: ExecutionGroup[];
  /** Total task count */
  totalTasks: number;
  /** Completed task count */
  completedTasks: number;
  /** Failed task count */
  failedTasks: number;
  /** Current executing group index (-1 if not started) */
  currentGroupIndex: number;
  /** Overall status */
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed';
}

// ========== Events ==========

export interface GroupSchedulerEvents {
  /** Schedule built from plan */
  scheduleBuilt: (schedule: ExecutionSchedule) => void;
  /** Group started executing */
  groupStarted: (group: ExecutionGroup) => void;
  /** Group completed (fully or partially) */
  groupCompleted: (group: ExecutionGroup) => void;
  /** Task status changed */
  taskStatusChanged: (data: { taskId: string; groupNumber: number; oldStatus: GroupTaskStatus; newStatus: GroupTaskStatus }) => void;
}

// ========== Group Scheduler ==========

/**
 * GroupScheduler - Manages execution order and dependencies.
 *
 * Responsibilities:
 * - Build topologically ordered groups from plan items
 * - Track group dependencies (lower groups must complete first)
 * - Handle partial failures (continue with independent tasks)
 * - Determine group execution mode (session vs task-tool)
 */
export class GroupScheduler extends EventEmitter {
  private _schedule: ExecutionSchedule | null = null;
  private _taskToGroup: Map<string, number> = new Map();

  constructor() {
    super();
  }

  /**
   * Get current schedule.
   */
  get schedule(): ExecutionSchedule | null {
    return this._schedule;
  }

  /**
   * Build execution schedule from plan items.
   *
   * @param items - Array of plan items with parallelGroup assignments
   * @returns Built execution schedule
   */
  buildSchedule(items: Array<{
    id: string;
    title: string;
    description: string;
    parallelGroup?: number;
    agentType?: string;
    recommendedModel?: string;
    requiresFreshContext?: boolean;
    estimatedTokens?: number;
    inputFiles?: string[];
    outputFiles?: string[];
    dependencies?: string[];
  }>): ExecutionSchedule {
    // Group items by parallel group
    const groupMap = new Map<number, GroupTask[]>();

    for (const item of items) {
      const groupNum = item.parallelGroup ?? 0;
      const task: GroupTask = {
        id: item.id,
        title: item.title,
        description: item.description,
        parallelGroup: groupNum,
        agentType: (item.agentType as AgentType) ?? 'general',
        recommendedModel: item.recommendedModel as ModelTier | undefined,
        requiresFreshContext: item.requiresFreshContext ?? false,
        estimatedTokens: item.estimatedTokens,
        inputFiles: item.inputFiles,
        outputFiles: item.outputFiles,
        status: 'pending',
        dependencies: item.dependencies ?? [],
        retryCount: 0,
      };

      if (!groupMap.has(groupNum)) {
        groupMap.set(groupNum, []);
      }
      groupMap.get(groupNum)!.push(task);
      this._taskToGroup.set(item.id, groupNum);
    }

    // Sort groups by number
    const sortedGroupNums = Array.from(groupMap.keys()).sort((a, b) => a - b);

    // Build execution groups
    const groups: ExecutionGroup[] = sortedGroupNums.map(groupNum => {
      const tasks = groupMap.get(groupNum)!;

      // Determine which groups this one depends on
      const dependsOnGroups = new Set<number>();
      for (const task of tasks) {
        for (const depId of task.dependencies) {
          const depGroup = this._taskToGroup.get(depId);
          if (depGroup !== undefined && depGroup !== groupNum && depGroup < groupNum) {
            dependsOnGroups.add(depGroup);
          }
        }
      }

      // Determine execution mode based on task characteristics
      const { mode, rationale } = this.determineGroupExecutionMode(tasks);

      return {
        groupNumber: groupNum,
        tasks,
        status: 'pending',
        executionMode: mode,
        executionModeRationale: rationale,
        dependsOnGroups: Array.from(dependsOnGroups).sort((a, b) => a - b),
        completedCount: 0,
        failedCount: 0,
        skippedCount: 0,
      };
    });

    this._schedule = {
      groups,
      totalTasks: items.length,
      completedTasks: 0,
      failedTasks: 0,
      currentGroupIndex: -1,
      status: 'pending',
    };

    this.emit('scheduleBuilt', this._schedule);
    return this._schedule;
  }

  /**
   * Determine execution mode for a group based on task characteristics.
   */
  private determineGroupExecutionMode(tasks: GroupTask[]): { mode: ExecutionMode; rationale: string } {
    // High token estimate → session mode
    const highTokenTask = tasks.find(t => t.estimatedTokens && t.estimatedTokens > 50000);
    if (highTokenTask) {
      return {
        mode: 'session',
        rationale: `Task ${highTokenTask.id} has high token estimate (${highTokenTask.estimatedTokens})`,
      };
    }

    // Complex agent types → session mode
    const complexTask = tasks.find(t => t.agentType === 'implement' || t.agentType === 'review');
    if (complexTask) {
      return {
        mode: 'session',
        rationale: `Task ${complexTask.id} has complex agent type (${complexTask.agentType})`,
      };
    }

    // Multiple output files in any task → session mode
    const multiOutputTask = tasks.find(t => t.outputFiles && t.outputFiles.length > 2);
    if (multiOutputTask) {
      return {
        mode: 'session',
        rationale: `Task ${multiOutputTask.id} has multiple output files (${multiOutputTask.outputFiles!.length})`,
      };
    }

    // Fresh context required → session mode
    const freshContextTask = tasks.find(t => t.requiresFreshContext);
    if (freshContextTask) {
      return {
        mode: 'session',
        rationale: `Task ${freshContextTask.id} requires fresh context`,
      };
    }

    // All low-token explore tasks → task-tool mode
    const allLowToken = tasks.every(t => !t.estimatedTokens || t.estimatedTokens < 15000);
    const allExplore = tasks.every(t => t.agentType === 'explore' || t.agentType === 'general');
    if (allLowToken && allExplore) {
      return {
        mode: 'task-tool',
        rationale: 'All tasks are low-token explore/general tasks',
      };
    }

    // Default to session mode for reliability
    return {
      mode: 'session',
      rationale: 'Default to session mode for reliability',
    };
  }

  /**
   * Get the next group ready for execution.
   */
  getNextReadyGroup(): ExecutionGroup | null {
    if (!this._schedule) return null;

    for (const group of this._schedule.groups) {
      if (group.status === 'pending' && this.areGroupDependenciesSatisfied(group)) {
        group.status = 'ready';
        return group;
      }
    }

    return null;
  }

  /**
   * Check if a group's dependencies are satisfied.
   */
  areGroupDependenciesSatisfied(group: ExecutionGroup): boolean {
    if (!this._schedule) return false;

    for (const depGroupNum of group.dependsOnGroups) {
      const depGroup = this._schedule.groups.find(g => g.groupNumber === depGroupNum);
      if (!depGroup) continue;

      // Dependency must be completed (fully or partially)
      if (depGroup.status !== 'completed' && depGroup.status !== 'partial') {
        return false;
      }
    }

    return true;
  }

  /**
   * Mark a group as started.
   */
  startGroup(groupNumber: number): void {
    if (!this._schedule) return;

    const group = this._schedule.groups.find(g => g.groupNumber === groupNumber);
    if (!group) return;

    group.status = 'running';
    group.startedAt = Date.now();
    this._schedule.status = 'running';
    this._schedule.currentGroupIndex = this._schedule.groups.indexOf(group);

    this.emit('groupStarted', group);
  }

  /**
   * Update task status within a group.
   */
  updateTaskStatus(taskId: string, status: GroupTaskStatus, error?: string): void {
    if (!this._schedule) return;

    const groupNum = this._taskToGroup.get(taskId);
    if (groupNum === undefined) return;

    const group = this._schedule.groups.find(g => g.groupNumber === groupNum);
    if (!group) return;

    const task = group.tasks.find(t => t.id === taskId);
    if (!task) return;

    const oldStatus = task.status;
    task.status = status;
    if (error) task.error = error;

    // Update group counters
    if (status === 'completed') {
      group.completedCount++;
      this._schedule.completedTasks++;
    } else if (status === 'failed') {
      group.failedCount++;
      this._schedule.failedTasks++;
    } else if (status === 'skipped') {
      group.skippedCount++;
    }

    this.emit('taskStatusChanged', { taskId, groupNumber: groupNum, oldStatus, newStatus: status });

    // Check if group is complete
    this.checkGroupCompletion(group);
  }

  /**
   * Mark tasks blocked by a failed dependency.
   */
  markDependentTasksBlocked(failedTaskId: string): void {
    if (!this._schedule) return;

    for (const group of this._schedule.groups) {
      for (const task of group.tasks) {
        if (task.dependencies.includes(failedTaskId) && task.status === 'pending') {
          this.updateTaskStatus(task.id, 'skipped', `Blocked by failed task ${failedTaskId}`);
        }
      }
    }
  }

  /**
   * Get tasks ready to execute in a group.
   */
  getReadyTasksInGroup(groupNumber: number): GroupTask[] {
    if (!this._schedule) return [];

    const group = this._schedule.groups.find(g => g.groupNumber === groupNumber);
    if (!group) return [];

    return group.tasks.filter(task => {
      if (task.status !== 'pending') return false;

      // Check if task dependencies are satisfied (within and across groups)
      for (const depId of task.dependencies) {
        // Check if dependency is in the same group
        const sameGroupDep = group.tasks.find(t => t.id === depId);
        if (sameGroupDep && sameGroupDep.status !== 'completed') {
          return false;
        }

        // Check if dependency is in a different group
        const depGroupNum = this._taskToGroup.get(depId);
        if (depGroupNum !== undefined && depGroupNum !== groupNumber) {
          const depGroup = this._schedule!.groups.find(g => g.groupNumber === depGroupNum);
          const depTask = depGroup?.tasks.find(t => t.id === depId);
          if (depTask && depTask.status !== 'completed') {
            return false;
          }
        }
      }

      return true;
    });
  }

  /**
   * Check if a group has completed (all tasks done, failed, or skipped).
   */
  private checkGroupCompletion(group: ExecutionGroup): void {
    const pendingOrRunning = group.tasks.filter(
      t => t.status === 'pending' || t.status === 'running'
    );

    if (pendingOrRunning.length > 0) return;

    group.completedAt = Date.now();

    // Determine final status
    if (group.failedCount === 0 && group.skippedCount === 0) {
      group.status = 'completed';
    } else if (group.completedCount > 0) {
      group.status = 'partial';
    } else {
      group.status = 'failed';
    }

    this.emit('groupCompleted', group);

    // Check if all groups are done
    this.checkScheduleCompletion();
  }

  /**
   * Check if entire schedule has completed.
   */
  private checkScheduleCompletion(): void {
    if (!this._schedule) return;

    const pendingOrRunning = this._schedule.groups.filter(
      g => g.status === 'pending' || g.status === 'ready' || g.status === 'running'
    );

    if (pendingOrRunning.length > 0) return;

    // Determine final status
    const failedGroups = this._schedule.groups.filter(g => g.status === 'failed');
    const partialGroups = this._schedule.groups.filter(g => g.status === 'partial');

    if (failedGroups.length === this._schedule.groups.length) {
      this._schedule.status = 'failed';
    } else if (failedGroups.length > 0 || partialGroups.length > 0) {
      this._schedule.status = 'partial';
    } else {
      this._schedule.status = 'completed';
    }
  }

  /**
   * Get schedule statistics.
   */
  getStats(): {
    totalGroups: number;
    completedGroups: number;
    failedGroups: number;
    partialGroups: number;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    skippedTasks: number;
  } {
    if (!this._schedule) {
      return {
        totalGroups: 0,
        completedGroups: 0,
        failedGroups: 0,
        partialGroups: 0,
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        skippedTasks: 0,
      };
    }

    return {
      totalGroups: this._schedule.groups.length,
      completedGroups: this._schedule.groups.filter(g => g.status === 'completed').length,
      failedGroups: this._schedule.groups.filter(g => g.status === 'failed').length,
      partialGroups: this._schedule.groups.filter(g => g.status === 'partial').length,
      totalTasks: this._schedule.totalTasks,
      completedTasks: this._schedule.completedTasks,
      failedTasks: this._schedule.failedTasks,
      skippedTasks: this._schedule.groups.reduce((sum, g) => sum + g.skippedCount, 0),
    };
  }

  /**
   * Reset the scheduler.
   */
  reset(): void {
    this._schedule = null;
    this._taskToGroup.clear();
  }
}

// ========== Singleton ==========

let schedulerInstance: GroupScheduler | null = null;

/**
 * Get or create the singleton GroupScheduler instance.
 */
export function getGroupScheduler(): GroupScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new GroupScheduler();
  }
  return schedulerInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetGroupScheduler(): void {
  if (schedulerInstance) {
    schedulerInstance.reset();
  }
  schedulerInstance = null;
}

/**
 * @fileoverview Centralized limits for the Execution Bridge system.
 *
 * These constants define resource limits for parallel task execution,
 * group scheduling, and model selection.
 *
 * @module config/execution-limits
 */

// ============================================================================
// Parallel Execution Limits
// ============================================================================

/**
 * Maximum tasks to execute in parallel within a single group.
 * Higher values increase throughput but may strain system resources.
 */
export const MAX_PARALLEL_TASKS_PER_GROUP = 5;

/**
 * Default timeout for an execution group in milliseconds (30 minutes).
 * If all tasks in a group don't complete within this time, stragglers are cancelled.
 */
export const GROUP_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Maximum retry attempts for a failed task before marking as permanently failed.
 */
export const MAX_TASK_RETRIES = 2;

/**
 * Delay between task retries in milliseconds (10 seconds).
 */
export const TASK_RETRY_DELAY_MS = 10 * 1000;

// ============================================================================
// Model Selection Limits
// ============================================================================

/**
 * Default model when no recommendation is provided.
 */
export const DEFAULT_MODEL: 'opus' | 'sonnet' | 'haiku' = 'sonnet';

/**
 * Token threshold for switching execution modes.
 * Tasks with estimated tokens below this use task-tool mode.
 * Tasks with estimated tokens above this use session mode.
 */
export const TOKEN_THRESHOLD_FOR_SESSION_MODE = 50000;

/**
 * Token threshold for low-complexity tasks (haiku-appropriate).
 */
export const TOKEN_THRESHOLD_HAIKU = 15000;

// ============================================================================
// Context Management Limits
// ============================================================================

/**
 * Delay between /clear and /init commands in milliseconds.
 */
export const CONTEXT_REFRESH_DELAY_MS = 2000;

/**
 * Maximum pending context refresh operations.
 */
export const MAX_PENDING_CONTEXT_REFRESHES = 10;

// ============================================================================
// Execution Bridge Limits
// ============================================================================

/**
 * Maximum execution groups to track in history.
 */
export const MAX_EXECUTION_HISTORY = 50;

/**
 * Polling interval for execution progress in milliseconds.
 */
export const EXECUTION_POLL_INTERVAL_MS = 1000;

/**
 * Maximum total tasks in a single execution plan.
 */
export const MAX_TASKS_PER_PLAN = 100;

/**
 * Grace period after group completion before cleanup in milliseconds.
 */
export const GROUP_CLEANUP_DELAY_MS = 5000;

/**
 * @fileoverview Context Manager - Handles fresh context requirements.
 *
 * Manages context refresh operations for tasks that require starting
 * with a clean context window. Supports both /clear + /init sequences
 * and new session spawning.
 *
 * @module context-manager
 */

import { EventEmitter } from 'node:events';
import {
  CONTEXT_REFRESH_DELAY_MS,
  MAX_PENDING_CONTEXT_REFRESHES,
} from './config/execution-limits.js';

// ========== Types ==========

/** Methods for refreshing context */
export type ContextRefreshMethod = 'clear-init' | 'new-session';

/** Status of a context refresh operation */
export type ContextRefreshStatus = 'pending' | 'clearing' | 'initializing' | 'completed' | 'failed';

/**
 * Request for a context refresh.
 */
export interface ContextRefreshRequest {
  /** Task ID requesting refresh */
  taskId: string;
  /** Session ID to refresh */
  sessionId: string;
  /** Preferred refresh method */
  method: ContextRefreshMethod;
  /** Working directory (for new-session method) */
  workingDir?: string;
  /** Optional init prompt to use */
  initPrompt?: string;
}

/**
 * Result of a context refresh operation.
 */
export interface ContextRefreshResult {
  /** Request that was processed */
  request: ContextRefreshRequest;
  /** Final status */
  status: ContextRefreshStatus;
  /** New session ID (if method was new-session) */
  newSessionId?: string;
  /** Error message if failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Tracked refresh operation.
 */
interface TrackedRefresh {
  request: ContextRefreshRequest;
  status: ContextRefreshStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  newSessionId?: string;
}

// ========== Events ==========

export interface ContextManagerEvents {
  /** Context refresh started */
  refreshStarted: (data: { taskId: string; sessionId: string; method: ContextRefreshMethod }) => void;
  /** Context refresh completed */
  refreshCompleted: (result: ContextRefreshResult) => void;
  /** Context refresh failed */
  refreshFailed: (data: { taskId: string; sessionId: string; error: string }) => void;
}

// ========== Session Writer Interface ==========

/**
 * Interface for writing to sessions.
 * Injected to avoid circular dependencies.
 */
export interface SessionWriter {
  /** Write text to session */
  writeToSession(sessionId: string, text: string): void;
  /** Create a new session */
  createSession?(workingDir: string, name?: string): Promise<{ sessionId: string }>;
}

// ========== Context Manager ==========

/**
 * ContextManager - Handles context refresh operations.
 *
 * When a task requires fresh context (requiresFreshContext=true),
 * this manager coordinates the refresh using one of two methods:
 *
 * 1. clear-init: Send /clear followed by /init to existing session
 * 2. new-session: Spawn a completely new session (more expensive)
 */
export class ContextManager extends EventEmitter {
  private _pending: Map<string, TrackedRefresh> = new Map();
  private _sessionWriter: SessionWriter | null = null;
  private _refreshDelayMs: number;

  constructor(refreshDelayMs: number = CONTEXT_REFRESH_DELAY_MS) {
    super();
    this._refreshDelayMs = refreshDelayMs;
  }

  /**
   * Set the session writer for performing actual operations.
   */
  setSessionWriter(writer: SessionWriter): void {
    this._sessionWriter = writer;
  }

  /**
   * Get number of pending refresh operations.
   */
  get pendingCount(): number {
    return this._pending.size;
  }

  /**
   * Check if a refresh is pending for a session.
   */
  hasPendingRefresh(sessionId: string): boolean {
    for (const tracked of this._pending.values()) {
      if (tracked.request.sessionId === sessionId &&
          (tracked.status === 'pending' || tracked.status === 'clearing' || tracked.status === 'initializing')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Request a context refresh for a task.
   *
   * @returns Promise that resolves when refresh completes
   */
  async requestRefresh(request: ContextRefreshRequest): Promise<ContextRefreshResult> {
    if (!this._sessionWriter) {
      return {
        request,
        status: 'failed',
        error: 'No session writer configured',
        durationMs: 0,
      };
    }

    // Check pending limit
    if (this._pending.size >= MAX_PENDING_CONTEXT_REFRESHES) {
      return {
        request,
        status: 'failed',
        error: `Max pending refreshes (${MAX_PENDING_CONTEXT_REFRESHES}) exceeded`,
        durationMs: 0,
      };
    }

    // Track the refresh
    const tracked: TrackedRefresh = {
      request,
      status: 'pending',
      startedAt: Date.now(),
    };
    this._pending.set(request.taskId, tracked);

    this.emit('refreshStarted', {
      taskId: request.taskId,
      sessionId: request.sessionId,
      method: request.method,
    });

    try {
      if (request.method === 'clear-init') {
        await this.performClearInit(tracked);
      } else {
        await this.performNewSession(tracked);
      }

      tracked.status = 'completed';
      tracked.completedAt = Date.now();

      const result: ContextRefreshResult = {
        request,
        status: 'completed',
        newSessionId: tracked.newSessionId,
        durationMs: tracked.completedAt - tracked.startedAt,
      };

      this.emit('refreshCompleted', result);
      return result;

    } catch (err) {
      tracked.status = 'failed';
      tracked.error = err instanceof Error ? err.message : String(err);
      tracked.completedAt = Date.now();

      const result: ContextRefreshResult = {
        request,
        status: 'failed',
        error: tracked.error,
        durationMs: tracked.completedAt - tracked.startedAt,
      };

      this.emit('refreshFailed', {
        taskId: request.taskId,
        sessionId: request.sessionId,
        error: tracked.error,
      });

      return result;

    } finally {
      // Clean up after a delay
      setTimeout(() => {
        this._pending.delete(request.taskId);
      }, 5000);
    }
  }

  /**
   * Perform /clear + /init sequence.
   */
  private async performClearInit(tracked: TrackedRefresh): Promise<void> {
    if (!this._sessionWriter) throw new Error('No session writer');

    const { sessionId, initPrompt } = tracked.request;

    // Send /clear
    tracked.status = 'clearing';
    this._sessionWriter.writeToSession(sessionId, '/clear\r');

    // Wait for clear to process
    await this.delay(this._refreshDelayMs);

    // Send /init (or custom init prompt)
    tracked.status = 'initializing';
    const prompt = initPrompt || '/init';
    this._sessionWriter.writeToSession(sessionId, prompt + '\r');

    // Wait for init to complete
    await this.delay(this._refreshDelayMs);
  }

  /**
   * Spawn a new session for complete context isolation.
   */
  private async performNewSession(tracked: TrackedRefresh): Promise<void> {
    if (!this._sessionWriter?.createSession) {
      throw new Error('Session creation not supported');
    }

    const { workingDir, taskId } = tracked.request;
    if (!workingDir) {
      throw new Error('Working directory required for new-session method');
    }

    tracked.status = 'initializing';

    const result = await this._sessionWriter.createSession(workingDir, `task-${taskId}`);
    tracked.newSessionId = result.sessionId;
  }

  /**
   * Cancel a pending refresh.
   */
  cancelRefresh(taskId: string): boolean {
    const tracked = this._pending.get(taskId);
    if (tracked && tracked.status === 'pending') {
      tracked.status = 'failed';
      tracked.error = 'Cancelled';
      tracked.completedAt = Date.now();
      this._pending.delete(taskId);
      return true;
    }
    return false;
  }

  /**
   * Get status of all pending refreshes.
   */
  getPendingStatus(): Array<{ taskId: string; sessionId: string; status: ContextRefreshStatus; elapsedMs: number }> {
    const now = Date.now();
    return Array.from(this._pending.values()).map(tracked => ({
      taskId: tracked.request.taskId,
      sessionId: tracked.request.sessionId,
      status: tracked.status,
      elapsedMs: now - tracked.startedAt,
    }));
  }

  /**
   * Clear all pending operations (for cleanup).
   */
  clearAll(): void {
    this._pending.clear();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ========== Singleton ==========

let managerInstance: ContextManager | null = null;

/**
 * Get or create the singleton ContextManager instance.
 */
export function getContextManager(): ContextManager {
  if (!managerInstance) {
    managerInstance = new ContextManager();
  }
  return managerInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetContextManager(): void {
  if (managerInstance) {
    managerInstance.clearAll();
  }
  managerInstance = null;
}

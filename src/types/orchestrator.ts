/**
 * @fileoverview Orchestrator type definitions.
 *
 * Types for the automated orchestration system that watches for queued
 * work items, assigns them to agents, creates worktree sessions, monitors
 * progress, and handles cleanup.
 *
 * Key exports:
 * - OrchestratorConfig — tunable parameters (poll interval, stall thresholds, etc.)
 * - OrchestratorDecision — record of an agent assignment decision
 * - OrchestratorStatus — current orchestrator state for API consumers
 * - DEFAULT_ORCHESTRATOR_CONFIG — sensible defaults
 *
 * Consumed by: src/orchestrator.ts, src/web/routes/orchestrator-routes.ts,
 * src/types/app-state.ts (AppConfig.orchestrator)
 */

export interface OrchestratorConfig {
  /** Polling interval for the orchestration loop (ms). Default 30000. */
  pollIntervalMs: number;
  /** Idle threshold before sending a nudge prompt (ms). Default 600000 (10 min). */
  stallThresholdMs: number;
  /** Idle threshold after nudge before marking blocked (ms). Default 1200000 (20 min). */
  nudgeThresholdMs: number;
  /** Maximum concurrent dispatched work items. Default 10. */
  maxConcurrentDispatches: number;
  /** Orchestrator mode. Default 'hybrid'. */
  mode: 'hybrid' | 'autonomous';
  /** Minimum score gap for a "clear winner" in capability matching. Default 3. */
  matchingThreshold: number;
}

export interface OrchestratorDecision {
  workItemId: string;
  agentId: string | null;
  method: 'explicit' | 'mechanical' | 'llm' | 'fallback';
  reasoning: string;
  timestamp: string;
}

export interface OrchestratorStatus {
  running: boolean;
  mode: string;
  activeCases: string[];
  activeDispatches: number;
  lastActionAt: string | null;
  recentDecisions: OrchestratorDecision[];
  config: OrchestratorConfig;
}

export interface MergePrepResult {
  passed: boolean;
  tscErrors?: string;
  lintErrors?: string;
  commitsAhead?: number;
  failures: string[];
  timestamp: string;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  pollIntervalMs: 30000,
  stallThresholdMs: 600000,
  nudgeThresholdMs: 1200000,
  maxConcurrentDispatches: 10,
  mode: 'hybrid',
  matchingThreshold: 3,
};

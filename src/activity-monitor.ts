/**
 * @fileoverview The activity-monitor contract shared by every harness activity source, and the
 * factory map `Session` uses to attach one. See
 * docs/superpowers/specs/2026-09-10-harness-activity-detection-design.md §5.
 *
 * A monitor emits `working` and `idle` (optionally `{ reason }`, see `IdleInfo`) and exposes its
 * current `state`. `Session._attachActivityMonitor()` is the only consumer.
 *
 * @module activity-monitor
 */

import type { EventEmitter } from 'node:events';
import { ClaudeActivityMonitor } from './claude-activity-monitor.js';
import { CodexTranscriptActivityMonitor } from './codex-transcript-activity-monitor.js';
import { codexTranscriptAdapter } from './harnesses/transcripts/codex.js';
import { HookActivityMonitor } from './hook-activity-monitor.js';
import type { ActivitySource } from './types/activity.js';

export type ActivityState = 'working' | 'idle' | 'unknown';

export interface ActivityMonitor extends EventEmitter {
  readonly state: ActivityState;
  start(): Promise<void>;
  stop(): void;
  /** Called when the session learns its harness-native id (e.g. codex rollout discovery). */
  setHarnessSessionId?(id: string): void;
}

/** The subset of `Session` a monitor factory may read. */
export interface ActivityMonitorHost {
  readonly id: string;
  readonly workingDir: string;
  readonly harnessSessionId?: string;
}

export type ActivityMonitorFactory = (host: ActivityMonitorHost) => ActivityMonitor | null;

/**
 * One factory per activity source. `null` means no monitor: 'pty' harnesses keep the PTY
 * heuristics in `Session`. Mutable so tests can substitute fakes.
 */
export const activityMonitorFactories: Record<ActivitySource, ActivityMonitorFactory | null> = {
  claudeTranscript: (host) => new ClaudeActivityMonitor(host.id, host.workingDir),
  // pi: reports arrive through Session.applyHookActivity(), which forwards to this monitor.
  hook: () => new HookActivityMonitor(),
  // codex is the only 'transcript' harness. ActivityMonitorHost exposes `id`, not `sessionId`.
  transcript: (host) =>
    new CodexTranscriptActivityMonitor(codexTranscriptAdapter, {
      workingDir: host.workingDir,
      sessionId: host.id,
      harnessSessionId: host.harnessSessionId,
    }),
  pty: null,
};

export function createActivityMonitor(source: ActivitySource, host: ActivityMonitorHost): ActivityMonitor | null {
  const factory = activityMonitorFactories[source];
  return factory ? factory(host) : null;
}

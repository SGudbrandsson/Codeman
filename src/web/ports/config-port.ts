/**
 * @fileoverview Config port — capabilities for app configuration and settings.
 * Route modules that read or modify configuration depend on this port.
 */

import type { ClaudeMode, NiceConfig } from '../../types.js';
import type { StateStore } from '../../state-store.js';

export interface ConfigPort {
  readonly store: StateStore;
  readonly port: number;
  readonly https: boolean;
  readonly testMode: boolean;
  readonly serverStartTime: number;
  getGlobalNiceConfig(): Promise<NiceConfig | undefined>;
  getModelConfig(): Promise<{ defaultModel?: string; agentTypeOverrides?: Record<string, string> } | null>;
  getClaudeModeConfig(): Promise<{ claudeMode?: ClaudeMode; allowedTools?: string }>;
  getDefaultClaudeMdPath(): Promise<string | undefined>;
  getLightState(): unknown;
  getLightSessionsState(): unknown[];
  startTranscriptWatcher(sessionId: string, transcriptPath: string): void;
  /**
   * View-only watcher for a harness with `caps.transcript && !caps.claudeTranscript` (codex, pi).
   * Resolves the path itself via the harness adapter; returns it, or null if none yet.
   */
  startHarnessTranscriptWatcher(sessionId: string): string | null;
  /**
   * The session file named by an accepted harness_activity report ('hook' harnesses: pi).
   * The authoritative transcript path for that session.
   */
  acceptHarnessTranscriptPath(sessionId: string, sessionFile: string): void;
  /** Identity of the file the session's transcript watcher is streaming, or undefined with no watcher. */
  getTranscriptId(sessionId: string): string | undefined;
  /** Resolves the on-disk transcript for a conversation, or null when it no longer exists. */
  resolveSessionTranscript(workingDir: string, claudeResumeId: string | undefined): string | null;
  stopTranscriptWatcher(sessionId: string): void;
  getTranscriptPath(sessionId: string): string | null;
  /** Lite transcript state for the Hermes digest; null when no watcher is attached. */
  getTranscriptState(sessionId: string): import('../hermes/digest.js').TranscriptStateLite | null;
}

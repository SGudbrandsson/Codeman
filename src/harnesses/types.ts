/**
 * @fileoverview Types describing a Codeman session harness (the CLI backend a
 * session runs). One HarnessDefinition per SessionMode; see registry.ts.
 *
 * @module harnesses/types
 */

import type { ClaudeMode, OpenCodeConfig, SessionMode } from '../types/session.js';

/** Minimal per-harness config: the only knob codex and pi expose is the model. */
export interface HarnessModelConfig {
  model?: string;
}

/**
 * Feature flags describing what Codeman subsystems apply to a harness.
 *
 * These replace the ad-hoc `session.mode !== 'opencode'` guards, which actually
 * meant "this is a Claude-only feature" but read as "anything but opencode" —
 * and so were silently true for shell sessions too.
 */
export interface HarnessCapabilities {
  /** Ralph / todo loop tracker is meaningful for this harness. */
  ralph: boolean;
  /** Respawn controller may be armed for this harness. */
  respawn: boolean;
  /** Harness writes Claude-format transcript JSONL (transcript view, claudeResumeId). */
  claudeTranscript: boolean;
  /** Terminal output can be fed to Claude-specific parsers (BashToolParser, tokens, CLI info). */
  claudeParsers: boolean;
  /** Harness cannot run under a direct PTY; requires tmux for env injection / TUI. */
  requiresMux: boolean;
  /** Harness accepts a caller-chosen session id, so Codeman's own id can be reused. */
  preassignsSessionId: boolean;
  /** Session may be paused/parked. Requires a resumable Claude transcript today. */
  pausable: boolean;
  /** Claude-format hooks (.claude/settings.local.json) apply to this harness's cases. */
  claudeHooks: boolean;
  /** The global Claude default model applies to this harness. */
  usesClaudeModelDefaults: boolean;
}

/** Everything buildCommand needs to construct a spawn command string. */
export interface HarnessSpawnContext {
  sessionId: string;
  mode: SessionMode;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
  codexConfig?: HarnessModelConfig;
  piConfig?: HarnessModelConfig;
  extraArgs?: string[];
  /** Harness-native id to resume, when the harness supports resuming. */
  harnessSessionId?: string;
}

/**
 * How to decide a freshly started harness is ready.
 * - 'prompt': watch for the CLI's prompt marker (Claude's ❯), then clear the buffer.
 * - 'settle': full-screen TUI with no prompt marker; wait a fixed period, keep the buffer.
 */
export type HarnessReadiness = { kind: 'prompt' } | { kind: 'settle'; ms: number };

export interface HarnessDefinition {
  id: SessionMode;
  /** Human-readable name, used in UI copy and error messages. e.g. 'Codex'. */
  label: string;
  /** Two-character tab badge. e.g. 'cx'. */
  shortLabel: string;
  /** Binary to resolve on PATH, or null for shell (which uses $SHELL). */
  binary: string | null;
  /** Fallback directories searched when `which <binary>` finds nothing. */
  searchDirs: string[];
  /** Shown to the user when the binary is missing. */
  installHint: string;
  buildCommand(ctx: HarnessSpawnContext): string;
  /** Optional tmux `setenv` work performed after session creation (API keys, config JSON). */
  setupMuxEnv?(muxName: string, ctx: HarnessSpawnContext): void;
  readiness: HarnessReadiness;
  caps: HarnessCapabilities;
}

/**
 * @fileoverview Types describing a Codeman session harness (the CLI backend a
 * session runs). One HarnessDefinition per SessionMode; see registry.ts.
 *
 * @module harnesses/types
 */

import type { ClaudeMode, OpenCodeConfig, SessionMode } from '../types/session.js';
import type { ActivitySource } from '../types/activity.js';

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
  /**
   * Harness has a viewable transcript: the web transcript view and its toggle are offered,
   * backed by a per-harness adapter in src/harnesses/transcripts/. Says nothing about the
   * file format — see `claudeTranscript` for that.
   */
  transcript: boolean;
  /**
   * Harness speaks Claude's transcript JSONL schema, `--resume`, Claude hooks and the Claude
   * state machine in TranscriptWatcher (claudeResumeId, completion, plan mode). Deliberately
   * separate from `transcript`: it also hides the Respawn/Ralph tabs client-side.
   */
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
  /** The session's working directory. codex uses it to pre-trust the directory for this launch. */
  workingDir?: string;
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
  /**
   * Where busy/idle status comes from: Claude's JSONL monitor ('claudeTranscript'), reports
   * posted by a harness extension ('hook'), the harness's own transcript records
   * ('transcript'), or terminal-output heuristics ('pty').
   */
  activity: ActivitySource;
  caps: HarnessCapabilities;
}

/**
 * POSIX single-quote a string for safe interpolation into a `sh -c` command line.
 *
 * Harness commands are assembled as shell strings, so every value that can carry
 * user-supplied text MUST go through this. `JSON.stringify` is NOT a substitute:
 * it emits double quotes, and the shell still expands `$(...)`, backticks and
 * backslashes inside those. `worktreeNotes` reaches `extraArgs` as free-form user
 * text, so double quoting is command injection.
 *
 * This protects the INNER layer — the command bash runs inside the pane. The outer
 * layer (handing that command to tmux) is a separate concern: it is safe only because
 * both spawn sites invoke tmux via the argv form (`execFileSync`/`execFile`, no shell).
 * Reintroducing a `execSync(\`tmux ... ${JSON.stringify(cmd)}\`)` template would reopen
 * the hole at that outer /bin/sh regardless of this function. See
 * test/tmux-spawn-outer-shell.test.ts.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

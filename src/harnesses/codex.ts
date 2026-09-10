/**
 * @fileoverview The Codex CLI harness definition. Targets codex-cli 0.144.5.
 * @module harnesses/codex
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shellQuote } from './types.js';
import type { HarnessDefinition, HarnessSpawnContext } from './types.js';
import { MODEL_PATTERN } from './claude.js';

/**
 * Codex session ids are UUIDs; anything else must not reach the shell. Bounded to the
 * same length as CODEX_SESSION_ID_PATTERN in codex-session-discovery.ts — this is the
 * last line of defence for ids that did not come from discovery.
 */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

/** Control characters (U+0000–U+001F, U+007F) cannot appear in a TOML basic string. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A one-launch codex config override that trusts `workingDir`.
 *
 * A codex working directory that is not yet trusted shows "Do you trust the contents of
 * this directory?" with "No, quit" as an option, and typed input can select it and end the
 * session. Codeman already runs codex with --dangerously-bypass-approvals-and-sandbox, so
 * trusting the session's own directory matches that posture.
 *
 * Verified against codex 0.154.0:
 * - the inline-table form works for any path and writes nothing to ~/.codex/config.toml;
 * - `projects."<dir>".trust_level=…` still prompts, and an unquoted dotted key breaks on
 *   paths containing dots;
 * - codex matches the resolved path, so a symlinked key still prompts — hence realpath.
 *
 * The inline table replaces codex's `projects` table for this process only. That is harmless:
 * a codex session runs in a single directory.
 *
 * @returns the override value (without `-c`), or null when the directory cannot be resolved
 *   or its path cannot be expressed as a TOML string.
 */
export function codexTrustOverride(workingDir: string | undefined): string | null {
  if (!workingDir) return null;
  let real: string;
  try {
    real = realpathSync(workingDir);
  } catch {
    return null;
  }
  if (hasControlChars(real)) return null;
  const key = real.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `projects={"${key}"={trust_level="trusted"}}`;
}

export const codexHarness: HarnessDefinition = {
  id: 'codex',
  label: 'Codex',
  shortLabel: 'cx',
  binary: 'codex',
  searchDirs: [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.codex', 'bin'),
    '/usr/local/bin',
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), 'bin'),
  ],
  installHint: 'Codex CLI not found. Install with: npm i -g @openai/codex',
  // Codex renders a full-screen ratatui TUI with no prompt marker to watch for.
  readiness: { kind: 'settle', ms: 3000 },
  activity: 'transcript',
  caps: {
    ralph: false,
    respawn: false,
    transcript: true,
    claudeTranscript: false,
    claudeParsers: false,
    requiresMux: true,
    // Codex has no flag to preassign a session id; it is discovered after start.
    preassignsSessionId: false,
    pausable: false,
    claudeHooks: false,
    usesClaudeModelDefaults: false,
  },
  buildCommand(ctx: HarnessSpawnContext): string {
    // --no-alt-screen is required, not cosmetic: codex's TUI uses the alternate
    // screen by default, and tmux capture-pane scrollback — how Codeman restores
    // terminal buffers — is empty for an alt-screen application.
    const flags = ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen'];

    const model = ctx.codexConfig?.model;
    // Validate first (drop, never error), then quote — belt and braces.
    if (model && MODEL_PATTERN.test(model)) flags.push('-m', shellQuote(model));

    // Pre-trust the working directory for this launch only; see codexTrustOverride.
    const trust = codexTrustOverride(ctx.workingDir);
    if (trust) flags.push('-c', shellQuote(trust));

    // ctx.extraArgs is deliberately unsupported: codex takes no free-form trailing
    // arguments here, so worktree notes reach it via writeViaMux() after spawn instead.
    // (session.ts still marks _initialPromptSent when it passes extraArgs — that flag
    // tracks the note having been handed off, not this command consuming it.)
    const resumeId = ctx.harnessSessionId;
    if (resumeId && SESSION_ID_PATTERN.test(resumeId)) {
      return `codex resume ${shellQuote(resumeId)} ${flags.join(' ')}`;
    }
    return `codex ${flags.join(' ')}`;
  },
};

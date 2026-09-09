/**
 * @fileoverview The Codex CLI harness definition. Targets codex-cli 0.144.5.
 * @module harnesses/codex
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { shellQuote } from './types.js';
import type { HarnessDefinition, HarnessSpawnContext } from './types.js';
import { MODEL_PATTERN } from './claude.js';

/** Codex session ids are UUIDs; anything else must not reach the shell. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

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
  caps: {
    ralph: false,
    respawn: false,
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

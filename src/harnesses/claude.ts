/**
 * @fileoverview The Claude Code harness definition.
 * @module harnesses/claude
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeMode } from '../types/session.js';
import { shellQuote } from './types.js';
import type { HarnessDefinition, HarnessSpawnContext } from './types.js';

/** Model strings safe to interpolate into a shell command. */
export const MODEL_PATTERN = /^[a-zA-Z0-9._\-/:]+$/;

/** Claude's own model flag is stricter — no slashes or colons. */
const CLAUDE_MODEL_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Build Claude's permission flags.
 *
 * Copied verbatim from `buildClaudePermissionFlags` in tmux-manager.ts, including
 * the `dangerously-skip-permissions` default for an unset claudeMode — Task 1's
 * copy dropped both and would have changed behaviour once the delegation landed.
 */
function buildClaudePermissionFlags(claudeMode?: ClaudeMode, allowedTools?: string): string {
  const mode = claudeMode || 'dangerously-skip-permissions';
  switch (mode) {
    case 'dangerously-skip-permissions':
      return ' --dangerously-skip-permissions';
    case 'allowedTools':
      if (allowedTools) {
        // Sanitize: allow tool names with patterns like Bash(git:*), space/comma-separated
        // Block shell metacharacters: ; & | $ ` \ { } < > ' " newlines
        const hasDangerousChars = /[;&|$`\\{}<>'"[\]\n\r]/.test(allowedTools);
        if (!hasDangerousChars) {
          return ` --allowedTools "${allowedTools}"`;
        }
      }
      // Fall back to normal mode if tools are invalid or missing
      return '';
    case 'normal':
      return '';
  }
}

export const claudeHarness: HarnessDefinition = {
  id: 'claude',
  label: 'Claude Code',
  shortLabel: 'cc',
  binary: 'claude',
  searchDirs: [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.claude', 'local'),
    '/usr/local/bin',
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), 'bin'),
  ],
  installHint: 'Claude CLI not found. Install it with: curl -fsSL https://claude.ai/install.sh | bash',
  readiness: { kind: 'prompt' },
  activity: 'claudeTranscript',
  caps: {
    ralph: true,
    respawn: true,
    transcript: true,
    claudeTranscript: true,
    claudeParsers: true,
    requiresMux: false,
    preassignsSessionId: true,
    pausable: true,
    claudeHooks: true,
    usesClaudeModelDefaults: true,
  },
  buildCommand(ctx: HarnessSpawnContext): string {
    const safeModel = ctx.model && CLAUDE_MODEL_PATTERN.test(ctx.model) ? ctx.model : undefined;
    const modelFlag = safeModel ? ` --model ${safeModel}` : '';
    const extra = (ctx.extraArgs ?? []).map((a) => shellQuote(a)).join(' ');
    const extraStr = extra ? ` ${extra}` : '';
    // --session-id is only valid for fresh sessions; the Claude CLI rejects
    // --session-id together with --resume unless --fork-session is also passed
    // (which branches the conversation — not what a plain resume wants).
    const isResuming = (ctx.extraArgs ?? []).includes('--resume');
    const sessionIdFlag = isResuming ? '' : ` --session-id ${shellQuote(ctx.sessionId)}`;
    // AskUserQuestion is disabled for every Codeman claude session: its interactive
    // picker never renders in the web transcript, so Claude asks as plain text instead.
    const disallowFlag = ' --disallowedTools AskUserQuestion';
    const perms = buildClaudePermissionFlags(ctx.claudeMode, ctx.allowedTools);
    return `claude${perms}${sessionIdFlag}${modelFlag}${disallowFlag}${extraStr}`;
  },
};

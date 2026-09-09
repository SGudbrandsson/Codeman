/**
 * @fileoverview The Claude Code harness definition.
 * @module harnesses/claude
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeMode } from '../types/session.js';
import type { HarnessDefinition, HarnessSpawnContext } from './types.js';

/** Model strings safe to interpolate into a shell command. */
export const MODEL_PATTERN = /^[a-zA-Z0-9._\-/:]+$/;

/** Claude's own model flag is stricter — no slashes or colons. */
const CLAUDE_MODEL_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Build Claude's permission flags. Moved verbatim from tmux-manager. */
function buildClaudePermissionFlags(claudeMode?: ClaudeMode, allowedTools?: string): string {
  switch (claudeMode) {
    case 'dangerously-skip-permissions':
      return ' --dangerously-skip-permissions';
    case 'allowedTools': {
      if (allowedTools) {
        const hasDangerousChars = /[;&|`$(){}[\]<>\\'"]/.test(allowedTools);
        if (!hasDangerousChars) return ` --allowedTools "${allowedTools}"`;
      }
      return '';
    }
    case 'normal':
    default:
      return '';
  }
}

export const claudeHarness: HarnessDefinition = {
  id: 'claude',
  label: 'Claude Code',
  shortLabel: 'cc',
  binary: 'claude',
  searchDirs: [
    join(homedir(), '.claude', 'local'),
    join(homedir(), '.local', 'bin'),
    '/usr/local/bin',
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), 'bin'),
  ],
  installHint: 'Claude CLI not found. Install from https://claude.com/claude-code',
  readiness: { kind: 'prompt' },
  caps: {
    ralph: true,
    respawn: true,
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
    const extra = (ctx.extraArgs ?? []).map((a) => JSON.stringify(a)).join(' ');
    const extraStr = extra ? ` ${extra}` : '';
    // --session-id is only valid for fresh sessions; the Claude CLI rejects
    // --session-id together with --resume unless --fork-session is also passed
    // (which branches the conversation — not what a plain resume wants).
    const isResuming = (ctx.extraArgs ?? []).includes('--resume');
    const sessionIdFlag = isResuming ? '' : ` --session-id "${ctx.sessionId}"`;
    // AskUserQuestion is disabled for every Codeman claude session: its interactive
    // picker never renders in the web transcript, so Claude asks as plain text instead.
    const disallowFlag = ' --disallowedTools AskUserQuestion';
    const perms = buildClaudePermissionFlags(ctx.claudeMode, ctx.allowedTools);
    return `claude${perms}${sessionIdFlag}${modelFlag}${disallowFlag}${extraStr}`;
  },
};

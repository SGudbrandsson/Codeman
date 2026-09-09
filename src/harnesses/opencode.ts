/**
 * @fileoverview The OpenCode harness definition.
 *
 * `buildCommand` is moved verbatim from `buildOpenCodeCommand` and `setupMuxEnv`
 * from `setOpenCodeEnvVars` + `setOpenCodeConfigContent`, all previously in
 * src/tmux-manager.ts.
 *
 * @module harnesses/opencode
 */

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import type { OpenCodeConfig } from '../types/session.js';
import type { HarnessDefinition, HarnessSpawnContext } from './types.js';

/**
 * Set sensitive environment variables on a tmux session via setenv.
 * These are inherited by panes but not visible in ps output or tmux history.
 */
function setOpenCodeEnvVars(muxName: string): void {
  const sensitiveVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'];
  for (const key of sensitiveVars) {
    const val = process.env[key];
    if (val) {
      // Shell-escape: wrap in single quotes, escape any inner single quotes
      const escaped = val.replace(/'/g, "'\\''");
      try {
        execSync(`tmux setenv -t '${muxName}' ${key} '${escaped}'`, {
          encoding: 'utf8',
          timeout: EXEC_TIMEOUT_MS,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        /* Non-critical — key may not be needed */
      }
    }
  }
}

/**
 * Set OPENCODE_CONFIG_CONTENT on a tmux session via setenv.
 * Uses tmux setenv to avoid shell metacharacter injection from user-supplied JSON.
 */
function setOpenCodeConfigContent(muxName: string, config?: OpenCodeConfig): void {
  if (!config) return;

  let jsonContent: string | undefined;

  if (config.autoAllowTools) {
    const permConfig: Record<string, unknown> = { permission: { '*': 'allow' } };
    if (config.configContent) {
      try {
        const existing = JSON.parse(config.configContent) as Record<string, unknown>;
        Object.assign(permConfig, existing);
        permConfig.permission = { '*': 'allow' };
      } catch {
        /* invalid JSON, use default permConfig */
      }
    }
    jsonContent = JSON.stringify(permConfig);
  } else if (config.configContent) {
    // Validate JSON to prevent garbage config
    try {
      JSON.parse(config.configContent);
      jsonContent = config.configContent;
    } catch {
      console.error('[TmuxManager] Invalid JSON in openCodeConfig.configContent, skipping');
      return;
    }
  }

  if (jsonContent) {
    const escaped = jsonContent.replace(/'/g, "'\\''");
    try {
      execSync(`tmux setenv -t '${muxName}' OPENCODE_CONFIG_CONTENT '${escaped}'`, {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      /* Non-critical */
    }
  }
}

/**
 * Build the opencode CLI command with appropriate flags.
 */
function buildOpenCodeCommand(config?: OpenCodeConfig): string {
  const parts = ['opencode'];

  // Model selection — allow provider/model format (alphanumeric, dots, hyphens, slashes)
  if (config?.model) {
    const safeModel = /^[a-zA-Z0-9._\-/]+$/.test(config.model) ? config.model : undefined;
    if (safeModel) parts.push('--model', safeModel);
  }

  // Continue existing session
  if (config?.continueSession) {
    const safeId = /^[a-zA-Z0-9_-]+$/.test(config.continueSession) ? config.continueSession : undefined;
    if (safeId) parts.push('--session', safeId);
    if (safeId && config.forkSession) parts.push('--fork');
  }

  return parts.join(' ');
}

export const openCodeHarness: HarnessDefinition = {
  id: 'opencode',
  label: 'OpenCode',
  shortLabel: 'oc',
  binary: 'opencode',
  searchDirs: [
    join(homedir(), '.opencode', 'bin'), // Default install location
    join(homedir(), '.local', 'bin'), // Alternative install location
    '/usr/local/bin', // Homebrew / system
    join(homedir(), 'go', 'bin'), // Go install
    join(homedir(), '.bun', 'bin'), // Bun global
    join(homedir(), '.npm-global', 'bin'), // npm global
    join(homedir(), 'bin'), // User bin
  ],
  installHint: 'OpenCode CLI not found. Install from https://opencode.ai',
  readiness: { kind: 'settle', ms: 3000 },
  caps: {
    ralph: false,
    respawn: false,
    claudeTranscript: false,
    claudeParsers: false,
    requiresMux: true,
    preassignsSessionId: false,
    pausable: false,
    claudeHooks: false,
    usesClaudeModelDefaults: false,
  },
  buildCommand(ctx: HarnessSpawnContext): string {
    return buildOpenCodeCommand(ctx.openCodeConfig);
  },
  setupMuxEnv(muxName: string, ctx: HarnessSpawnContext): void {
    setOpenCodeEnvVars(muxName);
    setOpenCodeConfigContent(muxName, ctx.openCodeConfig);
  },
};

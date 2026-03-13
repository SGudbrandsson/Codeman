/**
 * @fileoverview Pure functions for building CLI arguments and environment variables
 * for Claude and OpenCode CLI spawning.
 *
 * Extracted from Session to keep argument construction logic testable and
 * separate from PTY lifecycle management.
 *
 * @module session-cli-builder
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeMode, McpServerEntry } from './types.js';
import { getAugmentedPath } from './utils/claude-cli-resolver.js';

/**
 * Build Claude CLI permission flags based on the configured mode.
 * Returns an array of args to pass to the CLI.
 */
export function buildPermissionArgs(claudeMode: ClaudeMode, allowedTools?: string): string[] {
  switch (claudeMode) {
    case 'dangerously-skip-permissions':
      return ['--dangerously-skip-permissions'];
    case 'allowedTools':
      if (allowedTools) {
        return ['--allowedTools', allowedTools];
      }
      // Fall back to normal mode if no tools specified
      return [];
    case 'normal':
    default:
      return [];
  }
}

/**
 * Build args for an interactive Claude CLI session (direct PTY, non-mux fallback).
 *
 * @param sessionId - The Codeman session ID (passed as --session-id to Claude for fresh sessions)
 * @param claudeMode - Permission mode for the CLI
 * @param model - Optional model override (e.g., 'opus', 'sonnet')
 * @param allowedTools - Optional comma-separated allowed tools list
 * @param resumeId - If set, --session-id is omitted (Claude CLI rejects --session-id + --resume without --fork-session)
 * @returns Array of CLI arguments
 */
export function buildInteractiveArgs(
  sessionId: string,
  claudeMode: ClaudeMode,
  model?: string,
  allowedTools?: string,
  resumeId?: string
): string[] {
  const args = [...buildPermissionArgs(claudeMode, allowedTools)];
  // --session-id is only valid for fresh sessions; combining it with --resume requires
  // --fork-session (which creates a branch) — not what we want for a plain resume.
  if (!resumeId) args.push('--session-id', sessionId);
  if (model) args.push('--model', model);
  return args;
}

/**
 * Build args for a one-shot Claude CLI prompt (runPrompt mode).
 *
 * @param prompt - The prompt text to send
 * @param model - Optional model override
 * @returns Array of CLI arguments
 */
export function buildPromptArgs(prompt: string, model?: string): string[] {
  const args = ['-p', '--verbose', '--dangerously-skip-permissions', '--output-format', 'stream-json'];
  if (model) {
    args.push('--model', model);
  }
  args.push(prompt);
  return args;
}

/**
 * Write a temp MCP config file for the session and return CLI flags to pass to Claude.
 * Only enabled servers are written. Returns empty array if no enabled servers.
 *
 * @param sessionId - Session ID used in the temp file name
 * @param mcpServers - MCP server entries for the session
 * @param resumeId - Optional Claude session UUID for --resume
 * @returns Extra args to append to the Claude CLI command
 */
export function buildMcpArgs(
  sessionId: string,
  mcpServers: McpServerEntry[] | undefined,
  resumeId: string | undefined
): string[] {
  const args: string[] = [];
  const enabled = (mcpServers ?? []).filter((s) => s.enabled);
  if (enabled.length > 0) {
    const configPath = join(tmpdir(), `codeman-mcp-${sessionId}.json`);
    const mcpConfig: Record<string, Record<string, unknown>> = {};
    for (const srv of enabled) {
      const entry: Record<string, unknown> = {};
      if (srv.command) {
        entry.command = srv.command;
        if (srv.args?.length) entry.args = srv.args;
        if (srv.env && Object.keys(srv.env).length) entry.env = srv.env;
      } else if (srv.type && srv.url) {
        entry.type = srv.type;
        entry.url = srv.url;
        if (srv.headers && Object.keys(srv.headers).length) entry.headers = srv.headers;
      }
      mcpConfig[srv.name] = entry;
    }
    writeFileSync(configPath, JSON.stringify({ mcpServers: mcpConfig }, null, 2));
    args.push('--mcp-config', configPath);
  }
  if (resumeId) {
    args.push('--resume', resumeId);
  }
  return args;
}

/**
 * Delete the temp MCP config file written by buildMcpArgs, if it exists.
 * Call this from session stop/restart to prevent accumulation of stale temp files.
 */
export function cleanupMcpConfig(sessionId: string): void {
  const configPath = join(tmpdir(), `codeman-mcp-${sessionId}.json`);
  try {
    unlinkSync(configPath);
  } catch {
    // File may not exist if no MCP servers were configured — that's fine
  }
}

/**
 * Build environment variables for Claude CLI processes (direct PTY, non-mux).
 *
 * Augments process.env with:
 * - UTF-8 locale settings
 * - Augmented PATH (includes Claude CLI directory)
 * - xterm-256color terminal type
 * - Codeman session identification vars
 *
 * @param sessionId - The Codeman session ID
 * @returns Environment variables object for pty.spawn
 */
export function buildClaudeEnv(sessionId: string): Record<string, string | undefined> {
  return {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    PATH: getAugmentedPath(),
    TERM: 'xterm-256color',
    COLORTERM: undefined,
    CLAUDECODE: undefined,
    // Inform Claude it's running within Codeman (helps prevent self-termination)
    CODEMAN_MUX: '1',
    CODEMAN_SESSION_ID: sessionId,
    CODEMAN_API_URL: process.env.CODEMAN_API_URL || 'http://localhost:3000',
  };
}

/**
 * Build environment variables for mux-attached PTY sessions (tmux attach).
 * Lighter than buildClaudeEnv — no PATH augmentation or Codeman vars needed
 * since the mux session already has those set.
 *
 * @returns Environment variables object for pty.spawn
 */
export function buildMuxAttachEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: undefined,
    CLAUDECODE: undefined,
  };
}

/**
 * Build environment variables for a direct shell session (non-mux fallback).
 *
 * @param sessionId - The Codeman session ID
 * @returns Environment variables object for pty.spawn
 */
export function buildShellEnv(sessionId: string): Record<string, string | undefined> {
  return {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    CODEMAN_MUX: '1',
    CODEMAN_SESSION_ID: sessionId,
    CODEMAN_API_URL: process.env.CODEMAN_API_URL || 'http://localhost:3000',
  };
}

/**
 * @fileoverview Claude Code hooks configuration generator.
 *
 * Generates `.claude/settings.local.json` with hook definitions that POST
 * to Codeman's `/api/hook-event` endpoint when Claude Code fires hooks.
 * Uses `$CODEMAN_API_URL` and `$CODEMAN_SESSION_ID` env vars (set on every
 * managed session) so the config is static per case directory.
 *
 * Key exports:
 * - `generateHooksConfig()` — returns hooks object for settings.local.json
 * - `writeHooksConfig(casePath)` — writes hooks + env config to disk
 * - `updateCaseEnvVars(casePath, envVars)` — merges env vars into settings
 *
 * Hook events generated: `idle_prompt`, `permission_prompt`, `elicitation_dialog`,
 * `ask_user_question`, `stop`, `teammate_idle`, `task_completed`
 *
 * Hook categories: `Notification` (3 matchers), `PreToolUse` (1: AskUserQuestion),
 * `Stop` (1), `TeammateIdle` (1), `TaskCompleted` (1)
 *
 * @dependencies types (HookEventType), config/auth-config (HOOK_TIMEOUT_MS)
 * @consumedby web/server (session creation), session-cli-builder (env setup)
 *
 * @module hooks-config
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { HookEventType } from './types.js';
import { HOOK_TIMEOUT_MS } from './config/auth-config.js';

/**
 * Generates the hooks section for .claude/settings.local.json
 *
 * The hook commands read stdin JSON from Claude Code (contains tool_name,
 * tool_input, etc.) and forward it as the `data` field to Codeman's API.
 * Env vars are resolved at runtime by the shell, so the config is static
 * per case directory.
 */
export function generateHooksConfig(): { hooks: Record<string, unknown[]> } {
  // Read Claude Code's stdin JSON and forward it as the data field.
  // Falls back to empty object if stdin is unavailable or malformed.
  const curlCmd = (event: HookEventType) =>
    `HOOK_DATA=$(cat 2>/dev/null || echo '{}'); ` +
    `printf '{"event":"${event}","sessionId":"%s","data":%s}' "$CODEMAN_SESSION_ID" "$HOOK_DATA" | ` +
    `curl -s -X POST "$CODEMAN_API_URL/api/hook-event" ` +
    `-H 'Content-Type: application/json' ` +
    `--data @- ` +
    `2>/dev/null || true`;

  return {
    hooks: {
      Notification: [
        {
          matcher: 'idle_prompt',
          hooks: [{ type: 'command', command: curlCmd('idle_prompt'), timeout: HOOK_TIMEOUT_MS }],
        },
        {
          matcher: 'permission_prompt',
          hooks: [{ type: 'command', command: curlCmd('permission_prompt'), timeout: HOOK_TIMEOUT_MS }],
        },
        {
          matcher: 'elicitation_dialog',
          hooks: [{ type: 'command', command: curlCmd('elicitation_dialog'), timeout: HOOK_TIMEOUT_MS }],
        },
      ],
      // PreToolUse for AskUserQuestion fires the moment Claude poses an interactive
      // question — BEFORE the user answers — and delivers the full structured
      // tool_input.questions (question text + option labels AND descriptions) on
      // stdin. This is the only live channel carrying the supporting info; the
      // transcript JSONL doesn't get the tool_use block until the turn flushes
      // (i.e. not while the question is pending), and the elicitation_dialog
      // Notification is MCP-only. The web client renders this into the transcript
      // view so the question is readable/answerable live, including on mobile.
      PreToolUse: [
        {
          matcher: 'AskUserQuestion',
          hooks: [{ type: 'command', command: curlCmd('ask_user_question'), timeout: HOOK_TIMEOUT_MS }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: curlCmd('stop'), timeout: HOOK_TIMEOUT_MS }],
        },
      ],
      TeammateIdle: [
        {
          hooks: [{ type: 'command', command: curlCmd('teammate_idle'), timeout: HOOK_TIMEOUT_MS }],
        },
      ],
      TaskCompleted: [
        {
          hooks: [{ type: 'command', command: curlCmd('task_completed'), timeout: HOOK_TIMEOUT_MS }],
        },
      ],
    },
  };
}

/**
 * Updates env vars in .claude/settings.local.json for the given case path.
 * Merges with existing env field; removes vars set to empty string.
 */
export async function updateCaseEnvVars(casePath: string, envVars: Record<string, string>): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  if (!existsSync(claudeDir)) {
    await mkdir(claudeDir, { recursive: true });
  }

  const settingsPath = join(claudeDir, 'settings.local.json');
  let existing: Record<string, unknown> = {};

  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
  } catch {
    existing = {};
  }

  const currentEnv = (existing.env as Record<string, string>) || {};
  for (const [key, value] of Object.entries(envVars)) {
    if (value) {
      currentEnv[key] = value;
    } else {
      delete currentEnv[key];
    }
  }
  existing.env = currentEnv;

  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
}

/**
 * Writes hooks config to .claude/settings.local.json in the given case path.
 * Merges with existing file content, only touching the `hooks` key.
 */
export async function writeHooksConfig(casePath: string): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  if (!existsSync(claudeDir)) {
    await mkdir(claudeDir, { recursive: true });
  }

  const settingsPath = join(claudeDir, 'settings.local.json');
  let existing: Record<string, unknown> = {};

  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
  } catch {
    // If file is malformed or doesn't exist, start fresh
    existing = {};
  }

  const hooksConfig = generateHooksConfig();
  const merged = { ...existing, ...hooksConfig };

  await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}

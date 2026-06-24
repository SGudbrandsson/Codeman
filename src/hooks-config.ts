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
import { homedir } from 'node:os';

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
// Read Claude Code's stdin JSON and forward it as the `data` field to Codeman's
// hook endpoint. Falls back to an empty object if stdin is unavailable/malformed.
// Resolved at hook-run time using the per-session $CODEMAN_API_URL /
// $CODEMAN_SESSION_ID env vars Codeman exports; outside a Codeman session those
// are unset and the curl simply no-ops (`|| true`). Shared by the per-worktree
// config and the global installer so the command stays identical.
function buildHookCurlCmd(event: HookEventType): string {
  return (
    `HOOK_DATA=$(cat 2>/dev/null || echo '{}'); ` +
    `printf '{"event":"${event}","sessionId":"%s","data":%s}' "$CODEMAN_SESSION_ID" "$HOOK_DATA" | ` +
    `curl -s -X POST "$CODEMAN_API_URL/api/hook-event" ` +
    `-H 'Content-Type: application/json' ` +
    `--data @- ` +
    `2>/dev/null || true`
  );
}

export function generateHooksConfig(): { hooks: Record<string, unknown[]> } {
  const curlCmd = buildHookCurlCmd;

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

/**
 * Idempotently install Codeman's GLOBAL `~/.claude/settings.json` hooks, so EVERY
 * Codeman-managed session — including main-repo sessions and pre-existing worktrees
 * that never had per-worktree hooks written — gets them with no per-worktree write
 * or restart. Installs:
 *  - Notification `idle_prompt` so the idle attention badge/queue/push fires for
 *    main-repo (non-worktree) sessions too (worktrees already get it via
 *    generateHooksConfig / settings.local.json).
 *
 * Also removes any stale Codeman-authored PreToolUse AskUserQuestion hook: that tool is
 * suppressed via `--disallowedTools` + the global `permissions.deny` rule, so the hook is
 * dead code and was needlessly reappearing after each restart.
 *
 * The hook only does anything inside a Codeman session (it relies on the
 * $CODEMAN_API_URL / $CODEMAN_SESSION_ID env vars Codeman exports per session); in
 * any other Claude usage the curl no-ops (`|| true`), so global install is safe.
 *
 * Safety guarantees:
 *  - Never clobbers — merges into existing settings, preserving every other key and
 *    any user-authored PreToolUse hooks.
 *  - Idempotent — does nothing once the idle_prompt hook is present and no stale
 *    AskUserQuestion hook remains.
 *  - Aborts (leaves the file untouched) if it exists but is unparseable or not a JSON
 *    object, so a hand-edited global config is never destroyed.
 *  - Opt out with CODEMAN_NO_GLOBAL_HOOK=1.
 *
 * Returns `{ installed, reason }`; never throws on the safe-abort paths.
 */
export async function installGlobalCodemanHooks(): Promise<{ installed: boolean; reason: string }> {
  if (process.env.CODEMAN_NO_GLOBAL_HOOK) {
    return { installed: false, reason: 'disabled via CODEMAN_NO_GLOBAL_HOOK' };
  }

  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');

  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(await readFile(settingsPath, 'utf-8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { installed: false, reason: 'global settings.json is not a JSON object — left untouched' };
      }
      existing = parsed as Record<string, unknown>;
    } catch {
      return { installed: false, reason: 'global settings.json is unparseable — left untouched' };
    }
  } else if (!existsSync(claudeDir)) {
    await mkdir(claudeDir, { recursive: true });
  }

  const hooks =
    existing.hooks && typeof existing.hooks === 'object' && !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as Array<Record<string, unknown>>) : [];

  // Codeman used to install a PreToolUse AskUserQuestion hook here. It is now dead code:
  // sessions launch with `--disallowedTools AskUserQuestion` AND the global
  // `permissions.deny` rule removes the tool from context, so Claude never invokes it and
  // the hook never fires. Stop installing it, and proactively strip any copy this installer
  // wrote in the past so it doesn't keep reappearing in ~/.claude/settings.json after a
  // server restart. Only Codeman's own entries (matcher AskUserQuestion + the
  // ask_user_question curl) are removed; user-authored PreToolUse hooks are left untouched.
  const isCodemanAskHook = (entry: Record<string, unknown>): boolean =>
    !!entry &&
    entry.matcher === 'AskUserQuestion' &&
    Array.isArray((entry as { hooks?: unknown }).hooks) &&
    (entry as { hooks: Array<{ command?: string }> }).hooks.some(
      (h) => typeof h?.command === 'string' && h.command.includes('ask_user_question')
    );
  const cleanedPreToolUse = preToolUse.filter((entry) => !isCodemanAskHook(entry));
  const askHookRemoved = cleanedPreToolUse.length !== preToolUse.length;

  // Global idle_prompt Notification hook: per-worktree settings.local.json already gets
  // this via generateHooksConfig(), but main-repo (non-worktree) Codeman sessions rely on
  // the global ~/.claude/settings.json, which has no Codeman idle_prompt matcher. Without
  // it the idle attention badge/queue/push never fires for those sessions. We add a
  // SEPARATE Notification matcher entry (do NOT merge into any unrelated existing entry,
  // e.g. workmux's permission_prompt|elicitation_dialog matcher running a different command).
  const notification = Array.isArray(hooks.Notification) ? (hooks.Notification as Array<Record<string, unknown>>) : [];
  const idlePromptCmd = buildHookCurlCmd('idle_prompt');
  const idleAlreadyInstalled = notification.some(
    (entry) =>
      entry &&
      Array.isArray((entry as { hooks?: unknown }).hooks) &&
      (entry as { hooks: Array<{ command?: string }> }).hooks.some(
        (h) =>
          typeof h?.command === 'string' && h.command.includes('/api/hook-event') && h.command.includes('"idle_prompt"')
      )
  );

  if (!askHookRemoved && idleAlreadyInstalled) {
    return { installed: false, reason: 'already present' };
  }

  if (askHookRemoved) {
    if (cleanedPreToolUse.length > 0) {
      hooks.PreToolUse = cleanedPreToolUse;
    } else {
      delete hooks.PreToolUse;
    }
  }

  if (!idleAlreadyInstalled) {
    notification.push({
      matcher: 'idle_prompt',
      hooks: [{ type: 'command', command: idlePromptCmd, timeout: HOOK_TIMEOUT_MS }],
    });
    hooks.Notification = notification;
  }

  existing.hooks = hooks;

  if (!existsSync(claudeDir)) {
    await mkdir(claudeDir, { recursive: true });
  }
  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  return {
    installed: true,
    reason: askHookRemoved
      ? 'removed stale AskUserQuestion hook; ensured idle_prompt hook'
      : 'installed idle_prompt hook',
  };
}

/**
 * @fileoverview Claude Code hooks configuration generator
 *
 * Generates .claude/settings.local.json with hook definitions that POST
 * to Claudeman's /api/hook-event endpoint when Claude Code fires
 * notification or stop hooks. Uses $CLAUDEMAN_API_URL and
 * $CLAUDEMAN_SESSION_ID env vars (set on every managed session) so the
 * config is static per case directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HookEventType } from './types.js';

/**
 * Generates the hooks section for .claude/settings.local.json
 *
 * The curl commands reference env vars that are resolved at runtime by
 * the shell, so the same config works for any session in the case dir.
 */
export function generateHooksConfig(): { hooks: Record<string, unknown[]> } {
  const curlCmd = (event: HookEventType) =>
    `curl -s -X POST $CLAUDEMAN_API_URL/api/hook-event ` +
    `-H 'Content-Type: application/json' ` +
    `-d '{"event":"${event}","sessionId":"'$CLAUDEMAN_SESSION_ID'"}' 2>/dev/null || true`;

  return {
    hooks: {
      Notification: [
        {
          matcher: 'idle_prompt',
          hooks: [{ type: 'command', command: curlCmd('idle_prompt'), timeout: 10000 }],
        },
        {
          matcher: 'permission_prompt',
          hooks: [{ type: 'command', command: curlCmd('permission_prompt'), timeout: 10000 }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: curlCmd('stop'), timeout: 10000 }],
        },
      ],
    },
  };
}

/**
 * Writes hooks config to .claude/settings.local.json in the given case path.
 * Merges with existing file content, only touching the `hooks` key.
 */
export function writeHooksConfig(casePath: string): void {
  const claudeDir = join(casePath, '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const settingsPath = join(claudeDir, 'settings.local.json');
  let existing: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      // If file is malformed, start fresh
      existing = {};
    }
  }

  const hooksConfig = generateHooksConfig();
  const merged = { ...existing, ...hooksConfig };

  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}

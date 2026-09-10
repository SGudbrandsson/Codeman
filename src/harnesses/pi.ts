/**
 * @fileoverview The Pi CLI harness definition (@earendil-works/pi-coding-agent).
 * Targets pi 0.85.1.
 * @module harnesses/pi
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from './types.js';
import type { HarnessDefinition, HarnessSpawnContext } from './types.js';
import { MODEL_PATTERN } from './claude.js';

/**
 * Pi session ids are internally generated UUIDs; anything else must not reach the shell.
 * Bounded to the same length as codex.ts's SESSION_ID_PATTERN.
 */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

// The Codeman activity extension (spec §3) sits beside this module: compiled .js under dist,
// .ts when running from source (pi loads either through jiti).
const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), 'pi');
const EXTENSION_CANDIDATES = [
  join(EXTENSION_DIR, 'codeman-activity-extension.js'),
  join(EXTENSION_DIR, 'codeman-activity-extension.ts'),
];

/** Absolute path of the pi activity extension, or null when neither build of it exists. */
export function resolvePiActivityExtension(exists: (path: string) => boolean = existsSync): string | null {
  return EXTENSION_CANDIDATES.find((p) => exists(p)) ?? null;
}

const piActivityExtension = resolvePiActivityExtension();
let warnedMissingExtension = false;

export const piHarness: HarnessDefinition = {
  id: 'pi',
  label: 'Pi',
  shortLabel: 'pi',
  binary: 'pi',
  searchDirs: [
    // pi installs here via npm -g. This directory is on an interactive shell's
    // PATH but NOT on the /bin/sh PATH that `which` sees from execSync, so the
    // fallback search is the only thing that finds it.
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), '.local', 'bin'),
    '/usr/local/bin',
    join(homedir(), '.bun', 'bin'),
    join(homedir(), 'bin'),
  ],
  installHint: 'Pi CLI not found. Install with: npm i -g @earendil-works/pi-coding-agent',
  readiness: { kind: 'settle', ms: 2000 },
  activity: 'hook',
  caps: {
    ralph: false,
    respawn: false,
    transcript: true,
    claudeTranscript: false,
    claudeParsers: false,
    requiresMux: true,
    // pi's --session-id creates the session when it does not exist, so Codeman's
    // own session id can be used directly and resume needs no discovery step.
    preassignsSessionId: true,
    pausable: false,
    claudeHooks: false,
    usesClaudeModelDefaults: false,
  },
  buildCommand(ctx: HarnessSpawnContext): string {
    // ctx.extraArgs is deliberately unsupported — see codexHarness.buildCommand:
    // worktree notes are delivered via writeViaMux() after spawn, not on the command line.
    const parts = ['pi', '--approve'];
    // Validate first (drop, never error), then quote — belt and braces.
    if (SESSION_ID_PATTERN.test(ctx.sessionId)) {
      parts.push('--session-id', shellQuote(ctx.sessionId));
    }
    const model = ctx.piConfig?.model;
    if (model && MODEL_PATTERN.test(model)) parts.push('--model', shellQuote(model));
    // Busy/idle for pi comes from this extension. Without it the session still spawns, but has
    // no activity tracking (status stays idle; never a false busy).
    if (piActivityExtension) {
      parts.push('-e', shellQuote(piActivityExtension));
    } else if (!warnedMissingExtension) {
      warnedMissingExtension = true;
      console.warn(
        `[pi] Codeman activity extension not found (${EXTENSION_CANDIDATES.join(', ')}); pi sessions will have no busy/idle tracking`
      );
    }
    return parts.join(' ');
  },
};

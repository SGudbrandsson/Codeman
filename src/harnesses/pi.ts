/**
 * @fileoverview The Pi CLI harness definition (@earendil-works/pi-coding-agent).
 * Targets pi 0.85.1.
 * @module harnesses/pi
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { shellQuote } from './types.js';
import type { HarnessDefinition, HarnessSpawnContext } from './types.js';
import { MODEL_PATTERN } from './claude.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

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
  caps: {
    ralph: false,
    respawn: false,
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
    const parts = ['pi', '--approve'];
    // Validate first (drop, never error), then quote — belt and braces.
    if (SESSION_ID_PATTERN.test(ctx.sessionId)) {
      parts.push('--session-id', shellQuote(ctx.sessionId));
    }
    const model = ctx.piConfig?.model;
    if (model && MODEL_PATTERN.test(model)) parts.push('--model', shellQuote(model));
    return parts.join(' ');
  },
};

/**
 * @fileoverview The harness registry: one HarnessDefinition per SessionMode.
 *
 * Adding a harness means adding a file here and a row in HARNESSES. Sites that
 * used to branch on the literal 'opencode' read `getHarness(mode).caps.<flag>`.
 *
 * @module harnesses/registry
 */

import type { SessionMode } from '../types/session.js';
import type { HarnessDefinition } from './types.js';
import { claudeHarness } from './claude.js';
import { shellHarness } from './shell.js';
import { openCodeHarness } from './opencode.js';

const HARNESSES: Partial<Record<SessionMode, HarnessDefinition>> = {
  claude: claudeHarness,
  shell: shellHarness,
  opencode: openCodeHarness,
};

/**
 * Look up a harness. Throws on an unknown mode.
 *
 * Throwing is deliberate: buildSpawnCommand used to fall through to `return '$SHELL'`,
 * so an unhandled mode silently launched a shell instead of the requested agent.
 */
export function getHarness(mode: SessionMode): HarnessDefinition {
  const def = HARNESSES[mode];
  if (!def) throw new Error(`Unknown harness mode: ${String(mode)}`);
  return def;
}

export function listHarnesses(): HarnessDefinition[] {
  return Object.values(HARNESSES) as HarnessDefinition[];
}

export { isHarnessAvailable, resolveHarnessDir } from './resolver.js';
export type { HarnessDefinition, HarnessCapabilities, HarnessSpawnContext } from './types.js';

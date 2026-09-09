/**
 * @fileoverview The plain-shell harness definition (no agent).
 * @module harnesses/shell
 */

import type { HarnessDefinition } from './types.js';

export const shellHarness: HarnessDefinition = {
  id: 'shell',
  label: 'Shell',
  shortLabel: 'sh',
  binary: null,
  searchDirs: [],
  installHint: '',
  readiness: { kind: 'prompt' },
  // Every Claude-only capability is false. Before the registry these guards read
  // `mode !== 'opencode'`, which was true for shell — so shell was given a ralph
  // tracker, a restorable respawn controller, and the Claude output parsers. That
  // was never intended; see spec section 2.
  caps: {
    ralph: false,
    respawn: false,
    claudeTranscript: false,
    claudeParsers: false,
    requiresMux: false,
    preassignsSessionId: false,
    pausable: false,
    claudeHooks: false,
    usesClaudeModelDefaults: false,
  },
  buildCommand(): string {
    return '$SHELL';
  },
};

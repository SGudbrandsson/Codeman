/**
 * @fileoverview Generic harness binary resolution.
 *
 * Replaces the duplicated `which`-then-search-dirs logic that lived separately in
 * utils/claude-cli-resolver.ts and utils/opencode-cli-resolver.ts.
 *
 * @module harnesses/resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import type { HarnessDefinition } from './types.js';

/** Cache: binary name -> containing dir. Empty string means "searched, not found". */
const _cache = new Map<string, string>();

/**
 * Find the directory containing `binary`.
 * Tries `which` first (respects the current PATH), then the supplied fallbacks.
 *
 * Note: `execSync` runs under /bin/sh, whose PATH is narrower than an interactive
 * shell's. A binary installed somewhere like ~/.npm-global/bin will NOT be found by
 * `which` here — that is exactly what searchDirs is for.
 */
export function resolveHarnessDir(binary: string, searchDirs: string[]): string | null {
  const cached = _cache.get(binary);
  if (cached !== undefined) return cached || null;

  try {
    const result = execSync(`which ${binary}`, { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }).trim();
    if (result && existsSync(result)) {
      const dir = dirname(result);
      _cache.set(binary, dir);
      return dir;
    }
  } catch {
    // Not on /bin/sh's PATH — fall through to the explicit search dirs.
  }

  for (const dir of searchDirs) {
    if (existsSync(join(dir, binary))) {
      _cache.set(binary, dir);
      return dir;
    }
  }

  _cache.set(binary, '');
  return null;
}

/** True when the harness needs no binary (shell) or its binary resolves. */
export function isHarnessAvailable(def: HarnessDefinition): boolean {
  if (!def.binary) return true;
  return resolveHarnessDir(def.binary, def.searchDirs) !== null;
}

/** Test-only: drop the resolution cache. */
export function _clearResolverCache(): void {
  _cache.clear();
}

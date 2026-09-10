/**
 * @fileoverview Path-safety helpers shared by the transcript locators.
 *
 * Locators build paths from persisted or discovered session fields. Every candidate must
 * resolve (symlinks included) to a file under that harness's transcript root; anything
 * else yields null, never a read.
 *
 * @module harnesses/transcripts/paths
 */

import { realpathSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

/**
 * Resolve symlinks on both `candidate` and `root` and return the canonical candidate path
 * if it lies strictly inside the canonical root. Returns null when either does not exist
 * or containment fails.
 */
export function assertUnderRoot(candidate: string, root: string): string | null {
  let realCandidate: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    realCandidate = realpathSync(candidate);
  } catch {
    return null;
  }
  const rel = relative(realRoot, realCandidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return realCandidate;
}

/**
 * Return the newest-mtime regular file in `dir` whose name satisfies `match`, or null.
 * Names are compared as plain strings — no glob, so an id can never widen the match.
 */
export function newestMatchingFile(dir: string, match: (name: string) => boolean): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!match(name)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs };
    } catch {
      continue;
    }
  }
  return best?.path ?? null;
}

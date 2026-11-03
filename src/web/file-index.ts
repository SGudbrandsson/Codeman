/**
 * @fileoverview Flat file index for the Files sheet fuzzy search.
 *
 * Walks a session's working directory breadth-first with async fs only (every
 * readdir yields the event loop — execSync / sync fs polling has frozen the UI in
 * this project before) and returns every regular file as a '/'-joined path
 * relative to the root. By user decision it does NOT consult git or .gitignore:
 * untracked and ignored files are listed too. Only the heavy/noise directories in
 * FILE_TREE_EXCLUDE_DIRS are skipped (the same set GET /files uses).
 *
 * Symlinked directories are never descended (a Dirent for a symlink reports
 * isDirectory() === false), so loops are impossible and the walk can't leave the
 * root. Symlinks to files are included. Breadth-first order means a cap only cuts
 * the deepest levels: shallow files are always present.
 */

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

/** Large/generated directories skipped by GET /files and the file index (matched by name at any depth). */
export const FILE_TREE_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '__pycache__',
  '.cache',
  '.next',
  '.nuxt',
  'coverage',
  '.venv',
  'venv',
  '.tox',
  'target',
  'vendor',
]);

/** Maximum number of paths returned by the file index. */
export const FILE_INDEX_CAP = 100_000;

/** How long a built index is reused for the same root + hidden setting. */
const FILE_INDEX_TTL_MS = 5_000;

/** Directories read concurrently per BFS batch. */
const WALK_CONCURRENCY = 8;

export interface FileIndexResult {
  paths: string[];
  truncated: boolean;
}

interface QueueEntry {
  abs: string;
  rel: string;
}

/**
 * Build a flat list of file paths under `root`. Throws if the root itself cannot
 * be read; unreadable subdirectories are skipped silently.
 */
export async function buildFileIndex(
  root: string,
  opts: { includeHidden: boolean; cap?: number }
): Promise<FileIndexResult> {
  const cap = opts.cap ?? FILE_INDEX_CAP;
  const paths: string[] = [];
  let truncated = false;

  // Root read failure is the only fatal error.
  const rootEntries = await fs.readdir(root, { withFileTypes: true });

  const queue: QueueEntry[] = [];
  let head = 0;

  /** Append a file path; returns false (and flags truncation) once the cap is hit. */
  const addPath = (rel: string): boolean => {
    if (paths.length >= cap) {
      truncated = true;
      return false;
    }
    paths.push(rel);
    return true;
  };

  const processEntries = async (entries: Dirent[], dir: QueueEntry): Promise<void> => {
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      if (!opts.includeHidden && name.startsWith('.')) continue;
      const rel = dir.rel ? dir.rel + '/' + name : name;
      if (entry.isDirectory()) {
        if (FILE_TREE_EXCLUDE_DIRS.has(name)) continue;
        queue.push({ abs: join(dir.abs, name), rel });
      } else if (entry.isFile()) {
        if (!addPath(rel)) return;
      } else if (entry.isSymbolicLink()) {
        // Never descend; include only when it resolves to a regular file.
        try {
          const st = await fs.stat(join(dir.abs, name));
          if (st.isFile() && !addPath(rel)) return;
        } catch {
          // dangling link / permission error: skip
        }
      }
      // sockets, fifos, devices: skipped
    }
  };

  await processEntries(rootEntries, { abs: root, rel: '' });

  while (head < queue.length && !truncated) {
    const batch = queue.slice(head, head + WALK_CONCURRENCY);
    head += batch.length;
    const listings = await Promise.all(batch.map((d) => fs.readdir(d.abs, { withFileTypes: true }).catch(() => null)));
    // Process in queue order so the result is deterministic and BFS-ordered.
    for (let i = 0; i < batch.length; i++) {
      const entries = listings[i];
      if (!entries) continue;
      await processEntries(entries, batch[i]);
      if (truncated) break;
    }
  }

  return { paths, truncated };
}

interface CacheEntry {
  at: number;
  promise: Promise<FileIndexResult>;
  settled: boolean;
}

const indexCache = new Map<string, CacheEntry>();
const INDEX_CACHE_MAX = 8;

/**
 * Cached wrapper around buildFileIndex: reuses a result (or an in-flight walk)
 * for the same root + hidden setting for a few seconds. `fresh` bypasses the cache.
 * Rejected walks are never cached.
 */
export function getFileIndex(
  root: string,
  includeHidden: boolean,
  opts: { fresh?: boolean } = {}
): Promise<FileIndexResult> {
  const key = `${root}\0${includeHidden}`;
  const now = Date.now();
  // Drop expired, settled entries so big indexes don't linger for the life of
  // the server (in-flight walks stay so concurrent callers still dedupe).
  for (const [k, e] of indexCache) {
    if (e.settled && now - e.at >= FILE_INDEX_TTL_MS) indexCache.delete(k);
  }
  const hit = indexCache.get(key);
  if (!opts.fresh && hit && now - hit.at < FILE_INDEX_TTL_MS) return hit.promise;

  const promise = buildFileIndex(root, { includeHidden });
  const entry: CacheEntry = { at: now, promise, settled: false };
  indexCache.delete(key);
  indexCache.set(key, entry);
  // Evict oldest entries beyond the cap (Map iterates in insertion order).
  while (indexCache.size > INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value;
    if (oldest === undefined) break;
    indexCache.delete(oldest);
  }
  promise.then(
    () => {
      entry.settled = true;
    },
    () => {
      entry.settled = true;
      if (indexCache.get(key) === entry) indexCache.delete(key);
    }
  );
  return promise;
}

/** Test hook: number of cached index entries. */
export function _fileIndexCacheSizeForTests(): number {
  return indexCache.size;
}

/** Test hook: drop every cached index. */
export function _resetFileIndexCacheForTests(): void {
  indexCache.clear();
}

/**
 * @fileoverview Recover a codex session id after start.
 *
 * Codex has no flag to preassign a session id, but it writes one rollout file per
 * session at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl. Its first
 * line is a `session_meta` record carrying both `session_id` and `cwd`.
 *
 * This mirrors how Codeman already locates Claude transcripts in
 * src/web/transcript-path-resolver.ts. Matching on cwd AND a start-time floor is what
 * keeps a concurrently running codex session in the same directory from being adopted.
 *
 * @module harnesses/codex-session-discovery
 */

import { existsSync, readdirSync, statSync, createReadStream, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Shell-safe shape of a codex session id.
 *
 * The discovered id is interpolated into `codex resume <id>` at spawn time, so it is
 * validated here at the point of discovery as well as in the codex harness — a rollout
 * file is attacker-writable in principle, and an id that cannot be used safely is worth
 * nothing to us anyway.
 */
const CODEX_SESSION_ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

/**
 * Default lifetime of a discovery watch, in ms.
 *
 * Codex 0.144.x does NOT create the rollout file at spawn — it creates it when the
 * FIRST USER TURN is submitted (measured 91 s after spawn in one smoke run, and still
 * absent after 20 s of an idle TUI). Any short fixed window from spawn therefore
 * misses it entirely, so the watch has to outlive the user's thinking time. It is
 * still bounded: a codex session with no first turn within an hour is not going to
 * produce a rollout we could match, and the session's own teardown aborts the watch
 * long before this in the normal case.
 */
export const CODEX_DISCOVERY_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

/** First poll gap. Kept short so a fast first turn is picked up promptly. */
const DEFAULT_INITIAL_INTERVAL_MS = 1_000;
/** Ceiling for the backoff. fs.watch normally wakes us long before this fires. */
const DEFAULT_MAX_INTERVAL_MS = 30_000;
/** Minimum gap between rescans triggered by filesystem events. */
const WAKE_DEBOUNCE_MS = 100;

interface DiscoveryOptions {
  codexHome?: string;
  /** Overall bound on the watch. Default {@link CODEX_DISCOVERY_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** First backoff gap; doubles up to `maxIntervalMs`. */
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Aborts the watch (session stop / teardown). Resolves null, never throws. */
  signal?: AbortSignal;
}

/** Read only the first line of a file — rollouts can be large. */
async function readFirstLine(file: string): Promise<string | null> {
  const stream = createReadStream(file, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) return line;
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** Recursively collect .jsonl files under dir. The tree is date-sharded and shallow. */
function collectRollouts(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) collectRollouts(full, out);
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * One pass over the rollout tree. Returns the newest matching session id, or null.
 */
async function scanForSessionId(sessionsDir: string, workingDir: string, startedAtMs: number): Promise<string | null> {
  if (!existsSync(sessionsDir)) return null;
  const candidates: { id: string; mtimeMs: number }[] = [];

  for (const file of collectRollouts(sessionsDir)) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    // Allow 1s of slack: the file's mtime can land marginally before the
    // timestamp we recorded for the spawn.
    if (mtimeMs < startedAtMs - 1_000) continue;

    try {
      const first = await readFirstLine(file);
      if (!first) continue;
      const rec = JSON.parse(first) as {
        type?: string;
        payload?: { session_id?: string; cwd?: string };
      };
      if (rec.type !== 'session_meta') continue;
      if (rec.payload?.cwd !== workingDir) continue;
      const id = rec.payload?.session_id;
      if (!id || !CODEX_SESSION_ID_PATTERN.test(id)) continue;
      candidates.push({ id, mtimeMs });
    } catch {
      // Partially written or malformed file — skip it and retry next pass.
      continue;
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]!.id;
}

/**
 * Watch for the rollout file codex writes for a session started in `workingDir`.
 *
 * Trigger design (see CODEX_DISCOVERY_DEFAULT_TIMEOUT_MS): codex creates the rollout
 * only on the first submitted turn, so this cannot be a short window from spawn. It is
 * instead an `fs.watch` on $CODEX_HOME/sessions backed by a backing-off poll:
 *
 *  - a filesystem event on the sessions tree wakes the loop immediately (so detection is
 *    effectively instant once codex writes the file);
 *  - the poll is the fallback for platforms/filesystems where recursive watch is
 *    unavailable or the sessions dir does not exist yet, and it backs off 1s -> 30s so
 *    a long-idle session costs a couple of directory reads per minute, not a spin;
 *  - it stops on the first match, on `signal` abort (session stop / teardown), and at
 *    `timeoutMs`. Every timer, watcher and abort listener is released on all three paths.
 *
 * @param workingDir  - the session's cwd, matched against session_meta.payload.cwd
 * @param startedAtMs - epoch ms the session was started; older rollouts are ignored
 * @param opts        - codexHome / timeouts / intervals / abort signal (injectable for tests)
 * @returns the codex session id, or null if none appeared before the watch ended
 */
export async function discoverCodexSessionId(
  workingDir: string,
  startedAtMs: number,
  opts: DiscoveryOptions = {}
): Promise<string | null> {
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const timeoutMs = opts.timeoutMs ?? CODEX_DISCOVERY_DEFAULT_TIMEOUT_MS;
  const initialIntervalMs = opts.intervalMs ?? DEFAULT_INITIAL_INTERVAL_MS;
  const maxIntervalMs = Math.max(opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS, initialIntervalMs);
  const signal = opts.signal;
  const sessionsDir = join(codexHome, 'sessions');
  const deadline = Date.now() + timeoutMs;

  // Held in a box: TypeScript cannot follow assignments made inside the callbacks below.
  const watcher: { current: FSWatcher | null } = { current: null };
  /** Resolver for the current sleep, so a watch event or an abort can cut it short. */
  let wake: (() => void) | null = null;
  /** Set when an event lands while no sleep is in progress, so it is not lost. */
  let pendingWake = false;
  const ring = (): void => {
    const w = wake;
    wake = null;
    if (w) w();
    else pendingWake = true;
  };

  const onAbort = (): void => ring();
  signal?.addEventListener('abort', onAbort, { once: true });

  /** (Re)establish the recursive watcher once the sessions dir exists. */
  const ensureWatcher = (): void => {
    if (watcher.current || !existsSync(sessionsDir)) return;
    try {
      const w = watch(sessionsDir, { recursive: true, persistent: false }, () => ring());
      // A watcher error must degrade to polling, not reject the discovery promise.
      w.on('error', () => {
        w.close();
        if (watcher.current === w) watcher.current = null;
      });
      watcher.current = w;
    } catch {
      watcher.current = null;
    }
  };

  try {
    let intervalMs = initialIntervalMs;
    for (;;) {
      if (signal?.aborted) return null;
      ensureWatcher();

      const id = await scanForSessionId(sessionsDir, workingDir, startedAtMs);
      if (id) return id;

      if (signal?.aborted) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;

      // An event that landed *during* the scan would otherwise be lost: rescan after a
      // short debounce instead of after the full backoff. The debounce is what stops an
      // event storm on the sessions tree from turning this into a rescan spin.
      const gap = pendingWake ? Math.min(WAKE_DEBOUNCE_MS, remaining) : Math.min(intervalMs, remaining);
      pendingWake = false;

      let wokenEarly = false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, gap);
        wake = () => {
          clearTimeout(timer);
          wokenEarly = true;
          resolve();
        };
      });
      // A filesystem event means something is happening: go back to the short interval.
      intervalMs = wokenEarly || pendingWake ? initialIntervalMs : Math.min(intervalMs * 2, maxIntervalMs);
    }
  } finally {
    wake = null;
    signal?.removeEventListener('abort', onAbort);
    watcher.current?.close();
    watcher.current = null;
  }
}

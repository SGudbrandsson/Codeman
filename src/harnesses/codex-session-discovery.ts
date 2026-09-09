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

import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
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

interface DiscoveryOptions {
  codexHome?: string;
  timeoutMs?: number;
  intervalMs?: number;
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
 * Poll for the rollout file codex wrote for a session started in `workingDir`.
 *
 * @param workingDir  - the session's cwd, matched against session_meta.payload.cwd
 * @param startedAtMs - epoch ms the session was started; older rollouts are ignored
 * @param opts        - codexHome / timeoutMs / intervalMs overrides (injectable for tests)
 * @returns the codex session id, or null if none appeared before the timeout
 */
export async function discoverCodexSessionId(
  workingDir: string,
  startedAtMs: number,
  opts: DiscoveryOptions = {}
): Promise<string | null> {
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const sessionsDir = join(codexHome, 'sessions');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(sessionsDir)) {
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
          // Partially written or malformed file — skip it and retry next poll.
          continue;
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return candidates[0]!.id;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return null;
}

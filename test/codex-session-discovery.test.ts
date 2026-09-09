/**
 * @fileoverview Tests for reading a codex session id back out of its rollout file.
 *
 * Codex writes $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl whose first
 * line is a session_meta record carrying both session_id and cwd.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverCodexSessionId,
  CODEX_DISCOVERY_DEFAULT_TIMEOUT_MS,
} from '../src/harnesses/codex-session-discovery.js';

let home: string;

/** Write a rollout file with the given session id, cwd, and mtime. */
function writeRollout(sessionId: string, cwd: string, mtimeMs: number): string {
  const dir = join(home, 'sessions', '2026', '09', '09');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-09-09T11-24-00-${sessionId}.jsonl`);
  const meta = {
    timestamp: '2026-09-09T11:24:00.577Z',
    type: 'session_meta',
    payload: { session_id: sessionId, cwd, cli_version: '0.144.5' },
  };
  writeFileSync(file, JSON.stringify(meta) + '\n');
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('discoverCodexSessionId', () => {
  const opts = () => ({ codexHome: home, timeoutMs: 1500, intervalMs: 100 });

  it('finds the session id for a matching cwd', async () => {
    const started = Date.now();
    writeRollout('01a085e9-15f5-7b80-8af1-411de2591ffe', '/work/proj', started + 100);
    await expect(discoverCodexSessionId('/work/proj', started, opts())).resolves.toBe(
      '01a085e9-15f5-7b80-8af1-411de2591ffe'
    );
  });

  it('ignores a rollout from a different cwd', async () => {
    const started = Date.now();
    writeRollout('other-uuid', '/somewhere/else', started + 100);
    await expect(discoverCodexSessionId('/work/proj', started, opts())).resolves.toBeNull();
  });

  it('ignores a rollout written before the session started', async () => {
    // A pre-existing codex session in the same directory must not be adopted.
    const started = Date.now();
    writeRollout('stale-uuid', '/work/proj', started - 60_000);
    await expect(discoverCodexSessionId('/work/proj', started, opts())).resolves.toBeNull();
  });

  it('picks the newest when several match', async () => {
    const started = Date.now();
    writeRollout('older', '/work/proj', started + 100);
    writeRollout('newer', '/work/proj', started + 900);
    await expect(discoverCodexSessionId('/work/proj', started, opts())).resolves.toBe('newer');
  });

  it('resolves null on timeout rather than throwing', async () => {
    await expect(discoverCodexSessionId('/work/proj', Date.now(), opts())).resolves.toBeNull();
  });

  it('resolves null when the sessions directory does not exist', async () => {
    await expect(
      discoverCodexSessionId('/work/proj', Date.now(), {
        codexHome: join(home, 'nope'),
        timeoutMs: 300,
        intervalMs: 100,
      })
    ).resolves.toBeNull();
  });

  it('ignores a session id that is not shell-safe', async () => {
    const started = Date.now();
    const dir = join(home, 'sessions', '2026', '09', '09');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-unsafe.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: 'bad; rm -rf /', cwd: '/work/proj' },
      }) + '\n'
    );
    utimesSync(file, (started + 100) / 1000, (started + 100) / 1000);
    await expect(discoverCodexSessionId('/work/proj', started, opts())).resolves.toBeNull();
  });

  // --- Timing / trigger contract (smoke test Defect 1) -------------------------
  //
  // Codex creates the rollout file only when the first user turn is submitted, which
  // can be minutes after spawn. The watch must therefore outlive any short window,
  // and must end on abort rather than run to its deadline.

  it('defaults to a watch far longer than a first-turn delay', () => {
    // Measured worst case in the smoke test was 91 s after spawn, with an idle TUI
    // producing nothing at all. Anything under a few minutes is a broken trigger.
    expect(CODEX_DISCOVERY_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it('finds a rollout that only appears long after the first poll', async () => {
    const started = Date.now();
    const promise = discoverCodexSessionId('/work/proj', started, {
      codexHome: home,
      timeoutMs: 10_000,
      intervalMs: 20,
      maxIntervalMs: 60,
    });
    // Well past the old 15 s-equivalent window at this scale: several poll gaps elapse
    // with no file present at all before codex "submits its first turn".
    await new Promise((r) => setTimeout(r, 600));
    writeRollout('late-uuid', '/work/proj', Date.now());
    await expect(promise).resolves.toBe('late-uuid');
  });

  it('creates the sessions directory watch lazily when codex has never run', async () => {
    // $CODEX_HOME/sessions does not exist at spawn time here.
    const fresh = join(home, 'later');
    const started = Date.now();
    const promise = discoverCodexSessionId('/work/proj', started, {
      codexHome: fresh,
      timeoutMs: 10_000,
      intervalMs: 20,
      maxIntervalMs: 60,
    });
    await new Promise((r) => setTimeout(r, 200));
    const dir = join(fresh, 'sessions', '2026', '09', '09');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-late.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: 'appeared-later', cwd: '/work/proj' },
      }) + '\n'
    );
    await expect(promise).resolves.toBe('appeared-later');
  });

  it('stops promptly when aborted, resolving null', async () => {
    const controller = new AbortController();
    const startedWall = Date.now();
    const promise = discoverCodexSessionId('/work/proj', Date.now(), {
      codexHome: home,
      // Deliberately huge: only the abort can end this watch.
      timeoutMs: 10 * 60 * 1000,
      intervalMs: 50,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(promise).resolves.toBeNull();
    expect(Date.now() - startedWall).toBeLessThan(5_000);
  });

  it('resolves null immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverCodexSessionId('/work/proj', Date.now(), {
        codexHome: home,
        timeoutMs: 10 * 60 * 1000,
        signal: controller.signal,
      })
    ).resolves.toBeNull();
  });

  it('leaves no pending timer or watcher behind after it resolves', async () => {
    // A leaked timer/watcher would keep the process alive; vitest surfaces that as a
    // hanging worker. Assert on the handle count instead, which is deterministic.
    const before = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
    const started = Date.now();
    writeRollout('clean-uuid', '/work/proj', started + 10);
    await discoverCodexSessionId('/work/proj', started, {
      codexHome: home,
      timeoutMs: 5_000,
      intervalMs: 20,
    });
    const after = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
    expect(after).toBeLessThanOrEqual(before);
  });

  it('ignores a malformed first line and a non session_meta record', async () => {
    const started = Date.now();
    const dir = join(home, 'sessions', '2026', '09', '09');
    mkdirSync(dir, { recursive: true });
    const broken = join(dir, 'rollout-broken.jsonl');
    writeFileSync(broken, '{not json\n');
    utimesSync(broken, (started + 100) / 1000, (started + 100) / 1000);
    const other = join(dir, 'rollout-other.jsonl');
    writeFileSync(
      other,
      JSON.stringify({ type: 'turn_context', payload: { session_id: 'x', cwd: '/work/proj' } }) + '\n'
    );
    utimesSync(other, (started + 100) / 1000, (started + 100) / 1000);
    await expect(discoverCodexSessionId('/work/proj', started, opts())).resolves.toBeNull();
  });
});

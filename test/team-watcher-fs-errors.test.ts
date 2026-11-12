/**
 * TeamWatcher must not flood the log when its chokidar watchers fail.
 *
 * On 2026-11-11 the per-user inotify instance limit was exhausted; chokidar kept emitting
 * EMFILE (plus a TypeError from its persistent:false path) and TeamWatcher logged every one
 * with a full stack — ~15 GB of syslog in five hours. Now the first error is logged once,
 * the watchers are closed, polling takes over, and the watchers are retried later.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class FakeWatcher extends EventEmitter {
  closed = false;
  close = vi.fn(async () => {
    this.closed = true;
  });
}

const created: FakeWatcher[] = [];
vi.mock('chokidar', () => ({
  watch: vi.fn(() => {
    const w = new FakeWatcher();
    created.push(w);
    return w;
  }),
}));

const { TeamWatcher } = await import('../src/team-watcher.js');

function emfile(): NodeJS.ErrnoException {
  const e = new Error("EMFILE: too many open files, watch '/'") as NodeJS.ErrnoException;
  e.code = 'EMFILE';
  return e;
}

describe('TeamWatcher fs watcher errors', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let tw: InstanceType<typeof TeamWatcher>;

  beforeEach(() => {
    vi.useFakeTimers();
    created.length = 0;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    tw = new TeamWatcher('/nonexistent/teams', '/nonexistent/tasks');
    tw.start();
  });

  afterEach(() => {
    tw.stop();
    warn.mockRestore();
    log.mockRestore();
    vi.useRealTimers();
  });

  const watcherWarnings = () =>
    warn.mock.calls.filter(
      (c: unknown[]) => String(c[0]).startsWith('[TeamWatcher]') && /fs watcher/.test(String(c[0]))
    );

  it('logs one line for a burst of errors and closes both watchers', () => {
    const [teams, tasks] = created;
    for (let i = 0; i < 1000; i++) {
      teams.emit('error', emfile());
      tasks.emit('error', new TypeError("Cannot read properties of undefined (reading 'close')"));
    }
    expect(watcherWarnings()).toHaveLength(1);
    const msg = String(watcherWarnings()[0][0]);
    expect(msg).toContain('EMFILE');
    expect(msg).toContain('falling back to polling');
    expect(watcherWarnings()[0]).toHaveLength(1); // no Error object → no stack trace in syslog
    expect(teams.closed && tasks.closed).toBe(true);
  });

  it('retries after 5 minutes, stays quiet if the retry fails, and logs once when restored', () => {
    created[0].emit('error', emfile());
    expect(created).toHaveLength(2);

    vi.advanceTimersByTime(5 * 60_000);
    expect(created).toHaveLength(4); // retried
    created[2].emit('error', emfile());
    expect(watcherWarnings()).toHaveLength(1); // still just the first line
    expect(created[2].closed && created[3].closed).toBe(true);

    vi.advanceTimersByTime(5 * 60_000);
    expect(created).toHaveLength(6);
    created[4].emit('ready');
    expect(log.mock.calls.filter((c: unknown[]) => c[0] === '[TeamWatcher] fs watchers restored')).toHaveLength(1);
  });

  it('ignores errors from an already-closed watcher so it cannot tear down its replacement', () => {
    created[0].emit('error', emfile());
    vi.advanceTimersByTime(5 * 60_000);
    created[0].emit('error', emfile()); // stale watcher still emitting
    expect(created[4]).toBeUndefined(); // no extra retry scheduled
    expect(created[2].closed || created[3].closed).toBe(false);
  });

  it('does not retry after stop()', () => {
    created[0].emit('error', emfile());
    tw.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(created).toHaveLength(2);
  });
});

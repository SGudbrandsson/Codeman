/**
 * @fileoverview Unit tests for post-compaction /context refresh.
 *
 * After a compaction the real context shrinks, but the "Context ~N% full" banner
 * keeps showing the last-parsed /context value until it is re-read. Session flags a
 * pending refresh when a /compact command is written and re-reads /context on the
 * next idle transition. These tests cover that flag + idle-consume behaviour without
 * spawning a real PTY/mux.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Session } from '../src/session.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internals = any;

function makeSession(): Session {
  return new Session({ workingDir: '/tmp' });
}

describe('post-compaction /context refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('flags a pending refresh when /compact is written', async () => {
    const session = makeSession();
    await session.writeViaMux('/compact\r');
    expect((session as Internals)._pendingCompactRefresh).toBe(true);
  });

  it('does not flag on ordinary input or on /context itself', async () => {
    const session = makeSession();
    await session.writeViaMux('hello world\r');
    expect((session as Internals)._pendingCompactRefresh).toBe(false);
    await session.writeViaMux('/context\r');
    expect((session as Internals)._pendingCompactRefresh).toBe(false);
  });

  it('re-reads /context on idle after a /compact, once settled', async () => {
    const session = makeSession();
    const refreshSpy = vi.spyOn(session as Internals, '_refreshContext').mockImplementation(() => {});

    await session.writeViaMux('/compact\r');
    // Idle transition consumes the flag and schedules a delayed refresh.
    (session as Internals)._maybeRefreshContextAfterCompact();
    expect((session as Internals)._pendingCompactRefresh).toBe(false);
    expect(refreshSpy).not.toHaveBeenCalled(); // still settling

    vi.advanceTimersByTime(2500);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on idle when no /compact was issued', async () => {
    const session = makeSession();
    const refreshSpy = vi.spyOn(session as Internals, '_refreshContext').mockImplementation(() => {});

    (session as Internals)._maybeRefreshContextAfterCompact();
    vi.advanceTimersByTime(5000);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('skips the refresh if the session became busy again (e.g. auto-continue)', async () => {
    const session = makeSession();
    const refreshSpy = vi.spyOn(session as Internals, '_refreshContext').mockImplementation(() => {});

    await session.writeViaMux('/compact\r');
    (session as Internals)._maybeRefreshContextAfterCompact();
    // Session starts a new turn before the delayed refresh fires.
    (session as Internals)._status = 'busy';

    vi.advanceTimersByTime(2500);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

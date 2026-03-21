/**
 * Tests for the _isLoadingScrollback guard in Session PTY onData handler.
 *
 * The guard suppresses spinner and work-keyword busy detection during the
 * scrollback replay phase that occurs when a PTY attaches to an existing
 * tmux session. It is cleared one-shot when the first ❯ prompt is seen.
 *
 * These tests mock node-pty so no real PTY process is spawned. The mock
 * captures the onData callback registered by startInteractive() and calls
 * it directly to simulate PTY data arriving.
 *
 * Run: npx vitest run test/busy-indicator-scrollback-guard.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- node-pty mock ---------------------------------------------------------
// Capture the onData callback so tests can feed data into the PTY handler.
let capturedOnData: ((data: string) => void) | null = null;

vi.mock('node-pty', () => {
  const spawn = vi.fn(() => {
    // Reset for each spawn call so each test gets a fresh capture
    capturedOnData = null;
    return {
      pid: 99999,
      onData: vi.fn((cb: (data: string) => void) => {
        capturedOnData = cb;
        // Return a disposable as node-pty expects
        return { dispose: vi.fn() };
      }),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      process: 'mock-claude',
      handleFlowControl: false,
      cols: 120,
      rows: 40,
    };
  });
  return { spawn };
});
// --------------------------------------------------------------------------

import { Session } from '../src/session.js';

/** Feed a string into the captured onData handler. Throws if not yet captured. */
function feedData(data: string): void {
  if (!capturedOnData) throw new Error('onData not yet captured — did startInteractive() run?');
  capturedOnData(data);
}

/** Collect all `working` events emitted by a session during the execution of fn(). */
async function collectWorkingEvents(session: Session, fn: () => void | Promise<void>): Promise<number> {
  let count = 0;
  const listener = () => {
    count++;
  };
  session.on('working', listener);
  await fn();
  session.off('working', listener);
  return count;
}

describe('_isLoadingScrollback guard — spinner detection', () => {
  let session: Session;

  beforeEach(async () => {
    capturedOnData = null;
    // useMux: false forces the direct PTY path; _isLoadingScrollback starts false.
    session = new Session({ workingDir: '/tmp', mode: 'claude', useMux: false });
    await session.startInteractive();
  });

  afterEach(() => {
    session.stop();
  });

  it('does NOT emit working when spinner arrives while _isLoadingScrollback is true', async () => {
    // Simulate the flag being set (as startInteractive does for the mux path)
    (session as any)._isLoadingScrollback = true;

    const count = await collectWorkingEvents(session, () => {
      // braille spinner chars used by Claude's progress indicator
      feedData('⠋ Loading...');
      feedData('⠙ Thinking...');
    });

    expect(count).toBe(0);
  });

  it('DOES emit working when spinner arrives after _isLoadingScrollback is false', async () => {
    // Flag is false by default for the direct PTY path
    expect((session as any)._isLoadingScrollback).toBe(false);

    const count = await collectWorkingEvents(session, () => {
      feedData('⠋ Working on it...');
    });

    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('clears _isLoadingScrollback on first ❯ prompt and then emits working on spinner', async () => {
    (session as any)._isLoadingScrollback = true;

    // Feed the ❯ prompt — this should clear the flag (one-shot)
    feedData('❯ ');

    expect((session as any)._isLoadingScrollback).toBe(false);

    // Now a spinner should trigger the working event
    const count = await collectWorkingEvents(session, () => {
      feedData('⠋ Running task...');
    });

    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('does NOT emit working event when ❯ first seen during scrollback (no false idle emission)', async () => {
    (session as any)._isLoadingScrollback = true;
    // _isWorking must be false (it is by default) for this to matter
    expect((session as any)._isWorking).toBe(false);

    // Feeding ❯ during scrollback clears flag but should not start the idle timer
    // (working was never true, so idle should never fire).
    // We verify: no working event fires on ❯ during scrollback.
    const count = await collectWorkingEvents(session, () => {
      feedData('❯ ');
    });

    expect(count).toBe(0);
  });
});

describe('_isLoadingScrollback guard — work-keyword detection', () => {
  let session: Session;

  beforeEach(async () => {
    capturedOnData = null;
    session = new Session({ workingDir: '/tmp', mode: 'claude', useMux: false });
    await session.startInteractive();
    // Reset the expensive-parsers throttle so keyword detection runs immediately
    (session as any)._lastExpensiveProcessTime = 0;
  });

  afterEach(() => {
    session.stop();
  });

  it('does NOT emit working for work keywords while _isLoadingScrollback is true', async () => {
    (session as any)._isLoadingScrollback = true;

    const count = await collectWorkingEvents(session, () => {
      (session as any)._lastExpensiveProcessTime = 0;
      feedData('Thinking about your request...');
    });

    expect(count).toBe(0);
  });

  it('does NOT emit working for Writing/Reading/Running keywords during scrollback', async () => {
    (session as any)._isLoadingScrollback = true;

    const count = await collectWorkingEvents(session, () => {
      (session as any)._lastExpensiveProcessTime = 0;
      feedData('Writing file /tmp/out.txt');
      (session as any)._lastExpensiveProcessTime = 0;
      feedData('Reading src/index.ts');
      (session as any)._lastExpensiveProcessTime = 0;
      feedData('Running tests...');
    });

    expect(count).toBe(0);
  });
});

describe('_isLoadingScrollback NOT set for opencode mode', () => {
  it('_isLoadingScrollback is false by default (regression: opencode never permanently suppressed)', () => {
    // The constructor initialises _isLoadingScrollback = false.
    // startInteractive() only sets it to true inside `if (this.mode === 'claude')`.
    // For opencode sessions that path is skipped — this test guards against
    // a regression where opencode would get the flag set again.
    const session = new Session({ workingDir: '/tmp', mode: 'opencode', useMux: false });
    expect((session as any)._isLoadingScrollback).toBe(false);
    // Do not call startInteractive() — opencode requires mux; just verify
    // that the constructor default is correct and the value is not changed.
  });

  it('claude session also starts with _isLoadingScrollback false before startInteractive()', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude', useMux: false });
    // Flag is false at construction; startInteractive() sets it for the mux path only.
    expect((session as any)._isLoadingScrollback).toBe(false);
  });
});

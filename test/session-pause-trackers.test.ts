/**
 * @fileoverview Regression tests for tracker event forwarding across a pause → resume cycle.
 *
 * `Session.stop()` normally tears down (and destroys) the TaskTracker / RalphTracker /
 * BashToolParser, which are wired to forward their events onto the Session. Pause is the
 * first code path that stops a session and then reuses the *same* Session object via
 * `startInteractive()`, so without care a resumed session silently stops emitting
 * `ralphCompletionDetected`, `taskCreated`, `bashToolStart`, … for the rest of its life.
 *
 * These tests exercise the Session in isolation — no PTY, no mux.
 */

import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session.js';

function makeSession(): Session {
  return new Session({ workingDir: '/tmp' });
}

describe('tracker event forwarding survives pause → resume', () => {
  it('re-emits ralph events after a pause/resume cycle', async () => {
    const session = makeSession();

    await session.pause();
    session.clearPaused();

    const onCompletion = vi.fn();
    const onLoopUpdate = vi.fn();
    session.on('ralphCompletionDetected', onCompletion);
    session.on('ralphLoopUpdate', onLoopUpdate);

    session.ralphTracker.emit('completionDetected', 'ALL DONE');
    session.ralphTracker.emit('loopUpdate', { iteration: 1 });

    expect(onCompletion).toHaveBeenCalledTimes(1);
    expect(onCompletion).toHaveBeenCalledWith('ALL DONE');
    expect(onLoopUpdate).toHaveBeenCalledTimes(1);
  });

  it('re-emits task and bash-tool events after a pause/resume cycle', async () => {
    const session = makeSession();

    await session.pause();
    session.clearPaused();

    const onTaskCreated = vi.fn();
    const onBashToolStart = vi.fn();
    session.on('taskCreated', onTaskCreated);
    session.on('bashToolStart', onBashToolStart);

    session.taskTracker.emit('taskCreated', { id: 't1' });
    session.bashToolParser.emit('toolStart', { id: 'b1' });

    expect(onTaskCreated).toHaveBeenCalledTimes(1);
    expect(onBashToolStart).toHaveBeenCalledTimes(1);
  });

  it('does not double-register listeners when resume runs more than once', async () => {
    const session = makeSession();

    await session.pause();
    session.clearPaused();
    // The `/interactive` un-park and `/resume` can both land on the same session.
    session.clearPaused();
    session.clearPaused();

    const onCompletion = vi.fn();
    session.on('ralphCompletionDetected', onCompletion);
    session.ralphTracker.emit('completionDetected', 'ALL DONE');

    expect(onCompletion).toHaveBeenCalledTimes(1);
  });

  it('keeps the trackers usable — pause must not destroy them', async () => {
    const session = makeSession();

    await session.pause();
    session.clearPaused();

    // BashToolParser latches a `_destroyed` flag in destroy() that no amount of
    // listener re-registration can undo, so assert it was never destroyed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session.bashToolParser as any)._destroyed).toBe(false);
  });

  it('still tears the trackers down on a plain stop()', async () => {
    const session = makeSession();

    await session.stop(true);

    const onCompletion = vi.fn();
    session.on('ralphCompletionDetected', onCompletion);
    session.ralphTracker.emit('completionDetected', 'ALL DONE');

    expect(onCompletion).not.toHaveBeenCalled();
  });
});

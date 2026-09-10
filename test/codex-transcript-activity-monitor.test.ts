/**
 * CodexTranscriptActivityMonitor: codex busy/idle from rollout turn records (spec §6).
 *
 * Real files in a temp directory; fake timers drive the 2 s poll and the staleness timer. The
 * fs.watch seam is injected so tests can fire change/rename events, throw, or write "between
 * scan and watch". Fixtures are synthetic; only their record shapes follow codex rollouts.
 *
 * Run: npx vitest run test/codex-transcript-activity-monitor.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexTranscriptAdapter } from '../src/harnesses/transcripts/codex.js';
import type { TranscriptLocateCtx } from '../src/harnesses/transcripts/types.js';
import { CodexTranscriptActivityMonitor, type CodexActivityOptions } from '../src/codex-transcript-activity-monitor.js';

const FIXTURES = join(__dirname, 'fixtures');
const COMPLETED_ROLLOUT = readFileSync(join(FIXTURES, 'transcripts', 'codex.jsonl'), 'utf-8');
const MID_TURN_ROLLOUT = readFileSync(join(FIXTURES, 'codex-activity', 'mid-turn.jsonl'), 'utf-8');
const ABORTED_ROLLOUT = readFileSync(join(FIXTURES, 'codex-activity', 'aborted.jsonl'), 'utf-8');

const rec = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type, payload }) + '\n';
const STARTED = rec('event_msg', { type: 'task_started', turn_id: 'turn-1', model_context_window: 1000 });
const COMPLETE = rec('event_msg', { type: 'task_complete', turn_id: 'turn-1', duration_ms: 10 });
const ABORTED = rec('event_msg', { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' });
const TOKENS = rec('event_msg', { type: 'token_count', info: null });

/** An assistant message record of exactly `bytes` bytes (including the newline). */
function bigMessage(bytes: number): string {
  const make = (text: string) =>
    rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  return make('x'.repeat(Math.max(0, bytes - make('').length)));
}

let dir = '';
let file = '';
const monitors: CodexTranscriptActivityMonitor[] = [];

interface Made {
  monitor: CodexTranscriptActivityMonitor;
  events: Array<{ type: string; info?: unknown }>;
  watchListeners: Array<(event: string) => void>;
}

function makeMonitor(
  opts: Partial<CodexActivityOptions> = {},
  locate: (ctx: TranscriptLocateCtx) => string | null = () => file,
  harnessSessionId?: string
): Made {
  const events: Made['events'] = [];
  const watchListeners: Made['watchListeners'] = [];
  const monitor = new CodexTranscriptActivityMonitor(
    { locate, classifyActivity: codexTranscriptAdapter.classifyActivity },
    { workingDir: dir, sessionId: 'sess-1', harnessSessionId },
    {
      pollMs: 100,
      staleMs: 600_000,
      watchFn: (_path, onEvent) => {
        watchListeners.push(onEvent);
        return { close() {} };
      },
      ...opts,
    }
  );
  monitor.on('working', () => events.push({ type: 'working' }));
  monitor.on('idle', (info?: unknown) => events.push({ type: 'idle', info }));
  monitors.push(monitor);
  return { monitor, events, watchListeners };
}

const tick = (ms = 100) => vi.advanceTimersByTime(ms);
const WORKING = { type: 'working' };
const COMPLETED = { type: 'idle', info: { reason: 'completed' } };
const STALE = { type: 'idle', info: { reason: 'stale' } };

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'codex-activity-'));
  file = join(dir, 'rollout-2026-01-01T00-00-00-00000000-0000-4000-8000-000000000001.jsonl');
});

afterEach(() => {
  for (const m of monitors.splice(0)) m.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('codexTranscriptAdapter.classifyActivity', () => {
  it.each([
    ['task_started', 'working'],
    ['task_complete', 'idle'],
    ['turn_aborted', 'idle'],
    ['token_count', null],
    ['user_message', null],
    ['agent_message', null],
  ])('event_msg/%s → %s', (type, expected) => {
    expect(codexTranscriptAdapter.classifyActivity!({ type: 'event_msg', payload: { type } })).toBe(expected);
  });

  it('non-event_msg records are null, even with a boundary payload type', () => {
    expect(codexTranscriptAdapter.classifyActivity!({ type: 'response_item', payload: { type: 'task_started' } })).toBe(
      null
    );
    expect(codexTranscriptAdapter.classifyActivity!(JSON.parse(bigMessage(200)))).toBe(null);
  });

  it.each([[null], ['task_started'], [42], [[]], [{ type: 'event_msg' }], [{ type: 'event_msg', payload: 'x' }]])(
    'malformed record %j → null',
    (record) => {
      expect(codexTranscriptAdapter.classifyActivity!(record)).toBe(null);
    }
  );

  it('never throws', () => {
    const hostile = {
      type: 'event_msg',
      get payload(): unknown {
        throw new Error('boom');
      },
    };
    expect(codexTranscriptAdapter.classifyActivity!(hostile)).toBe(null);
  });
});

describe('initial backward scan', () => {
  it('a rollout ending in task_complete is idle and emits nothing', async () => {
    writeFileSync(file, COMPLETED_ROLLOUT);
    const { monitor, events } = makeMonitor();
    await monitor.start();
    expect(monitor.state).toBe('idle');
    expect(events).toEqual([]);
  });

  it('a rollout cut mid-turn is working and emits exactly one working', async () => {
    writeFileSync(file, MID_TURN_ROLLOUT);
    const { monitor, events } = makeMonitor();
    await monitor.start();
    expect(monitor.state).toBe('working');
    expect(events).toEqual([WORKING]);
  });

  it('a rollout ending in turn_aborted is idle', async () => {
    writeFileSync(file, ABORTED_ROLLOUT);
    const { monitor, events } = makeMonitor();
    await monitor.start();
    expect(monitor.state).toBe('idle');
    expect(events).toEqual([]);
  });

  it('a rollout with no boundary record is unknown and emits nothing', async () => {
    writeFileSync(file, TOKENS + bigMessage(120));
    const { monitor, events } = makeMonitor();
    await monitor.start();
    expect(monitor.state).toBe('unknown');
    expect(events).toEqual([]);
  });

  it('reconstructs a record larger than a chunk that spans chunk boundaries', async () => {
    writeFileSync(file, COMPLETE + STARTED + bigMessage(300));
    const { monitor, events } = makeMonitor({ chunkBytes: 64 });
    await monitor.start();
    expect(monitor.state).toBe('working');
    expect(events).toEqual([WORKING]);
  });

  it('treats the fragment at byte 0 as a complete line', async () => {
    writeFileSync(file, STARTED);
    const { monitor } = makeMonitor({ chunkBytes: 16 });
    await monitor.start();
    expect(monitor.state).toBe('working');
  });

  it('a budget cut through an unclassified record is unknown, never an older boundary', async () => {
    writeFileSync(file, STARTED + bigMessage(300));
    const { monitor, events } = makeMonitor({ chunkBytes: 64, scanBudgetBytes: 128 });
    await monitor.start();
    expect(monitor.state).toBe('unknown');
    expect(events).toEqual([]);
  });

  it('a trailing unterminated fragment is not scanned; it seeds the pending buffer', async () => {
    writeFileSync(file, COMPLETE + STARTED.slice(0, -1));
    const { monitor, events } = makeMonitor({ chunkBytes: 32 });
    await monitor.start();
    expect(monitor.state).toBe('idle');
    expect(events).toEqual([]);

    appendFileSync(file, '\n');
    tick();

    expect(monitor.state).toBe('working');
    expect(events).toEqual([WORKING]);
  });

  it('rescans when the file is replaced between scan and publish', async () => {
    writeFileSync(file, STARTED);
    let calls = 0;
    const statFn = (p: string) => {
      calls++;
      if (calls === 2) {
        // Replace the file (new inode) just before the post-scan stat.
        const tmp = join(dir, 'replacement.jsonl');
        writeFileSync(tmp, COMPLETE);
        renameSync(tmp, file);
      }
      return statSync(p);
    };
    const { monitor, events } = makeMonitor({ statFn });
    await monitor.start();

    expect(calls).toBeGreaterThanOrEqual(4);
    expect(monitor.state).toBe('idle');
    expect(events).toEqual([]);
  });

  it('writes between scan and watch are not skipped', async () => {
    writeFileSync(file, COMPLETE);
    const { monitor, events } = makeMonitor({
      watchFn: () => {
        appendFileSync(file, STARTED);
        return { close() {} };
      },
    });
    await monitor.start();
    expect(monitor.state).toBe('working');
    expect(events).toEqual([WORKING]);
  });

  it('a task_complete written between scan and watch, after a scanned task_started, publishes idle silently', async () => {
    writeFileSync(file, STARTED);
    const { monitor, events } = makeMonitor({
      watchFn: () => {
        appendFileSync(file, COMPLETE);
        return { close() {} };
      },
    });
    await monitor.start();
    expect(monitor.state).toBe('idle');
    expect(events).toEqual([]);
  });
});

describe('runtime', () => {
  it('appended turn records drive transitions', async () => {
    writeFileSync(file, COMPLETE);
    const { monitor, events } = makeMonitor();
    await monitor.start();

    appendFileSync(file, STARTED + TOKENS);
    tick();
    expect(events).toEqual([WORKING]);

    appendFileSync(file, bigMessage(80) + COMPLETE);
    tick();
    expect(events).toEqual([WORKING, COMPLETED]);

    appendFileSync(file, STARTED + ABORTED);
    tick();
    expect(events).toEqual([WORKING, COMPLETED, WORKING, COMPLETED]);
  });

  it('a watch change event reads without waiting for the poll', async () => {
    writeFileSync(file, COMPLETE);
    const { monitor, events, watchListeners } = makeMonitor({ pollMs: 3_600_000 });
    await monitor.start();

    appendFileSync(file, STARTED);
    watchListeners[0]!('change');

    expect(events).toEqual([WORKING]);
  });

  it('a watch that throws falls back to polling', async () => {
    writeFileSync(file, COMPLETE);
    const { monitor, events } = makeMonitor({
      watchFn: () => {
        throw new Error('EMFILE');
      },
    });
    await monitor.start();

    appendFileSync(file, STARTED);
    tick();

    expect(events).toEqual([WORKING]);
  });

  it('an oversized pending line is discarded to its newline, and the next record parses', async () => {
    writeFileSync(file, COMPLETE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { monitor, events } = makeMonitor({ pendingCapBytes: 128 });
    await monitor.start();

    // A garbage prefix over the cap, whose tail is a valid task_started line. If the remainder
    // were parsed after dropping the prefix, it would wrongly report working.
    appendFileSync(file, 'A'.repeat(200));
    tick();
    appendFileSync(file, STARTED);
    tick();
    expect(events).toEqual([]);

    appendFileSync(file, STARTED);
    tick();
    expect(events).toEqual([WORKING]);
    warn.mockRestore();
  });

  it('truncation resets and rescans', async () => {
    writeFileSync(file, STARTED + bigMessage(300));
    const { monitor, events } = makeMonitor();
    await monitor.start();
    expect(events).toEqual([WORKING]);

    writeFileSync(file, COMPLETE); // same inode, smaller than the consumed offset
    tick();

    expect(monitor.state).toBe('idle');
    expect(events).toEqual([WORKING, COMPLETED]);
  });

  it('equal-size replacement resets and rescans', async () => {
    const pad = (line: string, len: number) => line.replace('"turn_id":"t"', `"turn_id":"t${'x'.repeat(len)}"`);
    const a = rec('event_msg', { type: 'task_started', turn_id: 't' });
    const b = rec('event_msg', { type: 'task_complete', turn_id: 't' });
    const oldContent = pad(a, Math.max(0, b.length - a.length));
    const newContent = pad(b, Math.max(0, a.length - b.length));
    expect(oldContent.length).toBe(newContent.length);

    writeFileSync(file, oldContent);
    const { monitor, events } = makeMonitor();
    await monitor.start();
    expect(events).toEqual([WORKING]);

    const tmp = join(dir, 'replacement.jsonl');
    writeFileSync(tmp, newContent);
    renameSync(tmp, file);
    expect(statSync(file).size).toBe(oldContent.length);
    tick();

    expect(monitor.state).toBe('idle');
    expect(events).toEqual([WORKING, COMPLETED]);
  });

  it('silence while working goes stale; a later task_complete still completes exactly once', async () => {
    writeFileSync(file, STARTED);
    const { monitor, events } = makeMonitor({ staleMs: 1000 });
    await monitor.start();
    expect(events).toEqual([WORKING]);

    tick(1000);
    expect(monitor.state).toBe('idle');
    expect(events).toEqual([WORKING, STALE]);

    appendFileSync(file, COMPLETE);
    tick();
    expect(events).toEqual([WORKING, STALE, COMPLETED]);

    tick(10_000);
    expect(events).toEqual([WORKING, STALE, COMPLETED]);
  });

  it('writes while working reset the staleness timer', async () => {
    writeFileSync(file, STARTED);
    const { events, monitor } = makeMonitor({ staleMs: 1000 });
    await monitor.start();

    tick(600);
    appendFileSync(file, TOKENS);
    tick(100); // poll reads the write at t=700
    tick(800); // t=1500: 800 ms since the write
    expect(events).toEqual([WORKING]);

    tick(300); // t=1800: over 1000 ms since the write
    expect(events).toEqual([WORKING, STALE]);
  });

  it('retries locate while the rollout is unknown', async () => {
    let located: string | null = null;
    const { monitor, events } = makeMonitor({}, () => located);
    await monitor.start();
    expect(monitor.state).toBe('unknown');

    writeFileSync(file, STARTED);
    located = file;
    tick();

    expect(events).toEqual([WORKING]);
  });

  it('re-runs locate after the file is deleted', async () => {
    writeFileSync(file, COMPLETE);
    const other = join(dir, 'rollout-other.jsonl');
    const locate = () => (existsSync(file) ? file : existsSync(other) ? other : null);
    const { monitor, events, watchListeners } = makeMonitor({}, locate);
    await monitor.start();

    unlinkSync(file);
    watchListeners[0]!('rename');
    writeFileSync(other, COMPLETE + STARTED);
    tick();

    expect(events).toEqual([WORKING]);
  });

  it('setHarnessSessionId re-locates at once and publishes a file already containing task_started', async () => {
    writeFileSync(file, STARTED);
    const { monitor, events } = makeMonitor({}, (ctx) => (ctx.harnessSessionId === 'codex-id-1' ? file : null));
    await monitor.start();
    expect(events).toEqual([]);

    monitor.setHarnessSessionId('codex-id-1');

    expect(monitor.state).toBe('working');
    expect(events).toEqual([WORKING]);
  });

  it('stop() ends all activity', async () => {
    writeFileSync(file, STARTED);
    const { monitor, events } = makeMonitor({ staleMs: 1000 });
    await monitor.start();
    monitor.stop();

    appendFileSync(file, COMPLETE);
    tick(10_000);

    expect(events).toEqual([WORKING]);
  });
});

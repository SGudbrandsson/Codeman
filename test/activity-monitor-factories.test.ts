/**
 * activityMonitorFactories: only the codex ('transcript') monitor tracks pending questions.
 *
 * Real rollout file under a temp CODEX_HOME (set before any module resolves it). Monitors for
 * other sources are constructed but never started, so no ~/.claude file is read.
 *
 * Run: npx vitest run test/activity-monitor-factories.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activityMonitorFactories, type ActivityMonitor } from '../src/activity-monitor.js';
import { clearCodexLocateCache } from '../src/harnesses/transcripts/codex.js';

const HARNESS_ID = '00000000-0000-4000-8000-000000000071';
const rec = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type, payload }) + '\n';

let tmpRoot = '';
const savedCodexHome = process.env.CODEX_HOME;
const monitors: ActivityMonitor[] = [];

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'activity-factories-'));
  process.env.CODEX_HOME = join(tmpRoot, 'codex');
  const dir = join(process.env.CODEX_HOME, 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-01-01T00-00-00-${HARNESS_ID}.jsonl`),
    rec('event_msg', { type: 'task_started', turn_id: 't1' }) +
      rec('response_item', {
        type: 'function_call',
        name: 'request_user_input_async',
        call_id: 'call_f1',
        arguments: JSON.stringify({ questions: [{ title: 'Pick one', options: ['A', 'B'] }] }),
      }) +
      rec('response_item', { type: 'function_call_output', call_id: 'call_f1', output: '{"accepted":true}' }) +
      rec('event_msg', { type: 'task_complete', turn_id: 't1' })
  );
  clearCodexLocateCache();
});

afterEach(() => {
  for (const m of monitors.splice(0)) m.stop();
});

afterAll(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('activityMonitorFactories question tracking', () => {
  it('the transcript (codex) monitor raises an unanswered question from the rollout', async () => {
    const monitor = activityMonitorFactories.transcript!({
      id: 'sess-factory-codex',
      workingDir: tmpRoot,
      harnessSessionId: HARNESS_ID,
    })!;
    monitors.push(monitor);
    const questions: unknown[] = [];
    monitor.on('question', (q: unknown) => questions.push(q));

    await monitor.start();

    expect(questions).toEqual([
      {
        toolUseId: 'call_f1',
        questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
        replay: true,
      },
    ]);
    expect(monitor.pendingQuestion?.toolUseId).toBe('call_f1');
  });

  it('the hook and claudeTranscript monitors expose no pendingQuestion', () => {
    const host = { id: 'sess-factory-other', workingDir: tmpRoot };
    for (const source of ['hook', 'claudeTranscript'] as const) {
      const monitor = activityMonitorFactories[source]!(host)!;
      monitors.push(monitor);
      expect(monitor.pendingQuestion).toBeUndefined();
    }
  });

  it('pty has no monitor factory', () => {
    expect(activityMonitorFactories.pty).toBeNull();
  });
});

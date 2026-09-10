/**
 * TranscriptWatcher: the Claude state machine is gated behind `claudeState`.
 *
 * A codex/pi watcher (claudeState:false) must emit `transcript:block` and nothing from the
 * Claude state machine — even when a record happens to look like a Claude `result` or an
 * ExitPlanMode tool call. A Claude watcher (default) must behave exactly as before.
 *
 * Run: npx vitest run test/transcript-watcher-harness-isolation.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../src/transcript-watcher.js';
import {
  codexTranscriptAdapter,
  piTranscriptAdapter,
  claudeTranscriptAdapter,
  parseJsonlBuffer,
} from '../src/harnesses/transcripts/index.js';
import { seqBaseForOffset, type TranscriptBlock } from '../src/types/transcript-blocks.js';

const CLAUDE_EVENTS = [
  'transcript:complete',
  'transcript:plan_mode',
  'transcript:tool_start',
  'transcript:tool_end',
  'transcript:ask_user_question',
  'transcript:ask_user_question_resolved',
  'transcript:update',
] as const;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await wait(20);
  }
}

/** Records that look like Claude state-machine triggers. A view-only watcher must ignore them. */
const CLAUDE_LOOKALIKES = [
  { type: 'result', timestamp: 't' },
  {
    type: 'assistant',
    timestamp: 't',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'ExitPlanMode', input: {} },
        { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'q', options: [] }] } },
      ],
    },
  },
];

describe('TranscriptWatcher — harness isolation', () => {
  let dir: string;
  let file: string;
  let watcher: TranscriptWatcher;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tv-watch-iso-'));
    file = join(dir, 't.jsonl');
    writeFileSync(file, '');
  });
  afterEach(() => {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function track(w: TranscriptWatcher) {
    const blocks: TranscriptBlock[] = [];
    const claudeFired: string[] = [];
    w.on('transcript:block', (b) => blocks.push(b));
    for (const ev of CLAUDE_EVENTS) w.on(ev, () => claudeFired.push(ev));
    return { blocks, claudeFired };
  }

  it('codex: blocks fire, the Claude state machine never does', async () => {
    watcher = new TranscriptWatcher({ claudeState: false, adapter: codexTranscriptAdapter });
    const t = track(watcher);
    watcher.start(file);
    const fixture = readFileSync(join(__dirname, 'fixtures', 'transcripts', 'codex.jsonl'), 'utf-8');
    appendFileSync(file, fixture + CLAUDE_LOOKALIKES.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await waitFor(() => t.blocks.length >= 5);
    await wait(150);
    expect(t.blocks.map((b) => b.type)).toEqual(['text', 'text', 'tool_use', 'tool_result', 'result']);
    expect(t.claudeFired).toEqual([]);
    expect(watcher.getState().entryCount).toBe(0);
  });

  it('pi: blocks (thinking included) fire, the Claude state machine never does', async () => {
    watcher = new TranscriptWatcher({ claudeState: false, adapter: piTranscriptAdapter });
    const t = track(watcher);
    watcher.start(file);
    const fixture = readFileSync(join(__dirname, 'fixtures', 'transcripts', 'pi.jsonl'), 'utf-8');
    appendFileSync(file, fixture + CLAUDE_LOOKALIKES.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await waitFor(() => t.blocks.length >= 6);
    await wait(150);
    expect(t.blocks.map((b) => b.type)).toEqual(['text', 'thinking', 'tool_use', 'tool_result', 'text', 'result']);
    expect(t.claudeFired).toEqual([]);
  });

  it('claude (default): state events still fire exactly as before, and blocks carry seq', async () => {
    watcher = new TranscriptWatcher();
    const t = track(watcher);
    watcher.start(file);
    appendFileSync(
      file,
      [
        { type: 'user', timestamp: 't', message: { role: 'user', content: 'go' } },
        ...CLAUDE_LOOKALIKES.slice(1),
        { type: 'result', timestamp: 't' },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n'
    );
    await waitFor(() => t.claudeFired.includes('transcript:complete'));
    for (const ev of [
      'transcript:plan_mode',
      'transcript:tool_start',
      'transcript:ask_user_question',
      'transcript:update',
    ]) {
      expect(t.claudeFired).toContain(ev);
    }
    expect(t.blocks.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_use', 'result']);
    for (const b of t.blocks) expect(typeof b.seq).toBe('number');
  });

  it('SSE seq values equal the REST (full-file) seq values for the same lines', async () => {
    writeFileSync(
      file,
      JSON.stringify({ type: 'user', timestamp: 't', message: { role: 'user', content: 'before' } }) + '\n'
    );
    watcher = new TranscriptWatcher();
    const t = track(watcher);
    watcher.start(file); // seeks to EOF — offsets must still be absolute
    appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: 't',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      }) + '\n'
    );
    await waitFor(() => t.blocks.length >= 2);
    const rest = parseJsonlBuffer(claudeTranscriptAdapter, readFileSync(file), 0);
    expect(t.blocks.map((b) => b.seq)).toEqual(rest.slice(1).map((b) => b.seq));
  });

  it('a line caught mid-write is read whole on the next change, not dropped', async () => {
    watcher = new TranscriptWatcher({ claudeState: false, adapter: piTranscriptAdapter });
    const t = track(watcher);
    watcher.start(file);
    const full = JSON.stringify({
      type: 'message',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    appendFileSync(file, full.slice(0, 20));
    await wait(200);
    expect(t.blocks).toHaveLength(0);
    appendFileSync(file, full.slice(20) + '\n');
    await waitFor(() => t.blocks.length >= 1);
    expect(t.blocks[0]).toMatchObject({ type: 'text', text: 'hello' });
  });

  const piLine = (text: string) =>
    JSON.stringify({
      type: 'message',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  const restSeqs = () => parseJsonlBuffer(piTranscriptAdapter, readFileSync(file), 0).map((b) => b.seq);
  const texts = (blocks: TranscriptBlock[]) => blocks.map((b) => (b as { text?: string }).text);

  it('a line completed after a partial write gets the same seq as the REST read', async () => {
    writeFileSync(file, piLine('before') + '\n');
    watcher = new TranscriptWatcher({ claudeState: false, adapter: piTranscriptAdapter });
    const t = track(watcher);
    watcher.start(file); // seeks past 'before'
    const full = piLine('hello');
    appendFileSync(file, full.slice(0, 20));
    await wait(200);
    expect(t.blocks).toHaveLength(0);
    appendFileSync(file, full.slice(20) + '\n');
    await waitFor(() => t.blocks.length >= 1);
    await wait(150);
    expect(t.blocks.map((b) => b.seq)).toEqual(restSeqs().slice(1));
    expect(t.blocks[0]!.seq).toBe(seqBaseForOffset(Buffer.byteLength(piLine('before') + '\n')));
  });

  it('a malformed complete line is skipped and the lines after it keep REST seq', async () => {
    watcher = new TranscriptWatcher({ claudeState: false, adapter: piTranscriptAdapter });
    const t = track(watcher);
    watcher.start(file);
    appendFileSync(file, piLine('one') + '\n{not json\n');
    await waitFor(() => t.blocks.length >= 1);
    await wait(150);
    appendFileSync(file, piLine('two') + '\n');
    await waitFor(() => t.blocks.length >= 2);
    await wait(150);
    expect(texts(t.blocks)).toEqual(['one', 'two']);
    expect(t.blocks.map((b) => b.seq)).toEqual(restSeqs());
  });

  it('CRLF-terminated appends keep REST seq', async () => {
    writeFileSync(file, piLine('before') + '\r\n');
    watcher = new TranscriptWatcher({ claudeState: false, adapter: piTranscriptAdapter });
    const t = track(watcher);
    watcher.start(file);
    appendFileSync(file, piLine('one') + '\r\n' + piLine('two') + '\r\n');
    await waitFor(() => t.blocks.length >= 2);
    await wait(150);
    expect(texts(t.blocks)).toEqual(['one', 'two']);
    expect(t.blocks.map((b) => b.seq)).toEqual(restSeqs().slice(1));
  });
});

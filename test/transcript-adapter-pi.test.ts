/**
 * Pi session transcript adapter.
 *
 * The fixture is fully synthetic (no real session data); only its record SHAPES follow
 * pi 0.85.1 session files.
 *
 * Run: npx vitest run test/transcript-adapter-pi.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTranscriptAdapter, piTranscriptAdapter, parseJsonlBuffer } from '../src/harnesses/transcripts/index.js';
import { piSessionDirName } from '../src/harnesses/transcripts/pi.js';

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'transcripts', 'pi.jsonl'), 'utf-8');
const line = (o: unknown) => JSON.stringify(o);
const msg = (message: unknown) => line({ type: 'message', timestamp: 't', message });

describe('pi transcript adapter — parsing', () => {
  it('is registered for pi', () => {
    expect(getTranscriptAdapter('pi')).toBe(piTranscriptAdapter);
  });

  it('maps a whole session file to the expected blocks, in order', () => {
    const blocks = parseJsonlBuffer(piTranscriptAdapter, Buffer.from(FIXTURE), 0);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'thinking', 'tool_use', 'tool_result', 'text', 'result']);
    expect(blocks[0]).toMatchObject({ type: 'text', role: 'user', text: 'hello' });
    expect(blocks[1]).toMatchObject({ type: 'thinking', text: 'thinking about hello' });
    expect(blocks[2]).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'read',
      input: { path: '/tmp/example-project/README.md' },
    });
    expect(blocks[3]).toMatchObject({ type: 'tool_result', toolUseId: 'call_1', content: 'hello\n', isError: false });
    expect(blocks[4]).toMatchObject({ type: 'text', role: 'assistant', text: 'hello back' });
    expect(blocks[5]).toMatchObject({ type: 'result', error: 'example error' });
    // thinking + toolCall from ONE record: same timestamp, distinct seq.
    expect(blocks[1]!.timestamp).toBe(blocks[2]!.timestamp);
    expect(blocks[2]!.seq).toBe(blocks[1]!.seq + 1);
  });

  it('user text, assistant text, thinking and toolCall map per the spec table', () => {
    expect(piTranscriptAdapter.parseLine(msg({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), 0)).toEqual([
      { type: 'text', role: 'user', text: 'hi', timestamp: 't', seq: 0 },
    ]);
    expect(
      piTranscriptAdapter.parseLine(
        msg({
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'ok' },
            { type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'ls' } },
          ],
        }),
        10
      )
    ).toEqual([
      { type: 'thinking', text: 'hmm', timestamp: 't', seq: 10 },
      { type: 'text', role: 'assistant', text: 'ok', timestamp: 't', seq: 11 },
      { type: 'tool_use', id: 'c', name: 'bash', input: { command: 'ls' }, timestamp: 't', seq: 12 },
    ]);
  });

  it('toolResult with isError → tool_result isError', () => {
    expect(
      piTranscriptAdapter.parseLine(
        msg({ role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'nope' }], isError: true }),
        0
      )
    ).toMatchObject([{ type: 'tool_result', toolUseId: 'c', content: 'nope', isError: true }]);
  });

  it('non-message records, unknown roles and malformed lines yield [] without throwing', () => {
    for (const raw of [
      line({ type: 'session', version: 3, id: 'x' }),
      line({ type: 'model_change', modelId: 'm' }),
      line({ type: 'thinking_level_change' }),
      line({ type: 'session_info', name: 'n' }),
      line({ type: 'message' }),
      msg({ role: 'bashExecution', content: [] }),
      msg({ role: 'assistant', content: 42 }),
      msg({ role: 'assistant', content: [null, 'x', { type: 'image', data: 'AAAA' }] }),
      '{"type":"message",',
      'true',
    ]) {
      expect(piTranscriptAdapter.parseLine(raw, 0)).toEqual([]);
    }
  });

  it('drops base64 image payloads', () => {
    const blocks = parseJsonlBuffer(piTranscriptAdapter, Buffer.from(FIXTURE), 0);
    for (const b of blocks) {
      const s = JSON.stringify(b);
      expect(s.length).toBeLessThan(4096);
      expect(s).not.toContain('ZmFrZS1pbWFnZQ');
    }
  });
});

describe('pi transcript adapter — locate', () => {
  const ID = '00000000-0000-4000-8000-000000000002';
  const workingDir = '/tmp/example.project';
  let agentDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'tv-pi-agent-'));
    prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('encodes the cwd the way pi 0.85.1 does (not Claude’s encoding: dots kept, wrapped in --)', () => {
    expect(piSessionDirName('/home/example')).toBe('--home-example--');
    expect(piSessionDirName('/tmp/example-project/.claude/worktrees/wt')).toBe(
      '--tmp-example-project-.claude-worktrees-wt--'
    );
  });

  function sessionDir(): string {
    const dir = join(agentDir, 'sessions', piSessionDirName(workingDir));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('finds <ts>_<harnessSessionId>.jsonl in the escaped-cwd dir, newest first', () => {
    const dir = sessionDir();
    const older = join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
    const newer = join(dir, `2026-01-02T00-00-00-000Z_${ID}.jsonl`);
    writeFileSync(older, FIXTURE);
    writeFileSync(newer, FIXTURE);
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    writeFileSync(join(dir, '2026-01-02T00-00-00-000Z_other-id.jsonl'), FIXTURE);
    expect(piTranscriptAdapter.locate({ workingDir, sessionId: 'ignored', harnessSessionId: ID })).toBe(newer);
  });

  it('falls back to the Codeman session id (pi --session-id is preassigned from it)', () => {
    const file = join(sessionDir(), `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
    writeFileSync(file, FIXTURE);
    expect(piTranscriptAdapter.locate({ workingDir, sessionId: ID })).toBe(file);
  });

  it('returns null when the file has not been written yet', () => {
    sessionDir();
    expect(piTranscriptAdapter.locate({ workingDir, sessionId: ID })).toBeNull();
    expect(piTranscriptAdapter.locate({ workingDir: '/nowhere', sessionId: ID })).toBeNull();
  });

  it('returns null for a traversal id or a symlink escaping the sessions root', () => {
    sessionDir();
    expect(piTranscriptAdapter.locate({ workingDir, sessionId: '../../../etc/passwd' })).toBeNull();
    const outside = mkdtempSync(join(tmpdir(), 'tv-pi-outside-'));
    try {
      const target = join(outside, 'secret.jsonl');
      writeFileSync(target, 'secret');
      symlinkSync(target, join(sessionDir(), `2026-01-01T00-00-00-000Z_${ID}.jsonl`));
      expect(piTranscriptAdapter.locate({ workingDir, sessionId: ID })).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

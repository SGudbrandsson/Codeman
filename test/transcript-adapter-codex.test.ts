/**
 * Codex rollout transcript adapter.
 *
 * The fixture is fully synthetic (no real session data); only its record SHAPES follow
 * codex 0.144 / 0.154 rollouts.
 *
 * Run: npx vitest run test/transcript-adapter-codex.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTranscriptAdapter, codexTranscriptAdapter, parseJsonlBuffer } from '../src/harnesses/transcripts/index.js';
import {
  classifyCodexQuestion,
  matchCodexAnswer,
  clearCodexLocateCache,
  CODEX_LOCATE_MISS_TTL_MS,
  CODEX_QUESTION_TOOL,
  normalizeCodexQuestions,
} from '../src/harnesses/transcripts/codex.js';

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'transcripts', 'codex.jsonl'), 'utf-8');
const line = (o: unknown) => JSON.stringify(o);

describe('codex transcript adapter — parsing', () => {
  it('is registered for codex', () => {
    expect(getTranscriptAdapter('codex')).toBe(codexTranscriptAdapter);
  });

  it('maps a whole rollout to the expected blocks, in order', () => {
    const blocks = parseJsonlBuffer(codexTranscriptAdapter, Buffer.from(FIXTURE), 0);
    expect(blocks.map((b) => [b.type, 'role' in b ? b.role : undefined])).toEqual([
      ['text', 'user'],
      ['text', 'assistant'],
      ['tool_use', undefined],
      ['tool_result', undefined],
      ['result', undefined],
    ]);
    expect(blocks[0]).toMatchObject({ text: 'hello' });
    // agent_message duplicates response_item/message assistant — rendered once, not twice.
    expect(blocks.filter((b) => b.type === 'text' && b.role === 'assistant')).toHaveLength(1);
    expect(blocks[2]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'exec', input: { input: 'echo hello' } });
    expect(blocks[3]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call_1',
      content: 'Script completed\nhello\n',
      isError: false,
    });
    expect(blocks[4]).toMatchObject({ type: 'result', durationMs: 4500 });
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.seq).toBeGreaterThan(blocks[i - 1]!.seq);
  });

  it('event_msg/user_message → user text', () => {
    const b = codexTranscriptAdapter.parseLine(
      line({ timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
      0
    );
    expect(b).toEqual([{ type: 'text', role: 'user', text: 'hi', timestamp: 't', seq: 0 }]);
  });

  it('event_msg/item_completed UserMessage (codex 0.154) → user text', () => {
    const b = codexTranscriptAdapter.parseLine(
      line({
        timestamp: 't',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'text', text: 'from 0.154', text_elements: [] }] },
        },
      }),
      5
    );
    expect(b).toEqual([{ type: 'text', role: 'user', text: 'from 0.154', timestamp: 't', seq: 5 }]);
  });

  it('response_item/message assistant → assistant text', () => {
    const b = codexTranscriptAdapter.parseLine(
      line({
        timestamp: 't',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      }),
      0
    );
    expect(b).toMatchObject([{ type: 'text', role: 'assistant', text: 'done' }]);
  });

  it('filters developer and injected user response_items, reasoning, token_count and agent_message', () => {
    for (const rec of [
      {
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>' }] },
      },
      { type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'ZmFrZS1ibG9i' } },
      { type: 'event_msg', payload: { type: 'token_count', info: {} } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'dup' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage' } } },
      { type: 'session_meta', payload: { session_id: 'x' } },
      { type: 'turn_context', payload: {} },
      { type: 'world_state', payload: {} },
    ]) {
      expect(codexTranscriptAdapter.parseLine(line({ timestamp: 't', ...rec }), 0)).toEqual([]);
    }
  });

  it('maps older function_call / function_call_output records', () => {
    const use = codexTranscriptAdapter.parseLine(
      line({
        timestamp: 't',
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}' },
      }),
      0
    );
    expect(use).toMatchObject([{ type: 'tool_use', id: 'c1', name: 'shell', input: { command: ['ls'] } }]);
    const res = codexTranscriptAdapter.parseLine(
      line({
        timestamp: 't',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: { content: 'boom', success: false } },
      }),
      0
    );
    expect(res).toMatchObject([{ type: 'tool_result', toolUseId: 'c1', content: 'boom', isError: true }]);
  });

  it('unknown records and malformed lines yield [] without throwing', () => {
    expect(codexTranscriptAdapter.parseLine(line({ type: 'future_thing', payload: { type: 'x' } }), 0)).toEqual([]);
    expect(codexTranscriptAdapter.parseLine(line({ type: 'event_msg' }), 0)).toEqual([]);
    expect(codexTranscriptAdapter.parseLine(line({ type: 'event_msg', payload: 'str' }), 0)).toEqual([]);
    expect(
      codexTranscriptAdapter.parseLine(
        line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 7 } }),
        0
      )
    ).toEqual([]);
    expect(codexTranscriptAdapter.parseLine('{"type":"event_msg",', 0)).toEqual([]);
    expect(codexTranscriptAdapter.parseLine('[]', 0)).toEqual([]);
  });

  it('drops encrypted reasoning and base64 image payloads', () => {
    const blocks = parseJsonlBuffer(codexTranscriptAdapter, Buffer.from(FIXTURE), 0);
    for (const b of blocks) {
      const s = JSON.stringify(b);
      expect(s.length).toBeLessThan(4096);
      expect(s).not.toContain('ZmFrZS1ibG9i');
      expect(s).not.toContain('base64');
      expect(s).not.toContain('ZmFrZS1pbWFnZQ');
    }
  });
});

describe('codex transcript adapter — locate', () => {
  const ID = '00000000-0000-4000-8000-000000000001';
  let codexHomeDir: string;
  let prevCodexHome: string | undefined;

  beforeEach(() => {
    codexHomeDir = mkdtempSync(join(tmpdir(), 'tv-codex-home-'));
    prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHomeDir;
    clearCodexLocateCache();
  });
  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    clearCodexLocateCache();
    rmSync(codexHomeDir, { recursive: true, force: true });
  });

  const ctx = (harnessSessionId?: string) => ({
    workingDir: '/tmp/example-project',
    sessionId: 'sess-1',
    harnessSessionId,
  });

  function writeRollout(day: string, id = ID): string {
    const dir = join(codexHomeDir, 'sessions', '2026', '01', day);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-01-${day}T00-00-00-${id}.jsonl`);
    writeFileSync(file, FIXTURE);
    return file;
  }

  it('finds the rollout for the harness session id', () => {
    const file = writeRollout('01');
    writeRollout('01', '00000000-0000-4000-8000-000000000009');
    expect(codexTranscriptAdapter.locate(ctx(ID))).toBe(file);
  });

  it('returns null before discovery (no harnessSessionId) and when no file exists yet', () => {
    expect(codexTranscriptAdapter.locate(ctx(undefined))).toBeNull();
    expect(codexTranscriptAdapter.locate(ctx(ID))).toBeNull();
  });

  it('rejects ids that are not UUID-shaped', () => {
    writeRollout('01');
    expect(codexTranscriptAdapter.locate(ctx('../../etc/passwd'))).toBeNull();
    expect(codexTranscriptAdapter.locate(ctx('*'))).toBeNull();
  });

  it('returns null for a rollout symlinked from outside the sessions root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tv-codex-outside-'));
    try {
      const target = join(outside, 'secret.jsonl');
      writeFileSync(target, 'secret');
      const dir = join(codexHomeDir, 'sessions', '2026', '01', '01');
      mkdirSync(dir, { recursive: true });
      symlinkSync(target, join(dir, `rollout-2026-01-01T00-00-00-${ID}.jsonl`));
      expect(codexTranscriptAdapter.locate(ctx(ID))).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('caches the resolved path but re-validates it when the file disappears', () => {
    const file = writeRollout('01');
    expect(codexTranscriptAdapter.locate(ctx(ID))).toBe(file);
    unlinkSync(file);
    expect(codexTranscriptAdapter.locate(ctx(ID))).toBeNull();
  });

  it('remembers a miss for a short TTL, then finds a rollout written after it', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      expect(codexTranscriptAdapter.locate(ctx(ID))).toBeNull();
      const file = writeRollout('01');
      // Within the TTL the miss is served from cache — no re-walk.
      now.mockReturnValue(1_000_000 + CODEX_LOCATE_MISS_TTL_MS - 1);
      expect(codexTranscriptAdapter.locate(ctx(ID))).toBeNull();
      // After the TTL the tree is walked again and the late-written rollout is found.
      now.mockReturnValue(1_000_000 + CODEX_LOCATE_MISS_TTL_MS);
      expect(codexTranscriptAdapter.locate(ctx(ID))).toBe(file);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps the miss TTL short enough for a late first-turn rollout (<= 30 s)', () => {
    expect(CODEX_LOCATE_MISS_TTL_MS).toBeGreaterThanOrEqual(10_000);
    expect(CODEX_LOCATE_MISS_TTL_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('codex transcript adapter — questions (request_user_input_async)', () => {
  const askRecord = (args: unknown, callId = 'call_q1') => ({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: CODEX_QUESTION_TOOL,
      call_id: callId,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  });

  describe('normalizeCodexQuestions', () => {
    it('maps title → question and string options → {label}', () => {
      expect(
        normalizeCodexQuestions({
          questions: [{ title: 'Who should it serve?', options: ['Everyday', 'Camping'] }, { title: 'Anything else?' }],
        })
      ).toEqual([
        { question: 'Who should it serve?', options: [{ label: 'Everyday' }, { label: 'Camping' }] },
        { question: 'Anything else?', options: [] },
      ]);
    });

    it('keeps object options, header and multiSelect; falls back to question/header text', () => {
      expect(
        normalizeCodexQuestions({
          questions: [
            {
              question: 'Pick?',
              header: 'Scope',
              multiSelect: true,
              options: [{ label: 'A', description: 'first' }, { label: '' }, 42, 'B'],
            },
            { header: 'Only a header' },
          ],
        })
      ).toEqual([
        {
          question: 'Pick?',
          header: 'Scope',
          multiSelect: true,
          options: [{ label: 'A', description: 'first' }, { label: 'B' }],
        },
        { question: 'Only a header', options: [] },
      ]);
    });

    it.each([[null], ['x'], [{}], [{ questions: 'no' }], [{ questions: [null, 3, { title: '  ' }] }]])(
      'malformed input %j → []',
      (raw) => {
        expect(normalizeCodexQuestions(raw)).toEqual([]);
      }
    );

    it('caps the number of questions', () => {
      const questions = Array.from({ length: 30 }, (_, i) => ({ title: `Q${i}` }));
      expect(normalizeCodexQuestions({ questions })).toHaveLength(10);
    });
  });

  it('parses the call into a normalised tool_use and the accepted output into a tool_result', () => {
    const jsonl = [
      line(askRecord({ questions: [{ title: 'Who?', options: ['Me', 'You'] }] })),
      line({
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_q1', output: '{"accepted":true}' },
      }),
    ].join('\n');
    const blocks = parseJsonlBuffer(codexTranscriptAdapter, Buffer.from(jsonl), 0);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'call_q1',
      name: 'request_user_input_async',
      input: { questions: [{ question: 'Who?', options: [{ label: 'Me' }, { label: 'You' }] }] },
    });
    expect(blocks[1]).toMatchObject({ type: 'tool_result', toolUseId: 'call_q1', content: '{"accepted":true}' });
  });

  it('leaves other tools untouched', () => {
    const rec = askRecord({ questions: [{ title: 'Who?' }] });
    rec.payload.name = 'shell';
    const [block] = codexTranscriptAdapter.parseRecord(rec, 0);
    expect(block).toMatchObject({ type: 'tool_use', name: 'shell', input: { questions: [{ title: 'Who?' }] } });
  });

  describe('matchCodexAnswer', () => {
    const titles = ['Who is the todo app for?', 'Which platform should the todo app run on?'];

    it('matches the codex "> title\\n\\nanswer" shape to its question', () => {
      expect(matchCodexAnswer('> Who is the todo app for?\n\nMe', titles)).toBe(0);
      expect(matchCodexAnswer('> Which platform should the todo app run on?\n\nWeb', titles)).toBe(1);
    });

    it('plain, empty-quote or unknown-title messages → -1', () => {
      expect(matchCodexAnswer('Who is the todo app for?\n\nMe', titles)).toBe(-1);
      expect(matchCodexAnswer('Dark theme, please.', titles)).toBe(-1);
      expect(matchCodexAnswer('>\n\nMe', titles)).toBe(-1);
      expect(matchCodexAnswer('> Something else\n\nMe', titles)).toBe(-1);
    });

    it('tolerates leading/trailing whitespace, CRLF and collapsed spacing', () => {
      expect(matchCodexAnswer('  >   Who is  the todo\r\napp for?  \r\n\r\nMe', titles)).toBe(0);
    });

    it('matches a title containing newlines, quoted per line or not', () => {
      const multi = ['First line\nsecond line?'];
      expect(matchCodexAnswer('> First line\n> second line?\n\nA', multi)).toBe(0);
      expect(matchCodexAnswer('> First line\nsecond line?\n\nA', multi)).toBe(0);
    });

    it('a truncated quoted title (with ellipsis) matches its full title', () => {
      expect(matchCodexAnswer('> Which platform should the…\n\nWeb', titles)).toBe(1);
      expect(matchCodexAnswer('> Which…\n\nWeb', titles)).toBe(-1); // too short to trust
    });

    it('skips answered questions and prefers the longest whole-title match', () => {
      expect(matchCodexAnswer('> Who is the todo app for?\n\nMe', titles, new Set([0]))).toBe(-1);
      expect(matchCodexAnswer('> Who? Really?\n\nx', ['Who?', 'Who? Really?'])).toBe(1);
      expect(matchCodexAnswer('> Who?\n\nx', ['Who?', 'Who?'], new Set([0]))).toBe(1);
    });

    it('a clipped title (trailing ellipsis from normalisation) still matches the full quote', () => {
      const long = 'q'.repeat(2500);
      const [normalised] = normalizeCodexQuestions({ questions: [{ title: long }] });
      expect(matchCodexAnswer(`> ${long}\n\nA`, [normalised.question])).toBe(0);
    });
  });

  describe('classifyCodexQuestion', () => {
    it('an ask call with questions → ask', () => {
      expect(classifyCodexQuestion(askRecord({ questions: [{ title: 'Who?', options: ['Me'] }] }))).toEqual({
        kind: 'ask',
        toolUseId: 'call_q1',
        questions: [{ question: 'Who?', options: [{ label: 'Me' }] }],
      });
    });

    it('an ask call with no usable questions, malformed args or another tool → null', () => {
      expect(classifyCodexQuestion(askRecord({ questions: [] }))).toBe(null);
      expect(classifyCodexQuestion(askRecord('not json'))).toBe(null);
      const other = askRecord({ questions: [{ title: 'Who?' }] });
      other.payload.name = 'shell';
      expect(classifyCodexQuestion(other)).toBe(null);
    });

    it('both user message shapes → user with its text', () => {
      expect(classifyCodexQuestion({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } })).toEqual({
        kind: 'user',
        text: 'hi',
      });
      expect(
        classifyCodexQuestion({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'UserMessage', content: [{ type: 'input_text', text: '> Who?\n\nMe' }] },
          },
        })
      ).toEqual({ kind: 'user', text: '> Who?\n\nMe' });
    });

    it('caps the user text kept for matching', () => {
      const signal = classifyCodexQuestion({
        type: 'event_msg',
        payload: { type: 'user_message', message: '> ' + 'x'.repeat(100_000) },
      });
      expect(signal?.kind).toBe('user');
      expect((signal as { text: string }).text.length).toBeLessThan(5000);
    });

    it('empty user messages, response_item role user and unrelated records → null', () => {
      expect(classifyCodexQuestion({ type: 'event_msg', payload: { type: 'user_message', message: '  ' } })).toBe(null);
      expect(
        classifyCodexQuestion({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>' }] },
        })
      ).toBe(null);
      expect(classifyCodexQuestion({ type: 'event_msg', payload: { type: 'task_complete' } })).toBe(null);
      expect(classifyCodexQuestion(null)).toBe(null);
      expect(classifyCodexQuestion('x')).toBe(null);
    });

    it('toolUseId falls back from call_id to payload.id, then to an empty string', () => {
      const args = JSON.stringify({ questions: [{ title: 'Who?' }] });
      const withId = {
        type: 'response_item',
        payload: { type: 'function_call', name: CODEX_QUESTION_TOOL, id: 'fc_9', arguments: args },
      };
      expect(classifyCodexQuestion(withId)).toMatchObject({ kind: 'ask', toolUseId: 'fc_9' });
      const noId = {
        type: 'response_item',
        payload: { type: 'function_call', name: CODEX_QUESTION_TOOL, arguments: args },
      };
      expect(classifyCodexQuestion(noId)).toMatchObject({ kind: 'ask', toolUseId: '' });
    });

    it('a custom_tool_call ask reads its questions from input', () => {
      expect(
        classifyCodexQuestion({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: CODEX_QUESTION_TOOL,
            call_id: 'ct_1',
            input: JSON.stringify({ questions: [{ title: 'Which?', options: ['X'] }] }),
          },
        })
      ).toEqual({ kind: 'ask', toolUseId: 'ct_1', questions: [{ question: 'Which?', options: [{ label: 'X' }] }] });
    });
  });
});

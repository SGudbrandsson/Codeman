/**
 * Claude transcript adapter: a no-behaviour-change wrapper over parseTranscriptEntry and
 * the existing path resolution order.
 *
 * Run: npx vitest run test/transcript-adapter-claude.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getTranscriptAdapter,
  claudeTranscriptAdapter,
  parseJsonlBuffer,
  readTranscriptTail,
  readTranscriptFile,
} from '../src/harnesses/transcripts/index.js';
import { parseTranscriptJSONL, SEQ_BLOCKS_PER_LINE } from '../src/types/transcript-blocks.js';

const LINES = [
  { type: 'system', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'system', content: 'sys' } },
  { type: 'user', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'Hello' } },
  {
    type: 'assistant',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } },
      ],
    },
  },
  {
    type: 'user',
    timestamp: '2026-01-01T00:00:03.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'data', is_error: false }] },
  },
  { type: 'result', timestamp: '2026-01-01T00:00:04.000Z', total_cost_usd: 0.01, duration_ms: 1200 },
];
const CONTENT = LINES.map((l) => JSON.stringify(l)).join('\n') + '\n';

describe('claude transcript adapter — parsing', () => {
  it('is registered for claude and for a legacy session with no mode', () => {
    expect(getTranscriptAdapter('claude')).toBe(claudeTranscriptAdapter);
    expect(getTranscriptAdapter(undefined)).toBe(claudeTranscriptAdapter);
    expect(getTranscriptAdapter('shell')).toBeNull();
    expect(getTranscriptAdapter('opencode')).toBeNull();
  });

  it('reproduces parseTranscriptJSONL block-for-block, seq included', () => {
    const viaAdapter = parseJsonlBuffer(claudeTranscriptAdapter, Buffer.from(CONTENT), 0);
    const legacy = parseTranscriptJSONL(CONTENT);
    expect(viaAdapter).toEqual(legacy);
    expect(viaAdapter.map((b) => b.type)).toEqual(['text', 'text', 'tool_use', 'tool_result', 'result']);
  });

  it('gives every block a strictly increasing seq, siblings of one line included', () => {
    const blocks = parseJsonlBuffer(claudeTranscriptAdapter, Buffer.from(CONTENT), 0);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.seq).toBeGreaterThan(blocks[i - 1]!.seq);
    // The two blocks from the assistant line share a timestamp but not a seq.
    expect(blocks[1]!.timestamp).toBe(blocks[2]!.timestamp);
    expect(blocks[2]!.seq - blocks[1]!.seq).toBe(1);
  });

  it('seq is the line start byte offset times SEQ_BLOCKS_PER_LINE plus the block index', () => {
    const blocks = parseJsonlBuffer(claudeTranscriptAdapter, Buffer.from(CONTENT), 0);
    const userLineOffset = Buffer.byteLength(JSON.stringify(LINES[0]) + '\n');
    expect(blocks[0]!.seq).toBe(userLineOffset * SEQ_BLOCKS_PER_LINE);
  });

  it('a malformed line or a non-object record yields [] and never throws', () => {
    expect(claudeTranscriptAdapter.parseLine('{not json', 0)).toEqual([]);
    expect(claudeTranscriptAdapter.parseLine('', 0)).toEqual([]);
    expect(claudeTranscriptAdapter.parseLine('42', 0)).toEqual([]);
    expect(claudeTranscriptAdapter.parseLine('null', 0)).toEqual([]);
    expect(claudeTranscriptAdapter.parseLine('{"type":"user","message":{"role":"user","content":{"x":1}}}', 0)).toEqual(
      []
    );
    expect(claudeTranscriptAdapter.parseLine('{"type":"assistant","message":{"content":[null,7]}}', 0)).toEqual([]);
  });
});

describe('bounded tail read', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tv-tail-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the same seq values as a full parse, and flags completeness', async () => {
    const file = join(dir, 't.jsonl');
    writeFileSync(file, CONTENT);
    const full = parseTranscriptJSONL(CONTENT);
    const tail = await readTranscriptTail(claudeTranscriptAdapter, file, 2);
    // Small file: the window covers byte 0, so the complete transcript comes back.
    expect(tail.complete).toBe(true);
    expect(tail.blocks).toEqual(full);
  });

  it('reads only a window from the end of a large file, slicing to the requested tail', async () => {
    const file = join(dir, 'big.jsonl');
    const pad = 'x'.repeat(2000);
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(
        JSON.stringify({
          type: 'user',
          timestamp: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
          message: { role: 'user', content: `m${i} ${pad}` },
        })
      );
    }
    const content = lines.join('\n') + '\n';
    writeFileSync(file, content);
    const full = parseTranscriptJSONL(content);
    const tail = await readTranscriptTail(claudeTranscriptAdapter, file, 5);
    expect(tail.complete).toBe(false);
    expect(tail.blocks).toEqual(full.slice(-5));
  });

  const userLine = (content: string, ts = '2026-01-01T00:00:00Z') =>
    JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content } });

  it('doubles the window when the first one holds fewer than tail blocks (a line larger than 256 KB)', async () => {
    const file = join(dir, 'huge-line.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(userLine(`p${i} ${'x'.repeat(2000)}`));
    lines.push(userLine(`huge ${'h'.repeat(600 * 1024)}`, '2026-01-01T00:00:01Z'));
    lines.push(userLine('hello', '2026-01-01T00:00:02Z'), userLine('hello again', '2026-01-01T00:00:03Z'));
    const content = lines.join('\n') + '\n';
    writeFileSync(file, content);
    // 256 KB and 512 KB windows both start inside the huge line (2 blocks < tail 3); the
    // 1 MB window reaches the prefix but not byte 0.
    expect(Buffer.byteLength(content)).toBeGreaterThan(1024 * 1024);
    const full = parseTranscriptJSONL(content);

    const tail = await readTranscriptTail(claudeTranscriptAdapter, file, 3);
    expect(tail.complete).toBe(false);
    expect(tail.blocks).toEqual(full.slice(-3));
    expect((tail.blocks[0] as { text: string }).text.startsWith('huge ')).toBe(true);
    expect(tail.estimatedTotal).toBeGreaterThan(tail.blocks.length);
  });

  it('a CRLF file gives identical blocks and seq from the full read, the tail read and parseTranscriptJSONL', async () => {
    const small = join(dir, 'crlf-small.jsonl');
    const smallContent = LINES.map((l) => JSON.stringify(l)).join('\r\n') + '\r\n';
    writeFileSync(small, smallContent);
    const legacySmall = parseTranscriptJSONL(smallContent);
    expect(legacySmall.map((b) => b.type)).toEqual(['text', 'text', 'tool_use', 'tool_result', 'result']);
    expect(await readTranscriptFile(claudeTranscriptAdapter, small)).toEqual(legacySmall);
    expect((await readTranscriptTail(claudeTranscriptAdapter, small, 2)).blocks).toEqual(legacySmall);

    // Large enough that the tail window starts mid-file.
    const big = join(dir, 'crlf-big.jsonl');
    const bigLines: string[] = [];
    for (let i = 0; i < 600; i++) bigLines.push(userLine(`m${i} ${'x'.repeat(2000)}`));
    const bigContent = bigLines.join('\r\n') + '\r\n';
    writeFileSync(big, bigContent);
    const legacyBig = parseTranscriptJSONL(bigContent);
    expect(await readTranscriptFile(claudeTranscriptAdapter, big)).toEqual(legacyBig);
    const tail = await readTranscriptTail(claudeTranscriptAdapter, big, 5);
    expect(tail.complete).toBe(false);
    expect(tail.blocks).toEqual(legacyBig.slice(-5));
  });

  it('a window starting exactly on a line boundary (its first whole line discarded) still equals full.slice(-tail)', async () => {
    const file = join(dir, 'boundary.jsonl');
    const LINE_BYTES = 4096; // including the '\n'
    const TAIL = 64; // window = max(256 KB, 64 * 4096) = 262144 bytes = exactly 64 lines
    const lines: string[] = [];
    for (let i = 0; i < 264; i++) {
      const prefix = `m${String(i).padStart(3, '0')} `;
      const base = userLine(prefix);
      const line = userLine(prefix + 'z'.repeat(LINE_BYTES - 1 - base.length));
      expect(Buffer.byteLength(line)).toBe(LINE_BYTES - 1);
      lines.push(line);
    }
    const content = lines.join('\n') + '\n';
    writeFileSync(file, content);
    const windowStart = Buffer.byteLength(content) - 256 * 1024;
    expect(windowStart % LINE_BYTES).toBe(0);
    expect(content[windowStart - 1]).toBe('\n');

    const full = parseTranscriptJSONL(content);
    const tail = await readTranscriptTail(claudeTranscriptAdapter, file, TAIL);
    expect(tail.complete).toBe(false);
    expect(tail.blocks).toHaveLength(TAIL);
    expect(tail.blocks).toEqual(full.slice(-TAIL));
  });
});

describe('claude transcript adapter — locate (existing order)', () => {
  let home: string;
  const workingDir = '/tmp/example-project';
  const projectDir = () => join(home, '.claude', 'projects', '-tmp-example-project');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tv-claude-home-'));
    mkdirSync(projectDir(), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('prefers the watcher path when it exists', () => {
    const watched = join(home, 'elsewhere.jsonl');
    writeFileSync(watched, '');
    expect(claudeTranscriptAdapter.locate({ workingDir, sessionId: 's1', watcherPath: watched, homeDir: home })).toBe(
      watched
    );
  });

  it('uses <claudeResumeId>.jsonl', () => {
    const id = '00000000-0000-4000-8000-000000000003';
    const file = join(projectDir(), `${id}.jsonl`);
    writeFileSync(file, '');
    expect(claudeTranscriptAdapter.locate({ workingDir, sessionId: 's1', claudeResumeId: id, homeDir: home })).toBe(
      file
    );
  });

  it('falls back to <sessionId>.jsonl when no claudeResumeId was persisted', () => {
    const file = join(projectDir(), 'sess-abc.jsonl');
    writeFileSync(file, '');
    expect(claudeTranscriptAdapter.locate({ workingDir, sessionId: 'sess-abc', homeDir: home })).toBe(file);
  });

  it('returns null for a brand-new session with nothing on disk', () => {
    expect(claudeTranscriptAdapter.locate({ workingDir, sessionId: 'sess-new', homeDir: home })).toBeNull();
  });

  it('never joins a session id containing a path separator', () => {
    expect(claudeTranscriptAdapter.locate({ workingDir, sessionId: '../../etc/passwd', homeDir: home })).toBeNull();
  });
});

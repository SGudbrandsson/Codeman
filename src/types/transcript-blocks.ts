// src/types/transcript-blocks.ts
// @fileoverview Block types for the transcript web view.
// These are the harness-neutral wire-format types sent from the REST endpoint and SSE events.
// Per-harness adapters (src/harnesses/transcripts/) convert each harness's JSONL into them.

/**
 * Every block carries a `seq`: a stable, monotonic identity within one transcript file,
 * computed as `lineStartByteOffset * SEQ_BLOCKS_PER_LINE + blockIndexWithinLine`.
 *
 * Byte offsets (not line numbers) are used because neither the watcher (which seeks to EOF)
 * nor a bounded tail read (which starts mid-file) knows absolute line numbers, and REST and
 * SSE must agree on the value. The client dedups recovery blocks on `seq` rather than on
 * `timestamp`, which ties for sibling blocks from one record. Safe below 2^53 for any
 * realistic file size. Offsets restart after a truncation; the client clears on
 * `transcript:clear`, so that is fine.
 */
export const SEQ_BLOCKS_PER_LINE = 1000;

/** The `seq` base for a JSONL line that starts at `lineStartByteOffset`. */
export function seqBaseForOffset(lineStartByteOffset: number): number {
  return lineStartByteOffset * SEQ_BLOCKS_PER_LINE;
}

export interface TextBlock {
  type: 'text';
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  seq: number;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp: string;
  seq: number;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
  timestamp: string;
  seq: number;
}

export interface ResultBlock {
  type: 'result';
  cost?: number;
  durationMs?: number;
  error?: string;
  timestamp: string;
  seq: number;
}

/** Model reasoning in plaintext. Only pi emits it today (codex reasoning is encrypted). */
export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  timestamp: string;
  seq: number;
}

export type TranscriptBlock = TextBlock | ToolUseBlock | ToolResultBlock | ResultBlock | ThinkingBlock;

/** A block before its `seq` is stamped. Distributes over the union. */
export type UnsequencedBlock = TranscriptBlock extends infer T ? (T extends unknown ? Omit<T, 'seq'> : never) : never;

/** Stamp `seq = seqBase + index` onto blocks produced from one JSONL line. */
export function stampSeq(blocks: UnsequencedBlock[], seqBase: number): TranscriptBlock[] {
  return blocks.map((b, i) => ({ ...b, seq: seqBase + i }) as TranscriptBlock);
}

/** Raw JSONL entry from Claude Code's transcript file */
export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'system' | 'result';
  timestamp?: string;
  message?: {
    role: string;
    content: string | TranscriptContentBlock[];
  };
  total_cost_usd?: number;
  duration_ms?: number;
  error?: { type: string; message: string };
}

export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

/**
 * Parse a single Claude JSONL transcript entry into 0-N TranscriptBlocks.
 * @param seqBase - `seq` of the first block; see {@link seqBaseForOffset}. Defaults to 0.
 */
export function parseTranscriptEntry(entry: TranscriptEntry, seqBase = 0): TranscriptBlock[] {
  const ts = entry.timestamp ?? new Date().toISOString();
  const blocks: UnsequencedBlock[] = [];

  if (entry.type === 'user' && entry.message) {
    const c = entry.message.content;
    if (typeof c === 'string') {
      if (c.trim()) blocks.push({ type: 'text', role: 'user', text: c, timestamp: ts });
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text) {
          blocks.push({ type: 'text', role: 'user', text: b.text, timestamp: ts });
        } else if (b.type === 'tool_result') {
          const raw = b.content;
          const resultContent =
            typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((r) => r?.text ?? '').join('') : '';
          blocks.push({
            type: 'tool_result',
            toolUseId: b.tool_use_id ?? '',
            content: resultContent,
            isError: b.is_error ?? false,
            timestamp: ts,
          });
        }
      }
    }
  }

  if (entry.type === 'assistant' && entry.message) {
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text) {
        blocks.push({ type: 'text', role: 'assistant', text: b.text, timestamp: ts });
      } else if (b.type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          id: b.id ?? '',
          name: b.name ?? '',
          input: b.input ?? {},
          timestamp: ts,
        });
      }
    }
  }

  // 'system' entries (system prompts) are intentionally not rendered in the web view
  if (entry.type === 'result') {
    blocks.push({
      type: 'result',
      cost: entry.total_cost_usd,
      durationMs: entry.duration_ms,
      error: entry.error?.message,
      timestamp: ts,
    });
  }

  return stampSeq(blocks, seqBase);
}

/**
 * Parse a full Claude JSONL file string into a flat Block array.
 * `content` is assumed to start at byte 0 of the file, so each block's `seq` matches what
 * the watcher and the bounded tail read assign to the same line.
 */
export function parseTranscriptJSONL(content: string): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    const lineStart = offset;
    offset += Buffer.byteLength(line, 'utf-8') + 1;
    if (!line.trim()) continue;
    try {
      out.push(...parseTranscriptEntry(JSON.parse(line) as TranscriptEntry, seqBaseForOffset(lineStart)));
    } catch {
      // malformed line — skip
    }
  }
  return out;
}

// src/types/transcript-blocks.ts
// @fileoverview Block types for Claude Code transcript web view.
// These are the wire-format types sent from the REST endpoint and SSE events.

export interface TextBlock {
  type: 'text';
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
  timestamp: string;
}

export interface ResultBlock {
  type: 'result';
  cost?: number;
  durationMs?: number;
  error?: string;
  timestamp: string;
}

export type TranscriptBlock = TextBlock | ToolUseBlock | ToolResultBlock | ResultBlock;

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

/** Parse a single JSONL transcript entry into 0-N TranscriptBlocks */
export function parseTranscriptEntry(entry: TranscriptEntry): TranscriptBlock[] {
  const ts = entry.timestamp ?? new Date().toISOString();
  const blocks: TranscriptBlock[] = [];

  if (entry.type === 'user' && entry.message) {
    const c = entry.message.content;
    const text =
      typeof c === 'string'
        ? c
        : (c as TranscriptContentBlock[])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('');
    if (text.trim()) blocks.push({ type: 'text', role: 'user', text, timestamp: ts });
  }

  if (entry.type === 'assistant' && entry.message) {
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    for (const b of content) {
      if (b.type === 'text' && b.text) {
        blocks.push({ type: 'text', role: 'assistant', text: b.text, timestamp: ts });
      } else if (b.type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          id: b.id ?? '',
          name: b.name ?? '',
          input: (b.input as Record<string, unknown>) ?? {},
          timestamp: ts,
        });
      } else if (b.type === 'tool_result') {
        const raw = b.content;
        const resultContent =
          typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? (raw as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('')
              : '';
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

  if (entry.type === 'result') {
    blocks.push({
      type: 'result',
      cost: entry.total_cost_usd,
      durationMs: entry.duration_ms,
      error: entry.error?.message,
      timestamp: ts,
    });
  }

  return blocks;
}

/** Parse a full JSONL file string into a flat Block array */
export function parseTranscriptJSONL(content: string): TranscriptBlock[] {
  return content
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((line) => {
      try {
        return parseTranscriptEntry(JSON.parse(line) as TranscriptEntry);
      } catch {
        return [];
      }
    });
}

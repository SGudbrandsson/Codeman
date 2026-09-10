/**
 * @fileoverview Transcript adapter registry and bounded file readers.
 *
 * @module harnesses/transcripts
 */

import { open } from 'node:fs/promises';
import type { SessionMode } from '../../types/session.js';
import { seqBaseForOffset, type TranscriptBlock } from '../../types/transcript-blocks.js';
import { claudeTranscriptAdapter } from './claude.js';
import { codexTranscriptAdapter } from './codex.js';
import { piTranscriptAdapter } from './pi.js';
import type { TranscriptAdapter } from './types.js';

export type { TranscriptAdapter, TranscriptLocateCtx } from './types.js';
export { claudeTranscriptAdapter, codexTranscriptAdapter, piTranscriptAdapter };

/**
 * The adapter for a harness, or null when the harness has no viewable transcript
 * (opencode, shell) or the mode is unknown. A missing mode means a legacy Claude session.
 */
export function getTranscriptAdapter(mode: SessionMode | undefined | null): TranscriptAdapter | null {
  switch (mode ?? 'claude') {
    case 'claude':
      return claudeTranscriptAdapter;
    case 'codex':
      return codexTranscriptAdapter;
    case 'pi':
      return piTranscriptAdapter;
    default:
      return null;
  }
}

/**
 * Parse a byte range of JSONL into blocks. `baseOffset` is the file offset of `buf[0]`,
 * so every block's `seq` is identical to what the watcher assigns the same line.
 *
 * @param skipPartialFirstLine - drop bytes before the first newline (a mid-file window).
 */
export function parseJsonlBuffer(
  adapter: TranscriptAdapter,
  buf: Buffer,
  baseOffset: number,
  skipPartialFirstLine = false
): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  let pos = 0;
  if (skipPartialFirstLine) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return out;
    pos = nl + 1;
  }
  while (pos < buf.length) {
    let nl = buf.indexOf(0x0a, pos);
    if (nl === -1) nl = buf.length;
    if (nl > pos) {
      const line = buf.toString('utf-8', pos, nl);
      if (line.trim()) out.push(...adapter.parseLine(line, seqBaseForOffset(baseOffset + pos)));
    }
    pos = nl + 1;
  }
  return out;
}

/** Read and parse a whole transcript file. */
export async function readTranscriptFile(adapter: TranscriptAdapter, path: string): Promise<TranscriptBlock[]> {
  const fh = await open(path, 'r');
  try {
    const buf = await fh.readFile();
    return parseJsonlBuffer(adapter, buf, 0);
  } finally {
    await fh.close();
  }
}

/** Initial byte window for a tail read, and the floor below which we never go. */
const TAIL_BYTES_PER_BLOCK = 4096;
const TAIL_MIN_BYTES = 256 * 1024;

export interface TranscriptTail {
  blocks: TranscriptBlock[];
  /** True when the window reached byte 0, so `blocks` is the complete transcript. */
  complete: boolean;
  /**
   * Total block count: exact when `complete`; otherwise extrapolated from the window's
   * block density and always greater than `blocks.length`.
   */
  estimatedTotal: number;
}

/**
 * Read the last `tail` blocks without reading the whole file.
 *
 * Reads a window from the end, sized from the requested block count, discarding the first
 * partial line; doubles the window until it holds at least `tail` blocks or reaches the
 * start of the file. Codex rollouts and pi sessions embed base64 payloads, so this is what
 * bounds server memory and CPU — dropping base64 in the adapter only protects the client.
 */
export async function readTranscriptTail(
  adapter: TranscriptAdapter,
  path: string,
  tail: number
): Promise<TranscriptTail> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    let window = Math.max(TAIL_MIN_BYTES, tail * TAIL_BYTES_PER_BLOCK);
    for (;;) {
      const start = Math.max(0, size - window);
      const length = size - start;
      const buf = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await fh.read(buf, read, length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const blocks = parseJsonlBuffer(adapter, buf.subarray(0, read), start, start > 0);
      if (start === 0) return { blocks, complete: true, estimatedTotal: blocks.length };
      if (blocks.length >= tail) {
        const density = blocks.length / Math.max(1, read);
        const estimatedTotal = Math.max(tail + 1, Math.ceil(density * size));
        return { blocks: blocks.slice(blocks.length - tail), complete: false, estimatedTotal };
      }
      window *= 2;
    }
  } finally {
    await fh.close();
  }
}

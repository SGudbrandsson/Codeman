/**
 * @fileoverview Per-harness transcript adapter contract.
 *
 * The transcript web view consumes harness-neutral `TranscriptBlock[]`. Each harness that
 * has a viewable transcript (`caps.transcript`) provides a locator (where is the file) and
 * a record parser (one JSONL record → blocks). See
 * docs/superpowers/specs/2026-09-10-multi-harness-transcripts-design.md.
 *
 * @module harnesses/transcripts/types
 */

import type { SessionMode } from '../../types/session.js';
import type { TranscriptBlock } from '../../types/transcript-blocks.js';

export interface TranscriptLocateCtx {
  /** The session's working directory. */
  workingDir: string;
  /** Codeman's own session id. */
  sessionId: string;
  /** Harness-native session id (codex rollout uuid, pi --session-id). */
  harnessSessionId?: string;
  /** Claude only: the current conversation uuid (session.claudeResumeId). */
  claudeResumeId?: string;
  /** Path the session's live watcher already tracks, if any (fast path). */
  watcherPath?: string | null;
  /** Override the home directory (tests). */
  homeDir?: string;
}

export interface TranscriptAdapter {
  readonly mode: SessionMode;
  /** Absolute path to this session's transcript file, or null if not (yet) written. */
  locate(ctx: TranscriptLocateCtx): string | null;
  /**
   * Convert one already-JSON-parsed record into zero or more blocks. Receives the raw
   * record — never a Claude-typed entry — so non-Claude envelopes survive intact.
   * MUST NOT throw: unknown or malformed records yield [].
   */
  parseRecord(record: unknown, seqBase: number): TranscriptBlock[];
  /** Convert one raw JSONL line into zero or more blocks. MUST NOT throw. */
  parseLine(raw: string, seqBase: number): TranscriptBlock[];
}

/** Build an adapter whose parse functions can never throw. */
export function defineTranscriptAdapter(def: {
  mode: SessionMode;
  locate(ctx: TranscriptLocateCtx): string | null;
  parseRecord(record: unknown, seqBase: number): TranscriptBlock[];
}): TranscriptAdapter {
  const parseRecord = (record: unknown, seqBase: number): TranscriptBlock[] => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
    try {
      return def.parseRecord(record, seqBase);
    } catch {
      return [];
    }
  };
  return {
    mode: def.mode,
    locate(ctx) {
      try {
        return def.locate(ctx);
      } catch {
        return null;
      }
    },
    parseRecord,
    parseLine(raw, seqBase) {
      if (typeof raw !== 'string' || !raw.trim()) return [];
      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        return [];
      }
      return parseRecord(record, seqBase);
    },
  };
}

/** Return `value` if it is a non-empty string, else undefined. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Narrow to a plain object. */
export function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

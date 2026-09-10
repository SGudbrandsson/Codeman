/**
 * @fileoverview Claude transcript adapter. A thin wrapper over the existing Claude parser
 * and path resolver — no behaviour change for Claude sessions.
 *
 * @module harnesses/transcripts/claude
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTranscriptEntry, type TranscriptEntry } from '../../types/transcript-blocks.js';
import { resolveTranscriptPath } from '../../web/transcript-path-resolver.js';
import { defineTranscriptAdapter } from './types.js';

/** Codeman session ids are UUIDs; anything with a path separator must never reach join(). */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

export const claudeTranscriptAdapter = defineTranscriptAdapter({
  mode: 'claude',
  /**
   * Today's exact lookup order:
   *  1-3. resolveTranscriptPath — the watcher's tracked path, then `<claudeResumeId>.jsonl`
   *       under each project-dir encoding (formerly WebServer.getTranscriptPath()).
   *  4.   `<sessionId>.jsonl` under the slash-only encoding, for a session whose
   *       claudeResumeId was never persisted (formerly inline in GET /transcript).
   *
   * The watcher path is deliberately NOT root-contained: it arrives from Claude's own
   * hooks and a user may run Claude with a non-default config dir. That exposure is
   * pre-existing (hook-event-routes.ts) and out of scope.
   */
  locate(ctx) {
    const home = ctx.homeDir ?? homedir();
    const resolved = resolveTranscriptPath(
      ctx.workingDir,
      ctx.watcherPath ? { transcriptPath: ctx.watcherPath } : undefined,
      ctx.claudeResumeId,
      home
    );
    if (resolved) return resolved;
    if (!SESSION_ID_PATTERN.test(ctx.sessionId)) return null;
    const escapedDir = ctx.workingDir.replace(/\//g, '-');
    const candidate = join(home, '.claude', 'projects', escapedDir, `${ctx.sessionId}.jsonl`);
    return existsSync(candidate) ? candidate : null;
  },
  parseRecord(record, seqBase) {
    return parseTranscriptEntry(record as TranscriptEntry, seqBase);
  },
});

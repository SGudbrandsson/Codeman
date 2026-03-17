/**
 * @fileoverview Pure helper for resolving a session's transcript JSONL path.
 *
 * Extracted from WebServer.getTranscriptPath() so the logic can be unit-tested
 * independently of the WebServer class construction overhead.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TranscriptWatcher } from '../transcript-watcher.js';

/**
 * Resolve the transcript JSONL path for a session.
 *
 * Resolution order:
 *  1. Fast path — watcher already tracks the correct file; return it if still on disk.
 *  2. null — claudeResumeId is not set → session has never run Claude → show empty state.
 *  3. Direct lookup — claudeResumeId is authoritative (set by startTranscriptWatcher when
 *     the session's own Claude process emitted its conversationId). Return
 *     `<projectDir>/<claudeResumeId>.jsonl` if it exists on disk, otherwise null.
 *
 *     NOTE: We intentionally do NOT scan the project directory for newer files. Two sessions
 *     that share the same workingDir (the common case in Codeman) share the same projectDir.
 *     Scanning for the "newest" JSONL would always return the most recently active session's
 *     file, cross-contaminating the other session's transcript. claudeResumeId is the
 *     per-session authoritative identifier — trust it exclusively.
 *
 *     A /clear mid-run causes the watcher to receive the new conversationId via the PTY
 *     event and update its tracked path (step 1). By the time the UI fetches, step 1 returns
 *     the new file, so step 3 is never reached in that case.
 *
 * @param workingDir      - Session working directory
 * @param watcher         - TranscriptWatcher for this session, or undefined if none
 * @param claudeResumeId  - session.claudeResumeId (current conversation UUID, persisted)
 * @param _homeDir        - Override home directory (injectable for testing)
 * @returns Absolute path to the JSONL file, or null if not found
 */
export function resolveTranscriptPath(
  workingDir: string,
  watcher: TranscriptWatcher | undefined,
  claudeResumeId: string | undefined,
  _homeDir: string = homedir()
): string | null {
  // 1. Fast path: watcher already tracks the correct file — use it directly
  const watcherPath = watcher?.transcriptPath;
  if (watcherPath) {
    try {
      statSync(watcherPath);
      return watcherPath;
    } catch {
      /* file gone — fall through */
    }
  }

  // Brand-new session: claudeResumeId not yet set means Claude has never run for this
  // session, so there is no transcript file. Return null → UI shows empty-state placeholder.
  // Without this guard, sessions in project dirs with old JSONL files from prior Claude
  // conversations would incorrectly display stale history.
  if (!claudeResumeId) return null;

  const escapedDir = workingDir.replace(/\//g, '-');
  const projectDir = join(_homeDir, '.claude', 'projects', escapedDir);

  // 3. Direct lookup: claudeResumeId is the authoritative identifier for this session's
  //    conversation. Return the corresponding JSONL file if it exists on disk.
  //    Do NOT scan for newer files — that would cross-contaminate sessions sharing the
  //    same projectDir (same workingDir).
  const resumeFile = join(projectDir, `${claudeResumeId}.jsonl`);
  try {
    statSync(resumeFile);
    return resumeFile;
  } catch {
    /* file not on disk yet */
    return null;
  }
}

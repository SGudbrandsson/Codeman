/**
 * @fileoverview Pure helper for resolving a session's transcript JSONL path.
 *
 * Extracted from WebServer.getTranscriptPath() so the logic can be unit-tested
 * independently of the WebServer class construction overhead.
 */

import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TranscriptWatcher } from '../transcript-watcher.js';

/**
 * Resolve the transcript JSONL path for a session.
 *
 * Resolution order:
 *  1. Fast path — watcher already tracks the correct file; return it if still on disk.
 *  2. Resume path — claudeResumeId is persisted to state.json and always updated to the
 *     current conversation (startTranscriptWatcher updates it on every hook fire).
 *     Check `<projectDir>/<claudeResumeId>.jsonl` directly — no guessing, no scanning.
 *     This handles: server restart, post-/clear, and multiple sessions sharing a workingDir
 *     (each session has its own claudeResumeId pointing to its own JSONL).
 *  3. Scan path — claudeResumeId is set but its file is gone (edge case: /clear race where
 *     hook hasn't fired yet to update claudeResumeId). Find the newest JSONL in project dir.
 *  4. null — claudeResumeId is not set → session has never run Claude → show empty state.
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

  // 2. Resume path: claudeResumeId is always updated to the current conversation UUID
  //    (startTranscriptWatcher removes the old !session.claudeResumeId guard).
  //    This is the most precise match — no scanning, no cross-session contamination.
  const resumeFile = join(projectDir, `${claudeResumeId}.jsonl`);
  try {
    statSync(resumeFile);
    return resumeFile;
  } catch {
    /* file gone — fall through to scan */
  }

  // 3. Scan path: claudeResumeId file is missing. This can happen when /clear creates a
  //    new conversation file before the hook fires to update claudeResumeId. Scan for the
  //    newest JSONL in the project dir as a fallback.
  try {
    const files = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    if (files.length > 0) {
      let newest = files[0];
      let newestMtime = 0;
      for (const f of files) {
        try {
          const mtime = statSync(join(projectDir, f)).mtimeMs;
          if (mtime > newestMtime) {
            newestMtime = mtime;
            newest = f;
          }
        } catch {
          /* skip */
        }
      }
      return join(projectDir, newest);
    }
  } catch {
    /* dir doesn't exist yet */
  }

  return null;
}

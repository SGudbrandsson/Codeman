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
 *  2. null — claudeResumeId is not set → session has never run Claude → show empty state.
 *  3. Freshness scan — claudeResumeId is set, so Claude has run. Seed the search with
 *     `<projectDir>/<claudeResumeId>.jsonl` and scan for any NEWER JSONL in the same dir.
 *     Return the newest of the two. This handles:
 *       - Server restart (claudeResumeId still correct) → resumeFile is newest → correct
 *       - Stale claudeResumeId (hooks missed while Codeman was down, or /clear race) →
 *         a newer JSONL exists → return that one → fixes transcript/terminal mismatch
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

  // 3. Freshness scan: start with claudeResumeId as the known candidate, then scan the
  //    project dir for any NEWER JSONL. This handles stale claudeResumeId — e.g. when
  //    hooks didn't reach Codeman (server down, direct claude CLI usage) so the persisted
  //    UUID still points to an old conversation while Claude is writing to a newer file.
  //    claudeResumeId being set (checked above) confirms Claude has run for this session,
  //    so scanning for a newer file is safe and cannot show unrelated history.
  const resumeFile = join(projectDir, `${claudeResumeId}.jsonl`);
  let bestFile: string | null = null;
  let bestMtime = 0;

  // Seed with claudeResumeId file if it exists on disk
  try {
    const mtime = statSync(resumeFile).mtimeMs;
    bestFile = resumeFile;
    bestMtime = mtime;
  } catch {
    /* file gone — will rely on scan below */
  }

  // Scan for any newer JSONL in the project dir
  try {
    const files = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    for (const f of files) {
      try {
        const mtime = statSync(join(projectDir, f)).mtimeMs;
        if (mtime > bestMtime) {
          bestMtime = mtime;
          bestFile = join(projectDir, f);
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* dir doesn't exist yet */
  }

  return bestFile;
}

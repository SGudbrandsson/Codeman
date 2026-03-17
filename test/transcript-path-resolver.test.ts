/**
 * Unit tests for resolveTranscriptPath().
 *
 * Scenarios covered:
 *  1. Fast path — watcher has a valid file
 *  2. Watcher path gone — falls through to direct lookup
 *  3. New session — no claudeResumeId, return null
 *  4. Direct lookup — claudeResumeId file exists → return it (even if other newer files exist)
 *  5. Direct lookup — claudeResumeId file does not exist → return null (no directory scan)
 *
 * The filesystem is isolated to a temp directory so tests never touch real ~/.claude data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveTranscriptPath } from '../src/web/transcript-path-resolver.js';
import type { TranscriptWatcher } from '../src/transcript-watcher.js';

function makeWatcher(transcriptPath: string | null): TranscriptWatcher {
  return { transcriptPath } as unknown as TranscriptWatcher;
}

describe('resolveTranscriptPath', () => {
  const SESSION_A = 'aaaaaaaa-0000-0000-0000-000000000000';
  const SESSION_B = 'bbbbbbbb-0000-0000-0000-000000000000';
  let tmpHome: string;
  let workingDir: string;
  let projectDir: string;

  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeman-transcript-test-'));
    workingDir = '/home/user/my-project';
    projectDir = path.join(tmpHome, '.claude', 'projects', workingDir.replace(/\//g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── Fast path ─────────────────────────────────────────────────────────────

  it('returns the watcher path when the file exists', () => {
    const f = path.join(projectDir, 'current.jsonl');
    fs.writeFileSync(f, '');
    expect(resolveTranscriptPath(workingDir, makeWatcher(f), SESSION_A, tmpHome)).toBe(f);
    fs.unlinkSync(f);
  });

  it('falls through when watcher file no longer exists', () => {
    const gone = path.join(projectDir, 'gone.jsonl');
    const own = path.join(projectDir, `${SESSION_A}.jsonl`);
    fs.writeFileSync(own, '');
    expect(resolveTranscriptPath(workingDir, makeWatcher(gone), SESSION_A, tmpHome)).toBe(own);
    fs.unlinkSync(own);
  });

  // ── New session ───────────────────────────────────────────────────────────

  it('returns null for a brand-new session even when old JSONL files exist', () => {
    const old = path.join(projectDir, 'old-unrelated.jsonl');
    fs.writeFileSync(old, '');
    expect(resolveTranscriptPath(workingDir, undefined, undefined, tmpHome)).toBeNull();
    fs.unlinkSync(old);
  });

  // ── Direct lookup: claudeResumeId is authoritative ────────────────────────

  it("returns the session's own JSONL when it exists on disk", () => {
    const own = path.join(projectDir, `${SESSION_A}.jsonl`);
    fs.writeFileSync(own, '');
    expect(resolveTranscriptPath(workingDir, undefined, SESSION_A, tmpHome)).toBe(own);
    fs.unlinkSync(own);
  });

  it('does NOT return a newer JSONL belonging to a different session — own file is canonical', async () => {
    // SESSION_A's own file exists. SESSION_B's file is written later (newer mtime).
    // The resolver must return SESSION_A's file, not the newer SESSION_B file.
    const sessionAFile = path.join(projectDir, `${SESSION_A}.jsonl`);
    fs.writeFileSync(sessionAFile, '');
    await new Promise((r) => setTimeout(r, 20));
    const sessionBFile = path.join(projectDir, `${SESSION_B}.jsonl`);
    fs.writeFileSync(sessionBFile, ''); // newer — but belongs to different session
    expect(resolveTranscriptPath(workingDir, undefined, SESSION_A, tmpHome)).toBe(sessionAFile);
    fs.unlinkSync(sessionAFile);
    fs.unlinkSync(sessionBFile);
  });

  it('returns null when claudeResumeId is set but own file is not on disk', () => {
    // No file for SESSION_A exists. Should return null — no directory scan fallback.
    // (The /clear case is handled by the watcher fast-path before this point.)
    expect(resolveTranscriptPath(workingDir, undefined, SESSION_A, tmpHome)).toBeNull();
  });

  it('returns null when claudeResumeId set but project dir is empty', () => {
    expect(resolveTranscriptPath(workingDir, undefined, SESSION_A, tmpHome)).toBeNull();
  });

  // ── Session isolation: two sessions sharing same workingDir ───────────────

  it('returns different paths for two sessions with different claudeResumeIds in the same projectDir', () => {
    const fileA = path.join(projectDir, `${SESSION_A}.jsonl`);
    const fileB = path.join(projectDir, `${SESSION_B}.jsonl`);
    fs.writeFileSync(fileA, '{"session":"A"}');
    fs.writeFileSync(fileB, '{"session":"B"}');

    const resolvedA = resolveTranscriptPath(workingDir, undefined, SESSION_A, tmpHome);
    const resolvedB = resolveTranscriptPath(workingDir, undefined, SESSION_B, tmpHome);

    expect(resolvedA).toBe(fileA);
    expect(resolvedB).toBe(fileB);
    expect(resolvedA).not.toBe(resolvedB);

    fs.unlinkSync(fileA);
    fs.unlinkSync(fileB);
  });
});

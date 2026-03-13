/**
 * Unit tests for resolveTranscriptPath().
 *
 * Scenarios covered:
 *  1. Fast path — watcher has a valid file
 *  2. Stale claudeResumeId — newer JSONL exists (main bug fix: transcript/terminal mismatch)
 *  3. Scan path — claudeResumeId file gone (post-/clear race)
 *  4. New session — no claudeResumeId, return null
 *  5. Server restart — claudeResumeId file is still the newest → return it
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

  // ── Server restart: own file is newest ────────────────────────────────────

  it("returns the session's own JSONL after server restart when it is the newest", async () => {
    const unrelated = path.join(projectDir, 'other.jsonl');
    fs.writeFileSync(unrelated, '');
    await new Promise((r) => setTimeout(r, 10));
    const own = path.join(projectDir, `${SESSION_A}.jsonl`);
    fs.writeFileSync(own, ''); // own is newer → wins
    expect(resolveTranscriptPath(workingDir, undefined, SESSION_A, tmpHome)).toBe(own);
    fs.unlinkSync(own);
    fs.unlinkSync(unrelated);
  });

  // ── Stale claudeResumeId: newer JSONL exists (the main bug fix) ───────────

  it('returns the newer JSONL when claudeResumeId points to a stale file', async () => {
    // Simulates: Codeman was down while Claude ran /clear → newer JSONL not tracked
    const staleFile = path.join(projectDir, `${SESSION_A}.jsonl`);
    fs.writeFileSync(staleFile, '');
    await new Promise((r) => setTimeout(r, 10));
    const currentFile = path.join(projectDir, 'new-uuid-after-clear.jsonl');
    fs.writeFileSync(currentFile, ''); // newer — what Claude is actually writing to
    expect(resolveTranscriptPath(workingDir, undefined, SESSION_A, tmpHome)).toBe(currentFile);
    fs.unlinkSync(staleFile);
    fs.unlinkSync(currentFile);
  });

  // ── Scan path: own file gone (post-/clear race) ───────────────────────────

  it('scans for newest JSONL when own file is gone (post-/clear race)', () => {
    // Own file doesn't exist; a post-clear file is the newest
    const postClear = path.join(projectDir, 'new-uuid-after-clear.jsonl');
    fs.writeFileSync(postClear, '');
    expect(resolveTranscriptPath(workingDir, undefined, SESSION_A, tmpHome)).toBe(postClear);
    fs.unlinkSync(postClear);
  });

  it('returns null when claudeResumeId set but project dir is empty', () => {
    expect(resolveTranscriptPath(workingDir, undefined, SESSION_A, tmpHome)).toBeNull();
  });

  // ── Scan picks newest when multiple files and no own file ─────────────────

  it('returns the most recently modified JSONL during a scan', async () => {
    const older = path.join(projectDir, 'older.jsonl');
    const newer = path.join(projectDir, 'newer.jsonl');
    fs.writeFileSync(older, '');
    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(newer, '');
    expect(resolveTranscriptPath(workingDir, undefined, SESSION_A, tmpHome)).toBe(newer);
    fs.unlinkSync(older);
    fs.unlinkSync(newer);
  });
});

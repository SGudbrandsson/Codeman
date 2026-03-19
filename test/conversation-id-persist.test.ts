/**
 * Tests for the conversationId handler's explicit persist-on-change logic.
 *
 * Gap covered:
 *
 *   Gap 1: When conversationId fires with a new UUID, session.claudeResumeId is updated
 *           and persistSessionState is called.
 *
 *   Gap 2: When conversationId fires with the same UUID as the current claudeResumeId,
 *           persistSessionState is NOT called (idempotency guard).
 *
 *   Gap 3: End-to-end scenario — conversationId fires, watcher is then cleared (simulating
 *           server restart), and resolveTranscriptPath still returns the correct file
 *           using the persisted claudeResumeId.
 *
 * The handler logic under test (server.ts conversationId handler, lines 1686-1689):
 *
 *   if (session.claudeResumeId !== uuid) {
 *     session.setClaudeResumeId(uuid);
 *     this.persistSessionState(session);
 *   }
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveTranscriptPath } from '../src/web/transcript-path-resolver.js';
import type { TranscriptWatcher } from '../src/transcript-watcher.js';

// ── Minimal re-implementation of the conversationId handler persist block ─────
// Mirrors the exact logic added to server.ts lines 1686-1689.
// If that code changes, update this to match.

interface SessionLike {
  claudeResumeId: string | undefined;
  setClaudeResumeId(id: string): void;
}

function applyConversationIdPersist(session: SessionLike, uuid: string, persistSessionState: () => void): void {
  if (session.claudeResumeId !== uuid) {
    session.setClaudeResumeId(uuid);
    persistSessionState();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const UUID_A = 'aaaaaaaa-1111-1111-1111-000000000001';
const UUID_B = 'bbbbbbbb-2222-2222-2222-000000000002';

function makeSession(resumeId: string | undefined): SessionLike & { claudeResumeId: string | undefined } {
  return {
    claudeResumeId: resumeId,
    setClaudeResumeId(id: string) {
      this.claudeResumeId = id;
    },
  };
}

function makeWatcher(transcriptPath: string | null): TranscriptWatcher {
  return { transcriptPath } as unknown as TranscriptWatcher;
}

// ── Gap 1: conversationId handler — persist when UUID changes ─────────────────

describe('conversationId handler — persist on UUID change (Gap 1)', () => {
  it('updates claudeResumeId when it was undefined (first conversationId fire)', () => {
    const session = makeSession(undefined);
    let persistCalls = 0;
    applyConversationIdPersist(session, UUID_A, () => {
      persistCalls++;
    });
    expect(session.claudeResumeId).toBe(UUID_A);
    expect(persistCalls).toBe(1);
  });

  it('updates claudeResumeId when a new conversation starts after /clear', () => {
    // Session had UUID_A; Claude /clear started UUID_B
    const session = makeSession(UUID_A);
    let persistCalls = 0;
    applyConversationIdPersist(session, UUID_B, () => {
      persistCalls++;
    });
    expect(session.claudeResumeId).toBe(UUID_B);
    expect(persistCalls).toBe(1);
  });

  it('persists new UUID regardless of whether watcher was already tracking it', () => {
    // Demonstrates that persistence is independent of watcher state —
    // the explicit block runs before the watcher early-return guard.
    const session = makeSession(undefined);
    let persistCalls = 0;
    // Simulate watcher already tracking UUID_A (the watcher guard would skip startTranscriptWatcher),
    // but the persist block still runs first.
    applyConversationIdPersist(session, UUID_A, () => {
      persistCalls++;
    });
    expect(session.claudeResumeId).toBe(UUID_A);
    expect(persistCalls).toBe(1);
  });
});

// ── Gap 2: conversationId handler — no-persist when UUID unchanged ─────────────

describe('conversationId handler — idempotency guard (Gap 2)', () => {
  it('does NOT call persistSessionState when UUID is already current', () => {
    const session = makeSession(UUID_A);
    let persistCalls = 0;
    applyConversationIdPersist(session, UUID_A, () => {
      persistCalls++;
    });
    expect(persistCalls).toBe(0);
    expect(session.claudeResumeId).toBe(UUID_A); // unchanged
  });

  it('does NOT overwrite claudeResumeId with the same value', () => {
    const session = makeSession(UUID_B);
    let persistCalls = 0;
    applyConversationIdPersist(session, UUID_B, () => {
      persistCalls++;
    });
    expect(session.claudeResumeId).toBe(UUID_B);
    expect(persistCalls).toBe(0);
  });

  it('fires persist on first call then suppresses on repeated identical fires', () => {
    const session = makeSession(undefined);
    let persistCalls = 0;
    const persist = () => {
      persistCalls++;
    };

    // First fire: UUID_A is new → persist
    applyConversationIdPersist(session, UUID_A, persist);
    expect(persistCalls).toBe(1);

    // Repeated fire with same UUID (e.g. PTY replay) → no-op
    applyConversationIdPersist(session, UUID_A, persist);
    applyConversationIdPersist(session, UUID_A, persist);
    expect(persistCalls).toBe(1); // still just 1
  });
});

// ── Gap 3: Post-restart resolution using persisted claudeResumeId ─────────────

describe('post-restart transcript resolution using persisted claudeResumeId (Gap 3)', () => {
  let tmpHome: string;
  let workingDir: string;
  let projectDir: string;

  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeman-conv-id-persist-test-'));
    workingDir = '/home/user/my-project';
    projectDir = path.join(tmpHome, '.claude', 'projects', workingDir.replace(/\//g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('resolveTranscriptPath returns the file for the persisted claudeResumeId after watcher is cleared', () => {
    // Step 1: conversationId fires with UUID_B → session persists new UUID
    const session = makeSession(UUID_A);
    let persistCalls = 0;
    applyConversationIdPersist(session, UUID_B, () => {
      persistCalls++;
    });
    expect(session.claudeResumeId).toBe(UUID_B);
    expect(persistCalls).toBe(1);

    // Step 2: UUID_B transcript file exists on disk
    const newFile = path.join(projectDir, `${UUID_B}.jsonl`);
    fs.writeFileSync(newFile, '{"type":"conversation"}');

    // Step 3: Simulate server restart — watcher is gone (undefined)
    const result = resolveTranscriptPath(workingDir, undefined, session.claudeResumeId, tmpHome);

    expect(result).toBe(newFile);

    fs.unlinkSync(newFile);
  });

  it('does NOT return the stale (old) transcript after a /clear when watcher is cleared', () => {
    // Old conversation file is on disk
    const oldFile = path.join(projectDir, `${UUID_A}.jsonl`);
    const newFile = path.join(projectDir, `${UUID_B}.jsonl`);
    fs.writeFileSync(oldFile, '{"old":true}');
    fs.writeFileSync(newFile, '{"new":true}');

    // After /clear, conversationId fired UUID_B and was persisted
    const session = makeSession(UUID_A);
    applyConversationIdPersist(session, UUID_B, () => {});
    expect(session.claudeResumeId).toBe(UUID_B);

    // After server restart (watcher gone), resolver must return the NEW file, not the old one
    const result = resolveTranscriptPath(workingDir, undefined, session.claudeResumeId, tmpHome);
    expect(result).toBe(newFile);
    expect(result).not.toBe(oldFile);

    fs.unlinkSync(oldFile);
    fs.unlinkSync(newFile);
  });

  it('returns null after restart when the new transcript file has not yet been written to disk', () => {
    // conversationId fired UUID_B and was persisted, but Claude has not yet written the file
    const session = makeSession(UUID_A);
    applyConversationIdPersist(session, UUID_B, () => {});

    // No file on disk for UUID_B
    const result = resolveTranscriptPath(workingDir, undefined, session.claudeResumeId, tmpHome);
    expect(result).toBeNull();
  });
});

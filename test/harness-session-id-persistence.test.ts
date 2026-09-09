/**
 * @fileoverview Regression test for smoke-test Defect 4 — a harness session id that is
 * learned after spawn (codex discovery) or at spawn (`caps.preassignsSessionId`, pi) must
 * reach `state.json` immediately, not only at the next graceful shutdown.
 *
 * The original bug was invisible to in-memory assertions: the id WAS on the Session
 * object, the server listener simply never persisted it. So every assertion here reads
 * the state file back off disk.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStore } from '../src/state-store.js';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import type { StateStore } from '../src/state-store.js';

let dir: string;
let statePath: string;
let store: StateStore;
let server: WebServer;

/** Reads harnessSessionId for a session straight out of the state file on disk. */
function harnessSessionIdOnDisk(sessionId: string): string | null | undefined {
  if (!existsSync(statePath)) return undefined;
  const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as {
    sessions?: Record<string, { harnessSessionId?: string }>;
  };
  return raw.sessions?.[sessionId]?.harnessSessionId;
}

const flush = async (ms = 400): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'codeman-hsid-'));
  statePath = join(dir, 'state.json');
  // Bind the state-store singleton to a temp file BEFORE anything constructs the server,
  // so this test never touches the user's real ~/.codeman/state.json.
  store = getStore(statePath);
  expect(store.getState().config.stateFilePath).toBe(statePath);
  server = new WebServer(0, false, true);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('harnessSessionIdDiscovered reaches state.json', () => {
  it('persists a discovered id (codex path) without waiting for shutdown', async () => {
    const session = new Session({ id: 'sess-codex-1', workingDir: dir, mode: 'codex', useMux: false });
    // Mirror the spawn-time write: the session is on disk with no harness id yet.
    (server as unknown as { sessions: Map<string, Session> }).sessions.set(session.id, session);
    await (server as unknown as { setupSessionListeners(s: Session): Promise<void> }).setupSessionListeners(session);
    store.setSession(session.id, session.toState());
    store.saveNow();
    expect(harnessSessionIdOnDisk(session.id)).toBeUndefined();

    // What the codex rollout-file discovery does when it finds an id.
    session.recordHarnessSessionId('01a0863d-5708-77e2-9048-e69ac9faa27d');

    await flush();
    store.saveNow();
    expect(harnessSessionIdOnDisk(session.id)).toBe('01a0863d-5708-77e2-9048-e69ac9faa27d');
  });

  it('persists a preassigned id (pi path) without waiting for shutdown', async () => {
    const session = new Session({ id: 'sess-pi-1', workingDir: dir, mode: 'pi', useMux: false });
    (server as unknown as { sessions: Map<string, Session> }).sessions.set(session.id, session);
    await (server as unknown as { setupSessionListeners(s: Session): Promise<void> }).setupSessionListeners(session);
    store.setSession(session.id, session.toState());
    store.saveNow();
    expect(harnessSessionIdOnDisk(session.id)).toBeUndefined();

    // What startInteractive() does for a harness that is handed its own id.
    session.recordHarnessSessionId(session.id);

    await flush();
    store.saveNow();
    expect(harnessSessionIdOnDisk(session.id)).toBe('sess-pi-1');
  });

  it('does not re-emit (and so does not re-persist) when the same id is recorded again', async () => {
    const session = new Session({ id: 'sess-codex-2', workingDir: dir, mode: 'codex', useMux: false });
    let emits = 0;
    session.on('harnessSessionIdDiscovered', () => {
      emits++;
    });
    (server as unknown as { sessions: Map<string, Session> }).sessions.set(session.id, session);
    await (server as unknown as { setupSessionListeners(s: Session): Promise<void> }).setupSessionListeners(session);

    session.recordHarnessSessionId('dup-id');
    session.recordHarnessSessionId('dup-id');
    session.recordHarnessSessionId('dup-id');
    expect(emits).toBe(1);

    await flush();
    store.saveNow();
    expect(harnessSessionIdOnDisk(session.id)).toBe('dup-id');
  });
});

// ---------------------------------------------------------------------------
// The `conversationId` PTY listener's harness gate.
//
// `conversationId` is emitted from Session.processOutput(), which parses JSON lines for
// EVERY mode — it is not behind caps.claudeParsers. Without the gate in the listener, any
// codex/pi session that happens to print a JSON object carrying a `session_id` writes
// claudeResumeId, and setClaudeResumeId() mirrors that straight into harnessSessionId — so
// the next restore would spawn `codex resume <claude-uuid>`.
//
// These tests attach the REAL WebServer.setupSessionListeners() and emit on a real Session,
// so deleting the gate must fail them.
// ---------------------------------------------------------------------------

/** Reads claudeResumeId for a session straight out of the state file on disk. */
function claudeResumeIdOnDisk(sessionId: string): string | null | undefined {
  if (!existsSync(statePath)) return undefined;
  const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as {
    sessions?: Record<string, { claudeResumeId?: string | null }>;
  };
  return raw.sessions?.[sessionId]?.claudeResumeId;
}

describe('conversationId listener is gated on the Claude-transcript capability', () => {
  const CLAUDE_UUID = '7f3c1c58-9c4c-4a1f-9c0e-6a1a2b3c4d5e';
  let watcherCalls: string[][];

  beforeEach(() => {
    watcherCalls = [];
    // Stub the transcript watcher: it is the observable side effect of the listener body,
    // and stubbing keeps the test off the user's real ~/.claude/projects.
    (server as unknown as { startTranscriptWatcher(id: string, path: string): void }).startTranscriptWatcher = (
      id: string,
      path: string
    ) => {
      watcherCalls.push([id, path]);
    };
  });

  /** Registers a real session with the real listeners and writes its baseline to disk. */
  async function attach(id: string, mode: 'claude' | 'codex' | 'pi'): Promise<Session> {
    const session = new Session({ id, workingDir: dir, mode, useMux: false });
    (server as unknown as { sessions: Map<string, Session> }).sessions.set(session.id, session);
    await (server as unknown as { setupSessionListeners(s: Session): Promise<void> }).setupSessionListeners(session);
    store.setSession(session.id, session.toState());
    store.saveNow();
    return session;
  }

  it('does not adopt a conversationId as the harness identity of a codex session', async () => {
    const session = await attach('sess-convid-codex', 'codex');

    session.emit('conversationId', CLAUDE_UUID);

    await flush();
    store.saveNow();
    expect(session.claudeResumeId).toBeFalsy();
    expect(session.harnessSessionId).toBeUndefined();
    expect(claudeResumeIdOnDisk(session.id)).toBeFalsy();
    expect(harnessSessionIdOnDisk(session.id)).toBeUndefined();
    expect(watcherCalls).toEqual([]);
  });

  it('does not adopt a conversationId as the harness identity of a pi session', async () => {
    const session = await attach('sess-convid-pi', 'pi');
    // A pi session already carries its own preassigned id — it must survive untouched.
    session.recordHarnessSessionId('sess-convid-pi');
    await flush();

    session.emit('conversationId', CLAUDE_UUID);

    await flush();
    store.saveNow();
    expect(session.claudeResumeId).toBeFalsy();
    expect(session.harnessSessionId).toBe('sess-convid-pi');
    expect(harnessSessionIdOnDisk(session.id)).toBe('sess-convid-pi');
    expect(watcherCalls).toEqual([]);
  });

  it('still adopts a conversationId for a claude session (positive control)', async () => {
    const session = await attach('sess-convid-claude', 'claude');

    session.emit('conversationId', CLAUDE_UUID);

    await flush();
    store.saveNow();
    expect(session.claudeResumeId).toBe(CLAUDE_UUID);
    expect(session.harnessSessionId).toBe(CLAUDE_UUID);
    expect(claudeResumeIdOnDisk(session.id)).toBe(CLAUDE_UUID);
    expect(harnessSessionIdOnDisk(session.id)).toBe(CLAUDE_UUID);
    expect(watcherCalls).toHaveLength(1);
    expect(watcherCalls[0][1].endsWith(`${CLAUDE_UUID}.jsonl`)).toBe(true);
  });
});

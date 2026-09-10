/**
 * WebServer wiring for view-only (codex / pi) transcript watchers.
 *
 * Covers startHarnessTranscriptWatcher (gate, claudeState:false, ids untouched,
 * transcript:ready once, idempotent), its listener triggers (codex harnessSessionIdDiscovered,
 * pi idle, never for Claude), getTranscriptState / getTranscriptPath for view-only sessions,
 * and the archive-time transcriptPath fallback in clearSession.
 *
 * HOME ISOLATION: a real WebServer is constructed (no start()). HOME, TMUX_TMPDIR, CODEX_HOME
 * and PI_CODING_AGENT_DIR point at temp dirs and TMUX is unset BEFORE any server module is
 * imported (dynamic import), because several modules resolve ~/.codeman paths at import time.
 * The state-store path is asserted to be under the temp HOME before anything else runs.
 * All transcript fixtures are synthetic.
 *
 * Run (system Node v24 — better-sqlite3 ABI): npx vitest run test/server-harness-transcript-watcher.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../src/session.js';
import type { TranscriptWatcher } from '../src/transcript-watcher.js';
import type { SessionMode } from '../src/types/session.js';

const FIXTURES = join(__dirname, 'fixtures', 'transcripts');
const ENV_KEYS = ['HOME', 'TMUX_TMPDIR', 'TMUX', 'CODEX_HOME', 'PI_CODING_AGENT_DIR'] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

interface ServerInternals {
  sessions: Map<string, Session>;
  transcriptWatchers: Map<string, TranscriptWatcher>;
  store: {
    filePath: string;
    setSession(id: string, state: unknown): void;
    getSession(id: string): { status?: string; transcriptPath?: string } | undefined;
  };
  broadcast(event: string, data: unknown): void;
  startTranscriptWatcher(id: string, path: string): void;
  startHarnessTranscriptWatcher(id: string): string | null;
  stopTranscriptWatcher(id: string): void;
  getTranscriptPath(id: string): string | null;
  getTranscriptState(id: string): unknown;
  setupSessionListeners(s: Session): Promise<void>;
  getModelConfig(): Promise<unknown>;
  clearSession(id: string, force: boolean): Promise<unknown>;
}

let tmpRoot = '';
let tmpHome = '';
let tmpTmux = '';
let workDir = '';
let srv: ServerInternals;
let SessionCtor: typeof import('../src/session.js').Session;
let piSessionDirName: (cwd: string) => string;
let clearCodexLocateCache: () => void;
const created: Session[] = [];
let events: Array<{ event: string; sessionId?: string }> = [];
let claudeWatcherCalls: string[] = [];

const codexId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function writeRollout(id: string): string {
  const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  writeFileSync(file, readFileSync(join(FIXTURES, 'codex.jsonl')));
  return realpathSync(file);
}

function writePiSession(id: string): string {
  const dir = join(process.env.PI_CODING_AGENT_DIR!, 'sessions', piSessionDirName(workDir));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, readFileSync(join(FIXTURES, 'pi.jsonl')));
  return realpathSync(file);
}

async function addSession(id: string, mode: SessionMode, opts: { listeners?: boolean } = {}): Promise<Session> {
  const session = new SessionCtor({ id, workingDir: workDir, mode, useMux: false });
  srv.sessions.set(id, session);
  created.push(session);
  if (opts.listeners) await srv.setupSessionListeners(session);
  return session;
}

const readyCount = (sessionId: string) =>
  events.filter((e) => e.event === 'transcript:ready' && e.sessionId === sessionId).length;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tv-srv-harness-'));
  tmpHome = join(tmpRoot, 'home');
  mkdirSync(tmpHome);
  tmpTmux = mkdtempSync(join(tmpdir(), 'tv-srv-tmux-'));
  workDir = join(tmpRoot, 'work');
  mkdirSync(workDir);
  process.env.HOME = tmpHome;
  process.env.TMUX_TMPDIR = tmpTmux;
  delete process.env.TMUX;
  process.env.CODEX_HOME = join(tmpRoot, 'codex');
  process.env.PI_CODING_AGENT_DIR = join(tmpRoot, 'pi-agent');
  // os.homedir() follows $HOME only on a process main thread (vitest forks pool).
  if (homedir() !== tmpHome) throw new Error(`HOME isolation failed: homedir() is ${homedir()}`);

  const { WebServer } = await import('../src/web/server.js');
  ({ Session: SessionCtor } = await import('../src/session.js'));
  ({ piSessionDirName } = await import('../src/harnesses/transcripts/pi.js'));
  ({ clearCodexLocateCache } = await import('../src/harnesses/transcripts/codex.js'));

  srv = new WebServer(0, false, true) as unknown as ServerInternals;
  if (!srv.store.filePath.startsWith(tmpHome + '/')) throw new Error(`state store not isolated: ${srv.store.filePath}`);

  srv.broadcast = (event: string, data: unknown) => {
    events.push({ event, sessionId: (data as { sessionId?: string } | undefined)?.sessionId });
  };
  // The Claude watcher must never be reached from these paths; record instead of scanning ~/.claude.
  srv.startTranscriptWatcher = (id: string) => {
    claudeWatcherCalls.push(id);
  };
}, 60_000);

afterAll(async () => {
  if (srv) for (const id of [...srv.transcriptWatchers.keys()]) srv.stopTranscriptWatcher(id);
  for (const s of created) {
    try {
      await s.stop(false);
    } catch {
      // already stopped by clearSession
    }
  }
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of [tmpRoot, tmpTmux]) if (d) rmSync(d, { recursive: true, force: true });
}, 30_000);

beforeEach(() => {
  clearCodexLocateCache();
  events = [];
  claudeWatcherCalls = [];
});

describe('test isolation', () => {
  it('the server state store lives under the temp HOME', () => {
    expect(srv.store.filePath).toBe(join(tmpHome, '.codeman', 'state.json'));
    if (savedEnv.HOME) expect(srv.store.filePath.startsWith(savedEnv.HOME + '/')).toBe(false);
  });
});

describe('startHarnessTranscriptWatcher', () => {
  it('returns null and creates no watcher for claude and shell sessions', async () => {
    for (const mode of ['claude', 'shell'] as const) {
      const s = await addSession(`sess-${mode}-nowatch`, mode);
      expect(srv.startHarnessTranscriptWatcher(s.id)).toBeNull();
      expect(srv.transcriptWatchers.has(s.id)).toBe(false);
    }
    expect(events).toEqual([]);
  });

  it('returns null for codex before discovery and before the rollout file exists', async () => {
    const s = await addSession('sess-codex-early', 'codex');
    expect(srv.startHarnessTranscriptWatcher(s.id)).toBeNull();
    s.harnessSessionId = codexId(1); // discovered id, but no rollout on disk
    expect(srv.startHarnessTranscriptWatcher(s.id)).toBeNull();
    expect(srv.transcriptWatchers.has(s.id)).toBe(false);
    expect(readyCount(s.id)).toBe(0);
  });

  for (const mode of ['codex', 'pi'] as const) {
    it(`${mode}: attaches one view-only watcher, leaves ids untouched, broadcasts transcript:ready once`, async () => {
      const id = mode === 'codex' ? 'sess-codex-attach' : '00000000-0000-4000-8000-000000000021';
      const s = await addSession(id, mode);
      let file: string;
      if (mode === 'codex') {
        s.harnessSessionId = codexId(2);
        file = writeRollout(codexId(2));
      } else {
        file = writePiSession(id);
      }
      const before = { claudeResumeId: s.claudeResumeId, harnessSessionId: s.harnessSessionId };

      expect(srv.startHarnessTranscriptWatcher(id)).toBe(file);
      const watcher = srv.transcriptWatchers.get(id)!;
      expect(watcher.claudeState).toBe(false);
      expect(watcher.transcriptPath).toBe(file);

      // Repeat call: same watcher, same path, no second ready.
      expect(srv.startHarnessTranscriptWatcher(id)).toBe(file);
      expect(srv.transcriptWatchers.get(id)).toBe(watcher);
      expect(readyCount(id)).toBe(1);

      expect({ claudeResumeId: s.claudeResumeId, harnessSessionId: s.harnessSessionId }).toEqual(before);
      expect(claudeWatcherCalls).toEqual([]);
    });
  }

  it('getTranscriptState is null for a view-only watcher; getTranscriptPath resolves through the adapter', async () => {
    const codex = await addSession('sess-codex-state', 'codex');
    codex.harnessSessionId = codexId(3);
    const codexFile = writeRollout(codexId(3));
    const piId = '00000000-0000-4000-8000-000000000031';
    await addSession(piId, 'pi');
    const piFile = writePiSession(piId);

    // Resolved before any watcher exists, so this is the adapter's locate, not a watcher path.
    expect(srv.getTranscriptPath(codex.id)).toBe(codexFile);
    expect(srv.getTranscriptPath(piId)).toBe(piFile);

    expect(srv.startHarnessTranscriptWatcher(codex.id)).toBe(codexFile);
    expect(srv.transcriptWatchers.has(codex.id)).toBe(true);
    expect(srv.getTranscriptState(codex.id)).toBeNull();
  });
});

describe('listener triggers', () => {
  it('harnessSessionIdDiscovered on a codex session attaches the view-only watcher', async () => {
    const s = await addSession('sess-codex-discovered', 'codex', { listeners: true });
    const file = writeRollout(codexId(4));
    expect(srv.transcriptWatchers.has(s.id)).toBe(false);

    s.recordHarnessSessionId(codexId(4));

    const watcher = srv.transcriptWatchers.get(s.id);
    expect(watcher?.claudeState).toBe(false);
    expect(watcher?.transcriptPath).toBe(file);
    expect(readyCount(s.id)).toBe(1);
    expect(claudeWatcherCalls).toEqual([]);
  });

  it('idle on a pi session attaches the view-only watcher', async () => {
    const id = '00000000-0000-4000-8000-000000000041';
    const s = await addSession(id, 'pi', { listeners: true });
    const file = writePiSession(id);

    s.emit('idle');

    const watcher = srv.transcriptWatchers.get(id);
    expect(watcher?.claudeState).toBe(false);
    expect(watcher?.transcriptPath).toBe(file);
    expect(readyCount(id)).toBe(1);
  });

  it('idle on a claude session creates no watcher', async () => {
    const s = await addSession('sess-claude-idle', 'claude', { listeners: true });

    s.emit('idle');

    expect(srv.transcriptWatchers.has(s.id)).toBe(false);
    expect(readyCount(s.id)).toBe(0);
    expect(claudeWatcherCalls).toEqual([]);
  });
});

describe('archive-time transcriptPath fallback', () => {
  for (const mode of ['codex', 'pi'] as const) {
    it(`clearSession persists the adapter-located path for a ${mode} session that never had a watcher`, async () => {
      const id = mode === 'codex' ? 'sess-codex-archive' : '00000000-0000-4000-8000-000000000051';
      const s = await addSession(id, mode);
      let file: string;
      if (mode === 'codex') {
        s.harnessSessionId = codexId(5);
        file = writeRollout(codexId(5));
      } else {
        file = writePiSession(id);
      }
      srv.store.setSession(id, s.toState());
      expect(srv.transcriptWatchers.has(id)).toBe(false);

      // The archived state is persisted (step 9) before the child session is built (step 10).
      // Abort at step 10 so no child harness process is ever spawned by this test.
      srv.getModelConfig = async () => {
        throw new Error('stop-before-child-spawn');
      };
      try {
        await expect(srv.clearSession(id, true)).rejects.toThrow('stop-before-child-spawn');
      } finally {
        delete (srv as unknown as Record<string, unknown>).getModelConfig;
      }

      const archived = srv.store.getSession(id);
      expect(archived?.status).toBe('archived');
      expect(archived?.transcriptPath).toBe(file);
    });
  }
});

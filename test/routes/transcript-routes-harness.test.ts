/**
 * Transcript routes for non-Claude harnesses (codex, pi) and the bounded ?tail= read.
 *
 * Run: npx vitest run test/routes/transcript-routes-harness.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { piSessionDirName, piTranscriptAdapter } from '../../src/harnesses/transcripts/pi.js';
import { clearCodexLocateCache } from '../../src/harnesses/transcripts/codex.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'transcripts');
const SESSION_ID = 'harness-sess-1';

type Harness = Awaited<ReturnType<typeof createRouteTestHarness>>;

describe('GET /api/sessions/:id/transcript — codex / pi / shell', () => {
  let harness: Harness;
  let dir: string;

  beforeAll(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes, { sessionId: SESSION_ID });
    dir = mkdtempSync(join(tmpdir(), 'tv-routes-harness-'));
  });
  afterAll(async () => {
    await harness.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setMode(mode: string): void {
    (harness.ctx.sessions.get(SESSION_ID) as unknown as { mode: string }).mode = mode;
  }

  beforeEach(() => {
    vi.mocked(harness.ctx.startTranscriptWatcher).mockClear();
    harness.ctx.getTranscriptPath = vi.fn(() => null);
  });

  it('codex: blocks come from the view-only harness watcher, never the Claude watcher', async () => {
    setMode('codex');
    const file = join(dir, 'codex.jsonl');
    copyFileSync(join(FIXTURES, 'codex.jsonl'), file);
    harness.ctx.startHarnessTranscriptWatcher = vi.fn(() => file);

    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/transcript?tail=100` });
    const blocks = JSON.parse(res.body);
    expect(blocks.map((b: { type: string }) => b.type)).toEqual(['text', 'text', 'tool_use', 'tool_result', 'result']);
    expect(res.headers['x-total-blocks']).toBe('5');
    expect(harness.ctx.startHarnessTranscriptWatcher).toHaveBeenCalledWith(SESSION_ID);
    expect(harness.ctx.startTranscriptWatcher).not.toHaveBeenCalled();
    expect(harness.ctx.getTranscriptPath).not.toHaveBeenCalled();
  });

  it('pi: blocks (thinking included) with no tail param', async () => {
    setMode('pi');
    const file = join(dir, 'pi.jsonl');
    copyFileSync(join(FIXTURES, 'pi.jsonl'), file);
    harness.ctx.startHarnessTranscriptWatcher = vi.fn(() => file);

    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/transcript` });
    const blocks = JSON.parse(res.body);
    expect(blocks.map((b: { type: string }) => b.type)).toEqual([
      'text',
      'thinking',
      'tool_use',
      'tool_result',
      'text',
      'result',
    ]);
    expect(harness.ctx.startTranscriptWatcher).not.toHaveBeenCalled();
  });

  it('codex/pi with no transcript file yet returns []', async () => {
    setMode('pi');
    harness.ctx.startHarnessTranscriptWatcher = vi.fn(() => null);
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/transcript?tail=100` });
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('shell and opencode return [] without touching either watcher', async () => {
    for (const mode of ['shell', 'opencode']) {
      setMode(mode);
      harness.ctx.startHarnessTranscriptWatcher = vi.fn(() => '/should/not/be/used');
      const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/transcript` });
      expect(JSON.parse(res.body)).toEqual([]);
      expect(harness.ctx.startHarnessTranscriptWatcher).not.toHaveBeenCalled();
      expect(harness.ctx.startTranscriptWatcher).not.toHaveBeenCalled();
    }
  });

  it('?tail= on a large file returns the tail with an X-Total-Blocks estimate above the returned count', async () => {
    setMode('claude');
    const file = join(dir, 'big-claude.jsonl');
    const pad = 'y'.repeat(4000);
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(
        JSON.stringify({
          type: 'user',
          timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: `m${i} ${pad}` },
        })
      );
    }
    writeFileSync(file, lines.join('\n') + '\n');
    harness.ctx.getTranscriptPath = vi.fn(() => file);

    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/transcript?tail=10` });
    const blocks = JSON.parse(res.body);
    expect(blocks).toHaveLength(10);
    expect(blocks[9].text.startsWith('m399 ')).toBe(true);
    // Lazy-load treats the header as "more exists" — it must exceed what was returned.
    expect(Number(res.headers['x-total-blocks'])).toBeGreaterThan(10);
    expect(harness.ctx.startTranscriptWatcher).toHaveBeenCalledWith(SESSION_ID, file);

    // Asking for more than exists reaches byte 0: exact count, everything returned.
    const all = await harness.app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/transcript?tail=1000` });
    expect(JSON.parse(all.body)).toHaveLength(400);
    expect(all.headers['x-total-blocks']).toBe('400');
  });
});

describe('GET /api/sessions/:id/state — archived codex / pi sessions', () => {
  let harness: Harness;
  let dir: string;
  let prevPiDir: string | undefined;

  beforeAll(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes, { sessionId: 'live-session' });
    dir = mkdtempSync(join(tmpdir(), 'tv-state-harness-'));
    prevPiDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(dir, 'pi-agent');
  });
  afterAll(async () => {
    await harness.app.close();
    if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevPiDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses an archived codex session’s persisted transcriptPath with the codex adapter', async () => {
    const file = join(dir, 'rollout.jsonl');
    copyFileSync(join(FIXTURES, 'codex.jsonl'), file);
    harness.ctx.store.getSession = vi.fn(() => ({
      id: 'archived-codex',
      mode: 'codex',
      status: 'archived',
      workingDir: '/tmp/example-project',
      transcriptPath: file,
    })) as never;

    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/archived-codex/state' });
    const body = JSON.parse(res.body);
    expect(body.transcript.map((b: { type: string }) => b.type)).toEqual([
      'text',
      'text',
      'tool_use',
      'tool_result',
      'result',
    ]);
  });

  it('locates an archived pi session with no persisted path from its workingDir and harness id', async () => {
    const id = '00000000-0000-4000-8000-000000000002';
    const workingDir = '/tmp/example-project';
    const sessDir = join(dir, 'pi-agent', 'sessions', piSessionDirName(workingDir));
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), readFileSync(join(FIXTURES, 'pi.jsonl')));
    harness.ctx.store.getSession = vi.fn(() => ({
      id: 'archived-pi',
      mode: 'pi',
      status: 'archived',
      workingDir,
      harnessSessionId: id,
    })) as never;

    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/archived-pi/state' });
    const body = JSON.parse(res.body);
    expect(body.transcript.map((b: { type: string }) => b.type)).toEqual([
      'text',
      'thinking',
      'tool_use',
      'tool_result',
      'text',
      'result',
    ]);
  });

  it('an archived shell session yields no transcript even with a stray persisted path', async () => {
    const file = join(dir, 'stray.jsonl');
    copyFileSync(join(FIXTURES, 'pi.jsonl'), file);
    harness.ctx.store.getSession = vi.fn(() => ({
      id: 'archived-shell',
      mode: 'shell',
      status: 'archived',
      workingDir: '/tmp',
      transcriptPath: file,
    })) as never;
    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/archived-shell/state' });
    expect(JSON.parse(res.body).transcript).toEqual([]);
  });
});

describe('GET /api/sessions/:id/state — archived codex locate, archived pi persisted path, live-session guard', () => {
  let harness: Harness;
  let dir: string;
  const prevEnv = { CODEX_HOME: process.env.CODEX_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const LIVE_ID = 'live-pi';

  beforeAll(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes, { sessionId: LIVE_ID });
    dir = mkdtempSync(join(tmpdir(), 'tv-state-harness2-'));
    process.env.CODEX_HOME = join(dir, 'codex');
    process.env.PI_CODING_AGENT_DIR = join(dir, 'pi-agent');
    clearCodexLocateCache();
  });
  afterAll(async () => {
    await harness.app.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearCodexLocateCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('locates an archived codex session with no persisted path via CODEX_HOME and its harness id', async () => {
    const id = '00000000-0000-4000-8000-000000000003';
    const rolloutDir = join(dir, 'codex', 'sessions', '2026', '01', '01');
    mkdirSync(rolloutDir, { recursive: true });
    copyFileSync(join(FIXTURES, 'codex.jsonl'), join(rolloutDir, `rollout-2026-01-01T00-00-00-${id}.jsonl`));
    harness.ctx.store.getSession = vi.fn(() => ({
      id: 'archived-codex-nopath',
      mode: 'codex',
      status: 'archived',
      workingDir: '/tmp/example-project',
      harnessSessionId: id,
    })) as never;

    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/archived-codex-nopath/state' });
    expect(JSON.parse(res.body).transcript.map((b: { type: string }) => b.type)).toEqual([
      'text',
      'text',
      'tool_use',
      'tool_result',
      'result',
    ]);
  });

  it('parses an archived pi session’s persisted transcriptPath with the pi adapter', async () => {
    const file = join(dir, 'persisted-pi.jsonl');
    copyFileSync(join(FIXTURES, 'pi.jsonl'), file);
    harness.ctx.store.getSession = vi.fn(() => ({
      id: 'archived-pi-path',
      mode: 'pi',
      status: 'archived',
      workingDir: '/tmp/example-project',
      transcriptPath: file,
    })) as never;

    const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/archived-pi-path/state' });
    expect(JSON.parse(res.body).transcript.map((b: { type: string }) => b.type)).toEqual([
      'text',
      'thinking',
      'tool_use',
      'tool_result',
      'text',
      'result',
    ]);
  });

  it('a live session with no transcript path is not located from its state', async () => {
    const live = harness.ctx.sessions.get(LIVE_ID) as unknown as { mode: string; workingDir: string };
    live.mode = 'pi';
    // A pi file the locator WOULD find for this session if the live-session guard were missing.
    const sessDir = join(dir, 'pi-agent', 'sessions', piSessionDirName(live.workingDir));
    mkdirSync(sessDir, { recursive: true });
    const file = join(sessDir, `2026-01-01T00-00-00-000Z_${LIVE_ID}.jsonl`);
    copyFileSync(join(FIXTURES, 'pi.jsonl'), file);
    expect(piTranscriptAdapter.locate({ workingDir: live.workingDir, sessionId: LIVE_ID })).not.toBeNull();
    harness.ctx.getTranscriptPath = vi.fn(() => null);

    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${LIVE_ID}/state` });
    const body = JSON.parse(res.body);
    expect(body.session.mode).toBe('pi');
    expect(body.transcript).toEqual([]);
    expect(harness.ctx.getTranscriptPath).toHaveBeenCalledWith(LIVE_ID);
  });
});

describe('transcript identity and the authoritative pi path', () => {
  let harness: Harness;
  let dir: string;
  const ID = 'tid-session';

  beforeAll(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes, { sessionId: ID });
    dir = mkdtempSync(join(tmpdir(), 'tv-routes-tid-'));
  });
  afterAll(async () => {
    await harness.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const live = () => harness.ctx.sessions.get(ID) as unknown as { mode: string; harnessTranscriptPath?: string };

  beforeEach(() => {
    vi.mocked(harness.ctx.startTranscriptWatcher).mockClear();
    harness.ctx.getTranscriptPath = vi.fn(() => null);
    live().harnessTranscriptPath = undefined;
  });

  it('pi /transcript sends X-Transcript-Id from the watcher it reads', async () => {
    live().mode = 'pi';
    const file = join(dir, 'pi.jsonl');
    copyFileSync(join(FIXTURES, 'pi.jsonl'), file);
    harness.ctx.startHarnessTranscriptWatcher = vi.fn(() => file);
    harness.ctx.getTranscriptId = vi.fn(() => 'tid-pi-1');

    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/transcript?tail=100` });
    expect(JSON.parse(res.body)).toHaveLength(6);
    expect(res.headers['x-transcript-id']).toBe('tid-pi-1');
    expect(harness.ctx.getTranscriptId).toHaveBeenCalledWith(ID);
  });

  it('pi /transcript for a not-yet-created session file returns [] and still sends the id', async () => {
    live().mode = 'pi';
    harness.ctx.startHarnessTranscriptWatcher = vi.fn(() => join(dir, 'not-created.jsonl'));
    harness.ctx.getTranscriptId = vi.fn(() => 'tid-pi-empty');
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/transcript` });
    expect(JSON.parse(res.body)).toEqual([]);
    expect(res.headers['x-transcript-id']).toBe('tid-pi-empty');
  });

  it('claude /transcript sends X-Transcript-Id too', async () => {
    live().mode = 'claude';
    const file = join(dir, 'claude.jsonl');
    writeFileSync(
      file,
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } }) +
        '\n'
    );
    harness.ctx.getTranscriptPath = vi.fn(() => file);
    harness.ctx.getTranscriptId = vi.fn(() => 'tid-claude');
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/transcript` });
    expect(JSON.parse(res.body)).toHaveLength(1);
    expect(res.headers['x-transcript-id']).toBe('tid-claude');
  });

  it('claude /transcript reads the id AFTER starting the watcher, which may retarget it', async () => {
    live().mode = 'claude';
    const file = join(dir, 'claude-retarget.jsonl');
    writeFileSync(
      file,
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } }) +
        '\n'
    );
    harness.ctx.getTranscriptPath = vi.fn(() => file);
    // The watcher's id changes once startTranscriptWatcher has (re)targeted it.
    let watcherStarted = false;
    harness.ctx.startTranscriptWatcher = vi.fn(() => {
      watcherStarted = true;
    });
    harness.ctx.getTranscriptId = vi.fn(() => (watcherStarted ? 'tid-new' : 'tid-old'));

    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/transcript` });
    expect(JSON.parse(res.body)).toHaveLength(1);
    expect(res.headers['x-transcript-id']).toBe('tid-new');
    expect(harness.ctx.startTranscriptWatcher).toHaveBeenCalledWith(ID, file);
    expect(vi.mocked(harness.ctx.startTranscriptWatcher).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(harness.ctx.getTranscriptId).mock.invocationCallOrder[0]
    );
  });

  it('no header when there is no watcher id', async () => {
    live().mode = 'pi';
    const file = join(dir, 'pi2.jsonl');
    copyFileSync(join(FIXTURES, 'pi.jsonl'), file);
    harness.ctx.startHarnessTranscriptWatcher = vi.fn(() => file);
    harness.ctx.getTranscriptId = vi.fn(() => undefined);
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/transcript` });
    expect(res.headers['x-transcript-id']).toBeUndefined();
  });

  it('live pi /state reads harnessTranscriptPath, not getTranscriptPath()', async () => {
    live().mode = 'pi';
    const file = join(dir, 'accepted-pi.jsonl');
    copyFileSync(join(FIXTURES, 'pi.jsonl'), file);
    live().harnessTranscriptPath = file;
    harness.ctx.getTranscriptPath = vi.fn(() => '/wrong/located.jsonl');

    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/state` });
    const body = JSON.parse(res.body);
    expect(body.transcript.map((b: { type: string }) => b.type)).toEqual([
      'text',
      'thinking',
      'tool_use',
      'tool_result',
      'text',
      'result',
    ]);
    expect(harness.ctx.getTranscriptPath).not.toHaveBeenCalled();
  });

  it('live pi /state with no accepted path falls back to getTranscriptPath() (pre-extension sessions)', async () => {
    live().mode = 'pi';
    const file = join(dir, 'located-pi.jsonl');
    copyFileSync(join(FIXTURES, 'pi.jsonl'), file);
    harness.ctx.getTranscriptPath = vi.fn(() => file);
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/state` });
    expect(JSON.parse(res.body).transcript).toHaveLength(6);
    expect(harness.ctx.getTranscriptPath).toHaveBeenCalledWith(ID);
  });

  it('a non-hook session ignores a stray harnessTranscriptPath in /state', async () => {
    live().mode = 'codex';
    const file = join(dir, 'stray-codex.jsonl');
    copyFileSync(join(FIXTURES, 'codex.jsonl'), file);
    live().harnessTranscriptPath = join(dir, 'does-not-matter.jsonl');
    harness.ctx.getTranscriptPath = vi.fn(() => file);
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/state` });
    expect(JSON.parse(res.body).transcript).toHaveLength(5);
    expect(harness.ctx.getTranscriptPath).toHaveBeenCalledWith(ID);
  });
});

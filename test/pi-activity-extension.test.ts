/**
 * The Codeman pi extension (spec §3): runs inside pi's process, reports whether pi is working
 * to the Codeman session that launched it via ordered, token-authenticated harness_activity
 * hook events.
 *
 * A fake `pi.on` registry drives the handlers; `fetch` is stubbed; timers are fake; and
 * `globalThis.__codemanActivity` is reset per test so each test is a fresh pi process.
 *
 * Run: npx vitest run test/pi-activity-extension.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import codemanActivity from '../src/harnesses/pi/codeman-activity-extension.js';

type Handler = (event: unknown, ctx: unknown) => unknown;
type Factory = (pi: { on(event: string, handler: Handler): void }) => void;

const ENV = {
  CODEMAN_SESSION_ID: 'codeman-session-1',
  CODEMAN_API_URL: 'http://localhost:3431',
  CODEMAN_ACTIVITY_TOKEN: '0123456789abcdef0123456789abcdef',
};
const SESSION_FILE = '/home/u/.pi/agent/sessions/--tmp--/2026-09-10_abc.jsonl';

let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv: Record<string, string | undefined> = {};
const loaded: Array<Record<string, Handler>> = [];

function load(factory: Factory = codemanActivity as Factory) {
  const handlers: Record<string, Handler> = {};
  factory({
    on(event, handler) {
      handlers[event] = handler;
    },
  });
  loaded.push(handlers);
  const ctx = { sessionManager: { getSessionFile: () => SESSION_FILE } };
  const fire = (name: string, c: unknown = ctx) => handlers[name]?.({ type: name }, c);
  return { handlers, fire };
}

interface Posted {
  event: string;
  sessionId: string;
  data: { state: 'working' | 'idle'; token: string; gen: number; seq: number; sessionFile?: string };
}
const posts = (): Posted[] => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
const states = () => posts().map((p) => p.data.state);

beforeEach(() => {
  delete (globalThis as { __codemanActivity?: unknown }).__codemanActivity;
  for (const [k, v] of Object.entries(ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  // Clear every heartbeat interval a test left armed.
  for (const h of loaded.splice(0)) {
    try {
      h.session_shutdown?.({ type: 'session_shutdown' }, {});
    } catch {
      /* the never-throws tests cover this */
    }
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete (globalThis as { __codemanActivity?: unknown }).__codemanActivity;
});

describe('registration', () => {
  it.each(Object.keys(ENV))('registers nothing and posts nothing when %s is missing', (name) => {
    delete process.env[name];
    const { handlers } = load();
    expect(Object.keys(handlers)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registers the lifecycle handlers when all three variables are set', () => {
    const { handlers } = load();
    expect(Object.keys(handlers).sort()).toEqual(
      [
        'agent_settled',
        'agent_start',
        'session_before_compact',
        'session_compact',
        'session_compact_failed',
        'session_shutdown',
        'session_start',
      ].sort()
    );
  });
});

describe('state tracking', () => {
  it('agent_start, agent_start, agent_settled posts working then idle (state, not event counts)', () => {
    const { fire } = load();
    fire('agent_start');
    fire('agent_start');
    fire('agent_settled');
    expect(states()).toEqual(['working', 'idle']);
  });

  it('agent_settled with no prior start reports idle without error', () => {
    const { fire } = load();
    expect(() => fire('agent_settled')).not.toThrow();
    expect(states()).toEqual(['idle']);
  });

  it('session_before_compact reports working and its handler returns undefined', () => {
    const { fire } = load();
    expect(fire('session_before_compact')).toBeUndefined();
    expect(states()).toEqual(['working']);
  });

  it.each(['session_compact', 'session_compact_failed'])('%s reports idle when no run is active', (name) => {
    const { fire } = load();
    fire('session_before_compact');
    fire(name);
    expect(states()).toEqual(['working', 'idle']);
  });

  it('compaction ending while a run is active stays working', () => {
    const { fire } = load();
    fire('agent_start');
    fire('session_before_compact');
    fire('session_compact');
    expect(states()).toEqual(['working']);
    fire('agent_settled');
    expect(states()).toEqual(['working', 'idle']);
  });

  it('agent_start clears a compacting flag that no compaction event cleared', () => {
    const { fire } = load();
    fire('session_before_compact');
    fire('agent_start');
    fire('agent_settled');
    expect(states()).toEqual(['working', 'idle']);
  });

  it('session_shutdown posts idle and clears the heartbeat', () => {
    const { fire } = load();
    fire('agent_start');
    fire('session_shutdown');
    expect(states()).toEqual(['working', 'idle']);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the heartbeat re-posts the current state every 30 s', () => {
    const { fire } = load();
    fire('agent_start');
    vi.advanceTimersByTime(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(30_000);
    expect(states()).toEqual(['working', 'working', 'working']);
  });

  it('session_start posts, carrying the session file', () => {
    const { fire } = load();
    fire('session_start');
    expect(posts()).toHaveLength(1);
    expect(posts()[0].data).toMatchObject({ state: 'idle', sessionFile: SESSION_FILE });
  });

  it('a changed session file is posted even when the state is unchanged', () => {
    const { fire } = load();
    fire('agent_start');
    fire('agent_start', { sessionManager: { getSessionFile: () => '/other.jsonl' } });
    expect(posts().map((p) => p.data.sessionFile)).toEqual([SESSION_FILE, '/other.jsonl']);
  });
});

describe('payload', () => {
  it('posts exactly to ${CODEMAN_API_URL}/api/hook-event with the report', () => {
    const { fire } = load();
    fire('agent_start');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The localhost auth exemption compares req.url exactly: no query string.
    expect(url).toBe('http://localhost:3431/api/hook-event');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(posts()[0]).toEqual({
      event: 'harness_activity',
      sessionId: ENV.CODEMAN_SESSION_ID,
      data: { state: 'working', token: ENV.CODEMAN_ACTIVITY_TOKEN, gen: 1, seq: 1, sessionFile: SESSION_FILE },
    });
  });

  it('seq strictly increases across two factory invocations (/reload); gen is 1 then 2', async () => {
    const first = load();
    first.fire('agent_start');
    first.fire('session_shutdown');

    // /reload re-imports the module (moduleCache: false) but keeps the process's globalThis.
    vi.resetModules();
    const reimported = (await import('../src/harnesses/pi/codeman-activity-extension.js')).default as Factory;
    const second = load(reimported);
    second.fire('agent_start');
    vi.advanceTimersByTime(30_000);

    const data = posts().map((p) => p.data);
    expect(data.map((d) => d.gen)).toEqual([1, 1, 2, 2]);
    const seqs = data.map((d) => d.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});

describe('never throws into pi', () => {
  it('a rejecting fetch is swallowed', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    const { fire } = load();
    expect(() => fire('agent_start')).not.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
  });

  it('a hanging fetch is swallowed and does not block later posts', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { fire } = load();
    expect(() => fire('agent_start')).not.toThrow();
    expect(() => fire('agent_settled')).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a synchronously throwing fetch is swallowed', () => {
    fetchMock.mockImplementation(() => {
      throw new TypeError('fetch unavailable');
    });
    const { fire } = load();
    expect(() => fire('agent_start')).not.toThrow();
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
  });

  it('a throwing or missing sessionManager is tolerated', () => {
    const { fire } = load();
    const boom = {
      sessionManager: {
        getSessionFile: () => {
          throw new Error('boom');
        },
      },
    };
    expect(() => fire('agent_start', boom)).not.toThrow();
    expect(() => fire('agent_settled', {})).not.toThrow();
    expect(states()).toEqual(['working', 'idle']);
  });
});

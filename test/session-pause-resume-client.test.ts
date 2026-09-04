/**
 * @fileoverview Client-side pause/resume regression tests (review-5 finding R2).
 *
 * The C7 transcript preflight can refuse a resume. Before this pass the UI had no way
 * past that refusal — `resumeSessionProcess()` sent no body and had no force ladder — so a
 * refused session was permanently parked, and every flushed keystroke chunk fired its own
 * `/resume` POST plus its own error toast.
 *
 * The REAL method bodies are extracted from the shipped `app.js` text (same approach as
 * `files-lazy-subtree.test.ts`) so these assertions break if app.js regresses, rather than
 * testing a copy that can silently drift.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

function methodSource(name: string): string {
  let start = APP_JS_SOURCE.indexOf(`\n  ${name}(`);
  if (start === -1) start = APP_JS_SOURCE.indexOf(`\n  async ${name}(`);
  expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
  const lines = APP_JS_SOURCE.slice(start + 1).split('\n');
  if (lines[0].trimEnd().endsWith('}')) return lines[0];
  const end = lines.findIndex((l, i) => i > 0 && l === '  }');
  expect(end, `${name}() has no 2-space closing brace`).toBeGreaterThan(0);
  return lines.slice(0, end + 1).join('\n');
}

const METHODS = [
  'pauseSessionProcess',
  'resumeSessionProcess',
  '_isResumeBackedOff',
  '_noteResumeFailure',
  '_clearResumeBackoff',
  '_sendInputAsync',
  '_enqueueInput',
];

interface FetchCall {
  url: string;
  body: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApp(responder: (url: string, body: unknown) => unknown, overrides: Record<string, unknown> = {}): any {
  const body = METHODS.map(methodSource).join(',\n');
  const calls: FetchCall[] = [];

  globalThis.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    const parsed = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body: parsed });
    const payload = responder(url, parsed);
    return { ok: true, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;

  return Object.assign(new Function(`return ({\n${body}\n});`)(), {
    _calls: calls,
    sessions: new Map([['s1', { id: 's1', name: 'Parked', paused: true }]]),
    _pausingSessionId: null,
    _resumeBackoffUntil: new Map(),
    _inputQueue: new Map(),
    _inputQueueMaxBytes: 65536,
    _inputSendChain: Promise.resolve(),
    isOnline: true,
    _connectionStatus: 'connected',
    toasts: [] as { msg: string; kind: string }[],
    getSessionName(s: { name: string }) {
      return s.name;
    },
    showToast(msg: string, kind: string) {
      this.toasts.push({ msg, kind });
    },
    clearPendingHooks: vi.fn(),
    pendingHooks: new Map(),
    tabAlerts: new Map(),
    removeAttentionItemsForSession: vi.fn(),
    _updateConnectionIndicator: vi.fn(),
    ...overrides,
  });
}

const REFUSAL = {
  success: false,
  errorCode: 'TRANSCRIPT_UNAVAILABLE',
  error: 'Cannot resume: transcript is gone',
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('resumeSessionProcess force ladder (R2)', () => {
  it('retries with force after the user confirms a transcript refusal', async () => {
    const app = makeApp((_url, body) => ((body as { force?: boolean })?.force ? { success: true } : REFUSAL));
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true)
    );

    await expect(app.resumeSessionProcess('s1')).resolves.toBe(true);

    expect(app._calls).toHaveLength(2);
    expect(app._calls[0].body).toEqual({});
    // Without this second call the session is parked forever with no UI way out.
    expect(app._calls[1].body).toEqual({ force: true });
    expect(app.sessions.get('s1').paused).toBe(false);
  });

  it('does not force when the user declines, and backs the session off', async () => {
    const app = makeApp(() => REFUSAL);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false)
    );

    await expect(app.resumeSessionProcess('s1')).resolves.toBe(false);

    expect(app._calls).toHaveLength(1);
    expect(app._isResumeBackedOff('s1')).toBe(true);
  });

  it('does not confirm-loop when the forced attempt is itself refused', async () => {
    const app = makeApp(() => REFUSAL);
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);

    await expect(app.resumeSessionProcess('s1')).resolves.toBe(false);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(app._calls).toHaveLength(2);
  });

  it('sends no force flag on an ordinary resume', async () => {
    const app = makeApp(() => ({ success: true }));

    await expect(app.resumeSessionProcess('s1')).resolves.toBe(true);
    expect(app._calls).toHaveLength(1);
    expect(app._calls[0].body).toEqual({});
    expect(app.toasts[0].msg).toMatch(/Resumed session/);
  });
});

describe('auto-resume back-off (R2 secondary — one POST per refusal, not per keystroke)', () => {
  it('stops re-POSTing /resume for every flushed keystroke chunk', async () => {
    const app = makeApp((url) => (url.endsWith('/resume') ? { success: false, error: 'nope' } : { success: true }));

    for (const chunk of ['h', 'e', 'l', 'l', 'o']) {
      app._sendInputAsync('s1', chunk);
      await app._inputSendChain;
    }

    const resumeCalls = app._calls.filter((c: FetchCall) => c.url.endsWith('/resume'));
    expect(resumeCalls).toHaveLength(1);
    // Nothing was sent to a parked session, and no keystroke was dropped.
    expect(app._calls.filter((c: FetchCall) => c.url.endsWith('/input'))).toHaveLength(0);
    expect(app._inputQueue.get('s1')).toBe('hello');
    // One toast, not five.
    expect(app.toasts.filter((t: { msg: string }) => /Resume failed/.test(t.msg))).toHaveLength(1);
  });

  it('still resumes and sends when the resume succeeds', async () => {
    const app = makeApp(() => ({ success: true }));

    app._sendInputAsync('s1', 'hi');
    await app._inputSendChain;
    await Promise.resolve();

    expect(app._calls.map((c: FetchCall) => c.url)).toEqual(['/api/sessions/s1/resume', '/api/sessions/s1/input']);
    expect(app._inputQueue.has('s1')).toBe(false);
  });
});

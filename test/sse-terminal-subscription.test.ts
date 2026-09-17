/**
 * @fileoverview Per-client terminal subscription tests.
 *
 * `session:terminal` carries raw PTY output and is by far the highest-volume SSE
 * event. Before this feature every connected browser received terminal output for
 * EVERY session and threw away all but the active one — with 40+ sessions that is
 * megabytes of JSON parsed on the main thread per minute, which is what froze the UI.
 *
 * A client now declares which session's terminal it is actually rendering
 * (`?clientId=…&terminal=…` on connect, `POST /api/events/terminal-subscription`
 * afterwards) and the server only writes terminal frames to subscribed clients.
 * Clients that don't pass a clientId keep the old "receive everything" behaviour.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebServer } from '../src/web/server.js';

const TEST_PORT = 3217;

/** Opens an SSE connection and accumulates raw text until `stop()` is called. */
function openSSE(url: string): { text: () => string; stop: () => Promise<void> } {
  const controller = new AbortController();
  let received = '';

  const done = fetch(url, { signal: controller.signal })
    .then(async (response) => {
      const reader = response.body?.getReader();
      if (!reader) return;
      try {
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          received += new TextDecoder().decode(value);
        }
      } catch {
        /* AbortError expected */
      }
    })
    .catch(() => {
      /* AbortError expected */
    });

  return {
    text: () => received,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

/** Terminal payloads this client received for `sessionId`. */
function terminalFramesFor(raw: string, sessionId: string): string[] {
  return raw
    .split('\n\n')
    .filter((block) => block.startsWith('event: session:terminal') && block.includes(`"id":"${sessionId}"`));
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SSE per-client terminal subscription', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(TEST_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
  }, 60000);

  /** Pushes PTY output through the real batching path without needing a live PTY. */
  function emitTerminal(sessionId: string, data: string): void {
    (server as unknown as { batchTerminalData(id: string, data: string): void }).batchTerminalData(sessionId, data);
  }

  it('only sends terminal frames to clients subscribed to that session', async () => {
    const sessionId = 'sub-test-session-1';
    const otherId = 'sub-test-session-2';

    const legacy = openSSE(`${baseUrl}/api/events`);
    const subscribed = openSSE(`${baseUrl}/api/events?clientId=client-sub&terminal=${sessionId}`);
    const elsewhere = openSSE(`${baseUrl}/api/events?clientId=client-other&terminal=${otherId}`);
    const nothing = openSSE(`${baseUrl}/api/events?clientId=client-none&terminal=`);
    await settle();

    emitTerminal(sessionId, 'MARKER-ALPHA');
    await settle();

    expect(terminalFramesFor(legacy.text(), sessionId).join('')).toContain('MARKER-ALPHA');
    expect(terminalFramesFor(subscribed.text(), sessionId).join('')).toContain('MARKER-ALPHA');
    expect(terminalFramesFor(elsewhere.text(), sessionId)).toHaveLength(0);
    expect(terminalFramesFor(nothing.text(), sessionId)).toHaveLength(0);

    await Promise.all([legacy.stop(), subscribed.stop(), elsewhere.stop(), nothing.stop()]);
  });

  it('starts and stops the stream when the client changes its subscription', async () => {
    const sessionId = 'sub-test-session-3';
    const client = openSSE(`${baseUrl}/api/events?clientId=client-switch&terminal=`);
    await settle();

    emitTerminal(sessionId, 'BEFORE-SUBSCRIBE');
    await settle();
    expect(terminalFramesFor(client.text(), sessionId)).toHaveLength(0);

    const subRes = await fetch(`${baseUrl}/api/events/terminal-subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-switch', sessionIds: [sessionId] }),
    });
    expect(subRes.status).toBe(200);

    emitTerminal(sessionId, 'AFTER-SUBSCRIBE');
    await settle();
    const afterSubscribe = terminalFramesFor(client.text(), sessionId).join('');
    expect(afterSubscribe).toContain('AFTER-SUBSCRIBE');
    expect(afterSubscribe).not.toContain('BEFORE-SUBSCRIBE');

    // Unsubscribe (what the tab does when it is hidden or the user leaves the terminal)
    await fetch(`${baseUrl}/api/events/terminal-subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-switch', sessionIds: [] }),
    });

    emitTerminal(sessionId, 'AFTER-UNSUBSCRIBE');
    await settle();
    expect(terminalFramesFor(client.text(), sessionId).join('')).not.toContain('AFTER-UNSUBSCRIBE');

    await client.stop();
  });

  it('does not buffer terminal output when nobody is watching that session', async () => {
    const sessionId = 'sub-test-session-4';
    const client = openSSE(`${baseUrl}/api/events?clientId=client-idle&terminal=`);
    await settle();

    emitTerminal(sessionId, 'UNWATCHED');

    const batches = (server as unknown as { terminalBatches: Map<string, string[]> }).terminalBatches;
    expect(batches.has(sessionId)).toBe(false);

    await client.stop();
  });

  it('keeps non-terminal session events flowing to unsubscribed clients', async () => {
    const client = openSSE(`${baseUrl}/api/events?clientId=client-meta&terminal=`);
    await settle();

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    const sessionId = (await createRes.json()).session.id;
    await settle();

    expect(client.text()).toContain('event: session:created');

    await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    await client.stop();
  });
});

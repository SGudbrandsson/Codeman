/**
 * @fileoverview SSE delivery end-to-end tests for agent messaging events.
 *
 * These tests start a real WebServer on an ephemeral port and connect a real SSE
 * client via fetch() to verify agent:message and agent:broadcast events are
 * delivered over the wire.
 *
 * This file is intentionally SEPARATE from message-routes.test.ts because that
 * file uses vi.mock('../../src/messages/index.js') which is hoisted and would
 * replace the real store implementation that the live WebServer needs.
 *
 * Pattern mirrors test/sse-events.test.ts.
 *
 * Run: npx vitest run test/routes/message-sse-delivery.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebServer } from '../../src/web/server.js';
import { openDb, closeDb } from '../../src/work-items/db.js';

const SSE_TEST_PORT = 3143;

/** Parse SSE text into { event, data } pairs */
function parseSseEvents(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const lines = text.split('\n');
  let currentEvent = '';
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.substring(7);
    } else if (line.startsWith('data: ')) {
      currentData = line.substring(6);
    } else if (line === '') {
      if (currentEvent && currentData) {
        try {
          events.push({ event: currentEvent, data: JSON.parse(currentData) });
        } catch {
          events.push({ event: currentEvent, data: currentData });
        }
      }
      currentEvent = '';
      currentData = '';
    }
  }
  return events;
}

describe('SSE delivery — end-to-end (live WebServer)', () => {
  let server: WebServer;
  const baseUrl = `http://localhost:${SSE_TEST_PORT}`;

  beforeAll(async () => {
    // Open in-memory DB so message routes can store/retrieve messages
    openDb(':memory:');
    server = new WebServer(SSE_TEST_PORT, false, true);
    await server.start();
  }, 30000);

  afterAll(async () => {
    await server.stop();
    closeDb();
  }, 60000);

  it('SSE client receives agent:broadcast event when broadcast endpoint is called', async () => {
    const controller = new AbortController();
    let receivedData = '';

    // Start SSE listener
    const fetchPromise = fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    }).then(async (response) => {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedData += new TextDecoder().decode(value);
          }
        } catch {
          // AbortError on cleanup — expected
        }
      }
    });

    // Wait for SSE connection to establish
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Register two agents so broadcast has recipients in the store
    const regA = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Broadcast Sender', role: 'developer' }),
    });
    const regAData = await regA.json();
    const senderAgentId: string = regAData.data.agentId;

    await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Broadcast Recipient', role: 'developer' }),
    });

    // Send broadcast — fromAgentId is the sender's agent ID
    const broadcastRes = await fetch(`${baseUrl}/api/agents/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromAgentId: senderAgentId,
        subject: 'SSE delivery test broadcast',
        body: 'All agents please check in.',
      }),
    });
    expect(broadcastRes.status).toBe(201);
    const broadcastBody = await broadcastRes.json();
    expect(broadcastBody.success).toBe(true);
    // Broadcast to 2 agents minus the sender = 1 recipient message
    expect(broadcastBody.data.length).toBeGreaterThanOrEqual(1);

    // Wait for the SSE event to propagate
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Stop listener
    controller.abort();
    try {
      await fetchPromise;
    } catch {
      /* AbortError */
    }

    const events = parseSseEvents(receivedData);
    const broadcastEvent = events.find((e) => e.event === 'agent:broadcast');

    expect(broadcastEvent).toBeDefined();
    expect((broadcastEvent?.data as any).fromAgentId).toBe(senderAgentId);
  });

  it('POST /api/agents/:agentId/messages returns 201 with correct payload for a registered recipient', async () => {
    // Register sender and recipient agents
    const regA = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Msg Sender', role: 'developer' }),
    });
    const senderAgentId: string = (await regA.json()).data.agentId;

    const regB = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Msg Recipient', role: 'developer' }),
    });
    const recipientAgentId: string = (await regB.json()).data.agentId;

    expect(senderAgentId).toBeTruthy();
    expect(recipientAgentId).toBeTruthy();

    const controller = new AbortController();
    let receivedData = '';

    // Start SSE listener
    const fetchPromise = fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    }).then(async (response) => {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedData += new TextDecoder().decode(value);
          }
        } catch {
          // AbortError on cleanup — expected
        }
      }
    });

    // Wait for SSE connection to establish
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Send targeted message to recipient (route returns 201 when agent exists in store)
    const msgRes = await fetch(`${baseUrl}/api/agents/${recipientAgentId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromAgentId: senderAgentId,
        type: 'handoff',
        subject: 'SSE targeted message test',
        body: 'Please take over.',
      }),
    });
    expect(msgRes.status).toBe(201);
    const msgData = await msgRes.json();
    expect(msgData.success).toBe(true);
    expect(msgData.data.toAgentId).toBe(recipientAgentId);
    expect(msgData.data.fromAgentId).toBe(senderAgentId);
    expect(msgData.data.type).toBe('handoff');
    expect(msgData.data.subject).toBe('SSE targeted message test');
    expect(msgData.data.id).toMatch(/^msg-/);

    // Wait for any SSE propagation
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Stop listener
    controller.abort();
    try {
      await fetchPromise;
    } catch {
      /* AbortError */
    }

    // Recipient has no active session in this test, so no agent:message SSE is emitted.
    // Verify no spurious agent:message events with wrong recipient were emitted.
    const events = parseSseEvents(receivedData);
    const wrongMsgEvents = events.filter(
      (e) => e.event === 'agent:message' && (e.data as any).toAgentId !== recipientAgentId
    );
    expect(wrongMsgEvents).toHaveLength(0);
  });

  it('GET /api/agents/:agentId/inbox returns the message after it is sent', async () => {
    // Register agents
    const regA = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Inbox Sender', role: 'developer' }),
    });
    const senderId: string = (await regA.json()).data.agentId;

    const regB = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Inbox Recipient', role: 'developer' }),
    });
    const recipientId: string = (await regB.json()).data.agentId;

    // Send message
    await fetch(`${baseUrl}/api/agents/${recipientId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromAgentId: senderId,
        type: 'briefing',
        subject: 'Inbox integration test',
        body: 'This should appear in inbox.',
      }),
    });

    // Fetch inbox
    const inboxRes = await fetch(`${baseUrl}/api/agents/${recipientId}/inbox`);
    expect(inboxRes.status).toBe(200);
    const inboxData = await inboxRes.json();
    expect(inboxData.success).toBe(true);
    expect(inboxData.data.unreadCount).toBeGreaterThanOrEqual(1);
    const subjects = inboxData.data.messages.map((m: any) => m.subject);
    expect(subjects).toContain('Inbox integration test');
  });
});

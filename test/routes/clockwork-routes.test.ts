/**
 * @fileoverview API route tests for clockwork-routes — all six endpoints.
 *
 * Uses app.inject() — no real HTTP ports opened.
 * The work-items, messages, and clockwork-webhook modules are fully mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock the work-items module (hoisted by Vitest) ────────────────────────────
vi.mock('../../src/work-items/index.js', () => ({
  createWorkItem: vi.fn(),
  getWorkItem: vi.fn(),
  listWorkItems: vi.fn(),
  updateWorkItem: vi.fn(),
  claimWorkItem: vi.fn(),
  getReadyWorkItems: vi.fn(),
  addDependency: vi.fn(),
  removeDependency: vi.fn(),
  listDependencies: vi.fn(),
  decay: vi.fn(),
}));

// ── Mock the messages module (hoisted by Vitest) ──────────────────────────────
vi.mock('../../src/messages/index.js', () => ({
  sendMessage: vi.fn(),
  getMessage: vi.fn(),
  getInbox: vi.fn(),
  markRead: vi.fn(),
  broadcastMessage: vi.fn(),
  buildHandoffContext: vi.fn(),
}));

// ── Mock the clockwork-webhook module (hoisted by Vitest) ─────────────────────
vi.mock('../../src/clockwork-webhook.js', () => ({
  deliverWebhookIfRegistered: vi.fn(),
}));

import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerClockworkRoutes } from '../../src/web/routes/clockwork-routes.js';
import { SseEvent } from '../../src/web/sse-events.js';
import { createWorkItem, getWorkItem, listWorkItems } from '../../src/work-items/index.js';
import { sendMessage, broadcastMessage } from '../../src/messages/index.js';

// Typed mock references
const mockCreateItem = vi.mocked(createWorkItem);
const mockGetItem = vi.mocked(getWorkItem);
const mockListItems = vi.mocked(listWorkItems);
const mockSendMessage = vi.mocked(sendMessage);
const mockBroadcastMessage = vi.mocked(broadcastMessage);

const VALID_TOKEN = 'test-clockwork-token';

/** Minimal WorkItem stub */
function makeItem(overrides?: Partial<{ id: string; title: string; status: string; source: string }>) {
  return {
    id: overrides?.id ?? 'wi-cw000001',
    title: overrides?.title ?? 'Clockwork task',
    description: '',
    status: overrides?.status ?? 'queued',
    source: overrides?.source ?? 'clockwork',
    assignedAgentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    worktreePath: null,
    branchName: null,
    taskMdPath: null,
    externalRef: null,
    externalUrl: null,
    metadata: {},
    compactSummary: null,
  };
}

/** Minimal AgentMessage stub */
function makeMessage(overrides?: Partial<{ id: string; toAgentId: string }>) {
  return {
    id: overrides?.id ?? 'msg-cw000001',
    fromAgentId: 'clockwork-os',
    toAgentId: overrides?.toAgentId ?? 'agent-x',
    workItemId: null,
    type: 'briefing' as const,
    subject: 'Test briefing',
    body: 'Briefing body',
    context: null,
    sentAt: '2026-01-01T00:00:00.000Z',
    readAt: null,
  };
}

/** Headers with the valid clockwork token */
function authHeaders() {
  return { 'x-clockwork-token': VALID_TOKEN };
}

describe('clockwork-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerClockworkRoutes);
    vi.clearAllMocks();

    // Configure the mock store to return a config with the clockwork token
    harness.ctx.store.getConfig.mockReturnValue({
      ralphEnabled: false,
      maxConcurrentSessions: 5,
      clockworkToken: VALID_TOKEN,
    } as any);

    // Safe defaults — override per-test as needed
    mockListItems.mockReturnValue([]);
    mockGetItem.mockReturnValue(null);
    mockCreateItem.mockReturnValue(makeItem());
    mockSendMessage.mockReturnValue(makeMessage());
    mockBroadcastMessage.mockReturnValue([]);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ── Auth — missing / wrong / valid token ──────────────────────────────────

  describe('Auth guard', () => {
    it('returns 401 when X-Clockwork-Token header is missing', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/status',
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/[Uu]nauthorized/);
    });

    it('returns 401 when X-Clockwork-Token is incorrect', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/status',
        headers: { 'x-clockwork-token': 'wrong-token-xxxx' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 when correct token is provided', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/status',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 401 when no clockworkToken is configured', async () => {
      // No token in config and no env var — verifyToken returns false
      harness.ctx.store.getConfig.mockReturnValue({
        ralphEnabled: false,
        maxConcurrentSessions: 5,
      } as any);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/status',
        headers: { 'x-clockwork-token': 'anything' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── POST /api/clockwork/work-items ────────────────────────────────────────

  describe('POST /api/clockwork/work-items', () => {
    it('returns 400 when title is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/work-items',
        headers: authHeaders(),
        payload: { description: 'No title here' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/title/i);
    });

    it('returns 201 with created item on valid payload', async () => {
      const item = makeItem({ id: 'wi-new0001', title: 'New clockwork task' });
      mockCreateItem.mockReturnValue(item);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/work-items',
        headers: authHeaders(),
        payload: { title: 'New clockwork task' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('wi-new0001');
    });

    it('broadcasts WorkItemCreated SSE after creating item', async () => {
      const item = makeItem({ id: 'wi-sse0001' });
      mockCreateItem.mockReturnValue(item);

      await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/work-items',
        headers: authHeaders(),
        payload: { title: 'SSE test task' },
      });

      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.WorkItemCreated,
        expect.objectContaining({ id: 'wi-sse0001' })
      );
    });

    it('broadcasts ClockworkWorkItemPushed SSE after creating item', async () => {
      const item = makeItem({ id: 'wi-sse0002' });
      mockCreateItem.mockReturnValue(item);

      await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/work-items',
        headers: authHeaders(),
        payload: { title: 'SSE test task 2' },
      });

      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.ClockworkWorkItemPushed,
        expect.objectContaining({ id: 'wi-sse0002' })
      );
    });

    it('passes source, externalRef and externalUrl to createWorkItem', async () => {
      mockCreateItem.mockReturnValue(makeItem());

      await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/work-items',
        headers: authHeaders(),
        payload: {
          title: 'With extras',
          source: 'github',
          externalRef: 'github:owner/repo#42',
          externalUrl: 'https://github.com/owner/repo/issues/42',
        },
      });

      expect(mockCreateItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'With extras',
          source: 'github',
          externalRef: 'github:owner/repo#42',
          externalUrl: 'https://github.com/owner/repo/issues/42',
        })
      );
    });
  });

  // ── GET /api/clockwork/status ─────────────────────────────────────────────

  describe('GET /api/clockwork/status', () => {
    it('returns success with zero counts when board is empty', async () => {
      mockListItems.mockReturnValue([]);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/status',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.workItems.total).toBe(0);
      expect(body.data.workItems.byStatus).toEqual({});
    });

    it('returns correct counts grouped by status', async () => {
      mockListItems.mockReturnValue([
        makeItem({ status: 'queued' }),
        makeItem({ id: 'wi-2', status: 'queued' }),
        makeItem({ id: 'wi-3', status: 'in_progress' }),
      ]);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/status',
        headers: authHeaders(),
      });
      const body = JSON.parse(res.body);
      expect(body.data.workItems.total).toBe(3);
      expect(body.data.workItems.byStatus.queued).toBe(2);
      expect(body.data.workItems.byStatus.in_progress).toBe(1);
    });

    it('includes agents summary in response', async () => {
      harness.ctx.store.setAgent({
        agentId: 'agent-1',
        displayName: 'Agent One',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/status',
        headers: authHeaders(),
      });
      const body = JSON.parse(res.body);
      expect(body.data.agents.total).toBe(1);
      expect(body.data.agents).toHaveProperty('active');
      expect(body.data.agents).toHaveProperty('activeAgents');
    });
  });

  // ── POST /api/clockwork/broadcast ─────────────────────────────────────────

  describe('POST /api/clockwork/broadcast', () => {
    it('returns 400 when subject is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/broadcast',
        headers: authHeaders(),
        payload: { body: 'Hello agents' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/subject/i);
    });

    it('returns 400 when body field is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/broadcast',
        headers: authHeaders(),
        payload: { subject: 'Heads up' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/body/i);
    });

    it('returns 201 with sent messages and broadcasts AgentBroadcast SSE', async () => {
      const msgs = [
        makeMessage({ id: 'msg-1', toAgentId: 'agent-a' }),
        makeMessage({ id: 'msg-2', toAgentId: 'agent-b' }),
      ];
      mockBroadcastMessage.mockReturnValue(msgs);

      harness.ctx.store.setAgent({
        agentId: 'agent-a',
        displayName: 'A',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/broadcast',
        headers: authHeaders(),
        payload: { subject: 'Team update', body: 'All hands on deck.' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);

      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.AgentBroadcast,
        expect.objectContaining({ fromAgentId: 'clockwork-os' })
      );
    });

    it('calls broadcastMessage with fromAgentId=clockwork-os and all agent IDs', async () => {
      mockBroadcastMessage.mockReturnValue([]);
      harness.ctx.store.setAgent({
        agentId: 'agent-x',
        displayName: 'X',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);
      harness.ctx.store.setAgent({
        agentId: 'agent-y',
        displayName: 'Y',
        role: 'orchestrator',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/broadcast',
        headers: authHeaders(),
        payload: { subject: 'S', body: 'B' },
      });

      expect(mockBroadcastMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          fromAgentId: 'clockwork-os',
          recipientAgentIds: expect.arrayContaining(['agent-x', 'agent-y']),
        })
      );
    });
  });

  // ── POST /api/clockwork/agents/:id/briefing ───────────────────────────────

  describe('POST /api/clockwork/agents/:id/briefing', () => {
    it('returns 404 when agent does not exist', async () => {
      // No agent registered — getAgent returns undefined
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/agents/ghost-agent/briefing',
        headers: authHeaders(),
        payload: { subject: 'Brief', body: 'Body text' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/[Aa]gent not found/);
    });

    it('returns 400 when subject is missing', async () => {
      harness.ctx.store.setAgent({
        agentId: 'agent-z',
        displayName: 'Z',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/agents/agent-z/briefing',
        headers: authHeaders(),
        payload: { body: 'No subject here' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/subject/i);
    });

    it('returns 400 when body is missing', async () => {
      harness.ctx.store.setAgent({
        agentId: 'agent-z',
        displayName: 'Z',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/agents/agent-z/briefing',
        headers: authHeaders(),
        payload: { subject: 'No body here' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/body/i);
    });

    it('returns 201 with message and calls sendMessage with briefing type', async () => {
      const msg = makeMessage({ id: 'msg-brief01', toAgentId: 'agent-p' });
      mockSendMessage.mockReturnValue(msg);
      harness.ctx.store.setAgent({
        agentId: 'agent-p',
        displayName: 'P',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/agents/agent-p/briefing',
        headers: authHeaders(),
        payload: { subject: 'Your mission', body: 'Fix the bug.' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('msg-brief01');

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          fromAgentId: 'clockwork-os',
          toAgentId: 'agent-p',
          type: 'briefing',
          subject: 'Your mission',
        })
      );
    });

    it('broadcasts ClockworkBriefingSent SSE when recipient has active session', async () => {
      const msg = makeMessage({ id: 'msg-brief02', toAgentId: 'agent-q' });
      mockSendMessage.mockReturnValue(msg);
      harness.ctx.store.setAgent({
        agentId: 'agent-q',
        displayName: 'Q',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      // Inject a session for this agent
      const sessions = harness.ctx.store.getSessions() as Record<string, unknown>;
      sessions['sess-q-001'] = { agentProfile: { agentId: 'agent-q' } };

      await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/agents/agent-q/briefing',
        headers: authHeaders(),
        payload: { subject: 'Mission briefing', body: 'Details here.' },
      });

      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.ClockworkBriefingSent,
        expect.objectContaining({ sessionId: 'sess-q-001', agentId: 'agent-q' })
      );
    });
  });

  // ── POST /api/clockwork/webhook ────────────────────────────────────────────

  describe('POST /api/clockwork/webhook', () => {
    it('returns 400 when url is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/webhook',
        headers: authHeaders(),
        payload: { secret: 'abc' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/url/i);
    });

    it('returns 200 and stores webhook when valid url is provided', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/webhook',
        headers: authHeaders(),
        payload: { url: 'https://clockwork.example.com/webhook' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.url).toBe('https://clockwork.example.com/webhook');
      expect(body.data.registered).toBe(true);

      expect(harness.ctx.store.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          clockworkWebhook: expect.objectContaining({ url: 'https://clockwork.example.com/webhook' }),
        })
      );
    });

    it('stores secret when provided with url', async () => {
      await harness.app.inject({
        method: 'POST',
        url: '/api/clockwork/webhook',
        headers: authHeaders(),
        payload: { url: 'https://clockwork.example.com/wh', secret: 'supersecret' },
      });

      expect(harness.ctx.store.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          clockworkWebhook: expect.objectContaining({ secret: 'supersecret' }),
        })
      );
    });
  });

  // ── GET /api/clockwork/work-items/:id/suggest-agent ───────────────────────

  describe('GET /api/clockwork/work-items/:id/suggest-agent', () => {
    it('returns 404 for unknown work item id', async () => {
      mockGetItem.mockReturnValue(null);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/work-items/wi-ghost/suggest-agent',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/[Ww]ork item not found/);
    });

    it('returns ranked suggestions list with workItemId and suggestions array', async () => {
      const item = makeItem({ id: 'wi-suggest01', source: 'manual' });
      mockGetItem.mockReturnValue(item);
      harness.ctx.store.setAgent({
        agentId: 'agent-dev',
        displayName: 'Dev',
        role: 'developer',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/work-items/wi-suggest01/suggest-agent',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.workItemId).toBe('wi-suggest01');
      expect(Array.isArray(body.data.suggestions)).toBe(true);
      expect(body.data.suggestions.length).toBeGreaterThan(0);
      expect(body.data.suggestions[0]).toHaveProperty('agentId');
      expect(body.data.suggestions[0]).toHaveProperty('score');
      expect(body.data.suggestions[0]).toHaveProperty('reasons');
    });

    it('boosts codeman-dev role score when work item source is github', async () => {
      const item = makeItem({ id: 'wi-github01', source: 'github' });
      mockGetItem.mockReturnValue(item);
      harness.ctx.store.setAgent({
        agentId: 'agent-codeman',
        displayName: 'Codeman Dev',
        role: 'codeman-dev',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);
      harness.ctx.store.setAgent({
        agentId: 'agent-orch',
        displayName: 'Orchestrator',
        role: 'orchestrator',
        vaultPath: '/tmp',
        capabilities: [],
        decay: {},
      } as any);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/work-items/wi-github01/suggest-agent',
        headers: authHeaders(),
      });
      const body = JSON.parse(res.body);
      const suggestions: Array<{ agentId: string; score: number }> = body.data.suggestions;
      const codemanScore = suggestions.find((s) => s.agentId === 'agent-codeman')?.score ?? 0;
      const orchScore = suggestions.find((s) => s.agentId === 'agent-orch')?.score ?? 0;
      // codeman-dev gets +2 boost for github source
      expect(codemanScore).toBeGreaterThan(orchScore);
    });

    it('returns empty suggestions array when no agents are registered', async () => {
      const item = makeItem({ id: 'wi-noagents' });
      mockGetItem.mockReturnValue(item);
      // No agents registered

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/clockwork/work-items/wi-noagents/suggest-agent',
        headers: authHeaders(),
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.suggestions).toEqual([]);
    });
  });
});

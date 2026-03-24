/**
 * @fileoverview Tests for PATCH /api/sessions/:id/agent route.
 *
 * Tests the session-agent linking/unlinking route added in feat/agent-management-ui.
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { SseEvent } from '../../src/web/sse-events.js';

const MOCK_AGENT: Record<string, unknown> = {
  agentId: 'agent-abc',
  role: 'codeman-dev',
  displayName: 'Dev Agent',
  vaultPath: '/home/user/.codeman/vaults/agent-abc',
  capabilities: [],
  notesSinceConsolidation: 0,
  decay: { notesTtlDays: 90, patternsTtlDays: 365 },
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('PATCH /api/sessions/:id/agent', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);

    // Make store.getSession return the session state so the route can read/mutate it
    harness.ctx.store.getSession.mockReturnValue(harness.ctx._session.toState());
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ─── Test 1: Links agent to session ──────────────────────────────────────

  it('links agent to session — returns 200 with success: true', async () => {
    harness.ctx.store.getAgent.mockReturnValue(MOCK_AGENT);

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/sessions/${harness.ctx._sessionId}/agent`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-abc' }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // store.setSession should have been called with the agentProfile attached
    expect(harness.ctx.store.setSession).toHaveBeenCalledOnce();
    const [, newState] = harness.ctx.store.setSession.mock.calls[0] as [string, Record<string, unknown>];
    expect(newState.agentProfile).toMatchObject({ agentId: 'agent-abc', displayName: 'Dev Agent' });
  });

  // ─── Test 2: Unlinks with agentId: null ──────────────────────────────────

  it('unlinks agent when agentId is null — returns 200 and removes agentProfile', async () => {
    // Set up a session state that already has an agentProfile attached
    harness.ctx.store.getSession.mockReturnValue({
      ...harness.ctx._session.toState(),
      agentProfile: MOCK_AGENT,
    });

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/sessions/${harness.ctx._sessionId}/agent`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: null }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // store.setSession should have been called without agentProfile
    expect(harness.ctx.store.setSession).toHaveBeenCalledOnce();
    const [, newState] = harness.ctx.store.setSession.mock.calls[0] as [string, Record<string, unknown>];
    expect(newState).not.toHaveProperty('agentProfile');
  });

  // ─── Test 3: Returns 404 for unknown sessionId ───────────────────────────

  it('returns 404 for unknown sessionId', async () => {
    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/sessions/nonexistent-session-id/agent',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-abc' }),
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
  });

  // ─── Test 4: Returns 404 for unknown agentId ─────────────────────────────

  it('returns 404 when agentId is non-null but agent does not exist', async () => {
    // getAgent returns undefined — agent not found
    harness.ctx.store.getAgent.mockReturnValue(undefined);

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `/api/sessions/${harness.ctx._sessionId}/agent`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'unknown-agent-id' }),
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/agent/i);
  });

  // ─── Test 5: Broadcasts SessionUpdated SSE event ─────────────────────────

  it('broadcasts SessionUpdated SSE event after linking', async () => {
    harness.ctx.store.getAgent.mockReturnValue(MOCK_AGENT);

    await harness.app.inject({
      method: 'PATCH',
      url: `/api/sessions/${harness.ctx._sessionId}/agent`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-abc' }),
    });

    expect(harness.ctx.broadcast).toHaveBeenCalledWith(SseEvent.SessionUpdated, expect.anything());
  });
});

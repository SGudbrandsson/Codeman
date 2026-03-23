/**
 * @fileoverview Tests for agent-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerAgentRoutes } from '../../src/web/routes/agent-routes.js';
import { SseEvent } from '../../src/web/sse-events.js';

describe('agent-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerAgentRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/agents ==========

  describe('GET /api/agents', () => {
    it('returns empty array by default', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns list when agents exist', async () => {
      const mockAgents = [
        {
          agentId: 'agent-1',
          role: 'codeman-dev',
          displayName: 'Dev Agent',
          vaultPath: '/home/user/.codeman/vaults/agent-1',
          capabilities: [],
          notesSinceConsolidation: 0,
          decay: { notesTtlDays: 90, patternsTtlDays: 365 },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          agentId: 'agent-2',
          role: 'orchestrator',
          displayName: 'Orchestrator',
          vaultPath: '/home/user/.codeman/vaults/agent-2',
          capabilities: [],
          notesSinceConsolidation: 0,
          decay: { notesTtlDays: 90, patternsTtlDays: 365 },
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ];
      harness.ctx.store.listAgents.mockReturnValue(mockAgents);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].agentId).toBe('agent-1');
      expect(body.data[1].displayName).toBe('Orchestrator');
    });
  });

  // ========== GET /api/agents/:agentId ==========

  describe('GET /api/agents/:agentId', () => {
    it('returns 404 for unknown agentId', async () => {
      harness.ctx.store.getAgent.mockReturnValue(undefined);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/unknown-id',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns profile for known agentId', async () => {
      const mockProfile = {
        agentId: 'agent-1',
        role: 'codeman-dev',
        displayName: 'Dev Agent',
        vaultPath: '/home/user/.codeman/vaults/agent-1',
        capabilities: [],
        notesSinceConsolidation: 0,
        decay: { notesTtlDays: 90, patternsTtlDays: 365 },
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      harness.ctx.store.getAgent.mockReturnValue(mockProfile);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/agent-1',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.agentId).toBe('agent-1');
      expect(body.data.displayName).toBe('Dev Agent');
    });
  });

  // ========== POST /api/agents ==========

  describe('POST /api/agents', () => {
    it('creates profile with valid role and displayName, broadcasts AgentCreated, returns 201', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'codeman-dev', displayName: 'My Dev Agent' }),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.role).toBe('codeman-dev');
      expect(body.data.displayName).toBe('My Dev Agent');
      expect(body.data.agentId).toBeDefined();
      expect(body.data.createdAt).toBeDefined();

      // Should have called setAgent and broadcast
      expect(harness.ctx.store.setAgent).toHaveBeenCalledOnce();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.AgentCreated,
        expect.objectContaining({
          role: 'codeman-dev',
          displayName: 'My Dev Agent',
        })
      );
    });

    it('returns 400 when role is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'No Role Agent' }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns 400 when displayName is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'orchestrator' }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== PATCH /api/agents/:agentId ==========

  describe('PATCH /api/agents/:agentId', () => {
    it('updates displayName for known agentId', async () => {
      const existingProfile = {
        agentId: 'agent-1',
        role: 'codeman-dev',
        displayName: 'Old Name',
        vaultPath: '/home/user/.codeman/vaults/agent-1',
        capabilities: [],
        notesSinceConsolidation: 0,
        decay: { notesTtlDays: 90, patternsTtlDays: 365 },
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      harness.ctx.store.getAgent.mockReturnValue(existingProfile);

      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/agents/agent-1',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'New Name' }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.displayName).toBe('New Name');
      expect(body.data.agentId).toBe('agent-1');
      expect(harness.ctx.store.setAgent).toHaveBeenCalledOnce();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.AgentUpdated,
        expect.objectContaining({
          agentId: 'agent-1',
          displayName: 'New Name',
        })
      );
    });

    it('returns 404 for unknown agentId', async () => {
      harness.ctx.store.getAgent.mockReturnValue(undefined);

      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/agents/unknown-id',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'New Name' }),
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== DELETE /api/agents/:agentId ==========

  describe('DELETE /api/agents/:agentId', () => {
    it('removes profile and calls removeAgent for known agentId', async () => {
      const existingProfile = {
        agentId: 'agent-1',
        role: 'codeman-dev',
        displayName: 'Dev Agent',
        vaultPath: '/home/user/.codeman/vaults/agent-1',
        capabilities: [],
        notesSinceConsolidation: 0,
        decay: { notesTtlDays: 90, patternsTtlDays: 365 },
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      harness.ctx.store.getAgent.mockReturnValue(existingProfile);
      harness.ctx.store.getSessions.mockReturnValue({});

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/agents/agent-1',
      });

      expect(res.statusCode).toBe(204);
      expect(harness.ctx.store.removeAgent).toHaveBeenCalledWith('agent-1');
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(SseEvent.AgentDeleted, { agentId: 'agent-1' });
    });

    it('returns 404 for unknown agentId', async () => {
      harness.ctx.store.getAgent.mockReturnValue(undefined);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/agents/unknown-id',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });
});

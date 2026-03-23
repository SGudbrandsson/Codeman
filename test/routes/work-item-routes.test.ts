/**
 * @fileoverview API route tests for work-item-routes — all 8 endpoints.
 *
 * Uses app.inject() — no real HTTP ports opened.
 * The work-items store is fully mocked via vi.mock so route logic is tested
 * in isolation from SQLite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock the work-items module (hoisted by Vitest) ───────────────────────────
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

import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerWorkItemRoutes } from '../../src/web/routes/work-item-routes.js';
import { SseEvent } from '../../src/web/sse-events.js';
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  claimWorkItem,
  getReadyWorkItems,
  addDependency,
  removeDependency,
} from '../../src/work-items/index.js';

// Typed mock references
const mockCreate = vi.mocked(createWorkItem);
const mockGet = vi.mocked(getWorkItem);
const mockList = vi.mocked(listWorkItems);
const mockUpdate = vi.mocked(updateWorkItem);
const mockClaim = vi.mocked(claimWorkItem);
const mockReady = vi.mocked(getReadyWorkItems);
const mockAddDep = vi.mocked(addDependency);
const mockRemoveDep = vi.mocked(removeDependency);

/** Minimal WorkItem stub for test responses */
function makeItem(
  overrides?: Partial<{
    id: string;
    title: string;
    status: string;
    assignedAgentId: string | null;
  }>
) {
  return {
    id: overrides?.id ?? 'wi-abcdef01',
    title: overrides?.title ?? 'Test task',
    description: '',
    status: overrides?.status ?? 'queued',
    source: 'manual',
    assignedAgentId: overrides?.assignedAgentId ?? null,
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

describe('work-item-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerWorkItemRoutes);
    vi.clearAllMocks();

    // Safe defaults — override per-test as needed
    mockList.mockReturnValue([]);
    mockReady.mockReturnValue([]);
    mockGet.mockReturnValue(null);
    mockCreate.mockReturnValue(makeItem());
    mockUpdate.mockReturnValue(null);
    mockClaim.mockReturnValue(null);
    mockAddDep.mockReturnValue({
      fromId: 'wi-aaa',
      toId: 'wi-bbb',
      type: 'blocks',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    mockRemoveDep.mockReturnValue(false);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ── GET /api/work-items ────────────────────────────────────────────────────

  describe('GET /api/work-items', () => {
    it('returns { success: true, data: [] } with empty store', async () => {
      mockList.mockReturnValue([]);
      const res = await harness.app.inject({ method: 'GET', url: '/api/work-items' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns items from listWorkItems', async () => {
      const items = [makeItem({ id: 'wi-00000001', title: 'First' }), makeItem({ id: 'wi-00000002', title: 'Second' })];
      mockList.mockReturnValue(items);

      const res = await harness.app.inject({ method: 'GET', url: '/api/work-items' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(2);
    });

    it('passes status query param to listWorkItems', async () => {
      await harness.app.inject({ method: 'GET', url: '/api/work-items?status=done' });
      expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
    });

    it('passes agentId query param to listWorkItems', async () => {
      await harness.app.inject({ method: 'GET', url: '/api/work-items?agentId=agent-42' });
      expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-42' }));
    });
  });

  // ── GET /api/work-items/ready ──────────────────────────────────────────────

  describe('GET /api/work-items/ready', () => {
    it('returns ready items list', async () => {
      const items = [makeItem({ id: 'wi-ready01' })];
      mockReady.mockReturnValue(items);

      const res = await harness.app.inject({ method: 'GET', url: '/api/work-items/ready' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('wi-ready01');
    });

    it('/ready is NOT captured by the /:id param (regression guard)', async () => {
      mockReady.mockReturnValue([]);
      const res = await harness.app.inject({ method: 'GET', url: '/api/work-items/ready' });
      // If /ready were captured by /:id, getWorkItem would be called instead of getReadyWorkItems
      expect(mockReady).toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });
  });

  // ── POST /api/work-items ───────────────────────────────────────────────────

  describe('POST /api/work-items', () => {
    it('returns 400 when title is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items',
        payload: { description: 'No title' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/title/i);
    });

    it('returns 201 with created item and broadcasts WorkItemCreated SSE', async () => {
      const item = makeItem({ id: 'wi-new0001', title: 'New task' });
      mockCreate.mockReturnValue(item);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items',
        payload: { title: 'New task' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('wi-new0001');

      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.WorkItemCreated,
        expect.objectContaining({ id: 'wi-new0001' })
      );
    });
  });

  // ── GET /api/work-items/:id ────────────────────────────────────────────────

  describe('GET /api/work-items/:id', () => {
    it('returns 404 for unknown id', async () => {
      mockGet.mockReturnValue(null);
      const res = await harness.app.inject({ method: 'GET', url: '/api/work-items/wi-notfound' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns 200 with item for known id', async () => {
      const item = makeItem({ id: 'wi-known001' });
      mockGet.mockReturnValue(item);

      const res = await harness.app.inject({ method: 'GET', url: '/api/work-items/wi-known001' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('wi-known001');
    });
  });

  // ── PATCH /api/work-items/:id ──────────────────────────────────────────────

  describe('PATCH /api/work-items/:id', () => {
    it('returns 404 for unknown id', async () => {
      mockUpdate.mockReturnValue(null);

      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/work-items/wi-ghost',
        payload: { title: 'Updated' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns 200 with updated item and broadcasts WorkItemUpdated + WorkItemStatusChanged', async () => {
      const item = makeItem({ id: 'wi-upd0001', status: 'in_progress' });
      mockUpdate.mockReturnValue(item);

      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/work-items/wi-upd0001',
        payload: { status: 'in_progress' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('wi-upd0001');

      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.WorkItemUpdated,
        expect.objectContaining({ id: 'wi-upd0001' })
      );
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.WorkItemStatusChanged,
        expect.objectContaining({ id: 'wi-upd0001' })
      );
    });
  });

  // ── POST /api/work-items/:id/claim ────────────────────────────────────────

  describe('POST /api/work-items/:id/claim', () => {
    it('returns 400 when agentId is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items/wi-abcdef01/claim',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/agentId/i);
    });

    it('returns 404 when item is not found', async () => {
      mockGet.mockReturnValue(null);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items/wi-ghost/claim',
        payload: { agentId: 'agent-1' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns 409 when claimWorkItem returns null (already claimed)', async () => {
      mockGet.mockReturnValue(makeItem({ id: 'wi-claimed' }));
      mockClaim.mockReturnValue(null);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items/wi-claimed/claim',
        payload: { agentId: 'agent-2' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/[Aa]lready claimed/);
    });

    it('returns 200 on success and broadcasts WorkItemClaimed + WorkItemStatusChanged', async () => {
      const existing = makeItem({ id: 'wi-claimme' });
      const claimed = makeItem({ id: 'wi-claimme', status: 'assigned', assignedAgentId: 'agent-7' });
      mockGet.mockReturnValue(existing);
      mockClaim.mockReturnValue(claimed);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items/wi-claimme/claim',
        payload: { agentId: 'agent-7' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.assignedAgentId).toBe('agent-7');

      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.WorkItemClaimed,
        expect.objectContaining({ id: 'wi-claimme' })
      );
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        SseEvent.WorkItemStatusChanged,
        expect.objectContaining({ id: 'wi-claimme' })
      );
    });
  });

  // ── POST /api/work-items/:id/dependencies ─────────────────────────────────

  describe('POST /api/work-items/:id/dependencies', () => {
    it('returns 400 when dependsOnId is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items/wi-abcdef01/dependencies',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/dependsOnId/i);
    });

    it('returns 404 when target item (id) is not found', async () => {
      mockGet.mockReturnValue(null); // first getWorkItem call (target) returns null

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items/wi-ghost/dependencies',
        payload: { dependsOnId: 'wi-blocker1' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when blocker item (dependsOnId) is not found', async () => {
      mockGet
        .mockReturnValueOnce(makeItem({ id: 'wi-target' })) // target exists
        .mockReturnValueOnce(null); // blocker does not exist

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items/wi-target/dependencies',
        payload: { dependsOnId: 'wi-ghostblocker' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/[Bb]locker/);
    });

    it('returns 400 when addDependency throws (circular dependency)', async () => {
      mockGet.mockReturnValueOnce(makeItem({ id: 'wi-a' })).mockReturnValueOnce(makeItem({ id: 'wi-b' }));
      mockAddDep.mockImplementation(() => {
        throw new Error('Circular dependency detected');
      });

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items/wi-a/dependencies',
        payload: { dependsOnId: 'wi-b' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/[Cc]ircular/);
    });

    it('returns 200 with dependency object on success', async () => {
      const dep = {
        fromId: 'wi-blocker',
        toId: 'wi-target',
        type: 'blocks' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      mockGet.mockReturnValueOnce(makeItem({ id: 'wi-target' })).mockReturnValueOnce(makeItem({ id: 'wi-blocker' }));
      mockAddDep.mockReturnValue(dep);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/work-items/wi-target/dependencies',
        payload: { dependsOnId: 'wi-blocker' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.fromId).toBe('wi-blocker');
      expect(body.data.toId).toBe('wi-target');
    });
  });

  // ── DELETE /api/work-items/:id/dependencies/:depId ────────────────────────

  describe('DELETE /api/work-items/:id/dependencies/:depId', () => {
    it('returns 404 when the dependency edge does not exist', async () => {
      mockRemoveDep.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/work-items/wi-target/dependencies/wi-blocker',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns 200 on successful removal', async () => {
      mockRemoveDep.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/work-items/wi-target/dependencies/wi-blocker',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);

      // Verify correct edge direction passed to removeDependency (depId blocks id)
      expect(mockRemoveDep).toHaveBeenCalledWith('wi-blocker', 'wi-target');
    });
  });
});

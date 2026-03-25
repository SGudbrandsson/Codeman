/**
 * @fileoverview API route tests for orchestrator-routes — all 4 endpoints.
 *
 * Uses app.inject() — no real HTTP ports opened.
 * The orchestrator singleton and work-items store are fully mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock the orchestrator singleton ──────────────────────────────────────────
const mockGetStatus = vi.fn();
const mockSelectAgent = vi.fn();
const mockDispatchWorkItem = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();

vi.mock('../../src/orchestrator.js', () => ({
  getOrchestrator: vi.fn(() => ({
    getStatus: mockGetStatus,
    selectAgent: mockSelectAgent,
    dispatchWorkItem: mockDispatchWorkItem,
    start: mockStart,
    stop: mockStop,
  })),
  initOrchestrator: vi.fn(),
}));

// ── Mock the work-items module ───────────────────────────────────────────────
vi.mock('../../src/work-items/index.js', () => ({
  getWorkItem: vi.fn(),
  createWorkItem: vi.fn(),
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
import { registerOrchestratorRoutes } from '../../src/web/routes/orchestrator-routes.js';
import { getOrchestrator } from '../../src/orchestrator.js';
import { getWorkItem } from '../../src/work-items/index.js';

const mockGetOrchestrator = vi.mocked(getOrchestrator);
const mockGetWorkItem = vi.mocked(getWorkItem);

describe('orchestrator-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerOrchestratorRoutes);
    vi.clearAllMocks();

    // Default: orchestrator exists
    mockGetOrchestrator.mockReturnValue({
      getStatus: mockGetStatus,
      selectAgent: mockSelectAgent,
      dispatchWorkItem: mockDispatchWorkItem,
      start: mockStart,
      stop: mockStop,
    } as never);

    mockGetStatus.mockReturnValue({
      mode: 'hybrid',
      activeCases: [],
      activeDispatches: 0,
      lastActionAt: null,
      recentDecisions: [],
    });
  });

  // ── GET /api/orchestrator/status ─────────────────────────────────────────

  describe('GET /api/orchestrator/status', () => {
    it('returns orchestrator status when running', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/orchestrator/status',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.mode).toBe('hybrid');
    });

    it('returns disabled status when orchestrator is null', async () => {
      mockGetOrchestrator.mockReturnValue(null);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/orchestrator/status',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.mode).toBe('disabled');
    });

    it('returns full fallback shape with running: false and config when orchestrator is null', async () => {
      mockGetOrchestrator.mockReturnValue(null);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/orchestrator/status',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.running).toBe(false);
      expect(body.data.config).toBeDefined();
      expect(body.data.config.pollIntervalMs).toBe(30000);
      expect(body.data.config.mode).toBe('hybrid');
      expect(body.data.config.maxConcurrentDispatches).toBe(5);
    });
  });

  // ── POST /api/orchestrator/toggle ────────────────────────────────────────

  describe('POST /api/orchestrator/toggle', () => {
    it('returns 400 when caseId is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/toggle',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.success).toBe(false);
    });

    it('returns 400 when enabled is not boolean', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/toggle',
        payload: { caseId: 'test-case', enabled: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when case not found (not native and not linked)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/toggle',
        payload: { caseId: 'nonexistent-case', enabled: true },
      });
      // Will be 404 because the case doesn't exist as native or linked
      expect(res.statusCode).toBe(404);
    });
  });

  // ── PATCH /api/orchestrator/config ───────────────────────────────────────

  describe('PATCH /api/orchestrator/config', () => {
    it('updates orchestrator config via store.setConfig', async () => {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/orchestrator/config',
        payload: { pollIntervalMs: 60000 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(harness.ctx.store.setConfig).toHaveBeenCalledTimes(1);
    });

    it('rejects negative pollIntervalMs', async () => {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/orchestrator/config',
        payload: { pollIntervalMs: -1000 },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('pollIntervalMs');
    });

    it('rejects non-integer maxConcurrentDispatches', async () => {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/orchestrator/config',
        payload: { maxConcurrentDispatches: 2.5 },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain('maxConcurrentDispatches');
    });

    it('rejects invalid mode value', async () => {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/orchestrator/config',
        payload: { mode: 'turbo' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain('mode');
    });

    it('accepts valid mode value', async () => {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/orchestrator/config',
        payload: { mode: 'autonomous' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('rejects zero-valued numeric fields', async () => {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/orchestrator/config',
        payload: { stallThresholdMs: 0 },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain('stallThresholdMs');
    });
  });

  // ── POST /api/orchestrator/dispatch ──────────────────────────────────────

  describe('POST /api/orchestrator/dispatch', () => {
    it('returns 400 when workItemId is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/dispatch',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.success).toBe(false);
    });

    it('returns 503 when orchestrator is null', async () => {
      mockGetOrchestrator.mockReturnValue(null);
      mockGetWorkItem.mockReturnValue({
        id: 'wi-12345678',
        status: 'queued',
        caseId: 'test',
      } as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/dispatch',
        payload: { workItemId: 'wi-12345678' },
      });
      expect(res.statusCode).toBe(503);
    });

    it('returns 404 when work item not found', async () => {
      mockGetWorkItem.mockReturnValue(null);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/dispatch',
        payload: { workItemId: 'wi-nonexist' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when work item is not queued', async () => {
      mockGetWorkItem.mockReturnValue({
        id: 'wi-12345678',
        status: 'in_progress',
        caseId: 'test',
      } as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/dispatch',
        payload: { workItemId: 'wi-12345678' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain('in_progress');
    });

    it('dispatches with explicit agentId when provided and agent exists', async () => {
      mockGetWorkItem.mockReturnValue({
        id: 'wi-12345678',
        status: 'queued',
        caseId: 'test',
      } as never);
      mockDispatchWorkItem.mockResolvedValue(undefined);
      (harness.ctx.store.getAgent as ReturnType<typeof vi.fn>).mockReturnValue({ agentId: 'agent-1' });

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/dispatch',
        payload: { workItemId: 'wi-12345678', agentId: 'agent-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(mockDispatchWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wi-12345678' }),
        'agent-1',
        'explicit',
        'Manual dispatch'
      );
    });

    it('returns 404 when explicit agentId does not exist', async () => {
      mockGetWorkItem.mockReturnValue({
        id: 'wi-12345678',
        status: 'queued',
        caseId: 'test',
      } as never);
      (harness.ctx.store.getAgent as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/dispatch',
        payload: { workItemId: 'wi-12345678', agentId: 'ghost-agent' },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toContain('ghost-agent');
      expect(mockDispatchWorkItem).not.toHaveBeenCalled();
    });

    it('uses selectAgent when agentId not provided', async () => {
      mockGetWorkItem.mockReturnValue({
        id: 'wi-12345678',
        status: 'queued',
        caseId: 'test',
      } as never);
      mockSelectAgent.mockResolvedValue({
        agentId: 'agent-auto',
        method: 'mechanical',
        reasoning: 'Best match',
      });
      mockDispatchWorkItem.mockResolvedValue(undefined);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/dispatch',
        payload: { workItemId: 'wi-12345678' },
      });
      expect(res.statusCode).toBe(200);
      expect(mockSelectAgent).toHaveBeenCalled();
      expect(mockDispatchWorkItem).toHaveBeenCalled();
    });

    it('returns 400 when no agent available for dispatch', async () => {
      mockGetWorkItem.mockReturnValue({
        id: 'wi-12345678',
        status: 'queued',
        caseId: 'test',
      } as never);
      mockSelectAgent.mockResolvedValue(null);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/dispatch',
        payload: { workItemId: 'wi-12345678' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain('No agent available');
    });
  });

  // ── POST /api/orchestrator/start ────────────────────────────────────────

  describe('POST /api/orchestrator/start', () => {
    it('starts orchestrator and returns status', async () => {
      mockGetStatus.mockReturnValue({
        running: true,
        mode: 'hybrid',
        activeCases: [],
        activeDispatches: 0,
        lastActionAt: null,
        recentDecisions: [],
        config: { pollIntervalMs: 30000, mode: 'hybrid' },
      });

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/start',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.running).toBe(true);
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it('returns 503 when orchestrator is null', async () => {
      mockGetOrchestrator.mockReturnValue(null);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/start',
      });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('not available');
    });
  });

  // ── POST /api/orchestrator/stop ─────────────────────────────────────────

  describe('POST /api/orchestrator/stop', () => {
    it('stops orchestrator and returns status', async () => {
      mockGetStatus.mockReturnValue({
        running: false,
        mode: 'hybrid',
        activeCases: [],
        activeDispatches: 0,
        lastActionAt: null,
        recentDecisions: [],
        config: { pollIntervalMs: 30000, mode: 'hybrid' },
      });

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/stop',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.running).toBe(false);
      expect(mockStop).toHaveBeenCalledTimes(1);
    });

    it('returns 503 when orchestrator is null', async () => {
      mockGetOrchestrator.mockReturnValue(null);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/orchestrator/stop',
      });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('not available');
    });
  });
});

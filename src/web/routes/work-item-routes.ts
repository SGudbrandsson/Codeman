/**
 * @fileoverview Work item graph REST routes.
 *
 * Routes:
 *   GET    /api/work-items              — list all (filters: status, agentId)
 *   GET    /api/work-items/ready        — unblocked items available for assignment
 *   POST   /api/work-items              — create work item
 *   GET    /api/work-items/:id          — get by ID
 *   PATCH  /api/work-items/:id          — update status/fields
 *   POST   /api/work-items/:id/claim    — atomic claim by agentId (409 on conflict)
 *   POST   /api/work-items/:id/dependencies        — add dependency
 *   DELETE /api/work-items/:id/dependencies/:depId — remove dependency
 *
 * IMPORTANT: GET /api/work-items/ready is registered BEFORE GET /api/work-items/:id
 * to prevent Fastify from capturing 'ready' as an ID param.
 */

import { FastifyInstance } from 'fastify';
import type { EventPort } from '../ports/event-port.js';
import type { ConfigPort } from '../ports/config-port.js';
import { SseEvent } from '../sse-events.js';
import { getOrchestrator } from '../../orchestrator.js';
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  claimWorkItem,
  getReadyWorkItems,
  addDependency,
  removeDependency,
  deleteWorkItem,
} from '../../work-items/index.js';
import type { WorkItemSource, WorkItemStatus } from '../../work-items/index.js';
import { deliverWebhookIfRegistered } from '../../clockwork-webhook.js';

type WorkItemRoutesCtx = EventPort & ConfigPort;

export function registerWorkItemRoutes(app: FastifyInstance, ctx: WorkItemRoutesCtx): void {
  // ── GET /api/work-items ───────────────────────────────────────────────────
  app.get('/api/work-items', async (req) => {
    const query = req.query as { status?: string; agentId?: string };
    const items = listWorkItems({
      status: query.status as WorkItemStatus | undefined,
      agentId: query.agentId,
    });
    return { success: true, data: items };
  });

  // ── GET /api/work-items/ready ─────────────────────────────────────────────
  // MUST be registered before /:id to avoid 'ready' being treated as an ID param.
  app.get('/api/work-items/ready', async () => {
    const items = getReadyWorkItems();
    return { success: true, data: items };
  });

  // ── POST /api/work-items ──────────────────────────────────────────────────
  app.post('/api/work-items', async (req, reply) => {
    const body = req.body as {
      title?: string;
      description?: string;
      source?: WorkItemSource;
      metadata?: Record<string, unknown>;
      externalRef?: string;
      externalUrl?: string;
      caseId?: string;
    };

    if (!body.title) {
      reply.code(400);
      return { success: false, error: 'title is required' };
    }

    const item = createWorkItem({
      title: body.title,
      description: body.description,
      source: body.source,
      metadata: body.metadata,
      externalRef: body.externalRef,
      externalUrl: body.externalUrl,
      caseId: body.caseId,
    });

    ctx.broadcast(SseEvent.WorkItemCreated, item);
    getOrchestrator()?.triggerTick();

    reply.code(201);
    return { success: true, data: item };
  });

  // ── GET /api/work-items/:id ───────────────────────────────────────────────
  app.get('/api/work-items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = getWorkItem(id);
    if (!item) {
      reply.code(404);
      return { success: false, error: 'Work item not found' };
    }
    return { success: true, data: item };
  });

  // ── PATCH /api/work-items/:id ─────────────────────────────────────────────
  app.patch('/api/work-items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<{
      title: string;
      description: string;
      status: WorkItemStatus;
      source: WorkItemSource;
      assignedAgentId: string | null;
      assignedAt: string | null;
      startedAt: string | null;
      completedAt: string | null;
      worktreePath: string | null;
      branchName: string | null;
      taskMdPath: string | null;
      externalRef: string | null;
      externalUrl: string | null;
      metadata: Record<string, unknown>;
      compactSummary: string | null;
      caseId: string | null;
    }>;

    const updated = updateWorkItem(id, body);
    if (!updated) {
      reply.code(404);
      return { success: false, error: 'Work item not found' };
    }

    ctx.broadcast(SseEvent.WorkItemUpdated, updated);

    if (body.status && body.status !== updated.status) {
      // Note: status was already applied — broadcast the final state
    }
    ctx.broadcast(SseEvent.WorkItemStatusChanged, { id, status: updated.status });

    // Fire-and-forget webhook delivery to Clockwork OS if registered (only on status change)
    if (body.status !== undefined) {
      void deliverWebhookIfRegistered(ctx.store, id, updated.status).catch(() => {});
    }

    // Trigger orchestrator completion flow when status transitions to 'done'
    if (body.status === 'done') {
      try {
        const { getOrchestrator } = await import('../../orchestrator.js');
        const orchestrator = getOrchestrator();
        if (orchestrator) {
          orchestrator.handleCompletionFlow(id).catch((err: unknown) => {
            console.error('[work-item-routes] orchestrator completion flow failed:', err);
          });
        }
      } catch {
        /* orchestrator not initialized */
      }
    }

    return { success: true, data: updated };
  });

  // ── POST /api/work-items/:id/claim ────────────────────────────────────────
  app.post('/api/work-items/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { agentId?: string };

    if (!body.agentId) {
      reply.code(400);
      return { success: false, error: 'agentId is required' };
    }

    // 404 check first
    const existing = getWorkItem(id);
    if (!existing) {
      reply.code(404);
      return { success: false, error: 'Work item not found' };
    }

    const claimed = claimWorkItem(id, body.agentId);
    if (!claimed) {
      reply.code(409);
      return { success: false, error: 'Already claimed' };
    }

    ctx.broadcast(SseEvent.WorkItemClaimed, claimed);
    ctx.broadcast(SseEvent.WorkItemStatusChanged, { id, status: claimed.status });

    return { success: true, data: claimed };
  });

  // ── POST /api/work-items/:id/dependencies ─────────────────────────────────
  app.post('/api/work-items/:id/dependencies', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { dependsOnId?: string };

    if (!body.dependsOnId) {
      reply.code(400);
      return { success: false, error: 'dependsOnId is required' };
    }

    // Verify both items exist
    if (!getWorkItem(id)) {
      reply.code(404);
      return { success: false, error: 'Work item not found' };
    }
    if (!getWorkItem(body.dependsOnId)) {
      reply.code(404);
      return { success: false, error: `Blocker work item not found: ${body.dependsOnId}` };
    }

    try {
      // dependsOnId blocks id (dependsOnId must be done before id)
      const dep = addDependency(body.dependsOnId, id);
      return { success: true, data: dep };
    } catch (err: unknown) {
      const e = err as Error;
      reply.code(400);
      return { success: false, error: e.message };
    }
  });

  // ── DELETE /api/work-items/:id ─────────────────────────────────────────────
  app.delete('/api/work-items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = deleteWorkItem(id);
    if (!deleted) {
      reply.code(404);
      return { success: false, error: 'Work item not found' };
    }
    ctx.broadcast(SseEvent.WorkItemUpdated, { id, deleted: true });
    reply.code(204);
    return;
  });

  // ── DELETE /api/work-items/:id/dependencies/:depId ────────────────────────
  app.delete('/api/work-items/:id/dependencies/:depId', async (req, reply) => {
    const { id, depId } = req.params as { id: string; depId: string };

    // depId blocks id
    const removed = removeDependency(depId, id);
    if (!removed) {
      reply.code(404);
      return { success: false, error: 'Dependency not found' };
    }

    return { success: true };
  });
}

/**
 * @fileoverview Orchestrator API routes.
 *
 * Routes:
 *   GET    /api/orchestrator/status   — current orchestrator status
 *   POST   /api/orchestrator/toggle   — toggle orchestration for a case
 *   PATCH  /api/orchestrator/config   — update orchestrator config
 *   POST   /api/orchestrator/dispatch — manual dispatch trigger
 *   POST   /api/orchestrator/start    — start the orchestrator loop
 *   POST   /api/orchestrator/stop     — stop the orchestrator loop
 */

import { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { EventPort, ConfigPort } from '../ports/index.js';
import { getOrchestrator } from '../../orchestrator.js';
import { getWorkItem } from '../../work-items/index.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types/api.js';
import { CASES_DIR } from '../route-helpers.js';
import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from '../../types/orchestrator.js';

export function registerOrchestratorRoutes(app: FastifyInstance, ctx: EventPort & ConfigPort): void {
  // ── GET /api/orchestrator/status ──────────────────────────────────────
  app.get('/api/orchestrator/status', async () => {
    const orchestrator = getOrchestrator();
    if (!orchestrator) {
      return {
        success: true,
        data: {
          running: false,
          mode: 'disabled',
          activeCases: [],
          activeDispatches: 0,
          lastActionAt: null,
          recentDecisions: [],
          config: DEFAULT_ORCHESTRATOR_CONFIG,
        },
      };
    }
    return { success: true, data: orchestrator.getStatus() };
  });

  // ── POST /api/orchestrator/toggle ─────────────────────────────────────
  app.post('/api/orchestrator/toggle', async (req, reply) => {
    const body = req.body as { caseId?: string; enabled?: boolean };
    if (!body.caseId || typeof body.enabled !== 'boolean') {
      reply.code(400);
      return { success: false, error: 'caseId (string) and enabled (boolean) are required' };
    }

    const { caseId, enabled } = body;

    try {
      // Check native case first
      const nativePath = join(CASES_DIR, caseId);
      if (existsSync(nativePath)) {
        const configPath = join(nativePath, 'case-config.json');
        let config: Record<string, unknown> = {};
        try {
          config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<string, unknown>;
        } catch {
          /* no existing config */
        }
        config.orchestrationEnabled = enabled;
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
        return { success: true, data: { caseId, orchestrationEnabled: enabled } };
      }

      // Check linked cases
      const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
      let linked: Record<string, string | { path: string; orchestrationEnabled?: boolean }> = {};
      try {
        linked = JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8')) as typeof linked;
      } catch {
        /* no file */
      }

      const entry = linked[caseId];
      if (!entry) {
        reply.code(404);
        return createErrorResponse(ApiErrorCode.NOT_FOUND, `Case "${caseId}" not found`);
      }

      // Upgrade string entry to object
      const path = typeof entry === 'string' ? entry : entry.path;
      linked[caseId] = { path, orchestrationEnabled: enabled };
      await fs.writeFile(linkedCasesFile, JSON.stringify(linked, null, 2));

      return { success: true, data: { caseId, orchestrationEnabled: enabled } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ── PATCH /api/orchestrator/config ────────────────────────────────────
  app.patch('/api/orchestrator/config', async (req) => {
    const body = req.body as Partial<OrchestratorConfig>;
    const appConfig = ctx.store.getConfig();
    const current = appConfig.orchestrator;
    const merged = { ...current, ...body } as OrchestratorConfig;
    ctx.store.setConfig({ orchestrator: merged });
    return { success: true, data: merged };
  });

  // ── POST /api/orchestrator/dispatch ───────────────────────────────────
  app.post('/api/orchestrator/dispatch', async (req, reply) => {
    const body = req.body as { workItemId?: string; agentId?: string };
    if (!body.workItemId) {
      reply.code(400);
      return { success: false, error: 'workItemId is required' };
    }

    const orchestrator = getOrchestrator();
    if (!orchestrator) {
      reply.code(503);
      return { success: false, error: 'Orchestrator not available' };
    }

    const item = getWorkItem(body.workItemId);
    if (!item) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Work item not found');
    }

    if (item.status !== 'queued') {
      reply.code(400);
      return { success: false, error: `Work item status is "${item.status}", expected "queued"` };
    }

    try {
      if (body.agentId) {
        await orchestrator.dispatchWorkItem(item, body.agentId, 'explicit', 'Manual dispatch');
      } else {
        const selection = await orchestrator.selectAgent(item);
        if (!selection) {
          reply.code(400);
          return { success: false, error: 'No agent available for dispatch' };
        }
        await orchestrator.dispatchWorkItem(item, selection.agentId, selection.method, selection.reasoning);
      }
      return { success: true };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ── POST /api/orchestrator/start ─────────────────────────────────────
  app.post('/api/orchestrator/start', async (_req, reply) => {
    const orchestrator = getOrchestrator();
    if (!orchestrator) {
      reply.code(503);
      return { success: false, error: 'Orchestrator not available' };
    }
    orchestrator.start();
    return { success: true, data: orchestrator.getStatus() };
  });

  // ── POST /api/orchestrator/stop ──────────────────────────────────────
  app.post('/api/orchestrator/stop', async (_req, reply) => {
    const orchestrator = getOrchestrator();
    if (!orchestrator) {
      reply.code(503);
      return { success: false, error: 'Orchestrator not available' };
    }
    orchestrator.stop();
    return { success: true, data: orchestrator.getStatus() };
  });
}

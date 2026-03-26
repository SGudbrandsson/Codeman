/**
 * @fileoverview Integration configuration REST routes.
 *
 * Routes:
 *   GET  /api/integrations/config        — returns integration config (tokens masked)
 *   PUT  /api/integrations/config        — saves integration tokens to AppConfig
 *   POST /api/integrations/test/:service — tests connectivity for a service
 */

import { FastifyInstance } from 'fastify';
import type { ConfigPort } from '../ports/config-port.js';
import { testIntegrationConnection } from '../../integrations/index.js';
import type { IntegrationsConfig, IntegrationConfig } from '../../integrations/types.js';

type IntegrationRoutesCtx = ConfigPort;

/** Mask a single integration config — replace token with hasToken boolean. */
function maskConfig(
  cfg?: IntegrationConfig
): { enabled: boolean; hasToken: boolean; org?: string; teamId?: string } | undefined {
  if (!cfg) return undefined;
  return {
    enabled: cfg.enabled,
    hasToken: !!cfg.token,
    ...(cfg.org ? { org: cfg.org } : {}),
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  };
}

export function registerIntegrationRoutes(app: FastifyInstance, ctx: IntegrationRoutesCtx): void {
  // ── GET /api/integrations/config ──────────────────────────────────
  app.get('/api/integrations/config', async () => {
    const integrations = ctx.store.getConfig().integrations || {};
    return {
      success: true,
      data: {
        asana: maskConfig(integrations.asana),
        github: maskConfig(integrations.github),
        sentry: maskConfig(integrations.sentry),
        slack: maskConfig(integrations.slack),
      },
    };
  });

  // ── PUT /api/integrations/config ──────────────────────────────────
  app.put('/api/integrations/config', async (req, reply) => {
    const body = req.body as Partial<IntegrationsConfig> | null;
    if (!body) {
      reply.code(400);
      return { success: false, error: 'Request body is required' };
    }

    const current = ctx.store.getConfig().integrations || {};
    const updated: IntegrationsConfig = { ...current };

    // Merge each service config — only update fields that are provided
    for (const service of ['asana', 'github', 'sentry', 'slack'] as const) {
      const incoming = body[service];
      if (incoming !== undefined) {
        const existing = current[service] || { enabled: false };
        updated[service] = {
          enabled: incoming.enabled ?? existing.enabled,
          // Only update token if a non-empty string is provided (don't clear on omit)
          token: incoming.token !== undefined && incoming.token !== '' ? incoming.token : existing.token,
          org: incoming.org !== undefined ? incoming.org : existing.org,
          teamId: incoming.teamId !== undefined ? incoming.teamId : existing.teamId,
        };
      }
    }

    ctx.store.setConfig({ integrations: updated } as Parameters<typeof ctx.store.setConfig>[0]);
    return { success: true };
  });

  // ── POST /api/integrations/test/:service ──────────────────────────
  app.post<{ Params: { service: string } }>('/api/integrations/test/:service', async (req) => {
    const { service } = req.params;
    const integrations = ctx.store.getConfig().integrations || {};
    const cfg = integrations[service as keyof IntegrationsConfig];

    if (!cfg) {
      return { success: false, error: `No configuration found for ${service}` };
    }

    const result = await testIntegrationConnection(service, cfg);
    return { success: result.ok, error: result.error };
  });
}

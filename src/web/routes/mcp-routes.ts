/**
 * @fileoverview MCP server management routes.
 *
 * Endpoints:
 *   GET  /api/sessions/:id/mcp            — get session MCP server list
 *   PUT  /api/sessions/:id/mcp            — replace MCP server list
 *   POST /api/sessions/:id/mcp/restart    — apply config + restart Claude with --resume
 *   GET  /api/mcp/library                 — return curated server list
 *   GET  /api/mcp/marketplace?q=<query>   — proxy Smithery.ai search
 */
import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { findSessionOrFail } from '../route-helpers.js';
import type { SessionPort, EventPort } from '../ports/index.js';
import { MCP_LIBRARY } from '../../mcp-library.js';
import { SseEvent } from '../sse-events.js';

const SMITHERY_BASE = 'https://registry.smithery.ai';
const marketplaceCache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function registerMcpRoutes(app: FastifyInstance, ctx: SessionPort & EventPort) {
  // GET session MCP servers
  app.get('/api/sessions/:id/mcp', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    return reply.send(session.mcpServers ?? []);
  });

  // PUT session MCP servers
  app.put('/api/sessions/:id/mcp', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    const servers = req.body as unknown[];
    if (!Array.isArray(servers)) {
      return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Body must be array'));
    }
    session.mcpServers = servers as typeof session.mcpServers;
    ctx.persistSessionState(session);
    return reply.send({ ok: true });
  });

  // POST restart Claude with updated MCP config
  app.post('/api/sessions/:id/mcp/restart', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    const body = req.body as { mcpServers?: unknown[] } | null;
    if (body?.mcpServers !== undefined) {
      if (!Array.isArray(body.mcpServers)) {
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'mcpServers must be array'));
      }
      session.mcpServers = body.mcpServers as typeof session.mcpServers;
      ctx.persistSessionState(session);
    }

    const resumeId = session.claudeResumeId;
    try {
      await session.prepareForRestart();
      await session.startInteractive();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'Restart failed: ' + msg));
    }

    const enabledCount = (session.mcpServers ?? []).filter((s) => s.enabled).length;
    ctx.broadcast(SseEvent.SessionMcpRestarted, { sessionId: id, serverCount: enabledCount });
    return reply.send({ ok: true, resumeId: resumeId ?? null });
  });

  // GET curated library
  app.get('/api/mcp/library', async (_req, reply) => {
    return reply.send(MCP_LIBRARY);
  });

  // GET marketplace proxy (Smithery.ai)
  app.get('/api/mcp/marketplace', async (req, reply) => {
    const { q = '' } = req.query as { q?: string };
    const cacheKey = q.trim().toLowerCase();
    const cached = marketplaceCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return reply.send(cached.data);
    }
    try {
      const url = `${SMITHERY_BASE}/servers?q=${encodeURIComponent(q)}&pageSize=24`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Smithery returned ' + res.status);
      const data = await res.json();
      marketplaceCache.set(cacheKey, { data, ts: Date.now() });
      return reply.send(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(502).send(createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'Marketplace unavailable: ' + msg));
    }
  });
}

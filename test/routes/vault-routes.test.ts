/**
 * @fileoverview Tests for vault-routes — all 9 endpoints.
 *
 * Agent CRUD: GET /api/agents, GET /api/agents/:id, POST /api/agents,
 *             PATCH /api/agents/:id, DELETE /api/agents/:id
 * Vault:      POST capture, GET query, GET notes, DELETE note
 *
 * Uses app.inject() — no real HTTP ports opened.
 * Vault writes go to a real tmp directory; cleaned up in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerVaultRoutes } from '../../src/web/routes/vault-routes.js';
import type { AgentProfile } from '../../src/types/session.js';

function makeTmpVault(suffix: string): string {
  const dir = join(tmpdir(), `vault-routes-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a minimal AgentProfile with a real tmp vaultPath */
function makeProfile(agentId: string, vaultPath: string): AgentProfile {
  return {
    agentId,
    role: 'implementer' as AgentProfile['role'],
    displayName: 'Test Agent',
    vaultPath,
    capabilities: [],
    notesSinceConsolidation: 0,
    decay: { notesTtlDays: 90, patternsTtlDays: 180 },
    createdAt: new Date().toISOString(),
  };
}

describe('vault-routes', () => {
  let harness: RouteTestHarness;
  let vaultPath: string;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerVaultRoutes);
    vaultPath = makeTmpVault('vr');
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  // Agent CRUD tests are in agent-routes.test.ts — vault-routes only tests vault endpoints

  // ── POST /api/agents/:agentId/vault/capture ────────────────────────────────

  describe('POST /api/agents/:agentId/vault/capture', () => {
    it('writes a note and returns filename + noteCount', async () => {
      harness.ctx.store.setAgent(makeProfile('cap-agent', vaultPath));
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/cap-agent/vault/capture',
        payload: {
          sessionId: 'sess-cap',
          workItemId: 'wi-1',
          content: 'authentication refactor completed',
        },
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.filename).toMatch(/\.md$/);
      expect(body.noteCount).toBe(1);
    });

    it('increments notesSinceConsolidation on the agent profile', async () => {
      const profile = makeProfile('nsync-agent', vaultPath);
      harness.ctx.store.setAgent(profile);

      await harness.app.inject({
        method: 'POST',
        url: '/api/agents/nsync-agent/vault/capture',
        payload: { sessionId: 'sess-1', workItemId: null, content: 'content here' },
      });

      const updated = harness.ctx.store.getAgent('nsync-agent');
      expect(updated?.notesSinceConsolidation).toBe(1);
    });

    it('returns error when sessionId is missing', async () => {
      harness.ctx.store.setAgent(makeProfile('cap-agent-bad', vaultPath));
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/cap-agent-bad/vault/capture',
        payload: { content: 'missing sessionId' },
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error for unknown agent', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/ghost/vault/capture',
        payload: { sessionId: 'sess-1', content: 'content' },
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ── GET /api/agents/:agentId/vault/query ──────────────────────────────────

  describe('GET /api/agents/:agentId/vault/query', () => {
    it('returns empty results for blank query', async () => {
      harness.ctx.store.setAgent(makeProfile('q-agent', vaultPath));
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/q-agent/vault/query?q=',
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.results).toEqual([]);
    });

    it('returns BM25 results for valid query after capture', async () => {
      const agentId = 'q-agent-full';
      harness.ctx.store.setAgent(makeProfile(agentId, vaultPath));

      // Capture a note first
      await harness.app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/vault/capture`,
        payload: { sessionId: 'sess-q', workItemId: null, content: 'session recovery after restart' },
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/vault/query?q=session+recovery`,
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.results)).toBe(true);
    });

    it('caps limit at 20', async () => {
      harness.ctx.store.setAgent(makeProfile('qlim-agent', vaultPath));
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/qlim-agent/vault/query?q=test&limit=999',
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns error for unknown agent', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/ghost/vault/query?q=test',
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ── GET /api/agents/:agentId/vault/notes ──────────────────────────────────

  describe('GET /api/agents/:agentId/vault/notes', () => {
    it('returns empty notes list for new agent', async () => {
      harness.ctx.store.setAgent(makeProfile('notes-agent', vaultPath));
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/notes-agent/vault/notes',
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.notes).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns notes after capture', async () => {
      const agentId = 'notes-agent-full';
      harness.ctx.store.setAgent(makeProfile(agentId, vaultPath));

      await harness.app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/vault/capture`,
        payload: { sessionId: 's1', workItemId: null, content: 'note 1 content' },
      });
      await harness.app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/vault/capture`,
        payload: { sessionId: 's2', workItemId: null, content: 'note 2 content' },
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/vault/notes`,
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.total).toBe(2);
      expect(body.notes).toHaveLength(2);
    });

    it('returns error for unknown agent', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/ghost/vault/notes',
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ── DELETE /api/agents/:agentId/vault/notes/:filename ─────────────────────

  describe('DELETE /api/agents/:agentId/vault/notes/:filename', () => {
    it('deletes an existing note and returns 204', async () => {
      const agentId = 'del-note-agent';
      harness.ctx.store.setAgent(makeProfile(agentId, vaultPath));

      const capRes = await harness.app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/vault/capture`,
        payload: { sessionId: 'sd1', workItemId: null, content: 'to be deleted' },
      });
      const { filename } = JSON.parse(capRes.body);

      const delRes = await harness.app.inject({
        method: 'DELETE',
        url: `/api/agents/${agentId}/vault/notes/${encodeURIComponent(filename)}`,
      });
      expect(delRes.statusCode).toBe(204);
    });

    it('returns error for nonexistent note', async () => {
      harness.ctx.store.setAgent(makeProfile('del-note-ghost', vaultPath));
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/agents/del-note-ghost/vault/notes/nonexistent.md',
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error for unknown agent', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/agents/ghost/vault/notes/any.md',
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });
});

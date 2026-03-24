/**
 * @fileoverview Tests for vault consolidation endpoints:
 *   POST /api/agents/:agentId/vault/consolidate
 *   GET  /api/agents/:agentId/vault/patterns
 *
 * consolidate() is mocked to avoid real LLM calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the vault consolidate module before importing routes
vi.mock('../../src/vault/consolidate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vault/consolidate.js')>();
  return {
    ...actual,
    consolidate: vi.fn(async () => ({
      patternsWritten: 2,
      notesProcessed: 5,
      notesArchived: 0,
      patternsDeleted: 0,
    })),
  };
});

// Also mock it via the index barrel
vi.mock('../../src/vault/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vault/index.js')>();
  return {
    ...actual,
    consolidate: vi.fn(async () => ({
      patternsWritten: 2,
      notesProcessed: 5,
      notesArchived: 0,
      patternsDeleted: 0,
    })),
  };
});

import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerVaultRoutes } from '../../src/web/routes/vault-routes.js';
import type { AgentProfile } from '../../src/types/session.js';

function makeTmpVault(suffix: string): string {
  const dir = join(tmpdir(), `vault-consolidate-routes-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeProfile(agentId: string, vaultPath: string, notesSince = 0): AgentProfile {
  return {
    agentId,
    role: 'keeps-engineer',
    displayName: 'Test Agent',
    vaultPath,
    capabilities: [],
    notesSinceConsolidation: notesSince,
    decay: { notesTtlDays: 90, patternsTtlDays: 365 },
    createdAt: new Date().toISOString(),
  };
}

describe('vault-consolidate-routes', () => {
  let harness: RouteTestHarness;
  let vaultPath: string;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerVaultRoutes);
    vaultPath = makeTmpVault('vcr');
    // Ensure vault subdirs exist
    for (const sub of ['notes', 'patterns', 'index']) {
      mkdirSync(join(vaultPath, sub), { recursive: true });
    }
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(vaultPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // ── POST /api/agents/:agentId/vault/consolidate ───────────────────────────

  describe('POST /api/agents/:agentId/vault/consolidate', () => {
    it('returns success with patternsWritten on known agent', async () => {
      harness.ctx.store.setAgent(makeProfile('con-agent', vaultPath, 5));

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/con-agent/vault/consolidate',
      });

      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(typeof body.patternsWritten).toBe('number');
      expect(typeof body.notesProcessed).toBe('number');
    });

    it('returns 404-style error for unknown agent', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/agents/ghost-agent/vault/consolidate',
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('resets notesSinceConsolidation to 0 via store.setAgent', async () => {
      harness.ctx.store.setAgent(makeProfile('reset-agent', vaultPath, 15));

      await harness.app.inject({
        method: 'POST',
        url: '/api/agents/reset-agent/vault/consolidate',
      });

      const updated = harness.ctx.store.getAgent('reset-agent');
      expect(updated?.notesSinceConsolidation).toBe(0);
    });

    it('sets lastConsolidatedAt on the agent profile', async () => {
      harness.ctx.store.setAgent(makeProfile('lca-agent', vaultPath, 5));

      await harness.app.inject({
        method: 'POST',
        url: '/api/agents/lca-agent/vault/consolidate',
      });

      const updated = harness.ctx.store.getAgent('lca-agent');
      expect(updated?.lastConsolidatedAt).toBeDefined();
      expect(typeof updated?.lastConsolidatedAt).toBe('string');
    });
  });

  // ── GET /api/agents/:agentId/vault/patterns ───────────────────────────────

  describe('GET /api/agents/:agentId/vault/patterns', () => {
    it('returns patterns array (empty) for agent with no patterns', async () => {
      harness.ctx.store.setAgent(makeProfile('pat-agent', vaultPath));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/pat-agent/vault/patterns',
      });

      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.patterns)).toBe(true);
      expect(body.patterns).toHaveLength(0);
    });

    it('returns 404-style error for unknown agent', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/agents/ghost-agent/vault/patterns',
      });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });
});

/**
 * @fileoverview Tests for src/vault/search.ts
 *
 * Covers: invalidateIndex, queryIndex (lazy build, BM25 results,
 *         normalized scores, empty-query short-circuit),
 *         and <500ms performance SLA for 1000 notes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeNote } from '../../src/vault/store.js';
import { invalidateIndex, queryIndex } from '../../src/vault/search.js';

function makeTmpVault(suffix: string): string {
  const dir = join(tmpdir(), `vault-search-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('vault/search', () => {
  let vaultPath: string;
  const agentId = 'test-agent-search';

  beforeEach(() => {
    vaultPath = makeTmpVault('search');
    // Invalidate to start with a clean index cache
    invalidateIndex(agentId);
  });

  afterEach(() => {
    invalidateIndex(agentId);
    rmSync(vaultPath, { recursive: true, force: true });
  });

  // ── invalidateIndex ────────────────────────────────────────────────────────

  describe('invalidateIndex', () => {
    it('does not throw when called for an agent with no cached index', () => {
      expect(() => invalidateIndex('no-such-agent')).not.toThrow();
    });

    it('forces index rebuild on next query after invalidation', async () => {
      writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'authentication token refresh flow' });

      // First query builds the index
      const results1 = await queryIndex(agentId, vaultPath, 'authentication', 5);
      expect(results1.length).toBeGreaterThan(0);

      // Write a second note, then invalidate
      writeNote(vaultPath, { sessionId: 's2', workItemId: null, body: 'database connection pooling' });
      invalidateIndex(agentId);

      // After invalidation, next query should include the new note
      const results2 = await queryIndex(agentId, vaultPath, 'database connection', 5);
      expect(results2.length).toBeGreaterThan(0);
    });
  });

  // ── queryIndex ────────────────────────────────────────────────────────────

  describe('queryIndex', () => {
    it('returns empty array for empty query string', async () => {
      writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'some content' });
      const results = await queryIndex(agentId, vaultPath, '', 5);
      expect(results).toEqual([]);
    });

    it('returns empty array for whitespace-only query', async () => {
      writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'some content' });
      const results = await queryIndex(agentId, vaultPath, '   ', 5);
      expect(results).toEqual([]);
    });

    it('returns empty array for empty vault', async () => {
      // No notes written
      const { mkdirSync: mk } = await import('node:fs');
      mk(join(vaultPath, 'notes'), { recursive: true });
      const results = await queryIndex(agentId, vaultPath, 'anything', 5);
      expect(results).toEqual([]);
    });

    it('finds relevant note by keyword', async () => {
      writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'authentication token refresh flow' });
      writeNote(vaultPath, { sessionId: 's2', workItemId: null, body: 'database connection pool settings' });
      invalidateIndex(agentId);

      const results = await queryIndex(agentId, vaultPath, 'authentication', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].sourceType).toBe('note');
      expect(results[0].sourceFile).toMatch(/\.md$/);
    });

    it('returns results with normalized scores in [0, 1] range', async () => {
      writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'memory cache invalidation strategy' });
      writeNote(vaultPath, { sessionId: 's2', workItemId: null, body: 'cache eviction policy LRU algorithm' });
      writeNote(vaultPath, { sessionId: 's3', workItemId: null, body: 'disk persistence and durability' });
      invalidateIndex(agentId);

      const results = await queryIndex(agentId, vaultPath, 'cache', 5);
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        writeNote(vaultPath, {
          sessionId: `s${i}`,
          workItemId: null,
          body: `feature implementation step ${i} auth token`,
        });
      }
      invalidateIndex(agentId);

      const results = await queryIndex(agentId, vaultPath, 'auth token', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('returns VaultQueryResult shape (sourceType, sourceFile, snippet, score, timestamp)', async () => {
      writeNote(vaultPath, { sessionId: 's1', workItemId: 'wi-5', body: 'session context recovery after restart' });
      invalidateIndex(agentId);

      const results = await queryIndex(agentId, vaultPath, 'session context recovery', 5);
      expect(results.length).toBeGreaterThan(0);
      const r = results[0];
      expect(r).toHaveProperty('sourceType', 'note');
      expect(r).toHaveProperty('sourceFile');
      expect(r).toHaveProperty('snippet');
      expect(r).toHaveProperty('score');
      expect(r).toHaveProperty('timestamp');
      expect(typeof r.snippet).toBe('string');
      expect(r.snippet.length).toBeGreaterThan(0);
    });

    it('sorts results by score descending', async () => {
      // Note 1 mentions "authentication" many times → should rank higher
      writeNote(vaultPath, {
        sessionId: 's1',
        workItemId: null,
        body: 'authentication authentication authentication token oauth flow',
      });
      writeNote(vaultPath, { sessionId: 's2', workItemId: null, body: 'authentication once mentioned here' });
      writeNote(vaultPath, { sessionId: 's3', workItemId: null, body: 'unrelated database stuff' });
      invalidateIndex(agentId);

      const results = await queryIndex(agentId, vaultPath, 'authentication', 5);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('uses cached index on second call (lazy build only once)', async () => {
      writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'refactoring session handler logic' });
      // Two queries with same agent/vault — should both return results without error
      const r1 = await queryIndex(agentId, vaultPath, 'refactoring', 5);
      const r2 = await queryIndex(agentId, vaultPath, 'refactoring', 5);
      expect(r1.length).toBe(r2.length);
    });
  });

  // ── Performance SLA ───────────────────────────────────────────────────────

  describe('performance', () => {
    it('completes query over 1000 notes in under 500ms', async () => {
      const perfVault = makeTmpVault('perf');
      const perfAgentId = 'perf-agent-1000';
      try {
        // Write 1000 synthetic notes
        const topics = [
          'authentication token refresh flow',
          'database connection pool settings',
          'cache eviction LRU strategy',
          'session state management restart',
          'vault memory retrieval BM25',
          'agent orchestration workflow task',
          'error handling retry backoff',
          'code review pull request diff',
          'deployment pipeline CI CD',
          'test coverage unit integration',
        ];
        for (let i = 0; i < 1000; i++) {
          const topic = topics[i % topics.length];
          writeNote(perfVault, {
            sessionId: `session-${i}`,
            workItemId: i % 5 === 0 ? `wi-${i}` : null,
            body: `## Note ${i}\n\n${topic}. Additional context for note number ${i}. This is a realistic note body with some varied content to make search meaningful. Index ${i}.`,
          });
        }
        invalidateIndex(perfAgentId);

        const start = Date.now();
        const results = await queryIndex(perfAgentId, perfVault, 'authentication token', 5);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(500);
        expect(results.length).toBeGreaterThan(0);
      } finally {
        invalidateIndex(perfAgentId);
        rmSync(perfVault, { recursive: true, force: true });
      }
    });
  });
});

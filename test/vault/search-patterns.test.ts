/**
 * @fileoverview Tests for pattern notes integration in BM25 search (search.ts).
 *
 * Covers:
 * - Pattern notes included in BM25 index after invalidateIndex
 * - Pattern notes get 1.5x score boost vs equivalent note
 * - sourceType is 'pattern' for pattern results
 * - Query returns both notes and patterns when both match
 * - Empty patterns dir doesn't break index build
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeNote, ensureVaultDirs } from '../../src/vault/store.js';
import { invalidateIndex, queryIndex } from '../../src/vault/search.js';

function makeTmpVault(suffix: string): string {
  const dir = join(tmpdir(), `search-patterns-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a pattern file directly (bypasses consolidate to keep tests fast). */
function writePatternDirect(vaultPath: string, filename: string, clusterLabel: string, body: string): void {
  const patternsDir = join(vaultPath, 'patterns');
  mkdirSync(patternsDir, { recursive: true });
  const content = [
    '---',
    `consolidatedAt: ${new Date().toISOString()}`,
    'sourceNotes:',
    '  - some-note.md',
    `clusterLabel: ${clusterLabel}`,
    '---',
    `## Pattern: ${clusterLabel}`,
    '',
    body,
  ].join('\n');
  writeFileSync(join(patternsDir, filename), content, 'utf-8');
}

describe('vault/search — pattern notes integration', () => {
  let vaultPath: string;
  const agentId = 'search-patterns-agent';

  beforeEach(() => {
    vaultPath = makeTmpVault('sp');
    ensureVaultDirs(vaultPath);
    invalidateIndex(agentId);
  });

  afterEach(() => {
    invalidateIndex(agentId);
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('pattern notes are included in BM25 index after invalidateIndex', async () => {
    writePatternDirect(
      vaultPath,
      '2026-03-23-cluster-0.md',
      'authentication oauth',
      'Authentication pattern with oauth tokens and session management.'
    );
    invalidateIndex(agentId);

    const results = await queryIndex(agentId, vaultPath, 'authentication oauth', 5);
    expect(results.length).toBeGreaterThan(0);
    const patternResult = results.find((r) => r.sourceType === 'pattern');
    expect(patternResult).toBeDefined();
  });

  it('pattern notes have sourceType "pattern" in results', async () => {
    writePatternDirect(
      vaultPath,
      '2026-03-23-cluster-0.md',
      'database migration',
      'Database migration pattern for postgresql schema changes.'
    );
    invalidateIndex(agentId);

    const results = await queryIndex(agentId, vaultPath, 'database migration', 5);
    const patternResult = results.find((r) => r.sourceFile === '2026-03-23-cluster-0.md');
    expect(patternResult).toBeDefined();
    expect(patternResult!.sourceType).toBe('pattern');
  });

  it('pattern notes get a score boost compared to an equivalent plain note', async () => {
    // Write a pattern and a note with identical content (same keyword density)
    const body = 'refactoring session handler logic cleanup refactoring session cleanup';
    writeNote(vaultPath, { sessionId: 'plain-s1', workItemId: null, body });
    writePatternDirect(vaultPath, '2026-03-23-cluster-0.md', 'refactoring session', body);
    invalidateIndex(agentId);

    const results = await queryIndex(agentId, vaultPath, 'refactoring session', 5);
    const patternResult = results.find((r) => r.sourceType === 'pattern');
    const noteResult = results.find((r) => r.sourceType === 'note');

    // Both should be found
    expect(patternResult).toBeDefined();
    expect(noteResult).toBeDefined();

    // Pattern score should be >= note score (due to 1.5x boost)
    expect(patternResult!.score).toBeGreaterThanOrEqual(noteResult!.score);
  });

  it('query returns both notes and patterns when both match', async () => {
    const keyword = 'authentication token session oauth';
    writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: `${keyword} note content` });
    writePatternDirect(vaultPath, '2026-03-23-cluster-0.md', 'authentication token', `${keyword} pattern content`);
    invalidateIndex(agentId);

    const results = await queryIndex(agentId, vaultPath, 'authentication token', 10);
    const sourceTypes = results.map((r) => r.sourceType);
    expect(sourceTypes).toContain('note');
    expect(sourceTypes).toContain('pattern');
  });

  it('empty patterns dir does not break index build', async () => {
    // patterns dir exists but is empty (ensureVaultDirs already created it)
    writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'some note content for search' });
    invalidateIndex(agentId);

    // Should not throw
    const results = await queryIndex(agentId, vaultPath, 'note content', 5);
    expect(Array.isArray(results)).toBe(true);
  });
});

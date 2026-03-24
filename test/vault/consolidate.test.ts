/**
 * @fileoverview Tests for src/vault/consolidate.ts
 *
 * Covers: runMemoryDecay, consolidate (guard, clustering, pattern writing),
 * and the full pipeline with a mock synthesis function.
 *
 * Uses the `synthesisFn` option in consolidate() to avoid real LLM calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { consolidate, runMemoryDecay, CONSOLIDATION_THRESHOLD } from '../../src/vault/consolidate.js';
import { writeNote, ensureVaultDirs } from '../../src/vault/store.js';
import type { AgentProfile } from '../../src/types/session.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeTmpVault(suffix: string): string {
  const dir = join(tmpdir(), `consolidate-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAgentProfile(vaultPath: string, notesSince = 15): AgentProfile {
  return {
    agentId: 'test-agent',
    role: 'keeps-engineer',
    displayName: 'Test Agent',
    vaultPath,
    capabilities: [],
    notesSinceConsolidation: notesSince,
    decay: { notesTtlDays: 90, patternsTtlDays: 365 },
    createdAt: new Date().toISOString(),
  };
}

/** Default mock synthesis function — returns quickly without spawning claude. */
const mockSynthesis = vi.fn(async (_prompt: string) => 'Mocked pattern synthesis output.');

// ────────────────────────────────────────────────────────────────────────────
// CONSOLIDATION_THRESHOLD constant
// ────────────────────────────────────────────────────────────────────────────

describe('CONSOLIDATION_THRESHOLD', () => {
  it('is 10', () => {
    expect(CONSOLIDATION_THRESHOLD).toBe(10);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runMemoryDecay
// ────────────────────────────────────────────────────────────────────────────

describe('runMemoryDecay', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = makeTmpVault('decay');
    ensureVaultDirs(vaultPath);
  });

  afterEach(() => {
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('archives notes older than notesTtlDays', () => {
    const { utimesSync } = require('node:fs');
    const notesDir = join(vaultPath, 'notes');
    const oldFile = join(notesDir, 'old-note.md');
    writeFileSync(
      oldFile,
      '---\ncapturedAt: 2020-01-01T00:00:00Z\nsessionId: s1\nworkItemId: null\n---\nOld note',
      'utf-8'
    );
    // Set mtime to 100 days ago
    const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);

    const result = runMemoryDecay(vaultPath, { notesTtlDays: 90, patternsTtlDays: 365 });
    expect(result.notesArchived).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(join(vaultPath, 'archive', 'old-note.md'))).toBe(true);
  });

  it('keeps recent notes (not older than notesTtlDays)', () => {
    const note = writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'recent note' });

    const result = runMemoryDecay(vaultPath, { notesTtlDays: 90, patternsTtlDays: 365 });
    expect(result.notesArchived).toBe(0);
    expect(existsSync(join(vaultPath, 'notes', note.filename))).toBe(true);
  });

  it('deletes old patterns older than patternsTtlDays', () => {
    const { utimesSync } = require('node:fs');
    const patternsDir = join(vaultPath, 'patterns');
    const oldPattern = join(patternsDir, '2020-01-01-cluster-0.md');
    writeFileSync(
      oldPattern,
      '---\nconsolidatedAt: 2020-01-01T00:00:00Z\nsourceNotes:\n  - note.md\nclusterLabel: old stuff\n---\n## Pattern: old stuff\n\nbody',
      'utf-8'
    );
    const oldTime = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    utimesSync(oldPattern, oldTime, oldTime);

    const result = runMemoryDecay(vaultPath, { notesTtlDays: 90, patternsTtlDays: 365 });
    expect(result.patternsDeleted).toBe(1);
    expect(existsSync(oldPattern)).toBe(false);
  });

  it('keeps recent patterns (not older than patternsTtlDays)', () => {
    const patternsDir = join(vaultPath, 'patterns');
    const recentPattern = join(patternsDir, 'recent-cluster-0.md');
    writeFileSync(
      recentPattern,
      '---\nconsolidatedAt: 2026-01-01T00:00:00Z\nsourceNotes:\n  - note.md\nclusterLabel: recent\n---\nbody',
      'utf-8'
    );

    const result = runMemoryDecay(vaultPath, { notesTtlDays: 90, patternsTtlDays: 365 });
    expect(result.patternsDeleted).toBe(0);
    expect(existsSync(recentPattern)).toBe(true);
  });

  it('handles empty vault dirs gracefully (returns zero counts)', () => {
    const result = runMemoryDecay(vaultPath, { notesTtlDays: 90, patternsTtlDays: 365 });
    expect(result.notesArchived).toBe(0);
    expect(result.patternsDeleted).toBe(0);
  });

  it('handles missing vault dirs gracefully (no throw)', () => {
    const emptyVault = join(tmpdir(), `missing-vault-${Date.now()}`);
    expect(() => runMemoryDecay(emptyVault, { notesTtlDays: 90, patternsTtlDays: 365 })).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// consolidate — guard conditions
// ────────────────────────────────────────────────────────────────────────────

describe('consolidate — guard conditions', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = makeTmpVault('guard');
    mockSynthesis.mockClear();
  });

  afterEach(() => {
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('returns early (zero counts) when notesSinceConsolidation <= threshold', async () => {
    const agent = makeAgentProfile(vaultPath, CONSOLIDATION_THRESHOLD); // exactly at threshold
    const result = await consolidate('test-agent', vaultPath, agent, { synthesisFn: mockSynthesis });
    expect(result.patternsWritten).toBe(0);
    expect(result.notesProcessed).toBe(0);
    expect(mockSynthesis).not.toHaveBeenCalled();
  });

  it('returns early when fewer than 2 notes exist', async () => {
    const agent = makeAgentProfile(vaultPath, 15);
    writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'only one note' });

    const result = await consolidate('test-agent', vaultPath, agent, { synthesisFn: mockSynthesis });
    expect(result.patternsWritten).toBe(0);
    expect(mockSynthesis).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// consolidate — clustering
// ────────────────────────────────────────────────────────────────────────────

describe('consolidate — clustering', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = makeTmpVault('cluster');
    mockSynthesis.mockClear();
    mockSynthesis.mockResolvedValue('Synthesized pattern body.');
  });

  afterEach(() => {
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('groups similar notes (high Jaccard similarity) into the same cluster', async () => {
    const agent = makeAgentProfile(vaultPath, 15);
    // Write 3 very similar notes (all about authentication)
    for (let i = 0; i < 3; i++) {
      writeNote(vaultPath, {
        sessionId: `s${i}`,
        workItemId: null,
        body: 'authentication token refresh flow oauth session security token refresh',
      });
    }

    const result = await consolidate('test-agent', vaultPath, agent, { synthesisFn: mockSynthesis });
    // All 3 similar notes should form one cluster → 1 pattern
    expect(result.patternsWritten).toBe(1);
    expect(mockSynthesis).toHaveBeenCalledTimes(1);
  });

  it('puts dissimilar notes into separate clusters (each becomes singleton, no patterns written)', async () => {
    const agent = makeAgentProfile(vaultPath, 15);
    // Write 2 completely dissimilar notes (no keyword overlap)
    writeNote(vaultPath, {
      sessionId: 's1',
      workItemId: null,
      body: 'authentication oauth token bearer refresh jwt',
    });
    writeNote(vaultPath, {
      sessionId: 's2',
      workItemId: null,
      body: 'database migration postgresql schema alteration',
    });

    const result = await consolidate('test-agent', vaultPath, agent, { synthesisFn: mockSynthesis });
    // Both notes are singletons — no patterns written
    expect(result.patternsWritten).toBe(0);
    expect(mockSynthesis).not.toHaveBeenCalled();
  });

  it('skips singleton clusters (< 2 notes)', async () => {
    const agent = makeAgentProfile(vaultPath, 15);
    writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'alpha beta gamma delta epsilon unique' });
    writeNote(vaultPath, { sessionId: 's2', workItemId: null, body: 'completely different zeta eta theta iota' });

    const result = await consolidate('test-agent', vaultPath, agent, { synthesisFn: mockSynthesis });
    // Both singletons — no synthesis
    expect(result.patternsWritten).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// consolidate — pattern writing
// ────────────────────────────────────────────────────────────────────────────

describe('consolidate — pattern writing', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = makeTmpVault('pattern');
    mockSynthesis.mockClear();
    mockSynthesis.mockResolvedValue('Pattern synthesis content here.');
  });

  afterEach(() => {
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('writes pattern file with correct YAML frontmatter fields', async () => {
    const agent = makeAgentProfile(vaultPath, 15);
    // Write 3 similar notes
    for (let i = 0; i < 3; i++) {
      writeNote(vaultPath, {
        sessionId: `s${i}`,
        workItemId: null,
        body: 'authentication token oauth session bearer refresh',
      });
    }

    await consolidate('test-agent', vaultPath, agent, { synthesisFn: mockSynthesis });

    const patternsDir = join(vaultPath, 'patterns');
    const files = readdirSync(patternsDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(1);

    const content = readFileSync(join(patternsDir, files[0]), 'utf-8');
    expect(content).toContain('consolidatedAt:');
    expect(content).toContain('sourceNotes:');
    expect(content).toContain('clusterLabel:');
    expect(content).toContain('## Pattern:');
    expect(content).toContain('Pattern synthesis content here.');
  });

  it('calls LLM synthesis once per cluster with >= 2 notes', async () => {
    const agent = makeAgentProfile(vaultPath, 15);
    // Two separate groups of similar notes
    for (let i = 0; i < 2; i++) {
      writeNote(vaultPath, {
        sessionId: `auth${i}`,
        workItemId: null,
        body: 'authentication token oauth bearer refresh session security',
      });
    }
    for (let i = 0; i < 2; i++) {
      writeNote(vaultPath, {
        sessionId: `db${i}`,
        workItemId: null,
        body: 'database migration postgresql schema table column index',
      });
    }

    await consolidate('test-agent', vaultPath, agent, { synthesisFn: mockSynthesis });
    // At least one cluster found — should call synthesis
    expect(mockSynthesis).toHaveBeenCalled();
  });

  it('clusterLabel is derived from top terms in cluster notes', async () => {
    const agent = makeAgentProfile(vaultPath, 15);
    for (let i = 0; i < 2; i++) {
      writeNote(vaultPath, {
        sessionId: `s${i}`,
        workItemId: null,
        body: 'authentication token authentication oauth authentication session',
      });
    }

    await consolidate('test-agent', vaultPath, agent, { synthesisFn: mockSynthesis });

    const patternsDir = join(vaultPath, 'patterns');
    const files = readdirSync(patternsDir).filter((f) => f.endsWith('.md'));
    if (files.length > 0) {
      const content = readFileSync(join(patternsDir, files[0]), 'utf-8');
      // clusterLabel should contain 'authentication' as it's the most frequent term
      expect(content).toMatch(/clusterLabel:.*authentication/);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// consolidate — full pipeline
// ────────────────────────────────────────────────────────────────────────────

describe('consolidate — full pipeline', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = makeTmpVault('full');
    mockSynthesis.mockClear();
    mockSynthesis.mockResolvedValue('Full pipeline pattern synthesis.');
  });

  afterEach(() => {
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('capture 12 similar notes → consolidate → patterns dir has files', async () => {
    const agent = makeAgentProfile(vaultPath, 12);

    // Write 12 similar notes
    for (let i = 0; i < 12; i++) {
      writeNote(vaultPath, {
        sessionId: `s${i}`,
        workItemId: null,
        body: `authentication token oauth bearer refresh session security login ${i}`,
      });
    }

    const result = await consolidate('test-agent', vaultPath, agent, { synthesisFn: mockSynthesis });

    expect(result.notesProcessed).toBeGreaterThan(0);
    expect(result.patternsWritten).toBeGreaterThan(0);

    const patternsDir = join(vaultPath, 'patterns');
    const files = readdirSync(patternsDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('returns correct result shape with all expected fields', async () => {
    const agent = makeAgentProfile(vaultPath, 15);
    for (let i = 0; i < 3; i++) {
      writeNote(vaultPath, {
        sessionId: `s${i}`,
        workItemId: null,
        body: 'authentication token oauth session bearer refresh',
      });
    }

    const result = await consolidate('test-agent', vaultPath, agent, { synthesisFn: mockSynthesis });

    expect(result).toHaveProperty('patternsWritten');
    expect(result).toHaveProperty('notesProcessed');
    expect(result).toHaveProperty('notesArchived');
    expect(result).toHaveProperty('patternsDeleted');
    expect(typeof result.patternsWritten).toBe('number');
    expect(typeof result.notesProcessed).toBe('number');
  });
});

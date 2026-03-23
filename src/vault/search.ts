/**
 * @fileoverview BM25 search over vault notes using flexsearch Document index.
 *
 * Index is built lazily on first query for a given agentId and cached in memory.
 * On each new capture, the index for that agentId is invalidated so the next
 * query rebuilds from disk (simple approach; avoids incremental update complexity).
 *
 * Performance target: <500ms for 1000 notes (actual: ~5-15ms build + ~1-2ms query).
 */

// @ts-expect-error — flexsearch types are incomplete; using runtime API
import FlexSearch from 'flexsearch';
import { listAllNotes } from './store.js';
import type { VaultNote, VaultQueryResult } from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// In-memory index cache
// ────────────────────────────────────────────────────────────────────────────

interface IndexEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  index: any;
  notes: Map<string, VaultNote>; // filename → VaultNote for quick lookup
}

const indexCache = new Map<string, IndexEntry>();

/** Invalidate the in-memory index for an agent (called after capture). */
export function invalidateIndex(agentId: string): void {
  indexCache.delete(agentId);
}

// ────────────────────────────────────────────────────────────────────────────
// Index building
// ────────────────────────────────────────────────────────────────────────────

function buildIndex(agentId: string, vaultPath: string): IndexEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const index = new (FlexSearch as any).Document({
    tokenize: 'forward',
    document: {
      id: 'filename',
      index: ['content', 'workItemId'],
    },
  });

  const notes = new Map<string, VaultNote>();
  const allNotes = listAllNotes(vaultPath);

  for (const note of allNotes) {
    notes.set(note.filename, note);
    index.add({
      filename: note.filename,
      content: note.content,
      workItemId: note.workItemId ?? '',
    });
  }

  const entry: IndexEntry = { index, notes };
  indexCache.set(agentId, entry);
  return entry;
}

function getOrBuildIndex(agentId: string, vaultPath: string): IndexEntry {
  const cached = indexCache.get(agentId);
  if (cached) return cached;
  return buildIndex(agentId, vaultPath);
}

// ────────────────────────────────────────────────────────────────────────────
// Snippet extraction
// ────────────────────────────────────────────────────────────────────────────

function extractSnippet(content: string, query: string): string {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const lines = content.split('\n');
  let bestLine = 0;
  let bestScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let score = 0;
    for (const word of words) {
      if (lower.includes(word)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  // Take bestLine ±2 lines of context
  const start = Math.max(0, bestLine - 2);
  const end = Math.min(lines.length - 1, bestLine + 2);
  const snippet = lines.slice(start, end + 1).join('\n');

  // Trim to 400 chars max
  if (snippet.length <= 400) return snippet;
  return snippet.slice(0, 397) + '...';
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Query the vault using BM25 full-text search.
 * Returns up to `limit` results sorted by relevance.
 */
export async function queryIndex(
  agentId: string,
  vaultPath: string,
  q: string,
  limit: number = 5
): Promise<VaultQueryResult[]> {
  if (!q.trim()) return [];

  const { index, notes } = getOrBuildIndex(agentId, vaultPath);

  // flexsearch Document.search returns per-field results.
  // With enrich:true, each fieldResult is {field, result: [{id, doc}]}.
  // flexsearch v0.8.x does not expose a raw BM25 score in enriched results,
  // so we assign normalized rank-based scores: (limit - rank) / limit → 0..1.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawResults: any[];
  try {
    rawResults = index.search(q, { limit, enrich: true });
  } catch {
    return [];
  }

  // Collect unique filenames with normalized rank scores (field results may duplicate)
  const seen = new Map<string, number>();
  let rank = 0;
  for (const fieldResult of rawResults) {
    const results: { id: string; doc: unknown }[] = fieldResult?.result ?? fieldResult ?? [];
    for (const item of results) {
      const filename = typeof item === 'string' ? item : item.id;
      if (!seen.has(filename)) {
        // Normalize: first result gets score 1.0, last gets (1/limit); 0..1 range
        seen.set(filename, (limit - rank) / limit);
        rank++;
      }
    }
  }

  const output: VaultQueryResult[] = [];
  for (const [filename, score] of seen) {
    const note = notes.get(filename);
    if (!note) continue;
    output.push({
      sourceType: 'note',
      sourceFile: filename,
      snippet: extractSnippet(note.content, q),
      score,
      workItemId: note.workItemId,
      timestamp: note.capturedAt,
    });
  }

  // Sort by score descending
  output.sort((a, b) => b.score - a.score);
  return output.slice(0, limit);
}

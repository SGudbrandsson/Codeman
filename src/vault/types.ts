/**
 * @fileoverview Vault type definitions for the per-agent memory vault.
 *
 * VaultNote — a single captured session memory note
 * VaultPattern — a consolidated synthesis of multiple notes (Phase 3)
 * VaultQueryResult — a search result from BM25 retrieval
 */

export interface VaultNote {
  filename: string; // e.g. "2026-03-23T14:05:22Z-abc123.md"
  capturedAt: string; // ISO timestamp
  sessionId: string;
  workItemId: string | null;
  content: string; // raw markdown (frontmatter + body)
  indexed: boolean; // true once BM25 index includes this note
}

export interface VaultPattern {
  filename: string; // e.g. "2026-03-23-cluster-3.md"
  consolidatedAt: string; // ISO timestamp
  sourceNotes: string[]; // filenames of clustered source notes
  content: string; // LLM-synthesized markdown
  clusterLabel: string; // dominant BM25 terms
}

export interface VaultQueryResult {
  sourceType: 'note' | 'pattern';
  sourceFile: string;
  snippet: string; // 200-400 chars surrounding best match
  score: number; // BM25 relevance score
  workItemId: string | null;
  timestamp: string; // ISO timestamp of source doc
}

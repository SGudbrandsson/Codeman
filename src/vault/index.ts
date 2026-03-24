/**
 * @fileoverview Public API for the memory vault module.
 *
 * capture() — write a timestamped note to the agent's vault
 * query()   — BM25 search over the agent's vault
 * injectVaultBriefing() — prepend a memory briefing section to CLAUDE.md
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { writeNote, countNotes } from './store.js';
import { queryIndex, invalidateIndex } from './search.js';
import type { VaultNote, VaultQueryResult } from './types.js';
import type { SessionState } from '../types/session.js';

export type { VaultNote, VaultPattern, VaultQueryResult } from './types.js';
export { consolidate, runMemoryDecay, CONSOLIDATION_THRESHOLD } from './consolidate.js';

// ────────────────────────────────────────────────────────────────────────────
// capture
// ────────────────────────────────────────────────────────────────────────────

/**
 * Capture a note into the agent's vault.
 * Writes to disk and invalidates the in-memory BM25 index.
 */
export async function capture(
  agentId: string,
  vaultPath: string,
  params: { sessionId: string; workItemId: string | null; content: string }
): Promise<VaultNote> {
  const note = writeNote(vaultPath, {
    sessionId: params.sessionId,
    workItemId: params.workItemId,
    body: params.content,
  });

  // Invalidate index so next query rebuilds from disk (includes this new note)
  invalidateIndex(agentId);

  return note;
}

// ────────────────────────────────────────────────────────────────────────────
// query
// ────────────────────────────────────────────────────────────────────────────

/**
 * Query the agent's vault using BM25 full-text search.
 * Returns top `limit` results sorted by relevance.
 */
export async function query(
  agentId: string,
  vaultPath: string,
  q: string,
  limit: number = 5
): Promise<VaultQueryResult[]> {
  return queryIndex(agentId, vaultPath, q, limit);
}

// ────────────────────────────────────────────────────────────────────────────
// injectVaultBriefing
// ────────────────────────────────────────────────────────────────────────────

const BRIEFING_START = '## Memory Briefing';
const BRIEFING_END_MARKER = '\n---\n';

/**
 * Query the vault using the session's work context and inject a
 * "## Memory Briefing" section into the CLAUDE.md at claudeMdPath.
 *
 * - If agentProfile is absent, this is a no-op.
 * - If vault is empty or query returns no results, this is a no-op.
 * - Replaces an existing "## Memory Briefing...---" block if present.
 * - Otherwise prepends the block at the top of the file.
 */
export async function injectVaultBriefing(sessionState: SessionState, claudeMdPath: string): Promise<void> {
  if (!sessionState.agentProfile) return;

  const { agentId, vaultPath } = sessionState.agentProfile;

  // Build query from available session context
  const q = sessionState.worktreeNotes ?? sessionState.name ?? '';
  if (!q.trim()) return;

  if (countNotes(vaultPath) === 0) return;

  let results: VaultQueryResult[];
  try {
    results = await queryIndex(agentId, vaultPath, q, 3);
  } catch {
    return;
  }

  if (results.length === 0) return;

  // Build the briefing block
  const lines = [BRIEFING_START, '', `*${results.length} memory note(s) retrieved for: "${q.slice(0, 80)}"*`, ''];
  for (const r of results) {
    lines.push(`### ${r.sourceFile}`);
    lines.push(`*${r.timestamp}*`);
    lines.push('');
    lines.push(r.snippet);
    lines.push('');
  }
  const briefingBlock = lines.join('\n') + '\n---\n';

  // Read existing CLAUDE.md (create empty if absent)
  let existing = '';
  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, 'utf-8');
  }

  let updated: string;
  const startIdx = existing.indexOf(BRIEFING_START);
  if (startIdx !== -1) {
    // Replace existing briefing block
    const endIdx = existing.indexOf(BRIEFING_END_MARKER, startIdx);
    if (endIdx !== -1) {
      updated = existing.slice(0, startIdx) + briefingBlock + existing.slice(endIdx + BRIEFING_END_MARKER.length);
    } else {
      // No trailing marker — replace to end of file
      updated = existing.slice(0, startIdx) + briefingBlock;
    }
  } else {
    // Prepend briefing
    updated = briefingBlock + '\n' + existing;
  }

  writeFileSync(claudeMdPath, updated, 'utf-8');
}

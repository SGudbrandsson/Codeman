/**
 * @fileoverview Vault consolidation pipeline — clusters notes by keyword overlap
 * and synthesises a pattern note per cluster via LLM (claude -p).
 *
 * Exported API:
 *   consolidate(agentId, vaultPath, agentProfile, options?) → ConsolidationResult
 *   runMemoryDecay(vaultPath, decay) → DecayResult
 *   CONSOLIDATION_THRESHOLD — default minimum notesSinceConsolidation to trigger
 *   callLLMSynthesis(prompt) — spawns `claude -p`, mockable in tests
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { listAllNotes } from './store.js';
import type { VaultNote } from './types.js';
import type { AgentProfile } from '../types/session.js';

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

export const CONSOLIDATION_THRESHOLD = 10;

const LLM_TIMEOUT_MS = 30_000;

// Common English stopwords — used during TF-IDF tokenisation
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'up',
  'about',
  'into',
  'through',
  'during',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'not',
  'no',
  'nor',
  'so',
  'yet',
  'both',
  'either',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'they',
  'them',
  'their',
  'we',
  'our',
  'you',
  'your',
  'he',
  'she',
  'him',
  'his',
  'her',
  'who',
  'which',
  'what',
  'how',
  'when',
  'where',
  'why',
  'all',
  'each',
  'every',
  'any',
  'some',
  'such',
  'than',
  'then',
  'also',
  'just',
  'only',
  'more',
]);

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface ConsolidationOptions {
  notesTtlDays?: number;
  patternsTtlDays?: number;
  /** Override LLM synthesis function (used in tests to avoid real claude calls). */
  synthesisFn?: (prompt: string) => Promise<string>;
}

export interface ConsolidationResult {
  patternsWritten: number;
  notesProcessed: number;
  notesArchived: number;
  patternsDeleted: number;
}

export interface DecayResult {
  notesArchived: number;
  patternsDeleted: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Tokenisation & clustering
// ────────────────────────────────────────────────────────────────────────────

/** Strip YAML frontmatter block (--- ... ---) and return the body. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return content;
  return content.slice(end + 4);
}

/** Tokenise text into a Set of lowercase terms, filtering stopwords and short tokens. */
function termSet(text: string): Set<string> {
  const body = stripFrontmatter(text);
  const tokens = body
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B| */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Greedy Jaccard clustering — groups notes with similarity >= threshold. */
function clusterNotes(notes: VaultNote[], threshold = 0.15): VaultNote[][] {
  // Pre-compute term sets
  const terms = notes.map((n) => termSet(n.content));
  const unclustered = notes.map((_, i) => i);
  const clusters: VaultNote[][] = [];

  const remaining = [...unclustered];
  while (remaining.length > 0) {
    const seedIdx = remaining.shift()!;
    const cluster: number[] = [seedIdx];
    const notInCluster: number[] = [];

    for (const idx of remaining) {
      if (jaccard(terms[seedIdx], terms[idx]) >= threshold) {
        cluster.push(idx);
      } else {
        notInCluster.push(idx);
      }
    }

    remaining.splice(0, remaining.length, ...notInCluster);
    clusters.push(cluster.map((i) => notes[i]));
  }

  return clusters;
}

/** Return top-N most frequent terms across a set of notes (for cluster label). */
function topTerms(notes: VaultNote[], n = 3): string {
  const freq = new Map<string, number>();
  for (const note of notes) {
    for (const term of termSet(note.content)) {
      freq.set(term, (freq.get(term) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t)
    .join(' ');
}

// ────────────────────────────────────────────────────────────────────────────
// LLM synthesis
// ────────────────────────────────────────────────────────────────────────────

/** Build the synthesis prompt for a cluster of notes. */
function buildSynthesisPrompt(notes: VaultNote[]): string {
  const n = notes.length;
  // Combine note bodies, truncated to 8000 chars total
  let combined = '';
  for (const note of notes) {
    combined += `---\n${note.content}\n`;
    if (combined.length >= 8000) {
      combined = combined.slice(0, 8000) + '\n[truncated]';
      break;
    }
  }

  return `You are a memory consolidation agent. Below are ${n} captured notes from an AI coding session.
Synthesize these into a single concise pattern note (max 300 words) that captures the key
insights, patterns, and lessons that would be useful for future reference.

Write in plain markdown. Start with a brief summary sentence. Use bullet points for key patterns.

NOTES:
${combined}

OUTPUT: A single markdown pattern note (no YAML frontmatter, just the body).`;
}

/**
 * Call `claude -p --output-format text` with the given prompt.
 * Mockable in tests via `vi.mock`.
 */
export async function callLLMSynthesis(prompt: string): Promise<string> {
  const timestamp = Date.now();
  const promptFile = join(tmpdir(), `codeman-consolidate-prompt-${timestamp}.txt`);

  writeFileSync(promptFile, prompt, 'utf-8');

  return new Promise<string>((resolve, reject) => {
    const cmd = `cat "${promptFile}" | claude -p --output-format text`;
    const child = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error('LLM synthesis timed out after 30s'));
    }, LLM_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        unlinkSync(promptFile);
      } catch {
        // best effort
      }
      if (timedOut) return;
      if (code !== 0) {
        reject(new Error(`claude -p exited with code ${code}`));
      } else {
        resolve(Buffer.concat(chunks).toString('utf-8').trim());
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      try {
        unlinkSync(promptFile);
      } catch {
        // best effort
      }
      reject(err);
    });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Memory decay
// ────────────────────────────────────────────────────────────────────────────

/**
 * Archive notes older than notesTtlDays; delete patterns older than patternsTtlDays.
 */
export function runMemoryDecay(
  vaultPath: string,
  decay: { notesTtlDays: number; patternsTtlDays: number }
): DecayResult {
  const notesDir = join(vaultPath, 'notes');
  const patternsDir = join(vaultPath, 'patterns');
  const archiveDir = join(vaultPath, 'archive');

  let notesArchived = 0;
  let patternsDeleted = 0;

  const nowMs = Date.now();
  const notesCutoffMs = nowMs - decay.notesTtlDays * 24 * 60 * 60 * 1000;
  const patternsCutoffMs = nowMs - decay.patternsTtlDays * 24 * 60 * 60 * 1000;

  // Archive old notes
  if (existsSync(notesDir)) {
    try {
      const files = readdirSync(notesDir).filter((f) => f.endsWith('.md'));
      for (const filename of files) {
        const filePath = join(notesDir, filename);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < notesCutoffMs) {
            if (!existsSync(archiveDir)) {
              mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
            }
            renameSync(filePath, join(archiveDir, filename));
            notesArchived++;
          }
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // ignore if directory unreadable
    }
  }

  // Delete old patterns
  if (existsSync(patternsDir)) {
    try {
      const files = readdirSync(patternsDir).filter((f) => f.endsWith('.md'));
      for (const filename of files) {
        const filePath = join(patternsDir, filename);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < patternsCutoffMs) {
            unlinkSync(filePath);
            patternsDeleted++;
          }
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // ignore if directory unreadable
    }
  }

  return { notesArchived, patternsDeleted };
}

// ────────────────────────────────────────────────────────────────────────────
// Pattern writing (self-contained, re-exported from store after store is updated)
// ────────────────────────────────────────────────────────────────────────────

/** Determine the next available cluster filename index for today. */
function nextClusterIndex(patternsDir: string, dateStr: string): number {
  if (!existsSync(patternsDir)) return 0;
  try {
    const existing = readdirSync(patternsDir)
      .filter((f) => f.startsWith(`${dateStr}-cluster-`) && f.endsWith('.md'))
      .map((f) => {
        const match = f.match(/-cluster-(\d+)\.md$/);
        return match ? parseInt(match[1], 10) : -1;
      })
      .filter((n) => n >= 0);
    return existing.length === 0 ? 0 : Math.max(...existing) + 1;
  } catch {
    return 0;
  }
}

/** Write a pattern note to vault/patterns/. Returns the filename. */
function writePatternFile(
  vaultPath: string,
  params: {
    consolidatedAt: string;
    sourceNotes: string[];
    clusterLabel: string;
    body: string;
  }
): string {
  const patternsDir = join(vaultPath, 'patterns');
  if (!existsSync(patternsDir)) {
    mkdirSync(patternsDir, { recursive: true, mode: 0o700 });
  }

  const dateStr = params.consolidatedAt.slice(0, 10); // YYYY-MM-DD
  const idx = nextClusterIndex(patternsDir, dateStr);
  const filename = `${dateStr}-cluster-${idx}.md`;
  const filePath = join(patternsDir, filename);

  const sourceNotesYaml = params.sourceNotes.map((f) => `  - ${f}`).join('\n');
  const frontmatter = [
    '---',
    `consolidatedAt: ${params.consolidatedAt}`,
    `sourceNotes:`,
    sourceNotesYaml,
    `clusterLabel: ${params.clusterLabel}`,
    '---',
    '',
  ].join('\n');

  const content = frontmatter + `## Pattern: ${params.clusterLabel}\n\n${params.body}`;
  writeFileSync(filePath, content, 'utf-8');

  return filename;
}

// ────────────────────────────────────────────────────────────────────────────
// Main consolidation pipeline
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run the full consolidation pipeline for an agent's vault.
 *
 * @param agentId - The agent's ID (used for guard check only)
 * @param vaultPath - Path to the agent's vault directory
 * @param agentProfile - Current agent profile (for notesSinceConsolidation + decay config)
 * @param options - Override decay TTL values
 */
export async function consolidate(
  _agentId: string,
  vaultPath: string,
  agentProfile: AgentProfile,
  options?: ConsolidationOptions
): Promise<ConsolidationResult> {
  const { notesSinceConsolidation, decay } = agentProfile;
  const notesTtlDays = options?.notesTtlDays ?? decay.notesTtlDays;
  const patternsTtlDays = options?.patternsTtlDays ?? decay.patternsTtlDays;
  const synthesize = options?.synthesisFn ?? callLLMSynthesis;

  // Guard: skip if not enough notes since last consolidation (manual override: caller passes 999)
  if (notesSinceConsolidation <= CONSOLIDATION_THRESHOLD) {
    return { patternsWritten: 0, notesProcessed: 0, notesArchived: 0, patternsDeleted: 0 };
  }

  // Step 1: Load all notes
  const allNotes = listAllNotes(vaultPath);
  if (allNotes.length < 2) {
    return { patternsWritten: 0, notesProcessed: allNotes.length, notesArchived: 0, patternsDeleted: 0 };
  }

  // Step 2: Memory decay
  const { notesArchived, patternsDeleted } = runMemoryDecay(vaultPath, { notesTtlDays, patternsTtlDays });

  // Reload notes after decay (some may have been archived)
  const notes = listAllNotes(vaultPath);
  if (notes.length < 2) {
    return { patternsWritten: 0, notesProcessed: notes.length, notesArchived, patternsDeleted };
  }

  // Step 3: Cluster notes by TF-IDF keyword overlap (Jaccard >= 0.15)
  const clusters = clusterNotes(notes);

  // Step 4: Synthesise a pattern for each cluster with >= 2 notes
  let patternsWritten = 0;
  const consolidatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  for (const cluster of clusters) {
    if (cluster.length < 2) continue; // skip singletons

    const clusterLabel = topTerms(cluster, 3);
    const prompt = buildSynthesisPrompt(cluster);

    let body: string;
    try {
      body = await synthesize(prompt);
    } catch (err) {
      console.error('[vault:consolidate] LLM synthesis failed for cluster:', err);
      continue; // skip this cluster rather than fail the whole pipeline
    }

    if (!body.trim()) continue;

    try {
      writePatternFile(vaultPath, {
        consolidatedAt,
        sourceNotes: cluster.map((n) => n.filename),
        clusterLabel,
        body,
      });
      patternsWritten++;
    } catch (err) {
      console.error('[vault:consolidate] Failed to write pattern file:', err);
    }
  }

  return {
    patternsWritten,
    notesProcessed: notes.length,
    notesArchived,
    patternsDeleted,
  };
}

// Re-export for convenience (used internally and in tests)
export { writePatternFile };

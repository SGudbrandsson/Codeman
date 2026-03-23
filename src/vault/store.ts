/**
 * @fileoverview Vault disk I/O — read/write/list/delete markdown notes.
 *
 * Notes live at: <vaultPath>/notes/<ISO-timestamp>-<sessionId-first8>.md
 * Format: YAML frontmatter + markdown body.
 *
 * All paths use the agentProfile.vaultPath which is set at agent creation time
 * to ~/.codeman/vaults/<agentId>/
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { VaultNote } from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

function notesDir(vaultPath: string): string {
  return join(vaultPath, 'notes');
}

export function ensureVaultDirs(vaultPath: string): void {
  for (const sub of ['notes', 'patterns', 'index']) {
    const dir = join(vaultPath, sub);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

function buildFilename(sessionId: string): string {
  // Format: 2026-03-23T14:05:22Z-abc12345.md
  // ISO timestamp keeps colons — Linux allows colons in filenames
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); // strip ms
  const shortId = sessionId.replace(/-/g, '').slice(0, 8);
  return `${ts}-${shortId}.md`;
}

function buildFrontmatter(capturedAt: string, sessionId: string, workItemId: string | null): string {
  const lines = ['---', `capturedAt: ${capturedAt}`, `sessionId: ${sessionId}`];
  if (workItemId) {
    lines.push(`workItemId: ${workItemId}`);
  } else {
    lines.push('workItemId: null');
  }
  lines.push('---', '');
  return lines.join('\n');
}

interface Frontmatter {
  capturedAt: string;
  sessionId: string;
  workItemId: string | null;
}

function parseFrontmatter(content: string): Frontmatter | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  const block = content.slice(4, end);
  const fm: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fm[key] = value;
  }
  return {
    capturedAt: fm['capturedAt'] ?? new Date().toISOString(),
    sessionId: fm['sessionId'] ?? '',
    workItemId: fm['workItemId'] === 'null' || !fm['workItemId'] ? null : fm['workItemId'],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/** Write a new note to disk. Creates vault directories if needed. */
export function writeNote(
  vaultPath: string,
  params: { sessionId: string; workItemId: string | null; body: string }
): VaultNote {
  ensureVaultDirs(vaultPath);

  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const filename = buildFilename(params.sessionId);
  const frontmatter = buildFrontmatter(capturedAt, params.sessionId, params.workItemId);
  const content = frontmatter + params.body;

  const filePath = join(notesDir(vaultPath), filename);
  writeFileSync(filePath, content, 'utf-8');

  return {
    filename,
    capturedAt,
    sessionId: params.sessionId,
    workItemId: params.workItemId,
    content,
    indexed: false,
  };
}

/** Read a single note by filename. Returns null if not found or path traversal detected. */
export function readNote(vaultPath: string, filename: string): VaultNote | null {
  const dir = resolve(notesDir(vaultPath));
  const filePath = resolve(dir, filename);
  // Guard against path traversal (e.g. "../" sequences in filename)
  if (!filePath.startsWith(dir + '/') && filePath !== dir) return null;
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    if (!fm) return null;

    return {
      filename,
      capturedAt: fm.capturedAt,
      sessionId: fm.sessionId,
      workItemId: fm.workItemId,
      content,
      indexed: true, // persisted notes are covered by the BM25 index
    };
  } catch {
    return null;
  }
}

/** List all notes, sorted newest-first. Supports pagination. */
export function listNotes(
  vaultPath: string,
  options: { limit?: number; offset?: number } = {}
): { notes: VaultNote[]; total: number } {
  const dir = notesDir(vaultPath);
  if (!existsSync(dir)) {
    return { notes: [], total: 0 };
  }

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse(); // newest-first (ISO sort works)
  } catch {
    return { notes: [], total: 0 };
  }

  const total = files.length;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const slice = files.slice(offset, offset + limit);

  const notes: VaultNote[] = [];
  for (const filename of slice) {
    const note = readNote(vaultPath, filename);
    if (note) notes.push(note);
  }

  return { notes, total };
}

/** List all notes as raw content (for BM25 index building). */
export function listAllNotes(vaultPath: string): VaultNote[] {
  const { notes } = listNotes(vaultPath, { limit: 100_000 });
  return notes;
}

/** Delete a note by filename. Returns true if deleted, false if not found or path traversal detected. */
export function deleteNote(vaultPath: string, filename: string): boolean {
  const dir = resolve(notesDir(vaultPath));
  const filePath = resolve(dir, filename);
  // Guard against path traversal (e.g. "../" sequences in filename)
  if (!filePath.startsWith(dir + '/') && filePath !== dir) return false;
  if (!existsSync(filePath)) return false;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Count the number of notes in the vault. */
export function countNotes(vaultPath: string): number {
  const dir = notesDir(vaultPath);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

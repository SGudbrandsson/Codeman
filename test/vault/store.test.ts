/**
 * @fileoverview Tests for src/vault/store.ts
 *
 * Covers: writeNote, readNote, listNotes, listAllNotes, deleteNote,
 *         countNotes, ensureVaultDirs, and path-traversal guards.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeNote,
  readNote,
  listNotes,
  listAllNotes,
  deleteNote,
  countNotes,
  ensureVaultDirs,
} from '../../src/vault/store.js';

function makeTmpVault(suffix: string): string {
  const dir = join(tmpdir(), `vault-store-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('vault/store', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = makeTmpVault('main');
  });

  afterEach(() => {
    rmSync(vaultPath, { recursive: true, force: true });
  });

  // ── ensureVaultDirs ────────────────────────────────────────────────────────

  describe('ensureVaultDirs', () => {
    it('creates notes, patterns, and index subdirectories', () => {
      ensureVaultDirs(vaultPath);
      expect(existsSync(join(vaultPath, 'notes'))).toBe(true);
      expect(existsSync(join(vaultPath, 'patterns'))).toBe(true);
      expect(existsSync(join(vaultPath, 'index'))).toBe(true);
    });

    it('is idempotent — calling twice does not throw', () => {
      ensureVaultDirs(vaultPath);
      expect(() => ensureVaultDirs(vaultPath)).not.toThrow();
    });
  });

  // ── writeNote ─────────────────────────────────────────────────────────────

  describe('writeNote', () => {
    it('returns a VaultNote with correct fields', () => {
      const note = writeNote(vaultPath, {
        sessionId: 'session-abc123',
        workItemId: 'wi-1',
        body: '## Summary\nDid some work.',
      });
      expect(note.filename).toMatch(/\.md$/);
      expect(note.sessionId).toBe('session-abc123');
      expect(note.workItemId).toBe('wi-1');
      expect(note.content).toContain('## Summary');
      expect(note.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(note.indexed).toBe(false);
    });

    it('creates the note file on disk', () => {
      const note = writeNote(vaultPath, {
        sessionId: 'sess-1',
        workItemId: null,
        body: 'body text',
      });
      const filePath = join(vaultPath, 'notes', note.filename);
      expect(existsSync(filePath)).toBe(true);
    });

    it('writes YAML frontmatter + body to disk', () => {
      const note = writeNote(vaultPath, {
        sessionId: 'sess-fm',
        workItemId: 'task-42',
        body: 'hello world',
      });
      expect(note.content).toContain('capturedAt:');
      expect(note.content).toContain('sessionId: sess-fm');
      expect(note.content).toContain('workItemId: task-42');
      expect(note.content).toContain('hello world');
    });

    it('writes workItemId: null in frontmatter when null passed', () => {
      const note = writeNote(vaultPath, {
        sessionId: 'sess-null',
        workItemId: null,
        body: 'no workitem',
      });
      expect(note.content).toContain('workItemId: null');
    });

    it('auto-creates vault directories if they do not exist', () => {
      // Use a subdirectory that does not yet exist
      const freshVault = join(tmpdir(), `vault-fresh-${Date.now()}`);
      try {
        const note = writeNote(freshVault, {
          sessionId: 'sess-fresh',
          workItemId: null,
          body: 'auto-create test',
        });
        expect(existsSync(join(freshVault, 'notes', note.filename))).toBe(true);
      } finally {
        rmSync(freshVault, { recursive: true, force: true });
      }
    });
  });

  // ── readNote ──────────────────────────────────────────────────────────────

  describe('readNote', () => {
    it('reads back a written note with correct fields', () => {
      const written = writeNote(vaultPath, {
        sessionId: 'read-sess',
        workItemId: 'wi-read',
        body: 'read body',
      });
      const read = readNote(vaultPath, written.filename);
      expect(read).not.toBeNull();
      expect(read!.sessionId).toBe('read-sess');
      expect(read!.workItemId).toBe('wi-read');
      expect(read!.content).toContain('read body');
      expect(read!.indexed).toBe(true); // persisted notes are indexed
    });

    it('returns null for nonexistent filename', () => {
      ensureVaultDirs(vaultPath);
      expect(readNote(vaultPath, 'does-not-exist.md')).toBeNull();
    });

    it('blocks path traversal with ../ in filename', () => {
      ensureVaultDirs(vaultPath);
      expect(readNote(vaultPath, '../escape.md')).toBeNull();
    });

    it('blocks path traversal with nested ../ sequences', () => {
      ensureVaultDirs(vaultPath);
      expect(readNote(vaultPath, '../../etc/passwd')).toBeNull();
    });
  });

  // ── listNotes ─────────────────────────────────────────────────────────────

  describe('listNotes', () => {
    it('returns empty list when vault does not exist', () => {
      const { notes, total } = listNotes('/tmp/nonexistent-vault-xyz');
      expect(notes).toEqual([]);
      expect(total).toBe(0);
    });

    it('returns notes sorted newest-first', async () => {
      // Write two notes with a small delay to ensure different timestamps
      const n1 = writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'first' });
      await new Promise((r) => setTimeout(r, 10));
      const n2 = writeNote(vaultPath, { sessionId: 's2', workItemId: null, body: 'second' });

      const { notes, total } = listNotes(vaultPath);
      expect(total).toBe(2);
      // Newest (n2) should come first — ISO string sort reversed
      expect(notes[0].filename >= notes[1].filename).toBe(true);
      // Both notes present
      const filenames = notes.map((n) => n.filename);
      expect(filenames).toContain(n1.filename);
      expect(filenames).toContain(n2.filename);
    });

    it('paginates with limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        writeNote(vaultPath, { sessionId: `s${i}`, workItemId: null, body: `note ${i}` });
      }
      const page1 = listNotes(vaultPath, { limit: 2, offset: 0 });
      expect(page1.notes).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = listNotes(vaultPath, { limit: 2, offset: 2 });
      expect(page2.notes).toHaveLength(2);

      const page3 = listNotes(vaultPath, { limit: 2, offset: 4 });
      expect(page3.notes).toHaveLength(1);
    });

    it('defaults to limit 50', () => {
      for (let i = 0; i < 3; i++) {
        writeNote(vaultPath, { sessionId: `s${i}`, workItemId: null, body: `note ${i}` });
      }
      const { notes, total } = listNotes(vaultPath);
      expect(total).toBe(3);
      expect(notes).toHaveLength(3);
    });
  });

  // ── listAllNotes ──────────────────────────────────────────────────────────

  describe('listAllNotes', () => {
    it('returns all notes with no limit', () => {
      for (let i = 0; i < 10; i++) {
        writeNote(vaultPath, { sessionId: `s${i}`, workItemId: null, body: `note ${i}` });
      }
      const all = listAllNotes(vaultPath);
      expect(all).toHaveLength(10);
    });

    it('returns empty array for empty vault', () => {
      ensureVaultDirs(vaultPath);
      expect(listAllNotes(vaultPath)).toEqual([]);
    });
  });

  // ── deleteNote ────────────────────────────────────────────────────────────

  describe('deleteNote', () => {
    it('deletes an existing note and returns true', () => {
      const note = writeNote(vaultPath, { sessionId: 's-del', workItemId: null, body: 'delete me' });
      const result = deleteNote(vaultPath, note.filename);
      expect(result).toBe(true);
      expect(readNote(vaultPath, note.filename)).toBeNull();
    });

    it('returns false for nonexistent note', () => {
      ensureVaultDirs(vaultPath);
      expect(deleteNote(vaultPath, 'nonexistent.md')).toBe(false);
    });

    it('blocks path traversal with ../ in filename', () => {
      ensureVaultDirs(vaultPath);
      expect(deleteNote(vaultPath, '../escape.md')).toBe(false);
    });

    it('blocks nested path traversal', () => {
      ensureVaultDirs(vaultPath);
      expect(deleteNote(vaultPath, '../../sensitive')).toBe(false);
    });
  });

  // ── countNotes ────────────────────────────────────────────────────────────

  describe('countNotes', () => {
    it('returns 0 when vault does not exist', () => {
      expect(countNotes('/tmp/nonexistent-count-xyz')).toBe(0);
    });

    it('returns 0 for empty notes directory', () => {
      ensureVaultDirs(vaultPath);
      expect(countNotes(vaultPath)).toBe(0);
    });

    it('returns correct count after writing notes', () => {
      writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'a' });
      writeNote(vaultPath, { sessionId: 's2', workItemId: null, body: 'b' });
      writeNote(vaultPath, { sessionId: 's3', workItemId: null, body: 'c' });
      expect(countNotes(vaultPath)).toBe(3);
    });

    it('decrements after deleting a note', () => {
      const note = writeNote(vaultPath, { sessionId: 's1', workItemId: null, body: 'x' });
      expect(countNotes(vaultPath)).toBe(1);
      deleteNote(vaultPath, note.filename);
      expect(countNotes(vaultPath)).toBe(0);
    });
  });
});

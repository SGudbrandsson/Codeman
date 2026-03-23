/**
 * @fileoverview SQLite database handle for the work item graph.
 *
 * Opens ~/.codeman/work-items.db (or an in-memory DB for tests) using
 * better-sqlite3, runs schema migrations on first open, and exports a
 * singleton `getDb()` getter plus `openDb()` / `closeDb()` for test teardown.
 */

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_items (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'queued',
  source          TEXT NOT NULL DEFAULT 'manual',
  assigned_agent_id TEXT,
  created_at      TEXT NOT NULL,
  assigned_at     TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  worktree_path   TEXT,
  branch_name     TEXT,
  task_md_path    TEXT,
  external_ref    TEXT,
  external_url    TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  compact_summary TEXT
);

CREATE TABLE IF NOT EXISTS dependencies (
  from_id    TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'blocks',
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS idx_wi_status ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_deps_to_id ON dependencies(to_id);
`;

/**
 * Open (or reuse) the work items database.
 *
 * @param path - Override path, e.g. ':memory:' for tests. Defaults to
 *               ~/.codeman/work-items.db.
 */
export function openDb(path?: string): Database.Database {
  const resolvedPath = path ?? join(homedir(), '.codeman', 'work-items.db');

  if (_db && _dbPath === resolvedPath) {
    return _db;
  }

  // Ensure the directory exists (skip for :memory:)
  if (resolvedPath !== ':memory:') {
    mkdirSync(join(homedir(), '.codeman'), { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  _db = db;
  _dbPath = resolvedPath;
  return db;
}

/**
 * Returns the singleton DB handle, opening it with the default path if not
 * already open.
 */
export function getDb(): Database.Database {
  if (!_db) {
    return openDb();
  }
  return _db;
}

/**
 * Close the database and reset the singleton. Used in tests to allow
 * re-opening with a fresh in-memory DB between test runs.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

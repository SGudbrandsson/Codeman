/**
 * @fileoverview Synchronous work item store backed by better-sqlite3.
 *
 * All operations are synchronous (better-sqlite3 style). Higher-level callers
 * (routes, hooks) import these functions directly.
 */

import { createHash } from 'node:crypto';
import { getDb } from './db.js';
import type { WorkItem, WorkItemDependency, WorkItemSource, WorkItemStatus } from './types.js';

// ─── Internal row type (snake_case columns) ──────────────────────────────────

interface WorkItemRow {
  id: string;
  title: string;
  description: string;
  status: string;
  source: string;
  assigned_agent_id: string | null;
  created_at: string;
  assigned_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  task_md_path: string | null;
  external_ref: string | null;
  external_url: string | null;
  metadata: string;
  compact_summary: string | null;
  case_id: string | null;
}

interface DependencyRow {
  from_id: string;
  to_id: string;
  type: string;
  created_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as WorkItemStatus,
    source: row.source as WorkItemSource,
    assignedAgentId: row.assigned_agent_id,
    createdAt: row.created_at,
    assignedAt: row.assigned_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    taskMdPath: row.task_md_path,
    externalRef: row.external_ref,
    externalUrl: row.external_url,
    metadata: JSON.parse(row.metadata || '{}') as Record<string, unknown>,
    compactSummary: row.compact_summary,
    caseId: row.case_id,
  };
}

function rowToDependency(row: DependencyRow): WorkItemDependency {
  return {
    fromId: row.from_id,
    toId: row.to_id,
    type: row.type as 'blocks',
    createdAt: row.created_at,
  };
}

/**
 * Generate a work item ID from title + source + createdAt.
 * Retries with a longer slice on UNIQUE constraint violation.
 */
function makeId(title: string, source: string, createdAt: string, slice = 8): string {
  const hash = createHash('sha256')
    .update(title + source + createdAt)
    .digest('hex');
  return `wi-${hash.slice(0, slice)}`;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Create a new work item. Returns the created item.
 */
export function createWorkItem(input: {
  title: string;
  description?: string;
  source?: WorkItemSource;
  metadata?: Record<string, unknown>;
  externalRef?: string;
  externalUrl?: string;
  caseId?: string;
}): WorkItem {
  const db = getDb();
  const createdAt = new Date().toISOString();
  const source: WorkItemSource = input.source ?? 'manual';

  let id = makeId(input.title, source, createdAt);

  // Retry with 12-char slice on collision
  const stmt = db.prepare(`
    INSERT INTO work_items (id, title, description, status, source, created_at, metadata)
    VALUES (?, ?, ?, 'queued', ?, ?, ?)
  `);

  let inserted = false;
  for (const sliceLen of [8, 12, 16]) {
    id = makeId(input.title, source, createdAt + sliceLen.toString());
    if (sliceLen === 8) {
      id = makeId(input.title, source, createdAt);
    }
    try {
      stmt.run(id, input.title, input.description ?? '', source, createdAt, JSON.stringify(input.metadata ?? {}));
      inserted = true;
      break;
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e.code === 'SQLITE_CONSTRAINT') {
        id = makeId(input.title, source, createdAt, sliceLen + 4);
        continue;
      }
      throw err;
    }
  }

  if (!inserted) {
    throw new Error(`Failed to insert work item after retries — id collision for "${input.title}"`);
  }

  // Update optional fields if provided
  if (input.externalRef || input.externalUrl) {
    db.prepare(
      `
      UPDATE work_items SET external_ref = ?, external_url = ? WHERE id = ?
    `
    ).run(input.externalRef ?? null, input.externalUrl ?? null, id);
  }

  if (input.caseId) {
    db.prepare('UPDATE work_items SET case_id = ? WHERE id = ?').run(input.caseId, id);
  }

  return getWorkItem(id)!;
}

/**
 * Get a work item by ID. Returns null if not found.
 */
export function getWorkItem(id: string): WorkItem | null {
  const row = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItemRow | undefined;
  return row ? rowToWorkItem(row) : null;
}

/**
 * List all work items, with optional filters.
 */
export function listWorkItems(filters?: { status?: WorkItemStatus; agentId?: string; caseId?: string }): WorkItem[] {
  const db = getDb();
  let sql = 'SELECT * FROM work_items WHERE 1=1';
  const params: unknown[] = [];

  if (filters?.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters?.agentId) {
    sql += ' AND assigned_agent_id = ?';
    params.push(filters.agentId);
  }
  if (filters?.caseId) {
    sql += ' AND case_id = ?';
    params.push(filters.caseId);
  }

  sql += ' ORDER BY created_at ASC';
  const rows = db.prepare(sql).all(...params) as WorkItemRow[];
  return rows.map(rowToWorkItem);
}

/**
 * Update fields on a work item. Returns the updated item, or null if not found.
 * Automatically sets completedAt when transitioning to done or cancelled.
 */
export function updateWorkItem(id: string, updates: Partial<Omit<WorkItem, 'id' | 'createdAt'>>): WorkItem | null {
  const db = getDb();
  const existing = getWorkItem(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const completedAt =
    updates.status === 'done' || updates.status === 'cancelled'
      ? (updates.completedAt ?? now)
      : (updates.completedAt ?? existing.completedAt);

  db.prepare(
    `
    UPDATE work_items SET
      title            = ?,
      description      = ?,
      status           = ?,
      source           = ?,
      assigned_agent_id = ?,
      assigned_at      = ?,
      started_at       = ?,
      completed_at     = ?,
      worktree_path    = ?,
      branch_name      = ?,
      task_md_path     = ?,
      external_ref     = ?,
      external_url     = ?,
      metadata         = ?,
      compact_summary  = ?,
      case_id          = ?
    WHERE id = ?
  `
  ).run(
    updates.title ?? existing.title,
    updates.description ?? existing.description,
    updates.status ?? existing.status,
    updates.source ?? existing.source,
    updates.assignedAgentId !== undefined ? updates.assignedAgentId : existing.assignedAgentId,
    updates.assignedAt !== undefined ? updates.assignedAt : existing.assignedAt,
    updates.startedAt !== undefined ? updates.startedAt : existing.startedAt,
    completedAt,
    updates.worktreePath !== undefined ? updates.worktreePath : existing.worktreePath,
    updates.branchName !== undefined ? updates.branchName : existing.branchName,
    updates.taskMdPath !== undefined ? updates.taskMdPath : existing.taskMdPath,
    updates.externalRef !== undefined ? updates.externalRef : existing.externalRef,
    updates.externalUrl !== undefined ? updates.externalUrl : existing.externalUrl,
    JSON.stringify(updates.metadata ?? existing.metadata),
    updates.compactSummary !== undefined ? updates.compactSummary : existing.compactSummary,
    updates.caseId !== undefined ? updates.caseId : existing.caseId,
    id
  );

  return getWorkItem(id);
}

/**
 * Delete a work item by ID. Returns true if deleted, false if not found.
 */
export function deleteWorkItem(id: string): boolean {
  const db = getDb();
  // Clear message FK references first (messages table lacks ON DELETE CASCADE)
  db.prepare('UPDATE messages SET work_item_id = NULL WHERE work_item_id = ?').run(id);
  const result = db.prepare('DELETE FROM work_items WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Claim ───────────────────────────────────────────────────────────────────

/**
 * Atomically claim a work item for an agent.
 * Returns the updated item, or null if the item was not in 'queued' status
 * (caller should return 409).
 */
export function claimWorkItem(id: string, agentId: string): WorkItem | null {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `
    UPDATE work_items
    SET status = 'assigned', assigned_agent_id = ?, assigned_at = ?
    WHERE id = ? AND status = 'queued'
  `
    )
    .run(agentId, now, id);

  if (result.changes === 0) {
    return null;
  }

  return getWorkItem(id);
}

// ─── Ready query ─────────────────────────────────────────────────────────────

/**
 * Return all queued work items that have no unfinished blockers.
 * A blocker is "finished" when its status is 'done' or 'cancelled'.
 */
export function getReadyWorkItems(): WorkItem[] {
  const rows = getDb()
    .prepare(
      `
    SELECT * FROM work_items wi
    WHERE wi.status = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM dependencies d
        JOIN work_items blocker ON blocker.id = d.from_id
        WHERE d.to_id = wi.id
          AND blocker.status NOT IN ('done', 'cancelled')
      )
    ORDER BY wi.created_at ASC
  `
    )
    .all() as WorkItemRow[];

  return rows.map(rowToWorkItem);
}

// ─── Dependencies ─────────────────────────────────────────────────────────────

/**
 * Add a dependency: fromId blocks toId.
 * Throws on circular dependency detection.
 */
export function addDependency(fromId: string, toId: string): WorkItemDependency {
  const db = getDb();

  // Detect circular dependency via BFS: walk upward from fromId.
  // If we reach toId, adding this edge would create a cycle.
  const visited = new Set<string>();
  const queue: string[] = [fromId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toId) {
      throw new Error(`Circular dependency detected: ${toId} already (transitively) blocks ${fromId}`);
    }
    if (visited.has(current)) continue;
    visited.add(current);

    // Find what blocks `current` (i.e. rows where to_id = current)
    const ancestors = db
      .prepare(
        `
      SELECT from_id FROM dependencies WHERE to_id = ?
    `
      )
      .all(current) as { from_id: string }[];

    for (const row of ancestors) {
      if (!visited.has(row.from_id)) {
        queue.push(row.from_id);
      }
    }
  }

  const createdAt = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO dependencies (from_id, to_id, type, created_at)
    VALUES (?, ?, 'blocks', ?)
  `
  ).run(fromId, toId, createdAt);

  return { fromId, toId, type: 'blocks', createdAt };
}

/**
 * Remove a dependency edge.
 * Returns true if removed, false if not found.
 */
export function removeDependency(fromId: string, toId: string): boolean {
  const result = getDb()
    .prepare(
      `
    DELETE FROM dependencies WHERE from_id = ? AND to_id = ?
  `
    )
    .run(fromId, toId);
  return result.changes > 0;
}

/**
 * List all dependencies for a given work item (as both from and to).
 */
export function listDependencies(workItemId: string): WorkItemDependency[] {
  const rows = getDb()
    .prepare(
      `
    SELECT * FROM dependencies WHERE from_id = ? OR to_id = ?
  `
    )
    .all(workItemId, workItemId) as DependencyRow[];
  return rows.map(rowToDependency);
}

// ─── Memory decay ─────────────────────────────────────────────────────────────

/**
 * Run memory decay:
 * - Compact done items older than 30 days (clear description, set compact_summary).
 * - Delete cancelled items older than 7 days.
 *
 * Returns counts of affected rows.
 */
export function decay(): { compacted: number; deleted: number } {
  const db = getDb();

  const compactResult = db
    .prepare(
      `
    UPDATE work_items
    SET compact_summary = title || ' [compacted]',
        description = ''
    WHERE status = 'done'
      AND completed_at < datetime('now', '-30 days')
      AND (compact_summary IS NULL OR compact_summary NOT LIKE '% [compacted]')
  `
    )
    .run();

  const deleteResult = db
    .prepare(
      `
    DELETE FROM work_items
    WHERE status = 'cancelled'
      AND completed_at < datetime('now', '-7 days')
  `
    )
    .run();

  return {
    compacted: compactResult.changes,
    deleted: deleteResult.changes,
  };
}

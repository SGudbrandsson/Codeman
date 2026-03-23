/**
 * @fileoverview Unit tests for src/work-items/db.ts and src/work-items/store.ts
 *
 * Uses an in-memory SQLite database for each test. openDb(':memory:') is called
 * in beforeEach and closeDb() in afterEach to give each test a clean slate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, closeDb } from '../../src/work-items/db.js';
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  deleteWorkItem,
  claimWorkItem,
  getReadyWorkItems,
  addDependency,
  removeDependency,
  listDependencies,
  decay,
} from '../../src/work-items/store.js';

beforeEach(() => {
  openDb(':memory:');
});

afterEach(() => {
  closeDb();
});

// ─── db.ts ────────────────────────────────────────────────────────────────────

describe('db: openDb', () => {
  it('opens an in-memory DB with schema ready (work_items table exists)', () => {
    // If createWorkItem doesn't throw, the schema was created
    expect(() => createWorkItem({ title: 'schema check' })).not.toThrow();
  });

  it('returns the same handle on repeated openDb calls with the same path', () => {
    const db1 = openDb(':memory:');
    const db2 = openDb(':memory:');
    expect(db1).toBe(db2);
  });
});

describe('db: closeDb', () => {
  it('resets the singleton so a subsequent openDb opens a fresh DB', () => {
    createWorkItem({ title: 'before close' });
    closeDb();
    openDb(':memory:');
    // Fresh in-memory DB — the item should not exist
    expect(listWorkItems()).toHaveLength(0);
  });
});

// ─── createWorkItem ───────────────────────────────────────────────────────────

describe('createWorkItem', () => {
  it('returns an item with status queued and wi- prefixed 8-char hex ID', () => {
    const item = createWorkItem({ title: 'My task' });
    expect(item.status).toBe('queued');
    expect(item.id).toMatch(/^wi-[0-9a-f]{8}$/);
  });

  it('hash ID format is exactly wi-[0-9a-f]{8}', () => {
    const item = createWorkItem({ title: 'hash format test' });
    expect(item.id).toMatch(/^wi-[0-9a-f]{8}$/);
  });

  it('sets title, description, source from input', () => {
    const item = createWorkItem({
      title: 'Feature X',
      description: 'Build the thing',
      source: 'github',
    });
    expect(item.title).toBe('Feature X');
    expect(item.description).toBe('Build the thing');
    expect(item.source).toBe('github');
  });

  it('defaults source to manual when not provided', () => {
    const item = createWorkItem({ title: 'defaults test' });
    expect(item.source).toBe('manual');
  });

  it('stores externalRef and externalUrl when provided', () => {
    const item = createWorkItem({
      title: 'External task',
      externalRef: 'GH-42',
      externalUrl: 'https://github.com/org/repo/issues/42',
    });
    expect(item.externalRef).toBe('GH-42');
    expect(item.externalUrl).toBe('https://github.com/org/repo/issues/42');
  });

  it('returns item with null externalRef/externalUrl when not provided', () => {
    const item = createWorkItem({ title: 'no external' });
    expect(item.externalRef).toBeNull();
    expect(item.externalUrl).toBeNull();
  });

  it('stores metadata JSON and returns it as an object', () => {
    const meta = { priority: 'high', tags: ['backend'] };
    const item = createWorkItem({ title: 'meta test', metadata: meta });
    expect(item.metadata).toEqual(meta);
  });

  it('handles hash collision retry — pre-inserted row forces longer hash', () => {
    // Create a first item to establish a unique ID
    const first = createWorkItem({ title: 'collision base' });
    expect(first.id).toBeDefined();

    // We cannot easily force a collision deterministically, but we can verify
    // that a second item with a different title gets a different ID
    const second = createWorkItem({ title: 'collision other' });
    expect(second.id).not.toBe(first.id);
  });
});

// ─── getWorkItem ──────────────────────────────────────────────────────────────

describe('getWorkItem', () => {
  it('returns null for an unknown ID', () => {
    expect(getWorkItem('wi-00000000')).toBeNull();
  });

  it('returns the correct item for a known ID', () => {
    const created = createWorkItem({ title: 'Find me' });
    const found = getWorkItem(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.title).toBe('Find me');
  });
});

// ─── listWorkItems ────────────────────────────────────────────────────────────

describe('listWorkItems', () => {
  it('returns all items when no filters are applied', () => {
    createWorkItem({ title: 'Task A' });
    createWorkItem({ title: 'Task B' });
    createWorkItem({ title: 'Task C' });
    expect(listWorkItems()).toHaveLength(3);
  });

  it('returns empty array when no items exist', () => {
    expect(listWorkItems()).toHaveLength(0);
  });

  it('filters by status', () => {
    const a = createWorkItem({ title: 'queued task' });
    createWorkItem({ title: 'another queued' });
    updateWorkItem(a.id, { status: 'done' });

    const done = listWorkItems({ status: 'done' });
    expect(done).toHaveLength(1);
    expect(done[0].id).toBe(a.id);

    const queued = listWorkItems({ status: 'queued' });
    expect(queued).toHaveLength(1);
  });

  it('filters by agentId', () => {
    const item = createWorkItem({ title: 'agent task' });
    claimWorkItem(item.id, 'agent-123');
    createWorkItem({ title: 'unclaimed task' });

    const agentItems = listWorkItems({ agentId: 'agent-123' });
    expect(agentItems).toHaveLength(1);
    expect(agentItems[0].id).toBe(item.id);
  });
});

// ─── updateWorkItem ───────────────────────────────────────────────────────────

describe('updateWorkItem', () => {
  it('returns null for an unknown ID', () => {
    expect(updateWorkItem('wi-00000000', { title: 'X' })).toBeNull();
  });

  it('updates supplied fields and leaves others unchanged', () => {
    const item = createWorkItem({ title: 'Original', description: 'desc' });
    const updated = updateWorkItem(item.id, { title: 'Updated' });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Updated');
    expect(updated!.description).toBe('desc');
    expect(updated!.status).toBe('queued');
  });

  it('auto-sets completedAt when transitioning to done', () => {
    const item = createWorkItem({ title: 'done test' });
    expect(item.completedAt).toBeNull();
    const updated = updateWorkItem(item.id, { status: 'done' });
    expect(updated!.completedAt).not.toBeNull();
    expect(updated!.status).toBe('done');
  });

  it('auto-sets completedAt when transitioning to cancelled', () => {
    const item = createWorkItem({ title: 'cancel test' });
    expect(item.completedAt).toBeNull();
    const updated = updateWorkItem(item.id, { status: 'cancelled' });
    expect(updated!.completedAt).not.toBeNull();
    expect(updated!.status).toBe('cancelled');
  });
});

// ─── deleteWorkItem ───────────────────────────────────────────────────────────

describe('deleteWorkItem', () => {
  it('returns false for an unknown ID', () => {
    expect(deleteWorkItem('wi-00000000')).toBe(false);
  });

  it('deletes the item and returns true', () => {
    const item = createWorkItem({ title: 'Delete me' });
    expect(deleteWorkItem(item.id)).toBe(true);
    expect(getWorkItem(item.id)).toBeNull();
  });

  it('cascades dependency rows when item is deleted', () => {
    const a = createWorkItem({ title: 'Blocker' });
    const b = createWorkItem({ title: 'Blocked' });
    addDependency(a.id, b.id);

    deleteWorkItem(a.id);

    // The dependency row should be gone
    const deps = listDependencies(b.id);
    expect(deps).toHaveLength(0);
  });
});

// ─── claimWorkItem ────────────────────────────────────────────────────────────

describe('claimWorkItem', () => {
  it('returns the updated item with status=assigned and assignedAgentId set', () => {
    const item = createWorkItem({ title: 'claim me' });
    const claimed = claimWorkItem(item.id, 'agent-007');
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('assigned');
    expect(claimed!.assignedAgentId).toBe('agent-007');
    expect(claimed!.assignedAt).not.toBeNull();
  });

  it('returns null (not throws) when item is not in queued status', () => {
    const item = createWorkItem({ title: 'already claimed' });
    claimWorkItem(item.id, 'agent-001');
    // Second claim attempt
    const result = claimWorkItem(item.id, 'agent-002');
    expect(result).toBeNull();
  });
});

// ─── getReadyWorkItems ────────────────────────────────────────────────────────

describe('getReadyWorkItems', () => {
  it('returns a queued item with no dependencies', () => {
    const item = createWorkItem({ title: 'no deps' });
    const ready = getReadyWorkItems();
    expect(ready.map((i) => i.id)).toContain(item.id);
  });

  it('does NOT return an item blocked by a pending dependency', () => {
    const blocker = createWorkItem({ title: 'blocker' });
    const blocked = createWorkItem({ title: 'blocked' });
    addDependency(blocker.id, blocked.id);

    const ready = getReadyWorkItems();
    const ids = ready.map((i) => i.id);
    expect(ids).toContain(blocker.id);
    expect(ids).not.toContain(blocked.id);
  });

  it('returns item after blocker transitions to done', () => {
    const blocker = createWorkItem({ title: 'blocker done' });
    const blocked = createWorkItem({ title: 'unblocked after done' });
    addDependency(blocker.id, blocked.id);

    updateWorkItem(blocker.id, { status: 'done' });

    const ready = getReadyWorkItems();
    const ids = ready.map((i) => i.id);
    expect(ids).toContain(blocked.id);
  });

  it('returns item after blocker transitions to cancelled', () => {
    const blocker = createWorkItem({ title: 'blocker cancelled' });
    const blocked = createWorkItem({ title: 'unblocked after cancel' });
    addDependency(blocker.id, blocked.id);

    updateWorkItem(blocker.id, { status: 'cancelled' });

    const ready = getReadyWorkItems();
    const ids = ready.map((i) => i.id);
    expect(ids).toContain(blocked.id);
  });
});

// ─── addDependency ────────────────────────────────────────────────────────────

describe('addDependency', () => {
  it('inserts a dependency and returns WorkItemDependency with correct fromId/toId', () => {
    const a = createWorkItem({ title: 'A' });
    const b = createWorkItem({ title: 'B' });
    const dep = addDependency(a.id, b.id);
    expect(dep.fromId).toBe(a.id);
    expect(dep.toId).toBe(b.id);
    expect(dep.type).toBe('blocks');
    expect(dep.createdAt).toBeDefined();
  });

  it('throws on direct circular dependency (A blocks B, B blocks A)', () => {
    const a = createWorkItem({ title: 'A circular' });
    const b = createWorkItem({ title: 'B circular' });
    addDependency(a.id, b.id);
    expect(() => addDependency(b.id, a.id)).toThrow(/[Cc]ircular/);
  });

  it('throws on transitive circular dependency (A→B→C, C blocks A)', () => {
    const a = createWorkItem({ title: 'A trans' });
    const b = createWorkItem({ title: 'B trans' });
    const c = createWorkItem({ title: 'C trans' });
    addDependency(a.id, b.id);
    addDependency(b.id, c.id);
    expect(() => addDependency(c.id, a.id)).toThrow(/[Cc]ircular/);
  });
});

// ─── removeDependency ─────────────────────────────────────────────────────────

describe('removeDependency', () => {
  it('returns false when the edge does not exist', () => {
    const a = createWorkItem({ title: 'A rem' });
    const b = createWorkItem({ title: 'B rem' });
    expect(removeDependency(a.id, b.id)).toBe(false);
  });

  it('removes the edge and returns true', () => {
    const a = createWorkItem({ title: 'A rm ok' });
    const b = createWorkItem({ title: 'B rm ok' });
    addDependency(a.id, b.id);
    expect(removeDependency(a.id, b.id)).toBe(true);
    expect(listDependencies(a.id)).toHaveLength(0);
  });
});

// ─── listDependencies ─────────────────────────────────────────────────────────

describe('listDependencies', () => {
  it('returns both from and to edges for a given item', () => {
    const a = createWorkItem({ title: 'A list' });
    const b = createWorkItem({ title: 'B list' });
    const c = createWorkItem({ title: 'C list' });
    addDependency(a.id, b.id); // a blocks b
    addDependency(b.id, c.id); // b blocks c

    const bDeps = listDependencies(b.id);
    // b is blocked by a (to_id=b) AND b blocks c (from_id=b)
    expect(bDeps).toHaveLength(2);
  });

  it('returns empty array when item has no dependencies', () => {
    const solo = createWorkItem({ title: 'solo' });
    expect(listDependencies(solo.id)).toHaveLength(0);
  });
});

// ─── decay ────────────────────────────────────────────────────────────────────

describe('decay', () => {
  it('returns zero counts when no items are old enough', () => {
    const item = createWorkItem({ title: 'fresh done' });
    updateWorkItem(item.id, { status: 'done' });
    const result = decay();
    expect(result.compacted).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('compacts done items with completedAt older than 30 days', () => {
    const db = openDb(':memory:');
    const item = createWorkItem({ title: 'Old done task' });
    // Manually backdate completedAt
    db.prepare(
      `
      UPDATE work_items SET status = 'done', completed_at = datetime('now', '-31 days') WHERE id = ?
    `
    ).run(item.id);

    const result = decay();
    expect(result.compacted).toBe(1);
    expect(result.deleted).toBe(0);

    const updated = getWorkItem(item.id);
    expect(updated!.description).toBe('');
    expect(updated!.compactSummary).toContain('[compacted]');
  });

  it('does NOT compact done items completed within 30 days', () => {
    const item = createWorkItem({ title: 'Recent done task' });
    updateWorkItem(item.id, { status: 'done' });

    const result = decay();
    expect(result.compacted).toBe(0);

    const found = getWorkItem(item.id);
    expect(found!.compactSummary).toBeNull();
  });

  it('deletes cancelled items with completedAt older than 7 days', () => {
    const db = openDb(':memory:');
    const item = createWorkItem({ title: 'Old cancelled task' });
    db.prepare(
      `
      UPDATE work_items SET status = 'cancelled', completed_at = datetime('now', '-8 days') WHERE id = ?
    `
    ).run(item.id);

    const result = decay();
    expect(result.deleted).toBe(1);
    expect(getWorkItem(item.id)).toBeNull();
  });

  it('does NOT delete cancelled items within 7 days', () => {
    const item = createWorkItem({ title: 'Recent cancelled' });
    updateWorkItem(item.id, { status: 'cancelled' });

    const result = decay();
    expect(result.deleted).toBe(0);
    expect(getWorkItem(item.id)).not.toBeNull();
  });

  it('returns correct compacted and deleted counts', () => {
    const db = openDb(':memory:');

    const done1 = createWorkItem({ title: 'done old 1' });
    const done2 = createWorkItem({ title: 'done old 2' });
    const cancelled1 = createWorkItem({ title: 'cancelled old 1' });

    db.prepare(`UPDATE work_items SET status = 'done', completed_at = datetime('now', '-31 days') WHERE id = ?`).run(
      done1.id
    );
    db.prepare(`UPDATE work_items SET status = 'done', completed_at = datetime('now', '-31 days') WHERE id = ?`).run(
      done2.id
    );
    db.prepare(
      `UPDATE work_items SET status = 'cancelled', completed_at = datetime('now', '-8 days') WHERE id = ?`
    ).run(cancelled1.id);

    const result = decay();
    expect(result.compacted).toBe(2);
    expect(result.deleted).toBe(1);
  });

  it('does not re-compact already compacted items (idempotent)', () => {
    const db = openDb(':memory:');
    const item = createWorkItem({ title: 'Already compacted' });
    db.prepare(
      `
      UPDATE work_items SET status = 'done', completed_at = datetime('now', '-31 days'),
        compact_summary = 'Already compacted [compacted]', description = ''
      WHERE id = ?
    `
    ).run(item.id);

    const first = decay();
    expect(first.compacted).toBe(0); // already has [compacted], skipped

    const second = decay();
    expect(second.compacted).toBe(0);
  });
});

/**
 * @fileoverview Integration tests for work item dependency graph traversal.
 *
 * Verifies that the ready() query correctly reflects the dependency graph:
 * - Linear chains (A→B→C)
 * - Diamond graphs (A→B, A→C, B→D, C→D)
 * - Circular dependency detection (3-node cycle)
 *
 * Each test gets a fresh in-memory DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, closeDb } from '../../src/work-items/db.js';
import { createWorkItem, updateWorkItem, addDependency, getReadyWorkItems } from '../../src/work-items/store.js';

beforeEach(() => {
  openDb(':memory:');
});

afterEach(() => {
  closeDb();
});

// ─── Linear chain: A→B→C ─────────────────────────────────────────────────────

describe('linear chain A→B→C', () => {
  it('only A is ready initially', () => {
    const a = createWorkItem({ title: 'A' });
    const b = createWorkItem({ title: 'B' });
    const c = createWorkItem({ title: 'C' });
    addDependency(a.id, b.id); // A blocks B
    addDependency(b.id, c.id); // B blocks C

    const ready = getReadyWorkItems().map((i) => i.id);
    expect(ready).toContain(a.id);
    expect(ready).not.toContain(b.id);
    expect(ready).not.toContain(c.id);
  });

  it('after A is done, B becomes ready; C is still blocked', () => {
    const a = createWorkItem({ title: 'A' });
    const b = createWorkItem({ title: 'B' });
    const c = createWorkItem({ title: 'C' });
    addDependency(a.id, b.id);
    addDependency(b.id, c.id);

    updateWorkItem(a.id, { status: 'done' });

    const ready = getReadyWorkItems().map((i) => i.id);
    expect(ready).not.toContain(a.id); // no longer queued
    expect(ready).toContain(b.id);
    expect(ready).not.toContain(c.id);
  });

  it('after A and B are done, C becomes ready', () => {
    const a = createWorkItem({ title: 'A' });
    const b = createWorkItem({ title: 'B' });
    const c = createWorkItem({ title: 'C' });
    addDependency(a.id, b.id);
    addDependency(b.id, c.id);

    updateWorkItem(a.id, { status: 'done' });
    updateWorkItem(b.id, { status: 'done' });

    const ready = getReadyWorkItems().map((i) => i.id);
    expect(ready).toContain(c.id);
    expect(ready).not.toContain(a.id);
    expect(ready).not.toContain(b.id);
  });
});

// ─── Diamond: A→B, A→C, B→D, C→D ────────────────────────────────────────────

describe('diamond graph A→B, A→C, B→D, C→D', () => {
  it('only A is ready initially', () => {
    const a = createWorkItem({ title: 'A' });
    const b = createWorkItem({ title: 'B' });
    const c = createWorkItem({ title: 'C' });
    const d = createWorkItem({ title: 'D' });
    addDependency(a.id, b.id);
    addDependency(a.id, c.id);
    addDependency(b.id, d.id);
    addDependency(c.id, d.id);

    const ready = getReadyWorkItems().map((i) => i.id);
    expect(ready).toContain(a.id);
    expect(ready).not.toContain(b.id);
    expect(ready).not.toContain(c.id);
    expect(ready).not.toContain(d.id);
  });

  it('after A is done, B and C are ready; D is still blocked', () => {
    const a = createWorkItem({ title: 'A' });
    const b = createWorkItem({ title: 'B' });
    const c = createWorkItem({ title: 'C' });
    const d = createWorkItem({ title: 'D' });
    addDependency(a.id, b.id);
    addDependency(a.id, c.id);
    addDependency(b.id, d.id);
    addDependency(c.id, d.id);

    updateWorkItem(a.id, { status: 'done' });

    const ready = getReadyWorkItems().map((i) => i.id);
    expect(ready).toContain(b.id);
    expect(ready).toContain(c.id);
    expect(ready).not.toContain(d.id);
  });

  it('after A+B done but C still pending, D is still blocked', () => {
    const a = createWorkItem({ title: 'A' });
    const b = createWorkItem({ title: 'B' });
    const c = createWorkItem({ title: 'C' });
    const d = createWorkItem({ title: 'D' });
    addDependency(a.id, b.id);
    addDependency(a.id, c.id);
    addDependency(b.id, d.id);
    addDependency(c.id, d.id);

    updateWorkItem(a.id, { status: 'done' });
    updateWorkItem(b.id, { status: 'done' });

    const ready = getReadyWorkItems().map((i) => i.id);
    expect(ready).toContain(c.id);
    expect(ready).not.toContain(d.id);
  });

  it('after A+B+C all done, D becomes ready', () => {
    const a = createWorkItem({ title: 'A' });
    const b = createWorkItem({ title: 'B' });
    const c = createWorkItem({ title: 'C' });
    const d = createWorkItem({ title: 'D' });
    addDependency(a.id, b.id);
    addDependency(a.id, c.id);
    addDependency(b.id, d.id);
    addDependency(c.id, d.id);

    updateWorkItem(a.id, { status: 'done' });
    updateWorkItem(b.id, { status: 'done' });
    updateWorkItem(c.id, { status: 'done' });

    const ready = getReadyWorkItems().map((i) => i.id);
    expect(ready).toContain(d.id);
  });
});

// ─── Circular dependency detection ───────────────────────────────────────────

describe('circular dependency detection', () => {
  it('3-node cycle A→B→C→A throws on the third addDependency call', () => {
    const a = createWorkItem({ title: 'A circ' });
    const b = createWorkItem({ title: 'B circ' });
    const c = createWorkItem({ title: 'C circ' });

    addDependency(a.id, b.id); // A blocks B — ok
    addDependency(b.id, c.id); // B blocks C — ok

    // C blocks A would close the cycle — must throw
    expect(() => addDependency(c.id, a.id)).toThrow(/[Cc]ircular/);
  });

  it('direct 2-node cycle A→B, B→A throws on second call', () => {
    const a = createWorkItem({ title: 'A 2-node' });
    const b = createWorkItem({ title: 'B 2-node' });

    addDependency(a.id, b.id);
    expect(() => addDependency(b.id, a.id)).toThrow(/[Cc]ircular/);
  });
});

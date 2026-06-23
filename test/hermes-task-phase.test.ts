import { describe, it, expect } from 'vitest';
import { parseTaskPhase } from '../src/web/hermes/task-phase.js';

describe('parseTaskPhase', () => {
  it('returns the value from a top-level status: field', () => {
    const content = '# Task\n\ntype: feature\nstatus: analysis\ntitle: Foo\n';
    expect(parseTaskPhase(content)).toBe('analysis');
  });

  it('trims extra surrounding spaces from the value', () => {
    const content = 'status:   fixing   ';
    expect(parseTaskPhase(content)).toBe('fixing');
  });

  it('returns null when no status line exists', () => {
    const content = '# Title\n\n## Description\nSome text here.\n';
    expect(parseTaskPhase(content)).toBeNull();
  });

  it('is case-insensitive on the key', () => {
    const content = 'Status: review';
    expect(parseTaskPhase(content)).toBe('review');
  });

  it('returns the first status line when multiple exist', () => {
    const content = 'status: analysis\nstatus: fixing\n';
    expect(parseTaskPhase(content)).toBe('analysis');
  });
});

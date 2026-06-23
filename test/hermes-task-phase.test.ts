import { describe, it, expect } from 'vitest';
import { parseTaskPhase } from '../src/web/hermes/task-phase.js';

describe('parseTaskPhase', () => {
  it('returns the phase from a standard status block', () => {
    const content = '## status\nphase: analysis\n';
    expect(parseTaskPhase(content)).toBe('analysis');
  });

  it('trims extra surrounding spaces from the value', () => {
    const content = 'phase:   implement   ';
    expect(parseTaskPhase(content)).toBe('implement');
  });

  it('returns null when no phase line exists', () => {
    const content = '# Title\n\n## Description\nSome text here.\n';
    expect(parseTaskPhase(content)).toBeNull();
  });

  it('is case-insensitive on the key', () => {
    const content = 'Phase: review';
    expect(parseTaskPhase(content)).toBe('review');
  });

  it('returns the first phase line when multiple exist', () => {
    const content = 'phase: analysis\nphase: implement\n';
    expect(parseTaskPhase(content)).toBe('analysis');
  });
});

import { describe, it, expect } from 'vitest';
import { buildDigest, mapStatus, type DigestInput } from '../src/web/hermes/digest.js';

const base: DigestInput = {
  id: 's1',
  name: 'sess',
  status: 'idle',
  transcript: null,
  subagents: [],
  phase: null,
  lastActivityAt: 100,
};

describe('mapStatus', () => {
  it('collapses the five-value enum into three', () => {
    expect(mapStatus('busy')).toBe('working');
    expect(mapStatus('idle')).toBe('idle');
    expect(['stopped', 'error', 'archived', 'weird'].map(mapStatus)).toEqual([
      'stopped',
      'stopped',
      'stopped',
      'stopped',
    ]);
  });
});

describe('buildDigest', () => {
  it('reports done only when transcript complete + idle + no tool running', () => {
    expect(
      buildDigest({
        ...base,
        status: 'idle',
        transcript: { isComplete: true, toolExecuting: false, lastAssistantMessage: 'hi' },
      }).done
    ).toBe(true);
    expect(
      buildDigest({
        ...base,
        status: 'busy',
        transcript: { isComplete: true, toolExecuting: false, lastAssistantMessage: 'hi' },
      }).done
    ).toBe(false);
    expect(
      buildDigest({
        ...base,
        status: 'idle',
        transcript: { isComplete: true, toolExecuting: true, lastAssistantMessage: 'x' },
      }).done
    ).toBe(false);
    expect(buildDigest({ ...base, transcript: null }).done).toBe(false);
  });

  it('surfaces lastAssistantMessage and null when no transcript', () => {
    expect(
      buildDigest({ ...base, transcript: { isComplete: true, toolExecuting: false, lastAssistantMessage: 'done!' } })
        .lastAssistantMessage
    ).toBe('done!');
    expect(buildDigest({ ...base, transcript: null }).lastAssistantMessage).toBeNull();
  });

  it('lists only non-completed subagents and maps description→doing', () => {
    const d = buildDigest({
      ...base,
      subagents: [
        { agentId: 'a1', description: 'Explore code', status: 'active', lastActivityAt: 1 },
        { agentId: 'a2', description: 'old', status: 'completed', lastActivityAt: 1 },
      ],
    });
    expect(d.subagents.count).toBe(1);
    expect(d.subagents.active).toEqual([{ name: 'a1', doing: 'Explore code', status: 'active' }]);
  });
});

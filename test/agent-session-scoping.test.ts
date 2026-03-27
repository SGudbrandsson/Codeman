// @vitest-environment jsdom

/**
 * @fileoverview Tests for subagent parent-session discovery and orphan re-checking.
 *
 * Covers:
 * - findParentSessionForSubagent(): cached hit, stale-cache clearing, claudeSessionId match, orphan fallthrough
 * - recheckOrphanSubagents(): orphan discovery, legacy wrong-mapping correction, side-effect gating
 * - _onSessionUpdated trigger: recheckOrphanSubagents called when subagents exist, skipped when empty
 *
 * Strategy:
 * - Build a minimal app-like object that reproduces the real method bodies from app.js.
 * - Does NOT import app.js directly — manually replicates the methods under test.
 * - See test/agent-view-session-filter.test.ts as the exemplar.
 *
 * Run: npx vitest run test/agent-session-scoping.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentStub {
  agentId: string;
  sessionId?: string; // claudeSessionId of the parent session (from Claude API)
  status: string;
  description?: string;
  parentSessionId?: string;
  parentSessionName?: string;
  toolCallCount: number;
}

interface SessionStub {
  id: string;
  claudeSessionId?: string;
  name?: string;
}

// ─── Minimal app object reproducing the real methods under test ──────────────

function makeApp() {
  const subagents = new Map<string, AgentStub>();
  const subagentParentMap = new Map<string, string>();
  const sessions = new Map<string, SessionStub>();

  const app = {
    activeSessionId: 'session-1',
    subagents,
    subagentParentMap,
    sessions,

    // ── stubs for side-effect methods ──
    updateSubagentWindowParent: vi.fn(),
    updateSubagentWindowVisibility: vi.fn(),
    updateConnectionLines: vi.fn(),
    saveSubagentParentMap: vi.fn(),
    renderSubagentPanel: vi.fn(),

    getSessionName(session: SessionStub) {
      return session.name || session.id;
    },

    /**
     * Exact reproduction of setAgentParentSessionId from app.js (line 14267).
     */
    setAgentParentSessionId(agentId: string, sessionId: string) {
      if (!agentId || !sessionId) return;
      if (this.subagentParentMap.has(agentId)) return;

      this.subagentParentMap.set(agentId, sessionId);
      this.saveSubagentParentMap();

      const agent = this.subagents.get(agentId);
      if (agent) {
        agent.parentSessionId = sessionId;
        const session = this.sessions.get(sessionId);
        if (session) {
          agent.parentSessionName = this.getSessionName(session);
        }
        this.subagents.set(agentId, agent);
      }
    },

    /**
     * Exact reproduction of findParentSessionForSubagent from app.js (line 16779).
     */
    findParentSessionForSubagent(agentId: string) {
      // Check if we already have a permanent association
      if (this.subagentParentMap.has(agentId)) {
        const storedSessionId = this.subagentParentMap.get(agentId)!;
        // Verify the session still exists
        if (this.sessions.has(storedSessionId)) {
          const agent = this.subagents.get(agentId);
          if (agent && !agent.parentSessionId) {
            agent.parentSessionId = storedSessionId;
            const session = this.sessions.get(storedSessionId);
            if (session) {
              agent.parentSessionName = this.getSessionName(session);
            }
            this.subagents.set(agentId, agent);
            this.updateSubagentWindowParent(agentId);
          }
          return;
        }
        // Stored session no longer exists — clear and re-discover
        this.subagentParentMap.delete(agentId);
      }

      const agent = this.subagents.get(agentId);
      if (!agent) return;

      // Strategy 1: Match via claudeSessionId (most accurate)
      if (agent.sessionId) {
        for (const [sessionId, session] of this.sessions) {
          if (session.claudeSessionId === agent.sessionId) {
            this.setAgentParentSessionId(agentId, sessionId);
            this.updateSubagentWindowParent(agentId);
            this.updateSubagentWindowVisibility();
            this.updateConnectionLines();
            return;
          }
        }
      }

      // No match found — leave as orphan.
    },

    /**
     * Exact reproduction of recheckOrphanSubagents from app.js (line 16830).
     */
    recheckOrphanSubagents() {
      let anyChanged = false;
      for (const [agentId, agent] of this.subagents) {
        if (!this.subagentParentMap.has(agentId)) {
          this.findParentSessionForSubagent(agentId);
          if (this.subagentParentMap.has(agentId)) {
            anyChanged = true;
          }
        } else if (agent.sessionId) {
          const storedParent = this.subagentParentMap.get(agentId)!;
          const storedSession = this.sessions.get(storedParent);

          if (storedSession && storedSession.claudeSessionId !== agent.sessionId) {
            for (const [sessionId, session] of this.sessions) {
              if (session.claudeSessionId === agent.sessionId) {
                this.subagentParentMap.set(agentId, sessionId);
                agent.parentSessionId = sessionId;
                agent.parentSessionName = this.getSessionName(session);
                this.subagents.set(agentId, agent);
                this.updateSubagentWindowParent(agentId);
                anyChanged = true;
                break;
              }
            }
          }
        }
      }
      if (anyChanged) {
        this.saveSubagentParentMap();
        this.updateConnectionLines();
      }
    },
  };

  return app;
}

// ─── Tests for findParentSessionForSubagent ──────────────────────────────────

describe('findParentSessionForSubagent()', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
  });

  it('returns immediately using cached association when session still exists', () => {
    // Setup: agent already mapped, session exists, but agent.parentSessionId not yet set
    app.sessions.set('session-1', { id: 'session-1', name: 'My Session' });
    app.subagents.set('agent-1', {
      agentId: 'agent-1',
      sessionId: 'claude-abc',
      status: 'active',
      toolCallCount: 3,
      // parentSessionId intentionally unset
    });
    app.subagentParentMap.set('agent-1', 'session-1');

    app.findParentSessionForSubagent('agent-1');

    // Should populate parentSessionId from cache
    const agent = app.subagents.get('agent-1')!;
    expect(agent.parentSessionId).toBe('session-1');
    expect(agent.parentSessionName).toBe('My Session');
    // Should NOT trigger claudeSessionId matching (early return)
    expect(app.updateSubagentWindowVisibility).not.toHaveBeenCalled();
  });

  it('skips update when cached association exists and parentSessionId already set', () => {
    app.sessions.set('session-1', { id: 'session-1', name: 'My Session' });
    app.subagents.set('agent-1', {
      agentId: 'agent-1',
      sessionId: 'claude-abc',
      status: 'active',
      toolCallCount: 3,
      parentSessionId: 'session-1',
      parentSessionName: 'My Session',
    });
    app.subagentParentMap.set('agent-1', 'session-1');

    app.findParentSessionForSubagent('agent-1');

    // Should early-return without calling updateSubagentWindowParent
    expect(app.updateSubagentWindowParent).not.toHaveBeenCalled();
  });

  it('clears stale cached association and re-discovers via claudeSessionId', () => {
    // Setup: stored session no longer exists, but another session matches claudeSessionId
    app.subagentParentMap.set('agent-1', 'session-deleted');
    // session-deleted is NOT in sessions map
    app.sessions.set('session-2', { id: 'session-2', claudeSessionId: 'claude-xyz', name: 'New Session' });
    app.subagents.set('agent-1', {
      agentId: 'agent-1',
      sessionId: 'claude-xyz',
      status: 'active',
      toolCallCount: 5,
    });

    app.findParentSessionForSubagent('agent-1');

    // Stale entry should be removed and re-discovered
    expect(app.subagentParentMap.get('agent-1')).toBe('session-2');
    const agent = app.subagents.get('agent-1')!;
    expect(agent.parentSessionId).toBe('session-2');
    expect(agent.parentSessionName).toBe('New Session');
  });

  it('matches via claudeSessionId when no cached entry exists', () => {
    app.sessions.set('session-A', { id: 'session-A', claudeSessionId: 'claude-111' });
    app.sessions.set('session-B', { id: 'session-B', claudeSessionId: 'claude-222' });
    app.subagents.set('agent-x', {
      agentId: 'agent-x',
      sessionId: 'claude-222',
      status: 'active',
      toolCallCount: 1,
    });

    app.findParentSessionForSubagent('agent-x');

    expect(app.subagentParentMap.get('agent-x')).toBe('session-B');
    expect(app.updateSubagentWindowParent).toHaveBeenCalledWith('agent-x');
    expect(app.updateSubagentWindowVisibility).toHaveBeenCalled();
    expect(app.updateConnectionLines).toHaveBeenCalled();
  });

  it('leaves agent as orphan when no claudeSessionId match exists', () => {
    app.sessions.set('session-A', { id: 'session-A', claudeSessionId: 'claude-111' });
    app.subagents.set('agent-orphan', {
      agentId: 'agent-orphan',
      sessionId: 'claude-999', // no session has this claudeSessionId
      status: 'active',
      toolCallCount: 0,
    });

    app.findParentSessionForSubagent('agent-orphan');

    // Should NOT be in the parent map
    expect(app.subagentParentMap.has('agent-orphan')).toBe(false);
    expect(app.updateSubagentWindowParent).not.toHaveBeenCalled();
  });

  it('leaves agent as orphan when agent has no sessionId', () => {
    app.sessions.set('session-A', { id: 'session-A', claudeSessionId: 'claude-111' });
    app.subagents.set('agent-no-sid', {
      agentId: 'agent-no-sid',
      // sessionId intentionally undefined
      status: 'active',
      toolCallCount: 0,
    });

    app.findParentSessionForSubagent('agent-no-sid');

    expect(app.subagentParentMap.has('agent-no-sid')).toBe(false);
  });

  it('does nothing when agent does not exist in subagents map', () => {
    app.findParentSessionForSubagent('nonexistent-agent');

    expect(app.subagentParentMap.has('nonexistent-agent')).toBe(false);
    expect(app.updateSubagentWindowParent).not.toHaveBeenCalled();
  });
});

// ─── Tests for recheckOrphanSubagents ────────────────────────────────────────

describe('recheckOrphanSubagents()', () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
  });

  it('discovers parent for orphan agents via claudeSessionId', () => {
    app.sessions.set('session-A', { id: 'session-A', claudeSessionId: 'claude-100' });
    app.subagents.set('orphan-1', {
      agentId: 'orphan-1',
      sessionId: 'claude-100',
      status: 'active',
      toolCallCount: 2,
    });
    // orphan-1 has NO entry in subagentParentMap

    app.recheckOrphanSubagents();

    expect(app.subagentParentMap.get('orphan-1')).toBe('session-A');
    expect(app.saveSubagentParentMap).toHaveBeenCalled();
    expect(app.updateConnectionLines).toHaveBeenCalled();
  });

  it('does not call saveSubagentParentMap when no changes occur', () => {
    // Agent already correctly mapped
    app.sessions.set('session-A', { id: 'session-A', claudeSessionId: 'claude-100' });
    app.subagents.set('agent-1', {
      agentId: 'agent-1',
      sessionId: 'claude-100',
      status: 'active',
      toolCallCount: 1,
      parentSessionId: 'session-A',
    });
    app.subagentParentMap.set('agent-1', 'session-A');

    app.recheckOrphanSubagents();

    expect(app.saveSubagentParentMap).not.toHaveBeenCalled();
    expect(app.updateConnectionLines).not.toHaveBeenCalled();
  });

  it('corrects legacy wrong mapping when claudeSessionId points elsewhere', () => {
    // Agent stored under session-A, but claudeSessionId actually matches session-B
    app.sessions.set('session-A', { id: 'session-A', claudeSessionId: 'claude-wrong' });
    app.sessions.set('session-B', { id: 'session-B', claudeSessionId: 'claude-correct', name: 'Correct Session' });
    app.subagents.set('agent-legacy', {
      agentId: 'agent-legacy',
      sessionId: 'claude-correct', // matches session-B
      status: 'active',
      toolCallCount: 5,
      parentSessionId: 'session-A', // legacy wrong assignment
    });
    app.subagentParentMap.set('agent-legacy', 'session-A'); // legacy wrong mapping

    app.recheckOrphanSubagents();

    // Should be corrected to session-B
    expect(app.subagentParentMap.get('agent-legacy')).toBe('session-B');
    const agent = app.subagents.get('agent-legacy')!;
    expect(agent.parentSessionId).toBe('session-B');
    expect(agent.parentSessionName).toBe('Correct Session');
    expect(app.saveSubagentParentMap).toHaveBeenCalled();
    expect(app.updateConnectionLines).toHaveBeenCalled();
  });

  it('does not correct mapping when stored session claudeSessionId matches agent', () => {
    // Agent correctly mapped — stored session's claudeSessionId matches
    app.sessions.set('session-A', { id: 'session-A', claudeSessionId: 'claude-match' });
    app.subagents.set('agent-ok', {
      agentId: 'agent-ok',
      sessionId: 'claude-match',
      status: 'idle',
      toolCallCount: 3,
      parentSessionId: 'session-A',
    });
    app.subagentParentMap.set('agent-ok', 'session-A');

    app.recheckOrphanSubagents();

    expect(app.subagentParentMap.get('agent-ok')).toBe('session-A');
    expect(app.saveSubagentParentMap).not.toHaveBeenCalled();
  });

  it('skips legacy correction when agent has no sessionId', () => {
    app.sessions.set('session-A', { id: 'session-A', claudeSessionId: 'claude-111' });
    app.subagents.set('agent-no-sid', {
      agentId: 'agent-no-sid',
      // no sessionId
      status: 'active',
      toolCallCount: 0,
    });
    app.subagentParentMap.set('agent-no-sid', 'session-A');

    app.recheckOrphanSubagents();

    // Should remain mapped, no correction attempted (else branch requires agent.sessionId)
    expect(app.subagentParentMap.get('agent-no-sid')).toBe('session-A');
    expect(app.saveSubagentParentMap).not.toHaveBeenCalled();
  });

  it('handles mix of orphans and legacy-mapped agents in one pass', () => {
    app.sessions.set('session-A', { id: 'session-A', claudeSessionId: 'claude-aaa' });
    app.sessions.set('session-B', { id: 'session-B', claudeSessionId: 'claude-bbb' });

    // Orphan: no parent map entry
    app.subagents.set('orphan', {
      agentId: 'orphan',
      sessionId: 'claude-aaa',
      status: 'active',
      toolCallCount: 1,
    });

    // Legacy wrong mapping: stored under session-A but actually belongs to session-B
    app.subagents.set('legacy', {
      agentId: 'legacy',
      sessionId: 'claude-bbb',
      status: 'active',
      toolCallCount: 2,
      parentSessionId: 'session-A',
    });
    app.subagentParentMap.set('legacy', 'session-A');

    app.recheckOrphanSubagents();

    expect(app.subagentParentMap.get('orphan')).toBe('session-A');
    expect(app.subagentParentMap.get('legacy')).toBe('session-B');
    // saveSubagentParentMap called once at end (anyChanged = true)
    expect(app.saveSubagentParentMap).toHaveBeenCalledTimes(2); // once from setAgentParentSessionId, once from recheckOrphanSubagents
    expect(app.updateConnectionLines).toHaveBeenCalled();
  });
});

// ─── Tests for _onSessionUpdated trigger ─────────────────────────────────────

describe('_onSessionUpdated recheckOrphanSubagents trigger', () => {
  /**
   * Reproduces the relevant fragment of _onSessionUpdated (app.js line 6094):
   *   if (this.subagents.size > 0) {
   *     this.recheckOrphanSubagents();
   *   }
   */
  function makeAppWithSessionUpdated() {
    const base = makeApp();
    const recheckSpy = vi.fn();
    const appExt = {
      ...base,
      recheckOrphanSubagents: recheckSpy,

      // Simplified _onSessionUpdated reproducing just the recheck trigger
      _onSessionUpdated(_sessionData: SessionStub) {
        if (this.subagents.size > 0) {
          this.recheckOrphanSubagents();
        }
      },
    };
    return { app: appExt, recheckSpy };
  }

  it('calls recheckOrphanSubagents when subagents exist', () => {
    const { app, recheckSpy } = makeAppWithSessionUpdated();
    app.subagents.set('agent-1', {
      agentId: 'agent-1',
      status: 'active',
      toolCallCount: 0,
    });

    app._onSessionUpdated({ id: 'session-1' });

    expect(recheckSpy).toHaveBeenCalledTimes(1);
  });

  it('skips recheckOrphanSubagents when subagents map is empty', () => {
    const { app, recheckSpy } = makeAppWithSessionUpdated();
    // subagents is empty by default

    app._onSessionUpdated({ id: 'session-1' });

    expect(recheckSpy).not.toHaveBeenCalled();
  });

  it('calls recheckOrphanSubagents on every session update, not just active session', () => {
    const { app, recheckSpy } = makeAppWithSessionUpdated();
    app.activeSessionId = 'session-1';
    app.subagents.set('agent-1', {
      agentId: 'agent-1',
      status: 'active',
      toolCallCount: 0,
    });

    // Update a non-active session
    app._onSessionUpdated({ id: 'session-99' });

    expect(recheckSpy).toHaveBeenCalledTimes(1);
  });
});

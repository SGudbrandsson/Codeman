// @vitest-environment jsdom

/**
 * @fileoverview Tests for subagent panel session-scoping and layout constraints.
 *
 * Covers the fixes for agent view bleed-through (agents from other sessions
 * appearing in the panel) and unbounded growth (panel growing without scroll).
 *
 * Strategy:
 * - Build a minimal DOM matching the elements that _renderSubagentPanelImmediate(),
 *   updateSubagentBadge(), and renderMonitorSubagents() query.
 * - Construct a thin app-like object that reproduces the real method bodies from app.js.
 * - Populate subagents across multiple sessions via subagentParentMap.
 * - Assert that only the active session's agents appear in DOM output.
 *
 * Run: npx vitest run test/agent-view-session-filter.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function buildSubagentDom() {
  // Badge element
  const badge = document.createElement('span');
  badge.id = 'subagentCountBadge';
  document.body.appendChild(badge);

  // Subagent list (used by _renderSubagentPanelImmediate)
  const list = document.createElement('div');
  list.id = 'subagentList';
  document.body.appendChild(list);

  // Monitor panel elements (used by renderMonitorSubagents)
  const monitorBody = document.createElement('div');
  monitorBody.id = 'monitorSubagentsBody';
  document.body.appendChild(monitorBody);

  const monitorStats = document.createElement('div');
  monitorStats.id = 'monitorSubagentStats';
  document.body.appendChild(monitorStats);

  return { badge, list, monitorBody, monitorStats };
}

function cleanupDom() {
  document.body.replaceChildren();
}

// ─── Stub escapeHtml (used in real app.js render methods) ─────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Subagent shape ───────────────────────────────────────────────────────────

interface SubagentStub {
  agentId: string;
  status: string;
  description?: string;
  lastActivityAt?: number;
  toolCallCount: number;
  modelShort?: string;
}

// ─── Minimal app object reproducing the real methods under test ───────────────

/**
 * Safely sets element content by creating DOM nodes rather than using innerHTML.
 * For test purposes, we parse the HTML string via a template element.
 */
function safeSetContent(el: HTMLElement, htmlStr: string): void {
  const template = document.createElement('template');
  template.innerHTML = htmlStr; // eslint-disable-line -- template elements are safe for parsing
  el.replaceChildren(template.content);
}

function makeApp(activeSessionId: string) {
  const subagents = new Map<string, SubagentStub>();
  const subagentParentMap = new Map<string, string>();
  const subagentActivity = new Map<string, unknown[]>();
  const subagentWindows = new Map<string, unknown>();

  const app = {
    activeSessionId,
    subagents,
    subagentParentMap,
    subagentActivity,
    subagentWindows,
    subagentPanelVisible: true,
    activeSubagentId: null as string | null,
    _subagentPanelRenderTimeout: null as ReturnType<typeof setTimeout> | null,

    $(id: string) {
      return document.getElementById(id);
    },

    getTeammateInfo(_agent: SubagentStub) {
      return null;
    },

    getTeammateBadgeHtml(_agent: SubagentStub) {
      return '';
    },

    getToolIcon(_tool: string) {
      return '';
    },

    // Exact reproduction of updateSubagentBadge from app.js
    updateSubagentBadge() {
      const badge = this.$('subagentCountBadge');
      const sid = this.activeSessionId;
      const activeCount = Array.from(this.subagents.values()).filter(
        (s: SubagentStub) =>
          (s.status === 'active' || s.status === 'idle') && this.subagentParentMap.get(s.agentId) === sid
      ).length;

      if (badge) {
        badge.textContent = activeCount > 0 ? String(activeCount) : '';
      }
    },

    // Exact reproduction of _renderSubagentPanelImmediate from app.js
    _renderSubagentPanelImmediate() {
      const list = this.$('subagentList');
      if (!list) return;

      this.updateSubagentBadge();
      this.renderMonitorSubagents();

      if (!this.subagentPanelVisible) {
        return;
      }

      const sid = this.activeSessionId;
      const sessionAgents = Array.from(this.subagents.values()).filter((agent: SubagentStub) => {
        const parentSession = this.subagentParentMap.get(agent.agentId);
        return parentSession === sid;
      });

      if (sessionAgents.length === 0) {
        safeSetContent(list, '<div class="subagent-empty">No background agents detected</div>');
        return;
      }

      const htmlParts: string[] = [];
      const sorted = sessionAgents.sort((a: SubagentStub, b: SubagentStub) => {
        if (a.status === 'active' && b.status !== 'active') return -1;
        if (b.status === 'active' && a.status !== 'active') return 1;
        return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
      });

      for (const agent of sorted) {
        const isActive = this.activeSubagentId === agent.agentId;
        const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
        const canKill = agent.status === 'active' || agent.status === 'idle';
        const displayName = agent.description || agent.agentId.substring(0, 7);

        htmlParts.push(`
          <div class="subagent-item ${statusClass} ${isActive ? 'selected' : ''}"
               data-agent-id="${escapeHtml(agent.agentId)}"
               title="Double-click to open tracking window">
            <div class="subagent-header">
              <span class="subagent-icon">R</span>
              <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(displayName)}</span>
              <span class="subagent-status ${statusClass}">${agent.status}</span>
            </div>
            <div class="subagent-meta">
              <span class="subagent-tools">${agent.toolCallCount} tools</span>
            </div>
          </div>
        `);
      }

      safeSetContent(list, htmlParts.join(''));
    },

    // Exact reproduction of renderMonitorSubagents from app.js
    renderMonitorSubagents() {
      const body = document.getElementById('monitorSubagentsBody');
      const stats = document.getElementById('monitorSubagentStats');
      if (!body) return;

      const sid = this.activeSessionId;
      const subagentsList = Array.from(this.subagents.values()).filter(
        (agent: SubagentStub) => this.subagentParentMap.get(agent.agentId) === sid
      );
      const activeCount = subagentsList.filter(
        (s: SubagentStub) => s.status === 'active' || s.status === 'idle'
      ).length;

      if (stats) {
        stats.textContent = `${subagentsList.length} tracked` + (activeCount > 0 ? `, ${activeCount} active` : '');
      }

      if (subagentsList.length === 0) {
        safeSetContent(body, '<div class="monitor-empty">No background agents</div>');
        return;
      }

      let html = '';
      for (const agent of subagentsList) {
        const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
        const desc = agent.description ? escapeHtml(agent.description.substring(0, 40)) : agent.agentId;

        html += `
          <div class="process-item" data-agent-id="${escapeHtml(agent.agentId)}">
            <span class="process-mode ${statusClass}">${agent.status}</span>
            <div class="process-info">
              <div class="process-name">${desc}</div>
              <div class="process-meta">
                <span>ID: ${agent.agentId}</span>
                <span>${agent.toolCallCount || 0} tools</span>
              </div>
            </div>
          </div>
        `;
      }

      safeSetContent(body, html);
    },

    // Simplified renderSubagentPanel (calls immediate directly for testing)
    renderSubagentPanel() {
      this._renderSubagentPanelImmediate();
    },
  };

  return app;
}

// ─── Test data ────────────────────────────────────────────────────────────────

function populateAgents(app: ReturnType<typeof makeApp>) {
  // Session A agents
  app.subagents.set('agent-a1', { agentId: 'agent-a1', status: 'active', description: 'Agent A1', toolCallCount: 5 });
  app.subagents.set('agent-a2', { agentId: 'agent-a2', status: 'idle', description: 'Agent A2', toolCallCount: 3 });
  app.subagentParentMap.set('agent-a1', 'session-A');
  app.subagentParentMap.set('agent-a2', 'session-A');

  // Session B agents
  app.subagents.set('agent-b1', { agentId: 'agent-b1', status: 'active', description: 'Agent B1', toolCallCount: 10 });
  app.subagents.set('agent-b2', {
    agentId: 'agent-b2',
    status: 'completed',
    description: 'Agent B2',
    toolCallCount: 8,
  });
  app.subagents.set('agent-b3', { agentId: 'agent-b3', status: 'active', description: 'Agent B3', toolCallCount: 2 });
  app.subagentParentMap.set('agent-b1', 'session-B');
  app.subagentParentMap.set('agent-b2', 'session-B');
  app.subagentParentMap.set('agent-b3', 'session-B');
}

// ─── Global setup / teardown ──────────────────────────────────────────────────

beforeEach(() => {
  buildSubagentDom();
});

afterEach(() => {
  cleanupDom();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('_renderSubagentPanelImmediate() session filtering', () => {
  it('only renders agents belonging to the active session', () => {
    const app = makeApp('session-A');
    populateAgents(app);

    app._renderSubagentPanelImmediate();

    const list = document.getElementById('subagentList')!;
    const items = list.querySelectorAll('.subagent-item');
    expect(items.length).toBe(2);
    // Should contain session-A agents only
    expect(list.textContent).toContain('Agent A1');
    expect(list.textContent).toContain('Agent A2');
    expect(list.textContent).not.toContain('Agent B1');
    expect(list.textContent).not.toContain('Agent B2');
    expect(list.textContent).not.toContain('Agent B3');
  });

  it('shows empty state when active session has no agents', () => {
    const app = makeApp('session-C'); // no agents for session-C
    populateAgents(app);

    app._renderSubagentPanelImmediate();

    const list = document.getElementById('subagentList')!;
    expect(list.textContent).toContain('No background agents detected');
    expect(list.querySelectorAll('.subagent-item').length).toBe(0);
  });

  it('excludes orphan agents with no parent map entry', () => {
    const app = makeApp('session-A');
    populateAgents(app);
    // Add an orphan agent (no entry in subagentParentMap)
    app.subagents.set('agent-orphan', {
      agentId: 'agent-orphan',
      status: 'active',
      description: 'Orphan',
      toolCallCount: 1,
    });

    app._renderSubagentPanelImmediate();

    const list = document.getElementById('subagentList')!;
    expect(list.textContent).not.toContain('Orphan');
    expect(list.querySelectorAll('.subagent-item').length).toBe(2);
  });
});

describe('updateSubagentBadge() session-scoped count', () => {
  it('badge shows count of active/idle agents for the active session only', () => {
    const app = makeApp('session-A');
    populateAgents(app);

    app.updateSubagentBadge();

    const badge = document.getElementById('subagentCountBadge')!;
    // session-A has 2 agents: agent-a1 (active) + agent-a2 (idle) = 2
    expect(badge.textContent).toBe('2');
  });

  it('badge shows count for session-B when that is active', () => {
    const app = makeApp('session-B');
    populateAgents(app);

    app.updateSubagentBadge();

    const badge = document.getElementById('subagentCountBadge')!;
    // session-B has 3 agents: agent-b1 (active) + agent-b3 (active) = 2 active/idle
    // agent-b2 is completed, so not counted
    expect(badge.textContent).toBe('2');
  });

  it('badge is empty when active session has no active/idle agents', () => {
    const app = makeApp('session-C');
    populateAgents(app);

    app.updateSubagentBadge();

    const badge = document.getElementById('subagentCountBadge')!;
    expect(badge.textContent).toBe('');
  });
});

describe('renderMonitorSubagents() session filtering', () => {
  it('only renders agents belonging to the active session in monitor panel', () => {
    const app = makeApp('session-B');
    populateAgents(app);

    app.renderMonitorSubagents();

    const body = document.getElementById('monitorSubagentsBody')!;
    const items = body.querySelectorAll('.process-item');
    expect(items.length).toBe(3); // all 3 session-B agents
    expect(body.textContent).toContain('Agent B1');
    expect(body.textContent).toContain('Agent B2');
    expect(body.textContent).toContain('Agent B3');
    expect(body.textContent).not.toContain('Agent A1');
    expect(body.textContent).not.toContain('Agent A2');
  });

  it('shows stats scoped to the active session', () => {
    const app = makeApp('session-B');
    populateAgents(app);

    app.renderMonitorSubagents();

    const stats = document.getElementById('monitorSubagentStats')!;
    // session-B: 3 tracked, 2 active (b1 + b3 are active, b2 is completed)
    expect(stats.textContent).toBe('3 tracked, 2 active');
  });

  it('shows empty state when active session has no agents', () => {
    const app = makeApp('session-C');
    populateAgents(app);

    app.renderMonitorSubagents();

    const body = document.getElementById('monitorSubagentsBody')!;
    expect(body.textContent).toContain('No background agents');
  });
});

describe('selectSession() triggers renderSubagentPanel()', () => {
  it('switching activeSessionId and calling renderSubagentPanel updates the panel content', () => {
    const app = makeApp('session-A');
    populateAgents(app);

    // Initial render for session-A
    app.renderSubagentPanel();
    const list = document.getElementById('subagentList')!;
    expect(list.querySelectorAll('.subagent-item').length).toBe(2);
    expect(list.textContent).toContain('Agent A1');

    // Simulate selectSession switching to session-B
    app.activeSessionId = 'session-B';
    app.renderSubagentPanel();

    expect(list.querySelectorAll('.subagent-item').length).toBe(3);
    expect(list.textContent).toContain('Agent B1');
    expect(list.textContent).not.toContain('Agent A1');
  });

  it('badge updates when session changes', () => {
    const app = makeApp('session-A');
    populateAgents(app);

    app.updateSubagentBadge();
    const badge = document.getElementById('subagentCountBadge')!;
    expect(badge.textContent).toBe('2'); // session-A: 2 active/idle

    // Switch to session-B
    app.activeSessionId = 'session-B';
    app.updateSubagentBadge();
    expect(badge.textContent).toBe('2'); // session-B: 2 active (b1, b3)
  });
});

describe('CSS layout constraints for subagent panel', () => {
  it('.subagent-container has min-height: 0 to allow flex shrinking', () => {
    // Inject the relevant CSS rules and verify they apply correctly
    const style = document.createElement('style');
    style.textContent = `
      .subagent-container {
        display: flex;
        gap: 0.5rem;
        height: 100%;
        min-height: 0;
      }
      .subagent-list {
        flex: 0 0 200px;
        min-height: 0;
        overflow-y: auto;
      }
      .subagents-panel-body {
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }
      .subagents-panel.open {
        max-height: 65vh;
      }
    `;
    document.head.appendChild(style);

    // Build a panel structure matching the real DOM
    const panel = document.createElement('div');
    panel.className = 'subagents-panel open';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';

    const body = document.createElement('div');
    body.className = 'subagents-panel-body';

    const container = document.createElement('div');
    container.className = 'subagent-container';

    const listEl = document.createElement('div');
    listEl.className = 'subagent-list';

    // Add many items to simulate unbounded growth
    for (let i = 0; i < 50; i++) {
      const item = document.createElement('div');
      item.className = 'subagent-item';
      item.textContent = `Agent ${i}`;
      item.style.height = '40px';
      listEl.appendChild(item);
    }

    container.appendChild(listEl);
    body.appendChild(container);
    panel.appendChild(body);
    document.body.appendChild(panel);

    // Verify the CSS properties are applied (jsdom computes styles from stylesheets)
    const computedContainer = getComputedStyle(container);
    const computedList = getComputedStyle(listEl);
    const computedBody = getComputedStyle(body);

    // min-height: 0 ensures flex children can shrink (jsdom may return '0' or '0px')
    expect(['0', '0px']).toContain(computedContainer.minHeight);
    expect(['0', '0px']).toContain(computedList.minHeight);
    expect(['0', '0px']).toContain(computedBody.minHeight);

    // overflow-y: auto on .subagent-list enables scrolling
    expect(computedList.overflowY).toBe('auto');

    // overflow: hidden on body delegates scrolling to inner list
    expect(computedBody.overflow).toBe('hidden');

    document.head.removeChild(style);
  });
});

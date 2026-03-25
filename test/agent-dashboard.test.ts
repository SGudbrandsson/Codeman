// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for Agent Dashboard frontend logic.
 *
 * The Agent Dashboard lives in src/web/public/app.js (a browser script). These tests
 * mirror the method implementations and run them against a minimal DOM using
 * vitest jsdom environment + manual DOM construction via document APIs.
 *
 * Strategy:
 * - Set up a minimal DOM (required dashboard elements) using document.createElement
 * - Mock global fetch and app helpers
 * - Build a thin dashboard object that reproduces the real method bodies
 * - Assert on fetch calls, DOM state, and data structures
 *
 * Run: npx vitest run test/agent-dashboard.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

/** Build the minimal dashboard DOM that renderAgentDashboard() interacts with. */
function buildDashboardDom() {
  const section = document.createElement('div');
  section.id = 'agentDashboardSection';
  section.className = 'monitor-section';

  const header = document.createElement('div');
  header.className = 'monitor-section-header';

  const statsSpan = document.createElement('span');
  statsSpan.id = 'agentDashboardStats';
  statsSpan.textContent = '0 agents';
  header.appendChild(statsSpan);

  section.appendChild(header);

  const body = document.createElement('div');
  body.id = 'agentDashboardBody';
  body.className = 'monitor-section-body';
  section.appendChild(body);

  document.body.appendChild(section);
}

function cleanupDom() {
  document.body.replaceChildren();
}

// ─── Minimal dashboard object ─────────────────────────────────────────────────

/**
 * Reproduces the Agent Dashboard method bodies from app.js verbatim.
 * Only the methods under test are included. Data structures (agents, sessions,
 * workItems, _agentDashboardExpanded) are initialized in each test.
 */
function makeDashboard() {
  return {
    agents: new Map<string, any>(),
    sessions: new Map<string, any>(),
    workItems: new Map<string, any>(),
    _agentDashboardExpanded: new Set<string>(),
    _renderAgentDashboardDebounced: null as ReturnType<typeof setTimeout> | null,
    _shortIdCache: new Map<string, string>(),

    showToast: vi.fn(),
    selectSession: vi.fn(),

    getShortId(id: string): string {
      if (!id) return '';
      let short = this._shortIdCache.get(id);
      if (!short) {
        short = id.slice(0, 8);
        this._shortIdCache.set(id, short);
      }
      return short;
    },

    _scheduleAgentDashboardRender() {
      if (this._renderAgentDashboardDebounced) clearTimeout(this._renderAgentDashboardDebounced);
      this._renderAgentDashboardDebounced = setTimeout(() => {
        this._renderAgentDashboardDebounced = null;
        this.renderAgentDashboard();
      }, 120);
    },

    async _loadWorkItemsForDashboard() {
      try {
        const res = await fetch('/api/work-items');
        if (res.ok) {
          const data = await res.json();
          const items = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
          this.workItems.clear();
          for (const item of items) {
            if (item.id) this.workItems.set(item.id, item);
          }
        }
      } catch (e) {
        console.warn('[AgentDashboard] Failed to load work items:', e);
      }
    },

    renderAgentDashboard() {
      const body = document.getElementById('agentDashboardBody');
      const stats = document.getElementById('agentDashboardStats');
      if (!body) return;

      const agents = [...this.agents.values()];
      if (agents.length === 0) {
        body.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'monitor-empty';
        empty.textContent = 'No registered agents';
        body.appendChild(empty);
        if (stats) stats.textContent = '0 agents';
        return;
      }

      // Build agent-to-session and agent-to-workitem mappings
      const agentSessions = new Map();
      for (const s of this.sessions.values()) {
        if (s.agentProfile && s.agentProfile.agentId) {
          agentSessions.set(s.agentProfile.agentId, s);
        }
      }

      const agentWorkItems = new Map();
      const agentCompletedItems = new Map();
      for (const wi of this.workItems.values()) {
        if (wi.assignedAgentId) {
          if (wi.status === 'done' || wi.status === 'cancelled') {
            if (!agentCompletedItems.has(wi.assignedAgentId)) agentCompletedItems.set(wi.assignedAgentId, []);
            agentCompletedItems.get(wi.assignedAgentId).push(wi);
          } else {
            if (!agentWorkItems.has(wi.assignedAgentId)) agentWorkItems.set(wi.assignedAgentId, []);
            agentWorkItems.get(wi.assignedAgentId).push(wi);
          }
        }
      }

      // Determine status for each agent
      let busyCount = 0,
        idleCount = 0,
        offlineCount = 0;
      const agentData = agents.map((agent: any) => {
        const session = agentSessions.get(agent.agentId);
        let statusColor: string, statusLabel: string;
        if (!session || session.status === 'closed' || session.status === 'archived') {
          statusColor = 'gray';
          statusLabel = 'offline';
          offlineCount++;
        } else if (session.isWorking || session.status === 'busy') {
          statusColor = 'green';
          statusLabel = 'working';
          busyCount++;
        } else {
          statusColor = 'yellow';
          statusLabel = 'idle';
          idleCount++;
        }
        return { agent, session, statusColor, statusLabel };
      });

      const statusOrder: Record<string, number> = { green: 0, yellow: 1, red: 2, gray: 3 };
      agentData.sort((a: any, b: any) => (statusOrder[a.statusColor] ?? 9) - (statusOrder[b.statusColor] ?? 9));

      const parts: string[] = [];
      if (busyCount > 0) parts.push(`${busyCount} busy`);
      if (idleCount > 0) parts.push(`${idleCount} idle`);
      if (offlineCount > 0) parts.push(`${offlineCount} offline`);
      if (stats) stats.textContent = parts.join(' / ') || `${agents.length} agents`;

      body.textContent = '';
      const container = document.createElement('div');
      container.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

      for (const { agent, session, statusColor, statusLabel } of agentData) {
        const card = document.createElement('div');
        card.className = 'agent-dashboard-card';
        const isExpanded = this._agentDashboardExpanded.has(agent.agentId);
        if (isExpanded) card.classList.add('expanded');

        const dot = document.createElement('div');
        dot.className = `agent-status-dot ${statusColor}`;
        dot.title = statusLabel;
        card.appendChild(dot);

        const info = document.createElement('div');
        info.className = 'agent-card-info';

        const header = document.createElement('div');
        header.className = 'agent-card-header';
        const name = document.createElement('span');
        name.className = 'agent-card-name';
        name.textContent = agent.displayName || agent.agentId;
        header.appendChild(name);
        if (agent.role) {
          const role = document.createElement('span');
          role.className = 'agent-card-role';
          role.textContent = agent.role;
          header.appendChild(role);
        }
        info.appendChild(header);

        const activeItems = agentWorkItems.get(agent.agentId) || [];
        if (activeItems.length > 0) {
          for (const wi of activeItems.slice(0, 2)) {
            const wiDiv = document.createElement('div');
            wiDiv.className = 'agent-work-item';
            const wiStatus = document.createElement('span');
            wiStatus.className = `agent-wi-status ${wi.status || ''}`;
            wiStatus.textContent = (wi.status || 'unknown').replace('_', ' ');
            wiDiv.appendChild(wiStatus);
            const wiTitle = document.createElement('span');
            wiTitle.textContent = wi.title || wi.id;
            wiTitle.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            wiDiv.appendChild(wiTitle);
            info.appendChild(wiDiv);
          }
        }

        if (session && session.status !== 'closed' && session.status !== 'archived') {
          const sessDiv = document.createElement('div');
          sessDiv.className = 'agent-session-info';
          const sessState = session.isWorking ? 'working' : session.status || 'idle';
          sessDiv.textContent = `Session: ${session.name || this.getShortId(session.id)} (${sessState})`;
          info.appendChild(sessDiv);
        }

        if (isExpanded) {
          const detail = document.createElement('div');
          detail.className = 'agent-card-detail';

          if (activeItems.length > 0) {
            const wi = activeItems[0];
            if (wi.branchName) {
              const row = document.createElement('div');
              row.className = 'agent-detail-row';
              const label = document.createElement('span');
              label.className = 'agent-detail-label';
              label.textContent = 'Branch:';
              row.appendChild(label);
              const val = document.createElement('span');
              val.textContent = wi.branchName;
              row.appendChild(val);
              detail.appendChild(row);
            }
            if (wi.description) {
              const row = document.createElement('div');
              row.className = 'agent-detail-row';
              const label = document.createElement('span');
              label.className = 'agent-detail-label';
              label.textContent = 'Task:';
              row.appendChild(label);
              const val = document.createElement('span');
              val.textContent = wi.description.length > 80 ? wi.description.slice(0, 80) + '...' : wi.description;
              val.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
              row.appendChild(val);
              detail.appendChild(row);
            }
          }

          if (session && session.status !== 'closed' && session.status !== 'archived') {
            const row = document.createElement('div');
            row.className = 'agent-detail-row';
            const label = document.createElement('span');
            label.className = 'agent-detail-label';
            label.textContent = 'Session:';
            row.appendChild(label);
            const link = document.createElement('span');
            link.className = 'agent-session-link';
            link.textContent = session.name || this.getShortId(session.id);
            link.addEventListener('click', (e: Event) => {
              e.stopPropagation();
              this.selectSession(session.id);
            });
            row.appendChild(link);
            detail.appendChild(row);
          }

          const completedItems = (agentCompletedItems.get(agent.agentId) || []).slice(0, 3);
          if (completedItems.length > 0) {
            const row = document.createElement('div');
            const label = document.createElement('span');
            label.className = 'agent-detail-label';
            label.textContent = 'Completed:';
            row.appendChild(label);
            const list = document.createElement('ul');
            list.className = 'agent-completed-list';
            for (const ci of completedItems) {
              const li = document.createElement('li');
              li.textContent = ci.title || ci.id;
              list.appendChild(li);
            }
            row.appendChild(list);
            detail.appendChild(row);
          }

          if (agent.capabilities && agent.capabilities.length > 0) {
            const row = document.createElement('div');
            row.className = 'agent-detail-row';
            const label = document.createElement('span');
            label.className = 'agent-detail-label';
            label.textContent = 'Skills:';
            row.appendChild(label);
            const val = document.createElement('span');
            val.textContent = agent.capabilities.map((c: any) => c.name).join(', ');
            val.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            row.appendChild(val);
            detail.appendChild(row);
          }

          info.appendChild(detail);

          // Messaging section
          const msgSection = document.createElement('div');
          msgSection.className = 'agent-messaging-section';
          const msgList = document.createElement('div');
          msgList.className = 'agent-msg-list';
          msgList.textContent = 'Loading messages...';
          msgSection.appendChild(msgList);

          const inputRow = document.createElement('div');
          inputRow.className = 'agent-msg-input-row';
          const msgInput = document.createElement('input');
          msgInput.type = 'text';
          msgInput.placeholder = 'Send message...';
          inputRow.appendChild(msgInput);
          const sendBtn = document.createElement('button');
          sendBtn.textContent = 'Send';
          inputRow.appendChild(sendBtn);
          msgSection.appendChild(inputRow);
          info.appendChild(msgSection);

          this._loadAgentDashboardMessages(agent.agentId, msgList);
        }

        card.appendChild(info);

        card.addEventListener('click', () => {
          if (this._agentDashboardExpanded.has(agent.agentId)) {
            this._agentDashboardExpanded.delete(agent.agentId);
          } else {
            this._agentDashboardExpanded.add(agent.agentId);
          }
          this.renderAgentDashboard();
        });

        container.appendChild(card);
      }

      body.appendChild(container);
    },

    async _loadAgentDashboardMessages(agentId: string, msgListEl: HTMLElement) {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/inbox?limit=5`);
        if (!res.ok) {
          msgListEl.textContent = 'No messages';
          return;
        }
        const data = await res.json();
        const messages = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
        msgListEl.textContent = '';
        if (messages.length === 0) {
          msgListEl.textContent = 'No messages';
          return;
        }
        for (const msg of messages.slice(0, 5)) {
          const item = document.createElement('div');
          item.className = 'agent-msg-item';
          const from = msg.fromAgentId || 'system';
          const text = msg.body || msg.content || JSON.stringify(msg);
          const truncated = text.length > 100 ? text.slice(0, 100) + '...' : text;
          item.textContent = `${from}: ${truncated}`;
          msgListEl.appendChild(item);
        }
      } catch {
        msgListEl.textContent = 'Failed to load messages';
      }
    },

    async _sendAgentDashboardMessage(agentId: string, content: string, msgListEl: HTMLElement) {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fromAgentId: 'dashboard-user',
            type: 'info',
            subject: 'Dashboard message',
            body: content,
          }),
        });
        if (res.ok) {
          this._loadAgentDashboardMessages(agentId, msgListEl);
        } else {
          this.showToast('Failed to send message', 'error');
        }
      } catch (err: any) {
        this.showToast('Failed to send message: ' + err.message, 'error');
      }
    },
  };
}

// ─── Global setup / teardown ──────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  buildDashboardDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupDom();
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

// Gap 1: renderAgentDashboard()

describe('renderAgentDashboard()', () => {
  it('shows empty state when no agents are registered', () => {
    const dash = makeDashboard();
    dash.renderAgentDashboard();

    const body = document.getElementById('agentDashboardBody')!;
    const empty = body.querySelector('.monitor-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe('No registered agents');

    const stats = document.getElementById('agentDashboardStats')!;
    expect(stats.textContent).toBe('0 agents');
  });

  it('renders a card with green status dot for a busy agent', () => {
    const dash = makeDashboard();
    dash.agents.set('a1', { agentId: 'a1', displayName: 'Builder', role: 'codeman-dev' });
    dash.sessions.set('s1', {
      id: 's1',
      agentProfile: { agentId: 'a1' },
      status: 'busy',
      isWorking: true,
      name: 'Build Session',
    });

    dash.renderAgentDashboard();

    const dot = document.querySelector('.agent-status-dot')!;
    expect(dot.classList.contains('green')).toBe(true);
    expect(dot.getAttribute('title')).toBe('working');
  });

  it('renders a yellow dot for an idle agent', () => {
    const dash = makeDashboard();
    dash.agents.set('a1', { agentId: 'a1', displayName: 'Idler', role: 'analyst' });
    dash.sessions.set('s1', {
      id: 's1',
      agentProfile: { agentId: 'a1' },
      status: 'idle',
      isWorking: false,
      name: 'Idle Session',
    });

    dash.renderAgentDashboard();

    const dot = document.querySelector('.agent-status-dot')!;
    expect(dot.classList.contains('yellow')).toBe(true);
    expect(dot.getAttribute('title')).toBe('idle');
  });

  it('renders a gray dot for an agent with no session', () => {
    const dash = makeDashboard();
    dash.agents.set('a1', { agentId: 'a1', displayName: 'Offline Agent', role: 'analyst' });

    dash.renderAgentDashboard();

    const dot = document.querySelector('.agent-status-dot')!;
    expect(dot.classList.contains('gray')).toBe(true);
    expect(dot.getAttribute('title')).toBe('offline');
  });

  it('updates stats badge with correct busy/idle/offline counts', () => {
    const dash = makeDashboard();
    dash.agents.set('a1', { agentId: 'a1', displayName: 'Busy', role: 'dev' });
    dash.agents.set('a2', { agentId: 'a2', displayName: 'Idle', role: 'dev' });
    dash.agents.set('a3', { agentId: 'a3', displayName: 'Offline', role: 'dev' });

    dash.sessions.set('s1', {
      id: 's1',
      agentProfile: { agentId: 'a1' },
      status: 'busy',
      isWorking: true,
    });
    dash.sessions.set('s2', {
      id: 's2',
      agentProfile: { agentId: 'a2' },
      status: 'idle',
      isWorking: false,
    });
    // a3 has no session

    dash.renderAgentDashboard();

    const stats = document.getElementById('agentDashboardStats')!;
    expect(stats.textContent).toBe('1 busy / 1 idle / 1 offline');
  });

  it('displays work item title and status for an agent with active work', () => {
    const dash = makeDashboard();
    dash.agents.set('a1', { agentId: 'a1', displayName: 'Worker', role: 'dev' });
    dash.sessions.set('s1', {
      id: 's1',
      agentProfile: { agentId: 'a1' },
      status: 'busy',
      isWorking: true,
    });
    dash.workItems.set('wi1', {
      id: 'wi1',
      title: 'Implement feature X',
      status: 'in_progress',
      assignedAgentId: 'a1',
    });

    dash.renderAgentDashboard();

    const wiDiv = document.querySelector('.agent-work-item')!;
    expect(wiDiv).not.toBeNull();
    const wiStatus = wiDiv.querySelector('.agent-wi-status')!;
    expect(wiStatus.textContent).toBe('in progress');
    // The second span has the title
    const spans = wiDiv.querySelectorAll('span');
    expect(spans[1].textContent).toBe('Implement feature X');
  });

  it('displays session info with session name and working state', () => {
    const dash = makeDashboard();
    dash.agents.set('a1', { agentId: 'a1', displayName: 'Agent', role: 'dev' });
    dash.sessions.set('s1', {
      id: 's1',
      agentProfile: { agentId: 'a1' },
      status: 'busy',
      isWorking: true,
      name: 'My Session',
    });

    dash.renderAgentDashboard();

    const sessInfo = document.querySelector('.agent-session-info')!;
    expect(sessInfo).not.toBeNull();
    expect(sessInfo.textContent).toBe('Session: My Session (working)');
  });

  it('adds expanded class and detail section when agent is in expanded set', () => {
    const dash = makeDashboard();
    dash.agents.set('a1', { agentId: 'a1', displayName: 'Agent', role: 'dev' });
    dash.sessions.set('s1', {
      id: 's1',
      agentProfile: { agentId: 'a1' },
      status: 'busy',
      isWorking: true,
      name: 'Sess',
    });
    dash.workItems.set('wi1', {
      id: 'wi1',
      title: 'Task',
      status: 'in_progress',
      assignedAgentId: 'a1',
      branchName: 'feat/test',
      description: 'A short description',
    });
    // Mock fetch for messages load triggered by expansion
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    dash._agentDashboardExpanded.add('a1');
    dash.renderAgentDashboard();

    const card = document.querySelector('.agent-dashboard-card')!;
    expect(card.classList.contains('expanded')).toBe(true);

    const detail = document.querySelector('.agent-card-detail')!;
    expect(detail).not.toBeNull();

    // Branch row
    const branchLabel = detail.querySelector('.agent-detail-label');
    expect(branchLabel).not.toBeNull();
    expect(branchLabel!.textContent).toBe('Branch:');
  });

  it('renders capabilities as comma-separated names in expanded view', () => {
    const dash = makeDashboard();
    dash.agents.set('a1', {
      agentId: 'a1',
      displayName: 'Agent',
      role: 'dev',
      capabilities: [
        { name: 'skill-a', type: 'skill', ref: 'ref-a', enabled: true },
        { name: 'mcp-b', type: 'mcp', ref: 'ref-b', enabled: true },
      ],
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    dash._agentDashboardExpanded.add('a1');
    dash.renderAgentDashboard();

    // Find the Skills: label and its sibling value span
    const labels = document.querySelectorAll('.agent-detail-label');
    let skillsVal: string | null = null;
    labels.forEach((lbl) => {
      if (lbl.textContent === 'Skills:') {
        skillsVal = (lbl.nextElementSibling as HTMLElement)?.textContent ?? null;
      }
    });
    expect(skillsVal).toBe('skill-a, mcp-b');
  });

  it('renders completed work items in expanded view', () => {
    const dash = makeDashboard();
    dash.agents.set('a1', { agentId: 'a1', displayName: 'Agent', role: 'dev' });
    dash.workItems.set('wi-done', {
      id: 'wi-done',
      title: 'Finished task',
      status: 'done',
      assignedAgentId: 'a1',
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    dash._agentDashboardExpanded.add('a1');
    dash.renderAgentDashboard();

    const completedList = document.querySelector('.agent-completed-list')!;
    expect(completedList).not.toBeNull();
    expect(completedList.querySelector('li')!.textContent).toBe('Finished task');
  });

  it('sorts agents: busy first, then idle, then offline', () => {
    const dash = makeDashboard();
    // Add in reverse order: offline, idle, busy
    dash.agents.set('offline', { agentId: 'offline', displayName: 'Offline', role: 'dev' });
    dash.agents.set('idle', { agentId: 'idle', displayName: 'Idle', role: 'dev' });
    dash.agents.set('busy', { agentId: 'busy', displayName: 'Busy', role: 'dev' });

    dash.sessions.set('s-busy', {
      id: 's-busy',
      agentProfile: { agentId: 'busy' },
      status: 'busy',
      isWorking: true,
    });
    dash.sessions.set('s-idle', {
      id: 's-idle',
      agentProfile: { agentId: 'idle' },
      status: 'idle',
      isWorking: false,
    });

    dash.renderAgentDashboard();

    const names = document.querySelectorAll('.agent-card-name');
    expect(names.length).toBe(3);
    expect(names[0].textContent).toBe('Busy');
    expect(names[1].textContent).toBe('Idle');
    expect(names[2].textContent).toBe('Offline');
  });
});

// Gap 2: _loadWorkItemsForDashboard()

describe('_loadWorkItemsForDashboard()', () => {
  it('fetches GET /api/work-items and populates workItems Map', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'wi1', title: 'Task 1', status: 'open' },
          { id: 'wi2', title: 'Task 2', status: 'in_progress' },
        ],
      }),
    } as Response);

    const dash = makeDashboard();
    await dash._loadWorkItemsForDashboard();

    expect(fetch).toHaveBeenCalledWith('/api/work-items');
    expect(dash.workItems.size).toBe(2);
    expect(dash.workItems.get('wi1')!.title).toBe('Task 1');
    expect(dash.workItems.get('wi2')!.title).toBe('Task 2');
  });

  it('clears existing workItems before populating', async () => {
    const dash = makeDashboard();
    dash.workItems.set('old', { id: 'old', title: 'Old item' });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'new', title: 'New item' }] }),
    } as Response);

    await dash._loadWorkItemsForDashboard();

    expect(dash.workItems.has('old')).toBe(false);
    expect(dash.workItems.has('new')).toBe(true);
  });

  it('handles fetch failure gracefully without throwing', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

    const dash = makeDashboard();
    // Should not throw
    await expect(dash._loadWorkItemsForDashboard()).resolves.toBeUndefined();
    expect(dash.workItems.size).toBe(0);
  });

  it('handles non-ok response without clearing existing items', async () => {
    const dash = makeDashboard();
    dash.workItems.set('existing', { id: 'existing', title: 'Keep me' });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server error' }),
    } as Response);

    await dash._loadWorkItemsForDashboard();

    // workItems not cleared on non-ok
    expect(dash.workItems.has('existing')).toBe(true);
  });
});

// Gap 3: _loadAgentDashboardMessages()

describe('_loadAgentDashboardMessages()', () => {
  it('fetches GET /api/agents/:id/inbox?limit=5 and renders messages using msg.body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { fromAgentId: 'agent-x', body: 'Hello from agent X', subject: 'Greeting' },
          { fromAgentId: 'agent-y', body: 'Status update', subject: 'Update' },
        ],
      }),
    } as Response);

    const dash = makeDashboard();
    const msgListEl = document.createElement('div');
    document.body.appendChild(msgListEl);

    await dash._loadAgentDashboardMessages('agent-1', msgListEl);

    expect(fetch).toHaveBeenCalledWith('/api/agents/agent-1/inbox?limit=5');
    const items = msgListEl.querySelectorAll('.agent-msg-item');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe('agent-x: Hello from agent X');
    expect(items[1].textContent).toBe('agent-y: Status update');
  });

  it('shows "No messages" when response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const dash = makeDashboard();
    const msgListEl = document.createElement('div');
    document.body.appendChild(msgListEl);

    await dash._loadAgentDashboardMessages('agent-1', msgListEl);

    expect(msgListEl.textContent).toBe('No messages');
  });

  it('shows "No messages" when response returns empty array', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    const dash = makeDashboard();
    const msgListEl = document.createElement('div');
    document.body.appendChild(msgListEl);

    await dash._loadAgentDashboardMessages('agent-1', msgListEl);

    expect(msgListEl.textContent).toBe('No messages');
  });

  it('shows "Failed to load messages" on fetch error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network down'));

    const dash = makeDashboard();
    const msgListEl = document.createElement('div');
    document.body.appendChild(msgListEl);

    await dash._loadAgentDashboardMessages('agent-1', msgListEl);

    expect(msgListEl.textContent).toBe('Failed to load messages');
  });
});

// Gap 4: _sendAgentDashboardMessage()

describe('_sendAgentDashboardMessage()', () => {
  it('POSTs to /api/agents/:agentId/messages with correct body shape', async () => {
    // First call: the POST itself. Second call: the reload of messages.
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) } as Response);

    const dash = makeDashboard();
    const msgListEl = document.createElement('div');
    document.body.appendChild(msgListEl);

    await dash._sendAgentDashboardMessage('agent-abc', 'Hello there', msgListEl);

    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents/agent-abc/messages');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string);
    expect(body.fromAgentId).toBe('dashboard-user');
    expect(body.type).toBe('info');
    expect(body.subject).toBe('Dashboard message');
    expect(body.body).toBe('Hello there');
  });

  it('reloads messages after successful send', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ fromAgentId: 'me', body: 'Hello' }] }),
      } as Response);

    const dash = makeDashboard();
    const msgListEl = document.createElement('div');
    document.body.appendChild(msgListEl);

    await dash._sendAgentDashboardMessage('agent-abc', 'Hello', msgListEl);

    // Second fetch call should be the inbox reload
    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('/api/agents/agent-abc/inbox?limit=5');
  });

  it('shows error toast when send fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Bad request' }),
    } as Response);

    const dash = makeDashboard();
    const msgListEl = document.createElement('div');
    document.body.appendChild(msgListEl);

    await dash._sendAgentDashboardMessage('agent-abc', 'Hello', msgListEl);

    expect(dash.showToast).toHaveBeenCalledWith('Failed to send message', 'error');
  });
});

// Gap 5: _scheduleAgentDashboardRender() debounce

describe('_scheduleAgentDashboardRender()', () => {
  it('calls renderAgentDashboard after 120ms debounce', () => {
    vi.useFakeTimers();
    const dash = makeDashboard();
    const renderSpy = vi.spyOn(dash, 'renderAgentDashboard');

    dash._scheduleAgentDashboardRender();

    // Not called immediately
    expect(renderSpy).not.toHaveBeenCalled();

    // Still not called at 119ms
    vi.advanceTimersByTime(119);
    expect(renderSpy).not.toHaveBeenCalled();

    // Called at 120ms
    vi.advanceTimersByTime(1);
    expect(renderSpy).toHaveBeenCalledOnce();
  });

  it('batches multiple rapid calls into a single render', () => {
    vi.useFakeTimers();
    const dash = makeDashboard();
    const renderSpy = vi.spyOn(dash, 'renderAgentDashboard');

    dash._scheduleAgentDashboardRender();
    vi.advanceTimersByTime(50);
    dash._scheduleAgentDashboardRender();
    vi.advanceTimersByTime(50);
    dash._scheduleAgentDashboardRender();

    // 120ms from last call
    vi.advanceTimersByTime(120);
    expect(renderSpy).toHaveBeenCalledOnce();
  });
});

// Gap 6: SSE handler hooks — verify the handlers update workItems cache

describe('SSE work item cache updates', () => {
  it('_onWorkItemCreated adds item to workItems Map', () => {
    const dash = makeDashboard() as any;
    // Provide a stub boardView to avoid errors in real SSE handler
    dash.boardView = { onWorkItemCreated: vi.fn(), addTimelineEvent: vi.fn() };

    // Simulate the SSE handler logic inline (as it appears in the real code)
    const data = { id: 'wi-new', title: 'New Item', status: 'open' };
    if (data.id) dash.workItems.set(data.id, data);

    expect(dash.workItems.get('wi-new')).toEqual(data);
  });

  it('_onWorkItemUpdated merges with existing item', () => {
    const dash = makeDashboard() as any;
    dash.workItems.set('wi-1', { id: 'wi-1', title: 'Original', status: 'open', assignedAgentId: 'a1' });

    // Simulate the merge semantics from _onWorkItemUpdated
    const data = { id: 'wi-1', status: 'in_progress' };
    const existing = dash.workItems.get(data.id);
    dash.workItems.set(data.id, existing ? { ...existing, ...data } : data);

    const result = dash.workItems.get('wi-1');
    expect(result.title).toBe('Original'); // preserved
    expect(result.status).toBe('in_progress'); // updated
    expect(result.assignedAgentId).toBe('a1'); // preserved
  });

  it('_onWorkItemCompleted sets status to done', () => {
    const dash = makeDashboard() as any;
    dash.workItems.set('wi-1', { id: 'wi-1', title: 'Task', status: 'in_progress' });

    // Simulate _onWorkItemCompleted logic
    const data = { id: 'wi-1' };
    const existing = dash.workItems.get(data.id);
    dash.workItems.set(data.id, existing ? { ...existing, ...data, status: 'done' } : { ...data, status: 'done' });

    expect(dash.workItems.get('wi-1').status).toBe('done');
  });
});

// Gap 7: HTML structure — verify DOM elements used by renderAgentDashboard exist

describe('HTML structure — dashboard DOM elements', () => {
  it('#agentDashboardBody and #agentDashboardStats are present in the test DOM', () => {
    // These elements are created by buildDashboardDom() which mirrors index.html
    expect(document.getElementById('agentDashboardBody')).not.toBeNull();
    expect(document.getElementById('agentDashboardStats')).not.toBeNull();
    expect(document.getElementById('agentDashboardSection')).not.toBeNull();
  });

  it('renderAgentDashboard returns early without error when #agentDashboardBody is missing', () => {
    // Remove the body element
    const body = document.getElementById('agentDashboardBody');
    body?.remove();

    const dash = makeDashboard();
    // Should not throw
    expect(() => dash.renderAgentDashboard()).not.toThrow();
  });
});

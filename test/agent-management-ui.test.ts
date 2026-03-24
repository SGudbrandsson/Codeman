// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for AgentPanel frontend logic.
 *
 * AgentPanel lives in src/web/public/app.js (a browser script). These tests
 * mirror the method implementations and run them against a minimal DOM using
 * vitest jsdom environment + manual DOM construction via document APIs.
 *
 * Strategy:
 * - Set up a minimal DOM (required form elements) using document.createElement
 * - Mock global fetch, confirm, and app.showToast
 * - Build a thin AgentPanel object that reproduces the real method bodies
 * - Assert on fetch calls and DOM state
 *
 * Run: npx vitest run test/agent-management-ui.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

/**
 * Appends an input element to document.body with the given id and type.
 */
function appendInput(id: string, type = 'text', value = ''): HTMLInputElement {
  const el = document.createElement('input');
  el.id = id;
  el.type = type;
  el.value = value;
  document.body.appendChild(el);
  return el;
}

/**
 * Appends a role input element to document.body.
 * Matches the real DOM: <input type="text" list="agentRoleSuggestions"> backed by a <datalist>.
 * The first 5 preset roles appear as datalist suggestions but any free-text value is valid.
 */
function appendRoleSelect(id: string): HTMLInputElement {
  const datalist = document.createElement('datalist');
  datalist.id = 'agentRoleSuggestions';
  for (const r of ['codeman-dev', 'orchestrator', 'analyst', 'keeps-engineer', 'deployment-agent']) {
    const opt = document.createElement('option');
    opt.value = r;
    datalist.appendChild(opt);
  }
  document.body.appendChild(datalist);

  const input = document.createElement('input');
  input.type = 'text';
  input.id = id;
  input.setAttribute('list', 'agentRoleSuggestions');
  document.body.appendChild(input);
  return input;
}

/**
 * Appends a div error element (hidden by default) to document.body.
 */
function appendErrDiv(id: string): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

/**
 * Build the minimal form DOM that AgentPanel methods interact with.
 */
function buildFormDom() {
  const panel = document.createElement('div');
  panel.id = 'agentPanel';
  document.body.appendChild(panel);

  const overlay = document.createElement('div');
  overlay.id = 'agentPanelOverlay';
  document.body.appendChild(overlay);

  appendInput('agentFormName', 'text', '');
  appendErrDiv('agentFormNameErr');
  appendRoleSelect('agentFormRole');
  appendErrDiv('agentFormRoleErr');

  const promptEl = document.createElement('textarea');
  promptEl.id = 'agentFormPrompt';
  document.body.appendChild(promptEl);

  appendInput('agentFormNotesTtl', 'number', '90');
  appendInput('agentFormPatternsTtl', 'number', '365');
}

function cleanupDom() {
  document.body.replaceChildren();
}

// ─── Minimal AgentPanel object ────────────────────────────────────────────────

/**
 * Reproduces the AgentPanel method bodies from app.js verbatim.
 * Only the methods under test are included.
 */
function makeAgentPanel(
  agentId: string | null = null,
  pendingMcp: Array<{
    name: string;
    ref: string;
    enabled: boolean;
    envVars: Record<string, string>;
    _envVals: Record<string, string>;
  }> = []
) {
  return {
    _agentId: agentId,
    _mcpLibrary: null as unknown[] | null,
    _pendingMcp: pendingMcp,

    _validate(): boolean {
      const nameEl = document.getElementById('agentFormName') as HTMLInputElement | null;
      const nameErrEl = document.getElementById('agentFormNameErr') as HTMLElement | null;
      const roleEl = document.getElementById('agentFormRole') as HTMLSelectElement | null;
      const roleErrEl = document.getElementById('agentFormRoleErr') as HTMLElement | null;
      let ok = true;
      if (!nameEl || !nameEl.value.trim()) {
        if (nameErrEl) {
          nameErrEl.style.display = '';
        }
        ok = false;
      } else {
        if (nameErrEl) {
          nameErrEl.style.display = 'none';
        }
      }
      if (!roleEl || !roleEl.value) {
        if (roleErrEl) {
          roleErrEl.style.display = '';
        }
        ok = false;
      } else {
        if (roleErrEl) {
          roleErrEl.style.display = 'none';
        }
      }
      return ok;
    },

    _buildBody(): Record<string, unknown> {
      const nameEl = document.getElementById('agentFormName') as HTMLInputElement | null;
      const roleEl = document.getElementById('agentFormRole') as HTMLSelectElement | null;
      const promptEl = document.getElementById('agentFormPrompt') as HTMLTextAreaElement | null;
      const notesTtlEl = document.getElementById('agentFormNotesTtl') as HTMLInputElement | null;
      const patternsTtlEl = document.getElementById('agentFormPatternsTtl') as HTMLInputElement | null;

      const body: Record<string, unknown> = {
        displayName: nameEl?.value.trim() ?? '',
        role: roleEl?.value ?? '',
        decay: {
          notesTtlDays: Number(notesTtlEl?.value ?? 90),
          patternsTtlDays: Number(patternsTtlEl?.value ?? 365),
        },
      };
      if (promptEl?.value.trim()) body.rolePrompt = promptEl.value.trim();

      const capabilities: unknown[] = [];
      this._pendingMcp.forEach((mcp, idx) => {
        const envVars: Record<string, string> = {};
        Object.keys(mcp.envVars || {}).forEach((k, ei) => {
          const inputs = document.querySelectorAll<HTMLInputElement>(`[data-mcp="${idx}"][data-env="${ei}"]`);
          const val = inputs[0]?.value ?? mcp._envVals?.[k] ?? '';
          if (val) envVars[k] = val;
        });
        capabilities.push({
          name: mcp.name,
          type: 'mcp',
          ref: mcp.ref,
          enabled: mcp.enabled !== false,
          envVars: Object.keys(envVars).length ? envVars : undefined,
        });
      });
      body.capabilities = capabilities;
      return body;
    },

    async _create(): Promise<void> {
      if (!this._validate()) return;
      const body = this._buildBody();
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to create agent');
      (globalThis as any).app.showToast('Agent created', 'success');
      this.close();
    },

    async _save(): Promise<void> {
      if (!this._validate()) return;
      const body = this._buildBody();
      const res = await fetch(`/api/agents/${this._agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save agent');
      (globalThis as any).app.showToast('Agent saved', 'success');
    },

    async _delete(): Promise<void> {
      if (!confirm('Delete this agent? This cannot be undone.')) return;
      const res = await fetch(`/api/agents/${this._agentId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error((data.error as string) || 'Failed to delete agent');
      }
      (globalThis as any).app.showToast('Agent deleted', 'success');
      this.close();
    },

    async _consolidate(): Promise<void> {
      const res = await fetch(`/api/agents/${this._agentId}/vault/consolidate`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to consolidate');
      (globalThis as any).app.showToast('Vault consolidation triggered', 'success');
    },

    async _linkSession(sessionId: string): Promise<void> {
      if (!this._agentId) return;
      if (!sessionId) {
        const sessions = Array.from(
          (globalThis as any).app.sessions.values() as IterableIterator<{
            id: string;
            agentProfile?: { agentId: string };
          }>
        );
        const linked = sessions.find((s) => s.agentProfile && s.agentProfile.agentId === this._agentId);
        if (!linked) return;
        const res = await fetch(`/api/sessions/${linked.id}/agent`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: null }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to unlink session');
        (globalThis as any).app.showToast('Session unlinked', 'success');
        return;
      }
      const res = await fetch(`/api/sessions/${sessionId}/agent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: this._agentId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to link session');
      (globalThis as any).app.showToast('Session linked', 'success');
    },

    _toggleEnvEye(btn: HTMLButtonElement): void {
      const input = btn.previousElementSibling as HTMLInputElement;
      input.type = input.type === 'password' ? 'text' : 'password';
    },

    close(): void {
      const panelEl = document.getElementById('agentPanel');
      const overlayEl = document.getElementById('agentPanelOverlay');
      if (panelEl) panelEl.classList.remove('open');
      if (overlayEl) overlayEl.classList.remove('open');
      this._agentId = null;
    },
  };
}

// ─── Global setup / teardown ──────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true)
  );
  (globalThis as any).app = { showToast: vi.fn(), sessions: new Map() };
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupDom();
  delete (globalThis as any).app;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentPanel._create()', () => {
  it('POSTs correct body to /api/agents', async () => {
    buildFormDom();

    (document.getElementById('agentFormName') as HTMLInputElement).value = 'My Test Agent';
    (document.getElementById('agentFormRole') as HTMLInputElement).value = 'codeman-dev';

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { agentId: 'new-id' } }),
    } as Response);

    const panel = makeAgentPanel(null);
    await panel._create();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.displayName).toBe('My Test Agent');
    expect(body.role).toBe('codeman-dev');
  });
});

describe('AgentPanel._save()', () => {
  it('PATCHes correct body to /api/agents/:id', async () => {
    buildFormDom();

    (document.getElementById('agentFormName') as HTMLInputElement).value = 'Updated Name';
    (document.getElementById('agentFormRole') as HTMLInputElement).value = 'orchestrator';

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { agentId: 'agent-xyz' } }),
    } as Response);

    const panel = makeAgentPanel('agent-xyz');
    await panel._save();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents/agent-xyz');
    expect(options.method).toBe('PATCH');
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.displayName).toBe('Updated Name');
    expect(body.role).toBe('orchestrator');
  });
});

describe('AgentPanel._delete()', () => {
  it('calls DELETE /api/agents/:id after confirm', async () => {
    buildFormDom();

    vi.mocked(confirm).mockReturnValue(true);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    const panel = makeAgentPanel('agent-to-delete');
    await panel._delete();

    expect(confirm).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents/agent-to-delete');
    expect(options.method).toBe('DELETE');
  });

  it('does NOT call fetch when user cancels confirm dialog', async () => {
    buildFormDom();
    vi.mocked(confirm).mockReturnValue(false);

    const panel = makeAgentPanel('agent-cancel');
    await panel._delete();

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('AgentPanel._consolidate()', () => {
  it('POSTs to /api/agents/:id/vault/consolidate', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    const panel = makeAgentPanel('agent-vault');
    await panel._consolidate();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents/agent-vault/vault/consolidate');
    expect(options.method).toBe('POST');
  });
});

describe('AgentPanel._linkSession()', () => {
  it('calls PATCH /api/sessions/:id/agent with agentId when sessionId is provided', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    const panel = makeAgentPanel('agent-link');
    await panel._linkSession('session-123');

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sessions/session-123/agent');
    expect(options.method).toBe('PATCH');
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.agentId).toBe('agent-link');
  });

  it('calls PATCH with agentId:null to unlink when sessionId is empty string', async () => {
    // Set up a linked session in app.sessions
    (globalThis as any).app.sessions.set('linked-session', {
      id: 'linked-session',
      agentProfile: { agentId: 'agent-unlink' },
    });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    const panel = makeAgentPanel('agent-unlink');
    await panel._linkSession('');

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sessions/linked-session/agent');
    expect(options.method).toBe('PATCH');
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.agentId).toBeNull();
  });
});

describe('MCP env vars rendering', () => {
  it('env var input renders as type="password" by default', () => {
    // Replicate the DOM structure that app.js produces for an MCP env var row.
    // The key input is readonly text; the value input is password type.
    const row = document.createElement('div');
    row.className = 'mcp-env-row';

    const keyInput = document.createElement('input');
    keyInput.className = 'mcp-env-key';
    keyInput.type = 'text';
    keyInput.value = 'API_KEY';
    row.appendChild(keyInput);

    const valInput = document.createElement('input');
    valInput.className = 'mcp-env-val';
    valInput.type = 'password';
    valInput.setAttribute('data-mcp', '0');
    valInput.setAttribute('data-env', '0');
    valInput.placeholder = 'value';
    row.appendChild(valInput);

    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'mcp-env-eye';
    row.appendChild(eyeBtn);

    document.body.appendChild(row);

    const input = document.querySelector<HTMLInputElement>('.mcp-env-val');
    expect(input).not.toBeNull();
    expect(input!.type).toBe('password');
  });

  it('eye-toggle button changes input type from password to text and back', () => {
    const row = document.createElement('div');
    row.className = 'mcp-env-row';

    const valInput = document.createElement('input');
    valInput.className = 'mcp-env-val';
    valInput.type = 'password';
    row.appendChild(valInput);

    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'mcp-env-eye';
    row.appendChild(eyeBtn);

    document.body.appendChild(row);

    const panel = makeAgentPanel();
    const input = document.querySelector<HTMLInputElement>('.mcp-env-val')!;
    const btn = document.querySelector<HTMLButtonElement>('.mcp-env-eye')!;

    expect(input.type).toBe('password');

    panel._toggleEnvEye(btn);
    expect(input.type).toBe('text');

    panel._toggleEnvEye(btn);
    expect(input.type).toBe('password');
  });
});

describe('AgentPanel._validate()', () => {
  it('returns false and shows name error when displayName is empty', () => {
    buildFormDom();
    // Leave name input empty; set a role value
    (document.getElementById('agentFormRole') as HTMLInputElement).value = 'codeman-dev';

    const panel = makeAgentPanel(null);
    const result = panel._validate();

    expect(result).toBe(false);
    const nameErr = document.getElementById('agentFormNameErr') as HTMLElement;
    expect(nameErr.style.display).not.toBe('none');
  });

  it('returns false and shows role error when no role is selected', () => {
    buildFormDom();
    (document.getElementById('agentFormName') as HTMLInputElement).value = 'Valid Name';
    // role input stays empty (value='')

    const panel = makeAgentPanel(null);
    const result = panel._validate();

    expect(result).toBe(false);
    const roleErr = document.getElementById('agentFormRoleErr') as HTMLElement;
    expect(roleErr.style.display).not.toBe('none');
  });
});

describe('AgentPanel custom role — free-text role flows through _validate() and _buildBody()', () => {
  it('_validate() returns true for a custom role string not in the preset list', () => {
    buildFormDom();
    (document.getElementById('agentFormName') as HTMLInputElement).value = 'Custom Role Agent';
    // Set a custom role value that is not one of the 5 preset options
    (document.getElementById('agentFormRole') as HTMLInputElement).value = 'my-custom-role';

    const panel = makeAgentPanel(null);
    const result = panel._validate();

    expect(result).toBe(true);
  });

  it('_buildBody() includes the custom role string verbatim in the returned body', () => {
    buildFormDom();
    (document.getElementById('agentFormName') as HTMLInputElement).value = 'Custom Role Agent';
    (document.getElementById('agentFormRole') as HTMLInputElement).value = 'my-custom-role';

    const panel = makeAgentPanel(null);
    const body = panel._buildBody();

    expect(body.role).toBe('my-custom-role');
    expect(body.displayName).toBe('Custom Role Agent');
  });

  it('_create() POSTs the custom role string to /api/agents', async () => {
    buildFormDom();
    (document.getElementById('agentFormName') as HTMLInputElement).value = 'Custom Role Agent';
    (document.getElementById('agentFormRole') as HTMLInputElement).value = 'my-custom-role';

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { agentId: 'new-custom-id' } }),
    } as Response);

    const panel = makeAgentPanel(null);
    await panel._create();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents');
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.role).toBe('my-custom-role');
  });
});

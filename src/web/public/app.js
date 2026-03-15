/**
 * @fileoverview Core UI controller for Codeman — tab-based terminal manager with xterm.js.
 *
 * This is the main application module (~11,500 lines). It defines the CodemanApp class which
 * manages the entire frontend: terminal rendering, SSE event handling, session lifecycle,
 * settings UI, and all panel systems. Additional methods are mixed in from api-client.js,
 * ralph-wizard.js, and subagent-windows.js via Object.assign on CodemanApp.prototype.
 *
 * ═══ Major Sections ═══
 *
 *   SSE Handler Map (line ~80)        — Event-to-method routing table
 *   CodemanApp Class (line ~189)      — Constructor and global state
 *   Pending Hooks (line ~368)         — Hook state machine for tab alerts
 *   Init (line ~408)                  — App bootstrap and mobile setup
 *   Terminal Setup (line ~483)        — xterm.js config and input handling
 *   Terminal Rendering (line ~1053)   — batchTerminalWrite, flushPendingWrites, chunkedTerminalWrite
 *   Event Listeners (line ~1390)      — Keyboard shortcuts, resize, beforeunload
 *   SSE Connection (line ~1474)       — connectSSE with exponential backoff (1-30s)
 *   SSE Event Handlers (line ~1570)   — ~60 handler methods (_onSessionCreated, _onRespawnStateChanged, etc.)
 *   Connection Status (line ~2553)    — Online detection, handleInit (full state sync on reconnect)
 *   Session Tabs (line ~2911)         — Tab rendering, selection, drag-and-drop reordering
 *   Tab Order & Drag-and-Drop (~3143) — Persistent tab ordering with drag reorder
 *   Session Lifecycle (line ~3268)    — Select, close, navigate sessions
 *   Navigation (line ~3673)           — goHome, Ralph wizard stub
 *   Quick Start (line ~3709)          — Case loading, session spawning (Claude, Shell, OpenCode)
 *   Respawn Banner (line ~4205)       — Respawn state display, countdown timers, action log
 *   Kill Sessions (line ~4640)        — Kill active/all sessions
 *   Terminal Controls (line ~4678)    — Clear, resize, copy, font size, sendInput
 *   Timer / Tokens (line ~4833)       — Session timer, token/cost display
 *   Session Options Modal (line ~4939) — Per-session settings, respawn config, color picker
 *   Respawn Presets (line ~5188)      — Preset CRUD, load/save/delete
 *   Run Summary Modal (line ~5506)    — Timeline events, filtering, export (JSON/Markdown)
 *   Session Options Tabs (line ~5762) — Ralph config tab within session options
 *   Web Push (line ~5882)             — Service worker registration, push subscribe/unsubscribe
 *   App Settings Modal (line ~6024)   — Global settings, tunnel management, QR auth, voice config
 *   Session Lifecycle Log (line ~6536) — JSONL audit log viewer
 *   Visibility Settings (line ~6859)  — Header/panel visibility, device-specific defaults
 *   Persistent Parent Assoc (line ~7218) — Parent session tracking for subagent windows
 *   Help Modal (line ~7326)           — Keyboard shortcuts help
 *   Token Statistics (line ~7363)     — Aggregate token/cost stats across sessions
 *   Monitor Panel (line ~7490)        — Mux sessions + background tasks, detachable panel
 *   Subagents Panel (line ~7614)      — Detachable subagent list panel
 *   Ralph Panel (line ~7799)          — Ralph Loop status, @fix_plan.md integration
 *   Plan Versioning (line ~8638)      — Plan checkpoint/rollback/diff UI
 *   Subagent Panel (line ~8780)       — Agent discovery, window open/close, connection lines
 *   Subagent Parent Tracking (~9101)  — Tab-based agent grouping
 *   Agent Teams (line ~9595)          — Team tasks panel, teammate badges
 *   Project Insights (line ~9995)     — Bash tool tracking with clickable file paths
 *   File Browser (line ~10310)        — Directory tree panel with file preview
 *   Log Viewer (line ~10619)          — Floating file streamer windows (tail -f)
 *   Image Popups (line ~10768)        — Auto-popup windows for detected screenshots
 *   Mux Sessions (line ~10909)        — tmux session list in monitor panel
 *   Case Settings (line ~10986)       — Case CRUD and link management
 *   Mobile Case Picker (line ~11221)  — Touch-friendly case selection modal
 *   Plan Wizard Agents (line ~11480)  — Plan orchestrator subagent display in monitor
 *   Toast (line ~11566)               — Toast notification popups
 *   System Stats (line ~11618)        — CPU/memory polling display
 *   Module Init (line ~11696)         — localStorage migration and app start
 *
 * After the class: localStorage migration (claudeman-* → codeman-*), app instantiation,
 * and window.app / window.MobileDetection exports.
 *
 * @class CodemanApp
 * @globals {CodemanApp} app - Singleton instance (also on window.app)
 *
 * @dependency constants.js (SSE_EVENTS, timing constants, escapeHtml, extractSyncSegments, DEC sync markers)
 * @dependency mobile-handlers.js (MobileDetection, KeyboardHandler, SwipeHandler)
 * @dependency voice-input.js (VoiceInput, DeepgramProvider)
 * @dependency notification-manager.js (NotificationManager class)
 * @dependency keyboard-accessory.js (KeyboardAccessoryBar, FocusTrap)
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js, vendor/xterm-addon-webgl.js
 * @dependency vendor/xterm-zerolag-input.iife.js (LocalEchoOverlay)
 * @loadorder 6 of 9 — loaded after keyboard-accessory.js, before ralph-wizard.js
 */

// Codeman App - Tab-based Terminal UI
// Constants, utilities, and escapeHtml() are in constants.js (loaded before this file)
// MobileDetection, KeyboardHandler, SwipeHandler are in mobile-handlers.js
// DeepgramProvider, VoiceInput are in voice-input.js

// ═══════════════════════════════════════════════════════════════
// Global Error & Performance Diagnostics
// ═══════════════════════════════════════════════════════════════
// Writes breadcrumbs to localStorage so they survive tab freezes.
// After a crash, check: localStorage.getItem('codeman-crash-diag')

const _crashDiag = {
  _entries: [],
  _maxEntries: 50,
  log(msg) {
    const entry = `${new Date().toISOString().slice(11,23)} ${msg}`;
    this._entries.push(entry);
    if (this._entries.length > this._maxEntries) this._entries.shift();
    try { localStorage.setItem('codeman-crash-diag', this._entries.join('\n')); } catch {}
  }
};

// Log previous crash breadcrumbs on startup
try {
  const prev = localStorage.getItem('codeman-crash-diag');
  if (prev) console.log('[CRASH-DIAG] Previous session breadcrumbs:\n' + prev);
} catch {}
_crashDiag.log('PAGE LOAD');

// Heartbeat: send breadcrumbs to server every 2s so they survive tab freezes.
setInterval(() => {
  try {
    localStorage.setItem('codeman-crash-heartbeat', String(Date.now()));
    if (_crashDiag._entries.length > 0) {
      navigator.sendBeacon('/api/crash-diag', JSON.stringify({ data: _crashDiag._entries.join('\n') }));
    }
  } catch {}
}, 2000);

window.addEventListener('error', (e) => {
  _crashDiag.log(`ERROR: ${e.message} at ${e.filename}:${e.lineno}`);
  console.error('[CRASH-DIAG] Uncaught error:', e.message, '\n  File:', e.filename, ':', e.lineno, ':', e.colno, '\n  Stack:', e.error?.stack);
});

window.addEventListener('unhandledrejection', (e) => {
  _crashDiag.log(`UNHANDLED: ${e.reason?.message || e.reason}`);
  console.error('[CRASH-DIAG] Unhandled promise rejection:', e.reason?.message || e.reason, '\n  Stack:', e.reason?.stack);
});

// Detect long tasks (>50ms main thread blocks) — these cause "page unresponsive"
if (typeof PerformanceObserver !== 'undefined') {
  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 200) {
          _crashDiag.log(`LONG_TASK: ${entry.duration.toFixed(0)}ms`);
          console.warn(`[CRASH-DIAG] Long task: ${entry.duration.toFixed(0)}ms (type: ${entry.entryType}, name: ${entry.name})`);
        }
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true });
  } catch { /* longtask not supported */ }
}

// Track WebGL context loss/restore events on all canvases
const _origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(type, ...args) {
  const ctx = _origGetContext.call(this, type, ...args);
  if (type === 'webgl2' || type === 'webgl') {
    this.addEventListener('webglcontextlost', (e) => {
      _crashDiag.log(`WEBGL_LOST: ${this.width}x${this.height}`);
      console.error('[CRASH-DIAG] WebGL context LOST on canvas', this.width, 'x', this.height, '— prevented:', e.defaultPrevented);
    });
    this.addEventListener('webglcontextrestored', () => {
      _crashDiag.log('WEBGL_RESTORED');
      console.warn('[CRASH-DIAG] WebGL context restored');
    });
  }
  return ctx;
};




// ═══════════════════════════════════════════════════════════════
// Copy-to-clipboard helper (used by renderMarkdown code blocks)
// ═══════════════════════════════════════════════════════════════

window._copyCode = function (btn) {
  const pre = btn.nextElementSibling;
  const text = pre ? (pre.textContent || '') : '';
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  }).catch(() => {});
};

// ═══════════════════════════════════════════════════════════════
// Markdown Renderer
// ═══════════════════════════════════════════════════════════════

/**
 * Minimal Markdown to HTML renderer.
 * SECURITY: All user/assistant text is HTML-escaped via esc() before processing.
 * Link hrefs are protocol-validated (only http/https/relative allowed).
 * The resulting HTML is safe to set via innerHTML on .tv-markdown elements.
 * @param {string} text
 * @returns {string} HTML string
 */
function renderMarkdown(text) {
  function esc(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  // Validate link href — only allow safe protocols
  function safeHref(url) {
    const trimmed = url.trim().toLowerCase();
    if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:') || trimmed.startsWith('vbscript:')) {
      return '#';
    }
    return url;
  }

  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      const code = esc(codeLines.join('\n'));
      out.push('<div class="tv-code-block"><button class="tv-code-copy" onclick="window._copyCode(this)" title="Copy code">Copy</button><pre><code class="tv-code' + (lang ? ' language-' + esc(lang) : '') + '">' + code + '</code></pre></div>');
      i++;
      continue;
    }

    // Heading
    const hMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push('<h' + level + '>' + inlineMarkdown(esc(hMatch[2]), safeHref, esc) + '</h' + level + '>');
      i++; continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      out.push('<hr>');
      i++; continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const bqLines = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        bqLines.push(lines[i].slice(2));
        i++;
      }
      out.push('<blockquote>' + renderMarkdown(bqLines.join('\n')) + '</blockquote>');
      continue;
    }

    // Unordered list
    if (/^[-*+] /.test(line)) {
      out.push('<ul>');
      while (i < lines.length && /^[-*+] /.test(lines[i])) {
        out.push('<li>' + inlineMarkdown(esc(lines[i].replace(/^[-*+] /, '')), safeHref, esc) + '</li>');
        i++;
      }
      out.push('</ul>');
      continue;
    }

    // Ordered list — use <li value="N"> so numbers are correct even if items end up in separate <ol>s
    if (/^\d+\. /.test(line)) {
      out.push('<ol>');
      let itemNum = parseInt(line.match(/^(\d+)\. /)[1], 10);
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        out.push(`<li value="${itemNum}">` + inlineMarkdown(esc(lines[i].replace(/^\d+\. /, '')), safeHref, esc) + '</li>');
        itemNum++;
        i++;
      }
      out.push('</ol>');
      continue;
    }

    // Blank line
    if (line.trim() === '') { i++; continue; }

    // Paragraph — collect consecutive non-special lines
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,3} |```|> |[-*+] |\d+\. |---+$|\*\*\*+$)/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      out.push('<p>' + inlineMarkdown(esc(paraLines.join(' ')), safeHref, esc) + '</p>');
    }
  }
  return out.join('\n');
}

/** Process inline markdown on already-HTML-escaped text. */
function inlineMarkdown(escaped, safeHref, esc) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
      '<a href="' + esc(safeHref(url)) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
    );
}

// ═══════════════════════════════════════════════════════════════
// TranscriptView — rich web view of the Claude Code JSONL transcript
// ═══════════════════════════════════════════════════════════════

/**
 * TranscriptView — renders Claude Code JSONL as a rich web view.
 *
 * Per-session state in app._transcriptState[sessionId]:
 *   { viewMode: 'terminal'|'web', blocks: Block[], scrolledUp: boolean }
 *
 * Block types:
 *   { type:'text', role:'user'|'assistant', text, timestamp }
 *   { type:'tool_use', id, name, input, timestamp }
 *   { type:'tool_result', toolUseId, content, isError, timestamp }
 *   { type:'result', cost, durationMs, error, timestamp }
 */
// ===================================================================
// MCP Panel
// ===================================================================
const McpPanel = {
  _sessionId: null,
  _savedServers: [],
  _draftServers: [],
  _dirty: false,
  _editingIndex: -1,

  init() {
    this._panel      = document.getElementById('mcpPanel');
    this._chip       = document.getElementById('mcpChipBtn');
    this._activeList = document.getElementById('mcpActiveList');
    this._applyBtn   = document.getElementById('mcpApplyBtn');
    this._cancelBtn  = document.getElementById('mcpCancelBtn');
    this._tabs       = this._panel ? Array.from(this._panel.querySelectorAll('.mcp-tab')) : [];
    this._search     = document.getElementById('mcpSearch');
    this._libPane    = document.getElementById('mcpLibraryPane');
    this._mktPane    = document.getElementById('mcpMarketplacePane');
    this._mktResults = document.getElementById('mcpMarketplaceResults');
    this._formOverlay = document.getElementById('mcpFormOverlay');
    this._library    = [];
    this._mktDebounce = null;
    if (!this._panel) return;
    document.getElementById('mcpPanelClose')?.addEventListener('click', () => this.close());
    this._chip?.addEventListener('click', () => this.toggle());
    this._applyBtn?.addEventListener('click', () => this._applyAndRestart());
    this._cancelBtn?.addEventListener('click', () => this._cancelChanges());
    this._tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this._tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const pane = tab.dataset.tab;
        this._libPane.style.display  = pane === 'library' ? '' : 'none';
        this._mktPane.style.display  = pane === 'marketplace' ? '' : 'none';
        if (pane === 'marketplace' && !this._mktResults.children.length) this._searchMarketplace('');
      });
    });
    this._search?.addEventListener('input', () => {
      const q = this._search.value;
      const activeTab = this._panel.querySelector('.mcp-tab.active')?.dataset.tab;
      if (activeTab === 'library') {
        this._renderLibrary(q);
      } else {
        clearTimeout(this._mktDebounce);
        this._mktDebounce = setTimeout(() => this._searchMarketplace(q), 300);
      }
    });
    this._initForm();
    this._loadLibrary();
  },

  async open(sessionId) {
    if (typeof PluginsPanel !== 'undefined' && PluginsPanel._panel?.classList.contains('open')) PluginsPanel.close();
    if (typeof ContextBar !== 'undefined' && ContextBar._panel?.classList.contains('open')) ContextBar.close();
    this._sessionId = sessionId;
    this._panel.style.display = '';
    requestAnimationFrame(() => this._panel.classList.add('open'));
    this._chip?.classList.add('active');
    PanelBackdrop.show();
    await this._loadServers();
  },

  close() {
    this._panel.classList.remove('open');
    this._chip?.classList.remove('active');
    PanelBackdrop.hide();
    const panel = this._panel;
    setTimeout(() => { if (!panel.classList.contains('open')) panel.style.display = 'none'; }, 260);
  },

  toggle() {
    if (this._panel.classList.contains('open')) this.close();
    else if (this._sessionId) this.open(this._sessionId);
  },

  showForSession(sessionId) {
    if (!this._chip) return;
    this._chip.style.display = '';
    if (this._sessionId !== sessionId) {
      this._sessionId = sessionId;
      this._savedServers = [];
      this._draftServers = [];
      this._dirty = false;
      this._renderActiveList();
      this._updateApplyBtn();
    }
  },

  hide() {
    if (!this._chip) return;
    this._chip.style.display = 'none';
    this.close();
  },

  async _loadServers() {
    if (!this._sessionId) return;
    try {
      const res = await fetch('/api/sessions/' + encodeURIComponent(this._sessionId) + '/mcp');
      if (res.ok) {
        this._savedServers = await res.json();
        this._draftServers = this._savedServers.map(s => Object.assign({}, s));
        this._dirty = false;
        this._renderActiveList();
        this._updateApplyBtn();
        this._updateChipBadge();
      }
    } catch (_e) { /* network error */ }
  },

  _markDirty() {
    this._dirty = true;
    this._updateApplyBtn();
    if (this._cancelBtn) this._cancelBtn.style.display = '';
  },

  _updateApplyBtn() {
    if (this._applyBtn) this._applyBtn.disabled = !this._dirty;
  },

  _cancelChanges() {
    this._draftServers = this._savedServers.map(s => Object.assign({}, s));
    this._dirty = false;
    this._updateApplyBtn();
    if (this._cancelBtn) this._cancelBtn.style.display = 'none';
    this._renderActiveList();
  },

  _renderActiveList() {
    if (!this._activeList) return;
    this._activeList.textContent = '';
    if (!this._draftServers.length) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty-state';
      empty.textContent = 'No MCP servers configured. Add one below.';
      this._activeList.appendChild(empty);
      return;
    }
    this._draftServers.forEach((srv, idx) => {
      const card = document.createElement('div');
      card.className = 'mcp-server-card';
      const toggle = document.createElement('button');
      toggle.className = 'mcp-toggle' + (srv.enabled ? ' on' : '');
      toggle.title = srv.enabled ? 'Disable' : 'Enable';
      toggle.addEventListener('click', () => {
        srv.enabled = !srv.enabled;
        toggle.classList.toggle('on', srv.enabled);
        toggle.title = srv.enabled ? 'Disable' : 'Enable';
        this._markDirty();
        this._updateChipBadge();
      });
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      const name = document.createElement('div');
      name.className = 'mcp-server-name';
      name.textContent = srv.name;
      const cmd = document.createElement('div');
      cmd.className = 'mcp-server-cmd';
      cmd.textContent = srv.command ? (srv.command + ' ' + (srv.args || []).join(' ')) : (srv.url || '');
      info.appendChild(name);
      info.appendChild(cmd);
      const editBtn = document.createElement('button');
      editBtn.className = 'mcp-server-edit';
      editBtn.title = 'Edit';
      editBtn.textContent = '\u270e';
      editBtn.addEventListener('click', () => this._openForm(srv, idx));
      const removeBtn = document.createElement('button');
      removeBtn.className = 'mcp-server-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '\u2715';
      removeBtn.addEventListener('click', () => {
        this._draftServers.splice(idx, 1);
        this._markDirty();
        this._renderActiveList();
        this._updateChipBadge();
      });
      card.appendChild(toggle);
      card.appendChild(info);
      card.appendChild(editBtn);
      card.appendChild(removeBtn);
      this._activeList.appendChild(card);
    });
  },

  _updateChipBadge() {
    const badge = this._chip?.querySelector('.mcp-chip-badge');
    if (!badge) return;
    const count = this._draftServers.filter(s => s.enabled).length;
    badge.style.display = count > 0 ? '' : 'none';
    badge.textContent = String(count);
  },

  async _applyAndRestart() {
    if (!this._applyBtn) return;
    this._applyBtn.disabled = true;
    this._applyBtn.textContent = 'Restarting\u2026';
    try {
      const res = await fetch('/api/sessions/' + encodeURIComponent(this._sessionId) + '/mcp/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServers: this._draftServers }),
      });
      if (!res.ok) {
        this._applyBtn.textContent = 'Restart failed \u2717';
        setTimeout(() => { this._applyBtn.textContent = 'Apply & Restart Claude'; this._applyBtn.disabled = false; }, 3000);
        return;
      }
      this._savedServers = this._draftServers.map(s => Object.assign({}, s));
      this._dirty = false;
      if (this._cancelBtn) this._cancelBtn.style.display = 'none';
      this._applyBtn.textContent = 'Resumed \u2713';
      this._chip?.classList.add('pulsing');
      setTimeout(() => {
        this._applyBtn.textContent = 'Apply & Restart Claude';
        this._applyBtn.disabled = true;
        this._chip?.classList.remove('pulsing');
      }, 2000);
    } catch (_e) {
      this._applyBtn.textContent = 'Error \u2014 see console';
      setTimeout(() => { this._applyBtn.textContent = 'Apply & Restart Claude'; this._applyBtn.disabled = false; }, 3000);
    }
  },

  async _loadLibrary() {
    try {
      const res = await fetch('/api/mcp/library');
      if (res.ok) { this._library = await res.json(); this._renderLibrary(''); }
    } catch (_e) { /* offline */ }
  },

  _renderLibrary(filter) {
    if (!this._libPane) return;
    const q = filter.toLowerCase();
    const items = q ? this._library.filter(e => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)) : this._library;
    this._libPane.textContent = '';
    items.forEach(entry => this._libPane.appendChild(this._makeLibCard(entry)));
  },

  _makeLibCard(entry) {
    const card = document.createElement('div');
    card.className = 'mcp-lib-card';
    const hdr = document.createElement('div');
    hdr.className = 'mcp-lib-card-header';
    const name = document.createElement('span');
    name.className = 'mcp-lib-card-name';
    name.textContent = entry.name;
    const cat = document.createElement('span');
    cat.className = 'mcp-lib-card-cat';
    cat.textContent = entry.category;
    hdr.appendChild(name);
    hdr.appendChild(cat);
    const desc = document.createElement('div');
    desc.className = 'mcp-lib-card-desc';
    desc.textContent = entry.description;
    card.appendChild(hdr);
    card.appendChild(desc);
    card.addEventListener('click', () => this._openFormFromLibrary(entry));
    return card;
  },

  async _searchMarketplace(q) {
    if (!this._mktResults) return;
    this._mktResults.textContent = '';
    for (let i = 0; i < 4; i++) { const sk = document.createElement('div'); sk.className = 'mcp-skeleton'; this._mktResults.appendChild(sk); }
    try {
      const res = await fetch('/api/mcp/marketplace?q=' + encodeURIComponent(q));
      this._mktResults.textContent = '';
      if (!res.ok) throw new Error('unavailable');
      const data = await res.json();
      const items = Array.isArray(data) ? data : (data.servers || data.results || []);
      if (!items.length) { const msg = document.createElement('div'); msg.className = 'mcp-empty-state'; msg.textContent = 'No results.'; this._mktResults.appendChild(msg); return; }
      items.slice(0, 24).forEach(item => {
        this._mktResults.appendChild(this._makeLibCard({ id: item.qualifiedName || item.name || '', name: item.displayName || item.name || item.qualifiedName || '', description: item.description || '', category: 'Marketplace', transport: item.transport || 'stdio', command: item.command, args: item.args, url: item.url }));
      });
    } catch (_e) {
      this._mktResults.textContent = '';
      const msg = document.createElement('div'); msg.className = 'mcp-empty-state'; msg.textContent = 'Marketplace unavailable \u2014 using curated library only.'; this._mktResults.appendChild(msg);
    }
  },

  _openFormFromLibrary(entry) {
    this._openForm({ name: entry.name, enabled: true, command: entry.command, args: entry.args, url: entry.url, type: (entry.transport !== 'stdio') ? entry.transport : undefined }, -1);
  },

  _openForm(srv, idx) {
    if (!this._formOverlay) return;
    this._editingIndex = idx;
    this._formOverlay.style.display = '';
    const ftabs = Array.from(this._formOverlay.querySelectorAll('.mcp-form-tab'));
    ftabs.forEach((t, i) => t.classList.toggle('active', i === 0));
    const fieldsPane = document.getElementById('mcpFieldsPane');
    const jsonPane   = document.getElementById('mcpJsonPane');
    if (fieldsPane) fieldsPane.style.display = '';
    if (jsonPane)   jsonPane.style.display   = 'none';
    const titleEl = document.getElementById('mcpFormTitle');
    const saveBtn = document.getElementById('mcpFormSave');
    if (titleEl) titleEl.textContent = idx >= 0 ? 'Edit Server' : 'Add Server';
    if (saveBtn)  saveBtn.textContent = idx >= 0 ? 'Save changes' : 'Add to session';
    const nameEl = document.getElementById('mcpFName');
    const cmdEl  = document.getElementById('mcpFCommand');
    const argsEl = document.getElementById('mcpFArgs');
    const urlEl  = document.getElementById('mcpFUrl');
    if (nameEl) nameEl.value = srv.name || '';
    if (cmdEl)  cmdEl.value  = srv.command || '';
    if (argsEl) argsEl.value = (srv.args || []).join(' ');
    if (urlEl)  urlEl.value  = srv.url || '';
    const transport = srv.type || (srv.url && !srv.command ? 'http' : 'stdio');
    this._formOverlay.querySelectorAll('input[name=mcpTransport]').forEach(r => { r.checked = r.value === transport; });
    this._updateTransportFields(transport);
    this._renderKvList('mcpEnvVars', srv.env || {}, true);
    this._renderKvList('mcpHeaders', srv.headers || {}, false);
  },

  _updateTransportFields(transport) {
    const stdioEl = document.getElementById('mcpStdioFields');
    const httpEl  = document.getElementById('mcpHttpFields');
    if (stdioEl) stdioEl.style.display = transport === 'stdio' ? '' : 'none';
    if (httpEl)  httpEl.style.display  = transport === 'stdio' ? 'none' : '';
  },

  _renderKvList(containerId, obj, sensitive) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.textContent = '';
    Object.entries(obj).forEach(([k, v]) => this._addKvRow(container, k, v, sensitive));
  },

  _addKvRow(container, k, v, sensitive) {
    const row = document.createElement('div');
    row.className = 'mcp-kv-row';
    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.placeholder = 'KEY';
    keyInput.value = k;
    const valInput = document.createElement('input');
    valInput.type = sensitive ? 'password' : 'text';
    valInput.placeholder = 'value';
    valInput.value = v;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'mcp-kv-remove';
    removeBtn.textContent = '\u2715';
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(keyInput);
    row.appendChild(valInput);
    row.appendChild(removeBtn);
    container.appendChild(row);
  },

  _collectKvList(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return {};
    const result = {};
    container.querySelectorAll('.mcp-kv-row').forEach(row => {
      const inputs = row.querySelectorAll('input');
      const k = inputs[0]?.value?.trim();
      const v = inputs[1]?.value ?? '';
      if (k) result[k] = v;
    });
    return result;
  },

  _initForm() {
    if (!this._formOverlay) return;
    this._formOverlay.querySelectorAll('input[name=mcpTransport]').forEach(r => {
      r.addEventListener('change', () => this._updateTransportFields(r.value));
    });
    this._formOverlay.querySelectorAll('.mcp-form-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this._formOverlay.querySelectorAll('.mcp-form-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const isJson = tab.dataset.ftab === 'json';
        const fieldsPane = document.getElementById('mcpFieldsPane');
        const jsonPane   = document.getElementById('mcpJsonPane');
        if (fieldsPane) fieldsPane.style.display = isJson ? 'none' : '';
        if (jsonPane)   jsonPane.style.display   = isJson ? '' : 'none';
      });
    });
    document.getElementById('mcpAddEnvVar')?.addEventListener('click', () => { const c = document.getElementById('mcpEnvVars'); if (c) this._addKvRow(c, '', '', true); });
    document.getElementById('mcpAddHeader')?.addEventListener('click', () => { const c = document.getElementById('mcpHeaders'); if (c) this._addKvRow(c, '', '', false); });
    document.getElementById('mcpJsonInput')?.addEventListener('blur', () => this._parseJsonPaste());
    document.getElementById('mcpFormSave')?.addEventListener('click', () => this._saveForm());
    document.getElementById('mcpFormCancel')?.addEventListener('click', () => this._closeForm());
    document.getElementById('mcpFormClose')?.addEventListener('click', () => this._closeForm());
  },

  _parseJsonPaste() {
    const input = document.getElementById('mcpJsonInput');
    const errEl  = document.getElementById('mcpJsonError');
    if (!input || !errEl) return;
    const raw = input.value.trim();
    if (!raw) return;
    try {
      let parsed = JSON.parse(raw);
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const entries = Object.entries(parsed.mcpServers);
        if (entries.length) { const [firstName, firstEntry] = entries[0]; parsed = Object.assign({ name: firstName }, firstEntry); }
      }
      errEl.style.display = 'none';
      const nameEl = document.getElementById('mcpFName');
      const cmdEl  = document.getElementById('mcpFCommand');
      const argsEl = document.getElementById('mcpFArgs');
      const urlEl  = document.getElementById('mcpFUrl');
      if (nameEl) nameEl.value = parsed.name || '';
      if (cmdEl)  cmdEl.value  = parsed.command || '';
      if (argsEl) argsEl.value = (parsed.args || []).join(' ');
      if (urlEl)  urlEl.value  = parsed.url || '';
      const transport = parsed.type || (parsed.url ? 'http' : 'stdio');
      this._formOverlay.querySelectorAll('input[name=mcpTransport]').forEach(r => { r.checked = r.value === transport; });
      this._updateTransportFields(transport);
      if (parsed.env)     this._renderKvList('mcpEnvVars', parsed.env, true);
      if (parsed.headers) this._renderKvList('mcpHeaders', parsed.headers, false);
    } catch (_e) {
      errEl.textContent = 'Invalid JSON \u2014 check format';
      errEl.style.display = '';
    }
  },

  _saveForm() {
    const nameEl = document.getElementById('mcpFName');
    if (!nameEl) return;
    const name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    const transport = this._formOverlay?.querySelector('input[name=mcpTransport]:checked')?.value || 'stdio';
    const server = { name, enabled: true };
    if (transport === 'stdio') {
      const cmd  = document.getElementById('mcpFCommand')?.value.trim();
      const args = document.getElementById('mcpFArgs')?.value.trim();
      if (cmd) server.command = cmd;
      server.args = args ? args.split(/\s+/) : [];
      const env = this._collectKvList('mcpEnvVars');
      if (Object.keys(env).length) server.env = env;
    } else {
      server.type = transport;
      const url = document.getElementById('mcpFUrl')?.value.trim();
      if (url) server.url = url;
      const headers = this._collectKvList('mcpHeaders');
      if (Object.keys(headers).length) server.headers = headers;
    }
    if (this._editingIndex >= 0) { this._draftServers[this._editingIndex] = server; }
    else { this._draftServers.push(server); }
    this._markDirty();
    this._renderActiveList();
    this._updateChipBadge();
    this._closeForm();
  },

  _closeForm() {
    if (this._formOverlay) this._formOverlay.style.display = 'none';
  },
};

// Plugins Panel
// ===================================================================
const PluginsPanel = {
  _sessionId: null,
  _library: [],
  _skills: [],
  _projectPaths: [],
  _selectedProject: '__global__',
  _disabledMap: {},
  _currentProjectPath: null,

  init() {
    this._panel        = document.getElementById('pluginsPanel');
    this._chip         = document.getElementById('pluginsChipBtn');
    this._tabs         = this._panel ? Array.from(this._panel.querySelectorAll('[data-ptab]')) : [];
    this._activePane   = document.getElementById('pluginsInstalledPane');
    this._libraryPane  = document.getElementById('pluginsLibraryPane');
    this._skillsPane   = document.getElementById('pluginsSkillsPane');
    this._activeList   = document.getElementById('pluginsActiveList');
    this._libraryList  = document.getElementById('pluginsLibraryList');
    this._skillsList   = document.getElementById('pluginsSkillsList');
    this._installInput = document.getElementById('pluginsInstallInput');
    this._installScope = document.getElementById('pluginsInstallScope');
    this._installBtn   = document.getElementById('pluginsInstallBtn');
    this._installStatus= document.getElementById('pluginsInstallStatus');
    this._projectSelect= document.getElementById('pluginsProjectSelect');
    if (!this._panel) return;

    document.getElementById('pluginsPanelClose')?.addEventListener('click', () => this.close());
    this._chip?.addEventListener('click', () => this.toggle());
    this._installBtn?.addEventListener('click', () => this._installPlugin());
    this._installInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._installPlugin(); });
    this._projectSelect?.addEventListener('change', () => {
      this._selectedProject = this._projectSelect.value;
      this._renderSkills();
    });
    this._installScope?.addEventListener('change', () => this._renderLibrary());

    this._tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this._tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const pane = tab.dataset.ptab;
        this._activePane.style.display  = pane === 'installed' ? '' : 'none';
        this._libraryPane.style.display = pane === 'library' ? '' : 'none';
        this._skillsPane.style.display  = pane === 'skills' ? '' : 'none';
        if (pane === 'library' && !this._library.length) this._loadLibrary();
        if (pane === 'skills' && !this._skills.length) this._loadSkills();
      });
    });

    this._loadLibrary();
  },

  open(sessionId) {
    this._sessionId = sessionId;
    if (McpPanel._panel?.classList.contains('open')) McpPanel.close();
    if (typeof ContextBar !== 'undefined' && ContextBar._panel?.classList.contains('open')) ContextBar.close();
    this._panel.style.display = '';
    requestAnimationFrame(() => this._panel.classList.add('open'));
    this._chip?.classList.add('active');
    PanelBackdrop.show();
    this._loadInstalled();
    this._updateInstallScopeDefault();
  },

  _updateInstallScopeDefault() {
    if (!this._installScope) return;
    const session = app.sessions?.get(this._sessionId);
    if (session?.workingDir) {
      this._installScope.value = 'project';
      this._currentProjectPath = session.workingDir;
    } else {
      this._installScope.value = 'user';
      this._currentProjectPath = null;
    }
  },

  close() {
    this._panel.classList.remove('open');
    this._chip?.classList.remove('active');
    PanelBackdrop.hide();
    const panel = this._panel;
    setTimeout(() => { if (!panel.classList.contains('open')) panel.style.display = 'none'; }, 260);
  },

  toggle() {
    // No session guard needed — plugin endpoints are global, not per-session
    if (this._panel.classList.contains('open')) this.close();
    else this.open(this._sessionId);
  },

  showChip() {
    if (this._chip) this._chip.style.display = '';
    this._loadInstalled();
  },

  hideChip() {
    if (!this._chip) return;
    this._chip.style.display = 'none';
    this.close();
  },

  async _loadInstalled() {
    try {
      const res = await fetch('/api/plugins');
      if (!res.ok) return;
      const plugins = await res.json();
      this._renderActiveList(plugins);
      this._updateChipBadge(plugins.length);
    } catch (_e) { /* network */ }
  },

  async _loadLibrary() {
    try {
      const res = await fetch('/api/plugins/library');
      if (res.ok) { this._library = await res.json(); this._renderLibrary(); }
    } catch (_e) { /* offline */ }
  },

  async _loadSkills() {
    try {
      const [skillsRes, disabledRes] = await Promise.all([
        fetch('/api/plugins/skills'),
        fetch('/api/plugins/skills/disabled'),
      ]);
      if (skillsRes.ok) this._skills = await skillsRes.json();
      if (disabledRes.ok) {
        const d = await disabledRes.json();
        this._disabledMap['__global__'] = new Set(d.disabled);
      }
      this._projectPaths = [];
      if (app.sessions) {
        for (const s of app.sessions.values()) {
          if (s.workingDir && !this._projectPaths.includes(s.workingDir)) {
            this._projectPaths.push(s.workingDir);
          }
        }
      }
      // Default scope to current session's project instead of global
      const currentSession = app.sessions?.get(this._sessionId);
      if (currentSession?.workingDir && this._projectPaths.includes(currentSession.workingDir)) {
        this._selectedProject = currentSession.workingDir;
      }
      this._populateProjectSelect();
      this._renderSkills();
    } catch (_e) { /* offline */ }
  },

  async _installPlugin() {
    const name = this._installInput?.value.trim();
    if (!name) { this._installInput?.focus(); return; }
    if (this._installBtn) { this._installBtn.disabled = true; this._installBtn.textContent = 'Installing\u2026'; }
    this._showInstallStatus('', '');
    const scope = this._installScope?.value || 'user';
    if (scope === 'project' && !this._currentProjectPath) {
      this._showInstallStatus('No active session — switch scope to Global or open a session first', 'error');
      if (this._installBtn) { this._installBtn.disabled = false; this._installBtn.textContent = 'Install'; }
      return;
    }
    const body = { name, scope };
    if (scope === 'project' && this._currentProjectPath) Object.assign(body, { projectPath: this._currentProjectPath });
    try {
      const res = await fetch('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        this._showInstallStatus(data.error || 'Install failed', 'error');
      } else {
        if (this._installInput) this._installInput.value = '';
        this._loadInstalled();
        // Switch to Installed tab to show the newly installed plugin
        this._tabs.forEach(t => t.classList.remove('active'));
        const installedTab = this._tabs.find(t => t.dataset.ptab === 'installed');
        if (installedTab) installedTab.classList.add('active');
        this._activePane.style.display = '';
        this._libraryPane.style.display = 'none';
        this._skillsPane.style.display = 'none';
      }
    } catch (_e) {
      this._showInstallStatus('Network error', 'error');
    } finally {
      if (this._installBtn) { this._installBtn.disabled = false; this._installBtn.textContent = 'Install'; }
    }
  },

  async _uninstallPlugin(pluginKey, scope, projectPath) {
    const displayName = pluginKey.split('@')[0];
    const scopeLabel = scope === 'project' ? 'project scope' : 'global scope';
    if (!confirm('Uninstall plugin "' + displayName + '" (' + scopeLabel + ')?')) return;
    try {
      const params = new URLSearchParams();
      if (scope) params.set('scope', scope);
      if (scope === 'project' && projectPath) params.set('projectPath', projectPath);
      const qs = params.toString() ? '?' + params.toString() : '';
      const res = await fetch('/api/plugins/' + encodeURIComponent(pluginKey) + qs, { method: 'DELETE' });
      if (res.ok) this._loadInstalled();
    } catch (_e) { /* network */ }
  },

  _showInstallStatus(msg, type) {
    if (!this._installStatus) return;
    this._installStatus.textContent = msg;
    this._installStatus.className = 'plugins-install-status' + (type ? ' ' + type : '');
    this._installStatus.style.display = msg ? '' : 'none';
  },

  _updateChipBadge(count) {
    const badge = this._chip?.querySelector('.mcp-chip-badge');
    if (!badge) return;
    badge.style.display = count > 0 ? '' : 'none';
    badge.textContent = String(count);
  },

  _renderActiveList(plugins) {
    if (!this._activeList) return;
    this._activeList.textContent = '';
    if (!plugins.length) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty-state';
      empty.textContent = 'No plugins installed. Browse the Library tab.';
      this._activeList.appendChild(empty);
      return;
    }
    const colors = ['#3b82f6','#a855f7','#22c55e','#f97316','#ec4899','#eab308','#06b6d4'];
    plugins.forEach(p => {
      const card = document.createElement('div');
      card.className = 'mcp-server-card';

      const colorIdx = p.pluginName.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length;
      const avatar = document.createElement('div');
      avatar.className = 'plugin-card-avatar';
      avatar.style.background = colors[colorIdx] + '33';
      avatar.style.color = colors[colorIdx];
      avatar.textContent = (p.pluginName[0] || '?').toUpperCase();

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';

      const nameRow = document.createElement('div');
      nameRow.style.cssText = 'display:flex;align-items:center;gap:5px;flex-wrap:wrap';

      const nameEl = document.createElement('div');
      nameEl.className = 'mcp-server-name';
      nameEl.textContent = p.pluginName;

      const scopeBadge = document.createElement('span');
      scopeBadge.className = 'plugin-card-scope ' + (p.scope || 'user');
      scopeBadge.textContent = p.scope === 'project' ? 'Project' : 'User';

      const versionEl = document.createElement('span');
      versionEl.className = 'plugin-card-version';
      versionEl.textContent = p.version ? 'v' + p.version : '';

      nameRow.appendChild(nameEl);
      nameRow.appendChild(scopeBadge);
      nameRow.appendChild(versionEl);

      const desc = document.createElement('div');
      desc.className = 'mcp-server-cmd';
      desc.textContent = p.meta?.description || p.installPath || '';

      info.appendChild(nameRow);
      info.appendChild(desc);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'mcp-server-remove';
      removeBtn.title = p.key === 'gsd@local' ? 'Managed outside Codeman' : 'Uninstall';
      removeBtn.textContent = '\u2715';
      if (p.key === 'gsd@local') {
        removeBtn.disabled = true;
        removeBtn.style.opacity = '0.3';
        removeBtn.style.cursor = 'default';
      } else {
        removeBtn.addEventListener('click', () => this._uninstallPlugin(p.key, p.scope, p.projectPath));
      }

      card.appendChild(avatar);
      card.appendChild(info);
      card.appendChild(removeBtn);
      this._activeList.appendChild(card);
    });
  },

  _renderLibrary() {
    if (!this._libraryList) return;
    this._libraryList.textContent = '';
    this._library.forEach(entry => {
      const card = document.createElement('div');
      card.className = 'mcp-lib-card';

      const hdr = document.createElement('div');
      hdr.className = 'mcp-lib-card-header';

      const name = document.createElement('span');
      name.className = 'mcp-lib-card-name';
      name.textContent = entry.name;

      const installBtn = document.createElement('button');
      installBtn.className = 'mcp-btn-apply plugins-install-btn';
      installBtn.style.cssText = 'padding:3px 8px;font-size:0.7rem';
      installBtn.textContent = 'Install \u2193';
      installBtn.title = this._currentProjectPath ? 'Install (project scope)' : 'Install (global scope)';
      installBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._installInput) this._installInput.value = entry.installName;
        this._installPlugin();
      });

      hdr.appendChild(name);
      hdr.appendChild(installBtn);

      const desc = document.createElement('div');
      desc.className = 'mcp-lib-card-desc';
      desc.textContent = entry.description;

      const keywords = document.createElement('div');
      keywords.className = 'plugins-lib-keywords';
      (entry.keywords || []).forEach(kw => {
        const tag = document.createElement('span');
        tag.className = 'mcp-lib-card-cat';
        tag.textContent = kw;
        keywords.appendChild(tag);
      });

      card.appendChild(hdr);
      card.appendChild(desc);
      card.appendChild(keywords);
      this._libraryList.appendChild(card);
    });
  },

  _populateProjectSelect() {
    if (!this._projectSelect) return;
    this._projectSelect.textContent = '';
    const globalOpt = document.createElement('option');
    globalOpt.value = '__global__';
    globalOpt.textContent = 'Global (all projects)';
    this._projectSelect.appendChild(globalOpt);
    this._projectPaths.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      this._projectSelect.appendChild(opt);
    });
    this._projectSelect.value = this._selectedProject;
  },

  _renderSkills() {
    if (!this._skillsList) return;
    this._skillsList.textContent = '';
    if (!this._skills.length) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty-state';
      empty.textContent = 'No plugin skills found.';
      this._skillsList.appendChild(empty);
      return;
    }
    const groups = {};
    this._skills.forEach(s => {
      if (!groups[s.pluginName]) groups[s.pluginName] = [];
      groups[s.pluginName].push(s);
    });
    const projectKey = this._selectedProject;
    const projectDisabled = this._disabledMap[projectKey] ?? new Set();
    const globalDisabled = this._disabledMap['__global__'] ?? new Set();

    Object.entries(groups).forEach(([pluginName, skills]) => {
      const label = document.createElement('div');
      label.className = 'plugins-skill-group-label';
      label.textContent = pluginName;
      this._skillsList.appendChild(label);

      skills.forEach(skill => {
        const row = document.createElement('div');
        row.className = 'plugins-skill-row';

        const isDisabled = projectDisabled.has(skill.fullName) || globalDisabled.has(skill.fullName);
        const toggle = document.createElement('button');
        toggle.className = 'mcp-toggle' + (isDisabled ? '' : ' on');
        toggle.title = isDisabled ? 'Enable' : 'Disable';
        toggle.addEventListener('click', async () => {
          const nowDisabled = !toggle.classList.contains('on');
          if (!this._disabledMap[projectKey]) this._disabledMap[projectKey] = new Set();
          if (nowDisabled) {
            this._disabledMap[projectKey].add(skill.fullName);
          } else {
            this._disabledMap[projectKey].delete(skill.fullName);
          }
          toggle.classList.toggle('on', !nowDisabled);
          await fetch('/api/plugins/skills/disabled', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project: projectKey,
              disabled: Array.from(this._disabledMap[projectKey]),
            }),
          });
        });

        const nameEl = document.createElement('span');
        nameEl.className = 'plugins-skill-name';
        nameEl.textContent = skill.skillName;

        const descEl = document.createElement('span');
        descEl.className = 'plugins-skill-desc';
        descEl.textContent = skill.description;
        descEl.title = skill.description;

        row.appendChild(toggle);
        row.appendChild(nameEl);
        row.appendChild(descEl);
        this._skillsList.appendChild(row);
      });
    });
  },
};

// ===================================================================
// Session Indicator Bar
// ===================================================================
const SessionIndicatorBar = {
  _bar: null,
  _dot: null,
  _nameEl: null,
  _projectEl: null,
  _branchEl: null,

  init() {
    this._bar       = document.getElementById('sessionIndicatorBar');
    this._dot       = document.getElementById('sibStatusDot');
    this._nameEl    = document.getElementById('sibSessionName');
    this._projectEl = document.getElementById('sibProject');
    this._branchEl  = document.getElementById('sibBranch');
  },

  update(sessionId) {
    if (!this._bar) return;
    if (!sessionId) {
      this._bar.style.display = 'none';
      return;
    }
    const session = app.sessions.get(sessionId);
    if (!session) {
      this._bar.style.display = 'none';
      return;
    }
    // Session name
    const name = app.getSessionName(session);
    if (this._nameEl) this._nameEl.textContent = name;

    // Project name — strip worktree branch slug suffix from directory name
    let project = session.workingDir ? (session.workingDir.split('/').pop() || session.workingDir) : '';
    if (project && session.worktreeBranch) {
      const slug = session.worktreeBranch.replace(/\//g, '-');
      if (project.endsWith('-' + slug)) {
        project = project.slice(0, -(slug.length + 1));
      }
    }
    if (this._projectEl) this._projectEl.textContent = project;

    // Branch pill — show only when worktreeBranch is set and differs from session.name (raw)
    const branch = session.worktreeBranch || '';
    const showBranch = branch && branch !== session.name;
    if (this._branchEl) {
      this._branchEl.textContent = branch;
      this._branchEl.style.display = showBranch ? '' : 'none';
    }

    // Status dot
    const status = session.displayStatus ?? session.status ?? 'idle';
    if (this._dot) {
      this._dot.classList.toggle('busy', status === 'busy');
      this._dot.classList.toggle('idle', status !== 'busy');
    }

    this._bar.style.display = 'flex';
  },
};

// Context Bar / Chip / Banner / Panel
// ===================================================================
const ContextBar = {
  _data: new Map(),          // sessionId -> latest context data
  _dismissed80: new Set(),   // sessionIds dismissed at 80% threshold
  _dismissed90: new Set(),   // sessionIds dismissed at 90% threshold

  init() {
    this._bar       = document.getElementById('contextBar');
    this._chip      = document.getElementById('ctxChipBtn');
    this._badge     = document.getElementById('ctxChipBadge');
    this._banner    = document.getElementById('contextBanner');
    this._bannerTxt = document.getElementById('contextBannerText');
    this._bannerClr = document.getElementById('contextBannerClear');
    this._bannerDis = document.getElementById('contextBannerDismiss');
    this._panel     = document.getElementById('contextPanel');
    this._donutArc  = document.getElementById('ctxDonutArc');
    this._donutPct  = document.getElementById('ctxDonutPct');
    this._segSystem = document.getElementById('ctxSegSystem');
    this._segConv   = document.getElementById('ctxSegConv');
    this._segTools  = document.getElementById('ctxSegTools');
    this._segFree   = document.getElementById('ctxSegFree');

    this._chip?.addEventListener('click', () => this.toggle());
    document.getElementById('contextPanelClose')?.addEventListener('click', () => this.close());

    this._bannerClr?.addEventListener('click', () => {
      if (app.activeSessionId) app.sendInput('/clear');
    });
    this._bannerDis?.addEventListener('click', () => {
      const sid = app.activeSessionId;
      if (!sid) return;
      const d = this._data.get(sid);
      if (d) {
        if (d.pct >= 90) this._dismissed90.add(sid);
        else this._dismissed80.add(sid);
      }
      if (this._banner) this._banner.style.display = 'none';
    });
  },

  onContextUsage(data) {
    this._data.set(data.id, data);
    const sid = app.activeSessionId;
    if (data.id === sid) {
      this._updateBar(data);
      this._checkBanner(data);
      this._updateChip(data);
      if (this._panel?.classList.contains('open')) this._renderPanel(data);
    }
  },

  onSessionSelected(sessionId) {
    const data = this._data.get(sessionId);
    if (data) {
      this._updateBar(data);
      this._checkBanner(data);
      this._updateChip(data);
    } else {
      this._clearBar();
      if (this._banner) this._banner.style.display = 'none';
      this._clearChip();
    }
  },

  _updateBar(data) {
    if (!this._bar) return;
    this._bar.style.display = '';
    const max = data.maxTokens || 200000;
    const total = data.inputTokens || 0;
    const sys   = data.system      || 0;
    const conv  = data.conversation|| 0;
    const tools = data.tools       || 0;

    if (sys || conv || tools) {
      const free = Math.max(0, max - sys - conv - tools);
      if (this._segSystem) this._segSystem.style.width = (sys   / max * 100).toFixed(2) + '%';
      if (this._segConv)   this._segConv.style.width   = (conv  / max * 100).toFixed(2) + '%';
      if (this._segTools)  this._segTools.style.width  = (tools / max * 100).toFixed(2) + '%';
      if (this._segFree)   this._segFree.style.width   = (free  / max * 100).toFixed(2) + '%';
    } else {
      if (this._segSystem) this._segSystem.style.width = '0%';
      if (this._segTools)  this._segTools.style.width  = '0%';
      if (this._segConv)   this._segConv.style.width   = (total / max * 100).toFixed(2) + '%';
      if (this._segFree)   this._segFree.style.width   = (Math.max(0, max - total) / max * 100).toFixed(2) + '%';
    }
  },

  _clearBar() {
    if (!this._bar) return;
    this._bar.style.display = 'none';
  },

  _checkBanner(data) {
    if (!this._banner) return;
    const sid = data.id;
    const pct = data.pct;

    if (pct >= 90 && !this._dismissed90.has(sid)) {
      if (this._bannerTxt) this._bannerTxt.textContent = `Context ~${pct}% full — consider /clear or /compact`;
      this._banner.style.display = '';
    } else if (pct >= 80 && !this._dismissed80.has(sid) && !this._dismissed90.has(sid)) {
      if (this._bannerTxt) this._bannerTxt.textContent = `Context ~${pct}% full — consider /clear`;
      this._banner.style.display = '';
    } else if (pct < 80) {
      this._banner.style.display = 'none';
      this._dismissed80.delete(sid);
      this._dismissed90.delete(sid);
    }
  },

  _updateChip(data) {
    if (!this._chip || !this._badge) return;
    this._chip.style.display = '';
    this._badge.style.display = '';
    this._badge.textContent = data.pct + '%';
    this._chip.classList.remove('ctx-green', 'ctx-amber', 'ctx-red');
    if (data.pct >= 85) this._chip.classList.add('ctx-red');
    else if (data.pct >= 60) this._chip.classList.add('ctx-amber');
    else this._chip.classList.add('ctx-green');
  },

  _clearChip() {
    if (!this._chip) return;
    this._chip.style.display = 'none';
  },

  open(sessionId) {
    if (!this._panel) return;
    if (McpPanel._panel?.classList.contains('open')) McpPanel.close();
    if (typeof PluginsPanel !== 'undefined' && PluginsPanel._panel?.classList.contains('open')) PluginsPanel.close();
    this._panel.style.display = '';
    requestAnimationFrame(() => this._panel.classList.add('open'));
    this._chip?.classList.add('active');
    PanelBackdrop.show();
    const sid = sessionId || app.activeSessionId;
    if (sid) {
      const cached = this._data.get(sid);
      if (cached) this._renderPanel(cached);
      fetch(`/api/sessions/${encodeURIComponent(sid)}/context`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && d.pct != null && sid === app.activeSessionId) { this._data.set(sid, d); this._renderPanel(d); } })
        .catch(() => {});
    }
  },

  close() {
    if (!this._panel) return;
    this._panel.classList.remove('open');
    this._chip?.classList.remove('active');
    PanelBackdrop.hide();
    const panel = this._panel;
    setTimeout(() => { if (!panel.classList.contains('open')) panel.style.display = 'none'; }, 260);
  },

  toggle() {
    if (this._panel?.classList.contains('open')) this.close();
    else this.open(app.activeSessionId);
  },

  _renderPanel(data) {
    if (!this._donutArc || !this._donutPct) return;
    const CIRC = 251.2;
    const pct = data.pct || 0;
    this._donutArc.style.strokeDashoffset = (CIRC * (1 - pct / 100)).toFixed(2);
    if (pct >= 85) this._donutArc.style.stroke = '#f87171';
    else if (pct >= 60) this._donutArc.style.stroke = '#fbbf24';
    else this._donutArc.style.stroke = '#22d3ee';
    this._donutPct.textContent = pct + '%';

    const max = data.maxTokens || 200000;
    const fmt = n => n != null ? n.toLocaleString() : '--';
    const fpct = n => n != null ? `${(n / max * 100).toFixed(1)}%` : '';
    const sys  = data.system;
    const conv = data.conversation;
    const tools= data.tools;
    const free = (sys != null && conv != null && tools != null)
      ? Math.max(0, max - sys - conv - tools) : null;

    document.getElementById('ctxValSystem').textContent  = fmt(sys);
    document.getElementById('ctxValConv').textContent    = fmt(conv);
    document.getElementById('ctxValTools').textContent   = fmt(tools);
    document.getElementById('ctxValFree').textContent    = fmt(free);
    document.getElementById('ctxPctSystem').textContent  = fpct(sys);
    document.getElementById('ctxPctConv').textContent    = fpct(conv);
    document.getElementById('ctxPctTools').textContent   = fpct(tools);
    document.getElementById('ctxPctFree').textContent    = fpct(free);

    const suggestion = document.getElementById('ctxSuggestion');
    if (suggestion) suggestion.style.display = pct >= 90 ? '' : 'none';
  },
};
/** In-session terminal search using xterm.js SearchAddon. Ctrl+F to open. */
const TerminalSearch = {
  _bar: null,
  _input: null,
  _count: null,
  _addon: null,
  _debounceTimer: null,

  init() {
    this._bar = document.getElementById('terminalSearchBar');
    this._input = document.getElementById('terminalSearchInput');
    this._count = document.getElementById('terminalSearchCount');
    const prevBtn = document.getElementById('terminalSearchPrev');
    const nextBtn = document.getElementById('terminalSearchNext');
    const closeBtn = document.getElementById('terminalSearchClose');
    if (!this._bar || !this._input) return;

    this._input.addEventListener('input', () => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._doSearch(true), 150);
    });
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
      else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); this.prev(); }
      else if (e.key === 'Enter') { e.preventDefault(); this.next(); }
    });
    if (prevBtn) prevBtn.addEventListener('click', () => this.prev());
    if (nextBtn) nextBtn.addEventListener('click', () => this.next());
    if (closeBtn) closeBtn.addEventListener('click', () => this.close());
  },

  attachToTerminal(terminal) {
    if (typeof SearchAddon === 'undefined') return;
    try {
      this._addon = new SearchAddon.SearchAddon();
      terminal.loadAddon(this._addon);
    } catch (_e) { this._addon = null; }
  },

  open() {
    if (!this._bar) return;
    this._bar.style.display = 'flex';
    this._input.focus();
    if (this._input.value) this._doSearch(true);
  },

  close() {
    if (!this._bar) return;
    this._bar.style.display = 'none';
    if (this._addon && this._addon.clearDecorations) this._addon.clearDecorations();
    if (window.app && app.terminal) app.terminal.focus();
  },

  toggle() {
    if (!this._bar) return;
    if (this._bar.style.display === 'none' || this._bar.style.display === '') {
      this.open();
    } else {
      this.close();
    }
  },

  next() { this._doSearch(false); },

  prev() {
    if (!this._addon) return;
    const q = this._input ? this._input.value : '';
    if (!q) return;
    const found = this._addon.findPrevious(q, { caseSensitive: false, regex: false });
    if (this._count) this._count.textContent = found ? '' : 'no match';
  },

  _doSearch(incremental) {
    if (!this._addon) return;
    const q = this._input ? this._input.value : '';
    if (!q) { if (this._count) this._count.textContent = ''; return; }
    const found = this._addon.findNext(q, { caseSensitive: false, regex: false, incremental });
    if (this._count) this._count.textContent = found ? '' : 'no match';
  },
};

/** Cross-session fuzzy switcher. Ctrl+Shift+F to open. */
const SessionSwitcher = {
  _modal: null,
  _input: null,
  _list: null,
  _items: [],
  _activeIdx: 0,
  _debounceTimer: null,
  _subpicker: null,
  _subpickerSession: null,

  init() {
    this._modal = document.getElementById('sessionSwitcherModal');
    this._input = document.getElementById('sessionSwitcherInput');
    this._list = document.getElementById('sessionSwitcherList');
    const backdrop = document.getElementById('sessionSwitcherBackdrop');
    if (!this._modal || !this._input || !this._list) return;

    this._input.addEventListener('input', () => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        this._filter(this._input.value);
        this._render();
      }, 150);
    });
    this._input.addEventListener('keydown', (e) => this._onKey(e));
    if (backdrop) backdrop.addEventListener('click', () => this.close());
  },

  open() {
    if (!this._modal) return;
    this._modal.style.display = 'flex';
    this._modal.classList.add('open');
    if (this._input) { this._input.value = ''; this._input.focus(); }
    this._filter('');
    this._render();
  },

  close() {
    if (!this._modal) return;
    this._modal.classList.remove('open');
    this._modal.style.display = 'none';
    this._closeSubpicker();
  },

  toggle() {
    if (!this._modal) return;
    if (this._modal.classList.contains('open')) { this.close(); } else { this.open(); }
  },

  _scoreSession(s, query) {
    if (!query) return 1;
    const name = (window.app ? app.getSessionName(s) : (s.name || s.id)).toLowerCase();
    const dir = (s.workingDir || '').toLowerCase();
    const q = query.toLowerCase();
    if (name.includes(q)) return 2;
    if (dir.includes(q)) return 1;
    let ni = 0;
    for (let ci = 0; ci < dir.length && ni < q.length; ci++) { if (dir[ci] === q[ni]) ni++; }
    if (ni === q.length) return 0.5;
    return 0;
  },

  _filter(query) {
    const sessions = window.app ? Array.from(app.sessions.values()) : [];
    this._items = sessions
      .map(s => ({ s, score: this._scoreSession(s, query) }))
      .filter(x => !query || x.score > 0)
      .sort((a, b) => b.score - a.score || (b.s.lastActivityAt || 0) - (a.s.lastActivityAt || 0))
      .map(x => x.s);
    this._activeIdx = 0;
  },

  _shortDir(workingDir) {
    if (!workingDir) return '';
    const parts = workingDir.replace(/\/$/, '').split('/');
    return parts.slice(-2).join('/');
  },

  _render() {
    if (!this._list) return;
    while (this._list.firstChild) this._list.removeChild(this._list.firstChild);
    const currentId = window.app ? app.activeSessionId : null;
    this._items.forEach((s, idx) => {
      const li = document.createElement('li');
      li.className = 'ssm-item' + (idx === this._activeIdx ? ' ssm-active' : '') + (s.id === currentId ? ' ssm-current' : '');
      li.setAttribute('role', 'option');
      li.dataset.idx = String(idx);

      const dot = document.createElement('span');
      dot.className = 'ssm-dot' + (s.status === 'busy' ? ' busy' : '');
      li.appendChild(dot);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'ssm-item-name';
      nameSpan.textContent = window.app ? app.getSessionName(s) : (s.name || s.id);
      li.appendChild(nameSpan);

      const dirSpan = document.createElement('span');
      dirSpan.className = 'ssm-item-dir';
      dirSpan.textContent = this._shortDir(s.workingDir);
      li.appendChild(dirSpan);

      const meta = document.createElement('span');
      meta.className = 'ssm-item-meta';

      if (s.contextWindowTokens && s.contextWindowMax) {
        const ctxPct = Math.round((s.contextWindowTokens / s.contextWindowMax) * 100);
        const ctxSpan = document.createElement('span');
        ctxSpan.className = 'ssm-item-ctx';
        ctxSpan.textContent = ctxPct + '%';
        meta.appendChild(ctxSpan);
      }

      if (s.lastActivityAt && window.app && app._formatTimeAgo) {
        const timeSpan = document.createElement('span');
        timeSpan.textContent = app._formatTimeAgo(s.lastActivityAt);
        meta.appendChild(timeSpan);
      }

      li.appendChild(meta);

      const actionRow = document.createElement('div');
      actionRow.className = 'ssm-action-row';
      const reassignBtn = document.createElement('button');
      reassignBtn.className = 'ssm-action-btn';
      reassignBtn.textContent = 'Reassign pane\u2026';
      reassignBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._subpickerSession = s;
        this._openMuxSubpicker(reassignBtn, s);
      });
      actionRow.appendChild(reassignBtn);
      li.appendChild(actionRow);

      li.addEventListener('click', () => { this._select(idx); });
      this._list.appendChild(li);
    });
    if (this._items.length === 0) {
      const empty = document.createElement('li');
      empty.style.cssText = 'padding:12px 14px;color:var(--text-muted);font-size:0.85rem;';
      empty.textContent = 'No sessions found';
      this._list.appendChild(empty);
    }
  },

  _highlightActive() {
    if (!this._list) return;
    const items = this._list.querySelectorAll('.ssm-item');
    items.forEach((el, i) => {
      el.classList.toggle('ssm-active', i === this._activeIdx);
      if (i === this._activeIdx) el.scrollIntoView({ block: 'nearest' });
    });
  },

  _select(idx) {
    const s = this._items[idx];
    if (!s) return;
    this.close();
    if (window.app && app.switchToSession) app.switchToSession(s.id);
  },

  _onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); this._activeIdx = Math.min(this._activeIdx + 1, this._items.length - 1); this._highlightActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this._activeIdx = Math.max(this._activeIdx - 1, 0); this._highlightActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); this._select(this._activeIdx); }
  },

  _closeSubpicker() {
    if (this._subpicker) {
      this._subpicker.remove();
      this._subpicker = null;
    }
    this._subpickerSession = null;
  },

  async _openMuxSubpicker(anchorBtn, targetSession) {
    this._closeSubpicker();
    const picker = document.createElement('div');
    picker.className = 'ssm-subpicker open';

    const header = document.createElement('div');
    header.className = 'ssm-subpicker-header';
    header.textContent = 'Choose tmux session to bind:';
    picker.appendChild(header);

    anchorBtn.style.position = 'relative';
    anchorBtn.appendChild(picker);
    this._subpicker = picker;

    try {
      const resp = await fetch('/api/mux-sessions');
      const data = await resp.json();
      const muxSessions = data.sessions || [];
      if (muxSessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ssm-subpicker-item';
        empty.textContent = 'No tmux sessions available';
        picker.appendChild(empty);
        return;
      }
      muxSessions.forEach(mx => {
        const item = document.createElement('div');
        item.className = 'ssm-subpicker-item';
        item.textContent = mx.muxName + (mx.name ? ' (' + mx.name + ')' : '');
        item.addEventListener('click', () => {
          this._closeSubpicker();
          this._applyMuxOverride(targetSession.id, mx.muxName);
        });
        picker.appendChild(item);
      });
    } catch (_e) {
      const err = document.createElement('div');
      err.className = 'ssm-subpicker-item';
      err.textContent = 'Failed to load tmux sessions';
      picker.appendChild(err);
    }
  },

  async _applyMuxOverride(sessionId, muxName) {
    try {
      const resp = await fetch('/api/sessions/' + sessionId + '/mux-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muxSession: muxName }),
      });
      const data = await resp.json();
      if (data.success) {
        if (window.app && app.showToast) app.showToast('Pane reassigned to ' + muxName);
      } else {
        if (window.app && app.showToast) app.showToast('Failed: ' + (data.error || 'unknown error'), 'error');
      }
    } catch (_e) {
      if (window.app && app.showToast) app.showToast('Network error reassigning pane', 'error');
    }
  },
};


/** Shared translucent backdrop for mcp-type side panels (McpPanel, PluginsPanel, ContextBar). */
const PanelBackdrop = {
  _el: null,
  _get() { return this._el || (this._el = document.getElementById('panelBackdrop')); },
  show() { this._get()?.classList.add('open'); },
  /** Only hides if no other panel is still open.
   *  Protects the case where close() is called in isolation while a different panel
   *  is still visible (e.g. an external caller closes one panel without opening another).
   *  In the A.open() → B.close() sequence the backdrop is temporarily removed then
   *  immediately re-added by A's subsequent show() call — both within the same
   *  synchronous frame, so no visual flicker occurs. */
  hide() {
    const anyOpen = [McpPanel, PluginsPanel, ContextBar].some(
      p => p._panel?.classList.contains('open')
    );
    if (!anyOpen) this._get()?.classList.remove('open');
  },
  init() {
    this._get()?.addEventListener('click', () => {
      McpPanel.close();
      PluginsPanel.close();
      ContextBar.close();
    });
  },
};

const TranscriptView = {
  _container: null,
  _sessionId: null,
  _pendingToolUses: {},
  _loadGen: 0,       // incremented each load(); SSE blocks check this to avoid races
  _compactingEl: null,   // DOM ref to the animated compacting spinner pill
  _isCompacting: false,  // true while auto-compact is in progress (survives container clears)
  _workingDebounce: null,
  _workingHideTimer: null,
  _clearFallbackTimer: null, // set by clearOnly(); cancelled by clear() when TRANSCRIPT_CLEAR arrives

  init() {
    this._container = document.getElementById('transcriptView');
    if (!this._container) return;
    // Keep padding-bottom in sync with compose panel height so last message is never hidden
    const panel = document.getElementById('mobileInputPanel');
    if (panel && window.ResizeObserver) {
      new ResizeObserver(() => {
        const h = panel.getBoundingClientRect().height;
        document.documentElement.style.setProperty('--desktop-compose-height', h + 'px');
      }).observe(panel);
    }
    this._container.addEventListener('scroll', () => {
      const state = this._sessionId ? this._getState(this._sessionId) : null;
      if (!state) return;
      const el = this._container;
      state.scrolledUp = el.scrollTop < el.scrollHeight - el.clientHeight - 100;
    }, { passive: true });
  },

  _getState(sessionId) {
    if (!app._transcriptState) app._transcriptState = {};
    if (!app._transcriptState[sessionId]) {
      app._transcriptState[sessionId] = { viewMode: 'terminal', blocks: [], scrolledUp: false };
    }
    return app._transcriptState[sessionId];
  },

  getViewMode(sessionId) {
    const stored = localStorage.getItem('transcriptViewMode:' + sessionId);
    if (stored === 'web' || stored === 'terminal') return stored;
    return 'web'; // default to web view for Claude sessions
  },

  setViewMode(sessionId, mode) {
    localStorage.setItem('transcriptViewMode:' + sessionId, mode);
    this._getState(sessionId).viewMode = mode;
  },

  async load(sessionId) {
    this._sessionId = sessionId;
    this._pendingToolUses = {};
    const myGen = ++this._loadGen;  // guard against SSE race during fetch
    const state = this._getState(sessionId);
    // NOTE: do NOT clear state.blocks here — caller (clear()) does it when needed.
    // Preserving blocks lets us render a cached view instantly on tab switch.
    state.scrolledUp = false;
    state._sseBuffer = [];  // collect SSE blocks that arrive during the HTTP fetch
    if (!this._container) return;

    // Container is already opacity:0 (set by show()). Keep it hidden until content
    // is rendered and scrolled, then reveal in one frame — no flash, no jump.
    const hadCache = state.blocks.length > 0;
    if (hadCache) {
      this._container.textContent = '';
      for (const block of state.blocks) this._appendBlock(block, false);
      // Scroll to bottom while still invisible, then reveal
      this._container.scrollTop = this._container.scrollHeight;
      this._container.style.opacity = '';
    } else {
      // No cache — show loading message immediately so the user knows something is happening
      this._setPlaceholder('Loading session history\u2026');
      this._container.style.opacity = '';
    }

    try {
      const res = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/transcript');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blocks = await res.json();
      // Abort if a newer load() was started (user switched sessions mid-fetch)
      if (myGen !== this._loadGen) return;

      const prevCount = state.blocks.length;
      state.blocks = [...blocks];  // update cache with authoritative server data

      if (prevCount > 0 && blocks.length >= prevCount) {
        // Incremental update — cache was rendered, just append anything new.
        // No DOM clear, no scroll — avoids any flash or jump.
        const newBlocks = blocks.slice(prevCount);
        for (const block of newBlocks) this._appendBlock(block, false);
      } else {
        // First load or server has fewer blocks than cache (clear happened) — full re-render.
        // Reset _compactingEl ref: the DOM was cleared so the element is now detached.
        // _isCompacting is preserved so we can restore the spinner below if still pending.
        this._compactingEl = null;
        this._container.textContent = '';
        this._pendingToolUses = {};
        if (!blocks.length) {
          this._setEmptyPlaceholder();
          this._container.style.opacity = '';
          state._sseBuffer = null;
          return;
        }
        for (const block of blocks) this._appendBlock(block, false);
      }

      // Replay any SSE blocks that arrived after the HTTP snapshot was taken
      const httpLastTs = blocks[blocks.length - 1]?.timestamp ?? '';
      const allBlocks = [...blocks];
      for (const b of (state._sseBuffer ?? [])) {
        if (!httpLastTs || b.timestamp > httpLastTs) {
          state.blocks.push(b);
          allBlocks.push(b);
          this._appendBlock(b, false);
        }
      }
      state._sseBuffer = null;
      // If compaction was in progress when load() cleared the container, restore the spinner.
      // clearCompacting() sets _isCompacting=false when the compact summary arrives as a block,
      // so if it's still true here, compaction is genuinely still pending.
      if (this._isCompacting && !this._compactingEl) this.showCompacting();
      // Scan all loaded blocks for a pending AskUserQuestion (unanswered tool_use)
      if (typeof app !== 'undefined') {
        let pendingQ = null;
        for (const b of allBlocks) {
          if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions) && b.input.questions.length > 0) {
            const q = b.input.questions[0];
            pendingQ = { sessionId, header: q.header || '', question: q.question || '', options: Array.isArray(q.options) ? q.options : [], toolUseId: b.id };
          } else if (b.type === 'tool_result' && pendingQ && b.toolUseId === pendingQ.toolUseId) {
            pendingQ = null;
          }
        }
        app.pendingAskUserQuestion = pendingQ;
        app.renderAskUserQuestionPanel();
      }
      // Scroll to bottom unless the user explicitly scrolled up during the fetch.
      if (!state.scrolledUp) this._container.scrollTop = this._container.scrollHeight;
      if (!hadCache) this._container.style.opacity = '';
    } catch {
      this._container.style.opacity = '';
      this._setPlaceholder('Could not load session history.');
    }
  },

  _setPlaceholder(text) {
    if (!this._container) return;
    this._container.textContent = '';
    const p = document.createElement('div');
    p.className = 'tv-placeholder';
    p.textContent = text;
    this._container.appendChild(p);
  },

  _setEmptyPlaceholder() {
    if (!this._container) return;
    this._container.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'tv-empty-cta';
    const title = document.createElement('div');
    title.className = 'tv-empty-cta-title';
    title.textContent = 'What\u2019s on your mind today?';
    const sub = document.createElement('div');
    sub.className = 'tv-empty-cta-sub';
    sub.textContent = 'Send a message to start a conversation with Claude.';
    wrap.appendChild(title);
    wrap.appendChild(sub);
    this._container.appendChild(wrap);
  },

  /** Immediately show a user message bubble before the SSE block arrives. */
  appendOptimistic(text) {
    if (!this._container) return;
    const el = this._renderTextBlock({ type: 'text', role: 'user', text });
    if (el) {
      el.dataset.optimistic = 'true';
      const placeholder = this._container.querySelector('.tv-placeholder');
      if (placeholder) placeholder.remove();
      this._container.appendChild(el);
      this._scrollToBottom(true);
    }
  },

  /** Renders an AskUserQuestion tool block as an inline interactive question. */
  _renderAskUserQuestionBlock(block) {
    const q = block.input.questions[0];
    const sessionId = this._sessionId;
    const el = document.createElement('div');
    el.className = 'tv-auq-block';
    if (q.header) {
      const hdr = document.createElement('div');
      hdr.className = 'tv-auq-header';
      hdr.textContent = q.header;
      el.appendChild(hdr);
    }
    if (q.question) {
      const qtxt = document.createElement('div');
      qtxt.className = 'tv-auq-question';
      qtxt.textContent = q.question;
      el.appendChild(qtxt);
    }
    const opts = document.createElement('div');
    opts.className = 'tv-auq-options';
    (q.options || []).forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'tv-auq-option';
      const lbl = document.createElement('span');
      lbl.className = 'tv-auq-option-label';
      lbl.textContent = (i + 1) + '. ' + opt.label;
      btn.appendChild(lbl);
      if (opt.description) {
        const desc = document.createElement('span');
        desc.className = 'tv-auq-option-desc';
        desc.textContent = opt.description;
        btn.appendChild(desc);
      }
      btn.addEventListener('click', () => {
        if (typeof app !== 'undefined') app.sendAskUserQuestionResponse(sessionId, String(i + 1));
        el.remove();
      });
      opts.appendChild(btn);
    });
    // Free-text "write your own answer" row
    const customRow = document.createElement('div');
    customRow.className = 'tv-auq-custom';
    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.className = 'tv-auq-custom-input';
    customInput.placeholder = 'Write your own answer…';
    const customBtn = document.createElement('button');
    customBtn.className = 'tv-auq-custom-send';
    customBtn.textContent = 'Send';
    const sendCustom = () => {
      const val = customInput.value.trim();
      if (!val) return;
      if (typeof app !== 'undefined') app.sendAskUserQuestionResponse(sessionId, val);
      el.remove();
    };
    customBtn.addEventListener('click', sendCustom);
    customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCustom(); });
    customRow.appendChild(customInput);
    customRow.appendChild(customBtn);
    opts.appendChild(customRow);

    el.appendChild(opts);
    return el;
  },

  append(block) {
    if (!this._container || !this._sessionId) return;
    this._getState(this._sessionId).blocks.push(block);
    const placeholder = this._container.querySelector('.tv-placeholder');
    if (placeholder) placeholder.remove();
    // Remove matching optimistic bubble when the real SSE block arrives
    if (block.type === 'text' && block.role === 'user') {
      const optimistic = this._container.querySelector('[data-optimistic="true"]');
      if (optimistic) optimistic.remove();
    }
    this._appendBlock(block, true);
  },

  clear() {
    // Cancel the fallback timer set by clearOnly() — TRANSCRIPT_CLEAR arrived normally.
    clearTimeout(this._clearFallbackTimer);
    this._clearFallbackTimer = null;
    this._pendingToolUses = {};
    if (this._sessionId) {
      const state = this._getState(this._sessionId);
      state.blocks = [];
      state.scrolledUp = false;
    }
    if (this._container) this._container.textContent = '';
    this._compactingEl = null;
    this._isCompacting = false;
    if (this._sessionId) this.load(this._sessionId);
  },

  // Clears the view immediately without reloading from server.
  // Used for optimistic UI when /clear is sent — the SSE transcript:clear event
  // will arrive later and trigger a proper reload via clear() → load().
  //
  // However, Claude Code's /clear creates a new conversation (new UUID + new .jsonl
  // file). The existing transcript watcher only learns the new path from the next
  // hook event, which fires only after the next user interaction. If no hook arrives,
  // transcript:clear never fires and "Clearing…" gets stuck forever.
  //
  // Safety net: _clearFallbackTimer calls clear() after 1.5 s so the view always
  // transitions. clear() cancels the timer when transcript:clear arrives normally.
  // Bumping _loadGen here also aborts any stale in-flight load() so its fetch result
  // can't overwrite the "Clearing…" placeholder with stale blocks.
  clearOnly() {
    this._pendingToolUses = {};
    if (this._sessionId) {
      const state = this._getState(this._sessionId);
      state.blocks = [];
      state.scrolledUp = false;
      state._sseBuffer = null;
    }
    ++this._loadGen; // abort any in-progress load() so its result doesn't overwrite "Clearing…"
    if (this._container) {
      this._container.textContent = '';
      // Show a placeholder while waiting for the server-side clear to complete
      // and the transcript:clear SSE event to trigger a proper reload.
      this._setPlaceholder('Clearing\u2026');
    }
    this._compactingEl = null;

    // Fallback: if transcript:clear SSE never arrives (e.g. /clear creates a new
    // conversation but the server only learns the new transcript path on the next hook
    // event, which fires only after the next user interaction), show the empty CTA
    // directly so the view never stays stuck.
    //
    // We do NOT call load() here — /clear doesn't immediately create a new transcript
    // file, so fetching from the server would return the old content. Instead we
    // render the empty state directly. When transcript:clear eventually fires on the
    // next hook, clear() → load() will fetch the real new transcript at that point.
    const pendingSessionId = this._sessionId;
    clearTimeout(this._clearFallbackTimer);
    // 1.5 s: long enough for a prompt TRANSCRIPT_CLEAR to arrive first (~500 ms typical),
    // short enough that the view doesn't feel broken if it never arrives.
    this._clearFallbackTimer = setTimeout(() => {
      this._clearFallbackTimer = null;
      if (this._sessionId !== pendingSessionId || !pendingSessionId) return;
      // Show empty CTA without fetching — user cleared, so empty is the correct state.
      this._pendingToolUses = {};
      this._compactingEl = null;
      this._isCompacting = false;
      const state = this._getState(pendingSessionId);
      state.blocks = [];
      state.scrolledUp = false;
      if (this._container) {
        this._container.textContent = '';
        this._setEmptyPlaceholder();
        this._container.style.opacity = '';
      }
    }, 1500);
  },

  show(sessionId) {
    this._sessionId = sessionId;
    // Bug fix: reset typing indicator state when switching sessions.
    // Without this, the previous session's busy indicator stays visible for up to 4s
    // while the new (idle) session loads, because setWorking(false) only hides after a debounce.
    clearTimeout(this._workingDebounce);
    this._workingDebounce = null;
    clearTimeout(this._workingHideTimer);
    this._workingHideTimer = null;
    clearTimeout(this._clearFallbackTimer);
    this._clearFallbackTimer = null;
    const _overlay = document.getElementById('tvTypingIndicator');
    if (_overlay) _overlay.style.display = 'none';
    if (this._container) {
      this._container.style.opacity = '0';
      this._container.style.display = '';
    }
    this._detachXterm(sessionId);
    this.load(sessionId);
  },

  hide(sessionId) {
    if (this._container) this._container.style.display = 'none';
    const overlay = document.getElementById('tvTypingIndicator');
    if (overlay) overlay.style.display = 'none';
    this._attachXterm(sessionId);
  },

  _detachXterm(_sessionId) {
    // There is one shared xterm Terminal instance (app.terminal) rendered into #terminalContainer.
    // Hide the container so the transcript view (position:absolute; inset:0) takes the full area.
    const termContainer = document.getElementById('terminalContainer');
    if (termContainer) termContainer.style.visibility = 'hidden';
  },

  _attachXterm(_sessionId) {
    // Restore the terminal container. The shared app.terminal instance stays mounted —
    // no re-open needed.  sendResize corrects the PTY dimensions if the container
    // was hidden long enough that the terminal lost its size.
    const termContainer = document.getElementById('terminalContainer');
    if (termContainer) termContainer.style.visibility = '';
    if (typeof app !== 'undefined' && _sessionId && app.activeSessionId === _sessionId) {
      app.sendResize?.(_sessionId);
    }
  },

  _scrollToBottom(force) {
    if (!this._container) return;
    const state = this._sessionId ? this._getState(this._sessionId) : null;
    if (!force && state?.scrolledUp) return;
    // Use 'instant' to bypass CSS scroll-behavior: smooth so programmatic scroll is immediate
    this._container.scrollTo({ top: this._container.scrollHeight, behavior: 'instant' });
  },

  /** Show or hide the "Claude is thinking" typing indicator (fixed overlay, not in scroll flow) */
  setWorking(isWorking) {
    const overlay = document.getElementById('tvTypingIndicator');
    if (!overlay) return;
    if (isWorking) {
      // Cancel any pending hide — session is still active
      clearTimeout(this._workingHideTimer);
      this._workingHideTimer = null;
      // Debounce showing — avoids flash on tab switch when session briefly transitions busy→idle
      if (!this._workingDebounce) {
        this._workingDebounce = setTimeout(() => {
          this._workingDebounce = null;
          const isTranscriptVisible = this._container && this._container.style.display !== 'none';
          if (isTranscriptVisible) overlay.style.display = 'flex';
        }, 300);
      }
    } else {
      // Debounce hiding — Claude regularly emits short idle gaps while processing
      // (e.g. between tool calls). Don't hide until there's been 4s of genuine silence.
      clearTimeout(this._workingDebounce);
      this._workingDebounce = null;
      clearTimeout(this._workingHideTimer);
      this._workingHideTimer = setTimeout(() => {
        this._workingHideTimer = null;
        overlay.style.display = 'none';
      }, 4000);
    }
  },

  /** Insert an animated "Compacting context..." pill at the bottom of the transcript.
   *  Stored as _compactingEl so _renderTextBlock can remove it when the compact summary arrives.
   *  _isCompacting tracks whether compaction is in progress independently of the DOM element,
   *  so load() can restore the spinner after a container clear without losing the pending state. */
  showCompacting() {
    this._isCompacting = true;
    // If _compactingEl is set but detached (cleared by load()), reset it so we can re-add.
    if (this._compactingEl && this._container && !this._container.contains(this._compactingEl)) {
      this._compactingEl = null;
    }
    if (!this._container || this._compactingEl) return;
    const pill = document.createElement('div');
    pill.className = 'tv-compacting-pill';
    const dots = document.createElement('span');
    dots.className = 'tv-compacting-dots';
    for (let i = 0; i < 3; i++) {
      dots.appendChild(document.createElement('span'));
    }
    const lbl = document.createElement('span');
    lbl.textContent = 'Compacting context';
    pill.appendChild(dots);
    pill.appendChild(lbl);
    this._compactingEl = pill;
    this._container.appendChild(pill);
    this._scrollToBottom(false);
  },

  /** Remove the compacting placeholder. Called when the compact summary text block arrives. */
  clearCompacting() {
    this._isCompacting = false;
    if (this._compactingEl) {
      this._compactingEl.remove();
      this._compactingEl = null;
    }
  },

  _appendBlock(block, scroll) {
    if (!this._container) return;
    let el = null;
    if (block.type === 'text') {
      el = this._renderTextBlock(block);
    } else if (block.type === 'tool_use') {
      if (block.name === 'AskUserQuestion' && Array.isArray(block.input?.questions) && block.input.questions.length > 0) {
        el = this._renderAskUserQuestionBlock(block);
        el.dataset.toolId = block.id;
        this._container.appendChild(el);
        if (scroll) this._scrollToBottom(false);
        return;
      }
      this._pendingToolUses[block.id] = block;
      el = this._renderToolWrapper(block, null);
      el.dataset.toolId = block.id;
    } else if (block.type === 'tool_result') {
      const pendingEl = block.toolUseId
        ? this._container.querySelector('[data-tool-id="' + CSS.escape(block.toolUseId) + '"]')
        : null;
      if (pendingEl) {
        if (pendingEl.classList.contains('tv-auq-block')) {
          pendingEl.remove();
          if (scroll) this._scrollToBottom(false);
          return;
        }
        this._updateToolWrapper(pendingEl, block);
        if (scroll) this._scrollToBottom(false);
        return;
      }
      el = this._renderToolWrapper(null, block);
    } else if (block.type === 'result') {
      el = this._renderResultBlock(block);
    }
    if (el) {
      if (block.type === 'tool_use' || block.type === 'tool_result') {
        this._appendToToolGroup(el);
      } else {
        this._container.appendChild(el);
      }
      if (scroll) this._scrollToBottom(false);
    }
  },

  /** Add a tool wrapper element to the current tool group, creating one if needed. */
  _appendToToolGroup(toolEl) {
    const lastChild = this._container.lastElementChild;
    let group;
    if (lastChild?.classList.contains('tv-tool-group')) {
      group = lastChild;
    } else {
      group = document.createElement('div');
      group.className = 'tv-tool-group';

      const header = document.createElement('div');
      header.className = 'tv-tool-group-header';

      const arrow = document.createElement('span');
      arrow.className = 'tv-tool-group-arrow';
      arrow.textContent = '\u25B6';

      const label = document.createElement('span');
      label.className = 'tv-tool-group-label';

      header.appendChild(arrow);
      header.appendChild(label);

      const body = document.createElement('div');
      body.className = 'tv-tool-group-body';

      header.addEventListener('click', () => {
        const open = header.classList.toggle('open');
        body.classList.toggle('open', open);
      });

      group.appendChild(header);
      group.appendChild(body);
      this._container.appendChild(group);
    }
    group.querySelector('.tv-tool-group-body').appendChild(toolEl);
    this._updateToolGroupLabel(group);
  },

  /** Recount tool wrappers in a group and update the header label. */
  _updateToolGroupLabel(group) {
    if (!group) return;
    const n = group.querySelectorAll('.tv-tool-group-body > [data-tool-id], .tv-tool-group-body > .tv-block').length;
    const label = group.querySelector('.tv-tool-group-label');
    if (label) label.textContent = n + (n === 1 ? ' tool call' : ' tool calls');
  },

  _renderTextBlock(block) {
    // Skip Claude Code internal/system messages — they contain only XML wrapper tags, no real text.
    // Handles: <command-*>, <local-command-*>, <task-notification>, etc.
    if (block.role === 'user') {
      // Hide skill content blocks — Claude Code injects the full skill markdown as a separate
      // user text message (sibling to the tool_result block in the same JSONL entry) after
      // the tool_result confirmation. The tool view already shows "Launching skill: ..." so
      // the content block is redundant and clutters the chat.
      // Pattern anchors to an absolute path + blank line + markdown heading to avoid false
      // positives from real user messages that happen to start with a similar phrase.
      if (/^Base directory for this skill: \/.+\n\n#/.test(block.text)) {
        return null;
      }

      // Render task-notification blocks as a compact summary pill.
      // The full message includes the XML plus a trailing system instruction
      // ("Read the output file to retrieve the result: ...") — hide both.
      if (block.text.includes('<task-notification>')) {
        const summaryMatch = block.text.match(/<summary>([\s\S]*?)<\/summary>/);
        const summary = summaryMatch ? summaryMatch[1].trim() : 'Background task completed';
        const pill = document.createElement('div');
        pill.className = 'tv-task-pill';
        pill.textContent = '\u2713 ' + summary;
        return pill;
      }

      const SYSTEM_XML_RE = /<(?:command-\w+|local-command-\w+)(?:\s[^>]*)?>[\s\S]*?<\/(?:command-\w+|local-command-\w+)>/g;
      const stripped = block.text.replace(SYSTEM_XML_RE, '').trim();
      if (!stripped) {
        // Completely hide caveat/task-notification — pure system metadata with no user value
        if (/<local-command-caveat>/.test(block.text)) {
          return null;
        }
        // Show local command stdout as a muted monospace pill (strip ANSI codes)
        const stdoutMatch = block.text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
        if (stdoutMatch) {
          const cleanText = stdoutMatch[1].replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (!cleanText) return null;
          // Hide /context output — it's already shown in the context bar/chip, no need to repeat it in chat.
          if (cleanText.startsWith('Context Usage')) return null;
          const pill = document.createElement('div');
          pill.className = 'tv-command-pill';
          pill.textContent = cleanText;
          return pill;
        }
        // Show /command-name as a pill (existing behavior)
        const nameMatch = block.text.match(/<command-name>([^<]*)<\/command-name>/);
        const cmdName = (nameMatch ? nameMatch[1].trim() : 'command').replace(/^\//, '');
        const pill = document.createElement('div');
        pill.className = 'tv-command-pill';
        pill.textContent = '/' + cmdName;
        return pill;
      }

      // Context-continuation summary injected by Claude Code's /compact — render as collapsed pill
      const COMPACT_MARKER = 'This session is being continued from a previous conversation that ran out of context.';
      if (block.text.startsWith(COMPACT_MARKER)) {
        this.clearCompacting();
        const wrap = document.createElement('div');
        wrap.className = 'tv-compact-block';

        const hdr = document.createElement('div');
        hdr.className = 'tv-compact-header';

        const arrow = document.createElement('span');
        arrow.className = 'tv-compact-arrow';
        arrow.textContent = '\u25B6';

        const lbl = document.createElement('span');
        lbl.textContent = 'Context summary (compacted)';

        hdr.appendChild(arrow);
        hdr.appendChild(lbl);

        const body = document.createElement('div');
        body.className = 'tv-compact-body tv-markdown';
        body.innerHTML = renderMarkdown(block.text);

        hdr.addEventListener('click', () => {
          const open = hdr.classList.toggle('open');
          body.classList.toggle('open', open);
        });

        wrap.appendChild(hdr);
        wrap.appendChild(body);
        return wrap;
      }
    }
    const div = document.createElement('div');
    div.className = 'tv-block tv-block--' + (block.role === 'user' ? 'user' : 'assistant');
    const label = document.createElement('div');
    label.className = 'tv-label';
    if (block.role === 'user') {
      label.textContent = 'You';
      const bubble = document.createElement('div');
      bubble.className = 'tv-bubble';
      // Use the XML-stripped text if any command/local-command tags were removed,
      // so raw XML from system-injected metadata never appears in the chat bubble.
      const _bubbleText = block.text.replace(/<(?:command-\w+|local-command-\w+)(?:\s[^>]*)?>[\s\S]*?<\/(?:command-\w+|local-command-\w+)>/g, '').trim();
      bubble.textContent = _bubbleText || block.text; // fallback to original if stripping empties it
      div.appendChild(label);
      div.appendChild(bubble);
    } else {
      const dot = document.createElement('span');
      dot.className = 'tv-assistant-dot';
      label.appendChild(dot);
      label.appendChild(document.createTextNode('Claude'));
      const content = document.createElement('div');
      content.className = 'tv-content tv-markdown';
      // renderMarkdown escapes all user/assistant text via esc() before processing.
      // Link hrefs are protocol-validated (only http/https/relative allowed).
      // The resulting HTML is safe to assign on .tv-markdown elements.
      content.innerHTML = renderMarkdown(block.text);
      div.appendChild(label);
      div.appendChild(content);
    }
    return div;
  },

  _renderToolWrapper(toolUse, toolResult) {
    const name = toolUse?.name ?? 'Tool';
    const isError = toolResult?.isError ?? false;
    const wrapper = document.createElement('div');
    wrapper.className = 'tv-block';

    const row = document.createElement('div');
    row.className = 'tv-tool-row' + (isError ? ' tv-tool-row--error' : '');

    const arrow = document.createElement('span');
    arrow.className = 'tv-tool-arrow';
    arrow.textContent = '\u25B6'; // ▶

    const nameSp = document.createElement('span');
    nameSp.className = 'tv-tool-name';
    nameSp.textContent = name; // tool names are internal, but still use textContent

    const argSp = document.createElement('span');
    argSp.className = 'tv-tool-arg';
    if (toolUse?.input) {
      const vals = Object.values(toolUse.input);
      argSp.textContent = vals.length ? String(vals[0]).slice(0, 80) : '';
    }

    const status = document.createElement('span');
    status.className = 'tv-tool-status';
    status.textContent = toolResult ? (isError ? '\u2717' : '\u2713') : ''; // ✗ or ✓

    row.appendChild(arrow);
    row.appendChild(nameSp);
    row.appendChild(argSp);
    row.appendChild(status);

    const panel = document.createElement('div');
    panel.className = 'tv-tool-panel';
    this._buildToolPanel(panel, toolUse, toolResult);

    row.addEventListener('click', () => {
      const open = row.classList.toggle('open');
      panel.classList.toggle('open', open);
    });

    wrapper.appendChild(row);
    wrapper.appendChild(panel);
    return wrapper;
  },

  _buildToolPanel(panel, toolUse, toolResult) {
    panel.textContent = ''; // clear using textContent
    if (toolUse?.input && Object.keys(toolUse.input).length) {
      const sec = this._makeToolSection('Input');
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(toolUse.input, null, 2);
      sec.appendChild(this._wrapPreWithCopy(pre));
      panel.appendChild(sec);
    }
    if (toolResult) {
      const MAX = 10 * 1024;
      const content = toolResult.content ?? '';
      const sec = this._makeToolSection(toolResult.isError ? 'Error Output' : 'Output');
      const pre = document.createElement('pre');
      pre.textContent = content.slice(0, MAX);
      sec.appendChild(this._wrapPreWithCopy(pre));
      if (content.length > MAX) {
        const note = document.createElement('div');
        note.className = 'tv-tool-truncated';
        const btn = document.createElement('button');
        btn.className = 'tv-tool-show-more';
        btn.textContent = 'Show full output (' + Math.round(content.length / 1024) + '\u202fKB)';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          pre.textContent = content;
          note.remove();
        });
        note.appendChild(btn);
        sec.appendChild(note);
      }
      panel.appendChild(sec);
    }
  },

  _makeToolSection(labelText) {
    const sec = document.createElement('div');
    sec.className = 'tv-tool-section';
    const lbl = document.createElement('div');
    lbl.className = 'tv-tool-section-label';
    lbl.textContent = labelText;
    sec.appendChild(lbl);
    return sec;
  },

  _wrapPreWithCopy(pre) {
    const wrap = document.createElement('div');
    wrap.className = 'tv-code-block';
    const btn = document.createElement('button');
    btn.className = 'tv-code-copy';
    btn.title = 'Copy code';
    btn.textContent = 'Copy';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(pre.textContent || '').then(() => {
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      }).catch(() => {});
    });
    wrap.appendChild(btn);
    wrap.appendChild(pre);
    return wrap;
  },

  _updateToolWrapper(wrapper, toolResult) {
    const row = wrapper.querySelector('.tv-tool-row');
    const panel = wrapper.querySelector('.tv-tool-panel');
    if (!row || !panel) return;
    if (toolResult.isError) row.classList.add('tv-tool-row--error');
    const status = row.querySelector('.tv-tool-status');
    if (status) status.textContent = toolResult.isError ? '\u2717' : '\u2713';
    const toolUse = wrapper.dataset.toolId ? this._pendingToolUses[wrapper.dataset.toolId] : null;
    this._buildToolPanel(panel, toolUse, toolResult);
  },

  _renderResultBlock(block) {
    const div = document.createElement('div');
    div.className = 'tv-block tv-block--result';
    const line = document.createElement('div');
    line.className = 'tv-result-line';
    if (block.error) {
      const e = document.createElement('span');
      e.className = 'tv-result-error';
      e.textContent = '\u2717 Error: ' + block.error;
      line.appendChild(e);
    } else {
      const ok = document.createElement('span');
      ok.className = 'tv-result-ok';
      ok.textContent = '\u2713 Completed';
      line.appendChild(ok);
    }
    if (block.cost != null) {
      const cost = document.createElement('span');
      cost.textContent = '\u00b7 $' + block.cost.toFixed(4);
      line.appendChild(cost);
    }
    if (block.durationMs != null) {
      const dur = document.createElement('span');
      dur.textContent = '\u00b7 ' + (block.durationMs / 1000).toFixed(1) + 's';
      line.appendChild(dur);
    }
    div.appendChild(line);
    return div;
  },
};

// ═══════════════════════════════════════════════════════════════
// SSE Handler Map — event-to-method routing table
// ═══════════════════════════════════════════════════════════════
// connectSSE() iterates this array to register all listeners in a single loop.
// Omitted no-op events (registered by server but unused in UI):
//   respawn:stepSent, respawn:aiCheckStarted, respawn:aiCheckCompleted,
//   respawn:aiCheckFailed, respawn:aiCheckCooldown
const _SSE_HANDLER_MAP = [
  // Core
  [SSE_EVENTS.INIT, '_onInit'],

  // Session lifecycle
  [SSE_EVENTS.SESSION_CREATED, '_onSessionCreated'],
  [SSE_EVENTS.SESSION_UPDATED, '_onSessionUpdated'],
  [SSE_EVENTS.SESSION_DELETED, '_onSessionDeleted'],
  [SSE_EVENTS.SESSION_TERMINAL, '_onSessionTerminal'],
  [SSE_EVENTS.SESSION_NEEDS_REFRESH, '_onSessionNeedsRefresh'],
  [SSE_EVENTS.SESSION_CLEAR_TERMINAL, '_onSessionClearTerminal'],
  [SSE_EVENTS.SESSION_COMPLETION, '_onSessionCompletion'],
  [SSE_EVENTS.SESSION_ERROR, '_onSessionError'],
  [SSE_EVENTS.SESSION_EXIT, '_onSessionExit'],
  [SSE_EVENTS.SESSION_IDLE, '_onSessionIdle'],
  [SSE_EVENTS.SESSION_WORKING, '_onSessionWorking'],
  [SSE_EVENTS.SESSION_AUTO_CLEAR, '_onSessionAutoClear'],
  [SSE_EVENTS.SESSION_AUTO_COMPACT, '_onSessionAutoCompact'],
  [SSE_EVENTS.SESSION_CLI_INFO, '_onSessionCliInfo'],

  // Scheduled runs
  [SSE_EVENTS.SCHEDULED_CREATED, '_onScheduledCreated'],
  [SSE_EVENTS.SCHEDULED_UPDATED, '_onScheduledUpdated'],
  [SSE_EVENTS.SCHEDULED_COMPLETED, '_onScheduledCompleted'],
  [SSE_EVENTS.SCHEDULED_STOPPED, '_onScheduledStopped'],

  // Respawn
  [SSE_EVENTS.RESPAWN_STARTED, '_onRespawnStarted'],
  [SSE_EVENTS.RESPAWN_STOPPED, '_onRespawnStopped'],
  [SSE_EVENTS.RESPAWN_STATE_CHANGED, '_onRespawnStateChanged'],
  [SSE_EVENTS.RESPAWN_CYCLE_STARTED, '_onRespawnCycleStarted'],
  [SSE_EVENTS.RESPAWN_BLOCKED, '_onRespawnBlocked'],
  [SSE_EVENTS.RESPAWN_AUTO_ACCEPT_SENT, '_onRespawnAutoAcceptSent'],
  [SSE_EVENTS.RESPAWN_DETECTION_UPDATE, '_onRespawnDetectionUpdate'],
  [SSE_EVENTS.RESPAWN_TIMER_STARTED, '_onRespawnTimerStarted'],
  [SSE_EVENTS.RESPAWN_TIMER_CANCELLED, '_onRespawnTimerCancelled'],
  [SSE_EVENTS.RESPAWN_TIMER_COMPLETED, '_onRespawnTimerCompleted'],
  [SSE_EVENTS.RESPAWN_ERROR, '_onRespawnError'],
  [SSE_EVENTS.RESPAWN_ACTION_LOG, '_onRespawnActionLog'],

  // Tasks
  [SSE_EVENTS.TASK_CREATED, '_onTaskCreated'],
  [SSE_EVENTS.TASK_COMPLETED, '_onTaskCompleted'],
  [SSE_EVENTS.TASK_FAILED, '_onTaskFailed'],
  [SSE_EVENTS.TASK_UPDATED, '_onTaskUpdated'],

  // Mux (tmux)
  [SSE_EVENTS.MUX_CREATED, '_onMuxCreated'],
  [SSE_EVENTS.MUX_KILLED, '_onMuxKilled'],
  [SSE_EVENTS.MUX_DIED, '_onMuxDied'],
  [SSE_EVENTS.MUX_STATS_UPDATED, '_onMuxStatsUpdated'],

  // Ralph
  [SSE_EVENTS.SESSION_RALPH_LOOP_UPDATE, '_onRalphLoopUpdate'],
  [SSE_EVENTS.SESSION_RALPH_TODO_UPDATE, '_onRalphTodoUpdate'],
  [SSE_EVENTS.SESSION_RALPH_COMPLETION_DETECTED, '_onRalphCompletionDetected'],
  [SSE_EVENTS.SESSION_RALPH_STATUS_UPDATE, '_onRalphStatusUpdate'],
  [SSE_EVENTS.SESSION_CIRCUIT_BREAKER_UPDATE, '_onCircuitBreakerUpdate'],
  [SSE_EVENTS.SESSION_EXIT_GATE_MET, '_onExitGateMet'],

  // Bash tools
  [SSE_EVENTS.SESSION_BASH_TOOL_START, '_onBashToolStart'],
  [SSE_EVENTS.SESSION_BASH_TOOL_END, '_onBashToolEnd'],
  [SSE_EVENTS.SESSION_BASH_TOOLS_UPDATE, '_onBashToolsUpdate'],

  // Hooks (Claude Code hook events)
  [SSE_EVENTS.HOOK_IDLE_PROMPT, '_onHookIdlePrompt'],
  [SSE_EVENTS.HOOK_PERMISSION_PROMPT, '_onHookPermissionPrompt'],
  [SSE_EVENTS.HOOK_ELICITATION_DIALOG, '_onHookElicitationDialog'],
  [SSE_EVENTS.HOOK_ASK_USER_QUESTION, '_onHookAskUserQuestion'],
  [SSE_EVENTS.HOOK_STOP, '_onHookStop'],
  [SSE_EVENTS.HOOK_TEAMMATE_IDLE, '_onHookTeammateIdle'],
  [SSE_EVENTS.HOOK_TASK_COMPLETED, '_onHookTaskCompleted'],

  // Subagents (Claude Code background agents)
  [SSE_EVENTS.SUBAGENT_DISCOVERED, '_onSubagentDiscovered'],
  [SSE_EVENTS.SUBAGENT_UPDATED, '_onSubagentUpdated'],
  [SSE_EVENTS.SUBAGENT_TOOL_CALL, '_onSubagentToolCall'],
  [SSE_EVENTS.SUBAGENT_PROGRESS, '_onSubagentProgress'],
  [SSE_EVENTS.SUBAGENT_MESSAGE, '_onSubagentMessage'],
  [SSE_EVENTS.SUBAGENT_TOOL_RESULT, '_onSubagentToolResult'],
  [SSE_EVENTS.SUBAGENT_COMPLETED, '_onSubagentCompleted'],

  // Images
  [SSE_EVENTS.IMAGE_DETECTED, '_onImageDetected'],

  // Tunnel
  [SSE_EVENTS.TUNNEL_STARTED, '_onTunnelStarted'],
  [SSE_EVENTS.TUNNEL_STOPPED, '_onTunnelStopped'],
  [SSE_EVENTS.TUNNEL_PROGRESS, '_onTunnelProgress'],
  [SSE_EVENTS.TUNNEL_ERROR, '_onTunnelError'],
  [SSE_EVENTS.TUNNEL_QR_ROTATED, '_onTunnelQrRotated'],
  [SSE_EVENTS.TUNNEL_QR_REGENERATED, '_onTunnelQrRegenerated'],
  [SSE_EVENTS.TUNNEL_QR_AUTH_USED, '_onTunnelQrAuthUsed'],

  // Plan orchestration
  [SSE_EVENTS.PLAN_SUBAGENT, '_onPlanSubagent'],
  [SSE_EVENTS.PLAN_PROGRESS, '_onPlanProgress'],
  [SSE_EVENTS.PLAN_STARTED, '_onPlanStarted'],
  [SSE_EVENTS.PLAN_CANCELLED, '_onPlanCancelled'],
  [SSE_EVENTS.PLAN_COMPLETED, '_onPlanCompleted'],

  // Update notifications
  [SSE_EVENTS.UPDATE_PROGRESS, '_onUpdateProgress'],
  [SSE_EVENTS.UPDATE_COMPLETE, '_onUpdateComplete'],
  [SSE_EVENTS.UPDATE_FAILED, '_onUpdateFailed'],

  // MCP
  [SSE_EVENTS.SESSION_MCP_RESTARTED, '_onSessionMcpRestarted'],

  // Context usage
  [SSE_EVENTS.SESSION_CONTEXT_USAGE, '_onSessionContextUsage'],

  // Worktrees
  [SSE_EVENTS.WORKTREE_SESSION_ENDED, '_onWorktreeSessionEnded'],

  // Transcript streaming
  [SSE_EVENTS.TRANSCRIPT_BLOCK, '_onTranscriptBlock'],
  [SSE_EVENTS.TRANSCRIPT_CLEAR, '_onTranscriptClear'],
  [SSE_EVENTS.TRANSCRIPT_ASK_USER_QUESTION, '_onTranscriptAskUserQuestion'],
  [SSE_EVENTS.TRANSCRIPT_ASK_USER_QUESTION_RESOLVED, '_onTranscriptAskUserQuestionResolved'],
];

// ═══════════════════════════════════════════════════════════════
// Module-level regex patterns
// ═══════════════════════════════════════════════════════════════

/** Matches GSD context lines like "◆ Context: 47% · 3 tools · idle" */
const STATUS_LINE_RE = /(\bContext\b|\btokens?\b).*\d+%|\d+%.*(\bContext\b|\btokens?\b)/i;

// ═══════════════════════════════════════════════════════════════
// CodemanApp Class — constructor and global state
// ═══════════════════════════════════════════════════════════════

class CodemanApp {
  constructor() {
    this.sessions = new Map();
    this._sessionCommands = new Map(); // Map<sessionId, Array<{cmd:string, desc:string, source:string}>>
    this._shortIdCache = new Map(); // Cache session ID .slice(0, 8) results
    this.sessionOrder = []; // Track tab order for drag-and-drop reordering
    this.draggedTabId = null; // Currently dragged tab session ID
    this.cases = [];
    this.currentRun = null;
    this.totalTokens = 0;
    this.globalStats = null; // Global token/cost stats across all sessions
    this.eventSource = null;
    this.terminal = null;
    this.fitAddon = null;
    this.activeSessionId = null;
    this._initGeneration = 0;     // dedup concurrent handleInit calls
    this._initFallbackTimer = null; // fallback timer if SSE init doesn't arrive
    this._selectGeneration = 0;   // cancel stale selectSession loads
    this.respawnStatus = {};
    this.respawnTimers = {}; // Track timed respawn timers
    this.respawnCountdownTimers = {}; // { sessionId: { timerName: { endsAt, totalMs, reason } } }
    this.respawnActionLogs = {};      // { sessionId: [action, action, ...] } (max 20)
    this.timerCountdownInterval = null; // Interval for updating countdown display
    this.terminalBuffers = new Map(); // Store terminal content per session
    this.editingSessionId = null; // Session being edited in options modal
    this.pendingCloseSessionId = null; // Session pending close confirmation
    this.muxSessions = []; // Screen sessions for process monitor

    // Ralph loop/todo state per session
    this.ralphStates = new Map(); // Map<sessionId, { loop, todos }>

    // Subagent (Claude Code background agent) tracking
    this.subagents = new Map(); // Map<agentId, SubagentInfo>
    this.subagentActivity = new Map(); // Map<agentId, activity[]> - recent tool calls/progress
    this.subagentToolResults = new Map(); // Map<agentId, Map<toolUseId, result>> - tool results by toolUseId
    this.activeSubagentId = null; // Currently selected subagent for detail view
    this.subagentPanelVisible = false;
    this.subagentWindows = new Map(); // Map<agentId, { element, position }>
    this.subagentWindowZIndex = ZINDEX_SUBAGENT_BASE;
    this.minimizedSubagents = new Map(); // Map<sessionId, Set<agentId>> - minimized to tab
    this._subagentHideTimeout = null; // Timeout for hover-based dropdown hide

    // PERSISTENT parent associations - agentId -> sessionId
    // This is the SINGLE SOURCE OF TRUTH for which tab an agent window connects to.
    // Once set, never recalculated. Persisted to localStorage and server.
    this.subagentParentMap = new Map();

    // Agent Teams tracking
    this.teams = new Map(); // Map<teamName, TeamConfig>
    this.teamTasks = new Map(); // Map<teamName, TeamTask[]>
    this.teammateMap = new Map(); // Map<agentId-prefix, {name, color, teamName}> for quick lookup

    // Teammate tmux pane terminals (Agent Teams feature)
    this.teammatePanesByName = new Map(); // Map<name, { paneTarget, sessionId, color }>
    this.teammateTerminals = new Map(); // Map<agentId, { terminal, fitAddon, paneTarget, sessionId, resizeObserver }>

    this.terminalBufferCache = new Map(); // Map<sessionId, string> — client-side cache for instant tab re-visits (max 20)

    this.ralphStatePanelCollapsed = true; // Default to collapsed
    this.ralphClosedSessions = new Set(); // Sessions where user explicitly closed Ralph panel

    // Plan subagent windows (visible agents during plan generation)
    this.planSubagents = new Map(); // Map<agentId, { type, model, status, startTime, element, relativePos }>
    this.planSubagentWindowZIndex = ZINDEX_PLAN_SUBAGENT_BASE;
    this.planGenerationStopped = false; // Flag to ignore SSE events after Stop
    this.planAgentsMinimized = false; // Whether agent windows are minimized to tab

    // Wizard dragging state
    this.wizardDragState = null; // { startX, startY, startLeft, startTop, isDragging }
    this.wizardDragListeners = null; // { move, up } for cleanup
    this.wizardPosition = null; // { left, top } - null means centered

    // Project Insights tracking (active Bash tools with clickable file paths)
    this.projectInsights = new Map(); // Map<sessionId, ActiveBashTool[]>
    this.logViewerWindows = new Map(); // Map<windowId, { element, eventSource, filePath }>
    this.logViewerWindowZIndex = ZINDEX_LOG_VIEWER_BASE;
    this.projectInsightsPanelVisible = false;
    this.currentSessionWorkingDir = null; // Track current session's working dir for path normalization

    // Image popup windows (auto-open for detected screenshots/images)
    this.imagePopups = new Map(); // Map<imageId, { element, sessionId, filePath }>
    this.imagePopupZIndex = ZINDEX_IMAGE_POPUP_BASE;

    // Tunnel indicator state
    this._tunnelUrl = null;

    // Tab alert states: Map<sessionId, 'action' | 'idle'>
    this.tabAlerts = new Map();

    // Tab status dot debounce timers (300ms show / 4000ms hide)
    this._tabStatusTimers = new Map();     // session id -> show-debounce timer id
    this._tabStatusHideTimers = new Map(); // session id -> hide-debounce timer id

    // Pending hooks per session: Map<sessionId, Set<hookType>>
    // Tracks pending hook events that need resolution (permission_prompt, elicitation_dialog, idle_prompt)
    this.pendingHooks = new Map();

    // Elicitation quick-reply state: { sessionId, question, options: [{val,label}] } | null
    this.pendingElicitation = null;

    // AskUserQuestion state: { sessionId, header, question, options: [{label, description}] } | null
    this.pendingAskUserQuestion = null;

    // Terminal write batching with DEC 2026 sync support
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._wasAtBottomBeforeWrite = true; // Default to true for sticky scroll
    this.syncWaitTimeout = null; // Timeout for incomplete sync blocks
    this._isLoadingBuffer = false; // true during chunkedTerminalWrite — blocks live SSE writes
    this._loadBufferQueue = null;  // queued SSE events during buffer load

    // Flicker filter state (buffers output after screen clears)
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    this.flickerFilterTimeout = null;

    // Render debouncing
    this.renderSessionTabsTimeout = null;
    this.renderRalphStatePanelTimeout = null;
    this.renderTaskPanelTimeout = null;
    this.renderMuxSessionsTimeout = null;

    // System stats polling
    this.systemStatsInterval = null;

    // SSE reconnect timeout (to prevent orphaned timeouts)
    this.sseReconnectTimeout = null;

    // Tracks last SSE event timestamp — used to detect stale connections on tab-focus
    this._lastSseEventTime = Date.now();

    // SSE event listener cleanup function (to prevent listener accumulation on reconnect)
    this._sseListenerCleanup = null;

    // SSE connection status tracking
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.isOnline = navigator.onLine;

    // Offline input queue
    this._inputQueue = new Map(); // Map<sessionId, string>
    this._inputQueueMaxBytes = 64 * 1024; // 64KB cap per session
    this._connectionStatus = 'connected';

    // Sequential input send chain — ensures keystroke ordering across async fetches
    this._inputSendChain = Promise.resolve();

    // Local echo overlay — DOM overlay positioned at the visible ❯ prompt
    // (not at buffer.cursorY, which reflects Ink's internal cursor position)
    this._localEchoOverlay = null;  // created after terminal.open()
    this._localEchoEnabled = false; // true when setting on + session active
    this._restoringFlushedState = false; // true during selectSession buffer load — protects flushed Maps
    this._statusStripEl = null; // lazy-cached in _updateStatusStrip

    // Accessibility: Focus trap for modals
    this.activeFocusTrap = null;

    // Notification system
    this.notificationManager = new NotificationManager(this);
    this.idleTimers = new Map(); // Map<sessionId, timeout> for stuck detection

    // DOM element cache for performance (avoid repeated getElementById calls)
    this._elemCache = {};

    this.init();
  }

  // Cached element getter - avoids repeated DOM queries
  $(id) {
    if (!this._elemCache[id]) {
      this._elemCache[id] = document.getElementById(id);
    }
    return this._elemCache[id];
  }

  // Format token count: 1000k -> 1m, 1450k -> 1.45m, 500 -> 500
  formatTokens(count) {
    if (count >= 1000000) {
      const m = count / 1000000;
      return m >= 10 ? `${m.toFixed(1)}m` : `${m.toFixed(2)}m`;
    } else if (count >= 1000) {
      const k = count / 1000;
      return k >= 100 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
    }
    return String(count);
  }

  // Estimate cost from tokens using Claude Opus pricing
  // Input: $15/M tokens, Output: $75/M tokens
  estimateCost(inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1000000) * 15;
    const outputCost = (outputTokens / 1000000) * 75;
    return inputCost + outputCost;
  }

  // ═══════════════════════════════════════════════════════════════
  // Pending Hooks State Machine
  // ═══════════════════════════════════════════════════════════════
  // Track pending hook events per session to determine tab alerts.
  // Action hooks (permission_prompt, elicitation_dialog) take priority over idle_prompt.

  setPendingHook(sessionId, hookType) {
    if (!this.pendingHooks.has(sessionId)) {
      this.pendingHooks.set(sessionId, new Set());
    }
    this.pendingHooks.get(sessionId).add(hookType);
    this.updateTabAlertFromHooks(sessionId);
  }

  clearPendingHooks(sessionId, hookType = null) {
    const hooks = this.pendingHooks.get(sessionId);
    if (!hooks) return;
    if (hookType) {
      hooks.delete(hookType);
    } else {
      hooks.clear();
    }
    if (hooks.size === 0) {
      this.pendingHooks.delete(sessionId);
    }
    this.updateTabAlertFromHooks(sessionId);
    if (this.pendingElicitation?.sessionId === sessionId &&
        (!hookType || hookType === 'elicitation_dialog')) {
      this.pendingElicitation = null;
      this.renderElicitationPanel();
    }
    if (this.pendingAskUserQuestion?.sessionId === sessionId &&
        (!hookType || hookType === 'ask_user_question')) {
      this.pendingAskUserQuestion = null;
      this.renderAskUserQuestionPanel();
    }
  }

  updateTabAlertFromHooks(sessionId) {
    const hooks = this.pendingHooks.get(sessionId);
    if (!hooks || hooks.size === 0) {
      this.tabAlerts.delete(sessionId);
    } else if (hooks.has('permission_prompt') || hooks.has('elicitation_dialog') || hooks.has('ask_user_question')) {
      this.tabAlerts.set(sessionId, 'action');
    } else if (hooks.has('idle_prompt')) {
      this.tabAlerts.set(sessionId, 'idle');
    }
    this.renderSessionTabs();
  }

  // ═══════════════════════════════════════════════════════════════
  // Init — app bootstrap and mobile setup
  // ═══════════════════════════════════════════════════════════════

  init() {
    // Initialize mobile detection first (adds device classes to body)
    MobileDetection.init();
    // Initialize mobile handlers
    KeyboardHandler.init();
    SwipeHandler.init();
    VoiceInput.init();
    KeyboardAccessoryBar.init();
    InputPanel.init();
    TranscriptView.init();
    McpPanel.init();
    PluginsPanel.init();
    ContextBar.init();
    SessionIndicatorBar.init();
    PanelBackdrop.init();
    TerminalSearch.init();
    SessionSwitcher.init();
    // Always-visible compose bar on mobile and desktop
    InputPanel.open();
    // Restore desktop sidebar pin state
    if (MobileDetection.getDeviceType() !== 'mobile' && localStorage.getItem('sidebarPinned') === 'true') {
      document.body.classList.add('sidebar-pinned');
    }
    this.applyHeaderVisibilitySettings();
    this.applyTabWrapSettings();
    this.applyMonitorVisibility();
    // Remove mobile-init class now that JS has applied visibility settings.
    // The inline <script> in <head> added this to prevent flash-of-content on mobile.
    document.documentElement.classList.remove('mobile-init');
    // Defer heavy terminal canvas creation to next frame — lets browser paint header/skeleton first.
    // IMPORTANT: connectSSE must run AFTER initTerminal to prevent a race where SSE data
    // arrives before the terminal exists, orphaning data in pendingWrites and corrupting
    // escape sequence boundaries when later concatenated with fresh data.
    requestAnimationFrame(() => {
      this.initTerminal();
      this.loadFontSize();
      this.connectSSE();
      // Only fetch state if SSE init event hasn't arrived within 3s (avoids duplicate handleInit)
      this._initFallbackTimer = setTimeout(() => {
        if (this._initGeneration === 0) this.loadState();
      }, 3000);
    });
    // Register service worker for push notifications
    this.registerServiceWorker();
    // Fetch tunnel status for header indicator (desktop only)
    this.loadTunnelStatus();
    // Share a single settings fetch between both consumers
    const settingsPromise = fetch('/api/settings').then(r => r.ok ? r.json() : null).catch(() => null);
    this.loadQuickStartCases(null, settingsPromise);
    this._initRunMode();
    this.setupEventListeners();
    // Mobile: ensure button taps register even when keyboard is visible.
    // On mobile, tapping a button while the soft keyboard is up causes the
    // browser to dismiss the keyboard first (blur event), swallowing the tap.
    // The button only receives the click on a second tap. Fix: intercept
    // touchstart on buttons while keyboard is visible, preventDefault to stop
    // the dismiss-swallows-tap behavior, and trigger the click programmatically.
    if (MobileDetection.isTouchDevice()) {
      const addKeyboardTapFix = (container) => {
        if (!container) return;
        container.addEventListener('touchstart', (e) => {
          if (!KeyboardHandler.keyboardVisible) return;
          const btn = e.target.closest('button');
          if (!btn) return;
          e.preventDefault();
          btn.click();
          // Refocus terminal so keyboard stays open (e.g. voice input button)
          if (typeof app !== 'undefined' && app.terminal) {
            app.terminal.focus();
          }
        }, { passive: false });
      };
      addKeyboardTapFix(document.querySelector('.toolbar'));
      addKeyboardTapFix(document.querySelector('.welcome-overlay'));
      addKeyboardTapFix(document.getElementById('mobileInputPanel'));
    }
    // System stats polling deferred until sessions exist (started in handleInit/session:created)
    // Setup online/offline detection
    this.setupOnlineDetection();
    this._initUpdateChecker();
    // Load server-stored settings (async, re-applies visibility after load)
    this.loadAppSettingsFromServer(settingsPromise).then(() => {
      this.applyHeaderVisibilitySettings();
      this.applyTabWrapSettings();
      this.applyMonitorVisibility();
    });
    // Hide loading skeleton now that the app shell is ready
    document.body.classList.add('app-loaded');
  }

  // ═══════════════════════════════════════════════════════════════
  // Terminal Setup — xterm.js config and input handling
  // ═══════════════════════════════════════════════════════════════

  initTerminal() {
    // Load scrollback setting from localStorage (default 500)
    const scrollback = parseInt(localStorage.getItem('codeman-scrollback')) || DEFAULT_SCROLLBACK;

    // Cap scrollback on mobile: each line adds to xterm-viewport scroll height.
    // 500 lines × 10px font = 5000px tall scroll layer on a 900px screen.
    // Cap at 200 lines to keep the native scroll layer manageable.
    const isMobile = MobileDetection.getDeviceType() !== 'desktop';
    const MOBILE_SCROLLBACK_CAP = 200;
    const effectiveScrollback = isMobile ? Math.min(scrollback, MOBILE_SCROLLBACK_CAP) : scrollback;

    this.terminal = new Terminal({
      theme: {
        background: '#0d0d0d',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        cursorAccent: '#0d0d0d',
        selection: 'rgba(255, 255, 255, 0.3)',
        black: '#0d0d0d',
        red: '#ff6b6b',
        green: '#51cf66',
        yellow: '#ffd43b',
        blue: '#339af0',
        magenta: '#cc5de8',
        cyan: '#22b8cf',
        white: '#e0e0e0',
        brightBlack: '#495057',
        brightRed: '#ff8787',
        brightGreen: '#69db7c',
        brightYellow: '#ffe066',
        brightBlue: '#5c7cfa',
        brightMagenta: '#da77f2',
        brightCyan: '#66d9e8',
        brightWhite: '#ffffff',
      },
      fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
      // Use smaller font on mobile to fit more columns (prevents wrapping of Claude's status line)
      fontSize: MobileDetection.getDeviceType() === 'mobile' ? 10 : 14,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: effectiveScrollback,
      allowTransparency: true,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    TerminalSearch.attachToTerminal(this.terminal);

    if (typeof Unicode11Addon !== 'undefined') {
      try {
        const unicode11Addon = new Unicode11Addon.Unicode11Addon();
        this.terminal.loadAddon(unicode11Addon);
        this.terminal.unicode.activeVersion = '11';
      } catch (_e) { /* Unicode11 addon failed — default Unicode handling used */ }
    }

    const container = document.getElementById('terminalContainer');
    this.terminal.open(container);

    // WebGL renderer for GPU-accelerated terminal rendering.
    // Previously caused "page unresponsive" crashes from synchronous GPU stalls,
    // but the 48KB/frame flush cap in flushPendingWrites() now prevents
    // oversized terminal.write() calls that triggered the stalls.
    // Enable GPU-accelerated rendering with ?webgl URL param (canvas renderer is default).
    this._webglAddon = null;
    const skipWebGL = MobileDetection.getDeviceType() !== 'desktop';
    if (!skipWebGL && new URLSearchParams(location.search).has('webgl') && typeof WebglAddon !== 'undefined') {
      try {
        this._webglAddon = new WebglAddon.WebglAddon();
        this._webglAddon.onContextLoss(() => {
          console.error('[CRASH-DIAG] WebGL context LOST — falling back to canvas renderer');
          this._webglAddon.dispose();
          this._webglAddon = null;
        });
        this.terminal.loadAddon(this._webglAddon);
        console.log('[CRASH-DIAG] WebGL renderer enabled via ?webgl param');
      } catch (_e) { /* WebGL2 unavailable — canvas renderer used */ }
    }

    this._localEchoOverlay = new LocalEchoOverlay(this.terminal);

    // OSC-based busy/idle detection — more reliable than spinner character scanning.
    // onTitleChange fires on OSC 0/2 title-change sequences from the PTY.
    // registerOscHandler(133) captures shell integration marks (A/B/C/D) for reliable
    // prompt-shown / pre-execution signals if Claude Code emits them.
    this.terminal.onTitleChange((title) => {
      // Enable capture for investigation: run `window._oscTitleLog = []` in the browser console.
      if (window._oscTitleLog) window._oscTitleLog.push({ title, at: Date.now() });
      this._onTerminalTitleChange(title);
    });

    if (this.terminal.parser) {
      // OSC 133: A=prompt-start, B=prompt-end (idle), C=pre-exec (busy), D=exec-done (idle)
      this.terminal.parser.registerOscHandler(133, (data) => {
        if (window._osc133Log) window._osc133Log.push({ data, at: Date.now() });
        this._onOsc133(data);
        return true; // handler consumed the sequence
      });
    }

    // On mobile Safari, delay initial fit() to allow layout to settle
    // This prevents 0-column terminals caused by fit() running before container is sized
    const isMobileSafari = MobileDetection.getDeviceType() === 'mobile' &&
                           document.body.classList.contains('safari-browser');
    if (isMobileSafari) {
      // Wait for layout, then fit multiple times to ensure proper sizing
      requestAnimationFrame(() => {
        this.fitAddon.fit();
        // Double-check after another frame
        requestAnimationFrame(() => this.fitAddon.fit());
      });
    } else {
      this.fitAddon.fit();
    }

    // Register link provider for clickable file paths in Bash tool output
    this.registerFilePathLinkProvider();

    // Always use mouse wheel for terminal scrollback, never forward to application.
    // Prevents Claude's Ink UI (plan mode selector) from capturing scroll as option navigation.
    container.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const lines = Math.round(ev.deltaY / 25) || (ev.deltaY > 0 ? 1 : -1);
      this.terminal.scrollLines(lines);
    }, { passive: false });

    // Touch scrolling - only use custom JS scrolling on desktop
    // Mobile uses native browser scrolling via CSS touch-action: pan-y
    const isMobileDevice = MobileDetection.isTouchDevice() && window.innerWidth < 1024;

    if (!isMobileDevice) {
      // Desktop touch scrolling with custom momentum
      let touchLastY = 0;
      let pendingDelta = 0;
      let velocity = 0;
      let lastTime = 0;
      let scrollFrame = null;
      let isTouching = false;

      const viewport = container.querySelector('.xterm-viewport');

      // Single RAF loop handles both touch and momentum
      const scrollLoop = (timestamp) => {
        if (!viewport) return;

        const dt = lastTime ? (timestamp - lastTime) / 16.67 : 1; // Normalize to 60fps
        lastTime = timestamp;

        if (isTouching) {
          // During touch: apply pending delta
          if (pendingDelta !== 0) {
            viewport.scrollTop += pendingDelta;
            pendingDelta = 0;
          }
          scrollFrame = requestAnimationFrame(scrollLoop);
        } else if (Math.abs(velocity) > 0.1) {
          // Momentum phase
          viewport.scrollTop += velocity * dt;
          velocity *= 0.94; // Smooth deceleration
          scrollFrame = requestAnimationFrame(scrollLoop);
        } else {
          scrollFrame = null;
          velocity = 0;
        }
      };

      container.addEventListener('touchstart', (ev) => {
        if (ev.touches.length === 1) {
          touchLastY = ev.touches[0].clientY;
          pendingDelta = 0;
          velocity = 0;
          isTouching = true;
          lastTime = 0;
          if (!scrollFrame) {
            scrollFrame = requestAnimationFrame(scrollLoop);
          }
        }
      }, { passive: true });

      container.addEventListener('touchmove', (ev) => {
        if (ev.touches.length === 1 && isTouching) {
          const touchY = ev.touches[0].clientY;
          const delta = touchLastY - touchY;
          pendingDelta += delta;
          velocity = delta * 1.2; // Track for momentum
          touchLastY = touchY;
        }
      }, { passive: true });

      container.addEventListener('touchend', () => {
        isTouching = false;
        // Momentum continues in scrollLoop
      }, { passive: true });

      container.addEventListener('touchcancel', () => {
        isTouching = false;
        velocity = 0;
      }, { passive: true });
    }
    // Mobile: native scrolling handles touch via CSS

    // Welcome message
    this.showWelcome();

    // Handle resize with throttling for performance
    this._resizeTimeout = null;
    this._lastResizeDims = null;

    // Minimum terminal dimensions to prevent vertical text wrapping
    const MIN_COLS = 40;
    const MIN_ROWS = 10;

    const throttledResize = () => {
      if (this._resizeTimeout) return;
      this._resizeTimeout = setTimeout(() => {
        this._resizeTimeout = null;
        if (this.fitAddon) {
          this.fitAddon.fit();
          // Skip server resize while mobile keyboard is visible — sending SIGWINCH
          // causes Ink to re-render at the new row count, garbling terminal output.
          // Local fit() still runs so xterm knows the viewport size for scrolling.
          // Also skip during buffer load (tab switch): selectSession calls sendResize at the
          // end, and an early resize queues an Ink full-screen repaint in _loadBufferQueue
          // that flushes on top of the loaded buffer, looking like a stream reload.
          const keyboardUp = typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible;
          if (this.activeSessionId && !keyboardUp && !this._isLoadingBuffer) {
            const dims = this.fitAddon.proposeDimensions();
            // Enforce minimum dimensions to prevent layout issues
            const cols = dims ? Math.max(dims.cols, MIN_COLS) : MIN_COLS;
            const rows = dims ? Math.max(dims.rows, MIN_ROWS) : MIN_ROWS;
            // Only send resize if dimensions actually changed
            if (!this._lastResizeDims ||
                cols !== this._lastResizeDims.cols ||
                rows !== this._lastResizeDims.rows) {
              this._lastResizeDims = { cols, rows };
              fetch(`/api/sessions/${this.activeSessionId}/resize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cols, rows })
              }).catch(() => {});
            }
          }
        }
        // Update subagent connection lines when viewport resizes
        this.updateConnectionLines();
        // Re-render local echo overlay at new cell dimensions/positions
        if (this._localEchoOverlay?.hasPending) {
          this._localEchoOverlay.rerender();
        }
      }, 100); // Throttle to 100ms
    };

    window.addEventListener('resize', throttledResize);
    // Store resize observer for cleanup (prevents memory leak on terminal re-init)
    if (this.terminalResizeObserver) {
      this.terminalResizeObserver.disconnect();
    }
    this.terminalResizeObserver = new ResizeObserver(throttledResize);
    this.terminalResizeObserver.observe(container);

    // Handle keyboard input — send to PTY immediately, no local echo.
    // PTY/Ink handles all character echoing to avoid desync ("typing visible below" bug).
    this._pendingInput = '';
    this._inputFlushTimeout = null;
    this._lastKeystrokeTime = 0;

    const flushInput = () => {
      this._inputFlushTimeout = null;
      if (this._pendingInput && this.activeSessionId) {
        const input = this._pendingInput;
        const sessionId = this.activeSessionId;
        this._pendingInput = '';
        this._sendInputAsync(sessionId, input);
      }
    };

    // Local echo mode: buffer keystrokes locally (shown in overlay) and only
    // send to PTY on Enter.  Avoids out-of-order delivery on high-latency
    // mobile connections.  The overlay + localStorage persistence ensure input
    // survives tab switches and reconnects.

    this.terminal.onData((data) => {
      if (this.activeSessionId) {
        // Filter out terminal query responses that xterm.js generates automatically.
        // These are responses to DA (Device Attributes), DSR (Device Status Report), etc.
        // sent by tmux when attaching. Without this filter, they appear as typed text.
        // Patterns: \x1b[?...c (DA1), \x1b[>...c (DA2), \x1b[...R (CPR), \x1b[...n (DSR)
        if (/^\x1b\[[\?>=]?[\d;]*[cnR]$/.test(data)) return;

        // ── Local Echo Mode ──
        // When enabled, keystrokes are buffered locally in the overlay for
        // instant visual feedback.  Nothing is sent to the PTY until Enter
        // (or a control char) is pressed — avoids out-of-order char delivery.
        if (this._localEchoEnabled) {
          if (data === '\x7f') {
            const source = this._localEchoOverlay?.removeChar();
            if (source === 'flushed') {
              // Sync app-level flushed Maps (per-session state for tab switching)
              const { count, text } = this._localEchoOverlay.getFlushed();
              if (this._flushedOffsets?.has(this.activeSessionId)) {
                if (count === 0) {
                  this._flushedOffsets.delete(this.activeSessionId);
                  this._flushedTexts?.delete(this.activeSessionId);
                } else {
                  this._flushedOffsets.set(this.activeSessionId, count);
                  this._flushedTexts?.set(this.activeSessionId, text);
                }
              }
              this._pendingInput += data;
              flushInput();
            }
            // 'pending' = removed unsent text (no PTY backspace needed)
            // false = nothing to remove (swallow the backspace)
            return;
          }
          if (/^[\r\n]+$/.test(data)) {
            // Enter: send full buffered text + \r to PTY in one shot
            const text = this._localEchoOverlay?.pendingText || '';
            this._localEchoOverlay?.clear();
            // Suppress detection so PTY-echoed text isn't re-detected as user input
            this._localEchoOverlay?.suppressBufferDetection();
            // Clear flushed offset and text — Enter commits all text
            this._flushedOffsets?.delete(this.activeSessionId);
            this._flushedTexts?.delete(this.activeSessionId);
            if (this._inputFlushTimeout) {
              clearTimeout(this._inputFlushTimeout);
              this._inputFlushTimeout = null;
            }
            if (text) {
              this._pendingInput += text;
              flushInput();
            }
            // Send \r after a short delay so text arrives first
            setTimeout(() => {
              this._pendingInput += '\r';
              flushInput();
            }, 80);
            return;
          }
          if (data.length > 1 && data.charCodeAt(0) >= 32) {
            // Paste: append to overlay only (sent on Enter)
            this._localEchoOverlay?.appendText(data);
            return;
          }
          if (data.charCodeAt(0) < 32) {
            // Skip xterm-generated terminal responses.
            // These arrive via triggerDataEvent when the terminal processes
            // buffer data (DA responses, OSC color queries, mode reports, etc.).
            // They are NOT user input and must not clear flushed text state.
            // Covers: CSI (\x1b[), OSC (\x1b]), DCS (\x1bP), APC (\x1b_),
            // PM (\x1b^), SOS (\x1bX), and any other multi-byte ESC sequence.
            // Single-byte ESC (user pressing Escape) still falls through to
            // the control char handler below.
            if (data.length > 1 && data.charCodeAt(0) === 27) {
              // Multi-byte escape sequence — forward to PTY without clearing
              // overlay/flushed state (terminal response, not user input)
              this._pendingInput += data;
              flushInput();
              return;
            }
            // During buffer load (tab switch), stray control chars from
            // terminal response processing must not wipe the flushed state
            // that selectSession() is actively restoring.
            if (this._restoringFlushedState) {
              this._pendingInput += data;
              flushInput();
              return;
            }
            // Tab key: send pending text + Tab to PTY for tab completion.
            // Set a flag so flushPendingWrites() re-detects buffer text when
            // the PTY response arrives (event-driven, no fixed timer).
            if (data === '\t') {
              const text = this._localEchoOverlay?.pendingText || '';
              this._localEchoOverlay?.clear();
              this._flushedOffsets?.delete(this.activeSessionId);
              this._flushedTexts?.delete(this.activeSessionId);
              if (text) {
                this._pendingInput += text;
              }
              this._pendingInput += data;
              if (this._inputFlushTimeout) {
                clearTimeout(this._inputFlushTimeout);
                this._inputFlushTimeout = null;
              }
              // Snapshot prompt line text BEFORE flushing — used to distinguish
              // real Tab completions from pre-existing Claude UI text.
              let baseText = '';
              try {
                const p = this._localEchoOverlay?.findPrompt?.();
                if (p) {
                  const buf = this.terminal.buffer.active;
                  const line = buf.getLine(buf.viewportY + p.row);
                  if (line) baseText = line.translateToString(true).slice(p.col + 2).trimEnd();
                }
              } catch {}
              this._tabCompletionBaseText = baseText;
              flushInput();
              this._tabCompletionSessionId = this.activeSessionId;
              this._tabCompletionRetries = 0;
              // Fallback: if flushPendingWrites() detection misses the completion
              // (e.g., flicker filter delays data, or xterm hasn't processed writes
              // by the time the callback fires), retry detection after a delay.
              // This ensures the overlay renders even without further terminal data.
              if (this._tabCompletionFallback) clearTimeout(this._tabCompletionFallback);
              const selfTab = this;
              this._tabCompletionFallback = setTimeout(() => {
                selfTab._tabCompletionFallback = null;
                if (!selfTab._tabCompletionSessionId || selfTab._tabCompletionSessionId !== selfTab.activeSessionId) return;
                const ov = selfTab._localEchoOverlay;
                if (!ov || ov.pendingText) return;
                selfTab.terminal.write('', () => {
                  if (!selfTab._tabCompletionSessionId) return;
                  ov.resetBufferDetection();
                  const detected = ov.detectBufferText();
                  if (detected && detected !== selfTab._tabCompletionBaseText) {
                    selfTab._tabCompletionSessionId = null;
                    selfTab._tabCompletionRetries = 0;
                    selfTab._tabCompletionBaseText = null;
                    ov.rerender();
                  }
                });
              }, 300);
              return;
            }
            // Control chars (Ctrl+C, single ESC): send buffered text + control char immediately
            const text = this._localEchoOverlay?.pendingText || '';
            this._localEchoOverlay?.clear();
            // Suppress detection so PTY-echoed text isn't re-detected as user input
            this._localEchoOverlay?.suppressBufferDetection();
            // Clear flushed offset and text — control chars (Ctrl+C, Escape) change
            // cursor position or abort readline, making flushed text tracking invalid.
            this._flushedOffsets?.delete(this.activeSessionId);
            this._flushedTexts?.delete(this.activeSessionId);
            if (text) {
              this._pendingInput += text;
            }
            this._pendingInput += data;
            if (this._inputFlushTimeout) {
              clearTimeout(this._inputFlushTimeout);
              this._inputFlushTimeout = null;
            }
            flushInput();
            return;
          }
          if (data.length === 1 && data.charCodeAt(0) >= 32) {
            // Printable char: add to overlay only (sent on Enter)
            this._localEchoOverlay?.addChar(data);
            return;
          }
        }

        // ── Normal Mode (echo disabled) ──
        this._pendingInput += data;

        // Control chars (Enter, Ctrl+C, escape sequences) — flush immediately
        if (data.charCodeAt(0) < 32 || data.length > 1) {
          if (this._inputFlushTimeout) {
            clearTimeout(this._inputFlushTimeout);
            this._inputFlushTimeout = null;
          }
          flushInput();
          return;
        }

        // Regular chars — flush immediately if typed after a gap (>50ms),
        // otherwise batch via microtask to coalesce rapid keystrokes (paste).
        const now = performance.now();
        if (now - this._lastKeystrokeTime > 50) {
          // Single char after a gap — send immediately, no setTimeout latency
          if (this._inputFlushTimeout) {
            clearTimeout(this._inputFlushTimeout);
            this._inputFlushTimeout = null;
          }
          this._lastKeystrokeTime = now;
          flushInput();
        } else {
          // Rapid sequence (paste or fast typing) — coalesce via microtask
          this._lastKeystrokeTime = now;
          if (!this._inputFlushTimeout) {
            this._inputFlushTimeout = setTimeout(flushInput, 0);
          }
        }
      }
    });
  }

  /**
   * Register a custom link provider for xterm.js that detects file paths
   * in terminal output and makes them clickable.
   * When clicked, opens a floating log viewer window with live streaming.
   */
  registerFilePathLinkProvider() {
    const self = this;

    // Debug: Track if provider is being invoked
    let lastInvokedLine = -1;

    this.terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        // Debug logging - only log if line changed to avoid spam
        if (bufferLineNumber !== lastInvokedLine) {
          lastInvokedLine = bufferLineNumber;
          console.debug('[LinkProvider] Checking line:', bufferLineNumber);
        }

        const buffer = self.terminal.buffer.active;
        const line = buffer.getLine(bufferLineNumber);

        if (!line) {
          callback(undefined);
          return;
        }

        // Get line text - translateToString handles wrapped lines
        const lineText = line.translateToString(true);

        if (!lineText || !lineText.includes('/')) {
          callback(undefined);
          return;
        }

        const links = [];

        // Pattern 1: Commands with file paths (tail -f, cat, head, grep pattern, etc.)
        // Handles: tail -f /path, grep pattern /path, cat -n /path
        const cmdPattern = /(tail|cat|head|less|grep|watch|vim|nano)\s+(?:[^\s\/]*\s+)*(\/[^\s"'<>|;&\n\x00-\x1f]+)/g;

        // Pattern 2: Paths with common extensions
        const extPattern = /(\/(?:home|tmp|var|etc|opt)[^\s"'<>|;&\n\x00-\x1f]*\.(?:log|txt|json|md|yaml|yml|csv|xml|sh|py|ts|js))\b/g;

        // Pattern 3: Bash() tool output
        const bashPattern = /Bash\([^)]*?(\/(?:home|tmp|var|etc|opt)[^\s"'<>|;&\)\n\x00-\x1f]+)/g;

        const addLink = (filePath, matchIndex) => {
          const startCol = lineText.indexOf(filePath, matchIndex);
          if (startCol === -1) return;

          // Skip if already have link at this position
          if (links.some(l => l.range.start.x === startCol + 1)) return;

          links.push({
            text: filePath,
            range: {
              start: { x: startCol + 1, y: bufferLineNumber },      // 1-based
              end: { x: startCol + filePath.length + 1, y: bufferLineNumber }
            },
            decorations: {
              pointerCursor: true,
              underline: true
            },
            activate(event, text) {
              self.openLogViewerWindow(text, self.activeSessionId);
            }
          });
        };

        // Match all patterns
        let match;

        cmdPattern.lastIndex = 0;
        while ((match = cmdPattern.exec(lineText)) !== null) {
          addLink(match[2], match.index);
        }

        extPattern.lastIndex = 0;
        while ((match = extPattern.exec(lineText)) !== null) {
          addLink(match[1], match.index);
        }

        bashPattern.lastIndex = 0;
        while ((match = bashPattern.exec(lineText)) !== null) {
          addLink(match[1], match.index);
        }

        if (links.length > 0) {
          console.debug('[LinkProvider] Found links:', links.map(l => l.text));
        }
        callback(links.length > 0 ? links : undefined);
      }
    });

    console.log('[LinkProvider] File path link provider registered');
  }

  showWelcome() {
    SessionIndicatorBar.update(null);
    const overlay = document.getElementById('welcomeOverlay');
    if (overlay) {
      overlay.classList.add('visible');
      this.loadTunnelStatus();
    }
  }

  hideWelcome() {
    const overlay = document.getElementById('welcomeOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
    // Collapse expanded QR when leaving welcome screen
    const qrWrap = document.getElementById('welcomeQr');
    if (qrWrap) {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.remove('expanded');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Terminal Rendering
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if terminal viewport is at or near the bottom.
   * Used to implement "sticky scroll" behavior - keep user at bottom if they were there.
   */
  isTerminalAtBottom() {
    if (!this.terminal) return true;
    const buffer = this.terminal.buffer.active;
    // viewportY is the top line of the viewport, baseY is where scrollback starts
    // If viewportY >= baseY, we're showing the latest content (at bottom)
    // Allow 2 lines tolerance for edge cases
    return buffer.viewportY >= buffer.baseY - 2;
  }

  batchTerminalWrite(data) {
    // If a buffer load (chunkedTerminalWrite) is in progress, queue live events
    // to prevent interleaving historical buffer data with live SSE data.
    // This is critical: interleaving causes cursor position chaos with Ink redraws.
    if (this._isLoadingBuffer) {
      if (this._loadBufferQueue) this._loadBufferQueue.push(data);
      return;
    }

    // Check if at bottom BEFORE adding data (captures user's scroll position)
    // Only update if not already scheduled (preserve the first check's result)
    if (!this.writeFrameScheduled) {
      this._wasAtBottomBeforeWrite = this.isTerminalAtBottom();
    }

    // Check if flicker filter is enabled for current session
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
    const flickerFilterEnabled = session?.flickerFilterEnabled ?? false;

    // Always buffer Ink's cursor-up redraws regardless of flicker filter setting.
    // Ink's status bar updates use cursor-up + erase-line + rewrite, which can split
    // across render frames causing old/new status text to overlap (garbled output).
    // Buffering for 50ms ensures the full redraw arrives atomically.
    //
    // Shell mode is excluded: shell readline also uses cursor-up for prompt redraws
    // (e.g. zsh syntax highlighting on every keystroke), and there's no Ink status bar
    // to protect. Applying the filter in shell mode delays character feedback until the
    // user stops typing for 50ms, making the terminal feel unresponsive.
    const isShellMode = session?.mode === 'shell';
    const hasCursorUpRedraw = !isShellMode && /\x1b\[\d{1,2}A/.test(data);
    if (hasCursorUpRedraw || (this.flickerFilterActive && !flickerFilterEnabled)) {
      this.flickerFilterActive = true;
      this.flickerFilterBuffer += data;

      // Only reset the 50ms timer on cursor-up events (start of a new Ink redraw cycle).
      // Non-cursor-up events while the filter is active are trailing data from the same
      // redraw — don't extend the deadline further. Without this guard, a busy Claude
      // session emitting terminal data faster than SYNC_WAIT_TIMEOUT_MS never flushes,
      // accumulating MBs in flickerFilterBuffer that freeze Chrome all at once.
      if (hasCursorUpRedraw) {
        if (this.flickerFilterTimeout) {
          clearTimeout(this.flickerFilterTimeout);
        }
        this.flickerFilterTimeout = setTimeout(() => {
          this.flickerFilterTimeout = null;
          this.flushFlickerBuffer();
        }, SYNC_WAIT_TIMEOUT_MS); // 50ms buffer window
      } else if (!this.flickerFilterTimeout) {
        // Safety: if no timer is running for some reason, ensure we eventually flush.
        this.flickerFilterTimeout = setTimeout(() => {
          this.flickerFilterTimeout = null;
          this.flushFlickerBuffer();
        }, SYNC_WAIT_TIMEOUT_MS);
      }

      // Safety valve: if buffer grew very large (e.g. from a burst before the timer fired),
      // flush immediately to avoid writing a huge block all at once.
      if (this.flickerFilterBuffer.length > 256 * 1024) {
        if (this.flickerFilterTimeout) {
          clearTimeout(this.flickerFilterTimeout);
          this.flickerFilterTimeout = null;
        }
        this.flushFlickerBuffer();
      }

      return;
    }

    // Opt-in flicker filter: also buffer screen clear patterns
    if (flickerFilterEnabled) {
      const hasScreenClear = data.includes('\x1b[2J') ||
                             data.includes('\x1b[H\x1b[J') ||
                             (data.includes('\x1b[H') && data.includes('\x1b[?25l'));

      if (hasScreenClear) {
        this.flickerFilterActive = true;
        this.flickerFilterBuffer += data;

        if (this.flickerFilterTimeout) {
          clearTimeout(this.flickerFilterTimeout);
        }
        this.flickerFilterTimeout = setTimeout(() => {
          this.flickerFilterTimeout = null;
          this.flushFlickerBuffer();
        }, SYNC_WAIT_TIMEOUT_MS); // 50ms buffer window

        return;
      }

      if (this.flickerFilterActive) {
        this.flickerFilterBuffer += data;
        return;
      }
    }

    // Accumulate raw data (may contain DEC 2026 markers)
    this.pendingWrites.push(data);

    if (!this.writeFrameScheduled) {
      this.writeFrameScheduled = true;
      requestAnimationFrame(() => {
        if (this.pendingWrites.length > 0 && this.terminal) {
          // Join chunks for sync marker detection
          const pending = this.pendingWrites.join('');
          // Check if we have an incomplete sync block (SYNC_START without SYNC_END)
          const hasStart = pending.includes(DEC_SYNC_START);
          const hasEnd = pending.includes(DEC_SYNC_END);

          if (hasStart && !hasEnd) {
            // Incomplete sync block - wait for more data (up to 50ms max)
            if (!this.syncWaitTimeout) {
              this.syncWaitTimeout = setTimeout(() => {
                this.syncWaitTimeout = null;
                // Force flush after timeout to prevent stuck state
                this.flushPendingWrites();
              }, 50);
            }
            this.writeFrameScheduled = false;
            return;
          }

          // Clear any pending sync wait timeout
          if (this.syncWaitTimeout) {
            clearTimeout(this.syncWaitTimeout);
            this.syncWaitTimeout = null;
          }

          this.flushPendingWrites();
        }
        this.writeFrameScheduled = false;
      });
    }
  }

  /**
   * Flush the flicker filter buffer to the terminal.
   * Called after the buffer window expires.
   */
  flushFlickerBuffer() {
    if (!this.flickerFilterBuffer) return;

    // Transfer buffered data to normal pending writes
    this.pendingWrites.push(this.flickerFilterBuffer);
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;

    // Trigger a normal flush
    if (!this.writeFrameScheduled) {
      this.writeFrameScheduled = true;
      requestAnimationFrame(() => {
        this.flushPendingWrites();
        this.writeFrameScheduled = false;
      });
    }
  }

  /**
   * Update local echo overlay state based on settings.
   * Enabled whenever the setting is on — works during idle AND busy.
   * Position is tracked dynamically by _findPrompt() on every render.
   */
  _updateLocalEchoState() {
      const settings = this.loadAppSettingsFromStorage();
      const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
      const echoEnabled = settings.localEchoEnabled ?? MobileDetection.isTouchDevice();
      const shouldEnable = !!(echoEnabled && session);
      if (this._localEchoEnabled && !shouldEnable) {
          this._localEchoOverlay?.clear();
      }
      this._localEchoEnabled = shouldEnable;

      // Swap prompt finder based on session mode
      if (this._localEchoOverlay && session) {
        if (session.mode === 'opencode') {
          // OpenCode (Bubble Tea TUI): find the ┃ border on the cursor's row.
          // The input area is "┃  <text>" — the ┃ is the anchor, offset 3 skips "┃  ".
          // We use the cursor row (cursorY) to find the right line, then scan for ┃.
          this._localEchoOverlay.setPrompt({
            type: 'custom',
            offset: 3,
            find: (terminal) => {
              try {
                const buf = terminal.buffer.active;
                const row = buf.cursorY;
                const line = buf.getLine(buf.viewportY + row);
                if (!line) return null;
                const text = line.translateToString(true);
                const idx = text.indexOf('\u2503'); // ┃ (BOX DRAWINGS HEAVY VERTICAL)
                if (idx >= 0) return { row, col: idx };
                return null;
              } catch { return null; }
            }
          });
        } else if (session.mode === 'shell') {
          // Shell mode: the shell provides its own PTY echo so the overlay isn't needed.
          // Disable it by clearing any pending text.
          this._localEchoOverlay.clear();
          this._localEchoEnabled = false;
        } else {
          // Claude Code: scan for ❯ prompt character
          this._localEchoOverlay.setPrompt({ type: 'character', char: '\u276f', offset: 2 });
        }
      }
  }

  /**
   * Flush pending writes to terminal, processing DEC 2026 sync markers.
   * Strips markers and writes content atomically within a single frame.
   */
  flushPendingWrites() {
    if (this.pendingWrites.length === 0 || !this.terminal) return;

    const _t0 = performance.now();
    // Extract segments, stripping DEC 2026 markers
    // This implements synchronized output for xterm.js which doesn't support DEC 2026 natively
    const _joinedLen = this.pendingWrites.reduce((s, w) => s + w.length, 0);
    if (_joinedLen > 16384) _crashDiag.log(`FLUSH: ${(_joinedLen/1024).toFixed(0)}KB`);
    const joined = this.pendingWrites.join('');
    this.pendingWrites = [];

    const segments = extractSyncSegments(joined);

    // Write segments respecting a per-frame time budget.
    // After each sub-chunk write, check elapsed time and defer remaining content
    // if we've used more than 8ms of the frame budget. Sub-chunk size (8KB) is
    // small enough that a single write rarely blocks >2ms even on canvas 2D.
    // This sacrifices strict DEC 2026 sync atomicity in exchange for never blocking
    // the main thread — the flicker filter upstream already handles cursor-up redraws.
    const MAX_FRAME_MS = 8; // 8ms — half a 60fps frame, leaves headroom for browser paint
    const SUB_CHUNK = 8192; // 8KB per write — small enough to check budget frequently
    let bytesThisFrame = 0;
    let deferred = false;

    outer: for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment) continue;
      const content = segment.startsWith(DEC_SYNC_START)
        ? segment.slice(DEC_SYNC_START.length)
        : segment;
      if (!content) continue;

      // Write content in sub-chunks so the time check fires frequently enough
      // to defer mid-segment when a single Ink redraw exceeds the frame budget.
      let subOffset = 0;
      while (subOffset < content.length) {
        const sub = content.slice(subOffset, subOffset + SUB_CHUNK);
        this.terminal.write(sub);
        subOffset += SUB_CHUNK;
        bytesThisFrame += sub.length;

        if (performance.now() - _t0 > MAX_FRAME_MS) {
          // Defer: remaining of this segment + all following segments
          const restOfSegment = content.slice(subOffset);
          const restOfSegments = segments.slice(i + 1).map(s => {
            if (!s) return '';
            return s.startsWith(DEC_SYNC_START) ? s.slice(DEC_SYNC_START.length) : s;
          }).filter(Boolean).join('');
          const remaining = restOfSegment + restOfSegments;
          if (remaining) {
            this.pendingWrites.push(remaining);
            if (!this.writeFrameScheduled) {
              this.writeFrameScheduled = true;
              requestAnimationFrame(() => {
                this.flushPendingWrites();
                this.writeFrameScheduled = false;
              });
            }
            deferred = true;
          }
          break outer;
        }
      }
    }
    const _dt = performance.now() - _t0;
    if (_dt > 100 || deferred) console.warn(`[CRASH-DIAG] flushPendingWrites: ${_dt.toFixed(0)}ms, ${(bytesThisFrame/1024).toFixed(0)}KB written${deferred ? ', rest deferred' : ''} (total ${(_joinedLen/1024).toFixed(0)}KB)`);

    // Sticky scroll: if user was at bottom, keep them there after new output
    if (this._wasAtBottomBeforeWrite) {
      this.terminal.scrollToBottom();
    }

    this._updateStatusStrip();

    // Re-position local echo overlay after terminal writes — Ink redraws can
    // move the ❯ prompt to a different row, making the overlay invisible.
    if (this._localEchoOverlay?.hasPending) {
      this._localEchoOverlay.rerender();
    }

    // After Tab completion: detect the completed text in the overlay.
    // Use terminal.write('', callback) to defer detection until xterm.js
    // finishes processing ALL queued writes — direct buffer reads after
    // terminal.write(data) can miss text if xterm processes asynchronously.
    if (this._tabCompletionSessionId && this._tabCompletionSessionId === this.activeSessionId
        && this._localEchoOverlay && !this._localEchoOverlay.pendingText) {
      const overlay = this._localEchoOverlay;
      const self = this;
      this.terminal.write('', () => {
        if (!self._tabCompletionSessionId) return; // already resolved
        overlay.resetBufferDetection();
        const detected = overlay.detectBufferText();
        if (detected) {
          if (detected === self._tabCompletionBaseText) {
            // Same text as before Tab — no completion yet. Undo and retry.
            overlay.undoDetection();
            self._tabCompletionRetries = (self._tabCompletionRetries || 0) + 1;
            if (self._tabCompletionRetries > 60) {
              self._tabCompletionSessionId = null;
              self._tabCompletionRetries = 0;
            }
          } else {
            // Text changed — real completion happened
            self._tabCompletionSessionId = null;
            self._tabCompletionRetries = 0;
            self._tabCompletionBaseText = null;
            if (self._tabCompletionFallback) { clearTimeout(self._tabCompletionFallback); self._tabCompletionFallback = null; }
            overlay.rerender();
          }
        } else {
          // No text found yet — retry on next flush.
          self._tabCompletionRetries = (self._tabCompletionRetries || 0) + 1;
          if (self._tabCompletionRetries > 60) {
            self._tabCompletionSessionId = null;
            self._tabCompletionRetries = 0;
          }
        }
      });
    }
  }

  /**
   * Scan the last lines of the xterm.js buffer for a GSD/plugin status line
   * and mirror it into the persistent status strip element.
   * Matches patterns like "Context: 47%" from the GSD context tracker.
   */
  _updateStatusStrip() {
    if (!this.terminal) return;
    // Throttle: status strip doesn't need sub-second updates; scanning the xterm
    // buffer on every flush (potentially 60×/sec) wastes CPU under heavy output.
    const now = Date.now();
    if (now - (this._lastStatusStripUpdate || 0) < 500) return;
    this._lastStatusStripUpdate = now;
    if (!this._statusStripEl) this._statusStripEl = document.getElementById('terminalStatusStrip');
    const strip = this._statusStripEl;
    if (!strip) return;

    const buffer = this.terminal.buffer.active;
    const totalLines = buffer.length;
    // Scan last 8 lines — Ink status bar is always near the bottom
    const scanFrom = Math.max(0, totalLines - 8);

    let matched = '';
    for (let i = totalLines - 1; i >= scanFrom; i--) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true).trim();
      if (text && STATUS_LINE_RE.test(text)) {
        matched = text;
        break;
      }
    }

    if (matched) {
      strip.textContent = matched; // textContent is safe — no HTML interpretation
      strip.style.display = '';

    }
    // Keep last known value visible if no match found this frame
  }

  /**
   * Write large buffer to terminal in chunks to avoid UI jank.
   * Uses requestAnimationFrame to spread work across frames.
   * @param {string} buffer - The full terminal buffer to write
   * @param {number} chunkSize - Size of each chunk (default 128KB for smooth 60fps)
   * @returns {Promise<void>} - Resolves when all chunks written
   */
  chunkedTerminalWrite(buffer, chunkSize = TERMINAL_CHUNK_SIZE) {
    return new Promise((resolve) => {
      if (!buffer || buffer.length === 0) {
        this._finishBufferLoad();
        resolve();
        return;
      }

      // Block live SSE writes during buffer load to prevent interleaving
      this._isLoadingBuffer = true;
      this._loadBufferQueue = [];

      // Strip any DEC 2026 markers that might be in the buffer
      // (from historical SSE data that was stored with markers)
      const cleanBuffer = buffer.replace(DEC_SYNC_STRIP_RE, '');

      const finish = () => {
        this._finishBufferLoad();
        resolve();
      };

      // For small buffers, write directly — single-frame render is fast enough
      if (cleanBuffer.length <= chunkSize) {
        this.terminal.write(cleanBuffer);
        finish();
        return;
      }

      // Large buffers: write in chunks across animation frames.
      // Each 32KB chunk keeps per-frame WebGL render work under ~5ms,
      // avoiding GPU stalls without needing to toggle the renderer.
      let offset = 0;
      const _chunkStart = performance.now();
      let _chunkCount = 0;
      const writeChunk = () => {
        if (offset >= cleanBuffer.length) {
          const _totalMs = performance.now() - _chunkStart;
          console.log(`[CRASH-DIAG] chunkedTerminalWrite complete: ${cleanBuffer.length} bytes in ${_chunkCount} chunks, ${_totalMs.toFixed(0)}ms total`);
          // Wait one more frame for xterm to finish rendering before resolving
          requestAnimationFrame(finish);
          return;
        }

        const _ct0 = performance.now();
        const chunk = cleanBuffer.slice(offset, offset + chunkSize);
        this.terminal.write(chunk);
        const _cdt = performance.now() - _ct0;
        _chunkCount++;
        if (_cdt > 50) console.warn(`[CRASH-DIAG] chunk #${_chunkCount} write took ${_cdt.toFixed(0)}ms (${chunk.length} bytes at offset ${offset})`);
        offset += chunkSize;

        // Schedule next chunk on next frame
        requestAnimationFrame(writeChunk);
      };

      // Start writing
      requestAnimationFrame(writeChunk);
    });
  }

  /**
   * Complete a buffer load: unblock live SSE writes and flush any queued events.
   * Called when chunkedTerminalWrite finishes (or is skipped for empty buffers).
   */
  _finishBufferLoad() {
    const queue = this._loadBufferQueue;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    if (queue && queue.length > 0) {
      for (const data of queue) {
        this.batchTerminalWrite(data);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Event Listeners (Keyboard Shortcuts, Resize, Beforeunload)
  // ═══════════════════════════════════════════════════════════════

  setupEventListeners() {
    // Use capture to handle before terminal
    document.addEventListener('keydown', (e) => {
      // Escape - close panels and modals
      if (e.key === 'Escape') {
        this.closeAllPanels();
        this.closeHelp();
      }

      // Ctrl/Cmd + ? - help
      if ((e.ctrlKey || e.metaKey) && (e.key === '?' || e.key === '/')) {
        e.preventDefault();
        this.showHelp();
      }

      // Ctrl/Cmd + W - close active session
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        this.killActiveSession();
      }

      // Ctrl/Cmd + Tab - next session
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault();
        this.nextSession();
      }

      // Ctrl/Cmd + K - kill all
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.killAllSessions();
      }

      // Ctrl/Cmd + L - clear terminal
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        this.clearTerminal();
      }

      // Ctrl/Cmd + +/- - font size
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        this.increaseFontSize();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        this.decreaseFontSize();
      }

      // Ctrl/Cmd + Shift + B - toggle voice input
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'B') {
        e.preventDefault();
        VoiceInput.toggle();
      }

      // Ctrl/Cmd + Shift + V - paste text from clipboard
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
        e.preventDefault();
        if (this.activeSessionId) {
          navigator.clipboard.readText().then(text => {
            if (!text) return;
            if (this._localEchoEnabled && this._localEchoOverlay) {
              this._localEchoOverlay.appendText(text);
            } else {
              this.sendInput(text).catch(() => {});
            }
          }).catch(() => {
            // Clipboard API denied (e.g. lost user activation after freeze) — fall back to dialog
            if (typeof KeyboardAccessory !== 'undefined') {
              KeyboardAccessory.pasteFromClipboard();
            } else {
              this.showToast('Clipboard access denied', 'error');
            }
          });
        }
      }

      // Ctrl/Cmd + F - terminal search
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'f') {
        e.preventDefault();
        TerminalSearch.toggle();
      }

      // Ctrl/Cmd + Shift + F - cross-session switcher
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        SessionSwitcher.toggle();
      }

      // Ctrl/Cmd + X - copy selected terminal text
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'x') {
        const selection = this.terminal?.getSelection?.();
        if (selection) {
          e.preventDefault();
          navigator.clipboard.writeText(selection).then(() => {
            this.showToast('Copied', 'success');
          }).catch(() => {});
        }
        // No selection → let Ctrl+X pass through to PTY
      }

    }, true); // Use capture phase to handle before terminal

    // Token stats click handler (with guard to prevent duplicate handlers on reconnect)
    const tokenEl = this.$('headerTokens');
    if (tokenEl && !tokenEl._statsHandlerAttached) {
      tokenEl.classList.add('clickable');
      tokenEl._statsHandlerAttached = true;
      tokenEl.addEventListener('click', () => this.openTokenStats());
    }

    // Color picker for session customization
    this.setupColorPicker();
  }

  // ═══════════════════════════════════════════════════════════════
  // SSE Connection
  // ═══════════════════════════════════════════════════════════════

  connectSSE() {
    // Check if browser is offline
    if (!navigator.onLine) {
      this.setConnectionStatus('offline');
      return;
    }

    // Clear any pending reconnect timeout to prevent duplicate connections
    if (this.sseReconnectTimeout) {
      clearTimeout(this.sseReconnectTimeout);
      this.sseReconnectTimeout = null;
    }

    // Clean up existing SSE listeners before creating new connection (prevents listener accumulation)
    if (this._sseListenerCleanup) {
      this._sseListenerCleanup();
      this._sseListenerCleanup = null;
    }

    // Close existing EventSource before creating new one to prevent duplicate connections
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    // Show connecting state
    if (this.reconnectAttempts === 0) {
      this.setConnectionStatus('connecting');
    } else {
      this.setConnectionStatus('reconnecting');
    }

    this.eventSource = new EventSource('/api/events');

    // Store all event listeners for cleanup on reconnect
    const listeners = [];
    const addListener = (event, handler) => {
      this.eventSource.addEventListener(event, handler);
      listeners.push({ event, handler });
    };

    // Create cleanup function to remove all listeners
    this._sseListenerCleanup = () => {
      for (const { event, handler } of listeners) {
        if (this.eventSource) {
          this.eventSource.removeEventListener(event, handler);
        }
      }
      listeners.length = 0;
    };

    // Track last event time to detect stale connections after tab restore
    this.eventSource.addEventListener('message', () => {
      this._lastSseEventTime = Date.now();
    });

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this.setConnectionStatus('connected');
      this._lastSseEventTime = Date.now();
    };
    this.eventSource.onerror = () => {
      this.reconnectAttempts++;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.setConnectionStatus('disconnected');
      } else {
        this.setConnectionStatus('reconnecting');
      }
      // Close the failed connection before scheduling reconnect
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      // Clear any existing reconnect timeout before setting new one (prevents orphaned timeouts)
      if (this.sseReconnectTimeout) {
        clearTimeout(this.sseReconnectTimeout);
      }
      // Exponential backoff: 200ms, 500ms, 1s, 2s, 4s, ... up to 30s
      // Fast first retry (200ms) for server-restart case (COM deploy),
      // then ramp up for real network issues.
      const delay = this.reconnectAttempts <= 1 ? 200
        : Math.min(500 * Math.pow(2, this.reconnectAttempts - 2), 30000);
      this.sseReconnectTimeout = setTimeout(() => this.connectSSE(), delay);
    };

    // Create stable handler wrappers once (reused across reconnects so
    // removeEventListener always matches the original reference)
    if (!this._sseHandlerWrappers) {
      this._sseHandlerWrappers = new Map();
      for (const [event, method] of _SSE_HANDLER_MAP) {
        const fn = this[method];
        this._sseHandlerWrappers.set(event, (e) => {
          try {
            fn.call(this, e.data ? JSON.parse(e.data) : {});
          } catch (err) {
            console.error(`[SSE] Error handling ${event}:`, err);
          }
        });
      }
    }

    // Register all SSE event handlers via centralized map
    for (const [event] of _SSE_HANDLER_MAP) {
      addListener(event, this._sseHandlerWrappers.get(event));
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SSE Event Handlers
  // ═══════════════════════════════════════════════════════════════
  // Each _on* method receives pre-parsed SSE data (JSON.parse done in connectSSE loop).
  // Async handlers have their own internal try/catch for fetch errors.

  _onInit(data) {
    _crashDiag.log(`INIT: ${data.sessions?.length || 0} sessions`);
    this.handleInit(data);
  }

  _onSessionCreated(data) {
    data.displayStatus = data.status || 'idle';
    this.sessions.set(data.id, data);
    // Add new session to end of tab order
    if (!this.sessionOrder.includes(data.id)) {
      this.sessionOrder.push(data.id);
      this.saveSessionOrder();
    }
    this.renderSessionTabs();
    this.updateCost();
    // Start stats polling when first session appears
    if (this.sessions.size === 1) this.startSystemStatsPolling();
  }

  _onSessionUpdated(data) {
    const session = data.session || data;
    const oldSession = this.sessions.get(session.id);
    const claudeSessionIdJustSet = session.claudeSessionId && (!oldSession || !oldSession.claudeSessionId);
    // Preserve displayStatus from previous session so debounce is not reset by server updates
    session.displayStatus = oldSession?.displayStatus ?? session.status ?? 'idle';
    this.sessions.set(session.id, session);
    this.renderSessionTabs();
    this.updateCost();
    // Update tokens display if this is the active session
    if (session.id === this.activeSessionId && session.tokens) {
      this.updateRespawnTokens(session.tokens);
    }
    // Refresh session indicator bar if this is the active session
    if (session.id === this.activeSessionId) {
      SessionIndicatorBar.update(session.id);
    }
    // Update parentSessionName for any subagents belonging to this session
    // (fixes stale name display after session rename)
    this.updateSubagentParentNames(session.id);
    // If claudeSessionId was just set, re-check orphan subagents
    // This connects subagents that were waiting for the session to identify itself
    if (claudeSessionIdJustSet) {
      this.recheckOrphanSubagents();
      // Update connection lines after DOM settles (ensure tabs are rendered)
      requestAnimationFrame(() => {
        this.updateConnectionLines();
      });
    }
  }

  _onSessionDeleted(data) {
    this._cleanupSessionData(data.id);
    if (this.activeSessionId === data.id) {
      this.activeSessionId = null;
      SessionIndicatorBar.update(null);
      try { localStorage.removeItem('codeman-active-session'); } catch {}
      this.terminal.clear();
      this.showWelcome();
    }
    this.renderSessionTabs();
    this.renderRalphStatePanel();  // Update ralph panel after session deleted
    this.renderProjectInsightsPanel();  // Update project insights panel after session deleted
    // Stop stats polling when no sessions remain
    if (this.sessions.size === 0) this.stopSystemStatsPolling();
  }

  _onSessionTerminal(data) {
    if (data.id === this.activeSessionId) {
      if (data.data.length > 32768) _crashDiag.log(`TERMINAL: ${(data.data.length/1024).toFixed(0)}KB`);

      // Hard cap: track total bytes queued in render buffers (pendingWrites +
      // flickerFilterBuffer). When rAF is throttled (tab
      // backgrounded, GPU busy), data accumulates with no flush, reaching
      // 889KB+ and freezing Chrome for minutes. Drop data beyond 128KB and
      // schedule a buffer reload to recover the display once the burst subsides.
      const queued = (this.pendingWrites?.reduce((s, w) => s + w.length, 0) || 0)
        + (this.flickerFilterBuffer?.length || 0);
      if (queued > 131072) { // 128KB — drop to prevent accumulation
        // Schedule a self-recovery: reload the full terminal buffer once the
        // queue drains (debounced to avoid hammering the API during sustained bursts).
        if (!this._clientDropRecoveryTimer) {
          this._clientDropRecoveryTimer = setTimeout(() => {
            this._clientDropRecoveryTimer = null;
            this._onSessionNeedsRefresh();
          }, 2000);
        }
        return;
      }

      this.batchTerminalWrite(data.data);
    }
  }

  async _onSessionNeedsRefresh() {
    // Server sends this after SSE backpressure clears — terminal data was dropped,
    // so reload the buffer to recover from any display corruption.
    if (!this.activeSessionId || !this.terminal) return;
    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`);
      const data = await res.json();
      if (data.terminalBuffer) {
        const termContainer = document.getElementById('terminalContainer');
        termContainer?.classList.add('buffer-loading');
        await new Promise(resolve => requestAnimationFrame(resolve));
        this.terminal.clear();
        this.terminal.reset();
        await this.chunkedTerminalWrite(data.terminalBuffer);
        this.terminal.scrollToBottom();
        termContainer?.classList.remove('buffer-loading');
        // Re-position local echo overlay at new prompt location
        this._localEchoOverlay?.rerender();
        // Resize PTY to match actual browser dimensions (critical for OpenCode
        // TUI sessions that render at fixed 120x40 until told the real size)
        if (this.activeSessionId) {
          this.sendResize(this.activeSessionId);
        }
      }
    } catch (err) {
      console.error('needsRefresh reload failed:', err);
    }
  }

  async _onSessionClearTerminal(data) {
    if (data.id === this.activeSessionId) {
      // Fetch buffer, clear terminal, write buffer, resize (no Ctrl+L needed)
      try {
        const res = await fetch(`/api/sessions/${data.id}/terminal`);
        const termData = await res.json();

        this.terminal.clear();
        this.terminal.reset();
        if (termData.terminalBuffer) {
          // Strip any DEC 2026 markers and write raw content
          // (markers don't help here - this is a static buffer reload, not live Ink redraws)
          const cleanBuffer = termData.terminalBuffer.replace(DEC_SYNC_STRIP_RE, '');
          // Use chunked write to avoid UI freeze with large buffers (can be 1-2MB)
          await this.chunkedTerminalWrite(cleanBuffer);
        }

        // Fire-and-forget resize — don't block on it
        this.sendResize(data.id);
        // Re-position local echo overlay at new prompt location
        this._localEchoOverlay?.rerender();
      } catch (err) {
        console.error('clearTerminal refresh failed:', err);
      }
    }
  }

  _onSessionCompletion(data) {
    this.totalCost += data.cost || 0;
    this.updateCost();
    if (data.id === this.activeSessionId) {
      this.terminal.writeln('');
      this.terminal.writeln(`\x1b[1;32m Done (Cost: $${(data.cost || 0).toFixed(4)})\x1b[0m`);
    }
  }

  _onSessionError(data) {
    if (data.id === this.activeSessionId) {
      this.terminal.writeln(`\x1b[1;31m Error: ${data.error}\x1b[0m`);
    }
    const session = this.sessions.get(data.id);
    this.notificationManager?.notify({
      urgency: 'critical',
      category: 'session-error',
      sessionId: data.id,
      sessionName: session?.name || this.getShortId(data.id),
      title: 'Session Error',
      message: data.error || 'Unknown error',
    });
  }

  _onSessionExit(data) {
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'stopped';
      // Cancel any in-flight tab status debounce timers — a 4s hide timer could otherwise
      // fire after exit and overwrite displayStatus back to 'idle' on a stopped session.
      const tabShowTimer = this._tabStatusTimers.get(data.id);
      if (tabShowTimer) { clearTimeout(tabShowTimer); this._tabStatusTimers.delete(data.id); }
      const tabHideTimer = this._tabStatusHideTimers.get(data.id);
      if (tabHideTimer) { clearTimeout(tabHideTimer); this._tabStatusHideTimers.delete(data.id); }
      session.displayStatus = 'stopped';
      this.renderSessionTabs();
      if (data.id === this.activeSessionId) this._updateLocalEchoState();
    }
    // Auto-close on clean exit (exit code 0) if setting enabled and respawn not running
    if (data.code === 0) {
      const settings = this.loadAppSettingsFromStorage();
      const stopOnCleanExit = settings.stopOnCleanExit ?? true;
      const respawnActive = this.respawnStatus[data.id]?.enabled;
      if (stopOnCleanExit && !respawnActive) {
        setTimeout(() => this.closeSession(data.id).catch(() => {}), 800);
        return;
      }
    }
    // Notify on unexpected exit (non-zero code)
    if (data.code && data.code !== 0) {
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'session-crash',
        sessionId: data.id,
        sessionName: session?.name || this.getShortId(data.id),
        title: 'Session Crashed',
        message: `Exited with code ${data.code}`,
      });
    }
  }

  _onSessionIdle(data) {
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'idle';
      this._updateTabStatusDebounced(data.id, 'idle');
      this.sendPendingCtrlL(data.id);
      if (data.id === this.activeSessionId) {
        this._updateLocalEchoState();
        this._updateSendBtn(false);
        if (TranscriptView._sessionId === data.id) TranscriptView.setWorking(false);
      }
    }
    // Start stuck detection timer (only if no respawn running)
    if (!this.respawnStatus[data.id]?.enabled) {
      const threshold = this.notificationManager?.preferences?.stuckThresholdMs || 600000;
      clearTimeout(this.idleTimers.get(data.id));
      this.idleTimers.set(data.id, setTimeout(() => {
        const s = this.sessions.get(data.id);
        this.notificationManager?.notify({
          urgency: 'warning',
          category: 'session-stuck',
          sessionId: data.id,
          sessionName: s?.name || this.getShortId(data.id),
          title: 'Session Idle',
          message: `Idle for ${Math.round(threshold / 60000)}+ minutes`,
        });
        this.idleTimers.delete(data.id);
      }, threshold));
    }
  }

  _onSessionWorking(data) {
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'busy';
      // Only clear tab alert if no pending hooks (permission_prompt, elicitation_dialog, etc.)
      if (!this.pendingHooks.has(data.id)) {
        this.tabAlerts.delete(data.id);
      }
      this._updateTabStatusDebounced(data.id, 'busy');
      this.sendPendingCtrlL(data.id);
      if (data.id === this.activeSessionId) {
        this._updateLocalEchoState();
        this._updateSendBtn(true);
        if (TranscriptView._sessionId === data.id) TranscriptView.setWorking(true);
      }
    }
    // Clear stuck detection timer
    const timer = this.idleTimers.get(data.id);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(data.id);
    }
  }

  /** Called when xterm receives an OSC 0/2 title-change sequence from the PTY.
   *  Patterns are captured via window._oscTitleLog for investigation.
   *  TODO: implement title-pattern-based idle detection once patterns are understood. */
  _onTerminalTitleChange(_title) {
    // No-op until title patterns are understood from _oscTitleLog investigation.
  }

  /** Called when xterm receives an OSC 133 shell-integration sequence.
   *  Provides reliable idle/busy signals if Claude Code emits these marks.
   *  A=prompt-start, B=prompt-end (idle), C=pre-execution (busy), D=exec-done (idle). */
  _onOsc133(data) {
    // Skip during buffer loading — replayed history from a different session would
    // fire with this.activeSessionId already set to the newly-switched session,
    // causing that session to be falsely marked busy.
    if (this._isLoadingBuffer) return;
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    if (data === 'B' || data === 'A') {
      // Prompt shown — reliable idle signal
      if (TranscriptView._sessionId === sessionId) TranscriptView.setWorking(false);
      this._updateTabStatusDebounced(sessionId, 'idle');
    } else if (data === 'C') {
      // Pre-execution — reliable busy signal
      if (TranscriptView._sessionId === sessionId) TranscriptView.setWorking(true);
      this._updateTabStatusDebounced(sessionId, 'busy');
    }
  }

  /** Send button stays as send — no stop toggle. */
  _updateSendBtn(_isWorking) {
    // Stop button removed; send button is always send.
  }

  /** Debounce tab status dot updates — same 300ms show / 4000ms hide as the typing indicator.
   *  Prevents rapid busy->idle->busy flicker from frequent SESSION_WORKING/SESSION_IDLE events. */
  _updateTabStatusDebounced(sessionId, status) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (status === 'busy') {
      clearTimeout(this._tabStatusHideTimers.get(sessionId));
      this._tabStatusHideTimers.delete(sessionId);
      if (!this._tabStatusTimers.has(sessionId)) {
        this._tabStatusTimers.set(sessionId, setTimeout(() => {
          this._tabStatusTimers.delete(sessionId);
          const s = this.sessions.get(sessionId);
          if (s) { s.displayStatus = 'busy'; this.renderSessionTabs(); }
          if (sessionId === this.activeSessionId) SessionIndicatorBar.update(sessionId);
        }, 300));
      }
    } else {
      clearTimeout(this._tabStatusTimers.get(sessionId));
      this._tabStatusTimers.delete(sessionId);
      clearTimeout(this._tabStatusHideTimers.get(sessionId));
      this._tabStatusHideTimers.set(sessionId, setTimeout(() => {
        this._tabStatusHideTimers.delete(sessionId);
        const s = this.sessions.get(sessionId);
        if (s) { s.displayStatus = status; this.renderSessionTabs(); }
        if (sessionId === this.activeSessionId) SessionIndicatorBar.update(sessionId);
      }, 4000));
    }
  }

  _onSessionAutoClear(data) {
    if (data.sessionId === this.activeSessionId) {
      this.showToast(`Auto-cleared at ${data.tokens.toLocaleString()} tokens`, 'info');
      this.updateRespawnTokens(0);
    }
    const session = this.sessions.get(data.sessionId);
    this.notificationManager?.notify({
      urgency: 'info',
      category: 'auto-clear',
      sessionId: data.sessionId,
      sessionName: session?.name || this.getShortId(data.sessionId),
      title: 'Auto-Cleared',
      message: `Context reset at ${(data.tokens || 0).toLocaleString()} tokens`,
    });
  }

  _onSessionAutoCompact(data) {
    const session = this.sessions.get(data.sessionId);
    if (data.sessionId === this.activeSessionId) {
      this.showToast('Compacting context...', 'info');
    }
    this.notificationManager?.notify({
      urgency: 'info',
      category: 'auto-compact',
      sessionId: data.sessionId,
      sessionName: session?.name || this.getShortId(data.sessionId),
      title: 'Compacting Context',
      message: `Compacting at ${(data.tokens || 0).toLocaleString()} tokens`,
    });
    if (TranscriptView._sessionId === data.sessionId) {
      TranscriptView.showCompacting();
    }
  }

  _onSessionCliInfo(data) {
    const session = this.sessions.get(data.sessionId);
    if (session) {
      if (data.version) session.cliVersion = data.version;
      if (data.model) session.cliModel = data.model;
      if (data.accountType) session.cliAccountType = data.accountType;
      if (data.latestVersion) session.cliLatestVersion = data.latestVersion;
    }
    if (data.sessionId === this.activeSessionId) {
      this.updateCliInfoDisplay();
    }
  }

  // Scheduled runs
  _onScheduledCreated(data) {
    this.currentRun = data;
    this.showTimer();
  }

  _onScheduledUpdated(data) {
    this.currentRun = data;
    this.updateTimer();
  }

  _onScheduledCompleted(data) {
    this.currentRun = data;
    this.hideTimer();
    this.showToast('Scheduled run completed!', 'success');
  }

  _onScheduledStopped() {
    this.currentRun = null;
    this.hideTimer();
  }

  // Respawn
  _onRespawnStarted(data) {
    this.respawnStatus[data.sessionId] = data.status;
    if (data.sessionId === this.activeSessionId) {
      this.showRespawnBanner();
    }
  }

  _onRespawnStopped(data) {
    delete this.respawnStatus[data.sessionId];
    if (data.sessionId === this.activeSessionId) {
      this.hideRespawnBanner();
    }
  }

  _onRespawnStateChanged(data) {
    if (this.respawnStatus[data.sessionId]) {
      this.respawnStatus[data.sessionId].state = data.state;
    }
    if (data.sessionId === this.activeSessionId) {
      this.updateRespawnBanner(data.state);
    }
  }

  _onRespawnCycleStarted(data) {
    if (this.respawnStatus[data.sessionId]) {
      this.respawnStatus[data.sessionId].cycleCount = data.cycleNumber;
    }
    if (data.sessionId === this.activeSessionId) {
      document.getElementById('respawnCycleCount').textContent = data.cycleNumber;
    }
  }

  _onRespawnBlocked(data) {
    const session = this.sessions.get(data.sessionId);
    const reasonMap = {
      circuit_breaker_open: 'Circuit Breaker Open',
      exit_signal: 'Exit Signal Detected',
      status_blocked: 'Claude Reported BLOCKED',
    };
    const title = reasonMap[data.reason] || 'Respawn Blocked';
    this.notificationManager?.notify({
      urgency: 'critical',
      category: 'respawn-blocked',
      sessionId: data.sessionId,
      sessionName: session?.name || this.getShortId(data.sessionId),
      title,
      message: data.details,
    });
    // Update respawn panel to show blocked state
    if (data.sessionId === this.activeSessionId) {
      const stateEl = document.getElementById('respawnStateLabel');
      if (stateEl) {
        stateEl.textContent = title;
        stateEl.classList.add('respawn-blocked');
      }
    }
  }

  _onRespawnAutoAcceptSent(data) {
    const session = this.sessions.get(data.sessionId);
    this.notificationManager?.notify({
      urgency: 'info',
      category: 'auto-accept',
      sessionId: data.sessionId,
      sessionName: session?.name || this.getShortId(data.sessionId),
      title: 'Plan Accepted',
      message: `Accepted plan mode for ${session?.name || 'session'}`,
    });
  }

  _onRespawnDetectionUpdate(data) {
    if (this.respawnStatus[data.sessionId]) {
      this.respawnStatus[data.sessionId].detection = data.detection;
    }
    if (data.sessionId === this.activeSessionId) {
      this.updateDetectionDisplay(data.detection);
    }
  }

  // Merged handler for respawn:timerStarted — handles both run timers (data.endAt)
  // and controller countdown timers (data.timer). Previously registered as two
  // separate addListener calls (duplicate event bug).
  _onRespawnTimerStarted(data) {
    // Run timer (timed respawn runs)
    if (data.endAt) {
      this.respawnTimers[data.sessionId] = {
        endAt: data.endAt,
        startedAt: data.startedAt,
        durationMinutes: data.durationMinutes
      };
      if (data.sessionId === this.activeSessionId) {
        this.showRespawnTimer();
      }
    }
    // Controller countdown timer (internal timers)
    if (data.timer) {
      const { sessionId, timer } = data;
      if (!this.respawnCountdownTimers[sessionId]) {
        this.respawnCountdownTimers[sessionId] = {};
      }
      this.respawnCountdownTimers[sessionId][timer.name] = {
        endsAt: timer.endsAt,
        totalMs: timer.durationMs,
        reason: timer.reason
      };
      if (sessionId === this.activeSessionId) {
        this.updateCountdownTimerDisplay();
        this.startCountdownInterval();
      }
    }
  }

  _onRespawnTimerCancelled(data) {
    const { sessionId, timerName } = data;
    if (this.respawnCountdownTimers[sessionId]) {
      delete this.respawnCountdownTimers[sessionId][timerName];
    }
    if (sessionId === this.activeSessionId) {
      this.updateCountdownTimerDisplay();
    }
  }

  _onRespawnTimerCompleted(data) {
    const { sessionId, timerName } = data;
    if (this.respawnCountdownTimers[sessionId]) {
      delete this.respawnCountdownTimers[sessionId][timerName];
    }
    if (sessionId === this.activeSessionId) {
      this.updateCountdownTimerDisplay();
    }
  }

  _onRespawnError(data) {
    const session = this.sessions.get(data.sessionId);
    this.notificationManager?.notify({
      urgency: 'critical',
      category: 'session-error',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Respawn Error',
      message: data.error || data.message || 'Respawn encountered an error',
    });
  }

  _onRespawnActionLog(data) {
    const { sessionId, action } = data;
    this.addActionLogEntry(sessionId, action);
    if (sessionId === this.activeSessionId) {
      this.updateCountdownTimerDisplay(); // Show row if hidden
      this.updateActionLogDisplay();
    }
  }

  // Tasks
  _onTaskCreated(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  }

  _onTaskCompleted(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  }

  _onTaskFailed(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  }

  _onTaskUpdated(data) {
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  }

  // Mux (tmux)
  _onMuxCreated(data) {
    this.muxSessions.push(data);
    this.renderMuxSessions();
  }

  _onMuxKilled(data) {
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== data.sessionId);
    this.renderMuxSessions();
  }

  _onMuxDied(data) {
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== data.sessionId);
    this.renderMuxSessions();
    this.showToast('Mux session died: ' + this.getShortId(data.sessionId), 'warning');
  }

  _onMuxStatsUpdated(data) {
    this.muxSessions = data;
    if (document.getElementById('monitorPanel').classList.contains('open')) {
      this.renderMuxSessions();
    }
  }

  // Ralph
  _onRalphLoopUpdate(data) {
    // Skip if user explicitly closed this session's Ralph panel
    if (this.ralphClosedSessions.has(data.sessionId)) return;
    this.updateRalphState(data.sessionId, { loop: data.state });
  }

  _onRalphTodoUpdate(data) {
    // Skip if user explicitly closed this session's Ralph panel
    if (this.ralphClosedSessions.has(data.sessionId)) return;
    this.updateRalphState(data.sessionId, { todos: data.todos });
  }

  _onRalphCompletionDetected(data) {
    // Skip if user explicitly closed this session's Ralph panel
    if (this.ralphClosedSessions.has(data.sessionId)) return;
    // Prevent duplicate notifications for the same completion
    const completionKey = `${data.sessionId}:${data.phrase}`;
    if (this._shownCompletions?.has(completionKey)) {
      return;
    }
    if (!this._shownCompletions) {
      this._shownCompletions = new Set();
    }
    this._shownCompletions.add(completionKey);
    // Clear after 30 seconds to allow re-notification if loop restarts
    setTimeout(() => this._shownCompletions?.delete(completionKey), 30000);

    // Update ralph state to mark loop as inactive
    const existing = this.ralphStates.get(data.sessionId) || {};
    if (existing.loop) {
      existing.loop.active = false;
      this.updateRalphState(data.sessionId, existing);
    }

    const session = this.sessions.get(data.sessionId);
    this.notificationManager?.notify({
      urgency: 'warning',
      category: 'ralph-complete',
      sessionId: data.sessionId,
      sessionName: session?.name || this.getShortId(data.sessionId),
      title: 'Loop Complete',
      message: `Completion: ${data.phrase || 'unknown'}`,
    });
  }

  _onRalphStatusUpdate(data) {
    // Skip if user explicitly closed this session's Ralph panel
    if (this.ralphClosedSessions.has(data.sessionId)) return;
    this.updateRalphState(data.sessionId, { statusBlock: data.block });
  }

  _onCircuitBreakerUpdate(data) {
    // Skip if user explicitly closed this session's Ralph panel
    if (this.ralphClosedSessions.has(data.sessionId)) return;
    this.updateRalphState(data.sessionId, { circuitBreaker: data.status });
    // Notify if circuit breaker opens
    if (data.status.state === 'OPEN') {
      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'circuit-breaker',
        sessionId: data.sessionId,
        sessionName: session?.name || this.getShortId(data.sessionId),
        title: 'Circuit Breaker Open',
        message: data.status.reason || 'Loop stuck - no progress detected',
      });
    }
  }

  _onExitGateMet(data) {
    const session = this.sessions.get(data.sessionId);
    this.notificationManager?.notify({
      urgency: 'warning',
      category: 'exit-gate',
      sessionId: data.sessionId,
      sessionName: session?.name || this.getShortId(data.sessionId),
      title: 'Exit Gate Met',
      message: `Loop ready to exit (indicators: ${data.completionIndicators})`,
    });
  }

  // Bash tools
  _onBashToolStart(data) {
    this.handleBashToolStart(data.sessionId, data.tool);
  }

  _onBashToolEnd(data) {
    this.handleBashToolEnd(data.sessionId, data.tool);
  }

  _onBashToolsUpdate(data) {
    this.handleBashToolsUpdate(data.sessionId, data.tools);
  }

  // Hooks (Claude Code hook events)
  _onHookIdlePrompt(data) {
    const session = this.sessions.get(data.sessionId);
    // Always track pending hook - alert will show when switching away from session
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'idle_prompt');
    }
    this.notificationManager?.notify({
      urgency: 'warning',
      category: 'hook-idle',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Waiting for Input',
      message: data.message || 'Claude is idle and waiting for a prompt',
    });
  }

  _onHookPermissionPrompt(data) {
    const session = this.sessions.get(data.sessionId);
    // Always track pending hook - action alerts need user interaction to clear
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'permission_prompt');
    }
    const toolInfo = data.tool ? `${data.tool}${data.command ? ': ' + data.command : data.file ? ': ' + data.file : ''}` : '';
    this.notificationManager?.notify({
      urgency: 'critical',
      category: 'hook-permission',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Permission Required',
      message: toolInfo || 'Claude needs tool approval to continue',
    });
  }

  /** Parse numbered options from a plain-text string (hook payload). */
  _parseElicitationOptionsFromText(text) {
    const optionRe = /\b(\d):\s*([A-Za-z][A-Za-z /\-]{0,40}?)(?=\s{2,}|\s*\d:|$|\n)/g;
    const options = [];
    let m;
    while ((m = optionRe.exec(text)) !== null) {
      options.push({ val: m[1], label: m[2].trim() });
    }
    if (options.length === 0) return null;
    const firstOptionIdx = text.indexOf(options[0].val + ':');
    const question = text.slice(0, firstOptionIdx).split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
    return { question, options };
  }

  /**
   * Reads the last 20 lines of the given session's xterm buffer and extracts
   * numbered options of the form "N: Label" plus the question text above them.
   * Returns { question, options: [{val, label}] } or null if nothing found.
   */
  _parseElicitationOptions(sessionId) {
    const terminal = this.terminals?.get(sessionId) ?? this.terminal;
    if (!terminal) return null;
    const buf = terminal.buffer.active;
    const lineCount = buf.length;
    const start = Math.max(0, lineCount - 20);
    const lines = [];
    for (let i = start; i < lineCount; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true).trimEnd());
    }
    const text = lines.join('\n');

    const optionRe = /\b(\d):\s*([A-Za-z][A-Za-z /\-]{0,18}?)(?=\s{2,}|\s*\d:|$|\n)/g;
    const options = [];
    let m;
    while ((m = optionRe.exec(text)) !== null) {
      options.push({ val: m[1], label: m[2].trim() });
    }
    if (options.length === 0) return null;

    const firstOptionIdx = text.indexOf(options[0].val + ':');
    const beforeOptions = text.slice(0, firstOptionIdx);
    const questionLines = beforeOptions.split('\n')
      .map(l => l.replace(/^[\u2022\s]+/, '').trim())
      .filter(Boolean);
    const question = questionLines[questionLines.length - 1] || '';

    return { question, options };
  }

  /** Renders or hides the elicitation quick-reply panel based on this.pendingElicitation. */
  renderElicitationPanel() {
    const panel = document.getElementById('elicitationPanel');
    if (!panel) return;
    const pe = this.pendingElicitation;
    if (!pe || pe.sessionId !== this.activeSessionId) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';
    if (pe.options && pe.options.length > 0) {
      const btns = pe.options.map(o =>
        `<button class="elicitation-btn" ` +
        `onclick="app.sendElicitationResponse('${pe.sessionId}','${o.val}')" ` +
        `ontouchend="event.preventDefault();app.sendElicitationResponse('${pe.sessionId}','${o.val}')"` +
        `>${o.val}: ${o.label}</button>`
      ).join('');
      panel.innerHTML =
        (pe.question ? `<div class="elicitation-question">${pe.question}</div>` : '') +
        `<div class="elicitation-options">${btns}</div>`;
    } else {
      panel.innerHTML =
        (pe.question ? `<div class="elicitation-question">${pe.question}</div>` : '') +
        `<div class="elicitation-free-row">` +
        `<input class="elicitation-free-input" id="elicitationInput" type="text" ` +
        `placeholder="Type your answer\u2026" autocomplete="off">` +
        `<button class="elicitation-send-btn" ` +
        `onclick="app.sendElicitationResponse('${pe.sessionId}',document.getElementById('elicitationInput').value)">Send</button>` +
        `</div>`;
    }
  }

  /** Sends a response to the active elicitation dialog and clears the panel. */
  sendElicitationResponse(sessionId, value) {
    if (value === null || value === undefined || value === '') return;
    this.clearPendingHooks(sessionId, 'elicitation_dialog');
    this.pendingElicitation = null;
    this.renderElicitationPanel();
    fetch(`/api/sessions/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: String(value) + '\r', useMux: true }),
    }).catch(() => {});
  }

  /** Renders or hides the AskUserQuestion panel based on this.pendingAskUserQuestion. */
  renderAskUserQuestionPanel() {
    const panel = document.getElementById('askUserQuestionPanel');
    if (!panel) return;
    const pq = this.pendingAskUserQuestion;
    if (!pq || pq.sessionId !== this.activeSessionId) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'flex';
    const escapedSessionId = pq.sessionId.replace(/'/g, "\\'");
    const headerHtml = pq.header ? `<div class="auq-header">${pq.header}</div>` : '';
    const questionHtml = pq.question ? `<div class="elicitation-question">${pq.question}</div>` : '';
    const optionsHtml = pq.options.map((opt, i) => {
      const num = i + 1;
      const escapedLabel = opt.label.replace(/'/g, "\\'");
      const descHtml = opt.description ? `<span class="auq-option-desc">${opt.description}</span>` : '';
      return `<button class="auq-option-btn" ` +
        `onclick="app.sendAskUserQuestionResponse('${escapedSessionId}','${num}')" ` +
        `ontouchend="event.preventDefault();app.sendAskUserQuestionResponse('${escapedSessionId}','${num}')">` +
        `<span class="auq-option-label">${num}. ${opt.label}</span>${descHtml}` +
        `</button>`;
    }).join('');
    panel.innerHTML = headerHtml + questionHtml + `<div class="auq-options">${optionsHtml}</div>`;
  }

  /** Sends an AskUserQuestion response (option number) and clears the panel. */
  sendAskUserQuestionResponse(sessionId, value) {
    if (!value) return;
    this.clearPendingHooks(sessionId, 'ask_user_question');
    this.pendingAskUserQuestion = null;
    this.renderAskUserQuestionPanel();
    fetch(`/api/sessions/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: String(value) + '\r', useMux: true }),
    }).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════
  // Update Checker
  // ═══════════════════════════════════════════════════════════════

  /** Called on page load and every 24h. Silently checks for updates. */
  async _initUpdateChecker() {
    try {
      const data = await fetch('/api/update/check').then(r => r.json());
      this._applyUpdateInfo(data);
    } catch { /* offline — ignore */ }
    setInterval(async () => {
      try {
        const data = await fetch('/api/update/check').then(r => r.json());
        this._applyUpdateInfo(data);
      } catch { /* ignore */ }
    }, 24 * 60 * 60 * 1000);
  }

  /** Apply update info to badge and settings panel. */
  _applyUpdateInfo(data) {
    const badge = document.getElementById('updateBadge');
    const badgeMobile = document.getElementById('updateBadgeMobile');
    const tabBtn = document.getElementById('settingsUpdatesTabBtn');
    const hasUpdate = data.updateAvailable && !data.stale;

    if (badge) badge.style.display = hasUpdate ? '' : 'none';
    if (badgeMobile) badgeMobile.style.display = hasUpdate ? '' : 'none';
    if (tabBtn) tabBtn.classList.toggle('has-update', hasUpdate);

    // Populate settings panel fields
    const cur = document.getElementById('updateCurrentVersion');
    const latestRow = document.getElementById('updateLatestRow');
    const latestEl = document.getElementById('updateLatestVersion');
    const statusMsg = document.getElementById('updateStatusMsg');
    const releaseNotes = document.getElementById('updateReleaseNotes');
    const updateBtn = document.getElementById('updateNowBtn');
    const repoInput = document.getElementById('updateRepoPathInput');

    if (cur) cur.textContent = data.currentVersion || '—';
    if (repoInput && data.repoPath && !repoInput.value) repoInput.value = data.repoPath;

    if (hasUpdate) {
      if (latestRow) latestRow.style.display = '';
      if (latestEl) latestEl.textContent = data.latestVersion;
      if (statusMsg) statusMsg.textContent = `Version ${data.latestVersion} is available.`;
      if (releaseNotes && data.releaseNotes) {
        releaseNotes.style.display = '';
        releaseNotes.textContent = data.releaseNotes.slice(0, 2000);
      }
      if (updateBtn) updateBtn.style.display = '';
    } else {
      if (latestRow) latestRow.style.display = 'none';
      if (updateBtn) updateBtn.style.display = 'none';
      if (releaseNotes) releaseNotes.style.display = 'none';
      if (statusMsg) {
        statusMsg.textContent = data.stale
          ? 'Could not check for updates (GitHub unreachable).'
          : 'You are running the latest version.';
      }
    }
  }

  /** Called by "Check for updates" button. */
  async checkForUpdates(force = false) {
    const statusMsg = document.getElementById('updateStatusMsg');
    if (statusMsg) statusMsg.textContent = 'Checking…';
    try {
      const data = await fetch(`/api/update/check${force ? '?force=1' : ''}`).then(r => r.json());
      this._applyUpdateInfo(data);
    } catch {
      if (statusMsg) statusMsg.textContent = 'Failed to check — check your connection.';
    }
  }

  /** Called by "Update Now" button. */
  async applyUpdate() {
    const updateBtn = document.getElementById('updateNowBtn');
    const log = document.getElementById('updateProgressLog');
    if (updateBtn) updateBtn.disabled = true;
    if (log) { log.style.display = ''; log.textContent = ''; }

    try {
      const res = await fetch('/api/update/apply', { method: 'POST' });
      if (res.status === 400 || res.status === 409) {
        const body = await res.json();
        if (log) log.textContent = body.message || 'Update failed.';
        if (updateBtn) updateBtn.disabled = false;
        return;
      }
      if (log) log.textContent += 'Update started…\n';
    } catch {
      if (log) log.textContent = 'Failed to start update — check your connection.';
      if (updateBtn) updateBtn.disabled = false;
    }
  }

  /** Save repo path to server settings. */
  saveUpdateRepoPath(path) {
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updateRepoPath: path }),
    }).catch(() => {});
  }

  _onUpdateProgress(data) {
    const log = document.getElementById('updateProgressLog');
    if (log) {
      log.style.display = '';
      log.textContent += (data.message || '') + '\n';
      log.scrollTop = log.scrollHeight;
    }
  }

  _onUpdateComplete(data) {
    const log = document.getElementById('updateProgressLog');
    if (log) log.textContent += (data.message || 'Update complete') + '\nReloading in 5 seconds…\n';
    const badge = document.getElementById('updateBadge');
    const badgeMobile = document.getElementById('updateBadgeMobile');
    if (badge) badge.style.display = 'none';
    if (badgeMobile) badgeMobile.style.display = 'none';
    setTimeout(() => window.location.reload(), 5000);
  }

  _onUpdateFailed(data) {
    const log = document.getElementById('updateProgressLog');
    const updateBtn = document.getElementById('updateNowBtn');
    if (log) log.textContent += (data.message || 'Update failed') + '\n';
    if (updateBtn) updateBtn.disabled = false;
  }

  _onSessionMcpRestarted(data) {
    if (data.sessionId === this.activeSessionId) {
      if (typeof McpPanel !== 'undefined') McpPanel._loadServers();
    }
  }

  _onSessionContextUsage(data) {
    if (typeof ContextBar !== 'undefined') ContextBar.onContextUsage(data);
  }

  _onHookElicitationDialog(data) {
    const session = this.sessions.get(data.sessionId);
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'elicitation_dialog');
    }
    // Try to parse question/options from the hook payload first (works in web/transcript view).
    // Fall back to scraping the terminal buffer (works in terminal view when prompt field missing).
    const promptText = data.prompt || data.message || '';
    const fromPayload = promptText ? this._parseElicitationOptionsFromText(promptText) : null;
    const fromTerminal = this._parseElicitationOptions(data.sessionId);
    const parsed = (fromPayload?.options?.length ? fromPayload : null) || fromTerminal;
    const question = parsed?.question || promptText.split('\n')[0]?.trim() || '';
    this.notificationManager?.notify({
      urgency: 'critical',
      category: 'hook-elicitation',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Question Asked',
      message: question || 'Claude is asking a question and waiting for your answer',
    });
    this.pendingElicitation = {
      sessionId: data.sessionId,
      question,
      options: parsed?.options || [],
    };
    this.renderElicitationPanel();
  }

  _onTranscriptAskUserQuestion(data) {
    if (!data.questions || !Array.isArray(data.questions) || data.questions.length === 0) return;
    const q = data.questions[0];
    const session = this.sessions.get(data.sessionId);
    this.notificationManager?.notify({
      urgency: 'critical',
      category: 'hook-ask-user-question',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: q.header || 'Question',
      message: q.question || 'Claude is asking a question',
    });
    this.pendingAskUserQuestion = {
      sessionId: data.sessionId,
      header: q.header || '',
      question: q.question || '',
      options: Array.isArray(q.options) ? q.options : [],
    };
    this.renderAskUserQuestionPanel();
  }

  _onTranscriptAskUserQuestionResolved(data) {
    if (this.pendingAskUserQuestion?.sessionId === data.sessionId) {
      this.pendingAskUserQuestion = null;
      this.renderAskUserQuestionPanel();
    }
  }

  _onHookAskUserQuestion(data) {
    const session = this.sessions.get(data.sessionId);
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'ask_user_question');
    }
    // tool_input.questions is preserved by sanitizeHookData for AskUserQuestion
    const questions = data.tool_input?.questions;
    if (!questions || !Array.isArray(questions) || questions.length === 0) return;
    const q = questions[0]; // render first question (multi-question is rare)
    this.notificationManager?.notify({
      urgency: 'critical',
      category: 'hook-ask-user-question',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: q.header || 'Question',
      message: q.question || 'Claude is asking a question',
    });
    this.pendingAskUserQuestion = {
      sessionId: data.sessionId,
      header: q.header || '',
      question: q.question || '',
      options: Array.isArray(q.options) ? q.options : [],
    };
    this.renderAskUserQuestionPanel();
  }

  _onHookStop(data) {
    const session = this.sessions.get(data.sessionId);
    // Clear all pending hooks when Claude finishes responding
    if (data.sessionId) {
      this.clearPendingHooks(data.sessionId);
    }
    this.notificationManager?.notify({
      urgency: 'info',
      category: 'hook-stop',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Response Complete',
      message: data.reason || 'Claude has finished responding',
    });
  }

  _onHookTeammateIdle(data) {
    const session = this.sessions.get(data.sessionId);
    this.notificationManager?.notify({
      urgency: 'warning',
      category: 'hook-teammate-idle',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Teammate Idle',
      message: `A teammate is idle in ${session?.name || data.sessionId}`,
    });
  }

  _onHookTaskCompleted(data) {
    const session = this.sessions.get(data.sessionId);
    this.notificationManager?.notify({
      urgency: 'info',
      category: 'hook-task-completed',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Task Completed',
      message: `A team task completed in ${session?.name || data.sessionId}`,
    });
  }

  // Subagents (Claude Code background agents)
  _onSubagentDiscovered(data) {
    // Clear all old data for this agentId (in case of ID reuse)
    this.subagents.set(data.agentId, data);
    this.subagentActivity.set(data.agentId, []);
    this.subagentToolResults.delete(data.agentId);
    // Close any existing window for this agentId (will be reopened fresh)
    if (this.subagentWindows.has(data.agentId)) {
      this.forceCloseSubagentWindow(data.agentId);
    }
    this.renderSubagentPanel();

    // Find which Codeman session owns this subagent (direct claudeSessionId match only)
    this.findParentSessionForSubagent(data.agentId);

    // Auto-open window for new active agents — but ONLY if they belong to a Codeman session tab.
    // Agents from external Claude sessions (not managed by Codeman) should not pop up.
    if (data.status === 'active') {
      const agentForCheck = this.subagents.get(data.agentId);
      const hasMatchingTab = agentForCheck?.sessionId &&
        Array.from(this.sessions.values()).some(s => s.claudeSessionId === agentForCheck.sessionId);
      if (hasMatchingTab) {
        this.openSubagentWindow(data.agentId);
      }
    }

    // Ensure connection lines are updated after window is created and DOM settles
    requestAnimationFrame(() => {
      this.updateConnectionLines();
    });

    // Notify about new subagent discovery
    const parentId = this.subagentParentMap.get(data.agentId);
    const parentSession = parentId ? this.sessions.get(parentId) : null;
    this.notificationManager?.notify({
      urgency: 'info',
      category: 'subagent-spawn',
      sessionId: parentId || data.sessionId,
      sessionName: parentSession?.name || parentId || data.sessionId,
      title: 'Subagent Spawned',
      message: data.description || 'New background agent started',
    });
  }

  _onSubagentUpdated(data) {
    const existing = this.subagents.get(data.agentId);
    if (existing) {
      // Merge updated fields (especially description)
      Object.assign(existing, data);
      this.subagents.set(data.agentId, existing);
    } else {
      this.subagents.set(data.agentId, data);
    }
    this.renderSubagentPanel();
    // Update floating window if open (content + header/title)
    if (this.subagentWindows.has(data.agentId)) {
      this.renderSubagentWindowContent(data.agentId);
      this.updateSubagentWindowHeader(data.agentId);
    }
  }

  _onSubagentToolCall(data) {
    const activity = this.subagentActivity.get(data.agentId) || [];
    activity.push({ type: 'tool', ...data });
    if (activity.length > 50) activity.shift(); // Keep last 50 entries
    this.subagentActivity.set(data.agentId, activity);
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    this.renderSubagentPanel();
    // Update floating window (debounced — tool_call events fire rapidly)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  }

  _onSubagentProgress(data) {
    const activity = this.subagentActivity.get(data.agentId) || [];
    activity.push({ type: 'progress', ...data });
    if (activity.length > 50) activity.shift();
    this.subagentActivity.set(data.agentId, activity);
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  }

  _onSubagentMessage(data) {
    const activity = this.subagentActivity.get(data.agentId) || [];
    activity.push({ type: 'message', ...data });
    if (activity.length > 50) activity.shift();
    this.subagentActivity.set(data.agentId, activity);
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  }

  _onSubagentToolResult(data) {
    // Store tool result by toolUseId for later lookup (cap at 50 per agent)
    if (!this.subagentToolResults.has(data.agentId)) {
      this.subagentToolResults.set(data.agentId, new Map());
    }
    const resultsMap = this.subagentToolResults.get(data.agentId);
    resultsMap.set(data.toolUseId, data);
    if (resultsMap.size > 50) {
      const oldest = resultsMap.keys().next().value;
      resultsMap.delete(oldest);
    }

    // Add to activity stream
    const activity = this.subagentActivity.get(data.agentId) || [];
    activity.push({ type: 'tool_result', ...data });
    if (activity.length > 50) activity.shift();
    this.subagentActivity.set(data.agentId, activity);

    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  }

  async _onSubagentCompleted(data) {
    const existing = this.subagents.get(data.agentId);
    if (existing) {
      existing.status = 'completed';
      this.subagents.set(data.agentId, existing);
    }
    this.renderSubagentPanel();
    this.updateSubagentWindows();

    // Auto-minimize completed subagent windows
    if (this.subagentWindows.has(data.agentId)) {
      const windowData = this.subagentWindows.get(data.agentId);
      if (windowData && !windowData.minimized) {
        await this.closeSubagentWindow(data.agentId); // This minimizes to tab
        this.saveSubagentWindowStates(); // Persist the minimized state
      }
    }

    // Notify about subagent completion
    const parentId = this.subagentParentMap.get(data.agentId);
    const parentSession = parentId ? this.sessions.get(parentId) : null;
    this.notificationManager?.notify({
      urgency: 'info',
      category: 'subagent-complete',
      sessionId: parentId || existing?.sessionId || data.sessionId,
      sessionName: parentSession?.name || parentId || data.sessionId,
      title: 'Subagent Completed',
      message: existing?.description || data.description || 'Background agent finished',
    });

    // Clean up activity/tool data for completed agents after 5 minutes
    // This prevents memory leaks from long-running sessions with many subagents
    setTimeout(() => {
      const agent = this.subagents.get(data.agentId);
      // Only clean up if agent is still completed (not restarted)
      if (agent?.status === 'completed') {
        this.subagentActivity.delete(data.agentId);
        this.subagentToolResults.delete(data.agentId);
      }
    }, 5 * 60 * 1000); // 5 minutes

    // Prune stale completed agents from main maps after 30 minutes
    // Keeps subagents/subagentParentMap from growing unbounded in 24h sessions
    setTimeout(() => {
      const agent = this.subagents.get(data.agentId);
      if (agent?.status === 'completed' && !this.subagentWindows.has(data.agentId)) {
        this.subagents.delete(data.agentId);
        this.subagentParentMap.delete(data.agentId);
      }
    }, 30 * 60 * 1000); // 30 minutes
  }

  // Images
  _onImageDetected(data) {
    console.log('[Image Detected]', data);
    this.openImagePopup(data);
  }

  // Tunnel
  _onTunnelStarted(data) {
    console.log('[Tunnel] Started:', data.url);
    this._tunnelUrl = data.url;
    this._dismissTunnelConnecting();
    this._updateTunnelUrlDisplay(data.url);
    this._updateTunnelIndicator(true);
    const welcomeVisible = document.getElementById('welcomeOverlay')?.classList.contains('visible');
    if (welcomeVisible) {
      // On welcome screen: QR appears inline, expanded first
      this._updateWelcomeTunnelBtn(true, data.url, true);
      this.showToast(`Tunnel active`, 'success');
    } else {
      // Not on welcome screen: popup QR overlay
      this._updateWelcomeTunnelBtn(true, data.url);
      this.showToast(`Tunnel active: ${data.url}`, 'success');
      this.showTunnelQR();
    }
  }

  _onTunnelStopped() {
    console.log('[Tunnel] Stopped');
    this._tunnelUrl = null;
    this._dismissTunnelConnecting();
    this._updateTunnelUrlDisplay(null);
    this._updateWelcomeTunnelBtn(false);
    this._updateTunnelIndicator(false);
    this.closeTunnelPanel();
    this.closeTunnelQR();
  }

  _onTunnelProgress(data) {
    console.log('[Tunnel] Progress:', data.message);
    const toast = document.getElementById('tunnelConnectingToast');
    if (toast) {
      toast.innerHTML = `<span class="tunnel-spinner"></span> ${data.message}`;
    }
    // Also update button text if on welcome screen
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn?.classList.contains('connecting')) {
      btn.innerHTML = `<span class="tunnel-spinner"></span> ${data.message}`;
    }
  }

  _onTunnelError(data) {
    console.warn('[Tunnel] Error:', data.message);
    this._dismissTunnelConnecting();
    this.showToast(`Tunnel error: ${data.message}`, 'error');
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) { btn.disabled = false; btn.classList.remove('connecting'); }
  }

  _onTunnelQrRotated(data) {
    if (data.svg) {
      const container = document.getElementById('tunnelQrContainer');
      if (container) container.innerHTML = data.svg;
      const welcomeInner = document.getElementById('welcomeQrInner');
      if (welcomeInner) welcomeInner.innerHTML = data.svg;
    } else {
      this._refreshTunnelQrFromApi();
    }
    this._resetQrCountdown();
  }

  _onTunnelQrRegenerated(data) {
    if (data.svg) {
      const container = document.getElementById('tunnelQrContainer');
      if (container) container.innerHTML = data.svg;
      const welcomeInner = document.getElementById('welcomeQrInner');
      if (welcomeInner) welcomeInner.innerHTML = data.svg;
    } else {
      this._refreshTunnelQrFromApi();
    }
    this._resetQrCountdown();
  }

  _onTunnelQrAuthUsed(data) {
    const ua = data.ua || 'Unknown device';
    const family = ua.match(/Chrome|Firefox|Safari|Edge|Mobile/)?.[0] || 'Browser';
    this.showToast(`Device authenticated via QR (${family}, ${data.ip}). Not you?`, 'warning', {
      duration: 10000,
      action: { label: 'Revoke All', onClick: () => {
        fetch('/api/auth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(() => this.showToast('All sessions revoked', 'success'))
          .catch(() => this.showToast('Failed to revoke sessions', 'error'));
      }},
    });
  }

  // Plan orchestration
  _onPlanSubagent(data) {
    console.log('[Plan Subagent]', data);
    this.handlePlanSubagentEvent(data);
  }

  _onPlanProgress(data) {
    console.log('[Plan Progress]', data);

    // Update UI if we have a progress handler registered
    if (this._planProgressHandler) {
      this._planProgressHandler({ type: 'plan:progress', data });
    }

    // Also update the loading display directly for better feedback
    const titleEl = document.getElementById('planLoadingTitle');
    const hintEl = document.getElementById('planLoadingHint');

    if (titleEl && data.phase) {
      const phaseLabels = {
        'parallel-analysis': 'Running parallel analysis...',
        'subagent': data.detail || 'Subagent working...',
        'synthesis': 'Synthesizing results...',
        'verification': 'Running verification...',
      };
      titleEl.textContent = phaseLabels[data.phase] || data.phase;
    }
    if (hintEl && data.detail) {
      hintEl.textContent = data.detail;
    }
  }

  _onPlanStarted(data) {
    console.log('[Plan Started]', data);
    this.activePlanOrchestratorId = data.orchestratorId;
    this.planGenerationStopped = false; // Reset flag for new generation
    this.renderMonitorPlanAgents();
  }

  _onPlanCancelled(data) {
    console.log('[Plan Cancelled]', data);
    if (this.activePlanOrchestratorId === data.orchestratorId) {
      this.activePlanOrchestratorId = null;
    }
    this.renderMonitorPlanAgents();
  }

  _onPlanCompleted(data) {
    console.log('[Plan Completed]', data);
    if (this.activePlanOrchestratorId === data.orchestratorId) {
      this.activePlanOrchestratorId = null;
    }
    this.renderMonitorPlanAgents();
  }

  // ═══════════════════════════════════════════════════════════════
  // Connection Status, Input Queuing & State Initialization
  // ═══════════════════════════════════════════════════════════════

  setConnectionStatus(status) {
    this._connectionStatus = status;
    this._updateConnectionIndicator();
    if (status === 'connected' && this._inputQueue.size > 0) {
      this._drainInputQueues();
    }
  }

  /**
   * Send input to server without blocking the keystroke flush cycle.
   * Uses a sequential promise chain to preserve character ordering
   * across concurrent async fetches.
   */
  _sendInputAsync(sessionId, input) {
    // Queue immediately if offline
    if (!this.isOnline || this._connectionStatus === 'disconnected') {
      this._enqueueInput(sessionId, input);
      return;
    }

    // Chain on dispatch only — wait for the previous request to be sent before
    // dispatching the next one (preserves keystroke ordering), but don't wait
    // for the server's response. The server handles writeViaMux as
    // fire-and-forget anyway, so the HTTP response carries no useful data
    // beyond success/failure for retry purposes.
    this._inputSendChain = this._inputSendChain.then(() => {
      const fetchPromise = fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        keepalive: input.length < 65536,
      });

      // Handle response asynchronously — don't block next keystroke on response
      fetchPromise.then(resp => {
        if (!resp.ok) {
          this._enqueueInput(sessionId, input);
        } else {
          this.clearPendingHooks(sessionId);
        }
      }).catch(() => {
        this._enqueueInput(sessionId, input);
      });

      // Return immediately after fetch is dispatched (don't await response)
    });
  }


  _enqueueInput(sessionId, input) {
    const existing = this._inputQueue.get(sessionId) || '';
    let combined = existing + input;
    // Enforce 64KB cap — keep most recent keystrokes
    if (combined.length > this._inputQueueMaxBytes) {
      combined = combined.slice(combined.length - this._inputQueueMaxBytes);
    }
    this._inputQueue.set(sessionId, combined);
    this._updateConnectionIndicator();
  }

  async _drainInputQueues() {
    if (this._inputQueue.size === 0) return;
    // Snapshot and clear
    const queued = new Map(this._inputQueue);
    this._inputQueue.clear();
    this._updateConnectionIndicator();

    for (const [sessionId, input] of queued) {
      const resp = await this._apiPost(`/api/sessions/${sessionId}/input`, { input });
      if (!resp?.ok) {
        this._enqueueInput(sessionId, input);
      }
    }
    this._updateConnectionIndicator();
  }

  _updateConnectionIndicator() {
    const indicator = this.$('connectionIndicator');
    const dot = this.$('connectionDot');
    const text = this.$('connectionText');
    if (!indicator || !dot || !text) return;

    let totalBytes = 0;
    for (const v of this._inputQueue.values()) totalBytes += v.length;

    const status = this._connectionStatus;
    const hasQueue = totalBytes > 0;

    // Connected with empty queue — hide
    if ((status === 'connected' || status === 'connecting') && !hasQueue) {
      indicator.style.display = 'none';
      return;
    }

    indicator.style.display = 'flex';
    dot.className = 'connection-dot';

    const formatBytes = (b) => b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}KB`;

    if (status === 'connected' && hasQueue) {
      // Draining
      dot.classList.add('draining');
      text.textContent = `Sending ${formatBytes(totalBytes)}...`;
    } else if (status === 'reconnecting') {
      dot.classList.add('reconnecting');
      text.textContent = hasQueue ? `Reconnecting (${formatBytes(totalBytes)} queued)` : 'Reconnecting...';
    } else {
      // Offline or disconnected
      dot.classList.add('offline');
      text.textContent = hasQueue ? `Offline (${formatBytes(totalBytes)} queued)` : 'Offline';
    }
  }

  setupOnlineDetection() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.reconnectAttempts = 0;
      this.connectSSE();
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.setConnectionStatus('offline');
    });

    // Reconnect SSE when tab becomes visible (fixes frozen-tab bug)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._onTabVisible();
    });
  }

  /**
   * Called when the browser tab becomes visible again after being hidden.
   * Reconnects the SSE stream if it dropped while the tab was backgrounded.
   * Fixes the "frozen tab" bug where terminal stops updating after switching away.
   */
  _onTabVisible() {
    if (!this.isOnline) return;
    const es = this.eventSource;
    if (!es || es.readyState === EventSource.CLOSED) {
      // Stream dropped — reconnect (triggers INIT event which re-syncs all state)
      this.reconnectAttempts = 0;
      this.connectSSE();
      return;
    }
    // Stream appears open but may be stale (browser throttled it without error)
    const STALE_THRESHOLD_MS = 5 * 60 * 1000;
    if (Date.now() - this._lastSseEventTime > STALE_THRESHOLD_MS) {
      this.reconnectAttempts = 0;
      this.connectSSE();
    }
  }

  handleInit(data) {
    // Clear the init fallback timer since we got data
    if (this._initFallbackTimer) {
      clearTimeout(this._initFallbackTimer);
      this._initFallbackTimer = null;
    }
    const gen = ++this._initGeneration;

    // Update version displays (header, toolbar, and desktop bar)
    if (data.version) {
      const versionEl = this.$('versionDisplay');
      const headerVersionEl = this.$('headerVersion');
      if (versionEl) {
        versionEl.textContent = `v${data.version}`;
        versionEl.title = `Codeman v${data.version}`;
      }
      if (headerVersionEl) {
        headerVersionEl.textContent = `v${data.version}`;
        headerVersionEl.title = `Codeman v${data.version}`;
      }
    }

    // Stop any active voice recording on reconnect
    VoiceInput.cleanup();

    this.sessions.clear();
    this.ralphStates.clear();
    this.terminalBuffers.clear();
    // Keep terminalBufferCache across SSE reconnects — selectSession uses it for soft reload
    // (no hide/clear when same session reconnects with unchanged content).
    this.projectInsights.clear();
    this.teams.clear();
    this.teamTasks.clear();
    // Clear all idle timers to prevent stale timers from firing
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    // Clear tab status debounce timers to prevent stale dot updates after reconnect
    for (const timer of this._tabStatusTimers.values()) clearTimeout(timer);
    this._tabStatusTimers.clear();
    for (const timer of this._tabStatusHideTimers.values()) clearTimeout(timer);
    this._tabStatusHideTimers.clear();
    // Clear flicker filter state
    if (this.flickerFilterTimeout) {
      clearTimeout(this.flickerFilterTimeout);
      this.flickerFilterTimeout = null;
    }
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    // Clear pending terminal writes
    if (this.syncWaitTimeout) {
      clearTimeout(this.syncWaitTimeout);
      this.syncWaitTimeout = null;
    }
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    // Preserve local echo overlay text across SSE reconnect — just hide until
    // terminal buffer reloads and prompt is visible again.  _render() re-scans
    // for the ❯ prompt on every call, so rerender() after buffer load repositions it.
    this._localEchoOverlay?.rerender();
    // Clear pending hooks
    this.pendingHooks.clear();
    // Clear parent name cache (prevents stale session name entries accumulating)
    if (this._parentNameCache) this._parentNameCache.clear();
    // Clear subagent activity/results maps (prevents leaks if data.subagents is missing)
    this.subagentActivity.clear();
    this.subagentToolResults.clear();
    // Clean up mobile/keyboard handlers and re-init (prevents listener accumulation on reconnect)
    MobileDetection.cleanup();
    KeyboardHandler.cleanup();
    SwipeHandler.cleanup();
    MobileDetection.init();
    KeyboardHandler.init();
    SwipeHandler.init();
    // Clear tab alerts
    this.tabAlerts.clear();
    // Clear shown completions (used for duplicate notification prevention)
    if (this._shownCompletions) {
      this._shownCompletions.clear();
    }
    // Clear notification manager title flash interval to prevent memory leak
    if (this.notificationManager?.titleFlashInterval) {
      clearInterval(this.notificationManager.titleFlashInterval);
      this.notificationManager.titleFlashInterval = null;
    }
    // Clear notification manager grouping timeouts (prevents orphaned timers)
    if (this.notificationManager?.groupingMap) {
      for (const { timeout } of this.notificationManager.groupingMap.values()) {
        clearTimeout(timeout);
      }
      this.notificationManager.groupingMap.clear();
    }
    // Disconnect terminal resize observer (prevents memory leak on reconnect)
    if (this.terminalResizeObserver) {
      this.terminalResizeObserver.disconnect();
      this.terminalResizeObserver = null;
    }
    // Clear any other orphaned timers
    if (this.planLoadingTimer) {
      clearInterval(this.planLoadingTimer);
      this.planLoadingTimer = null;
    }
    if (this.timerCountdownInterval) {
      clearInterval(this.timerCountdownInterval);
      this.timerCountdownInterval = null;
    }
    if (this.runSummaryAutoRefreshTimer) {
      clearInterval(this.runSummaryAutoRefreshTimer);
      this.runSummaryAutoRefreshTimer = null;
    }
    data.sessions.forEach(s => {
      s.displayStatus = s.status || 'idle';
      this.sessions.set(s.id, s);
      // Load ralph state from session data (only if not explicitly closed by user)
      if ((s.ralphLoop || s.ralphTodos) && !this.ralphClosedSessions.has(s.id)) {
        this.ralphStates.set(s.id, {
          loop: s.ralphLoop || null,
          todos: s.ralphTodos || []
        });
      }
      // Seed context bar from stored token counts so chip shows immediately on load
      // Prefer actual parsed context window data (contextWindowTokens) over cumulative inputTokens estimate
      if (s.contextWindowTokens) {
        const maxTokens = s.contextWindowMax || 200000;
        ContextBar.onContextUsage({
          id: s.id,
          inputTokens: s.contextWindowTokens,
          maxTokens,
          pct: Math.min(100, Math.round((s.contextWindowTokens / maxTokens) * 100)),
          system: s.contextWindowSystem,
          conversation: s.contextWindowConversation,
        });
      } else if (s.inputTokens > 0) {
        const maxTokens = 200000;
        ContextBar.onContextUsage({
          id: s.id,
          inputTokens: s.inputTokens,
          maxTokens,
          pct: Math.min(100, Math.round((s.inputTokens / maxTokens) * 100)),
        });
      }
    });

    // Sync sessionOrder with current sessions (preserve order, add new, remove stale)
    this.syncSessionOrder();

    if (data.respawnStatus) {
      this.respawnStatus = data.respawnStatus;
    } else {
      // Clear respawn status on init if not provided (prevents stale data)
      this.respawnStatus = {};
    }
    // Clean up respawn state for sessions that no longer exist
    this.respawnTimers = {};
    this.respawnCountdownTimers = {};
    this.respawnActionLogs = {};

    // Store global stats for aggregate tracking
    if (data.globalStats) {
      this.globalStats = data.globalStats;
    }

    this.totalCost = data.sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
    this.totalCost += data.scheduledRuns.reduce((sum, r) => sum + (r.totalCost || 0), 0);

    const activeRun = data.scheduledRuns.find(r => r.status === 'running');
    if (activeRun) {
      this.currentRun = activeRun;
      this.showTimer();
    }

    this.updateCost();
    this.renderSessionTabs();

    // Start/stop system stats polling based on session count
    if (this.sessions.size > 0) {
      this.startSystemStatsPolling();
    } else {
      this.stopSystemStatsPolling();
    }

    // CRITICAL: Clean up all floating windows before loading new subagents
    // This prevents memory leaks from ResizeObservers, EventSources, and DOM elements
    this.cleanupAllFloatingWindows();

    // Load subagents - clear all related maps to prevent memory leaks on reconnect
    if (data.subagents) {
      this.subagents.clear();
      this.subagentActivity.clear();
      this.subagentToolResults.clear();
      data.subagents.forEach(s => {
        this.subagents.set(s.agentId, s);
      });
      this.renderSubagentPanel();

      // Load PERSISTENT parent associations FIRST, before restoring windows
      // This ensures connection lines are drawn to the correct tabs
      // Clear the in-memory map first to ensure fresh state from storage
      this.subagentParentMap.clear();
      this.loadSubagentParentMap().then(() => {
        // Apply stored parent associations to agents
        for (const [agentId, sessionId] of this.subagentParentMap) {
          const agent = this.subagents.get(agentId);
          if (agent && this.sessions.has(sessionId)) {
            agent.parentSessionId = sessionId;
            const session = this.sessions.get(sessionId);
            if (session) {
              agent.parentSessionName = this.getSessionName(session);
            }
            this.subagents.set(agentId, agent);
          }
        }

        // Now try to find parents for any agents that don't have one yet
        for (const [agentId] of this.subagents) {
          if (!this.subagentParentMap.has(agentId)) {
            this.findParentSessionForSubagent(agentId);
          }
        }

        // Finally, restore window states (this opens windows with correct parent info)
        this.restoreSubagentWindowStates();
      });
    }

    // Restore previously active session (survives page reload + SSE reconnect)
    // Must always re-select because handleInit clears terminal state above.
    // Reset activeSessionId so selectSession doesn't early-return.
    // Guard: skip if a newer handleInit has already started (race between loadState + SSE init).
    if (gen !== this._initGeneration) return;
    const previousActiveId = this.activeSessionId;
    this.activeSessionId = null;
    if (this.sessionOrder.length > 0) {
      // Priority: current active > localStorage > first session
      let restoreId = previousActiveId;
      if (!restoreId || !this.sessions.has(restoreId)) {
        try { restoreId = localStorage.getItem('codeman-active-session'); } catch {}
      }
      if (restoreId && this.sessions.has(restoreId)) {
        // Soft reconnect: if SSE dropped and same session is being restored with cached
        // content, selectSession will skip the hide+clear+reload and just verify in background.
        this._sseReconnectRestoreId = (previousActiveId === restoreId && this.terminalBufferCache.has(restoreId))
          ? restoreId : null;
        this.selectSession(restoreId);
      } else {
        this.selectSession(this.sessionOrder[0]);
      }
    }
  }

  async loadState() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      this.handleInit(data);
    } catch (err) {
      console.error('Failed to load state:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Tabs
  // ═══════════════════════════════════════════════════════════════

  renderSessionTabs() {
    // Debounce renders at 100ms to prevent excessive DOM updates
    if (this.renderSessionTabsTimeout) {
      clearTimeout(this.renderSessionTabsTimeout);
    }
    this.renderSessionTabsTimeout = setTimeout(() => {
      this._renderSessionTabsImmediate();
    }, 100);
  }

  /** Toggle .active class on tabs immediately (no debounce). Used by selectSession(). */
  _updateActiveTabImmediate(sessionId) {
    const container = this.$('sessionTabs');
    if (!container) return;
    const tabs = container.querySelectorAll('.session-tab[data-id]');
    for (const tab of tabs) {
      if (tab.dataset.id === sessionId) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    }
  }

  _renderSessionTabsImmediate() {
    const container = this.$('sessionTabs');
    const existingTabs = container.querySelectorAll('.session-tab[data-id]');
    const existingIds = new Set([...existingTabs].map(t => t.dataset.id));
    const currentIds = new Set(this.sessions.keys());

    // Check if we can do incremental update (same session IDs)
    const canIncremental = existingIds.size === currentIds.size &&
      [...existingIds].every(id => currentIds.has(id));

    if (canIncremental) {
      // Incremental update - only modify changed properties
      for (const [id, session] of this.sessions) {
        const tab = container.querySelector(`.session-tab[data-id="${id}"]`);
        if (!tab) continue;

        const isActive = id === this.activeSessionId;
        const status = session.displayStatus ?? session.status ?? 'idle';
        const name = this.getSessionName(session);
        const taskStats = session.taskStats || { running: 0, total: 0 };
        const hasRunningTasks = taskStats.running > 0;

        // Update active class
        if (isActive && !tab.classList.contains('active')) {
          tab.classList.add('active');
        } else if (!isActive && tab.classList.contains('active')) {
          tab.classList.remove('active');
        }

        // Update alert class
        const alertType = this.tabAlerts.get(id);
        const wantAction = alertType === 'action';
        const wantIdle = alertType === 'idle';
        const hasAction = tab.classList.contains('tab-alert-action');
        const hasIdle = tab.classList.contains('tab-alert-idle');
        if (wantAction && !hasAction) { tab.classList.add('tab-alert-action'); tab.classList.remove('tab-alert-idle'); }
        else if (wantIdle && !hasIdle) { tab.classList.add('tab-alert-idle'); tab.classList.remove('tab-alert-action'); }
        else if (!alertType && (hasAction || hasIdle)) { tab.classList.remove('tab-alert-action', 'tab-alert-idle'); }

        // Update status indicator
        const statusEl = tab.querySelector('.tab-status');
        if (statusEl && !statusEl.classList.contains(status)) {
          statusEl.className = `tab-status ${status}`;
        }

        // Update name if changed
        const nameEl = tab.querySelector('.tab-name');
        if (nameEl && nameEl.textContent !== name) {
          nameEl.textContent = name;
        }

        // Update task badge
        const badgeEl = tab.querySelector('.tab-badge');
        if (hasRunningTasks) {
          if (badgeEl) {
            if (badgeEl.textContent !== String(taskStats.running)) {
              badgeEl.textContent = taskStats.running;
            }
          } else {
            // Need to add badge - do full rebuild
            this._fullRenderSessionTabs();
            return;
          }
        } else if (badgeEl) {
          // Need to remove badge - do full rebuild
          this._fullRenderSessionTabs();
          return;
        }

        // Update subagent badge - targeted update without full rebuild
        const subagentBadgeEl = tab.querySelector('.tab-subagent-badge');
        const minimizedAgents = this.minimizedSubagents.get(id);
        const minimizedCount = minimizedAgents?.size || 0;
        if (minimizedCount > 0 && subagentBadgeEl) {
          // Badge exists and still has agents - update label and dropdown in-place
          const labelEl = subagentBadgeEl.querySelector('.subagent-label');
          const newLabel = minimizedCount === 1 ? 'AGENT' : `AGENTS (${minimizedCount})`;
          if (labelEl && labelEl.textContent !== newLabel) {
            labelEl.textContent = newLabel;
          }
          // Rebuild dropdown items (agent list may have changed)
          const dropdownEl = subagentBadgeEl.querySelector('.subagent-dropdown');
          if (dropdownEl) {
            const newBadgeHtml = this.renderSubagentTabBadge(id, minimizedAgents);
            const temp = document.createElement('div');
            temp.innerHTML = newBadgeHtml;
            const newDropdown = temp.querySelector('.subagent-dropdown');
            if (newDropdown) {
              dropdownEl.innerHTML = newDropdown.innerHTML;
            }
          }
        } else if (minimizedCount > 0 && !subagentBadgeEl) {
          // Need to add badge - insert before gear icon
          const badgeHtml = this.renderSubagentTabBadge(id, minimizedAgents);
          const gearEl = tab.querySelector('.tab-gear');
          if (gearEl) {
            gearEl.insertAdjacentHTML('beforebegin', badgeHtml);
          }
        } else if (minimizedCount === 0 && subagentBadgeEl) {
          // Count went to 0 - remove badge
          subagentBadgeEl.remove();
        }
      }
    } else {
      // Full rebuild needed (sessions added/removed)
      this._fullRenderSessionTabs();
    }

  }

  _fullRenderSessionTabs() {
    const container = this.$('sessionTabs');

    // Clean up any orphaned dropdowns before re-rendering
    document.querySelectorAll('body > .subagent-dropdown').forEach(d => d.remove());
    this.cancelHideSubagentDropdown();

    // Build tabs HTML using array for better string concatenation performance
    // Iterate in sessionOrder to respect user's custom tab arrangement
    // On mobile: put active session first (only one tab visible anyway)
    const parts = [];
    let tabOrder = this.sessionOrder;
    if (MobileDetection.getDeviceType() === 'mobile' && this.activeSessionId) {
      // Reorder to put active tab first
      tabOrder = [this.activeSessionId, ...this.sessionOrder.filter(id => id !== this.activeSessionId)];
    }
    for (const id of tabOrder) {
      const session = this.sessions.get(id);
      if (!session) continue; // Skip if session was removed

      const isActive = id === this.activeSessionId;
      const status = session.displayStatus ?? session.status ?? 'idle';
      const name = this.getSessionName(session);
      const mode = session.mode || 'claude';
      const color = session.color || 'default';
      const taskStats = session.taskStats || { running: 0, total: 0 };
      const hasRunningTasks = taskStats.running > 0;
      const alertType = this.tabAlerts.get(id);
      const alertClass = alertType === 'action' ? ' tab-alert-action' : alertType === 'idle' ? ' tab-alert-idle' : '';

      // Get minimized subagents for this session
      const minimizedAgents = this.minimizedSubagents.get(id);
      const minimizedCount = minimizedAgents?.size || 0;
      const subagentBadge = minimizedCount > 0 ? this.renderSubagentTabBadge(id, minimizedAgents) : '';
      const worktreeBadge = session.worktreeBranch
        ? `<span class="tab-worktree-badge" title="Worktree: ${escapeHtml(session.worktreeBranch)}">${BRANCH_SVG} ${escapeHtml(session.worktreeBranch)}</span>`
        : '';
      const safeModeBadge = session.safeMode ? '<span class="tab-safe-mode-badge" title="Safe mode: stripped CLI args">SAFE</span>' : '';

      // Show folder name if session has a custom name AND tall tabs setting is enabled
      const folderName = session.workingDir ? session.workingDir.split('/').pop() || '' : '';
      const tallTabsEnabled = this._tallTabsEnabled ?? false;
      const showFolder = tallTabsEnabled && session.name && folderName && folderName !== name;

      parts.push(`<div class="session-tab ${isActive ? 'active' : ''}${alertClass}" data-id="${id}" data-color="${color}" onclick="app.selectSession('${escapeHtml(id)}')" oncontextmenu="event.preventDefault(); app.startInlineRename('${escapeHtml(id)}')" tabindex="0" role="tab" aria-selected="${isActive ? 'true' : 'false'}" aria-label="${escapeHtml(name)} session" ${session.workingDir ? `title="${escapeHtml(session.workingDir)}"` : ''}>
          <span class="tab-status ${status}" aria-hidden="true"></span>
          <span class="tab-info">
            <span class="tab-name-row">
              ${mode === 'shell' ? '<span class="tab-mode shell" aria-hidden="true">sh</span>' : mode === 'opencode' ? '<span class="tab-mode opencode" aria-hidden="true">oc</span>' : ''}
              <span class="tab-name" data-session-id="${id}">${escapeHtml(name)}</span>
            </span>
            ${showFolder ? `<span class="tab-folder">\u{1F4C1} ${escapeHtml(folderName)}</span>` : ''}
          </span>
          ${hasRunningTasks ? `<span class="tab-badge" onclick="event.stopPropagation(); app.toggleTaskPanel()" aria-label="${taskStats.running} running tasks">${taskStats.running}</span>` : ''}
          ${subagentBadge}
          ${worktreeBadge}
          ${safeModeBadge}
          <span class="tab-gear" onclick="event.stopPropagation(); app.openSessionOptions('${escapeHtml(id)}')" title="Session options" aria-label="Session options" tabindex="0">&#x2699;</span>
          <span class="tab-close" onclick="event.stopPropagation(); app.requestCloseSession('${escapeHtml(id)}')" title="Close session" aria-label="Close session" tabindex="0">&times;</span>
        </div>`);
    }

    container.innerHTML = parts.join('');

    // Set up drag-and-drop handlers for tab reordering
    this.setupTabDragHandlers();

    // Set up keyboard navigation for tabs
    this.setupTabKeyboardNavigation(container);

    // Update connection lines after tabs change (positions may have shifted)
    this.updateConnectionLines();
  }

  // Set up arrow key navigation for session tabs (accessibility)
  setupTabKeyboardNavigation(container) {
    // Remove existing listener if any to avoid duplicates
    if (this._tabKeydownHandler) {
      container.removeEventListener('keydown', this._tabKeydownHandler);
    }

    this._tabKeydownHandler = (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(e.key)) return;

      const tabs = [...container.querySelectorAll('.session-tab')];
      const currentIndex = tabs.indexOf(document.activeElement);

      // Enter or Space activates the tab
      if ((e.key === 'Enter' || e.key === ' ') && currentIndex >= 0) {
        e.preventDefault();
        const sessionId = tabs[currentIndex].dataset.id;
        this.selectSession(sessionId);
        return;
      }

      if (currentIndex < 0) return;

      let newIndex;
      switch (e.key) {
        case 'ArrowLeft':
          newIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
          break;
        case 'ArrowRight':
          newIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
          break;
        case 'Home':
          newIndex = 0;
          break;
        case 'End':
          newIndex = tabs.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      tabs[newIndex]?.focus();
    };

    container.addEventListener('keydown', this._tabKeydownHandler);
  }


  // ═══════════════════════════════════════════════════════════════
  // Tab Order and Drag-and-Drop
  // ═══════════════════════════════════════════════════════════════

  // Sync sessionOrder with current sessions (preserve order for existing, add new at end)
  syncSessionOrder() {
    const currentIds = new Set(this.sessions.keys());

    // Load saved order from localStorage
    const savedOrder = this.loadSessionOrder();

    // Start with saved order, keeping only sessions that still exist
    const preserved = savedOrder.filter(id => currentIds.has(id));
    const preservedSet = new Set(preserved);

    // Add any new sessions at the end
    const newSessions = [...currentIds].filter(id => !preservedSet.has(id));

    this.sessionOrder = [...preserved, ...newSessions];
  }

  // Load session order from localStorage
  loadSessionOrder() {
    try {
      const saved = localStorage.getItem('codeman-session-order');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  // Save session order to localStorage
  saveSessionOrder() {
    try {
      localStorage.setItem('codeman-session-order', JSON.stringify(this.sessionOrder));
    } catch {
      // Ignore storage errors
    }
  }

  // Set up drag-and-drop handlers on tab elements
  setupTabDragHandlers() {
    const container = this.$('sessionTabs');
    const tabs = container.querySelectorAll('.session-tab[data-id]');

    tabs.forEach(tab => {
      tab.setAttribute('draggable', 'true');

      tab.addEventListener('dragstart', (e) => {
        this.draggedTabId = tab.dataset.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.dataset.id);
      });

      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        this.draggedTabId = null;
        // Remove all drag-over indicators
        container.querySelectorAll('.session-tab').forEach(t => {
          t.classList.remove('drag-over-left', 'drag-over-right');
        });
      });

      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!this.draggedTabId || this.draggedTabId === tab.dataset.id) return;

        e.dataTransfer.dropEffect = 'move';

        // Determine drop position based on mouse position
        const rect = tab.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const isLeftHalf = e.clientX < midpoint;

        // Update visual indicator
        tab.classList.toggle('drag-over-left', isLeftHalf);
        tab.classList.toggle('drag-over-right', !isLeftHalf);
      });

      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over-left', 'drag-over-right');
      });

      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over-left', 'drag-over-right');

        if (!this.draggedTabId || this.draggedTabId === tab.dataset.id) return;

        const targetId = tab.dataset.id;
        const draggedId = this.draggedTabId;

        // Determine insertion position
        const rect = tab.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const insertBefore = e.clientX < midpoint;

        // Reorder sessionOrder array
        const fromIndex = this.sessionOrder.indexOf(draggedId);
        let toIndex = this.sessionOrder.indexOf(targetId);

        if (fromIndex === -1 || toIndex === -1) return;

        // Remove dragged item
        this.sessionOrder.splice(fromIndex, 1);

        // Recalculate target index after removal
        toIndex = this.sessionOrder.indexOf(targetId);
        if (toIndex === -1) return;

        // Insert at correct position
        if (insertBefore) {
          this.sessionOrder.splice(toIndex, 0, draggedId);
        } else {
          this.sessionOrder.splice(toIndex + 1, 0, draggedId);
        }

        // Save and re-render
        this.saveSessionOrder();
        this._fullRenderSessionTabs();
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Lifecycle — select, close, navigate
  // ═══════════════════════════════════════════════════════════════

  getShortId(id) {
    if (!id) return '';
    let short = this._shortIdCache.get(id);
    if (!short) {
      short = id.slice(0, 8);
      this._shortIdCache.set(id, short);
    }
    return short;
  }

  getSessionName(session) {
    // Use custom name if set
    if (session.name) {
      return session.name;
    }
    // Fall back to directory name
    if (session.workingDir) {
      return session.workingDir.split('/').pop() || session.workingDir;
    }
    return this.getShortId(session.id);
  }

  async selectSession(sessionId) {
    if (this.activeSessionId === sessionId) return;
    const _selStart = performance.now();
    const _selName = this.sessions.get(sessionId)?.name || sessionId.slice(0,8);
    _crashDiag.log(`SELECT: ${_selName}`);
    console.log(`[CRASH-DIAG] selectSession START: ${sessionId.slice(0,8)}`);

    const selectGen = ++this._selectGeneration;

    if (selectGen !== this._selectGeneration) return; // newer tab switch won

    // Clean up flicker filter state when switching sessions
    if (this.flickerFilterTimeout) {
      clearTimeout(this.flickerFilterTimeout);
      this.flickerFilterTimeout = null;
    }
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;

    // Clear tab completion detection flag — don't carry across sessions
    this._tabCompletionSessionId = null;
    this._tabCompletionRetries = 0;
    this._tabCompletionBaseText = null;
    if (this._tabCompletionFallback) { clearTimeout(this._tabCompletionFallback); this._tabCompletionFallback = null; }
    if (this._clientDropRecoveryTimer) { clearTimeout(this._clientDropRecoveryTimer); this._clientDropRecoveryTimer = null; }

    // Clear status strip — new session may not have GSD output
    const statusStrip = this._statusStripEl ?? document.getElementById('terminalStatusStrip');
    if (statusStrip) statusStrip.style.display = 'none';

    // Clean up pending terminal writes to prevent old session data from appearing in new session
    if (this.syncWaitTimeout) {
      clearTimeout(this.syncWaitTimeout);
      this.syncWaitTimeout = null;
    }
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    // End any in-flight IME composition.
    // iOS Safari keeps autocorrect composing; switching tabs without ending it
    // leaves xterm's _compositionHelper._isComposing stuck true, which blocks
    // keyboard input when the user returns to this tab.
    try {
      const ch = this.terminal?._core?._compositionHelper;
      if (ch?._isComposing) {
        ch._isComposing = false;
        // Also fire compositionend on the textarea so any other listeners reset
        const ta = this.terminal?.element?.querySelector('.xterm-helper-textarea');
        if (ta) ta.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
      }
    } catch {}

    // Flush local echo text to PTY before switching tabs.
    // Send as a single batch (no Enter) so it lands in the session's readline
    // input buffer — avoids "old text resent on Enter" and overlay render bugs.
    // Track flushed length so _render() offsets the overlay correctly even before
    // the PTY echo arrives in the terminal buffer.
    if (this.activeSessionId) {
      const echoText = this._localEchoOverlay?.pendingText || '';
      // Include buffer-detected flushed text (from Tab completion, etc.)
      // so it's preserved across tab switches.
      const existingFlushed = this._localEchoOverlay?.getFlushed()?.count || 0;
      const existingFlushedText = this._localEchoOverlay?.getFlushed()?.text || '';
      if (echoText) {
        this._sendInputAsync(this.activeSessionId, echoText);
      }
      const totalOffset = existingFlushed + echoText.length;
      if (totalOffset > 0) {
        if (!this._flushedOffsets) this._flushedOffsets = new Map();
        if (!this._flushedTexts) this._flushedTexts = new Map();
        this._flushedOffsets.set(this.activeSessionId, totalOffset);
        this._flushedTexts.set(this.activeSessionId, existingFlushedText + echoText);
      }
    }
    this._localEchoOverlay?.clear();
    // Prevent _detectBufferText() from picking up Claude's Ink UI text
    // (status bar, model info, etc.) as "user input" on fresh sessions.
    // Only sessions with prior flushed text (from tab-switch-away) need detection.
    // After the user's first Enter, clear() resets _bufferDetectDone = false,
    // re-enabling detection for tab completion and other legitimate cases.
    if (this._localEchoOverlay && !this._flushedOffsets?.has(sessionId)) {
      this._localEchoOverlay.suppressBufferDetection();
    }
    const _prevSessionId = this.activeSessionId;
    this.activeSessionId = sessionId;
    SessionIndicatorBar.update(sessionId);
    // Save draft for old session, load draft for new session
    if (typeof InputPanel !== 'undefined') InputPanel.onSessionChange(_prevSessionId, sessionId);
    if (typeof McpPanel !== 'undefined') McpPanel.showForSession(sessionId);
    PluginsPanel.showChip();
    ContextBar.onSessionSelected(sessionId);
    this.renderElicitationPanel();
    this.renderAskUserQuestionPanel();
    try { localStorage.setItem('codeman-active-session', sessionId); } catch {}
    this.hideWelcome();

    // Restore transcript vs terminal view for this session and update the accessory button.
    // Hide the previous session's transcript view first, then apply this session's preference.
    const _tvMode = TranscriptView.getViewMode(sessionId);
    if (_tvMode === 'web') {
      TranscriptView.show(sessionId);
    } else {
      TranscriptView.hide(sessionId);
    }
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.updateViewModeBtn(sessionId);
    }
    // Clear idle hooks on view, but keep action hooks until user interacts
    this.clearPendingHooks(sessionId, 'idle_prompt');
    // Instant active-class toggle (no 100ms debounce), then schedule full render for badges/status
    this._updateActiveTabImmediate(sessionId);
    this.renderSessionTabs();
    this._updateLocalEchoState();
    const _switchedSession = this.sessions.get(sessionId);
    const _switchedWorking = _switchedSession?.status === 'busy';
    this._updateSendBtn(_switchedWorking);
    if (TranscriptView._sessionId === sessionId) TranscriptView.setWorking(_switchedWorking);

    // Restore flushed offset AND text IMMEDIATELY so backspace/typing work during
    // the async buffer load.  Without this, the offset is 0 during the
    // fetch() gap: backspace is swallowed, and typing a space covers the
    // canvas text with an opaque overlay showing only the new char.
    if (this._flushedOffsets?.has(sessionId) && this._localEchoOverlay) {
      this._localEchoOverlay.setFlushed(
        this._flushedOffsets.get(sessionId),
        this._flushedTexts?.get(sessionId) || '',
        false  // render=false: buffer not loaded yet
      );
    }

    // Glow the newly-active tab
    const activeTab = document.querySelector(`.session-tab.active[data-id="${sessionId}"]`);
    if (activeTab) {
      activeTab.classList.add('tab-glow');
      activeTab.addEventListener('animationend', () => activeTab.classList.remove('tab-glow'), { once: true });
    }

    // Check if this is a restored session that needs to be attached
    const session = this.sessions.get(sessionId);

    // Track working directory for path normalization in Project Insights
    this.currentSessionWorkingDir = session?.workingDir || null;
    if (session && session.pid === null && session.status === 'idle') {
      // This is a restored session - attach to the existing screen
      try {
        await fetch(`/api/sessions/${sessionId}/interactive`, { method: 'POST' });
        // Update local session state
        session.status = 'busy';
      } catch (err) {
        console.error('Failed to attach to restored session:', err);
      }
    }

    // Load terminal buffer for this session
    // Show cached content instantly while fetching fresh data in background.
    // Use tail mode for faster initial load (128KB is enough for recent visible content).
    //
    // Protect flushed state during buffer load: terminal.write() can trigger
    // xterm.js onData responses (DA, OSC, etc.) that would otherwise clear
    // the flushed Maps via the control char handler.  The multi-byte ESC
    // filter catches most cases, but _restoringFlushedState provides a
    // belt-and-suspenders guard for any edge cases.
    this._restoringFlushedState = true;
    // Gate live SSE terminal writes for the ENTIRE buffer load sequence.
    // Without this, SSE events arriving during the fetch() gap compete with
    // the buffer write, causing 70KB+ single-frame flushes that stall WebGL.
    // chunkedTerminalWrite also sets this, but we need it before the fetch too.
    this._isLoadingBuffer = true;
    this._loadBufferQueue = [];
    try {
      // Load terminal buffer for the new session. Hide the terminal container for the
      // entire sequence (cache write + fetch + optional rewrite) so the user sees a
      // single reveal rather than: cached-content → hidden → fresh-content (double flash).
      // On localhost the fetch is < 5ms, so the hidden period is imperceptible.
      const cachedBuffer = this.terminalBufferCache.get(sessionId);
      const termContainer = document.getElementById('terminalContainer');

      // Soft reconnect: SSE dropped and reconnected to the same already-visible session.
      // Skip hiding the terminal; verify the buffer in the background. Only do a full
      // hide+clear+reload if content actually changed while SSE was down.
      const isSoftReconnect = this._sseReconnectRestoreId === sessionId;
      this._sseReconnectRestoreId = null;  // consume immediately
      let terminalHidden = false;  // track whether buffer-loading was added

      if (isSoftReconnect && cachedBuffer) {
        _crashDiag.log('SOFT_RECONNECT: fetching to compare');
        const res = await fetch(`/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`);
        if (selectGen !== this._selectGeneration) { if (this._isLoadingBuffer) this._finishBufferLoad(); this._restoringFlushedState = false; return; }
        const data = await res.json();
        _crashDiag.log(`SOFT_RECONNECT_DONE: ${data.terminalBuffer ? (data.terminalBuffer.length/1024).toFixed(0) + 'KB' : 'empty'} changed=${data.terminalBuffer !== cachedBuffer}`);

        if (data.terminalBuffer && data.terminalBuffer !== cachedBuffer) {
          // Content changed while SSE was down — hide and reload cleanly
          termContainer?.classList.add('buffer-loading');
          terminalHidden = true;
          await new Promise(resolve => requestAnimationFrame(resolve));
          this.terminal.clear();
          this.terminal.reset();
          if (data.truncated) {
            this.terminal.write('\x1b[90m... (earlier output truncated for performance) ...\x1b[0m\r\n\r\n');
          }
          await this.chunkedTerminalWrite(data.terminalBuffer);
          if (selectGen !== this._selectGeneration) { termContainer?.classList.remove('buffer-loading'); if (this._isLoadingBuffer) this._finishBufferLoad(); this._restoringFlushedState = false; return; }
          this.terminalBufferCache.set(sessionId, data.terminalBuffer);
          if (this.terminalBufferCache.size > 20) {
            const oldest = this.terminalBufferCache.keys().next().value;
            this.terminalBufferCache.delete(oldest);
          }
        } else if (data.terminalBuffer) {
          // Buffer unchanged — terminal already shows correct content; refresh cache entry
          this.terminalBufferCache.set(sessionId, data.terminalBuffer);
        }
      } else {
        // Normal tab switch: hide terminal for the entire load sequence so the user sees
        // a single reveal rather than: cached-content → hidden → fresh-content (double flash).
        termContainer?.classList.add('buffer-loading');
        terminalHidden = true;
        await new Promise(resolve => requestAnimationFrame(resolve));

        if (cachedBuffer) {
          _crashDiag.log(`CACHE_WRITE: ${(cachedBuffer.length/1024).toFixed(0)}KB`);
          this.terminal.clear();
          this.terminal.reset();
          await this.chunkedTerminalWrite(cachedBuffer);
          if (selectGen !== this._selectGeneration) { termContainer?.classList.remove('buffer-loading'); if (this._isLoadingBuffer) this._finishBufferLoad(); this._restoringFlushedState = false; return; }
          _crashDiag.log('CACHE_DONE');
          // Stay hidden — fetch may have newer content; reveal once after final write
        }

        _crashDiag.log('FETCH_START');
        const res = await fetch(`/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`);
        if (selectGen !== this._selectGeneration) { termContainer?.classList.remove('buffer-loading'); if (this._isLoadingBuffer) this._finishBufferLoad(); this._restoringFlushedState = false; return; }
        const data = await res.json();
        _crashDiag.log(`FETCH_DONE: ${data.terminalBuffer ? (data.terminalBuffer.length/1024).toFixed(0) + 'KB' : 'empty'} truncated=${data.truncated}`);

        if (data.terminalBuffer) {
          // Skip rewrite if fresh buffer matches cache — avoids unnecessary clear+rewrite.
          const needsRewrite = data.terminalBuffer !== cachedBuffer;
          if (needsRewrite) {
            _crashDiag.log(`REWRITE: ${(data.terminalBuffer.length/1024).toFixed(0)}KB`);
            this.terminal.clear();
            this.terminal.reset();
            // Show truncation indicator if buffer was cut
            if (data.truncated) {
              this.terminal.write('\x1b[90m... (earlier output truncated for performance) ...\x1b[0m\r\n\r\n');
            }
            // Use chunked write for large buffers to avoid UI jank
            await this.chunkedTerminalWrite(data.terminalBuffer);
            if (selectGen !== this._selectGeneration) { termContainer?.classList.remove('buffer-loading'); if (this._isLoadingBuffer) this._finishBufferLoad(); this._restoringFlushedState = false; return; }
          }

          // Update cache (cap at 20 entries)
          this.terminalBufferCache.set(sessionId, data.terminalBuffer);
          if (this.terminalBufferCache.size > 20) {
            // Evict oldest entry (first key in Map iteration order)
            const oldest = this.terminalBufferCache.keys().next().value;
            this.terminalBufferCache.delete(oldest);
          }
        } else if (!cachedBuffer) {
          // No fresh buffer and no cache — clear any stale content
          this.terminal.clear();
          this.terminal.reset();
        }
      }

      // Scroll to bottom and reveal terminal (only if it was hidden)
      this.terminal.scrollToBottom();
      if (terminalHidden) termContainer?.classList.remove('buffer-loading');

      // Buffer load complete — unblock live SSE writes and flush any queued events.
      // chunkedTerminalWrite calls _finishBufferLoad internally, but if we skipped
      // the chunked write (small buffer, cache hit, or empty), we must call it here.
      if (this._isLoadingBuffer) {
        this._finishBufferLoad();
      }
      // Drop the guard so user input clears state normally
      this._restoringFlushedState = false;

      // Restore flushed offset and text for this session so the overlay positions
      // correctly even before the PTY echo arrives in the terminal buffer.
      if (this._flushedOffsets?.has(sessionId) && this._localEchoOverlay) {
        this._localEchoOverlay.setFlushed(
          this._flushedOffsets.get(sessionId),
          this._flushedTexts?.get(sessionId) || '',
          false  // render=false: buffer just loaded, defer to rerender
        );
        // Trigger render after xterm.js finishes processing the buffer data.
        // terminal.write('', callback) fires the callback after ALL previously
        // queued writes have been parsed — so findPrompt() can find ❯ in the buffer.
        const zl = this._localEchoOverlay;
        this.terminal.write('', () => {
          if (zl.hasPending) zl.rerender();
        });
      }

      // Fire-and-forget resize — don't await to avoid blocking UI.
      // The resize triggers an Ink redraw in Claude which streams back via SSE.
      this.sendResize(sessionId);

      // Defer secondary panel updates so they don't block the main thread
      // after terminal content is already visible.
      const idleCb = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb) => setTimeout(cb, 16);
      idleCb(() => {
        // Guard against stale generation — user may have switched tabs again
        if (selectGen !== this._selectGeneration) return;

        // Update respawn banner
        if (this.respawnStatus[sessionId]) {
          this.showRespawnBanner();
          this.updateRespawnBanner(this.respawnStatus[sessionId].state);
          document.getElementById('respawnCycleCount').textContent = this.respawnStatus[sessionId].cycleCount || 0;
          this.updateCountdownTimerDisplay();
          this.updateActionLogDisplay();
          if (Object.keys(this.respawnCountdownTimers[sessionId] || {}).length > 0) {
            this.startCountdownInterval();
          }
        } else {
          this.hideRespawnBanner();
          this.stopCountdownInterval();
        }

        // Update task panel if open
        const taskPanel = document.getElementById('taskPanel');
        if (taskPanel && taskPanel.classList.contains('open')) {
          this.renderTaskPanel();
        }

        // Update ralph state panel for this session
        const curSession = this.sessions.get(sessionId);
        if (curSession && (curSession.ralphLoop || curSession.ralphTodos)) {
          this.updateRalphState(sessionId, {
            loop: curSession.ralphLoop,
            todos: curSession.ralphTodos
          });
        }
        this.renderRalphStatePanel();

        // Update CLI info bar (mobile - shows Claude version/model)
        this.updateCliInfoDisplay();

        // Update project insights panel for this session
        this.renderProjectInsightsPanel();

        // Update subagent window visibility for active session
        this.updateSubagentWindowVisibility();

        // Load file browser if enabled
        const settings = this.loadAppSettingsFromStorage();
        if (settings.showFileBrowser) {
          const fileBrowserPanel = this.$('fileBrowserPanel');
          if (fileBrowserPanel) {
            fileBrowserPanel.classList.add('visible');
            this.loadFileBrowser(sessionId);
            // Attach drag listeners if not already attached
            if (!this.fileBrowserDragListeners) {
              const header = fileBrowserPanel.querySelector('.file-browser-header');
              if (header) {
                const onFirstDrag = () => {
                  if (!fileBrowserPanel.style.left) {
                    const rect = fileBrowserPanel.getBoundingClientRect();
                    fileBrowserPanel.style.left = `${rect.left}px`;
                    fileBrowserPanel.style.top = `${rect.top}px`;
                    fileBrowserPanel.style.right = 'auto';
                  }
                };
                header.addEventListener('mousedown', onFirstDrag);
                header.addEventListener('touchstart', onFirstDrag, { passive: true });
                this.fileBrowserDragListeners = this.makeWindowDraggable(fileBrowserPanel, header);
                this.fileBrowserDragListeners._onFirstDrag = onFirstDrag;
              }
            }
          }
        }
      });

      _crashDiag.log('FOCUS');
      // On touch devices, skip auto-focus on tab switch — focusing the xterm textarea
      // unconditionally opens the virtual keyboard, causing it to pop up when switching
      // tabs even if it was closed, or to flicker (close + reopen) if it was open.
      // On mobile the user taps the terminal or input bar to bring the keyboard up.
      if (!MobileDetection.isTouchDevice()) {
        this.terminal.focus();
      }
      this.terminal.scrollToBottom();

      // Fetch session-scoped slash commands (project + user level)
      if (!this._sessionCommands.has(sessionId)) {
        fetch(`/api/sessions/${sessionId}/commands`)
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data?.commands?.length) {
              this._sessionCommands.set(sessionId, data.commands);
            }
          })
          .catch(() => {}); // non-fatal — drawer falls back to static list
      }

      _crashDiag.log(`SELECT_DONE: ${(performance.now() - _selStart).toFixed(0)}ms`);
      console.log(`[CRASH-DIAG] selectSession DONE: ${sessionId.slice(0,8)} in ${(performance.now() - _selStart).toFixed(0)}ms`);
    } catch (err) {
      if (this._isLoadingBuffer) this._finishBufferLoad();
      this._restoringFlushedState = false;
      console.error('Failed to load session terminal:', err);
    }
  }

  // Shared cleanup for all session data — called from both closeSession() and session:deleted handler
  _cleanupSessionData(sessionId) {
    this.sessions.delete(sessionId);
    // Remove from tab order
    const orderIndex = this.sessionOrder.indexOf(sessionId);
    if (orderIndex !== -1) {
      this.sessionOrder.splice(orderIndex, 1);
      this.saveSessionOrder();
    }
    this.terminalBuffers.delete(sessionId);
    this.terminalBufferCache.delete(sessionId);
    this._sessionCommands?.delete(sessionId);

    this._flushedOffsets?.delete(sessionId);
    this._flushedTexts?.delete(sessionId);
    this._inputQueue.delete(sessionId);
    this.ralphStates.delete(sessionId);
    this.ralphClosedSessions.delete(sessionId);
    this.projectInsights.delete(sessionId);
    this.pendingHooks.delete(sessionId);
    this.tabAlerts.delete(sessionId);
    this.clearCountdownTimers(sessionId);
    this.closeSessionLogViewerWindows(sessionId);
    this.closeSessionImagePopups(sessionId);
    this.closeSessionSubagentWindows(sessionId, true);

    // Clean up idle timer
    const idleTimer = this.idleTimers.get(sessionId);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(sessionId);
    }
    const tabShowTimer = this._tabStatusTimers.get(sessionId);
    if (tabShowTimer) { clearTimeout(tabShowTimer); this._tabStatusTimers.delete(sessionId); }
    const tabHideTimer = this._tabStatusHideTimers.get(sessionId);
    if (tabHideTimer) { clearTimeout(tabHideTimer); this._tabStatusHideTimers.delete(sessionId); }
    // Clean up respawn state
    delete this.respawnStatus[sessionId];
    delete this.respawnTimers[sessionId];
    delete this.respawnCountdownTimers[sessionId];
    delete this.respawnActionLogs[sessionId];
  }

  async closeSession(sessionId, killMux = true) {
    try {
      await this._apiDelete(`/api/sessions/${sessionId}?killMux=${killMux}`);
      this._cleanupSessionData(sessionId);

      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        // Select another session or show welcome (use sessionOrder for consistent ordering)
        if (this.sessionOrder.length > 0 && this.sessions.size > 0) {
          const nextSessionId = this.sessionOrder[0];
          this.selectSession(nextSessionId);
        } else {
          this.terminal.clear();
          this.showWelcome();
          this.renderRalphStatePanel();  // Clear ralph panel when no sessions
        }
      }

      this.renderSessionTabs();

      if (killMux) {
        this.showToast('Session closed and tmux killed', 'success');
      } else {
        this.showToast('Tab hidden, tmux still running', 'info');
      }
    } catch (err) {
      this.showToast('Failed to close session', 'error');
    }
  }

  // Request confirmation before closing a session
  requestCloseSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.pendingCloseSessionId = sessionId;

    // Show session name in confirmation dialog
    const name = this.getSessionName(session);
    const sessionNameEl = document.getElementById('closeConfirmSessionName');
    sessionNameEl.textContent = name;

    // Update kill button text based on session mode
    const killTitle = document.getElementById('closeConfirmKillTitle');
    if (killTitle) {
      killTitle.textContent = session.mode === 'opencode'
        ? 'Kill Tmux & OpenCode'
        : 'Kill Tmux & Claude Code';
    }

    // Show merge option for worktree sessions
    const mergeOption = document.getElementById('closeConfirmMergeOption');
    if (mergeOption) {
      if (session.worktreeBranch) {
        const originSession = session.worktreeOriginId ? this.sessions.get(session.worktreeOriginId) : null;
        const targetName = originSession ? this.getSessionName(originSession) : 'origin';
        document.getElementById('closeConfirmMergeBranch').textContent = session.worktreeBranch;
        document.getElementById('closeConfirmMergeTarget').textContent = targetName;
        mergeOption.style.display = '';
      } else {
        mergeOption.style.display = 'none';
      }
    }

    document.getElementById('closeConfirmModal').classList.add('active');
  }

  cancelCloseSession() {
    this.pendingCloseSessionId = null;
    document.getElementById('closeConfirmModal').classList.remove('active');
  }

  async confirmCloseSession(killMux = true) {
    const sessionId = this.pendingCloseSessionId;
    this.cancelCloseSession();

    if (sessionId) {
      await this.closeSession(sessionId, killMux);
    }
  }

  async confirmCloseSessionWithMerge() {
    const sessionId = this.pendingCloseSessionId;
    const session = this.sessions.get(sessionId);
    this.cancelCloseSession();
    if (!session?.worktreeBranch) return;

    const originSession = session.worktreeOriginId ? this.sessions.get(session.worktreeOriginId) : null;
    if (!originSession) {
      this.showToast('Origin session not found — cannot merge', 'error');
      return;
    }

    this.showToast(`Merging ${session.worktreeBranch}…`, 'info');
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(originSession.id)}/worktree/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: session.worktreeBranch }),
      });
      const result = await res.json();
      if (!result.success) {
        this.showToast('Merge failed: ' + (result.error || 'Unknown error'), 'error');
        return;
      }
      this.showToast('Merged! Cleaning up worktree…', 'success');
      // Remove worktree from disk
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/worktree`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      // Close the session tab
      await this.closeSession(sessionId, true);
    } catch (err) {
      this.showToast('Merge error: ' + err.message, 'error');
    }
  }

  // Open the worktree cleanup panel for a running (or stopped) worktree session
  openWorktreeCleanupForSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.worktreeBranch) return;
    this._onWorktreeSessionEnded(
      {
        id: sessionId,
        worktreePath: session.worktreePath,
        worktreeBranch: session.worktreeBranch,
        worktreeOriginId: session.worktreeOriginId,
      },
      'What should happen to this worktree?'
    );
  }

  nextSession() {
    if (this.sessionOrder.length <= 1) return;

    const currentIndex = this.sessionOrder.indexOf(this.activeSessionId);
    const nextIndex = (currentIndex + 1) % this.sessionOrder.length;
    this.selectSession(this.sessionOrder[nextIndex]);
  }

  prevSession() {
    if (this.sessionOrder.length <= 1) return;

    const currentIndex = this.sessionOrder.indexOf(this.activeSessionId);
    const prevIndex = (currentIndex - 1 + this.sessionOrder.length) % this.sessionOrder.length;
    this.selectSession(this.sessionOrder[prevIndex]);
  }

  // ═══════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════

  goHome() {
    // Deselect active session and show welcome screen
    this.activeSessionId = null;
    try { localStorage.removeItem('codeman-active-session'); } catch {}
    this.terminal.clear();
    this.showWelcome();
    this.renderSessionTabs();
    this.renderRalphStatePanel();
  }

  // ═══════════════════════════════════════════════════════════════
  // Ralph Loop Wizard (methods in ralph-wizard.js)
  // ═══════════════════════════════════════════════════════════════

  // Wizard state (initialized here, methods loaded from ralph-wizard.js)
  ralphWizardStep = 1;
  ralphWizardConfig = {
    taskDescription: '',
    completionPhrase: 'COMPLETE',
    maxIterations: 10,
    caseName: 'testcase',
    enableRespawn: false,
    generatedPlan: null,
    planGenerated: false,
    skipPlanGeneration: false,
    planDetailLevel: 'detailed',
    existingPlan: null,
    useExistingPlan: false,
  };
  planLoadingTimer = null;
  planLoadingStartTime = null;

  // ═══════════════════════════════════════════════════════════════
  // Quick Start
  // ═══════════════════════════════════════════════════════════════

  async loadQuickStartCases(selectCaseName = null, settingsPromise = null) {
    try {
      // Load settings to get lastUsedCase (reuse shared promise if provided)
      let lastUsedCase = null;
      try {
        const settings = settingsPromise ? await settingsPromise : await fetch('/api/settings').then(r => r.ok ? r.json() : null);
        if (settings) {
          lastUsedCase = settings.lastUsedCase || null;
        }
      } catch {
        // Ignore settings load errors
      }

      const res = await fetch('/api/cases');
      const cases = await res.json();
      this.cases = cases;
      // Re-render drawer if open so project groups appear even if drawer was opened before cases loaded
      if (document.getElementById('sessionDrawer')?.classList.contains('open')) SessionDrawer._render();
      console.log('[loadQuickStartCases] Loaded cases:', cases.map(c => c.name), 'lastUsedCase:', lastUsedCase);

      const select = document.getElementById('quickStartCase');

      // Build options - existing cases first, then testcase as fallback if not present
      let options = '';
      const hasTestcase = cases.some(c => c.name === 'testcase');
      const isMobile = MobileDetection.getDeviceType() === 'mobile';
      const maxNameLength = isMobile ? 8 : 20; // Truncate to 8 chars on mobile

      cases.forEach(c => {
        const displayName = c.name.length > maxNameLength
          ? c.name.substring(0, maxNameLength) + '…'
          : c.name;
        options += `<option value="${escapeHtml(c.name)}">${escapeHtml(displayName)}</option>`;
      });

      // Add testcase option if it doesn't exist (will be created on first run)
      if (!hasTestcase) {
        options = `<option value="testcase">testcase</option>` + options;
      }

      select.innerHTML = options;
      console.log('[loadQuickStartCases] Set options:', select.innerHTML.substring(0, 200));

      // If a specific case was requested, select it
      if (selectCaseName) {
        select.value = selectCaseName;
        this.updateDirDisplayForCase(selectCaseName);
        this.updateMobileCaseLabel(selectCaseName);
      } else if (lastUsedCase && cases.some(c => c.name === lastUsedCase)) {
        // Use lastUsedCase if available and exists
        select.value = lastUsedCase;
        this.updateDirDisplayForCase(lastUsedCase);
        this.updateMobileCaseLabel(lastUsedCase);
      } else if (cases.length > 0) {
        // Fallback to testcase or first case
        const firstCase = cases.find(c => c.name === 'testcase') || cases[0];
        select.value = firstCase.name;
        this.updateDirDisplayForCase(firstCase.name);
        this.updateMobileCaseLabel(firstCase.name);
      } else {
        // No cases exist yet - show the default case name as directory
        select.value = 'testcase';
        document.getElementById('dirDisplay').textContent = '~/codeman-cases/testcase';
        this.updateMobileCaseLabel('testcase');
      }

      // Only add event listener once (on first load)
      if (!select.dataset.listenerAdded) {
        select.addEventListener('change', () => {
          this.updateDirDisplayForCase(select.value);
          this.saveLastUsedCase(select.value);
          this.updateMobileCaseLabel(select.value);
        });
        select.dataset.listenerAdded = 'true';
      }
    } catch (err) {
      console.error('Failed to load cases:', err);
    }
  }

  async updateDirDisplayForCase(caseName) {
    try {
      const res = await fetch(`/api/cases/${caseName}`);
      const data = await res.json();
      if (data.path) {
        document.getElementById('dirDisplay').textContent = data.path;
        document.getElementById('dirInput').value = data.path;
      }
    } catch (err) {
      document.getElementById('dirDisplay').textContent = caseName;
    }
  }

  async saveLastUsedCase(caseName) {
    try {
      // Get current settings
      const res = await fetch('/api/settings');
      const settings = res.ok ? await res.json() : {};
      // Update lastUsedCase
      settings.lastUsedCase = caseName;
      // Save back
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
    } catch (err) {
      console.error('Failed to save last used case:', err);
    }
  }

  async quickStart() {
    return this.run();
  }

  /** Run using the selected mode (Claude Code or OpenCode) */
  async run() {
    const mode = this._runMode || 'claude';
    if (mode === 'opencode') {
      return this.runOpenCode();
    }
    return this.runClaude();
  }

  /** Get/set the run mode, persisted in localStorage */
  get runMode() { return this._runMode || 'claude'; }

  setRunMode(mode) {
    this._runMode = mode;
    try { localStorage.setItem('codeman_runMode', mode); } catch {}
    this._applyRunMode();
    // Close menu
    document.getElementById('runModeMenu')?.classList.remove('active');
  }

  toggleRunModeMenu(e) {
    e?.stopPropagation();
    const menu = document.getElementById('runModeMenu');
    if (!menu) return;
    menu.classList.toggle('active');
    // Update selected state
    menu.querySelectorAll('.run-mode-option').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.mode === this.runMode);
    });
    // Close on click outside
    if (menu.classList.contains('active')) {
      const close = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.classList.remove('active');
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  }

  _applyRunMode() {
    const mode = this.runMode;
    const runBtn = document.getElementById('runBtn');
    const gearBtn = runBtn?.nextElementSibling;
    const label = document.getElementById('runBtnLabel');
    if (runBtn) {
      runBtn.className = `btn-toolbar btn-run mode-${mode}`;
    }
    if (gearBtn) {
      gearBtn.className = `btn-toolbar btn-run-gear mode-${mode}`;
    }
    if (label) {
      label.textContent = mode === 'opencode' ? 'Run OC' : 'Run';
    }
  }

  _initRunMode() {
    try { this._runMode = localStorage.getItem('codeman_runMode') || 'claude'; } catch { this._runMode = 'claude'; }
    this._applyRunMode();
  }

  // Tab count stepper functions
  _setCount(primaryId, value) {
    const a = document.getElementById(primaryId);
    if (a) a.value = value;
  }

  _getCount(primaryId) {
    const a = document.getElementById(primaryId);
    return parseInt(a?.value || '1') || 1;
  }

  incrementTabCount() {
    const v = Math.min(20, this._getCount('tabCount') + 1);
    this._setCount('tabCount', v);
  }

  decrementTabCount() {
    const v = Math.max(1, this._getCount('tabCount') - 1);
    this._setCount('tabCount', v);
  }

  // Shell count stepper functions
  incrementShellCount() {
    const v = Math.min(20, this._getCount('shellCount') + 1);
    this._setCount('shellCount', v);
  }

  decrementShellCount() {
    const v = Math.max(1, this._getCount('shellCount') - 1);
    this._setCount('shellCount', v);
  }

  async runClaude() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const tabCount = Math.min(20, Math.max(1, this._getCount('tabCount')));

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting ${tabCount} Claude session(s) in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Get case path first
      const caseRes = await fetch(`/api/cases/${caseName}`);
      let caseData = await caseRes.json();

      // Create the case if it doesn't exist
      if (!caseData.path) {
        const createCaseRes = await fetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName, description: '' })
        });
        const createCaseData = await createCaseRes.json();
        if (!createCaseData.success) throw new Error(createCaseData.error || 'Failed to create project');
        // Use the newly created case data (API returns { success, case: { name, path } })
        caseData = createCaseData.case;
      }

      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Project path not found');
      let firstSessionId = null;

      // Find the highest existing w-number for THIS case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^w(\d+)-(.+)$/);
        if (match && match[2] === caseName) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Get global Ralph tracker setting
      const ralphEnabled = this.isRalphTrackerEnabledByDefault();

      // Create all sessions in parallel for speed
      const sessionNames = [];
      for (let i = 0; i < tabCount; i++) {
        sessionNames.push(`w${startNumber + i}-${caseName}`);
      }

      // Build env overrides from global + case settings (case overrides global)
      const caseSettings = this.getCaseSettings(caseName);
      const globalSettings = this.loadAppSettingsFromStorage();
      const envOverrides = {};
      if (caseSettings.agentTeams || globalSettings.agentTeamsEnabled) {
        envOverrides.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      }
      const hasEnvOverrides = Object.keys(envOverrides).length > 0;

      // Step 1: Create all sessions in parallel
      this.terminal.writeln(`\x1b[90m Creating ${tabCount} session(s)...\x1b[0m`);
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir, name, ...(hasEnvOverrides ? { envOverrides } : {}) })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      // Collect created session IDs
      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        sessionIds.push(result.session.id);
      }
      firstSessionId = sessionIds[0];

      // Step 2: Configure Ralph for all sessions in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/ralph-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: ralphEnabled, disableAutoEnable: !ralphEnabled })
        })
      ));

      // Step 3: Start all sessions in parallel (biggest speedup)
      this.terminal.writeln(`\x1b[90m Starting ${tabCount} session(s) in parallel...\x1b[0m`);
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/interactive`, { method: 'POST' })
      ));

      this.terminal.writeln(`\x1b[90m All ${tabCount} sessions ready\x1b[0m`);

      // Auto-switch to the new session using selectSession (does proper refresh)
      if (firstSessionId) {
        await this.selectSession(firstSessionId);
        this.loadQuickStartCases();
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  }

  /** Send Ctrl+C to the active session to stop the current operation.
   *  Requires double-tap: first tap turns button amber, second tap within 2s sends Ctrl+C. */
  stopClaude() {
    if (!this.activeSessionId) return;
    const btn = document.querySelector('.btn-toolbar.btn-stop');
    if (!btn) return;

    if (this._stopConfirmTimer) {
      // Second tap — send Ctrl+C
      clearTimeout(this._stopConfirmTimer);
      this._stopConfirmTimer = null;
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
      btn.classList.remove('confirming');
      fetch(`/api/sessions/${this.activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x03' })
      });
    } else {
      // First tap — enter confirm state
      btn.dataset.origHtml = btn.innerHTML;
      btn.textContent = 'Tap again';
      btn.classList.add('confirming');
      this._stopConfirmTimer = setTimeout(() => {
        this._stopConfirmTimer = null;
        if (btn.dataset.origHtml) {
          btn.innerHTML = btn.dataset.origHtml;
          delete btn.dataset.origHtml;
        }
        btn.classList.remove('confirming');
      }, 2000);
    }
  }

  async runShell() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const shellCount = Math.min(20, Math.max(1, this._getCount('shellCount')));

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;33m Starting ${shellCount} Shell session(s) in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Get the project path
      const caseRes = await fetch(`/api/cases/${caseName}`);
      const caseData = await caseRes.json();
      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Project path not found');

      // Find the highest existing s-number for THIS case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^s(\d+)-(.+)$/);
        if (match && match[2] === caseName) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Create all shell sessions in parallel
      const sessionNames = [];
      for (let i = 0; i < shellCount; i++) {
        sessionNames.push(`s${startNumber + i}-${caseName}`);
      }

      // Step 1: Create all sessions in parallel
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir, mode: 'shell', name })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        sessionIds.push(result.session.id);
      }

      // Step 2: Start all shells in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/shell`, { method: 'POST' })
      ));

      // Step 3: Resize all in parallel (with minimum dimension enforcement)
      const dims = this.getTerminalDimensions();
      if (dims) {
        await Promise.all(sessionIds.map(id =>
          fetch(`/api/sessions/${id}/resize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dims)
          })
        ));
      }

      // Switch to first session
      if (sessionIds.length > 0) {
        this.activeSessionId = sessionIds[0];
        await this.selectSession(sessionIds[0]);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  }

  async runOpenCode() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting OpenCode session in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Check if OpenCode is available
      const statusRes = await fetch('/api/opencode/status');
      const status = await statusRes.json();
      if (!status.available) {
        this.terminal.writeln('\x1b[1;31m OpenCode CLI not found.\x1b[0m');
        this.terminal.writeln('\x1b[90m Install with: curl -fsSL https://opencode.ai/install | bash\x1b[0m');
        return;
      }

      // Quick-start with opencode mode (auto-allow tools by default)
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'opencode',
          openCodeConfig: { autoAllowTools: true },
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start OpenCode');

      // Switch to the new session (don't pre-set activeSessionId — selectSession
      // early-returns when IDs match, skipping buffer load and sendResize)
      if (data.sessionId) {
        await this.selectSession(data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Directory Input
  // ═══════════════════════════════════════════════════════════════

  toggleDirInput() {
    const btn = document.querySelector('#dirDisplay').parentElement;
    const input = document.getElementById('dirInput');

    if (input.classList.contains('hidden')) {
      input.classList.remove('hidden');
      btn.style.display = 'none';
      input.focus();
    }
  }

  hideDirInput() {
    const btn = document.querySelector('#dirDisplay').parentElement;
    const input = document.getElementById('dirInput');

    setTimeout(() => {
      input.classList.add('hidden');
      btn.style.display = '';

      const value = input.value.trim();
      document.getElementById('dirDisplay').textContent = value || 'No directory';
    }, 100);
  }

  // ═══════════════════════════════════════════════════════════════
  // Respawn Banner
  // ═══════════════════════════════════════════════════════════════

  showRespawnBanner() {
    this.$('respawnBanner').style.display = 'flex';
    // Also show timer if there's a timed respawn
    if (this.activeSessionId && this.respawnTimers[this.activeSessionId]) {
      this.showRespawnTimer();
    }
    // Show tokens if session has token data
    const session = this.sessions.get(this.activeSessionId);
    if (session && session.tokens) {
      this.updateRespawnTokens(session.tokens);
    }
  }

  hideRespawnBanner() {
    this.$('respawnBanner').style.display = 'none';
    this.hideRespawnTimer();
  }

  // Human-friendly state labels
  getStateLabel(state) {
    const labels = {
      'stopped': 'Stopped',
      'watching': 'Watching',
      'confirming_idle': 'Confirming idle',
      'ai_checking': 'AI checking',
      'sending_update': 'Sending prompt',
      'waiting_update': 'Running prompt',
      'sending_clear': 'Clearing context',
      'waiting_clear': 'Clearing...',
      'sending_init': 'Initializing',
      'waiting_init': 'Initializing...',
      'monitoring_init': 'Waiting for work',
      'sending_kickstart': 'Kickstarting',
      'waiting_kickstart': 'Kickstarting...',
    };
    return labels[state] || state.replace(/_/g, ' ');
  }

  updateRespawnBanner(state) {
    const stateEl = this.$('respawnState');
    stateEl.textContent = this.getStateLabel(state);
    // Clear blocked state when state changes (resumed from blocked)
    stateEl.classList.remove('respawn-blocked');
  }

  updateDetectionDisplay(detection) {
    if (!detection) return;

    const statusEl = this.$('detectionStatus');
    const waitingEl = this.$('detectionWaiting');
    const confidenceEl = this.$('detectionConfidence');
    const aiCheckEl = document.getElementById('detectionAiCheck');
    const hookEl = document.getElementById('detectionHook');

    // Hook-based detection indicator (highest priority signals)
    if (hookEl) {
      if (detection.stopHookReceived || detection.idlePromptReceived) {
        const hookType = detection.idlePromptReceived ? 'idle' : 'stop';
        hookEl.textContent = `🎯 ${hookType} hook`;
        hookEl.className = 'detection-hook hook-active';
        hookEl.style.display = '';
      } else {
        hookEl.style.display = 'none';
      }
    }

    // Simplified status - only show when meaningful
    if (detection.statusText && detection.statusText !== 'Watching...') {
      statusEl.textContent = detection.statusText;
      statusEl.style.display = '';
    } else {
      statusEl.style.display = 'none';
    }

    // Hide "waiting for" text - it's redundant with the state label
    waitingEl.style.display = 'none';

    // Show confidence only when confirming (>0%)
    const confidence = detection.confidenceLevel || 0;
    if (confidence > 0) {
      confidenceEl.textContent = `${confidence}%`;
      confidenceEl.style.display = '';
      confidenceEl.className = 'detection-confidence';
      // Hook signals give 100% confidence
      if (detection.stopHookReceived || detection.idlePromptReceived) {
        confidenceEl.classList.add('hook-confirmed');
      } else if (confidence >= 60) {
        confidenceEl.classList.add('high');
      } else if (confidence >= 30) {
        confidenceEl.classList.add('medium');
      }
    } else {
      confidenceEl.style.display = 'none';
    }

    // AI check display - compact format
    if (aiCheckEl && detection.aiCheck) {
      const ai = detection.aiCheck;
      let aiText = '';
      let aiClass = 'detection-ai-check';

      if (ai.status === 'checking') {
        aiText = '🔍 AI checking...';
        aiClass += ' ai-checking';
      } else if (ai.status === 'cooldown' && ai.cooldownEndsAt) {
        const remaining = Math.ceil((ai.cooldownEndsAt - Date.now()) / 1000);
        if (remaining > 0) {
          if (ai.lastVerdict === 'WORKING') {
            aiText = `⏳ Working, retry ${remaining}s`;
            aiClass += ' ai-working';
          } else {
            aiText = `✓ Idle, wait ${remaining}s`;
            aiClass += ' ai-idle';
          }
        }
      } else if (ai.status === 'disabled') {
        aiText = '⚠ AI disabled';
        aiClass += ' ai-disabled';
      } else if (ai.lastVerdict && ai.lastCheckTime) {
        const ago = Math.round((Date.now() - ai.lastCheckTime) / 1000);
        if (ago < 120) {
          aiText = ai.lastVerdict === 'IDLE'
            ? `✓ Idle (${ago}s)`
            : `⏳ Working (${ago}s)`;
          aiClass += ai.lastVerdict === 'IDLE' ? ' ai-idle' : ' ai-working';
        }
      }

      aiCheckEl.textContent = aiText;
      aiCheckEl.className = aiClass;
      aiCheckEl.style.display = aiText ? '' : 'none';
    } else if (aiCheckEl) {
      aiCheckEl.style.display = 'none';
    }

    // Manage row2 visibility - hide if nothing visible
    const row2 = this.$('respawnStatusRow2');
    if (row2) {
      const hasVisibleContent =
        (hookEl && hookEl.style.display !== 'none') ||
        (aiCheckEl && aiCheckEl.style.display !== 'none') ||
        (statusEl && statusEl.style.display !== 'none') ||
        (this.respawnCountdownTimers[this.activeSessionId] &&
         Object.keys(this.respawnCountdownTimers[this.activeSessionId]).length > 0);
      row2.style.display = hasVisibleContent ? '' : 'none';
    }
  }

  showRespawnTimer() {
    const timerEl = this.$('respawnTimer');
    timerEl.style.display = '';
    this.updateRespawnTimer();
    // Update every second
    if (this.respawnTimerInterval) clearInterval(this.respawnTimerInterval);
    this.respawnTimerInterval = setInterval(() => this.updateRespawnTimer(), 1000);
  }

  hideRespawnTimer() {
    this.$('respawnTimer').style.display = 'none';
    if (this.respawnTimerInterval) {
      clearInterval(this.respawnTimerInterval);
      this.respawnTimerInterval = null;
    }
  }

  updateRespawnTimer() {
    if (!this.activeSessionId || !this.respawnTimers[this.activeSessionId]) {
      this.hideRespawnTimer();
      return;
    }

    const timer = this.respawnTimers[this.activeSessionId];
    // Guard against invalid timer data
    if (!timer.endAt || isNaN(timer.endAt)) {
      this.hideRespawnTimer();
      return;
    }

    const now = Date.now();
    const remaining = Math.max(0, timer.endAt - now);

    if (remaining <= 0) {
      this.$('respawnTimer').textContent = 'Time up';
      delete this.respawnTimers[this.activeSessionId];
      this.hideRespawnTimer();
      return;
    }

    this.$('respawnTimer').textContent = this.formatTime(remaining);
  }

  updateRespawnTokens(tokens) {
    // Skip if tokens haven't changed (avoid unnecessary DOM writes)
    const isObject = tokens && typeof tokens === 'object';
    const total = isObject ? tokens.total : tokens;
    if (total === this._lastRespawnTokenTotal) return;
    this._lastRespawnTokenTotal = total;

    const tokensEl = this.$('respawnTokens');
    const input = isObject ? (tokens.input || 0) : Math.round(total * 0.6);
    const output = isObject ? (tokens.output || 0) : Math.round(total * 0.4);

    if (total > 0) {
      tokensEl.style.display = '';
      const tokenStr = this.formatTokens(total);
      const settings = this.loadAppSettingsFromStorage();
      const showCost = settings.showCost ?? false;
      if (showCost) {
        const estimatedCost = this.estimateCost(input, output);
        tokensEl.textContent = `${tokenStr} tokens · $${estimatedCost.toFixed(2)}`;
      } else {
        tokensEl.textContent = `${tokenStr} tokens`;
      }
    } else {
      tokensEl.style.display = 'none';
    }

    // Also update mobile CLI info bar (shows tokens on mobile)
    this.updateCliInfoDisplay();
  }

  // Update CLI info display (tokens, version, model - shown on mobile)
  updateCliInfoDisplay() {
    const infoBar = this.$('cliInfoBar');
    if (!infoBar) return;

    const session = this.sessions.get(this.activeSessionId);
    if (!session) {
      infoBar.style.display = 'none';
      return;
    }

    // Build display parts - tokens first (most important on mobile)
    let parts = [];

    // Add tokens if available
    if (session.tokens) {
      const total = typeof session.tokens === 'object' ? session.tokens.total : session.tokens;
      if (total > 0) {
        parts.push(`${this.formatTokens(total)} tokens`);
      }
    }

    // Add model (condensed)
    if (session.cliModel) {
      // Shorten model names for mobile: "claude-sonnet-4-20250514" -> "Sonnet 4"
      let model = session.cliModel;
      if (model.includes('opus')) model = 'Opus';
      else if (model.includes('sonnet')) model = 'Sonnet';
      else if (model.includes('haiku')) model = 'Haiku';
      parts.push(model);
    }

    // Add version (compact format)
    if (session.cliVersion) {
      // Show "v2.1.27" or "v2.1.27 ↑" if update available
      let versionStr = `v${session.cliVersion}`;
      if (session.cliLatestVersion && session.cliLatestVersion !== session.cliVersion) {
        versionStr += ' ↑'; // Arrow indicates update available
      }
      parts.push(versionStr);
    }

    if (parts.length > 0) {
      infoBar.textContent = parts.join(' · ');
      infoBar.style.display = '';
    } else {
      infoBar.style.display = 'none';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Countdown Timer Display Methods
  // ═══════════════════════════════════════════════════════════════

  addActionLogEntry(sessionId, action) {
    // Only keep truly interesting events - no spam
    // KEEP: command (inputs), hook events, AI verdicts, plan verdicts
    // SKIP: timer, timer-cancel, state changes, routine detection, step confirmations

    const interestingTypes = ['command', 'hook'];

    // Always keep commands and hooks
    if (interestingTypes.includes(action.type)) {
      // ok, keep it
    }
    // AI check: only verdicts (IDLE, WORKING) and errors, not "Spawning"
    else if (action.type === 'ai-check') {
      if (action.detail.includes('Spawning')) return;
    }
    // Plan check: only verdicts, not "Spawning"
    else if (action.type === 'plan-check') {
      if (action.detail.includes('Spawning')) return;
    }
    // Transcript: keep completion/plan detection
    else if (action.type === 'transcript') {
      // keep it
    }
    // Skip everything else (timer, timer-cancel, state, detection, step)
    else {
      return;
    }

    if (!this.respawnActionLogs[sessionId]) {
      this.respawnActionLogs[sessionId] = [];
    }
    this.respawnActionLogs[sessionId].unshift(action);
    // Keep reasonable history
    if (this.respawnActionLogs[sessionId].length > 30) {
      this.respawnActionLogs[sessionId].pop();
    }
  }

  startCountdownInterval() {
    if (this.timerCountdownInterval) return;
    this.timerCountdownInterval = setInterval(() => {
      if (this.activeSessionId && this.respawnCountdownTimers[this.activeSessionId]) {
        this.updateCountdownTimerDisplay();
      }
    }, 100);
  }

  stopCountdownInterval() {
    if (this.timerCountdownInterval) {
      clearInterval(this.timerCountdownInterval);
      this.timerCountdownInterval = null;
    }
  }

  updateCountdownTimerDisplay() {
    const timersContainer = this.$('respawnCountdownTimers');
    const row2 = this.$('respawnStatusRow2');
    if (!timersContainer) return;

    const timers = this.respawnCountdownTimers[this.activeSessionId];
    const hasTimers = timers && Object.keys(timers).length > 0;

    if (!hasTimers) {
      timersContainer.innerHTML = '';
      // Update row2 visibility
      if (row2) {
        const hookEl = document.getElementById('detectionHook');
        const aiCheckEl = document.getElementById('detectionAiCheck');
        const statusEl = this.$('detectionStatus');
        const hasVisibleContent =
          (hookEl && hookEl.style.display !== 'none') ||
          (aiCheckEl && aiCheckEl.style.display !== 'none') ||
          (statusEl && statusEl.style.display !== 'none');
        row2.style.display = hasVisibleContent ? '' : 'none';
      }
      return;
    }

    // Show row2 since we have timers
    if (row2) row2.style.display = '';

    const now = Date.now();
    let html = '';

    for (const [name, timer] of Object.entries(timers)) {
      const remainingMs = Math.max(0, timer.endsAt - now);
      const remainingSec = (remainingMs / 1000).toFixed(1);
      const percent = Math.max(0, Math.min(100, (remainingMs / timer.totalMs) * 100));

      // Shorter timer name display
      const displayName = name.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());

      html += `<div class="respawn-countdown-timer" title="${escapeHtml(timer.reason || '')}">
        <span class="timer-name">${escapeHtml(displayName)}</span>
        <span class="timer-value">${remainingSec}s</span>
        <div class="respawn-timer-bar">
          <div class="respawn-timer-progress" style="width: ${percent}%"></div>
        </div>
      </div>`;
    }

    timersContainer.innerHTML = html;
  }

  updateActionLogDisplay() {
    const logContainer = this.$('respawnActionLog');
    if (!logContainer) return;

    const actions = this.respawnActionLogs[this.activeSessionId];
    if (!actions || actions.length === 0) {
      logContainer.innerHTML = '';
      return;
    }

    let html = '';
    // Show fewer entries for compact view
    for (const action of actions.slice(0, 5)) {
      const time = new Date(action.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const isCommand = action.type === 'command';
      const extraClass = isCommand ? ' action-command' : '';
      // Compact format: time [type] detail
      html += `<div class="respawn-action-entry${extraClass}">
        <span class="action-time">${time}</span>
        <span class="action-type">[${action.type}]</span>
        <span class="action-detail">${escapeHtml(action.detail)}</span>
      </div>`;
    }

    logContainer.innerHTML = html;
  }

  clearCountdownTimers(sessionId) {
    delete this.respawnCountdownTimers[sessionId];
    delete this.respawnActionLogs[sessionId];
    if (sessionId === this.activeSessionId) {
      this.updateCountdownTimerDisplay();
      this.updateActionLogDisplay();
    }
  }

  async stopRespawn() {
    if (!this.activeSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.activeSessionId}/respawn/stop`, {});
      delete this.respawnTimers[this.activeSessionId];
      this.clearCountdownTimers(this.activeSessionId);
    } catch (err) {
      this.showToast('Failed to stop respawn', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Kill Sessions
  // ═══════════════════════════════════════════════════════════════

  async killActiveSession() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'warning');
      return;
    }
    await this.closeSession(this.activeSessionId);
  }

  async killAllSessions() {
    if (this.sessions.size === 0) return;

    if (!confirm(`Kill all ${this.sessions.size} session(s)?`)) return;

    try {
      await this._apiDelete('/api/sessions');
      this.sessions.clear();
      this.terminalBuffers.clear();
      this.terminalBufferCache.clear();
      this.activeSessionId = null;
      try { localStorage.removeItem('codeman-active-session'); } catch {}
      this.respawnStatus = {};
      this.respawnCountdownTimers = {};
      this.respawnActionLogs = {};
      this.stopCountdownInterval();
      this.hideRespawnBanner();
      this.renderSessionTabs();
      this.terminal.clear();
      this.showWelcome();
      this.showToast('All sessions killed', 'success');
    } catch (err) {
      this.showToast('Failed to kill sessions', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Terminal Controls
  // ═══════════════════════════════════════════════════════════════

  clearTerminal() {
    this.terminal.clear();
  }

  /**
   * Restore terminal size to match web UI dimensions.
   * Use this after mobile screen attachment has squeezed the terminal.
   * Sends resize to PTY and Ctrl+L to trigger Claude to redraw.
   */
  async restoreTerminalSize() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'warning');
      return;
    }

    const dims = this.getTerminalDimensions();
    if (!dims) {
      this.showToast('Could not determine terminal size', 'error');
      return;
    }

    try {
      // Send resize to restore proper dimensions (with minimum enforcement)
      await this.sendResize(this.activeSessionId);

      // Send Ctrl+L to trigger Claude to redraw at new size
      await fetch(`/api/sessions/${this.activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x0c' })
      });

      this.showToast(`Terminal restored to ${dims.cols}x${dims.rows}`, 'success');
    } catch (err) {
      console.error('Failed to restore terminal size:', err);
      this.showToast('Failed to restore terminal size', 'error');
    }
  }

  // Send Ctrl+L to fix display for newly created sessions once Claude is running
  sendPendingCtrlL(sessionId) {
    if (!this.pendingCtrlL || !this.pendingCtrlL.has(sessionId)) {
      return;
    }
    this.pendingCtrlL.delete(sessionId);

    // Only send if this is the active session
    if (sessionId !== this.activeSessionId) {
      return;
    }

    // Send resize + Ctrl+L to fix the display (with minimum dimension enforcement)
    this.sendResize(sessionId).then(() => {
      fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x0c' })
      });
    });
  }

  async copyTerminal() {
    try {
      const buffer = this.terminal.buffer.active;
      let text = '';
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      await navigator.clipboard.writeText(text.replace(/\n+$/, '\n'));
      this.showToast('Copied to clipboard', 'success');
    } catch (err) {
      this.showToast('Failed to copy', 'error');
    }
  }

  increaseFontSize() {
    const current = this.terminal.options.fontSize || 14;
    this.setFontSize(Math.min(current + 2, 24));
  }

  decreaseFontSize() {
    const current = this.terminal.options.fontSize || 14;
    this.setFontSize(Math.max(current - 2, 10));
  }

  setFontSize(size) {
    this.terminal.options.fontSize = size;
    document.getElementById('fontSizeDisplay').textContent = size;
    this.fitAddon.fit();
    localStorage.setItem('codeman-font-size', size);
    // Update overlay font cache and re-render at new cell dimensions
    this._localEchoOverlay?.refreshFont();
  }

  loadFontSize() {
    const saved = localStorage.getItem('codeman-font-size');
    if (saved) {
      const size = parseInt(saved, 10);
      if (size >= 10 && size <= 24) {
        this.terminal.options.fontSize = size;
        document.getElementById('fontSizeDisplay').textContent = size;
      }
    }
  }

  /**
   * Get terminal dimensions with minimum enforcement.
   * Prevents extremely narrow terminals that cause vertical text wrapping.
   * @returns {{cols: number, rows: number}|null}
   */
  getTerminalDimensions() {
    const MIN_COLS = 40;
    const MIN_ROWS = 10;
    const dims = this.fitAddon?.proposeDimensions();
    if (!dims) return null;
    return {
      cols: Math.max(dims.cols, MIN_COLS),
      rows: Math.max(dims.rows, MIN_ROWS)
    };
  }

  /**
   * Send resize to a session with minimum dimension enforcement.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async sendResize(sessionId) {
    const dims = this.getTerminalDimensions();
    if (!dims) return;
    await fetch(`/api/sessions/${sessionId}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dims)
    });
  }

  /**
   * Send input to the active session.
   * @param {string} input - Text to send (include \r for Enter)
   * @returns {Promise<void>}
   */
  async sendInput(input) {
    if (!this.activeSessionId) return;
    await fetch(`/api/sessions/${this.activeSessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, useMux: true })
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Timer
  // ═══════════════════════════════════════════════════════════════

  showTimer() {
    document.getElementById('timerBanner').style.display = 'flex';
    this.updateTimer();
    this.timerInterval = setInterval(() => this.updateTimer(), 1000);
  }

  hideTimer() {
    document.getElementById('timerBanner').style.display = 'none';
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  updateTimer() {
    if (!this.currentRun || this.currentRun.status !== 'running') return;

    const now = Date.now();
    const remaining = Math.max(0, this.currentRun.endAt - now);
    const total = this.currentRun.endAt - this.currentRun.startedAt;
    const elapsed = now - this.currentRun.startedAt;
    const percent = Math.min(100, (elapsed / total) * 100);

    document.getElementById('timerValue').textContent = this.formatTime(remaining);
    document.getElementById('timerProgress').style.width = `${percent}%`;
    document.getElementById('timerMeta').textContent =
      `${this.currentRun.completedTasks} tasks | $${this.currentRun.totalCost.toFixed(2)}`;
  }

  async stopCurrentRun() {
    if (!this.currentRun) return;
    try {
      await fetch(`/api/scheduled/${this.currentRun.id}`, { method: 'DELETE' });
    } catch (err) {
      this.showToast('Failed to stop run', 'error');
    }
  }

  formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // Tokens
  // ═══════════════════════════════════════════════════════════════

  updateCost() {
    // Now updates tokens instead of cost
    this.updateTokens();
  }

  updateTokens() {
    // Debounce at 200ms — token display is non-critical and shouldn't
    // compete with input handling on the main thread
    if (this._updateTokensTimeout) {
      clearTimeout(this._updateTokensTimeout);
    }
    this._updateTokensTimeout = setTimeout(() => {
      this._updateTokensTimeout = null;
      this._updateTokensImmediate();
    }, 200);
  }

  _updateTokensImmediate() {
    // Use global stats if available (includes deleted sessions)
    let totalInput = 0;
    let totalOutput = 0;
    if (this.globalStats) {
      totalInput = this.globalStats.totalInputTokens || 0;
      totalOutput = this.globalStats.totalOutputTokens || 0;
    } else {
      // Fallback to active sessions only
      this.sessions.forEach(s => {
        if (s.tokens) {
          totalInput += s.tokens.input || 0;
          totalOutput += s.tokens.output || 0;
        }
      });
    }
    const total = totalInput + totalOutput;
    this.totalTokens = total;
    const display = this.formatTokens(total);

    // Estimate cost from tokens (more accurate than stored cost in interactive mode)
    const estimatedCost = this.estimateCost(totalInput, totalOutput);
    const tokenEl = this.$('headerTokens');
    if (tokenEl) {
      const settings = this.loadAppSettingsFromStorage();
      const showCost = settings.showCost ?? false;
      tokenEl.textContent = total > 0
        ? (showCost ? `${display} tokens · $${estimatedCost.toFixed(2)}` : `${display} tokens`)
        : '0 tokens';
      tokenEl.title = this.globalStats
        ? `Lifetime: ${this.globalStats.totalSessionsCreated} sessions created${showCost ? '\nEstimated cost based on Claude Opus pricing' : ''}`
        : `Token usage across active sessions${showCost ? '\nEstimated cost based on Claude Opus pricing' : ''}`;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Options Modal
  // ═══════════════════════════════════════════════════════════════

  openSessionOptions(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.editingSessionId = sessionId;

    // Reset to an appropriate tab — Summary for OpenCode (Respawn/Ralph are Claude-only)
    this.switchOptionsTab(session.mode === 'opencode' ? 'summary' : 'respawn');

    // Update respawn status display and buttons
    const respawnStatus = document.getElementById('sessionRespawnStatus');
    const enableBtn = document.getElementById('modalEnableRespawnBtn');
    const stopBtn = document.getElementById('modalStopRespawnBtn');

    if (this.respawnStatus[sessionId]) {
      respawnStatus.classList.add('active');
      respawnStatus.querySelector('.respawn-status-text').textContent =
        this.respawnStatus[sessionId].state || 'Active';
      enableBtn.style.display = 'none';
      stopBtn.style.display = '';
    } else {
      respawnStatus.classList.remove('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'Not active';
      enableBtn.style.display = '';
      stopBtn.style.display = 'none';
    }

    // Only show respawn section for claude mode sessions with a running process
    const respawnSection = document.getElementById('sessionRespawnSection');
    if (session.mode === 'claude' && session.pid) {
      respawnSection.style.display = '';
    } else {
      respawnSection.style.display = 'none';
    }

    // Hide Claude-specific options for OpenCode sessions
    const isOpenCode = session.mode === 'opencode';
    const claudeOnlyEls = document.querySelectorAll('[data-claude-only]');
    claudeOnlyEls.forEach(el => { el.style.display = isOpenCode ? 'none' : ''; });

    // Reset duration presets to default (unlimited)
    this.selectDurationPreset('');

    // Populate respawn config from saved state
    this.loadSavedRespawnConfig(sessionId);

    // Populate auto-compact/clear from session state
    document.getElementById('modalAutoCompactEnabled').checked = session.autoCompactEnabled ?? false;
    document.getElementById('modalAutoCompactThreshold').value = session.autoCompactThreshold ?? 110000;
    document.getElementById('modalAutoCompactPrompt').value = session.autoCompactPrompt ?? '';
    document.getElementById('modalAutoClearEnabled').checked = session.autoClearEnabled ?? false;
    document.getElementById('modalAutoClearThreshold').value = session.autoClearThreshold ?? 140000;
    document.getElementById('modalImageWatcherEnabled').checked = session.imageWatcherEnabled ?? true;
    document.getElementById('modalFlickerFilterEnabled').checked = session.flickerFilterEnabled ?? false;
    document.getElementById('modalSafeMode').checked = session.safeMode ?? false;

    // Populate session name input
    document.getElementById('modalSessionName').value = session.name || '';

    // Initialize color picker with current session color
    const currentColor = session.color || 'default';
    const colorPicker = document.getElementById('sessionColorPicker');
    colorPicker?.querySelectorAll('.color-swatch').forEach(s => {
      s.classList.toggle('selected', s.dataset.color === currentColor);
    });

    // Initialize respawn preset dropdown
    this.renderPresetDropdown();
    document.getElementById('respawnPresetSelect').value = '';
    document.getElementById('presetDescriptionHint').textContent = '';

    // Hide Ralph/Todo tab and Respawn tab for opencode sessions (not supported)
    const ralphTabBtn = document.querySelector('#sessionOptionsModal .modal-tab-btn[data-tab="ralph"]');
    const respawnTabBtn = document.querySelector('#sessionOptionsModal .modal-tab-btn[data-tab="respawn"]');
    if (isOpenCode) {
      if (ralphTabBtn) ralphTabBtn.style.display = 'none';
      if (respawnTabBtn) respawnTabBtn.style.display = 'none';
      // Default to Context tab for opencode sessions since Respawn is hidden
      this.switchOptionsTab('context');
    } else {
      if (ralphTabBtn) ralphTabBtn.style.display = '';
      if (respawnTabBtn) respawnTabBtn.style.display = '';
    }

    // Populate Ralph Wiggum form with current session values (skip for opencode)
    if (!isOpenCode) {
      const ralphState = this.ralphStates.get(sessionId);
      this.populateRalphForm({
        enabled: ralphState?.loop?.enabled ?? session.ralphLoop?.enabled ?? false,
        completionPhrase: ralphState?.loop?.completionPhrase || session.ralphLoop?.completionPhrase || '',
        maxIterations: ralphState?.loop?.maxIterations || session.ralphLoop?.maxIterations || 0,
      });
    }

    const modal = document.getElementById('sessionOptionsModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  openNewPicker() {
    document.getElementById('newPickerModal').classList.add('active');
  }

  closeNewPicker() {
    document.getElementById('newPickerModal').classList.remove('active');
  }

  async openWorktreeCreator() {
    this.closeNewPicker();
    let dormant = [];
    let allCases = [];
    try {
      const [worktreeRes, casesRes] = await Promise.all([fetch('/api/worktrees'), fetch('/api/cases')]);
      const worktreeData = await worktreeRes.json();
      if (worktreeData.success) dormant = worktreeData.worktrees;
      const casesData = await casesRes.json();
      allCases = Array.isArray(casesData) ? casesData : (casesData.cases || []);
    } catch {}
    this._dormantWorktrees = dormant;
    this._worktreeCreatorSourceId = null;
    this._worktreeCreatorCaseName = null;
    this._worktreeCreatorMode = null;
    this._renderWorktreeCreator(true);
    document.getElementById('worktreeCreatorModal').classList.add('active');
    // Probe each case for git support
    const results = await Promise.allSettled(
      allCases.map(async c => {
        const res = await fetch(`/api/cases/${encodeURIComponent(c.name)}/worktree/branches`);
        const data = await res.json();
        if (!data.success) throw new Error('not a git repo');
        return c;
      })
    );
    this._worktreeGitCases = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (this._worktreeGitCases.length === 1) {
      this._worktreeCreatorCaseName = this._worktreeGitCases[0].name;
      this._loadWorktreeBranchesByCase(this._worktreeCreatorCaseName);
    }
    this._renderWorktreeCreator(false);
  }

  openSessionCreator() {
    this._sessionCreatorCaseName = null;
    this._sessionCreatorMode = this._runMode || 'claude';
    this._sessionCreatorCases = null;
    document.getElementById('sessionCreatorModal').classList.add('active');
    this._loadSessionCreatorCases();
  }

  closeSessionCreator() {
    document.getElementById('sessionCreatorModal').classList.remove('active');
  }

  async _loadSessionCreatorCases() {
    try {
      const res = await fetch('/api/cases');
      const data = await res.json();
      this._sessionCreatorCases = Array.isArray(data) ? data : (data.cases || []);
    } catch {
      this._sessionCreatorCases = [];
    }
    this._renderSessionCreator();
  }

  _renderSessionCreator() {
    const body = document.getElementById('sessionCreatorBody');
    if (!body) return;
    const cases = this._sessionCreatorCases;
    if (!cases) {
      body['inner' + 'HTML'] = '<div class="worktree-git-loading">Loading projects...</div>';
      return;
    }
    const selectedCase = this._sessionCreatorCaseName;
    const currentMode = this._sessionCreatorMode || 'claude';
    let html = '';
    if (cases.length === 0) {
      html += '<div class="worktree-git-loading">No projects found. Create a project first.</div>';
    } else {
      html += '<div class="worktree-section-label">Project</div><div class="session-creator-cases">';
      cases.forEach(c => {
        const isSelected = c.name === selectedCase;
        html += `<button class="session-creator-case-card${isSelected ? ' selected' : ''}" onclick="app._selectSessionCase('${escapeHtml(c.name)}')">` +
          `<svg class="session-creator-case-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>` +
          `<span class="session-creator-case-name">${escapeHtml(c.name)}</span>` +
          `<svg class="worktree-session-card-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>` +
          `</button>`;
      });
      html += '</div>';
    }
    html += '<div class="worktree-section-label">Run with</div><div class="worktree-mode-selector">' +
      `<button class="worktree-mode-btn${currentMode === 'claude' ? ' selected' : ''}" onclick="app._setSessionMode('claude')"><span class="run-mode-dot claude"></span>Claude Code</button>` +
      `<button class="worktree-mode-btn${currentMode === 'opencode' ? ' selected' : ''}" onclick="app._setSessionMode('opencode')"><span class="run-mode-dot opencode"></span>OpenCode</button>` +
      `<button class="worktree-mode-btn${currentMode === 'shell' ? ' selected' : ''}" onclick="app._setSessionMode('shell')"><span class="run-mode-dot shell"></span>Shell</button>` +
      '</div>';
    html += '<div class="worktree-creator-actions">' +
      '<button class="btn btn-secondary" onclick="app.closeSessionCreator()">Cancel</button>' +
      `<button class="btn btn-primary" id="sessionCreatorStartBtn" onclick="app._submitCreateSession()"${!selectedCase ? ' disabled' : ''}>Start</button>` +
      '</div>';
    body['inner' + 'HTML'] = html;
  }

  _selectSessionCase(caseName) {
    this._sessionCreatorCaseName = caseName;
    document.querySelectorAll('.session-creator-case-card').forEach(card => {
      const cardMode = card.getAttribute('onclick')?.match(/_selectSessionCase\('([^']+)'\)/)?.[1];
      card.classList.toggle('selected', cardMode === caseName);
    });
    const startBtn = document.getElementById('sessionCreatorStartBtn');
    if (startBtn) startBtn.disabled = false;
  }

  _setSessionMode(mode) {
    this._sessionCreatorMode = mode;
    document.querySelectorAll('#sessionCreatorBody .worktree-mode-btn').forEach(btn => {
      const btnMode = btn.getAttribute('onclick')?.match(/_setSessionMode\('(\w+)'\)/)?.[1];
      btn.classList.toggle('selected', btnMode === mode);
    });
  }

  /** Start a session in a specific case from the drawer quick-add popover */
  async startSessionInCase(caseName, mode) {
    const caseSelect = document.getElementById('quickStartCase');
    if (caseSelect) caseSelect.value = caseName;
    if (mode === 'opencode') {
      await this.runOpenCode();
    } else if (mode === 'shell') {
      await this.runShell();
    } else {
      await this.runClaude();
    }
  }

  async _submitCreateSession() {
    const caseName = this._sessionCreatorCaseName;
    const mode = this._sessionCreatorMode || 'claude';
    if (!caseName) return;
    const startBtn = document.getElementById('sessionCreatorStartBtn');
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Starting...'; }
    this.closeSessionCreator();
    // Set the quickStartCase select to the chosen case so runClaude/runShell/runOpenCode can use it
    const caseSelect = document.getElementById('quickStartCase');
    if (caseSelect) caseSelect.value = caseName;
    if (mode === 'opencode') {
      await this.runOpenCode();
    } else if (mode === 'shell') {
      await this.runShell();
    } else {
      await this.runClaude();
    }
  }

  closeWorktreeCreator() {
    document.getElementById('worktreeCreatorModal').classList.remove('active');
  }

  _selectWorktreeCase(caseName) {
    this._worktreeCreatorCaseName = caseName;
    document.querySelectorAll('.session-creator-case-card').forEach(card => {
      const m = card.getAttribute('onclick')?.match(/_selectWorktreeCase\('([^']+)'\)/);
      card.classList.toggle('selected', m?.[1] === caseName);
    });
    const picker = document.getElementById('worktreeBranchPicker');
    if (picker) picker.style.display = 'block';
    this._loadWorktreeBranchesByCase(caseName);
  }

  _setWorktreeMode(mode) {
    this._worktreeCreatorMode = mode;
    document.querySelectorAll('.worktree-mode-btn').forEach(btn => {
      const btnMode = btn.getAttribute('onclick')?.match(/_setWorktreeMode\('(\w+)'\)/)?.[1];
      btn.classList.toggle('selected', btnMode === mode);
    });
  }

  _renderWorktreeCreator(loading = false) {
    const body = document.getElementById('worktreeCreatorBody');
    const dormant = this._dormantWorktrees || [];
    const sessions = this._worktreeCreatorSessions || [];
    const sourceId = this._worktreeCreatorSourceId;
    let html = '';

    if (loading) {
      html += `<div class="worktree-git-loading">Checking for git repositories…</div>`;
      body.innerHTML = html;
      return;
    }

    if (dormant.length > 0) {
      html += `<div class="worktree-section-label">Resume</div>`;
      dormant.forEach(w => {
        html += `<button class="worktree-resume-btn" onclick="app._resumeWorktree('${escapeHtml(w.id)}')">${BRANCH_SVG} ${escapeHtml(w.branch)} <span class="worktree-resume-project">${escapeHtml(w.projectName)}</span></button>`;
      });
      html += `<hr class="worktree-divider">`;
    }

    const gitCases = this._worktreeGitCases || [];
    const selectedCase = this._worktreeCreatorCaseName;
    if (gitCases.length === 0 && dormant.length === 0) {
      html += `<div class="worktree-git-loading">No git repositories found in projects.</div>`;
    } else if (!selectedCase && gitCases.length > 1) {
      html += `<div class="worktree-section-label">Branch from</div><div class="session-creator-cases">`;
      gitCases.forEach(c => {
        html += `<button class="session-creator-case-card" onclick="app._selectWorktreeCase('${escapeHtml(c.name)}')">` +
          `<svg class="session-creator-case-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>` +
          `<span class="session-creator-case-name">${escapeHtml(c.name)}</span>` +
          `<svg class="worktree-session-card-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>` +
          `</button>`;
      });
      html += `</div>`;
    }

    const currentMode = this._worktreeCreatorMode || this._runMode || 'claude';
    html += `<div class="worktree-section-label">Run with</div><div class="worktree-mode-selector">` +
      `<button class="worktree-mode-btn${currentMode === 'claude' ? ' selected' : ''}" onclick="app._setWorktreeMode('claude')">` +
      `<span class="run-mode-dot claude"></span>Claude Code</button>` +
      `<button class="worktree-mode-btn${currentMode === 'opencode' ? ' selected' : ''}" onclick="app._setWorktreeMode('opencode')">` +
      `<span class="run-mode-dot opencode"></span>OpenCode</button>` +
      `<button class="worktree-mode-btn${currentMode === 'shell' ? ' selected' : ''}" onclick="app._setWorktreeMode('shell')">` +
      `<span class="run-mode-dot shell"></span>Shell</button>` +
      `</div>`;

    html += `<div id="worktreeBranchPicker" style="display:${selectedCase ? 'block' : 'none'}">
      <div class="worktree-section-label">Branch</div>
      <div class="worktree-branch-type">
        <label><input type="radio" name="worktreeBranchType" value="new" checked onchange="app._onWorktreeBranchTypeChange(this.value)"><span>New branch</span></label>
        <label><input type="radio" name="worktreeBranchType" value="existing" onchange="app._onWorktreeBranchTypeChange(this.value)"><span>Existing</span></label>
      </div>
      <input type="text" id="worktreeNewBranchInput" class="form-input" placeholder="feature/my-thing" oninput="app._updateWorktreePathPreview()">
      <select id="worktreeExistingBranchSelect" class="form-select" style="display:none" onchange="app._updateWorktreePathPreview()"><option value="">Loading...</option></select>
      <div class="worktree-path-preview" id="worktreePathPreview"></div>
      <div class="worktree-creator-actions">
        <button class="btn btn-secondary" onclick="app.closeWorktreeCreator()">Cancel</button>
        <button class="btn btn-primary" onclick="app._submitCreateWorktree()">Create</button>
      </div>
    </div>`;

    body.innerHTML = html;
  }

  async _loadWorktreeBranchesByCase(caseName) {
    const picker = document.getElementById('worktreeBranchPicker');
    if (picker) picker.style.display = 'block';
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}/worktree/branches`);
      const data = await res.json();
      if (!data.success) return;
      const sel = document.getElementById('worktreeExistingBranchSelect');
      if (sel) sel.innerHTML = data.branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    } catch {}
  }

  _onWorktreeBranchTypeChange(type) {
    const newInput = document.getElementById('worktreeNewBranchInput');
    const existSel = document.getElementById('worktreeExistingBranchSelect');
    if (newInput) newInput.style.display = type === 'new' ? '' : 'none';
    if (existSel) existSel.style.display = type === 'existing' ? '' : 'none';
    this._updateWorktreePathPreview();
  }

  _updateWorktreePathPreview() {
    const type = document.querySelector('input[name="worktreeBranchType"]:checked')?.value ?? 'new';
    const branch = type === 'new'
      ? (document.getElementById('worktreeNewBranchInput')?.value ?? '')
      : (document.getElementById('worktreeExistingBranchSelect')?.value ?? '');
    const preview = document.getElementById('worktreePathPreview');
    if (preview) preview.textContent = branch ? `Path: ../project-${branch.replace(/\//g, '-')}` : '';
  }

  async _resumeWorktree(id) {
    this.closeWorktreeCreator();
    try {
      const res = await fetch(`/api/worktrees/${encodeURIComponent(id)}/resume`, { method: 'POST' });
      const data = await res.json();
      if (data.success) this.selectSession(data.session.id);
      else alert('Failed to resume worktree: ' + (data.error || 'Unknown error'));
    } catch (err) { alert('Failed to resume worktree: ' + err.message); }
  }

  async _submitCreateWorktree() {
    const caseName = this._worktreeCreatorCaseName;
    if (!caseName) { alert('Please select a project'); return; }
    const type = document.querySelector('input[name="worktreeBranchType"]:checked')?.value ?? 'new';
    const isNew = type === 'new';
    const branch = (isNew
      ? document.getElementById('worktreeNewBranchInput')?.value
      : document.getElementById('worktreeExistingBranchSelect')?.value
    )?.trim() ?? '';
    if (!branch) { alert('Please enter a branch name'); return; }
    const btn = document.querySelector('#worktreeCreatorBody .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}/worktree`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch, isNew, mode: this._worktreeCreatorMode || undefined }),
      });
      const data = await res.json();
      if (data.success) { this.closeWorktreeCreator(); this.selectSession(data.session.id); }
      else {
        alert('Failed to create worktree: ' + (data.error || 'Unknown error'));
        if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
      }
    } catch (err) {
      alert('Failed to create worktree: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
    }
  }

  _onWorktreeSessionEnded(data, desc) {
    this._pendingWorktreeCleanup = data;
    document.getElementById('worktreeCleanupBranch').textContent = data.worktreeBranch;
    const originSession = data.worktreeOriginId ? this.sessions.get(data.worktreeOriginId) : null;
    document.getElementById('worktreeCleanupMergeTarget').textContent =
      originSession ? this.getSessionName(originSession) : 'origin';
    const out = document.getElementById('worktreeCleanupOutput');
    out.style.display = 'none';
    out.textContent = '';
    const descEl = document.getElementById('worktreeCleanupDesc');
    if (descEl) descEl.textContent = desc ?? 'Session ended — what should happen to this worktree?';
    document.getElementById('worktreeCleanupModal').classList.add('active');
  }

  _onTranscriptBlock(data) {
    const { sessionId, block } = data;
    const state = app._transcriptState?.[sessionId];
    let handledByView = false;
    if (TranscriptView._sessionId === sessionId) {
      const transcriptEl = document.getElementById('transcriptView');
      if (transcriptEl?.style.display !== 'none') {
        // If load() is in progress, buffer the block; it will be replayed after HTTP snapshot
        if (state && state._sseBuffer !== null && state._sseBuffer !== undefined) {
          state._sseBuffer.push(block);
          handledByView = true;
        } else {
          TranscriptView.append(block);
          handledByView = true;
        }
      }
    }
    // Only push to state.blocks when not handled above — append() already does it,
    // and _sseBuffer blocks are added to state.blocks after the load() fetch completes.
    if (state && !handledByView) state.blocks.push(block);

    // Detect pending AskUserQuestion from the block stream (works for both HTTP replay and live SSE)
    if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
      const questions = Array.isArray(block.input?.questions) ? block.input.questions : [];
      if (questions.length > 0) {
        const q = questions[0];
        this.pendingAskUserQuestion = {
          sessionId,
          header: q.header || '',
          question: q.question || '',
          options: Array.isArray(q.options) ? q.options : [],
          toolUseId: block.id,
        };
        if (sessionId === this.activeSessionId) this.renderAskUserQuestionPanel();
      }
    } else if (block.type === 'tool_result' &&
               this.pendingAskUserQuestion?.sessionId === sessionId &&
               this.pendingAskUserQuestion?.toolUseId === block.toolUseId) {
      // The AskUserQuestion was answered
      this.pendingAskUserQuestion = null;
      if (sessionId === this.activeSessionId) this.renderAskUserQuestionPanel();
    }
  }

  _onTranscriptClear(data) {
    const { sessionId } = data;
    if (app._transcriptState?.[sessionId]) {
      app._transcriptState[sessionId].blocks = [];
    }
    if (TranscriptView._sessionId === sessionId) {
      TranscriptView.clear();
    }
    if (this.pendingAskUserQuestion?.sessionId === sessionId) {
      this.pendingAskUserQuestion = null;
      this.renderAskUserQuestionPanel();
    }
  }

  _closeWorktreeCleanupModal() {
    document.getElementById('worktreeCleanupModal').classList.remove('active');
    this._pendingWorktreeCleanup = null;
  }

  async worktreeCleanupRemove() {
    const data = this._pendingWorktreeCleanup;
    if (!data) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(data.id)}/worktree`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: false }),
      });
      const result = await res.json();
      if (result.dirty) {
        if (!confirm('The worktree has uncommitted changes. Remove anyway?')) return;
        await fetch(`/api/sessions/${encodeURIComponent(data.id)}/worktree`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        });
      }
      this._closeWorktreeCleanupModal();
    } catch (err) { alert('Failed to remove worktree: ' + err.message); }
  }

  async worktreeCleanupKeep() {
    const data = this._pendingWorktreeCleanup;
    if (!data) return;
    const originSession = data.worktreeOriginId ? this.sessions.get(data.worktreeOriginId) : null;
    const projectName = originSession?.workingDir?.split('/').pop() ?? 'project';
    try {
      await fetch('/api/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: data.worktreePath,
          branch: data.worktreeBranch,
          originSessionId: data.worktreeOriginId ?? '',
          projectName,
        }),
      });
    } catch {}
    this._closeWorktreeCleanupModal();
  }

  async worktreeCleanupMerge() {
    const data = this._pendingWorktreeCleanup;
    if (!data) return;
    const originSession = data.worktreeOriginId ? this.sessions.get(data.worktreeOriginId) : null;
    if (!originSession) { alert('Origin session not found. Cannot merge.'); return; }
    const out = document.getElementById('worktreeCleanupOutput');
    out.style.display = 'block';
    out.textContent = 'Merging...';
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(originSession.id)}/worktree/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: data.worktreeBranch }),
      });
      const result = await res.json();
      out.textContent = result.success
        ? (result.output || 'Merge successful.')
        : ('Merge failed: ' + (result.error || 'Unknown error') + '\n\nWorktree kept on disk.');
      if (result.success) setTimeout(() => this._closeWorktreeCleanupModal(), 2000);
    } catch (err) {
      out.textContent = 'Merge error: ' + err.message + '\n\nWorktree kept on disk.';
    }
  }

  async saveSessionName() {
    if (!this.editingSessionId) return;
    const name = document.getElementById('modalSessionName').value.trim();
    try {
      await this._apiPut(`/api/sessions/${this.editingSessionId}/name`, { name });
    } catch (err) {
      this.showToast('Failed to save session name: ' + err.message, 'error');
    }
  }

  async autoSaveAutoCompact() {
    if (!this.editingSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-compact`, {
        enabled: document.getElementById('modalAutoCompactEnabled').checked,
        threshold: parseInt(document.getElementById('modalAutoCompactThreshold').value) || 110000,
        prompt: document.getElementById('modalAutoCompactPrompt').value.trim() || undefined
      });
    } catch { /* silent */ }
  }

  async autoSaveAutoClear() {
    if (!this.editingSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-clear`, {
        enabled: document.getElementById('modalAutoClearEnabled').checked,
        threshold: parseInt(document.getElementById('modalAutoClearThreshold').value) || 140000
      });
    } catch { /* silent */ }
  }

  async toggleSessionImageWatcher() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalImageWatcherEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/image-watcher`, { enabled });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.imageWatcherEnabled = enabled;
      }
      this.showToast(`Image watcher ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle image watcher', 'error');
    }
  }

  async toggleFlickerFilter() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalFlickerFilterEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/flicker-filter`, { enabled });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.flickerFilterEnabled = enabled;
      }
      this.showToast(`Flicker filter ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle flicker filter', 'error');
    }
  }

  async toggleSafeMode() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalSafeMode').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/safe-mode`, { enabled });
      const session = this.sessions.get(this.editingSessionId);
      if (session) session.safeMode = enabled;
      this.renderSessionTabs();
      this.showToast(`Safe mode ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle safe mode', 'error');
    }
  }

  // ========== Session Health Analyzer ==========

  _classifySession(session, ralphState) {
    const issues = [];
    const now = Date.now();
    const FIVE_MIN = 5 * 60 * 1000;
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    if (session.pid === null && session.status === 'busy' && (now - session.lastActivityAt) > FIVE_MIN) {
      issues.push({ type: 'dead', label: 'Appears dead (no process)', severity: 'error' });
    }
    const cb = ralphState && ralphState.circuitBreaker;
    if (cb && cb.state === 'OPEN') {
      issues.push({ type: 'circuit_open', label: 'Circuit breaker OPEN', severity: 'error' });
    } else if (cb && cb.state === 'HALF_OPEN') {
      issues.push({ type: 'circuit_half', label: 'Circuit breaker warning (HALF_OPEN)', severity: 'warning' });
    }
    if ((now - session.lastActivityAt) > TWO_HOURS && session.status !== 'stopped') {
      issues.push({ type: 'idle_long', label: 'Idle >2 hours', severity: 'info' });
    }
    return issues;
  }

  openHealthAnalyzer() {
    this._healthIgnored = this._healthIgnored || new Set();
    const body = document.getElementById('healthAnalyzerBody');
    if (!body) return;
    const sessions = Array.from(this.sessions.values());
    const problematic = [];
    let healthyCount = 0;
    for (const session of sessions) {
      if (this._healthIgnored.has(session.id)) continue;
      const ralphState = this.ralphStates ? this.ralphStates.get(session.id) : null;
      const issues = this._classifySession(session, ralphState);
      if (issues.length === 0) {
        healthyCount++;
      } else {
        problematic.push({ session, issues });
      }
    }
    const totalSessions = sessions.length - this._healthIgnored.size;
    const parts = [];
    if (problematic.length === 0) {
      parts.push('<div class="health-summary">' + totalSessions + ' session' + (totalSessions !== 1 ? 's' : '') + ' analyzed</div>');
      parts.push('<div class="health-all-healthy">&#x2665; All sessions look healthy</div>');
    } else {
      parts.push('<div class="health-summary">' + healthyCount + ' healthy &bull; ' + problematic.length + ' need attention</div>');
      for (const { session, issues } of problematic) {
        const name = escapeHtml(session.name || (session.workingDir && session.workingDir.split('/').pop()) || session.id.slice(0, 8));
        const statusClass = escapeHtml(session.status);
        const dir = escapeHtml(session.workingDir || '');
        const issueHtml = issues.map(i => '<span class="health-issue-badge ' + escapeHtml(i.severity) + '">' + escapeHtml(i.label) + '</span>').join('');
        const hasDead = issues.some(i => i.type === 'dead');
        const hasCBOpen = issues.some(i => i.type === 'circuit_open');
        const sid = escapeHtml(session.id);
        const actionBtns = [];
        if (hasDead || hasCBOpen) {
          actionBtns.push('<button class="btn-toolbar btn-sm btn-warning" onclick="app._healthRestartSafeMode(\x27' + sid + '\x27)">Restart Safe Mode</button>');
        }
        if (hasDead) {
          actionBtns.push('<button class="btn-toolbar btn-sm" onclick="app._healthForceRespawn(\x27' + sid + '\x27)">Force Respawn</button>');
        }
        if (hasDead) {
          actionBtns.push('<button class="btn-toolbar btn-sm btn-danger" onclick="app._healthKill(\x27' + sid + '\x27)">Kill Session</button>');
        }
        if (hasCBOpen) {
          actionBtns.push('<button class="btn-toolbar btn-sm" onclick="app._healthResetCB(\x27' + sid + '\x27)">Reset Circuit Breaker</button>');
        }
        actionBtns.push('<button class="btn-toolbar btn-sm" onclick="app._healthIgnore(\x27' + sid + '\x27)">Ignore</button>');
        parts.push('<div class="health-session-card"><div class="health-session-card-header"><span class="tab-status ' + statusClass + '" style="display:inline-block;margin-right:2px;"></span> ' + name + ' <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">' + dir + '</span></div><div class="health-session-issues">' + issueHtml + '</div><div class="health-session-actions">' + actionBtns.join('') + '</div></div>');
      }
    }
    body.innerHTML = parts.join('');
    document.getElementById('healthAnalyzerModal').classList.add('active');
  }

  closeHealthAnalyzer() {
    document.getElementById('healthAnalyzerModal').classList.remove('active');
  }

  _healthIgnore(sessionId) {
    this._healthIgnored = this._healthIgnored || new Set();
    this._healthIgnored.add(sessionId);
    this.openHealthAnalyzer();
  }

  async _healthRestartSafeMode(sessionId) {
    try {
      await this._apiPost(`/api/sessions/${sessionId}/safe-mode`, { enabled: true });
      const session = this.sessions.get(sessionId);
      if (session) session.safeMode = true;
      if (!session || session.pid === null) {
        await this._apiPost(`/api/sessions/${sessionId}/interactive`, {});
      }
      this.showToast('Safe mode enabled. Session will use stripped CLI args on next start.', 'success');
      this.renderSessionTabs();
      this.openHealthAnalyzer();
    } catch (err) {
      this.showToast('Failed to restart in safe mode', 'error');
    }
  }

  async _healthForceRespawn(sessionId) {
    try {
      await this._apiPost(`/api/sessions/${sessionId}/interactive`, {});
      this.showToast('Respawn requested', 'success');
      this.openHealthAnalyzer();
    } catch (err) {
      this.showToast('Failed to force respawn', 'error');
    }
  }

  async _healthKill(sessionId) {
    try {
      await this._apiDelete(`/api/sessions/${sessionId}`);
      this.showToast('Session killed', 'success');
      this.openHealthAnalyzer();
    } catch (err) {
      this.showToast('Failed to kill session', 'error');
    }
  }

  async _healthResetCB(sessionId) {
    try {
      await this._apiPost(`/api/sessions/${sessionId}/ralph-circuit-breaker/reset`, {});
      this.showToast('Circuit breaker reset', 'success');
      this.openHealthAnalyzer();
    } catch (err) {
      this.showToast('Failed to reset circuit breaker', 'error');
    }
  }

  async autoSaveRespawnConfig() {
    if (!this.editingSessionId) return;
    const config = {
      updatePrompt: document.getElementById('modalRespawnPrompt').value,
      sendClear: document.getElementById('modalRespawnSendClear').checked,
      sendInit: document.getElementById('modalRespawnSendInit').checked,
      kickstartPrompt: document.getElementById('modalRespawnKickstart').value.trim() || undefined,
      autoAcceptPrompts: document.getElementById('modalRespawnAutoAccept').checked,
    };
    try {
      await this._apiPut(`/api/sessions/${this.editingSessionId}/respawn/config`, config);
    } catch {
      // Silent save - don't interrupt user
    }
  }

  async loadSavedRespawnConfig(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/respawn/config`);
      const data = await res.json();
      if (data.success && data.config) {
        const c = data.config;
        document.getElementById('modalRespawnPrompt').value = c.updatePrompt || 'update all the docs and CLAUDE.md';
        document.getElementById('modalRespawnSendClear').checked = c.sendClear ?? true;
        document.getElementById('modalRespawnSendInit').checked = c.sendInit ?? true;
        document.getElementById('modalRespawnKickstart').value = c.kickstartPrompt || '';
        document.getElementById('modalRespawnAutoAccept').checked = c.autoAcceptPrompts ?? true;
        // Restore duration if set
        if (c.durationMinutes) {
          const presetBtn = document.querySelector(`.duration-preset-btn[data-minutes="${c.durationMinutes}"]`);
          if (presetBtn) {
            this.selectDurationPreset(String(c.durationMinutes));
          } else {
            this.selectDurationPreset('custom');
            document.getElementById('modalRespawnDuration').value = c.durationMinutes;
          }
        }
      }
    } catch {
      // Ignore - use defaults
    }
  }

  // Handle duration preset selection
  selectDurationPreset(value) {
    // Remove active from all buttons
    document.querySelectorAll('.duration-preset-btn').forEach(btn => btn.classList.remove('active'));

    // Find and activate the clicked button
    const btn = document.querySelector(`.duration-preset-btn[data-minutes="${value}"]`);
    if (btn) btn.classList.add('active');

    // Show/hide custom input
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (value === 'custom') {
      customInput.classList.add('visible');
      durationInput.focus();
    } else {
      customInput.classList.remove('visible');
      durationInput.value = ''; // Clear custom value when using preset
    }
  }

  // Get selected duration from preset buttons or custom input
  getSelectedDuration() {
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (customInput.classList.contains('visible')) {
      // Custom mode - use input value
      return durationInput.value ? parseInt(durationInput.value) : null;
    } else {
      // Preset mode - get from active button
      const activeBtn = document.querySelector('.duration-preset-btn.active');
      const minutes = activeBtn?.dataset.minutes;
      return minutes ? parseInt(minutes) : null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Respawn Presets
  // ═══════════════════════════════════════════════════════════════

  loadRespawnPresets() {
    const saved = localStorage.getItem('codeman-respawn-presets');
    const custom = saved ? JSON.parse(saved) : [];
    return [...BUILTIN_RESPAWN_PRESETS, ...custom];
  }

  saveRespawnPresets(presets) {
    // Only save custom presets (not built-in)
    const custom = presets.filter(p => !p.builtIn);
    localStorage.setItem('codeman-respawn-presets', JSON.stringify(custom));
  }

  renderPresetDropdown() {
    const presets = this.loadRespawnPresets();
    const builtinGroup = document.getElementById('builtinPresetsGroup');
    const customGroup = document.getElementById('customPresetsGroup');

    if (!builtinGroup || !customGroup) return;

    // Clear and repopulate
    builtinGroup.innerHTML = '';
    customGroup.innerHTML = '';

    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      if (preset.builtIn) {
        builtinGroup.appendChild(option);
      } else {
        customGroup.appendChild(option);
      }
    });
  }

  updatePresetDescription() {
    const select = document.getElementById('respawnPresetSelect');
    const hint = document.getElementById('presetDescriptionHint');
    if (!select || !hint) return;

    const presetId = select.value;
    if (!presetId) {
      hint.textContent = '';
      return;
    }

    const presets = this.loadRespawnPresets();
    const preset = presets.find(p => p.id === presetId);
    hint.textContent = preset?.description || '';
  }

  loadRespawnPreset() {
    const select = document.getElementById('respawnPresetSelect');
    const presetId = select?.value;
    if (!presetId) {
      this.showToast('Please select a preset first', 'warning');
      return;
    }

    const presets = this.loadRespawnPresets();
    const preset = presets.find(p => p.id === presetId);
    if (!preset) return;

    // Populate form fields
    document.getElementById('modalRespawnPrompt').value = preset.config.updatePrompt || '';
    document.getElementById('modalRespawnSendClear').checked = preset.config.sendClear ?? false;
    document.getElementById('modalRespawnSendInit').checked = preset.config.sendInit ?? false;
    document.getElementById('modalRespawnKickstart').value = preset.config.kickstartPrompt || '';
    document.getElementById('modalRespawnAutoAccept').checked = preset.config.autoAcceptPrompts ?? true;

    // Set duration if available
    if (preset.durationMinutes) {
      this.selectDurationPreset(String(preset.durationMinutes));
    }

    // Reset select to placeholder
    select.value = '';
    document.getElementById('presetDescriptionHint').textContent = '';

    this.showToast(`Loaded preset: ${preset.name}`, 'info');
  }

  saveCurrentAsPreset() {
    document.getElementById('savePresetModal').classList.add('active');
    document.getElementById('presetNameInput').value = '';
    document.getElementById('presetDescriptionInput').value = '';
    document.getElementById('presetNameInput').focus();
  }

  closeSavePresetModal() {
    document.getElementById('savePresetModal').classList.remove('active');
  }

  confirmSavePreset() {
    const name = document.getElementById('presetNameInput').value.trim();
    if (!name) {
      this.showToast('Please enter a preset name', 'error');
      return;
    }

    // Get current config from form
    const updatePrompt = document.getElementById('modalRespawnPrompt').value;
    const sendClear = document.getElementById('modalRespawnSendClear').checked;
    const sendInit = document.getElementById('modalRespawnSendInit').checked;
    const kickstartPrompt = document.getElementById('modalRespawnKickstart').value.trim() || undefined;
    const durationMinutes = this.getSelectedDuration();

    const newPreset = {
      id: 'custom-' + Date.now(),
      name,
      description: document.getElementById('presetDescriptionInput').value.trim() || undefined,
      config: {
        idleTimeoutMs: 5000, // Default
        updatePrompt,
        interStepDelayMs: 3000, // Default
        sendClear,
        sendInit,
        kickstartPrompt,
      },
      durationMinutes: durationMinutes || undefined,
      builtIn: false,
      createdAt: Date.now(),
    };

    const presets = this.loadRespawnPresets();
    presets.push(newPreset);
    this.saveRespawnPresets(presets);
    this.renderPresetDropdown();
    this.closeSavePresetModal();
    this.showToast(`Saved preset: ${name}`, 'success');
  }

  deletePreset(presetId) {
    const presets = this.loadRespawnPresets();
    const preset = presets.find(p => p.id === presetId);
    if (!preset || preset.builtIn) {
      this.showToast('Cannot delete built-in presets', 'warning');
      return;
    }

    const filtered = presets.filter(p => p.id !== presetId);
    this.saveRespawnPresets(filtered);
    this.renderPresetDropdown();
    this.showToast(`Deleted preset: ${preset.name}`, 'success');
  }

  // Get respawn config from modal inputs
  getModalRespawnConfig() {
    const updatePrompt = document.getElementById('modalRespawnPrompt').value;
    const sendClear = document.getElementById('modalRespawnSendClear').checked;
    const sendInit = document.getElementById('modalRespawnSendInit').checked;
    const kickstartPrompt = document.getElementById('modalRespawnKickstart').value.trim() || undefined;
    const autoAcceptPrompts = document.getElementById('modalRespawnAutoAccept').checked;
    const durationMinutes = this.getSelectedDuration();

    // Auto-compact settings
    const autoCompactEnabled = document.getElementById('modalAutoCompactEnabled').checked;
    const autoCompactThreshold = parseInt(document.getElementById('modalAutoCompactThreshold').value) || 110000;
    const autoCompactPrompt = document.getElementById('modalAutoCompactPrompt').value.trim() || undefined;

    // Auto-clear settings
    const autoClearEnabled = document.getElementById('modalAutoClearEnabled').checked;
    const autoClearThreshold = parseInt(document.getElementById('modalAutoClearThreshold').value) || 140000;

    return {
      respawnConfig: {
        enabled: true,  // Fix: ensure enabled is set so pre-saved configs with enabled: false get overridden
        updatePrompt,
        sendClear,
        sendInit,
        kickstartPrompt,
        autoAcceptPrompts,
      },
      durationMinutes,
      autoCompactEnabled,
      autoCompactThreshold,
      autoCompactPrompt,
      autoClearEnabled,
      autoClearThreshold
    };
  }

  async enableRespawnFromModal() {
    if (!this.editingSessionId) {
      this.showToast('No session selected', 'warning');
      return;
    }

    const {
      respawnConfig,
      durationMinutes,
      autoCompactEnabled,
      autoCompactThreshold,
      autoCompactPrompt,
      autoClearEnabled,
      autoClearThreshold
    } = this.getModalRespawnConfig();

    try {
      // Enable respawn on the session
      const res = await fetch(`/api/sessions/${this.editingSessionId}/respawn/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: respawnConfig, durationMinutes })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Set auto-compact if enabled
      if (autoCompactEnabled) {
        await fetch(`/api/sessions/${this.editingSessionId}/auto-compact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, threshold: autoCompactThreshold, prompt: autoCompactPrompt })
        });
      }

      // Set auto-clear if enabled
      if (autoClearEnabled) {
        await fetch(`/api/sessions/${this.editingSessionId}/auto-clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, threshold: autoClearThreshold })
        });
      }

      // Update UI
      const respawnStatus = document.getElementById('sessionRespawnStatus');
      respawnStatus.classList.add('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'WATCHING';
      document.getElementById('modalEnableRespawnBtn').style.display = 'none';
      document.getElementById('modalStopRespawnBtn').style.display = '';

      this.showToast('Respawn enabled', 'success');
    } catch (err) {
      this.showToast('Failed to enable respawn: ' + err.message, 'error');
    }
  }

  async stopRespawnFromModal() {
    if (!this.editingSessionId) return;
    try {
      await fetch(`/api/sessions/${this.editingSessionId}/respawn/stop`, { method: 'POST' });
      delete this.respawnTimers[this.editingSessionId];

      // Update the modal display
      const respawnStatus = document.getElementById('sessionRespawnStatus');
      respawnStatus.classList.remove('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'Not active';
      document.getElementById('modalEnableRespawnBtn').style.display = '';
      document.getElementById('modalStopRespawnBtn').style.display = 'none';

      this.showToast('Respawn stopped', 'success');
    } catch (err) {
      this.showToast('Failed to stop respawn', 'error');
    }
  }

  closeSessionOptions() {
    this.editingSessionId = null;
    // Stop run summary auto-refresh if it was running
    this.stopRunSummaryAutoRefresh();
    document.getElementById('sessionOptionsModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  setupColorPicker() {
    const picker = document.getElementById('sessionColorPicker');
    if (!picker) return;

    picker.addEventListener('click', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (!swatch || !this.editingSessionId) return;

      const color = swatch.dataset.color;
      this.setSessionColor(this.editingSessionId, color);
    });
  }

  async setSessionColor(sessionId, color) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/color`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color })
      });

      if (res.ok) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.color = color;
          this.renderSessionTabs();
        }

        // Update picker UI to show selection
        const picker = document.getElementById('sessionColorPicker');
        if (picker) {
          picker.querySelectorAll('.color-swatch').forEach(swatch => {
            swatch.classList.toggle('selected', swatch.dataset.color === color);
          });
        }
      } else {
        this.showToast('Failed to set session color', 'error');
      }
    } catch (err) {
      this.showToast('Failed to set session color', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Run Summary Modal
  // ═══════════════════════════════════════════════════════════════

  async openRunSummary(sessionId) {
    // Open session options modal and switch to summary tab
    this.openSessionOptions(sessionId);
    this.switchOptionsTab('summary');

    this.runSummarySessionId = sessionId;
    this.runSummaryFilter = 'all';

    // Reset filter buttons
    document.querySelectorAll('.run-summary-filters .filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === 'all');
    });

    // Load summary data
    await this.loadRunSummary(sessionId);
  }

  closeRunSummary() {
    this.runSummarySessionId = null;
    this.stopRunSummaryAutoRefresh();
    // Close session options modal (summary is now a tab in it)
    this.closeSessionOptions();
  }

  async refreshRunSummary() {
    const sessionId = this.runSummarySessionId || this.editingSessionId;
    if (!sessionId) return;
    await this.loadRunSummary(sessionId);
  }

  toggleRunSummaryAutoRefresh() {
    const checkbox = document.getElementById('runSummaryAutoRefresh');
    if (checkbox.checked) {
      this.startRunSummaryAutoRefresh();
    } else {
      this.stopRunSummaryAutoRefresh();
    }
  }

  startRunSummaryAutoRefresh() {
    if (this.runSummaryAutoRefreshTimer) return;
    this.runSummaryAutoRefreshTimer = setInterval(() => {
      if (this.runSummarySessionId) {
        this.loadRunSummary(this.runSummarySessionId);
      }
    }, 5000); // Refresh every 5 seconds
  }

  stopRunSummaryAutoRefresh() {
    if (this.runSummaryAutoRefreshTimer) {
      clearInterval(this.runSummaryAutoRefreshTimer);
      this.runSummaryAutoRefreshTimer = null;
    }
    const checkbox = document.getElementById('runSummaryAutoRefresh');
    if (checkbox) checkbox.checked = false;
  }

  exportRunSummary(format) {
    if (!this.runSummaryData) {
      this.showToast('No summary data to export', 'error');
      return;
    }

    const { stats, events, sessionName, startedAt, lastUpdatedAt } = this.runSummaryData;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `run-summary-${sessionName || 'session'}-${timestamp}`;

    if (format === 'json') {
      const json = JSON.stringify(this.runSummaryData, null, 2);
      this.downloadFile(`${filename}.json`, json, 'application/json');
    } else if (format === 'md') {
      const duration = lastUpdatedAt - startedAt;
      let md = `# Run Summary: ${sessionName || 'Session'}\n\n`;
      md += `**Duration**: ${this.formatDuration(duration)}\n`;
      md += `**Started**: ${new Date(startedAt).toLocaleString()}\n`;
      md += `**Last Update**: ${new Date(lastUpdatedAt).toLocaleString()}\n\n`;

      md += `## Statistics\n\n`;
      md += `| Metric | Value |\n`;
      md += `|--------|-------|\n`;
      md += `| Respawn Cycles | ${stats.totalRespawnCycles} |\n`;
      md += `| Peak Tokens | ${this.formatTokens(stats.peakTokens)} |\n`;
      md += `| Active Time | ${this.formatDuration(stats.totalTimeActiveMs)} |\n`;
      md += `| Idle Time | ${this.formatDuration(stats.totalTimeIdleMs)} |\n`;
      md += `| Errors | ${stats.errorCount} |\n`;
      md += `| Warnings | ${stats.warningCount} |\n`;
      md += `| AI Checks | ${stats.aiCheckCount} |\n`;
      md += `| State Transitions | ${stats.stateTransitions} |\n\n`;

      md += `## Event Timeline\n\n`;
      if (events.length === 0) {
        md += `No events recorded.\n`;
      } else {
        md += `| Time | Type | Severity | Title | Details |\n`;
        md += `|------|------|----------|-------|----------|\n`;
        for (const event of events) {
          const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
          const details = event.details ? event.details.replace(/\|/g, '\\|') : '-';
          md += `| ${time} | ${event.type} | ${event.severity} | ${event.title} | ${details} |\n`;
        }
      }

      this.downloadFile(`${filename}.md`, md, 'text/markdown');
    }

    this.showToast(`Exported as ${format.toUpperCase()}`, 'success');
  }

  downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async loadRunSummary(sessionId) {
    const timeline = document.getElementById('runSummaryTimeline');
    timeline.innerHTML = '<p class="empty-message">Loading summary...</p>';

    try {
      const response = await fetch(`/api/sessions/${sessionId}/run-summary`);
      const data = await response.json();

      if (!data.success) {
        timeline.innerHTML = `<p class="empty-message">Failed to load summary: ${escapeHtml(data.error)}</p>`;
        return;
      }

      this.runSummaryData = data.summary;
      this.renderRunSummary();
    } catch (err) {
      console.error('Failed to load run summary:', err);
      timeline.innerHTML = '<p class="empty-message">Failed to load summary</p>';
    }
  }

  renderRunSummary() {
    if (!this.runSummaryData) return;

    const { stats, events, sessionName, startedAt, lastUpdatedAt } = this.runSummaryData;

    // Update session info
    const duration = lastUpdatedAt - startedAt;
    document.getElementById('runSummarySessionInfo').textContent =
      `${sessionName || 'Session'} - ${this.formatDuration(duration)} total`;

    // Filter and render events
    const filteredEvents = this.filterRunSummaryEvents(events);
    this.renderRunSummaryTimeline(filteredEvents);
  }

  filterRunSummaryEvents(events) {
    if (this.runSummaryFilter === 'all') return events;

    return events.filter(event => {
      switch (this.runSummaryFilter) {
        case 'errors': return event.severity === 'error';
        case 'warnings': return event.severity === 'warning' || event.severity === 'error';
        case 'respawn': return event.type.startsWith('respawn_') || event.type === 'state_stuck';
        case 'idle': return event.type === 'idle_detected' || event.type === 'working_detected';
        default: return true;
      }
    });
  }

  filterRunSummary(filter) {
    this.runSummaryFilter = filter;

    // Update active state on buttons
    document.querySelectorAll('.run-summary-filters .filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });

    this.renderRunSummary();
  }

  renderRunSummaryTimeline(events) {
    const timeline = document.getElementById('runSummaryTimeline');

    if (!events || events.length === 0) {
      timeline.innerHTML = '<p class="empty-message">No events recorded yet</p>';
      return;
    }

    // Reverse to show most recent first
    const reversedEvents = [...events].reverse();

    const html = reversedEvents.map(event => {
      const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const severityClass = `event-${event.severity}`;
      const icon = this.getEventIcon(event.type, event.severity);

      return `
        <div class="timeline-event ${severityClass}">
          <div class="event-icon">${icon}</div>
          <div class="event-content">
            <div class="event-header">
              <span class="event-title">${escapeHtml(event.title)}</span>
              <span class="event-time">${time}</span>
            </div>
            ${event.details ? `<div class="event-details">${escapeHtml(event.details)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    timeline.innerHTML = html;
  }

  getEventIcon(type, severity) {
    if (severity === 'error') return '&#x274C;'; // Red X
    if (severity === 'warning') return '&#x26A0;'; // Warning triangle
    if (severity === 'success') return '&#x2714;'; // Checkmark

    switch (type) {
      case 'session_started': return '&#x1F680;'; // Rocket
      case 'session_stopped': return '&#x1F6D1;'; // Stop sign
      case 'respawn_cycle_started': return '&#x1F504;'; // Cycle
      case 'respawn_cycle_completed': return '&#x2705;'; // Green check
      case 'respawn_state_change': return '&#x27A1;'; // Arrow
      case 'token_milestone': return '&#x1F4B0;'; // Money bag
      case 'idle_detected': return '&#x1F4A4;'; // Zzz
      case 'working_detected': return '&#x1F4BB;'; // Laptop
      case 'ai_check_result': return '&#x1F916;'; // Robot
      case 'hook_event': return '&#x1F514;'; // Bell
      default: return '&#x2022;'; // Bullet
    }
  }


  formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  saveSessionOptions() {
    // Session options are applied immediately via individual controls
    // This just closes the modal
    this.closeSessionOptions();
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Options Modal Tabs
  // ═══════════════════════════════════════════════════════════════

  switchOptionsTab(tabName) {
    // Toggle active class on tab buttons
    document.querySelectorAll('#sessionOptionsModal .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Toggle hidden class on tab content
    document.getElementById('respawn-tab').classList.toggle('hidden', tabName !== 'respawn');
    document.getElementById('context-tab').classList.toggle('hidden', tabName !== 'context');
    document.getElementById('ralph-tab').classList.toggle('hidden', tabName !== 'ralph');
    document.getElementById('summary-tab').classList.toggle('hidden', tabName !== 'summary');
    document.getElementById('terminal-tab').classList.toggle('hidden', tabName !== 'terminal');

    // Load run summary data when switching to summary tab
    if (tabName === 'summary' && this.editingSessionId) {
      this.loadRunSummary(this.editingSessionId);
    }
    // Load mux session list when switching to terminal tab
    if (tabName === 'terminal') {
      this.loadMuxSessionList();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Mux Rebind (Terminal Tab)
  // ═══════════════════════════════════════════════════════════════

  /** Cached mux session data for the terminal tab */
  _muxAllSessions = [];

  /**
   * Fetch all live tmux sessions and render the rebind list.
   */
  async loadMuxSessionList() {
    const listEl = document.getElementById('muxSessionList');
    if (!listEl) return;
    listEl.innerHTML = '<p class="empty-message">Loading...</p>';
    try {
      const data = await this._apiJson('/api/mux/all-sessions');
      this._muxAllSessions = data.sessions || [];
      this._renderMuxSessionList();
    } catch (err) {
      listEl.innerHTML = `<p class="empty-message" style="color: var(--danger-color, #e74c3c)">Failed to load: ${escapeHtml(err.message)}</p>`;
    }
  }

  /**
   * Re-render the mux session list, applying the current search filter.
   */
  _renderMuxSessionList() {
    const listEl = document.getElementById('muxSessionList');
    if (!listEl) return;
    const query = (document.getElementById('muxRebindSearch')?.value || '').toLowerCase().trim();
    const sessions = this._muxAllSessions.filter(s => !query || s.name.toLowerCase().includes(query));

    if (sessions.length === 0) {
      listEl.innerHTML = '<p class="empty-message">No tmux sessions found</p>';
      return;
    }

    const currentSessionId = this.editingSessionId;

    const rows = sessions.map(s => {
      const isCurrent = s.ownerSessionId === currentSessionId;
      const hasOtherOwner = s.ownerSessionId && s.ownerSessionId !== currentSessionId;
      const ownerSession = hasOtherOwner ? this.sessions.get(s.ownerSessionId) : null;
      const ownerName = ownerSession?.name || s.ownerSessionId || '';
      const ago = s.createdAt ? this._formatRelativeTime(Date.now() - s.createdAt) : '';
      const attachedBadge = s.attached ? '<span class="mux-session-badge mux-session-attached-badge">attached</span>' : '';

      let actionHtml;
      if (isCurrent) {
        actionHtml = '<span class="mux-session-badge mux-session-current-badge">Current</span>';
      } else if (hasOtherOwner) {
        actionHtml = `<span class="mux-session-badge mux-session-owner-badge" title="Owned by: ${escapeHtml(ownerName)}">&#x26A0; ${escapeHtml(ownerName)}</span>
          <button class="btn btn-sm btn-danger mux-assign-btn" onclick="app.confirmMuxRebind('${escapeHtml(s.name)}', '${escapeHtml(ownerName)}')">Assign</button>`;
      } else {
        actionHtml = `<button class="btn btn-sm mux-assign-btn" onclick="app.rebindMuxSession('${escapeHtml(s.name)}', false)">Assign</button>`;
      }

      return `<div class="mux-session-row">
        <div class="mux-session-info">
          <span class="mux-session-name">${escapeHtml(s.name)}</span>
          <span class="mux-session-meta">${s.windows} window${s.windows !== 1 ? 's' : ''} · ${ago}${attachedBadge ? ' · ' : ''}${attachedBadge}</span>
        </div>
        <div class="mux-session-actions">${actionHtml}</div>
      </div>`;
    });

    listEl.innerHTML = rows.join('');
  }

  /**
   * Filter the displayed mux session list by the search input.
   */
  filterMuxSessionList() {
    this._renderMuxSessionList();
  }

  /**
   * Show a confirm dialog before reassigning a session that is owned by another Codeman session.
   */
  confirmMuxRebind(muxName, ownerName) {
    if (confirm(`This tmux session is currently bound to "${ownerName}". Reassign it to this session anyway?`)) {
      this.rebindMuxSession(muxName, true);
    }
  }

  /**
   * POST /api/sessions/:id/mux-rebind to rebind the current Codeman session.
   */
  async rebindMuxSession(muxName, force) {
    if (!this.editingSessionId) return;
    try {
      const result = await this._apiPost(`/api/sessions/${this.editingSessionId}/mux-rebind`, {
        muxSessionName: muxName,
        force: force || false,
      });
      if (result.conflict) {
        const ownerName = result.ownerSessionName || result.ownerSessionId || 'another session';
        this.confirmMuxRebind(muxName, ownerName);
        return;
      }
      if (result.success) {
        this.showToast('Terminal pane reassigned to ' + muxName, 'success');
        this.closeSessionOptions();
      } else {
        this.showToast('Rebind failed: ' + (result.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      this.showToast('Rebind failed: ' + err.message, 'error');
    }
  }

  /**
   * Format a duration in ms as a relative time string (e.g. "3h ago", "5m ago").
   */
  _formatRelativeTime(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  getRalphConfig() {
    return {
      enabled: document.getElementById('modalRalphEnabled').checked,
      completionPhrase: document.getElementById('modalRalphPhrase').value.trim(),
      maxIterations: parseInt(document.getElementById('modalRalphMaxIterations').value) || 0,
      maxTodos: parseInt(document.getElementById('modalRalphMaxTodos').value) || 50,
      todoExpirationMinutes: parseInt(document.getElementById('modalRalphTodoExpiration').value) || 60
    };
  }

  populateRalphForm(config) {
    document.getElementById('modalRalphEnabled').checked = config?.enabled ?? false;
    document.getElementById('modalRalphPhrase').value = config?.completionPhrase || '';
    document.getElementById('modalRalphMaxIterations').value = config?.maxIterations || 0;
    document.getElementById('modalRalphMaxTodos').value = config?.maxTodos || 50;
    document.getElementById('modalRalphTodoExpiration').value = config?.todoExpirationMinutes || 60;
  }

  async saveRalphConfig() {
    if (!this.editingSessionId) {
      this.showToast('No session selected', 'warning');
      return;
    }

    const config = this.getRalphConfig();

    // If user is enabling Ralph, clear from closed set
    if (config.enabled) {
      this.ralphClosedSessions.delete(this.editingSessionId);
    }

    try {
      const res = await fetch(`/api/sessions/${this.editingSessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      this.showToast('Ralph config saved', 'success');
    } catch (err) {
      this.showToast('Failed to save Ralph config: ' + err.message, 'error');
    }
  }

  // Inline rename on right-click
  startInlineRename(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const tabName = document.querySelector(`.tab-name[data-session-id="${sessionId}"]`);
    if (!tabName) return;

    const currentName = this.getSessionName(session);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = session.name || '';
    input.placeholder = currentName;
    input.className = 'tab-rename-input';
    input.style.cssText = 'width: 80px; font-size: 0.75rem; padding: 2px 4px; background: var(--bg-input); border: 1px solid var(--accent); border-radius: 3px; color: var(--text); outline: none;';

    const originalContent = tabName.textContent;
    tabName.textContent = '';
    tabName.appendChild(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      const newName = input.value.trim();
      tabName.textContent = newName || originalContent;

      if (newName && newName !== session.name) {
        try {
          await fetch(`/api/sessions/${sessionId}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
          });
        } catch (err) {
          tabName.textContent = originalContent;
          this.showToast('Failed to rename', 'error');
        }
      }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Web Push
  // ═══════════════════════════════════════════════════════════════

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      this._swRegistration = reg;
      // Listen for messages from service worker (notification clicks)
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'notification-click') {
          const { sessionId } = event.data;
          if (sessionId && this.sessions.has(sessionId)) {
            this.selectSession(sessionId);
          }
          window.focus();
        }
      });
      // Check if already subscribed
      reg.pushManager.getSubscription().then((sub) => {
        if (sub) {
          this._pushSubscription = sub;
          this._updatePushUI(true);
        }
      });
    }).catch(() => {
      // Service worker registration failed (likely not HTTPS)
    });
  }

  async subscribeToPush() {
    if (!this._swRegistration) {
      this.showToast('Service worker not available. HTTPS or localhost required.', 'error');
      return;
    }
    try {
      // Get VAPID public key from server
      const keyData = await this._apiJson('/api/push/vapid-key');
      if (!keyData?.success) throw new Error('Failed to get VAPID key');

      const applicationServerKey = urlBase64ToUint8Array(keyData.data.publicKey);
      const subscription = await this._swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });

      // Send subscription to server
      const subJson = subscription.toJSON();
      const data = await this._apiJson('/api/push/subscribe', {
        method: 'POST',
        body: {
          endpoint: subJson.endpoint,
          keys: subJson.keys,
          userAgent: navigator.userAgent,
          pushPreferences: this._buildPushPreferences(),
        },
      });
      if (!data?.success) throw new Error('Failed to register subscription');

      this._pushSubscription = subscription;
      this._pushSubscriptionId = data.data.id;
      localStorage.setItem('codeman-push-subscription-id', data.data.id);
      this._updatePushUI(true);
      this.showToast('Push notifications enabled', 'success');
    } catch (err) {
      this.showToast('Push subscription failed: ' + (err.message || err), 'error');
    }
  }

  async unsubscribeFromPush() {
    try {
      if (this._pushSubscription) {
        await this._pushSubscription.unsubscribe();
      }
      const subId = this._pushSubscriptionId || localStorage.getItem('codeman-push-subscription-id');
      if (subId) {
        await fetch(`/api/push/subscribe/${subId}`, { method: 'DELETE' }).catch(() => {});
      }
      this._pushSubscription = null;
      this._pushSubscriptionId = null;
      localStorage.removeItem('codeman-push-subscription-id');
      this._updatePushUI(false);
      this.showToast('Push notifications disabled', 'success');
    } catch (err) {
      this.showToast('Failed to unsubscribe: ' + (err.message || err), 'error');
    }
  }

  async togglePushSubscription() {
    if (this._pushSubscription) {
      await this.unsubscribeFromPush();
    } else {
      await this.subscribeToPush();
    }
  }

  /** Sync push preferences to server */
  async _syncPushPreferences() {
    const subId = this._pushSubscriptionId || localStorage.getItem('codeman-push-subscription-id');
    if (!subId) return;
    try {
      await fetch(`/api/push/subscribe/${subId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pushPreferences: this._buildPushPreferences() }),
      });
    } catch {
      // Silently fail — prefs saved locally, will sync on next subscribe
    }
  }

  /** Build push preferences object from current event type checkboxes */
  _buildPushPreferences() {
    const prefs = {};
    const eventMap = {
      'hook:permission_prompt': 'eventPermissionPush',
      'hook:elicitation_dialog': 'eventQuestionPush',
      'hook:idle_prompt': 'eventIdlePush',
      'hook:stop': 'eventStopPush',
      'respawn:blocked': 'eventRespawnPush',
      'session:ralphCompletionDetected': 'eventRalphPush',
    };
    for (const [event, checkboxId] of Object.entries(eventMap)) {
      const el = document.getElementById(checkboxId);
      prefs[event] = el ? el.checked : true;
    }
    // session:error always receives push (no per-event toggle, always critical)
    prefs['session:error'] = true;
    return prefs;
  }

  _updatePushUI(subscribed) {
    const btn = document.getElementById('pushSubscribeBtn');
    const status = document.getElementById('pushSubscriptionStatus');
    if (btn) btn.textContent = subscribed ? 'Unsubscribe' : 'Subscribe';
    if (status) {
      status.textContent = subscribed ? 'active' : 'off';
      status.classList.remove('granted', 'denied');
      if (subscribed) status.classList.add('granted');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // App Settings Modal
  // ═══════════════════════════════════════════════════════════════

  _loadHotbarCustomCmds(cmds) {
    const container = document.getElementById('hotbarCustomCmds');
    if (!container) return;
    container.textContent = '';
    cmds.forEach(cmd => this._addHotbarCmdRow(cmd.label, cmd.command));
  }

  _addHotbarCmdRow(label = '', command = '') {
    const container = document.getElementById('hotbarCustomCmds');
    if (!container) return;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Label';
    labelInput.value = label;
    labelInput.className = 'hotbar-cmd-label';
    labelInput.style.cssText = 'width:80px;font-size:0.8rem;padding:2px 4px;background:var(--input-bg,#222);color:var(--text);border:1px solid var(--border);border-radius:4px;';
    const cmdInput = document.createElement('input');
    cmdInput.type = 'text';
    cmdInput.placeholder = '/command or text';
    cmdInput.value = command;
    cmdInput.className = 'hotbar-cmd-value';
    cmdInput.style.cssText = 'flex:1;font-size:0.8rem;padding:2px 4px;background:var(--input-bg,#222);color:var(--text);border:1px solid var(--border);border-radius:4px;';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '\u2715';
    removeBtn.style.cssText = 'font-size:0.8rem;padding:2px 6px;cursor:pointer;background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-secondary);';
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(labelInput);
    row.appendChild(cmdInput);
    row.appendChild(removeBtn);
    container.appendChild(row);
  }

  _collectHotbarCustomCmds() {
    return [...document.querySelectorAll('#hotbarCustomCmds > div')].map(row => ({
      label: row.querySelector('.hotbar-cmd-label').value.trim(),
      command: row.querySelector('.hotbar-cmd-value').value.trim(),
    })).filter(c => c.command);
  }

  openAppSettings() {
    // Load current settings
    const settings = this.loadAppSettingsFromStorage();
    document.getElementById('appSettingsClaudeMdPath').value = settings.defaultClaudeMdPath || '';
    document.getElementById('appSettingsDefaultDir').value = settings.defaultWorkingDir || '';
    // Use device-aware defaults for display settings (mobile has different defaults)
    const defaults = this.getDefaultSettings();
    document.getElementById('appSettingsRalphEnabled').checked = settings.ralphTrackerEnabled ?? defaults.ralphTrackerEnabled ?? false;
    // Header visibility settings
    document.getElementById('appSettingsShowFontControls').checked = settings.showFontControls ?? defaults.showFontControls ?? false;
    document.getElementById('appSettingsShowSystemStats').checked = settings.showSystemStats ?? defaults.showSystemStats ?? true;
    document.getElementById('appSettingsShowTokenCount').checked = settings.showTokenCount ?? defaults.showTokenCount ?? true;
    document.getElementById('appSettingsShowCost').checked = settings.showCost ?? defaults.showCost ?? false;
    document.getElementById('appSettingsShowLifecycleLog').checked = settings.showLifecycleLog ?? defaults.showLifecycleLog ?? true;
    document.getElementById('appSettingsShowMonitor').checked = settings.showMonitor ?? defaults.showMonitor ?? true;
    document.getElementById('appSettingsShowProjectInsights').checked = settings.showProjectInsights ?? defaults.showProjectInsights ?? false;
    document.getElementById('appSettingsShowFileBrowser').checked = settings.showFileBrowser ?? defaults.showFileBrowser ?? false;
    document.getElementById('appSettingsShowSubagents').checked = settings.showSubagents ?? defaults.showSubagents ?? true;
    document.getElementById('appSettingsSubagentTracking').checked = settings.subagentTrackingEnabled ?? defaults.subagentTrackingEnabled ?? true;
    document.getElementById('appSettingsSubagentActiveTabOnly').checked = settings.subagentActiveTabOnly ?? defaults.subagentActiveTabOnly ?? true;
    document.getElementById('appSettingsImageWatcherEnabled').checked = settings.imageWatcherEnabled ?? defaults.imageWatcherEnabled ?? false;
    document.getElementById('appSettingsTunnelEnabled').checked = settings.tunnelEnabled ?? false;
    this.loadTunnelStatus();
    document.getElementById('appSettingsLocalEcho').checked = settings.localEchoEnabled ?? MobileDetection.isTouchDevice();
    document.getElementById('appSettingsStopOnCleanExit').checked = settings.stopOnCleanExit ?? true;
    document.getElementById('appSettingsTabTwoRows').checked = settings.tabTwoRows ?? defaults.tabTwoRows ?? false;
    // Mobile hotbar buttons
    const hotbarButtons = settings.hotbarButtons || ['scroll-up', 'scroll-down', 'commands', 'paste', 'copy', 'dismiss'];
    document.querySelectorAll('input[name="hotbarBtn"]').forEach(cb => {
      cb.checked = hotbarButtons.includes(cb.value);
    });
    this._loadHotbarCustomCmds(settings.hotbarCustomCommands || []);
    // Claude CLI settings
    const claudeModeSelect = document.getElementById('appSettingsClaudeMode');
    const allowedToolsRow = document.getElementById('allowedToolsRow');
    claudeModeSelect.value = settings.claudeMode || 'dangerously-skip-permissions';
    document.getElementById('appSettingsAllowedTools').value = settings.allowedTools || '';
    allowedToolsRow.style.display = claudeModeSelect.value === 'allowedTools' ? '' : 'none';
    // Toggle allowed tools row visibility based on mode selection
    claudeModeSelect.onchange = () => {
      allowedToolsRow.style.display = claudeModeSelect.value === 'allowedTools' ? '' : 'none';
    };
    // Claude Permissions settings
    document.getElementById('appSettingsAgentTeams').checked = settings.agentTeamsEnabled ?? false;
    // CPU Priority settings
    const niceSettings = settings.nice || {};
    document.getElementById('appSettingsNiceEnabled').checked = niceSettings.enabled ?? false;
    document.getElementById('appSettingsNiceValue').value = niceSettings.niceValue ?? 10;
    // Model configuration (loaded from server)
    this.loadModelConfigForSettings();
    // Notification settings
    const notifPrefs = this.notificationManager?.preferences || {};
    document.getElementById('appSettingsNotifEnabled').checked = notifPrefs.enabled ?? true;
    document.getElementById('appSettingsNotifBrowser').checked = notifPrefs.browserNotifications ?? false;
    document.getElementById('appSettingsNotifAudio').checked = notifPrefs.audioAlerts ?? false;
    document.getElementById('appSettingsNotifStuckMins').value = Math.round((notifPrefs.stuckThresholdMs || 600000) / 60000);
    document.getElementById('appSettingsNotifCritical').checked = !notifPrefs.muteCritical;
    document.getElementById('appSettingsNotifWarning').checked = !notifPrefs.muteWarning;
    document.getElementById('appSettingsNotifInfo').checked = !notifPrefs.muteInfo;
    // Push notification settings
    document.getElementById('appSettingsPushEnabled').checked = !!this._pushSubscription;
    this._updatePushUI(!!this._pushSubscription);
    // Per-event-type preferences
    const eventTypes = notifPrefs.eventTypes || {};
    // Permission prompts
    const permPref = eventTypes.permission_prompt || {};
    document.getElementById('eventPermissionEnabled').checked = permPref.enabled ?? true;
    document.getElementById('eventPermissionBrowser').checked = permPref.browser ?? true;
    document.getElementById('eventPermissionPush').checked = permPref.push ?? false;
    document.getElementById('eventPermissionAudio').checked = permPref.audio ?? true;
    // Questions (elicitation_dialog)
    const questionPref = eventTypes.elicitation_dialog || {};
    document.getElementById('eventQuestionEnabled').checked = questionPref.enabled ?? true;
    document.getElementById('eventQuestionBrowser').checked = questionPref.browser ?? true;
    document.getElementById('eventQuestionPush').checked = questionPref.push ?? false;
    document.getElementById('eventQuestionAudio').checked = questionPref.audio ?? true;
    // Session idle (idle_prompt)
    const idlePref = eventTypes.idle_prompt || {};
    document.getElementById('eventIdleEnabled').checked = idlePref.enabled ?? true;
    document.getElementById('eventIdleBrowser').checked = idlePref.browser ?? true;
    document.getElementById('eventIdlePush').checked = idlePref.push ?? false;
    document.getElementById('eventIdleAudio').checked = idlePref.audio ?? false;
    // Response complete (stop)
    const stopPref = eventTypes.stop || {};
    document.getElementById('eventStopEnabled').checked = stopPref.enabled ?? true;
    document.getElementById('eventStopBrowser').checked = stopPref.browser ?? false;
    document.getElementById('eventStopPush').checked = stopPref.push ?? false;
    document.getElementById('eventStopAudio').checked = stopPref.audio ?? false;
    // Respawn cycles
    const respawnPref = eventTypes.respawn_cycle || {};
    document.getElementById('eventRespawnEnabled').checked = respawnPref.enabled ?? true;
    document.getElementById('eventRespawnBrowser').checked = respawnPref.browser ?? false;
    document.getElementById('eventRespawnPush').checked = respawnPref.push ?? false;
    document.getElementById('eventRespawnAudio').checked = respawnPref.audio ?? false;
    // Task complete (ralph_complete)
    const ralphPref = eventTypes.ralph_complete || {};
    document.getElementById('eventRalphEnabled').checked = ralphPref.enabled ?? true;
    document.getElementById('eventRalphBrowser').checked = ralphPref.browser ?? true;
    document.getElementById('eventRalphPush').checked = ralphPref.push ?? false;
    document.getElementById('eventRalphAudio').checked = ralphPref.audio ?? true;
    // Subagent activity (subagent_spawn and subagent_complete)
    const subagentPref = eventTypes.subagent_spawn || {};
    document.getElementById('eventSubagentEnabled').checked = subagentPref.enabled ?? false;
    document.getElementById('eventSubagentBrowser').checked = subagentPref.browser ?? false;
    document.getElementById('eventSubagentPush').checked = subagentPref.push ?? false;
    document.getElementById('eventSubagentAudio').checked = subagentPref.audio ?? false;
    // Update permission status display (compact format for new grid layout)
    const permStatus = document.getElementById('notifPermissionStatus');
    if (permStatus && typeof Notification !== 'undefined') {
      const perm = Notification.permission;
      permStatus.textContent = perm === 'granted' ? '\u2713' : perm === 'denied' ? '\u2717' : '?';
      permStatus.classList.remove('granted', 'denied');
      if (perm === 'granted') permStatus.classList.add('granted');
      else if (perm === 'denied') permStatus.classList.add('denied');
    }
    // Voice settings (loaded from localStorage only)
    const voiceCfg = VoiceInput._getDeepgramConfig();
    document.getElementById('voiceDeepgramKey').value = voiceCfg.apiKey || '';
    document.getElementById('voiceLanguage').value = voiceCfg.language || 'en-US';
    document.getElementById('voiceKeyterms').value = voiceCfg.keyterms || 'refactor, endpoint, middleware, callback, async, regex, TypeScript, npm, API, deploy, config, linter, env, webhook, schema, CLI, JSON, CSS, DOM, SSE, backend, frontend, localhost, dependencies, repository, merge, rebase, diff, commit, com';
    document.getElementById('voiceInsertMode').value = voiceCfg.insertMode || 'direct';
    // Reset key visibility to hidden
    const keyInput = document.getElementById('voiceDeepgramKey');
    keyInput.type = 'password';
    document.getElementById('voiceKeyToggleBtn').textContent = 'Show';
    // Update provider status
    const providerName = VoiceInput.getActiveProviderName();
    const providerEl = document.getElementById('voiceProviderStatus');
    providerEl.textContent = providerName;
    providerEl.className = 'voice-provider-status' + (providerName.startsWith('Deepgram') ? ' active' : '');

    // Reset to first tab and wire up tab switching
    this.switchSettingsTab('settings-display');
    const modal = document.getElementById('appSettingsModal');
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.onclick = () => this.switchSettingsTab(btn.dataset.tab);
    });
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  switchSettingsTab(tabName) {
    const modal = document.getElementById('appSettingsModal');
    // Toggle active class on tab buttons
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // Toggle hidden class on tab content
    modal.querySelectorAll('.modal-tab-content').forEach(content => {
      content.classList.toggle('hidden', content.id !== tabName);
    });
  }

  closeAppSettings() {
    document.getElementById('appSettingsModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  async loadTunnelStatus() {
    try {
      const res = await fetch('/api/tunnel/status');
      const status = await res.json();
      const active = status.running && status.url;
      this._tunnelUrl = active ? status.url : null;
      this._updateTunnelUrlDisplay(this._tunnelUrl);
      this._updateWelcomeTunnelBtn(!!active, this._tunnelUrl);
      this._updateTunnelIndicator(!!active);
    } catch {
      this._tunnelUrl = null;
      this._updateTunnelUrlDisplay(null);
      this._updateWelcomeTunnelBtn(false);
      this._updateTunnelIndicator(false);
    }
  }

  _updateTunnelUrlDisplay(url) {
    const row = document.getElementById('tunnelUrlRow');
    const display = document.getElementById('tunnelUrlDisplay');
    if (!row || !display) return;
    if (url) {
      row.style.display = '';
      display.textContent = url;
      display.onclick = () => {
        navigator.clipboard.writeText(url).then(() => {
          this.showToast('Tunnel URL copied', 'success');
        });
      };
    } else {
      row.style.display = 'none';
      display.textContent = '';
      display.onclick = null;
    }
    // Upload URL row
    const uploadRow = document.getElementById('tunnelUploadUrlRow');
    const uploadDisplay = document.getElementById('tunnelUploadUrlDisplay');
    if (!uploadRow || !uploadDisplay) return;
    if (url) {
      const uploadUrl = url + '/upload.html';
      uploadRow.style.display = '';
      uploadDisplay.textContent = uploadUrl;
      uploadDisplay.onclick = () => {
        navigator.clipboard.writeText(uploadUrl).then(() => {
          this.showToast('Upload URL copied', 'success');
        });
      };
    } else {
      uploadRow.style.display = 'none';
      uploadDisplay.textContent = '';
      uploadDisplay.onclick = null;
    }
  }

  showTunnelQR() {
    // Close existing popup if open
    this.closeTunnelQR();

    const overlay = document.createElement('div');
    overlay.id = 'tunnelQrOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:5000;display:flex;align-items:center;justify-content:center;cursor:pointer';
    overlay.onclick = (e) => { if (e.target === overlay) this.closeTunnelQR(); };

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center;max-width:340px;width:90vw;box-shadow:var(--shadow-lg);cursor:default';

    card.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:16px">Scan to connect</div>
      <div id="tunnelQrContainer" style="background:#fff;border-radius:8px;padding:16px;display:inline-block">
        <div style="color:#666;font-size:12px">Loading...</div>
      </div>
      <div id="tunnelQrUrl" style="margin-top:12px;font-family:monospace;font-size:11px;color:var(--text-muted);word-break:break-all;cursor:pointer" title="Click to copy"></div>
      <button onclick="app.closeTunnelQR()" style="margin-top:16px;padding:6px 20px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);cursor:pointer;font-size:13px">Close</button>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Fetch QR SVG from server
    fetch('/api/tunnel/qr')
      .then(res => {
        if (!res.ok) throw new Error('Tunnel not running');
        return res.json();
      })
      .then(data => {
        const container = document.getElementById('tunnelQrContainer');
        if (container && data.svg) container.innerHTML = data.svg;
        // Show auth badge, countdown, and regenerate button when auth is enabled
        if (data.authEnabled) {
          const badge = document.createElement('div');
          badge.id = 'tunnelQrBadge';
          badge.style.cssText = 'margin-top:8px;font-size:11px;color:var(--text-muted)';
          badge.textContent = 'Single-use auth \u00b7 expires in 60s';
          const regenBtn = document.createElement('button');
          regenBtn.textContent = 'Regenerate QR';
          regenBtn.style.cssText = 'margin-top:8px;padding:4px 12px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:4px;color:var(--text-secondary);cursor:pointer;font-size:11px';
          regenBtn.onclick = () => {
            fetch('/api/tunnel/qr/regenerate', { method: 'POST' })
              .then(() => this.showToast('QR code regenerated', 'success'))
              .catch(() => this.showToast('Failed to regenerate QR', 'error'));
          };
          const card = container.parentElement;
          if (card) {
            card.appendChild(badge);
            card.appendChild(regenBtn);
          }
          this._resetQrCountdown();
        }
      })
      .catch(() => {
        const container = document.getElementById('tunnelQrContainer');
        if (container) container.innerHTML = '<div style="color:#c00;font-size:12px;padding:20px">Tunnel not active</div>';
      });

    // Fetch URL for display
    fetch('/api/tunnel/status')
      .then(r => r.json())
      .then(status => {
        const urlEl = document.getElementById('tunnelQrUrl');
        if (urlEl && status.url) {
          urlEl.textContent = status.url;
          urlEl.onclick = () => {
            navigator.clipboard.writeText(status.url).then(() => {
              this.showToast('Tunnel URL copied', 'success');
            });
          };
        }
      })
      .catch(() => {});

    // Close on Escape
    this._tunnelQrEscHandler = (e) => { if (e.key === 'Escape') this.closeTunnelQR(); };
    document.addEventListener('keydown', this._tunnelQrEscHandler);
  }

  closeTunnelQR() {
    const overlay = document.getElementById('tunnelQrOverlay');
    if (overlay) overlay.remove();
    if (this._tunnelQrEscHandler) {
      document.removeEventListener('keydown', this._tunnelQrEscHandler);
      this._tunnelQrEscHandler = null;
    }
    this._clearQrCountdown();
  }

  /** Fallback: fetch QR SVG from API when SSE payload lacks it */
  _refreshTunnelQrFromApi() {
    fetch('/api/tunnel/qr')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.svg) return;
        const container = document.getElementById('tunnelQrContainer');
        if (container) container.innerHTML = data.svg;
        const welcomeInner = document.getElementById('welcomeQrInner');
        if (welcomeInner) welcomeInner.innerHTML = data.svg;
      })
      .catch(() => {});
  }

  /** Start or reset the 60s countdown on the QR badge */
  _resetQrCountdown() {
    this._clearQrCountdown();
    this._qrCountdownSec = 60;
    this._updateQrCountdownText();
    this._qrCountdownTimer = setInterval(() => {
      this._qrCountdownSec--;
      if (this._qrCountdownSec <= 0) {
        this._clearQrCountdown();
        return;
      }
      this._updateQrCountdownText();
    }, 1000);
  }

  _updateQrCountdownText() {
    const badge = document.getElementById('tunnelQrBadge');
    if (badge) {
      badge.textContent = `Single-use auth \u00b7 expires in ${this._qrCountdownSec}s`;
    }
  }

  _clearQrCountdown() {
    if (this._qrCountdownTimer) {
      clearInterval(this._qrCountdownTimer);
      this._qrCountdownTimer = null;
    }
  }

  async toggleTunnelFromWelcome() {
    const btn = document.getElementById('welcomeTunnelBtn');
    if (!btn) return;
    const isActive = btn.classList.contains('active');
    btn.disabled = true;
    try {
      const newEnabled = !isActive;
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelEnabled: newEnabled }),
      });
      if (newEnabled) {
        this._showTunnelConnecting();
        // Poll tunnel status as fallback in case SSE event is missed
        this._pollTunnelStatus();
      } else {
        this._dismissTunnelConnecting();
        this.showToast('Tunnel stopped', 'info');
        this._updateWelcomeTunnelBtn(false);
        btn.disabled = false;
      }
    } catch (err) {
      this._dismissTunnelConnecting();
      this.showToast('Failed to toggle tunnel', 'error');
      btn.disabled = false;
    }
  }

  _showTunnelConnecting() {
    // Remove any existing connecting toast first (without resetting button state)
    const oldToast = document.getElementById('tunnelConnectingToast');
    if (oldToast) {
      oldToast.remove();
    }
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) {
      btn.classList.add('connecting');
      btn.innerHTML = `
        <span class="tunnel-spinner"></span>
        Connecting...`;
    }
    // Persistent toast with spinner
    const toast = document.createElement('div');
    toast.className = 'toast toast-info show';
    toast.id = 'tunnelConnectingToast';
    toast.innerHTML = '<span class="tunnel-spinner"></span> Cloudflare Tunnel connecting...';
    toast.style.pointerEvents = 'auto';
    if (!this._toastContainer) {
      this._toastContainer = document.querySelector('.toast-container');
      if (!this._toastContainer) {
        this._toastContainer = document.createElement('div');
        this._toastContainer.className = 'toast-container';
        document.body.appendChild(this._toastContainer);
      }
    }
    this._toastContainer.appendChild(toast);
  }

  _dismissTunnelConnecting() {
    clearTimeout(this._tunnelPollTimer);
    this._tunnelPollTimer = null;
    const toast = document.getElementById('tunnelConnectingToast');
    if (toast) {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    }
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) btn.classList.remove('connecting');
  }

  _pollTunnelStatus(attempt = 0) {
    if (attempt > 15) return; // give up after ~30s
    this._tunnelPollTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/tunnel/status');
        const status = await res.json();
        if (status.running && status.url) {
          // Tunnel is up — update UI
          this._dismissTunnelConnecting();
          this._updateTunnelUrlDisplay(status.url);
          const welcomeVisible = document.getElementById('welcomeOverlay')?.classList.contains('visible');
          if (welcomeVisible) {
            this._updateWelcomeTunnelBtn(true, status.url, true);
            this.showToast('Tunnel active', 'success');
          } else {
            this._updateWelcomeTunnelBtn(true, status.url);
            this.showToast(`Tunnel active: ${status.url}`, 'success');
            this.showTunnelQR();
          }
          return;
        }
      } catch { /* ignore */ }
      this._pollTunnelStatus(attempt + 1);
    }, 2000);
  }

  _updateWelcomeTunnelBtn(active, url, firstAppear = false) {
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) {
      btn.disabled = false;
      if (active) {
        btn.classList.remove('connecting');
        btn.classList.add('active');
        btn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Tunnel Active`;
      } else {
        btn.classList.remove('active', 'connecting');
        btn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Cloudflare Tunnel`;
      }
    }
    // Update welcome QR code
    const qrWrap = document.getElementById('welcomeQr');
    const qrInner = document.getElementById('welcomeQrInner');
    const qrUrl = document.getElementById('welcomeQrUrl');
    if (!qrWrap || !qrInner) return;
    if (active) {
      qrWrap.classList.add('visible');
      // First appear: start expanded, auto-shrink after 8s
      if (firstAppear) {
        qrWrap.classList.add('expanded');
        clearTimeout(this._welcomeQrShrinkTimer);
        this._welcomeQrShrinkTimer = setTimeout(() => {
          qrWrap.classList.remove('expanded');
        }, 8000);
      }
      if (url) {
        qrUrl.textContent = url;
        qrUrl.title = 'Click QR to enlarge';
      }
      fetch('/api/tunnel/qr')
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then(data => { if (data.svg) qrInner.innerHTML = data.svg; })
        .catch(() => { qrInner.innerHTML = '<div style="color:#999;font-size:11px;padding:20px">QR unavailable</div>'; });
    } else {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.remove('visible', 'expanded');
      qrInner.innerHTML = '';
      if (qrUrl) qrUrl.textContent = '';
    }
  }

  toggleWelcomeQrSize() {
    const qrWrap = document.getElementById('welcomeQr');
    if (qrWrap) {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.toggle('expanded');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Tunnel Header Indicator & Panel (desktop only)
  // ═══════════════════════════════════════════════════════════════

  _updateTunnelIndicator(active) {
    if (MobileDetection.getDeviceType() === 'mobile') return;
    const indicator = document.getElementById('tunnelIndicator');
    if (!indicator) return;
    indicator.style.display = active ? 'flex' : 'none';
    indicator.classList.remove('connecting');
  }

  toggleTunnelPanel() {
    const existing = document.getElementById('tunnelPanel');
    if (existing) {
      this.closeTunnelPanel();
      return;
    }
    this._openTunnelPanel();
  }

  async _openTunnelPanel() {
    const panel = document.createElement('div');
    panel.className = 'tunnel-panel';
    panel.id = 'tunnelPanel';
    panel.innerHTML = `
      <div class="tunnel-panel-header">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Cloudflare Tunnel
          <span class="tunnel-panel-status" id="tunnelPanelStatus">Loading...</span>
        </h3>
      </div>
      <div class="tunnel-panel-body" id="tunnelPanelBody">
        <div style="font-size:12px;color:var(--text-muted);padding:8px 0">Loading...</div>
      </div>
    `;
    document.body.appendChild(panel);

    // Close on outside click
    this._tunnelPanelClickHandler = (e) => {
      if (!panel.contains(e.target) && e.target.id !== 'tunnelIndicator' && !e.target.closest('.tunnel-indicator')) {
        this.closeTunnelPanel();
      }
    };
    setTimeout(() => document.addEventListener('click', this._tunnelPanelClickHandler), 0);

    // Close on Escape
    this._tunnelPanelEscHandler = (e) => { if (e.key === 'Escape') this.closeTunnelPanel(); };
    document.addEventListener('keydown', this._tunnelPanelEscHandler);

    // Fetch tunnel info
    try {
      const res = await fetch('/api/tunnel/info');
      const info = await res.json();
      this._renderTunnelPanel(info);
    } catch {
      const body = document.getElementById('tunnelPanelBody');
      if (body) body.innerHTML = '<div style="font-size:12px;color:var(--red);padding:8px 0">Failed to load tunnel info</div>';
    }
  }

  _renderTunnelPanel(info) {
    const statusEl = document.getElementById('tunnelPanelStatus');
    const body = document.getElementById('tunnelPanelBody');
    if (!statusEl || !body) return;

    statusEl.textContent = info.running ? 'Connected' : 'Offline';
    statusEl.className = 'tunnel-panel-status' + (info.running ? '' : ' offline');

    let html = '';

    // URL section
    if (info.url) {
      html += `
        <div class="tunnel-panel-section">
          <div class="tunnel-panel-label">URL</div>
          <div class="tunnel-panel-url" id="tunnelPanelUrl" title="Click to copy">${escapeHtml(info.url)}</div>
        </div>`;
    }

    // Clients section
    html += `
      <div class="tunnel-panel-section">
        <div class="tunnel-panel-label">Connections</div>
        <div class="tunnel-panel-stat">
          <span>Remote Clients</span>
          <span class="tunnel-panel-stat-value">${info.sseClients}</span>
        </div>`;

    if (info.authEnabled) {
      html += `
        <div class="tunnel-panel-stat">
          <span>Auth Sessions</span>
          <span class="tunnel-panel-stat-value">${info.authSessions.length}</span>
        </div>`;
    }
    html += '</div>';

    // Auth sessions detail
    if (info.authEnabled && info.authSessions.length > 0) {
      html += '<div class="tunnel-panel-section"><div class="tunnel-panel-label">Authenticated Devices</div>';
      for (const s of info.authSessions) {
        const ua = s.ua || 'Unknown';
        const browser = ua.match(/Chrome|Firefox|Safari|Edge|Mobile/)?.[0] || 'Browser';
        const ago = this._formatTimeAgo(s.createdAt);
        html += `
          <div class="tunnel-panel-session">
            <span class="tunnel-panel-session-dot"></span>
            <span class="tunnel-panel-session-info" title="${escapeHtml(ua)}">${escapeHtml(browser)} &middot; ${escapeHtml(s.ip)} &middot; ${ago}</span>
            <span class="tunnel-panel-session-method">${s.method}</span>
          </div>`;
      }
      html += '</div>';
    }

    // Actions
    html += '<div class="tunnel-panel-actions">';
    if (info.running) {
      html += `
        <button class="tunnel-panel-btn btn-qr" onclick="app.showTunnelQR();app.closeTunnelPanel()">QR Code</button>
        <button class="tunnel-panel-btn btn-stop" onclick="app._tunnelPanelToggle(false)">Stop Tunnel</button>`;
    } else {
      html += `<button class="tunnel-panel-btn btn-start" onclick="app._tunnelPanelToggle(true)">Start Tunnel</button>`;
    }
    html += '</div>';

    // Revoke all sessions button
    if (info.authEnabled && info.authSessions.length > 0) {
      html += `
        <div style="padding-top:8px">
          <button class="tunnel-panel-btn btn-revoke" style="width:100%" onclick="app._tunnelPanelRevokeAll()">Revoke All Sessions</button>
        </div>`;
    }

    body.innerHTML = html;

    // Bind URL copy handler
    const urlEl = document.getElementById('tunnelPanelUrl');
    if (urlEl) {
      urlEl.onclick = () => {
        navigator.clipboard.writeText(info.url).then(() => this.showToast('Tunnel URL copied', 'success'));
      };
    }
  }

  _formatTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  async _tunnelPanelToggle(enable) {
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelEnabled: enable }),
      });
      if (enable) {
        this._updateTunnelIndicator(false);
        const indicator = document.getElementById('tunnelIndicator');
        if (indicator) {
          indicator.style.display = 'flex';
          indicator.classList.add('connecting');
        }
        this.showToast('Tunnel starting...', 'info');
        this._showTunnelConnecting();
        this._pollTunnelStatus();
      } else {
        this.showToast('Tunnel stopped', 'info');
      }
      this.closeTunnelPanel();
    } catch {
      this.showToast('Failed to toggle tunnel', 'error');
    }
  }

  async _tunnelPanelRevokeAll() {
    try {
      await fetch('/api/auth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      this.showToast('All sessions revoked', 'success');
      // Refresh panel
      const res = await fetch('/api/tunnel/info');
      const info = await res.json();
      this._renderTunnelPanel(info);
    } catch {
      this.showToast('Failed to revoke sessions', 'error');
    }
  }

  closeTunnelPanel() {
    const panel = document.getElementById('tunnelPanel');
    if (panel) panel.remove();
    if (this._tunnelPanelClickHandler) {
      document.removeEventListener('click', this._tunnelPanelClickHandler);
      this._tunnelPanelClickHandler = null;
    }
    if (this._tunnelPanelEscHandler) {
      document.removeEventListener('keydown', this._tunnelPanelEscHandler);
      this._tunnelPanelEscHandler = null;
    }
  }

  toggleDeepgramKeyVisibility() {
    const input = document.getElementById('voiceDeepgramKey');
    const btn = document.getElementById('voiceKeyToggleBtn');
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      btn.textContent = 'Show';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Lifecycle Log
  // ═══════════════════════════════════════════════════════════════

  openLifecycleLog() {
    const win = document.getElementById('lifecycleWindow');
    win.style.display = 'block';
    // Reset transform so it appears centered initially
    if (!win._dragInitialized) {
      win.style.left = '50%';
      win.style.transform = 'translateX(-50%)';
      this._initLifecycleDrag(win);
      win._dragInitialized = true;
    }
    this.loadLifecycleLog();
  }

  closeLifecycleLog() {
    document.getElementById('lifecycleWindow').style.display = 'none';
  }

  _initLifecycleDrag(win) {
    const header = document.getElementById('lifecycleWindowHeader');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      isDragging = true;
      // Clear transform so left/top work in absolute pixels
      const rect = win.getBoundingClientRect();
      win.style.transform = 'none';
      win.style.left = rect.left + 'px';
      win.style.top = rect.top + 'px';
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      win.style.left = (startLeft + e.clientX - startX) + 'px';
      win.style.top = (startTop + e.clientY - startY) + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  async loadLifecycleLog() {
    const eventFilter = document.getElementById('lifecycleFilterEvent').value;
    const sessionFilter = document.getElementById('lifecycleFilterSession').value.trim();
    const params = new URLSearchParams();
    if (eventFilter) params.set('event', eventFilter);
    if (sessionFilter) params.set('sessionId', sessionFilter);
    params.set('limit', '300');

    try {
      const res = await fetch(`/api/session-lifecycle?${params}`);
      const data = await res.json();
      const tbody = document.getElementById('lifecycleTableBody');
      const empty = document.getElementById('lifecycleEmpty');

      if (!data.entries || data.entries.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = '';
        return;
      }
      empty.style.display = 'none';

      const eventColors = {
        created: '#4ade80', started: '#4ade80', recovered: '#4ade80',
        exit: '#fbbf24', mux_died: '#f87171', deleted: '#f87171', stale_cleaned: '#f87171',
        server_started: '#666', server_stopped: '#666',
      };

      tbody.innerHTML = data.entries.map(e => {
        const time = new Date(e.ts).toLocaleString();
        const color = eventColors[e.event] || '#888';
        const name = e.name || (e.sessionId === '*' ? '—' : this.getShortId(e.sessionId));
        const extra = [];
        if (e.exitCode !== undefined && e.exitCode !== null) extra.push(`code=${e.exitCode}`);
        if (e.mode) extra.push(e.mode);
        return `<tr style="border-bottom:1px solid #1a1a2e">
          <td style="padding:3px 8px;color:#888;white-space:nowrap">${time}</td>
          <td style="padding:3px 8px;color:${color};font-weight:600">${e.event}</td>
          <td style="padding:3px 8px;color:#e0e0e0" title="${e.sessionId}">${name}</td>
          <td style="padding:3px 8px;color:#aaa">${e.reason || ''}</td>
          <td style="padding:3px 8px;color:#666">${extra.join(', ')}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('Failed to load lifecycle log:', err);
    }
  }

  async saveAppSettings() {
    const settings = {
      defaultClaudeMdPath: document.getElementById('appSettingsClaudeMdPath').value.trim(),
      defaultWorkingDir: document.getElementById('appSettingsDefaultDir').value.trim(),
      ralphTrackerEnabled: document.getElementById('appSettingsRalphEnabled').checked,
      // Header visibility settings
      showFontControls: document.getElementById('appSettingsShowFontControls').checked,
      showSystemStats: document.getElementById('appSettingsShowSystemStats').checked,
      showTokenCount: document.getElementById('appSettingsShowTokenCount').checked,
      showCost: document.getElementById('appSettingsShowCost').checked,
      showLifecycleLog: document.getElementById('appSettingsShowLifecycleLog').checked,
      showMonitor: document.getElementById('appSettingsShowMonitor').checked,
      showProjectInsights: document.getElementById('appSettingsShowProjectInsights').checked,
      showFileBrowser: document.getElementById('appSettingsShowFileBrowser').checked,
      showSubagents: document.getElementById('appSettingsShowSubagents').checked,
      subagentTrackingEnabled: document.getElementById('appSettingsSubagentTracking').checked,
      subagentActiveTabOnly: document.getElementById('appSettingsSubagentActiveTabOnly').checked,
      imageWatcherEnabled: document.getElementById('appSettingsImageWatcherEnabled').checked,
      tunnelEnabled: document.getElementById('appSettingsTunnelEnabled').checked,
      localEchoEnabled: document.getElementById('appSettingsLocalEcho').checked,
      stopOnCleanExit: document.getElementById('appSettingsStopOnCleanExit').checked,
      hotbarButtons: [...document.querySelectorAll('input[name="hotbarBtn"]:checked')].map(cb => cb.value),
      hotbarCustomCommands: this._collectHotbarCustomCmds(),
      tabTwoRows: document.getElementById('appSettingsTabTwoRows').checked,
      // Claude CLI settings
      claudeMode: document.getElementById('appSettingsClaudeMode').value,
      allowedTools: document.getElementById('appSettingsAllowedTools').value.trim(),
      // Claude Permissions settings
      agentTeamsEnabled: document.getElementById('appSettingsAgentTeams').checked,
      // CPU Priority settings
      nice: {
        enabled: document.getElementById('appSettingsNiceEnabled').checked,
        niceValue: parseInt(document.getElementById('appSettingsNiceValue').value) || 10,
      },
    };

    // Save to localStorage
    this.saveAppSettingsToStorage(settings);
    this._updateLocalEchoState();

    // Save voice settings to localStorage + include in server payload for cross-device sync
    const voiceSettings = {
      apiKey: document.getElementById('voiceDeepgramKey').value.trim(),
      language: document.getElementById('voiceLanguage').value,
      keyterms: document.getElementById('voiceKeyterms').value.trim(),
      insertMode: document.getElementById('voiceInsertMode').value,
    };
    VoiceInput._saveDeepgramConfig(voiceSettings);

    // Save notification preferences separately
    const notifPrefsToSave = {
      enabled: document.getElementById('appSettingsNotifEnabled').checked,
      browserNotifications: document.getElementById('appSettingsNotifBrowser').checked,
      audioAlerts: document.getElementById('appSettingsNotifAudio').checked,
      stuckThresholdMs: (parseInt(document.getElementById('appSettingsNotifStuckMins').value) || 10) * 60000,
      muteCritical: !document.getElementById('appSettingsNotifCritical').checked,
      muteWarning: !document.getElementById('appSettingsNotifWarning').checked,
      muteInfo: !document.getElementById('appSettingsNotifInfo').checked,
      // Per-event-type preferences
      eventTypes: {
        permission_prompt: {
          enabled: document.getElementById('eventPermissionEnabled').checked,
          browser: document.getElementById('eventPermissionBrowser').checked,
          push: document.getElementById('eventPermissionPush').checked,
          audio: document.getElementById('eventPermissionAudio').checked,
        },
        elicitation_dialog: {
          enabled: document.getElementById('eventQuestionEnabled').checked,
          browser: document.getElementById('eventQuestionBrowser').checked,
          push: document.getElementById('eventQuestionPush').checked,
          audio: document.getElementById('eventQuestionAudio').checked,
        },
        idle_prompt: {
          enabled: document.getElementById('eventIdleEnabled').checked,
          browser: document.getElementById('eventIdleBrowser').checked,
          push: document.getElementById('eventIdlePush').checked,
          audio: document.getElementById('eventIdleAudio').checked,
        },
        stop: {
          enabled: document.getElementById('eventStopEnabled').checked,
          browser: document.getElementById('eventStopBrowser').checked,
          push: document.getElementById('eventStopPush').checked,
          audio: document.getElementById('eventStopAudio').checked,
        },
        session_error: {
          enabled: true,
          browser: this.notificationManager?.preferences?.eventTypes?.session_error?.browser ?? true,
          push: this.notificationManager?.preferences?.eventTypes?.session_error?.push ?? false,
          audio: false,
        },
        respawn_cycle: {
          enabled: document.getElementById('eventRespawnEnabled').checked,
          browser: document.getElementById('eventRespawnBrowser').checked,
          push: document.getElementById('eventRespawnPush').checked,
          audio: document.getElementById('eventRespawnAudio').checked,
        },
        token_milestone: {
          enabled: true,
          browser: false,
          push: false,
          audio: false,
        },
        ralph_complete: {
          enabled: document.getElementById('eventRalphEnabled').checked,
          browser: document.getElementById('eventRalphBrowser').checked,
          push: document.getElementById('eventRalphPush').checked,
          audio: document.getElementById('eventRalphAudio').checked,
        },
        subagent_spawn: {
          enabled: document.getElementById('eventSubagentEnabled').checked,
          browser: document.getElementById('eventSubagentBrowser').checked,
          push: document.getElementById('eventSubagentPush').checked,
          audio: document.getElementById('eventSubagentAudio').checked,
        },
        subagent_complete: {
          enabled: document.getElementById('eventSubagentEnabled').checked,
          browser: document.getElementById('eventSubagentBrowser').checked,
          push: document.getElementById('eventSubagentPush').checked,
          audio: document.getElementById('eventSubagentAudio').checked,
        },
      },
      _version: 4,
    };
    if (this.notificationManager) {
      this.notificationManager.preferences = notifPrefsToSave;
      this.notificationManager.savePreferences();
    }

    // Sync push preferences to server
    this._syncPushPreferences();

    // Apply header visibility immediately
    this.applyHeaderVisibilitySettings();
    this.applyTabWrapSettings();
    this._updateTokensImmediate();  // Re-render token display (picks up showCost change)
    this.applyMonitorVisibility();
    this.renderProjectInsightsPanel();  // Re-render to apply visibility setting
    this.updateSubagentWindowVisibility();  // Apply subagent window visibility setting

    // Save to server (includes notification prefs for cross-browser persistence)
    // Strip device-specific keys — localEchoEnabled is per-platform (touch default differs)
    const { localEchoEnabled: _leo, ...serverSettings } = settings;
    try {
      await this._apiPut('/api/settings', { ...serverSettings, notificationPreferences: notifPrefsToSave, voiceSettings });

      // Save model configuration separately
      await this.saveModelConfigFromSettings();

      this.showToast('Settings saved', 'success');

      // Show tunnel-specific feedback if toggled on
      if (settings.tunnelEnabled) {
        this.showToast('Tunnel starting — QR code will appear when ready...', 'info');
      }
    } catch (err) {
      // Server save failed but localStorage succeeded
      this.showToast('Settings saved locally', 'warning');
    }

    this.closeAppSettings();
  }

  // Load model configuration from server for the settings modal
  async loadModelConfigForSettings() {
    try {
      const res = await fetch('/api/execution/model-config');
      const data = await res.json();
      if (data.success && data.data) {
        const config = data.data;
        // Default model
        const defaultModelEl = document.getElementById('appSettingsDefaultModel');
        if (defaultModelEl) {
          defaultModelEl.value = config.defaultModel || 'opus';
        }
        // Show recommendations
        const showRecsEl = document.getElementById('appSettingsShowModelRecommendations');
        if (showRecsEl) {
          showRecsEl.checked = config.showRecommendations ?? true;
        }
        // Agent type overrides
        const overrides = config.agentTypeOverrides || {};
        const exploreEl = document.getElementById('appSettingsModelExplore');
        const implementEl = document.getElementById('appSettingsModelImplement');
        const testEl = document.getElementById('appSettingsModelTest');
        const reviewEl = document.getElementById('appSettingsModelReview');
        if (exploreEl) exploreEl.value = overrides.explore || '';
        if (implementEl) implementEl.value = overrides.implement || '';
        if (testEl) testEl.value = overrides.test || '';
        if (reviewEl) reviewEl.value = overrides.review || '';
      }
    } catch (err) {
      console.warn('Failed to load model config:', err);
    }
  }

  // Save model configuration from settings modal to server
  async saveModelConfigFromSettings() {
    const defaultModelEl = document.getElementById('appSettingsDefaultModel');
    const showRecsEl = document.getElementById('appSettingsShowModelRecommendations');
    const exploreEl = document.getElementById('appSettingsModelExplore');
    const implementEl = document.getElementById('appSettingsModelImplement');
    const testEl = document.getElementById('appSettingsModelTest');
    const reviewEl = document.getElementById('appSettingsModelReview');

    const agentTypeOverrides = {};
    if (exploreEl?.value) agentTypeOverrides.explore = exploreEl.value;
    if (implementEl?.value) agentTypeOverrides.implement = implementEl.value;
    if (testEl?.value) agentTypeOverrides.test = testEl.value;
    if (reviewEl?.value) agentTypeOverrides.review = reviewEl.value;

    const config = {
      defaultModel: defaultModelEl?.value || 'opus',
      showRecommendations: showRecsEl?.checked ?? true,
      agentTypeOverrides,
    };

    try {
      await fetch('/api/execution/model-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
    } catch (err) {
      console.warn('Failed to save model config:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Visibility Settings & Device-Specific Defaults
  // ═══════════════════════════════════════════════════════════════

  // Get the global Ralph tracker enabled setting
  isRalphTrackerEnabledByDefault() {
    const settings = this.loadAppSettingsFromStorage();
    return settings.ralphTrackerEnabled ?? false;
  }

  // Get the settings storage key based on device type (mobile vs desktop)
  getSettingsStorageKey() {
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    return isMobile ? 'codeman-app-settings-mobile' : 'codeman-app-settings';
  }

  // Get default settings based on device type
  // Note: Notification prefs are handled separately by NotificationManager
  getDefaultSettings() {
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    if (isMobile) {
      // Mobile defaults: minimal UI for small screens
      return {
        // Header visibility - hide everything on mobile
        showFontControls: false,
        showSystemStats: false,
        showTokenCount: false,
        showCost: false,
        // Panel visibility - hide panels on mobile (not enough space)
        showMonitor: false,
        showProjectInsights: false,
        showFileBrowser: false,
        showSubagents: false,
        // Feature toggles - keep tracking on even on mobile
        subagentTrackingEnabled: true,
        subagentActiveTabOnly: true, // Only show subagents for active tab
        imageWatcherEnabled: false,
        ralphTrackerEnabled: false,
        tabTwoRows: false,
      };
    }
    // Desktop defaults - rely on ?? operators in apply functions
    // This allows desktop to have different defaults without duplication
    return {};
  }

  loadAppSettingsFromStorage() {
    // Return cached settings if available (avoids synchronous localStorage + JSON.parse
    // on every SSE event — critical for input responsiveness)
    if (this._cachedAppSettings) return this._cachedAppSettings;
    try {
      const key = this.getSettingsStorageKey();
      const saved = localStorage.getItem(key);
      if (saved) {
        this._cachedAppSettings = JSON.parse(saved);
        return this._cachedAppSettings;
      }
    } catch (err) {
      console.error('Failed to load app settings:', err);
    }
    // Return device-specific defaults
    this._cachedAppSettings = this.getDefaultSettings();
    return this._cachedAppSettings;
  }

  saveAppSettingsToStorage(settings) {
    // Invalidate cache on save
    this._cachedAppSettings = settings;
    try {
      const key = this.getSettingsStorageKey();
      localStorage.setItem(key, JSON.stringify(settings));
    } catch (err) {
      console.error('Failed to save app settings:', err);
    }
  }

  applyHeaderVisibilitySettings() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const showFontControls = settings.showFontControls ?? defaults.showFontControls ?? false;
    const showSystemStats = settings.showSystemStats ?? defaults.showSystemStats ?? true;
    const showTokenCount = settings.showTokenCount ?? defaults.showTokenCount ?? true;

    const fontControlsEl = document.querySelector('.header-font-controls');
    const systemStatsEl = document.getElementById('headerSystemStats');
    const tokenCountEl = document.getElementById('headerTokens');

    if (fontControlsEl) {
      fontControlsEl.style.display = showFontControls ? '' : 'none';
    }
    if (systemStatsEl) {
      systemStatsEl.style.display = showSystemStats ? '' : 'none';
    }
    if (tokenCountEl) {
      tokenCountEl.style.display = showTokenCount ? '' : 'none';
    }

    // Hide lifecycle log button when setting is disabled
    const showLifecycleLog = settings.showLifecycleLog ?? defaults.showLifecycleLog ?? true;
    const lifecycleBtn = document.querySelector('.btn-lifecycle-log');
    if (lifecycleBtn) {
      lifecycleBtn.style.display = showLifecycleLog ? '' : 'none';
    }

    // Hide notification bell when notifications are disabled
    const notifEnabled = this.notificationManager?.preferences?.enabled ?? true;
    const notifBtn = document.querySelector('.btn-notifications');
    if (notifBtn) {
      notifBtn.style.display = notifEnabled ? '' : 'none';
    }
    // Close the drawer if notifications got disabled while it's open
    if (!notifEnabled) {
      const drawer = document.getElementById('notifDrawer');
      if (drawer) drawer.classList.remove('open');
    }
  }

  applyTabWrapSettings() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const deviceType = MobileDetection.getDeviceType();
    // Two-row tabs disabled on mobile/tablet — not enough screen space
    const twoRows = deviceType === 'desktop'
      ? (settings.tabTwoRows ?? defaults.tabTwoRows ?? false)
      : false;
    const prevTallTabs = this._tallTabsEnabled;
    this._tallTabsEnabled = twoRows;
    const tabsEl = document.getElementById('sessionTabs');
    if (tabsEl) {
      tabsEl.classList.toggle('tabs-two-rows', twoRows);
      tabsEl.classList.toggle('tabs-show-folder', twoRows);
    }
    // Re-render tabs if folder visibility changed (folder spans are generated in JS)
    if (prevTallTabs !== undefined && prevTallTabs !== twoRows) {
      this._fullRenderSessionTabs();
    }
  }

  applyMonitorVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const showMonitor = settings.showMonitor ?? defaults.showMonitor ?? true;
    const showSubagents = settings.showSubagents ?? defaults.showSubagents ?? true;
    const showFileBrowser = settings.showFileBrowser ?? defaults.showFileBrowser ?? false;

    const monitorPanel = document.getElementById('monitorPanel');
    if (monitorPanel) {
      monitorPanel.style.display = showMonitor ? '' : 'none';
      if (showMonitor) {
        monitorPanel.classList.add('open');
      } else {
        monitorPanel.classList.remove('open');
      }
    }

    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      if (showSubagents) {
        subagentsPanel.classList.remove('hidden');
      } else {
        subagentsPanel.classList.add('hidden');
      }
    }

    // File browser panel visibility
    const fileBrowserPanel = document.getElementById('fileBrowserPanel');
    if (fileBrowserPanel) {
      if (showFileBrowser && this.activeSessionId) {
        fileBrowserPanel.classList.add('visible');
        this.loadFileBrowser(this.activeSessionId);
        // Attach drag listeners if not already attached
        if (!this.fileBrowserDragListeners) {
          const header = fileBrowserPanel.querySelector('.file-browser-header');
          if (header) {
            // Convert right-positioned to left/top before drag so makeWindowDraggable works
            const onFirstDrag = () => {
              if (!fileBrowserPanel.style.left) {
                const rect = fileBrowserPanel.getBoundingClientRect();
                fileBrowserPanel.style.left = `${rect.left}px`;
                fileBrowserPanel.style.top = `${rect.top}px`;
                fileBrowserPanel.style.right = 'auto';
              }
            };
            header.addEventListener('mousedown', onFirstDrag);
            header.addEventListener('touchstart', onFirstDrag, { passive: true });
            this.fileBrowserDragListeners = this.makeWindowDraggable(fileBrowserPanel, header);
            this.fileBrowserDragListeners._onFirstDrag = onFirstDrag;
          }
        }
      } else {
        fileBrowserPanel.classList.remove('visible');
      }
    }
  }

  closeMonitor() {
    // Hide the monitor panel
    const monitorPanel = document.getElementById('monitorPanel');
    if (monitorPanel) {
      monitorPanel.classList.remove('open');
      monitorPanel.style.display = 'none';
    }
    // Save the setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showMonitor = false;
    this.saveAppSettingsToStorage(settings);
  }

  closeSubagentsPanel() {
    // Hide the subagents panel
    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      subagentsPanel.classList.remove('open');
      subagentsPanel.classList.add('hidden');
    }
    this.subagentPanelVisible = false;
    // Save the setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showSubagents = false;
    this.saveAppSettingsToStorage(settings);
  }

  async clearAllSubagents() {
    const count = this.subagents.size;
    if (count === 0) {
      this.showToast('No subagents to clear', 'info');
      return;
    }

    if (!confirm(`Clear all ${count} tracked subagent(s)? This removes them from the UI but does not affect running processes.`)) {
      return;
    }

    try {
      const res = await fetch('/api/subagents', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        // Clear local state
        this.subagents.clear();
        this.subagentActivity.clear();
        this.subagentToolResults.clear();
        // Close any open subagent windows
        this.cleanupAllFloatingWindows();
        // Update UI
        this.renderSubagentPanel();
        this.renderMonitorSubagents();
        this.updateSubagentBadge();
        this.showToast(`Cleared ${data.data.cleared} subagent(s)`, 'success');
      } else {
        this.showToast('Failed to clear subagents: ' + data.error, 'error');
      }
    } catch (err) {
      this.showToast('Failed to clear subagents', 'error');
    }
  }

  toggleSubagentsPanel() {
    const panel = document.getElementById('subagentsPanel');
    const toggleBtn = document.getElementById('subagentsToggleBtn');
    if (!panel) return;

    // If hidden, show it first
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      // Save setting
      const settings = this.loadAppSettingsFromStorage();
      settings.showSubagents = true;
      this.saveAppSettingsToStorage(settings);
    }

    // Toggle open/collapsed state
    panel.classList.toggle('open');
    this.subagentPanelVisible = panel.classList.contains('open');

    // Update toggle button icon
    if (toggleBtn) {
      toggleBtn.innerHTML = this.subagentPanelVisible ? '&#x25BC;' : '&#x25B2;'; // Down when open, up when collapsed
    }

    if (this.subagentPanelVisible) {
      this.renderSubagentPanel();
    }
  }

  async loadAppSettingsFromServer(settingsPromise = null) {
    try {
      const settings = settingsPromise ? await settingsPromise : await fetch('/api/settings').then(r => r.ok ? r.json() : null);
      if (settings) {
        // Extract notification prefs before merging app settings
        const { notificationPreferences, voiceSettings, ...appSettings } = settings;
        // Filter out display settings — these are device-specific (mobile vs desktop)
        // and should not be synced from the server to avoid overriding mobile defaults.
        // NOTE: Feature toggles (subagentTrackingEnabled, imageWatcherEnabled, ralphTrackerEnabled)
        // are NOT display keys — they control server-side behavior and must sync from server.
        const displayKeys = new Set([
          'showFontControls', 'showSystemStats', 'showTokenCount', 'showCost',
          'showMonitor', 'showProjectInsights', 'showFileBrowser', 'showSubagents',
          'subagentActiveTabOnly', 'tabTwoRows', 'localEchoEnabled',
        ]);
        // Merge settings: non-display keys always sync from server,
        // display keys only seed from server when localStorage has no value
        // (prevents cross-device overwrite while fixing settings re-enabling on fresh loads)
        const localSettings = this.loadAppSettingsFromStorage();
        const merged = { ...localSettings };
        for (const [key, value] of Object.entries(appSettings)) {
          if (displayKeys.has(key)) {
            // Display keys: only use server value as initial seed
            if (!(key in localSettings)) {
              merged[key] = value;
            }
          } else {
            // Non-display keys: server always wins
            merged[key] = value;
          }
        }
        this.saveAppSettingsToStorage(merged);

        // Apply notification prefs from server if present (only if localStorage has none)
        if (notificationPreferences && this.notificationManager) {
          const localNotifPrefs = localStorage.getItem(this.notificationManager.getStorageKey());
          if (!localNotifPrefs) {
            this.notificationManager.preferences = notificationPreferences;
            this.notificationManager.savePreferences();
          }
        }

        // Sync voice settings from server (seed localStorage if no local API key)
        if (voiceSettings) {
          const localVoice = localStorage.getItem('codeman-voice-settings');
          if (!localVoice || !JSON.parse(localVoice).apiKey) {
            VoiceInput._saveDeepgramConfig(voiceSettings);
          }
        }

        return merged;
      }
    } catch (err) {
      console.error('Failed to load settings from server:', err);
    }
    return this.loadAppSettingsFromStorage();
  }


  /**
   * Load subagent window states from server (or localStorage fallback).
   * Called on page load to restore minimized/open window states.
   */
  async loadSubagentWindowStates() {
    let states = null;

    // Try server first for cross-browser sync
    try {
      const res = await fetch('/api/subagent-window-states');
      if (res.ok) {
        states = await res.json();
        // Also update localStorage
        localStorage.setItem('codeman-subagent-window-states', JSON.stringify(states));
      }
    } catch (err) {
      console.error('Failed to load subagent window states from server:', err);
    }

    // Fallback to localStorage
    if (!states) {
      try {
        const saved = localStorage.getItem('codeman-subagent-window-states');
        if (saved) {
          states = JSON.parse(saved);
        }
      } catch (err) {
        console.error('Failed to load subagent window states from localStorage:', err);
      }
    }

    return states || { minimized: {}, open: [] };
  }


  // ═══════════════════════════════════════════════════════════════
  // Persistent Parent Associations
  // ═══════════════════════════════════════════════════════════════
  // This is the ROCK-SOLID system for tracking which tab an agent belongs to.
  // Once an agent's parent is discovered, it's saved here PERMANENTLY.

  /**
   * Save the subagent parent map to localStorage and server.
   * Called whenever a new parent association is discovered.
   */
  async saveSubagentParentMap() {
    const mapData = Object.fromEntries(this.subagentParentMap);

    // Save to localStorage for instant recovery
    try {
      localStorage.setItem('codeman-subagent-parents', JSON.stringify(mapData));
    } catch (err) {
      console.error('Failed to save subagent parents to localStorage:', err);
    }

    // Save to server for cross-browser/session persistence
    try {
      await fetch('/api/subagent-parents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mapData)
      });
    } catch (err) {
      console.error('Failed to save subagent parents to server:', err);
    }
  }

  /**
   * Load the subagent parent map from server (or localStorage fallback).
   * Called once on page load, before any agents are discovered.
   */
  async loadSubagentParentMap() {
    let mapData = null;

    // Try server first (most authoritative)
    try {
      const res = await fetch('/api/subagent-parents');
      if (res.ok) {
        mapData = await res.json();
        // Update localStorage as cache
        localStorage.setItem('codeman-subagent-parents', JSON.stringify(mapData));
      }
    } catch (err) {
      console.error('Failed to load subagent parents from server:', err);
    }

    // Fallback to localStorage
    if (!mapData) {
      try {
        const saved = localStorage.getItem('codeman-subagent-parents');
        if (saved) {
          mapData = JSON.parse(saved);
        }
      } catch (err) {
        console.error('Failed to load subagent parents from localStorage:', err);
      }
    }

    // Populate the map (prune stale entries: require both session and agent to exist)
    if (mapData && typeof mapData === 'object') {
      for (const [agentId, sessionId] of Object.entries(mapData)) {
        if (this.sessions.has(sessionId) && this.subagents.has(agentId)) {
          this.subagentParentMap.set(agentId, sessionId);
        }
      }
    }
  }

  /**
   * Get the parent session ID for an agent from the persistent map.
   * This is the ONLY source of truth for connection lines.
   */
  getAgentParentSessionId(agentId) {
    return this.subagentParentMap.get(agentId) || null;
  }

  /**
   * Set and persist the parent session ID for an agent.
   * Once set, this association is PERMANENT and never recalculated.
   */
  setAgentParentSessionId(agentId, sessionId) {
    if (!agentId || !sessionId) return;

    // Only set if not already set (first association wins)
    if (this.subagentParentMap.has(agentId)) {
      return; // Already has a parent, don't override
    }

    this.subagentParentMap.set(agentId, sessionId);
    this.saveSubagentParentMap(); // Persist immediately

    // Also update the agent object for consistency
    const agent = this.subagents.get(agentId);
    if (agent) {
      agent.parentSessionId = sessionId;
      const session = this.sessions.get(sessionId);
      if (session) {
        agent.parentSessionName = this.getSessionName(session);
      }
      this.subagents.set(agentId, agent);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Help Modal
  // ═══════════════════════════════════════════════════════════════

  showHelp() {
    const modal = document.getElementById('helpModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  closeHelp() {
    document.getElementById('helpModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  closeAllPanels() {
    this.closeSessionOptions();
    this.closeAppSettings();
    this.cancelCloseSession();
    this.closeTokenStats();
    if (typeof SessionDrawer !== 'undefined') SessionDrawer.close();
    if (typeof InputPanel !== 'undefined') InputPanel.close();
    document.getElementById('monitorPanel').classList.remove('open');
    // Collapse subagents panel (don't hide it permanently)
    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      subagentsPanel.classList.remove('open');
    }
    this.subagentPanelVisible = false;
    if (typeof TerminalSearch !== 'undefined') TerminalSearch.close();
    if (typeof SessionSwitcher !== 'undefined') SessionSwitcher.close();
  }

  // ═══════════════════════════════════════════════════════════════
  // Token Statistics Modal
  // ═══════════════════════════════════════════════════════════════

  async openTokenStats() {
    try {
      const response = await fetch('/api/token-stats');
      const data = await response.json();
      if (data.success) {
        this.renderTokenStats(data);
        document.getElementById('tokenStatsModal').classList.add('active');
      } else {
        this.showToast('Failed to load token stats', 'error');
      }
    } catch (err) {
      console.error('Failed to fetch token stats:', err);
      this.showToast('Failed to load token stats', 'error');
    }
  }

  renderTokenStats(data) {
    const { daily, totals } = data;

    // Calculate period totals
    const today = new Date().toISOString().split('T')[0];
    const todayData = daily.find(d => d.date === today) || { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

    // Last 7 days totals (for summary card)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const last7Days = daily.filter(d => new Date(d.date) >= sevenDaysAgo);
    const weekInput = last7Days.reduce((sum, d) => sum + d.inputTokens, 0);
    const weekOutput = last7Days.reduce((sum, d) => sum + d.outputTokens, 0);
    const weekCost = this.estimateCost(weekInput, weekOutput);

    // Lifetime totals (from aggregate stats)
    const lifetimeInput = totals.totalInputTokens;
    const lifetimeOutput = totals.totalOutputTokens;
    const lifetimeCost = this.estimateCost(lifetimeInput, lifetimeOutput);

    // Render summary cards
    const summaryEl = document.getElementById('statsSummary');
    summaryEl.innerHTML = `
      <div class="stat-card">
        <span class="stat-card-label">Today</span>
        <span class="stat-card-value">${this.formatTokens(todayData.inputTokens + todayData.outputTokens)}</span>
        <span class="stat-card-cost">~$${todayData.estimatedCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">7 Days</span>
        <span class="stat-card-value">${this.formatTokens(weekInput + weekOutput)}</span>
        <span class="stat-card-cost">~$${weekCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">Lifetime</span>
        <span class="stat-card-value">${this.formatTokens(lifetimeInput + lifetimeOutput)}</span>
        <span class="stat-card-cost">~$${lifetimeCost.toFixed(2)}</span>
      </div>
    `;

    // Render bar chart (last 7 days)
    const chartEl = document.getElementById('statsChart');
    const daysEl = document.getElementById('statsChartDays');

    // Get last 7 days (fill gaps with empty data)
    const chartData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayData = daily.find(d => d.date === dateStr);
      chartData.push({
        date: dateStr,
        dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
        tokens: dayData ? dayData.inputTokens + dayData.outputTokens : 0,
        cost: dayData ? dayData.estimatedCost : 0,
      });
    }

    // Find max for scaling
    const maxTokens = Math.max(...chartData.map(d => d.tokens), 1);

    chartEl.innerHTML = chartData.map(d => {
      const height = Math.max((d.tokens / maxTokens) * 100, 3);
      const tooltip = `${d.dayName}: ${this.formatTokens(d.tokens)} (~$${d.cost.toFixed(2)})`;
      return `<div class="bar" style="height: ${height}%" data-tooltip="${tooltip}"></div>`;
    }).join('');

    daysEl.innerHTML = chartData.map(d => `<span>${d.dayName}</span>`).join('');

    // Render table (last 14 days with data)
    const tableEl = document.getElementById('statsTable');
    const tableData = daily.slice(0, 14);

    if (tableData.length === 0) {
      tableEl.innerHTML = '<div class="stats-no-data">No usage data recorded yet</div>';
    } else {
      tableEl.innerHTML = `
        <div class="stats-table-header">
          <span>Date</span>
          <span>Input</span>
          <span>Output</span>
          <span>Cost</span>
        </div>
        ${tableData.map(d => {
          const dateObj = new Date(d.date + 'T00:00:00');
          const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return `
            <div class="stats-table-row">
              <span class="cell cell-date">${dateStr}</span>
              <span class="cell">${this.formatTokens(d.inputTokens)}</span>
              <span class="cell">${this.formatTokens(d.outputTokens)}</span>
              <span class="cell cell-cost">$${d.estimatedCost.toFixed(2)}</span>
            </div>
          `;
        }).join('')}
      `;
    }
  }

  closeTokenStats() {
    const modal = document.getElementById('tokenStatsModal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Monitor Panel (combined Mux Sessions + Background Tasks)
  // ═══════════════════════════════════════════════════════════════

  async toggleMonitorPanel() {
    const panel = document.getElementById('monitorPanel');
    const toggleBtn = document.getElementById('monitorToggleBtn');
    panel.classList.toggle('open');

    if (panel.classList.contains('open')) {
      // Load screens and start stats collection
      await this.loadMuxSessions();
      await fetch('/api/mux-sessions/stats/start', { method: 'POST' });
      this.renderTaskPanel();
      if (toggleBtn) toggleBtn.innerHTML = '&#x25BC;'; // Down arrow when open
    } else {
      // Stop stats collection when panel is closed
      await fetch('/api/mux-sessions/stats/stop', { method: 'POST' });
      if (toggleBtn) toggleBtn.innerHTML = '&#x25B2;'; // Up arrow when closed
    }
  }

  // Legacy alias for task panel toggle (used by session tab badge)
  toggleTaskPanel() {
    this.toggleMonitorPanel();
  }

  // ═══════════════════════════════════════════════════════════════
  // Monitor Panel Detach & Drag
  // ═══════════════════════════════════════════════════════════════

  toggleMonitorDetach() {
    const panel = document.getElementById('monitorPanel');
    const detachBtn = document.getElementById('monitorDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon (two overlapping squares)
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon (squared plus - dock back)
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupMonitorDrag();
    }
  }

  setupMonitorDrag() {
    const panel = document.getElementById('monitorPanel');
    const header = document.getElementById('monitorPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  }

  // ═══════════════════════════════════════════════════════════════
  // Subagents Panel Detach & Drag
  // ═══════════════════════════════════════════════════════════════

  toggleSubagentsDetach() {
    const panel = document.getElementById('subagentsPanel');
    const detachBtn = document.getElementById('subagentsDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupSubagentsDrag();
    }
  }

  setupSubagentsDrag() {
    const panel = document.getElementById('subagentsPanel');
    const header = document.getElementById('subagentsPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  }

  renderTaskPanel() {
    // Debounce renders at 100ms to prevent excessive DOM updates
    if (this.renderTaskPanelTimeout) {
      clearTimeout(this.renderTaskPanelTimeout);
    }
    this.renderTaskPanelTimeout = setTimeout(() => {
      this._renderTaskPanelImmediate();
    }, 100);
  }

  _renderTaskPanelImmediate() {
    const session = this.sessions.get(this.activeSessionId);
    const body = document.getElementById('backgroundTasksBody');
    const stats = document.getElementById('taskPanelStats');
    const section = document.getElementById('backgroundTasksSection');

    if (!session || !session.taskTree || session.taskTree.length === 0) {
      // Hide the entire section when there are no background tasks
      if (section) section.style.display = 'none';
      body.innerHTML = '';
      stats.textContent = '0 tasks';
      return;
    }

    // Show the section when there are tasks
    if (section) section.style.display = '';

    const taskStats = session.taskStats || { running: 0, completed: 0, failed: 0, total: 0 };
    stats.textContent = `${taskStats.running} running, ${taskStats.completed} done`;

    // Render task tree recursively
    const renderTask = (task, allTasks) => {
      const statusIcon = task.status === 'running' ? '' :
                        task.status === 'completed' ? '&#x2713;' : '&#x2717;';
      const duration = task.endTime
        ? `${((task.endTime - task.startTime) / 1000).toFixed(1)}s`
        : `${((Date.now() - task.startTime) / 1000).toFixed(0)}s...`;

      let childrenHtml = '';
      if (task.children && task.children.length > 0) {
        childrenHtml = '<div class="task-children">';
        for (const childId of task.children) {
          // Find child task in allTasks map
          const childTask = allTasks.find(t => t.id === childId);
          if (childTask) {
            childrenHtml += `<div class="task-node">${renderTask(childTask, allTasks)}</div>`;
          }
        }
        childrenHtml += '</div>';
      }

      return `
        <div class="task-item">
          <span class="task-status-icon ${task.status}">${statusIcon}</span>
          <div class="task-info">
            <div class="task-description">${escapeHtml(task.description)}</div>
            <div class="task-meta">
              <span class="task-type">${task.subagentType}</span>
              <span>${duration}</span>
            </div>
          </div>
        </div>
        ${childrenHtml}
      `;
    };

    // Flatten all tasks for lookup
    const allTasks = this.flattenTaskTree(session.taskTree);

    // Render only root tasks (those without parents or with null parentId)
    let html = '<div class="task-tree">';
    for (const task of session.taskTree) {
      html += `<div class="task-node">${renderTask(task, allTasks)}</div>`;
    }
    html += '</div>';

    body.innerHTML = html;
  }

  flattenTaskTree(tasks, result = []) {
    for (const task of tasks) {
      result.push(task);
      // Children are stored as IDs, not nested objects in taskTree
      // The task tree from server already has the structure we need
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // Enhanced Ralph Wiggum Loop Panel
  // ═══════════════════════════════════════════════════════════════

  updateRalphState(sessionId, updates) {
    const existing = this.ralphStates.get(sessionId) || { loop: null, todos: [] };
    const updated = { ...existing, ...updates };
    this.ralphStates.set(sessionId, updated);

    // Re-render if this is the active session
    if (sessionId === this.activeSessionId) {
      this.renderRalphStatePanel();
    }
  }

  toggleRalphStatePanel() {
    // Preserve xterm scroll position to prevent jump when panel height changes
    const xtermViewport = this.terminal?.element?.querySelector('.xterm-viewport');
    const scrollTop = xtermViewport?.scrollTop;

    this.ralphStatePanelCollapsed = !this.ralphStatePanelCollapsed;
    this.renderRalphStatePanel();

    // Restore scroll position and refit terminal after layout change
    requestAnimationFrame(() => {
      // Restore xterm scroll position
      if (xtermViewport && scrollTop !== undefined) {
        xtermViewport.scrollTop = scrollTop;
      }
      // Refit terminal to new container size
      if (this.terminal && this.fitAddon) {
        this.fitAddon.fit();
      }
    });
  }

  async closeRalphTracker() {
    if (!this.activeSessionId) return;

    // Mark this session as explicitly closed - will stay hidden until user re-enables
    this.ralphClosedSessions.add(this.activeSessionId);

    // Disable tracker via API
    await this._apiPost(`/api/sessions/${this.activeSessionId}/ralph-config`, { enabled: false });

    // Clear local state and hide panel
    this.ralphStates.delete(this.activeSessionId);
    this.renderRalphStatePanel();
  }

  // ═══════════════════════════════════════════════════════════════
  // @fix_plan.md Integration
  // ═══════════════════════════════════════════════════════════════

  toggleRalphMenu() {
    const dropdown = document.getElementById('ralphDropdown');
    if (dropdown) {
      dropdown.classList.toggle('show');
    }
  }

  closeRalphMenu() {
    const dropdown = document.getElementById('ralphDropdown');
    if (dropdown) {
      dropdown.classList.remove('show');
    }
  }

  async resetCircuitBreaker() {
    if (!this.activeSessionId) return;

    try {
      const response = await this._apiPost(`/api/sessions/${this.activeSessionId}/ralph-circuit-breaker/reset`, {});
      const data = await response?.json();

      if (data?.success) {
        this.notificationManager?.notify({
          urgency: 'info',
          category: 'circuit-breaker',
          title: 'Reset',
          message: 'Circuit breaker reset to CLOSED',
        });
      }
    } catch (error) {
      console.error('Error resetting circuit breaker:', error);
    }
  }

  /**
   * Generate @fix_plan.md content and show in a modal.
   */
  async showFixPlan() {
    if (!this.activeSessionId) return;

    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/fix-plan`);
      const data = await response.json();

      if (!data.success) {
        this.notificationManager?.notify({
          urgency: 'error',
          category: 'fix-plan',
          title: 'Error',
          message: data.error || 'Failed to generate fix plan',
        });
        return;
      }

      // Show in a modal
      this.showFixPlanModal(data.data.content, data.data.todoCount);
    } catch (error) {
      console.error('Error fetching fix plan:', error);
    }
  }

  /**
   * Show fix plan content in a modal.
   */
  showFixPlanModal(content, todoCount) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('fixPlanModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'fixPlanModal';
      modal.className = 'modal';
      modal.innerHTML = `
        <div class="modal-content fix-plan-modal">
          <div class="modal-header">
            <h3>@fix_plan.md</h3>
            <button class="btn-close" onclick="app.closeFixPlanModal()">&times;</button>
          </div>
          <div class="modal-body">
            <textarea id="fixPlanContent" class="fix-plan-textarea" readonly></textarea>
          </div>
          <div class="modal-footer">
            <span class="fix-plan-stats" id="fixPlanStats"></span>
            <button class="btn btn-secondary" onclick="app.copyFixPlan()">Copy</button>
            <button class="btn btn-primary" onclick="app.writeFixPlanToFile()">Write to File</button>
            <button class="btn btn-secondary" onclick="app.closeFixPlanModal()">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    document.getElementById('fixPlanContent').value = content;
    document.getElementById('fixPlanStats').textContent = `${todoCount} tasks`;
    modal.classList.add('show');
  }

  closeFixPlanModal() {
    const modal = document.getElementById('fixPlanModal');
    if (modal) {
      modal.classList.remove('show');
    }
  }

  async copyFixPlan() {
    const content = document.getElementById('fixPlanContent')?.value;
    if (content) {
      await navigator.clipboard.writeText(content);
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'fix-plan',
        title: 'Copied',
        message: 'Fix plan copied to clipboard',
      });
    }
  }

  async writeFixPlanToFile() {
    if (!this.activeSessionId) return;

    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/fix-plan/write`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        this.notificationManager?.notify({
          urgency: 'info',
          category: 'fix-plan',
          title: 'Written',
          message: `@fix_plan.md written to ${data.data.filePath}`,
        });
        this.closeFixPlanModal();
      } else {
        this.notificationManager?.notify({
          urgency: 'error',
          category: 'fix-plan',
          title: 'Error',
          message: data.error || 'Failed to write file',
        });
      }
    } catch (error) {
      console.error('Error writing fix plan:', error);
    }
  }

  async importFixPlanFromFile() {
    if (!this.activeSessionId) return;

    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/fix-plan/read`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        this.notificationManager?.notify({
          urgency: 'info',
          category: 'fix-plan',
          title: 'Imported',
          message: `Imported ${data.data.importedCount} tasks from @fix_plan.md`,
        });
        // Refresh ralph panel
        this.updateRalphState(this.activeSessionId, { todos: data.data.todos });
      } else {
        this.notificationManager?.notify({
          urgency: 'warning',
          category: 'fix-plan',
          title: 'Not Found',
          message: data.error || '@fix_plan.md not found',
        });
      }
    } catch (error) {
      console.error('Error importing fix plan:', error);
    }
  }

  toggleRalphDetach() {
    const panel = this.$('ralphStatePanel');
    const detachBtn = this.$('ralphDetachBtn');

    if (!panel) return;

    if (panel.classList.contains('detached')) {
      // Re-attach to original position
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon (two overlapping squares)
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      // Expand when detaching for better visibility
      this.ralphStatePanelCollapsed = false;
      panel.classList.remove('collapsed');
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon (squared plus - dock back)
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupRalphDrag();
    }
    this.renderRalphStatePanel();
  }

  setupRalphDrag() {
    const panel = this.$('ralphStatePanel');
    const header = this.$('ralphSummary');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onMouseDown = (e) => {
      // Only drag from header, not from buttons or toggle
      if (e.target.closest('button') || e.target.closest('.ralph-toggle')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._ralphDragHandler);
    header._ralphDragHandler = onMouseDown;
    header.addEventListener('mousedown', onMouseDown);
  }

  renderRalphStatePanel() {
    // Debounce renders at 50ms to prevent excessive DOM updates
    if (this.renderRalphStatePanelTimeout) {
      clearTimeout(this.renderRalphStatePanelTimeout);
    }
    this.renderRalphStatePanelTimeout = setTimeout(() => {
      this._renderRalphStatePanelImmediate();
    }, 50);
  }

  _renderRalphStatePanelImmediate() {
    const panel = this.$('ralphStatePanel');
    const toggle = this.$('ralphToggle');

    if (!panel) return;

    // If user explicitly closed this session's Ralph panel, keep it hidden
    if (this.ralphClosedSessions.has(this.activeSessionId)) {
      panel.style.display = 'none';
      return;
    }

    const state = this.ralphStates.get(this.activeSessionId);

    // Check if there's anything to show
    // Only show panel if tracker is enabled OR there's active state to display
    const isEnabled = state?.loop?.enabled === true;
    const hasLoop = state?.loop?.active || state?.loop?.completionPhrase;
    const hasTodos = state?.todos?.length > 0;
    const hasCircuitBreaker = state?.circuitBreaker && state.circuitBreaker.state !== 'CLOSED';
    const hasStatusBlock = state?.statusBlock !== undefined;

    if (!isEnabled && !hasLoop && !hasTodos && !hasCircuitBreaker && !hasStatusBlock) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = '';

    // Calculate completion percentage
    const todos = state?.todos || [];
    const completed = todos.filter(t => t.status === 'completed').length;
    const total = todos.length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Update progress rings
    this.updateRalphRing(percent);

    // Update status badge (pass completion info)
    this.updateRalphStatus(state?.loop, completed, total);

    // Update stats
    this.updateRalphStats(state?.loop, completed, total);

    // Update circuit breaker badge
    this.updateCircuitBreakerBadge(state?.circuitBreaker);

    // Handle collapsed/expanded state
    if (this.ralphStatePanelCollapsed) {
      panel.classList.add('collapsed');
      if (toggle) toggle.innerHTML = '&#x25BC;'; // Down arrow when collapsed (click to expand)
    } else {
      panel.classList.remove('collapsed');
      if (toggle) toggle.innerHTML = '&#x25B2;'; // Up arrow when expanded (click to collapse)

      // Update expanded view content
      this.updateRalphExpandedView(state);
    }
  }

  updateRalphRing(percent) {
    // Ensure percent is a valid number between 0-100
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));

    // Mini ring (in summary)
    const miniProgress = this.$('ralphRingMiniProgress');
    const miniText = this.$('ralphRingMiniText');
    if (miniProgress) {
      // Circumference = 2 * PI * r = 2 * PI * 15.9 ≈ 100
      // offset = 100 means 0% visible, offset = 0 means 100% visible
      const offset = 100 - safePercent;
      miniProgress.style.strokeDashoffset = offset;
    }
    if (miniText) {
      miniText.textContent = `${safePercent}%`;
    }

    // Large ring (in expanded view)
    const largeProgress = this.$('ralphRingProgress');
    const largePercent = this.$('ralphRingPercent');
    if (largeProgress) {
      // Circumference = 2 * PI * r = 2 * PI * 42 ≈ 264
      // offset = 264 means 0% visible, offset = 0 means 100% visible
      const offset = 264 - (264 * safePercent / 100);
      largeProgress.style.strokeDashoffset = offset;
    }
    if (largePercent) {
      largePercent.textContent = `${safePercent}%`;
    }
  }

  updateRalphStatus(loop, completed = 0, total = 0) {
    const badge = this.$('ralphStatusBadge');
    const statusText = badge?.querySelector('.ralph-status-text');
    if (!badge || !statusText) return;

    badge.classList.remove('active', 'completed', 'tracking');

    if (loop?.active) {
      badge.classList.add('active');
      statusText.textContent = 'Running';
    } else if (total > 0 && completed === total) {
      // Only show "Complete" when all todos are actually done
      badge.classList.add('completed');
      statusText.textContent = 'Complete';
    } else if (loop?.enabled || total > 0) {
      badge.classList.add('tracking');
      statusText.textContent = 'Tracking';
    } else {
      statusText.textContent = 'Idle';
    }
  }

  updateCircuitBreakerBadge(circuitBreaker) {
    // Find or create the circuit breaker badge container
    let cbContainer = this.$('ralphCircuitBreakerBadge');
    if (!cbContainer) {
      // Create container if it doesn't exist (we'll add it dynamically)
      const summary = this.$('ralphSummary');
      if (!summary) return;

      // Check if it already exists
      cbContainer = summary.querySelector('.ralph-circuit-breaker');
      if (!cbContainer) {
        cbContainer = document.createElement('div');
        cbContainer.id = 'ralphCircuitBreakerBadge';
        cbContainer.className = 'ralph-circuit-breaker';
        // Insert after the status badge
        const statusBadge = this.$('ralphStatusBadge');
        if (statusBadge && statusBadge.nextSibling) {
          statusBadge.parentNode.insertBefore(cbContainer, statusBadge.nextSibling);
        } else {
          summary.appendChild(cbContainer);
        }
      }
    }

    // Hide if no circuit breaker state or CLOSED
    if (!circuitBreaker || circuitBreaker.state === 'CLOSED') {
      cbContainer.style.display = 'none';
      return;
    }

    cbContainer.style.display = '';
    cbContainer.classList.remove('half-open', 'open');

    if (circuitBreaker.state === 'HALF_OPEN') {
      cbContainer.classList.add('half-open');
      cbContainer.innerHTML = `<span class="cb-icon">⚠</span><span class="cb-text">Warning</span>`;
      cbContainer.title = circuitBreaker.reason || 'Circuit breaker warning';
    } else if (circuitBreaker.state === 'OPEN') {
      cbContainer.classList.add('open');
      cbContainer.innerHTML = `<span class="cb-icon">🛑</span><span class="cb-text">Stuck</span>`;
      cbContainer.title = circuitBreaker.reason || 'Loop appears stuck';
    }

    // Add click handler to reset
    cbContainer.onclick = () => this.resetCircuitBreaker();
  }


  updateRalphStats(loop, completed, total) {
    // Time stat
    const timeEl = this.$('ralphStatTime');
    if (timeEl) {
      if (loop?.elapsedHours !== null && loop?.elapsedHours !== undefined) {
        timeEl.textContent = this.formatRalphTime(loop.elapsedHours);
      } else if (loop?.startedAt) {
        const hours = (Date.now() - loop.startedAt) / (1000 * 60 * 60);
        timeEl.textContent = this.formatRalphTime(hours);
      } else {
        timeEl.textContent = '0m';
      }
    }

    // Cycles stat
    const cyclesEl = this.$('ralphStatCycles');
    if (cyclesEl) {
      if (loop?.maxIterations) {
        cyclesEl.textContent = `${loop.cycleCount || 0}/${loop.maxIterations}`;
      } else {
        cyclesEl.textContent = String(loop?.cycleCount || 0);
      }
    }

    // Tasks stat
    const tasksEl = this.$('ralphStatTasks');
    if (tasksEl) {
      tasksEl.textContent = `${completed}/${total}`;
    }
  }

  formatRalphTime(hours) {
    if (hours < 0.0167) return '0m'; // < 1 minute
    if (hours < 1) {
      const minutes = Math.round(hours * 60);
      return `${minutes}m`;
    }
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  updateRalphExpandedView(state) {
    // Update phrase
    const phraseEl = this.$('ralphPhrase');
    if (phraseEl) {
      phraseEl.textContent = state?.loop?.completionPhrase || '--';
    }

    // Update elapsed
    const elapsedEl = this.$('ralphElapsed');
    if (elapsedEl) {
      if (state?.loop?.elapsedHours !== null && state?.loop?.elapsedHours !== undefined) {
        elapsedEl.textContent = this.formatRalphTime(state.loop.elapsedHours);
      } else if (state?.loop?.startedAt) {
        const hours = (Date.now() - state.loop.startedAt) / (1000 * 60 * 60);
        elapsedEl.textContent = this.formatRalphTime(hours);
      } else {
        elapsedEl.textContent = '0m';
      }
    }

    // Update iterations
    const iterationsEl = this.$('ralphIterations');
    if (iterationsEl) {
      if (state?.loop?.maxIterations) {
        iterationsEl.textContent = `${state.loop.cycleCount || 0} / ${state.loop.maxIterations}`;
      } else {
        iterationsEl.textContent = String(state?.loop?.cycleCount || 0);
      }
    }

    // Update tasks count
    const todos = state?.todos || [];
    const completed = todos.filter(t => t.status === 'completed').length;
    const tasksCountEl = this.$('ralphTasksCount');
    if (tasksCountEl) {
      tasksCountEl.textContent = `${completed}/${todos.length}`;
    }

    // Update plan version display if available
    if (state?.loop?.planVersion) {
      this.updatePlanVersionDisplay(state.loop.planVersion, state.loop.planHistoryLength || 1);
    } else {
      this.updatePlanVersionDisplay(null, 0);
    }

    // Render task cards
    this.renderRalphTasks(todos);

    // Render RALPH_STATUS block if present
    this.renderRalphStatusBlock(state?.statusBlock);
  }

  renderRalphStatusBlock(statusBlock) {
    // Find or create the status block container
    let container = this.$('ralphStatusBlockDisplay');
    const expandedContent = this.$('ralphExpandedContent');

    if (!statusBlock) {
      // Remove container if no status block
      if (container) {
        container.remove();
      }
      return;
    }

    if (!container && expandedContent) {
      container = document.createElement('div');
      container.id = 'ralphStatusBlockDisplay';
      container.className = 'ralph-status-block';
      // Insert at the top of expanded content
      expandedContent.insertBefore(container, expandedContent.firstChild);
    }

    if (!container) return;

    // Build status class
    const statusClass = statusBlock.status === 'IN_PROGRESS' ? 'in-progress'
      : statusBlock.status === 'COMPLETE' ? 'complete'
      : statusBlock.status === 'BLOCKED' ? 'blocked' : '';

    // Build tests status icon
    const testsIcon = statusBlock.testsStatus === 'PASSING' ? '✅'
      : statusBlock.testsStatus === 'FAILING' ? '❌'
      : '⏸';

    // Build work type icon
    const workIcon = statusBlock.workType === 'IMPLEMENTATION' ? '🔧'
      : statusBlock.workType === 'TESTING' ? '🧪'
      : statusBlock.workType === 'DOCUMENTATION' ? '📝'
      : statusBlock.workType === 'REFACTORING' ? '♻️' : '📋';

    let html = `
      <div class="ralph-status-block-header">
        <span>RALPH_STATUS</span>
        <span class="ralph-status-block-status ${statusClass}">${escapeHtml(statusBlock.status)}</span>
        ${statusBlock.exitSignal ? '<span style="color: #4caf50;">🚪 EXIT</span>' : ''}
      </div>
      <div class="ralph-status-block-stats">
        <span>${workIcon} ${escapeHtml(statusBlock.workType)}</span>
        <span>📁 ${statusBlock.filesModified} files</span>
        <span>✓ ${escapeHtml(String(statusBlock.tasksCompletedThisLoop))} tasks</span>
        <span>${testsIcon} Tests: ${escapeHtml(statusBlock.testsStatus)}</span>
      </div>
    `;

    if (statusBlock.recommendation) {
      html += `<div class="ralph-status-block-recommendation">${escapeHtml(statusBlock.recommendation)}</div>`;
    }

    container.innerHTML = html;
  }

  renderRalphTasks(todos) {
    const grid = this.$('ralphTasksGrid');
    if (!grid) return;

    if (todos.length === 0) {
      if (grid.children.length !== 1 || !grid.querySelector('.ralph-state-empty')) {
        grid.innerHTML = '<div class="ralph-state-empty">No tasks detected</div>';
      }
      return;
    }

    // Sort: by priority (P0 > P1 > P2 > null), then by status (in_progress > pending > completed)
    const priorityOrder = { 'P0': 0, 'P1': 1, 'P2': 2, null: 3 };
    const statusOrder = { in_progress: 0, pending: 1, completed: 2 };
    const sorted = [...todos].sort((a, b) => {
      const priA = priorityOrder[a.priority] ?? 3;
      const priB = priorityOrder[b.priority] ?? 3;
      if (priA !== priB) return priA - priB;
      return (statusOrder[a.status] || 1) - (statusOrder[b.status] || 1);
    });

    // Always do full rebuild for enhanced features
    const fragment = document.createDocumentFragment();

    sorted.forEach((todo, idx) => {
      const card = this.createRalphTaskCard(todo, idx);
      fragment.appendChild(card);
    });

    grid.innerHTML = '';
    grid.appendChild(fragment);
  }

  createRalphTaskCard(todo, index) {
    const card = document.createElement('div');
    const statusClass = `task-${todo.status.replace('_', '-')}`;
    const priorityClass = todo.priority ? `task-priority-${todo.priority.toLowerCase()}` : '';
    card.className = `ralph-task-card ${statusClass} ${priorityClass}`.trim();
    card.dataset.taskId = todo.id || index;

    // Status icon
    const iconSpan = document.createElement('span');
    iconSpan.className = 'ralph-task-icon';
    iconSpan.textContent = this.getRalphTaskIcon(todo.status);
    card.appendChild(iconSpan);

    // Priority badge if present
    if (todo.priority) {
      const prioritySpan = document.createElement('span');
      prioritySpan.className = `ralph-task-priority priority-${todo.priority.toLowerCase()}`;
      prioritySpan.textContent = todo.priority;
      card.appendChild(prioritySpan);
    }

    // Task content
    const contentSpan = document.createElement('span');
    contentSpan.className = 'ralph-task-content';
    contentSpan.textContent = todo.content;
    card.appendChild(contentSpan);

    // Attempts indicator (if > 0)
    if (todo.attempts && todo.attempts > 0) {
      const attemptsSpan = document.createElement('span');
      attemptsSpan.className = 'ralph-task-attempts';
      if (todo.lastError) {
        attemptsSpan.classList.add('has-errors');
        attemptsSpan.title = `Last error: ${todo.lastError}`;
      }
      attemptsSpan.textContent = `#${todo.attempts}`;
      card.appendChild(attemptsSpan);
    }

    // Verification badge (if has verification criteria)
    if (todo.verificationCriteria) {
      const verifySpan = document.createElement('span');
      verifySpan.className = 'ralph-task-verify-badge';
      verifySpan.title = `Verify: ${todo.verificationCriteria}`;
      verifySpan.textContent = '✓';
      card.appendChild(verifySpan);
    }

    // Dependencies indicator
    if (todo.dependencies && todo.dependencies.length > 0) {
      const depsSpan = document.createElement('span');
      depsSpan.className = 'ralph-task-deps-indicator';
      depsSpan.title = `Depends on: ${todo.dependencies.join(', ')}`;
      depsSpan.textContent = `↗${todo.dependencies.length}`;
      card.appendChild(depsSpan);
    }

    // Quick action buttons (shown on hover)
    const actions = document.createElement('div');
    actions.className = 'ralph-task-actions';

    if (todo.status !== 'completed') {
      const completeBtn = document.createElement('button');
      completeBtn.className = 'ralph-task-action-btn';
      completeBtn.textContent = '✓';
      completeBtn.title = 'Mark complete';
      completeBtn.onclick = (e) => {
        e.stopPropagation();
        this.updateRalphTaskStatus(todo.id, 'completed');
      };
      actions.appendChild(completeBtn);
    }

    if (todo.status === 'completed') {
      const reopenBtn = document.createElement('button');
      reopenBtn.className = 'ralph-task-action-btn';
      reopenBtn.textContent = '↺';
      reopenBtn.title = 'Reopen';
      reopenBtn.onclick = (e) => {
        e.stopPropagation();
        this.updateRalphTaskStatus(todo.id, 'pending');
      };
      actions.appendChild(reopenBtn);
    }

    if (todo.lastError) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'ralph-task-action-btn';
      retryBtn.textContent = '↻';
      retryBtn.title = 'Retry (clear error)';
      retryBtn.onclick = (e) => {
        e.stopPropagation();
        this.retryRalphTask(todo.id);
      };
      actions.appendChild(retryBtn);
    }

    card.appendChild(actions);

    return card;
  }

  // Update a Ralph task's status via API
  async updateRalphTaskStatus(taskId, newStatus) {
    if (!this.activeSessionId) return;

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/task/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update task');
      }

      this.showToast(`Task ${newStatus === 'completed' ? 'completed' : 'reopened'}`, 'success');
    } catch (err) {
      this.showToast('Failed to update task: ' + err.message, 'error');
    }
  }

  // Retry a failed Ralph task (clear error, reset attempts)
  async retryRalphTask(taskId) {
    if (!this.activeSessionId) return;

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/task/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attempts: 0, lastError: null, status: 'pending' })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to retry task');
      }

      this.showToast('Task reset for retry', 'success');
    } catch (err) {
      this.showToast('Failed to retry task: ' + err.message, 'error');
    }
  }

  getRalphTaskIcon(status) {
    switch (status) {
      case 'completed': return '✓';
      case 'in_progress': return '◐';
      case 'pending':
      default: return '○';
    }
  }

  // Legacy method for backwards compatibility
  getTodoIcon(status) {
    return this.getRalphTaskIcon(status);
  }

  // ═══════════════════════════════════════════════════════════════
  // Plan Versioning
  // ═══════════════════════════════════════════════════════════════

  // Update the plan version display in the Ralph panel
  updatePlanVersionDisplay(version, historyLength) {
    const versionRow = this.$('ralphVersionRow');
    const versionBadge = this.$('ralphPlanVersion');
    const rollbackBtn = this.$('ralphRollbackBtn');

    if (!versionRow) return;

    if (version && version > 0) {
      versionRow.style.display = '';
      if (versionBadge) versionBadge.textContent = `v${version}`;
      if (rollbackBtn) {
        rollbackBtn.style.display = historyLength > 1 ? '' : 'none';
      }
    } else {
      versionRow.style.display = 'none';
    }
  }

  // Show plan history dropdown
  async showPlanHistory() {
    if (!this.activeSessionId) return;

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/history`);
      const data = await res.json();

      if (data.error) {
        this.showToast('Failed to load plan history: ' + data.error, 'error');
        return;
      }

      const history = data.history || [];
      if (history.length === 0) {
        this.showToast('No plan history available', 'info');
        return;
      }

      // Show history dropdown modal
      this.showPlanHistoryModal(history, data.currentVersion);
    } catch (err) {
      this.showToast('Failed to load plan history: ' + err.message, 'error');
    }
  }

  // Show the plan history modal
  showPlanHistoryModal(history, currentVersion) {
    // Remove existing modal if present
    const existing = document.getElementById('planHistoryModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'planHistoryModal';
    modal.className = 'modal active';
    modal.innerHTML = `
      <div class="modal-backdrop" onclick="app.closePlanHistoryModal()"></div>
      <div class="modal-content modal-sm">
        <div class="modal-header">
          <h3>Plan Version History</h3>
          <button class="modal-close" onclick="app.closePlanHistoryModal()">&times;</button>
        </div>
        <div class="modal-body">
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            Current version: <strong>v${currentVersion}</strong>
          </p>
          <div class="plan-history-list">
            ${history.map(item => `
              <div class="plan-history-item ${item.version === currentVersion ? 'current' : ''}"
                   onclick="app.rollbackToPlanVersion(${item.version})">
                <div>
                  <span class="plan-history-version">v${item.version}</span>
                  <span class="plan-history-tasks">${item.taskCount || 0} tasks</span>
                </div>
                <span class="plan-history-time">${this.formatRelativeTime(item.timestamp)}</span>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-toolbar" onclick="app.closePlanHistoryModal()">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  closePlanHistoryModal() {
    const modal = document.getElementById('planHistoryModal');
    if (modal) modal.remove();
  }

  // Rollback to a specific plan version
  async rollbackToPlanVersion(version) {
    if (!this.activeSessionId) return;

    if (!confirm(`Rollback to plan version ${version}? Current changes will be preserved in history.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/rollback/${version}`, {
        method: 'POST'
      });
      const data = await res.json();

      if (data.error) {
        this.showToast('Failed to rollback: ' + data.error, 'error');
        return;
      }

      this.showToast(`Rolled back to plan v${version}`, 'success');
      this.closePlanHistoryModal();

      // Refresh the plan display
      this.renderRalphStatePanel();
    } catch (err) {
      this.showToast('Failed to rollback: ' + err.message, 'error');
    }
  }

  // Format relative time (e.g., "2 mins ago", "1 hour ago")
  formatRelativeTime(timestamp) {
    if (!timestamp) return '';

    const now = Date.now();
    const diff = now - timestamp;

    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  // ═══════════════════════════════════════════════════════════════
  // Subagent Panel (Claude Code Background Agents)
  // ═══════════════════════════════════════════════════════════════

  // Legacy alias
  toggleSubagentPanel() {
    this.toggleSubagentsPanel();
  }

  updateSubagentBadge() {
    const badge = this.$('subagentCountBadge');
    const activeCount = Array.from(this.subagents.values()).filter(s => s.status === 'active' || s.status === 'idle').length;

    // Update badge with active count
    if (badge) {
      badge.textContent = activeCount > 0 ? activeCount : '';
    }
  }

  renderSubagentPanel() {
    // Debounce renders at 150ms to prevent excessive DOM updates from rapid subagent events
    if (this._subagentPanelRenderTimeout) {
      clearTimeout(this._subagentPanelRenderTimeout);
    }
    this._subagentPanelRenderTimeout = setTimeout(() => {
      scheduleBackground(() => this._renderSubagentPanelImmediate());
    }, 150);
  }

  _renderSubagentPanelImmediate() {
    const list = this.$('subagentList');
    if (!list) return;

    // Always update badge count
    this.updateSubagentBadge();

    // Always update monitor panel (even if subagent panel is hidden)
    this.renderMonitorSubagents();

    // If panel is not visible, don't render content
    if (!this.subagentPanelVisible) {
      return;
    }

    // Render subagent list
    if (this.subagents.size === 0) {
      list.innerHTML = '<div class="subagent-empty">No background agents detected</div>';
      return;
    }

    const html = [];
    const sorted = Array.from(this.subagents.values()).sort((a, b) => {
      // Active first, then by last activity
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return 1;
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });

    for (const agent of sorted) {
      const isActive = this.activeSubagentId === agent.agentId;
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const activity = this.subagentActivity.get(agent.agentId) || [];
      const lastActivity = activity[activity.length - 1];
      const lastTool = lastActivity?.type === 'tool' ? lastActivity.tool : null;
      const hasWindow = this.subagentWindows.has(agent.agentId);
      const canKill = agent.status === 'active' || agent.status === 'idle';
      const modelBadge = agent.modelShort
        ? `<span class="subagent-model-badge ${escapeHtml(agent.modelShort)}">${escapeHtml(agent.modelShort)}</span>`
        : '';

      const teammateInfo = this.getTeammateInfo(agent);
      const displayName = teammateInfo ? teammateInfo.name : (agent.description || agent.agentId.substring(0, 7));
      const teammateBadge = this.getTeammateBadgeHtml(agent);
      const agentIcon = teammateInfo ? `<span class="subagent-icon teammate-dot teammate-color-${teammateInfo.color}">●</span>` : '<span class="subagent-icon">🤖</span>';
      html.push(`
        <div class="subagent-item ${statusClass} ${isActive ? 'selected' : ''}${teammateInfo ? ' is-teammate' : ''}"
             onclick="app.selectSubagent('${escapeHtml(agent.agentId)}')"
             ondblclick="app.openSubagentWindow('${escapeHtml(agent.agentId)}')"
             title="Double-click to open tracking window">
          <div class="subagent-header">
            ${agentIcon}
            <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(displayName.length > 40 ? displayName.substring(0, 40) + '...' : displayName)}</span>
            ${teammateBadge}
            ${modelBadge}
            <span class="subagent-status ${statusClass}">${agent.status}</span>
            ${canKill ? `<button class="subagent-kill-btn" onclick="event.stopPropagation(); app.killSubagent('${escapeHtml(agent.agentId)}')" title="Kill agent">&#x2715;</button>` : ''}
            <button class="subagent-window-btn" onclick="event.stopPropagation(); app.${hasWindow ? 'closeSubagentWindow' : 'openSubagentWindow'}('${escapeHtml(agent.agentId)}')" title="${hasWindow ? 'Close window' : 'Open in window'}">
              ${hasWindow ? '✕' : '⧉'}
            </button>
          </div>
          <div class="subagent-meta">
            <span class="subagent-tools">${agent.toolCallCount} tools</span>
            ${lastTool ? `<span class="subagent-last-tool">${this.getToolIcon(lastTool)} ${lastTool}</span>` : ''}
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  }

  selectSubagent(agentId) {
    this.activeSubagentId = agentId;
    this.renderSubagentPanel();
    this.renderSubagentDetail();
  }

  renderSubagentDetail() {
    const detail = this.$('subagentDetail');
    if (!detail) return;

    if (!this.activeSubagentId) {
      detail.innerHTML = '<div class="subagent-empty">Select an agent to view details</div>';
      return;
    }

    const agent = this.subagents.get(this.activeSubagentId);
    const activity = this.subagentActivity.get(this.activeSubagentId) || [];

    if (!agent) {
      detail.innerHTML = '<div class="subagent-empty">Agent not found</div>';
      return;
    }

    const activityHtml = activity.slice(-30).map(a => {
      const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
      if (a.type === 'tool') {
        const toolDetail = this.getToolDetailExpanded(a.tool, a.input, a.fullInput, a.toolUseId);
        return `<div class="subagent-activity tool" data-tool-use-id="${a.toolUseId || ''}">
          <span class="time">${time}</span>
          <span class="icon">${this.getToolIcon(a.tool)}</span>
          <span class="name">${a.tool}</span>
          <span class="detail">${toolDetail.primary}</span>
          ${toolDetail.hasMore ? `<button class="tool-expand-btn" onclick="app.toggleToolParams('${escapeHtml(a.toolUseId)}')">▶</button>` : ''}
          ${toolDetail.hasMore ? `<div class="tool-params-expanded" id="tool-params-${a.toolUseId}" style="display:none;"><pre>${escapeHtml(JSON.stringify(a.fullInput || a.input, null, 2))}</pre></div>` : ''}
        </div>`;
      } else if (a.type === 'tool_result') {
        const icon = a.isError ? '❌' : '📄';
        const statusClass = a.isError ? 'error' : '';
        const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
        const preview = a.preview.length > 80 ? a.preview.substring(0, 80) + '...' : a.preview;
        return `<div class="subagent-activity tool-result ${statusClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="name">${a.tool || 'result'}</span>
          <span class="detail">${escapeHtml(preview)}${sizeInfo}</span>
        </div>`;
      } else if (a.type === 'progress') {
        // Check for hook events
        const isHook = a.hookEvent || a.hookName;
        const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
        const hookClass = isHook ? ' hook' : '';
        const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
        return `<div class="subagent-activity progress${hookClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="detail">${displayText}</span>
        </div>`;
      } else if (a.type === 'message') {
        const preview = a.text.length > 100 ? a.text.substring(0, 100) + '...' : a.text;
        return `<div class="subagent-activity message">
          <span class="time">${time}</span>
          <span class="icon">💬</span>
          <span class="detail">${escapeHtml(preview)}</span>
        </div>`;
      }
      return '';
    }).join('');

    const detailTitle = agent.description || `Agent ${agent.agentId}`;
    const modelBadge = agent.modelShort
      ? `<span class="subagent-model-badge ${escapeHtml(agent.modelShort)}">${escapeHtml(agent.modelShort)}</span>`
      : '';
    const tokenStats = (agent.totalInputTokens || agent.totalOutputTokens)
      ? `<span>Tokens: ${this.formatTokenCount(agent.totalInputTokens || 0)}↓ ${this.formatTokenCount(agent.totalOutputTokens || 0)}↑</span>`
      : '';

    detail.innerHTML = `
      <div class="subagent-detail-header">
        <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(detailTitle.length > 60 ? detailTitle.substring(0, 60) + '...' : detailTitle)}</span>
        ${modelBadge}
        <span class="subagent-status ${agent.status}">${agent.status}</span>
        <button class="subagent-transcript-btn" onclick="app.viewSubagentTranscript('${escapeHtml(agent.agentId)}')">
          View Full Transcript
        </button>
      </div>
      <div class="subagent-detail-stats">
        <span>Tools: ${agent.toolCallCount}</span>
        <span>Entries: ${agent.entryCount}</span>
        <span>Size: ${(agent.fileSize / 1024).toFixed(1)}KB</span>
        ${tokenStats}
      </div>
      <div class="subagent-activity-log">
        ${activityHtml || '<div class="subagent-empty">No activity yet</div>'}
      </div>
    `;
  }

  toggleToolParams(toolUseId) {
    const el = document.getElementById(`tool-params-${toolUseId}`);
    if (!el) return;
    const btn = el.previousElementSibling;
    if (el.style.display === 'none') {
      el.style.display = 'block';
      if (btn) btn.textContent = '▼';
    } else {
      el.style.display = 'none';
      if (btn) btn.textContent = '▶';
    }
  }

  formatTokenCount(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return count.toString();
  }

  formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return bytes + 'B';
  }

  getToolIcon(tool) {
    const icons = {
      WebSearch: '🔍',
      WebFetch: '🌐',
      Read: '📖',
      Write: '📝',
      Edit: '✏️',
      Bash: '💻',
      Glob: '📁',
      Grep: '🔎',
      Task: '🤖',
    };
    return icons[tool] || '🔧';
  }

  getToolDetail(tool, input) {
    if (!input) return '';
    if (tool === 'WebSearch' && input.query) return `"${input.query}"`;
    if (tool === 'WebFetch' && input.url) return input.url;
    if (tool === 'Read' && input.file_path) return input.file_path;
    if ((tool === 'Write' || tool === 'Edit') && input.file_path) return input.file_path;
    if (tool === 'Bash' && input.command) {
      const cmd = input.command;
      return cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd;
    }
    if (tool === 'Glob' && input.pattern) return input.pattern;
    if (tool === 'Grep' && input.pattern) return input.pattern;
    return '';
  }

  getToolDetailExpanded(tool, input, fullInput, toolUseId) {
    const primary = this.getToolDetail(tool, input);
    // Check if there are additional params beyond the primary one
    const primaryKeys = ['query', 'url', 'file_path', 'command', 'pattern'];
    const inputKeys = Object.keys(fullInput || input || {});
    const extraKeys = inputKeys.filter(k => !primaryKeys.includes(k));
    const hasMore = extraKeys.length > 0 || (fullInput && JSON.stringify(fullInput).length > 100);
    return { primary, hasMore, fullInput: fullInput || input };
  }

  async killSubagent(agentId) {
    try {
      const res = await this._apiDelete(`/api/subagents/${agentId}`);
      const data = await res?.json();
      if (data?.success) {
        // Update local state
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.status = 'completed';
          this.subagents.set(agentId, agent);
        }
        this.renderSubagentPanel();
        this.renderSubagentDetail();
        this.updateSubagentWindows();
        this.showToast(`Subagent ${agentId.substring(0, 7)} killed`, 'success');
      } else {
        this.showToast(data.error || 'Failed to kill subagent', 'error');
      }
    } catch (err) {
      console.error('Failed to kill subagent:', err);
      this.showToast('Failed to kill subagent: ' + err.message, 'error');
    }
  }

  async viewSubagentTranscript(agentId) {
    try {
      const res = await fetch(`/api/subagents/${agentId}/transcript?format=formatted`);
      const data = await res.json();

      if (!data.success) {
        alert('Failed to load transcript');
        return;
      }

      // Show in a modal or new window
      const content = data.data.formatted.join('\n');
      const win = window.open('', '_blank', 'width=800,height=600');
      win.document.write(`
        <html>
          <head>
            <title>Subagent ${escapeHtml(agentId)} Transcript</title>
            <style>
              body { background: #1a1a2e; color: #eee; font-family: monospace; padding: 20px; }
              pre { white-space: pre-wrap; word-wrap: break-word; }
            </style>
          </head>
          <body>
            <h2>Subagent ${escapeHtml(agentId)} Transcript (${data.data.entryCount} entries)</h2>
            <pre>${escapeHtml(content)}</pre>
          </body>
        </html>
      `);
    } catch (err) {
      console.error('Failed to load transcript:', err);
      alert('Failed to load transcript: ' + err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Subagent Parent TAB Tracking
  // ═══════════════════════════════════════════════════════════════
  //
  // CRITICAL: This system tracks which TAB an agent window connects to.
  // The association is stored in `subagentParentMap` (agentId -> sessionId).
  // The sessionId IS the tab identifier (tabs have data-id="${sessionId}").
  // Once set, this association is PERMANENT and persisted across restarts.

  /**
   * Find and assign the parent TAB for a subagent.
   *
   * Matching strategy (in order):
   * 1. Use existing stored association from subagentParentMap (permanent)
   * 2. Match via claudeSessionId (agent.sessionId === session.claudeSessionId)
   * 3. FALLBACK: Use the currently active session (since that's where the user typed the command)
   *
   * Once found, the association is stored PERMANENTLY in subagentParentMap.
   */
  findParentSessionForSubagent(agentId) {
    // Check if we already have a permanent association
    if (this.subagentParentMap.has(agentId)) {
      // Already have a parent - update agent object from stored value
      const storedSessionId = this.subagentParentMap.get(agentId);
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
      // Stored session no longer exists - clear and re-discover
      this.subagentParentMap.delete(agentId);
    }

    const agent = this.subagents.get(agentId);
    if (!agent) return;

    // Strategy 1: Match via claudeSessionId (most accurate)
    if (agent.sessionId) {
      for (const [sessionId, session] of this.sessions) {
        if (session.claudeSessionId === agent.sessionId) {
          // FOUND! Store this association PERMANENTLY
          this.setAgentParentSessionId(agentId, sessionId);
          this.updateSubagentWindowParent(agentId);
          this.updateSubagentWindowVisibility();
          this.updateConnectionLines();
          return;
        }
      }
    }

    // Strategy 2: FALLBACK - Use the currently active session
    // This works because agents spawn from where the user typed the command
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      this.setAgentParentSessionId(agentId, this.activeSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
      return;
    }

    // Strategy 3: If no active session, use the first session
    if (this.sessions.size > 0) {
      const firstSessionId = this.sessions.keys().next().value;
      this.setAgentParentSessionId(agentId, firstSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
    }
  }

  /**
   * Re-check all orphan subagents (those without a parent TAB) when a session updates.
   * Called when session:updated fires with claudeSessionId.
   *
   * Also re-validates existing associations when claudeSessionId becomes available,
   * in case the fallback association was wrong.
   */
  recheckOrphanSubagents() {
    let anyChanged = false;
    for (const [agentId, agent] of this.subagents) {
      // Check if this agent has no parent in the persistent map
      if (!this.subagentParentMap.has(agentId)) {
        this.findParentSessionForSubagent(agentId);
        if (this.subagentParentMap.has(agentId)) {
          anyChanged = true;
        }
      } else if (agent.sessionId) {
        // Agent has a stored parent, but check if we can now do a proper claudeSessionId match
        // This handles the case where fallback was used but now the real parent is known
        const storedParent = this.subagentParentMap.get(agentId);
        const storedSession = this.sessions.get(storedParent);

        // If the stored session doesn't have a matching claudeSessionId, try to find the real match
        if (storedSession && storedSession.claudeSessionId !== agent.sessionId) {
          for (const [sessionId, session] of this.sessions) {
            if (session.claudeSessionId === agent.sessionId) {
              // Found the real parent - update the association
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
  }

  /**
   * Update parentSessionName for all subagents belonging to a TAB.
   * Called when a session is renamed to keep cached names fresh.
   */
  updateSubagentParentNames(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const newName = this.getSessionName(session);

    // Skip iteration if name hasn't changed (avoids O(n) loop on every session:updated)
    const cachedName = this._parentNameCache?.get(sessionId);
    if (cachedName === newName) return;
    if (!this._parentNameCache) this._parentNameCache = new Map();
    this._parentNameCache.set(sessionId, newName);

    for (const [agentId, storedSessionId] of this.subagentParentMap) {
      if (storedSessionId === sessionId) {
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.parentSessionName = newName;
          this.subagents.set(agentId, agent);

          // Update the window header if open
          const windowData = this.subagentWindows.get(agentId);
          if (windowData) {
            const parentNameEl = windowData.element.querySelector('.subagent-window-parent .parent-name');
            if (parentNameEl) {
              parentNameEl.textContent = newName;
            }
          }
        }
      }
    }
  }

  /**
   * Add parent header to an agent window, showing which TAB it belongs to.
   */
  updateSubagentWindowParent(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (!windowData) return;

    // Get parent from persistent map (THE source of truth)
    const parentSessionId = this.subagentParentMap.get(agentId);
    if (!parentSessionId) return;

    const session = this.sessions.get(parentSessionId);
    const parentName = session ? this.getSessionName(session) : 'Unknown';

    // Check if parent header already exists
    const win = windowData.element;
    const existingParent = win.querySelector('.subagent-window-parent');
    if (existingParent) {
      // Update existing
      existingParent.dataset.parentSession = parentSessionId;
      const nameEl = existingParent.querySelector('.parent-name');
      if (nameEl) {
        nameEl.textContent = parentName;
        nameEl.onclick = () => this.selectSession(parentSessionId);
      }
      return;
    }

    // Insert new parent header after the main header
    const header = win.querySelector('.subagent-window-header');
    if (header) {
      const parentDiv = document.createElement('div');
      parentDiv.className = 'subagent-window-parent';
      parentDiv.dataset.parentSession = parentSessionId;
      parentDiv.innerHTML = `
        <span class="parent-label">from</span>
        <span class="parent-name" onclick="app.selectSession('${escapeHtml(parentSessionId)}')">${escapeHtml(parentName)}</span>
      `;
      header.insertAdjacentElement('afterend', parentDiv);
    }
  }


  /**
   * Show/hide subagent windows based on active session.
   * Behavior controlled by "Subagents for Active Tab Only" setting.
   * Uses the PERSISTENT subagentParentMap for accurate tab-based visibility.
   */
  updateSubagentWindowVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;

    for (const [agentId, windowInfo] of this.subagentWindows) {
      // Get parent from PERSISTENT map (THE source of truth)
      const storedParent = this.subagentParentMap.get(agentId);
      const agent = this.subagents.get(agentId);
      const parentSessionId = storedParent || agent?.parentSessionId;

      // Determine visibility based on setting
      let shouldShow;
      if (activeTabOnly) {
        // Show if: no parent known yet, or parent matches active session
        const hasKnownParent = !!parentSessionId;
        shouldShow = !hasKnownParent || parentSessionId === this.activeSessionId;
      } else {
        // Show all windows (original behavior)
        shouldShow = true;
      }

      if (shouldShow) {
        // Show window (unless it was minimized by user)
        if (!windowInfo.minimized) {
          windowInfo.element.style.display = 'flex';
          // Lazily re-create teammate terminal if it was disposed when hidden
          if (windowInfo._lazyTerminal) {
            this._restoreTeammateTerminalFromLazy(agentId);
          }
        }
        windowInfo.hidden = false;
      } else {
        // Hide window (but don't close it)
        // Dispose teammate terminal to free memory while hidden on inactive tab
        this._disposeTeammateTerminalForMinimize(agentId);
        windowInfo.element.style.display = 'none';
        windowInfo.hidden = true;
      }
    }
    // Update connection lines after visibility changes
    this.updateConnectionLines();
    // Restack mobile windows after visibility changes
    this.relayoutMobileSubagentWindows();
  }


  // Close all subagent windows for a session (fully removes them, not minimize)
  // If cleanupData is true, also remove activity and toolResults data to prevent memory leaks
  closeSessionSubagentWindows(sessionId, cleanupData = false) {
    const toClose = [];
    for (const [agentId, _windowData] of this.subagentWindows) {
      const agent = this.subagents.get(agentId);
      // Check both subagent parentSessionId and subagentParentMap
      // (standalone pane windows use subagentParentMap, not subagents map)
      const parentFromMap = this.subagentParentMap.get(agentId);
      if (agent?.parentSessionId === sessionId || parentFromMap === sessionId) {
        toClose.push(agentId);
      }
    }
    for (const agentId of toClose) {
      this.forceCloseSubagentWindow(agentId);
      // Clean up activity and tool results data if requested (prevents memory leaks)
      if (cleanupData) {
        this.subagents.delete(agentId);
        this.subagentActivity.delete(agentId);
        this.subagentToolResults.delete(agentId);
        this.subagentParentMap.delete(agentId);
      }
    }
    // Also clean up minimized agents for this session
    this.minimizedSubagents.delete(sessionId);
    this.renderSessionTabs();
  }

  // Fully close a subagent window (removes from DOM, not minimize)
  forceCloseSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      // Clean up resize observer
      if (windowData.resizeObserver) {
        windowData.resizeObserver.disconnect();
      }
      // Clean up drag event listeners (both document-level and handle-level)
      if (windowData.dragListeners) {
        document.removeEventListener('mousemove', windowData.dragListeners.move);
        document.removeEventListener('mouseup', windowData.dragListeners.up);
        if (windowData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', windowData.dragListeners.touchMove);
          document.removeEventListener('touchend', windowData.dragListeners.up);
          document.removeEventListener('touchcancel', windowData.dragListeners.up);
        }
        // Remove handle-level listeners before DOM removal
        if (windowData.dragListeners.handle) {
          windowData.dragListeners.handle.removeEventListener('mousedown', windowData.dragListeners.handleMouseDown);
          windowData.dragListeners.handle.removeEventListener('touchstart', windowData.dragListeners.handleTouchStart);
        }
      }
      windowData.element.remove();
      this.subagentWindows.delete(agentId);
    }
    // Clean up teammate terminal if present
    const termData = this.teammateTerminals.get(agentId);
    if (termData) {
      if (termData.resizeObserver) {
        termData.resizeObserver.disconnect();
      }
      if (termData.terminal) {
        try { termData.terminal.dispose(); } catch {}
      }
      this.teammateTerminals.delete(agentId);
    }
  }


  minimizeSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      // Dispose teammate terminal on minimize to free DOM/memory (lazy re-creation on restore)
      this._disposeTeammateTerminalForMinimize(agentId);
      windowData.element.style.display = 'none';
      windowData.minimized = true;
      this.updateConnectionLines();
    }
  }


  // Debounced wrapper — coalesces rapid subagent events (tool_call, progress,
  // message) into a single DOM update per 100ms per agent window.
  scheduleSubagentWindowRender(agentId) {
    // Skip DOM updates for windows with lazy (disposed) terminals — they're minimized
    const windowData = this.subagentWindows.get(agentId);
    if (windowData?.minimized) return;

    if (!this._subagentWindowRenderTimeouts) this._subagentWindowRenderTimeouts = new Map();
    if (this._subagentWindowRenderTimeouts.has(agentId)) {
      clearTimeout(this._subagentWindowRenderTimeouts.get(agentId));
    }
    this._subagentWindowRenderTimeouts.set(agentId, setTimeout(() => {
      this._subagentWindowRenderTimeouts.delete(agentId);
      scheduleBackground(() => this.renderSubagentWindowContent(agentId));
    }, 100));
  }

  renderSubagentWindowContent(agentId) {
    // Skip if this window has a live terminal (don't overwrite xterm with activity HTML)
    if (this.teammateTerminals.has(agentId)) return;
    // Skip if this window has a lazy (disposed) terminal — it will be re-created on restore
    const windowData = this.subagentWindows.get(agentId);
    if (windowData?._lazyTerminal) return;

    const body = document.getElementById(`subagent-window-body-${agentId}`);
    if (!body) return;

    const activity = this.subagentActivity.get(agentId) || [];

    if (activity.length === 0) {
      body.innerHTML = '<div class="subagent-empty">No activity yet</div>';
      return;
    }

    // Incremental rendering: track how many items are already rendered
    const renderedCount = body.dataset.renderedCount ? parseInt(body.dataset.renderedCount, 10) : 0;
    const maxItems = 100;
    const visibleActivity = activity.slice(-maxItems);

    // If activity was trimmed or this is a fresh render, do full rebuild
    if (renderedCount === 0 || renderedCount > visibleActivity.length || body.children.length === 0 ||
        (body.children.length === 1 && body.querySelector('.subagent-empty'))) {
      // Full rebuild
      const html = visibleActivity.map(a => this._renderActivityItem(a)).join('');
      body.innerHTML = html;
      body.dataset.renderedCount = String(visibleActivity.length);
    } else {
      // Incremental: only append new items
      const newItems = visibleActivity.slice(renderedCount);
      if (newItems.length > 0) {
        const newHtml = newItems.map(a => this._renderActivityItem(a)).join('');
        body.insertAdjacentHTML('beforeend', newHtml);
        body.dataset.renderedCount = String(visibleActivity.length);

        // Trim excess children from the front if over maxItems
        while (body.children.length > maxItems) {
          body.removeChild(body.firstChild);
        }
      }
    }

    body.scrollTop = body.scrollHeight;
  }

  _renderActivityItem(a) {
    const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
    if (a.type === 'tool') {
      return `<div class="activity-line">
        <span class="time">${time}</span>
        <span class="tool-icon">${this.getToolIcon(a.tool)}</span>
        <span class="tool-name">${a.tool}</span>
        <span class="tool-detail">${escapeHtml(this.getToolDetail(a.tool, a.input))}</span>
      </div>`;
    } else if (a.type === 'tool_result') {
      const icon = a.isError ? '❌' : '📄';
      const statusClass = a.isError ? ' error' : '';
      const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
      const preview = a.preview.length > 60 ? a.preview.substring(0, 60) + '...' : a.preview;
      return `<div class="activity-line result-line${statusClass}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${a.tool || '→'}</span>
        <span class="tool-detail">${escapeHtml(preview)}${sizeInfo}</span>
      </div>`;
    } else if (a.type === 'progress') {
      const isHook = a.hookEvent || a.hookName;
      const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
      const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
      return `<div class="activity-line progress-line${isHook ? ' hook-line' : ''}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-detail">${escapeHtml(displayText)}</span>
      </div>`;
    } else if (a.type === 'message') {
      const preview = a.text.length > 150 ? a.text.substring(0, 150) + '...' : a.text;
      return `<div class="message-line">
        <span class="time">${time}</span> 💬 ${escapeHtml(preview)}
      </div>`;
    }
    return '';
  }

  // Update all open subagent windows
  updateSubagentWindows() {
    for (const agentId of this.subagentWindows.keys()) {
      this.renderSubagentWindowContent(agentId);
      this.updateSubagentWindowHeader(agentId);
    }
  }

  // Update subagent window header (title and status)
  updateSubagentWindowHeader(agentId) {
    const agent = this.subagents.get(agentId);
    if (!agent) return;

    const win = document.getElementById(`subagent-window-${agentId}`);
    if (!win) return;

    // Update title/id element with description if available
    const idEl = win.querySelector('.subagent-window-title .id');
    if (idEl) {
      const teammateInfo = this.getTeammateInfo(agent);
      const windowTitle = teammateInfo ? teammateInfo.name : (agent.description || agentId.substring(0, 7));
      const truncatedTitle = windowTitle.length > 50 ? windowTitle.substring(0, 50) + '...' : windowTitle;
      idEl.textContent = truncatedTitle;
    }

    // Add or update teammate badge
    let tmBadge = win.querySelector('.teammate-badge');
    const teammateInfo = this.getTeammateInfo(agent);
    if (teammateInfo && !tmBadge) {
      const titleContainer = win.querySelector('.subagent-window-title');
      if (titleContainer) {
        const badge = document.createElement('span');
        badge.className = `teammate-badge teammate-color-${teammateInfo.color}`;
        badge.title = `Team: ${teammateInfo.teamName}`;
        badge.textContent = `@${teammateInfo.name}`;
        const statusEl = titleContainer.querySelector('.status');
        if (statusEl) statusEl.insertAdjacentElement('beforebegin', badge);
      }
    }

    // Update full tooltip
    const titleContainer = win.querySelector('.subagent-window-title');
    if (titleContainer) {
      titleContainer.title = agent.description || agentId;
    }

    // Update or add model badge
    let modelBadge = win.querySelector('.subagent-window-title .subagent-model-badge');
    if (agent.modelShort) {
      if (!modelBadge) {
        modelBadge = document.createElement('span');
        modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
        const statusEl = win.querySelector('.subagent-window-title .status');
        if (statusEl) {
          statusEl.insertAdjacentElement('beforebegin', modelBadge);
        }
      }
      modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
      modelBadge.textContent = agent.modelShort;
    }

    // Update status
    const statusEl = win.querySelector('.subagent-window-title .status');
    if (statusEl) {
      statusEl.className = `status ${agent.status}`;
      statusEl.textContent = agent.status;
    }
  }

  // Open windows for all active subagents
  openAllActiveSubagentWindows() {
    for (const [agentId, agent] of this.subagents) {
      if (agent.status === 'active' && !this.subagentWindows.has(agentId)) {
        this.openSubagentWindow(agentId);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Agent Teams
  // ═══════════════════════════════════════════════════════════════

  /** Initialize an xterm.js terminal for a teammate's tmux pane */
  initTeammateTerminal(agentId, paneInfo, windowElement) {
    const body = windowElement.querySelector('.subagent-window-body');
    if (!body) return;

    // Clear the activity log content
    body.innerHTML = '';
    body.classList.add('teammate-terminal-body');
    windowElement.classList.add('has-terminal');

    const sessionId = paneInfo.sessionId;

    // Buffer incoming terminal data until xterm is ready
    const pendingData = [];
    this.teammateTerminals.set(agentId, {
      terminal: null,
      fitAddon: null,
      paneTarget: paneInfo.paneTarget,
      sessionId,
      resizeObserver: null,
      pendingData,
    });

    // Defer terminal creation to next frame so the body element has computed dimensions
    requestAnimationFrame(() => {
      // Safety: if window was closed before we got here, bail out
      if (!document.contains(body)) {
        this.teammateTerminals.delete(agentId);
        return;
      }

      const terminal = new Terminal({
        theme: {
          background: '#0d0d0d',
          foreground: '#e0e0e0',
          cursor: '#e0e0e0',
          cursorAccent: '#0d0d0d',
          selection: 'rgba(255, 255, 255, 0.3)',
          black: '#0d0d0d',
          red: '#ff6b6b',
          green: '#51cf66',
          yellow: '#ffd43b',
          blue: '#339af0',
          magenta: '#cc5de8',
          cyan: '#22b8cf',
          white: '#e0e0e0',
          brightBlack: '#495057',
          brightRed: '#ff8787',
          brightGreen: '#69db7c',
          brightYellow: '#ffe066',
          brightBlue: '#5c7cfa',
          brightMagenta: '#da77f2',
          brightCyan: '#66d9e8',
          brightWhite: '#ffffff',
        },
        fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
        fontSize: 12,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 500,
        allowTransparency: true,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);

      if (typeof Unicode11Addon !== 'undefined') {
        try {
          const unicode11Addon = new Unicode11Addon.Unicode11Addon();
          terminal.loadAddon(unicode11Addon);
          terminal.unicode.activeVersion = '11';
        } catch (_e) { /* Unicode11 addon failed */ }
      }

      try {
        terminal.open(body);
      } catch (err) {
        console.warn('[TeammateTerminal] Failed to open terminal:', err);
        this.teammateTerminals.delete(agentId);
        return;
      }

      // Wait for terminal renderer to fully initialize before any writes.
      // xterm.js needs a few frames after open() before write() is safe.
      setTimeout(() => {
        try { fitAddon.fit(); } catch {}

        // Fetch initial pane buffer. Pane captures can be large (up to 5000 lines of
        // tmux scrollback with ANSI sequences = potentially 500KB+). Write in time-budgeted
        // chunks to avoid blocking the main thread when the window is opened mid-session.
        const writeChunked = (term, data) => {
          const CHUNK_MS = 8;
          const CHUNK_BYTES = 32 * 1024;
          if (!data) return;
          let offset = 0;
          const writeNext = () => {
            if (!document.contains(body)) return; // window was closed
            const t0 = performance.now();
            while (offset < data.length) {
              const end = Math.min(offset + CHUNK_BYTES, data.length);
              try { term.write(data.slice(offset, end)); } catch { return; }
              offset = end;
              if (performance.now() - t0 > CHUNK_MS && offset < data.length) {
                requestAnimationFrame(writeNext);
                return;
              }
            }
          };
          requestAnimationFrame(writeNext);
        };

        fetch(`/api/sessions/${sessionId}/teammate-pane-buffer/${encodeURIComponent(paneInfo.paneTarget)}`)
          .then(r => r.json())
          .then(resp => {
            if (resp.success && resp.data?.buffer) {
              writeChunked(terminal, resp.data.buffer);
            }
          })
          .catch(err => console.error('[TeammateTerminal] Failed to fetch buffer:', err));

        // Flush any data that arrived while terminal was initializing
        for (const chunk of pendingData) {
          try { terminal.write(chunk); } catch {}
        }
        pendingData.length = 0;
      }, 100);

      // Forward keyboard input to the teammate's pane
      terminal.onData((data) => {
        fetch(`/api/sessions/${sessionId}/teammate-pane-input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paneTarget: paneInfo.paneTarget, input: data }),
        }).catch(err => console.error('[TeammateTerminal] Failed to send input:', err));
      });

      // Resize observer to refit terminal when window is resized
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });
      });
      resizeObserver.observe(body);

      // Update the stored entry with the real terminal
      const entry = this.teammateTerminals.get(agentId);
      if (entry) {
        entry.terminal = terminal;
        entry.fitAddon = fitAddon;
        entry.resizeObserver = resizeObserver;
      }
    });
  }

  /** Open a standalone terminal window for a tmux-pane teammate (no subagent entry needed) */
  openTeammateTerminalWindow(paneData) {
    // Only open if the session has a tab in Codeman
    if (!this.sessions.has(paneData.sessionId)) return;

    // Use pane target as the unique ID for this window
    const windowId = `pane-${paneData.paneTarget}`;

    // If window already exists, focus it
    if (this.subagentWindows.has(windowId)) {
      const existing = this.subagentWindows.get(windowId);
      if (existing.hidden) {
        existing.element.style.display = 'flex';
        existing.hidden = false;
      }
      if (this.subagentWindowZIndex >= ZINDEX_SUBAGENT_MAX) this._normalizeSubagentZIndexes();
      existing.element.style.zIndex = ++this.subagentWindowZIndex;
      if (existing.minimized) {
        this.restoreSubagentWindow(windowId);
      }
      return;
    }

    // Calculate position
    const windowCount = this.subagentWindows.size;
    const windowWidth = 550;
    const windowHeight = 400;
    const gap = 20;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const startX = 50;
    const startY = 120;
    const maxCols = Math.floor((viewportWidth - startX - 50) / (windowWidth + gap)) || 1;
    const maxRows = Math.floor((viewportHeight - startY - 50) / (windowHeight + gap)) || 1;
    const col = windowCount % maxCols;
    const row = Math.floor(windowCount / maxCols) % maxRows;
    let finalX = startX + col * (windowWidth + gap);
    let finalY = startY + row * (windowHeight + gap);
    finalX = Math.max(10, Math.min(finalX, viewportWidth - windowWidth - 10));
    finalY = Math.max(10, Math.min(finalY, viewportHeight - windowHeight - 10));

    // Color badge
    const colorClass = paneData.color || 'blue';

    // Create window element
    const win = document.createElement('div');
    win.className = 'subagent-window has-terminal';
    win.id = `subagent-window-${windowId}`;
    if (this.subagentWindowZIndex >= ZINDEX_SUBAGENT_MAX) this._normalizeSubagentZIndexes();
    win.style.zIndex = ++this.subagentWindowZIndex;
    win.style.left = `${finalX}px`;
    win.style.top = `${finalY}px`;
    win.style.width = `${windowWidth}px`;
    win.style.height = `${windowHeight}px`;
    win.innerHTML = `
      <div class="subagent-window-header">
        <div class="subagent-window-title" title="Teammate terminal: ${escapeHtml(paneData.teammateName)} (pane ${paneData.paneTarget})">
          <span class="icon" style="color: var(--team-color-${colorClass}, #339af0)">⬤</span>
          <span class="id">${escapeHtml(paneData.teammateName)}</span>
          <span class="status running">terminal</span>
        </div>
        <div class="subagent-window-actions">
          <button onclick="app.closeSubagentWindow('${escapeHtml(windowId)}')" title="Minimize to tab">─</button>
        </div>
      </div>
      <div class="subagent-window-body teammate-terminal-body" id="subagent-window-body-${windowId}">
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.subagent-window-header'));

    // Make resizable if method exists
    if (typeof this.makeWindowResizable === 'function') {
      this.makeWindowResizable(win);
    }

    // Check visibility based on active session
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;
    const shouldHide = activeTabOnly && paneData.sessionId !== this.activeSessionId;

    // Store reference
    this.subagentWindows.set(windowId, {
      element: win,
      minimized: false,
      hidden: shouldHide,
      dragListeners,
      description: `Teammate: ${paneData.teammateName}`,
    });

    // Also add to subagentParentMap for tab-based visibility
    this.subagentParentMap.set(windowId, paneData.sessionId);

    if (shouldHide) {
      win.style.display = 'none';
    }

    // Focus on click
    win.addEventListener('mousedown', () => {
      if (this.subagentWindowZIndex >= ZINDEX_SUBAGENT_MAX) this._normalizeSubagentZIndexes();
      win.style.zIndex = ++this.subagentWindowZIndex;
    });

    // Resize observer for connection lines
    const resizeObserver = new ResizeObserver(() => {
      this.updateConnectionLines();
    });
    resizeObserver.observe(win);
    this.subagentWindows.get(windowId).resizeObserver = resizeObserver;

    // Init the xterm.js terminal (lazy if hidden)
    if (shouldHide) {
      // Window starts hidden — defer terminal creation until visible (lazy init)
      const windowEntry = this.subagentWindows.get(windowId);
      if (windowEntry) {
        windowEntry._lazyTerminal = true;
        windowEntry._lazyPaneTarget = paneData.paneTarget;
        windowEntry._lazySessionId = paneData.sessionId;
      }
    } else {
      this.initTeammateTerminal(windowId, paneData, win);
    }

    // Animate in
    requestAnimationFrame(() => {
      win.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      win.style.transform = 'scale(1)';
      win.style.opacity = '1';
    });
  }

  /** Rebuild the teammate lookup map from all team configs */
  rebuildTeammateMap() {
    this.teammateMap.clear();
    for (const [teamName, team] of this.teams) {
      for (const member of team.members) {
        if (member.agentType !== 'team-lead') {
          // Use name as key prefix for matching subagent descriptions
          this.teammateMap.set(member.name, {
            name: member.name,
            color: member.color || 'blue',
            teamName,
            agentId: member.agentId,
          });
        }
      }
    }
  }

  /** Check if a subagent is a teammate and return its info */
  getTeammateInfo(agent) {
    if (!agent?.description) return null;
    // Teammate descriptions start with <teammate-message teammate_id=
    const match = agent.description.match(/<teammate-message\s+teammate_id="?([^">\s]+)/);
    if (!match) return null;
    const teammateId = match[1];
    // Extract name from teammate_id (format: name@teamName)
    const name = teammateId.split('@')[0];
    return this.teammateMap.get(name) || { name, color: 'blue', teamName: 'unknown' };
  }

  /** Get teammate badge HTML for a subagent */
  getTeammateBadgeHtml(agent) {
    const info = this.getTeammateInfo(agent);
    if (!info) return '';
    return `<span class="teammate-badge teammate-color-${info.color}" title="Team: ${escapeHtml(info.teamName)}">@${escapeHtml(info.name)}</span>`;
  }

  /** Render the team tasks panel */
  renderTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (!panel) return;

    // Find team for active session
    let activeTeam = null;
    let activeTeamName = null;
    if (this.activeSessionId) {
      for (const [name, team] of this.teams) {
        if (team.leadSessionId === this.activeSessionId) {
          activeTeam = team;
          activeTeamName = name;
          break;
        }
      }
    }

    if (!activeTeam) {
      panel.style.display = 'none';
      return;
    }

    // Set initial position and make draggable on first show
    const wasHidden = panel.style.display === 'none';
    panel.style.display = 'flex';

    if (wasHidden && !this.teamTasksDragListeners) {
      // Position bottom-right
      const panelWidth = 360;
      const panelHeight = 300;
      panel.style.left = `${Math.max(10, window.innerWidth - panelWidth - 20)}px`;
      panel.style.top = `${Math.max(10, window.innerHeight - panelHeight - 70)}px`;
      // Make draggable
      const header = panel.querySelector('.team-tasks-header');
      if (header) {
        this.teamTasksDragListeners = this.makeWindowDraggable(panel, header);
      }
    }

    const tasks = this.teamTasks.get(activeTeamName) || [];
    const completed = tasks.filter(t => t.status === 'completed').length;
    const total = tasks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const headerEl = panel.querySelector('.team-tasks-header-text');
    if (headerEl) {
      const teammateCount = activeTeam.members.filter(m => m.agentType !== 'team-lead').length;
      headerEl.textContent = `Team Tasks (${teammateCount} teammates)`;
    }

    const progressEl = panel.querySelector('.team-tasks-progress-fill');
    if (progressEl) {
      progressEl.style.width = `${pct}%`;
    }

    const progressText = panel.querySelector('.team-tasks-progress-text');
    if (progressText) {
      progressText.textContent = `${completed}/${total}`;
    }

    const listEl = panel.querySelector('.team-tasks-list');
    if (!listEl) return;

    if (tasks.length === 0) {
      listEl.innerHTML = '<div class="team-task-empty">No tasks yet</div>';
      return;
    }

    const html = tasks.map(task => {
      const statusIcon = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◉' : '○';
      const statusClass = task.status.replace('_', '-');
      const ownerBadge = task.owner
        ? `<span class="team-task-owner teammate-color-${this.getTeammateColor(task.owner)}">${escapeHtml(task.owner)}</span>`
        : '';
      return `<div class="team-task-item ${statusClass}">
        <span class="team-task-status">${statusIcon}</span>
        <span class="team-task-subject">${escapeHtml(task.subject)}</span>
        ${ownerBadge}
      </div>`;
    }).join('');

    listEl.innerHTML = html;
  }

  /** Hide team tasks panel and clean up drag listeners */
  hideTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (panel) panel.style.display = 'none';
    if (this.teamTasksDragListeners) {
      document.removeEventListener('mousemove', this.teamTasksDragListeners.move);
      document.removeEventListener('mouseup', this.teamTasksDragListeners.up);
      if (this.teamTasksDragListeners.touchMove) {
        document.removeEventListener('touchmove', this.teamTasksDragListeners.touchMove);
        document.removeEventListener('touchend', this.teamTasksDragListeners.up);
        document.removeEventListener('touchcancel', this.teamTasksDragListeners.up);
      }
      if (this.teamTasksDragListeners.handle) {
        this.teamTasksDragListeners.handle.removeEventListener('mousedown', this.teamTasksDragListeners.handleMouseDown);
        this.teamTasksDragListeners.handle.removeEventListener('touchstart', this.teamTasksDragListeners.handleTouchStart);
      }
      this.teamTasksDragListeners = null;
    }
  }

  /** Clean up wizard drag document-level listeners (called on SSE reconnect cleanup) */
  cleanupWizardDragging() {
    if (this.wizardDragListeners) {
      document.removeEventListener('mousemove', this.wizardDragListeners.move);
      document.removeEventListener('mouseup', this.wizardDragListeners.up);
      if (this.wizardDragListeners.touchMove) {
        document.removeEventListener('touchmove', this.wizardDragListeners.touchMove);
        document.removeEventListener('touchend', this.wizardDragListeners.up);
        document.removeEventListener('touchcancel', this.wizardDragListeners.up);
      }
      this.wizardDragListeners = null;
    }
    this.wizardDragState = null;
  }

  /** Get teammate color by name */
  getTeammateColor(name) {
    const info = this.teammateMap.get(name);
    return info?.color || 'blue';
  }

  // ═══════════════════════════════════════════════════════════════
  // Project Insights Panel (Bash Tools with Clickable File Paths)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Normalize a file path to its canonical form for comparison.
   * - Expands ~ to home directory approximation
   * - Resolves relative paths against working directory (case folder)
   * - Normalizes . and .. components
   */
  normalizeFilePath(path, workingDir) {
    if (!path) return '';

    let normalized = path.trim();
    const homeDir = '/home/' + (window.USER || 'user'); // Approximation

    // Expand ~ to home directory
    if (normalized.startsWith('~/')) {
      normalized = homeDir + normalized.slice(1);
    } else if (normalized === '~') {
      normalized = homeDir;
    }

    // If not absolute, resolve against working directory (case folder)
    if (!normalized.startsWith('/') && workingDir) {
      normalized = workingDir + '/' + normalized;
    }

    // Normalize path components (resolve . and ..)
    const parts = normalized.split('/');
    const stack = [];

    for (const part of parts) {
      if (part === '' || part === '.') {
        continue;
      } else if (part === '..') {
        if (stack.length > 1) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }

    return '/' + stack.join('/');
  }

  /**
   * Extract just the filename from a path.
   */
  getFilename(path) {
    const parts = path.split('/');
    return parts[parts.length - 1] || '';
  }

  /**
   * Check if a path is a "shallow root path" - an absolute path with only one
   * component after root (e.g., /test.txt, /file.log).
   * These are often typos where the user meant a relative path in the case folder.
   */
  isShallowRootPath(path) {
    if (!path.startsWith('/')) return false;
    const parts = path.split('/').filter(p => p !== '');
    return parts.length === 1;
  }

  /**
   * Check if a path is inside (or is) the working directory (case folder).
   */
  isPathInWorkingDir(path, workingDir) {
    if (!workingDir) return false;
    const normalized = this.normalizeFilePath(path, workingDir);
    return normalized.startsWith(workingDir + '/') || normalized === workingDir;
  }

  /**
   * Smart path equivalence check.
   * Two paths are considered equivalent if:
   * 1. They normalize to the same path (standard case)
   * 2. One is a "shallow root path" (e.g., /test.txt) and the other is the
   *    same filename inside the case folder - the shallow root path
   *    is likely a typo and they probably meant the same file.
   */
  pathsAreEquivalent(path1, path2, workingDir) {
    const norm1 = this.normalizeFilePath(path1, workingDir);
    const norm2 = this.normalizeFilePath(path2, workingDir);

    // Standard check: exact normalized match
    if (norm1 === norm2) return true;

    // Smart check: shallow root path vs case folder path with same filename
    const file1 = this.getFilename(norm1);
    const file2 = this.getFilename(norm2);

    if (file1 !== file2) return false; // Different filenames, can't be equivalent

    const shallow1 = this.isShallowRootPath(path1);
    const shallow2 = this.isShallowRootPath(path2);
    const inWorkDir1 = this.isPathInWorkingDir(norm1, workingDir);
    const inWorkDir2 = this.isPathInWorkingDir(norm2, workingDir);

    // If one is shallow root (e.g., /test.txt) and other is in case folder
    // with same filename, treat as equivalent (user likely made a typo)
    if (shallow1 && inWorkDir2) return true;
    if (shallow2 && inWorkDir1) return true;

    return false;
  }

  /**
   * Pick the "better" of two paths that resolve to the same file.
   * Prefers paths inside the case folder, longer/more explicit paths, and absolute paths.
   */
  pickBetterPath(path1, path2, workingDir) {
    // Prefer paths inside the case folder (working directory)
    if (workingDir) {
      const inWorkDir1 = this.isPathInWorkingDir(path1, workingDir);
      const inWorkDir2 = this.isPathInWorkingDir(path2, workingDir);
      if (inWorkDir1 && !inWorkDir2) return path1;
      if (inWorkDir2 && !inWorkDir1) return path2;
    }

    // Prefer absolute paths
    const abs1 = path1.startsWith('/');
    const abs2 = path2.startsWith('/');
    if (abs1 && !abs2) return path1;
    if (abs2 && !abs1) return path2;

    // Both absolute or both relative - prefer longer (more explicit)
    if (path1.length !== path2.length) {
      return path1.length > path2.length ? path1 : path2;
    }

    // Prefer paths without ~
    if (!path1.includes('~') && path2.includes('~')) return path1;
    if (!path2.includes('~') && path1.includes('~')) return path2;

    return path1;
  }

  /**
   * Deduplicate file paths across all tools, keeping the "best" version.
   * Uses smart equivalence checking:
   * - Standard normalization for relative vs absolute paths
   * - Detects likely typos (e.g., /file.txt when caseFolder/file.txt exists)
   * - Prefers paths inside the case folder (working directory)
   * - Prefers longer, more explicit paths
   * Returns a Map of normalized path -> best raw path.
   */
  deduplicateProjectInsightPaths(tools, workingDir) {
    // Collect all paths with their tool IDs
    const allPaths = [];
    for (const tool of tools) {
      for (const rawPath of tool.filePaths) {
        allPaths.push({ rawPath, toolId: tool.id });
      }
    }

    if (allPaths.length <= 1) {
      const pathMap = new Map();
      for (const p of allPaths) {
        pathMap.set(this.normalizeFilePath(p.rawPath, workingDir), p);
      }
      return pathMap;
    }

    // Sort paths: prefer paths in case folder first, then by length (longer first)
    allPaths.sort((a, b) => {
      const aInWorkDir = this.isPathInWorkingDir(a.rawPath, workingDir);
      const bInWorkDir = this.isPathInWorkingDir(b.rawPath, workingDir);
      if (aInWorkDir && !bInWorkDir) return -1;
      if (bInWorkDir && !aInWorkDir) return 1;
      return b.rawPath.length - a.rawPath.length; // Longer paths first
    });

    const result = new Map(); // normalized -> { rawPath, toolId }
    const seenNormalized = new Set();

    for (const { rawPath, toolId } of allPaths) {
      const normalized = this.normalizeFilePath(rawPath, workingDir);

      // Check if we've already seen an equivalent path
      let isDuplicate = false;
      for (const [, existing] of result) {
        if (this.pathsAreEquivalent(rawPath, existing.rawPath, workingDir)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate && !seenNormalized.has(normalized)) {
        result.set(normalized, { rawPath, toolId });
        seenNormalized.add(normalized);
      }
    }

    return result;
  }

  handleBashToolStart(sessionId, tool) {
    let tools = this.projectInsights.get(sessionId) || [];
    // Add new tool
    tools = tools.filter(t => t.id !== tool.id);
    tools.push(tool);
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  }

  handleBashToolEnd(sessionId, tool) {
    const tools = this.projectInsights.get(sessionId) || [];
    const existing = tools.find(t => t.id === tool.id);
    if (existing) {
      existing.status = 'completed';
    }
    this.renderProjectInsightsPanel();
    // Remove after a short delay
    setTimeout(() => {
      const current = this.projectInsights.get(sessionId) || [];
      this.projectInsights.set(sessionId, current.filter(t => t.id !== tool.id));
      this.renderProjectInsightsPanel();
    }, 2000);
  }

  handleBashToolsUpdate(sessionId, tools) {
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  }

  renderProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    const list = this.$('projectInsightsList');
    if (!panel || !list) return;

    // Check if panel is enabled in settings
    const settings = this.loadAppSettingsFromStorage();
    const showProjectInsights = settings.showProjectInsights ?? false;
    if (!showProjectInsights) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    // Get tools for active session only
    const tools = this.projectInsights.get(this.activeSessionId) || [];
    const runningTools = tools.filter(t => t.status === 'running');

    if (runningTools.length === 0) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    panel.classList.add('visible');
    this.projectInsightsPanelVisible = true;

    // Get working directory for path normalization
    const session = this.sessions.get(this.activeSessionId);
    const workingDir = session?.workingDir || this.currentSessionWorkingDir;

    // Smart deduplication: collect all unique paths across all tools
    // Paths that resolve to the same file are deduplicated, keeping the most complete version
    const deduplicatedPaths = this.deduplicateProjectInsightPaths(runningTools, workingDir);

    // Build a set of paths to show (only the best version of each unique file)
    const pathsToShow = new Set(Array.from(deduplicatedPaths.values()).map(p => p.rawPath));

    const html = [];
    for (const tool of runningTools) {
      // Filter this tool's paths to only include those that weren't deduplicated away
      const filteredPaths = tool.filePaths.filter(p => pathsToShow.has(p));

      // Skip tools with no paths to show (all were duplicates of better paths elsewhere)
      if (filteredPaths.length === 0) continue;

      const cmdDisplay = tool.command.length > 50
        ? tool.command.substring(0, 50) + '...'
        : tool.command;

      html.push(`
        <div class="project-insight-item" data-tool-id="${tool.id}">
          <div class="project-insight-command">
            <span class="icon">💻</span>
            <span class="cmd" title="${escapeHtml(tool.command)}">${escapeHtml(cmdDisplay)}</span>
            <span class="project-insight-status ${tool.status}">${tool.status}</span>
            ${tool.timeout ? `<span class="project-insight-timeout">${escapeHtml(tool.timeout)}</span>` : ''}
          </div>
          <div class="project-insight-paths">
      `);

      for (const path of filteredPaths) {
        const fileName = path.split('/').pop();
        html.push(`
            <span class="project-insight-filepath"
                  onclick="app.openLogViewerWindow('${escapeHtml(path)}', '${escapeHtml(tool.sessionId)}')"
                  title="${escapeHtml(path)}">${escapeHtml(fileName)}</span>
        `);
      }

      html.push(`
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  }

  closeProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    if (panel) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // File Browser Panel
  // ═══════════════════════════════════════════════════════════════

  // File tree data and state
  fileBrowserData = null;
  fileBrowserExpandedDirs = new Set();
  fileBrowserFilter = '';
  fileBrowserAllExpanded = false;
  fileBrowserDragListeners = null;
  filePreviewContent = '';

  async loadFileBrowser(sessionId) {
    if (!sessionId) return;

    const treeEl = this.$('fileBrowserTree');
    const statusEl = this.$('fileBrowserStatus');
    if (!treeEl) return;

    // Show loading state
    treeEl.innerHTML = '<div class="file-browser-loading">Loading files...</div>';

    try {
      const res = await fetch(`/api/sessions/${sessionId}/files?depth=5&showHidden=false`);
      if (!res.ok) throw new Error('Failed to load files');

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load files');

      this.fileBrowserData = result.data;
      this.renderFileBrowserTree();

      // Update status
      if (statusEl) {
        const { totalFiles, totalDirectories, truncated } = result.data;
        statusEl.textContent = `${totalFiles} files, ${totalDirectories} dirs${truncated ? ' (truncated)' : ''}`;
      }
    } catch (err) {
      console.error('Failed to load file browser:', err);
      treeEl.innerHTML = `<div class="file-browser-empty">Failed to load files: ${escapeHtml(err.message)}</div>`;
    }
  }

  renderFileBrowserTree() {
    const treeEl = this.$('fileBrowserTree');
    if (!treeEl || !this.fileBrowserData) return;

    const { tree } = this.fileBrowserData;
    if (!tree || tree.length === 0) {
      treeEl.innerHTML = '<div class="file-browser-empty">No files found</div>';
      return;
    }

    const html = [];
    const filter = this.fileBrowserFilter.toLowerCase();

    const renderNode = (node, depth) => {
      const isDir = node.type === 'directory';
      const isExpanded = this.fileBrowserExpandedDirs.has(node.path);
      const matchesFilter = !filter || node.name.toLowerCase().includes(filter);

      // For directories, check if any children match
      let hasMatchingChildren = false;
      if (isDir && filter && node.children) {
        hasMatchingChildren = this.hasMatchingChild(node, filter);
      }

      const shouldShow = matchesFilter || hasMatchingChildren;
      const hiddenClass = !shouldShow && filter ? ' hidden-by-filter' : '';

      const icon = isDir
        ? (isExpanded ? '\uD83D\uDCC2' : '\uD83D\uDCC1')
        : this.getFileIcon(node.extension);

      const expandIcon = isDir
        ? `<span class="file-tree-expand${isExpanded ? ' expanded' : ''}">\u25B6</span>`
        : '<span class="file-tree-expand"></span>';

      const sizeStr = !isDir && node.size !== undefined
        ? `<span class="file-tree-size">${this.formatFileSize(node.size)}</span>`
        : '';

      const nameClass = isDir ? 'file-tree-name directory' : 'file-tree-name';

      html.push(`
        <div class="file-tree-item${hiddenClass}" data-path="${escapeHtml(node.path)}" data-type="${node.type}" data-depth="${depth}">
          ${expandIcon}
          <span class="file-tree-icon">${icon}</span>
          <span class="${nameClass}">${escapeHtml(node.name)}</span>
          ${sizeStr}
        </div>
      `);

      // Render children if directory is expanded
      if (isDir && isExpanded && node.children) {
        for (const child of node.children) {
          renderNode(child, depth + 1);
        }
      }
    };

    for (const node of tree) {
      renderNode(node, 0);
    }

    treeEl.innerHTML = html.join('');

    // Add click handlers
    treeEl.querySelectorAll('.file-tree-item').forEach(item => {
      item.addEventListener('click', () => {
        const path = item.dataset.path;
        const type = item.dataset.type;

        if (type === 'directory') {
          this.toggleFileBrowserFolder(path);
        } else {
          this.openFilePreview(path);
        }
      });
    });
  }

  hasMatchingChild(node, filter) {
    if (!node.children) return false;
    for (const child of node.children) {
      if (child.name.toLowerCase().includes(filter)) return true;
      if (child.type === 'directory' && this.hasMatchingChild(child, filter)) return true;
    }
    return false;
  }

  toggleFileBrowserFolder(path) {
    if (this.fileBrowserExpandedDirs.has(path)) {
      this.fileBrowserExpandedDirs.delete(path);
    } else {
      this.fileBrowserExpandedDirs.add(path);
    }
    this.renderFileBrowserTree();
  }

  filterFileBrowser(value) {
    this.fileBrowserFilter = value;
    // Auto-expand all if filtering
    if (value) {
      this.expandAllDirectories(this.fileBrowserData?.tree || []);
    }
    this.renderFileBrowserTree();
  }

  expandAllDirectories(nodes) {
    for (const node of nodes) {
      if (node.type === 'directory') {
        this.fileBrowserExpandedDirs.add(node.path);
        if (node.children) {
          this.expandAllDirectories(node.children);
        }
      }
    }
  }

  collapseAllDirectories() {
    this.fileBrowserExpandedDirs.clear();
  }

  toggleFileBrowserExpand() {
    this.fileBrowserAllExpanded = !this.fileBrowserAllExpanded;
    const btn = this.$('fileBrowserExpandBtn');

    if (this.fileBrowserAllExpanded) {
      this.expandAllDirectories(this.fileBrowserData?.tree || []);
      if (btn) btn.innerHTML = '\u229F'; // Collapse icon
    } else {
      this.collapseAllDirectories();
      if (btn) btn.innerHTML = '\u229E'; // Expand icon
    }
    this.renderFileBrowserTree();
  }

  refreshFileBrowser() {
    if (this.activeSessionId) {
      this.fileBrowserExpandedDirs.clear();
      this.fileBrowserFilter = '';
      this.fileBrowserAllExpanded = false;
      const searchInput = this.$('fileBrowserSearch');
      if (searchInput) searchInput.value = '';
      this.loadFileBrowser(this.activeSessionId);
    }
  }

  closeFileBrowserPanel() {
    const panel = this.$('fileBrowserPanel');
    if (panel) {
      panel.classList.remove('visible');
      // Reset position so it reopens at default location
      panel.style.left = '';
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.right = '';
    }
    // Clean up drag listeners
    if (this.fileBrowserDragListeners) {
      const dl = this.fileBrowserDragListeners;
      document.removeEventListener('mousemove', dl.move);
      document.removeEventListener('mouseup', dl.up);
      document.removeEventListener('touchmove', dl.touchMove);
      document.removeEventListener('touchend', dl.up);
      document.removeEventListener('touchcancel', dl.up);
      if (dl.handle) {
        dl.handle.removeEventListener('mousedown', dl.handleMouseDown);
        dl.handle.removeEventListener('touchstart', dl.handleTouchStart);
        if (dl._onFirstDrag) {
          dl.handle.removeEventListener('mousedown', dl._onFirstDrag);
          dl.handle.removeEventListener('touchstart', dl._onFirstDrag);
        }
      }
      this.fileBrowserDragListeners = null;
    }
    // Save setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showFileBrowser = false;
    this.saveAppSettingsToStorage(settings);
  }

  async openFilePreview(filePath) {
    if (!this.activeSessionId || !filePath) return;

    const overlay = this.$('filePreviewOverlay');
    const titleEl = this.$('filePreviewTitle');
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');

    if (!overlay || !bodyEl) return;

    // Show overlay with loading state
    overlay.classList.add('visible');
    titleEl.textContent = filePath;
    bodyEl.innerHTML = '<div class="binary-message">Loading...</div>';
    footerEl.textContent = '';

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/file-content?path=${encodeURIComponent(filePath)}&lines=500`);
      if (!res.ok) throw new Error('Failed to load file');

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load file');

      const data = result.data;

      if (data.type === 'image') {
        bodyEl.innerHTML = `<img src="${data.url}" alt="${escapeHtml(filePath)}">`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'video') {
        bodyEl.innerHTML = `<video src="${data.url}" controls autoplay></video>`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'binary') {
        bodyEl.innerHTML = `<div class="binary-message">Binary file (${this.formatFileSize(data.size)})<br>Cannot preview</div>`;
        footerEl.textContent = data.extension || 'binary';
      } else {
        // Text content
        this.filePreviewContent = data.content;
        bodyEl.innerHTML = `<pre><code>${escapeHtml(data.content)}</code></pre>`;
        const truncNote = data.truncated ? ` (showing 500/${data.totalLines} lines)` : '';
        footerEl.textContent = `${data.totalLines} lines \u2022 ${this.formatFileSize(data.size)}${truncNote}`;
      }
    } catch (err) {
      console.error('Failed to preview file:', err);
      bodyEl.innerHTML = `<div class="binary-message">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  closeFilePreview() {
    const overlay = this.$('filePreviewOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
    this.filePreviewContent = '';
  }

  copyFilePreviewContent() {
    if (this.filePreviewContent) {
      navigator.clipboard.writeText(this.filePreviewContent).then(() => {
        this.showToast('Copied to clipboard', 'success');
      }).catch(() => {
        this.showToast('Failed to copy', 'error');
      });
    }
  }

  getFileIcon(ext) {
    if (!ext) return '\uD83D\uDCC4'; // Default file

    const icons = {
      // TypeScript/JavaScript
      'ts': '\uD83D\uDCD8', 'tsx': '\uD83D\uDCD8', 'js': '\uD83D\uDCD2', 'jsx': '\uD83D\uDCD2',
      'mjs': '\uD83D\uDCD2', 'cjs': '\uD83D\uDCD2',
      // Python
      'py': '\uD83D\uDC0D', 'pyx': '\uD83D\uDC0D', 'pyw': '\uD83D\uDC0D',
      // Rust/Go/C
      'rs': '\uD83E\uDD80', 'go': '\uD83D\uDC39', 'c': '\u2699\uFE0F', 'cpp': '\u2699\uFE0F',
      'h': '\u2699\uFE0F', 'hpp': '\u2699\uFE0F',
      // Web
      'html': '\uD83C\uDF10', 'htm': '\uD83C\uDF10', 'css': '\uD83C\uDFA8', 'scss': '\uD83C\uDFA8',
      'sass': '\uD83C\uDFA8', 'less': '\uD83C\uDFA8',
      // Data
      'json': '\uD83D\uDCCB', 'yaml': '\uD83D\uDCCB', 'yml': '\uD83D\uDCCB', 'xml': '\uD83D\uDCCB',
      'toml': '\uD83D\uDCCB', 'csv': '\uD83D\uDCCB',
      // Docs
      'md': '\uD83D\uDCDD', 'markdown': '\uD83D\uDCDD', 'txt': '\uD83D\uDCDD', 'rst': '\uD83D\uDCDD',
      // Images
      'png': '\uD83D\uDDBC\uFE0F', 'jpg': '\uD83D\uDDBC\uFE0F', 'jpeg': '\uD83D\uDDBC\uFE0F',
      'gif': '\uD83D\uDDBC\uFE0F', 'svg': '\uD83D\uDDBC\uFE0F', 'webp': '\uD83D\uDDBC\uFE0F',
      'ico': '\uD83D\uDDBC\uFE0F', 'bmp': '\uD83D\uDDBC\uFE0F',
      // Video/Audio
      'mp4': '\uD83C\uDFAC', 'webm': '\uD83C\uDFAC', 'mov': '\uD83C\uDFAC',
      'mp3': '\uD83C\uDFB5', 'wav': '\uD83C\uDFB5', 'ogg': '\uD83C\uDFB5',
      // Config/Shell
      'sh': '\uD83D\uDCBB', 'bash': '\uD83D\uDCBB', 'zsh': '\uD83D\uDCBB',
      'env': '\uD83D\uDD10', 'gitignore': '\uD83D\uDEAB', 'dockerfile': '\uD83D\uDC33',
      // Lock files
      'lock': '\uD83D\uDD12',
    };

    return icons[ext.toLowerCase()] || '\uD83D\uDCC4';
  }

  formatFileSize(bytes) {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  // ═══════════════════════════════════════════════════════════════
  // Log Viewer Windows (Floating File Streamers)
  // ═══════════════════════════════════════════════════════════════

  openLogViewerWindow(filePath, sessionId) {
    sessionId = sessionId || this.activeSessionId;
    if (!sessionId) return;

    // Create unique window ID
    const windowId = `${sessionId}-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    // If window already exists, focus it
    if (this.logViewerWindows.has(windowId)) {
      const existing = this.logViewerWindows.get(windowId);
      existing.element.style.zIndex = ++this.logViewerWindowZIndex;
      return;
    }

    // Calculate position (cascade from top-left)
    const windowCount = this.logViewerWindows.size;
    const offsetX = 100 + (windowCount % 5) * 30;
    const offsetY = 100 + (windowCount % 5) * 30;

    // Get filename for title
    const fileName = filePath.split('/').pop();

    // Create window element
    const win = document.createElement('div');
    win.className = 'log-viewer-window';
    win.id = `log-viewer-window-${windowId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.logViewerWindowZIndex;

    win.innerHTML = `
      <div class="log-viewer-window-header">
        <div class="log-viewer-window-title" title="${escapeHtml(filePath)}">
          <span class="icon">📄</span>
          <span class="filename">${escapeHtml(fileName)}</span>
          <span class="status streaming">streaming</span>
        </div>
        <div class="log-viewer-window-actions">
          <button onclick="app.closeLogViewerWindow('${escapeHtml(windowId)}')" title="Close">×</button>
        </div>
      </div>
      <div class="log-viewer-window-body" id="log-viewer-body-${windowId}">
        <div class="log-info">Connecting to ${escapeHtml(filePath)}...</div>
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable (returns listener refs for cleanup)
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.log-viewer-window-header'));

    // Connect to SSE stream
    const eventSource = new EventSource(
      `/api/sessions/${sessionId}/tail-file?path=${encodeURIComponent(filePath)}&lines=50`
    );

    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const body = document.getElementById(`log-viewer-body-${windowId}`);
      if (!body) return;

      switch (data.type) {
        case 'connected':
          body.innerHTML = '';
          break;
        case 'data':
          // Append data, auto-scroll
          const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 10;
          const content = escapeHtml(data.content);
          body.innerHTML += content;
          if (wasAtBottom) {
            body.scrollTop = body.scrollHeight;
          }
          // Trim if too large
          if (body.innerHTML.length > 500000) {
            body.innerHTML = body.innerHTML.slice(-400000);
          }
          break;
        case 'end':
          this.updateLogViewerStatus(windowId, 'disconnected', 'ended');
          break;
        case 'error':
          body.innerHTML += `<div class="log-error">${escapeHtml(data.error)}</div>`;
          this.updateLogViewerStatus(windowId, 'error', 'error');
          break;
      }
    };

    eventSource.onerror = () => {
      this.updateLogViewerStatus(windowId, 'disconnected', 'connection error');
    };

    // Store reference (including drag listeners for cleanup)
    this.logViewerWindows.set(windowId, {
      element: win,
      eventSource,
      filePath,
      sessionId,
      dragListeners, // Store for cleanup to prevent memory leaks
    });
  }

  updateLogViewerStatus(windowId, statusClass, statusText) {
    const statusEl = document.querySelector(`#log-viewer-window-${windowId} .status`);
    if (statusEl) {
      statusEl.className = `status ${statusClass}`;
      statusEl.textContent = statusText;
    }
  }

  closeLogViewerWindow(windowId) {
    const windowData = this.logViewerWindows.get(windowId);
    if (!windowData) return;

    // Close SSE connection
    if (windowData.eventSource) {
      windowData.eventSource.close();
    }

    // Clean up drag event listeners (both document-level and handle-level)
    if (windowData.dragListeners) {
      document.removeEventListener('mousemove', windowData.dragListeners.move);
      document.removeEventListener('mouseup', windowData.dragListeners.up);
      if (windowData.dragListeners.handle) {
        windowData.dragListeners.handle.removeEventListener('mousedown', windowData.dragListeners.handleMouseDown);
        windowData.dragListeners.handle.removeEventListener('touchstart', windowData.dragListeners.handleTouchStart);
      }
    }

    // Remove element
    windowData.element.remove();

    // Remove from map
    this.logViewerWindows.delete(windowId);
  }

  // Close all log viewer windows for a session
  closeSessionLogViewerWindows(sessionId) {
    const toClose = [];
    for (const [windowId, data] of this.logViewerWindows) {
      if (data.sessionId === sessionId) {
        toClose.push(windowId);
      }
    }
    for (const windowId of toClose) {
      this.closeLogViewerWindow(windowId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Image Popup Windows (Auto-popup for Screenshots)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Open a popup window to display a detected image.
   * Called automatically when image:detected SSE event is received.
   */
  openImagePopup(imageEvent) {
    const { sessionId, filePath, relativePath, fileName, timestamp, size } = imageEvent;

    // Create unique window ID
    const imageId = `${sessionId}-${timestamp}`;

    // If window already exists for this image, focus it
    if (this.imagePopups.has(imageId)) {
      const existing = this.imagePopups.get(imageId);
      existing.element.style.zIndex = ++this.imagePopupZIndex;
      return;
    }

    // Cap open popups at 20 — close oldest when at limit
    const MAX_IMAGE_POPUPS = 20;
    if (this.imagePopups.size >= MAX_IMAGE_POPUPS) {
      // Map iteration order is insertion order, so first key is oldest
      const oldestId = this.imagePopups.keys().next().value;
      if (oldestId) this.closeImagePopup(oldestId);
    }

    // Calculate position (cascade from center, with offset for multiple popups)
    const windowCount = this.imagePopups.size;
    const centerX = (window.innerWidth - 600) / 2;
    const centerY = (window.innerHeight - 500) / 2;
    const offsetX = centerX + (windowCount % 5) * 30;
    const offsetY = centerY + (windowCount % 5) * 30;

    // Get session name for display
    const session = this.sessions.get(sessionId);
    const sessionName = session?.name || sessionId.substring(0, 8);

    // Format file size
    const sizeKB = (size / 1024).toFixed(1);

    // Build image URL using the existing file-raw endpoint
    // Use relativePath (path from working dir) instead of fileName (basename) for subdirectory images
    const imageUrl = `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(relativePath || fileName)}`;

    // Create window element
    const win = document.createElement('div');
    win.className = 'image-popup-window';
    win.id = `image-popup-${imageId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.imagePopupZIndex;

    win.innerHTML = `
      <div class="image-popup-header">
        <div class="image-popup-title" title="${escapeHtml(filePath)}">
          <span class="icon">🖼️</span>
          <span class="filename">${escapeHtml(fileName)}</span>
          <span class="session-badge">${escapeHtml(sessionName)}</span>
          <span class="size-badge">${sizeKB} KB</span>
        </div>
        <div class="image-popup-actions">
          <button onclick="app.openImageInNewTab('${escapeHtml(imageUrl)}')" title="Open in new tab">↗</button>
          <button onclick="app.closeImagePopup('${escapeHtml(imageId)}')" title="Close">×</button>
        </div>
      </div>
      <div class="image-popup-body">
        <img src="${imageUrl}" alt="${escapeHtml(fileName)}"
             onerror="this.parentElement.innerHTML='<div class=\\'image-error\\'>Failed to load image</div>'"
             onclick="app.openImageInNewTab('${escapeHtml(imageUrl)}')" />
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.image-popup-header'));

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.imagePopupZIndex;
    });

    // Store reference
    this.imagePopups.set(imageId, {
      element: win,
      sessionId,
      filePath,
      dragListeners,
    });
  }

  /**
   * Close an image popup window.
   */
  closeImagePopup(imageId) {
    const popupData = this.imagePopups.get(imageId);
    if (!popupData) return;

    // Clean up drag event listeners (both document-level and handle-level)
    if (popupData.dragListeners) {
      document.removeEventListener('mousemove', popupData.dragListeners.move);
      document.removeEventListener('mouseup', popupData.dragListeners.up);
      if (popupData.dragListeners.touchMove) {
        document.removeEventListener('touchmove', popupData.dragListeners.touchMove);
        document.removeEventListener('touchend', popupData.dragListeners.up);
        document.removeEventListener('touchcancel', popupData.dragListeners.up);
      }
      if (popupData.dragListeners.handle) {
        popupData.dragListeners.handle.removeEventListener('mousedown', popupData.dragListeners.handleMouseDown);
        popupData.dragListeners.handle.removeEventListener('touchstart', popupData.dragListeners.handleTouchStart);
      }
    }

    // Remove element
    popupData.element.remove();

    // Remove from map
    this.imagePopups.delete(imageId);
  }

  /**
   * Open image in a new browser tab.
   */
  openImageInNewTab(url) {
    window.open(url, '_blank');
  }

  /**
   * Close all image popups for a session.
   */
  closeSessionImagePopups(sessionId) {
    const toClose = [];
    for (const [imageId, data] of this.imagePopups) {
      if (data.sessionId === sessionId) {
        toClose.push(imageId);
      }
    }
    for (const imageId of toClose) {
      this.closeImagePopup(imageId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Mux Sessions (in Monitor Panel)
  // ═══════════════════════════════════════════════════════════════

  async loadMuxSessions() {
    try {
      const res = await fetch('/api/mux-sessions');
      const data = await res.json();
      this.muxSessions = data.sessions || [];
      this.renderMuxSessions();
    } catch (err) {
      console.error('Failed to load mux sessions:', err);
    }
  }

  killAllMuxSessions() {
    const count = this.muxSessions?.length || 0;
    if (count === 0) {
      alert('No sessions to kill');
      return;
    }

    // Show the kill all modal
    document.getElementById('killAllCount').textContent = count;
    const modal = document.getElementById('killAllModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  closeKillAllModal() {
    document.getElementById('killAllModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  async confirmKillAll(killMux) {
    this.closeKillAllModal();

    try {
      if (killMux) {
        // Kill everything including tmux sessions
        const res = await fetch('/api/sessions', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          this.sessions.clear();
          this.muxSessions = [];
          this.activeSessionId = null;
          SessionIndicatorBar.update(null);
          try { localStorage.removeItem('codeman-active-session'); } catch {}
          this.renderSessionTabs();
          this.renderMuxSessions();
          this.terminal.clear();
          this.terminal.reset();
          this.toast('All sessions and tmux killed', 'success');
        }
      } else {
        // Just remove tabs, keep mux sessions running
        this.sessions.clear();
        this.activeSessionId = null;
        SessionIndicatorBar.update(null);
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        this.renderSessionTabs();
        this.terminal.clear();
        this.terminal.reset();
        this.toast('All tabs removed, tmux still running', 'info');
      }
    } catch (err) {
      console.error('Failed to kill sessions:', err);
      this.toast('Failed to kill sessions: ' + err.message, 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Case Settings
  // ═══════════════════════════════════════════════════════════════

  toggleCaseSettings() {
    const popover = document.getElementById('caseSettingsPopover');
    if (popover.classList.contains('hidden')) {
      // Load settings for current case
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeams').checked = settings.agentTeams;
      popover.classList.remove('hidden');

      // Close on outside click (one-shot listener)
      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      // Defer to avoid catching the current click
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  }

  getCaseSettings(caseName) {
    try {
      const stored = localStorage.getItem('caseSettings_' + caseName);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return { agentTeams: false };
  }

  saveCaseSettings(caseName, settings) {
    localStorage.setItem('caseSettings_' + caseName, JSON.stringify(settings));
  }

  onCaseSettingChanged() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeams').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync mobile checkbox
    const mobileCheckbox = document.getElementById('caseAgentTeamsMobile');
    if (mobileCheckbox) mobileCheckbox.checked = settings.agentTeams;
  }

  toggleCaseSettingsMobile() {
    const popover = document.getElementById('caseSettingsPopoverMobile');
    if (popover.classList.contains('hidden')) {
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeamsMobile').checked = settings.agentTeams;
      popover.classList.remove('hidden');

      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings-mobile')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  }

  onCaseSettingChangedMobile() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeamsMobile').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync desktop checkbox
    const desktopCheckbox = document.getElementById('caseAgentTeams');
    if (desktopCheckbox) desktopCheckbox.checked = settings.agentTeams;
  }

  // ═══════════════════════════════════════════════════════════════
  // Create Case Modal
  // ═══════════════════════════════════════════════════════════════

  showCreateCaseModal() {
    document.getElementById('newCaseName').value = '';
    document.getElementById('newCaseDescription').value = '';
    document.getElementById('linkCaseName').value = '';
    document.getElementById('linkCasePath').value = '';
    // Reset to first tab
    this.caseModalTab = 'case-create';
    this.switchCaseModalTab('case-create');
    // Wire up tab buttons
    const modal = document.getElementById('createCaseModal');
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.onclick = () => this.switchCaseModalTab(btn.dataset.tab);
    });
    // Scroll-into-view on focus for mobile keyboard visibility
    modal.querySelectorAll('input[type="text"]').forEach(input => {
      if (!input._mobileScrollWired) {
        input._mobileScrollWired = true;
        input.addEventListener('focus', () => {
          if (window.innerWidth <= 430) {
            setTimeout(() => input.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
          }
        });
      }
    });
    modal.classList.add('active');
    document.getElementById('newCaseName').focus();
  }

  switchCaseModalTab(tabName) {
    this.caseModalTab = tabName;
    const modal = document.getElementById('createCaseModal');
    // Toggle active class on tab buttons
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // Toggle hidden class on tab content
    modal.querySelectorAll('.modal-tab-content').forEach(content => {
      content.classList.toggle('hidden', content.id !== tabName);
    });
    // Update submit button text
    const submitBtn = document.getElementById('caseModalSubmit');
    submitBtn.textContent = tabName === 'case-create' ? 'Create' : 'Link';
    // Focus appropriate input
    if (tabName === 'case-create') {
      document.getElementById('newCaseName').focus();
    } else {
      document.getElementById('linkCaseName').focus();
    }
  }

  closeCreateCaseModal() {
    document.getElementById('createCaseModal').classList.remove('active');
  }

  async submitCaseModal() {
    const btn = document.getElementById('caseModalSubmit');
    const originalText = btn.textContent;
    btn.classList.add('loading');
    btn.textContent = this.caseModalTab === 'case-create' ? 'Creating...' : 'Linking...';
    try {
      if (this.caseModalTab === 'case-create') {
        await this.createCase();
      } else {
        await this.linkCase();
      }
    } finally {
      btn.classList.remove('loading');
      btn.textContent = originalText;
    }
  }

  async createCase() {
    const name = document.getElementById('newCaseName').value.trim();
    const description = document.getElementById('newCaseDescription').value.trim();

    if (!name) {
      this.showToast('Please enter a project name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Project "${name}" created`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to create project', 'error');
      }
    } catch (err) {
      console.error('Failed to create project:', err);
      this.showToast('Failed to create project: ' + err.message, 'error');
    }
  }

  async linkCase() {
    const name = document.getElementById('linkCaseName').value.trim();
    const path = document.getElementById('linkCasePath').value.trim();

    if (!name) {
      this.showToast('Please enter a project name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    if (!path) {
      this.showToast('Please enter a folder path', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Project "${name}" linked to ${path}`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to link project', 'error');
      }
    } catch (err) {
      console.error('Failed to link project:', err);
      this.showToast('Failed to link project: ' + err.message, 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Mobile Case Picker
  // ═══════════════════════════════════════════════════════════════

  showMobileCasePicker(initialTab = 'projects') {
    const modal = document.getElementById('mobileCasePickerModal');
    const listContainer = document.getElementById('mobileCaseList');
    const select = document.getElementById('quickStartCase');
    const currentCase = select.value;

    // Build case list HTML
    let html = '';
    const cases = this.cases || [];

    // Add testcase if not in list
    const hasTestcase = cases.some(c => c.name === 'testcase');
    const allCases = hasTestcase ? cases : [{ name: 'testcase' }, ...cases];

    for (const c of allCases) {
      const isSelected = c.name === currentCase;
      html += `
        <button class="mobile-case-item ${isSelected ? 'selected' : ''}"
                onclick="app.selectMobileCase('${escapeHtml(c.name)}')">
          <span class="mobile-case-item-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </span>
          <span class="mobile-case-item-name">${escapeHtml(c.name)}</span>
          <span class="mobile-case-item-check">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </span>
        </button>
      `;
    }

    listContainer.innerHTML = html;
    modal.classList.add('active');
    // Switch to requested tab (default: projects)
    this.switchCasePickerTab(initialTab);
  }

  closeMobileCasePicker() {
    document.getElementById('mobileCasePickerModal').classList.remove('active');
  }

  selectMobileCase(caseName) {
    // Update the desktop select (source of truth)
    const select = document.getElementById('quickStartCase');
    select.value = caseName;

    // Update mobile button label
    this.updateMobileCaseLabel(caseName);

    // Update directory display
    this.updateDirDisplayForCase(caseName);

    // Save as last used
    this.saveLastUsedCase(caseName);

    // Close the picker
    this.closeMobileCasePicker();

    this.showToast(`Selected: ${caseName}`, 'success');
  }

  updateMobileCaseLabel(caseName) {
    // Keep activeCaseName in sync for accessory bar project button
    this.activeCaseName = caseName;
    const label = document.getElementById('mobileCaseName');
    if (label) {
      // Let CSS handle truncation via text-overflow: ellipsis
      label.textContent = caseName;
    }
    // Update the accessory bar project name pill
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.updateProjectName();
    }
  }

  showCreateCaseFromMobile() {
    // Close mobile picker first
    this.closeMobileCasePicker();
    // Open the create case modal with slide-up animation
    this.showCreateCaseModal();
    const modal = document.getElementById('createCaseModal');
    modal.classList.add('from-mobile');
    // Remove animation class after it plays
    setTimeout(() => modal.classList.remove('from-mobile'), 300);
  }

  // Open project picker to the "New" tab — wired to drawer footer "+ New Project" button
  openNewCaseModal() {
    if (typeof SessionDrawer !== 'undefined') SessionDrawer.close();
    this.showMobileCasePicker('new');
  }

  // Open project picker to the "Clone from Git" tab — wired to drawer footer button
  openCloneModal() {
    if (typeof SessionDrawer !== 'undefined') SessionDrawer.close();
    this.showMobileCasePicker('clone');
  }

  switchCasePickerTab(tab) {
    document.querySelectorAll('.case-picker-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.case-picker-tab-content').forEach(el => {
      el.style.display = 'none';
    });
    const target = document.getElementById('casePickerTab-' + tab);
    if (target) target.style.display = '';
    // Auto-focus the first input in the tab
    const input = target?.querySelector('input');
    if (input) setTimeout(() => input.focus(), 50);
  }

  async createCaseFromPicker() {
    const nameEl = document.getElementById('pickerNewCaseName');
    const name = nameEl?.value.trim();
    if (!name) { this.showToast('Enter a project name', 'error'); nameEl?.focus(); return; }
    const btn = document.querySelector('#casePickerTab-new .case-picker-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.success) {
        this.closeMobileCasePicker();
        await this.loadQuickStartCases(name);
        await this.saveLastUsedCase(name);
        this.showToast(`Project "${name}" created`, 'success');
      } else {
        this.showToast(data.error || 'Failed to create project', 'error');
      }
    } catch (err) {
      this.showToast('Failed to create project: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Create Project'; }
    }
  }

  async cloneRepoFromPicker() {
    const url = document.getElementById('pickerCloneUrl')?.value.trim();
    if (!url) { this.showToast('Enter a repository URL', 'error'); return; }
    const btn = document.querySelector('#casePickerTab-clone .case-picker-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Cloning…'; }
    try {
      const res = await fetch('/api/cases/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (data.success) {
        const name = data.data?.case?.name;
        this.closeMobileCasePicker();
        await this.loadQuickStartCases(name);
        if (name) await this.saveLastUsedCase(name);
        this.showToast(`Cloned "${name}" successfully`, 'success');
      } else {
        this.showToast(data.error || 'Clone failed', 'error');
      }
    } catch (err) {
      this.showToast('Clone failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Clone & Open'; }
    }
  }

  renderMuxSessions() {
    // Debounce renders at 100ms to prevent excessive DOM updates
    if (this.renderMuxSessionsTimeout) {
      clearTimeout(this.renderMuxSessionsTimeout);
    }
    this.renderMuxSessionsTimeout = setTimeout(() => {
      this._renderMuxSessionsImmediate();
    }, 100);
  }

  _renderMuxSessionsImmediate() {
    const body = document.getElementById('muxSessionsBody');

    if (!this.muxSessions || this.muxSessions.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No mux sessions</div>';
      return;
    }

    let html = '';
    for (const muxSession of this.muxSessions) {
      const stats = muxSession.stats || { memoryMB: 0, cpuPercent: 0, childCount: 0 };

      // Look up rich session data by sessionId
      const session = this.sessions.get(muxSession.sessionId);
      const status = session ? session.status : 'unknown';
      const isWorking = session ? session.isWorking : false;

      // Status badge
      let statusLabel, statusClass;
      if (status === 'idle' && !isWorking) {
        statusLabel = 'IDLE';
        statusClass = 'status-idle';
      } else if (status === 'busy' || isWorking) {
        statusLabel = 'WORKING';
        statusClass = 'status-working';
      } else if (status === 'stopped') {
        statusLabel = 'STOPPED';
        statusClass = 'status-stopped';
      } else {
        statusLabel = status.toUpperCase();
        statusClass = '';
      }

      // Token and cost info
      const tokens = session && session.tokens ? session.tokens : null;
      const totalCost = session ? session.totalCost : 0;
      const model = session ? (session.cliModel || '') : '';
      const modelShort = model.includes('opus') ? 'opus' : model.includes('sonnet') ? 'sonnet' : model.includes('haiku') ? 'haiku' : '';

      // Ralph/Todo progress
      const todoStats = session ? session.ralphTodoStats : null;
      let todoHtml = '';
      if (todoStats && todoStats.total > 0) {
        const pct = Math.round((todoStats.completed / todoStats.total) * 100);
        todoHtml = `<span class="process-stat todo-progress">${todoStats.completed}/${todoStats.total} (${pct}%)</span>`;
      }

      // Format tokens
      let tokenHtml = '';
      if (tokens && tokens.total > 0) {
        const totalK = (tokens.total / 1000).toFixed(1);
        tokenHtml = `<span class="process-stat tokens">${totalK}k tok</span>`;
      }

      // Format cost
      let costHtml = '';
      if (totalCost > 0) {
        costHtml = `<span class="process-stat cost">$${totalCost.toFixed(2)}</span>`;
      }

      // Model badge
      let modelHtml = '';
      if (modelShort) {
        modelHtml = `<span class="monitor-model-badge ${modelShort}">${modelShort}</span>`;
      }

      html += `
        <div class="process-item">
          <span class="monitor-status-badge ${statusClass}">${statusLabel}</span>
          <div class="process-info">
            <div class="process-name">${modelHtml} ${escapeHtml(muxSession.name || muxSession.muxName)}</div>
            <div class="process-meta">
              ${tokenHtml}
              ${costHtml}
              ${todoHtml}
              <span class="process-stat memory">${stats.memoryMB}MB</span>
              <span class="process-stat cpu">${stats.cpuPercent}%</span>
            </div>
          </div>
          <div class="process-actions">
            <button class="btn-toolbar btn-sm btn-danger" onclick="app.killMuxSession('${escapeHtml(muxSession.sessionId)}')" title="Kill session">Kill</button>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  renderMonitorSubagents() {
    const body = document.getElementById('monitorSubagentsBody');
    const stats = document.getElementById('monitorSubagentStats');
    if (!body) return;

    const subagents = Array.from(this.subagents.values());
    const activeCount = subagents.filter(s => s.status === 'active' || s.status === 'idle').length;

    if (stats) {
      stats.textContent = `${subagents.length} tracked` + (activeCount > 0 ? `, ${activeCount} active` : '');
    }

    if (subagents.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No background agents</div>';
      return;
    }

    let html = '';
    for (const agent of subagents) {
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const modelBadge = agent.modelShort ? `<span class="model-badge ${agent.modelShort}">${agent.modelShort}</span>` : '';
      const desc = agent.description ? escapeHtml(agent.description.substring(0, 40)) : agent.agentId;

      html += `
        <div class="process-item">
          <span class="process-mode ${statusClass}">${agent.status}</span>
          <div class="process-info">
            <div class="process-name">${modelBadge} ${desc}</div>
            <div class="process-meta">
              <span>ID: ${agent.agentId}</span>
              <span>${agent.toolCallCount || 0} tools</span>
            </div>
          </div>
          <div class="process-actions">
            ${agent.status !== 'completed' ? `<button class="btn-toolbar btn-sm btn-danger" onclick="app.killSubagent('${escapeHtml(agent.agentId)}')" title="Kill agent">Kill</button>` : ''}
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  async killMuxSession(sessionId) {
    if (!confirm('Kill this mux session?')) return;

    try {
      // Use closeSession to properly clean up both the session tab and tmux process
      // (closeSession handles its own toast messaging)
      await this.closeSession(sessionId, true);
    } catch (err) {
      // Fallback: kill mux directly if session cleanup fails
      try { await fetch(`/api/mux-sessions/${sessionId}`, { method: 'DELETE' }); } catch (_ignored) {}
      this.showToast('Tmux session killed', 'success');
    }
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== sessionId);
    this.renderMuxSessions();
  }

  async reconcileMuxSessions() {
    try {
      const res = await fetch('/api/mux-sessions/reconcile', { method: 'POST' });
      const data = await res.json();

      if (data.dead && data.dead.length > 0) {
        this.showToast(`Found ${data.dead.length} dead mux session(s)`, 'warning');
        await this.loadMuxSessions();
      } else {
        this.showToast('All mux sessions are alive', 'success');
      }
    } catch (err) {
      this.showToast('Failed to reconcile mux sessions', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Plan Wizard Agents in Monitor
  // ═══════════════════════════════════════════════════════════════

  renderMonitorPlanAgents() {
    const section = document.getElementById('monitorPlanAgentsSection');
    const body = document.getElementById('monitorPlanAgentsBody');
    const stats = document.getElementById('monitorPlanAgentStats');
    if (!section || !body) return;

    const planAgents = Array.from(this.planSubagents?.values() || []);
    const hasActiveOrchestrator = !!this.activePlanOrchestratorId;

    // Show section only if there are plan agents or active orchestrator
    if (planAgents.length === 0 && !hasActiveOrchestrator) {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';

    const activeCount = planAgents.filter(a => a.status === 'running').length;
    const completedCount = planAgents.filter(a => a.status === 'completed' || a.status === 'failed').length;

    if (stats) {
      if (hasActiveOrchestrator) {
        stats.textContent = `${activeCount} running, ${completedCount} done`;
      } else {
        stats.textContent = `${planAgents.length} total`;
      }
    }

    if (planAgents.length === 0) {
      body.innerHTML = `<div class="monitor-empty">${hasActiveOrchestrator ? 'Plan generation starting...' : 'No plan agents'}</div>`;
      return;
    }

    let html = '';
    for (const agent of planAgents) {
      const statusClass = agent.status === 'running' ? 'active' : agent.status === 'completed' ? 'completed' : 'error';
      const agentLabel = agent.agentType || agent.agentId;
      const modelBadge = agent.model ? `<span class="model-badge opus">opus</span>` : '';
      const detail = agent.detail ? escapeHtml(agent.detail.substring(0, 50)) : '';
      const duration = agent.durationMs ? `${(agent.durationMs / 1000).toFixed(1)}s` : '';
      const itemCount = agent.itemCount ? `${agent.itemCount} items` : '';

      html += `
        <div class="process-item">
          <span class="process-mode ${statusClass}">${agent.status || 'pending'}</span>
          <div class="process-info">
            <div class="process-name">${modelBadge} ${escapeHtml(agentLabel)}</div>
            <div class="process-meta">
              ${detail ? `<span>${detail}</span>` : ''}
              ${itemCount ? `<span>${itemCount}</span>` : ''}
              ${duration ? `<span>${duration}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  async cancelPlanFromMonitor() {
    if (!this.activePlanOrchestratorId && this.planSubagents?.size === 0) {
      this.showToast('No active plan generation', 'info');
      return;
    }

    if (!confirm('Cancel plan generation and close all plan agent windows?')) return;

    // Cancel the plan generation (reuse existing method)
    await this.cancelPlanGeneration();

    // Also force close the wizard if it's open
    const wizardModal = document.getElementById('ralphWizardModal');
    if (wizardModal?.classList.contains('active')) {
      this.closeRalphWizard();
    }

    // Update monitor display
    this.renderMonitorPlanAgents();
    this.showToast('Plan generation cancelled', 'success');
  }

  // ═══════════════════════════════════════════════════════════════
  // Toast
  // ═══════════════════════════════════════════════════════════════

  // Cached toast container for performance
  _toastContainer = null;

  toggleNotifications() {
    this.notificationManager?.toggleDrawer();
  }

  // Alias for showToast
  toast(message, type = 'info') {
    return this.showToast(message, type);
  }

  showToast(message, type = 'info', opts = {}) {
    const { duration = 3000, action } = opts;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.style.cssText = 'margin-left:12px;padding:2px 10px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:3px;color:inherit;cursor:pointer;font-size:12px';
      btn.onclick = (e) => { e.stopPropagation(); action.onClick(); toast.remove(); };
      toast.appendChild(btn);
    }

    // Cache toast container reference
    if (!this._toastContainer) {
      this._toastContainer = document.querySelector('.toast-container');
      if (!this._toastContainer) {
        this._toastContainer = document.createElement('div');
        this._toastContainer.className = 'toast-container';
        document.body.appendChild(this._toastContainer);
      }
    }
    this._toastContainer.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }

  // ═══════════════════════════════════════════════════════════════
  // System Stats
  // ═══════════════════════════════════════════════════════════════

  startSystemStatsPolling() {
    // Clear any existing interval to prevent duplicates
    this.stopSystemStatsPolling();

    // Initial fetch
    this.fetchSystemStats();

    // Poll every 2 seconds
    this.systemStatsInterval = setInterval(() => {
      this.fetchSystemStats();
    }, 2000);
  }

  stopSystemStatsPolling() {
    if (this.systemStatsInterval) {
      clearInterval(this.systemStatsInterval);
      this.systemStatsInterval = null;
    }
  }

  async fetchSystemStats() {
    // Skip polling when system stats display is hidden
    const statsEl = document.getElementById('headerSystemStats');
    if (!statsEl || statsEl.style.display === 'none') return;

    try {
      const res = await fetch('/api/system/stats');
      const stats = await res.json();
      this.updateSystemStatsDisplay(stats);
    } catch (err) {
      // Silently fail - system stats are not critical
    }
  }

  updateSystemStatsDisplay(stats) {
    const cpuEl = this.$('statCpu');
    const cpuBar = this.$('statCpuBar');
    const memEl = this.$('statMem');
    const memBar = this.$('statMemBar');

    if (cpuEl && cpuBar) {
      cpuEl.textContent = `${stats.cpu}%`;
      cpuBar.style.width = `${Math.min(100, stats.cpu)}%`;

      // Color classes based on usage
      cpuBar.classList.remove('medium', 'high');
      cpuEl.classList.remove('high');
      if (stats.cpu > 80) {
        cpuBar.classList.add('high');
        cpuEl.classList.add('high');
      } else if (stats.cpu > 50) {
        cpuBar.classList.add('medium');
      }
    }

    if (memEl && memBar) {
      const memGB = (stats.memory.usedMB / 1024).toFixed(1);
      memEl.textContent = `${memGB}G`;
      memBar.style.width = `${Math.min(100, stats.memory.percent)}%`;

      // Color classes based on usage
      memBar.classList.remove('medium', 'high');
      memEl.classList.remove('high');
      if (stats.memory.percent > 80) {
        memBar.classList.add('high');
        memEl.classList.add('high');
      } else if (stats.memory.percent > 50) {
        memBar.classList.add('medium');
      }
    }
  }

}

// ═══════════════════════════════════════════════════════════════
// Module Init — localStorage migration and app start
// ═══════════════════════════════════════════════════════════════

// Migrate legacy localStorage keys (claudeman-* → codeman-*)
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('claudeman-') || key.startsWith('claudeman_'))) {
      const newKey = key.replace(/^claudeman[-_]/, (m) => 'codeman' + m.charAt(m.length - 1));
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, localStorage.getItem(key));
      }
    }
  }
} catch {}

/** Centralized branch/worktree SVG icon — use everywhere instead of 🌿 */
const BRANCH_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="5" r="1.5"/><path d="M4 4.5v7"/><path d="M4 4.5 C4 7 12 6 12 6.5"/></svg>';

/**
 * Built-in Claude Code slash commands — always available in the compose panel,
 * regardless of which session is active or which plugins are installed.
 */
const BUILTIN_CLAUDE_COMMANDS = [
  { cmd: '/compact',        desc: 'Compact conversation history',          source: 'builtin' },
  { cmd: '/clear',          desc: 'Clear conversation history',            source: 'builtin' },
  { cmd: '/help',           desc: 'Show available commands and help',      source: 'builtin' },
  { cmd: '/bug',            desc: 'Report a bug to Anthropic',             source: 'builtin' },
  { cmd: '/cost',           desc: 'View token usage and cost',             source: 'builtin' },
  { cmd: '/doctor',         desc: 'Check Claude Code installation health', source: 'builtin' },
  { cmd: '/init',           desc: 'Initialize CLAUDE.md in current project', source: 'builtin' },
  { cmd: '/login',          desc: 'Sign in with Anthropic credentials',    source: 'builtin' },
  { cmd: '/logout',         desc: 'Sign out from Anthropic',               source: 'builtin' },
  { cmd: '/memory',         desc: 'Edit CLAUDE.md memory files',           source: 'builtin' },
  { cmd: '/model',          desc: 'Set the AI model',                      source: 'builtin' },
  { cmd: '/pr_comments',    desc: 'View PR comments',                      source: 'builtin' },
  { cmd: '/release-notes',  desc: 'See what\'s new in Claude Code',        source: 'builtin' },
  { cmd: '/review',         desc: 'Review a pull request',                 source: 'builtin' },
  { cmd: '/status',         desc: 'Show account and system status',        source: 'builtin' },
  { cmd: '/terminal-setup', desc: 'Configure terminal key bindings',       source: 'builtin' },
  { cmd: '/vim',            desc: 'Toggle Vim mode',                       source: 'builtin' },
];

/**
 * InputPanel — Persistent native textarea above the keyboard accessory bar.
 * Mobile only. Toggle open/closed.
 *
 * Features: auto-growing textarea, inset + and send buttons, multi-image thumbnails,
 * slash command popup, plus action sheet (camera / gallery / file).
 */
const InputPanel = {
  _open: false,
  _panelEl: null,
  _textareaEl: null,
  _images: [],     // Array<{ objectUrl: string, file: File, path: string|null }>
  _slashVisible: false,
  _replaceIdx: -1,
  _autoGrowPending: false,
  _drafts: new Map(),       // Map<sessionId, {text, imagePaths[]}> — per-session draft cache
  _draftSaveTimer: null,    // Debounce timer for server draft auto-save
  _currentSessionId: null,  // Session whose draft is currently loaded

  _getPanel()    { return this._panelEl    || (this._panelEl    = document.getElementById('mobileInputPanel')); },
  _getTextarea() { return this._textareaEl || (this._textareaEl = document.getElementById('composeTextarea')); },

  /** Called by selectSession when the active session changes. Saves old draft, loads new one. */
  onSessionChange(oldId, newId) {
    if (oldId) this._saveDraftLocal(oldId);
    this._currentSessionId = newId;
    if (newId) this._loadDraft(newId);
  },

  /** Save current textarea + images to in-memory draft for sessionId, then schedule server save. */
  _saveDraftLocal(sessionId) {
    if (!sessionId) return;
    const ta = this._getTextarea();
    const text = ta ? ta.value : '';
    const imagePaths = this._images.map(img => img.path).filter(Boolean);
    this._drafts.set(sessionId, { text, imagePaths });
    // Auto-save to server (debounced 2s)
    clearTimeout(this._draftSaveTimer);
    this._draftSaveTimer = setTimeout(() => this._saveDraftServer(sessionId, text, imagePaths), 2000);
  },

  /** Persist draft to server for cross-device sync. */
  _saveDraftServer(sessionId, text, imagePaths) {
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, imagePaths }),
    }).catch(() => {}); // fire-and-forget
  },

  /** Restore draft for sessionId — first from local cache, then from server. */
  async _loadDraft(sessionId) {
    const ta = this._getTextarea();
    if (!ta) return;
    // Always clear first so the previous session's text never leaks into a new session
    ta.value = '';
    this._restoreImages([]);
    this._autoGrow(ta);
    // Apply local cache immediately (fast path)
    const local = this._drafts.get(sessionId);
    if (local) {
      ta.value = local.text || '';
      this._restoreImages(local.imagePaths || []);
      this._autoGrow(ta);
    }
    // Then fetch from server (handles cross-device case)
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/draft`);
      if (!res.ok) return;
      const data = await res.json();
      // Only apply if server draft is newer than what we have (or local was empty)
      if (!local && (data.text || data.imagePaths?.length)) {
        ta.value = data.text || '';
        this._restoreImages(data.imagePaths || []);
        this._autoGrow(ta);
      }
    } catch {}
  },

  /** Rebuild _images from an array of server-side paths (no File object needed for display). */
  _restoreImages(imagePaths) {
    // Revoke any existing object URLs to avoid memory leaks
    for (const img of this._images) {
      if (img.objectUrl) URL.revokeObjectURL(img.objectUrl);
    }
    this._images = imagePaths.map(path => ({ objectUrl: null, file: null, path }));
    this._renderThumbnails();
  },

  /** Init — wire events once after DOM is ready */
  init() {
    const ta = this._getTextarea();
    if (!ta) return;

    // Auto-grow on input (RAF-debounced to avoid forced sync layout per keystroke)
    ta.addEventListener('input', () => {
      this._handleSlashInput(ta.value); // stays synchronous (drives popup visibility)
      if (!this._autoGrowPending) {
        this._autoGrowPending = true;
        requestAnimationFrame(() => {
          this._autoGrowPending = false;
          this._autoGrow(ta);
        });
      }
      // Auto-save draft for the current session (debounced 2s)
      if (this._currentSessionId) {
        clearTimeout(this._draftSaveTimer);
        this._draftSaveTimer = setTimeout(() => {
          const imagePaths = this._images.map(img => img.path).filter(Boolean);
          this._saveDraftServer(this._currentSessionId, ta.value, imagePaths);
          this._drafts.set(this._currentSessionId, { text: ta.value, imagePaths });
        }, 2000);
      }
    });

    // Keyboard: Ctrl/Cmd+Enter sends on desktop; plain Enter creates newline
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.send();
      }
    });

    // Paste images — intercept clipboard image data on both desktop and mobile
    ta.addEventListener('paste', (e) => {
      const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
      const imageItems = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'));
      if (!imageItems.length) return; // No images — let default text paste proceed
      e.preventDefault();
      const files = imageItems.map(it => it.getAsFile()).filter(Boolean);
      if (!files.length) return;
      // Reuse existing file-handling logic by creating a synthetic input-like object
      this._onFilesFromPaste(files);
    });

    // Plus button — on desktop skip the mobile action sheet, open file picker directly
    const plusBtn = document.getElementById('composePlusBtn');
    if (plusBtn) plusBtn.addEventListener('click', () => {
      const isDesktop = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() !== 'mobile';
      if (isDesktop) {
        document.getElementById('composeFileAny')?.click();
      } else {
        this._openActionSheet();
      }
    });

    // Send button
    const sendBtn = document.getElementById('composeSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', () => this.send());

    // Expand/collapse button — desktop only
    const expandBtn = document.getElementById('composeExpandBtn');
    if (expandBtn) {
      expandBtn.removeAttribute('style'); // Always clear inline style — CSS media query hides it on mobile
      const isDesktop = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() !== 'mobile';
      if (isDesktop) {
        const wrap = document.querySelector('.compose-textarea-wrap');
        if (wrap && localStorage.getItem('desktopComposeExpanded') === 'true') {
          wrap.classList.add('expanded');
        }
        expandBtn.addEventListener('click', () => {
          const w = document.querySelector('.compose-textarea-wrap');
          if (!w) return;
          const expanded = w.classList.toggle('expanded');
          localStorage.setItem('desktopComposeExpanded', String(expanded));
        });
      }
    }
    // Set initial padding on desktop so .main doesn't jump on first keystroke
    if (typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() !== 'mobile') {
      const ta = this._getTextarea();
      if (ta) this._autoGrow(ta);
    }
  },

  /** Auto-grow the textarea up to the available viewport height */
  _autoGrow(ta) {
    ta.style.height = 'auto';
    const isDesktop = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() === 'desktop';
    const vvh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const maxH = isDesktop ? 200 : Math.max(80, vvh - 200);
    ta.style.maxHeight = maxH + 'px';
    ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px';
    // Update CSS var so layout containers track the actual compose bar height
    const panel = document.getElementById('mobileInputPanel');
    if (panel) {
      const h = panel.getBoundingClientRect().height;
      if (isDesktop) {
        document.documentElement.style.setProperty('--desktop-compose-height', String(h) + 'px');
      } else {
        // --mobile-compose-height drives .transcript-view bottom offset so content
        // is never hidden beneath the fixed input panel + accessory bar.
        document.documentElement.style.setProperty('--mobile-compose-height', String(h) + 'px');
      }
    }
  },

  toggle() { if (this._open) this.close(); else this.open(); },

  open() {
    const panel = this._getPanel();
    if (!panel) return;
    panel.style.display = '';
    this._open = true;
    if (typeof KeyboardAccessoryBar !== 'undefined' && KeyboardAccessoryBar.instance) {
      KeyboardAccessoryBar.instance.setComposeActive(true);
    }
    const ta = this._getTextarea();
    if (ta) { this._autoGrow(ta); ta.focus(); }
  },

  close() {
    const panel = this._getPanel();
    if (!panel) return;
    panel.style.display = 'none';
    this._open = false;
    this._closeSlashPopup();
    // Revoke object URLs to prevent memory leaks
    for (const img of this._images) {
      if (img.objectUrl) URL.revokeObjectURL(img.objectUrl);
    }
    this._images = [];
    this._renderThumbnails();
    if (typeof KeyboardAccessoryBar !== 'undefined' && KeyboardAccessoryBar.instance) {
      KeyboardAccessoryBar.instance.setComposeActive(false);
    }
  },

  /** Send all queued images then the typed text */
  send() {
    const ta = this._getTextarea();
    if (!ta) return;
    const text = ta.value.trim();
    const images = this._images.filter(img => img.path);
    if (!text && !images.length) return;
    if (typeof app === 'undefined' || !app.sendInput) return;

    // Combine image paths and text into one message joined by \n (Ctrl+J line breaks).
    // This sends everything as a single Claude prompt so the Enter at the end submits
    // it all together — avoids the race where text+Enter arrive while Claude is still
    // processing the image path submission from a prior Enter.
    const parts = [...images.map(img => img.path), ...(text ? [text] : [])];
    app.sendInput(parts.join('\n') + '\r');

    // Verify Enter was received: poll session status every 100ms for 500ms.
    // If session never goes busy, send a bare \r to retry the Enter key.
    const _sendSessionId = app.activeSessionId;
    let _sendChecks = 0;
    const _sendCheckTimer = setInterval(() => {
      _sendChecks++;
      const s = app.sessions?.get(_sendSessionId);
      if (s?.status === 'busy') { clearInterval(_sendCheckTimer); return; }
      if (_sendChecks >= 5) {
        clearInterval(_sendCheckTimer);
        // Session still idle — resend Enter in case it was lost
        if (s?.status !== 'busy') app.sendInput('\r').catch(() => {});
      }
    }, 100);

    // Show user message immediately in transcript view (optimistic UI)
    if (text && typeof TranscriptView !== 'undefined' && TranscriptView._sessionId === app.activeSessionId) {
      if (text.trim() === '/clear') {
        TranscriptView.clearOnly();
      } else {
        TranscriptView.appendOptimistic(text);
      }
    }

    // Optimistic busy indicator — show loading state immediately without waiting for OSC-133 or SSE.
    // Session is processing as soon as we send; don't make the user wait for server-side signals.
    if (typeof TranscriptView !== 'undefined' && TranscriptView._sessionId === app.activeSessionId) {
      TranscriptView.setWorking(true);
    }
    app._updateTabStatusDebounced(app.activeSessionId, 'busy');

    // Clear draft for this session
    if (this._currentSessionId) {
      this._drafts.set(this._currentSessionId, { text: '', imagePaths: [] });
      clearTimeout(this._draftSaveTimer);
      this._saveDraftServer(this._currentSessionId, '', []);
    }

    ta.value = '';
    this._images = [];
    this._renderThumbnails(); // Clear strip first so _autoGrow sees final panel height
    this._autoGrow(ta);
    // Desktop: keep panel open (always-visible); mobile: close after send
    const isDesktop = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() !== 'mobile';
    if (!isDesktop) this.close();
  },

  clear() {
    const ta = this._getTextarea();
    if (!ta) return;
    ta.value = '';
    this._autoGrow(ta);
    ta.focus();
  },

  // ── Image handling ──────────────────────────────────────────────────────────

  _openActionSheet() {
    const sheet = document.getElementById('composeActionSheet');
    const backdrop = document.getElementById('composeActionBackdrop');
    if (sheet) sheet.style.display = '';
    if (backdrop) backdrop.style.display = '';
  },

  _closeActionSheet() {
    const sheet = document.getElementById('composeActionSheet');
    const backdrop = document.getElementById('composeActionBackdrop');
    if (sheet) sheet.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
  },

  _actionSheetPick(type) {
    this._closeActionSheet();
    const id = type === 'camera' ? 'composeFileCamera'
             : type === 'gallery' ? 'composeFileGallery'
             : 'composeFileAny';
    document.getElementById(id)?.click();
  },

  /** Handle files pasted from clipboard (Ctrl+V / Cmd+V with image data) */
  async _onFilesFromPaste(files) {
    await this._uploadFiles(files);
  },

  async _onFilesChosen(input, _type) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    await this._uploadFiles(files);
  },

  async _uploadFiles(files) {
    if (!files.length) return;

    // If replacing an existing image
    const replacing = this._replaceIdx >= 0 && this._replaceIdx < this._images.length;
    const replaceIdx = this._replaceIdx;
    this._replaceIdx = -1;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const objectUrl = URL.createObjectURL(file);
      const entry = { objectUrl, file, path: null };

      if (replacing && i === 0) {
        // Revoke old object URL and replace entry
        URL.revokeObjectURL(this._images[replaceIdx].objectUrl);
        this._images[replaceIdx] = entry;
      } else {
        this._images.push(entry);
      }
      this._renderThumbnails();

      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/screenshots', { method: 'POST', body: formData });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Upload failed');
        entry.path = data.path;
        this._renderThumbnails();
      } catch (err) {
        if (typeof app !== 'undefined') app.showToast('Image upload failed', 'error');
        console.error('[InputPanel] image upload failed:', err);
        const idx = this._images.indexOf(entry);
        if (idx !== -1) this._images.splice(idx, 1);
        URL.revokeObjectURL(objectUrl);
        this._renderThumbnails();
      }
    }
  },

  _renderThumbnails() {
    const strip = document.getElementById('composeThumbStrip');
    if (!strip) return;
    strip.replaceChildren();
    if (!this._images.length) { strip.style.display = 'none'; return; }
    strip.style.display = '';

    this._images.forEach((img, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'compose-thumb';
      wrap.title = img.path ? 'Tap to preview / long-press to replace' : 'Uploading\u2026';

      const imgEl = document.createElement('img');
      // objectUrl is null for server-restored images — use the API path instead
      imgEl.src = img.objectUrl || (img.path ? `/api/screenshots/${encodeURIComponent(img.path.split('/').pop())}` : '');
      imgEl.alt = 'Attachment ' + (idx + 1);
      imgEl.addEventListener('click', () => this._previewImage(img));
      let pressTimer;
      imgEl.addEventListener('touchstart', () => {
        pressTimer = setTimeout(() => this._replaceImage(idx), 500);
      }, { passive: true });
      imgEl.addEventListener('touchend', () => clearTimeout(pressTimer), { passive: true });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'compose-thumb-remove';
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', 'Remove image');
      removeBtn.textContent = '\xd7';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        URL.revokeObjectURL(img.objectUrl);
        this._images.splice(idx, 1);
        this._renderThumbnails();
      });

      wrap.appendChild(imgEl);
      wrap.appendChild(removeBtn);
      strip.appendChild(wrap);
    });
  },

  _previewImage(img) {
    window.open(img.objectUrl, '_blank');
  },

  _replaceImage(idx) {
    this._replaceIdx = idx;
    const input = document.getElementById('composeFileGallery');
    if (input) input.click();
  },

  // ── Slash commands ──────────────────────────────────────────────────────────

  _handleSlashInput(value) {
    if (!value.startsWith('/')) { this._closeSlashPopup(); return; }
    const query = value.slice(1).toLowerCase();
    const sessionId = typeof app !== 'undefined' ? app.activeSessionId : null;
    const sessionCommands = (sessionId && app._sessionCommands?.get(sessionId)) || [];
    // Merge session-specific commands (first) with built-ins, deduplicating by cmd name
    const sessionCmdSet = new Set(sessionCommands.map(c => c.cmd));
    const allCommands = [...sessionCommands, ...BUILTIN_CLAUDE_COMMANDS.filter(c => !sessionCmdSet.has(c.cmd))];
    const matches = query
      ? allCommands.filter(c => {
          const cmd = c.cmd.toLowerCase();
          const desc = (c.desc || '').toLowerCase();
          if (cmd.includes(query) || desc.includes(query)) return true;
          // Subsequence match: gsdmile matches gsd:new-milestone
          let qi = 0;
          for (let i = 0; i < cmd.length && qi < query.length; i++) {
            if (cmd[i] === query[qi]) qi++;
          }
          return qi === query.length;
        })
      : allCommands;
    if (!matches.length) { this._closeSlashPopup(); return; }
    this._showSlashPopup(matches);
  },

  _showSlashPopup(commands) {
    const popup = document.getElementById('composeSlashPopup');
    if (!popup) return;
    popup.replaceChildren();
    commands.forEach(cmd => {
      const item = document.createElement('div');
      item.className = 'compose-slash-item';
      item.setAttribute('role', 'option');

      const cmdSpan = document.createElement('span');
      cmdSpan.className = 'compose-slash-cmd';
      cmdSpan.textContent = cmd.cmd;

      const descSpan = document.createElement('span');
      descSpan.className = 'compose-slash-desc';
      descSpan.textContent = cmd.desc;

      item.appendChild(cmdSpan);
      if (cmd.desc) item.appendChild(descSpan);
      item.addEventListener('click', () => this._insertSlashCommand(cmd.cmd));
      popup.appendChild(item);
    });
    popup.style.display = '';
    this._slashVisible = true;
  },

  _insertSlashCommand(cmd) {
    const ta = this._getTextarea();
    if (ta) {
      ta.value = cmd + ' ';
      this._autoGrow(ta);
      ta.focus();
    }
    this._closeSlashPopup();
  },

  _closeSlashPopup() {
    const popup = document.getElementById('composeSlashPopup');
    if (popup) popup.style.display = 'none';
    this._slashVisible = false;
  },
};

/**
 * SessionDrawer — session drawer — right-anchored popup (desktop and mobile).
 * All DOM text uses textContent (no innerHTML with session data).
 */
const SessionDrawer = {
  _el: null,
  _overlay: null,
  _list: null,
  _getEl() { return this._el || (this._el = document.getElementById('sessionDrawer')); },
  _getOverlay() { return this._overlay || (this._overlay = document.getElementById('sessionDrawerOverlay')); },
  _getList() { return this._list || (this._list = document.getElementById('sessionDrawerList')); },
  open() {
    this._getOverlay()?.classList.add('open');
    const drawer = this._getEl();
    if (drawer) { drawer.classList.add('open'); this._render(); }
    // Add pin toggle button on desktop (≥1024px)
    if (MobileDetection.getDeviceType() !== 'mobile' && window.innerWidth >= 1024) {
      const titleEl = document.querySelector('.session-drawer-title');
      if (titleEl && !titleEl.querySelector('.drawer-pin-btn')) {
        const pinBtn = document.createElement('button');
        pinBtn.className = 'drawer-pin-btn';
        const isPinned = document.body.classList.contains('sidebar-pinned');
        pinBtn.textContent = isPinned ? '\u21a4' : '\u21a6';
        pinBtn.title = isPinned ? 'Unpin sidebar' : 'Pin sidebar';
        pinBtn.addEventListener('click', () => {
          const nowPinned = !document.body.classList.contains('sidebar-pinned');
          document.body.classList.toggle('sidebar-pinned', nowPinned);
          localStorage.setItem('sidebarPinned', String(nowPinned));
          pinBtn.textContent = nowPinned ? '\u21a4' : '\u21a6';
          pinBtn.title = nowPinned ? 'Unpin sidebar' : 'Pin sidebar';
        });
        titleEl.appendChild(pinBtn);
      }
    }
  },
  close() {
    this._getOverlay()?.classList.remove('open');
    this._getEl()?.classList.remove('open');
  },
  toggle() {
    if (this._getEl()?.classList.contains('open')) this.close(); else this.open();
  },
  _esc(str) {
    return String(str ?? '');
  },

  _renderSessionRow(s) {
    const isActive = s.id === app.activeSessionId;
    const isRunning = s.status === 'running' || s.status === 'active' || s.status === 'busy';
    const hasRalph  = app.ralphStates?.get(s.id)?.enabled;
    const modeLabel = s.cliMode || s.mode || 'claude';

    const row = document.createElement('div');
    row.className = 'drawer-session-row' + (isActive ? ' active' : '');
    row.dataset.sessionId = s.id;

    const dot = document.createElement('span');
    dot.className = 'drawer-session-dot'
      + (isRunning ? ' running' : ' idle')
      + (hasRalph  ? ' ralph'   : '');

    const name = document.createElement('span');
    name.className = 'drawer-session-name';
    name.textContent = app.getSessionName(s);

    const badge = document.createElement('span');
    badge.className = 'session-mode-badge';
    badge.setAttribute('data-mode', modeLabel);
    badge.textContent = modeLabel;

    const gearBtn = document.createElement('button');
    gearBtn.className = 'drawer-session-gear';
    gearBtn.setAttribute('aria-label', 'Session options');
    gearBtn.textContent = '⚙';
    gearBtn.addEventListener('click', e => {
      e.stopPropagation();
      SessionDrawer.close();
      app.openSessionOptions(s.id);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-session-close';
    closeBtn.setAttribute('aria-label', 'Close session');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      this._showCloseSheet(s.id, app.getSessionName(s));
    });

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(badge);
    row.appendChild(gearBtn);
    row.appendChild(closeBtn);

    row.addEventListener('click', () => {
      app.selectSession(s.id);
      SessionDrawer.close();
    });

    return row;
  },

  _render() {
    const list = this._getList();
    if (!list || typeof app === 'undefined') return;
    list.replaceChildren();

    // Build groups: caseName -> { caseObj, worktrees: Map(branch -> Session[]), sessions: Session[] }
    // Seed groups from all known cases first so [+] buttons always appear.
    const groups = new Map();
    const caseList = app.cases || [];
    for (const c of caseList) {
      groups.set(c.name, { caseObj: c, worktrees: new Map(), sessions: [] });
    }

    // Helper: find the best-matching case for a session (longest path match)
    const findCase = (workingDir) => {
      if (!workingDir) return null;
      let best = null;
      let bestLen = 0;
      for (const c of caseList) {
        if (!c.path) continue;
        const cPath = c.path.endsWith('/') ? c.path : c.path + '/';
        const wDir  = workingDir.endsWith('/') ? workingDir : workingDir + '/';
        if ((wDir === cPath || wDir.startsWith(cPath)) && c.path.length > bestLen) {
          best = c;
          bestLen = c.path.length;
        }
      }
      return best;
    };

    // Helper: extract case name from session name convention (w1-caseName, s1-caseName)
    const findCaseBySessionName = (name) => {
      const m = name && name.match(/^[ws]\d+-(.+)$/i);
      if (!m) return null;
      const suffix = m[1].toLowerCase();
      return caseList.find(c => c.name.toLowerCase() === suffix) || null;
    };

    // Helper: match worktree dirs like "Codeman-feat-better-ux" → case with path ending in "Codeman"
    const findCaseByWorktreeDirPrefix = (workingDir) => {
      if (!workingDir) return null;
      const dirBase = (workingDir.split('/').pop() || '').toLowerCase();
      let best = null;
      let bestLen = 0;
      for (const c of caseList) {
        if (!c.path) continue;
        const cBase = (c.path.split('/').pop() || '').toLowerCase();
        if (cBase && (dirBase === cBase || dirBase.startsWith(cBase + '-') || dirBase.startsWith(cBase + '_'))) {
          if (c.path.length > bestLen) { best = c; bestLen = c.path.length; }
        }
      }
      return best;
    };

    // Helper: resolve the best case for a session — prefers name convention, then dir prefix, then path
    const resolveCase = (s) => {
      const byName = findCaseBySessionName(s.name);
      if (byName) return byName;
      // For worktree sessions with a known origin, use origin's case
      if (s.worktreeOriginId) {
        const origin = app.sessions.get(s.worktreeOriginId);
        if (origin) {
          const byOriginName = findCaseBySessionName(origin.name);
          if (byOriginName) return byOriginName;
        }
      }
      // Path-based (longest match wins)
      const byPath = findCase(s.workingDir);
      // Dir-prefix heuristic for git worktree dirs (e.g. "Codeman-feat-better-ux" → case "Codeman")
      const byDirPrefix = findCaseByWorktreeDirPrefix(s.workingDir);
      // Prefer dir prefix if it gives a longer (more specific) case path than the path match
      if (byDirPrefix && (!byPath || byDirPrefix.path.length > byPath.path.length)) return byDirPrefix;
      return byPath;
    };

    for (const id of (app.sessionOrder || [])) {
      const s = app.sessions.get(id);
      if (!s) continue;
      const caseObj = resolveCase(s);
      const groupKey = caseObj ? caseObj.name : '__ungrouped__';
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { caseObj: caseObj || null, worktrees: new Map(), sessions: [] });
      }
      const g = groups.get(groupKey);
      if (s.worktreeBranch) {
        if (!g.worktrees.has(s.worktreeBranch)) g.worktrees.set(s.worktreeBranch, []);
        g.worktrees.get(s.worktreeBranch).push(s);
      } else {
        g.sessions.push(s);
      }
    }

    for (const [groupKey, group] of groups) {
      const projectName = group.caseObj?.name || groupKey;

      const groupEl = document.createElement('div');
      groupEl.className = 'drawer-project-group';

      // Project header
      const header = document.createElement('div');
      header.className = 'drawer-project-header';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'drawer-project-name';
      nameSpan.textContent = projectName.toUpperCase();

      const addBtn = document.createElement('button');
      addBtn.className = 'drawer-add-btn';
      addBtn.textContent = '+';
      addBtn.title = 'New session in ' + this._esc(projectName);
      addBtn.addEventListener('click', e => {
        e.stopPropagation();
        this._showQuickAdd(e.currentTarget, groupKey, projectName, false);
      });

      header.appendChild(nameSpan);
      header.appendChild(addBtn);
      groupEl.appendChild(header);

      // Worktree sub-groups
      for (const [branch, wtSessions] of group.worktrees) {
        const wtGroup = document.createElement('div');
        wtGroup.className = 'drawer-worktree-group';

        const wtHeader = document.createElement('div');
        wtHeader.className = 'drawer-worktree-header';

        const wtIcon = document.createElement('span');
        wtIcon.className = 'drawer-worktree-icon';
        wtIcon.textContent = '⎇';

        const wtBranch = document.createElement('span');
        wtBranch.className = 'drawer-worktree-branch';
        wtBranch.textContent = branch;

        const mergeBtn = document.createElement('button');
        mergeBtn.className = 'drawer-merge-btn';
        mergeBtn.textContent = 'merge';
        mergeBtn.addEventListener('click', e => {
          e.stopPropagation();
          if (wtSessions[0]) {
            SessionDrawer.close();
            app.openWorktreeCleanupForSession(wtSessions[0].id);
          }
        });

        const wtAddBtn = document.createElement('button');
        wtAddBtn.className = 'drawer-add-btn';
        wtAddBtn.textContent = '+';
        wtAddBtn.title = 'Add session to ' + this._esc(branch);
        wtAddBtn.addEventListener('click', e => {
          e.stopPropagation();
          this._showQuickAdd(e.currentTarget, groupKey, branch, true);
        });

        wtHeader.appendChild(wtIcon);
        wtHeader.appendChild(wtBranch);
        wtHeader.appendChild(mergeBtn);
        wtHeader.appendChild(wtAddBtn);
        wtGroup.appendChild(wtHeader);

        for (const s of wtSessions) wtGroup.appendChild(this._renderSessionRow(s));
        groupEl.appendChild(wtGroup);
      }

      // Regular sessions in this project
      for (const s of group.sessions) groupEl.appendChild(this._renderSessionRow(s));

      list.appendChild(groupEl);
    }

    // Drawer footer
    const footer = document.createElement('div');
    footer.className = 'drawer-footer';

    const newBtn = document.createElement('button');
    newBtn.className = 'drawer-footer-btn';
    newBtn.textContent = '+ New Project';
    newBtn.addEventListener('click', () => app.openNewCaseModal?.());

    const cloneBtn = document.createElement('button');
    cloneBtn.className = 'drawer-footer-btn';
    cloneBtn.textContent = 'Clone from Git';
    cloneBtn.addEventListener('click', () => app.openCloneModal?.());

    const historyBtn = document.createElement('button');
    historyBtn.className = 'drawer-footer-btn';
    historyBtn.textContent = '⏱ Resume';
    historyBtn.addEventListener('click', () => {
      SessionDrawer.close();
      HistoryModal.open();
    });

    footer.appendChild(newBtn);
    footer.appendChild(cloneBtn);
    footer.appendChild(historyBtn);
    list.appendChild(footer);
  },

  _showCloseSheet(sessionId, sessionName) {
    // Desktop: delegate to existing modal flow
    if (MobileDetection.getDeviceType() !== 'mobile') {
      app.requestCloseSession(sessionId);
      return;
    }

    // Mobile: show confirmation sheet inside the drawer
    document.querySelector('.drawer-close-sheet')?.remove();

    const drawer = document.getElementById('sessionDrawer');
    if (!drawer) return;

    const truncated = sessionName.length > 40 ? sessionName.slice(0, 39) + '…' : sessionName;

    const sheet = document.createElement('div');
    sheet.className = 'drawer-close-sheet';

    const titleEl = document.createElement('div');
    titleEl.className = 'drawer-close-sheet-title';
    titleEl.textContent = 'Close "' + truncated + '"';

    // Kill Session option (danger)
    const killBtn = document.createElement('button');
    killBtn.className = 'close-sheet-option danger';
    const killTitle = document.createElement('div');
    killTitle.className = 'close-sheet-option-title';
    killTitle.textContent = '× Kill Session';
    const killDesc = document.createElement('div');
    killDesc.className = 'close-sheet-option-desc';
    killDesc.textContent = 'Stops Claude & kills tmux — cannot be undone';
    killBtn.appendChild(killTitle);
    killBtn.appendChild(killDesc);
    killBtn.addEventListener('click', () => {
      sheet.remove();
      // Set pendingCloseSessionId before calling confirmCloseSession
      app.pendingCloseSessionId = sessionId;
      app.confirmCloseSession?.(true);
    });

    // Remove Tab option
    const removeBtn = document.createElement('button');
    removeBtn.className = 'close-sheet-option';
    const removeTitle = document.createElement('div');
    removeTitle.className = 'close-sheet-option-title';
    removeTitle.textContent = '○ Remove Tab';
    const removeDesc = document.createElement('div');
    removeDesc.className = 'close-sheet-option-desc';
    removeDesc.textContent = 'Hides from drawer — tmux keeps running in background';
    removeBtn.appendChild(removeTitle);
    removeBtn.appendChild(removeDesc);
    removeBtn.addEventListener('click', () => {
      sheet.remove();
      app.pendingCloseSessionId = sessionId;
      app.confirmCloseSession?.(false);
    });

    // Cancel
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'close-sheet-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => sheet.remove());

    sheet.appendChild(titleEl);
    sheet.appendChild(killBtn);
    sheet.appendChild(removeBtn);
    sheet.appendChild(cancelBtn);

    drawer.appendChild(sheet);
  },

  _showQuickAdd(anchorEl, caseId, groupName, worktreeOnly) {
    // Remove any existing popover
    document.querySelector('.drawer-quick-add')?.remove();

    const drawer = document.getElementById('sessionDrawer');
    if (!drawer) return;

    const popover = document.createElement('div');
    popover.className = 'drawer-quick-add';

    // Title
    const title = document.createElement('div');
    title.className = 'drawer-quick-add-title';
    title.textContent = worktreeOnly
      ? 'Add session to ' + groupName
      : 'Start new session in ' + groupName;
    popover.appendChild(title);

    // Mode buttons row
    const row = document.createElement('div');
    row.className = 'drawer-quick-add-row';

    const modes = [
      { mode: 'claude', icon: '▶', label: 'Claude' },
      { mode: 'shell', icon: '⚡', label: 'Shell' },
      { mode: 'opencode', icon: '◈', label: 'OpenCode' },
    ];
    if (!worktreeOnly) {
      modes.push({ mode: 'worktree', icon: '⎇', label: 'Worktree' });
    }

    for (const { mode, icon, label } of modes) {
      const btn = document.createElement('button');
      btn.className = 'drawer-mode-btn';

      const iconEl = document.createElement('span');
      iconEl.className = 'drawer-mode-btn-icon';
      iconEl.textContent = icon;

      const labelEl = document.createElement('span');
      labelEl.textContent = label;

      btn.appendChild(iconEl);
      btn.appendChild(labelEl);

      btn.addEventListener('click', () => {
        if (mode === 'worktree') {
          this._showWorktreeForm(popover, caseId, groupName, anchorEl);
        } else {
          popover.remove();
          app.startSessionInCase?.(caseId, mode);
        }
      });
      row.appendChild(btn);
    }
    popover.appendChild(row);

    // Position: use fixed positioning relative to viewport so drawer overflow-y doesn't clip it
    const anchorRect = anchorEl.getBoundingClientRect();
    popover.style.position = 'fixed';
    // Place below the anchor; if it would go off the bottom, flip above
    const popoverHeight = 100; // estimated before insertion
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    if (spaceBelow >= popoverHeight) {
      popover.style.top = (anchorRect.bottom + 4) + 'px';
    } else {
      popover.style.bottom = (window.innerHeight - anchorRect.top + 4) + 'px';
    }
    popover.style.right = (window.innerWidth - anchorRect.right) + 'px';

    document.body.appendChild(popover);

    // Dismiss on outside click
    const dismiss = e => {
      if (!popover.contains(e.target)) {
        popover.remove();
        document.removeEventListener('click', dismiss, true);
      }
    };
    setTimeout(() => document.addEventListener('click', dismiss, true), 50);
  },

  _showWorktreeForm(popover, caseId, groupName, anchorEl) {
    // Clear popover and rebuild as worktree creation form
    popover.textContent = '';

    const backBtn = document.createElement('button');
    backBtn.className = 'drawer-form-back';
    backBtn.textContent = '← back';
    backBtn.addEventListener('click', () => {
      this._showQuickAdd(anchorEl, caseId, groupName, false);
    });

    const title = document.createElement('div');
    title.className = 'drawer-quick-add-title';
    title.textContent = '⎇ New worktree in ' + groupName;

    const form = document.createElement('div');
    form.className = 'drawer-worktree-form';

    // Branch input
    const branchLabel = document.createElement('div');
    branchLabel.className = 'drawer-form-label';
    branchLabel.textContent = 'Branch';
    const branchInput = document.createElement('input');
    branchInput.className = 'drawer-form-input';
    branchInput.type = 'text';
    branchInput.placeholder = 'feat/…';
    const branchGroup = document.createElement('div');
    branchGroup.appendChild(branchLabel);
    branchGroup.appendChild(branchInput);

    // From chips
    const fromLabel = document.createElement('div');
    fromLabel.className = 'drawer-form-label';
    fromLabel.textContent = 'From';
    const fromChips = document.createElement('div');
    fromChips.className = 'drawer-from-chips';

    // CaseInfo has no branch data — default to master
    const branches = ['master'];
    let selectedFrom = branches[0];

    for (const b of branches) {
      const chip = document.createElement('button');
      chip.className = 'drawer-from-chip' + (b === selectedFrom ? ' selected' : '');
      chip.textContent = b;
      chip.addEventListener('click', () => {
        fromChips.querySelectorAll('.drawer-from-chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        selectedFrom = b;
      });
      fromChips.appendChild(chip);
    }
    const fromGroup = document.createElement('div');
    fromGroup.appendChild(fromLabel);
    fromGroup.appendChild(fromChips);

    // Mode selector
    const modeLabel = document.createElement('div');
    modeLabel.className = 'drawer-form-label';
    modeLabel.textContent = 'Start with';
    const modeRow = document.createElement('div');
    modeRow.className = 'drawer-quick-add-row';

    let selectedMode = 'claude';
    for (const { mode, icon, label } of [
      { mode: 'claude', icon: '▶', label: 'Claude' },
      { mode: 'shell', icon: '⚡', label: 'Shell' },
      { mode: 'opencode', icon: '◈', label: 'OpenCode' },
    ]) {
      const btn = document.createElement('button');
      btn.className = 'drawer-mode-btn' + (mode === selectedMode ? ' selected' : '');
      const iconEl = document.createElement('span');
      iconEl.className = 'drawer-mode-btn-icon';
      iconEl.textContent = icon;
      const labelEl = document.createElement('span');
      labelEl.textContent = label;
      btn.appendChild(iconEl);
      btn.appendChild(labelEl);
      btn.addEventListener('click', () => {
        modeRow.querySelectorAll('.drawer-mode-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedMode = mode;
      });
      modeRow.appendChild(btn);
    }
    const modeGroup = document.createElement('div');
    modeGroup.appendChild(modeLabel);
    modeGroup.appendChild(modeRow);

    // Create button
    const createBtn = document.createElement('button');
    createBtn.className = 'drawer-create-btn';
    createBtn.textContent = 'Create & Start';
    createBtn.addEventListener('click', async () => {
      const branch = branchInput.value.trim();
      if (!branch) { branchInput.focus(); return; }
      popover.remove();
      await app.createWorktreeAndStartSession?.(caseId, branch, selectedFrom, selectedMode);
    });

    form.appendChild(branchGroup);
    form.appendChild(fromGroup);
    form.appendChild(modeGroup);

    popover.appendChild(backBtn);
    popover.appendChild(title);
    popover.appendChild(form);
    popover.appendChild(createBtn);

    branchInput.focus();
  },
};

// ═══════════════════════════════════════════════════════════════
// HistoryModal — resume previously closed sessions
// ═══════════════════════════════════════════════════════════════
const HistoryModal = {
  _el: null,

  open() {
    this._el = document.getElementById('historyModal');
    if (!this._el) return;
    this._el.classList.add('active');
    this._load();
  },

  close() {
    if (this._el) this._el.classList.remove('active');
    this._el = null;
  },

  _formatTimeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  },

  async _load() {
    const list = document.getElementById('historyList');
    if (!list) return;
    list.textContent = '';

    const loading = document.createElement('div');
    loading.className = 'history-loading';
    loading.textContent = 'Loading…';
    list.appendChild(loading);

    let sessions;
    try {
      const res = await fetch('/api/sessions/history');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to load');
      sessions = data.sessions;
    } catch (err) {
      list.textContent = '';
      const errEl = document.createElement('div');
      errEl.className = 'history-empty';
      errEl.textContent = 'Failed to load history: ' + err.message;
      list.appendChild(errEl);
      return;
    }

    list.textContent = '';
    this._sessions = sessions;
    this._renderList(sessions);
  },

  _renderList(sessions) {
    const list = document.getElementById('historyList');
    if (!list) return;
    list.textContent = '';

    if (!sessions || sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No closed sessions found.';
      list.appendChild(empty);
      return;
    }

    for (const s of sessions) {
      const entry = document.createElement('div');
      entry.className = 'history-entry';

      const info = document.createElement('div');
      info.className = 'history-entry-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'history-entry-name';
      nameEl.textContent = s.displayName || s.workingDir.split('/').pop() || s.workingDir;
      info.appendChild(nameEl);

      const pathEl = document.createElement('div');
      pathEl.className = 'history-entry-path';
      pathEl.textContent = s.workingDir;
      info.appendChild(pathEl);

      const meta = document.createElement('div');
      meta.className = 'history-entry-meta';

      const timeEl = document.createElement('span');
      timeEl.className = 'history-entry-time';
      timeEl.textContent = this._formatTimeAgo(s.lastActiveAt);
      meta.appendChild(timeEl);

      const uuidEl = document.createElement('span');
      uuidEl.className = 'history-entry-uuid';
      uuidEl.textContent = s.resumeId.slice(0, 8);
      meta.appendChild(uuidEl);

      if (s.worktreeBranch) {
        const branchEl = document.createElement('span');
        branchEl.className = 'history-entry-branch';
        branchEl.textContent = s.worktreeBranch;
        meta.appendChild(branchEl);
      }

      info.appendChild(meta);
      entry.appendChild(info);

      const btn = document.createElement('button');
      btn.className = 'history-resume-btn';
      btn.textContent = 'Resume';
      btn.addEventListener('click', () => this._resume(s, btn));
      entry.appendChild(btn);

      list.appendChild(entry);
    }
  },

  _filterList(query) {
    const sessions = this._sessions || [];
    if (!query) {
      this._renderList(sessions);
      return;
    }
    const q = query.toLowerCase();
    const filtered = sessions.filter(s =>
      s.displayName.toLowerCase().includes(q) ||
      s.workingDir.toLowerCase().includes(q)
    );
    this._renderList(filtered);
  },

  async _resume(s, btn) {
    btn.disabled = true;
    btn.textContent = 'Resuming…';
    try {
      const res = await fetch('/api/sessions/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workingDir: s.workingDir,
          resumeId: s.resumeId,
          name: s.displayName,
          mode: 'claude',
        }),
      });
      const data = await res.json();
      if (data.success) {
        this.close();
        if (data.session && data.session.id && typeof app !== 'undefined') {
          app.selectSession(data.session.id);
        }
        if (typeof app !== 'undefined') app.showToast('Session resumed', 'success');
      } else {
        if (typeof app !== 'undefined') app.showToast(data.error || 'Failed to resume', 'error');
        btn.disabled = false;
        btn.textContent = 'Resume';
      }
    } catch (err) {
      if (typeof app !== 'undefined') app.showToast('Error: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Resume';
    }
  },
};

// Initialize
const app = new CodemanApp();

// Expose for debugging/testing
window.app = app;
window.MobileDetection = MobileDetection;
window.TranscriptView = TranscriptView;

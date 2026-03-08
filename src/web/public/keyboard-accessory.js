/**
 * @fileoverview Mobile keyboard accessory bar and modal focus trap.
 *
 * Defines two exports:
 *
 * - KeyboardAccessoryBar (singleton object) — Quick action buttons shown above the virtual
 *   keyboard on mobile: arrow up/down, Commands (drawer), paste, copy, and dismiss.
 *   The Commands button opens an upward-sliding drawer containing /init, /clear, /compact,
 *   and user-configured custom commands. Destructive actions (/clear, /compact) require
 *   double-tap confirmation (2s amber state) inside the drawer.
 *   Commands are sent as text + Enter separately for Ink compatibility.
 *   Only initializes on touch devices (MobileDetection.isTouchDevice guard).
 *
 * - FocusTrap (class) — Traps Tab/Shift+Tab keyboard focus within a modal element.
 *   Saves and restores previously focused element on deactivate. Used by Ralph wizard
 *   and other modal dialogs.
 *
 * @globals {object} KeyboardAccessoryBar
 * @globals {class} FocusTrap
 *
 * @dependency mobile-handlers.js (MobileDetection.isTouchDevice)
 * @dependency app.js (uses global `app` for sendInput, activeSessionId, terminal)
 * @loadorder 5 of 9 — loaded after notification-manager.js, before app.js
 */

// Codeman — Keyboard accessory bar and focus trap for modals
// Loaded after mobile-handlers.js, before app.js

// ═══════════════════════════════════════════════════════════════
// Mobile Keyboard Accessory Bar
// ═══════════════════════════════════════════════════════════════

/**
 * KeyboardAccessoryBar - Quick action buttons shown above keyboard when typing.
 */
const KeyboardAccessoryBar = {
  element: null,
  drawerElement: null,
  _searchInput: null,
  _itemsContainer: null,

  /**
   * Known slash commands per session mode.
   * `confirm: true` = destructive, requires double-tap.
   * `noSend: true` = opens a sub-UI in the CLI rather than running inline (show but don't auto-send).
   */
  _CLI_COMMANDS: {
    claude: [
      { cmd: '/clear',           desc: 'Clear conversation history',       confirm: true  },
      { cmd: '/compact',         desc: 'Compact conversation (keep summary)', confirm: true },
      { cmd: '/init',            desc: 'Initialize CLAUDE.md for project'                 },
      { cmd: '/help',            desc: 'Show help'                                         },
      { cmd: '/cost',            desc: 'Token usage & cost'                                },
      { cmd: '/status',          desc: 'Account & API status'                              },
      { cmd: '/model',           desc: 'Set or switch AI model'                            },
      { cmd: '/memory',          desc: 'Edit CLAUDE.md memory files'                       },
      { cmd: '/config',          desc: 'View/edit configuration'                           },
      { cmd: '/permissions',     desc: 'View/update tool permissions'                      },
      { cmd: '/mcp',             desc: 'Manage MCP server connections'                     },
      { cmd: '/add-dir',         desc: 'Add an allowed working directory'                  },
      { cmd: '/doctor',          desc: 'Check installation health'                         },
      { cmd: '/review',          desc: 'Code review (optional PR URL)'                     },
      { cmd: '/vim',             desc: 'Toggle vim key bindings'                           },
      { cmd: '/bug',             desc: 'Report a bug to Anthropic'                         },
      { cmd: '/login',           desc: 'Switch Anthropic accounts'                         },
      { cmd: '/logout',          desc: 'Sign out from Anthropic'                           },
      { cmd: '/terminal',        desc: 'Run a terminal command'                            },
      { cmd: '/pr_comments',     desc: 'View PR comments'                                  },
      { cmd: '/release-notes',   desc: 'View release notes'                                },
    ],
    opencode: [
      { cmd: '/clear',    desc: 'Clear conversation',    confirm: true },
      { cmd: '/compact',  desc: 'Compact conversation',  confirm: true },
      { cmd: '/model',    desc: 'Set model'                            },
      { cmd: '/sessions', desc: 'Browse sessions'                      },
    ],
    shell: [],
  },

  /** Default hotbar button set */
  _defaultButtons: ['tab', 'scroll-up', 'scroll-down', 'commands', 'copy'],

  /** Return the configured button list from saved settings */
  _getButtonConfig() {
    try {
      const isMobile = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() === 'mobile';
      const key = isMobile ? 'codeman-app-settings-mobile' : 'codeman-app-settings';
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      return Array.isArray(saved.hotbarButtons) && saved.hotbarButtons.length > 0
        ? saved.hotbarButtons
        : this._defaultButtons;
    } catch (_e) {
      return this._defaultButtons;
    }
  },

  /** Return custom command buttons from saved settings */
  _getCustomCommands() {
    try {
      const isMobile = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() === 'mobile';
      const key = isMobile ? 'codeman-app-settings-mobile' : 'codeman-app-settings';
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      return Array.isArray(saved.hotbarCustomCommands) ? saved.hotbarCustomCommands : [];
    } catch (_e) {
      return [];
    }
  },

  /** Create and inject the accessory bar */
  init() {
    // Only on mobile
    if (!MobileDetection.isTouchDevice()) return;

    // Create accessory bar element with all possible buttons (hidden by default, shown by config)
    this.element = document.createElement('div');
    this.element.className = 'keyboard-accessory-bar';
    this.element.innerHTML = `
      <button class="accessory-btn" data-action="tab" title="Tab">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12h14M12 5l7 7-7 7"/><line x1="21" y1="5" x2="21" y2="19" stroke-width="2.5"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-up" title="Arrow up">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M5 15l7-7 7 7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-down" title="Arrow down">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-commands" data-action="commands" title="Commands">/ ▲</button>
      <button class="accessory-btn" data-action="paste" title="Paste from clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="copy" title="Copy selected text">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </button>
    `;
    // Show only configured buttons
    const enabled = this._getButtonConfig();
    this.element.querySelectorAll('.accessory-btn[data-action]').forEach(btn => {
      btn.style.display = enabled.includes(btn.dataset.action) ? '' : 'none';
    });

    // Build the commands drawer
    this._buildDrawer();

    // Prevent any button in the bar from stealing focus — this is the key to keeping
    // the keyboard open when tapping accessory buttons on mobile.
    this.element.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    this.element.addEventListener('touchstart', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    }, { passive: false });

    // Click handler for data-action buttons
    this.element.addEventListener('click', (e) => {
      const btn = e.target.closest('.accessory-btn[data-action]');
      if (!btn) return;
      e.stopPropagation();
      this.handleAction(btn.dataset.action, btn);
    });

    // Input panel toggle button (pencil icon)
    if (typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice()) {
      const inputToggleBtn = document.createElement('button');
      inputToggleBtn.className = 'accessory-btn';
      inputToggleBtn.title = 'Compose';
      inputToggleBtn.setAttribute('aria-label', 'Compose');
      inputToggleBtn.type = 'button';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
      svg.setAttribute('aria-hidden', 'true');
      const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path1.setAttribute('d', 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
      const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path2.setAttribute('d', 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z');
      svg.appendChild(path1);
      svg.appendChild(path2);
      inputToggleBtn.appendChild(svg);
      inputToggleBtn.addEventListener('click', () => {
        if (typeof InputPanel !== 'undefined') {
          InputPanel.toggle();
          inputToggleBtn.classList.toggle('active', InputPanel._open);
        }
      });
      this.element.appendChild(inputToggleBtn);
      this._inputToggleBtn = inputToggleBtn;

      // Hamburger (session drawer) button
      const hamburgerBtn = document.createElement('button');
      hamburgerBtn.className = 'accessory-btn';
      hamburgerBtn.title = 'Sessions';
      hamburgerBtn.setAttribute('aria-label', 'Open session list');
      hamburgerBtn.type = 'button';
      const hSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      hSvg.setAttribute('width', '18'); hSvg.setAttribute('height', '18');
      hSvg.setAttribute('viewBox', '0 0 24 24'); hSvg.setAttribute('fill', 'none');
      hSvg.setAttribute('stroke', 'currentColor'); hSvg.setAttribute('stroke-width', '2');
      hSvg.setAttribute('aria-hidden', 'true');
      [6, 12, 18].forEach(y => {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', '3'); line.setAttribute('y1', String(y));
        line.setAttribute('x2', '21'); line.setAttribute('y2', String(y));
        hSvg.appendChild(line);
      });
      hamburgerBtn.appendChild(hSvg);
      hamburgerBtn.addEventListener('click', () => {
        if (typeof SessionDrawer !== 'undefined') SessionDrawer.toggle();
      });
      this.element.appendChild(hamburgerBtn);
    }

    // Insert before toolbar
    const toolbar = document.querySelector('.toolbar');
    if (toolbar && toolbar.parentNode) {
      toolbar.parentNode.insertBefore(this.element, toolbar);
    }

    // Show immediately — bar is always visible on mobile, not keyboard-dependent
    this.show();
  },

  _confirmTimer: null,
  _confirmAction: null,

  /** Handle accessory button actions */
  handleAction(action, btn) {
    if (typeof app === 'undefined' || !app.activeSessionId) return;

    switch (action) {
      case 'tab':
        this.sendKey('\t');
        break;
      case 'scroll-up':
        this.sendKey('\x1b[A');
        break;
      case 'scroll-down':
        this.sendKey('\x1b[B');
        break;
      case 'commands':
        this.openDrawer();
        break;
      case 'paste':
        this.pasteFromClipboard();
        break;
      case 'copy':
        this.copySelection();
        break;
      case 'dismiss':
        // Blur active element to dismiss keyboard
        document.activeElement?.blur();
        break;
      default:
        if (action.startsWith('custom-') && btn?.dataset.command) {
          this.sendCommand(btn.dataset.command);
        }
        break;
    }
  },

  /** Enter confirm state: button turns amber for 2s waiting for second tap */
  setConfirm(action, btn) {
    this.clearConfirm();
    this._confirmAction = action;
    if (btn) {
      btn.classList.add('confirming');
      // Drawer items have a .drawer-cmd-name child; plain hotbar buttons use textContent directly
      const nameEl = btn.querySelector('.drawer-cmd-name');
      if (nameEl) {
        btn.dataset.origText = nameEl.textContent;
        nameEl.textContent = 'Tap again to confirm';
      } else {
        btn.dataset.origText = btn.textContent;
        btn.textContent = 'Tap again';
      }
    }
    this._confirmTimer = setTimeout(() => this.clearConfirm(), 2000);
  },

  /** Reset confirm state */
  clearConfirm() {
    if (this._confirmTimer) {
      clearTimeout(this._confirmTimer);
      this._confirmTimer = null;
    }
    if (this._confirmAction) {
      // Search bar, drawer, and items container for the confirming button
      const containers = [this.element, this._itemsContainer, this.drawerElement].filter(Boolean);
      for (const container of containers) {
        const btn = container.querySelector(`[data-action="${CSS.escape(this._confirmAction)}"]`);
        if (btn) {
          if (btn.dataset.origText) {
            const nameEl = btn.querySelector('.drawer-cmd-name');
            if (nameEl) {
              nameEl.textContent = btn.dataset.origText;
            } else {
              btn.textContent = btn.dataset.origText;
            }
            delete btn.dataset.origText;
          }
          btn.classList.remove('confirming');
        }
      }
    }
    this._confirmAction = null;
  },

  /** Build the commands drawer shell (search input + items container + delegated click handler).
   *  Items are populated dynamically per session on each open via _populateDrawer(). */
  _buildDrawer() {
    const drawer = document.createElement('div');
    drawer.className = 'accessory-cmd-drawer';
    this.drawerElement = drawer;

    // Search input — focusing re-opens the keyboard on Android when the drawer opens.
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'accessory-cmd-search';
    searchInput.placeholder = 'Search commands…';
    searchInput.setAttribute('autocomplete', 'off');
    searchInput.setAttribute('autocorrect', 'off');
    searchInput.setAttribute('autocapitalize', 'none');
    searchInput.setAttribute('spellcheck', 'false');
    drawer.appendChild(searchInput);
    this._searchInput = searchInput;

    // Container for dynamically generated command items
    const items = document.createElement('div');
    items.className = 'accessory-cmd-items';
    drawer.appendChild(items);
    this._itemsContainer = items;

    // Filter: search both command name and description (stored in data-desc)
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      items.querySelectorAll('.accessory-drawer-item').forEach((btn) => {
        const match = btn.dataset.cmd.includes(q) || (btn.dataset.desc || '').toLowerCase().includes(q);
        btn.style.display = match ? '' : 'none';
      });
    });

    // Enter sends the first visible command
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = items.querySelector('.accessory-drawer-item:not([style*="none"])');
        if (first) first.click();
      }
    });

    // Delegated click handler for all items (works for dynamically added items too)
    items.addEventListener('click', (e) => {
      const btn = e.target.closest('.accessory-drawer-item');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const cmd = btn.dataset.cmd;
      const action = btn.dataset.action; // stable key for confirm tracking
      if (btn.dataset.confirm === 'true') {
        if (this._confirmAction === action && this._confirmTimer) {
          this.clearConfirm();
          this.closeDrawer();
          this.sendCommand(cmd);
        } else {
          this.setConfirm(action, btn);
        }
      } else {
        this.closeDrawer();
        this.sendCommand(cmd);
      }
    });

    this.element.appendChild(drawer);
  },

  /** Populate the items container based on the active session's CLI type.
   *  Called each time the drawer opens so it always reflects the current pane. */
  _populateDrawer() {
    if (!this._itemsContainer) return;
    this._itemsContainer.replaceChildren(); // clear previous items

    const mode = (typeof app !== 'undefined' && app.activeSessionId)
      ? (app.sessions?.get(app.activeSessionId)?.mode ?? 'claude')
      : 'claude';

    const cliCmds = this._CLI_COMMANDS[mode] ?? [];

    // Add CLI commands
    for (const { cmd, desc, confirm } of cliCmds) {
      const btn = document.createElement('button');
      btn.className = 'accessory-drawer-item';
      btn.dataset.cmd = cmd;
      btn.dataset.action = cmd; // stable key for confirm tracking
      btn.dataset.desc = desc;
      if (confirm) btn.dataset.confirm = 'true';

      const nameEl = document.createElement('span');
      nameEl.className = 'drawer-cmd-name';
      nameEl.textContent = cmd;
      const descEl = document.createElement('span');
      descEl.className = 'drawer-cmd-desc';
      descEl.textContent = desc;
      btn.appendChild(nameEl);
      btn.appendChild(descEl);
      this._itemsContainer.appendChild(btn);
    }

    // Separator before custom commands (only if both lists are non-empty)
    const customCmds = this._getCustomCommands();
    if (cliCmds.length > 0 && customCmds.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'accessory-drawer-sep';
      this._itemsContainer.appendChild(sep);
    }

    // Add custom commands from settings
    customCmds.forEach((custom) => {
      const btn = document.createElement('button');
      btn.className = 'accessory-drawer-item';
      btn.dataset.cmd = custom.command;
      btn.dataset.action = `custom:${custom.command}`;
      btn.dataset.desc = custom.label || '';

      const nameEl = document.createElement('span');
      nameEl.className = 'drawer-cmd-name';
      nameEl.textContent = custom.label || custom.command;
      const descEl = document.createElement('span');
      descEl.className = 'drawer-cmd-desc';
      descEl.textContent = custom.command;
      btn.appendChild(nameEl);
      btn.appendChild(descEl);
      this._itemsContainer.appendChild(btn);
    });

    // Dynamic commands from plugins/GSD fetched on session connect
    const dynamicCmds = (typeof app !== 'undefined' && app.activeSessionId)
      ? (app._sessionCommands?.get(app.activeSessionId) ?? [])
      : [];

    if (dynamicCmds.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'accessory-drawer-sep';
      const sepLabel = document.createElement('span');
      sepLabel.className = 'accessory-drawer-sep-label';
      sepLabel.textContent = 'Plugins & Skills';
      sep.appendChild(sepLabel);
      this._itemsContainer.appendChild(sep);

      for (const { cmd, desc } of dynamicCmds) {
        const btn = document.createElement('button');
        btn.className = 'accessory-drawer-item';
        btn.dataset.cmd = cmd;
        btn.dataset.action = cmd;
        btn.dataset.desc = desc;

        const nameEl = document.createElement('span');
        nameEl.className = 'drawer-cmd-name';
        nameEl.textContent = cmd;

        const descEl = document.createElement('span');
        descEl.className = 'drawer-cmd-desc';
        descEl.textContent = desc;

        btn.appendChild(nameEl);
        btn.appendChild(descEl);
        this._itemsContainer.appendChild(btn);
      }
    }
  },

  /** Open the commands drawer, populating it for the current session */
  openDrawer() {
    if (!this.drawerElement) return;

    // Populate items for the active session's CLI type
    this._populateDrawer();

    this.drawerElement.classList.add('open');

    // Reset search and focus input to re-open keyboard on Android
    if (this._searchInput) {
      this._searchInput.value = '';
      setTimeout(() => this._searchInput?.focus(), 80);
    }

    // Register outside-tap close. Use 200ms delay so the opening tap (and its
    // associated touchstart/click propagation) finishes before we listen.
    const handler = (e) => {
      if (!this.drawerElement?.contains(e.target) &&
          !e.target.closest('[data-action="commands"]')) {
        this.closeDrawer();
      }
    };
    setTimeout(() => document.addEventListener('touchstart', handler, { once: true }), 200);
    setTimeout(() => document.addEventListener('click', handler, { once: true }), 200);
  },

  /** Close the commands drawer and reset confirm state */
  closeDrawer() {
    this.drawerElement?.classList.remove('open');
    if (this._searchInput) this._searchInput.value = '';
    this.clearConfirm();
  },

  /** Send a slash command to the active session.
   *  Sends text and Enter separately so Ink processes them as distinct events. */
  sendCommand(command) {
    if (!app.activeSessionId) return;
    // Send command text first (without Enter)
    app.sendInput(command);
    // Send Enter separately after a brief delay so Ink has time to process the text.
    setTimeout(() => app.sendInput('\r'), 120);
  },

  /** Send a special key (arrow, escape, etc.) directly to the PTY.
   *  Bypasses tmux send-keys -l (literal mode) since escape sequences
   *  must be written raw to be interpreted as key presses by Ink. */
  sendKey(escapeSequence) {
    if (!app.activeSessionId) return;
    fetch(`/api/sessions/${app.activeSessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: escapeSequence })
    }).catch(() => {});
  },

  /** Read clipboard and send contents as input */
  /** Show a paste overlay with a textarea for iOS compatibility */
  pasteFromClipboard() {
    if (typeof app === 'undefined' || !app.activeSessionId) return;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'paste-overlay';
    overlay.innerHTML = `
      <div class="paste-dialog">
        <textarea class="paste-textarea" placeholder="Long-press here and tap Paste"></textarea>
        <div class="paste-actions">
          <button class="paste-cancel">Cancel</button>
          <button class="paste-send">Send</button>
        </div>
      </div>
    `;

    const textarea = overlay.querySelector('.paste-textarea');
    const send = () => {
      const text = textarea.value;
      overlay.remove();
      if (text) app.sendInput(text);
    };
    overlay.querySelector('.paste-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.paste-send').addEventListener('click', send);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.body.appendChild(overlay);
    textarea.focus();
  },

  /** Copy selected terminal text to clipboard */
  copySelection() {
    if (typeof app === 'undefined') return;
    const selection = app.terminal?.getSelection?.();
    if (selection) {
      navigator.clipboard.writeText(selection).then(() => {
        app.showToast('Copied', 'success');
      }).catch(() => {
        app.showToast('Copy failed', 'error');
      });
    } else {
      app.showToast('No text selected', 'warning');
    }
  },

  /** Show the accessory bar */
  show() {
    if (this.element) {
      this.element.classList.add('visible');
    }
  },

  /** Hide the accessory bar */
  hide() {
    if (this.element) {
      this.element.classList.remove('visible');
    }
  },

  /** Sync the compose button active state */
  setComposeActive(active) {
    if (this._inputToggleBtn) this._inputToggleBtn.classList.toggle('active', active);
  }
};

// Expose a static-style instance reference so InputPanel can call
// KeyboardAccessoryBar.instance.setComposeActive() without needing a separate variable.
KeyboardAccessoryBar.instance = KeyboardAccessoryBar;

// ═══════════════════════════════════════════════════════════════
// Accessibility: Focus Trap for Modals
// ═══════════════════════════════════════════════════════════════

/**
 * FocusTrap - Traps keyboard focus within an element (typically a modal).
 * Saves the previously focused element and restores focus when deactivated.
 */
class FocusTrap {
  constructor(element) {
    this.element = element;
    this.previouslyFocused = null;
    this.boundHandleKeydown = this.handleKeydown.bind(this);
  }

  activate() {
    this.previouslyFocused = document.activeElement;
    this.element.addEventListener('keydown', this.boundHandleKeydown);

    // Focus first focusable element after a brief delay (for CSS transitions)
    requestAnimationFrame(() => {
      const focusable = this.getFocusableElements();
      if (focusable.length) {
        focusable[0].focus();
      }
    });
  }

  deactivate() {
    this.element.removeEventListener('keydown', this.boundHandleKeydown);
    if (this.previouslyFocused && typeof this.previouslyFocused.focus === 'function') {
      this.previouslyFocused.focus();
    }
  }

  getFocusableElements() {
    const selector = [
      'button:not([disabled]):not([tabindex="-1"])',
      'input:not([disabled]):not([tabindex="-1"])',
      'select:not([disabled]):not([tabindex="-1"])',
      'textarea:not([disabled]):not([tabindex="-1"])',
      'a[href]:not([tabindex="-1"])',
      '[tabindex]:not([tabindex="-1"]):not([disabled])'
    ].join(', ');

    return [...this.element.querySelectorAll(selector)].filter(
      el => el.offsetParent !== null // Exclude hidden elements
    );
  }

  handleKeydown(e) {
    if (e.key !== 'Tab') return;

    const focusable = this.getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

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

  /** Default hotbar button set */
  _defaultButtons: ['scroll-up', 'scroll-down', 'commands', 'paste', 'copy', 'dismiss'],

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
      <button class="accessory-btn accessory-btn-dismiss" data-action="dismiss" title="Dismiss keyboard">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M19 9l-7 7-7-7"/>
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

    // Add click handlers — preventDefault stops event from reaching terminal
    this.element.addEventListener('click', (e) => {
      const btn = e.target.closest('.accessory-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const action = btn.dataset.action;
      this.handleAction(action, btn);

      // Refocus terminal so keyboard stays open (tap blurs terminal → keyboard dismisses → toolbar shifts)
      if (action === 'scroll-up' || action === 'scroll-down') {
        if (typeof app !== 'undefined' && app.terminal) {
          app.terminal.focus();
        }
      }
    });

    // Insert before toolbar
    const toolbar = document.querySelector('.toolbar');
    if (toolbar && toolbar.parentNode) {
      toolbar.parentNode.insertBefore(this.element, toolbar);
    }
  },

  _confirmTimer: null,
  _confirmAction: null,

  /** Handle accessory button actions */
  handleAction(action, btn) {
    if (typeof app === 'undefined' || !app.activeSessionId) return;

    switch (action) {
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
      btn.dataset.origText = btn.textContent;
      btn.textContent = 'Tap again';
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
      // Search both the bar and the drawer for the confirming button
      const containers = [this.element, this.drawerElement].filter(Boolean);
      for (const container of containers) {
        const btn = container.querySelector(`[data-action="${this._confirmAction}"]`);
        if (btn) {
          if (btn.dataset.origText) {
            btn.textContent = btn.dataset.origText;
            delete btn.dataset.origText;
          }
          btn.classList.remove('confirming');
        }
      }
    }
    this._confirmAction = null;
  },

  /** Build the commands drawer and append to the accessory bar element */
  _buildDrawer() {
    const drawer = document.createElement('div');
    drawer.className = 'accessory-cmd-drawer';
    this.drawerElement = drawer;

    // Search input — focusing this re-opens the keyboard on Android when the
    // drawer opens, and lets users filter commands by typing.
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

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      drawer.querySelectorAll('.accessory-drawer-item').forEach((btn) => {
        btn.style.display = btn.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
    // Enter on search input sends the first visible command
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = drawer.querySelector('.accessory-drawer-item:not([style*="none"])');
        if (first) first.click();
      }
    });

    // Fixed commands: /init, /clear, /compact
    const fixed = [
      { action: 'init', label: '/init' },
      { action: 'clear', label: '/clear' },
      { action: 'compact', label: '/compact' },
    ];
    for (const { action, label } of fixed) {
      const btn = document.createElement('button');
      btn.className = 'accessory-drawer-item';
      btn.dataset.action = action;
      btn.textContent = label;
      drawer.appendChild(btn);
    }

    // Custom commands from settings
    const customCmds = this._getCustomCommands();
    customCmds.forEach((cmd, i) => {
      const btn = document.createElement('button');
      btn.className = 'accessory-drawer-item';
      btn.dataset.action = `custom-${i}`;
      btn.dataset.command = cmd.command;
      btn.textContent = cmd.label || cmd.command;
      btn.title = cmd.command;
      drawer.appendChild(btn);
    });

    // Drawer click handler
    drawer.addEventListener('click', (e) => {
      const btn = e.target.closest('.accessory-drawer-item');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const action = btn.dataset.action;
      if (action === 'clear' || action === 'compact') {
        const cmd = action === 'clear' ? '/clear' : '/compact';
        if (this._confirmAction === action && this._confirmTimer) {
          this.clearConfirm();
          this.closeDrawer();
          this.sendCommand(cmd);
        } else {
          this.setConfirm(action, btn);
        }
      } else if (action === 'init') {
        this.closeDrawer();
        this.sendCommand('/init');
      } else if (action.startsWith('custom-') && btn.dataset.command) {
        this.closeDrawer();
        this.sendCommand(btn.dataset.command);
      }
    });

    this.element.appendChild(drawer);
  },

  /** Open the commands drawer */
  openDrawer() {
    if (!this.drawerElement) return;
    this.drawerElement.classList.add('open');

    // Reset filter and show all items
    if (this._searchInput) {
      this._searchInput.value = '';
      this.drawerElement.querySelectorAll('.accessory-drawer-item').forEach((btn) => {
        btn.style.display = '';
      });
      // Focus search input — re-opens the keyboard on Android so the drawer stays visible.
      // Delay slightly to let the drawer's CSS transition start before focus triggers layout.
      setTimeout(() => this._searchInput?.focus(), 80);
    }

    // Register outside-tap close with a long enough delay that the tap opening the
    // drawer (and any associated touchstart/click) has fully completed first.
    // Android needs more time than iOS here.
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
  }
};

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

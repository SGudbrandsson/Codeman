/**
 * Terminal Copy — copying text straight out of the terminal buffer.
 *
 * Three layers, cheapest first:
 *
 *  1. `attachSelection()` — selecting in the buffer itself. On desktop that is
 *     xterm's own drag selection: Ctrl/Cmd+C copies it (falling through to the
 *     PTY as SIGINT when nothing is selected) and a floating chip appears so
 *     the shortcut is discoverable. On touch, `body.touch-device` CSS re-enables
 *     native selection over the DOM-rendered rows, so a long-press gives the OS
 *     selection handles and its own Copy callout.
 *  2. `getText()` / `copyText()` — buffer → plain text, with an execCommand
 *     clipboard fallback for plain-HTTP origins.
 *  3. `open()` — the overlay: the whole buffer in a plain <textarea>, for
 *     grabbing more scrollback than fits on one screen (native selection only
 *     reaches the rows xterm currently has in the DOM).
 *
 * Overlay entry points: overflow menu item, Ctrl/Cmd+Shift+X, and the mobile
 * keyboard accessory copy button when there is no selection to copy.
 */
const TerminalCopy = {
  _overlay: null,
  _textarea: null,
  _escHandler: null,
  _scope: 'all', // 'all' | 'screen'

  _chip: null,
  _chipHideTimer: null,
  _hint: null,
  _hintTimer: null,
  _hintShownAt: 0,
  _selectionRaf: 0,

  /**
   * Wire the in-buffer copy affordances onto the main terminal.
   *
   * Returns the xterm disposable for the selection listener so the caller can
   * register it for teardown alongside its other terminal disposables.
   */
  attachSelection(terminal) {
    if (!terminal || typeof terminal.onSelectionChange !== 'function') return null;
    this._ensureChip();
    this._installShiftHint(terminal);
    // onSelectionChange fires per cell during a drag — coalesce to one frame.
    return terminal.onSelectionChange(() => {
      if (this._selectionRaf) return;
      this._selectionRaf = requestAnimationFrame(() => {
        this._selectionRaf = 0;
        this._syncChip(terminal);
      });
    });
  },

  /**
   * Claude Code's TUI turns on mouse reporting, so a plain drag is forwarded to
   * the app and selects nothing — the user just sees the terminal ignore them.
   * xterm honours Shift as a force-selection modifier; nobody knows that, so
   * say it the moment a plain drag is about to come up empty.
   */
  _installShiftHint(terminal) {
    const container = document.getElementById('terminalContainer');
    if (!container || container._tselHintInstalled) return;
    container._tselHintInstalled = true;

    let downX = 0;
    let downY = 0;
    let armed = false;

    container.addEventListener('mousedown', (e) => {
      const tracking = terminal.modes?.mouseTrackingMode;
      armed = e.button === 0 && !e.shiftKey && !!tracking && tracking !== 'none';
      downX = e.clientX;
      downY = e.clientY;
    }, true);

    container.addEventListener('mousemove', (e) => {
      if (!armed || !(e.buttons & 1)) return;
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) < 24) return;
      armed = false;
      this._showShiftHint(e.clientX, e.clientY);
    }, true);
  },

  _HINT_COOLDOWN_MS: 30000,

  _showShiftHint(clientX, clientY) {
    const now = Date.now();
    if (this._hintShownAt && now - this._hintShownAt < this._HINT_COOLDOWN_MS) return;
    this._hintShownAt = now;
    const container = document.getElementById('terminalContainer');
    if (!container) return;
    let hint = this._hint;
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'tsel-hint';
      hint.textContent = 'Hold \u21e7 Shift to select text';
      container.appendChild(hint);
      this._hint = hint;
    }
    hint.hidden = false;
    // Show it where the drag is happening rather than in a fixed corner, so it
    // lands in the user's field of view and covers as little output as possible.
    const box = container.getBoundingClientRect();
    const w = hint.offsetWidth || 180;
    const h = hint.offsetHeight || 26;
    const x = Math.min(Math.max(clientX - box.left + 14, 4), Math.max(box.width - w - 4, 4));
    const y = Math.min(Math.max(clientY - box.top + 18, 4), Math.max(box.height - h - 4, 4));
    hint.style.left = x + 'px';
    hint.style.top = y + 'px';
    if (this._hintTimer) clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => {
      hint.hidden = true;
      this._hintTimer = null;
    }, 2600);
  },

  /** The chip is a discoverability aid for Ctrl/Cmd+C, not the only way to copy. */
  _ensureChip() {
    if (this._chip) return this._chip;
    const container = document.getElementById('terminalContainer');
    if (!container) return null;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tsel-chip';
    chip.hidden = true;
    chip.textContent = 'Copy selection';
    chip.addEventListener('mousedown', (e) => {
      // Keep the mousedown from clearing the selection before we read it.
      e.preventDefault();
      e.stopPropagation();
    });
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.copySelection();
    });
    container.appendChild(chip);
    this._chip = chip;
    return chip;
  },

  _syncChip(terminal) {
    const chip = this._chip || this._ensureChip();
    if (!chip) return;
    const hasSelection = !!terminal.getSelection?.();
    if (!hasSelection) {
      chip.hidden = true;
      chip.classList.remove('copied');
      chip.textContent = 'Copy selection';
      return;
    }
    if (chip.hidden) {
      chip.hidden = false;
      chip.classList.remove('copied');
      chip.textContent = 'Copy selection';
    }
  },

  /**
   * Copy whatever is selected in the terminal — xterm's own selection first,
   * then a native DOM selection inside the terminal (touch long-press).
   * @returns {Promise<boolean>} whether anything was copied
   */
  async copySelection() {
    const text = this.getSelectionText();
    if (!text) return false;
    if (typeof FeatureTracker !== 'undefined') FeatureTracker.track('terminal-copy-selection');
    const ok = await this.copyText(text);
    const chip = this._chip;
    if (ok && chip && !chip.hidden) {
      chip.classList.add('copied');
      chip.textContent = '\u2713 Copied';
      if (this._chipHideTimer) clearTimeout(this._chipHideTimer);
      this._chipHideTimer = setTimeout(() => {
        chip.hidden = true;
        chip.classList.remove('copied');
        chip.textContent = 'Copy selection';
        this._chipHideTimer = null;
      }, 1200);
    }
    if (ok) window.app?.showToast?.('Copied', 'success');
    else window.app?.showToast?.('Copy blocked \u2014 use the copy panel instead', 'error');
    return ok;
  },

  /** The current terminal selection, xterm's or a native one over the rows. */
  getSelectionText() {
    const xtermSel = window.app?.terminal?.getSelection?.();
    if (xtermSel) return xtermSel;
    return this.getNativeSelectionText();
  },

  /**
   * A native DOM selection that lies inside the terminal. On touch devices the
   * rows are selectable text, so a long-press produces a real browser selection
   * that xterm knows nothing about.
   */
  getNativeSelectionText() {
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    const container = document.getElementById('terminalContainer');
    if (!container) return '';
    const node = sel.anchorNode;
    const el = node && node.nodeType === 1 ? node : node?.parentElement;
    if (!el || !container.contains(el)) return '';
    return sel.toString();
  },

  /** True when the terminal holds a selection of either kind. */
  hasSelection() {
    return !!this.getSelectionText();
  },

  /** True when the overlay is on screen. */
  isOpen() {
    return !!this._overlay;
  },

  /**
   * Extract plain text from the active xterm buffer.
   * @param {'all'|'screen'} scope
   * @returns {string}
   */
  getText(scope = 'all') {
    const term = window.app?.terminal;
    const buf = term?.buffer?.active;
    if (!buf) return '';

    let start;
    let end;
    if (scope === 'screen') {
      start = buf.viewportY;
      end = Math.min(buf.viewportY + term.rows, buf.length);
    } else {
      start = 0;
      end = buf.length;
    }

    const lines = [];
    let current = '';
    let started = false;
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      // isWrapped marks a row that continues the previous one — join them so
      // long commands and paths come out as a single copyable line.
      if (line.isWrapped && started) {
        current += text;
      } else {
        if (started) lines.push(current);
        current = text;
        started = true;
      }
    }
    if (started) lines.push(current);

    // Joined wrapped rows can carry mid-line padding; trim the tail of each.
    for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\s+$/, '');

    // Drop the trailing run of blank lines the screen always carries.
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n');
  },

  /**
   * Copy text to the clipboard, falling back to execCommand on the plain-HTTP
   * LAN/tailscale origins where the async clipboard API is unavailable.
   * @returns {Promise<boolean>} whether the copy succeeded
   */
  async copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to execCommand */
    }
    return this._execCopy(text);
  },

  /** execCommand fallback, including the iOS contenteditable dance. */
  _execCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    let ok = false;
    try {
      const isIOS = /iP(ad|hone|od)/.test(navigator.userAgent);
      if (isIOS) {
        // iOS Safari refuses to select a readonly textarea programmatically.
        ta.contentEditable = 'true';
        ta.readOnly = false;
        const range = document.createRange();
        range.selectNodeContents(ta);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ta.setSelectionRange(0, text.length);
      } else {
        ta.select();
      }
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  },

  /** Open the copy overlay. */
  open(scope) {
    if (typeof FeatureTracker !== 'undefined') FeatureTracker.track('terminal-copy-open');
    if (this._overlay) {
      if (scope) this.setScope(scope);
      return;
    }
    if (!window.app?.terminal) {
      window.app?.showToast?.('No terminal to copy from', 'warning');
      return;
    }
    if (scope) this._scope = scope;

    const overlay = document.createElement('div');
    overlay.className = 'tcopy-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Copy terminal text');
    overlay.innerHTML = `
      <div class="tcopy-backdrop"></div>
      <div class="tcopy-box">
        <div class="tcopy-header">
          <span class="tcopy-title">Copy terminal text</span>
          <div class="tcopy-scope" role="group" aria-label="How much to include">
            <button type="button" class="tcopy-scope-btn" data-scope="screen">Screen</button>
            <button type="button" class="tcopy-scope-btn" data-scope="all">All</button>
          </div>
          <button type="button" class="tcopy-close" aria-label="Close">&times;</button>
        </div>
        <textarea class="tcopy-text" readonly spellcheck="false" autocapitalize="off"
                  autocorrect="off" aria-label="Terminal text"></textarea>
        <div class="tcopy-actions">
          <span class="tcopy-hint">Select any part by hand, or:</span>
          <button type="button" class="tcopy-btn tcopy-copy-all">Copy all</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this._overlay = overlay;
    this._textarea = overlay.querySelector('.tcopy-text');

    overlay.querySelector('.tcopy-backdrop').addEventListener('click', () => this.close());
    overlay.querySelector('.tcopy-close').addEventListener('click', () => this.close());
    overlay.querySelectorAll('.tcopy-scope-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.setScope(btn.dataset.scope));
    });
    overlay.querySelector('.tcopy-copy-all').addEventListener('click', (e) => {
      this._copyAll(e.currentTarget);
    });
    // Keep Escape from reaching the terminal / other global handlers, whether
    // or not focus is still inside the overlay.
    this._escHandler = (e) => {
      if (e.key !== 'Escape' || !this._overlay) return;
      e.stopPropagation();
      e.preventDefault();
      this.close();
    };
    document.addEventListener('keydown', this._escHandler, true);

    this._render();
    // Focus the textarea but leave the caret at the top rather than selecting
    // everything — a full selection makes hand-selecting a fragment awkward.
    this._textarea.focus({ preventScroll: true });
    this._textarea.setSelectionRange(0, 0);
    this._textarea.scrollTop = this._textarea.scrollHeight;
  },

  /** Switch between screen-only and full-scrollback text. */
  setScope(scope) {
    if (scope !== 'all' && scope !== 'screen') return;
    this._scope = scope;
    this._render();
  },

  _render() {
    if (!this._overlay || !this._textarea) return;
    const text = this.getText(this._scope);
    this._textarea.value = text;
    this._overlay.querySelectorAll('.tcopy-scope-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scope === this._scope);
    });
    const hint = this._overlay.querySelector('.tcopy-hint');
    if (hint) {
      const lines = text ? text.split('\n').length : 0;
      hint.textContent = lines
        ? `${lines} line${lines === 1 ? '' : 's'} — select by hand, or:`
        : 'Terminal is empty';
    }
  },

  async _copyAll(btn) {
    const text = this._textarea ? this._textarea.value : '';
    if (!text) {
      window.app?.showToast?.('Nothing to copy', 'warning');
      return;
    }
    if (typeof FeatureTracker !== 'undefined') FeatureTracker.track('terminal-copy-copy-all');
    const ok = await this.copyText(text);
    if (ok) {
      if (btn) {
        if (btn._resetTimer) clearTimeout(btn._resetTimer);
        if (btn._label === undefined) btn._label = btn.textContent;
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        btn._resetTimer = setTimeout(() => {
          btn.textContent = btn._label;
          btn.classList.remove('copied');
          btn._resetTimer = null;
        }, 2000);
      }
      window.app?.showToast?.('Copied to clipboard', 'success');
    } else {
      window.app?.showToast?.('Copy blocked — select the text and copy manually', 'error');
    }
  },

  close() {
    if (!this._overlay) return;
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler, true);
      this._escHandler = null;
    }
    this._overlay.remove();
    this._overlay = null;
    this._textarea = null;
    try {
      window.app?.terminal?.focus?.();
    } catch {
      /* terminal may be gone */
    }
  },

  toggle() {
    if (this._overlay) this.close();
    else this.open();
  },
};

window.TerminalCopy = TerminalCopy;

/**
 * Terminal Copy — a selectable plain-text view of the terminal buffer.
 *
 * xterm.js selection only works with a mouse drag, and even on desktop it is
 * fighting tmux mouse mode in split layouts. On touch devices there is no way
 * to select terminal text at all, so shell sessions were effectively
 * copy-proof. This module renders the terminal buffer (scrollback + screen)
 * into a plain <textarea> the OS knows how to select from, plus one-tap
 * "copy everything" / "copy screen" buttons.
 *
 * Entry points: overflow menu item, Ctrl/Cmd+Shift+X, and the mobile keyboard
 * accessory copy button when there is no xterm selection to copy.
 */
const TerminalCopy = {
  _overlay: null,
  _textarea: null,
  _escHandler: null,
  _scope: 'all', // 'all' | 'screen'

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

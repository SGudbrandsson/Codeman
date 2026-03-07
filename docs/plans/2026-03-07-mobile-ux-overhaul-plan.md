# Mobile UX Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Four-phase mobile UX improvement: fix terminal buffer scroll animation, pin GSD status line, add session navigation drawer, fix keyboard layout jump, add persistent input toggle, and add dynamic plugin command discovery.

**Architecture:** All four phases are frontend-only except Phase 4 (dynamic commands), which adds one backend API endpoint. No new files needed for Phases 1-3 — all changes are in existing `app.js`, `mobile-handlers.js`, `keyboard-accessory.js`, `index.html`, and CSS files. Phase 4 adds a route handler in the backend.

**Tech Stack:** xterm.js (buffer API, scrollToBottom), Fastify (backend route), plain JS (no framework), CSS transitions for drawer/panel animations.

---

## Context for Implementer

- `app.js` is ~11,800 lines. Read `@fileoverview` at the top and use line numbers from this plan — don't scan the whole file.
- `chunkedTerminalWrite()` is at line ~1508. It writes the session buffer in 32KB chunks across `requestAnimationFrame` calls when buffer > chunk size. `_isLoadingBuffer` flag (line 1496) is already set during load — this is the hook for the scroll fix.
- `selectSession()` is at line 3529. This is where session switching happens. Buffer load occurs inside here.
- `flushPendingWrites()` is at line ~1395. This is where live terminal data is written. Use xterm.js buffer API after writes here for status line detection.
- `KeyboardAccessoryBar._populateDrawer()` is at `keyboard-accessory.js:336`. This is where the Commands drawer is built.
- `resetLayout()` is at `mobile-handlers.js:281`. This is where keyboard-hide causes layout jumps.
- Do **not** run `npx vitest run` without a specific file — it kills tmux. Only run individual test files.
- Production port is **3001**, not 3000. Service is `codeman-web` at `~/.codeman/app`.
- After any frontend change: deploy with `npm run build && cp -r dist ~/.codeman/app/ && cp package.json ~/.codeman/app/ && systemctl --user restart codeman-web`. Then hard-refresh (Ctrl+Shift+R) in browser.
- **Security:** Never use `innerHTML` with session or user data. Use `textContent` for text, DOM methods (`createElement`, `appendChild`) for structure.

---

## Phase 1: Terminal Content Fidelity

### Task 1.1: Fix terminal buffer scroll animation on session switch

**Problem:** `chunkedTerminalWrite()` writes buffer in chunks across animation frames. xterm.js auto-scrolls to bottom after each chunk (viewport is "pinned at bottom"). User sees hundreds of lines animate past.

**Fix:** Hide the terminal container visually during buffer load. The user sees nothing during the write, then the terminal snaps into view already at the bottom.

**Files:**
- Modify: `src/web/public/app.js` (lines ~3674-3709 in `selectSession`, lines ~1864-1876 in `_onSessionNeedsRefresh`)
- Modify: `src/web/public/styles.css` (add `buffer-loading` class)

**Step 1: Add CSS class to suppress terminal visibility during load**

In `styles.css`, find the `.terminal-container` rule and add a companion rule:

```css
.terminal-container.buffer-loading {
  visibility: hidden;
}
```

**Step 2: Hide terminal at start of buffer write, restore after**

In `app.js`, find the two places where `chunkedTerminalWrite` is called in `selectSession` (lines ~3678 and ~3705). Both follow this pattern:
```javascript
this.terminal.clear();
this.terminal.reset();
await this.chunkedTerminalWrite(...);
this.terminal.scrollToBottom();
```

Before each `terminal.clear()`, get the container and add the class. After `scrollToBottom()`, remove it. Wrap in a `requestAnimationFrame` so the browser commits the hidden state before writes begin.

Example for the `cachedBuffer` path (around line 3676):

```javascript
const termContainer = document.getElementById('terminalContainer');
termContainer?.classList.add('buffer-loading');
// Use rAF to ensure hidden state is painted before writes start
await new Promise(resolve => requestAnimationFrame(resolve));
this.terminal.clear();
this.terminal.reset();
await this.chunkedTerminalWrite(cachedBuffer);
if (selectGen !== this._selectGeneration) { ... return; }
this.terminal.scrollToBottom();
termContainer?.classList.remove('buffer-loading');
```

Do the same for the `needsRewrite` path at line ~3696. Also apply to `_onSessionNeedsRefresh()` at line ~1873.

**Step 3: Verify**

Start dev server: `npx tsx src/index.ts web --port 3000`

Open browser, start two Claude sessions with long histories. Switch between them rapidly. Verify: terminal never shows scroll animation — it appears instantly at the bottom. No blank flash between sessions.

**Step 4: Commit**

```bash
git add src/web/public/app.js src/web/public/styles.css
git commit -m "fix: suppress terminal scroll animation during buffer load"
```

---

### Task 1.2: Pin GSD status line above the accessory bar

**Problem:** The GSD plugin writes a context status line (showing context %, tool count, idle state) as part of the Claude Code Ink interface. It appears in the terminal but is easily buried by new output.

**Fix:** After each terminal write flush, scan the last few lines of the xterm.js buffer for a status line pattern. Mirror the matched line into a small fixed strip between the terminal and the accessory bar.

**Files:**
- Modify: `src/web/public/index.html` (add `.terminal-status-strip` element)
- Modify: `src/web/public/app.js` (add `_updateStatusStrip()` called after `flushPendingWrites`)
- Modify: `src/web/public/mobile.css` (style the strip for mobile)
- Modify: `src/web/public/styles.css` (hide on desktop)

**Step 1: Add the status strip element to index.html**

Find the `<main class="main">` block (line ~230). Add the strip between the terminal container and `</main>`:

```html
    <main class="main">
      <div class="terminal-container" id="terminalContainer"></div>
      <!-- GSD/plugin status line mirror — updated by app.js after each terminal write -->
      <div class="terminal-status-strip" id="terminalStatusStrip" style="display:none;"></div>
    </main>
```

**Step 2: Style the strip**

In `styles.css`:

```css
.terminal-status-strip {
  display: none; /* hidden until status line is detected */
}
```

In `mobile.css`:

```css
.terminal-status-strip {
  font-family: var(--font-mono, 'Cascadia Code', monospace);
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  background: #0a0a0a;
  padding: 2px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-top: 1px solid rgba(255,255,255,0.08);
  min-height: 18px;
  flex-shrink: 0;
}
```

**Step 3: Add status line detection after terminal writes**

In `app.js`, find `flushPendingWrites()` (around line 1395). After the `this.terminal.scrollToBottom()` call at line ~1430, add:

```javascript
this._updateStatusStrip();
```

Add the `_updateStatusStrip()` method adjacent to `flushPendingWrites`:

```javascript
/**
 * Scan the last lines of the xterm.js buffer for a GSD/plugin status line
 * and mirror it into the persistent status strip element.
 * Matches patterns like "Context: 47%" from the GSD context tracker.
 */
_updateStatusStrip() {
  if (!this.terminal) return;
  const strip = document.getElementById('terminalStatusStrip');
  if (!strip) return;

  const buffer = this.terminal.buffer.active;
  const totalLines = buffer.length;
  // Scan last 8 lines — Ink status bar is always near the bottom
  const scanFrom = Math.max(0, totalLines - 8);

  // Matches GSD format like "◆ Context: 47% · 3 tools · idle"
  const STATUS_RE = /(\bContext\b|\btokens?\b).*\d+%|\d+%.*(\bContext\b|\btokens?\b)/i;

  let matched = '';
  for (let i = totalLines - 1; i >= scanFrom; i--) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trim();
    if (text && STATUS_RE.test(text)) {
      matched = text;
      break;
    }
  }

  if (matched) {
    strip.textContent = matched; // textContent is safe — no HTML interpretation
    strip.style.display = '';
  }
  // Keep last known value if no match found this frame
}
```

**Step 4: Verify**

In a Claude Code session with GSD active, run a few commands. Verify the status strip appears below the terminal and above the accessory bar, shows the context percentage, and updates with each Claude response. Verify it does not appear in sessions without GSD output.

**Step 5: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html src/web/public/mobile.css src/web/public/styles.css
git commit -m "feat: pin GSD status line in persistent strip above accessory bar"
```

---

## Phase 2: Session Navigation and Keyboard Stability

### Task 2.1: Add session navigation drawer (hamburger menu)

**Problem:** The only way to switch sessions on mobile is the horizontal swipe gesture, which is unreliable and provides no session list visibility.

**Fix:** Add a hamburger button to the mobile header that opens a bottom-sheet drawer listing all sessions with name, CLI type, and status.

**Files:**
- Modify: `src/web/public/index.html` (hamburger button in header, drawer element)
- Modify: `src/web/public/app.js` (SessionDrawer object)
- Modify: `src/web/public/mobile.css` (drawer styles)

**Step 1: Add hamburger button and drawer HTML**

In `index.html`, find `<div class="header-right">` (line ~61). Add a hamburger button as the first child (it is hidden by default and shown via CSS on touch devices):

```html
<div class="header-right">
  <button class="btn-icon-header btn-hamburger" id="sessionDrawerToggle"
          onclick="SessionDrawer.toggle()"
          title="Sessions" aria-label="Open session list">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  </button>
  <!-- existing header-right content continues unchanged -->
```

Before `</body>`, add the overlay and drawer shell (content is built by JS):

```html
<div class="session-drawer-overlay" id="sessionDrawerOverlay"
     onclick="SessionDrawer.close()" aria-hidden="true"></div>
<div class="session-drawer" id="sessionDrawer" role="dialog"
     aria-label="Session list" aria-modal="true">
  <div class="session-drawer-handle" aria-hidden="true"></div>
  <div class="session-drawer-title">Sessions</div>
  <div class="session-drawer-list" id="sessionDrawerList"></div>
</div>
```

**Step 2: Style the drawer**

In `styles.css`, hide the hamburger on desktop:

```css
.btn-hamburger { display: none; }
```

In `mobile.css`:

```css
/* Show hamburger on touch devices */
.touch-device .btn-hamburger { display: flex; }

.session-drawer-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 1500;
}
.session-drawer-overlay.open { display: block; }

.session-drawer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #111;
  border-radius: 12px 12px 0 0;
  border-top: 1px solid #1a1a2e;
  z-index: 1501;
  transform: translateY(100%);
  transition: transform 0.25s ease;
  max-height: 70vh;
  overflow-y: auto;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.session-drawer.open { transform: translateY(0); }

.session-drawer-handle {
  width: 36px; height: 4px;
  background: #333; border-radius: 2px;
  margin: 10px auto 0;
}
.session-drawer-title {
  font-size: 12px; font-weight: 600; color: #666;
  text-transform: uppercase; letter-spacing: 0.08em;
  padding: 12px 16px 8px;
}
.session-drawer-item {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid #1a1a2e;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.session-drawer-item:active { background: #1a1a2e; }
.session-drawer-item.active { background: rgba(96,165,250,0.1); }
.session-drawer-item-name {
  flex: 1; font-size: 14px; color: #e2e8f0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.session-drawer-item-meta { display: flex; align-items: center; gap: 6px; }
.session-drawer-badge {
  font-size: 10px; padding: 2px 5px; border-radius: 3px;
  background: #1a1a2e; color: #94a3b8; text-transform: uppercase;
}
.session-drawer-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #374151;
}
.session-drawer-dot.running { background: #22c55e; }
.session-drawer-dot.ralph   { background: #f59e0b; }
```

**Step 3: Add SessionDrawer object to app.js**

Add this object near the bottom of `app.js`, after the `App` class definition and before `const app = new App()`:

```javascript
/**
 * SessionDrawer — bottom-sheet session picker for mobile.
 * All DOM content is built with createElement/textContent (no innerHTML).
 */
const SessionDrawer = {
  open() {
    document.getElementById('sessionDrawerOverlay')?.classList.add('open');
    const drawer = document.getElementById('sessionDrawer');
    if (drawer) { drawer.classList.add('open'); this._render(); }
  },
  close() {
    document.getElementById('sessionDrawerOverlay')?.classList.remove('open');
    document.getElementById('sessionDrawer')?.classList.remove('open');
  },
  toggle() {
    const drawer = document.getElementById('sessionDrawer');
    if (drawer?.classList.contains('open')) this.close(); else this.open();
  },
  _render() {
    const list = document.getElementById('sessionDrawerList');
    if (!list || typeof app === 'undefined') return;
    list.replaceChildren();

    for (const id of app.sessionOrder) {
      const session = app.sessions.get(id);
      if (!session) continue;
      const isActive  = id === app.activeSessionId;
      const isRunning = session.status === 'running' || session.status === 'active';
      const hasRalph  = app.ralphStates?.get(id)?.enabled;

      const item = document.createElement('div');
      item.className = 'session-drawer-item' + (isActive ? ' active' : '');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'session-drawer-item-name';
      nameSpan.textContent = session.name || id.slice(0, 8);

      const meta = document.createElement('span');
      meta.className = 'session-drawer-item-meta';

      const badge = document.createElement('span');
      badge.className = 'session-drawer-badge';
      badge.textContent = session.mode || 'claude';

      const dot = document.createElement('span');
      dot.className = 'session-drawer-dot'
        + (isRunning ? ' running' : '')
        + (hasRalph  ? ' ralph'   : '');

      meta.appendChild(badge);
      meta.appendChild(dot);
      item.appendChild(nameSpan);
      item.appendChild(meta);

      item.addEventListener('click', () => {
        app.selectSession(id);
        this.close();
      });
      list.appendChild(item);
    }
  }
};
```

**Step 4: Verify**

On a touch device or Chrome DevTools mobile emulation: tap the hamburger. Drawer slides up from bottom listing sessions. Tapping a session switches and closes the drawer. Tapping the overlay closes it. Verify session names are plain text (no XSS risk).

**Step 5: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html src/web/public/mobile.css src/web/public/styles.css
git commit -m "feat: add mobile session navigation drawer"
```

---

### Task 2.2: Fix keyboard layout jump on Android

**Problem:** When the keyboard hides, `resetLayout()` fires synchronously and changes `main.style.paddingBottom`. This shifts the terminal viewport before `fitAddon.fit()` recalculates dimensions — causing visible content jump.

**Fix:** Capture the terminal's scroll position before layout changes and restore it after `fitAddon.fit()` completes.

**Files:**
- Modify: `src/web/public/mobile-handlers.js` (lines ~319-337 `onKeyboardHide`)

**Step 1: Replace onKeyboardHide**

Current code (lines 319-337):
```javascript
onKeyboardHide() {
  this.resetLayout();
  setTimeout(() => {
    if (typeof app !== 'undefined' && app.fitAddon) {
      try { app.fitAddon.fit(); } catch {}
      if (app.terminal) app.terminal.scrollToBottom();
      this._sendTerminalResize();
    }
  }, 100);
  if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
},
```

Replace with:

```javascript
onKeyboardHide() {
  // Capture scroll state BEFORE layout changes so we can restore it after fitAddon.fit()
  const terminal = typeof app !== 'undefined' ? app.terminal : null;
  const wasAtBottom = typeof app !== 'undefined' && typeof app.isTerminalAtBottom === 'function'
    ? app.isTerminalAtBottom()
    : true;
  const preViewportY = terminal?.buffer?.active?.viewportY;
  const preBaseY     = terminal?.buffer?.active?.baseY;

  this.resetLayout();

  setTimeout(() => {
    if (typeof app !== 'undefined' && app.fitAddon) {
      try { app.fitAddon.fit(); } catch {}

      if (app.terminal) {
        if (wasAtBottom) {
          // Was at bottom — stay at bottom after resize
          app.terminal.scrollToBottom();
        } else if (preViewportY !== undefined && preBaseY !== undefined) {
          // Was scrolled up — restore relative position from scrollback start
          const offsetFromBase = preViewportY - preBaseY;
          const newBase = app.terminal.buffer.active.baseY;
          app.terminal.scrollToLine(newBase + Math.max(0, offsetFromBase));
        }
      }
      this._sendTerminalResize();
    }
  }, 100);

  if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
},
```

**Step 2: Verify**

On Android or DevTools mobile: open a session with long output. Scroll partway up to see older content. Tap to open keyboard, then tap elsewhere to close it. Verify: the visible content does not jump when the keyboard closes. The scroll position is preserved within ~1-2 lines. When user is at the bottom, it stays at the bottom.

**Step 3: Commit**

```bash
git add src/web/public/mobile-handlers.js
git commit -m "fix: preserve terminal scroll position on Android keyboard hide"
```

---

## Phase 3: Persistent Input Field Toggle

### Task 3.1: Add toggleable native textarea input panel

**Problem:** Typing directly in the xterm.js terminal on mobile provides no visibility. Cannot compose multi-line input or use voice dictation confidently.

**Fix:** A panel with a native `<textarea>` slides up above the accessory bar. Send sends without clearing — user keeps editing. Clear button empties it. Toggle button in accessory bar shows/hides the panel.

**Files:**
- Modify: `src/web/public/index.html` (input panel HTML)
- Modify: `src/web/public/app.js` (InputPanel object)
- Modify: `src/web/public/keyboard-accessory.js` (toggle button)
- Modify: `src/web/public/mobile.css` (panel styles)

**Step 1: Add input panel HTML to index.html**

Before `</body>`:

```html
<!-- Mobile persistent input panel — toggled by InputPanel.toggle() -->
<div class="mobile-input-panel" id="mobileInputPanel" style="display:none;"
     aria-label="Compose input" role="region">
  <div class="mobile-input-row">
    <button class="mobile-input-btn mobile-input-mic" id="mobileInputMic"
            onclick="InputPanel.toggleVoice()" title="Voice input"
            aria-label="Toggle voice input" type="button">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
    </button>
    <textarea class="mobile-input-textarea" id="mobileInputTextarea"
              rows="3"
              placeholder="Type or paste… Send keeps text. Clear to reset."
              autocomplete="off" autocorrect="on"
              autocapitalize="sentences" spellcheck="true"></textarea>
    <div class="mobile-input-actions">
      <button class="mobile-input-btn mobile-input-clear"
              onclick="InputPanel.clear()" title="Clear" type="button"
              aria-label="Clear input">&#x2715;</button>
      <button class="mobile-input-btn mobile-input-send"
              onclick="InputPanel.send()" title="Send"
              type="button" aria-label="Send input">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" aria-hidden="true">
          <line x1="22" y1="2" x2="11" y2="13"/>
          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>
  </div>
</div>
```

**Step 2: Style the panel**

In `mobile.css`:

```css
.mobile-input-panel {
  background: #111;
  border-top: 1px solid #1a1a2e;
  padding: 8px;
  flex-shrink: 0;
}
.mobile-input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.mobile-input-textarea {
  flex: 1;
  background: #0d0d0d;
  color: #e2e8f0;
  border: 1px solid #1a1a2e;
  border-radius: 8px;
  padding: 8px 10px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 15px;
  line-height: 1.4;
  resize: none;
  min-height: 44px;
  max-height: 120px;
  overflow-y: auto;
}
.mobile-input-textarea:focus {
  outline: none;
  border-color: #3b82f6;
}
.mobile-input-btn {
  background: none;
  border: none;
  color: #94a3b8;
  padding: 8px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mobile-input-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
}
.mobile-input-send {
  background: #3b82f6;
  color: #fff;
  border-radius: 8px;
  width: 36px;
  height: 36px;
}
.mobile-input-send:active { background: #2563eb; }
.mobile-input-clear { font-size: 14px; }
```

**Step 3: Add InputPanel object to app.js**

Add alongside `SessionDrawer` near the bottom of `app.js`:

```javascript
/**
 * InputPanel — Persistent native textarea above the keyboard accessory bar.
 * Mobile only. Toggle open/closed. Send does not clear — user keeps editing.
 * All DOM text uses textContent (no innerHTML).
 */
const InputPanel = {
  _open: false,

  toggle() {
    if (this._open) this.close(); else this.open();
  },

  open() {
    const panel = document.getElementById('mobileInputPanel');
    if (!panel) return;
    panel.style.display = '';
    this._open = true;
    requestAnimationFrame(() => {
      document.getElementById('mobileInputTextarea')?.focus();
    });
  },

  close() {
    const panel = document.getElementById('mobileInputPanel');
    if (!panel) return;
    panel.style.display = 'none';
    this._open = false;
  },

  send() {
    const ta = document.getElementById('mobileInputTextarea');
    if (!ta) return;
    const text = ta.value; // do not trim — preserve intentional whitespace
    if (!text) return;
    if (typeof app !== 'undefined' && app.sendInput) {
      app.sendInput(text);
    }
    // Intentionally do NOT clear — user can keep editing/appending
    ta.focus();
  },

  clear() {
    const ta = document.getElementById('mobileInputTextarea');
    if (!ta) return;
    ta.value = '';
    ta.focus();
  },

  toggleVoice() {
    if (typeof VoiceInput !== 'undefined' && VoiceInput.toggle) {
      VoiceInput.toggle();
    }
  }
};
```

**Step 4: Add toggle button to KeyboardAccessoryBar**

In `keyboard-accessory.js`, find the `init()` method where accessory buttons are created (search for `this.element.appendChild` patterns). Add a new button that calls `InputPanel.toggle()`:

```javascript
// Input panel toggle button (add alongside other accessory buttons)
if (MobileDetection.isTouchDevice()) {
  const inputToggleBtn = document.createElement('button');
  inputToggleBtn.className = 'accessory-btn';
  inputToggleBtn.title = 'Toggle input panel';
  inputToggleBtn.setAttribute('aria-label', 'Toggle input panel');
  inputToggleBtn.type = 'button';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('aria-hidden', 'true');

  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '3'); rect.setAttribute('y', '11');
  rect.setAttribute('width', '18'); rect.setAttribute('height', '11'); rect.setAttribute('rx', '2');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M7 11V7a5 5 0 0 1 10 0v4');

  svg.appendChild(rect);
  svg.appendChild(path);
  inputToggleBtn.appendChild(svg);

  inputToggleBtn.addEventListener('click', () => {
    if (typeof InputPanel !== 'undefined') InputPanel.toggle();
  });
  this.element.appendChild(inputToggleBtn);
}
```

**Step 5: Verify**

On mobile: tap the new input toggle button in the accessory bar. A textarea panel appears above the bar. Type text — it's fully visible and editable. Tap Send: text is sent to Claude (appears in terminal), textarea retains the text. Tap Clear: textarea empties. Tap toggle again: panel hides. Mic button: triggers VoiceInput.

**Step 6: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html src/web/public/mobile.css src/web/public/keyboard-accessory.js
git commit -m "feat: add persistent input panel toggle for mobile"
```

---

## Phase 4: Dynamic Plugin Command Discovery

### Task 4.1: Backend — add GET /api/sessions/:id/commands endpoint

**Read before implementing:**
- `src/web/routes/sessions-routes.ts` — for route registration pattern
- `src/web/schemas.ts` — for Zod schema patterns
- `src/web/server.ts` — to find where routes are registered
- `src/web/ports/session-port.ts` — for the `getSession` method signature

**Files:**
- Create: `src/web/routes/commands-routes.ts`
- Modify: `src/web/server.ts` (register the route)

**Step 1: Create commands-routes.ts**

```typescript
/**
 * @fileoverview Commands route — returns available slash commands for a session.
 *
 * Discovers commands from:
 *   1. Plugin skills: ~/.claude/plugins/installed_plugins.json (user + project-scoped)
 *   2. GSD commands: ~/.claude/commands/gsd/*.md
 *
 * No CLI interaction — reads SKILL.md frontmatter directly from the filesystem.
 *
 * @endpoints
 *   GET /api/sessions/:id/commands → { commands: CommandEntry[] }
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { SessionPort } from '../ports/session-port.js';

export interface CommandEntry {
  cmd: string;
  desc: string;
  source: 'plugin' | 'gsd';
}

interface InstalledPlugin {
  scope: 'user' | 'project';
  installPath: string;
  projectPath?: string;
}

interface PluginsManifest {
  version: number;
  plugins: Record<string, InstalledPlugin[]>;
}

/**
 * Parse name and description from YAML frontmatter in a markdown file.
 * Only reads the first frontmatter block (between --- delimiters).
 */
function parseFrontmatter(filePath: string): { name?: string; description?: string } {
  let content: string;
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return {}; }
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};
  const fm = content.slice(3, end);
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
  return { name, description: desc };
}

/** Build the full command list for a session's working directory. */
function discoverCommands(sessionWorkingDir?: string): CommandEntry[] {
  const commands: CommandEntry[] = [];
  const claudeDir = path.join(os.homedir(), '.claude');

  // 1. Plugin skills
  const manifestPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  if (fs.existsSync(manifestPath)) {
    let manifest: PluginsManifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); }
    catch { manifest = { version: 2, plugins: {} }; }

    const seen = new Set<string>(); // deduplicate by command name across plugin versions

    for (const [, installs] of Object.entries(manifest.plugins)) {
      for (const install of installs) {
        // Project-scoped: skip unless session workingDir is inside projectPath
        if (install.scope === 'project' && install.projectPath) {
          if (!sessionWorkingDir) continue;
          const proj = install.projectPath.replace(/\/$/, '');
          const sess = sessionWorkingDir.replace(/\/$/, '');
          if (sess !== proj && !sess.startsWith(proj + '/')) continue;
        }

        const skillsDir = path.join(install.installPath, 'skills');
        let skillNames: string[];
        try { skillNames = fs.readdirSync(skillsDir); } catch { continue; }

        for (const skillName of skillNames) {
          const skillMd = path.join(skillsDir, skillName, 'SKILL.md');
          if (!fs.existsSync(skillMd)) continue;
          const { name, description } = parseFrontmatter(skillMd);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          commands.push({ cmd: `/${name}`, desc: description ?? '', source: 'plugin' });
        }
      }
    }
  }

  // 2. GSD commands
  const gsdDir = path.join(claudeDir, 'commands', 'gsd');
  let gsdFiles: string[];
  try { gsdFiles = fs.readdirSync(gsdDir).filter(f => f.endsWith('.md')); }
  catch { gsdFiles = []; }

  for (const file of gsdFiles) {
    const { name, description } = parseFrontmatter(path.join(gsdDir, file));
    if (!name) continue;
    commands.push({ cmd: `/${name}`, desc: description ?? '', source: 'gsd' });
  }

  return commands;
}

export async function commandsRoutes(app: FastifyInstance, port: SessionPort): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/commands',
    async (request, reply) => {
      const { id } = request.params;
      const session = port.getSession(id);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      const commands = discoverCommands(session.workingDir);
      return reply.send({ commands });
    }
  );
}
```

**Step 2: Register route in server.ts**

Find the block in `server.ts` where other route modules are registered (search for `sessionsRoutes` or `ralphRoutes`). Import and register the new route in the same pattern:

```typescript
import { commandsRoutes } from './routes/commands-routes.js';

// In the route registration block:
await commandsRoutes(app, sessionPort);
```

**Step 3: Typecheck**

```bash
tsc --noEmit
```

Fix any type errors before continuing.

**Step 4: Verify backend**

```bash
npx tsx src/index.ts web --port 3000 &
SESSION_ID=$(curl -s localhost:3000/api/sessions | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
curl -s "localhost:3000/api/sessions/$SESSION_ID/commands" | python3 -m json.tool | head -30
```

Expected: JSON with `commands` array containing entries from superpowers and GSD. At least 20+ entries.

**Step 5: Commit**

```bash
git add src/web/routes/commands-routes.ts src/web/server.ts
git commit -m "feat: add GET /api/sessions/:id/commands for plugin discovery"
```

---

### Task 4.2: Frontend — fetch and merge dynamic commands into the drawer

**Files:**
- Modify: `src/web/public/app.js` (cache commands per session, fetch on switch)
- Modify: `src/web/public/keyboard-accessory.js` (`_populateDrawer` merges dynamic commands)
- Modify: `src/web/public/mobile.css` (separator label style)

**Step 1: Add per-session command cache to App constructor**

In `app.js`, in the `App` constructor (around line 280 where other Maps are initialized), add:

```javascript
this._sessionCommands = new Map(); // Map<sessionId, CommandEntry[]>
```

**Step 2: Fetch commands on session select**

In `selectSession()` (line ~3529), after the buffer load completes and `scrollToBottom()` is called (around line 3832), add a fire-and-forget fetch:

```javascript
// Fetch plugin/GSD commands for this session on connect (once per session)
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
```

**Step 3: Clean up cache when session is removed**

In `_cleanupSessionData()` (around line 3843), add:

```javascript
this._sessionCommands?.delete(sessionId);
```

**Step 4: Merge dynamic commands in _populateDrawer**

In `keyboard-accessory.js`, in `_populateDrawer()` (line ~336), after the custom commands section ends, append dynamic commands:

```javascript
// Dynamic commands from plugins/GSD fetched on session connect
const dynamicCmds = (typeof app !== 'undefined' && app.activeSessionId)
  ? (app._sessionCommands?.get(app.activeSessionId) ?? [])
  : [];

if (dynamicCmds.length > 0) {
  // Section separator with label
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
```

**Step 5: Style the separator label**

In `mobile.css`, extend the existing `.accessory-drawer-sep` rule (or add if missing):

```css
.accessory-drawer-sep {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
}
.accessory-drawer-sep-label {
  font-size: 10px;
  color: #4b5563;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  white-space: nowrap;
}
```

**Step 6: Verify**

Open Commands drawer on a Claude session in a project that has superpowers installed. After switching to the session (or waiting ~1s), open the drawer. Verify a "Plugins & Skills" section appears with `/superpowers:brainstorming`, `/gsd:progress`, etc. Search filters across all sections. In a shell session, no plugin section appears.

**Step 7: Final typecheck and lint**

```bash
tsc --noEmit
npm run lint
```

Fix any errors.

**Step 8: Deploy**

```bash
npm run build
cp -r dist ~/.codeman/app/
cp package.json ~/.codeman/app/package.json
systemctl --user restart codeman-web
```

Hard refresh on mobile (Ctrl+Shift+R or clear browser cache).

**Step 9: Commit**

```bash
git add src/web/public/app.js src/web/public/keyboard-accessory.js src/web/public/mobile.css
git commit -m "feat: populate commands drawer with dynamic plugin and GSD commands"
```

---

## Deployment Checklist

- [ ] Phase 1.1: No scroll animation when switching sessions — terminal appears instantly at bottom
- [ ] Phase 1.2: GSD context % visible in status strip above accessory bar
- [ ] Phase 2.1: Hamburger opens session list bottom sheet on mobile
- [ ] Phase 2.2: No layout jump when keyboard closes on Android
- [ ] Phase 3.1: Input panel slides up above hotbar, Send/Clear work, voice button works
- [ ] Phase 4.1: `GET /api/sessions/:id/commands` returns plugin commands as JSON
- [ ] Phase 4.2: Commands drawer shows "Plugins & Skills" section with dynamic entries

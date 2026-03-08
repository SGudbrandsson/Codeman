# Compose Panel Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the mobile compose panel with a full-width, auto-growing textarea with inset + and send buttons, multi-image thumbnail support, and slash command popup.

**Architecture:** Rewrite `#mobileInputPanel` HTML+CSS from scratch, rewrite the `InputPanel` JS object in `app.js`, and replace the lock icon with a pencil in `keyboard-accessory.js`. The panel `position:fixed` above the accessory bar is preserved; `mobile-handlers.js` layout logic is unchanged (it references the panel by id, which stays the same).

**Tech Stack:** Vanilla JS, CSS custom properties, `POST /api/screenshots` for image upload, `GET /api/sessions/:id/commands` for slash commands (already cached in `app._sessionCommands`).

---

### Task 1: Replace lock icon with pencil icon

**Files:**
- Modify: `src/web/public/keyboard-accessory.js` (around line 173–200)

**Step 1: Locate the lock SVG block**

The lock SVG is built from a `rect` + `path` element starting at line ~185. The whole block from `const svg = ...` to `svg.appendChild(path)` needs replacing.

**Step 2: Replace with pencil SVG**

Replace the SVG construction block with:

```js
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
svg.setAttribute('aria-hidden', 'true');
const pencilPath1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
pencilPath1.setAttribute('d', 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
const pencilPath2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
pencilPath2.setAttribute('d', 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z');
svg.appendChild(pencilPath1);
svg.appendChild(pencilPath2);
```

**Step 3: Update button labels**

Change `inputToggleBtn.title` to `'Compose'` and `aria-label` to `'Compose'`.

**Step 4: Add active state toggle**

After the `InputPanel.toggle()` call in the click handler, add active state reflection:

```js
inputToggleBtn.addEventListener('click', () => {
  if (typeof InputPanel !== 'undefined') {
    InputPanel.toggle();
    inputToggleBtn.classList.toggle('active', InputPanel._open);
  }
});
```

Also expose a method for `InputPanel` to update the button state when closed programmatically. Add a module-level variable and a setter:

```js
// After `this.element.appendChild(inputToggleBtn);`
this._inputToggleBtn = inputToggleBtn;
```

And in `AccessoryBar` expose:
```js
setComposeActive(active) {
  if (this._inputToggleBtn) this._inputToggleBtn.classList.toggle('active', active);
}
```

**Step 5: Commit**

```bash
git add src/web/public/keyboard-accessory.js
git commit -m "feat: replace lock icon with pencil in accessory bar compose button"
```

---

### Task 2: Redesign the compose panel HTML

**Files:**
- Modify: `src/web/public/index.html` (lines 1755–1807)

**Step 1: Replace `#mobileInputPanel` inner HTML**

Find the block from `<div class="mobile-input-panel" id="mobileInputPanel"` to the closing `</div>` of the panel (before the script tags). Replace the entire inner content with:

```html
  <!-- Mobile persistent input panel — toggled by InputPanel.toggle() -->
  <div class="mobile-input-panel" id="mobileInputPanel" style="display:none;"
       aria-label="Compose input" role="region">

    <!-- Thumbnail strip — hidden until images are attached -->
    <div class="compose-thumb-strip" id="composeThumbStrip" style="display:none;"></div>

    <!-- Slash command popup — shown when user types / -->
    <div class="compose-slash-popup" id="composeSlashPopup" style="display:none;"
         role="listbox" aria-label="Slash commands"></div>

    <!-- Textarea wrapper — + and send buttons are absolutely positioned inside -->
    <div class="compose-textarea-wrap">
      <textarea class="compose-textarea" id="composeTextarea"
                rows="1"
                placeholder="Type a message…"
                autocomplete="off" autocorrect="on"
                autocapitalize="sentences" spellcheck="true"></textarea>

      <!-- Plus button — bottom-left inside textarea -->
      <button class="compose-inset-btn compose-plus-btn" id="composePlusBtn"
              type="button" aria-label="Attach"
              onmousedown="event.preventDefault()"
              ontouchstart="event.preventDefault()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>

      <!-- Send button — bottom-right inside textarea -->
      <button class="compose-inset-btn compose-send-btn" id="composeSendBtn"
              type="button" aria-label="Send"
              onmousedown="event.preventDefault()"
              ontouchstart="event.preventDefault()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <line x1="12" y1="19" x2="12" y2="5"/>
          <polyline points="5 12 12 5 19 12"/>
        </svg>
      </button>
    </div>

    <!-- Hidden file inputs for the + action sheet -->
    <input type="file" id="composeFileCamera"  accept="image/*" capture="environment" style="display:none"
           onchange="InputPanel._onFilesChosen(this, 'camera')">
    <input type="file" id="composeFileGallery" accept="image/*" multiple style="display:none"
           onchange="InputPanel._onFilesChosen(this, 'gallery')">
    <input type="file" id="composeFileAny"     multiple style="display:none"
           onchange="InputPanel._onFilesChosen(this, 'file')">

    <!-- Plus action sheet -->
    <div class="compose-action-sheet" id="composeActionSheet" style="display:none;">
      <button class="compose-action-item" type="button"
              onclick="InputPanel._actionSheetPick('camera')">Take Photo</button>
      <button class="compose-action-item" type="button"
              onclick="InputPanel._actionSheetPick('gallery')">Photo Library</button>
      <button class="compose-action-item" type="button"
              onclick="InputPanel._actionSheetPick('file')">Attach File</button>
      <button class="compose-action-cancel" type="button"
              onclick="InputPanel._closeActionSheet()">Cancel</button>
    </div>
    <div class="compose-action-backdrop" id="composeActionBackdrop" style="display:none;"
         onclick="InputPanel._closeActionSheet()"></div>
  </div>
```

**Step 2: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat: redesign compose panel HTML — textarea with inset buttons, thumbnail strip, slash popup"
```

---

### Task 3: New CSS for compose panel

**Files:**
- Modify: `src/web/public/mobile.css` (lines 2130–2199, the `.mobile-input-*` block)

**Step 1: Replace the old `.mobile-input-*` rules**

Remove all rules from `.mobile-input-panel` through `.mobile-input-clear` (lines ~2130–2199) and replace with:

```css
/* ── Compose Panel ────────────────────────────────────────── */
.mobile-input-panel {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(var(--safe-area-bottom) + 84px); /* above accessory bar */
  z-index: 52;
  background: #111;
  border-top: 1px solid #1a1a2e;
  padding: 8px;
  padding-left: calc(8px + var(--safe-area-left));
  padding-right: calc(8px + var(--safe-area-right));
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Thumbnail strip */
.compose-thumb-strip {
  display: flex;
  flex-direction: row;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
  -webkit-overflow-scrolling: touch;
}
.compose-thumb {
  position: relative;
  flex-shrink: 0;
  width: 60px;
  height: 60px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #1a1a2e;
  cursor: pointer;
}
.compose-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.compose-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0,0,0,0.7);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

/* Textarea wrapper — relative so inset buttons are absolute */
.compose-textarea-wrap {
  position: relative;
}
.compose-textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  background: #0d0d0d;
  color: #e2e8f0;
  border: 1px solid #1a1a2e;
  border-radius: 12px;
  /* left padding leaves room for + btn; right padding leaves room for send btn */
  padding: 10px 52px 10px 44px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 15px;
  line-height: 1.45;
  resize: none;
  min-height: 44px;
  /* max-height set dynamically by JS */
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.compose-textarea:focus {
  outline: none;
  border-color: #3b82f6;
}

/* Inset buttons inside textarea */
.compose-inset-btn {
  position: absolute;
  bottom: 7px;
  background: none;
  border: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
}
.compose-plus-btn {
  left: 4px;
  color: #94a3b8;
}
.compose-plus-btn:active { color: #e2e8f0; }
.compose-send-btn {
  right: 4px;
  width: 34px;
  height: 34px;
  background: #3b82f6;
  color: #fff;
  border-radius: 50%;
  padding: 0;
}
.compose-send-btn:active { background: #2563eb; }

/* Slash command popup */
.compose-slash-popup {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  margin-bottom: 4px;
  background: #1a1a2e;
  border: 1px solid #2a2a4e;
  border-radius: 10px;
  max-height: 220px;
  overflow-y: auto;
  z-index: 53;
  -webkit-overflow-scrolling: touch;
}
.compose-slash-item {
  display: flex;
  flex-direction: column;
  padding: 10px 14px;
  border-bottom: 1px solid #2a2a4e;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.compose-slash-item:last-child { border-bottom: none; }
.compose-slash-item:active { background: #2a2a4e; }
.compose-slash-cmd {
  font-size: 14px;
  font-weight: 600;
  color: #93c5fd;
  font-family: monospace;
}
.compose-slash-desc {
  font-size: 12px;
  color: #64748b;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Plus action sheet */
.compose-action-backdrop {
  position: fixed;
  inset: 0;
  z-index: 54;
  background: rgba(0,0,0,0.5);
}
.compose-action-sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 55;
  background: #1a1a2e;
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  padding: 8px 16px calc(16px + var(--safe-area-bottom));
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.compose-action-item {
  background: #252540;
  color: #e2e8f0;
  border: none;
  border-radius: 10px;
  padding: 16px;
  font-size: 16px;
  text-align: center;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.compose-action-item:active { background: #2a2a4e; }
.compose-action-cancel {
  background: none;
  color: #94a3b8;
  border: none;
  border-radius: 10px;
  padding: 14px;
  font-size: 16px;
  text-align: center;
  cursor: pointer;
  margin-top: 4px;
}
```

**Step 2: Bump mobile.css version in index.html**

In `index.html` change `mobile.css?v=0.1638` → `mobile.css?v=0.1639`.

**Step 3: Commit**

```bash
git add src/web/public/mobile.css src/web/public/index.html
git commit -m "feat: new compose panel CSS — auto-grow textarea, inset buttons, thumbnails, slash popup, action sheet"
```

---

### Task 4: Rewrite InputPanel JS — core send + auto-grow

**Files:**
- Modify: `src/web/public/app.js` (lines ~12246–12355, the `InputPanel` object)

**Step 1: Replace the entire `InputPanel` object**

Find `const InputPanel = {` and replace everything through the closing `};` with:

```js
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

  _getPanel()    { return this._panelEl    || (this._panelEl    = document.getElementById('mobileInputPanel')); },
  _getTextarea() { return this._textareaEl || (this._textareaEl = document.getElementById('composeTextarea')); },

  /** Init — wire events once after DOM is ready */
  init() {
    const ta = this._getTextarea();
    if (!ta) return;

    // Auto-grow
    ta.addEventListener('input', () => {
      this._autoGrow(ta);
      this._handleSlashInput(ta.value);
    });

    // Send on Enter (without shift) — mirrors standard chat UX
    // On mobile, Enter usually inserts a newline (OS handles it), so we don't intercept.

    // Plus button
    const plusBtn = document.getElementById('composePlusBtn');
    if (plusBtn) plusBtn.addEventListener('click', () => this._openActionSheet());

    // Send button
    const sendBtn = document.getElementById('composeSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', () => this.send());
  },

  /** Auto-grow the textarea up to the available viewport height */
  _autoGrow(ta) {
    ta.style.height = 'auto';
    // Cap at: visual viewport height minus estimated panel overhead (keyboard + bars ~200px fallback)
    const vvh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const maxH = Math.max(80, vvh - 200);
    ta.style.maxHeight = maxH + 'px';
    ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px';
  },

  toggle() { if (this._open) this.close(); else this.open(); },

  open() {
    const panel = this._getPanel();
    if (!panel) return;
    panel.style.display = '';
    this._open = true;
    // Reflect active state on accessory bar pencil button
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
    if (typeof KeyboardAccessoryBar !== 'undefined' && KeyboardAccessoryBar.instance) {
      KeyboardAccessoryBar.instance.setComposeActive(false);
    }
  },

  /** Send all queued images then the typed text */
  send() {
    const ta = this._getTextarea();
    if (!ta) return;
    const text = ta.value.trim();
    const images = this._images.filter(img => img.path); // only uploaded images
    if (!text && !images.length) return;
    if (typeof app === 'undefined' || !app.sendInput) return;

    let delay = 0;
    // Send each image path as a separate line first
    for (const img of images) {
      const path = img.path;
      setTimeout(() => app.sendInput(path), delay);
      delay += 80;
      setTimeout(() => app.sendInput('\r'), delay);
      delay += 80;
    }
    // Then send the text
    if (text) {
      setTimeout(() => app.sendInput(text), delay);
      delay += 80;
      setTimeout(() => app.sendInput('\r'), delay);
    }

    ta.value = '';
    this._autoGrow(ta);
    this._images = [];
    this._renderThumbnails();
    this.close();
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

  async _onFilesChosen(input, _type) {
    const files = Array.from(input.files || []);
    input.value = ''; // reset so same file can be re-picked
    if (!files.length) return;

    for (const file of files) {
      const objectUrl = URL.createObjectURL(file);
      const entry = { objectUrl, file, path: null };
      this._images.push(entry);
      this._renderThumbnails();

      // Upload in background
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/screenshots', { method: 'POST', body: formData });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Upload failed');
        entry.path = data.path;
        this._renderThumbnails(); // re-render to reflect uploaded state
      } catch (err) {
        if (typeof app !== 'undefined') app.showToast('Image upload failed', 'error');
        console.error('[InputPanel] image upload failed:', err);
        // Remove the failed entry
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
      wrap.title = img.path ? 'Tap to preview / long-press to replace' : 'Uploading…';

      const imgEl = document.createElement('img');
      imgEl.src = img.objectUrl;
      imgEl.alt = 'Attachment ' + (idx + 1);
      // Tap: preview
      imgEl.addEventListener('click', () => this._previewImage(img));
      // Long-press: replace
      let pressTimer;
      imgEl.addEventListener('touchstart', () => {
        pressTimer = setTimeout(() => this._replaceImage(idx), 500);
      }, { passive: true });
      imgEl.addEventListener('touchend', () => clearTimeout(pressTimer), { passive: true });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'compose-thumb-remove';
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', 'Remove image');
      removeBtn.textContent = '×';
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
    // Reuse existing image popup if available
    if (typeof app !== 'undefined' && app.showImagePopup) {
      app.showImagePopup(img.objectUrl);
    } else {
      window.open(img.objectUrl, '_blank');
    }
  },

  _replaceImage(idx) {
    // Open gallery picker; on file chosen, replace entry at idx
    this._replaceIdx = idx;
    const input = document.getElementById('composeFileGallery');
    if (input) input.click();
  },

  // ── Slash commands ──────────────────────────────────────────────────────────

  _handleSlashInput(value) {
    if (!value.startsWith('/')) { this._closeSlashPopup(); return; }
    const query = value.slice(1).toLowerCase();
    const sessionId = typeof app !== 'undefined' ? app.activeSessionId : null;
    const commands = (sessionId && app._sessionCommands?.get(sessionId)) || [];
    const matches = query
      ? commands.filter(c => c.cmd.toLowerCase().includes(query) || c.desc.toLowerCase().includes(query))
      : commands;
    if (!matches.length) { this._closeSlashPopup(); return; }
    this._showSlashPopup(matches);
  },

  _showSlashPopup(commands) {
    const popup = document.getElementById('composeSlashPopup');
    if (!popup) return;
    popup.replaceChildren();
    commands.slice(0, 10).forEach(cmd => {
      const item = document.createElement('div');
      item.className = 'compose-slash-item';
      item.setAttribute('role', 'option');

      const cmdSpan = document.createElement('span');
      cmdSpan.className = 'compose-slash-cmd';
      cmdSpan.textContent = cmd.cmd; // textContent — safe

      const descSpan = document.createElement('span');
      descSpan.className = 'compose-slash-desc';
      descSpan.textContent = cmd.desc; // textContent — safe

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
```

**Step 2: Call `InputPanel.init()` at app startup**

Find where other mobile singletons are initialized (search for `SessionDrawer` or `VoiceInput` init calls at startup). Add:

```js
if (typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice()) {
  InputPanel.init();
}
```

**Step 3: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat: rewrite InputPanel — auto-grow textarea, multi-image, slash commands, action sheet"
```

---

### Task 5: Expose AccessoryBar instance + wire setComposeActive

**Files:**
- Modify: `src/web/public/keyboard-accessory.js`

**Context:** `InputPanel.open()`/`close()` call `KeyboardAccessoryBar.instance.setComposeActive()`. We need to store the instance and expose it.

**Step 1: Store instance on the class**

Find where `KeyboardAccessoryBar` is instantiated (likely near the bottom of `keyboard-accessory.js`, something like `new KeyboardAccessoryBar(...)`). After instantiation, add:

```js
KeyboardAccessoryBar.instance = barInstance; // where barInstance is the result of `new KeyboardAccessoryBar(...)`
```

Or if the class assigns `this` to a global, just add `KeyboardAccessoryBar.instance = this;` in the constructor.

**Step 2: Verify `setComposeActive` is on the prototype**

From Task 1, `setComposeActive` was added on the class. Double-check it's inside the class body, not outside.

**Step 3: Commit**

```bash
git add src/web/public/keyboard-accessory.js
git commit -m "feat: expose KeyboardAccessoryBar.instance for InputPanel active-state sync"
```

---

### Task 6: Bump version strings

**Files:**
- Modify: `src/web/public/index.html`

**Step 1: Bump all touched files**

In `index.html`, update:
- `keyboard-accessory.js?v=0.4.6` → `keyboard-accessory.js?v=0.4.7`
- `app.js?v=0.4.11` → `app.js?v=0.4.12`
- `mobile.css?v=0.1638` → `mobile.css?v=0.1639` (already done in Task 3)

**Step 2: Commit**

```bash
git add src/web/public/index.html
git commit -m "chore: bump cache-busting versions for compose panel redesign"
```

---

### Task 7: Verify with Playwright

**Files:** none — verification only

**Step 1: Start dev server**

```bash
npx tsx src/index.ts web --port 3000
```

**Step 2: Run Playwright check**

Use the playwright-skill to:
1. Load `http://localhost:3000` with `waitUntil: 'domcontentloaded'`
2. Assert `#mobileInputPanel` exists in DOM
3. Simulate mobile viewport (e.g. iPhone 14: 390×844)
4. Assert the panel's textarea (`#composeTextarea`) is visible when panel is shown
5. Assert the `#composePlusBtn` and `#composeSendBtn` exist
6. Assert `#composeThumbStrip` exists but is hidden
7. Type `/` in the textarea and assert `#composeSlashPopup` becomes visible
8. Type `test message` (no slash) and assert popup is hidden

**Step 3: Manual smoke test checklist**

- [ ] Pencil icon shows in accessory bar (not lock)
- [ ] Tapping pencil opens compose panel
- [ ] Typing grows the textarea
- [ ] `+` opens action sheet with 3 options + Cancel
- [ ] Cancel closes action sheet
- [ ] Attaching an image shows thumbnail with `×` badge
- [ ] Tapping thumbnail opens preview
- [ ] Long-pressing thumbnail triggers replace (file picker opens)
- [ ] `×` badge removes thumbnail
- [ ] Typing `/` shows slash command popup filtered by session
- [ ] Tapping a command inserts it in the textarea
- [ ] Send button sends text (and images) and closes panel
- [ ] Pencil button shows active state when panel is open

---

### Notes

- `mobile-handlers.js` needs **no changes** — it references `#mobileInputPanel` by id, which is preserved.
- The `showImagePopup` method referenced in `_previewImage` may need to be verified against its actual name in `app.js` (search for `showImagePopup` or `openImagePopup`).
- If `KeyboardAccessoryBar` is not a named class but an IIFE/object, adapt Task 5 accordingly — check the actual constructor pattern in `keyboard-accessory.js`.

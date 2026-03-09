# Desktop Bottom Bar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the old desktop toolbar with a full compose-bar + accessory-bar at the bottom of the screen, matching the mobile design, with a centered 720px-max textarea and an expand toggle.

**Architecture:** The existing `mobile-input-panel` HTML and `KeyboardAccessoryBar` JS object already have all the compose + accessory logic. We remove the desktop-bar, lift the mobile guards, and add desktop-specific CSS in `styles.css` (loaded on all viewports) to position and style both bars on screens >= 1024px.

**Tech Stack:** Vanilla JS, CSS (no framework), Playwright for verification.

---

## Context

- `src/web/public/index.html` — HTML for all UI elements
- `src/web/public/styles.css` — Desktop CSS (loaded always)
- `src/web/public/mobile.css` — Mobile CSS (loaded via `media="(max-width: 1023px)"`, NOT on desktop)
- `src/web/public/keyboard-accessory.js` — `KeyboardAccessoryBar` singleton; creates accessory bar DOM dynamically, currently skips init on non-touch devices
- `src/web/public/app.js` — `InputPanel` singleton; compose bar logic, currently skips init on non-touch
- Dev server: `npx tsx src/index.ts web` (port 3000)
- **Version strings must be bumped** on every changed asset per CLAUDE.md

---

## Task 1: Screenshot current desktop state

**Files:** none

**Step 1: Start dev server in background**

```bash
npx tsx src/index.ts web &
sleep 3
```

**Step 2: Screenshot current state**

```javascript
// /tmp/screenshot-before.js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/desktop-before.png', fullPage: false });
  console.log('Screenshot saved to /tmp/desktop-before.png');
  await browser.close();
})();
```

Run: `node /tmp/screenshot-before.js`

**Step 3: View the screenshot**

Read `/tmp/desktop-before.png` to document the current state (toolbar location, project select, sessions button).

---

## Task 2: Remove desktop-bar HTML, add expand button to compose bar

**Files:**
- Modify: `src/web/public/index.html`

**Step 1: Remove the desktop-bar div**

Remove the entire block from the `<!-- Desktop Bar` comment through its closing `</div>` (currently lines ~325-365). It begins with:

```html
    <!-- Desktop Bar — shown on desktop (>=1024px), replaces the old toolbar -->
    <div class="desktop-bar" id="desktopBar">
```

and ends with:

```html
    </div>

    <!-- Bottom Toolbar (hidden on desktop, kept for mobile legacy + JS targets) -->
```

Remove everything between those two comment lines (the entire `<div class="desktop-bar">` block).

**Step 2: Remove the sessions button from toolbar-right**

In `<div class="toolbar-right">`, remove the `btn-sessions-desktop` button:

```html
        <button class="btn-toolbar btn-sessions-desktop" onclick="if(typeof SessionDrawer!=='undefined')SessionDrawer.toggle()" title="Sessions">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          Sessions
        </button>
```

The sessions function is now handled by the accessory bar hamburger button.

**Step 3: Add expand button and collapse SVG icons inside `.compose-textarea-wrap`**

Inside `#mobileInputPanel`, find the `.compose-textarea-wrap` div. Add the expand button and its two icon states right before the existing `#composeSendBtn`:

```html
      <!-- Expand/collapse button — desktop only (hidden via style, shown via desktop CSS) -->
      <button class="compose-inset-btn compose-expand-btn" id="composeExpandBtn"
              type="button" aria-label="Expand compose area"
              onmousedown="event.preventDefault()"
              ontouchstart="event.preventDefault()"
              style="display:none;">
        <!-- Expand icon (default): shown when textarea is narrow -->
        <svg class="compose-expand-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="15 3 21 3 21 9"/>
          <polyline points="9 21 3 21 3 15"/>
          <line x1="21" y1="3" x2="14" y2="10"/>
          <line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
        <!-- Collapse icon: shown when textarea is full-width -->
        <svg class="compose-collapse-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" aria-hidden="true" style="display:none;">
          <polyline points="4 14 10 14 10 20"/>
          <polyline points="20 10 14 10 14 4"/>
          <line x1="10" y1="14" x2="3" y2="21"/>
          <line x1="21" y1="3" x2="14" y2="10"/>
        </svg>
      </button>
```

**Step 4: Bump version strings**

Change:
- `styles.css?v=0.1654` to `styles.css?v=0.1655`
- `app.js?v=0.4.50` to `app.js?v=0.4.51`
- `keyboard-accessory.js?v=0.4.13` to `keyboard-accessory.js?v=0.4.14`

**Step 5: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat: remove desktop-bar HTML, add compose expand button"
```

---

## Task 3: Add desktop bottom bar CSS to styles.css

**Files:**
- Modify: `src/web/public/styles.css`

**Step 1: Remove the old desktop-bar rules**

Find and remove the comment and rule around line 8233-8235:

```css
/* Desktop bar is hidden — toolbar stays on desktop */
.desktop-bar { display: none !important; }
```

Then remove ALL the `.desktop-bar-*` rule blocks that follow (`.desktop-bar-run-group`, `.desktop-bar-run`, `.desktop-bar-run:hover`, `.desktop-bar-run-gear`, `.desktop-bar-run-gear:hover`, `.desktop-bar-stop`, `.desktop-bar-stop:hover`, `.desktop-bar-shell`, `.desktop-bar-shell:hover`, `.desktop-bar-count-group`, `.desktop-bar-count-btn`, `.desktop-bar-count-btn:hover`, `.desktop-bar-count-input`, the spin-button rules, `.desktop-bar-project-group`, `.desktop-bar-project-icon`, `.desktop-bar-project-select`, `.desktop-bar-spacer`, `.desktop-bar-version`, `.desktop-bar-sessions`, `.desktop-bar-sessions:hover`). These are all dead code now that the HTML is removed.

**Step 2: Add the desktop bottom bar block at the end of styles.css**

Append this block to the very end of the file:

```css
/* ================================================================
   Desktop Bottom Bar (>=1024px)
   compose-bar + accessory-bar replace the old .toolbar footer.
   mobile.css is NOT loaded on desktop — all desktop styles live here.
   ================================================================ */
@media (min-width: 1024px) {
  /* Hide old toolbar footer */
  footer.toolbar { display: none !important; }

  /* Main content area: reserve space at bottom for the two fixed bars.
     CSS var --desktop-compose-height is updated by JS on textarea resize. */
  .main {
    padding-bottom: calc(var(--desktop-compose-height, 52px) + 40px);
  }

  /* ── Accessory bar ─────────────────────────────────────────── */
  .keyboard-accessory-bar {
    display: flex !important;   /* Always visible on desktop */
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 40px;
    background: #1a1a1a;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    padding: 6px 8px;
    gap: 8px;
    align-items: center;
    z-index: 51;
    overflow: visible;
  }

  /* ── Compose bar ───────────────────────────────────────────── */
  .mobile-input-panel {
    position: fixed !important;
    bottom: 40px;
    left: 0;
    right: 0;
    background: #111;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding: 8px 12px;
    z-index: 52;
    display: block !important;  /* Override inline style="display:none" */
  }

  /* Centered 720px textarea wrapper; .expanded overrides to near-full-width */
  .compose-textarea-wrap {
    max-width: 720px;
    margin: 0 auto;
    position: relative;
  }

  .compose-textarea-wrap.expanded {
    max-width: calc(100% - 24px);
  }

  /* Textarea sizing on desktop */
  .compose-textarea {
    font-size: 0.875rem;
    min-height: 36px;
    max-height: 200px;
    /* Padding-right: room for expand btn (~28px) + send btn (~40px) */
    padding-right: 76px;
  }

  /* Expand button: show on desktop (inline style="display:none" is overridden) */
  .compose-expand-btn {
    display: inline-flex !important;
    right: 44px;   /* Left of send button */
    bottom: 8px;
  }

  /* Swap expand/collapse icons based on wrapper state */
  .compose-expand-icon { display: block; }
  .compose-collapse-icon { display: none; }
  .compose-textarea-wrap.expanded .compose-expand-icon { display: none; }
  .compose-textarea-wrap.expanded .compose-collapse-icon { display: block; }

  /* Commands drawer: slides up from accessory bar */
  .accessory-cmd-drawer {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    background: #1e1e1e;
    border-top: 1px solid rgba(255, 255, 255, 0.15);
    display: flex;
    flex-direction: column;
    pointer-events: none;
    opacity: 0;
    transform: translateY(8px);
    transition: transform 0.18s ease-out, opacity 0.15s ease-out;
    max-height: 40vh;
    overflow-y: auto;
  }
  .accessory-cmd-drawer.open {
    pointer-events: auto;
    opacity: 1;
    transform: translateY(0);
  }

  /* ── Accessory button base ─────────────────────────────────── */
  .accessory-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px 12px;
    background: #2a2a2a;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    color: #e5e5e5;
    font-size: 0.65rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .accessory-btn:hover { background: #3a3a3a; }
  .accessory-btn:active { background: #3a3a3a; }

  .accessory-btn-arrow {
    padding: 6px 10px;
    background: #1e3a5f;
    border-color: rgba(59, 130, 246, 0.3);
    color: #93c5fd;
  }
  .accessory-btn-arrow:hover { background: #2563eb; }

  .accessory-btn-commands {
    background: #1e2a3a;
    border-color: rgba(100, 160, 255, 0.3);
    color: #93c5fd;
    font-size: 0.75rem;
    letter-spacing: 0.03em;
  }
  .accessory-btn-commands:hover { background: #2a3a5a; }

  /* Context pill */
  .accessory-ctx-pill {
    display: none;   /* Hidden by default; JS shows it when context data is available */
    align-items: center;
    justify-content: center;
    padding: 4px 8px;
    background: #1e2e1e;
    border: 1px solid rgba(74, 222, 128, 0.25);
    border-radius: 6px;
    color: #4ade80;
    font-size: 0.65rem;
    font-weight: 600;
    flex-shrink: 0;
  }

  /* Project button */
  .accessory-btn-project {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 0 8px;
    max-width: 160px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .accessory-project-name {
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #cbd5e1;
  }
  .accessory-project-caret {
    font-size: 9px;
    color: #64748b;
    flex-shrink: 0;
  }

  /* Flex spacer between commands and project */
  .accessory-btn-spacer { flex: 1; }

  /* Commands search input */
  .accessory-cmd-search {
    display: block;
    width: 100%;
    padding: 10px 16px;
    background: #111;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    color: #e5e5e5;
    font-size: 14px;
    outline: none;
    box-sizing: border-box;
  }
  .accessory-cmd-search::placeholder { color: #555; }

  .accessory-cmd-items {
    overflow-y: auto;
    max-height: calc(40vh - 44px);
  }

  .accessory-drawer-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    padding: 10px 20px;
    background: none;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    text-align: left;
    cursor: pointer;
    color: inherit;
  }
  .accessory-drawer-item:hover { background: #2a2a2a; }

  .drawer-cmd-name { color: #e5e5e5; font-size: 0.9rem; font-family: monospace; }
  .drawer-cmd-desc { color: #6b7280; font-size: 0.75rem; margin-top: 1px; }
}
```

**Step 3: Commit**

```bash
git add src/web/public/styles.css
git commit -m "feat: desktop bottom bar CSS — compose + accessory replace toolbar"
```

---

## Task 4: Enable KeyboardAccessoryBar on desktop

**Files:**
- Modify: `src/web/public/keyboard-accessory.js`

**Step 1: Remove the touch-device-only guard**

Find in `init()` (around line 112):

```javascript
  init() {
    // Only on mobile
    if (!MobileDetection.isTouchDevice()) return;
```

Change to:

```javascript
  init() {
    // Initializes on all platforms; bar is always visible on desktop
```

**Step 2: Add `visible` class immediately on desktop**

Find the insert-before-toolbar block (around line 270):

```javascript
    // Insert before toolbar
    const toolbar = document.querySelector('.toolbar');
    if (toolbar && toolbar.parentNode) {
      toolbar.parentNode.insertBefore(this.element, toolbar);
    }
```

Add immediately after it:

```javascript
    // On desktop, bar is always visible (not gated by keyboard appearance)
    if (typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() !== 'mobile') {
      this.element.classList.add('visible');
    }
```

**Step 3: Commit**

```bash
git add src/web/public/keyboard-accessory.js
git commit -m "feat: enable KeyboardAccessoryBar on desktop (remove touch-only guard)"
```

---

## Task 5: Enable InputPanel always-on + expand button in app.js

**Files:**
- Modify: `src/web/public/app.js`

**Step 1: Always init and open InputPanel**

Find (around line 532):

```javascript
    if (typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice()) {
      InputPanel.init();
    }
    // Always-visible compose bar on mobile (no pencil toggle needed)
    if (typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() === 'mobile') {
      InputPanel.open();
    }
```

Replace with:

```javascript
    InputPanel.init();
    // Always-visible compose bar on mobile and desktop
    InputPanel.open();
```

**Step 2: Fix `_autoGrow` for desktop — cap at 200px and update CSS variable**

Find the `_autoGrow` method (around line 13468):

```javascript
  _autoGrow(ta) {
    ta.style.height = 'auto';
    const vvh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const maxH = Math.max(80, vvh - 200);
    ta.style.maxHeight = maxH + 'px';
    ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px';
  },
```

Replace with:

```javascript
  _autoGrow(ta) {
    ta.style.height = 'auto';
    const isDesktop = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() === 'desktop';
    const vvh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const maxH = isDesktop ? 200 : Math.max(80, vvh - 200);
    ta.style.maxHeight = maxH + 'px';
    ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px';
    if (isDesktop) {
      // Update CSS var so .main padding-bottom tracks actual compose bar height
      const panel = document.getElementById('mobileInputPanel');
      const h = panel ? panel.getBoundingClientRect().height : 52;
      document.documentElement.style.setProperty('--desktop-compose-height', String(h) + 'px');
    }
  },
```

**Step 3: Don't close compose panel after send on desktop**

Find in `send()` the tail of the method (around line 13525):

```javascript
    ta.value = '';
    this._autoGrow(ta);
    this._images = [];
    this._renderThumbnails();
    this.close();
```

Replace with:

```javascript
    ta.value = '';
    this._autoGrow(ta);
    this._images = [];
    this._renderThumbnails();
    // Desktop: keep panel open (always-visible); mobile: close after send
    const isDesktop = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() === 'desktop';
    if (!isDesktop) this.close();
```

**Step 4: Wire up the expand button in `InputPanel.init()`**

Find in `InputPanel.init()` the existing button listener block (around line 13461):

```javascript
    const sendBtn = document.getElementById('composeSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', () => this.send());
  },
```

Add after that closing brace, still inside `init()`:

```javascript
    const sendBtn = document.getElementById('composeSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', () => this.send());

    // Expand/collapse button — desktop only
    const expandBtn = document.getElementById('composeExpandBtn');
    if (expandBtn) {
      const isDesktop = typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType() === 'desktop';
      if (isDesktop) {
        expandBtn.style.display = '';
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
  },
```

Note: icon toggling is handled purely by CSS (`.compose-textarea-wrap.expanded .compose-expand-icon { display: none }` etc.) — no JS needed.

**Step 5: Remove dead `desktopProjectSelect` / `_syncDesktopProject` code**

Remove the `_syncDesktopProject` method (around line 4794-4801):

```javascript
  _syncDesktopProject(caseName) {
    const sel = document.getElementById('quickStartCase');
    if (sel) sel.value = caseName;
    this.updateMobileCaseLabel(caseName);
    this.updateDirDisplayForCase(caseName);
    this.saveLastUsedCase(caseName);
    KeyboardAccessoryBar?.updateProjectName?.();
  },
```

Remove the two `desktopProjectSelect` sync blocks in `loadQuickStartCases` (around lines 4611-4615 and 4642-4644):

```javascript
      // Sync desktop bar project select by cloning options
      const desktopSel = document.getElementById('desktopProjectSelect');
      if (desktopSel) {
        while (desktopSel.options.length) desktopSel.remove(0);
        for (const opt of select.options) desktopSel.add(new Option(opt.text, opt.value));
      }
```

and:

```javascript
      // Sync desktop select value to match hidden select
      const desktopSel2 = document.getElementById('desktopProjectSelect');
      if (desktopSel2) desktopSel2.value = select.value;
```

and the inline sync in the change listener (around line 4651):

```javascript
          const ds = document.getElementById('desktopProjectSelect');
          if (ds) ds.value = select.value;
```

Also remove the `desktopVersionDisplay` update block (search for `desktopVersionDisplay` and remove it — the version is still shown in `#versionDisplay` in the toolbar-right span).

**Step 6: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat: InputPanel always-on desktop — expand btn, padding var, no-close-on-send"
```

---

## Task 6: Playwright verification

**Files:** none (read-only verification)

**Step 1: Start dev server (if not already running)**

```bash
pkill -f "tsx src/index.ts" 2>/dev/null; sleep 1
npx tsx src/index.ts web &
sleep 3
```

**Step 2: Run verification script**

```javascript
// /tmp/verify-desktop-bar.js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Screenshot 1: initial state
  await page.screenshot({ path: '/tmp/desktop-bar-01-initial.png' });

  // Check bars are visible and positioned at bottom
  const accessoryBar = page.locator('.keyboard-accessory-bar');
  const composePanel = page.locator('#mobileInputPanel');
  const oldToolbar = page.locator('footer.toolbar');

  const accessoryBox = await accessoryBar.boundingBox();
  const composeBox = await composePanel.boundingBox();
  const toolbarVisible = await oldToolbar.isVisible().catch(() => false);

  console.log('Accessory bar bounds:', accessoryBox);
  console.log('Compose panel bounds:', composeBox);
  console.log('Old toolbar visible (should be false):', toolbarVisible);

  const vh = 800;
  if (accessoryBox) {
    const bottom = Math.round(accessoryBox.y + accessoryBox.height);
    console.log(`Accessory bar bottom edge: ${bottom}px / ${vh}px — ${bottom <= vh ? 'OK (at bottom)' : 'PROBLEM (overflows)'}`);
  }
  if (composeBox && accessoryBox) {
    const gap = accessoryBox.y - (composeBox.y + composeBox.height);
    console.log(`Gap between compose and accessory bar: ${gap}px (should be ~0)`);
  }

  // Test: click project button opens picker
  const projectBtn = page.locator('.accessory-btn-project');
  if (await projectBtn.count() > 0) {
    await projectBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/desktop-bar-02-project-picker.png' });
    const pickerModal = page.locator('#mobileCasePickerModal');
    const pickerOpen = await pickerModal.isVisible().catch(() => false);
    console.log('Project picker opened:', pickerOpen);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } else {
    console.log('ERROR: .accessory-btn-project not found');
  }

  // Test: type in compose textarea
  const textarea = page.locator('#composeTextarea');
  await textarea.click();
  await textarea.fill('test message from desktop compose bar');
  await page.screenshot({ path: '/tmp/desktop-bar-03-typing.png' });
  const panelAfterType = await composePanel.isVisible();
  console.log('Compose bar still open after typing:', panelAfterType);

  // Test: expand button visible and toggles
  const expandBtn = page.locator('#composeExpandBtn');
  const expandVisible = await expandBtn.isVisible().catch(() => false);
  console.log('Expand button visible:', expandVisible);
  if (expandVisible) {
    await expandBtn.click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/tmp/desktop-bar-04-expanded.png' });
    await expandBtn.click(); // collapse back
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/tmp/desktop-bar-05-collapsed.png' });
  }

  await browser.close();
  console.log('\nDone. View screenshots at /tmp/desktop-bar-*.png');
})();
```

Run: `node /tmp/verify-desktop-bar.js`

**Step 3: Inspect each screenshot**

View each screenshot in turn:
- `desktop-bar-01-initial.png`: compose bar + accessory bar flush at bottom; old toolbar gone; terminal fills rest
- `desktop-bar-02-project-picker.png`: project picker modal open
- `desktop-bar-03-typing.png`: text in textarea, bar still visible
- `desktop-bar-04-expanded.png`: textarea widens to near full-width
- `desktop-bar-05-collapsed.png`: back to 720px centered

**Step 4: Common issues and fixes**

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Old toolbar still visible | `footer.toolbar { display: none !important }` not in desktop media query | Verify styles.css block was added |
| Accessory bar not showing | `KeyboardAccessoryBar.init()` returning early | Check touch guard was removed |
| Compose bar hidden | `InputPanel.open()` not called or `display: block !important` not overriding | Check init change in app.js |
| Bar hovering above bottom | `bottom` not `0` on accessory bar | Confirm no `bottom: calc(...)` in styles.css desktop block |
| Project picker not opening | `app.showMobileCasePicker()` errors | Check browser console; `#mobileCasePickerModal` must be in HTML |
| Expand btn not visible | CSS `display: inline-flex !important` not reaching it | Check selector `.compose-expand-btn` in desktop media query |

**Step 5: Commit fixes**

```bash
git add -p
git commit -m "fix: desktop bar — <describe specific fix>"
```

---

## Task 7: COM (version bump + deploy)

**Step 1: Verify typecheck and lint pass**

```bash
tsc --noEmit 2>&1 | head -30
npm run lint 2>&1 | tail -20
```

Expected: no errors.

**Step 2: COM**

Follow the COM process in CLAUDE.md:

1. Create changeset file:
```bash
cat > .changeset/$(openssl rand -hex 4).md << 'CHANGESET'
---
"aicodeman": patch
---

feat: replace desktop toolbar with compose-bar + accessory-bar at bottom
CHANGESET
```

2. Consume: `npm run version-packages`
3. Update `**Version**` line in CLAUDE.md
4. Build and deploy:
```bash
git add -A && git commit -m "chore: version packages" && git push && npm run build
cp -r dist /home/siggi/.codeman/app/
cp package.json /home/siggi/.codeman/app/package.json
systemctl --user restart codeman-web
```

---

## Expected Final State

```
viewport (1280x800)
+---------------------------------------------------+
| [header / tab bar]                                | ~40px
+---------------------------------------------------+
|                                                   |
|   terminal content                                | flex:1
|   (padding-bottom keeps content above bars)       |
|                                                   |
+---------------------------------------------------+
| [+]  [ type a message...             expand ] [>] | ~52px compose
|       (max-width: 720px, centered)                |
+---------------------------------------------------+
| gear | 64% | up dn | /cmd | [spacer] | proj | nav | 40px accessory
+---------------------------------------------------+
```

# Mobile UX Overhaul v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the mobile+desktop session management UX: grouped session drawer, always-visible compose bar, Cases→Projects rename, worktree as workspace sub-group, improved close UX, session badge contrast, desktop sidebar pin.

**Architecture:** Pure frontend changes across 5 files (app.js, mobile.css, styles.css, keyboard-accessory.js, index.html). No backend route changes — `/api/cases` stays as-is. Drawer groups sessions by case using `app.cases` + per-session `caseId`/`worktreeBranch`. Testing via Playwright snapshots after each major phase.

**Tech Stack:** Vanilla JS (ES2022 modules), CSS custom properties, xterm.js, Playwright for verification.

**Design reference:** `docs/plans/2026-03-09-mobile-ux-overhaul-v2-design.md`

**Version bump rule (CLAUDE.md):**
- CSS files: increment trailing number in `?v=0.XXXX`
- JS modules: increment patch digit in `?v=0.4.X`
- Bump the version in `index.html` for every file you touch.

**DOM safety rule:** All dynamic string values inserted into the DOM MUST be sanitized. Use `element.textContent = value` for plain text. For HTML structure, build elements with `document.createElement` + `.textContent` + `.appendChild`. Only use `el.textContent` / `el.setAttribute` for dynamic data — never concatenate user data directly into HTML strings.

---

## Phase 1 — Quick Wins: Strings & Styles

### Task 1: Cases → Projects string renames in app.js

**Files:**
- Modify: `src/web/public/app.js` (search for UI-facing case/Case strings)

**Step 1: Find all UI-facing "case" strings (not API routes, not variable names)**

```bash
grep -n '"Cases"\|"Case"\|"Select Case\|New Case\|case picker' src/web/public/app.js | head -60
```

Note every line. We only rename UI-visible strings, not JS variable names like `this.cases`, `caseId`, `caseName` (internal), or API URLs like `/api/cases`.

**Step 2: Do the renames**

For each UI string found:
- `"Cases"` → `"Projects"`
- `"Case"` → `"Project"` (when it's a label, title, or button text)
- `"Select Case"` → `"Select Project"`
- `"New Case"` → `"New Project"`
- Leave untouched: `this.cases`, `caseId`, `caseName` (JS vars), `/api/cases` (routes)

**Step 3: Bump app.js version in index.html**

```bash
grep -n 'app.js?v=' src/web/public/index.html
```

Increment the patch digit (e.g. `v=0.4.35` → `v=0.4.36`).

**Step 4: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html
git commit -m "feat: rename Cases to Projects in UI strings"
```

---

### Task 2: Session badge contrast fix (styles.css)

**Files:**
- Modify: `src/web/public/styles.css`

**Step 1: Find existing session-type badge styles**

```bash
grep -n 'session.*badge\|badge.*session\|\.session-type\|mode.*badge\|tab-mode' src/web/public/styles.css | head -20
```

**Step 2: Add per-mode badge color variables after existing badge rules**

```css
/* Session mode badges — per-mode contrast colors */
.session-mode-badge {
  display: inline-block;
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 1px 5px;
  border-radius: 4px;
  vertical-align: middle;
  text-transform: lowercase;
}
.session-mode-badge[data-mode="claude"] {
  color: #60a5fa;
  background: rgba(59, 130, 246, 0.09);
  border: 1px solid rgba(59, 130, 246, 0.25);
}
.session-mode-badge[data-mode="shell"] {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.07);
  border: 1px solid rgba(74, 222, 128, 0.22);
}
.session-mode-badge[data-mode="opencode"] {
  color: #fb923c;
  background: rgba(251, 146, 60, 0.08);
  border: 1px solid rgba(251, 146, 60, 0.22);
}
```

**Step 3: Bump styles.css version in index.html**

```bash
grep -n 'styles.css?v=' src/web/public/index.html
```

Increment trailing number.

**Step 4: Commit**

```bash
git add src/web/public/styles.css src/web/public/index.html
git commit -m "feat: add per-mode session badge contrast colors"
```

---

### Task 3: Worktree tab badge — change color to teal

**Files:**
- Modify: `src/web/public/styles.css` (~`.tab-worktree-badge`)

**Step 1: Find and read current rules**

```bash
grep -n 'tab-worktree-badge' src/web/public/styles.css
```

**Step 2: Update color values from green to teal**

```css
/* Before */
color: rgba(34, 197, 94, 0.7);
border: 1px solid rgba(34, 197, 94, 0.3);

/* After */
color: #22d3ee;
border: 1px solid rgba(6, 182, 212, 0.35);
background: rgba(6, 182, 212, 0.08);
```

**Step 3: Commit**

```bash
git add src/web/public/styles.css
git commit -m "style: worktree tab badge — teal instead of green"
```

---

## Phase 2 — Worktree Modal Redesign

### Task 4: Redesign worktree cleanup modal in index.html

**Files:**
- Modify: `src/web/public/index.html` (~lines 1927-1953, `id="worktreeCleanupModal"`)

**Step 1: Read the current modal**

Read lines 1920-1960 in `index.html` to see the full current markup.

**Step 2: Replace the modal markup**

Replace the entire `worktreeCleanupModal` div with this updated version. Key changes:
- Replace `🌿` emoji with an inline SVG git-merge icon (teal stroke)
- Add a `×` close button in the header
- Add `onclick` to the overlay div to close on backdrop click
- Restructure buttons as stacked "action cards" with title + description
- Keep all existing IDs (`worktreeCleanupBranch`, `worktreeCleanupDesc`, `worktreeCleanupMergeTarget`, `worktreeCleanupOutput`)

Structure:
```
<div id="worktreeCleanupModal" class="modal modal-sm">
  <div class="modal-overlay" onclick="close modal">
  <div class="modal-content">
    <div class="modal-header">
      [SVG git-merge icon]  <code id="worktreeCleanupBranch">branch</code>
      [x close button]
    </div>
    <p id="worktreeCleanupDesc">What should happen to this worktree?</p>
    <div class="modal-actions-stack">
      [Merge into ... button]
      [Keep worktree button]
      [Remove worktree button — danger tint]
    </div>
    <div id="worktreeCleanupOutput" style="display:none">
  </div>
</div>
```

The SVG for git-merge icon (18x18, teal, no fill, stroke-width 2):
- Circle at (18,18) r=3, circle at (6,6) r=3, path `M6 21V9a9 9 0 0 0 9 9`

**Step 3: Add supporting CSS to styles.css**

```css
.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
.modal-header-left { display: flex; align-items: center; gap: 0.5rem; }
.modal-branch-name { font-family: monospace; font-size: 0.95rem; color: #e2e8f0; }
.modal-close-btn { background: none; border: none; color: #94a3b8; font-size: 1.4rem; cursor: pointer; padding: 0.2rem 0.4rem; border-radius: 4px; }
.modal-close-btn:hover { background: rgba(255,255,255,0.08); color: #e2e8f0; }
.modal-subtitle { color: #94a3b8; font-size: 0.85rem; margin: 0 0 1rem; }
.modal-actions-stack { display: flex; flex-direction: column; gap: 0.5rem; }
.modal-action-card { display: flex; flex-direction: column; align-items: flex-start; padding: 0.75rem 1rem; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; cursor: pointer; text-align: left; transition: background 0.15s; width: 100%; }
.modal-action-card:hover { background: rgba(255,255,255,0.08); }
.modal-action-card.modal-action-danger { border-color: rgba(239,68,68,0.25); }
.modal-action-card.modal-action-danger:hover { background: rgba(239,68,68,0.08); }
.action-card-title { font-size: 0.9rem; font-weight: 600; color: #e2e8f0; }
.action-card-desc { font-size: 0.75rem; color: #64748b; margin-top: 2px; }
```

**Step 4: Bump versions for styles.css and index.html**

**Step 5: Commit**

```bash
git add src/web/public/index.html src/web/public/styles.css
git commit -m "feat: redesign worktree cleanup modal — SVG icon, close button, backdrop"
```

---

### Task 5: Fix _onWorktreeSessionEnded desc-reset bug (app.js)

**Files:**
- Modify: `src/web/public/app.js`

**Step 1: Locate the functions**

```bash
grep -n '_onWorktreeSessionEnded\|openWorktreeCleanupForSession' src/web/public/app.js | head -20
```

Read both function bodies fully.

**Step 2: Understand the bug**

`openWorktreeCleanupForSession()` calls `_onWorktreeSessionEnded()` internally.
`_onWorktreeSessionEnded` always sets `worktreeCleanupDesc` to the auto-trigger text (`"Session ended — …"`), overwriting what a manual [merge] click should show.

**Step 3: Fix — add optional `desc` parameter to `_onWorktreeSessionEnded`**

Change the function signature to accept an optional `desc` parameter:

```
_onWorktreeSessionEnded(data, desc)
```

Inside the function, when setting the description element:
```
use: desc ?? 'Session ended — what should happen to this worktree?'
```

In `openWorktreeCleanupForSession`, pass the manual description when calling `_onWorktreeSessionEnded`:
```
pass desc: 'What should happen to this worktree?'
```

**Step 4: Bump app.js version**

**Step 5: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html
git commit -m "fix: worktree cleanup desc-reset bug — pass desc through _onWorktreeSessionEnded"
```

---

## Phase 3 — Accessory Bar Reorder

### Task 6: Reorder keyboard-accessory.js buttons

**Files:**
- Modify: `src/web/public/keyboard-accessory.js`

**Step 1: Read the init() button creation block**

Read lines 80-230 in `keyboard-accessory.js` to see current button order and creation logic.

**Step 2: Current vs new order**

Current: tab → scroll-up → scroll-down → commands → copy → pencil → hamburger → context-pill

New (left to right):
1. `⚙️` Settings gear — new, opens settings modal
2. Context pill `64%` — moved from rightmost to position 2
3. `↑` scroll-up
4. `↓` scroll-down
5. `/▲` commands
6. Flex spacer div
7. `📁 Project ▾` — new project picker button
8. `≡` hamburger (session drawer)

Remove: pencil (compose), copy, tab buttons.

**Step 3: Create the settings gear button**

Build via `document.createElement('button')`, set:
- `className = 'accessory-btn accessory-btn-settings'`
- `title = 'Settings'`
- Append SVG gear icon as child `<svg>` element (build with DOM APIs, not HTML string)
- On click: `document.getElementById('settingsModal')?.classList.add('active')`

**Step 4: Create the project picker button**

Build via `document.createElement('button')`, set:
- `className = 'accessory-btn accessory-btn-project'`
- `id = 'accessoryProjectBtn'`
- `title = 'Switch project'`
- Children (built with DOM): 📁 icon span, project name span (`id="accessoryProjectName"`), caret span
- On click: `app?.openCasePickerModal?.()`

**Step 5: Create the flex spacer**

```js
const spacer = document.createElement('div');
spacer.style.flex = '1';
```

**Step 6: Re-wire append order**

Append to bar in this order: settingsBtn, contextPill, scrollUpBtn, scrollDownBtn, commandsBtn, spacer, projectBtn, hamburgerBtn.

Remove the pencil, copy, and tab button creation code entirely.

**Step 7: Update project name display**

In the `update()` or sync method, also update `#accessoryProjectName`:
- Get `app?.activeCaseName || 'Project'`
- Truncate to 9 chars + `…` if longer
- Set via `.textContent`

**Step 8: Bump keyboard-accessory.js version in index.html**

**Step 9: Commit**

```bash
git add src/web/public/keyboard-accessory.js src/web/public/index.html
git commit -m "feat: reorder accessory bar — settings gear, context pill, project picker, no pencil"
```

---

### Task 7: Accessory bar CSS — new button styles (mobile.css)

**Files:**
- Modify: `src/web/public/mobile.css`

**Step 1: Add styles for new buttons after the `.accessory-btn` section**

```css
/* Settings gear button */
.accessory-btn-settings {
  color: #94a3b8;
  flex-shrink: 0;
}

/* Project picker button */
.accessory-btn-project {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 0 8px;
  min-width: 0;
  max-width: 110px;
  overflow: hidden;
  flex-shrink: 0;
}
.accessory-project-icon { font-size: 12px; flex-shrink: 0; }
.accessory-project-name {
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #cbd5e1;
}
.accessory-project-caret { font-size: 9px; color: #64748b; flex-shrink: 0; }
```

**Step 2: Bump mobile.css version in index.html**

**Step 3: Commit**

```bash
git add src/web/public/mobile.css src/web/public/index.html
git commit -m "style: accessory bar project picker and settings gear styles"
```

---

## Phase 4 — Mobile Bottom Layer Restructure

### Task 8: Hide mobile footer, compose bar always visible (mobile.css)

**Files:**
- Modify: `src/web/public/mobile.css`

**Step 1: Find .toolbar rules**

```bash
grep -n '\.toolbar' src/web/public/mobile.css | head -20
```

**Step 2: Hide footer toolbar on mobile**

Add (inside the appropriate mobile context or at top-level since mobile.css is mobile-only):

```css
/* Hide legacy footer toolbar on mobile — replaced by compose bar + accessory bar */
.toolbar {
  display: none !important;
}
```

**Step 3: Ensure InputPanel is always visible**

Find the `.mobile-input-panel` rules. Remove any `display: none`, `opacity: 0`, or transform-based hide that was triggered by default. If the panel uses a `.hidden` class, override:

```css
/* Always-on compose bar — remove toggle-hidden behavior */
.mobile-input-panel {
  display: flex !important;
  opacity: 1 !important;
  pointer-events: auto !important;
  transform: none !important;
}
```

**Step 4: Verify compose bar positioning**

Check the `bottom` value on `.mobile-input-panel`. It must clear the accessory bar (~50px + safe area). The existing `calc(var(--safe-area-bottom) + 84px)` should be correct. Adjust if the footer removal changes the layout.

**Step 5: Bump mobile.css version in index.html**

**Step 6: Commit**

```bash
git add src/web/public/mobile.css src/web/public/index.html
git commit -m "feat: hide mobile footer, compose bar always-on"
```

---

### Task 9: InputPanel always open on mobile init (app.js)

**Files:**
- Modify: `src/web/public/app.js`

**Step 1: Find InputPanel initialization**

```bash
grep -n 'InputPanel\.' src/web/public/app.js | grep -i 'init\|open\|toggle' | head -20
```

**Step 2: Open panel on mobile immediately after init**

After the `InputPanel.init()` call (or in the DOMContentLoaded/app init block), add:

```js
// Always-visible compose bar on mobile
if (MobileDetection.isMobile()) {
  InputPanel.open();
}
```

**Step 3: Remove pencil button's active-state sync calls**

```bash
grep -n 'setComposeActive\|inputToggleBtn\|composeActive' src/web/public/app.js | head -15
```

Remove or no-op these calls since the pencil button no longer exists on mobile. Do not remove if they're guarded for desktop use.

**Step 4: Bump app.js version**

**Step 5: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html
git commit -m "feat: InputPanel always open on mobile, remove pencil toggle sync"
```

---

## Phase 5 — Session Drawer Redesign

### Task 10: Session drawer CSS — grouped layout (styles.css)

**Files:**
- Modify: `src/web/public/styles.css`

**Step 1: Find existing drawer item styles**

```bash
grep -n 'session-drawer-item\|session-drawer' src/web/public/styles.css | head -30
```

**Step 2: Add grouped drawer CSS after the existing `.session-drawer` block**

Add all of the following CSS rules:

```css
/* ── Grouped Session Drawer ───────────────────────────── */

/* Project group header */
.drawer-project-group { margin-bottom: 4px; }
.drawer-project-header {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px 4px;
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em;
  color: #64748b; text-transform: uppercase; user-select: none;
}
.drawer-project-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer-project-branch {
  font-size: 0.65rem; font-weight: 500; font-family: monospace; color: #475569;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.07);
  border-radius: 4px; padding: 1px 5px;
}
.drawer-add-btn {
  background: none; border: none; color: #475569; cursor: pointer;
  font-size: 1rem; padding: 2px 4px; border-radius: 4px; line-height: 1; flex-shrink: 0;
}
.drawer-add-btn:hover { background: rgba(255,255,255,0.08); color: #94a3b8; }

/* Worktree sub-group */
.drawer-worktree-group {
  margin: 2px 8px 4px;
  border-left: 2px solid rgba(6, 182, 212, 0.28);
  background: rgba(6, 182, 212, 0.03);
  border-radius: 0 6px 6px 0;
}
.drawer-worktree-header {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px 3px; font-size: 0.7rem; color: #22d3ee;
}
.drawer-worktree-icon { opacity: 0.8; }
.drawer-worktree-branch { flex: 1; font-family: monospace; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer-merge-btn {
  background: none; border: 1px solid rgba(6, 182, 212, 0.3); color: #22d3ee;
  cursor: pointer; font-size: 0.65rem; padding: 2px 6px; border-radius: 4px;
}
.drawer-merge-btn:hover { background: rgba(6, 182, 212, 0.1); }

/* Session rows */
.drawer-session-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; cursor: pointer;
  border-radius: 6px; margin: 1px 4px;
  transition: background 0.12s;
}
.drawer-session-row:hover { background: rgba(255,255,255,0.06); }
.drawer-session-row.active { background: rgba(59,130,246,0.12); }
.drawer-session-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #4ade80;
}
.drawer-session-dot.idle { background: #475569; }
.drawer-session-name {
  flex: 1; font-size: 0.82rem; color: #cbd5e1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.drawer-worktree-group .drawer-session-name { font-size: 0.78rem; color: #94a3b8; }

/* X close button per session row */
.drawer-session-close {
  width: 26px; height: 26px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; color: #334155; font-size: 14px;
  cursor: pointer; border-radius: 4px; transition: background 0.12s, color 0.12s;
}
.drawer-session-close:hover { background: rgba(239,68,68,0.12); color: #f87171; }

/* Drawer footer */
.drawer-footer {
  padding: 10px 12px; border-top: 1px solid rgba(255,255,255,0.06);
  display: flex; gap: 8px;
}
.drawer-footer-btn {
  flex: 1; padding: 8px 10px;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; color: #94a3b8; font-size: 0.78rem; cursor: pointer; text-align: center;
}
.drawer-footer-btn:hover { background: rgba(255,255,255,0.08); color: #e2e8f0; }

/* Quick-add popover */
.drawer-quick-add {
  position: absolute; background: #1e2d42;
  border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 100; min-width: 200px;
}
.drawer-quick-add-title { font-size: 0.72rem; color: #64748b; padding: 0 4px 6px; font-weight: 600; }
.drawer-quick-add-row { display: flex; gap: 6px; }
.drawer-mode-btn {
  flex: 1; padding: 8px 4px;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; color: #94a3b8; font-size: 0.72rem; cursor: pointer;
  text-align: center; display: flex; flex-direction: column; align-items: center; gap: 2px;
}
.drawer-mode-btn:hover { background: rgba(255,255,255,0.1); color: #e2e8f0; }
.drawer-mode-btn.selected { background: rgba(59,130,246,0.15); border-color: rgba(59,130,246,0.4); color: #93c5fd; }
.drawer-mode-btn-icon { font-size: 1rem; }

/* Worktree creation form (inside popover) */
.drawer-worktree-form { padding: 8px 4px 4px; display: flex; flex-direction: column; gap: 8px; }
.drawer-form-back { background: none; border: none; color: #64748b; font-size: 0.72rem; cursor: pointer; padding: 2px 0; text-align: left; }
.drawer-form-back:hover { color: #94a3b8; }
.drawer-form-label { font-size: 0.7rem; color: #64748b; margin-bottom: 2px; }
.drawer-form-input {
  width: 100%; padding: 6px 8px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; color: #e2e8f0; font-size: 0.8rem; font-family: monospace;
}
.drawer-from-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.drawer-from-chip {
  padding: 3px 8px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 20px; color: #94a3b8; font-size: 0.72rem; cursor: pointer;
}
.drawer-from-chip.selected { background: rgba(59,130,246,0.15); border-color: rgba(59,130,246,0.4); color: #93c5fd; }
.drawer-create-btn {
  padding: 8px; background: #2563eb; border: none; border-radius: 8px;
  color: #fff; font-size: 0.82rem; font-weight: 600; cursor: pointer; width: 100%;
}
.drawer-create-btn:hover { background: #1d4ed8; }

/* Mobile close confirmation sheet (pinned to bottom of drawer) */
.drawer-close-sheet {
  position: absolute; bottom: 0; left: 0; right: 0;
  background: #1a2236; border-top: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px 12px 0 0; padding: 12px; z-index: 10;
  display: flex; flex-direction: column; gap: 8px;
}
.drawer-close-sheet-title { font-size: 0.8rem; color: #94a3b8; padding: 0 4px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.close-sheet-option {
  padding: 12px; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
  cursor: pointer; display: flex; flex-direction: column; gap: 2px;
  background: rgba(255,255,255,0.03);
}
.close-sheet-option:hover { background: rgba(255,255,255,0.07); }
.close-sheet-option.danger { border-color: rgba(239,68,68,0.3); }
.close-sheet-option.danger:hover { background: rgba(239,68,68,0.08); }
.close-sheet-option-title { font-size: 0.88rem; font-weight: 600; color: #e2e8f0; }
.close-sheet-option.danger .close-sheet-option-title { color: #f87171; }
.close-sheet-option-desc { font-size: 0.72rem; color: #64748b; }
.close-sheet-cancel { background: none; border: none; color: #64748b; font-size: 0.85rem; cursor: pointer; padding: 8px; text-align: center; }
.close-sheet-cancel:hover { color: #94a3b8; }

/* Desktop pinned sidebar */
@media (min-width: 1024px) {
  body.sidebar-pinned .session-drawer { transform: translateX(0) !important; }
  body.sidebar-pinned .session-drawer-overlay { display: none; }
  body.sidebar-pinned .main-content { margin-right: 300px; }
  .drawer-pin-btn {
    background: none; border: none; color: #64748b; cursor: pointer;
    font-size: 0.9rem; padding: 2px 6px; border-radius: 4px; margin-left: auto;
  }
  .drawer-pin-btn:hover { color: #94a3b8; }
}
```

**Step 3: Bump styles.css version in index.html**

**Step 4: Commit**

```bash
git add src/web/public/styles.css src/web/public/index.html
git commit -m "feat: grouped session drawer CSS — project groups, worktree sub-groups, close sheet, sidebar pin"
```

---

### Task 11: SessionDrawer._render() — grouped by project (app.js)

**Files:**
- Modify: `src/web/public/app.js` (SessionDrawer object, `_render()` method)

**Step 1: Read the current SessionDrawer block**

```bash
grep -n 'SessionDrawer\|_render' src/web/public/app.js | head -30
```

Read the full SessionDrawer object definition (approx 100 lines).

**Step 2: Check session data shape**

```bash
curl localhost:3001/api/sessions | jq '.[0] | {id, name, caseId, status, cliMode, worktreeBranch}'
curl localhost:3001/api/cases | jq '.[0]'
```

Note exact field names. The plan uses `caseId`, `cliMode`, `worktreeBranch` — verify these match real API response field names. Adjust code accordingly.

**Step 3: Add helper method `_esc(str)` to SessionDrawer**

This sanitizes any dynamic string for use in text content (not HTML strings — use it with `.textContent` and `.setAttribute`):

```js
_esc(str) {
  return String(str ?? '');
},
```

Note: Use `element.textContent = this._esc(val)` for all dynamic values. Never concatenate into HTML template strings.

**Step 4: Add `_renderSessionRow(session)` method**

Build the row using DOM API (createElement + setAttribute + textContent + appendChild), not template strings. Structure:
- Outer div: `className = 'drawer-session-row' + (active ? ' active' : '')`; `dataset.sessionId = s.id`
- Dot span: `className = 'drawer-session-dot' + (active ? '' : ' idle')`
- Name span: `className = 'drawer-session-name'`; `textContent = s.name || s.id`
- Badge span: `className = 'session-mode-badge'`; `setAttribute('data-mode', modeLabel)`; `textContent = modeLabel`
- Close button: `className = 'drawer-session-close'`; `setAttribute('aria-label', 'Close session')`; `textContent = '×'`

Wire events:
- Row click: `app.switchToSession(s.id); SessionDrawer.close()`
- Close button click: `e.stopPropagation(); this._showCloseSheet(s.id, s.name || s.id)`

**Step 5: Rewrite `_render()` with grouping logic**

```
_render() {
  const list = document.getElementById('sessionDrawerList');
  list.textContent = ''; // clear safely

  // Build groups map: caseId -> { case, worktrees: Map(branch -> Session[]), sessions: Session[] }
  const groups = new Map();
  const caseMap = new Map((app.cases || []).map(c => [c.id, c]));

  for (const id of app.sessionOrder) {
    const s = app.sessions.get(id);
    if (!s) continue;
    const caseId = s.caseId || '__none__';
    if (!groups.has(caseId)) {
      groups.set(caseId, { case: caseMap.get(caseId), worktrees: new Map(), sessions: [] });
    }
    const g = groups.get(caseId);
    if (s.worktreeBranch) {
      if (!g.worktrees.has(s.worktreeBranch)) g.worktrees.set(s.worktreeBranch, []);
      g.worktrees.get(s.worktreeBranch).push(s);
    } else {
      g.sessions.push(s);
    }
  }

  for (const [caseId, group] of groups) {
    const projectName = group.case?.name || caseId;
    const groupEl = document.createElement('div');
    groupEl.className = 'drawer-project-group';

    // Project header row (all built via DOM APIs, no HTML string concat)
    const header = document.createElement('div');
    header.className = 'drawer-project-header';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'drawer-project-name';
    nameSpan.textContent = projectName.toUpperCase();
    const addBtn = document.createElement('button');
    addBtn.className = 'drawer-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'New session in ' + projectName;
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      this._showQuickAdd(e.currentTarget, caseId, projectName, false);
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
      const icon = document.createElement('span');
      icon.className = 'drawer-worktree-icon';
      icon.textContent = '⎇';
      const branchSpan = document.createElement('span');
      branchSpan.className = 'drawer-worktree-branch';
      branchSpan.textContent = branch;
      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'drawer-merge-btn';
      mergeBtn.textContent = 'merge';
      mergeBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (wtSessions[0]) app.openWorktreeCleanupForSession(wtSessions[0].id);
      });
      const wtAddBtn = document.createElement('button');
      wtAddBtn.className = 'drawer-add-btn';
      wtAddBtn.textContent = '+';
      wtAddBtn.title = 'Add session to ' + branch;
      wtAddBtn.addEventListener('click', e => {
        e.stopPropagation();
        this._showQuickAdd(e.currentTarget, caseId, branch, true);
      });
      wtHeader.appendChild(icon);
      wtHeader.appendChild(branchSpan);
      wtHeader.appendChild(mergeBtn);
      wtHeader.appendChild(wtAddBtn);
      wtGroup.appendChild(wtHeader);

      for (const s of wtSessions) wtGroup.appendChild(this._renderSessionRow(s));
      groupEl.appendChild(wtGroup);
    }

    // Regular sessions
    for (const s of group.sessions) groupEl.appendChild(this._renderSessionRow(s));
    list.appendChild(groupEl);
  }

  // Footer
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
  footer.appendChild(newBtn);
  footer.appendChild(cloneBtn);
  list.appendChild(footer);
},
```

**Step 6: Bump app.js version**

**Step 7: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html
git commit -m "feat: session drawer grouped by project with worktree sub-groups"
```

---

### Task 12: Quick-add popover (app.js)

**Files:**
- Modify: `src/web/public/app.js` (add `_showQuickAdd` and `_showWorktreeForm` methods to SessionDrawer)

**Step 1: Add `_showQuickAdd(anchorEl, caseId, groupName, worktreeOnly)` method**

Build the popover entirely with DOM APIs (createElement + textContent). No HTML string template injection.

Popover structure (all via DOM):
- Remove any existing `.drawer-quick-add` first
- Title text: `worktreeOnly ? 'Add session to X' : 'Start new session in X'`
- Mode buttons array: Claude (▶), Shell (⚡), OpenCode (◈) — plus Worktree (⎇) if not worktreeOnly
- On mode button click: if mode is 'worktree', call `this._showWorktreeForm(popover, caseId, groupName)`; else call `app.startSessionInCase?.(caseId, mode)` and remove popover
- Position: use `getBoundingClientRect()` on anchor and drawer to set `right` and `top` CSS
- Dismiss on outside click via a delegated document click listener (added with `setTimeout 0` to avoid immediate dismiss)

**Step 2: Add `_showWorktreeForm(popover, caseId, groupName)` method**

Clear the popover content (via `.textContent = ''`), then build:
- Back button (calls `_showQuickAdd` again)
- Title text: `⎇ New worktree in X`
- Form section with: branch input, "From" branch chips, mode selector row, "Create & Start" button

State tracking (local vars):
- `selectedFrom` = first branch (from `app.cases?.find(c => c.id === caseId)?.branches || ['master']`)
- `selectedMode` = 'claude'

On "Create & Start" click:
- Read branch input value (trim, bail if empty)
- Remove popover
- Call `app.createWorktreeAndStartSession?.(caseId, branch, selectedFrom, selectedMode)`

**Step 3: Bump app.js version**

**Step 4: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html
git commit -m "feat: session drawer quick-add popover with inline worktree creation form"
```

---

### Task 13: Mobile close confirmation bottom sheet (app.js)

**Files:**
- Modify: `src/web/public/app.js` (add `_showCloseSheet` to SessionDrawer)

**Step 1: Add `_showCloseSheet(sessionId, sessionName)` method**

Logic:
- Desktop path: if `!MobileDetection.isMobile()`, call `app.requestCloseSession(sessionId)` and return
- Mobile path: remove any existing `.drawer-close-sheet`, then build a sheet div

Sheet structure (all DOM APIs, no HTML string injection):
- Title: `'Close "' + truncatedName + '"'` via textContent
- "Kill Session" card button (`.close-sheet-option.danger`):
  - Title textContent: `'× Kill Session'`
  - Desc textContent: `'Stops Claude & kills tmux — cannot be undone'`
  - On click: `sheet.remove(); app.confirmCloseSession?.(true, sessionId)`
- "Remove Tab" card button (`.close-sheet-option`):
  - Title textContent: `'○ Remove Tab'`
  - Desc textContent: `'Hides from drawer — tmux keeps running in background'`
  - On click: `sheet.remove(); app.confirmCloseSession?.(false, sessionId)`
- Cancel button: `sheet.remove()`
- Append to `document.getElementById('sessionDrawer')`

**Step 2: Verify confirmCloseSession accepts optional sessionId**

```bash
grep -n 'confirmCloseSession\b' src/web/public/app.js | head -10
```

If it only reads `this.pendingCloseSessionId`, update to: `const id = sessionId ?? this.pendingCloseSessionId;`

**Step 3: Bump app.js version**

**Step 4: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html
git commit -m "feat: mobile close confirmation sheet inside session drawer"
```

---

## Phase 6 — Desktop Enhancements

### Task 14: Desktop pinned sidebar toggle (app.js)

**Files:**
- Modify: `src/web/public/app.js`

**Step 1: Restore pin state on page load**

In the app init block (after DOM ready), add:

```js
// Restore pinned sidebar state (desktop only)
if (!MobileDetection.isMobile() && localStorage.getItem('sidebarPinned') === 'true') {
  document.body.classList.add('sidebar-pinned');
}
```

**Step 2: Add pin toggle button to the drawer**

In `SessionDrawer.open()` or after `_render()`, add a pin button to the drawer title element (desktop only, width >= 1024px):

```js
if (!MobileDetection.isMobile() && window.innerWidth >= 1024) {
  const titleEl = document.querySelector('.session-drawer-title');
  if (titleEl && !titleEl.querySelector('.drawer-pin-btn')) {
    const pinBtn = document.createElement('button');
    pinBtn.className = 'drawer-pin-btn';
    const pinned = document.body.classList.contains('sidebar-pinned');
    pinBtn.textContent = pinned ? '⇤' : '⇥';
    pinBtn.title = pinned ? 'Unpin sidebar' : 'Pin sidebar';
    pinBtn.addEventListener('click', () => {
      const nowPinned = !document.body.classList.contains('sidebar-pinned');
      document.body.classList.toggle('sidebar-pinned', nowPinned);
      localStorage.setItem('sidebarPinned', String(nowPinned));
      pinBtn.textContent = nowPinned ? '⇤' : '⇥';
      pinBtn.title = nowPinned ? 'Unpin sidebar' : 'Pin sidebar';
    });
    titleEl.appendChild(pinBtn);
  }
}
```

**Step 3: Bump app.js version**

**Step 4: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html
git commit -m "feat: desktop pinned sidebar toggle with localStorage persistence"
```

---

### Task 15: Cases → Projects rename — desktop (index.html)

**Files:**
- Modify: `src/web/public/index.html`

**Step 1: Find UI strings**

```bash
grep -n -i 'cases\|case picker\|select case\|new case' src/web/public/index.html
```

**Step 2: Update visible strings only**

Update button labels, modal titles, aria-labels containing "Case(s)" → "Project(s)". Leave element IDs like `id="caseModal"` and `data-case` attributes untouched.

**Step 3: Bump index.html version for changed assets**

**Step 4: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat: Cases to Projects rename in desktop HTML UI strings"
```

---

## Phase 7 — Verification

### Task 16: Playwright verification

**Step 1: Start dev server**

```bash
npx tsx src/index.ts web &
sleep 3
```

**Step 2: Write Playwright script to `/tmp/test-ux-v2.js`**

Test assertions (use `waitUntil: 'domcontentloaded'`, then `waitForTimeout(3000)` for async data):

Mobile context (390x844, iPhone UA):
- `.toolbar` should not be visible → assert `isVisible('.toolbar') === false`
- `.mobile-input-panel` should be visible → assert visible
- `.accessory-btn-settings` should exist → assert exists
- `.accessory-btn-project` should exist → assert exists
- No element with class `accessory-btn-compose` should exist (pencil removed)
- Open drawer (click hamburger) → `.drawer-project-header` should appear

Desktop context (1440x900):
- Top tab bar still present → assert `.session-tabs` visible
- Footer toolbar still present → assert `.toolbar` visible
- Session drawer opens → has `.drawer-project-header` elements

Take screenshots:
- `/tmp/ux-v2-mobile.png`
- `/tmp/ux-v2-desktop.png`
- `/tmp/ux-v2-mobile-drawer.png` (drawer open)

**Step 3: Run and review screenshots**

```bash
node /tmp/test-ux-v2.js
```

Open screenshots and verify layout matches design doc.

**Step 4: Build and deploy**

```bash
npm run build
cp -r dist /home/siggi/.codeman/app/
cp package.json /home/siggi/.codeman/app/package.json
systemctl --user restart codeman-web
```

**Step 5: Final commit**

```bash
git add -A
git commit -m "chore: UX overhaul v2 — all phases complete"
```

---

## Backend Compatibility Check

Before starting implementation, verify real session data shape matches what the plan assumes:

```bash
curl localhost:3001/api/sessions | jq '.[0] | {id, name, caseId, status, cliMode, worktreeBranch}'
curl localhost:3001/api/cases | jq '.[0] | {id, name}'
```

If field names differ (e.g. `mode` instead of `cliMode`), update all references in Phase 5 tasks accordingly.

---

## Version Bump Audit

After all tasks, verify `index.html` has incremented `?v=` for every touched file:

| File | Minimum version |
|------|----------------|
| `styles.css` | ≥ `0.1650` |
| `mobile.css` | ≥ `0.1655` |
| `keyboard-accessory.js` | ≥ `0.4.12` |
| `app.js` | ≥ `0.4.40` |

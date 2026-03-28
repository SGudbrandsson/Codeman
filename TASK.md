# Task

type: feature
status: reviewing
fix_cycles: 0
test_fix_cycles: 0
affected_area: frontend
title: Feature usage analytics — map all features and track which are actually used
branch: feat/usage-analytics
port: 3008

## Goal

Map out ALL features in the Codeman application, instrument them with lightweight usage tracking, and produce a report showing which features are being used and which are not. This will inform decisions about which features to keep, improve, or remove to simplify the app.

## What Counts as a "Feature"

Every distinct user-facing capability, including but not limited to:

### Header / Navigation
- Board tab (kanban board view)
- Action tab (action dashboard with attention items)
- Command tab (command panel)
- Session tabs (switching between sessions)
- Project selector (Codeman dropdown in accessory bar)
- Settings gear button
- Hamburger menu / overflow menu

### Session Management
- Create new session (+ button, quick-add popover)
- Session drawer (sidebar with project groups)
- Swipe between Sessions/Agents tabs in drawer
- Session search/filter
- Delete session
- Rename session
- Session drag-and-drop reordering

### Terminal / Chat
- Terminal input (typing commands)
- Compose bar (InputPanel textarea)
- Send button
- Voice input / microphone button (both desktop and mobile)
- Image paste (Ctrl+V with image)
- File attachment (+ button → file picker)
- Screenshot thumbnails in compose bar

### File Management
- File explorer / file browser
- File viewer
- File upload
- File download

### Board / Work Items
- Board view (kanban columns)
- Work item cards (click to open detail)
- Detail panel (view/edit work item)
- Claim work item
- Change status
- Add/remove dependency
- Open session from work item

### Action Dashboard
- Attention items list
- Open session button
- Unblock button
- Action card interactions

### Command Panel
- Slash commands (/ ▲ button)
- Terminal mode (>_ button)
- Command search

### Voice Input
- Deepgram voice recording
- Web Speech API fallback
- Voice settings configuration

### Mobile-Specific
- Keyboard accessory bar
- Mobile swipe navigation
- Touch gestures

### Other
- Worktree management (create, merge, delete)
- Agent profiles
- Project insights
- Log viewer
- Auto-clear / auto-compact
- Notifications (desktop/push)
- Settings modal (all sub-sections)
- Ralph wizard

## Implementation Approach

### Phase 1: Map All Features
- [ ] Crawl through app.js, index.html, mobile-handlers.js, voice-input.js
- [ ] Create a comprehensive feature registry (JSON or TypeScript map)
- [ ] Each feature entry: { id, name, category, description, triggerPoint (CSS selector or function name) }
- [ ] Write the registry to a file: `src/web/public/feature-registry.js`

### Phase 2: Add Lightweight Usage Tracking
- [ ] Create a `FeatureTracker` module that:
  - Records feature usage events with timestamp
  - Stores in localStorage (simple, no backend needed initially)
  - Tracks: feature ID, timestamp, count
  - Debounces rapid repeated uses (e.g., clicking same button 5x in 1 second = 1 use)
- [ ] Instrument each feature's entry point with `FeatureTracker.track('feature-id')`
  - For buttons: add to click handlers
  - For views: track when opened/rendered
  - For keyboard shortcuts: track in key handler
- [ ] Keep instrumentation lightweight — one-liner per feature, no behavior changes

### Phase 3: Usage Report View
- [ ] Add a "Feature Usage" section in Settings or as a new view
- [ ] Show table: Feature name | Category | Times used | Last used | First used
- [ ] Sort by usage count (ascending = least used at top)
- [ ] Color coding: red (never used), yellow (rarely used), green (frequently used)
- [ ] Export as JSON button for further analysis
- [ ] "Reset tracking" button

### Phase 4: Review & Commit
- [ ] Run tsc + lint
- [ ] Review all changes — ensure no behavior changes, only tracking added
- [ ] Commit

## Key Constraints
- **No behavior changes** — only add tracking, don't modify any feature behavior
- **No backend required** — use localStorage for storage (simple, private, no API needed)
- **Lightweight** — tracking code should be minimal, no performance impact
- **Privacy-first** — all data stays local, no external analytics services

## Root Cause / Spec

### File Structure

Three new files (all in `src/web/public/`):
- `feature-registry.js` — static registry of all feature descriptors
- `feature-tracker.js` — FeatureTracker singleton (localStorage, debounce, report UI)
- Edits to `index.html` — add `<script>` tags and the Usage Analytics tab in appSettingsModal
- Edits to `app.js`, `mobile-handlers.js`, `voice-input.js` — one-line `FeatureTracker.track(id)` calls at each feature entry point

### feature-registry.js

Declare `window.FeatureRegistry` as a plain array of objects:
```js
{ id: string, name: string, category: string, description: string }
```

Categories and feature IDs (complete list):

**header-nav**
- `header-board-tab` — Board button (`#boardViewBtn` onclick `app.toggleBoard()`)
- `header-action-tab` — Action button (`#actionDashboardBtn` onclick `app.toggleActionDashboard()`)
- `header-command-tab` — Command chat button (`#commandChatBtn` onclick `CommandPanel.toggle()`)
- `header-overflow-menu` — Overflow menu (⋮) button (`#overflowMenuBtn`)
- `header-settings` — Settings from overflow (`#ovfSettingsBtn`) / mobile gear button (`.btn-settings-mobile`)
- `header-mcp` — MCP Servers from overflow (`#ovfMcpBtn`)
- `header-plugins` — Plugins from overflow (`#ovfPluginsBtn`)
- `header-health-analyzer` — Health Analyzer from overflow (`#ovfHealthBtn`)
- `header-notifications` — Notifications from overflow (`#ovfNotifBtn`)
- `header-lifecycle-log` — Lifecycle Log from overflow (`#ovfLifecycleBtn`)
- `header-font-increase` — Font size + (`#ovfFontInc`)
- `header-font-decrease` — Font size - (`#ovfFontDec`)
- `header-model-picker` — Model chip click (opens model switcher, `#modelChipBtn`)
- `header-context-arc` — Context arc click (`#ctxArcBtn`)
- `header-tunnel-indicator` — Tunnel indicator click (`#tunnelIndicator`)
- `header-go-home` — Codeman logo click (`.logo` onclick `app.goHome()`)

**session-management**
- `session-select` — Switching to a session (`app.selectSession()`)
- `session-create-picker` — New session picker opened (`app.openNewPicker()`)
- `session-create-session` — Create session flow launched (`app.openSessionCreator()`)
- `session-create-worktree` — Create worktree flow launched (`app.openWorktreeCreator()`)
- `session-close` — Close session (tab × button → `app.requestCloseSession()`)
- `session-options` — Per-session options gear (tab gear → `app.openSessionOptions()`)
- `session-rename` — Inline rename (right-click on tab → `app.startInlineRename()`)
- `session-drag-reorder` — Tab drag-and-drop reorder (in `setupTabDragHandlers`, on drop)
- `session-search-open` — Session switcher opened (`SessionSwitcher.open()`)
- `session-search-select` — Session selected via switcher (`SessionSwitcher._select()`)
- `session-drawer-open` — Session drawer opened (`SessionDrawer.open()`)
- `session-drawer-swipe-tabs` — Drawer Sessions/Agents tab swipe (`DrawerSwipeHandler._commit()`)
- `session-drawer-agents-tab` — Drawer Agents tab clicked (drawer tab button click)

**terminal-chat**
- `terminal-input` — User types into terminal (debounced — `terminal.onData` in `CodemanApp`, once per 5s of activity)
- `compose-bar-send` — Compose bar Send button (`InputPanel.send()`)
- `compose-bar-voice-mic` — Compose bar microphone button click (`#composeMicBtn`)
- `compose-bar-plus` — Compose bar plus button click (`#composePlusBtn`)
- `compose-bar-image-paste` — Image pasted into compose bar (`InputPanel._onFilesFromPaste()`)
- `compose-bar-file-attach` — Non-image file attached (`InputPanel._uploadNonImageFiles()`)
- `compose-bar-slash-command` — Slash command popup shown (`InputPanel._handleSlashInput` when slash detected)
- `compose-bar-expand` — Compose bar expand/collapse (`#composeExpandBtn`)
- `keyboard-shortcut-ctrl-enter` — Ctrl+Enter to send (in compose textarea `keydown` handler)
- `keyboard-shortcut-ctrl-w` — Close session shortcut
- `keyboard-shortcut-ctrl-tab` — Next session shortcut
- `keyboard-shortcut-ctrl-k` — Kill all sessions shortcut
- `keyboard-shortcut-ctrl-l` — Clear terminal shortcut
- `keyboard-shortcut-ctrl-f` — Terminal search shortcut
- `keyboard-shortcut-ctrl-shift-f` — Session switcher shortcut
- `keyboard-shortcut-ctrl-shift-b` — Voice input shortcut
- `keyboard-shortcut-ctrl-shift-k` — Command panel shortcut
- `keyboard-shortcut-ctrl-shift-v` — Paste from clipboard shortcut
- `terminal-search-open` — Terminal search opened (`TerminalSearch.toggle()`)

**voice-input**
- `voice-desktop-toggle` — Desktop voice button clicked (`#voiceInputBtn` onclick `VoiceInput.toggle()`)
- `voice-mobile-toggle` — Mobile voice button clicked (`#voiceInputBtnMobile` onclick `VoiceInput.toggle()`)
- `voice-start` — Voice recording actually started (`VoiceInput.start()`)
- `voice-stop` — Voice recording stopped with result (`VoiceInput.stop()`)

**file-management**
- `file-browser-open` — File browser panel made visible (`app.loadFileBrowser()`)
- `file-browser-file-click` — File opened in preview (file item click in file browser)
- `file-upload` — File uploaded via upload button / compose plus
- `log-viewer-open` — Log viewer window opened (`app.openLogViewerWindow()`)

**board**
- `board-view-open` — Board view shown (`app.showBoard()`)
- `board-item-detail` — Work item detail panel opened (`BoardView._openDetail()`)
- `board-item-claim` — Claim work item button
- `board-item-status-change` — Work item status changed
- `board-item-open-session` — Open session from work item

**action-dashboard**
- `action-dashboard-open` — Action dashboard shown (`app.showActionDashboard()`)
- `action-item-open-session` — Open session from action item
- `action-item-unblock` — Unblock button clicked

**command-panel**
- `command-panel-open` — Command panel opened (`CommandPanel.open()`)
- `command-panel-send` — Message sent in command panel (`CommandPanel._send()`)

**settings**
- `settings-open` — App Settings modal opened (`app.openAppSettings()`)
- `settings-tab-display` — Display tab switched (`app.switchSettingsTab('settings-display')`)
- `settings-tab-claude` — Claude CLI tab switched
- `settings-tab-models` — Models tab switched
- `settings-tab-paths` — Paths tab switched
- `settings-tab-notifications` — Notifications tab switched
- `settings-tab-voice` — Voice tab switched
- `settings-tab-shortcuts` — Shortcuts tab switched
- `settings-tab-updates` — Updates tab switched
- `settings-tab-orchestrator` — Orchestrator tab switched
- `settings-tab-integrations` — Integrations tab switched
- `settings-tab-usage` — Feature Usage tab switched (the new tab added by this feature)
- `session-options-open` — Session Options modal opened (`app.openSessionOptions()`)
- `session-options-tab-respawn` — Respawn tab in session options
- `session-options-tab-context` — Context tab in session options
- `session-options-tab-ralph` — Ralph tab in session options
- `session-options-tab-summary` — Summary tab in session options
- `session-options-tab-terminal` — Terminal tab in session options
- `help-modal-open` — Help/keyboard shortcuts modal opened (`app.showHelp()`)

**panels**
- `monitor-panel-toggle` — Monitor panel toggled (`app.toggleMonitorPanel()`)
- `monitor-panel-detach` — Monitor panel detached (`app.toggleMonitorDetach()`)
- `ralph-panel-toggle` — Ralph/Todo panel toggled (`app.toggleRalphStatePanel()`)
- `project-insights-panel` — Project insights panel visible (triggered by `app.renderProjectInsightsPanel()`)
- `subagents-panel-open` — Subagents panel shown
- `context-bar-open` — Context panel opened (`ContextBar.toggle()`)

**mobile-specific**
- `mobile-swipe-session` — Horizontal swipe to switch session (`SwipeHandler._commit()`)
- `mobile-case-picker` — Mobile project picker opened (`app.showMobileCasePicker()`)
- `mobile-case-settings` — Mobile project settings toggled (`app.toggleCaseSettingsMobile()`)
- `keyboard-accessory-bar-action` — Any keyboard accessory bar button pressed (in `KeyboardAccessoryBar`, on button click)

**other**
- `ralph-wizard-open` — Ralph wizard invoked
- `notification-toggle` — Notifications toggled (`app.toggleNotifications()`)
- `token-stats-open` — Token statistics opened (`app.openTokenStats()`)
- `run-summary-open` — Run Summary modal opened (`app.openRunSummary()`)
- `auto-clear-trigger` — Auto-clear triggered (on `_onSessionCleared` if it was automatic)
- `worktree-resume` — Resume dormant worktree (`app._resumeWorktree()`)

### feature-tracker.js

`window.FeatureTracker` singleton:

```js
const FeatureTracker = {
  STORAGE_KEY: 'codeman-feature-usage',
  DEBOUNCE_MS: 1000,   // same ID within 1s = 1 event
  _data: null,         // lazy-loaded from localStorage
  _lastTrack: {},      // { [featureId]: timestamp } for debounce

  _load() { /* JSON.parse localStorage or return {} */ },
  _save() { /* JSON.stringify _data to localStorage */ },

  track(featureId) {
    // Debounce: if same id tracked < DEBOUNCE_MS ago, skip
    // Update _data[featureId] = { count, firstUsed, lastUsed }
    // _save()
  },

  getData() { /* returns copy of _data */ },

  reset() {
    this._data = {};
    this._lastTrack = {};
    localStorage.removeItem(this.STORAGE_KEY);
  },

  exportJson() {
    // Build array from FeatureRegistry merging in usage data
    // Returns JSON string
  }
};
```

The `_data` shape:
```json
{
  "feature-id": {
    "count": 5,
    "firstUsed": "2026-03-28T12:00:00Z",
    "lastUsed": "2026-03-28T12:05:00Z"
  }
}
```

### Instrumentation strategy

**One-liner pattern**: `if (typeof FeatureTracker !== 'undefined') FeatureTracker.track('feature-id');`
Use a shorter alias after FeatureTracker is defined: the guard is only needed in files that load before feature-tracker.js. Since feature-tracker.js will be loaded early (after constants.js), app.js can call `FeatureTracker.track(id)` directly without a guard.

**Entry points to instrument** (exact locations):

In `app.js`:
- `app.toggleBoard()` → add `FeatureTracker.track('board-view-open')` at top of `showBoard()` (line ~9683)
- `app.toggleActionDashboard()` → add at top of `showActionDashboard()` (line ~9735)
- `app.selectSession()` → add `FeatureTracker.track('session-select')` at top (line ~9193 area)
- `app.openNewPicker()` → add at top (line ~11139)
- `app.openSessionCreator()` → add at top (line ~11181)
- `app.openWorktreeCreator()` → add at top (line ~11147)
- `app.requestCloseSession()` → add at top (line ~9529)
- `app.openSessionOptions()` → add at top (line ~11035)
- `app.startInlineRename()` → add at top (line ~12726)
- `app.openAppSettings()` → add at top (line ~12965)
- `app.switchSettingsTab()` → add `FeatureTracker.track('settings-tab-' + tabName.replace('settings-',''))` (line ~13116)
- `app.switchOptionsTab()` → add `FeatureTracker.track('session-options-tab-' + tabName)`
- `app.showHelp()` → add at top
- `app.openTokenStats()` → add at top
- `app.openRunSummary()` → add at top
- `app.toggleMonitorPanel()` → add at top
- `app.toggleMonitorDetach()` → add at top
- `app.toggleRalphStatePanel()` → add at top
- `app.toggleNotifications()` → add at top
- `app.openLogViewerWindow()` → add at top
- `app.loadFileBrowser()` → add at top (line ~18430)
- `app._resumeWorktree()` → add at top
- `app.goHome()` → add at top
- `setupEventListeners()` keydown handler — add `FeatureTracker.track('keyboard-shortcut-ctrl-*')` at each shortcut branch
- `InputPanel.send()` → add at start of send (line ~20397 area)
- `InputPanel._onFilesFromPaste()` → add at top
- `InputPanel._uploadNonImageFiles()` → add at top
- `InputPanel._handleSlashInput()` → add when slash popup becomes visible
- `InputPanel._openActionSheet()` → add (compose plus / action sheet)
- `CommandPanel.open()` → add at top (line ~2259 area)
- `CommandPanel._send()` → add at top (line ~2362)
- `TerminalSearch.toggle()` → add at top
- `SessionSwitcher.open()` → add at top (line ~2010 area)
- `SessionSwitcher._select()` → add at top
- `OverflowMenu.open()` → add `FeatureTracker.track('header-overflow-menu')`
- `ModelPicker.open()` → add `FeatureTracker.track('header-model-picker')`
- `BoardView._openDetail()` → add `FeatureTracker.track('board-item-detail')`
- `ActionDashboard` open session / unblock handlers → track respectively
- `setupTabDragHandlers` — in the drop handler where reorder is committed → track `'session-drag-reorder'`
- `terminal.onData` callback — track `'terminal-input'` with a 5-second cooldown (separate from DEBOUNCE_MS, use a dedicated timestamp)
- `SessionDrawer.open()` → add `FeatureTracker.track('session-drawer-open')`

In `mobile-handlers.js`:
- `SwipeHandler._commit()` → `FeatureTracker.track('mobile-swipe-session')` (where `app.selectSession` is called on commit)
- `DrawerSwipeHandler._commit()` (or wherever `SessionDrawer.setViewMode()` is called) → `FeatureTracker.track('session-drawer-swipe-tabs')`

In `voice-input.js`:
- `VoiceInput.start()` → `FeatureTracker.track('voice-start')`
- `VoiceInput.stop()` → `FeatureTracker.track('voice-stop')`

In `index.html` onclick attributes:
- `#boardViewBtn` → already routed through `app.toggleBoard()`, no HTML change needed
- `#voiceInputBtn` / `#voiceInputBtnMobile` → tracked in `VoiceInput.start()`; alternatively add FeatureTracker.track in VoiceInput.toggle()

### Settings Modal Tab: "Usage Analytics"

Add a new tab button and content section to the appSettingsModal in `index.html`:

Tab button (after the last `settings-integrations` tab button):
```html
<button class="modal-tab-btn" data-tab="settings-usage">Usage</button>
```

Tab content (after the `settings-integrations` content div):
```html
<div class="modal-tab-content hidden" id="settings-usage">
  <div class="settings-grid">
    <div class="settings-section-header">Feature Usage Analytics</div>
    <div class="settings-item">
      <span class="settings-item-label">Track since</span>
      <span id="featureUsageTrackingSince" class="settings-item-desc">—</span>
    </div>
    <div class="settings-item" style="gap:8px">
      <button class="btn btn-sm btn-secondary" onclick="FeatureTracker._exportAndDownload()">Export JSON</button>
      <button class="btn btn-sm btn-danger" onclick="FeatureTracker._resetWithConfirm()">Reset</button>
    </div>
  </div>
  <div id="featureUsageTable" style="margin-top:12px; overflow-y:auto; max-height:60vh;"></div>
</div>
```

When the `settings-usage` tab is activated (in `switchSettingsTab`), call `FeatureTracker._renderTable()` which:
1. Reads all registry entries from `FeatureRegistry`
2. Merges usage data from `FeatureTracker.getData()`
3. Renders a table: Feature Name | Category | Count | Last Used | First Used
4. Sorted by count ascending (never-used first — highlighted red; ≤3 uses yellow; >3 green)
5. Color applied as a left border or row background class

### Script loading order in index.html

Add before the closing `</body>`:
1. `feature-registry.js` (no dependencies)
2. `feature-tracker.js` (depends on feature-registry.js for the export/table functions)

These go after `constants.js` but before `app.js` to ensure `FeatureTracker` is available when `app.js` executes. Currently the load order comment is in app.js at line ~72: "loadorder 6 of 9". New files are loadorder 1.5 and 1.6.

Actually, since the existing scripts are already loaded via `<script>` tags in index.html, add the two new `<script src="feature-registry.js"></script>` and `<script src="feature-tracker.js"></script>` tags immediately after `constants.js` is loaded and before `mobile-handlers.js`.

### FeatureTracker._renderTable() approach

```js
_renderTable() {
  const container = document.getElementById('featureUsageTable');
  if (!container) return;
  const data = this._load();
  // Build sorted list from FeatureRegistry
  const rows = (window.FeatureRegistry || []).map(f => ({
    ...f,
    ...(data[f.id] || { count: 0, firstUsed: null, lastUsed: null })
  })).sort((a, b) => a.count - b.count);

  // Render HTML table
  // Color: count === 0 → red, 1-3 → yellow, >3 → green
}
```

### Tracking terminal input — special handling

The `terminal.onData` callback fires for every keystroke. Use a dedicated cooldown variable `_terminalInputLastTracked` initialized to 0, and track only when `Date.now() - _terminalInputLastTracked > 5000`. This is separate from and in addition to the standard DEBOUNCE_MS in FeatureTracker (which is just 1s).

### switchSettingsTab instrumentation

In `switchSettingsTab(tabName)`, the current body starts at line ~13116. Add at the top:
```js
FeatureTracker.track('settings-tab-' + tabName);
```
This covers ALL settings tabs with a single line. The feature IDs `settings-tab-settings-display` etc. are in the registry with their full IDs; the `switchSettingsTab` instrumentation can use the raw tabName value (e.g. `'settings-tab-settings-display'`) — registry IDs should match.

Actually, simplify: registry IDs should be `settings-tab-display`, `settings-tab-claude`, etc. (stripping the `settings-` prefix). In the instrumentation:
```js
FeatureTracker.track('settings-tab-' + tabName.replace(/^settings-/, ''));
```

## Decisions & Context

- **DOM methods over innerHTML**: `_renderTable()` builds the table using `createTHead/createTBody/insertRow/insertCell` instead of building an HTML string to avoid the innerHTML security hook and XSS concerns. All data comes from our own registry/localStorage but this is cleaner practice.
- **Guard pattern for external files**: `mobile-handlers.js` and `voice-input.js` load before feature-tracker.js in the defer queue, so they use `if (typeof FeatureTracker !== 'undefined') FeatureTracker.track(...)`. App.js loads after, so it calls `FeatureTracker.track()` directly.
- **Terminal input 5s cooldown**: A dedicated `_terminalInputLastTracked` variable in the onData closure handles the 5-second cooldown, separate from FeatureTracker's own 1s debounce. This prevents flooding from keystrokes.
- **switchSettingsTab tracks raw tabName with prefix stripped**: `settings-tab-` + `tabName.replace(/^settings-/, '')` maps `settings-display` → `settings-tab-display`, matching registry IDs.
- **_renderTable called on tab activation**: In `switchSettingsTab`, when `tabName === 'settings-usage'`, `_renderTable()` is called to refresh the table with current data.

## Fix / Implementation Notes

### Files created:
- `src/web/public/feature-registry.js` — 108 feature entries across 9 categories as `window.FeatureRegistry`
- `src/web/public/feature-tracker.js` — `window.FeatureTracker` singleton with track/export/reset/render

### Files modified:
- `src/web/public/index.html` — added script tags for the two new files (after constants.js); added "Usage" tab button and `settings-usage` content div to appSettingsModal
- `src/web/public/app.js` — ~45 one-line `FeatureTracker.track()` calls added across all major feature entry points including: session lifecycle, board, action dashboard, settings tabs, options tabs, keyboard shortcuts, input panel, command panel, session drawer, overflow menu, model picker, file browser, log viewer, terminal search, drag reorder, terminal input (5s cooldown)
- `src/web/public/mobile-handlers.js` — added tracking in `SwipeHandler._commitSwipe()` and `DrawerSwipeHandler._commitSwipe()`
- `src/web/public/voice-input.js` — added tracking in `VoiceInput.start()` and `VoiceInput.stop()`

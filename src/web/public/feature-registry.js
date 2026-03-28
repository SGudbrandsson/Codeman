/**
 * Feature Registry — static list of all user-facing features in Codeman.
 * Loaded early (before app.js) so FeatureTracker can reference it.
 */
window.FeatureRegistry = [
  // header-nav
  { id: 'header-board-tab',         name: 'Board Tab',              category: 'header-nav',         description: 'Board view (kanban) button in header' },
  { id: 'header-action-tab',        name: 'Action Tab',             category: 'header-nav',         description: 'Action dashboard button in header' },
  { id: 'header-command-tab',       name: 'Command Tab',            category: 'header-nav',         description: 'Command panel button in header' },
  { id: 'header-overflow-menu',     name: 'Overflow Menu',          category: 'header-nav',         description: 'Overflow (⋮) menu button' },
  { id: 'header-settings',          name: 'Settings',               category: 'header-nav',         description: 'Settings button in overflow or mobile' },
  { id: 'header-mcp',               name: 'MCP Servers',            category: 'header-nav',         description: 'MCP Servers from overflow menu' },
  { id: 'header-plugins',           name: 'Plugins',                category: 'header-nav',         description: 'Plugins from overflow menu' },
  { id: 'header-health-analyzer',   name: 'Health Analyzer',        category: 'header-nav',         description: 'Health Analyzer from overflow menu' },
  { id: 'header-notifications',     name: 'Notifications',          category: 'header-nav',         description: 'Notifications from overflow menu' },
  { id: 'header-lifecycle-log',     name: 'Lifecycle Log',          category: 'header-nav',         description: 'Lifecycle Log from overflow menu' },
  { id: 'header-font-increase',     name: 'Font Size +',            category: 'header-nav',         description: 'Increase font size button' },
  { id: 'header-font-decrease',     name: 'Font Size -',            category: 'header-nav',         description: 'Decrease font size button' },
  { id: 'header-model-picker',      name: 'Model Picker',           category: 'header-nav',         description: 'Model chip click — opens model switcher' },
  { id: 'header-context-arc',       name: 'Context Arc',            category: 'header-nav',         description: 'Context arc click' },
  { id: 'header-tunnel-indicator',  name: 'Tunnel Indicator',       category: 'header-nav',         description: 'Tunnel indicator click' },
  { id: 'header-go-home',           name: 'Go Home',                category: 'header-nav',         description: 'Codeman logo click — go home' },

  // session-management
  { id: 'session-select',           name: 'Select Session',         category: 'session-management', description: 'Switch to a different session' },
  { id: 'session-create-picker',    name: 'New Session Picker',     category: 'session-management', description: 'Open new session picker' },
  { id: 'session-create-session',   name: 'Create Session',         category: 'session-management', description: 'Create session flow launched' },
  { id: 'session-create-worktree',  name: 'Create Worktree',        category: 'session-management', description: 'Create worktree flow launched' },
  { id: 'session-close',            name: 'Close Session',          category: 'session-management', description: 'Close session via × button' },
  { id: 'session-options',          name: 'Session Options',        category: 'session-management', description: 'Per-session options gear opened' },
  { id: 'session-rename',           name: 'Rename Session',         category: 'session-management', description: 'Inline rename via right-click' },
  { id: 'session-drag-reorder',     name: 'Drag Reorder Tabs',      category: 'session-management', description: 'Tab drag-and-drop reorder' },
  { id: 'session-search-open',      name: 'Session Switcher Open',  category: 'session-management', description: 'Session switcher modal opened' },
  { id: 'session-search-select',    name: 'Session Switcher Select',category: 'session-management', description: 'Session selected via switcher' },
  { id: 'session-drawer-open',      name: 'Session Drawer',         category: 'session-management', description: 'Session drawer (sidebar) opened' },
  { id: 'session-drawer-swipe-tabs',name: 'Drawer Swipe Tabs',      category: 'session-management', description: 'Drawer Sessions/Agents tab swipe' },
  { id: 'session-drawer-agents-tab',name: 'Drawer Agents Tab',      category: 'session-management', description: 'Drawer Agents tab clicked' },

  // terminal-chat
  { id: 'terminal-input',              name: 'Terminal Input',           category: 'terminal-chat', description: 'User types into terminal (5s cooldown)' },
  { id: 'compose-bar-send',            name: 'Compose Send',             category: 'terminal-chat', description: 'Compose bar Send button' },
  { id: 'compose-bar-voice-mic',       name: 'Compose Voice Mic',        category: 'terminal-chat', description: 'Compose bar microphone button' },
  { id: 'compose-bar-plus',            name: 'Compose Plus',             category: 'terminal-chat', description: 'Compose bar plus button' },
  { id: 'compose-bar-image-paste',     name: 'Image Paste',              category: 'terminal-chat', description: 'Image pasted into compose bar' },
  { id: 'compose-bar-file-attach',     name: 'File Attach',              category: 'terminal-chat', description: 'Non-image file attached' },
  { id: 'compose-bar-slash-command',   name: 'Slash Command Popup',      category: 'terminal-chat', description: 'Slash command popup shown' },
  { id: 'compose-bar-expand',          name: 'Compose Expand',           category: 'terminal-chat', description: 'Compose bar expand/collapse' },
  { id: 'keyboard-shortcut-ctrl-enter',name: 'Shortcut: Ctrl+Enter',     category: 'terminal-chat', description: 'Ctrl+Enter to send in compose bar' },
  { id: 'keyboard-shortcut-ctrl-w',    name: 'Shortcut: Ctrl+W',         category: 'terminal-chat', description: 'Close session keyboard shortcut' },
  { id: 'keyboard-shortcut-ctrl-tab',  name: 'Shortcut: Ctrl+Tab',       category: 'terminal-chat', description: 'Next session keyboard shortcut' },
  { id: 'keyboard-shortcut-ctrl-k',    name: 'Shortcut: Ctrl+K',         category: 'terminal-chat', description: 'Kill all sessions keyboard shortcut' },
  { id: 'keyboard-shortcut-ctrl-l',    name: 'Shortcut: Ctrl+L',         category: 'terminal-chat', description: 'Clear terminal keyboard shortcut' },
  { id: 'keyboard-shortcut-ctrl-f',    name: 'Shortcut: Ctrl+F',         category: 'terminal-chat', description: 'Terminal search keyboard shortcut' },
  { id: 'keyboard-shortcut-ctrl-shift-f', name: 'Shortcut: Ctrl+Shift+F',category: 'terminal-chat', description: 'Session switcher keyboard shortcut' },
  { id: 'keyboard-shortcut-ctrl-shift-b', name: 'Shortcut: Ctrl+Shift+B',category: 'terminal-chat', description: 'Voice input keyboard shortcut' },
  { id: 'keyboard-shortcut-ctrl-shift-k', name: 'Shortcut: Ctrl+Shift+K',category: 'terminal-chat', description: 'Command panel keyboard shortcut' },
  { id: 'keyboard-shortcut-ctrl-shift-v', name: 'Shortcut: Ctrl+Shift+V',category: 'terminal-chat', description: 'Paste from clipboard keyboard shortcut' },
  { id: 'terminal-search-open',        name: 'Terminal Search',          category: 'terminal-chat', description: 'Terminal search opened' },

  // voice-input
  { id: 'voice-desktop-toggle', name: 'Voice Toggle (Desktop)', category: 'voice-input', description: 'Desktop voice button clicked' },
  { id: 'voice-mobile-toggle',  name: 'Voice Toggle (Mobile)',  category: 'voice-input', description: 'Mobile voice button clicked' },
  { id: 'voice-start',          name: 'Voice Start',            category: 'voice-input', description: 'Voice recording actually started' },
  { id: 'voice-stop',           name: 'Voice Stop',             category: 'voice-input', description: 'Voice recording stopped' },

  // file-management
  { id: 'file-browser-open',      name: 'File Browser',       category: 'file-management', description: 'File browser panel opened' },
  { id: 'file-browser-file-click',name: 'File Open',          category: 'file-management', description: 'File opened in preview' },
  { id: 'file-upload',            name: 'File Upload',        category: 'file-management', description: 'File uploaded' },
  { id: 'log-viewer-open',        name: 'Log Viewer',         category: 'file-management', description: 'Log viewer window opened' },

  // board
  { id: 'board-view-open',         name: 'Board View',              category: 'board', description: 'Board (kanban) view shown' },
  { id: 'board-item-detail',       name: 'Board Item Detail',       category: 'board', description: 'Work item detail panel opened' },
  { id: 'board-item-claim',        name: 'Board Item Claim',        category: 'board', description: 'Claim work item button' },
  { id: 'board-item-status-change',name: 'Board Item Status Change',category: 'board', description: 'Work item status changed' },
  { id: 'board-item-open-session', name: 'Board Open Session',      category: 'board', description: 'Open session from work item' },

  // action-dashboard
  { id: 'action-dashboard-open',   name: 'Action Dashboard',        category: 'action-dashboard', description: 'Action dashboard shown' },
  { id: 'action-item-open-session',name: 'Action Open Session',     category: 'action-dashboard', description: 'Open session from action item' },
  { id: 'action-item-unblock',     name: 'Action Unblock',          category: 'action-dashboard', description: 'Unblock button clicked' },

  // command-panel
  { id: 'command-panel-open', name: 'Command Panel Open', category: 'command-panel', description: 'Command panel opened' },
  { id: 'command-panel-send', name: 'Command Panel Send', category: 'command-panel', description: 'Message sent in command panel' },

  // settings
  { id: 'settings-open',                name: 'Settings Open',                category: 'settings', description: 'App Settings modal opened' },
  { id: 'settings-tab-display',         name: 'Settings: Display',            category: 'settings', description: 'Display tab switched' },
  { id: 'settings-tab-claude',          name: 'Settings: Claude CLI',         category: 'settings', description: 'Claude CLI tab switched' },
  { id: 'settings-tab-models',          name: 'Settings: Models',             category: 'settings', description: 'Models tab switched' },
  { id: 'settings-tab-paths',           name: 'Settings: Paths',              category: 'settings', description: 'Paths tab switched' },
  { id: 'settings-tab-notifications',   name: 'Settings: Notifications',      category: 'settings', description: 'Notifications tab switched' },
  { id: 'settings-tab-voice',           name: 'Settings: Voice',              category: 'settings', description: 'Voice tab switched' },
  { id: 'settings-tab-shortcuts',       name: 'Settings: Shortcuts',          category: 'settings', description: 'Shortcuts tab switched' },
  { id: 'settings-tab-updates',         name: 'Settings: Updates',            category: 'settings', description: 'Updates tab switched' },
  { id: 'settings-tab-orchestrator',    name: 'Settings: Orchestrator',       category: 'settings', description: 'Orchestrator tab switched' },
  { id: 'settings-tab-integrations',    name: 'Settings: Integrations',       category: 'settings', description: 'Integrations tab switched' },
  { id: 'settings-tab-usage',           name: 'Settings: Usage Analytics',    category: 'settings', description: 'Feature Usage tab switched' },
  { id: 'session-options-open',         name: 'Session Options Open',         category: 'settings', description: 'Session Options modal opened' },
  { id: 'session-options-tab-respawn',  name: 'Session Options: Respawn',     category: 'settings', description: 'Respawn tab in session options' },
  { id: 'session-options-tab-context',  name: 'Session Options: Context',     category: 'settings', description: 'Context tab in session options' },
  { id: 'session-options-tab-ralph',    name: 'Session Options: Ralph',       category: 'settings', description: 'Ralph tab in session options' },
  { id: 'session-options-tab-summary',  name: 'Session Options: Summary',     category: 'settings', description: 'Summary tab in session options' },
  { id: 'session-options-tab-terminal', name: 'Session Options: Terminal',    category: 'settings', description: 'Terminal tab in session options' },
  { id: 'help-modal-open',              name: 'Help Modal',                   category: 'settings', description: 'Help/keyboard shortcuts modal opened' },

  // panels
  { id: 'monitor-panel-toggle',   name: 'Monitor Panel',         category: 'panels', description: 'Monitor panel toggled' },
  { id: 'monitor-panel-detach',   name: 'Monitor Panel Detach',  category: 'panels', description: 'Monitor panel detached' },
  { id: 'ralph-panel-toggle',     name: 'Ralph Panel',           category: 'panels', description: 'Ralph/Todo panel toggled' },
  { id: 'project-insights-panel', name: 'Project Insights Panel',category: 'panels', description: 'Project insights panel shown' },
  { id: 'subagents-panel-open',   name: 'Subagents Panel',       category: 'panels', description: 'Subagents panel shown' },
  { id: 'context-bar-open',       name: 'Context Bar',           category: 'panels', description: 'Context panel opened' },

  // mobile-specific
  { id: 'mobile-swipe-session',        name: 'Mobile Swipe Session',       category: 'mobile-specific', description: 'Horizontal swipe to switch session' },
  { id: 'mobile-case-picker',          name: 'Mobile Project Picker',      category: 'mobile-specific', description: 'Mobile project picker opened' },
  { id: 'mobile-case-settings',        name: 'Mobile Project Settings',    category: 'mobile-specific', description: 'Mobile project settings toggled' },
  { id: 'keyboard-accessory-bar-action',name: 'Keyboard Accessory Bar',    category: 'mobile-specific', description: 'Keyboard accessory bar button pressed' },

  // other
  { id: 'ralph-wizard-open',  name: 'Ralph Wizard',       category: 'other', description: 'Ralph wizard invoked' },
  { id: 'notification-toggle',name: 'Notification Toggle',category: 'other', description: 'Notifications toggled' },
  { id: 'token-stats-open',   name: 'Token Stats',        category: 'other', description: 'Token statistics opened' },
  { id: 'run-summary-open',   name: 'Run Summary',        category: 'other', description: 'Run Summary modal opened' },
  { id: 'auto-clear-trigger', name: 'Auto-Clear',         category: 'other', description: 'Auto-clear triggered automatically' },
  { id: 'worktree-resume',    name: 'Worktree Resume',    category: 'other', description: 'Resume dormant worktree' },
];

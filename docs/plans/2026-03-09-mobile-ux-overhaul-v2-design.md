# UX Overhaul v2 — Design Document

Date: 2026-03-09
Branch: feat/better-ux
Status: **Approved — ready for implementation**

Mockup: `http://localhost:3002/mockup.html` (run `python3 -m http.server 3002` in repo root)

---

## Overview

Full refactor of the session management UX across mobile and desktop. Core theme: **a worktree is a workspace, not a session** — it can hold multiple sessions (Claude, Shell, OpenCode) running simultaneously. The session drawer becomes the primary navigation surface on both platforms, replacing the fragmented footer toolbar on mobile and supplementing the top tab bar on desktop.

Key changes: rename Cases→Projects, remove legacy mobile footer, always-visible compose bar, grouped session drawer with inline worktree creation, multi-session worktree sub-groups, improved close UX.

---

## Naming

**"Cases" → "Projects"** everywhere in the UI.
Universal developer term. Works naturally: "switch project", "new project", "clone project". Applies to all labels, modal titles, API-facing strings remain as `cases` internally (no backend change needed for this phase).

---

## Core Model Change: Worktree as Workspace

**Before:** A worktree session was displayed as a single session row with a `[merge]` button — one worktree = one session.

**After:** A worktree is a **sub-group** within a project. It has its own `[+]` button to add multiple sessions (Claude for coding, Shell for running servers, OpenCode for review). The `[merge]` button lives on the sub-group header, not on individual sessions.

```
CODEMAN                                   [+]   ← project header
  ⎇ feat/better-ux        [merge]  [+]         ← worktree sub-group
    ● claude · fix mobile UX refactor      [×]  ← session inside worktree
    ○ shell  · terminal                    [×]
  ○ write tests for worktree flow          [×]  ← regular session
```

---

## Session Drawer — Grouped by Project

The session drawer is the unified navigation surface. Works on both mobile (slide-in from right) and desktop (same slide-in, optionally pinnable on wide screens).

### Structure

```
Sessions                                      [×]
──────────────────────────────────────────────────
CODEMAN                      master        [+]
  ⎇ feat/better-ux  [merge]              [+]
    ● fix mobile UX — bottom bar refactor  [×]   claude
    ○ terminal                             [×]   shell
  ○ write tests for worktree flow          [×]   claude

MY-API-SERVICE                             [+]
  ● implement rate limiting middleware     [×]   claude
  ○ update OpenAPI docs for v3             [×]   shell
──────────────────────────────────────────────────
[+ New Project]              [Clone from Git]
```

### Session badges (mode label)

Fixed contrast issue: each badge has a per-mode color and light tinted background.

| Mode | Color | Style |
|------|-------|-------|
| claude | blue `#60a5fa` | `rgba(59,130,246,0.09)` bg + border |
| shell | green `#4ade80` | `rgba(74,222,128,0.07)` bg + border |
| opencode | orange `#fb923c` | `rgba(251,146,60,0.08)` bg + border |

### Project group header

`PROJECTNAME  [branch]  [+]` — branch shows the active worktree branch if one exists, otherwise omitted.

### Worktree sub-group (teal)

- Teal left border (`rgba(6,182,212,0.28)`) + very subtle teal background
- Header: `⎇ branch-name  [merge]  [+]`
- `[merge]` → worktree cleanup sheet (see below)
- `[+]` → mode-only quick-add (Claude / Shell / OpenCode — no nested worktrees)
- Sessions inside use smaller font, `#94a3b8` color (subdued vs project-level sessions)

### Quick-add popover (tap project `[+]`)

```
Start new session in Codeman
[▶ Claude]  [⚡ Shell]  [◈ OpenCode]  [⎇ Worktree]
```

Tapping **⎇ Worktree** replaces the row with an inline form (back button to return):

```
⎇ New worktree in Codeman              [← back]
Branch: [feat/___________]
From:   [master] [develop]
Start with: [▶ Claude] [⚡ Shell] [◈ OpenCode]
[Create & Start]
```

Tapping **[+] on a worktree sub-group** opens a simpler quick-add (mode-only, no ⎇ option):

```
Add session to feat/better-ux
[▶ Claude]  [⚡ Shell]  [◈ OpenCode]
```

---

## Close Session UX

### The `×` button

Every session row — regular and inside worktree sub-groups — has a `×` button at the trailing end of the row.

- `26×26px` touch target, `14px` `×` character
- Default: `color: #1e293b` (low opacity, doesn't clutter)
- Hover/active: red background `rgba(239,68,68,0.12)`, `color: #f87171`
- `e.stopPropagation()` so it doesn't trigger session selection

### Close confirmation

**Mobile:** A compact bottom sheet slides up from within the drawer (no full-screen takeover). The dimmed area behind it can be tapped to cancel.

**Desktop:** The existing `closeConfirmModal` (already implemented). The `×` on drawer items calls `app.requestCloseSession(id)` — same as the tab `×` buttons.

### Close sheet options

```
Close "session name"
──────────────────────────────────────
[×] Kill Session
    Stops Claude & kills tmux — cannot be undone

[○] Remove Tab
    Hides from drawer — tmux keeps running in background

         Cancel
```

- **Kill Session** — red-tinted card. Primary destructive action.
- **Remove Tab** — neutral card. tmux stays alive, session re-attachable.
- **Cancel** — text-only button, low emphasis.

For worktree sessions: same two options. The worktree directory itself is not affected by killing individual sessions inside it — only the worktree `[merge]` → Remove handles the git worktree directory.

---

## Worktree Lifecycle

1. **Create**: `≡ → [+] → ⎇ Worktree → branch name → From chip → mode → Create & Start`
2. **Add sessions**: `≡ → [+] on worktree sub-group → Claude/Shell/OpenCode`
3. **Close a session**: `×` on session row → Kill / Remove Tab
4. **Merge**: `[merge]` on sub-group header → worktree cleanup sheet
5. **After merge**: toast "Merged feat/better-ux → master", sub-group removed, user lands on next session

### Worktree cleanup sheet (redesigned)

Triggered by `[merge]` on worktree group header, or by `openWorktreeCleanupForSession()`.

- SVG git-merge icon (no 🌿 emoji)
- Title: branch name in monospace (`feat/better-ux`)
- Subtitle: "What should happen to this worktree?" (manual open) / "Session ended — what should happen to this worktree?" (auto-trigger)
- `×` close button — was missing, added
- Backdrop click closes
- **Bug fix**: `_onWorktreeSessionEnded` was resetting the description set by `openWorktreeCleanupForSession`. Fix: pass desc as parameter OR set desc after the internal call.

Options:
| Button | Action |
|--------|--------|
| Merge into [project] | Fast-forward branch into master |
| Keep worktree | Saves dormant worktree, branch untouched |
| Remove worktree | Deletes branch and working files |

---

## Workflow Map

| Goal | Steps | Taps |
|------|-------|------|
| Switch to existing session | ≡ → tap session | 2 |
| Close / kill a session | ≡ → × → Kill Session | 3 |
| New session, same project | ≡ → [+] → Claude/Shell | 3 |
| New session, different project | ≡ → [+] on target project → mode | 3 |
| Add session to worktree | ≡ → [+] on worktree → mode | 3 |
| Create worktree | ≡ → [+] → ⎇ Worktree → branch → mode → Create | 6 |
| Merge worktree | ≡ → [merge] → Merge into project | 3 |
| Create new project | ≡ footer → New Project → name + path → Create | 4 |
| Clone repo and start | ≡ footer → Clone → URL + branch → Clone & Open | 5 |
| Switch active project | 📁 pill → pick project | 2 |

**Key insight**: project switching is never required before creating a session or worktree. The grouped drawer lets you act on any project directly from wherever you are.

---

## Project Picker Sheet

Accessed via `📁 Codeman ▾` in the mobile accessory bar, or via footer button on desktop.

Three tabs:

**My Projects** — list of projects with active checkmark. "New Project" and "Clone from Git" action buttons at bottom.

**New** — Project name field + Location field (default `~/sources/`). "Create Project" button.

**Clone from Git** — URL field + Paste button. On URL entry: branch chips auto-fetched, clone-into path field, "Clone & Open" button. Shows spinner during clone, then auto-opens new project.

---

## Mobile-Specific Changes

### Bottom layer architecture

**Before (3 layers):**
```
[keyboard-accessory-bar]  ← tab, ↑↓, commands, copy, pencil, hamburger, % pill
[compose panel]           ← hidden by default, toggled by pencil
[footer .toolbar]         ← voice mic, settings gear, case picker, case settings gear
```

**After (2 layers):**
```
[compose-bar]    ← always visible textarea + attach + send
[accessory-bar]  ← ⚙️ | 64% | ↑ | ↓ | /▲ | ··· | 📁 Project ▾ | ≡
```

Footer (`.toolbar`) hidden on mobile via CSS. Pencil button removed. `InputPanel` always open on init.

### Accessory bar order (left → right)

1. `⚙️` — app settings (moved from footer)
2. `64%` — context pill (moved left of arrows)
3. `↑` `↓` — arrow keys
4. `/▲` — commands drawer
5. `[spacer flex]`
6. `📁 Codeman ▾` — project indicator / picker shortcut
7. `≡` — session drawer

### Compose bar

Always visible. Auto-grows with multiline content (up to ~120px).

```
[📎 attach]  [textarea grows…]  [➤ send]
```

- Attach: image upload via existing action sheet
- Textarea: `scrollHeight` auto-grow on input
- Send: blue, rounded, `box-shadow: 0 2px 8px rgba(59,130,246,0.3)`

---

## Desktop-Specific Changes

### What stays the same

- Top tab bar with session tabs (dots, names, `×` buttons, gear menus)
- Keyboard shortcuts (Ctrl+Tab, Ctrl+W, etc.)
- Session drawer accessible via `≡` button in the new accessory bar

### Bottom bar replacement

The old `.toolbar` footer is **hidden on desktop** (`@media (min-width: 1024px) { .toolbar { display: none } }`). The `desktop-bar` div is removed from HTML. Both are replaced by the same two-bar system used on mobile, with desktop-specific sizing:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ terminal / session content                                               │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤  ← compose bar (48–200px tall)
│              [📎]  [  type a message…                     ⤢ ]  [➤]      │
│              └── max-width: 720px, centered ──────────────────┘          │
├──────────────────────────────────────────────────────────────────────────┤  ← accessory bar (40px)
│  ⚙️  │  64%  │  ↑  ↓  │  /▲  │      [spacer]      │  📁 Codeman ▾  │  ≡ │
└──────────────────────────────────────────────────────────────────────────┘
```

Both bars `position: fixed; bottom: 0; left: 0; right: 0`. Terminal `padding-bottom` is updated whenever the compose textarea resizes to keep content visible.

#### Compose bar (desktop)

- `background: #111`, `border-top: 1px solid rgba(255,255,255,0.08)`
- Textarea `max-width: 720px`, centered (`margin: 0 auto`), auto-grows from 44px to 200px
- **Expand button (⤢)**: inside textarea trailing area; toggles `max-width: 720px` ↔ `calc(100% - 48px)`. State in `localStorage('desktopComposeExpanded')`. Icon flips to ⤡ when expanded.
- Send button: blue rounded, same style as mobile
- Attach button (📎): image upload via existing action sheet
- Enter sends, Shift+Enter inserts newline

#### Accessory bar (desktop)

Same button order and styling as mobile (left → right):

1. `⚙️` — app settings
2. `64%` — context pill (active session)
3. `↑` `↓` — scroll terminal up/down
4. `/▲` — commands drawer (slash command popup)
5. `[spacer]`
6. `📁 Codeman ▾` — project picker
7. `≡` — session drawer

Run/Stop/Shell/count-spinners from the old desktop bar are **removed** — those actions are accessible via slash commands or the session drawer.

### Session drawer improvements (desktop)

The same drawer improvements (grouped by project, worktree sub-groups, `×` close buttons, quick-add popovers) apply to desktop. The drawer width is 300px on both platforms.

**Pinned sidebar (desktop-only, optional):**
On screens ≥1024px, a toggle in the drawer header allows pinning it open as a persistent left/right sidebar. State persisted in `localStorage`. When pinned:
- Drawer stays open, overlay backdrop hidden
- Main content area shrinks by drawer width
- Toggle button changes from `≡` to `⇤` (collapse icon)

### Worktree tab indicator (desktop)

Worktree sessions in the top tab bar get an `⎇` badge alongside the session name, styled in teal — same visual language as the drawer sub-group.

```html
<span class="tab-worktree-badge">⎇ feat/better-ux</span>
```

### Close session on desktop

The existing `requestCloseSession()` → `closeConfirmModal` flow is unchanged. The `×` button added to drawer session rows on desktop calls the same `app.requestCloseSession(id)` function. No new confirmation UI needed for desktop — the existing modal handles it.

### "Cases → Projects" rename on desktop

All visible UI strings updated:
- Footer button: "Cases" → "Projects"
- Modal titles: "Select Case" → "Select Project", "New Case" → "New Project"
- Settings labels: any "case" references → "project"
- API routes remain `/api/cases/…` internally (no backend migration in this phase)

### Project picker on desktop

The same 3-tab bottom sheet design (My Projects / New / Clone from Git) works on desktop. On desktop it renders as a centered modal instead of a bottom sheet — no layout change needed, the existing `.modal` wrapper handles this.

---

## Files to Change

| File | Changes |
|------|---------|
| `src/web/public/mobile.css` | Hide footer on mobile; accessory bar reorder; compose bar always-on; grouped session drawer styles; worktree sub-group styles; session badge contrast; close button styles |
| `src/web/public/keyboard-accessory.js` | Remove pencil button; add settings gear (leftmost); move % pill left of arrows; add project picker button; reorder all buttons |
| `src/web/public/app.js` | `SessionDrawer._render()`: group by project, worktree sub-groups, `×` close buttons, quick-add popovers, worktree inline creation form; `InputPanel`: always open on init; `openWorktreeCleanupForSession`: fix desc-reset bug; worktree creation from drawer; `Cases→Projects` string renames |
| `src/web/public/index.html` | Worktree modal: add `×` close button, fix backdrop onclick, replace 🌿 with SVG; update `?v=` query strings on all changed assets |
| `src/web/public/styles.css` | Session badge contrast styles; worktree tab badge; desktop drawer pin toggle; Cases→Projects label updates; hide `.toolbar` on desktop (≥1024px); desktop compose bar + accessory bar layout |

---

## Open Questions (all resolved)

- ✅ "Cases" → "Projects"
- ✅ Compose bar always visible (pencil removed)
- ✅ Footer removed on mobile
- ✅ Settings gear leftmost in accessory bar
- ✅ Context pill left of arrows
- ✅ Session drawer grouped by project
- ✅ Worktree = workspace, not a session (sub-group with own `[+]`)
- ✅ Mode selector in worktree creation form (Claude / Shell / OpenCode)
- ✅ Multi-session worktrees via sub-group `[+]`
- ✅ `×` close button on every session row
- ✅ Close sheet: Kill Session vs Remove Tab
- ✅ Worktree modal redesigned (SVG icon, close button, bug fix)
- ✅ Session badge contrast fixed (per-mode colors)
- ✅ Clone from Git flow
- ✅ Desktop: drawer improvements carry over
- ✅ Desktop: Cases→Projects rename
- ✅ Desktop: worktree `⎇` badge on tabs
- ✅ Desktop: optional pinned sidebar (localStorage toggle)
- ✅ Desktop: full compose-bar + accessory-bar replaces old toolbar (same two-layer mobile design)
- ✅ Desktop: compose textarea max-width 720px centered, expand button for full-width toggle

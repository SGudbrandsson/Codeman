# Light/Dark Mode Toggle — Design

**Status:** rev4 (Codex APPROVE-WITH-NITS at round 3; nits patched)
**Scope:** add a user-switchable light theme alongside the existing (default) dark theme.
**Non-goals:** per-session themes, color-blind variants, theme editor UI.

## Motivation

Codeman is currently dark-only. Users in bright environments or who prefer light UIs have no option.

## User-facing surface

- Toggle in **App Settings → Display**, in a new `Appearance` section at the top of that tab (above the existing `Input` group).
- Control: segmented radio group — **Dark** (default), **Light**, **System**. `System` follows `prefers-color-scheme`.
- Applied instantly without reload.
- Persisted per-user via existing `/api/settings` (server-side `~/.codeman/settings.json`), mirrored to localStorage for flash-of-wrong-theme prevention.

## Technical approach

### 1. CSS variable strategy

Theme-dependent colors live in CSS custom properties on `:root`. Strategy:

1. **Extend the existing `:root` block.** Today ~40 vars are defined. Several more are referenced with inline fallbacks (`var(--bg-secondary, #1e1e1e)` etc.) — define them explicitly in `:root` using their current fallback values, so both themes share one declaration site.
2. **Light theme via attribute selector:** `html[data-theme="light"] { ... }` overrides only the vars whose values differ. Dark is the ground truth.
3. **Resolved theme on element.** The client resolves `system` → `dark`|`light` and always writes one of those two values to `html[data-theme]`. CSS never sees `system`.

### 2. Light palette (initial)

```
html[data-theme="light"] {
  --bg-dark:        #ffffff;
  --bg-card:        #f5f5f5;
  --bg-input:       #ffffff;
  --bg-hover:       #ececec;
  --bg-secondary:   #f0f0f0;
  --bg-panel:       #fafafa;
  --bg-darker:      #e8e8e8;
  --border:         #d4d4d4;
  --border-light:   #c0c0c0;
  --border-subtle:  #e5e5e5;
  --text:           #1a1a1a;
  --text-dim:       #555;
  --text-muted:     #888;
  --text-primary:   #1a1a1a;
  --text-secondary: #555;
  --text-bright:    #000;
  --accent:         #1d4ed8;
  --accent-hover:   #1e40af;
}
```

Status colors (`--green`, `--yellow`, `--red`) and the session palette stay unchanged — they pass WCAG AA on both backgrounds at used weights.

### 3. mobile.css migration (acceptance criterion)

`mobile.css` is loaded via `<link media="(max-width: 1023px)">` — it cascades normally, so `html[data-theme="light"]` selectors in styles.css **do not reach** its hard-coded colors. Therefore:

**Acceptance criterion:** every literal color value in `mobile.css` — `#hex` (3/4/6/8-digit), `rgb()`/`rgba()`, `hsl()`/`hsla()`, and CSS named colors — is replaced with a `var(--...)` reference when it appears on any of the properties below. **Exception:** the keyword `transparent` is allowed anywhere (it's theme-neutral by definition); do not flag it in review. It appears on these properties:

- `color`
- `background`, `background-color`, `background-image` (gradient color stops)
- `border`, `border-top/right/bottom/left`, `border-color`, `border-*-color`
- `fill`, `stroke`
- `caret-color`, `outline`, `outline-color`, `text-decoration-color`

**Exemption policy:** exemptions are allowed **only for explicitly listed selector+property pairs** in a top-of-file comment block, not ad-hoc "looks fine" calls. `box-shadow` and `text-shadow` values may stay without exemption (they read acceptably on both backgrounds with our current radii). Format for exemptions:

```
/* THEME-EXEMPT
 * .session-indicator .dot { background: #4caf50 } -- status pill, dark green reads on both
 * ...
 */
```

**Verification checklist** (manually walk through in both themes, mobile viewport):
- Sessions list / sidebar
- Top header + tabs
- Active terminal pane
- Compose bar with image attachment
- Settings modal (Display, Claude, Paths, Notifications tabs)
- Toast/notification stack
- Empty-state panels (no sessions, no agents)
- Teammate terminal panes (split view)

### 4. xterm theme

`XTERM_THEME` at `src/web/public/app.js:4801-4809` is hard-coded. Two objects:

```js
const XTERM_THEME_DARK  = { /* current values */ };
const XTERM_THEME_LIGHT = {
  background: '#ffffff', foreground: '#1a1a1a', cursor: '#1a1a1a',
  cursorAccent: '#ffffff', selection: 'rgba(0,0,0,0.2)',
  black: '#1a1a1a', red: '#c92a2a', green: '#2b8a3e', yellow: '#b7791f',
  blue: '#1971c2', magenta: '#862e9c', cyan: '#0c8599', white: '#495057',
  brightBlack: '#868e96', brightRed: '#e03131', brightGreen: '#2f9e44',
  brightYellow: '#f08c00', brightBlue: '#1864ab', brightMagenta: '#9c36b5',
  brightCyan: '#1098ad', brightWhite: '#212529',
};
```

**Hot-swap procedure:** for every live xterm instance (main terminal + any teammate terminals tracked in `app.terminals` / `app.teammateTerminals`):

```js
terminal.options.theme = XTERM_THEME_LIGHT_OR_DARK;
if (terminal.rows > 0) {
  terminal.refresh(0, terminal.rows - 1);  // force re-render of existing cells
}
```

Without the `refresh()`, already-rendered cells keep old colors. This is documented xterm.js behavior. The `rows > 0` guard avoids passing `-1` as the end row on terminals that haven't yet sized (some xterm builds throw on this).

### 5. Inline style colors in app.js

~43 occurrences of inline `style="color:#..."`. Survey during implementation; convert only those that render over theme-dependent backgrounds to CSS vars (e.g. status text on `--bg-card`). The rest (semantic swatches, chart colors on canvas, team color pills) stay — those are content, not chrome.

### 6. Persistence & load order

**Settings schema** (`src/web/schemas.ts:285`): add `themeMode: z.enum(['dark','light','system']).optional()` to `SettingsUpdateSchema`.

**Helper functions** (all in app.js):

```js
function safeGetLocalTheme() {
  try { return localStorage.getItem('codeman-theme'); } catch { return null; }
}
function safeSetLocalTheme(v) {
  try { localStorage.setItem('codeman-theme', v); } catch {}
}
function sanitizeThemeMode(v) {
  return v === 'light' || v === 'system' ? v : 'dark';
}
function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  // mode === 'system'
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
}
function applyTheme(resolved) {
  document.documentElement.dataset.theme = resolved;
  const xtermTheme = resolved === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;
  for (const term of getAllLiveTerminals()) {
    try {
      term.options.theme = xtermTheme;
      if (term.rows > 0) term.refresh(0, term.rows - 1);
    } catch {}
  }
}
```

**Startup precedence (inline head script, before any stylesheet):**

```html
<script>
  (function() {
    var t = 'dark';
    try {
      var s = localStorage.getItem('codeman-theme');
      if (s === 'light' || s === 'dark') t = s;
      else if (s === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) t = 'light';
    } catch {}
    document.documentElement.dataset.theme = t;
  })();
</script>
```

This handles: localStorage disabled (defaults to dark), unknown value (defaults to dark), and resolves System without waiting for CSS.

**Post-boot reconciliation:**

Use a monotonic integer `app._themeActionVersion` (starts at 0). Each user toggle does `app._themeActionVersion++` synchronously before the PUT fires. Deterministic across async boundaries — unlike `performance.now()`, two rapid actions can never share the same value.

1. On app boot, record `launchVersion = app._themeActionVersion` (= 0) and fire `GET /api/settings`.
2. When the GET returns, only apply `serverSettings.themeMode` if `app._themeActionVersion === launchVersion` (no user toggle happened since). "Last user action wins."
3. Sanitize server value via `sanitizeThemeMode`. Unknown / missing values → `dark`.
4. **Install or uninstall the matchMedia listener here too** — the reconciliation path must call `installSystemListener()` if the resolved `app._themeMode === 'system'`, else `uninstallSystemListener()`. Otherwise a user whose persisted `themeMode` is `'system'` won't get live OS-change updates until they interact with the toggle.

**User toggle action:**

1. `app._themeActionVersion++`.
2. `safeSetLocalTheme(newMode)` immediately (so next reload uses it even if PUT fails).
3. Store `newMode` on `app._themeMode` (the *selected* mode — including `'system'`).
4. Call `applyTheme(resolveTheme(newMode))` — writes resolved dark/light to DOM, re-themes live xterms.
5. If `newMode === 'system'`: `installSystemListener()`. Else: `uninstallSystemListener()`.
6. PUT `/api/settings` with `{themeMode: newMode}`.
7. If PUT fails: non-blocking toast ("Couldn't save theme preference — will retry on reload"). Keep the optimistic value. Do not snap back.

**matchMedia listener lifecycle:**

Listener install/uninstall is gated on the **selected mode** (`app._themeMode === 'system'`), not the resolved theme. `resolveTheme()` never returns `'system'` — it collapses `system` to `dark|light` — so gating on resolved would mean the listener never installs.

```js
let systemThemeListener = null;
function installSystemListener() {
  if (systemThemeListener) return;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => {
    if (app._themeMode === 'system') applyTheme(resolveTheme('system'));
  };
  // Safari <14 used the legacy addListener API
  if (mq.addEventListener) mq.addEventListener('change', handler);
  else if (mq.addListener) mq.addListener(handler);
  systemThemeListener = { mq, handler };
}
function uninstallSystemListener() {
  if (!systemThemeListener) return;
  const { mq, handler } = systemThemeListener;
  if (mq.removeEventListener) mq.removeEventListener('change', handler);
  else if (mq.removeListener) mq.removeListener(handler);
  systemThemeListener = null;
}
```

The handler's inner `if (app._themeMode === 'system')` check is a belt-and-braces guard in case a race lands an event after uninstall.

### 7. `<meta name="theme-color">`

Use two static tags with `media` queries — no JS:

```html
<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
```

This is slightly imperfect when user picks a non-System theme (iOS chrome follows OS's `prefers-color-scheme`, not the user's in-app choice). For v1, accept this: document as a known limitation — a user on dark-OS who picks Light in Codeman will still see dark iOS chrome above the page content. Fixable in a future iteration by reintroducing JS-driven meta updates if it becomes a real complaint.

## Files touched

| File | Change |
|---|---|
| `src/web/public/index.html` | inline theme-boot `<script>` in `<head>`; two `<meta name="theme-color">` tags with media queries; "Appearance" radio group in settings-display tab |
| `src/web/public/styles.css` | promote undefined-but-referenced vars into `:root` with current fallback values; add `html[data-theme="light"]` override block |
| `src/web/public/mobile.css` | convert all hex/rgb literals on `color`/`background*`/`border*`/`fill`/`stroke`/`caret-color`/`outline-color` to CSS vars; document exemptions |
| `src/web/public/app.js` | `XTERM_THEME_DARK`/`XTERM_THEME_LIGHT`; helper fns (`safeGetLocalTheme`, `sanitizeThemeMode`, `resolveTheme`, `applyTheme`, listener install/uninstall); wire to settings load + radio group; reconciliation token |
| `src/web/schemas.ts` | add `themeMode` enum to `SettingsUpdateSchema` |

No route changes, no DB schema, no migrations.

## Rollout & verification

1. Implement on a new branch off master (the current `feat/session-inline-rename` branch is an unrelated feature).
2. Build (`npm run build`), sync frontend assets + rebuilt schemas to `~/.codeman/app/` (where the running service serves from), `systemctl --user restart codeman-web`.
3. User walks through the verification checklist in §3 on both themes, plus toggling OS theme while on `System` to confirm live re-render.
4. After user confirms, commit and push.

## Risk & rollback

- **Risk:** light mode reveals low-contrast spots the verification checklist didn't cover. **Mitigation:** cosmetic; fix by CSS var tweak, no structural change.
- **Risk:** xterm `refresh()` after theme swap causes a visible flicker. **Mitigation:** documented API, no known issues; accept minor flicker on a rare action.
- **Risk:** PUT race — user toggles fast, last write lands. Acceptable: last-user-action wins is the intended semantic.
- **Rollback:** single commit, reverted cleanly. Settings file keeps `themeMode` but the code ignores unknown values.

## Explicitly out of scope

- Automatic migration of all 43 inline color strings in app.js (covered case-by-case under §5).
- Custom syntax-highlight themes for file viewers (inherits from vars).
- Visual regression tests.
- Per-theme screenshots.

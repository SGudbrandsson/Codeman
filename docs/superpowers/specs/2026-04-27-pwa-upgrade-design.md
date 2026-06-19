# PWA Upgrade — Design Spec

**Date:** 2026-04-27
**Status:** Draft
**Goal:** Close the gaps between Codeman's minimal PWA and a fully installable, offline-capable progressive web app — without adding a bundler or framework.

## Context

Codeman has a basic PWA: a minimal `manifest.json` (name + colors only) and a `sw.js` that handles Web Push notifications. Compared to a full PWA (benchmarked against PressHERO CRM), it's missing: installability (no icons), iOS support (no meta tags), offline app shell caching, cached session snapshots, and a service worker update prompt.

Codeman is a real-time monitoring dashboard — useless without a WebSocket connection for live data. Full offline support (like PressHERO's CRUD caching) doesn't apply. But caching the app shell + a read-only session list snapshot provides a useful "last known state" experience on flaky networks.

## Decisions

- **Offline strategy:** App shell cache + NetworkFirst session list snapshot (option B from brainstorming)
- **Icons:** Generate PNGs from the existing SVG lightning bolt design using `sharp` (already a dependency)
- **Build tooling:** Hand-written Cache API in `sw.js`, no Workbox/Vite (matches the no-framework philosophy)
- **Update prompt:** Toast notification using the existing toast system (non-intrusive, fits the UI)

## 1. Icons & Manifest

### Icons

Source SVG committed at `src/web/public/icons/icon.svg` — the existing lightning bolt on dark rounded rect.

Generated at build time by `scripts/build.mjs` using `sharp`:

| File | Size | Purpose |
|------|------|---------|
| `icons/icon-192x192.png` | 192×192 | Standard PWA icon |
| `icons/icon-512x512.png` | 512×512 | Standard PWA icon |
| `icons/icon-maskable-192x192.png` | 192×192 | Android adaptive (80% center, bg fill) |
| `icons/icon-maskable-512x512.png` | 512×512 | Android adaptive (80% center, bg fill) |
| `icons/apple-touch-icon-180x180.png` | 180×180 | iOS home screen |

Maskable variants render the SVG at ~80% size centered on `#0a0a0a` background, providing the safe zone padding Android adaptive icons require.

Output goes to `dist/web/public/icons/`. The `src/web/public/icons/` directory contains only the source SVG; PNGs are build artifacts.

### Manifest

Expand `src/web/public/manifest.json`:

```json
{
  "name": "Codeman",
  "short_name": "Codeman",
  "description": "AI coding agent control plane — real-time monitoring dashboard",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#0a0a0a",
  "scope": "/",
  "id": "/",
  "lang": "en",
  "icons": [
    { "src": "/icons/icon-192x192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512x512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/icon-maskable-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

No screenshots — Codeman is a private tool, not an app store listing.

## 2. iOS Meta Tags

Add to `index.html` `<head>` after the existing `<meta name="theme-color">`:

```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180x180.png">
```

Existing tags (`theme-color`, `description`, `viewport`, manifest link) are already correct.

## 3. Service Worker — Offline Caching

Rewrite `sw.js` to add caching while preserving the existing push notification handlers (`push`, `notificationclick`).

### Precache (install event)

Hand-maintained `PRECACHE_URLS` array of app shell assets:

```
/, /styles.css, /mobile.css, /app.js,
/keyboard-accessory.js, /mobile-handlers.js, /constants.js,
/manifest.json, /icons/icon-192x192.png,
/vendor/xterm.min.js, /vendor/xterm.css,
/vendor/xterm-addon-fit.min.js, /vendor/xterm-addon-webgl.min.js,
/vendor/xterm-addon-unicode11.min.js, /vendor/xterm-addon-search.min.js
```

Cache name: `codeman-shell-v1`. Bump the version manually when assets change. Old caches purged in `activate` event.

### Runtime — session list snapshot (fetch event)

NetworkFirst for `/api/sessions` only:
- Try network with 5-second timeout
- Fall back to cached response if network fails
- Add `X-Codeman-Cached: true` header to cached responses so the app can detect stale data
- Cache name: `codeman-api-v1`

### Everything else (fetch event)

- Precached assets → cache-first (fast, served from cache)
- WebSocket upgrades, other API calls, push endpoints → network-only (pass through, never cache)

### Message handler (for SW updates)

Listen for `{ type: 'SKIP_WAITING' }` messages and call `self.skipWaiting()`.

## 4. Offline UI State

### Connection state

No changes needed — existing WebSocket reconnect logic already communicates connection drops.

### Stale data indicator

When `/api/sessions` response has the `X-Codeman-Cached: true` header, display a muted label below the session list: "Last updated: {time}".

The timestamp comes from the `Date` header on the cached response (set by the browser when the response was originally fetched).

No toast, no modal — just a quiet label so you know you're looking at a snapshot.

## 5. SW Update Prompt

### Detection

In `app.js` `registerServiceWorker()`, add an `updatefound` listener on the registration. When the new SW reaches `installed` state and there's an existing controller (meaning it's an update, not first install), show the toast.

### Prompt

Use the existing `showToast()` with its `action` option (already supports `{ label, onClick }` and custom `duration`): "New version available — tap to update". Pass `duration: 86400000` for no practical auto-dismiss. This matches the existing `_onUpdateAvailable()` pattern used for npm package updates.

### Reload flow

1. User taps the toast
2. App posts `{ type: 'SKIP_WAITING' }` to the waiting SW
3. App listens for `controllerchange` on `navigator.serviceWorker`
4. On controller change, `window.location.reload()`

## 6. Build Script Changes

Add one step to `scripts/build.mjs` after "copy web assets":

1. Read `src/web/public/icons/icon.svg`
2. Use `sharp` to render 5 PNGs (192, 512, maskable-192, maskable-512, apple-180)
3. Output to `dist/web/public/icons/`

Maskable variants: render SVG at ~80% size centered on `#0a0a0a` background.

No other build changes. The precache list is hand-maintained in `sw.js` source, content-hash injection handles browser cache busting, and the SW cache is versioned separately via `CACHE_VERSION`.

## 7. Files Modified

| File | Change |
|------|--------|
| `src/web/public/manifest.json` | Expand with icons, description, scope, id, lang |
| `src/web/public/index.html` | Add iOS meta tags + apple-touch-icon link |
| `src/web/public/sw.js` | Add precache, fetch handler, SKIP_WAITING listener |
| `src/web/public/app.js` | Add SW update detection + toast, stale data indicator |
| `src/web/public/icons/icon.svg` | New — source SVG for icon generation |
| `scripts/build.mjs` | Add sharp-based icon generation step |

## 8. Testing

Manual verification (browser/PWA behavior, no automated tests):

1. **Installability** — Chrome DevTools > Application > Manifest shows no errors, install prompt appears
2. **Icons** — All 5 PNGs render correctly, maskable icons pass safe zone check in DevTools
3. **iOS** — Safari "Add to Home Screen" shows Apple touch icon, app launches standalone
4. **Offline shell** — Kill server, reload → app shell loads from cache, shows connecting state
5. **Session snapshot** — With sessions running, go offline → session list shows last-known state with "Last updated" label
6. **SW update** — Change `CACHE_VERSION`, rebuild, reload → toast appears
7. **Push preserved** — Existing push notification flow unaffected

## Non-Goals

- No Workbox or Vite integration
- No offline write/action support (monitoring tool — actions require live connection)
- No app store screenshots
- No background sync
- No IndexedDB storage

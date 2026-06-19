# PWA Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codeman a fully installable PWA with offline app shell caching, a session list snapshot for flaky networks, iOS support, and a service worker update prompt.

**Architecture:** Hand-written Cache API in `sw.js` (no Workbox). Precache the app shell on install, NetworkFirst for `/api/sessions`, cache-first for static assets, network-only for everything else. Icons generated at build time from source SVG using `sharp`.

**Tech Stack:** Vanilla JS, Cache API, sharp (existing dependency), `scripts/build.mjs`

**Spec:** `docs/superpowers/specs/2026-04-27-pwa-upgrade-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/web/public/icons/icon.svg` | Create | Source SVG for icon generation |
| `src/web/public/manifest.json` | Modify | Add icons, description, scope, id, lang |
| `src/web/public/index.html` | Modify | Add iOS meta tags + apple-touch-icon link |
| `src/web/public/sw.js` | Rewrite | Add precache, fetch handler, SKIP_WAITING, keep push handlers |
| `src/web/public/app.js` | Modify | SW update detection + toast, stale data indicator on session fetch |
| `scripts/build.mjs` | Modify | Add sharp-based icon generation step |

---

### Task 1: Source SVG & Icon Build Step

**Files:**
- Create: `src/web/public/icons/icon.svg`
- Modify: `scripts/build.mjs`

- [ ] **Step 1: Create the source SVG**

Create `src/web/public/icons/icon.svg` — the existing lightning bolt design extracted from the inline data URI in `index.html`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#60a5fa"/>
      <stop offset="100%" stop-color="#3b82f6"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="#0a0a0a"/>
  <path d="M288 64L128 288h96l-32 160 160-224h-96z" fill="url(#g)"/>
</svg>
```

This is the same design as the inline favicon but scaled to 512×512 viewBox. The `rx="96"` gives the same proportional rounding as `rx="6"` on the 32×32 original.

- [ ] **Step 2: Add icon generation to build script**

In `scripts/build.mjs`, add this block after the "copy web assets" step (after line 34, before the vendor xterm section):

```js
// 2b. Generate PWA icons from source SVG
{
  const sharp = (await import('sharp')).default;
  const svgPath = join(ROOT, 'src/web/public/icons/icon.svg');
  const outDir = join(ROOT, 'dist/web/public/icons');
  execSync(`mkdir -p "${outDir}"`, { cwd: ROOT, shell: true });

  const svgBuf = readFileSync(svgPath);

  // Standard icons — full bleed
  for (const size of [192, 512]) {
    await sharp(svgBuf).resize(size, size).png().toFile(join(outDir, `icon-${size}x${size}.png`));
  }

  // Maskable icons — 80% center on background
  for (const size of [192, 512]) {
    const inner = Math.round(size * 0.8);
    const pad = Math.round((size - inner) / 2);
    const icon = await sharp(svgBuf).resize(inner, inner).png().toBuffer();
    await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 1 } },
    }).composite([{ input: icon, left: pad, top: pad }]).png().toFile(join(outDir, `icon-maskable-${size}x${size}.png`));
  }

  // Apple touch icon — 180x180, full bleed
  await sharp(svgBuf).resize(180, 180).png().toFile(join(outDir, 'apple-touch-icon-180x180.png'));

  console.log('[build] generate PWA icons — done');
}
```

- [ ] **Step 3: Run the build and verify icons are generated**

Run: `npm run build`

Verify: `ls -la dist/web/public/icons/`

Expected: 5 PNG files:
```
icon-192x192.png
icon-512x512.png
icon-maskable-192x192.png
icon-maskable-512x512.png
apple-touch-icon-180x180.png
```

- [ ] **Step 4: Commit**

```bash
git add src/web/public/icons/icon.svg scripts/build.mjs
git commit -m "feat(pwa): add source SVG and icon generation build step"
```

---

### Task 2: Manifest & iOS Meta Tags

**Files:**
- Modify: `src/web/public/manifest.json`
- Modify: `src/web/public/index.html`

- [ ] **Step 1: Update the manifest**

Replace the contents of `src/web/public/manifest.json` with:

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

- [ ] **Step 2: Add iOS meta tags to index.html**

In `src/web/public/index.html`, after line 8 (`<meta name="google" content="notranslate">`), add:

```html
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon-180x180.png">
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`

Verify in `dist/web/public/index.html` that the iOS meta tags are present and the manifest link still works.

- [ ] **Step 4: Commit**

```bash
git add src/web/public/manifest.json src/web/public/index.html
git commit -m "feat(pwa): expand manifest with icons, add iOS meta tags"
```

---

### Task 3: Service Worker — Precache & Fetch Handler

**Files:**
- Rewrite: `src/web/public/sw.js`

- [ ] **Step 1: Rewrite sw.js with caching + existing push handlers**

Replace the entire contents of `src/web/public/sw.js` with:

```js
/**
 * @fileoverview Codeman service worker — offline caching + Web Push notifications.
 *
 * Caching strategy:
 *   - Install: precache app shell assets (HTML, CSS, JS, vendor libs)
 *   - Fetch: cache-first for precached assets, NetworkFirst for /api/sessions,
 *     network-only for everything else (WebSocket, other APIs, push endpoints)
 *   - Activate: purge old caches
 *
 * Push notifications (unchanged from original):
 *   - Receives push events and displays OS-level notifications
 *   - Handles notification clicks to focus/open Codeman tab
 *
 * Update flow:
 *   - Listens for SKIP_WAITING message from app.js to activate immediately
 */

const CACHE_VERSION = 1;
const SHELL_CACHE = `codeman-shell-v${CACHE_VERSION}`;
const API_CACHE = `codeman-api-v${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/styles.css',
  '/mobile.css',
  '/constants.js',
  '/feature-registry.js',
  '/feature-tracker.js',
  '/mobile-handlers.js',
  '/voice-input.js',
  '/notification-manager.js',
  '/secret-detector.js',
  '/keyboard-accessory.js',
  '/app.js',
  '/ralph-wizard.js',
  '/api-client.js',
  '/subagent-windows.js',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/vendor/xterm.min.js',
  '/vendor/xterm.css',
  '/vendor/xterm-addon-fit.min.js',
  '/vendor/xterm-addon-webgl.min.js',
  '/vendor/xterm-addon-unicode11.min.js',
  '/vendor/xterm-addon-search.min.js',
];

// ═══════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== API_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ═══════════════════════════════════════════════════════════════
// Fetch — caching strategies
// ═══════════════════════════════════════════════════════════════

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept non-GET or cross-origin requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // NetworkFirst for /api/sessions (session list snapshot)
  if (url.pathname === '/api/sessions') {
    event.respondWith(networkFirstSessions(request));
    return;
  }

  // Cache-first for precached app shell assets
  if (isPrecached(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
    return;
  }

  // Everything else: network-only (WebSocket, other APIs, push endpoints)
});

function isPrecached(pathname) {
  return PRECACHE_URLS.includes(pathname);
}

async function networkFirstSessions(request) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timeoutId);
    // Cache successful responses
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    clearTimeout(timeoutId);
    // Network failed — serve from cache with stale marker
    const cached = await caches.match(request);
    if (cached) {
      // Clone response and add X-Codeman-Cached header so the app can detect stale data
      const headers = new Headers(cached.headers);
      headers.set('X-Codeman-Cached', 'true');
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
    }
    // Nothing cached — return network error
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// SW Update — SKIP_WAITING message from app.js
// ═══════════════════════════════════════════════════════════════

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ═══════════════════════════════════════════════════════════════
// Web Push Notifications
// ═══════════════════════════════════════════════════════════════

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  const { title, body, tag, sessionId, urgency, actions } = payload;

  const options = {
    body: body || '',
    tag: tag || 'codeman-default',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    data: { sessionId, url: sessionId ? `/?session=${sessionId}` : '/' },
    renotify: true,
    requireInteraction: urgency === 'critical',
  };

  if (actions && actions.length > 0) {
    options.actions = actions;
  }

  event.waitUntil(
    self.registration.showNotification(title || 'Codeman', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { sessionId, url } = event.notification.data || {};
  const targetUrl = url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({
            type: 'notification-click',
            sessionId,
            action: event.action || null,
          });
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
```

Key changes from the original:
- Added `PRECACHE_URLS`, `SHELL_CACHE`, `API_CACHE` constants
- `install` event now precaches the app shell (instead of just `skipWaiting`)
- `activate` event purges old caches and claims clients
- New `fetch` event handler with cache-first for shell, NetworkFirst for sessions
- New `message` handler for `SKIP_WAITING`
- Push `icon`/`badge` now point to the real PNG instead of `/favicon.ico`
- Note: removed the unconditional `self.skipWaiting()` from install — the new SW waits until the app tells it to activate (via the SKIP_WAITING message), so active sessions aren't disrupted

- [ ] **Step 2: Build and verify the SW is copied to dist**

Run: `npm run build`

Verify: `head -5 dist/web/public/sw.js` shows the new file header.

- [ ] **Step 3: Commit**

```bash
git add src/web/public/sw.js
git commit -m "feat(pwa): rewrite service worker with precache and offline session snapshot"
```

---

### Task 4: SW Update Toast in app.js

**Files:**
- Modify: `src/web/public/app.js`

- [ ] **Step 1: Update registerServiceWorker() with update detection**

In `src/web/public/app.js`, replace the `registerServiceWorker()` method (lines 13277–13301) with:

```js
  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      this._swRegistration = reg;

      // Listen for messages from service worker (notification clicks)
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'notification-click') {
          const { sessionId } = event.data;
          if (sessionId && this.sessions.has(sessionId)) {
            this.selectSession(sessionId);
          }
          window.focus();
        }
      });

      // SW update detection — show toast when new version is waiting
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          // Only show toast for updates (not first install)
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            this._showSwUpdateToast(newWorker);
          }
        });
      });

      // Listen for controller change (after SKIP_WAITING) and reload
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (this._swReloading) return;
        this._swReloading = true;
        window.location.reload();
      });

      // Check if already subscribed
      reg.pushManager.getSubscription().then((sub) => {
        if (sub) {
          this._pushSubscription = sub;
          this._updatePushUI(true);
        }
      });
    }).catch(() => {
      // Service worker registration failed (likely not HTTPS)
    });
  }

  _showSwUpdateToast(waitingWorker) {
    if (this._swUpdateToastShown) return;
    this._swUpdateToastShown = true;
    this.showToast('New version available — tap to update', 'info', {
      duration: 86400000,
      action: {
        label: 'Reload',
        onClick: () => waitingWorker.postMessage({ type: 'SKIP_WAITING' }),
      },
    });
  }
```

This preserves all existing behavior (notification click handling, push subscription check) and adds:
- `updatefound` listener on the registration
- `statechange` listener on the installing worker
- Toast shown only for updates (checks `navigator.serviceWorker.controller` exists)
- `controllerchange` listener for reload after SKIP_WAITING
- Guard `_swReloading` prevents double-reload

- [ ] **Step 2: Build and verify**

Run: `npm run build`

Verify: `grep '_showSwUpdateToast' dist/web/public/app.js` returns a match.

- [ ] **Step 3: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat(pwa): add service worker update detection and toast prompt"
```

---

### Task 5: Stale Session Data Indicator

**Files:**
- Modify: `src/web/public/app.js`

- [ ] **Step 1: Find the session-fetching code paths and add stale detection**

There are two places in `app.js` that need the stale indicator. The main one is the initial session hydration from SSE/WebSocket. However, the session list in Codeman is hydrated via SSE events (`session-list`, `session-add`, etc.), not via a standalone `/api/sessions` fetch in the main app flow. The `/api/sessions` fetch calls at lines 23804 and 24216 are in the board module, not the main session drawer.

The right approach: add a dedicated fetch to `/api/sessions` as a fallback when the SSE connection is down. But the app already handles SSE reconnection. The stale indicator should show when we detect we're offline and the SW served cached data.

Add this method to the `CodemanApp` class, after the `registerServiceWorker()` / `_showSwUpdateToast()` methods:

```js
  /**
   * Check if the last /api/sessions response came from the SW cache.
   * Called after any fetch to /api/sessions to update the stale data indicator.
   */
  _checkStaleSessionData(response) {
    const isCached = response.headers.get('X-Codeman-Cached') === 'true';
    const indicator = document.getElementById('staleDataIndicator');
    if (isCached) {
      const dateHeader = response.headers.get('Date');
      const timeStr = dateHeader ? new Date(dateHeader).toLocaleTimeString() : 'unknown';
      if (indicator) {
        indicator.textContent = `Offline — last updated: ${timeStr}`;
        indicator.style.display = '';
      } else {
        this._createStaleIndicator(`Offline — last updated: ${timeStr}`);
      }
    } else if (indicator) {
      indicator.style.display = 'none';
    }
  }

  _createStaleIndicator(text) {
    const el = document.createElement('div');
    el.id = 'staleDataIndicator';
    el.textContent = text;
    el.style.cssText = 'padding:4px 12px;font-size:11px;color:#666;text-align:center;background:#111;border-bottom:1px solid #1a1a2e';
    // Insert at top of session drawer list
    const drawer = document.querySelector('.session-drawer-list');
    if (drawer) {
      drawer.parentNode.insertBefore(el, drawer);
    }
  }
```

- [ ] **Step 2: Wire up stale detection on the board's session fetch**

In `app.js`, find the board refresh method at line ~24216:

```js
      fetch('/api/sessions').then(r => r.ok ? r.json() : []),
```

Replace the `/api/sessions` fetch in the board refresh with a version that checks for stale data. Find the line:

```js
      fetch('/api/sessions').then(r => r.ok ? r.json() : []),
```

Replace with:

```js
      fetch('/api/sessions').then(r => { if (typeof app !== 'undefined') app._checkStaleSessionData(r); return r.ok ? r.json() : []; }),
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`

Verify: `grep 'staleDataIndicator' dist/web/public/app.js` returns matches.

- [ ] **Step 4: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat(pwa): add offline stale session data indicator"
```

---

### Task 6: Build, Test & Final Commit

**Files:**
- All modified files from Tasks 1–5

- [ ] **Step 1: Full clean build**

```bash
npm run clean && npm run build
```

Expected: Build completes with no errors, including the new "generate PWA icons" step.

- [ ] **Step 2: Verify all artifacts**

```bash
# Icons generated
ls -la dist/web/public/icons/

# Manifest has icons
cat dist/web/public/manifest.json | grep -c icon

# iOS meta tags present
grep 'apple-mobile-web-app-capable' dist/web/public/index.html

# SW has precache
grep 'PRECACHE_URLS' dist/web/public/sw.js

# SW update toast wired
grep '_showSwUpdateToast' dist/web/public/app.js

# Stale indicator wired
grep 'staleDataIndicator' dist/web/public/app.js
```

Expected: All commands produce output (no empty results).

- [ ] **Step 3: Run existing tests**

```bash
npm test
```

Expected: All existing tests pass (this change doesn't touch any tested backend code).

- [ ] **Step 4: Run lint and typecheck**

```bash
npm run typecheck && npm run lint
```

Expected: No new errors (only `scripts/build.mjs` and frontend JS files were changed, neither is type-checked or linted by the current config).

- [ ] **Step 5: Manual PWA verification**

Start a dev instance and verify in Chrome DevTools:

```bash
node dist/index.js web --port 3001
```

Open `http://localhost:3001` in Chrome, then:

1. DevTools → Application → Manifest: should show all icon sizes, no errors
2. DevTools → Application → Service Workers: should show the new SW as active
3. DevTools → Application → Cache Storage: should show `codeman-shell-v1` with all precached assets
4. Network tab → throttle to Offline → reload: app shell loads from cache
5. Check session list shows stale indicator when offline

- [ ] **Step 6: Final commit (if any uncommitted changes from verification)**

```bash
git status
# If clean, skip. If there are fixes from testing:
git add -u
git commit -m "fix(pwa): address issues found during verification"
```

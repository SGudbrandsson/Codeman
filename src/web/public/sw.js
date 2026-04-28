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

// Increment CACHE_VERSION when PRECACHE_URLS changes to trigger cache purge
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
    caches.open(SHELL_CACHE).then((cache) =>
      // Use individual fetch+put instead of addAll — addAll rejects if ANY request
      // fails (e.g., 401 from auth middleware), which would block SW installation entirely.
      Promise.all(
        PRECACHE_URLS.map((url) =>
          fetch(url, { credentials: 'same-origin' })
            .then((res) => {
              if (res.ok) return cache.put(url, res);
              // Skip non-ok responses (auth failures, etc.) — they'll be fetched from network later
            })
            .catch(() => {}) // Network error — skip, don't block install
        )
      )
    )
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
  // ignoreSearch: true — build injects ?v=<hash> query strings for browser cache busting,
  // but the SW cache keys are stored without query strings (from cache.addAll)
  if (isPrecached(url.pathname)) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true }).then((cached) => cached || fetch(request))
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
      await cache.put(request, response.clone());
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

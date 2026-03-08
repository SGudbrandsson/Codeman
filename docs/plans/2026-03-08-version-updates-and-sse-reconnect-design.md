# Version Update Notifications + SSE Reconnect — Design

**Date:** 2026-03-08
**Status:** Approved

## Summary

Two independent features shipping together:

1. **Tab Visibility Reconnect** — bug fix for SSE stream dying when the browser tab is backgrounded
2. **Version Update Notifications + Auto-Update** — badge, changelog panel, and one-click update with rollback safety

---

## Feature 1: Tab Visibility Reconnect

### Problem

When the user switches away from the Codeman tab, the browser may throttle or drop the SSE connection. On return, the terminal appears frozen — no new output, no state refresh.

### Solution

Use the Page Visibility API (`document.visibilitychange` + `document.hidden`) to detect tab focus restoration. On becoming visible:

1. Check `EventSource.readyState` — if `CLOSED` (2), re-create the `EventSource`
2. Call `/api/status` to get current session states and re-render
3. If open but stale (no events for > 60s), send a `GET /api/sessions/:id` ping to force a state refresh

No backend changes required.

---

## Feature 2: Version Update Notifications + Auto-Update

### Architecture

**Backend — new `UpdateChecker` service**
- Polls GitHub Releases API (`https://api.github.com/repos/SGudbrandsson/Codeman/releases/latest`) at most once per 24 hours
- Caches result in `~/.codeman/update-cache.json`
- Returns `{ currentVersion, latestVersion, releaseNotes, updateAvailable, stale }`

**New API endpoints**
- `GET /api/update/check` — returns cached version info; refreshes cache if stale
- `POST /api/update/apply` — triggers update script, streams progress via SSE; locked against double-trigger

**Update script steps (run server-side)**
1. `git fetch` — verify connectivity before anything destructive
2. `cp -r dist dist.backup` — backup current build
3. `git pull` — pull latest changes
4. `npm run build` — build new version
5. `cp -r dist ~/.codeman/app/dist` — deploy to installed location
6. `systemctl --user restart codeman-web` — restart service

**Health check + rollback**
- After restart, server polls `GET /api/status` (up to 15s)
- If health check fails: restore `dist.backup`, restart from old build, emit `update_failed` SSE event
- User sees "Rollback complete — your previous version is still running"

### Frontend UI

**Update badge**
- Small dot on the settings gear icon (header bar, visible on desktop and mobile)
- Shown when `updateAvailable: true`
- Cleared after update completes or user dismisses

**"What's New" panel**
- Slide-up sheet (consistent with existing panels)
- Shows: current version, latest version, GitHub release notes (plain text)
- "Version History" section: last 5 releases with notes
- "Update Now" button at bottom
- "Remind me later" / dismiss option

**Update progress**
- "Update Now" button becomes a live progress log
- SSE events of type `update_progress` streamed into panel
- On success: "Updated to vX.X.X — reloading in 5s" → auto page reload
- On failure: error shown, rollback status confirmed, link to `journalctl --user -u codeman-web`

**Settings integration**
- "Check for updates" option in settings panel
- Bypasses 24h cache, force-fetches from GitHub
- Shows "Up to date ✓" or triggers badge

**Background check**
- On page load: call `/api/update/check`
- `setInterval` every 24h while tab is open
- If GitHub unreachable: use cached data silently, no badge for stale failures

---

## Data Flow

### Version check
```
Browser (page load / 24h interval)
  → GET /api/update/check
  → UpdateChecker: cache fresh? return cache : fetch GitHub → write cache → return
  → { currentVersion, latestVersion, releaseNotes, updateAvailable }
  → Badge shown if updateAvailable
```

### Update apply
```
User taps "Update Now"
  → POST /api/update/apply (locked)
  → Server streams SSE update_progress events
  → git fetch → backup → git pull → build → deploy → restart
  → SSE stream drops (server restarted)
  → Tab visibility reconnect kicks in, re-creates EventSource
  → GET /api/status → version field confirms new version
  → Auto-reload page
```

### Rollback
```
Health check fails within 15s
  → restore dist.backup → restart → emit update_failed
  → Frontend reconnects, sees update_failed event
  → Panel shows error + rollback confirmed
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| GitHub API unreachable | Return cached data with `stale: true`; no badge shown for stale failures |
| Build fails | Restore backup, restart old version, show error in panel |
| Health check fails after restart | Restore backup, restart old version, show error + log instructions |
| Double-click "Update Now" | Second request ignored while lock is held (409 response) |
| Not a git repository | `/api/update/apply` returns 400: "Not a git repository" |
| No internet during update | `git fetch` fails early, no destructive changes made |

---

## Testing

**Unit tests** (`test/update-checker.test.ts`)
- GitHub API response parsing
- Cache freshness logic (fresh → cached, stale → re-fetch, corrupt cache → graceful)
- Version comparison (`latestVersion > currentVersion`)
- Rollback logic (backup restored on health check failure)

**Route tests** (`test/routes/update-routes.test.ts`)
- `GET /api/update/check` — correct shape, cache respected
- `POST /api/update/apply` — rejects non-git-repo (400), rejects double-trigger (409)

**Playwright tests**
- Badge appears when `updateAvailable: true`
- Panel opens with version info and release notes
- Manual "Check for updates" triggers fresh fetch
- Tab-visibility reconnect: navigate away → wait → return → verify SSE reconnects

*No CI test for full update script* — too destructive. Each step unit-tested in isolation.

---

## Files Affected

| File | Change |
|------|--------|
| `src/update-checker.ts` | New — UpdateChecker service |
| `src/web/routes/update-routes.ts` | New — `/api/update/check` and `/api/update/apply` |
| `src/web/routes/index.ts` | Register update routes |
| `src/web/sse-events.ts` | Add `update_progress`, `update_complete`, `update_failed` events |
| `src/web/public/index.html` | Add update panel HTML |
| `src/web/public/app.js` | Visibility reconnect + update panel logic |
| `src/web/public/styles.css` | Update panel base styles |
| `src/web/public/mobile.css` | Update panel mobile styles |
| `constants.js` | Add new SSE event constants |
| `test/update-checker.test.ts` | New unit tests |
| `test/routes/update-routes.test.ts` | New route tests |

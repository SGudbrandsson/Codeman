# Version Updates + SSE Reconnect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tab-visibility SSE reconnect (bug fix) and a version update notification system with changelog panel and one-click update with rollback safety.

**Architecture:** Frontend visibility reconnect hooks into existing `connectSSE()`. Backend adds `UpdateChecker` service (GitHub Releases API, 24h cache) + two new API routes. Frontend adds update badge on settings gear + "Updates" tab in settings modal with changelog and update button. Update script does backup→pull→build→deploy→health-check→rollback-on-failure, broadcasting SSE progress events throughout.

**Tech Stack:** TypeScript (strict), Fastify, `node:child_process` (`execFile` — no shell injection), `node:fs/promises`, GitHub REST API, Vanilla JS, CSS, Vitest.

---

### Task 1: UpdateChecker service (TDD)

**Files:**
- Create: `src/update-checker.ts`
- Create: `test/update-checker.test.ts`

**Step 1: Write failing tests**

Create `test/update-checker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdateChecker } from '../src/update-checker.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm, mkdir, writeFile } from 'node:fs/promises';

const TEST_DIR = join(tmpdir(), `codeman-update-test-${process.pid}`);

describe('UpdateChecker', () => {
  let checker: UpdateChecker;

  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    checker = new UpdateChecker('0.5.0', join(TEST_DIR, 'update-cache.json'));
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('version comparison', () => {
    it('detects newer patch version', () => {
      expect(checker.isNewer('0.5.1', '0.5.0')).toBe(true);
    });
    it('detects newer minor version', () => {
      expect(checker.isNewer('0.6.0', '0.5.9')).toBe(true);
    });
    it('detects newer major version', () => {
      expect(checker.isNewer('1.0.0', '0.9.9')).toBe(true);
    });
    it('returns false for same version', () => {
      expect(checker.isNewer('0.5.0', '0.5.0')).toBe(false);
    });
    it('returns false when latest is older', () => {
      expect(checker.isNewer('0.4.9', '0.5.0')).toBe(false);
    });
    it('strips leading v from tag names', () => {
      expect(checker.isNewer('v0.5.1', '0.5.0')).toBe(true);
    });
  });

  describe('cache logic', () => {
    it('returns cached result when fresh (< 24h)', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: 'v0.5.1', body: 'notes', html_url: 'u', published_at: 'p' }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      await checker.check();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await checker.check();
      expect(fetchSpy).toHaveBeenCalledTimes(1); // still 1 — used cache
    });

    it('re-fetches when force=true', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: 'v0.5.1', body: 'notes', html_url: 'u', published_at: 'p' }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      await checker.check();
      await checker.check(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns stale cache with stale:true when GitHub is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ tag_name: 'v0.5.1', body: 'notes', html_url: 'u', published_at: 'p' }),
        })
        .mockRejectedValueOnce(new Error('network error')));

      await checker.check();
      const result = await checker.check(true);
      expect(result.stale).toBe(true);
      expect(result.latestVersion).toBe('0.5.1');
    });

    it('handles corrupt cache file gracefully', async () => {
      await writeFile(join(TEST_DIR, 'update-cache.json'), 'not json', 'utf-8');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: 'v0.5.1', body: 'notes', html_url: 'u', published_at: 'p' }),
      }));
      const result = await checker.check();
      expect(result.latestVersion).toBe('0.5.1');
    });
  });

  describe('update detection', () => {
    it('sets updateAvailable true when newer version exists', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: 'v0.6.0', body: '', html_url: '', published_at: '' }),
      }));
      const result = await checker.check();
      expect(result.updateAvailable).toBe(true);
      expect(result.latestVersion).toBe('0.6.0');
      expect(result.currentVersion).toBe('0.5.0');
    });

    it('sets updateAvailable false when up to date', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: 'v0.5.0', body: '', html_url: '', published_at: '' }),
      }));
      const result = await checker.check();
      expect(result.updateAvailable).toBe(false);
    });
  });
});
```

**Step 2: Run to confirm they fail**

```bash
npx vitest run test/update-checker.test.ts 2>&1 | head -30
```
Expected: failures mentioning `Cannot find module '../src/update-checker.js'`.

**Step 3: Implement `src/update-checker.ts`**

```typescript
/**
 * @fileoverview UpdateChecker — polls GitHub Releases API for newer versions.
 * Caches result to avoid hitting GitHub more than once per 24 hours.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_CACHE_PATH = join(homedir(), '.codeman', 'update-cache.json');
const GITHUB_REPO = 'SGudbrandsson/Codeman';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string;
  updateAvailable: boolean;
  stale?: boolean;
  checkedAt: number;
}

export class UpdateChecker {
  private currentVersion: string;
  private cachePath: string;
  private _cached: UpdateInfo | null = null;

  constructor(currentVersion: string, cachePath = DEFAULT_CACHE_PATH) {
    this.currentVersion = currentVersion;
    this.cachePath = cachePath;
  }

  /** Exposed for testing */
  isNewer(latest: string, current: string): boolean {
    const clean = (v: string) => v.replace(/^v/, '');
    const parse = (v: string) => clean(v).split('.').map(Number);
    const [lMaj, lMin, lPat] = parse(latest);
    const [cMaj, cMin, cPat] = parse(current);
    if (lMaj !== cMaj) return lMaj > cMaj;
    if (lMin !== cMin) return lMin > cMin;
    return lPat > cPat;
  }

  async check(force = false): Promise<UpdateInfo> {
    if (!force) {
      const cached = await this._loadCache();
      if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
        this._cached = cached;
        return cached;
      }
    }
    try {
      const result = await this._fetchGitHub();
      await this._saveCache(result);
      this._cached = result;
      return result;
    } catch {
      const stale = await this._loadCache();
      if (stale) {
        const result = { ...stale, stale: true as const };
        this._cached = result;
        return result;
      }
      const fallback: UpdateInfo = {
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
        releaseNotes: '',
        releaseUrl: '',
        publishedAt: '',
        updateAvailable: false,
        stale: true,
        checkedAt: Date.now(),
      };
      this._cached = fallback;
      return fallback;
    }
  }

  getCached(): UpdateInfo | null {
    return this._cached;
  }

  private async _fetchGitHub(): Promise<UpdateInfo> {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': `Codeman-UpdateChecker/${this.currentVersion}`,
        'Accept': 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`GitHub API returned ${resp.status}`);
    const data = await resp.json() as {
      tag_name: string;
      body: string;
      html_url: string;
      published_at: string;
    };
    const latestVersion = data.tag_name.replace(/^v/, '');
    return {
      currentVersion: this.currentVersion,
      latestVersion,
      releaseNotes: data.body || '',
      releaseUrl: data.html_url,
      publishedAt: data.published_at,
      updateAvailable: this.isNewer(latestVersion, this.currentVersion),
      checkedAt: Date.now(),
    };
  }

  private async _loadCache(): Promise<UpdateInfo | null> {
    try {
      const raw = await readFile(this.cachePath, 'utf-8');
      return JSON.parse(raw) as UpdateInfo;
    } catch {
      return null;
    }
  }

  private async _saveCache(info: UpdateInfo): Promise<void> {
    const dir = join(this.cachePath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(info, null, 2), 'utf-8');
  }
}
```

**Step 4: Run tests — confirm they pass**

```bash
npx vitest run test/update-checker.test.ts 2>&1 | tail -20
```
Expected: all tests pass.

**Step 5: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

**Step 6: Commit**

```bash
git add src/update-checker.ts test/update-checker.test.ts
git commit -m "feat: add UpdateChecker service with GitHub release polling and 24h cache"
```

---

### Task 2: Add SSE events for update progress

**Files:**
- Modify: `src/web/sse-events.ts`
- Modify: `src/web/public/constants.js`

**Step 1: Add to `src/web/sse-events.ts`**

Find the line `CaseLinked,` (near end of the enum). After it, before `} as const;`, add:

```typescript
  // Update notifications
  UpdateAvailable,
  UpdateProgress,
  UpdateComplete,
  UpdateFailed,
```

**Step 2: Add to `src/web/public/constants.js`**

Find the `SSE_EVENTS` object (starts around line 186). Find the entry for `CaseLinked`. After it, before the closing `};`, add:

```javascript
  // Update notifications
  UPDATE_AVAILABLE: 'UpdateAvailable',
  UPDATE_PROGRESS: 'UpdateProgress',
  UPDATE_COMPLETE: 'UpdateComplete',
  UPDATE_FAILED: 'UpdateFailed',
```

**Step 3: Verify both files have the new events**

```bash
grep -c "Update" src/web/sse-events.ts src/web/public/constants.js
```
Expected: both show 4 matches.

**Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -10
```
Expected: no errors.

**Step 5: Commit**

```bash
git add src/web/sse-events.ts src/web/public/constants.js
git commit -m "feat: add UpdateAvailable/Progress/Complete/Failed SSE events"
```

---

### Task 3: Update API routes (TDD)

**Files:**
- Create: `src/web/routes/update-routes.ts`
- Create: `test/routes/update-routes.test.ts`

**Step 1: Write failing route tests**

Create `test/routes/update-routes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerUpdateRoutes } from '../../src/web/routes/update-routes.js';

describe('update routes', () => {
  describe('GET /api/update/check', () => {
    it('returns update info shape', async () => {
      const mockChecker = {
        check: vi.fn().mockResolvedValue({
          currentVersion: '0.5.0',
          latestVersion: '0.6.0',
          releaseNotes: 'New features',
          releaseUrl: 'https://github.com/SGudbrandsson/Codeman/releases/tag/v0.6.0',
          publishedAt: '2026-03-01T00:00:00Z',
          updateAvailable: true,
          checkedAt: Date.now(),
        }),
      };

      const { app } = await createRouteTestHarness(
        (a, ctx) => registerUpdateRoutes(a, ctx, mockChecker as any),
      );

      const res = await app.inject({ method: 'GET', url: '/api/update/check' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        currentVersion: '0.5.0',
        latestVersion: '0.6.0',
        updateAvailable: true,
      });
    });

    it('passes force=true when ?force=1 query param present', async () => {
      const mockChecker = {
        check: vi.fn().mockResolvedValue({
          currentVersion: '0.5.0', latestVersion: '0.5.0',
          releaseNotes: '', releaseUrl: '', publishedAt: '',
          updateAvailable: false, checkedAt: Date.now(),
        }),
      };

      const { app } = await createRouteTestHarness(
        (a, ctx) => registerUpdateRoutes(a, ctx, mockChecker as any),
      );

      await app.inject({ method: 'GET', url: '/api/update/check?force=1' });
      expect(mockChecker.check).toHaveBeenCalledWith(true);
    });
  });

  describe('POST /api/update/apply', () => {
    it('returns 400 when no updateRepoPath in settings', async () => {
      const mockChecker = { check: vi.fn() };
      const { app, ctx } = await createRouteTestHarness(
        (a, c) => registerUpdateRoutes(a, c, mockChecker as any),
      );
      ctx.store.getSettings.mockReturnValue({});

      const res = await app.inject({ method: 'POST', url: '/api/update/apply' });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/repo path/i);
    });

    it('returns 400 when updateRepoPath is empty string', async () => {
      const mockChecker = { check: vi.fn() };
      const { app, ctx } = await createRouteTestHarness(
        (a, c) => registerUpdateRoutes(a, c, mockChecker as any),
      );
      ctx.store.getSettings.mockReturnValue({ updateRepoPath: '' });

      const res = await app.inject({ method: 'POST', url: '/api/update/apply' });
      expect(res.statusCode).toBe(400);
    });
  });
});
```

**Step 2: Run to confirm they fail**

```bash
npx vitest run test/routes/update-routes.test.ts 2>&1 | head -20
```
Expected: failures about missing module.

**Step 3: Implement `src/web/routes/update-routes.ts`**

```typescript
/**
 * @fileoverview Update check and apply routes.
 *
 * GET  /api/update/check        — Returns cached version info (GitHub Releases)
 * POST /api/update/apply        — Runs update with backup + rollback safety
 */
import { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { cp, rm, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { SseEvent } from '../sse-events.js';
import { UpdateChecker } from '../../update-checker.js';
import type { EventPort, ConfigPort } from '../ports/index.js';

const execFileAsync = promisify(execFile);

// Singleton lock — prevents concurrent updates
let _updateInProgress = false;

const CODEMAN_APP_DIR = join(homedir(), '.codeman', 'app');
const DIST_BACKUP = join(CODEMAN_APP_DIR, 'dist.backup');
const DIST_LIVE = join(CODEMAN_APP_DIR, 'dist');

/** Run a command with execFile (no shell injection risk). Rejects on non-zero exit. */
async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: 5 * 60 * 1000 });
  return stdout;
}

/** Poll localhost health endpoint until 200 or timeout. */
async function healthCheck(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function rollback(repoPath: string, port: number): Promise<void> {
  try {
    await rm(DIST_LIVE, { recursive: true, force: true });
    await cp(DIST_BACKUP, DIST_LIVE, { recursive: true });
    await run('systemctl', ['--user', 'restart', 'codeman-web'], repoPath);
    await healthCheck(port, 10_000);
  } catch { /* best-effort */ }
}

export function registerUpdateRoutes(
  app: FastifyInstance,
  ctx: EventPort & ConfigPort,
  checker: UpdateChecker,
): void {
  // ─── GET /api/update/check ───────────────────────────────────────────────
  app.get('/api/update/check', async (req, reply) => {
    const force = (req.query as Record<string, string>)['force'] === '1';
    const info = await checker.check(force);
    return reply.send(info);
  });

  // ─── POST /api/update/apply ──────────────────────────────────────────────
  app.post('/api/update/apply', async (req, reply) => {
    if (_updateInProgress) {
      return reply.status(409).send({ message: 'Update already in progress' });
    }

    const settings = ctx.store.getSettings() as Record<string, unknown>;
    const repoPath = (settings['updateRepoPath'] as string | undefined) ?? '';

    if (!repoPath) {
      return reply.status(400).send({
        message: 'Update repo path not configured. Set it in Settings > Updates.',
      });
    }

    // Verify path is a git repo
    try {
      await access(join(repoPath, '.git'));
    } catch {
      return reply.status(400).send({
        message: `Not a git repository: ${repoPath}`,
      });
    }

    // Acknowledge immediately — update runs in background
    void reply.status(202).send({ message: 'Update started' });

    const broadcast = (msg: string, step: string) => {
      ctx.broadcast(SseEvent.UpdateProgress, { message: msg, step });
    };

    _updateInProgress = true;
    try {
      broadcast('Fetching latest changes…', 'fetch');
      await run('git', ['fetch'], repoPath);

      broadcast('Backing up current build…', 'backup');
      await rm(DIST_BACKUP, { recursive: true, force: true });
      try {
        await cp(DIST_LIVE, DIST_BACKUP, { recursive: true });
      } catch { /* dist may not exist on fresh installs */ }

      broadcast('Pulling changes…', 'pull');
      await run('git', ['pull'], repoPath);

      broadcast('Building…', 'build');
      await run('npm', ['run', 'build'], repoPath);

      broadcast('Deploying to installed location…', 'deploy');
      await rm(DIST_LIVE, { recursive: true, force: true });
      await cp(join(repoPath, 'dist'), DIST_LIVE, { recursive: true });

      broadcast('Restarting service…', 'restart');
      await run('systemctl', ['--user', 'restart', 'codeman-web'], repoPath);

      const healthy = await healthCheck(ctx.port);
      if (healthy) {
        ctx.broadcast(SseEvent.UpdateComplete, { message: 'Update complete — reloading…' });
      } else {
        broadcast('Health check failed — rolling back…', 'rollback');
        await rollback(repoPath, ctx.port);
        ctx.broadcast(SseEvent.UpdateFailed, {
          message: 'Health check failed. Rolled back to previous version.',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast(`Update failed: ${message}`, 'error');
      await rollback(repoPath, ctx.port).catch(() => {});
      ctx.broadcast(SseEvent.UpdateFailed, {
        message: `Update failed: ${message}. Rolled back to previous version.`,
      });
    } finally {
      _updateInProgress = false;
    }
  });
}
```

**Step 4: Run route tests — confirm they pass**

```bash
npx vitest run test/routes/update-routes.test.ts 2>&1 | tail -20
```
Expected: all tests pass.

**Step 5: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

**Step 6: Commit**

```bash
git add src/web/routes/update-routes.ts test/routes/update-routes.test.ts
git commit -m "feat: add /api/update/check and /api/update/apply routes with backup+rollback"
```

---

### Task 4: Wire UpdateChecker into server and register routes

**Files:**
- Modify: `src/web/server.ts`
- Modify: `src/web/routes/index.ts`

**Step 1: Find the registration pattern in server.ts**

```bash
grep -n "registerSystemRoutes\|registerSessionRoutes\|version\|require.*package" src/web/server.ts | head -20
```

Note the exact import pattern and where routes are registered.

**Step 2: Export from barrel**

In `src/web/routes/index.ts`, add at the end:

```typescript
export { registerUpdateRoutes } from './update-routes.js';
```

**Step 3: Add UpdateChecker to `src/web/server.ts`**

Add import near the top (after existing imports):

```typescript
import { UpdateChecker } from '../update-checker.js';
```

Find where `version` is available (look for `pkg.version` or similar). Then find where routes are registered and add after all other route registrations:

```typescript
const updateChecker = new UpdateChecker(version);
// Background check at startup — non-blocking
updateChecker.check().catch(() => {});
registerUpdateRoutes(app, ctx, updateChecker);
```

**Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors. If `ctx` type doesn't satisfy `EventPort & ConfigPort`, adjust the intersection type as needed.

**Step 5: Smoke test**

Start dev server and verify endpoint:

```bash
npx tsx src/index.ts web --port 3099 &
sleep 3
curl -s http://localhost:3099/api/update/check | python3 -m json.tool
kill %1
```
Expected: JSON with `currentVersion`, `latestVersion`, `updateAvailable` fields.

**Step 6: Commit**

```bash
git add src/web/server.ts src/web/routes/index.ts
git commit -m "feat: wire UpdateChecker into server and register update routes"
```

---

### Task 5: Tab visibility SSE reconnect (frontend bug fix)

**Files:**
- Modify: `src/web/public/app.js`

**Step 1: Add `_lastSseEventTime` to constructor**

Find `this.sseReconnectTimeout = null;` (around line 395). After it, add:

```javascript
    // Tracks last SSE event timestamp — used to detect stale connections on tab-focus
    this._lastSseEventTime = Date.now();
```

**Step 2: Track event time in `connectSSE`**

Find `this.eventSource.onopen = () => {` (around line 1803). Inside the onopen handler, after `this.setConnectionStatus('connected');`, add:

```javascript
      this._lastSseEventTime = Date.now();
```

Find the `addListener` function definition (around line 1788). After the `_sseListenerCleanup` block, add a generic message listener to track heartbeat:

```javascript
    // Track last event time to detect stale connections after tab restore
    this.eventSource.addEventListener('message', () => {
      this._lastSseEventTime = Date.now();
    });
```

**Step 3: Add `_onTabVisible` method**

Find `setupOnlineDetection()` (around line 3075). After its closing `}`, add:

```javascript
  /**
   * Called when the browser tab becomes visible again after being hidden.
   * Reconnects the SSE stream if it dropped while the tab was backgrounded.
   * Fixes the "frozen tab" bug where terminal stops updating after switching away.
   */
  _onTabVisible() {
    if (!this.isOnline) return;
    const es = this.eventSource;
    if (!es || es.readyState === EventSource.CLOSED) {
      // Stream dropped — reconnect (triggers INIT event which re-syncs all state)
      this.reconnectAttempts = 0;
      this.connectSSE();
      return;
    }
    // Stream appears open but may be stale (browser throttled it without error)
    const STALE_THRESHOLD_MS = 5 * 60 * 1000;
    if (Date.now() - this._lastSseEventTime > STALE_THRESHOLD_MS) {
      this.reconnectAttempts = 0;
      this.connectSSE();
    }
  }
```

**Step 4: Register visibility listener in `setupOnlineDetection`**

Inside `setupOnlineDetection()`, after `window.addEventListener('offline', ...)`, add:

```javascript
    // Reconnect SSE when tab becomes visible (fixes frozen-tab bug)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._onTabVisible();
    });
```

**Step 5: Verify with Playwright**

Write and run `/tmp/test-visibility-reconnect.js`:

```javascript
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3001', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  // Simulate tab going hidden, SSE dropping, then tab becoming visible
  await page.evaluate(() => {
    // Force-close the EventSource to simulate browser dropping it
    if (app.eventSource) app.eventSource.close();
    // Simulate visibilitychange (tab becomes visible)
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await new Promise(r => setTimeout(r, 2000));

  const status = await page.evaluate(() => app._connectionStatus);
  console.log('Status after reconnect:', status, status === 'connected' ? 'PASS' : 'FAIL');

  await browser.close();
})();
```

```bash
node /tmp/test-visibility-reconnect.js
```
Expected: `PASS`.

**Step 6: Commit**

```bash
git add src/web/public/app.js
git commit -m "fix: reconnect SSE stream when browser tab becomes visible after being backgrounded"
```

---

### Task 6: Frontend update UI — badge, panel, SSE handlers

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/app.js`

**Step 1: Add update badge spans to settings buttons in `index.html`**

Find the desktop settings button (search for `btn-settings`). It renders as a `<button class="btn-icon-header btn-settings" ...>`. Add a badge span **inside the button, before `</button>`**:

```html
<span class="update-badge" id="updateBadge" style="display:none;" aria-label="Update available"></span>
```

Find the mobile settings button (`btn-settings-mobile`). Add similarly:

```html
<span class="update-badge update-badge-mobile" id="updateBadgeMobile" style="display:none;" aria-label="Update available"></span>
```

**Step 2: Add "Updates" tab button to settings modal**

Find the settings tab buttons (look for `data-tab="settings-shortcuts"`). After that button, add:

```html
<button class="modal-tab-btn" id="settingsUpdatesTabBtn" data-tab="settings-updates">Updates</button>
```

**Step 3: Add Updates tab content panel in `index.html`**

Find the closing of the last `<div class="modal-tab-content" ...>` in the settings modal. After it, add:

```html
          <div class="modal-tab-content" id="settings-updates">
            <div class="settings-grid">
              <div class="settings-section-header">Software Updates</div>
              <div class="update-version-row">
                <span>Installed: <strong id="updateCurrentVersion">—</strong></span>
                <span id="updateLatestRow" style="display:none;">Latest: <strong id="updateLatestVersion">—</strong></span>
              </div>
              <div id="updateStatusMsg" class="update-status-msg"></div>
              <div id="updateReleaseNotes" class="update-release-notes" style="display:none;"></div>
              <div class="update-actions">
                <button class="btn-secondary" onclick="app.checkForUpdates(true)">Check for updates</button>
                <button class="btn-primary" id="updateNowBtn" style="display:none;" onclick="app.applyUpdate()">Update Now</button>
              </div>
              <div class="update-progress-log" id="updateProgressLog" style="display:none;"></div>
              <div class="settings-section-header" style="margin-top:16px;">Configuration</div>
              <label class="settings-label">Git repository path
                <small>Local path to Codeman source repo (e.g. /home/user/sources/Codeman). Required for auto-update.</small>
                <input type="text" id="updateRepoPathInput" class="settings-input"
                  placeholder="/home/user/sources/Codeman"
                  onchange="app.saveUpdateRepoPath(this.value)">
              </label>
            </div>
          </div>
```

**Step 4: Register update SSE event handlers in `EVENT_HANDLERS` map**

Find the `EVENT_HANDLERS` array/map in `app.js` (around line 169). Add three entries:

```javascript
  [SSE_EVENTS.UPDATE_PROGRESS, '_onUpdateProgress'],
  [SSE_EVENTS.UPDATE_COMPLETE, '_onUpdateComplete'],
  [SSE_EVENTS.UPDATE_FAILED, '_onUpdateFailed'],
```

**Step 5: Add update methods to `app.js`**

Find a suitable location (after `sendElicitationResponse`, before the next section). Add:

```javascript
  // ═══════════════════════════════════════════════════════════════
  // Update Checker
  // ═══════════════════════════════════════════════════════════════

  /** Called on page load and every 24h. Silently checks for updates. */
  async _initUpdateChecker() {
    try {
      const data = await fetch('/api/update/check').then(r => r.json());
      this._applyUpdateInfo(data);
    } catch { /* offline — ignore */ }
    setInterval(async () => {
      try {
        const data = await fetch('/api/update/check').then(r => r.json());
        this._applyUpdateInfo(data);
      } catch { /* ignore */ }
    }, 24 * 60 * 60 * 1000);
  }

  /** Apply update info to badge and settings panel. */
  _applyUpdateInfo(data) {
    const badge = document.getElementById('updateBadge');
    const badgeMobile = document.getElementById('updateBadgeMobile');
    const tabBtn = document.getElementById('settingsUpdatesTabBtn');
    const hasUpdate = data.updateAvailable && !data.stale;

    if (badge) badge.style.display = hasUpdate ? '' : 'none';
    if (badgeMobile) badgeMobile.style.display = hasUpdate ? '' : 'none';
    if (tabBtn) tabBtn.classList.toggle('has-update', hasUpdate);

    // Populate settings panel fields
    const cur = document.getElementById('updateCurrentVersion');
    const latestRow = document.getElementById('updateLatestRow');
    const latestEl = document.getElementById('updateLatestVersion');
    const statusMsg = document.getElementById('updateStatusMsg');
    const releaseNotes = document.getElementById('updateReleaseNotes');
    const updateBtn = document.getElementById('updateNowBtn');
    const repoInput = document.getElementById('updateRepoPathInput');

    if (cur) cur.textContent = data.currentVersion || '—';
    if (repoInput && data.repoPath && !repoInput.value) repoInput.value = data.repoPath;

    if (hasUpdate) {
      if (latestRow) latestRow.style.display = '';
      if (latestEl) latestEl.textContent = data.latestVersion;
      if (statusMsg) statusMsg.textContent = `Version ${data.latestVersion} is available.`;
      if (releaseNotes && data.releaseNotes) {
        releaseNotes.style.display = '';
        releaseNotes.textContent = data.releaseNotes.slice(0, 2000);
      }
      if (updateBtn) updateBtn.style.display = '';
    } else {
      if (latestRow) latestRow.style.display = 'none';
      if (updateBtn) updateBtn.style.display = 'none';
      if (releaseNotes) releaseNotes.style.display = 'none';
      if (statusMsg) {
        statusMsg.textContent = data.stale
          ? 'Could not check for updates (GitHub unreachable).'
          : 'You are running the latest version.';
      }
    }
  }

  /** Called by "Check for updates" button. */
  async checkForUpdates(force = false) {
    const statusMsg = document.getElementById('updateStatusMsg');
    if (statusMsg) statusMsg.textContent = 'Checking…';
    try {
      const data = await fetch(`/api/update/check${force ? '?force=1' : ''}`).then(r => r.json());
      this._applyUpdateInfo(data);
    } catch {
      if (statusMsg) statusMsg.textContent = 'Failed to check — check your connection.';
    }
  }

  /** Called by "Update Now" button. */
  async applyUpdate() {
    const updateBtn = document.getElementById('updateNowBtn');
    const log = document.getElementById('updateProgressLog');
    if (updateBtn) updateBtn.disabled = true;
    if (log) { log.style.display = ''; log.textContent = ''; }

    try {
      const res = await fetch('/api/update/apply', { method: 'POST' });
      if (res.status === 400 || res.status === 409) {
        const body = await res.json();
        if (log) log.textContent = body.message || 'Update failed.';
        if (updateBtn) updateBtn.disabled = false;
        return;
      }
      if (log) log.textContent += 'Update started…\n';
    } catch {
      if (log) log.textContent = 'Failed to start update — check your connection.';
      if (updateBtn) updateBtn.disabled = false;
    }
  }

  /** Save repo path to server settings. */
  saveUpdateRepoPath(path) {
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updateRepoPath: path }),
    }).catch(() => {});
  }

  _onUpdateProgress(data) {
    const log = document.getElementById('updateProgressLog');
    if (log) {
      log.style.display = '';
      log.textContent += (data.message || '') + '\n';
      log.scrollTop = log.scrollHeight;
    }
  }

  _onUpdateComplete(data) {
    const log = document.getElementById('updateProgressLog');
    if (log) log.textContent += (data.message || 'Update complete') + '\nReloading in 5 seconds…\n';
    const badge = document.getElementById('updateBadge');
    const badgeMobile = document.getElementById('updateBadgeMobile');
    if (badge) badge.style.display = 'none';
    if (badgeMobile) badgeMobile.style.display = 'none';
    setTimeout(() => window.location.reload(), 5000);
  }

  _onUpdateFailed(data) {
    const log = document.getElementById('updateProgressLog');
    const updateBtn = document.getElementById('updateNowBtn');
    if (log) log.textContent += (data.message || 'Update failed') + '\n';
    if (updateBtn) updateBtn.disabled = false;
  }
```

**Step 6: Call `_initUpdateChecker` during app startup**

Find `this.setupOnlineDetection();` (around line 573). After it, add:

```javascript
    this._initUpdateChecker();
```

**Step 7: Verify IDs are in HTML**

```bash
grep -n "updateBadge\|settingsUpdatesTabBtn\|settings-updates\|updateProgressLog\|updateNowBtn" src/web/public/index.html | head -10
```
Expected: all IDs present.

**Step 8: Commit**

```bash
git add src/web/public/index.html src/web/public/app.js
git commit -m "feat: add update badge, settings Updates tab, progress log, and SSE handlers"
```

---

### Task 7: CSS for update badge and panel

**Files:**
- Modify: `src/web/public/styles.css`
- Modify: `src/web/public/mobile.css`

**Step 1: Add badge and panel styles to `styles.css`**

Find `.btn-icon-header` rules. After that block, add:

```css
/* Update available badge — red dot on settings gear */
.btn-settings,
.btn-settings-mobile {
  position: relative;
}

.update-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 8px;
  height: 8px;
  background: #ef4444;
  border-radius: 50%;
  border: 1.5px solid var(--bg-primary, #111);
  pointer-events: none;
}

/* Red dot on "Updates" tab in settings modal */
.modal-tab-btn.has-update::after {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  background: #ef4444;
  border-radius: 50%;
  margin-left: 5px;
  vertical-align: middle;
}

/* Update settings panel */
.update-version-row {
  display: flex;
  gap: 16px;
  font-size: 13px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.update-status-msg {
  font-size: 13px;
  color: rgba(255,255,255,0.65);
  margin-bottom: 8px;
  min-height: 18px;
}

.update-release-notes {
  background: #1a1a1a;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
  color: rgba(255,255,255,0.75);
  white-space: pre-wrap;
  max-height: 180px;
  overflow-y: auto;
  margin-bottom: 12px;
  font-family: inherit;
}

.update-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.update-progress-log {
  background: #0a0a0a;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
  font-family: monospace;
  color: rgba(255,255,255,0.8);
  white-space: pre-wrap;
  max-height: 180px;
  overflow-y: auto;
  margin-bottom: 12px;
}
```

**Step 2: Add mobile overrides to `mobile.css`**

Inside the `@media (max-width: 768px)` block, add:

```css
  .update-badge-mobile {
    top: 0;
    right: 0;
    width: 10px;
    height: 10px;
  }

  .update-actions {
    flex-direction: column;
  }
```

**Step 3: Verify**

```bash
grep -c "update-badge\|update-progress-log\|update-actions" src/web/public/styles.css
```
Expected: 5 or more.

**Step 4: Commit**

```bash
git add src/web/public/styles.css src/web/public/mobile.css
git commit -m "feat: add CSS for update badge, release notes panel, and progress log"
```

---

### Task 8: Bump versions, deploy, and verify

**Files:**
- Modify: `src/web/public/index.html`

**Step 1: Check current version strings**

```bash
grep -n "styles.css\|mobile.css\|app.js\|constants.js" src/web/public/index.html | grep "v="
```

Note current version numbers for each file.

**Step 2: Increment each version string by 1**

- `styles.css?v=X.YYYY` → increment YYYY by 1
- `mobile.css?v=X.YYYY` → increment YYYY by 1
- `constants.js?v=X.Y.Z` → increment Z by 1
- `app.js?v=X.Y.Z` → increment Z by 1

**Step 3: Build and deploy**

```bash
npm run build
cp -r dist /home/siggi/.codeman/app/
cp package.json /home/siggi/.codeman/app/package.json
systemctl --user restart codeman-web
```

**Step 4: Verify service**

```bash
systemctl --user status codeman-web --no-pager | head -5
```
Expected: `Active: active (running)`.

**Step 5: Verify update endpoint**

```bash
curl -s http://localhost:3001/api/update/check | python3 -m json.tool
```
Expected: JSON with `currentVersion`, `latestVersion`, `updateAvailable`.

**Step 6: Playwright visual verification**

Write `/tmp/test-update-ui.js`:

```javascript
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://localhost:3001', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 3000));

  // Simulate update available
  await page.evaluate(() => app._applyUpdateInfo({
    currentVersion: '0.5.4',
    latestVersion: '0.9.0',
    releaseNotes: 'Big new features!',
    updateAvailable: true,
    stale: false,
    checkedAt: Date.now(),
  }));
  await new Promise(r => setTimeout(r, 300));

  const badgeVisible = await page.locator('#updateBadge').isVisible();
  console.log('Badge visible:', badgeVisible ? 'PASS' : 'FAIL');

  await page.click('.btn-settings');
  await new Promise(r => setTimeout(r, 400));

  const updatesTab = page.locator('[data-tab="settings-updates"]');
  const tabVisible = await updatesTab.isVisible();
  console.log('Updates tab visible:', tabVisible ? 'PASS' : 'FAIL');

  if (tabVisible) {
    await updatesTab.click();
    await new Promise(r => setTimeout(r, 200));
    const updateBtnVisible = await page.locator('#updateNowBtn').isVisible();
    console.log('Update Now button visible:', updateBtnVisible ? 'PASS' : 'FAIL');
    const notesVisible = await page.locator('.update-release-notes').isVisible();
    console.log('Release notes visible:', notesVisible ? 'PASS' : 'FAIL');
  }

  await page.screenshot({ path: '/tmp/update-ui-test.png' });
  console.log('Screenshot: /tmp/update-ui-test.png');
  await browser.close();
})();
```

```bash
node /tmp/test-update-ui.js
```
Expected: all checks PASS.

**Step 7: Final commit**

```bash
git add src/web/public/index.html
git commit -m "chore: bump asset version strings for update feature"
```

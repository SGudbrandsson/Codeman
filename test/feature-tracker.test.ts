/**
 * FeatureTracker tests
 *
 * Tests the window.FeatureTracker singleton loaded from
 * src/web/public/feature-tracker.js via a real browser (Playwright).
 *
 * Covers the six gaps identified in the Test Gap Analysis:
 * 1. track() — debounce logic, first-use record creation, count increment, lastUsed update, _save() side-effect
 * 2. _load() — lazy caching, corrupted JSON fallback
 * 3. _save() — writes to localStorage, silent failure when unavailable
 * 4. getData() — returns shallow copy, not live reference
 * 5. reset() — clears _data, _lastTrack, removes localStorage key
 * 6. exportJson() — merges FeatureRegistry with usage data, zero-usage features, valid JSON
 *
 * Port: 3248
 *
 * Run: npx vitest run test/feature-tracker.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3248;
const BASE_URL = `http://localhost:${PORT}`;
const STORAGE_KEY = 'codeman-feature-usage';

let server: WebServer;
let browser: Browser;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  return { context, page };
}

async function navigateTo(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 10000 });
  // Ensure FeatureTracker is available
  await page.waitForFunction(() => typeof (window as any).FeatureTracker !== 'undefined', { timeout: 5000 });
}

/** Reset tracker state and localStorage between tests */
async function resetTracker(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const ft = (window as any).FeatureTracker;
    ft._data = null;
    ft._lastTrack = {};
    localStorage.removeItem(key);
  }, STORAGE_KEY);
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Gap 1: track() ─────────────────────────────────────────────────────────

describe('Gap 1 — track(): first-use record creation', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    await resetTracker(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('creates a new record with count=1 and identical firstUsed/lastUsed on first track', async () => {
    const record = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft.track('test-feature-create');
      const data = JSON.parse(localStorage.getItem(key) || '{}');
      return data['test-feature-create'];
    }, STORAGE_KEY);

    expect(record).toBeDefined();
    expect(record.count).toBe(1);
    expect(record.firstUsed).toBeTruthy();
    expect(record.lastUsed).toBeTruthy();
    expect(record.firstUsed).toBe(record.lastUsed);
  });

  it('increments count and preserves firstUsed on subsequent track (after debounce)', async () => {
    const result = await page.evaluate(async (key) => {
      const ft = (window as any).FeatureTracker;
      // Reset to a clean state for this sub-test
      ft._data = null;
      ft._lastTrack = {};
      localStorage.removeItem(key);

      // First track — sets firstUsed
      ft.track('test-feature-incr');
      const firstUsed = ft._data['test-feature-incr'].firstUsed;

      // Advance past the 1000ms debounce by backdating _lastTrack
      ft._lastTrack['test-feature-incr'] -= 1001;

      // Second track
      ft.track('test-feature-incr');
      return { firstUsed, record: ft._data['test-feature-incr'] };
    }, STORAGE_KEY);

    expect(result.record.count).toBe(2);
    // firstUsed must be preserved across updates
    expect(result.record.firstUsed).toBe(result.firstUsed);
  });

  it('_save() is called after track — data is persisted to localStorage', async () => {
    await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      ft._lastTrack = {};
      localStorage.removeItem(key);
      ft.track('test-feature-save');
    }, STORAGE_KEY);

    const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed['test-feature-save']).toBeDefined();
    expect(parsed['test-feature-save'].count).toBe(1);
  });
});

describe('Gap 1 — track(): debounce suppression', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    await resetTracker(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('second track() within DEBOUNCE_MS is suppressed — count stays at 1', async () => {
    const count = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      ft._lastTrack = {};
      localStorage.removeItem(key);

      ft.track('debounce-test');
      ft.track('debounce-test'); // immediate second call — should be suppressed
      ft.track('debounce-test'); // third call — also suppressed

      return ft._data['debounce-test'].count;
    }, STORAGE_KEY);

    expect(count).toBe(1);
  });

  it('second track() after DEBOUNCE_MS is NOT suppressed — count becomes 2', async () => {
    const count = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      ft._lastTrack = {};
      localStorage.removeItem(key);

      ft.track('debounce-pass');
      // Simulate time passing by backdating the _lastTrack entry
      ft._lastTrack['debounce-pass'] -= 1001;
      ft.track('debounce-pass');

      return ft._data['debounce-pass'].count;
    }, STORAGE_KEY);

    expect(count).toBe(2);
  });

  it('debounce is per-feature — different feature IDs do not interfere', async () => {
    const counts = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      ft._lastTrack = {};
      localStorage.removeItem(key);

      ft.track('feature-alpha');
      ft.track('feature-beta'); // different ID — not debounced
      ft.track('feature-alpha'); // same ID, immediate — debounced
      ft.track('feature-beta'); // same ID, immediate — debounced

      return {
        alpha: ft._data['feature-alpha']?.count,
        beta: ft._data['feature-beta']?.count,
      };
    }, STORAGE_KEY);

    expect(counts.alpha).toBe(1);
    expect(counts.beta).toBe(1);
  });
});

// ─── Gap 2: _load() ─────────────────────────────────────────────────────────

describe('Gap 2 — _load(): lazy caching and corrupted JSON fallback', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    await resetTracker(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('_load() returns {} when localStorage has no entry', async () => {
    const result = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      localStorage.removeItem(key);
      return ft._load();
    }, STORAGE_KEY);

    expect(result).toEqual({});
  });

  it('_load() returns cached _data object on second call without re-reading localStorage', async () => {
    const result = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      localStorage.removeItem(key);

      const first = ft._load();
      first['marker'] = 42; // mutate the returned object

      // Write something different to localStorage
      localStorage.setItem(key, JSON.stringify({ marker: 99 }));

      const second = ft._load();
      return second['marker']; // should still be 42 (cached), not 99 from storage
    }, STORAGE_KEY);

    expect(result).toBe(42);
  });

  it('_load() returns {} and does not throw on corrupted JSON', async () => {
    const result = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      localStorage.setItem(key, 'not valid json {{{{');
      try {
        return { data: ft._load(), threw: false };
      } catch (e) {
        return { data: null, threw: true };
      }
    }, STORAGE_KEY);

    expect(result.threw).toBe(false);
    expect(result.data).toEqual({});
  });

  it('_load() reads existing valid data from localStorage', async () => {
    const result = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      const existing = {
        'some-feature': { count: 7, firstUsed: '2026-01-01T00:00:00.000Z', lastUsed: '2026-03-01T00:00:00.000Z' },
      };
      localStorage.setItem(key, JSON.stringify(existing));
      return ft._load();
    }, STORAGE_KEY);

    expect(result['some-feature']).toBeDefined();
    expect(result['some-feature'].count).toBe(7);
  });
});

// ─── Gap 3: _save() ─────────────────────────────────────────────────────────

describe('Gap 3 — _save(): writes to localStorage, silent failure', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    await resetTracker(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('_save() writes _data to localStorage under STORAGE_KEY', async () => {
    const stored = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = {
        'my-feature': { count: 3, firstUsed: '2026-01-01T00:00:00.000Z', lastUsed: '2026-03-01T00:00:00.000Z' },
      };
      ft._save();
      return localStorage.getItem(key);
    }, STORAGE_KEY);

    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed['my-feature'].count).toBe(3);
  });

  it('_save() does not throw when localStorage.setItem throws', async () => {
    const threw = await page.evaluate(() => {
      const ft = (window as any).FeatureTracker;
      ft._data = { test: { count: 1, firstUsed: '2026-01-01T00:00:00.000Z', lastUsed: '2026-01-01T00:00:00.000Z' } };

      // Override setItem to throw (simulate storage full / unavailable)
      const original = localStorage.setItem.bind(localStorage);
      localStorage.setItem = () => {
        throw new DOMException('QuotaExceededError');
      };
      try {
        ft._save();
        return false;
      } catch (e) {
        return true;
      } finally {
        localStorage.setItem = original;
      }
    });

    expect(threw).toBe(false);
  });
});

// ─── Gap 4: getData() ───────────────────────────────────────────────────────

describe('Gap 4 — getData(): returns shallow copy, not live reference', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    await resetTracker(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('getData() returns an object with the current data', async () => {
    const data = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      localStorage.removeItem(key);
      ft.track('data-test');
      return ft.getData();
    }, STORAGE_KEY);

    expect(data['data-test']).toBeDefined();
    expect(data['data-test'].count).toBe(1);
  });

  it('getData() returns a shallow copy — mutating it does not affect internal _data', async () => {
    const result = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      localStorage.removeItem(key);
      ft.track('copy-test');

      const copy = ft.getData();
      copy['injected'] = { count: 999, firstUsed: null, lastUsed: null };

      // Internal _data should not have the injected key
      return {
        copyHasInjected: 'injected' in copy,
        internalHasInjected: 'injected' in ft._data,
      };
    }, STORAGE_KEY);

    expect(result.copyHasInjected).toBe(true);
    expect(result.internalHasInjected).toBe(false);
  });

  it('getData() is not the same reference as _data', async () => {
    const isSameRef = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      localStorage.removeItem(key);
      ft.track('ref-test');
      return ft.getData() === ft._data;
    }, STORAGE_KEY);

    expect(isSameRef).toBe(false);
  });
});

// ─── Gap 5: reset() ─────────────────────────────────────────────────────────

describe('Gap 5 — reset(): clears _data, _lastTrack, removes localStorage key', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    await resetTracker(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('reset() sets _data to empty object', async () => {
    const data = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      localStorage.removeItem(key);
      ft.track('pre-reset');
      ft.reset();
      return ft._data;
    }, STORAGE_KEY);

    expect(data).toEqual({});
  });

  it('reset() clears _lastTrack', async () => {
    const lastTrack = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      localStorage.removeItem(key);
      ft.track('pre-reset-lt');
      ft.reset();
      return ft._lastTrack;
    }, STORAGE_KEY);

    expect(lastTrack).toEqual({});
  });

  it('reset() removes the localStorage key', async () => {
    const stored = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      localStorage.removeItem(key);
      ft.track('pre-reset-ls');
      ft.reset();
      return localStorage.getItem(key);
    }, STORAGE_KEY);

    expect(stored).toBeNull();
  });

  it('after reset(), track() creates a fresh record — count is 1', async () => {
    const count = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      localStorage.removeItem(key);
      ft.track('post-reset-feature');
      ft.reset();
      ft.track('post-reset-feature');
      return ft._data['post-reset-feature']?.count;
    }, STORAGE_KEY);

    expect(count).toBe(1);
  });
});

// ─── Gap 6: exportJson() ────────────────────────────────────────────────────

describe('Gap 6 — exportJson(): merges FeatureRegistry with usage data', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage());
    await navigateTo(page);
    await resetTracker(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('exportJson() returns valid JSON', async () => {
    const json = await page.evaluate(() => {
      return (window as any).FeatureTracker.exportJson();
    });

    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('exportJson() includes all FeatureRegistry entries', async () => {
    const result = await page.evaluate(() => {
      const ft = (window as any).FeatureTracker;
      const registry = (window as any).FeatureRegistry || [];
      const rows = JSON.parse(ft.exportJson());
      return { registryLen: registry.length, rowsLen: rows.length };
    });

    expect(result.rowsLen).toBe(result.registryLen);
    expect(result.registryLen).toBeGreaterThan(0);
  });

  it('exportJson() features with no usage have count=0 and null dates', async () => {
    const result = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      ft._data = null;
      ft._lastTrack = {};
      localStorage.removeItem(key);
      // Do not track anything — all features should show zero usage
      const rows = JSON.parse(ft.exportJson());
      return rows.filter((r: any) => r.count !== 0 || r.firstUsed !== null || r.lastUsed !== null);
    }, STORAGE_KEY);

    expect(result).toHaveLength(0);
  });

  it('exportJson() merges usage data for a tracked feature', async () => {
    const row = await page.evaluate((key) => {
      const ft = (window as any).FeatureTracker;
      const registry = (window as any).FeatureRegistry || [];
      ft._data = null;
      ft._lastTrack = {};
      localStorage.removeItem(key);

      // Use first registry entry as the test target
      const firstId = registry[0]?.id;
      if (!firstId) return null;

      ft.track(firstId);
      // Bypass debounce and track again
      ft._lastTrack[firstId] -= 1001;
      ft.track(firstId);

      const rows = JSON.parse(ft.exportJson());
      return rows.find((r: any) => r.id === firstId);
    }, STORAGE_KEY);

    expect(row).not.toBeNull();
    expect(row.count).toBe(2);
    expect(row.firstUsed).not.toBeNull();
    expect(row.lastUsed).not.toBeNull();
  });

  it('exportJson() includes id, name, category, description fields from registry', async () => {
    const firstRow = await page.evaluate(() => {
      const ft = (window as any).FeatureTracker;
      const rows = JSON.parse(ft.exportJson());
      return rows[0];
    });

    expect(firstRow).toHaveProperty('id');
    expect(firstRow).toHaveProperty('name');
    expect(firstRow).toHaveProperty('category');
    expect(firstRow).toHaveProperty('description');
    expect(firstRow).toHaveProperty('count');
    expect(firstRow).toHaveProperty('firstUsed');
    expect(firstRow).toHaveProperty('lastUsed');
  });

  it('exportJson() works with empty FeatureRegistry — returns valid empty array JSON', async () => {
    const result = await page.evaluate(() => {
      const ft = (window as any).FeatureTracker;
      const savedRegistry = (window as any).FeatureRegistry;
      (window as any).FeatureRegistry = [];
      const json = ft.exportJson();
      (window as any).FeatureRegistry = savedRegistry;
      return json;
    });

    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });

  it('exportJson() works when FeatureRegistry is undefined — returns valid empty array JSON', async () => {
    const result = await page.evaluate(() => {
      const ft = (window as any).FeatureTracker;
      const savedRegistry = (window as any).FeatureRegistry;
      (window as any).FeatureRegistry = undefined;
      const json = ft.exportJson();
      (window as any).FeatureRegistry = savedRegistry;
      return json;
    });

    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });
});

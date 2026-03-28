/**
 * FeatureTracker tests — server-side storage
 *
 * Tests the window.FeatureTracker singleton which now stores data
 * on the server via /api/feature-usage routes.
 *
 * Covers:
 * 1. track() — debounce logic, fire-and-forget POST to server
 * 2. getData() — async fetch from server
 * 3. reset() — POST to server, clears _lastTrack
 * 4. exportJson() — merges server data with FeatureRegistry
 * 5. Server API routes — GET, POST track, POST reset
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
  await page.waitForFunction(() => typeof (window as any).FeatureTracker !== 'undefined', { timeout: 5000 });
}

/** Reset server-side usage data and client-side debounce state */
async function resetTracker(page: Page): Promise<void> {
  // Reset server data via API
  await fetch(`${BASE_URL}/api/feature-usage/reset`, { method: 'POST' });
  // Reset client-side debounce
  await page.evaluate(() => {
    (window as any).FeatureTracker._lastTrack = {};
  });
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  // Clean up server data
  try {
    await fetch(`${BASE_URL}/api/feature-usage/reset`, { method: 'POST' });
  } catch {
    /* ignore */
  }
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── Server API routes ─────────────────────────────────────────────────────

describe('Server API — /api/feature-usage routes', () => {
  beforeEach(async () => {
    await fetch(`${BASE_URL}/api/feature-usage/reset`, { method: 'POST' });
  });

  it('GET /api/feature-usage returns empty data initially', async () => {
    const res = await fetch(`${BASE_URL}/api/feature-usage`);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({});
  });

  it('POST /api/feature-usage/track creates a new entry', async () => {
    const res = await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: 'test-api-track' }),
    });
    const json = await res.json();
    expect(json.success).toBe(true);

    const getRes = await fetch(`${BASE_URL}/api/feature-usage`);
    const getData = await getRes.json();
    expect(getData.data['test-api-track']).toBeDefined();
    expect(getData.data['test-api-track'].count).toBe(1);
  });

  it('POST /api/feature-usage/track increments count on repeat', async () => {
    await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: 'test-incr' }),
    });
    await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: 'test-incr' }),
    });

    const res = await fetch(`${BASE_URL}/api/feature-usage`);
    const json = await res.json();
    expect(json.data['test-incr'].count).toBe(2);
  });

  it('POST /api/feature-usage/track preserves firstUsed on update', async () => {
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-03-01T00:00:00.000Z';
    await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: 'test-dates', timestamp: ts1 }),
    });
    await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: 'test-dates', timestamp: ts2 }),
    });

    const res = await fetch(`${BASE_URL}/api/feature-usage`);
    const json = await res.json();
    expect(json.data['test-dates'].firstUsed).toBe(ts1);
    expect(json.data['test-dates'].lastUsed).toBe(ts2);
    expect(json.data['test-dates'].count).toBe(2);
  });

  it('POST /api/feature-usage/track returns 400 without featureId', async () => {
    const res = await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/feature-usage/reset clears all data', async () => {
    await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: 'pre-reset' }),
    });

    await fetch(`${BASE_URL}/api/feature-usage/reset`, { method: 'POST' });

    const res = await fetch(`${BASE_URL}/api/feature-usage`);
    const json = await res.json();
    expect(json.data).toEqual({});
  });
});

// ─── Client-side: track() debounce ─────────────────────────────────────────

describe('Client — track(): debounce logic', () => {
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

  it('track() fires POST and server records the event', async () => {
    await resetTracker(page);
    await page.evaluate(() => {
      (window as any).FeatureTracker.track('client-track-test');
    });
    // Wait for the fire-and-forget fetch to complete
    await page.waitForTimeout(500);

    const res = await fetch(`${BASE_URL}/api/feature-usage`);
    const json = await res.json();
    expect(json.data['client-track-test']).toBeDefined();
    expect(json.data['client-track-test'].count).toBe(1);
  });

  it('second track() within DEBOUNCE_MS is suppressed — count stays at 1', async () => {
    await resetTracker(page);
    await page.evaluate(() => {
      const ft = (window as any).FeatureTracker;
      ft.track('debounce-test');
      ft.track('debounce-test'); // immediate — should be suppressed
      ft.track('debounce-test'); // also suppressed
    });
    await page.waitForTimeout(500);

    const res = await fetch(`${BASE_URL}/api/feature-usage`);
    const json = await res.json();
    expect(json.data['debounce-test'].count).toBe(1);
  });

  it('track() after DEBOUNCE_MS is NOT suppressed — count becomes 2', async () => {
    await resetTracker(page);
    await page.evaluate(() => {
      const ft = (window as any).FeatureTracker;
      ft.track('debounce-pass');
      // Simulate time passing by backdating the _lastTrack entry
      ft._lastTrack['debounce-pass'] -= 1001;
      ft.track('debounce-pass');
    });
    await page.waitForTimeout(500);

    const res = await fetch(`${BASE_URL}/api/feature-usage`);
    const json = await res.json();
    expect(json.data['debounce-pass'].count).toBe(2);
  });

  it('debounce is per-feature — different feature IDs do not interfere', async () => {
    await resetTracker(page);
    await page.evaluate(() => {
      const ft = (window as any).FeatureTracker;
      ft.track('feature-alpha');
      ft.track('feature-beta'); // different ID — not debounced
      ft.track('feature-alpha'); // same ID, immediate — debounced
      ft.track('feature-beta'); // same ID, immediate — debounced
    });
    await page.waitForTimeout(500);

    const res = await fetch(`${BASE_URL}/api/feature-usage`);
    const json = await res.json();
    expect(json.data['feature-alpha'].count).toBe(1);
    expect(json.data['feature-beta'].count).toBe(1);
  });
});

// ─── Client-side: getData() ────────────────────────────────────────────────

describe('Client — getData(): async fetch from server', () => {
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

  it('getData() returns empty object when no data tracked', async () => {
    await resetTracker(page);
    const data = await page.evaluate(async () => {
      return await (window as any).FeatureTracker.getData();
    });
    expect(data).toEqual({});
  });

  it('getData() returns tracked data from server', async () => {
    await resetTracker(page);
    // Track via API directly
    await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: 'server-data-test', timestamp: '2026-01-15T00:00:00.000Z' }),
    });

    const data = await page.evaluate(async () => {
      return await (window as any).FeatureTracker.getData();
    });
    expect(data['server-data-test']).toBeDefined();
    expect(data['server-data-test'].count).toBe(1);
  });
});

// ─── Client-side: reset() ──────────────────────────────────────────────────

describe('Client — reset(): clears server data and _lastTrack', () => {
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

  it('reset() clears server data', async () => {
    // Track something first
    await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: 'pre-reset-test' }),
    });

    await page.evaluate(async () => {
      await (window as any).FeatureTracker.reset();
    });

    const res = await fetch(`${BASE_URL}/api/feature-usage`);
    const json = await res.json();
    expect(json.data).toEqual({});
  });

  it('reset() clears _lastTrack', async () => {
    await page.evaluate(() => {
      const ft = (window as any).FeatureTracker;
      ft.track('pre-reset-lt');
    });
    await page.waitForTimeout(200);

    const lastTrack = await page.evaluate(async () => {
      const ft = (window as any).FeatureTracker;
      await ft.reset();
      return ft._lastTrack;
    });
    expect(lastTrack).toEqual({});
  });

  it('after reset(), track() creates a fresh record — count is 1', async () => {
    await resetTracker(page);
    await page.evaluate(() => {
      (window as any).FeatureTracker.track('post-reset-feature');
    });
    await page.waitForTimeout(500);

    // Reset
    await page.evaluate(async () => {
      await (window as any).FeatureTracker.reset();
    });

    // Track again
    await page.evaluate(() => {
      (window as any).FeatureTracker.track('post-reset-feature');
    });
    await page.waitForTimeout(500);

    const res = await fetch(`${BASE_URL}/api/feature-usage`);
    const json = await res.json();
    expect(json.data['post-reset-feature'].count).toBe(1);
  });
});

// ─── Client-side: exportJson() ─────────────────────────────────────────────

describe('Client — exportJson(): merges server data with FeatureRegistry', () => {
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
    const json = await page.evaluate(async () => {
      return await (window as any).FeatureTracker.exportJson();
    });
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('exportJson() includes all FeatureRegistry entries', async () => {
    const result = await page.evaluate(async () => {
      const ft = (window as any).FeatureTracker;
      const registry = (window as any).FeatureRegistry || [];
      const rows = JSON.parse(await ft.exportJson());
      return { registryLen: registry.length, rowsLen: rows.length };
    });

    expect(result.rowsLen).toBe(result.registryLen);
    expect(result.registryLen).toBeGreaterThan(0);
  });

  it('exportJson() features with no usage have count=0 and null dates', async () => {
    await resetTracker(page);
    const result = await page.evaluate(async () => {
      const ft = (window as any).FeatureTracker;
      const rows = JSON.parse(await ft.exportJson());
      return rows.filter((r: any) => r.count !== 0 || r.firstUsed !== null || r.lastUsed !== null);
    });

    expect(result).toHaveLength(0);
  });

  it('exportJson() merges usage data for a tracked feature', async () => {
    await resetTracker(page);
    // Track a known registry feature via API
    const firstId = await page.evaluate(() => {
      const registry = (window as any).FeatureRegistry || [];
      return registry[0]?.id || null;
    });
    expect(firstId).not.toBeNull();

    await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: firstId }),
    });
    await fetch(`${BASE_URL}/api/feature-usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: firstId }),
    });

    const row = await page.evaluate(async (fid: string) => {
      const ft = (window as any).FeatureTracker;
      const rows = JSON.parse(await ft.exportJson());
      return rows.find((r: any) => r.id === fid);
    }, firstId);

    expect(row).not.toBeNull();
    expect(row.count).toBe(2);
    expect(row.firstUsed).not.toBeNull();
    expect(row.lastUsed).not.toBeNull();
  });

  it('exportJson() includes id, name, category, description fields from registry', async () => {
    const firstRow = await page.evaluate(async () => {
      const ft = (window as any).FeatureTracker;
      const rows = JSON.parse(await ft.exportJson());
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

  it('exportJson() works with empty FeatureRegistry', async () => {
    const result = await page.evaluate(async () => {
      const ft = (window as any).FeatureTracker;
      const savedRegistry = (window as any).FeatureRegistry;
      (window as any).FeatureRegistry = [];
      const json = await ft.exportJson();
      (window as any).FeatureRegistry = savedRegistry;
      return json;
    });

    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });

  it('exportJson() works when FeatureRegistry is undefined', async () => {
    const result = await page.evaluate(async () => {
      const ft = (window as any).FeatureTracker;
      const savedRegistry = (window as any).FeatureRegistry;
      (window as any).FeatureRegistry = undefined;
      const json = await ft.exportJson();
      (window as any).FeatureRegistry = savedRegistry;
      return json;
    });

    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });
});

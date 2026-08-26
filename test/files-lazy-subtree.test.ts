// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for the lazy file-subtree loader in
 * src/web/public/app.js — the client half of the breadth-first file tree.
 *
 * The REAL method bodies are extracted from the shipped app.js text and
 * re-compiled (same pattern as test/files-sheet-persistence.test.ts), so the
 * invariants below are asserted against the code that ships.
 *
 * Invariants under test:
 *  - the shared subtree queue never runs more than `_fileSubtreeMaxConcurrent`
 *    requests at once, and every task eventually runs;
 *  - a task DROPPED by _clearFileSubtreeQueue() still releases its surface's
 *    loading latch (the permanent-"Loading…"-row regression) — on BOTH the
 *    desktop panel and the mobile Files sheet, which share one queue but own
 *    separate latch sets;
 *  - a hung fetch times out, so the latch can never outlive the request;
 *  - the cache is generation-scoped and keyed by showHidden;
 *  - _applyFileSubtree() always marks a node loaded, so a render-time auto-kick
 *    cannot loop.
 *
 * Run: npx vitest run test/files-lazy-subtree.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

// ─── Real-source extraction ─────────────────────────────────────────────────

function methodSource(name: string): string {
  let start = APP_JS_SOURCE.indexOf(`\n  ${name}(`);
  if (start === -1) start = APP_JS_SOURCE.indexOf(`\n  async ${name}(`);
  expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
  const lines = APP_JS_SOURCE.slice(start + 1).split('\n');
  if (lines[0].trimEnd().endsWith('}')) return lines[0];
  const end = lines.findIndex((l, i) => i > 0 && l === '  }');
  expect(end, `${name}() has no 2-space closing brace`).toBeGreaterThan(0);
  return lines.slice(0, end + 1).join('\n');
}

const METHODS = [
  '_queueFileSubtreeTask',
  '_pumpFileSubtreeQueue',
  '_clearFileSubtreeQueue',
  '_scheduleFileBrowserRender',
  '_scheduleFilesRender',
  '_fetchFileSubtree',
  '_findFileTreeNode',
  '_applyFileSubtree',
  '_fileBrowserEnsureChildren',
  '_filesEnsureChildren',
];

/** Read the numeric class-field default straight out of app.js. */
function classField(name: string): number {
  const m = new RegExp(`\\n  ${name} = (\\d+);`).exec(APP_JS_SOURCE);
  expect(m, `${name} field not found in app.js`).toBeTruthy();
  return Number(m![1]);
}

const MAX_CONCURRENT = classField('_fileSubtreeMaxConcurrent');
const DEFAULT_TIMEOUT_MS = classField('_fileSubtreeTimeoutMs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApp(overrides: Record<string, unknown> = {}): any {
  const body = METHODS.map(methodSource).join(',\n');
  return Object.assign(new Function(`return ({\n${body}\n});`)(), {
    activeSessionId: 'sess-a',

    // Class fields the extracted methods rely on (mirrors app.js ~20113-20136).
    _fileSubtreeQueue: [],
    _fileSubtreeActive: 0,
    _fileSubtreeMaxConcurrent: MAX_CONCURRENT,
    _fileSubtreeTimeoutMs: DEFAULT_TIMEOUT_MS,
    _fileSubtreeGeneration: 0,
    _fileBrowserRenderQueued: false,
    _filesRenderQueued: false,
    _fileBrowserLoadSeq: 0,
    _filesLoadSeq: 0,
    _fileBrowserRenderSeq: 0,
    _filesRenderSeq: 0,

    // Desktop panel state.
    fileBrowserData: { tree: [] },
    fileBrowserSubtreeCache: new Map(),
    fileBrowserSubtreeInflight: new Map(),
    fileBrowserLoadingPaths: new Set(),
    renderFileBrowserTree: vi.fn(),

    // Mobile Files sheet state.
    filesState: {
      showHidden: true,
      data: { tree: [] },
      subtreeCache: new Map(),
      subtreeInflight: new Map(),
      loadingPaths: new Set(),
    },
    filesRenderTree: vi.fn(),

    ...overrides,
  });
}

const dirNode = (path: string) => ({
  name: path.split('/').pop(),
  path,
  type: 'directory',
  children: [],
  childrenLoaded: false,
  hasChildren: true,
});

/** Response body the route returns for a successful subtree fetch. */
const okBody = (tree: unknown[] = [], remainingChildren = 0) => ({
  ok: true,
  json: async () => ({ success: true, data: { tree, remainingChildren } }),
});

/** Let the microtask queue (and any pending rAF/timer) drain. */
const flush = async (ms = 0) => {
  await new Promise((r) => setTimeout(r, ms));
  await Promise.resolve();
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).fetch;
});

// ─── Gap 14 — bounded fan-out + drop handlers ───────────────────────────────

describe('subtree work queue', () => {
  it(`never runs more than ${MAX_CONCURRENT} tasks at once and completes them all`, async () => {
    const app = makeApp();
    let active = 0;
    let peak = 0;
    let completed = 0;
    const TASKS = 25;

    for (let i = 0; i < TASKS; i++) {
      app._queueFileSubtreeTask(async () => {
        active++;
        peak = Math.max(peak, active);
        await flush();
        active--;
        completed++;
      });
    }
    // Enqueue is synchronous, so the cap must already be visible.
    expect(app._fileSubtreeQueue.length).toBe(TASKS - MAX_CONCURRENT);

    await vi.waitFor(() => expect(completed).toBe(TASKS));
    expect(peak).toBe(MAX_CONCURRENT);
    expect(peak).toBeLessThanOrEqual(app._fileSubtreeMaxConcurrent);
    expect(app._fileSubtreeQueue.length).toBe(0);
    expect(app._fileSubtreeActive).toBe(0);
  });

  it('releases BOTH surfaces’ loading latches when the shared queue is cleared mid-flight', async () => {
    // The regression: the queue is shared by the desktop panel and the mobile
    // sheet, but each surface owns its own latch set. A task dropped by
    // _clearFileSubtreeQueue() never reaches its own `finally`, so without the
    // onDrop handler its directory keeps a "Loading…" row forever — and that row
    // pre-empts the retry row in both renderers, so there is no way to recover.
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async () => okBody());

    const desktopNodes = Array.from({ length: 10 }, (_, i) => dirNode(`d${i}`));
    const mobileNodes = Array.from({ length: 10 }, (_, i) => dirNode(`m${i}`));
    app.fileBrowserData.tree = desktopNodes;
    app.filesState.data.tree = mobileNodes;

    for (let i = 0; i < 10; i++) {
      app._fileBrowserEnsureChildren(desktopNodes[i]);
      app._filesEnsureChildren(mobileNodes[i]);
    }
    // Latches are set synchronously at enqueue time (that is what draws the
    // spinner row), so all 20 are latched before anything has run.
    expect(app.fileBrowserLoadingPaths.size).toBe(10);
    expect(app.filesState.loadingPaths.size).toBe(10);
    expect(app._fileSubtreeQueue.length).toBe(20 - MAX_CONCURRENT);

    // A reload from the mobile side clears the queue both surfaces share.
    app._clearFileSubtreeQueue();
    expect(app._fileSubtreeQueue.length).toBe(0);

    await vi.waitFor(() => {
      expect([...app.fileBrowserLoadingPaths]).toEqual([]);
      expect([...app.filesState.loadingPaths]).toEqual([]);
    });
  });
});

// ─── Gap 15 — timeout, dedupe, cache key ────────────────────────────────────

describe('_fetchFileSubtree()', () => {
  it('times out a hung request instead of latching the spinner forever', async () => {
    const app = makeApp({ _fileSubtreeTimeoutMs: 25 });
    // A fetch that only ever settles when its AbortController fires.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })
    );

    const node = dirNode('src');
    app.fileBrowserData.tree = [node];
    app._fileBrowserEnsureChildren(node);
    expect(app.fileBrowserLoadingPaths.has('src')).toBe(true);

    await vi.waitFor(() => expect(app.fileBrowserLoadingPaths.size).toBe(0));
    // The latch is gone, so the renderer draws the retry row rather than a
    // spinner row that would pre-empt it forever.
    expect(node._loadFailed).toBe(true);
    expect(node._loadError).toBe('Timed out loading folder');
    expect(node.childrenLoaded).toBe(false);
  });

  it('dedupes concurrent requests for the same path into one fetch', async () => {
    const app = makeApp();
    let resolveFetch: (v: unknown) => void = () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const args = ['sess-a', 'src', false, app.fileBrowserSubtreeCache, app.fileBrowserSubtreeInflight] as const;
    const p1 = app._fetchFileSubtree(...args);
    const p2 = app._fetchFileSubtree(...args);
    expect(p2).toBe(p1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);

    resolveFetch(okBody([{ name: 'a.ts', path: 'src/a.ts', type: 'file' }]));
    await expect(p1).resolves.toMatchObject({ tree: [{ path: 'src/a.ts' }] });
    expect(app.fileBrowserSubtreeInflight.size).toBe(0);

    // Cached now — a third call must not re-hit the server.
    await app._fetchFileSubtree(...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by showHidden, so the Hidden toggle cannot serve stale entries', async () => {
    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async () => okBody());
    const cache = app.fileBrowserSubtreeCache;
    const inflight = app.fileBrowserSubtreeInflight;

    await app._fetchFileSubtree('sess-a', 'src', false, cache, inflight);
    await app._fetchFileSubtree('sess-a', 'src', true, cache, inflight);

    expect([...cache.keys()].sort()).toEqual(['0:src', '1:src']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const urls = (globalThis as any).fetch.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls[0]).toContain('showHidden=false');
    expect(urls[1]).toContain('showHidden=true');
    // Expansion prefetches one extra level.
    expect(urls[0]).toContain('depth=2');
    expect(urls[0]).toContain('path=src');
  });

  // ─── Gap 16 — generation guard ────────────────────────────────────────────

  it('does not repopulate a cache that was cleared while the request was in flight', async () => {
    const app = makeApp();
    let resolveFetch: (v: unknown) => void = () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );
    const cache = app.fileBrowserSubtreeCache;
    const inflight = app.fileBrowserSubtreeInflight;

    const pending = app._fetchFileSubtree('sess-a', 'src', false, cache, inflight);
    // A Refresh / Hidden-toggle reload lands mid-flight.
    cache.clear();
    app._clearFileSubtreeQueue();
    resolveFetch(okBody([{ name: 'a.ts', path: 'src/a.ts', type: 'file' }]));

    // The caller still gets its data — the request is not wasted, just not remembered.
    await expect(pending).resolves.toMatchObject({ tree: [{ path: 'src/a.ts' }] });
    expect(cache.size).toBe(0);

    // A request entirely within the current generation still caches.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn(async () => okBody());
    await app._fetchFileSubtree('sess-a', 'src', false, cache, inflight);
    expect(cache.size).toBe(1);
  });
});

// ─── Gap 17 — _applyFileSubtree() ───────────────────────────────────────────

describe('_applyFileSubtree()', () => {
  it('marks the node loaded even when the fetch was itself truncated', () => {
    const app = makeApp();
    const node = { ...dirNode('big'), error: 'Cannot read directory (EACCES)', _loadFailed: true };

    app._applyFileSubtree(node, {
      tree: [{ name: 'a.ts', path: 'big/a.ts', type: 'file' }],
      remainingChildren: 203,
    });

    // childrenLoaded is true on ANY success, so the render-time auto-kick
    // (`if (!node.childrenLoaded ...) ensureChildren(node)`) can never loop.
    expect(node.childrenLoaded).toBe(true);
    expect(node.remainingChildren).toBe(203);
    expect(node.hasChildren).toBe(true);
    expect(node.children).toEqual([{ name: 'a.ts', path: 'big/a.ts', type: 'file' }]);
    // A successful fetch clears both failure states.
    expect(node.error).toBeNull();
    expect(node._loadFailed).toBe(false);
    expect(node._loadError).toBeNull();
  });

  it('reports an empty directory as loaded with no children', () => {
    const app = makeApp();
    const node = dirNode('empty');
    app._applyFileSubtree(node, { tree: [], remainingChildren: 0 });
    expect(node.childrenLoaded).toBe(true);
    expect(node.hasChildren).toBe(false);
    expect(node.remainingChildren).toBe(0);
  });
});

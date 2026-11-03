/**
 * @fileoverview GET /api/sessions/:id/file-index + buildFileIndex (Files sheet fuzzy search).
 *
 * Uses a real temp directory (test/routes/file-routes.test.ts mocks node:fs/promises
 * module-wide, so it can't exercise the walker). Covers: untracked + .gitignored
 * files listed, heavy dirs excluded at any depth, hidden toggle, symlinked dirs never
 * followed, symlinked files included, '/'-joined relative paths, cap/truncation with
 * breadth-first ordering, and the short per-root cache with the fresh=1 bypass.
 *
 * Run: npx vitest run test/routes/file-index-routes.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createMockRouteContext } from '../mocks/index.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import {
  buildFileIndex,
  getFileIndex,
  _resetFileIndexCacheForTests,
  _fileIndexCacheSizeForTests,
  FILE_TREE_EXCLUDE_DIRS,
  FILE_INDEX_CAP,
} from '../../src/web/file-index.js';

function write(root: string, rel: string, content = 'x'): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

interface IndexBody {
  success: boolean;
  data: { root: string; paths: string[]; count: number; truncated: boolean; cap: number };
}

describe('file index', () => {
  let app: FastifyInstance;
  let dir: string;
  let outside: string;
  let sessionId: string;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync('/tmp/codeman-file-index-'));
    outside = realpathSync(mkdtempSync('/tmp/codeman-file-index-outside-'));

    write(dir, 'README.md');
    write(dir, 'src/app.ts');
    write(dir, 'src/web/public/app.js');
    // Untracked + gitignored files must be listed (no .gitignore filtering).
    write(dir, '.gitignore', 'secret.log\nignored-dir/\n');
    write(dir, 'secret.log');
    write(dir, 'ignored-dir/data.txt');
    // Heavy dirs: excluded top-level and nested.
    write(dir, 'node_modules/pkg/index.js');
    write(dir, '.git/HEAD');
    write(dir, 'dist/bundle.js');
    write(dir, 'vendor/lib.js');
    write(dir, 'packages/a/node_modules/dep/index.js');
    write(dir, 'packages/a/dist/out.js');
    write(dir, 'packages/a/src/main.ts');
    // Hidden files / dirs.
    write(dir, '.env');
    write(dir, '.config/settings.json');
    // Symlinks: outside dir (must not be followed), loop to parent, inside file.
    write(outside, 'leak.txt');
    symlinkSync(outside, join(dir, 'outside-link'));
    symlinkSync('..', join(dir, 'src', 'loop'));
    symlinkSync(join(dir, 'src/app.ts'), join(dir, 'app-link.ts'));
    symlinkSync(join(dir, 'does-not-exist'), join(dir, 'dangling-link'));

    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    const ctx = createMockRouteContext();
    sessionId = ctx._sessionId;
    ctx.sessions.get(sessionId)!.workingDir = dir;
    registerFileRoutes(app, ctx as never);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetFileIndexCacheForTests();
  });

  async function getIndex(query = 'showHidden=true'): Promise<IndexBody> {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/file-index?${query}` });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as IndexBody;
  }

  it('lists untracked and .gitignored files', async () => {
    const body = await getIndex();
    expect(body.success).toBe(true);
    expect(body.data.paths).toEqual(
      expect.arrayContaining(['README.md', 'src/app.ts', 'src/web/public/app.js', 'secret.log', 'ignored-dir/data.txt'])
    );
    expect(body.data.root).toBe(dir);
    expect(body.data.cap).toBe(FILE_INDEX_CAP);
    expect(body.data.truncated).toBe(false);
    expect(body.data.count).toBe(body.data.paths.length);
  });

  it('excludes heavy directories at any depth', async () => {
    const { paths } = (await getIndex()).data;
    expect(paths).toContain('packages/a/src/main.ts');
    for (const p of paths) {
      for (const seg of p.split('/').slice(0, -1)) expect(FILE_TREE_EXCLUDE_DIRS.has(seg)).toBe(false);
    }
    expect(paths).not.toContain('node_modules/pkg/index.js');
    expect(paths).not.toContain('.git/HEAD');
    expect(paths).not.toContain('dist/bundle.js');
    expect(paths).not.toContain('vendor/lib.js');
    expect(paths).not.toContain('packages/a/node_modules/dep/index.js');
    expect(paths).not.toContain('packages/a/dist/out.js');
  });

  it('follows the showHidden toggle', async () => {
    const hidden = (await getIndex('showHidden=true')).data.paths;
    expect(hidden).toEqual(expect.arrayContaining(['.env', '.config/settings.json', '.gitignore']));
    const visible = (await getIndex('showHidden=false')).data.paths;
    expect(visible.some((p) => p.split('/').some((seg) => seg.startsWith('.')))).toBe(false);
    expect(visible).toContain('src/app.ts');
  });

  it('never follows symlinked directories but includes symlinked files', async () => {
    const { paths } = (await getIndex()).data;
    expect(paths.some((p) => p.startsWith('outside-link'))).toBe(false);
    expect(paths.some((p) => p.includes('leak.txt'))).toBe(false);
    expect(paths.some((p) => p.startsWith('src/loop'))).toBe(false);
    expect(paths).toContain('app-link.ts');
    expect(paths).not.toContain('dangling-link');
  });

  it("returns '/'-joined relative paths without '..' or './'", async () => {
    const { paths } = (await getIndex()).data;
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith('/')).toBe(false);
      expect(p.startsWith('./')).toBe(false);
      expect(p.split('/')).not.toContain('..');
      expect(p.includes('\\')).toBe(false);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('returns 404 for an unknown session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope/file-index' });
    expect(res.statusCode).toBe(404);
  });

  it('returns an error when the working directory is unreadable', async () => {
    const ctx = createMockRouteContext();
    ctx.sessions.get(ctx._sessionId)!.workingDir = join(dir, 'missing-root');
    const app2 = Fastify({ logger: false });
    registerFileRoutes(app2, ctx as never);
    await app2.ready();
    const res = await app2.inject({ method: 'GET', url: `/api/sessions/${ctx._sessionId}/file-index` });
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Cannot read working directory');
    await app2.close();
  });

  it('caps the index breadth-first and flags truncation', async () => {
    const root = realpathSync(mkdtempSync('/tmp/codeman-file-index-cap-'));
    try {
      write(root, 'a.txt');
      write(root, 'b.txt');
      for (let i = 0; i < 10; i++) write(root, `deep/level/f${i}.txt`);
      const res = await buildFileIndex(root, { includeHidden: true, cap: 5 });
      expect(res.paths).toHaveLength(5);
      expect(res.truncated).toBe(true);
      // Root files come first: a cap only cuts the deepest levels.
      expect(res.paths).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));

      const full = await buildFileIndex(root, { includeHidden: true, cap: 12 });
      expect(full.paths).toHaveLength(12);
      expect(full.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves a cached index briefly and bypasses it with fresh=1', async () => {
    const first = (await getIndex()).data.paths;
    expect(first).not.toContain('new-file.ts');
    write(dir, 'new-file.ts');
    try {
      const cached = (await getIndex()).data.paths;
      expect(cached).not.toContain('new-file.ts');
      const fresh = (await getIndex('showHidden=true&fresh=1')).data.paths;
      expect(fresh).toContain('new-file.ts');
    } finally {
      rmSync(join(dir, 'new-file.ts'), { force: true });
    }
  });

  it('prunes expired cache entries by age, not only by count', async () => {
    _resetFileIndexCacheForTests();
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      await getFileIndex(dir, false);
      await getFileIndex(dir, true);
      expect(_fileIndexCacheSizeForTests()).toBe(2);
      // Within the TTL both stay.
      nowSpy.mockReturnValue(t0 + 1_000);
      await getFileIndex(dir, false);
      expect(_fileIndexCacheSizeForTests()).toBe(2);
      // Past the TTL, the next call drops the stale entry for the other key.
      nowSpy.mockReturnValue(t0 + 60_000);
      await getFileIndex(dir, false);
      expect(_fileIndexCacheSizeForTests()).toBe(1);
    } finally {
      nowSpy.mockRestore();
      _resetFileIndexCacheForTests();
    }
  });

  it('skips an unreadable subdirectory but still lists its siblings', async (ctx) => {
    // root ignores directory permissions, so the walk would read it anyway.
    if (process.getuid?.() === 0) ctx.skip();
    const root = realpathSync(mkdtempSync('/tmp/codeman-file-index-perm-'));
    const locked = join(root, 'locked');
    try {
      write(root, 'top.txt');
      write(root, 'open/visible.txt');
      write(root, 'locked/hidden.txt');
      chmodSync(locked, 0o000);
      const res = await buildFileIndex(root, { includeHidden: true });
      expect(res.paths.sort()).toEqual(['open/visible.txt', 'top.txt']);
      expect(res.truncated).toBe(false);
    } finally {
      chmodSync(locked, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shares one in-flight walk between concurrent calls for the same key', async () => {
    const a = getFileIndex(dir, true);
    const b = getFileIndex(dir, true);
    expect(b).toBe(a);
    expect(_fileIndexCacheSizeForTests()).toBe(1);
    // A different hidden setting is a different key and starts its own walk.
    const c = getFileIndex(dir, false);
    expect(c).not.toBe(a);
    // fresh bypasses the in-flight walk.
    const d = getFileIndex(dir, true, { fresh: true });
    expect(d).not.toBe(a);
    await Promise.all([a, b, c, d]);
  });

  it('does not cache a failed walk, so a later call retries', async () => {
    const root = join(realpathSync(mkdtempSync('/tmp/codeman-file-index-retry-')), 'later');
    try {
      const failed = getFileIndex(root, true);
      await expect(failed).rejects.toThrow();
      expect(_fileIndexCacheSizeForTests()).toBe(0);
      write(root, 'now-here.txt');
      const retried = getFileIndex(root, true);
      expect(retried).not.toBe(failed);
      expect((await retried).paths).toEqual(['now-here.txt']);
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });

  it('evicts the oldest key once more than 8 indexes are cached', async () => {
    const base = realpathSync(mkdtempSync('/tmp/codeman-file-index-evict-'));
    try {
      const roots = Array.from({ length: 9 }, (_, i) => {
        write(base, `r${i}/f.txt`);
        return join(base, `r${i}`);
      });
      const promises = roots.map((r) => getFileIndex(r, true));
      await Promise.all(promises);
      expect(_fileIndexCacheSizeForTests()).toBe(8);
      // Newest keys are still served from cache...
      expect(getFileIndex(roots[8], true)).toBe(promises[8]);
      expect(getFileIndex(roots[1], true)).toBe(promises[1]);
      // ...but the oldest was evicted and gets a new walk.
      const again = getFileIndex(roots[0], true);
      expect(again).not.toBe(promises[0]);
      await again;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

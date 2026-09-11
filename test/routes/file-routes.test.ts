/**
 * @fileoverview Tests for file-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

// Mock fs/promises for file operations
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => 'file content'),
    stat: vi.fn(async () => ({ size: 100, isFile: () => true, isDirectory: () => false, mtimeMs: 0 })),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  },
}));

// Mock realpathSync for symlink resolution + existsSync for create-route pre-checks.
// existsSync also gates the module-load THUMB_CACHE_DIR bootstrap — a benign `false`
// default lets the real (spread) mkdirSync create the cache dir idempotently.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
    // The files route stat()s a resolved `?path=` target to reject non-directories.
    // Default to "is a directory" so subtree tests don't need a real filesystem;
    // the non-directory case overrides this explicitly.
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    // Default false (create-route targets don't exist yet), BUT report the
    // module-load THUMB_CACHE_DIR as existing so the import-time bootstrap
    // `if (!existsSync(THUMB_CACHE_DIR)) mkdirSync(...)` is skipped — homedir is
    // mocked to an unwritable path, so a real mkdirSync there would throw EACCES.
    existsSync: vi.fn((p: string) => String(p).includes('thumbnails')),
  };
});

// Mock homedir for preview endpoint allowlist tests
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(() => '/home/testuser'),
  };
});

// Mock fileStreamManager
vi.mock('../../src/file-stream-manager.js', () => ({
  fileStreamManager: {
    createStream: vi.fn(async () => ({ success: true, streamId: 'stream-1' })),
    closeStream: vi.fn(() => true),
  },
}));

import fs from 'node:fs/promises';
import { realpathSync, existsSync, statSync } from 'node:fs';
import { fileStreamManager } from '../../src/file-stream-manager.js';

const mockedReaddir = vi.mocked(fs.readdir);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedStat = vi.mocked(fs.stat);
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedMkdir = vi.mocked(fs.mkdir);
const mockedRm = vi.mocked(fs.rm);
const mockedUnlink = vi.mocked(fs.unlink);
const mockedRealpathSync = vi.mocked(realpathSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedStatSync = vi.mocked(statSync);
const mockedFileStreamManager = vi.mocked(fileStreamManager);

describe('file-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    // 8MB bodyLimit mirrors the production WebServer (server.ts) so the write
    // routes' own 5MB MAX_WRITE_SIZE guard is what rejects oversized bodies,
    // not Fastify's default 1MB transport limit.
    harness = await createRouteTestHarness(registerFileRoutes, { bodyLimit: 8 * 1024 * 1024 });
    vi.clearAllMocks();

    // Default: realpathSync returns the path unchanged (identity — path stays in sandbox)
    mockedRealpathSync.mockImplementation((p: string) => p as never);
    // Default: create-route pre-check sees no existing target
    mockedExistsSync.mockReturnValue(false);
    // Default stat — enriched with isDirectory()/mtimeMs for the write routes
    mockedStat.mockResolvedValue({
      size: 100,
      isFile: () => true,
      isDirectory: () => false,
      mtimeMs: 0,
    } as never);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/sessions/:id/files ==========

  describe('GET /api/sessions/:id/files', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/files',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns file tree for valid session', async () => {
      mockedReaddir.mockResolvedValue([
        { name: 'src', isDirectory: () => true },
        { name: 'package.json', isDirectory: () => false, name_: 'package.json' },
      ] as never);
      // Nested readdir for src/ returns empty
      mockedReaddir.mockResolvedValueOnce([
        { name: 'src', isDirectory: () => true },
        { name: 'package.json', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.root).toBe(harness.ctx._session.workingDir);
      expect(body.data.tree).toBeDefined();
    });

    it('respects depth parameter', async () => {
      mockedReaddir.mockResolvedValue([] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?depth=2`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('excludes hidden files by default', async () => {
      mockedReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => false },
        { name: 'visible.ts', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Hidden files should be excluded
      expect(body.data.totalFiles).toBe(1);
    });

    it('includes hidden files when showHidden=true', async () => {
      mockedReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => false },
        { name: 'visible.ts', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?showHidden=true`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.totalFiles).toBe(2);
    });

    it('excludes node_modules and .git directories', async () => {
      let callCount = 0;
      mockedReaddir.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return [
            { name: 'node_modules', isDirectory: () => true },
            { name: '.git', isDirectory: () => true },
            { name: 'src', isDirectory: () => true },
          ] as never;
        }
        return [] as never;
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?showHidden=true`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // node_modules and .git are in excludeDirs set — only src should be counted
      expect(body.data.totalDirectories).toBe(1); // only src
    });

    // ── Breadth-first walk, lazy per-directory loading, and the `path` param ──
    //
    // BFS visits directories LEVEL by level, so call-sequence readdir mocks
    // (mockResolvedValueOnce chains) are fragile here. Everything below drives a
    // path-keyed table instead: unlisted directories throw ENOENT, which is also
    // how the "unreadable directory" cases are expressed.

    /** Dirent-alike accepted by the route (only name + isDirectory are used). */
    const dirent = (name: string, isDir = false) => ({ name, isDirectory: () => isDir });

    const errno = (code: string) => Object.assign(new Error(code), { code });

    /**
     * Path-keyed readdir mock.
     * Values are either an entry array or an Error to throw for that directory.
     */
    function mockDirs(table: Record<string, Array<ReturnType<typeof dirent>> | Error>) {
      mockedReaddir.mockImplementation(async (dir: unknown) => {
        const entry = table[String(dir)];
        if (entry === undefined) throw errno('ENOENT');
        if (entry instanceof Error) throw entry;
        return entry as never;
      });
    }

    const wd = () => harness.ctx._session.workingDir as string;
    const names = (nodes: Array<{ name: string }>) => nodes.map((n) => n.name);
    const byName = (nodes: Array<{ name: string }>, name: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes.find((n) => n.name === name) as any;

    // Gap 1 — THE regression test for the reported bug.
    it('keeps root-level files when a sibling subtree exhausts the entry budget', async () => {
      // `big/` alone blows the 5000-entry budget. Under the old depth-first walk
      // the recursion into `big/` happened BEFORE the loop reached the root's file
      // entries (directories sort first), so package.json / README.md were silently
      // dropped from the response — exactly the reported data loss. Breadth-first
      // finishes the whole root level before descending, so they must survive and
      // the cut must land on `big/` instead.
      mockDirs({
        [wd()]: [dirent('big', true), dirent('package.json'), dirent('README.md')],
        [`${wd()}/big`]: Array.from({ length: 5200 }, (_, i) => dirent(`f${i}.txt`)),
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      // The whole root level survives — this is the assertion that fails under DFS.
      expect(names(body.data.tree)).toEqual(['big', 'package.json', 'README.md']);

      // ...and the truncation is explicit and per-directory, on the deepest frontier.
      const big = byName(body.data.tree, 'big');
      expect(big.childrenLoaded).toBe(false);
      expect(big.hasChildren).toBe(true);
      expect(big.remainingChildren).toBeGreaterThan(0);
      expect(big.children.length + big.remainingChildren).toBe(5200);
      expect(body.data.truncated).toBe(true);
      // Nothing was cut at the root level itself.
      expect(body.data.remainingChildren).toBe(0);
    });

    // Gap 2 — `?path=` returns a subtree, and the paths it returns round-trip.
    it('returns a subtree for ?path= and round-trips child paths', async () => {
      mockedStatSync.mockReturnValue({ isDirectory: () => true } as never);
      mockDirs({
        [wd()]: [dirent('src', true), dirent('package.json')],
        [`${wd()}/src`]: [dirent('a', true), dirent('index.ts')],
        [`${wd()}/src/a`]: [dirent('b.ts')],
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?path=src&depth=2`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toBe('src');
      expect(names(body.data.tree)).toEqual(['a', 'index.ts']);
      const a = byName(body.data.tree, 'a');
      expect(a.path).toBe('src/a');
      expect(names(a.children)).toEqual(['b.ts']);
      expect(a.children[0].path).toBe('src/a/b.ts');
      expect(a.childrenLoaded).toBe(true);

      // The client sends exactly that path back when the user expands `a`.
      const res2 = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?path=${encodeURIComponent(a.path)}&depth=2`,
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);
      expect(body2.success).toBe(true);
      expect(body2.data.path).toBe('src/a');
      expect(body2.data.tree[0].path).toBe('src/a/b.ts');
    });

    // Gap 3 — containment.
    it.each([
      ['../outside', 'relative traversal'],
      ['/etc', 'absolute path'],
    ])('rejects ?path=%s (%s) as outside the working directory', async (badPath) => {
      mockDirs({ [wd()]: [] });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?path=${encodeURIComponent(badPath)}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INVALID_INPUT');
      expect(body.error).toContain('within working directory');
    });

    // Gap 4 — symlink escape (realpathSync resolves outside workingDir).
    it('rejects a ?path= symlink that resolves outside the working directory', async () => {
      mockedRealpathSync.mockReturnValue('/etc' as never);
      mockDirs({ [wd()]: [] });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?path=sneaky-link`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INVALID_INPUT');
    });

    // Gap 5 — nonexistent path.
    it('returns NOT_FOUND when ?path= does not exist', async () => {
      mockedRealpathSync.mockImplementation(() => {
        throw errno('ENOENT');
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?path=nope`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('NOT_FOUND');
      expect(body.error).toContain('Directory not found');
    });

    // Gap 6 — non-directory target must not be a silent empty success.
    it('returns INVALID_INPUT when ?path= is a file, not a directory', async () => {
      mockedStatSync.mockReturnValueOnce({ isDirectory: () => false } as never);
      mockDirs({ [wd()]: [dirent('package.json')] });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?path=package.json`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INVALID_INPUT');
      expect(body.error).toContain('not a directory');
    });

    // Gap 7 — empty path means the root.
    it("treats path='' as the working directory root", async () => {
      mockDirs({
        [wd()]: [dirent('src', true), dirent('package.json')],
        [`${wd()}/src`]: [],
      });

      const withEmpty = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?path=&depth=2`,
      });
      const omitted = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?depth=2`,
      });
      expect(withEmpty.statusCode).toBe(200);
      const a = JSON.parse(withEmpty.body);
      const b = JSON.parse(omitted.body);
      expect(a.success).toBe(true);
      expect(a.data.path).toBe('');
      expect(a.data).toEqual(b.data);
      expect(names(a.data.tree)).toEqual(['src', 'package.json']);
    });

    // Gap 8 + 11 — the three distinct per-directory states, side by side.
    it('distinguishes loaded-empty, budget-cut and unreadable directories', async () => {
      // Names chosen so the level is walked in this order: the budget is still
      // intact when `aempty` and `blocked` are processed, and `zbig` is what
      // exhausts it.
      mockDirs({
        [wd()]: [dirent('aempty', true), dirent('blocked', true), dirent('zbig', true)],
        [`${wd()}/aempty`]: [],
        [`${wd()}/blocked`]: errno('EACCES'),
        [`${wd()}/zbig`]: Array.from({ length: 5200 }, (_, i) => dirent(`f${i}.txt`)),
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const tree = body.data.tree;

      // 1. Loaded and genuinely empty.
      const empty = byName(tree, 'aempty');
      expect(empty.childrenLoaded).toBe(true);
      expect(empty.hasChildren).toBe(false);
      expect(empty.error).toBeUndefined();
      expect(empty.remainingChildren).toBeUndefined();

      // 2. Cut by the entry budget — NOT empty, and it says how much is left.
      const cut = byName(tree, 'zbig');
      expect(cut.childrenLoaded).toBe(false);
      expect(cut.hasChildren).toBe(true);
      expect(cut.remainingChildren).toBeGreaterThan(0);
      expect(cut.error).toBeUndefined();

      // 3. Unreadable — a third state, never folded back into "empty".
      const locked = byName(tree, 'blocked');
      expect(locked.childrenLoaded).toBe(false);
      expect(locked.hasChildren).toBe(true);
      expect(locked.error).toBe('Cannot read directory (EACCES)');

      // Gap 11: error labels are errno-only — they never leak an absolute path.
      // (`data.root` legitimately carries the working dir, so assert on the label.)
      expect(locked.error).not.toContain(wd());
    });

    // Gap 9 — unreadable AT the depth frontier keeps the third state (chevron).
    it('keeps the unreadable state for a directory at the depth frontier', async () => {
      mockDirs({
        [wd()]: [dirent('emptydir', true), dirent('locked', true), dirent('root.txt')],
        [`${wd()}/emptydir`]: [],
        [`${wd()}/locked`]: errno('EACCES'),
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?depth=1`,
      });
      expect(res.statusCode).toBe(200);
      const tree = JSON.parse(res.body).data.tree;

      const locked = byName(tree, 'locked');
      expect(locked.childrenLoaded).toBe(false);
      // hasChildren MUST stay true, or the chevron disappears and the folder looks
      // silently empty with no way to see the real error.
      expect(locked.hasChildren).toBe(true);
      expect(locked.error).toBe('Cannot read directory (EACCES)');

      // A frontier directory that is merely empty still reports no children.
      const empty = byName(tree, 'emptydir');
      expect(empty.childrenLoaded).toBe(false);
      expect(empty.hasChildren).toBe(false);
      expect(empty.error).toBeUndefined();

      expect(names(tree)).toContain('root.txt');
    });

    // Gap 10 — unreadable REQUESTED root is an error, not an empty success.
    it('returns INTERNAL_ERROR when the requested subtree root is unreadable', async () => {
      mockedStatSync.mockReturnValue({ isDirectory: () => true } as never);
      mockDirs({
        [wd()]: [dirent('locked', true)],
        [`${wd()}/locked`]: errno('EACCES'),
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?path=locked`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INTERNAL_ERROR');
      expect(body.error).toBe('Cannot read directory (EACCES)');
      // The label is errno-only — no absolute path leaks to the client.
      expect(body.error).not.toContain(wd());
    });

    // Gap 12 — depth clamping, asserted on the echoed value.
    it.each([
      ['abc', 5],
      ['0', 5],
      ['-3', 5],
      ['', 5],
      ['2', 2],
      ['99', 10],
    ])('clamps depth=%s to %i', async (depth, expected) => {
      mockDirs({ [wd()]: [] });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?depth=${encodeURIComponent(depth)}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.depth).toBe(expected);
    });
  });

  // ========== GET /api/sessions/:id/file-content ==========

  describe('GET /api/sessions/:id/file-content', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/file-content?path=test.ts',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns error for missing path parameter', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing path');
    });

    it('returns text file content', async () => {
      const fileContent = 'const x = 1;\nconst y = 2;\n';
      mockedReadFile.mockResolvedValue(fileContent as never);
      mockedStat.mockResolvedValue({ size: fileContent.length, mtimeMs: 1717171717171 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=src/test.ts`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toBe(fileContent);
      expect(body.data.extension).toBe('ts');
      // Read now exposes mtime so the editor can pass it back as a staleness guard.
      expect(body.data.mtime).toBe(1717171717171);
    });

    it('returns binary metadata for image files', async () => {
      mockedStat.mockResolvedValue({ size: 1024 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=logo.png`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('image');
      expect(body.data.url).toContain('file-raw');
    });

    it.each([
      ['book.xlsx', 'xlsx'],
      ['legacy/OLD.XLS', 'xls'],
      ['calc.ods', 'ods'],
    ])('returns spreadsheet metadata for %s without decoding it as text', async (path, ext) => {
      mockedStat.mockResolvedValue({ size: 2048, mtimeMs: 1717000000123 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=${encodeURIComponent(path)}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      // Exact shape: no `content` key, and mtime is present for the save staleness guard.
      expect(body.data).toEqual({
        path,
        size: 2048,
        type: 'spreadsheet',
        extension: ext,
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=${encodeURIComponent(path)}`,
        mtime: 1717000000123,
      });
      expect(mockedReadFile).not.toHaveBeenCalled();
    });

    it('includes mtime in binary metadata for non-spreadsheet binaries too', async () => {
      mockedStat.mockResolvedValue({ size: 1024, mtimeMs: 4242 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=logo.png`,
      });
      const body = JSON.parse(res.body);
      expect(body.data.type).toBe('image');
      expect(body.data.mtime).toBe(4242);
    });

    it.each(['data.csv', 'Data.TSV'])('keeps %s on the utf-8 text path', async (path) => {
      const text = 'a,b\n1,2\n';
      mockedReadFile.mockResolvedValue(text as never);
      mockedStat.mockResolvedValue({ size: text.length, mtimeMs: 99 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=${path}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toBe(text);
      expect(body.data.type).toBeUndefined();
      expect(body.data.mtime).toBe(99);
      expect(mockedReadFile).toHaveBeenCalledWith(`/tmp/test-workdir/${path}`, 'utf-8');
    });

    it('rejects path traversal attempts', async () => {
      // realpathSync resolves the symlink to a path outside workingDir
      mockedRealpathSync.mockReturnValue('/etc/passwd' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=../../etc/passwd`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects files that are too large', async () => {
      mockedStat.mockResolvedValue({ size: 20 * 1024 * 1024 } as never); // 20MB

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=large-file.txt`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('too large');
    });

    it('truncates content when exceeding line limit', async () => {
      const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n');
      mockedReadFile.mockResolvedValue(lines as never);
      mockedStat.mockResolvedValue({ size: lines.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=big.txt&lines=100`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.truncated).toBe(true);
      expect(body.data.totalLines).toBe(600);
    });

    it('returns file not found when realpathSync throws', async () => {
      mockedRealpathSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=nonexistent.ts`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  // ========== GET /api/sessions/:id/file-raw ==========

  describe('GET /api/sessions/:id/file-raw', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/file-raw?path=test.png',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for missing path parameter', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('serves raw file with correct content type', async () => {
      const content = Buffer.from('fake png data');
      mockedReadFile.mockResolvedValue(content as never);
      mockedStat.mockResolvedValue({ size: content.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=image.png`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
    });

    it.each([
      ['book.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['OLD.XLS', 'application/vnd.ms-excel'],
      ['calc.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
      ['data.csv', 'text/csv'],
      ['data.tsv', 'text/tab-separated-values'],
    ])('serves %s as %s with the bytes unchanged', async (path, mime) => {
      const content = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80]);
      mockedReadFile.mockResolvedValue(content as never);
      mockedStat.mockResolvedValue({ size: content.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=${path}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe(mime);
      expect(res.rawPayload.equals(content)).toBe(true);
    });

    it('rejects path traversal in raw file serving', async () => {
      mockedRealpathSync.mockReturnValue('/etc/shadow' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=../../etc/shadow`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects overly large raw files', async () => {
      mockedStat.mockResolvedValue({ size: 100 * 1024 * 1024 } as never); // 100MB

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=huge.bin`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ========== DELETE /api/sessions/:id/tail-file/:streamId ==========

  describe('DELETE /api/sessions/:id/tail-file/:streamId', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/nonexistent/tail-file/stream-1',
      });
      expect(res.statusCode).toBe(404);
    });

    it('closes an existing stream', async () => {
      mockedFileStreamManager.closeStream.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/tail-file/stream-1`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockedFileStreamManager.closeStream).toHaveBeenCalledWith('stream-1');
    });

    it('returns false for unknown stream', async () => {
      mockedFileStreamManager.closeStream.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/tail-file/nonexistent`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/files/preview ==========

  describe('GET /api/files/preview', () => {
    it('returns 400 when path query param is missing', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing or non-absolute path');
    });

    it('returns 400 when path is not absolute', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=relative/image.png',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing or non-absolute path');
    });

    it('returns 400 when file extension is not an allowed image type', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/document.pdf',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Not an image file');
    });

    it('returns 400 for a file with no extension', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/noextension',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Not an image file');
    });

    it('returns 404 when file does not exist (realpathSync throws)', async () => {
      mockedRealpathSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/nonexistent.png',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('File not found');
    });

    it('returns 403 when resolved path is outside the allowlist', async () => {
      mockedRealpathSync.mockReturnValue('/etc/shadow.png' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/etc/shadow.png',
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Path outside allowed directories');
    });

    it('returns 403 when symlink resolves outside the allowlist', async () => {
      // Path looks like it's in /tmp but resolves to /etc via symlink
      mockedRealpathSync.mockReturnValue('/etc/secrets/image.png' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/sneaky-link.png',
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Path outside allowed directories');
    });

    it('returns 400 when file is not a regular file', async () => {
      mockedRealpathSync.mockReturnValue('/tmp/somedir.png' as never);
      mockedStat.mockResolvedValue({ size: 100, isFile: () => false } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/somedir.png',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Not a regular file');
    });

    it('returns 400 when file exceeds 50MB size cap', async () => {
      mockedRealpathSync.mockReturnValue('/tmp/huge.png' as never);
      mockedStat.mockResolvedValue({ size: 60 * 1024 * 1024, isFile: () => true } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/huge.png',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('too large');
    });

    it('returns 400 when symlink resolves to a non-image extension in an allowed directory', async () => {
      // rawPath has .png extension but resolves to a .txt file in /tmp
      mockedRealpathSync.mockReturnValue('/tmp/data.txt' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/trick.png',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Not an image file');
    });

    it('returns 200 with correct Content-Type for a PNG in /tmp', async () => {
      const content = Buffer.from('fake png data');
      mockedRealpathSync.mockReturnValue('/tmp/screenshot.png' as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true } as never);
      mockedReadFile.mockResolvedValue(content as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/screenshot.png',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('private, max-age=60');
    });

    it('returns 200 with correct Content-Type for a JPEG in homedir', async () => {
      const content = Buffer.from('fake jpeg data');
      mockedRealpathSync.mockReturnValue('/home/testuser/photos/cat.jpg' as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true } as never);
      mockedReadFile.mockResolvedValue(content as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/home/testuser/photos/cat.jpg',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe('private, max-age=60');
    });

    it('returns 200 with correct Content-Type for SVG', async () => {
      const content = Buffer.from('<svg></svg>');
      mockedRealpathSync.mockReturnValue('/tmp/icon.svg' as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true } as never);
      mockedReadFile.mockResolvedValue(content as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/icon.svg',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/svg+xml');
    });

    it('returns 200 with correct Content-Type for WebP', async () => {
      const content = Buffer.from('fake webp data');
      mockedRealpathSync.mockReturnValue('/home/testuser/img.webp' as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true } as never);
      mockedReadFile.mockResolvedValue(content as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/home/testuser/img.webp',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
    });

    it('returns 200 with correct Content-Type for GIF', async () => {
      const content = Buffer.from('fake gif data');
      mockedRealpathSync.mockReturnValue('/tmp/anim.gif' as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true } as never);
      mockedReadFile.mockResolvedValue(content as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/anim.gif',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/gif');
    });

    it('returns file content as the response body', async () => {
      const content = Buffer.from('PNG raw bytes here');
      mockedRealpathSync.mockReturnValue('/tmp/test.png' as never);
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true } as never);
      mockedReadFile.mockResolvedValue(content as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/files/preview?path=/tmp/test.png',
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload).toEqual(content);
    });
  });

  // ========== PUT /api/sessions/:id/file-content (save) ==========

  describe('PUT /api/sessions/:id/file-content', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/sessions/nonexistent/file-content',
        payload: { path: 'notes.txt', content: 'hi' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when path is missing', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { content: 'hi' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing path');
    });

    it('returns 400 when content is not a string', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { path: 'notes.txt', content: 123 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing content');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('rejects an oversized write body via the 5MB guard (before writeFile)', async () => {
      // Body over MAX_WRITE_SIZE (5MB) but under the 8MB transport limit reaches
      // the handler and gets the route's clean 400 "Content too large", never
      // touching writeFile.
      const tooBig = 'a'.repeat(6 * 1024 * 1024);
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { path: 'notes.txt', content: tooBig },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('too large');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('rejects path traversal / symlink escape', async () => {
      // realpathSync resolves to a path outside workingDir
      mockedRealpathSync.mockReturnValue('/etc/passwd' as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { path: '../../etc/passwd', content: 'pwned' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('within working directory');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('returns 404 when realpathSync throws (file not found)', async () => {
      mockedRealpathSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { path: 'ghost.txt', content: 'x' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('returns 400 when the target is not a regular file', async () => {
      mockedStat.mockResolvedValue({
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        mtimeMs: 100,
      } as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { path: 'somedir', content: 'x' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not a regular file');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('returns 409 CONFLICT when expectedMtime mismatches (staleness guard)', async () => {
      mockedStat.mockResolvedValue({
        size: 10,
        isFile: () => true,
        isDirectory: () => false,
        mtimeMs: 2000,
      } as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { path: 'notes.txt', content: 'stale write', expectedMtime: 1000 },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('CONFLICT');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('writes when expectedMtime matches (within 0.5ms tolerance)', async () => {
      mockedStat.mockResolvedValue({
        size: 42,
        isFile: () => true,
        isDirectory: () => false,
        mtimeMs: 5000,
      } as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { path: 'notes.txt', content: 'fresh write', expectedMtime: 5000 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    });

    it('saves successfully and returns fresh size/mtime WITHOUT echoing content', async () => {
      mockedStat.mockResolvedValue({
        size: 11,
        isFile: () => true,
        isDirectory: () => false,
        mtimeMs: 7777,
      } as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { path: 'notes.txt', content: 'hello world' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toBe('notes.txt');
      expect(body.data.size).toBe(11);
      expect(body.data.mtime).toBe(7777);
      // Content must NOT be echoed back in the save response.
      expect(body.data.content).toBeUndefined();
      // writeFile called with utf-8 encoding.
      expect(mockedWriteFile).toHaveBeenCalledWith('/tmp/test-workdir/notes.txt', 'hello world', 'utf-8');
    });

    it("writes text with 'utf-8' when encoding is explicitly 'utf-8'", async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { path: 'data.csv', content: 'a,b\n', encoding: 'utf-8' },
      });
      expect(res.statusCode).toBe(200);
      expect(mockedWriteFile).toHaveBeenCalledWith('/tmp/test-workdir/data.csv', 'a,b\n', 'utf-8');
    });

    it.each([['hex'], ['BASE64'], [123], [null]])(
      'rejects encoding %j with 400 INVALID_INPUT before writeFile',
      async (encoding) => {
        const res = await harness.app.inject({
          method: 'PUT',
          url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
          payload: { path: 'book.xlsx', content: 'UEsDBA==', encoding },
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(false);
        expect(body.errorCode).toBe('INVALID_INPUT');
        expect(body.error).toContain('Invalid encoding');
        expect(mockedWriteFile).not.toHaveBeenCalled();
      }
    );

    describe("encoding: 'base64' (binary saves from the spreadsheet editor)", () => {
      // Zip magic plus bytes that are not valid UTF-8 — a utf-8 write would corrupt them.
      const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80, 0x0a]);

      it('writes the decoded bytes as a Buffer with no utf-8 encoding argument', async () => {
        mockedStat.mockResolvedValue({
          size: bytes.length,
          isFile: () => true,
          isDirectory: () => false,
          mtimeMs: 4242,
        } as never);

        const res = await harness.app.inject({
          method: 'PUT',
          url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
          payload: { path: 'book.xlsx', content: bytes.toString('base64'), encoding: 'base64', expectedMtime: 4242 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.data).toEqual({ path: 'book.xlsx', size: bytes.length, mtime: 4242 });
        expect(mockedWriteFile).toHaveBeenCalledTimes(1);
        const args = mockedWriteFile.mock.calls[0];
        expect(args).toHaveLength(2);
        expect(args[0]).toBe('/tmp/test-workdir/book.xlsx');
        expect(Buffer.isBuffer(args[1])).toBe(true);
        expect((args[1] as Buffer).equals(bytes)).toBe(true);
      });

      it('writes an empty Buffer for an empty base64 body', async () => {
        const res = await harness.app.inject({
          method: 'PUT',
          url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
          payload: { path: 'book.xlsx', content: '', encoding: 'base64' },
        });
        expect(res.statusCode).toBe(200);
        const args = mockedWriteFile.mock.calls[0];
        expect(args).toHaveLength(2);
        expect(Buffer.isBuffer(args[1])).toBe(true);
        expect((args[1] as Buffer).length).toBe(0);
      });

      it.each([
        ['characters outside the base64 alphabet', 'ab!d'],
        ['the base64url alphabet', 'ab-_'],
        ['a length that is not a multiple of 4', 'UEsDB'],
        ['padding in the middle', 'ab=d'],
      ])('rejects %s with 400 "Invalid base64 content"', async (_label, content) => {
        const res = await harness.app.inject({
          method: 'PUT',
          url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
          payload: { path: 'book.xlsx', content, encoding: 'base64' },
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.errorCode).toBe('INVALID_INPUT');
        expect(body.error).toContain('Invalid base64 content');
        expect(mockedWriteFile).not.toHaveBeenCalled();
      });

      it('rejects a decoded size just over 5MB before writeFile', async () => {
        // 6,990,508 base64 chars with no padding decode to 5MB + 1 byte.
        const content = 'A'.repeat(6990508);
        const res = await harness.app.inject({
          method: 'PUT',
          url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
          payload: { path: 'book.xlsx', content, encoding: 'base64' },
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toContain('too large');
        expect(mockedWriteFile).not.toHaveBeenCalled();
      });

      it('accepts a decoded size of exactly 5MB even though the base64 text is longer', async () => {
        // One '=' of padding: 6,990,508 chars decode to exactly 5 * 1024 * 1024 bytes.
        const content = 'A'.repeat(6990507) + '=';
        expect(content.length).toBeGreaterThan(5 * 1024 * 1024);

        const res = await harness.app.inject({
          method: 'PUT',
          url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
          payload: { path: 'book.xlsx', content, encoding: 'base64' },
        });
        expect(res.statusCode).toBe(200);
        const args = mockedWriteFile.mock.calls[0];
        expect((args[1] as Buffer).length).toBe(5 * 1024 * 1024);
      });

      it('returns 409 CONFLICT for a stale expectedMtime without writing', async () => {
        mockedStat.mockResolvedValue({
          size: 10,
          isFile: () => true,
          isDirectory: () => false,
          mtimeMs: 2000,
        } as never);

        const res = await harness.app.inject({
          method: 'PUT',
          url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
          payload: { path: 'book.xlsx', content: bytes.toString('base64'), encoding: 'base64', expectedMtime: 1000 },
        });
        expect(res.statusCode).toBe(409);
        expect(JSON.parse(res.body).errorCode).toBe('CONFLICT');
        expect(mockedWriteFile).not.toHaveBeenCalled();
      });

      it('applies the working-directory sandbox', async () => {
        mockedRealpathSync.mockReturnValue('/etc/passwd' as never);

        const res = await harness.app.inject({
          method: 'PUT',
          url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
          payload: { path: '../../etc/passwd', content: bytes.toString('base64'), encoding: 'base64' },
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toContain('within working directory');
        expect(mockedWriteFile).not.toHaveBeenCalled();
      });
    });
  });

  // ========== POST /api/sessions/:id/file-create ==========

  describe('POST /api/sessions/:id/file-create', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/file-create',
        payload: { path: 'new.txt' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when path is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/file-create`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Missing path');
    });

    it('rejects an oversized create body via the 5MB guard (before writeFile)', async () => {
      // Body over MAX_WRITE_SIZE (5MB) but under the 8MB transport limit reaches
      // the handler and gets the route's clean 400 "Content too large".
      const tooBig = 'a'.repeat(6 * 1024 * 1024);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/file-create`,
        payload: { path: 'new.txt', content: tooBig },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('too large');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('rejects an unsafe basename (resolveNewChild)', async () => {
      // A backslash in the basename is rejected on POSIX (valid filename char, but blocked).
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/file-create`,
        payload: { path: 'bad\\name' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Invalid file or folder name');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('rejects when the parent resolves outside the sandbox', async () => {
      // realpathSync(parent) escapes the working directory.
      mockedRealpathSync.mockReturnValue('/etc' as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/file-create`,
        payload: { path: 'sub/file.txt' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('within working directory');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('returns 404 when the parent directory does not exist', async () => {
      mockedRealpathSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/file-create`,
        payload: { path: 'missing-dir/file.txt' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Parent directory not found');
    });

    it('returns 409 ALREADY_EXISTS when the target already exists', async () => {
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/file-create`,
        payload: { path: 'existing.txt' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('ALREADY_EXISTS');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('creates a file with the wx flag and returns path/size/mtime', async () => {
      mockedStat.mockResolvedValue({
        size: 5,
        isFile: () => true,
        isDirectory: () => false,
        mtimeMs: 3000,
      } as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/file-create`,
        payload: { path: 'new.txt', content: 'hello' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toBe('new.txt');
      expect(body.data.size).toBe(5);
      expect(body.data.mtime).toBe(3000);
      expect(mockedWriteFile).toHaveBeenCalledWith('/tmp/test-workdir/new.txt', 'hello', {
        encoding: 'utf-8',
        flag: 'wx',
      });
    });

    it('creates a file in a nested subdirectory', async () => {
      // Frontend POSTs { path: dir + '/' + name }. The identity realpathSync mock
      // resolves the parent (/tmp/test-workdir/subdir) inside the sandbox, so the
      // success path joins the resolved parent with the basename.
      mockedStat.mockResolvedValue({
        size: 4,
        isFile: () => true,
        isDirectory: () => false,
        mtimeMs: 4000,
      } as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/file-create`,
        payload: { path: 'subdir/nested.txt', content: 'deep' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toBe('subdir/nested.txt');
      expect(mockedWriteFile).toHaveBeenCalledWith('/tmp/test-workdir/subdir/nested.txt', 'deep', {
        encoding: 'utf-8',
        flag: 'wx',
      });
    });

    it('creates a dotfile (leading-dot name allowed by resolveNewChild)', async () => {
      // resolveNewChild only rejects exactly '.'/'..' — a leading-dot filename
      // like '.env.local' is a valid basename and must be written, not blocked.
      mockedStat.mockResolvedValue({
        size: 3,
        isFile: () => true,
        isDirectory: () => false,
        mtimeMs: 5000,
      } as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/file-create`,
        payload: { path: '.env.local', content: 'KEY' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toBe('.env.local');
      expect(mockedWriteFile).toHaveBeenCalledWith('/tmp/test-workdir/.env.local', 'KEY', {
        encoding: 'utf-8',
        flag: 'wx',
      });
    });
  });

  // ========== POST /api/sessions/:id/dir-create ==========

  describe('POST /api/sessions/:id/dir-create', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/dir-create',
        payload: { path: 'newdir' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when path is missing', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/dir-create`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Missing path');
    });

    it('rejects an unsafe basename (resolveNewChild)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/dir-create`,
        payload: { path: 'bad\\dir' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Invalid file or folder name');
      expect(mockedMkdir).not.toHaveBeenCalled();
    });

    it('returns 409 ALREADY_EXISTS when the target already exists', async () => {
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/dir-create`,
        payload: { path: 'existingdir' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.errorCode).toBe('ALREADY_EXISTS');
      expect(mockedMkdir).not.toHaveBeenCalled();
    });

    it('creates a directory and returns path/mtime', async () => {
      mockedStat.mockResolvedValue({
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        mtimeMs: 4000,
      } as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/dir-create`,
        payload: { path: 'newdir' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toBe('newdir');
      expect(body.data.mtime).toBe(4000);
      expect(mockedMkdir).toHaveBeenCalledWith('/tmp/test-workdir/newdir');
    });
  });

  // ========== DELETE /api/sessions/:id/file ==========

  describe('DELETE /api/sessions/:id/file', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/nonexistent/file',
        payload: { path: 'old.txt' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when path is missing', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/file`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Missing path');
    });

    it('rejects path traversal', async () => {
      mockedRealpathSync.mockReturnValue('/etc/passwd' as never);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/file`,
        payload: { path: '../../etc/passwd' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('within working directory');
      expect(mockedUnlink).not.toHaveBeenCalled();
      expect(mockedRm).not.toHaveBeenCalled();
    });

    it('returns 404 when realpathSync throws', async () => {
      mockedRealpathSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/file`,
        payload: { path: 'ghost.txt' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not found');
    });

    it('refuses to delete the working-directory root', async () => {
      // path '.' resolves to workingDir → relativePath === ''
      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/file`,
        payload: { path: '.' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Refusing to delete the working directory root');
      expect(mockedRm).not.toHaveBeenCalled();
      expect(mockedUnlink).not.toHaveBeenCalled();
    });

    it('deletes a regular file via unlink', async () => {
      mockedStat.mockResolvedValue({
        size: 10,
        isFile: () => true,
        isDirectory: () => false,
        mtimeMs: 1,
      } as never);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/file`,
        payload: { path: 'old.txt' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockedUnlink).toHaveBeenCalledWith('/tmp/test-workdir/old.txt');
      expect(mockedRm).not.toHaveBeenCalled();
    });

    it('refuses to delete a non-empty directory without the recursive flag', async () => {
      mockedStat.mockResolvedValue({
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        mtimeMs: 1,
      } as never);
      mockedReaddir.mockResolvedValue(['child.txt'] as never);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/file`,
        payload: { path: 'somedir' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('recursive delete requires explicit confirmation');
      expect(mockedRm).not.toHaveBeenCalled();
    });

    it('deletes a non-empty directory when the recursive flag is set', async () => {
      mockedStat.mockResolvedValue({
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        mtimeMs: 1,
      } as never);
      mockedReaddir.mockResolvedValue(['child.txt'] as never);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/file`,
        payload: { path: 'somedir', recursive: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockedRm).toHaveBeenCalledWith('/tmp/test-workdir/somedir', {
        recursive: true,
        force: false,
      });
    });

    it('deletes an empty directory without a flag', async () => {
      mockedStat.mockResolvedValue({
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        mtimeMs: 1,
      } as never);
      mockedReaddir.mockResolvedValue([] as never);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/file`,
        payload: { path: 'emptydir' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(mockedRm).toHaveBeenCalledWith('/tmp/test-workdir/emptydir', {
        recursive: true,
        force: false,
      });
    });
  });
});

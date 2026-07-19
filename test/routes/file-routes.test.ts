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
import { realpathSync, existsSync } from 'node:fs';
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
const mockedFileStreamManager = vi.mocked(fileStreamManager);

describe('file-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
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

    it('rejects an oversized write body (cap enforced before writeFile)', async () => {
      // The route declares a 5MB MAX_WRITE_SIZE guard, but the app runs with
      // Fastify's default 1MB bodyLimit and sets no override (see server.ts),
      // so any body over 1MB is rejected with 413 before the handler runs.
      // Either way the guarantee holds: an oversized write never reaches writeFile.
      const tooBig = 'a'.repeat(2 * 1024 * 1024);
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
        payload: { path: 'notes.txt', content: tooBig },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBe(413);
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

    it('rejects an oversized create body (cap enforced before writeFile)', async () => {
      // As with PUT save: Fastify's default 1MB bodyLimit preempts the route's
      // 5MB guard, so an oversized body is rejected (413) before writeFile runs.
      const tooBig = 'a'.repeat(2 * 1024 * 1024);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/file-create`,
        payload: { path: 'new.txt', content: tooBig },
      });
      expect(res.statusCode).toBe(413);
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

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
    stat: vi.fn(async () => ({ size: 100, isFile: () => true })),
  },
}));

// Mock realpathSync for symlink resolution
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
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
import { realpathSync } from 'node:fs';
import { fileStreamManager } from '../../src/file-stream-manager.js';

const mockedReaddir = vi.mocked(fs.readdir);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedStat = vi.mocked(fs.stat);
const mockedRealpathSync = vi.mocked(realpathSync);
const mockedFileStreamManager = vi.mocked(fileStreamManager);

describe('file-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    vi.clearAllMocks();

    // Default: realpathSync returns the path unchanged
    mockedRealpathSync.mockImplementation((p: string) => p as never);
    // Default stat
    mockedStat.mockResolvedValue({ size: 100, isFile: () => true } as never);
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
      mockedStat.mockResolvedValue({ size: fileContent.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=src/test.ts`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toBe(fileContent);
      expect(body.data.extension).toBe('ts');
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
});

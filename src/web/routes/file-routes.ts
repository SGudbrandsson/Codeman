/**
 * @fileoverview File browser and streaming routes.
 * Provides directory listing, file content preview, raw file serving, thumbnail generation, and tail streaming.
 */

import { FastifyInstance } from 'fastify';
import { join, resolve, relative, isAbsolute, extname } from 'node:path';
import { realpathSync, existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { fileStreamManager } from '../../file-stream-manager.js';
import { findSessionOrFail } from '../route-helpers.js';
import type { SessionPort } from '../ports/index.js';

/** Thumbnail cache directory */
const THUMB_CACHE_DIR = join(homedir(), '.codeman', 'cache', 'thumbnails');

/** Ensure thumbnail cache directory exists */
if (!existsSync(THUMB_CACHE_DIR)) {
  mkdirSync(THUMB_CACHE_DIR, { recursive: true });
}

/** Generate a cache key for a thumbnail based on path, mtime, and width */
function thumbCacheKey(resolvedPath: string, mtimeMs: number, width: number): string {
  const hash = createHash('sha256').update(`${resolvedPath}:${mtimeMs}:${width}`).digest('hex').slice(0, 16);
  return `${hash}.webp`;
}

export function registerFileRoutes(app: FastifyInstance, ctx: SessionPort): void {
  // File tree listing
  app.get('/api/sessions/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    const { depth, showHidden } = req.query as { depth?: string; showHidden?: string };
    const session = findSessionOrFail(ctx, id);

    const maxDepth = Math.min(parseInt(depth || '5', 10), 10);
    const includeHidden = showHidden === 'true';
    const workingDir = session.workingDir;

    // Default excludes - large/generated directories
    const excludeDirs = new Set([
      '.git',
      'node_modules',
      'dist',
      'build',
      '__pycache__',
      '.cache',
      '.next',
      '.nuxt',
      'coverage',
      '.venv',
      'venv',
      '.tox',
      'target',
      'vendor',
    ]);

    interface FileTreeNode {
      name: string;
      path: string;
      type: 'file' | 'directory';
      size?: number;
      extension?: string;
      children?: FileTreeNode[];
    }

    let totalFiles = 0;
    let totalDirectories = 0;
    let truncated = false;
    const maxFiles = 5000;

    const scanDirectory = async (dirPath: string, currentDepth: number): Promise<FileTreeNode[]> => {
      if (currentDepth > maxDepth || totalFiles + totalDirectories > maxFiles) {
        truncated = true;
        return [];
      }

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const nodes: FileTreeNode[] = [];

        // Sort: directories first, then alphabetically
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
          if (totalFiles + totalDirectories > maxFiles) {
            truncated = true;
            break;
          }

          // Skip hidden files unless requested
          if (!includeHidden && entry.name.startsWith('.')) continue;

          // Skip excluded directories
          if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;

          const fullPath = join(dirPath, entry.name);
          const relativePath = fullPath.slice(workingDir.length + 1);

          if (entry.isDirectory()) {
            totalDirectories++;
            const children = await scanDirectory(fullPath, currentDepth + 1);
            nodes.push({
              name: entry.name,
              path: relativePath,
              type: 'directory',
              children,
            });
          } else {
            totalFiles++;
            const ext = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : undefined;
            let size: number | undefined;
            try {
              const stat = await fs.stat(fullPath);
              size = stat.size;
            } catch {
              // Skip if can't stat
            }
            nodes.push({
              name: entry.name,
              path: relativePath,
              type: 'file',
              size,
              extension: ext,
            });
          }
        }

        return nodes;
      } catch {
        // Can't read directory (permission denied, etc.)
        return [];
      }
    };

    const tree = await scanDirectory(workingDir, 1);

    return {
      success: true,
      data: {
        root: workingDir,
        tree,
        totalFiles,
        totalDirectories,
        truncated,
      },
    };
  });

  // Get file content for preview (File Browser)
  app.get('/api/sessions/:id/file-content', async (req) => {
    const { id } = req.params as { id: string };
    const { path: filePath, lines, raw } = req.query as { path?: string; lines?: string; raw?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter');
    }

    // Validate path is within working directory (security: resolve symlinks to prevent traversal)
    const fullPath = resolve(session.workingDir, filePath);
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(fullPath);
    } catch {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
    }
    const relativePath = relative(session.workingDir, resolvedPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path must be within working directory');
    }

    try {
      const stat = await fs.stat(resolvedPath);

      // Check if it's a binary/media file
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const binaryExts = new Set([
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'ico',
        'svg',
        'bmp',
        'mp4',
        'webm',
        'mov',
        'avi',
        'mp3',
        'wav',
        'ogg',
        'pdf',
        'zip',
        'tar',
        'gz',
        'exe',
        'dll',
        'so',
        'woff',
        'woff2',
        'ttf',
        'eot',
      ]);
      const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
      const videoExts = new Set(['mp4', 'webm', 'mov', 'avi']);

      if (raw === 'true' || binaryExts.has(ext)) {
        // Return metadata for binary files
        return {
          success: true,
          data: {
            path: filePath,
            size: stat.size,
            type: imageExts.has(ext) ? 'image' : videoExts.has(ext) ? 'video' : 'binary',
            extension: ext,
            url: `/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`,
          },
        };
      }

      // Validate file size before reading (DoS protection - prevent memory exhaustion)
      const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024; // 10MB
      if (stat.size > MAX_TEXT_FILE_SIZE) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB limit)`
        );
      }

      // Read text file with line limit (bounded to prevent DoS)
      const MAX_LINES_LIMIT = 10000;
      const maxLines = Math.min(parseInt(lines || '500', 10) || 500, MAX_LINES_LIMIT);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const allLines = content.split('\n');
      const truncatedContent = allLines.length > maxLines;
      const displayContent = truncatedContent ? allLines.slice(0, maxLines).join('\n') : content;

      return {
        success: true,
        data: {
          path: filePath,
          content: displayContent,
          size: stat.size,
          totalLines: allLines.length,
          truncated: truncatedContent,
          extension: ext,
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`);
    }
  });

  // Serve raw file content (for images/binary files)
  app.get('/api/sessions/:id/file-raw', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath } = req.query as { path?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    // Validate path is within working directory (security: resolve symlinks to prevent traversal)
    const fullPath = resolve(session.workingDir, filePath);
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(fullPath);
    } catch {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const relativePath = relative(session.workingDir, resolvedPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path must be within working directory'));
      return;
    }

    try {
      // Validate file size before reading (DoS protection - prevent memory exhaustion)
      const MAX_RAW_FILE_SIZE = 50 * 1024 * 1024; // 50MB for raw files
      const stat = await fs.stat(resolvedPath);
      if (stat.size > MAX_RAW_FILE_SIZE) {
        reply
          .code(400)
          .send(
            createErrorResponse(
              ApiErrorCode.INVALID_INPUT,
              `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_RAW_FILE_SIZE / 1024 / 1024}MB limit)`
            )
          );
        return;
      }

      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        ico: 'image/x-icon',
        bmp: 'image/bmp',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        pdf: 'application/pdf',
        json: 'application/json',
      };

      const content = await fs.readFile(resolvedPath);
      reply.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      reply.send(content);
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  // Stream file content via tail -f (SSE endpoint)
  app.get('/api/sessions/:id/tail-file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath, lines } = req.query as { path?: string; lines?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    // Set up SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Track stream for cleanup
    const streamRef: { id?: string } = {};

    // Create the file stream
    const result = await fileStreamManager.createStream({
      sessionId: id,
      filePath,
      workingDir: session.workingDir,
      lines: lines ? parseInt(lines, 10) : undefined,
      onData: (data) => {
        // Send data as SSE event
        reply.raw.write(`data: ${JSON.stringify({ type: 'data', content: data })}\n\n`);
      },
      onEnd: () => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
        reply.raw.end();
      },
      onError: (error) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
      },
    });

    if (!result.success) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: result.error })}\n\n`);
      reply.raw.end();
      return;
    }

    streamRef.id = result.streamId;

    // Notify client of successful connection
    reply.raw.write(`data: ${JSON.stringify({ type: 'connected', streamId: result.streamId, filePath })}\n\n`);

    // Handle client disconnect
    req.raw.on('close', () => {
      if (streamRef.id) {
        fileStreamManager.closeStream(streamRef.id);
      }
    });
  });

  // Close a file stream
  app.delete('/api/sessions/:id/tail-file/:streamId', async (req) => {
    const { id, streamId } = req.params as { id: string; streamId: string };
    findSessionOrFail(ctx, id); // Validates session exists
    const closed = fileStreamManager.closeStream(streamId);
    return { success: closed };
  });

  // Serve image files for inline chat preview (session-agnostic)
  const imageMimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  const allowedImageExts = new Set(Object.keys(imageMimeTypes));
  const homeDir = homedir();

  app.get('/api/files/preview', async (req, reply) => {
    const { path: rawPath } = req.query as { path?: string };

    if (!rawPath || !isAbsolute(rawPath)) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing or non-absolute path parameter'));
      return;
    }

    // Check extension before touching the filesystem
    const ext = extname(rawPath).slice(1).toLowerCase();
    if (!allowedImageExts.has(ext)) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Not an image file'));
      return;
    }

    // Resolve symlinks to prevent traversal
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(rawPath);
    } catch {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }

    const resolvedExt = extname(resolvedPath).slice(1).toLowerCase();
    if (!allowedImageExts.has(resolvedExt)) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Not an image file'));
      return;
    }

    // Security allowlist: /tmp or user home directory
    const inTmp = resolvedPath.startsWith('/tmp/') || resolvedPath === '/tmp';
    const inHome = resolvedPath.startsWith(homeDir + '/') || resolvedPath === homeDir;
    if (!inTmp && !inHome) {
      reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path outside allowed directories'));
      return;
    }

    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Not a regular file'));
        return;
      }

      const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB
      if (stat.size > MAX_IMAGE_SIZE) {
        reply
          .code(400)
          .send(
            createErrorResponse(
              ApiErrorCode.INVALID_INPUT,
              `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_IMAGE_SIZE / 1024 / 1024}MB limit)`
            )
          );
        return;
      }

      const content = await fs.readFile(resolvedPath);
      reply.header('Content-Type', imageMimeTypes[resolvedExt] || 'application/octet-stream');
      reply.header('Cache-Control', 'private, max-age=60');
      reply.send(content);
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  // Serve resized thumbnail (sharp-based, cached to disk)
  // Supported formats: png, jpg, jpeg, gif, webp. SVGs pass through as-is.
  const thumbImageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

  app.get('/api/files/thumbnail', async (req, reply) => {
    const { path: rawPath, width: rawWidth } = req.query as { path?: string; width?: string };

    if (!rawPath || !isAbsolute(rawPath)) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing or non-absolute path parameter'));
      return;
    }

    const ext = extname(rawPath).slice(1).toLowerCase();
    if (!thumbImageExts.has(ext)) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Not an image file'));
      return;
    }

    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(rawPath);
    } catch {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }

    // Security allowlist: /tmp or user home directory
    const inTmp = resolvedPath.startsWith('/tmp/') || resolvedPath === '/tmp';
    const inHome = resolvedPath.startsWith(homeDir + '/') || resolvedPath === homeDir;
    if (!inTmp && !inHome) {
      reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path outside allowed directories'));
      return;
    }

    // SVGs are already tiny — serve as-is
    if (ext === 'svg') {
      try {
        const content = await fs.readFile(resolvedPath);
        reply.header('Content-Type', 'image/svg+xml');
        reply.header('Cache-Control', 'private, max-age=300');
        reply.send(content);
      } catch (err) {
        reply
          .code(500)
          .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
      }
      return;
    }

    const width = Math.min(Math.max(parseInt(rawWidth || '240', 10) || 240, 32), 800);

    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Not a regular file'));
        return;
      }

      const MAX_THUMB_SOURCE = 50 * 1024 * 1024; // 50MB
      if (stat.size > MAX_THUMB_SOURCE) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Source file too large'));
        return;
      }

      // Check cache
      const cacheFile = join(THUMB_CACHE_DIR, thumbCacheKey(resolvedPath, stat.mtimeMs, width));
      try {
        const cached = await fs.readFile(cacheFile);
        reply.header('Content-Type', 'image/webp');
        reply.header('Cache-Control', 'private, max-age=300');
        reply.send(cached);
        return;
      } catch {
        // Cache miss — generate thumbnail
      }

      const thumbnail = await sharp(resolvedPath)
        .resize(width, undefined, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      // Write cache file (fire-and-forget)
      fs.writeFile(cacheFile, thumbnail).catch(() => {});

      reply.header('Content-Type', 'image/webp');
      reply.header('Cache-Control', 'private, max-age=300');
      reply.send(thumbnail);
    } catch (err) {
      reply
        .code(500)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to generate thumbnail: ${getErrorMessage(err)}`)
        );
    }
  });

  // Session-scoped thumbnail (for file browser images)
  app.get('/api/sessions/:id/file-thumbnail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath, width: rawWidth } = req.query as { path?: string; width?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    const fullPath = resolve(session.workingDir, filePath);
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(fullPath);
    } catch {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const relativePath = relative(session.workingDir, resolvedPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path must be within working directory'));
      return;
    }

    const ext = extname(resolvedPath).slice(1).toLowerCase();
    if (!thumbImageExts.has(ext)) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Not an image file'));
      return;
    }

    // SVGs pass through
    if (ext === 'svg') {
      try {
        const content = await fs.readFile(resolvedPath);
        reply.header('Content-Type', 'image/svg+xml');
        reply.header('Cache-Control', 'private, max-age=300');
        reply.send(content);
      } catch (err) {
        reply
          .code(500)
          .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
      }
      return;
    }

    const width = Math.min(Math.max(parseInt(rawWidth || '400', 10) || 400, 32), 800);

    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Not a regular file'));
        return;
      }

      const MAX_THUMB_SOURCE = 50 * 1024 * 1024;
      if (stat.size > MAX_THUMB_SOURCE) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Source file too large'));
        return;
      }

      const cacheFile = join(THUMB_CACHE_DIR, thumbCacheKey(resolvedPath, stat.mtimeMs, width));
      try {
        const cached = await fs.readFile(cacheFile);
        reply.header('Content-Type', 'image/webp');
        reply.header('Cache-Control', 'private, max-age=300');
        reply.send(cached);
        return;
      } catch {
        // Cache miss
      }

      const thumbnail = await sharp(resolvedPath)
        .resize(width, undefined, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      fs.writeFile(cacheFile, thumbnail).catch(() => {});

      reply.header('Content-Type', 'image/webp');
      reply.header('Cache-Control', 'private, max-age=300');
      reply.send(thumbnail);
    } catch (err) {
      reply
        .code(500)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to generate thumbnail: ${getErrorMessage(err)}`)
        );
    }
  });
}

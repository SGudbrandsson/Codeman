/**
 * @fileoverview File browser and streaming routes.
 * Provides directory listing, file content preview, raw file serving, thumbnail generation, and tail streaming.
 */

import { FastifyInstance } from 'fastify';
import { join, resolve, relative, isAbsolute, extname, dirname, basename } from 'node:path';
import { realpathSync, statSync, existsSync, mkdirSync } from 'node:fs';
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
  // File tree listing (breadth-first, level-by-level, with per-directory lazy loading)
  app.get('/api/sessions/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    const {
      depth,
      showHidden,
      path: requestedPath,
    } = req.query as { depth?: string; showHidden?: string; path?: string };
    const session = findSessionOrFail(ctx, id);

    const parsedDepth = parseInt(depth || '5', 10);
    const maxDepth = Math.min(Number.isFinite(parsedDepth) && parsedDepth > 0 ? parsedDepth : 5, 10);
    const includeHidden = showHidden === 'true';
    const workingDir = session.workingDir;

    // Resolve the subtree root. `path` is relative to workingDir; empty/omitted means the root.
    // Same containment idiom used by the sibling read/write routes in this file.
    let startDir = workingDir;
    let startRelative = '';
    if (requestedPath) {
      const fullPath = resolve(workingDir, requestedPath);
      let resolvedPath: string;
      try {
        resolvedPath = realpathSync(fullPath);
      } catch {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Directory not found');
      }
      const relativePath = relative(workingDir, resolvedPath);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path must be within working directory');
      }
      // A non-directory target would otherwise fall through and return an empty
      // tree with success:true (the readdir failure is swallowed further down).
      try {
        if (!statSync(resolvedPath).isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Directory not found');
      }
      startDir = resolvedPath;
      startRelative = relativePath;
    }

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
      /** Directories only: false when children were not (fully) fetched yet. */
      childrenLoaded?: boolean;
      /** Directories only: whether the directory has at least one visible entry. */
      hasChildren?: boolean;
      /** Directories only: number of children omitted because the entry budget ran out. */
      remainingChildren?: number;
      /** Directories only: set when the directory could not be read (e.g. EACCES). */
      error?: string;
    }

    let totalFiles = 0;
    let totalDirectories = 0;
    let truncated = false;
    const maxFiles = 5000;

    const isVisible = (entry: { name: string; isDirectory(): boolean }): boolean => {
      if (!includeHidden && entry.name.startsWith('.')) return false;
      if (entry.isDirectory() && excludeDirs.has(entry.name)) return false;
      return true;
    };

    /** Read a directory, filtered and sorted (directories first, then alphabetically). */
    const listDir = async (dirPath: string) => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const visible = entries.filter(isVisible);
      visible.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
      return visible;
    };

    /** Short, path-free label for a directory that could not be read (e.g. "EACCES"). */
    const readErrorLabel = (err: unknown): string => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      return code ? `Cannot read directory (${code})` : 'Cannot read directory';
    };

    /** Cheap probe so unfetched directories still render a correct chevron. */
    const probeHasChildren = async (dirPath: string): Promise<{ hasChildren: boolean; error?: string }> => {
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        return { hasChildren: entries.some(isVisible) };
      } catch (err) {
        // Unreadable at the depth frontier is the SAME third state as an unreadable
        // directory mid-walk - never fold it back into "empty", or the chevron would
        // disappear and the folder would be silently un-expandable.
        return { hasChildren: true, error: readErrorLabel(err) };
      }
    };

    interface PendingDir {
      /** The node whose children we still have to fill (null for the requested root). */
      node: FileTreeNode | null;
      dirPath: string;
      /** Depth of the CHILDREN produced from this directory. */
      depth: number;
      out: FileTreeNode[];
    }

    const tree: FileTreeNode[] = [];
    let rootRemaining = 0;
    let rootError: string | null = null;
    let level: PendingDir[] = [{ node: null, dirPath: startDir, depth: 1, out: tree }];

    // Breadth-first: finish an entire level before descending. The entry budget can then only
    // ever truncate the deepest frontier - shallow siblings (notably root-level files, which
    // sort last) can no longer be starved by a large subtree.
    while (level.length > 0) {
      const nextLevel: PendingDir[] = [];

      for (const pending of level) {
        // Budget already spent: mark this directory as not-yet-loaded rather than empty.
        if (totalFiles + totalDirectories >= maxFiles) {
          truncated = true;
          if (pending.node) {
            pending.node.childrenLoaded = false;
            pending.node.hasChildren = true;
          }
          continue;
        }

        let entries;
        try {
          entries = await listDir(pending.dirPath);
        } catch (err) {
          // Can't read the directory (permission denied, vanished mid-walk, ...).
          // This is a THIRD state, distinct from both "empty" and "not fetched":
          // never fold it back into an empty `children: []`.
          if (pending.node) {
            pending.node.childrenLoaded = false;
            pending.node.hasChildren = true;
            pending.node.error = readErrorLabel(err);
          } else {
            // The requested subtree root itself is unreadable - that is an error
            // for the whole request, not an empty success.
            rootError = readErrorLabel(err);
          }
          continue;
        }

        let index = 0;
        for (; index < entries.length; index++) {
          if (totalFiles + totalDirectories >= maxFiles) break;

          const entry = entries[index];
          const fullPath = join(pending.dirPath, entry.name);
          const childRelative = pending.node
            ? join(pending.node.path, entry.name)
            : startRelative
              ? join(startRelative, entry.name)
              : entry.name;

          if (entry.isDirectory()) {
            totalDirectories++;
            const dirNode: FileTreeNode = {
              name: entry.name,
              path: childRelative,
              type: 'directory',
              children: [],
              childrenLoaded: false,
              hasChildren: true,
            };
            pending.out.push(dirNode);
            if (pending.depth + 1 <= maxDepth) {
              nextLevel.push({
                node: dirNode,
                dirPath: fullPath,
                depth: pending.depth + 1,
                out: dirNode.children as FileTreeNode[],
              });
            } else {
              // Depth frontier: children are not fetched, but say whether there are any.
              truncated = true;
              const probe = await probeHasChildren(fullPath);
              dirNode.hasChildren = probe.hasChildren;
              if (probe.error) dirNode.error = probe.error;
            }
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
            pending.out.push({
              name: entry.name,
              path: childRelative,
              type: 'file',
              size,
              extension: ext,
            });
          }
        }

        const remaining = entries.length - index;
        if (pending.node) {
          pending.node.childrenLoaded = remaining === 0;
          pending.node.hasChildren = entries.length > 0;
        }
        if (remaining > 0) {
          truncated = true;
          if (pending.node) pending.node.remainingChildren = remaining;
          else rootRemaining = remaining;
        }
      }

      level = nextLevel;
    }

    if (rootError) {
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, rootError);
    }

    return {
      success: true,
      data: {
        root: workingDir,
        path: startRelative,
        depth: maxDepth,
        remainingChildren: rootRemaining,
        tree,
        totalFiles,
        totalDirectories,
        // Kept for compatibility. Per-node `childrenLoaded` is the load-bearing signal now:
        // this flag is true merely by reaching the depth frontier.
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
          mtime: stat.mtimeMs,
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`);
    }
  });

  // Serve raw file content (for images/binary files)
  app.get('/api/sessions/:id/file-raw', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath, download } = req.query as { path?: string; download?: string };
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
      // ?download=1 forces a save instead of an in-browser preview. The <a download>
      // attribute alone is unreliable on iOS Safari, and text/PDF/image types would
      // otherwise open in a tab. Quotes and control chars are stripped from the
      // filename so they cannot break out of the header value.
      if (download === '1' || download === 'true') {
        const safeName = basename(resolvedPath).replace(/["\\\r\n]/g, '_');
        reply.header(
          'Content-Disposition',
          `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
        );
      }
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

  // ---------------------------------------------------------------------------
  // Write routes (mobile file explorer): save content, create file, mkdir, delete.
  // SECRETS SAFETY: never log request bodies or file content; never interpolate
  // file content into error messages/SSE; never echo saved content back.
  // ---------------------------------------------------------------------------

  /** Max size for a single write (bytes). Reads allow 10MB; writes are capped tighter. */
  const MAX_WRITE_SIZE = 5 * 1024 * 1024; // 5MB

  // Save (overwrite) an existing file's content, with best-effort staleness guard.
  app.put('/api/sessions/:id/file-content', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    const body = (req.body ?? {}) as { path?: string; content?: string; expectedMtime?: number };
    const filePath = body.path;
    const content = body.content;

    if (!filePath || typeof filePath !== 'string') {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }
    if (typeof content !== 'string') {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing content parameter'));
      return;
    }
    const byteLength = Buffer.byteLength(content, 'utf-8');
    if (byteLength > MAX_WRITE_SIZE) {
      reply
        .code(400)
        .send(
          createErrorResponse(
            ApiErrorCode.INVALID_INPUT,
            `Content too large (${Math.round(byteLength / 1024 / 1024)}MB > ${MAX_WRITE_SIZE / 1024 / 1024}MB limit)`
          )
        );
      return;
    }

    // Sandbox: target must already exist (existing-target pattern, mirrors file-content).
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
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path is not a regular file'));
        return;
      }
      // Best-effort staleness guard: if caller supplied the mtime it read, and the
      // file changed since, reject so the UI can offer Reload / Overwrite.
      if (typeof body.expectedMtime === 'number' && Math.abs(stat.mtimeMs - body.expectedMtime) > 0.5) {
        reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, 'File was modified since it was loaded'));
        return;
      }

      await fs.writeFile(resolvedPath, content, 'utf-8');
      const newStat = await fs.stat(resolvedPath);
      return { success: true, data: { path: relativePath, size: newStat.size, mtime: newStat.mtimeMs } };
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to save file: ${getErrorMessage(err)}`));
      return;
    }
  });

  // Create a new file (optionally with initial content). Parent-dir sandbox.
  app.post('/api/sessions/:id/file-create', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    const body = (req.body ?? {}) as { path?: string; content?: string };
    const relPath = body.path;
    const content = typeof body.content === 'string' ? body.content : '';

    if (!relPath || typeof relPath !== 'string') {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }
    const byteLength = Buffer.byteLength(content, 'utf-8');
    if (byteLength > MAX_WRITE_SIZE) {
      reply
        .code(400)
        .send(
          createErrorResponse(
            ApiErrorCode.INVALID_INPUT,
            `Content too large (${Math.round(byteLength / 1024 / 1024)}MB > ${MAX_WRITE_SIZE / 1024 / 1024}MB limit)`
          )
        );
      return;
    }

    const target = resolveNewChild(session.workingDir, relPath, reply);
    if (!target) return; // reply already sent

    try {
      if (existsSync(target)) {
        reply
          .code(409)
          .send(createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'A file or folder with that name already exists'));
        return;
      }
      await fs.writeFile(target, content, { encoding: 'utf-8', flag: 'wx' });
      const newStat = await fs.stat(target);
      const rel = relative(session.workingDir, target);
      return { success: true, data: { path: rel, size: newStat.size, mtime: newStat.mtimeMs } };
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create file: ${getErrorMessage(err)}`));
      return;
    }
  });

  // Create a new directory. Parent-dir sandbox.
  app.post('/api/sessions/:id/dir-create', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    const body = (req.body ?? {}) as { path?: string };
    const relPath = body.path;

    if (!relPath || typeof relPath !== 'string') {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    const target = resolveNewChild(session.workingDir, relPath, reply);
    if (!target) return; // reply already sent

    try {
      if (existsSync(target)) {
        reply
          .code(409)
          .send(createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'A file or folder with that name already exists'));
        return;
      }
      await fs.mkdir(target);
      const newStat = await fs.stat(target);
      const rel = relative(session.workingDir, target);
      return { success: true, data: { path: rel, mtime: newStat.mtimeMs } };
    } catch (err) {
      reply
        .code(500)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create directory: ${getErrorMessage(err)}`)
        );
      return;
    }
  });

  // Delete an existing file or directory. Recursive dir delete requires an explicit flag.
  app.delete('/api/sessions/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    // Accept params from body (DELETE with JSON) or query string.
    const body = (req.body ?? {}) as { path?: string; recursive?: boolean; confirm?: boolean };
    const query = req.query as { path?: string; recursive?: string; confirm?: string };
    const filePath = body.path ?? query.path;
    const recursive =
      body.recursive === true || body.confirm === true || query.recursive === 'true' || query.confirm === 'true';

    if (!filePath || typeof filePath !== 'string') {
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
    // Never delete the working directory root itself.
    if (relativePath === '' || resolvedPath === realpathSync(session.workingDir)) {
      reply
        .code(400)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Refusing to delete the working directory root'));
      return;
    }

    try {
      const stat = await fs.stat(resolvedPath);
      if (stat.isDirectory()) {
        // Require explicit confirmation for recursive directory removal.
        const entries = await fs.readdir(resolvedPath);
        if (entries.length > 0 && !recursive) {
          reply
            .code(400)
            .send(
              createErrorResponse(
                ApiErrorCode.INVALID_INPUT,
                'Directory is not empty; recursive delete requires explicit confirmation'
              )
            );
          return;
        }
        await fs.rm(resolvedPath, { recursive: true, force: false });
      } else {
        await fs.unlink(resolvedPath);
      }
      return { success: true, data: { path: relativePath } };
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to delete: ${getErrorMessage(err)}`));
      return;
    }
  });
}

/**
 * Sandbox helper for CREATE routes (new file / mkdir): the target does not exist
 * yet, so we resolve+validate the PARENT directory (whose realpath exists), reject
 * unsafe basenames, and return the final absolute path. On rejection it sends the
 * HTTP error via `reply` and returns null.
 */
function resolveNewChild(workingDir: string, relPath: string, reply: import('fastify').FastifyReply): string | null {
  const fullPath = resolve(workingDir, relPath);
  const base = basename(fullPath);
  // Reject unsafe basenames.
  if (!base || base === '.' || base === '..' || base.includes('/') || base.includes('\\')) {
    reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid file or folder name'));
    return null;
  }
  const parent = dirname(fullPath);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Parent directory not found'));
    return null;
  }
  const relParent = relative(workingDir, realParent);
  if (relParent.startsWith('..') || isAbsolute(relParent)) {
    reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path must be within working directory'));
    return null;
  }
  return join(realParent, base);
}

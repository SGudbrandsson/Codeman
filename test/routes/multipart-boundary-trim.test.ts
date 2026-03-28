/**
 * @fileoverview Tests for multipart boundary .trim() fix in system-routes.ts
 *
 * Verifies that POST /api/screenshots and POST /api/sessions/:id/upload
 * correctly handle Content-Type headers where the boundary value has
 * trailing whitespace or CRLF (as sent by some browsers/environments).
 *
 * Uses app.inject() — no real HTTP ports needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('../../src/subagent-watcher.js', () => ({
  subagentWatcher: {
    getSubagents: vi.fn(() => []),
    getRecentSubagents: vi.fn(() => []),
    getSubagentsForSession: vi.fn(() => []),
    getSubagent: vi.fn(() => null),
    getTranscript: vi.fn(async () => []),
    formatTranscript: vi.fn(() => ''),
    killSubagent: vi.fn(async () => false),
    cleanupNow: vi.fn(() => 0),
    clearAll: vi.fn(() => 0),
    getStats: vi.fn(() => ({
      totalAgents: 0,
      activeAgents: 0,
      fileDebouncerCount: 0,
      dirWatcherCount: 0,
      idleTimerCount: 0,
    })),
    isRunning: vi.fn(() => true),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../../src/image-watcher.js', () => ({
  imageWatcher: {
    isRunning: vi.fn(() => false),
    start: vi.fn(),
    stop: vi.fn(),
    watchSession: vi.fn(),
  },
}));

vi.mock('../../src/session-lifecycle-log.js', () => ({
  getLifecycleLog: vi.fn(() => ({
    log: vi.fn(),
    query: vi.fn(async () => []),
  })),
}));

vi.mock('../../src/utils/opencode-cli-resolver.js', () => ({
  isOpenCodeAvailable: vi.fn(() => false),
  resolveOpenCodeDir: vi.fn(() => null),
}));

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

const mockedExistsSync = vi.mocked(existsSync);
const mockedWriteFile = vi.mocked(fs.writeFile);

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Build a multipart/form-data body with a given boundary string.
 * The boundary in the body does NOT include leading `--` (that's added in the body parts).
 * Returns the raw body and the Content-Type header value.
 */
function buildMultipartWithBoundary(filename: string, content: Buffer, boundary: string, contentTypeOverride?: string) {
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([header, content, footer]),
    contentType: contentTypeOverride ?? `multipart/form-data; boundary=${boundary}`,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Multipart boundary .trim() fix', () => {
  // Both endpoints need a dedicated harness with the multipart content-type parser
  let harness: RouteTestHarness;

  beforeEach(async () => {
    const Fastify = (await import('fastify')).default;
    const fastifyCookie = (await import('@fastify/cookie')).default;
    const { createMockRouteContext } = await import('../mocks/index.js');

    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    app.addContentTypeParser('multipart/form-data', (_req: unknown, _payload: unknown, done: (err: null) => void) => {
      done(null);
    });
    const ctx = createMockRouteContext();
    registerSystemRoutes(app, ctx as never);
    await app.ready();
    harness = { app, ctx };

    mockedExistsSync.mockReturnValue(false);
    mockedWriteFile.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ────── POST /api/screenshots ──────

  describe('POST /api/screenshots — boundary with trailing whitespace', () => {
    it('succeeds when boundary has trailing spaces', async () => {
      const boundary = 'TestBoundary123';
      const { body } = buildMultipartWithBoundary('image.png', Buffer.from('png-data'), boundary);
      // Content-Type header has trailing spaces after the boundary value
      const contentType = `multipart/form-data; boundary=${boundary}   `;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/screenshots',
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
      expect(data.path).toBeDefined();
    });

    it('succeeds when boundary has trailing tab characters', async () => {
      const boundary = 'TestBoundary456';
      const { body } = buildMultipartWithBoundary('image.jpg', Buffer.from('jpg-data'), boundary);
      // Some HTTP clients/proxies leave trailing whitespace on Content-Type header
      const contentType = `multipart/form-data; boundary=${boundary}\t\t`;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/screenshots',
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
    });

    it('succeeds with clean boundary (baseline)', async () => {
      const boundary = 'CleanBoundary789';
      const { body, contentType } = buildMultipartWithBoundary('image.png', Buffer.from('data'), boundary);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/screenshots',
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
    });
  });

  // ────── POST /api/sessions/:id/upload ──────

  describe('POST /api/sessions/:id/upload — boundary with trailing whitespace', () => {
    it('succeeds when boundary has trailing spaces', async () => {
      const boundary = 'UploadBoundary123';
      const { body } = buildMultipartWithBoundary('doc.pdf', Buffer.from('pdf-data'), boundary);
      const contentType = `multipart/form-data; boundary=${boundary}   `;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/upload`,
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
      expect(data.filename).toBe('doc.pdf');
    });

    it('succeeds when boundary has trailing tab characters', async () => {
      const boundary = 'UploadBoundary456';
      const { body } = buildMultipartWithBoundary('report.txt', Buffer.from('text-data'), boundary);
      const contentType = `multipart/form-data; boundary=${boundary}\t\t`;

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/upload`,
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
    });

    it('succeeds with clean boundary (baseline)', async () => {
      const boundary = 'CleanUploadBoundary';
      const { body, contentType } = buildMultipartWithBoundary('notes.md', Buffer.from('md-data'), boundary);

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/upload`,
        headers: { 'content-type': contentType },
        body,
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
    });
  });
});

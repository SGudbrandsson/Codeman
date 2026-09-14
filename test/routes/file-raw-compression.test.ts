/**
 * @fileoverview Byte-exact file serving under @fastify/compress.
 *
 * Regression for the "Download gives a 0-byte file" bug: file-raw (and the image
 * preview/thumbnail routes) used `reply.send(buf)` without returning it from an
 * async handler. With @fastify/compress registered, onSend swaps the Buffer for a
 * brotli/gzip stream, and the handler resolving `undefined` ended the reply with
 * an empty body.
 *
 * test/routes/file-routes.test.ts mocks node:fs and never registers compression,
 * so it cannot catch this. Here a real temp directory and a Fastify instance that
 * registers @fastify/compress exactly like src/web/server.ts (threshold 1024) are
 * used, and bodies are decompressed with node:zlib and compared byte-for-byte.
 *
 * Uses app.inject() — no real HTTP ports needed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createMockRouteContext } from '../mocks/index.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

const ENCODINGS = ['br', 'gzip'] as const;

/** Repetitive (compressible) payload well over the 1024-byte threshold. */
function payload(seed: string, size = 16 * 1024): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = seed.charCodeAt(i % seed.length) ^ (i % 7);
  return out;
}

function decode(res: { rawPayload: Buffer; headers: Record<string, unknown> }): Buffer {
  const enc = res.headers['content-encoding'];
  if (enc === 'br') return brotliDecompressSync(res.rawPayload);
  if (enc === 'gzip') return gunzipSync(res.rawPayload);
  return res.rawPayload;
}

describe('file serving under @fastify/compress', () => {
  let app: FastifyInstance;
  let dir: string;
  let sessionId: string;
  const files: Record<string, Buffer> = {};

  beforeAll(async () => {
    // realpath so the /tmp allowlist in preview/thumbnail sees the resolved path.
    dir = realpathSync(mkdtempSync('/tmp/codeman-file-raw-compress-'));
    files['report.docx'] = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), payload('word/document.xml')]);
    files['blob.bin'] = payload('\x00\xff\x80binary');
    files['data.json'] = Buffer.from(JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ i })) }));
    files['logo.svg'] = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1"/>'.repeat(200)}</svg>`
    );
    for (const [name, buf] of Object.entries(files)) writeFileSync(join(dir, name), buf);

    app = Fastify({ logger: false });
    await app.register(fastifyCompress, { threshold: 1024 });
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
  });

  describe('GET /api/sessions/:id/file-raw', () => {
    for (const encoding of ENCODINGS) {
      for (const name of ['report.docx', 'blob.bin', 'data.json']) {
        for (const download of [false, true]) {
          it(`returns the full original bytes of ${name} with accept-encoding ${encoding}${download ? ' and download=1' : ''}`, async () => {
            const res = await app.inject({
              method: 'GET',
              url: `/api/sessions/${sessionId}/file-raw?path=${name}${download ? '&download=1' : ''}`,
              headers: { 'accept-encoding': encoding },
            });
            expect(res.statusCode).toBe(200);
            expect(res.rawPayload.length).toBeGreaterThan(0);
            const body = decode(res);
            expect(body.length).toBe(files[name].length);
            expect(body.equals(files[name])).toBe(true);
          });
        }
      }

      it(`actually compresses a compressible response with ${encoding} (exercises the onSend stream swap)`, async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}/file-raw?path=data.json`,
          headers: { 'accept-encoding': encoding },
        });
        expect(res.headers['content-encoding']).toBe(encoding);
        expect(decode(res).equals(files['data.json'])).toBe(true);
      });
    }

    it('serves a docx download with the Word MIME type and an attachment disposition', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/file-raw?path=report.docx&download=1`,
        headers: { 'accept-encoding': 'gzip, deflate, br' },
      });
      expect(res.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="report.docx"; filename*=UTF-8''report.docx`
      );
      expect(decode(res).equals(files['report.docx'])).toBe(true);
    });
  });

  describe('SVG image routes', () => {
    it.each(ENCODINGS)('GET /api/files/preview returns the full svg with accept-encoding %s', async (encoding) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/files/preview?path=${encodeURIComponent(join(dir, 'logo.svg'))}`,
        headers: { 'accept-encoding': encoding },
      });
      expect(res.statusCode).toBe(200);
      expect(decode(res).equals(files['logo.svg'])).toBe(true);
    });

    it.each(ENCODINGS)('GET /api/files/thumbnail returns the full svg with accept-encoding %s', async (encoding) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/files/thumbnail?path=${encodeURIComponent(join(dir, 'logo.svg'))}`,
        headers: { 'accept-encoding': encoding },
      });
      expect(res.statusCode).toBe(200);
      expect(decode(res).equals(files['logo.svg'])).toBe(true);
    });

    it.each(ENCODINGS)(
      'GET /api/sessions/:id/file-thumbnail returns the full svg with accept-encoding %s',
      async (encoding) => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/sessions/${sessionId}/file-thumbnail?path=logo.svg`,
          headers: { 'accept-encoding': encoding },
        });
        expect(res.statusCode).toBe(200);
        expect(decode(res).equals(files['logo.svg'])).toBe(true);
      }
    );
  });
});

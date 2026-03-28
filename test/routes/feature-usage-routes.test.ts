/**
 * @fileoverview Tests for feature-usage-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * Mocks: node:fs to avoid touching the real ~/.codeman/feature-usage.json.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mocks ──────────────────────────────────────────────────────────

let fakeFileContent: string | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn((...args: unknown[]) => {
        const filePath = args[0] as string;
        if (filePath.includes('feature-usage.json')) {
          if (fakeFileContent === null) throw new Error('ENOENT');
          return fakeFileContent;
        }
        return actual.readFileSync(filePath as string, args[1] as string);
      }),
      writeFileSync: vi.fn((...args: unknown[]) => {
        const filePath = args[0] as string;
        if (filePath.includes('feature-usage.json')) {
          fakeFileContent = args[1] as string;
          return;
        }
        return actual.writeFileSync(filePath as string, args[1] as string);
      }),
      existsSync: vi.fn((...args: unknown[]) => {
        const filePath = args[0] as string;
        if (filePath.includes('feature-usage.json')) {
          return fakeFileContent !== null;
        }
        // For the directory check in writeUsageData
        if (filePath.includes('.codeman')) return true;
        return actual.existsSync(filePath as string);
      }),
      unlinkSync: vi.fn((...args: unknown[]) => {
        const filePath = args[0] as string;
        if (filePath.includes('feature-usage.json')) {
          fakeFileContent = null;
          return;
        }
        return actual.unlinkSync(filePath as string);
      }),
      mkdirSync: vi.fn(),
    },
  };
});

import { registerFeatureUsageRoutes } from '../../src/web/routes/feature-usage-routes.js';

describe('feature-usage-routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    fakeFileContent = null;
    app = Fastify({ logger: false });
    registerFeatureUsageRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ========== GET /api/feature-usage ==========

  describe('GET /api/feature-usage', () => {
    it('returns empty data when no usage has been tracked', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/feature-usage',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({});
    });
  });

  // ========== POST /api/feature-usage/track ==========

  describe('POST /api/feature-usage/track', () => {
    it('returns 400 when featureId is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/feature-usage/track',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('featureId');
    });

    it('returns 400 when featureId exceeds 200 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/feature-usage/track',
        payload: { featureId: 'x'.repeat(201) },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('maximum length');
    });

    it('creates a new entry with count 1 on first track', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/feature-usage/track',
        payload: { featureId: 'test-feature', timestamp: '2026-01-01T00:00:00.000Z' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);

      // Verify stored data
      const stored = JSON.parse(fakeFileContent!);
      expect(stored['test-feature'].count).toBe(1);
      expect(stored['test-feature'].firstUsed).toBe('2026-01-01T00:00:00.000Z');
      expect(stored['test-feature'].lastUsed).toBe('2026-01-01T00:00:00.000Z');
    });

    it('increments count on subsequent track', async () => {
      // First track
      await app.inject({
        method: 'POST',
        url: '/api/feature-usage/track',
        payload: { featureId: 'counter-feature', timestamp: '2026-01-01T00:00:00.000Z' },
      });
      // Second track
      await app.inject({
        method: 'POST',
        url: '/api/feature-usage/track',
        payload: { featureId: 'counter-feature', timestamp: '2026-01-02T00:00:00.000Z' },
      });

      const stored = JSON.parse(fakeFileContent!);
      expect(stored['counter-feature'].count).toBe(2);
      expect(stored['counter-feature'].lastUsed).toBe('2026-01-02T00:00:00.000Z');
    });

    it('preserves firstUsed on subsequent track', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/feature-usage/track',
        payload: { featureId: 'stable-feature', timestamp: '2026-01-01T00:00:00.000Z' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/feature-usage/track',
        payload: { featureId: 'stable-feature', timestamp: '2026-06-15T12:00:00.000Z' },
      });

      const stored = JSON.parse(fakeFileContent!);
      expect(stored['stable-feature'].firstUsed).toBe('2026-01-01T00:00:00.000Z');
      expect(stored['stable-feature'].lastUsed).toBe('2026-06-15T12:00:00.000Z');
    });

    it('falls back to server-generated ISO string when timestamp is non-string', async () => {
      const before = new Date().toISOString();
      const res = await app.inject({
        method: 'POST',
        url: '/api/feature-usage/track',
        payload: { featureId: 'no-ts-feature', timestamp: 12345 },
      });
      const after = new Date().toISOString();

      expect(res.statusCode).toBe(200);
      const stored = JSON.parse(fakeFileContent!);
      const entry = stored['no-ts-feature'];
      // The server-generated timestamp should be a valid ISO string between before and after
      expect(entry.firstUsed >= before).toBe(true);
      expect(entry.firstUsed <= after).toBe(true);
    });
  });

  // ========== POST /api/feature-usage/reset ==========

  describe('POST /api/feature-usage/reset', () => {
    it('clears all usage data', async () => {
      // Track something first
      await app.inject({
        method: 'POST',
        url: '/api/feature-usage/track',
        payload: { featureId: 'doomed-feature', timestamp: '2026-01-01T00:00:00.000Z' },
      });
      expect(fakeFileContent).not.toBeNull();

      // Reset
      const res = await app.inject({
        method: 'POST',
        url: '/api/feature-usage/reset',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);

      // File should be gone
      expect(fakeFileContent).toBeNull();

      // GET should now return empty
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/feature-usage',
      });
      const getData = JSON.parse(getRes.body);
      expect(getData.data).toEqual({});
    });
  });
});

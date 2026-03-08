import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdateChecker } from '../src/update-checker.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm, mkdir, writeFile } from 'node:fs/promises';

const TEST_DIR = join(tmpdir(), `codeman-update-test-${process.pid}`);

describe('UpdateChecker', () => {
  let checker: UpdateChecker;

  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    checker = new UpdateChecker('0.5.0', join(TEST_DIR, 'update-cache.json'));
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('version comparison', () => {
    it('detects newer patch version', () => {
      expect(checker.isNewer('0.5.1', '0.5.0')).toBe(true);
    });
    it('detects newer minor version', () => {
      expect(checker.isNewer('0.6.0', '0.5.9')).toBe(true);
    });
    it('detects newer major version', () => {
      expect(checker.isNewer('1.0.0', '0.9.9')).toBe(true);
    });
    it('returns false for same version', () => {
      expect(checker.isNewer('0.5.0', '0.5.0')).toBe(false);
    });
    it('returns false when latest is older', () => {
      expect(checker.isNewer('0.4.9', '0.5.0')).toBe(false);
    });
    it('strips leading v from tag names', () => {
      expect(checker.isNewer('v0.5.1', '0.5.0')).toBe(true);
    });
  });

  describe('cache logic', () => {
    it('returns cached result when fresh (< 24h)', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: 'v0.5.1', body: 'notes', html_url: 'u', published_at: 'p' }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      await checker.check();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await checker.check();
      expect(fetchSpy).toHaveBeenCalledTimes(1); // still 1 — used cache
    });

    it('re-fetches when force=true', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: 'v0.5.1', body: 'notes', html_url: 'u', published_at: 'p' }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      await checker.check();
      await checker.check(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns stale cache with stale:true when GitHub is unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ tag_name: 'v0.5.1', body: 'notes', html_url: 'u', published_at: 'p' }),
          })
          .mockRejectedValueOnce(new Error('network error'))
      );

      await checker.check();
      const result = await checker.check(true);
      expect(result.stale).toBe(true);
      expect(result.latestVersion).toBe('0.5.1');
    });

    it('handles corrupt cache file gracefully', async () => {
      await writeFile(join(TEST_DIR, 'update-cache.json'), 'not json', 'utf-8');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ tag_name: 'v0.5.1', body: 'notes', html_url: 'u', published_at: 'p' }),
        })
      );
      const result = await checker.check();
      expect(result.latestVersion).toBe('0.5.1');
    });
  });

  describe('update detection', () => {
    it('sets updateAvailable true when newer version exists', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ tag_name: 'v0.6.0', body: '', html_url: '', published_at: '' }),
        })
      );
      const result = await checker.check();
      expect(result.updateAvailable).toBe(true);
      expect(result.latestVersion).toBe('0.6.0');
      expect(result.currentVersion).toBe('0.5.0');
    });

    it('sets updateAvailable false when up to date', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ tag_name: 'v0.5.0', body: '', html_url: '', published_at: '' }),
        })
      );
      const result = await checker.check();
      expect(result.updateAvailable).toBe(false);
    });
  });
});

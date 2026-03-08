/**
 * @fileoverview UpdateChecker — polls GitHub Releases API for newer versions.
 * Caches result to avoid hitting GitHub more than once per 24 hours.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_CACHE_PATH = join(homedir(), '.codeman', 'update-cache.json');
const GITHUB_REPO = 'SGudbrandsson/Codeman';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string;
  updateAvailable: boolean;
  stale?: boolean;
  checkedAt: number;
}

export class UpdateChecker {
  private currentVersion: string;
  private cachePath: string;
  private _cached: UpdateInfo | null = null;

  constructor(currentVersion: string, cachePath = DEFAULT_CACHE_PATH) {
    this.currentVersion = currentVersion;
    this.cachePath = cachePath;
  }

  /** Exposed for testing */
  isNewer(latest: string, current: string): boolean {
    const clean = (v: string) => v.replace(/^v/, '');
    const parse = (v: string) => clean(v).split('.').map(Number);
    const [lMaj, lMin, lPat] = parse(latest);
    const [cMaj, cMin, cPat] = parse(current);
    if (lMaj !== cMaj) return lMaj > cMaj;
    if (lMin !== cMin) return lMin > cMin;
    return lPat > cPat;
  }

  async check(force = false): Promise<UpdateInfo> {
    if (!force) {
      const cached = await this._loadCache();
      if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
        this._cached = cached;
        return cached;
      }
    }
    try {
      const result = await this._fetchGitHub();
      await this._saveCache(result);
      this._cached = result;
      return result;
    } catch {
      const stale = await this._loadCache();
      if (stale) {
        const result = { ...stale, stale: true as const };
        this._cached = result;
        return result;
      }
      const fallback: UpdateInfo = {
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
        releaseNotes: '',
        releaseUrl: '',
        publishedAt: '',
        updateAvailable: false,
        stale: true,
        checkedAt: Date.now(),
      };
      this._cached = fallback;
      return fallback;
    }
  }

  getCached(): UpdateInfo | null {
    return this._cached;
  }

  private async _fetchGitHub(): Promise<UpdateInfo> {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': `Codeman-UpdateChecker/${this.currentVersion}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`GitHub API returned ${resp.status}`);
    const data = (await resp.json()) as {
      tag_name: string;
      body: string;
      html_url: string;
      published_at: string;
    };
    const latestVersion = data.tag_name.replace(/^v/, '');
    return {
      currentVersion: this.currentVersion,
      latestVersion,
      releaseNotes: data.body || '',
      releaseUrl: data.html_url,
      publishedAt: data.published_at,
      updateAvailable: this.isNewer(latestVersion, this.currentVersion),
      checkedAt: Date.now(),
    };
  }

  private async _loadCache(): Promise<UpdateInfo | null> {
    try {
      const raw = await readFile(this.cachePath, 'utf-8');
      return JSON.parse(raw) as UpdateInfo;
    } catch {
      return null;
    }
  }

  private async _saveCache(info: UpdateInfo): Promise<void> {
    const dir = join(this.cachePath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(info, null, 2), 'utf-8');
  }
}

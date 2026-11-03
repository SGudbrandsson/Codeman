/**
 * @fileoverview Unit tests for FuzzyFileSearch (src/web/public/fuzzy-file-search.js),
 * the hand-written fzf-style matcher behind the Files sheet search.
 *
 * The shipped source is evaluated directly, so the code under test is exactly
 * what the browser runs.
 *
 * Run: npx vitest run test/fuzzy-file-search.test.ts
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import fuzzySource from '../src/web/public/fuzzy-file-search.js?raw';

interface MatchResult {
  score: number;
  positions: number[];
}
interface RankResult {
  results: Array<{ path: string; score: number; positions: number[] }>;
  total: number;
  candidates: number[] | null;
  query: string;
}
interface Parsed {
  isPath: boolean;
  path: string;
  line: number | null;
  col: number | null;
  term: string;
}
interface Fuzzy {
  prepare(paths: string[]): unknown;
  match(query: string, path: string): MatchResult | null;
  rank(index: unknown, query: string, limit?: number, prev?: RankResult | null): RankResult;
  highlightHtml(path: string, positions: number[], esc?: (s: string) => string): string;
  parsePathQuery(query: string, workingDir?: string): Parsed;
}

const F = new Function(`${fuzzySource as string}\nreturn FuzzyFileSearch;`)() as Fuzzy;

function top(paths: string[], query: string): string[] {
  return F.rank(F.prepare(paths), query, 100).results.map((r) => r.path);
}

describe('FuzzyFileSearch.match', () => {
  it('matches characters in order with gaps', () => {
    expect(F.match('sap', 'src/app.ts')).not.toBeNull();
    expect(F.match('SRCAPP', 'src/app.ts')).not.toBeNull();
  });

  it('rejects out-of-order characters', () => {
    expect(F.match('pas', 'src/app.ts')).toBeNull();
    expect(F.match('zzz', 'src/app.ts')).toBeNull();
  });

  it('returns positions of the matched characters', () => {
    const m = F.match('app', 'src/app.ts')!;
    expect(m.positions).toEqual([4, 5, 6]);
    const w = F.match('wapp', 'src/web/public/app.js')!;
    expect(w.positions).toEqual([4, 15, 16, 17]);
  });

  it('requires every whitespace-separated term to match', () => {
    expect(F.match('web app', 'src/web/public/app.js')).not.toBeNull();
    expect(F.match('web zzz', 'src/web/public/app.js')).toBeNull();
  });
});

describe('FuzzyFileSearch.rank', () => {
  it('ranks a basename match above the same chars spread across directories', () => {
    expect(top(['a/p/p.ts', 'src/app.ts'], 'app')[0]).toBe('src/app.ts');
  });

  it('ranks an exact basename first', () => {
    const r = top(['src/apple.ts', 'lib/app.js', 'src/mapper.ts', 'app'], 'app');
    expect(r[0]).toBe('app');
  });

  it('prefers boundary and consecutive matches over scattered ones', () => {
    expect(top(['xfxixlxexrx.txt', 'file-routes.ts'], 'fr')[0]).toBe('file-routes.ts');
    expect(top(['abcxdefxghi.txt', 'fileRoutes.ts', 'xfxxxxr.ts'], 'fr')[0]).toBe('fileRoutes.ts');
    expect(top(['s/x/y/z/l/a/t/e.ts', 'slate.ts'], 'slate')[0]).toBe('slate.ts');
  });

  it('respects the limit and reports the total', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `dir/file${i}.ts`);
    const r = F.rank(F.prepare(paths), 'file', 10);
    expect(r.results).toHaveLength(10);
    expect(r.total).toBe(50);
  });

  it('returns results sorted by score', () => {
    const paths = ['src/app.ts', 'a/p/p.ts', 'apps/x.js', 'zap.py', 'happy.md'];
    const r = F.rank(F.prepare(paths), 'ap', 100);
    for (let i = 1; i < r.results.length; i++) {
      expect(r.results[i - 1].score).toBeGreaterThanOrEqual(r.results[i].score);
    }
  });

  it('incremental narrowing gives the same results as a full scan', () => {
    const paths = [
      'src/web/app.ts',
      'src/web/public/app.js',
      'src/web/routes/file-routes.ts',
      'test/fuzzy-file-search.test.ts',
      'README.md',
      'src/apple/pie.ts',
      'docs/api.md',
    ];
    const index = F.prepare(paths);
    let prev: RankResult | null = null;
    for (const q of ['a', 'ap', 'app', 'app.', 'app.t', 'app.ts']) {
      const narrowed = F.rank(index, q, 100, prev);
      const full = F.rank(index, q, 100);
      expect(narrowed.results).toEqual(full.results);
      expect(narrowed.total).toBe(full.total);
      prev = narrowed;
    }
  });

  it('breaks score ties by shorter path first', () => {
    // These two paths score exactly the same: the shorter one has a longer gap,
    // the longer one pays the length penalty for its directory.
    const short = 'd/xzzzy.ts';
    const long = 'dddddddddddd/xzzy.ts';
    expect(F.match('xy', short)!.score).toBe(F.match('xy', long)!.score);
    expect(top([long, short], 'xy')).toEqual([short, long]);
  });

  it('breaks score and length ties alphabetically', () => {
    expect(F.match('x.ts', 'b/x.ts')!.score).toBe(F.match('x.ts', 'a/x.ts')!.score);
    expect(top(['c/x.ts', 'b/x.ts', 'a/x.ts'], 'x.ts')).toEqual(['a/x.ts', 'b/x.ts', 'c/x.ts']);
  });

  it('returns nothing for an empty query', () => {
    expect(F.rank(F.prepare(['a.ts']), '   ', 100).results).toEqual([]);
  });
});

describe('FuzzyFileSearch.highlightHtml', () => {
  it('wraps matched chars in <mark> and splits dir/basename', () => {
    const html = F.highlightHtml('src/app.ts', [4, 5, 6]);
    expect(html).toBe(
      '<span class="files-search-dir">src/</span><span class="files-search-base"><mark>app</mark>.ts</span>'
    );
  });

  it('escapes every segment of the path', () => {
    const path = 'a&b/<img src=x onerror="1">.ts';
    const m = F.match('img', path)!;
    const html = F.highlightHtml(path, m.positions);
    expect(html).not.toContain('<img');
    expect(html).toContain('a&amp;b/');
    expect(html).toContain('&lt;');
    expect(html).toContain('&quot;1&quot;');
    expect(html).toContain('<mark>img</mark>');
  });

  it('uses a provided escape function', () => {
    const html = F.highlightHtml('x.ts', [], (s) => s.toUpperCase());
    expect(html).toContain('X.TS');
  });

  it('omits the dir span for root files', () => {
    expect(F.highlightHtml('a.ts', [0])).toBe('<span class="files-search-base"><mark>a</mark>.ts</span>');
  });
});

describe('FuzzyFileSearch.parsePathQuery', () => {
  it('parses path:line', () => {
    const p = F.parsePathQuery('src/web/app.ts:42');
    expect(p).toEqual({ isPath: true, path: 'src/web/app.ts', line: 42, col: null, term: 'src/web/app.ts' });
  });

  it('parses path:line:col', () => {
    const p = F.parsePathQuery('a.ts:42:7');
    expect(p.line).toBe(42);
    expect(p.col).toBe(7);
    expect(p.path).toBe('a.ts');
  });

  it('strips leading ./ and treats it as a path', () => {
    const p = F.parsePathQuery('./x/y.js');
    expect(p.isPath).toBe(true);
    expect(p.path).toBe('x/y.js');
    expect(F.parsePathQuery('././z.js').path).toBe('z.js');
    expect(F.parsePathQuery('./z.js').isPath).toBe(true);
  });

  it('bare names are not paths but still carry a line', () => {
    expect(F.parsePathQuery('app.ts')).toEqual({
      isPath: false,
      path: 'app.ts',
      line: null,
      col: null,
      term: 'app.ts',
    });
    const p = F.parsePathQuery('app.ts:42');
    expect(p.isPath).toBe(false);
    expect(p.term).toBe('app.ts');
    expect(p.line).toBe(42);
  });

  it('strips trailing punctuation and colons', () => {
    expect(F.parsePathQuery('src/a.ts:').path).toBe('src/a.ts');
    expect(F.parsePathQuery('src/a.ts:42.').line).toBe(42);
    expect(F.parsePathQuery('src/a.ts,').path).toBe('src/a.ts');
  });

  it('strips surrounding backticks and quotes', () => {
    const p = F.parsePathQuery('`src/a.ts:3`');
    expect(p.path).toBe('src/a.ts');
    expect(p.line).toBe(3);
    expect(F.parsePathQuery('"src/b.ts"').path).toBe('src/b.ts');
  });

  it('parses #L line anchors', () => {
    const p = F.parsePathQuery('src/a.ts#L12');
    expect(p.path).toBe('src/a.ts');
    expect(p.line).toBe(12);
  });

  it('parses #L line anchors with a C column', () => {
    const p = F.parsePathQuery('src/a.ts#L12C3');
    expect(p.isPath).toBe(true);
    expect(p.path).toBe('src/a.ts');
    expect(p.line).toBe(12);
    expect(p.col).toBe(3);
  });

  it('makes absolute paths inside the working dir relative', () => {
    const p = F.parsePathQuery('/home/u/proj/src/a.ts:9', '/home/u/proj');
    expect(p.path).toBe('src/a.ts');
    expect(p.line).toBe(9);
    expect(F.parsePathQuery('/etc/passwd', '/home/u/proj').path).toBe('/etc/passwd');
    expect(F.parsePathQuery('/home/u/project2/a.ts', '/home/u/proj').path).toBe('/home/u/project2/a.ts');
  });

  it('does not treat a non-numeric suffix as a line', () => {
    const p = F.parsePathQuery('foo:bar');
    expect(p.line).toBeNull();
    expect(p.path).toBe('foo:bar');
  });

  it('ignores line 0', () => {
    expect(F.parsePathQuery('a/b.ts:0').line).toBeNull();
  });
});

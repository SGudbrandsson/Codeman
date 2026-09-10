/**
 * @fileoverview Tests for markdown file links in the transcript renderer
 * (codex writes file references as `[src/a.ts:12](/abs/src/a.ts:12)`).
 *
 * Covers:
 * - parseMarkdownFileLinkTarget(): classifies a raw link target as a file path
 *   ({ path, line, col }) or null (URLs, schemes, anchors, junk).
 * - renderMarkdown() / inlineMarkdown(): file targets render as an href-less
 *   `<a class="tv-md-file-link" data-file-path data-line>`, while every other link
 *   keeps its pre-fix output (href + target=_blank, unsafe schemes -> href="#").
 *
 * Like test/files-md-highlight.test.ts, this runs the REAL code: app.js is imported
 * as text and the top-level functions are extracted and compiled, so the tests
 * cannot drift from the shipped source.
 *
 * Run: npx vitest run test/markdown-file-link-target.test.ts
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

// ─── Real-source extraction ─────────────────────────────────────────────────

/** Source text of a top-level `function name(...) { ... }` in app.js. */
function functionSource(name: string): string {
  const start = APP_JS_SOURCE.indexOf(`\nfunction ${name}(`);
  expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
  const end = APP_JS_SOURCE.indexOf('\n}', start + 1);
  expect(end, `${name}() has no column-0 closing brace`).toBeGreaterThan(start);
  return APP_JS_SOURCE.slice(start + 1, end + 2);
}

/** The `var _FILE_PATH_*` constants looksLikePath() depends on. */
function filePathConstantsSource(): string {
  const start = APP_JS_SOURCE.indexOf('var _FILE_PATH_EXTENSIONS =');
  const last = APP_JS_SOURCE.indexOf('var _FILE_PATH_BARE_RE', start);
  expect(start, '_FILE_PATH_EXTENSIONS not found in app.js').toBeGreaterThan(-1);
  expect(last, '_FILE_PATH_BARE_RE not found in app.js').toBeGreaterThan(start);
  return APP_JS_SOURCE.slice(start, APP_JS_SOURCE.indexOf('\n', last));
}

type FileLinkTarget = { path: string; line: number | null; col: number | null } | null;

const md = new Function(
  [
    filePathConstantsSource(),
    functionSource('looksLikePath'),
    functionSource('parseMarkdownFileLinkTarget'),
    functionSource('inlineMarkdown'),
    functionSource('renderMarkdown'),
    'return { parseMarkdownFileLinkTarget, renderMarkdown };',
  ].join('\n')
)() as {
  parseMarkdownFileLinkTarget: (raw: string) => FileLinkTarget;
  renderMarkdown: (text: string) => string;
};

const parse = md.parseMarkdownFileLinkTarget;
const render = md.renderMarkdown;

// ─── parseMarkdownFileLinkTarget ────────────────────────────────────────────

describe('parseMarkdownFileLinkTarget', () => {
  describe('file targets', () => {
    it.each<[string, string, number | null, number | null]>([
      ['/home/u/proj/src/session.ts:1538', '/home/u/proj/src/session.ts', 1538, null],
      ['/home/u/proj/src/a.ts:12:3', '/home/u/proj/src/a.ts', 12, 3],
      ['/home/u/proj/src/a.ts', '/home/u/proj/src/a.ts', null, null],
      ['/home/u/proj/src/a.ts:12-20', '/home/u/proj/src/a.ts', 12, null],
      ['</abs/My Project/a.md:3>', '/abs/My Project/a.md', 3, null],
      ['app.py:12', 'app.py', 12, null],
      ['docs/superpowers/specs/x.md:81', 'docs/superpowers/specs/x.md', 81, null],
      ['src/a.ts#L12', 'src/a.ts', 12, null],
      ['src/a.ts#L12-L20', 'src/a.ts', 12, null],
      ['file:///home/u/x.ts:4', '/home/u/x.ts', 4, null],
      ['file://localhost/home/u/x.ts', '/home/u/x.ts', null, null],
      ['file:///home/u/My%20Dir/x.ts:4:2', '/home/u/My Dir/x.ts', 4, 2],
      ['/home/u/src/my_file_name.py:3', '/home/u/src/my_file_name.py', 3, null],
      ['/home/u/pkg/__init__.py', '/home/u/pkg/__init__.py', null, null],
      ['/home/u/a&b.ts:1:2', '/home/u/a&b.ts', 1, 2],
    ])('%j -> path %j, line %j, col %j', (target, path, line, col) => {
      expect(parse(target)).toEqual({ path, line, col });
    });
  });

  describe('non-file targets return null', () => {
    it.each([
      'https://example.com/a',
      'http://localhost:3001/api',
      'mailto:x@y.z',
      'app://connector_123',
      'javascript:alert(1)',
      'JavaScript:1',
      'data:text/html,x',
      'vbscript:msgbox',
      'localhost:3000',
      '#anchor',
      '/api/x?y=1',
      '',
      '/' + 'a'.repeat(600) + '.ts',
      '/',
      '..',
      '../..',
      '//evil.com/x',
      'file://host/x.ts',
      'file:///home/u/bad%zz.ts',
      'my dir/a.ts',
      '/home/u/a".ts',
    ])('%j', (target) => {
      expect(parse(target)).toBeNull();
    });
  });
});

// ─── renderMarkdown link output ─────────────────────────────────────────────

describe('renderMarkdown link output', () => {
  it('renders an absolute path:line link as an href-less tv-md-file-link', () => {
    const html = render('See [src/session.ts:1538](/home/u/proj/src/session.ts:1538) now.');
    expect(html).toBe(
      '<p>See <a class="tv-md-file-link" data-file-path="/home/u/proj/src/session.ts" data-line="1538">' +
        'src/session.ts:1538</a> now.</p>'
    );
    expect(html).not.toContain('href');
    expect(html).not.toContain('target=');
  });

  it('omits data-line when the target has no line suffix', () => {
    expect(render('[a.ts](/home/u/proj/a.ts)')).toBe(
      '<p><a class="tv-md-file-link" data-file-path="/home/u/proj/a.ts">a.ts</a></p>'
    );
  });

  it('keeps http(s) links unchanged: href + target=_blank + rel', () => {
    expect(render('[docs](https://example.com/a)')).toBe(
      '<p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a></p>'
    );
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox'])(
    'still neutralises %j to href="#"',
    (target) => {
      const html = render(`[bad](${target})`);
      expect(html).toContain('<a href="#" target="_blank" rel="noopener noreferrer">bad</a>');
      expect(html).not.toContain('tv-md-file-link');
    }
  );

  it('does not mangle underscores in the path into <em>/<strong>', () => {
    const a = render('[my_file_name.py:3](/home/u/src/my_file_name.py:3)');
    expect(a).toContain('data-file-path="/home/u/src/my_file_name.py" data-line="3">my_file_name.py:3</a>');
    const b = render('[__init__.py](/home/u/pkg/__init__.py)');
    expect(b).toContain('data-file-path="/home/u/pkg/__init__.py">__init__.py</a>');
    expect(a + b).not.toMatch(/<em>|<strong>/);
  });

  it('escapes & in the path exactly once', () => {
    const html = render('[a&b](/home/u/a&b.ts:1:2)');
    expect(html).toContain('data-file-path="/home/u/a&amp;b.ts" data-line="1"');
    expect(html).not.toContain('&amp;amp;');
  });

  it('does not double-escape an angle-bracket target', () => {
    expect(render('[a.md](</abs/My Project/a.md:3>)')).toBe(
      '<p><a class="tv-md-file-link" data-file-path="/abs/My Project/a.md" data-line="3">a.md</a></p>'
    );
  });

  it('a percent-encoded quote in a file:// target cannot break out of the attribute', () => {
    const html = render('[x](file:///home/u/x%22%3E.ts)');
    expect(html).toBe('<p><a class="tv-md-file-link" data-file-path="/home/u/x&quot;&gt;.ts">x</a></p>');
  });

  it('keeps a <code> label inside the file link', () => {
    expect(render('[`x.ts`](/abs/x.ts)')).toBe(
      '<p><a class="tv-md-file-link" data-file-path="/abs/x.ts"><code>x.ts</code></a></p>'
    );
  });

  it('plain Claude-style inline code paths still render as <code>', () => {
    expect(render('Open `src/session.ts` please.')).toBe('<p>Open <code>src/session.ts</code> please.</p>');
  });
});

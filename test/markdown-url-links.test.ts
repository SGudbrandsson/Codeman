/**
 * @fileoverview Tests for http(s) links and bare URLs in the transcript markdown
 * renderer (src/web/public/app.js renderMarkdown() / inlineMarkdown() / safeHref()).
 *
 * Regression: URLs containing `_`/`*`/`&`/parens were truncated or had `<em>`
 * injected into their href (and into our own `target="_blank"`), because the
 * emphasis pass ran over link targets and generated anchor HTML.
 *
 * Covers:
 * - bare URLs and `[label](url)` keep the exact URL (underscores, balanced parens, `&`)
 * - trailing punctuation / unbalanced `)` stay outside the anchor
 * - `[x](<url with spaces>)` angle-bracket targets
 * - emphasis in surrounding prose and in link labels still renders
 * - safeHref() neutralises javascript:/data:/vbscript:, including whitespace/control-char bypasses
 * - linear-time trailing trim on pathological input
 *
 * Like test/markdown-file-link-target.test.ts, this runs the REAL code extracted
 * from app.js imported as text.
 *
 * Run: npx vitest run test/markdown-url-links.test.ts
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

// ─── Real-source extraction ─────────────────────────────────────────────────

/** Source text of a `function name(...) { ... }` at the given indentation in app.js. */
function functionSource(name: string, indent = ''): string {
  const start = APP_JS_SOURCE.indexOf(`\n${indent}function ${name}(`);
  expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
  const end = APP_JS_SOURCE.indexOf(`\n${indent}}`, start + 1);
  expect(end, `${name}() has no closing brace at indent ${JSON.stringify(indent)}`).toBeGreaterThan(start);
  return APP_JS_SOURCE.slice(start + 1, end + indent.length + 2);
}

/** The `var _FILE_PATH_*` constants looksLikePath() depends on. */
function filePathConstantsSource(): string {
  const start = APP_JS_SOURCE.indexOf('var _FILE_PATH_EXTENSIONS =');
  const last = APP_JS_SOURCE.indexOf('var _FILE_PATH_BARE_RE', start);
  expect(start, '_FILE_PATH_EXTENSIONS not found in app.js').toBeGreaterThan(-1);
  expect(last, '_FILE_PATH_BARE_RE not found in app.js').toBeGreaterThan(start);
  return APP_JS_SOURCE.slice(start, APP_JS_SOURCE.indexOf('\n', last));
}

const md = new Function(
  [
    filePathConstantsSource(),
    functionSource('looksLikePath'),
    functionSource('parseMarkdownFileLinkTarget'),
    functionSource('inlineMarkdown'),
    functionSource('renderMarkdown'),
    // safeHref() is nested inside renderMarkdown(); extract it for direct unit tests.
    functionSource('safeHref', '  '),
    'return { renderMarkdown, safeHref };',
  ].join('\n')
)() as {
  renderMarkdown: (text: string) => string;
  safeHref: (url: string) => string;
};

const render = md.renderMarkdown;
const safeHref = md.safeHref;

const U =
  'https://commons.wikimedia.org/wiki/File:Esja_and_Faxa_Bay_-_view_from_Reykjav%C3%ADk,_20230507_0815_5426.jpg';
const A = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

function expectNoMangling(html: string): void {
  expect(html).not.toMatch(/<em>|<\/em>|<strong>|<\/strong>/);
  expect(html).not.toContain('%3C');
  expect(html).not.toContain('&lt;em');
}

// ─── Underscore URLs (the reported bug) ─────────────────────────────────────

describe('URLs with underscores', () => {
  it('bare Wikimedia URL: href and text are exactly the URL, target="_blank" intact', () => {
    const html = render(`See ${U} now`);
    expect(html).toBe(`<p>See ${A(U, U)} now</p>`);
    expect(html).toContain('target="_blank"');
    expectNoMangling(html);
  });

  it('[photo](U): href is exactly the URL, label intact', () => {
    const html = render(`[photo](${U})`);
    expect(html).toBe(`<p>${A(U, 'photo')}</p>`);
    expectNoMangling(html);
  });

  it('a label that is itself the URL yields a single anchor (no nested <a>)', () => {
    const html = render('[https://a.com/x_y](https://a.com/x_y)');
    expect(html).toBe(`<p>${A('https://a.com/x_y', 'https://a.com/x_y')}</p>`);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it('several links on one line (file link, [label](url), bare URLs) each keep their own href/text in order', () => {
    const html = render(
      '[a.ts:1](/abs/a.ts:1) then [doc_x](https://x.com/a_b) and https://y.com/c_d, https://z.com/e_f'
    );
    expect(html).toBe(
      '<p><a class="tv-md-file-link" data-file-path="/abs/a.ts" data-line="1">a.ts:1</a>' +
        ` then ${A('https://x.com/a_b', 'doc_x')}` +
        ` and ${A('https://y.com/c_d', 'https://y.com/c_d')},` +
        ` ${A('https://z.com/e_f', 'https://z.com/e_f')}</p>`
    );
    expectNoMangling(html);
  });
});

// ─── Parentheses and trailing punctuation ───────────────────────────────────

describe('parentheses and trailing punctuation', () => {
  it('bare URL keeps balanced parens and leaves a trailing "." outside', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(render(`${url}.`)).toBe(`<p>${A(url, url)}.</p>`);
  });

  it('link target with balanced parens gives the full href', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(render(`[w](${url})`)).toBe(`<p>${A(url, 'w')}</p>`);
  });

  it('an unbalanced trailing ")" stays outside the anchor', () => {
    expect(render('(see https://a.com/x)')).toBe(`<p>(see ${A('https://a.com/x', 'https://a.com/x')})</p>`);
  });

  it.each([',', ';', ':', '!', '?'])('trailing %j stays outside the anchor', (p) => {
    expect(render(`go https://a.com/x_y${p} next`)).toBe(
      `<p>go ${A('https://a.com/x_y', 'https://a.com/x_y')}${p} next</p>`
    );
  });

  it('**https://x.com/a_b** wraps the link in <strong>', () => {
    expect(render('**https://x.com/a_b**')).toBe(
      `<p><strong>${A('https://x.com/a_b', 'https://x.com/a_b')}</strong></p>`
    );
  });
});

// ─── Query strings, angle targets ───────────────────────────────────────────

describe('query strings and angle-bracket targets', () => {
  it('bare URL with & is escaped exactly once', () => {
    const html = render('https://a.com/?a=1&b=2');
    expect(html).toBe(`<p>${A('https://a.com/?a=1&amp;b=2', 'https://a.com/?a=1&amp;b=2')}</p>`);
    expect(html).not.toContain('&amp;amp;');
  });

  it('link target with & is escaped exactly once', () => {
    const html = render('[q](https://a.com/?a=1&b=2)');
    expect(html).toBe(`<p>${A('https://a.com/?a=1&amp;b=2', 'q')}</p>`);
    expect(html).not.toContain('&amp;amp;');
  });

  it('[x](<https://a.com/a b>) keeps the space in the href', () => {
    expect(render('[x](<https://a.com/a b>)')).toBe(`<p>${A('https://a.com/a b', 'x')}</p>`);
  });

  it('bare URL in <...> ends at the escaped &lt;/&gt; entities', () => {
    const html = render('<https://a.com/x_y>');
    expect(html).toBe(`<p>&lt;${A('https://a.com/x_y', 'https://a.com/x_y')}&gt;</p>`);
    expect(html).not.toContain('x_y&gt;"');
    expectNoMangling(html);
  });

  it('bare URL in "..." ends at the escaped &quot; entity', () => {
    const html = render('"https://a.com/x_y"');
    expect(html).toBe(`<p>&quot;${A('https://a.com/x_y', 'https://a.com/x_y')}&quot;</p>`);
    expectNoMangling(html);
  });

  it('bare URL ending in a literal & stays safe (known cosmetic limitation)', () => {
    // Known limitation: the trailing trim eats the `;` of `&amp;`, giving
    // href "…&amp;amp" — cosmetically wrong, so only safety is asserted here.
    const html = render('https://a.com/?q=a& end');
    expect(html).toMatch(/^<p><a href="https:\/\/a\.com\/\?q=a[^"<>]*" target="_blank" rel="noopener noreferrer">/);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain('javascript:');
  });
});

// ─── Emphasis still works ───────────────────────────────────────────────────

describe('emphasis around and inside links', () => {
  it('prose emphasis renders while the URL is untouched', () => {
    expect(render('_em_ and **bold** around https://x.com/a_b_c link')).toBe(
      `<p><em>em</em> and <strong>bold</strong> around ${A('https://x.com/a_b_c', 'https://x.com/a_b_c')} link</p>`
    );
  });

  it('link label keeps emphasis and code', () => {
    expect(render('[**bold** `c`](https://x.com)')).toBe(
      `<p>${A('https://x.com', '<strong>bold</strong> <code>c</code>')}</p>`
    );
  });
});

// ─── Unsafe schemes ─────────────────────────────────────────────────────────

describe('unsafe schemes', () => {
  it('[x](javascript:alert(1)) gives href="#" with no stray ")"', () => {
    const html = render('[x](javascript:alert(1))');
    expect(html).toBe(`<p>${A('#', 'x')}</p>`);
    expect(html).not.toContain('</a>)');
  });

  it.each([
    ['tab inside scheme', '[x](<jav\tascript:alert(1)>)'],
    ['leading space', '[x](< javascript:alert(1)>)'],
    ['control char, upper case', '[x](<JAVA\x01SCRIPT:alert(1)>)'],
  ])('neutralises bypass via %s', (_label, input) => {
    const html = render(input);
    expect(html).toBe(`<p>${A('#', 'x')}</p>`);
  });

  describe('safeHref()', () => {
    it.each([
      'javascript:alert(1)',
      'JavaScript:1',
      ' javascript:alert(1)',
      'jav\tascript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:1',
      'JAVA\x01SCRIPT:1',
      '\x7fjavascript:1',
      'data:text/html,x',
      'da ta:text/html,x',
      'vbscript:msgbox',
      'vb\x00script:msgbox',
    ])('%j -> "#"', (url) => {
      expect(safeHref(url)).toBe('#');
    });

    it.each(['https://a.com/a b', 'http://x.com/?a=1&b=2', U, 'mailto:x@y.z'])('returns safe %j unchanged', (url) => {
      expect(safeHref(url)).toBe(url);
    });
  });
});

// ─── Performance ────────────────────────────────────────────────────────────

describe('trailing trim is linear-time', () => {
  it('https://a.com/ + ")"x40000 renders quickly and correctly', () => {
    const tail = ')'.repeat(40000);
    const t0 = performance.now();
    const html = render('https://a.com/' + tail);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(html).toBe(`<p>${A('https://a.com/', 'https://a.com/')}${tail}</p>`);
  });

  it('https://a.com/ + ".)"x20000 renders quickly and correctly', () => {
    const tail = '.)'.repeat(20000);
    const t0 = performance.now();
    const html = render('https://a.com/' + tail);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(html).toBe(`<p>${A('https://a.com/', 'https://a.com/')}${tail}</p>`);
  });
});

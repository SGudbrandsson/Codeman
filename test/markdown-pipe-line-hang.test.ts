/**
 * @fileoverview Regression test: renderMarkdown() must terminate on lines that start
 * with `|` but are not a pipe table row (src/web/public/app.js).
 *
 * Regression: a truncated table row such as `| G6 | Provider-json` (starts with `|`,
 * does not end with one) was rejected by the table branch and excluded by the
 * paragraph branch, so the main loop never advanced `i`. Opening a session whose
 * transcript contained such a line froze the browser tab.
 *
 * renderMarkdown() runs inside node:vm with a timeout, so a regression fails the
 * test instead of hanging the runner.
 *
 * Run: npx vitest run test/markdown-pipe-line-hang.test.ts
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

function functionSource(name: string): string {
  const start = APP_JS_SOURCE.indexOf(`\nfunction ${name}(`);
  expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
  const end = APP_JS_SOURCE.indexOf('\n}', start + 1);
  return APP_JS_SOURCE.slice(start + 1, end + 2);
}

function filePathConstantsSource(): string {
  const start = APP_JS_SOURCE.indexOf('var _FILE_PATH_EXTENSIONS =');
  const last = APP_JS_SOURCE.indexOf('var _FILE_PATH_BARE_RE', start);
  return APP_JS_SOURCE.slice(start, APP_JS_SOURCE.indexOf('\n', last));
}

const SANDBOX_SOURCE = [
  filePathConstantsSource(),
  functionSource('looksLikePath'),
  functionSource('parseMarkdownFileLinkTarget'),
  functionSource('inlineMarkdown'),
  functionSource('renderMarkdown'),
].join('\n');

/** Render in a fresh VM context; throws "Script execution timed out" if renderMarkdown loops. */
function render(text: string): string {
  const ctx = vm.createContext({ input: text });
  return vm.runInContext(`${SANDBOX_SOURCE}\nrenderMarkdown(input);`, ctx, { timeout: 1000 }) as string;
}

describe('renderMarkdown: lines starting with "|" that are not table rows', () => {
  it('truncated table row after a valid table (the reported transcript)', () => {
    const text = ['| # | Gap |', '|---|---|', '| G5 | Settings |', '| G6 | Provider-json'].join('\n');
    const html = render(text);
    expect(html).toContain('<table class="tv-table">');
    expect(html).toContain('<p>| G6 | Provider-json</p>');
  });

  it('a lone "|" line', () => {
    expect(render('|')).toBe('<p>|</p>');
  });

  it('a "|"-prefixed line in the middle of prose keeps the surrounding text', () => {
    const html = render('before\n\n| not a row\nafter');
    expect(html).toContain('<p>before</p>');
    expect(html).toContain('| not a row');
    expect(html).toContain('after');
  });

  it('valid tables still render as tables', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>2</td>');
  });
});

/**
 * @fileoverview Tests for looksLikePath() — the file-path detection heuristic
 * used by the clickable-file-paths feature in the transcript view.
 *
 * `looksLikePath(text)` gates which inline-code spans get checked for on-disk
 * existence and (if found) turned into clickable links. It is a pure function:
 * trim, length cap, whitespace/backtick/angle-bracket reject, protocol reject,
 * then a slash-path regex OR a bare-filename-with-known-extension regex.
 *
 * Because app.js is a browser bundle (no exports, not importable), the function
 * and its dependent constant/regexes are hand-copied verbatim from
 * src/web/public/app.js (~lines 435-454) and exercised here. This mirrors the
 * established repo pattern in test/image-attach-rewrite.test.ts (which copies
 * replaceImagePaths — the sibling free function this feature was modeled on).
 *
 * KNOWN LIMITATION: because the source is hand-copied, this test will not catch
 * the source drifting out of sync — if app.js changes looksLikePath, this copy
 * must be updated by hand. This is an accepted limitation of the repo's app.js
 * unit-test pattern.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Verbatim copy from src/web/public/app.js (~lines 435-454)
// ---------------------------------------------------------------------------

/** Known code/doc extensions used to recognise bare filenames as paths. */
const _FILE_PATH_EXTENSIONS =
  'md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|xml|css|scss|html|py|rs|go|sh|sql|env|lock|cfg|ini|conf';
const _FILE_PATH_WITH_SLASH_RE = /^[\w.@~-]+(?:\/[\w.@~+-]+)+$/;
const _FILE_PATH_BARE_RE = new RegExp('^[\\w.@~-]+\\.(?:' + _FILE_PATH_EXTENSIONS + ')$', 'i');

/**
 * Heuristic: does this inline-code text look like a (relative or absolute) file path?
 * Existence is verified separately server-side; this only gates which spans we check.
 */
function looksLikePath(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t || t.length > 512) return false;
  // Reject whitespace, backticks, angle brackets (defensive — already escaped).
  if (/[\s`<>]/.test(t)) return false;
  // Reject protocols (http:, https:, file:, mailto:, etc.).
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false;
  // Path with at least one separator, OR a bare filename with a known extension.
  return _FILE_PATH_WITH_SLASH_RE.test(t) || _FILE_PATH_BARE_RE.test(t);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('looksLikePath', () => {
  describe('accepts real-looking paths', () => {
    it.each([
      'src/index.ts',
      'apps/skyvern/booking-sync/SKYVERN-FORK-FIX-BRIEF.md',
      'dist/index.js',
      'src/web/public/app.js',
    ])('accepts slash-separated path %j', (p) => {
      expect(looksLikePath(p)).toBe(true);
    });

    it.each(['package.json', 'README.md', 'styles.css', 'tsconfig.json'])(
      'accepts bare filename with known extension %j',
      (p) => {
        expect(looksLikePath(p)).toBe(true);
      }
    );
  });

  describe('rejects non-paths', () => {
    it.each([
      'npm run build', // contains whitespace
      'const x = 5', // contains whitespace
      'foo()', // parens are not path chars
    ])('rejects command/code fragment %j', (s) => {
      expect(looksLikePath(s)).toBe(false);
    });

    it.each(['https://example.com', 'http://localhost:3001/api', 'mailto:x@y.z', 'file:///etc/passwd'])(
      'rejects URLs/protocols %j',
      (s) => {
        expect(looksLikePath(s)).toBe(false);
      }
    );

    it('rejects the empty string', () => {
      expect(looksLikePath('')).toBe(false);
    });

    it('rejects a string with backticks', () => {
      expect(looksLikePath('`code`')).toBe(false);
    });

    it('rejects a string with angle brackets', () => {
      expect(looksLikePath('a<b>c')).toBe(false);
    });

    it('rejects a bare word with no slash and no known extension', () => {
      expect(looksLikePath('something')).toBe(false);
    });

    it('rejects strings longer than the 512-char cap', () => {
      // A would-be valid bare filename, but too long.
      const longName = 'a'.repeat(600) + '.ts';
      expect(longName.length).toBeGreaterThan(512);
      expect(looksLikePath(longName)).toBe(false);
    });
  });

  describe('extension list is significant (documents bare vs slash behavior)', () => {
    // png is NOT in _FILE_PATH_EXTENSIONS, so a bare filename with .png is rejected...
    it('rejects a bare filename with an unknown extension (image.png)', () => {
      expect(looksLikePath('image.png')).toBe(false);
    });

    // ...but the SAME unknown extension is accepted once a slash separator is
    // present, because the slash regex only requires word/path chars (png chars
    // are word chars) and does not consult the extension list.
    it('accepts foo/image.png via the slash regex regardless of extension', () => {
      expect(looksLikePath('foo/image.png')).toBe(true);
    });
  });

  describe('edge cases (pinned behavior)', () => {
    it('trims surrounding whitespace before evaluating', () => {
      expect(looksLikePath('  src/index.ts  ')).toBe(true);
    });

    it('rejects a bare dotfile with no name before the dot (.env)', () => {
      // The bare regex requires at least one char before the extension dot, so a
      // leading-dot dotfile does not match. Fail-safe: stays non-clickable.
      expect(looksLikePath('.env')).toBe(false);
    });
  });
});

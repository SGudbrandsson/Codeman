/**
 * @fileoverview Tests for non-image file upload branching logic
 *
 * Covers the three new logic blocks added to src/web/public/app.js:
 *   1. MIME-type filtering in the paste event handler (~line 17648)
 *   2. MIME-type splitting in _onFilesChosen (~line 17866)
 *   3. Textarea value building in _handleNonImageFiles (~line 17877)
 *
 * Because app.js is a browser bundle (no exports), the logic is replicated
 * here as pure functions matching the exact expressions in the source.
 * This mirrors the approach used in paste-newline-routing.test.ts.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Types mirroring the relevant DataTransferItem / File shape
// ---------------------------------------------------------------------------

interface FakeItem {
  kind: string;
  type: string;
}

interface FakeFile {
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Pure helpers extracted from the paste handler in app.js
// ---------------------------------------------------------------------------

/**
 * Filters clipboard items to image file items only.
 *   items.filter(it => it.kind === 'file' && it.type.startsWith('image/'))
 */
const filterImageItems = (items: FakeItem[]): FakeItem[] =>
  items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'));

/**
 * Filters clipboard items to non-image file items only.
 *   items.filter(it => it.kind === 'file' && it.type && !it.type.startsWith('image/'))
 * Note: items with an empty type string are excluded (truthy check on it.type).
 */
const filterNonImageItems = (items: FakeItem[]): FakeItem[] =>
  items.filter((it) => it.kind === 'file' && it.type && !it.type.startsWith('image/'));

/**
 * Determines whether preventDefault should be called.
 * Only called when at least one file of either kind is found.
 *   if (!imageItems.length && !nonImageItems.length) return;   // early-return = no preventDefault
 */
const shouldPreventDefault = (imageItems: FakeItem[], nonImageItems: FakeItem[]): boolean =>
  imageItems.length > 0 || nonImageItems.length > 0;

// ---------------------------------------------------------------------------
// Pure helpers extracted from _onFilesChosen in app.js
// ---------------------------------------------------------------------------

/**
 * Splits a file list into image and non-image groups.
 *   const imageFiles = files.filter(f => f.type.startsWith('image/'));
 *   const nonImageFiles = files.filter(f => !f.type.startsWith('image/'));
 * Note: files with empty type fall into nonImageFiles (unlike paste handler).
 */
const splitFilesByType = (files: FakeFile[]): { imageFiles: FakeFile[]; nonImageFiles: FakeFile[] } => ({
  imageFiles: files.filter((f) => f.type.startsWith('image/')),
  nonImageFiles: files.filter((f) => !f.type.startsWith('image/')),
});

// ---------------------------------------------------------------------------
// Pure helper extracted from _handleNonImageFiles in app.js
// ---------------------------------------------------------------------------

/**
 * Builds the new textarea value after inserting non-image file names.
 *   const names = files.map(f => f.name).join('\n');
 *   ta.value = existing ? existing + '\n' + names : names;
 */
const buildTextareaValue = (existing: string, files: FakeFile[]): string => {
  const names = files.map((f) => f.name).join('\n');
  return existing ? existing + '\n' + names : names;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Non-image file upload logic', () => {
  describe('filterImageItems — paste handler image filter', () => {
    it('keeps file items with an image/ MIME type', () => {
      const items: FakeItem[] = [{ kind: 'file', type: 'image/png' }];
      expect(filterImageItems(items)).toHaveLength(1);
    });

    it('keeps all common image MIME types', () => {
      const items: FakeItem[] = [
        { kind: 'file', type: 'image/jpeg' },
        { kind: 'file', type: 'image/gif' },
        { kind: 'file', type: 'image/webp' },
      ];
      expect(filterImageItems(items)).toHaveLength(3);
    });

    it('excludes non-image file items', () => {
      const items: FakeItem[] = [{ kind: 'file', type: 'application/pdf' }];
      expect(filterImageItems(items)).toHaveLength(0);
    });

    it('excludes string (non-file) clipboard items', () => {
      const items: FakeItem[] = [{ kind: 'string', type: 'text/plain' }];
      expect(filterImageItems(items)).toHaveLength(0);
    });
  });

  describe('filterNonImageItems — paste handler non-image filter', () => {
    it('keeps file items with a non-image MIME type', () => {
      const items: FakeItem[] = [{ kind: 'file', type: 'application/pdf' }];
      expect(filterNonImageItems(items)).toHaveLength(1);
    });

    it('keeps text/plain and text/javascript file items', () => {
      const items: FakeItem[] = [
        { kind: 'file', type: 'text/plain' },
        { kind: 'file', type: 'text/javascript' },
      ];
      expect(filterNonImageItems(items)).toHaveLength(2);
    });

    it('excludes image file items', () => {
      const items: FakeItem[] = [{ kind: 'file', type: 'image/png' }];
      expect(filterNonImageItems(items)).toHaveLength(0);
    });

    it('excludes file items with an empty type string', () => {
      // Empty type is unknown — dropped from non-image list in the paste path
      const items: FakeItem[] = [{ kind: 'file', type: '' }];
      expect(filterNonImageItems(items)).toHaveLength(0);
    });

    it('excludes string (non-file) clipboard items even with non-image type', () => {
      const items: FakeItem[] = [{ kind: 'string', type: 'text/plain' }];
      expect(filterNonImageItems(items)).toHaveLength(0);
    });
  });

  describe('shouldPreventDefault — paste handler early-return guard', () => {
    it('returns true when only image items are present', () => {
      const img: FakeItem[] = [{ kind: 'file', type: 'image/png' }];
      expect(shouldPreventDefault(img, [])).toBe(true);
    });

    it('returns true when only non-image items are present', () => {
      const nonImg: FakeItem[] = [{ kind: 'file', type: 'application/pdf' }];
      expect(shouldPreventDefault([], nonImg)).toBe(true);
    });

    it('returns true when both image and non-image items are present (mixed clipboard)', () => {
      const img: FakeItem[] = [{ kind: 'file', type: 'image/png' }];
      const nonImg: FakeItem[] = [{ kind: 'file', type: 'application/pdf' }];
      expect(shouldPreventDefault(img, nonImg)).toBe(true);
    });

    it('returns false when no file items of either kind are found (plain text paste passes through)', () => {
      expect(shouldPreventDefault([], [])).toBe(false);
    });
  });

  describe('mixed clipboard — image and non-image items split correctly', () => {
    it('routes each item to the correct group', () => {
      const items: FakeItem[] = [
        { kind: 'file', type: 'image/png' },
        { kind: 'file', type: 'application/pdf' },
        { kind: 'file', type: 'text/plain' },
        { kind: 'string', type: 'text/plain' }, // string, not file — excluded from both
        { kind: 'file', type: '' }, // empty type — excluded from non-image group
      ];
      const imageItems = filterImageItems(items);
      const nonImageItems = filterNonImageItems(items);
      expect(imageItems).toHaveLength(1);
      expect(imageItems[0].type).toBe('image/png');
      expect(nonImageItems).toHaveLength(2);
      expect(nonImageItems.map((i) => i.type)).toEqual(['application/pdf', 'text/plain']);
    });
  });

  describe('splitFilesByType — _onFilesChosen file split', () => {
    it('routes image files to imageFiles group', () => {
      const files: FakeFile[] = [{ name: 'photo.png', type: 'image/png' }];
      const { imageFiles, nonImageFiles } = splitFilesByType(files);
      expect(imageFiles).toHaveLength(1);
      expect(nonImageFiles).toHaveLength(0);
    });

    it('routes non-image files to nonImageFiles group', () => {
      const files: FakeFile[] = [{ name: 'doc.pdf', type: 'application/pdf' }];
      const { imageFiles, nonImageFiles } = splitFilesByType(files);
      expect(imageFiles).toHaveLength(0);
      expect(nonImageFiles).toHaveLength(1);
    });

    it('routes files with empty type to nonImageFiles group (file picker path)', () => {
      // Unlike the paste handler, _onFilesChosen has no truthy check on type,
      // so empty-type files are treated as non-image.
      const files: FakeFile[] = [{ name: 'unknown', type: '' }];
      const { imageFiles, nonImageFiles } = splitFilesByType(files);
      expect(imageFiles).toHaveLength(0);
      expect(nonImageFiles).toHaveLength(1);
    });

    it('splits a mixed array correctly', () => {
      const files: FakeFile[] = [
        { name: 'photo.jpg', type: 'image/jpeg' },
        { name: 'report.pdf', type: 'application/pdf' },
        { name: 'script.js', type: 'text/javascript' },
      ];
      const { imageFiles, nonImageFiles } = splitFilesByType(files);
      expect(imageFiles).toHaveLength(1);
      expect(nonImageFiles).toHaveLength(2);
    });
  });

  describe('buildTextareaValue — _handleNonImageFiles textarea insert', () => {
    it('returns just the filename when textarea is empty', () => {
      const files: FakeFile[] = [{ name: 'report.pdf', type: 'application/pdf' }];
      expect(buildTextareaValue('', files)).toBe('report.pdf');
    });

    it('appends filename on a new line when textarea has existing content', () => {
      const files: FakeFile[] = [{ name: 'report.pdf', type: 'application/pdf' }];
      expect(buildTextareaValue('Some text', files)).toBe('Some text\nreport.pdf');
    });

    it('joins multiple filenames with newlines', () => {
      const files: FakeFile[] = [
        { name: 'a.txt', type: 'text/plain' },
        { name: 'b.js', type: 'text/javascript' },
        { name: 'c.pdf', type: 'application/pdf' },
      ];
      expect(buildTextareaValue('', files)).toBe('a.txt\nb.js\nc.pdf');
    });

    it('appends multiple filenames after existing content, all on new lines', () => {
      const files: FakeFile[] = [
        { name: 'a.txt', type: 'text/plain' },
        { name: 'b.js', type: 'text/javascript' },
      ];
      expect(buildTextareaValue('Hello world', files)).toBe('Hello world\na.txt\nb.js');
    });
  });
});

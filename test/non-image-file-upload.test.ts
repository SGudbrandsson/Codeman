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

import { describe, it, expect, vi } from 'vitest';

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

  // ---------------------------------------------------------------------------
  // NEW: _uploadNonImageFiles logic
  // ---------------------------------------------------------------------------

  describe('_uploadNonImageFiles — fetch to /api/sessions/:id/upload', () => {
    /**
     * Simulates the core logic of _uploadNonImageFiles:
     * - pushes entry to _files with uploading:true
     * - calls fetch, on success updates entry
     * - on failure removes entry from _files
     * - always increments/decrements uploadingCount
     */
    async function simulateUploadNonImageFiles(
      files: { name: string }[],
      activeSessionId: string | null,
      fetchImpl: (
        url: string,
        init: RequestInit
      ) => Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }>
    ) {
      if (!files.length || !activeSessionId) return { filesArray: [], uploadingCount: 0, errors: [] };

      const _files: { filename: string; path: string | null; uploading: boolean }[] = [];
      let uploadingCount = 0;
      const errors: string[] = [];

      for (const file of files) {
        const entry = { filename: file.name, path: null as string | null, uploading: true };
        _files.push(entry);
        uploadingCount++;

        try {
          const res = await fetchImpl(`/api/sessions/${activeSessionId}/upload`, {
            method: 'POST',
            body: new FormData(),
          });
          const data = await res.json();
          if (!data.success) throw new Error((data.error as string) || 'Upload failed');
          entry.path = data.path as string;
          entry.filename = data.filename as string;
          entry.uploading = false;
        } catch (err) {
          errors.push((err as Error).message);
          const idx = _files.indexOf(entry);
          if (idx !== -1) _files.splice(idx, 1);
        } finally {
          uploadingCount = Math.max(0, uploadingCount - 1);
        }
      }

      return { filesArray: _files, uploadingCount, errors };
    }

    it('populates _files array on successful upload', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          success: true,
          path: '/tmp/work/.codeman-uploads/report.pdf',
          filename: 'report.pdf',
          isImage: false,
        }),
      }));
      const result = await simulateUploadNonImageFiles([{ name: 'report.pdf' }], 'session-1', fetchImpl);
      expect(result.filesArray).toHaveLength(1);
      expect(result.filesArray[0].path).toBe('/tmp/work/.codeman-uploads/report.pdf');
      expect(result.filesArray[0].uploading).toBe(false);
    });

    it('calls fetch with correct URL containing session ID', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, path: '/tmp/f.txt', filename: 'f.txt', isImage: false }),
      }));
      await simulateUploadNonImageFiles([{ name: 'f.txt' }], 'abc-123', fetchImpl);
      expect(fetchImpl).toHaveBeenCalledWith(
        '/api/sessions/abc-123/upload',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('removes entry from _files on upload failure', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: false, error: 'Session has no working directory' }),
      }));
      const result = await simulateUploadNonImageFiles([{ name: 'data.csv' }], 'session-1', fetchImpl);
      expect(result.filesArray).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('working directory');
    });

    it('decrements uploadingCount even on failure', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('Network error');
      });
      const result = await simulateUploadNonImageFiles([{ name: 'file.txt' }], 'session-1', fetchImpl);
      expect(result.uploadingCount).toBe(0);
    });

    it('does nothing when no active session', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true }),
      }));
      const result = await simulateUploadNonImageFiles([{ name: 'file.txt' }], null, fetchImpl);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.filesArray).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // NEW: send() file reference prepend
  // ---------------------------------------------------------------------------

  describe('send() — [Attached file:] prepend logic', () => {
    /**
     * Replicates the file reference prepend logic from send():
     *   const attachedFiles = _files.filter(f => f.path);
     *   const fileRefs = attachedFiles.map(f => `[Attached file: ${f.path}]`).join('\n');
     *   sendText = fileRefs + (sendText ? '\n' + sendText : '');
     */
    function buildSendText(text: string, files: { path: string | null }[]): string {
      const attachedFiles = files.filter((f) => f.path);
      if (!attachedFiles.length) return text;
      const fileRefs = attachedFiles.map((f) => `[Attached file: ${f.path}]`).join('\n');
      return fileRefs + (text ? '\n' + text : '');
    }

    it('prepends single file reference before user text', () => {
      const result = buildSendText('Analyze this', [{ path: '/tmp/.codeman-uploads/report.pdf' }]);
      expect(result).toBe('[Attached file: /tmp/.codeman-uploads/report.pdf]\nAnalyze this');
    });

    it('prepends multiple file references, each on its own line', () => {
      const result = buildSendText('Review these files', [
        { path: '/tmp/.codeman-uploads/a.txt' },
        { path: '/tmp/.codeman-uploads/b.js' },
      ]);
      expect(result).toBe(
        '[Attached file: /tmp/.codeman-uploads/a.txt]\n[Attached file: /tmp/.codeman-uploads/b.js]\nReview these files'
      );
    });

    it('sends only file references when user text is empty', () => {
      const result = buildSendText('', [{ path: '/tmp/.codeman-uploads/data.csv' }]);
      expect(result).toBe('[Attached file: /tmp/.codeman-uploads/data.csv]');
    });

    it('skips files with null path (still uploading)', () => {
      const result = buildSendText('Hello', [{ path: '/tmp/.codeman-uploads/done.txt' }, { path: null }]);
      expect(result).toBe('[Attached file: /tmp/.codeman-uploads/done.txt]\nHello');
    });

    it('returns plain text when no files attached', () => {
      const result = buildSendText('Just text', []);
      expect(result).toBe('Just text');
    });
  });

  // ---------------------------------------------------------------------------
  // NEW: _renderThumbnails with _files
  // ---------------------------------------------------------------------------

  describe('_renderThumbnails — non-image file entries', () => {
    /**
     * Replicates the per-file rendering logic from _renderThumbnails.
     * Returns a description of what would be rendered for each file entry.
     */
    function describeFileThumb(file: { filename: string; path: string | null; uploading: boolean }) {
      const ext = file.filename.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toUpperCase() || '';
      return {
        className: 'compose-thumb compose-thumb-file',
        extensionBadge: ext || '\ud83d\udcc4', // fallback to document emoji
        label: file.uploading ? 'Uploading\u2026' : file.filename,
        hasRemoveButton: true,
        ariaLabel: 'Remove file',
      };
    }

    it('renders extension badge from filename', () => {
      const thumb = describeFileThumb({ filename: 'report.pdf', path: '/tmp/report.pdf', uploading: false });
      expect(thumb.extensionBadge).toBe('PDF');
      expect(thumb.label).toBe('report.pdf');
    });

    it('renders JS extension for .js files', () => {
      const thumb = describeFileThumb({ filename: 'index.js', path: '/tmp/index.js', uploading: false });
      expect(thumb.extensionBadge).toBe('JS');
    });

    it('shows "Uploading..." label while file is uploading', () => {
      const thumb = describeFileThumb({ filename: 'data.csv', path: null, uploading: true });
      expect(thumb.label).toBe('Uploading\u2026');
    });

    it('shows document emoji when filename has no extension', () => {
      const thumb = describeFileThumb({ filename: 'Makefile', path: '/tmp/Makefile', uploading: false });
      expect(thumb.extensionBadge).toBe('\ud83d\udcc4');
    });

    it('includes remove button with correct aria-label', () => {
      const thumb = describeFileThumb({ filename: 'notes.txt', path: '/tmp/notes.txt', uploading: false });
      expect(thumb.hasRemoveButton).toBe(true);
      expect(thumb.ariaLabel).toBe('Remove file');
    });

    it('uses compose-thumb-file CSS class', () => {
      const thumb = describeFileThumb({ filename: 'x.py', path: '/tmp/x.py', uploading: false });
      expect(thumb.className).toContain('compose-thumb-file');
    });
  });
});

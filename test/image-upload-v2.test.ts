/**
 * @fileoverview Tests for image-upload-v2 fixes
 *
 * Covers four areas:
 *   1. Extension-based image detection (_isImage / _looksLikeImage helpers)
 *   2. VoiceInput offset-based interim text clear
 *   3. Paste handler clipboardData.files fallback routing
 *   4. Boundary quote stripping (tested in multipart-boundary-trim.test.ts)
 *
 * Because app.js and voice-input.js are browser bundles (no exports), the logic
 * is replicated here as pure functions matching the exact expressions in source.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// 1. Extension-based image detection
// ---------------------------------------------------------------------------

/**
 * Replicates _isImage from _onFilesChosen (app.js ~line 20673):
 *
 *   const _imageExts = /\.(png|jpe?g|webp|gif|bmp|svg|ico|tiff?)$/i;
 *   const _isImage = (f) => f.type.startsWith('image/') || (!f.type && f.name && _imageExts.test(f.name));
 */
function isImage(f: { type: string; name: string }): boolean {
  const _imageExts = /\.(png|jpe?g|webp|gif|bmp|svg|ico|tiff?)$/i;
  return f.type.startsWith('image/') || (!f.type && !!f.name && _imageExts.test(f.name));
}

/**
 * Replicates _looksLikeImage from paste handler (app.js ~line 5167):
 *
 *   const _looksLikeImage = (f) => f.type.startsWith('image/') || (!f.type && (!f.name || _imageExts.test(f.name)));
 *
 * More permissive than _isImage: treats no-type + no-name as image (clipboard paste).
 */
function looksLikeImage(f: { type: string; name: string }): boolean {
  const _imageExts = /\.(png|jpe?g|webp|gif|bmp|svg|ico|tiff?)$/i;
  return f.type.startsWith('image/') || (!f.type && (!f.name || _imageExts.test(f.name)));
}

describe('Extension-based image detection (_isImage)', () => {
  it('recognizes files with image/ MIME type', () => {
    expect(isImage({ type: 'image/png', name: 'photo.png' })).toBe(true);
    expect(isImage({ type: 'image/jpeg', name: 'photo.jpg' })).toBe(true);
    expect(isImage({ type: 'image/webp', name: 'photo.webp' })).toBe(true);
  });

  it('recognizes files with empty type but image extension', () => {
    expect(isImage({ type: '', name: 'screenshot.png' })).toBe(true);
    expect(isImage({ type: '', name: 'photo.jpg' })).toBe(true);
    expect(isImage({ type: '', name: 'photo.jpeg' })).toBe(true);
    expect(isImage({ type: '', name: 'image.webp' })).toBe(true);
    expect(isImage({ type: '', name: 'anim.gif' })).toBe(true);
    expect(isImage({ type: '', name: 'icon.bmp' })).toBe(true);
    expect(isImage({ type: '', name: 'icon.ico' })).toBe(true);
    expect(isImage({ type: '', name: 'scan.tif' })).toBe(true);
    expect(isImage({ type: '', name: 'scan.tiff' })).toBe(true);
  });

  it('rejects files with empty type and non-image extension', () => {
    expect(isImage({ type: '', name: 'document.pdf' })).toBe(false);
    expect(isImage({ type: '', name: 'archive.zip' })).toBe(false);
    expect(isImage({ type: '', name: 'script.js' })).toBe(false);
  });

  it('rejects files with empty type and no name', () => {
    // _isImage requires f.name to be truthy when type is empty
    expect(isImage({ type: '', name: '' })).toBe(false);
  });

  it('rejects non-image MIME types regardless of extension', () => {
    expect(isImage({ type: 'application/pdf', name: 'doc.pdf' })).toBe(false);
    expect(isImage({ type: 'text/plain', name: 'notes.txt' })).toBe(false);
  });

  it('extension check is case-insensitive', () => {
    expect(isImage({ type: '', name: 'PHOTO.PNG' })).toBe(true);
    expect(isImage({ type: '', name: 'Image.JPG' })).toBe(true);
    expect(isImage({ type: '', name: 'pic.WebP' })).toBe(true);
  });
});

describe('Extension-based image detection (_looksLikeImage, paste handler)', () => {
  it('treats no-type + no-name as image (clipboard paste)', () => {
    // Clipboard paste files often have neither type nor name
    expect(looksLikeImage({ type: '', name: '' })).toBe(true);
  });

  it('treats no-type + image extension as image', () => {
    expect(looksLikeImage({ type: '', name: 'screenshot.png' })).toBe(true);
  });

  it('rejects no-type + non-image extension', () => {
    expect(looksLikeImage({ type: '', name: 'document.pdf' })).toBe(false);
  });

  it('recognizes standard image MIME types', () => {
    expect(looksLikeImage({ type: 'image/png', name: '' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. VoiceInput offset-based interim text clear
// ---------------------------------------------------------------------------

/**
 * Replicates _showInterimInCompose + _clearInterimFromCompose from voice-input.js.
 * State is managed externally to match the VoiceInput singleton pattern.
 */
interface InterimState {
  lastInterimLength: number;
  interimInsertOffset: number | undefined;
}

function showInterim(taValue: string, text: string, state: InterimState): string {
  const interimText = text.trim();
  if (!interimText) return taValue;
  const spacer = taValue && !taValue.endsWith(' ') ? ' ' : '';
  state.interimInsertOffset = taValue.length;
  const newValue = taValue + spacer + interimText;
  state.lastInterimLength = spacer.length + interimText.length;
  return newValue;
}

function clearInterim(taValue: string, state: InterimState): string {
  if (state.lastInterimLength <= 0) return taValue;
  const offset = state.interimInsertOffset ?? taValue.length - state.lastInterimLength;
  let result: string;
  if (offset >= 0 && offset + state.lastInterimLength <= taValue.length) {
    result = taValue.slice(0, offset) + taValue.slice(offset + state.lastInterimLength);
  } else {
    result = taValue.slice(0, -state.lastInterimLength);
  }
  state.lastInterimLength = 0;
  state.interimInsertOffset = undefined;
  return result;
}

describe('VoiceInput offset-based interim text clear', () => {
  it('removes interim text when no user typing occurred', () => {
    const state: InterimState = { lastInterimLength: 0, interimInsertOffset: undefined };
    let value = 'Hello';
    value = showInterim(value, 'world', state);
    expect(value).toBe('Hello world');
    value = clearInterim(value, state);
    expect(value).toBe('Hello');
  });

  it('removes interim text even when user typed after it', () => {
    const state: InterimState = { lastInterimLength: 0, interimInsertOffset: undefined };
    let value = 'Hello';
    value = showInterim(value, 'interim', state);
    expect(value).toBe('Hello interim');
    // User types " extra" after interim (simulating manual keyboard input)
    value += ' extra';
    value = clearInterim(value, state);
    // Should remove " interim" but keep " extra"
    expect(value).toBe('Hello extra');
  });

  it('handles empty initial textarea', () => {
    const state: InterimState = { lastInterimLength: 0, interimInsertOffset: undefined };
    let value = '';
    value = showInterim(value, 'hello', state);
    expect(value).toBe('hello');
    value = clearInterim(value, state);
    expect(value).toBe('');
  });

  it('adds spacer when textarea does not end with space', () => {
    const state: InterimState = { lastInterimLength: 0, interimInsertOffset: undefined };
    let value = 'Hello';
    value = showInterim(value, 'there', state);
    expect(value).toBe('Hello there');
    expect(state.lastInterimLength).toBe(6); // ' there' = space + 5 chars
  });

  it('no spacer when textarea ends with space', () => {
    const state: InterimState = { lastInterimLength: 0, interimInsertOffset: undefined };
    let value = 'Hello ';
    value = showInterim(value, 'there', state);
    expect(value).toBe('Hello there');
    expect(state.lastInterimLength).toBe(5); // 'there' = 5 chars, no spacer
  });

  it('falls back to end-slice when offset is invalid', () => {
    const state: InterimState = { lastInterimLength: 5, interimInsertOffset: 999 };
    // offset 999 + length 5 > value.length, so fallback kicks in
    const value = 'Hello world';
    const result = clearInterim(value, state);
    expect(result).toBe('Hello '); // removes last 5 chars 'world'
  });

  it('handles sequential interim updates (clear + new interim)', () => {
    const state: InterimState = { lastInterimLength: 0, interimInsertOffset: undefined };
    let value = 'Base';
    value = showInterim(value, 'first', state);
    expect(value).toBe('Base first');
    value = clearInterim(value, state);
    expect(value).toBe('Base');
    value = showInterim(value, 'second', state);
    expect(value).toBe('Base second');
    value = clearInterim(value, state);
    expect(value).toBe('Base');
  });

  it('no-op when lastInterimLength is 0', () => {
    const state: InterimState = { lastInterimLength: 0, interimInsertOffset: undefined };
    const result = clearInterim('Hello', state);
    expect(result).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// 3. Paste handler clipboardData.files fallback routing
// ---------------------------------------------------------------------------

interface FakeFile {
  type: string;
  name: string;
}
interface FakeItem {
  kind: string;
  type: string;
  getAsFile: () => FakeFile | null;
}

/**
 * Replicates the paste handler's file classification and fallback routing logic.
 * Returns { imageFiles, nonImageFiles } after running through all fallback paths.
 */
function classifyPasteFiles(
  fileItems: FakeItem[],
  cdFiles: FakeFile[],
  clipboardApiFallback: FakeFile[] = []
): { imageFiles: FakeFile[]; nonImageFiles: FakeFile[] } {
  const _imageExts = /\.(png|jpe?g|webp|gif|bmp|svg|ico|tiff?)$/i;
  const _looksLikeImage = (f: FakeFile) =>
    f.type.startsWith('image/') || (!f.type && (!f.name || _imageExts.test(f.name)));

  const imageItems = fileItems.filter((it) => it.type.startsWith('image/') || !it.type);
  const nonImageItems = fileItems.filter((it) => it.type && !it.type.startsWith('image/'));
  const imageFiles: FakeFile[] = imageItems.map((it) => it.getAsFile()).filter(Boolean) as FakeFile[];
  const nonImageFiles: FakeFile[] = nonImageItems.map((it) => it.getAsFile()).filter(Boolean) as FakeFile[];

  // Fallback 1: clipboardData.files
  if (imageFiles.length === 0 && cdFiles.length > 0) {
    const cdImageFiles = cdFiles.filter((f) => _looksLikeImage(f));
    const cdNonImageFiles = cdFiles.filter((f) => !_looksLikeImage(f));
    imageFiles.push(...cdImageFiles);
    nonImageFiles.push(...cdNonImageFiles);
  }

  // Fallback 2: Clipboard API
  if (imageFiles.length === 0 && (imageItems.length > 0 || cdFiles.length > 0)) {
    imageFiles.push(...clipboardApiFallback);
  }

  return { imageFiles, nonImageFiles };
}

describe('Paste handler clipboardData.files fallback routing', () => {
  it('uses getAsFile() when it returns a file', () => {
    const file: FakeFile = { type: 'image/png', name: 'shot.png' };
    const items: FakeItem[] = [{ kind: 'file', type: 'image/png', getAsFile: () => file }];
    const result = classifyPasteFiles(items, []);
    expect(result.imageFiles).toEqual([file]);
    expect(result.nonImageFiles).toEqual([]);
  });

  it('falls back to cdFiles when getAsFile() returns null', () => {
    const items: FakeItem[] = [{ kind: 'file', type: 'image/png', getAsFile: () => null }];
    const cdFile: FakeFile = { type: 'image/png', name: 'clipboard.png' };
    const result = classifyPasteFiles(items, [cdFile]);
    expect(result.imageFiles).toEqual([cdFile]);
  });

  it('processes cdFiles when fileItems is empty', () => {
    const cdFile: FakeFile = { type: 'image/png', name: 'clipboard.png' };
    const result = classifyPasteFiles([], [cdFile]);
    expect(result.imageFiles).toEqual([cdFile]);
  });

  it('classifies cdFiles with empty type as images (clipboard paste)', () => {
    const cdFile: FakeFile = { type: '', name: '' };
    const result = classifyPasteFiles([], [cdFile]);
    expect(result.imageFiles).toEqual([cdFile]);
  });

  it('classifies cdFiles with non-image type as non-image', () => {
    const cdFile: FakeFile = { type: 'application/pdf', name: 'doc.pdf' };
    const result = classifyPasteFiles([], [cdFile]);
    expect(result.imageFiles).toEqual([]);
    expect(result.nonImageFiles).toEqual([cdFile]);
  });

  it('falls back to Clipboard API when cdFiles also has no images', () => {
    const items: FakeItem[] = [{ kind: 'file', type: 'image/png', getAsFile: () => null }];
    const apiFile: FakeFile = { type: 'image/png', name: 'clipboard.png' };
    const result = classifyPasteFiles(items, [], [apiFile]);
    expect(result.imageFiles).toEqual([apiFile]);
  });

  it('does not trigger Clipboard API fallback when getAsFile() succeeded', () => {
    const file: FakeFile = { type: 'image/png', name: 'shot.png' };
    const items: FakeItem[] = [{ kind: 'file', type: 'image/png', getAsFile: () => file }];
    const apiFile: FakeFile = { type: 'image/png', name: 'clipboard.png' };
    const result = classifyPasteFiles(items, [], [apiFile]);
    // Should NOT include the API fallback file
    expect(result.imageFiles).toEqual([file]);
  });

  it('does not trigger Clipboard API fallback when cdFiles succeeded', () => {
    const items: FakeItem[] = [{ kind: 'file', type: 'image/png', getAsFile: () => null }];
    const cdFile: FakeFile = { type: 'image/png', name: 'clipboard.png' };
    const apiFile: FakeFile = { type: 'image/png', name: 'api.png' };
    const result = classifyPasteFiles(items, [cdFile], [apiFile]);
    expect(result.imageFiles).toEqual([cdFile]);
  });

  it('separates image and non-image files from items', () => {
    const imgFile: FakeFile = { type: 'image/png', name: 'shot.png' };
    const pdfFile: FakeFile = { type: 'application/pdf', name: 'doc.pdf' };
    const items: FakeItem[] = [
      { kind: 'file', type: 'image/png', getAsFile: () => imgFile },
      { kind: 'file', type: 'application/pdf', getAsFile: () => pdfFile },
    ];
    const result = classifyPasteFiles(items, []);
    expect(result.imageFiles).toEqual([imgFile]);
    expect(result.nonImageFiles).toEqual([pdfFile]);
  });
});

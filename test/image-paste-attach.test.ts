/**
 * @fileoverview Tests for image paste/attach fixes in app.js
 *
 * Covers three areas of the clipboard paste flow:
 *   Gap 2: readImagesFromClipboardAPI() — new async Clipboard API reader
 *   Gap 3: CommandPanel._onPaste() — empty MIME, null getAsFile, fallback + toast
 *   Gap 4: Global paste handler — same edge cases at the document level
 *
 * Because app.js is a browser bundle (no exports), the logic is replicated
 * here as pure functions matching the exact expressions in the source.
 * This mirrors the approach used in paste-newline-routing.test.ts and
 * photo-upload-fixes.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Gap 2: readImagesFromClipboardAPI() — replicated from app.js ~line 2238
// ---------------------------------------------------------------------------

interface ClipboardItemLike {
  types: string[];
  getType: (mime: string) => Promise<Blob>;
}

interface NavigatorClipboardLike {
  read: () => Promise<ClipboardItemLike[]>;
}

/**
 * Replicates readImagesFromClipboardAPI() from app.js:
 *
 *   async function readImagesFromClipboardAPI() {
 *     const files = [];
 *     try {
 *       if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
 *         const clipItems = await navigator.clipboard.read();
 *         for (const ci of clipItems) {
 *           for (const mimeType of ci.types) {
 *             if (mimeType.startsWith('image/')) {
 *               const blob = await ci.getType(mimeType);
 *               const ext = mimeType.split('/')[1] || 'png';
 *               files.push({ name: `clipboard.${ext}`, type: mimeType, blob });
 *             }
 *           }
 *         }
 *       }
 *     } catch (clipErr) {
 *       warnLog.push(clipErr);
 *     }
 *     return files;
 *   }
 */
async function readImagesFromClipboardAPI(
  clipboard: NavigatorClipboardLike | undefined,
  warnLog: unknown[] = []
): Promise<{ name: string; type: string; blob: Blob }[]> {
  const files: { name: string; type: string; blob: Blob }[] = [];
  try {
    if (clipboard && typeof clipboard.read === 'function') {
      const clipItems = await clipboard.read();
      for (const ci of clipItems) {
        for (const mimeType of ci.types) {
          if (mimeType.startsWith('image/')) {
            const blob = await ci.getType(mimeType);
            const ext = mimeType.split('/')[1] || 'png';
            files.push({ name: `clipboard.${ext}`, type: mimeType, blob });
          }
        }
      }
    }
  } catch (clipErr) {
    warnLog.push(clipErr);
  }
  return files;
}

describe('readImagesFromClipboardAPI (Gap 2)', () => {
  it('returns File objects for clipboard items with image MIME types', async () => {
    const mockBlob = new Blob(['png-data'], { type: 'image/png' });
    const clipboard: NavigatorClipboardLike = {
      read: async () => [
        {
          types: ['image/png'],
          getType: async () => mockBlob,
        },
      ],
    };
    const files = await readImagesFromClipboardAPI(clipboard);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('clipboard.png');
    expect(files[0].type).toBe('image/png');
    expect(files[0].blob).toBe(mockBlob);
  });

  it('returns empty array when clipboard is empty', async () => {
    const clipboard: NavigatorClipboardLike = {
      read: async () => [],
    };
    const files = await readImagesFromClipboardAPI(clipboard);
    expect(files).toHaveLength(0);
  });

  it('returns empty array when clipboard API is unavailable', async () => {
    const files = await readImagesFromClipboardAPI(undefined);
    expect(files).toHaveLength(0);
  });

  it('returns empty array and logs warning when clipboard API throws (permission denied)', async () => {
    const clipboard: NavigatorClipboardLike = {
      read: async () => {
        throw new DOMException('Clipboard read blocked', 'NotAllowedError');
      },
    };
    const warnLog: unknown[] = [];
    const files = await readImagesFromClipboardAPI(clipboard, warnLog);
    expect(files).toHaveLength(0);
    expect(warnLog).toHaveLength(1);
    expect((warnLog[0] as DOMException).name).toBe('NotAllowedError');
  });

  it('skips non-image MIME types in clipboard items', async () => {
    const clipboard: NavigatorClipboardLike = {
      read: async () => [
        {
          types: ['text/plain', 'image/jpeg'],
          getType: async (mime: string) => new Blob(['data'], { type: mime }),
        },
      ],
    };
    const files = await readImagesFromClipboardAPI(clipboard);
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe('image/jpeg');
    expect(files[0].name).toBe('clipboard.jpeg');
  });
});

// ---------------------------------------------------------------------------
// Gap 3: CommandPanel._onPaste() — replicated from app.js ~line 2660
// ---------------------------------------------------------------------------

interface PasteItem {
  type: string;
  kind: string;
  getAsFile: () => { name: string } | null;
}

interface OnPasteResult {
  gotFile: boolean;
  hadImageItem: boolean;
  preventDefaultCalled: boolean;
  filesProcessed: { name: string }[];
  fallbackAttempted: boolean;
  toastShown: boolean;
}

/**
 * Replicates CommandPanel._onPaste() logic from app.js ~line 2660-2696.
 *
 * The key conditions:
 *   item.type.startsWith('image/') || (item.kind === 'file' && !item.type)
 *   → hadImageItem = true, e.preventDefault()
 *   → file = item.getAsFile(); if (!file) continue;
 *   → gotFile = true, process file
 *
 * Fallback when hadImageItem && !gotFile:
 *   → try readImagesFromClipboardAPI()
 *   → if still no files, show toast
 */
async function simulateOnPaste(
  items: PasteItem[],
  clipboardFallbackFiles: { name: string }[] = []
): Promise<OnPasteResult> {
  let gotFile = false;
  let hadImageItem = false;
  let preventDefaultCalled = false;
  const filesProcessed: { name: string }[] = [];
  let fallbackAttempted = false;
  let toastShown = false;

  for (const item of items) {
    if (item.type.startsWith('image/') || (item.kind === 'file' && !item.type)) {
      hadImageItem = true;
      preventDefaultCalled = true;
      const file = item.getAsFile();
      if (!file) continue;
      gotFile = true;
      filesProcessed.push(file);
    }
  }

  // Fallback: if items had images but getAsFile() returned null, try Clipboard API
  if (hadImageItem && !gotFile) {
    fallbackAttempted = true;
    for (const file of clipboardFallbackFiles) {
      filesProcessed.push(file);
      gotFile = true;
    }
    if (!gotFile) {
      toastShown = true;
    }
  }

  return { gotFile, hadImageItem, preventDefaultCalled, filesProcessed, fallbackAttempted, toastShown };
}

describe('CommandPanel._onPaste (Gap 3)', () => {
  it('treats items with empty MIME type as images (kind === "file" && !type)', async () => {
    const items: PasteItem[] = [{ type: '', kind: 'file', getAsFile: () => ({ name: 'screenshot.png' }) }];
    const result = await simulateOnPaste(items);
    expect(result.hadImageItem).toBe(true);
    expect(result.gotFile).toBe(true);
    expect(result.filesProcessed).toHaveLength(1);
    expect(result.preventDefaultCalled).toBe(true);
  });

  it('triggers clipboard API fallback when getAsFile() returns null', async () => {
    const items: PasteItem[] = [{ type: 'image/png', kind: 'file', getAsFile: () => null }];
    const fallbackFiles = [{ name: 'clipboard.png' }];
    const result = await simulateOnPaste(items, fallbackFiles);
    expect(result.hadImageItem).toBe(true);
    expect(result.fallbackAttempted).toBe(true);
    expect(result.gotFile).toBe(true);
    expect(result.filesProcessed).toEqual([{ name: 'clipboard.png' }]);
  });

  it('shows toast when both getAsFile() and clipboard fallback fail', async () => {
    const items: PasteItem[] = [{ type: 'image/png', kind: 'file', getAsFile: () => null }];
    const result = await simulateOnPaste(items, []); // empty fallback
    expect(result.hadImageItem).toBe(true);
    expect(result.fallbackAttempted).toBe(true);
    expect(result.gotFile).toBe(false);
    expect(result.toastShown).toBe(true);
  });

  it('processes normal image paste without fallback (happy path)', async () => {
    const items: PasteItem[] = [{ type: 'image/png', kind: 'file', getAsFile: () => ({ name: 'photo.png' }) }];
    const result = await simulateOnPaste(items);
    expect(result.gotFile).toBe(true);
    expect(result.fallbackAttempted).toBe(false);
    expect(result.toastShown).toBe(false);
    expect(result.filesProcessed).toEqual([{ name: 'photo.png' }]);
  });
});

// ---------------------------------------------------------------------------
// Gap 4: Global paste handler — replicated from app.js ~line 5152
// ---------------------------------------------------------------------------

interface GlobalPasteItem {
  type: string;
  kind: string;
  getAsFile: () => { name: string } | null;
}

interface GlobalPasteResult {
  preventDefaultCalled: boolean;
  routedToCommandPanel: boolean;
  imageFiles: { name: string }[];
  nonImageFiles: { name: string }[];
  fallbackAttempted: boolean;
  toastShown: boolean;
  inputPanelOpened: boolean;
}

/**
 * Replicates the global paste handler from app.js ~line 5152-5188.
 *
 * Key logic:
 *   const fileItems = items.filter(it => it.kind === 'file');
 *   if (!fileItems.length) return;  // no files, let text paste proceed
 *   e.preventDefault(); e.stopPropagation();
 *   if (CommandPanel open) → route to _onPaste
 *   else:
 *     imageItems = fileItems.filter(it => it.type.startsWith('image/') || !it.type)
 *     nonImageItems = fileItems.filter(it => it.type && !it.type.startsWith('image/'))
 *     imageFiles = imageItems.map(it => it.getAsFile()).filter(Boolean)
 *     if (imageItems.length > 0 && imageFiles.length === 0) → fallback → toast
 */
async function simulateGlobalPaste(
  items: GlobalPasteItem[],
  commandPanelOpen: boolean,
  clipboardFallbackFiles: { name: string }[] = []
): Promise<GlobalPasteResult> {
  let preventDefaultCalled = false;
  let routedToCommandPanel = false;
  let fallbackAttempted = false;
  let toastShown = false;
  let inputPanelOpened = false;
  let imageFiles: { name: string }[] = [];
  let nonImageFiles: { name: string }[] = [];

  const fileItems = items.filter((it) => it.kind === 'file');
  if (!fileItems.length) {
    return {
      preventDefaultCalled,
      routedToCommandPanel,
      imageFiles,
      nonImageFiles,
      fallbackAttempted,
      toastShown,
      inputPanelOpened,
    };
  }

  preventDefaultCalled = true;

  if (commandPanelOpen) {
    routedToCommandPanel = true;
    return {
      preventDefaultCalled,
      routedToCommandPanel,
      imageFiles,
      nonImageFiles,
      fallbackAttempted,
      toastShown,
      inputPanelOpened,
    };
  }

  // Treat items with empty MIME type as potential images
  const imageItems = fileItems.filter((it) => it.type.startsWith('image/') || !it.type);
  const nonImageItems = fileItems.filter((it) => it.type && !it.type.startsWith('image/'));
  imageFiles = imageItems.map((it) => it.getAsFile()).filter(Boolean) as { name: string }[];
  nonImageFiles = nonImageItems.map((it) => it.getAsFile()).filter(Boolean) as { name: string }[];

  // Fallback: if getAsFile() returned null for all image items
  if (imageItems.length > 0 && imageFiles.length === 0) {
    fallbackAttempted = true;
    imageFiles.push(...clipboardFallbackFiles);
    if (imageFiles.length === 0) {
      toastShown = true;
    }
  }

  if (imageFiles.length || nonImageFiles.length) {
    inputPanelOpened = true;
  }

  return {
    preventDefaultCalled,
    routedToCommandPanel,
    imageFiles,
    nonImageFiles,
    fallbackAttempted,
    toastShown,
    inputPanelOpened,
  };
}

describe('Global paste handler (Gap 4)', () => {
  it('classifies file items with empty MIME type as image candidates', async () => {
    const items: GlobalPasteItem[] = [{ type: '', kind: 'file', getAsFile: () => ({ name: 'screenshot.png' }) }];
    const result = await simulateGlobalPaste(items, false);
    expect(result.imageFiles).toHaveLength(1);
    expect(result.imageFiles[0].name).toBe('screenshot.png');
    expect(result.nonImageFiles).toHaveLength(0);
  });

  it('uses fallback when getAsFile() returns null for all image items', async () => {
    const items: GlobalPasteItem[] = [{ type: 'image/png', kind: 'file', getAsFile: () => null }];
    const fallbackFiles = [{ name: 'clipboard.png' }];
    const result = await simulateGlobalPaste(items, false, fallbackFiles);
    expect(result.fallbackAttempted).toBe(true);
    expect(result.imageFiles).toHaveLength(1);
    expect(result.toastShown).toBe(false);
  });

  it('shows toast when both getAsFile() and fallback fail', async () => {
    const items: GlobalPasteItem[] = [{ type: 'image/png', kind: 'file', getAsFile: () => null }];
    const result = await simulateGlobalPaste(items, false, []);
    expect(result.fallbackAttempted).toBe(true);
    expect(result.toastShown).toBe(true);
    expect(result.imageFiles).toHaveLength(0);
  });

  it('routes to CommandPanel._onPaste when panel is open', async () => {
    const items: GlobalPasteItem[] = [{ type: 'image/png', kind: 'file', getAsFile: () => ({ name: 'photo.png' }) }];
    const result = await simulateGlobalPaste(items, true);
    expect(result.routedToCommandPanel).toBe(true);
    expect(result.preventDefaultCalled).toBe(true);
  });

  it('routes to InputPanel when CommandPanel is closed', async () => {
    const items: GlobalPasteItem[] = [{ type: 'image/png', kind: 'file', getAsFile: () => ({ name: 'photo.png' }) }];
    const result = await simulateGlobalPaste(items, false);
    expect(result.routedToCommandPanel).toBe(false);
    expect(result.inputPanelOpened).toBe(true);
    expect(result.imageFiles).toHaveLength(1);
  });

  it('separates image and non-image files correctly', async () => {
    const items: GlobalPasteItem[] = [
      { type: 'image/png', kind: 'file', getAsFile: () => ({ name: 'photo.png' }) },
      { type: 'application/pdf', kind: 'file', getAsFile: () => ({ name: 'doc.pdf' }) },
    ];
    const result = await simulateGlobalPaste(items, false);
    expect(result.imageFiles).toHaveLength(1);
    expect(result.imageFiles[0].name).toBe('photo.png');
    expect(result.nonImageFiles).toHaveLength(1);
    expect(result.nonImageFiles[0].name).toBe('doc.pdf');
  });

  it('does nothing for non-file items (text paste proceeds normally)', async () => {
    const items: GlobalPasteItem[] = [{ type: 'text/plain', kind: 'string', getAsFile: () => null }];
    const result = await simulateGlobalPaste(items, false);
    expect(result.preventDefaultCalled).toBe(false);
    expect(result.imageFiles).toHaveLength(0);
  });
});

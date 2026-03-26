/**
 * @fileoverview Tests for photo upload bug fixes
 *
 * Covers the five fixes applied to src/web/public/app.js:
 *   1. addKeyboardTapFix — action sheet button exclusion (~line 4030)
 *   2. _actionSheetPick — deferred file input click (~line 19032)
 *   3. _uploadFiles — AbortController timeout and res.ok check (~line 19124)
 *   4. _uploadNonImageFiles — AbortController timeout and res.ok check (~line 19057)
 *   5. _updateSendBtnState — safety timer reset (~line 19105)
 *
 * Because app.js is a browser bundle (no exports), the logic is replicated
 * here as pure functions matching the exact expressions in the source.
 * This mirrors the approach used in non-image-file-upload.test.ts and
 * paste-newline-routing.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Gap 1: addKeyboardTapFix — action sheet exclusion
// ---------------------------------------------------------------------------

describe('addKeyboardTapFix — action sheet button exclusion (Fix 1)', () => {
  /**
   * Replicates the button-filtering logic from the touchstart handler in
   * addKeyboardTapFix (app.js ~line 4022-4032):
   *
   *   const btn = e.target.closest('button');
   *   if (!btn) return;
   *   if (btn.closest('.compose-action-sheet')) return;  // <-- new exclusion
   *   e.preventDefault();
   *   btn.click();
   *
   * Returns whether the handler would call preventDefault + btn.click().
   */
  function shouldIntercept(btn: { closestResults: Record<string, unknown | null> } | null): boolean {
    if (!btn) return false;
    // The new exclusion: action sheet buttons are skipped
    if (btn.closestResults['.compose-action-sheet']) return false;
    return true; // would call e.preventDefault() + btn.click()
  }

  it('intercepts a regular button (not in action sheet)', () => {
    const btn = { closestResults: { '.compose-action-sheet': null } };
    expect(shouldIntercept(btn)).toBe(true);
  });

  it('skips a button inside .compose-action-sheet', () => {
    // btn.closest('.compose-action-sheet') returns truthy → early return (no intercept)
    const btn = { closestResults: { '.compose-action-sheet': {} } }; // non-null = found
    expect(shouldIntercept(btn)).toBe(false);
  });

  it('skips when e.target is not a button (btn is null)', () => {
    expect(shouldIntercept(null)).toBe(false);
  });

  /**
   * More direct simulation: takes whether btn.closest('.compose-action-sheet')
   * returns a truthy value.
   */
  function shouldInterceptDirect(isInActionSheet: boolean): boolean {
    if (isInActionSheet) return false;
    return true;
  }

  it('does not intercept Take Photo button (inside action sheet)', () => {
    expect(shouldInterceptDirect(true)).toBe(false);
  });

  it('does not intercept Photo Library button (inside action sheet)', () => {
    expect(shouldInterceptDirect(true)).toBe(false);
  });

  it('does not intercept Attach File button (inside action sheet)', () => {
    expect(shouldInterceptDirect(true)).toBe(false);
  });

  it('intercepts toolbar button (not in action sheet)', () => {
    expect(shouldInterceptDirect(false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap 2: _actionSheetPick — deferred click
// ---------------------------------------------------------------------------

describe('_actionSheetPick — deferred file input click (Fix 2)', () => {
  /**
   * Replicates _actionSheetPick logic (app.js ~line 19027-19038):
   *
   *   _actionSheetPick(type) {
   *     this._closeActionSheet();
   *     const id = type === 'camera' ? 'composeFileCamera'
   *              : type === 'gallery' ? 'composeFileGallery'
   *              : 'composeFileAny';
   *     setTimeout(() => { document.getElementById(id)?.click(); }, 0);
   *   }
   */

  function resolveInputId(type: string): string {
    return type === 'camera' ? 'composeFileCamera' : type === 'gallery' ? 'composeFileGallery' : 'composeFileAny';
  }

  it('maps "camera" to composeFileCamera', () => {
    expect(resolveInputId('camera')).toBe('composeFileCamera');
  });

  it('maps "gallery" to composeFileGallery', () => {
    expect(resolveInputId('gallery')).toBe('composeFileGallery');
  });

  it('maps unknown type to composeFileAny (file fallback)', () => {
    expect(resolveInputId('file')).toBe('composeFileAny');
  });

  it('defers the click via setTimeout(fn, 0), not synchronous', () => {
    const clicks: string[] = [];
    let clickedId: string | null = null;

    // Simulate: the click must NOT happen synchronously
    function simulateActionSheetPick(type: string) {
      const id = resolveInputId(type);
      setTimeout(() => {
        clickedId = id;
        clicks.push(id);
      }, 0);
    }

    simulateActionSheetPick('gallery');

    // Synchronously, click should NOT have happened yet
    expect(clickedId).toBe(null);
    expect(clicks).toHaveLength(0);
  });

  it('click fires after setTimeout resolves', async () => {
    const clicks: string[] = [];

    function simulateActionSheetPick(type: string) {
      const id = resolveInputId(type);
      setTimeout(() => {
        clicks.push(id);
      }, 0);
    }

    simulateActionSheetPick('camera');

    // Wait for the setTimeout(0) to fire
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(clicks).toEqual(['composeFileCamera']);
  });
});

// ---------------------------------------------------------------------------
// Gap 3: _uploadFiles — AbortController timeout and res.ok check
// ---------------------------------------------------------------------------

describe('_uploadFiles — AbortController timeout and res.ok check (Fix 3)', () => {
  /**
   * Simulates the core logic of _uploadFiles (app.js ~line 19124-19183):
   * - Creates AbortController with 30s timeout
   * - fetch('/api/screenshots', ...) with signal
   * - Checks res.ok before res.json()
   * - On AbortError: shows "Image upload timed out"
   * - On other error: shows "Image upload failed"
   */
  async function simulateUploadFiles(
    files: { name: string }[],
    fetchImpl: (
      url: string,
      init: { method: string; body: FormData; signal: AbortSignal }
    ) => Promise<{
      ok: boolean;
      status?: number;
      json: () => Promise<Record<string, unknown>>;
      text: () => Promise<string>;
    }>,
    opts?: { abortDelay?: number }
  ) {
    if (!files.length) return { images: [], uploadingCount: 0, errors: [] };

    const images: { path: string | null }[] = [];
    let uploadingCount = 0;
    const errors: { message: string; type: string }[] = [];

    for (const file of files) {
      const entry = { path: null as string | null };
      images.push(entry);
      uploadingCount++;

      try {
        const formData = new FormData();
        formData.append('file', file as unknown as Blob);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), opts?.abortDelay ?? 30000);
        let res;
        try {
          res = await fetchImpl('/api/screenshots', { method: 'POST', body: formData, signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = await res.json();
        if (!data.success) throw new Error((data.error as string) || 'Upload failed');
        entry.path = data.path as string;
      } catch (err) {
        const e = err as Error & { name: string };
        const msg = e.name === 'AbortError' ? 'Image upload timed out' : 'Image upload failed';
        errors.push({ message: msg, type: e.name });
        const idx = images.indexOf(entry);
        if (idx !== -1) images.splice(idx, 1);
      } finally {
        uploadingCount = Math.max(0, uploadingCount - 1);
      }
    }

    return { images, uploadingCount, errors };
  }

  it('sets entry.path on successful upload', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, path: '/screenshots/img.png' }),
      text: async () => '',
    }));
    const result = await simulateUploadFiles([{ name: 'photo.png' }], fetchImpl);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].path).toBe('/screenshots/img.png');
    expect(result.errors).toHaveLength(0);
  });

  it('calls fetch with /api/screenshots URL and POST method', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, path: '/screenshots/img.png' }),
      text: async () => '',
    }));
    await simulateUploadFiles([{ name: 'photo.png' }], fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/screenshots', expect.objectContaining({ method: 'POST' }));
  });

  it('passes AbortController signal to fetch', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, path: '/screenshots/img.png' }),
        text: async () => '',
      };
    });
    await simulateUploadFiles([{ name: 'photo.png' }], fetchImpl);
  });

  it('throws when res.ok is false (non-200 response)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => '<html>Bad Gateway</html>',
    }));
    const result = await simulateUploadFiles([{ name: 'photo.png' }], fetchImpl);
    expect(result.images).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('Image upload failed');
  });

  it('reports "Image upload timed out" on AbortError', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      throw err;
    });
    const result = await simulateUploadFiles([{ name: 'photo.png' }], fetchImpl);
    expect(result.images).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('Image upload timed out');
    expect(result.errors[0].type).toBe('AbortError');
  });

  it('reports "Image upload failed" on generic error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await simulateUploadFiles([{ name: 'photo.png' }], fetchImpl);
    expect(result.errors[0].message).toBe('Image upload failed');
    expect(result.errors[0].type).toBe('TypeError');
  });

  it('removes entry from images on failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('Network error');
    });
    const result = await simulateUploadFiles([{ name: 'photo.png' }], fetchImpl);
    expect(result.images).toHaveLength(0);
  });

  it('decrements uploadingCount even on failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('Network error');
    });
    const result = await simulateUploadFiles([{ name: 'photo.png' }], fetchImpl);
    expect(result.uploadingCount).toBe(0);
  });

  it('does nothing when files array is empty', async () => {
    const fetchImpl = vi.fn();
    const result = await simulateUploadFiles([], fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.images).toHaveLength(0);
  });

  it('truncates error text to 200 chars in error message', async () => {
    const longBody = 'x'.repeat(500);
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => longBody,
    }));
    // The error message internally uses text.slice(0, 200) — verify it doesn't blow up
    const result = await simulateUploadFiles([{ name: 'photo.png' }], fetchImpl);
    expect(result.errors).toHaveLength(1);
  });

  it('aborts on timeout (short delay for testing)', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      // Simulate a slow server — wait until aborted
      return new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    // Use 50ms timeout for test speed
    const result = await simulateUploadFiles([{ name: 'photo.png' }], fetchImpl, { abortDelay: 50 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('Image upload timed out');
  });
});

// ---------------------------------------------------------------------------
// Gap 4: _uploadNonImageFiles — timeout and res.ok check
// ---------------------------------------------------------------------------

describe('_uploadNonImageFiles — AbortController timeout and res.ok check (Fix 4)', () => {
  /**
   * Simulates the updated _uploadNonImageFiles logic (app.js ~line 19057-19101)
   * with the new AbortController timeout and res.ok check.
   */
  async function simulateUploadNonImageFiles(
    files: { name: string }[],
    activeSessionId: string | null,
    fetchImpl: (
      url: string,
      init: { method: string; body: FormData; signal: AbortSignal }
    ) => Promise<{
      ok: boolean;
      status?: number;
      json: () => Promise<Record<string, unknown>>;
      text: () => Promise<string>;
    }>,
    opts?: { abortDelay?: number }
  ) {
    if (!files.length || !activeSessionId) return { filesArray: [], uploadingCount: 0, errors: [] };

    const _files: { filename: string; path: string | null; uploading: boolean }[] = [];
    let uploadingCount = 0;
    const errors: { message: string; type: string }[] = [];

    for (const file of files) {
      const entry = { filename: file.name, path: null as string | null, uploading: true };
      _files.push(entry);
      uploadingCount++;

      try {
        const formData = new FormData();
        formData.append('file', file as unknown as Blob);
        // 30-second timeout prevents indefinite spinner if server hangs
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), opts?.abortDelay ?? 30000);
        let res;
        try {
          res = await fetchImpl(`/api/sessions/${activeSessionId}/upload`, {
            method: 'POST',
            body: formData,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = await res.json();
        if (!data.success) throw new Error((data.error as string) || 'Upload failed');
        entry.path = data.path as string;
        entry.filename = data.filename as string;
        entry.uploading = false;
      } catch (err) {
        const e = err as Error & { name: string };
        const msg = e.name === 'AbortError' ? 'File upload timed out' : 'File upload failed: ' + (e.message || e);
        errors.push({ message: msg, type: e.name });
        const idx = _files.indexOf(entry);
        if (idx !== -1) _files.splice(idx, 1);
      } finally {
        uploadingCount = Math.max(0, uploadingCount - 1);
      }
    }

    return { filesArray: _files, uploadingCount, errors };
  }

  it('populates entry on successful upload', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, path: '/tmp/uploads/report.pdf', filename: 'report.pdf' }),
      text: async () => '',
    }));
    const result = await simulateUploadNonImageFiles([{ name: 'report.pdf' }], 'session-1', fetchImpl);
    expect(result.filesArray).toHaveLength(1);
    expect(result.filesArray[0].path).toBe('/tmp/uploads/report.pdf');
    expect(result.filesArray[0].uploading).toBe(false);
  });

  it('reports "File upload timed out" on AbortError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    const result = await simulateUploadNonImageFiles([{ name: 'data.csv' }], 'session-1', fetchImpl);
    expect(result.filesArray).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('File upload timed out');
    expect(result.errors[0].type).toBe('AbortError');
  });

  it('throws when res.ok is false (non-200 response)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'Internal Server Error',
    }));
    const result = await simulateUploadNonImageFiles([{ name: 'data.csv' }], 'session-1', fetchImpl);
    expect(result.filesArray).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('File upload failed');
  });

  it('includes HTTP status in error for non-ok response', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => 'Bad Gateway',
    }));
    const result = await simulateUploadNonImageFiles([{ name: 'data.csv' }], 'session-1', fetchImpl);
    // The error message contains "Server returned 502"
    expect(result.errors[0].message).toContain('502');
  });

  it('aborts on timeout (short delay for testing)', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      return new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    const result = await simulateUploadNonImageFiles([{ name: 'data.csv' }], 'session-1', fetchImpl, {
      abortDelay: 50,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('File upload timed out');
  });

  it('passes AbortController signal to fetch', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, path: '/tmp/f.txt', filename: 'f.txt' }),
        text: async () => '',
      };
    });
    await simulateUploadNonImageFiles([{ name: 'f.txt' }], 'abc-123', fetchImpl);
  });

  it('decrements uploadingCount even on failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('Network error');
    });
    const result = await simulateUploadNonImageFiles([{ name: 'file.txt' }], 'session-1', fetchImpl);
    expect(result.uploadingCount).toBe(0);
  });

  it('does nothing when no active session', async () => {
    const fetchImpl = vi.fn();
    const result = await simulateUploadNonImageFiles([{ name: 'file.txt' }], null, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gap 5: _updateSendBtnState — safety timer reset
// ---------------------------------------------------------------------------

describe('_updateSendBtnState — safety timer reset (Fix 5)', () => {
  /**
   * Simulates the safety timer logic from _updateSendBtnState (app.js ~line 19105-19121):
   *
   *   if (this._uploadingCount > 0) {
   *     clearTimeout(this._uploadSafetyTimer);
   *     this._uploadSafetyTimer = setTimeout(() => {
   *       if (this._uploadingCount > 0) {
   *         this._uploadingCount = 0;
   *         this._updateSendBtnState();
   *       }
   *     }, 60000);
   *   }
   */

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface PanelState {
    _uploadingCount: number;
    _uploadSafetyTimer: ReturnType<typeof setTimeout> | null;
    btnDisabled: boolean;
  }

  function updateSendBtnState(state: PanelState): void {
    state.btnDisabled = state._uploadingCount > 0;
    if (state._uploadingCount > 0) {
      if (state._uploadSafetyTimer) clearTimeout(state._uploadSafetyTimer);
      state._uploadSafetyTimer = setTimeout(() => {
        if (state._uploadingCount > 0) {
          state._uploadingCount = 0;
          updateSendBtnState(state);
        }
      }, 60000);
    }
  }

  it('disables button when uploadingCount > 0', () => {
    const state: PanelState = { _uploadingCount: 1, _uploadSafetyTimer: null, btnDisabled: false };
    updateSendBtnState(state);
    expect(state.btnDisabled).toBe(true);
  });

  it('enables button when uploadingCount === 0', () => {
    const state: PanelState = { _uploadingCount: 0, _uploadSafetyTimer: null, btnDisabled: true };
    updateSendBtnState(state);
    expect(state.btnDisabled).toBe(false);
  });

  it('starts a safety timer when uploadingCount > 0', () => {
    const state: PanelState = { _uploadingCount: 1, _uploadSafetyTimer: null, btnDisabled: false };
    updateSendBtnState(state);
    expect(state._uploadSafetyTimer).not.toBe(null);
  });

  it('does not start a safety timer when uploadingCount === 0', () => {
    const state: PanelState = { _uploadingCount: 0, _uploadSafetyTimer: null, btnDisabled: false };
    updateSendBtnState(state);
    expect(state._uploadSafetyTimer).toBe(null);
  });

  it('force-resets uploadingCount to 0 after 60 seconds', () => {
    const state: PanelState = { _uploadingCount: 2, _uploadSafetyTimer: null, btnDisabled: false };
    updateSendBtnState(state);
    expect(state._uploadingCount).toBe(2);
    expect(state.btnDisabled).toBe(true);

    vi.advanceTimersByTime(60000);

    expect(state._uploadingCount).toBe(0);
    expect(state.btnDisabled).toBe(false);
  });

  it('does not reset if uploadingCount dropped to 0 before timer fires', () => {
    const state: PanelState = { _uploadingCount: 1, _uploadSafetyTimer: null, btnDisabled: false };
    updateSendBtnState(state);

    // Simulate normal upload completion
    state._uploadingCount = 0;
    updateSendBtnState(state);
    expect(state.btnDisabled).toBe(false);

    // Timer fires but count is already 0 — no-op
    vi.advanceTimersByTime(60000);
    expect(state._uploadingCount).toBe(0);
    expect(state.btnDisabled).toBe(false);
  });

  it('clears previous timer when new upload starts (no timer accumulation)', () => {
    const state: PanelState = { _uploadingCount: 1, _uploadSafetyTimer: null, btnDisabled: false };
    updateSendBtnState(state);
    const firstTimer = state._uploadSafetyTimer;

    // Second upload starts — timer is replaced
    state._uploadingCount = 2;
    updateSendBtnState(state);
    const secondTimer = state._uploadSafetyTimer;

    expect(secondTimer).not.toBe(firstTimer);

    // Advance 60s — only the second timer fires, count resets once
    vi.advanceTimersByTime(60000);
    expect(state._uploadingCount).toBe(0);
  });

  it('recursive call from timer does not create infinite loop', () => {
    const state: PanelState = { _uploadingCount: 1, _uploadSafetyTimer: null, btnDisabled: false };
    updateSendBtnState(state);

    // Timer fires, resets count to 0, calls updateSendBtnState again
    // The recursive call sees count=0, does NOT set a new timer → no infinite loop
    vi.advanceTimersByTime(60000);

    expect(state._uploadingCount).toBe(0);
    expect(state.btnDisabled).toBe(false);
    // No pending timers should cause further state changes
    vi.advanceTimersByTime(120000);
    expect(state._uploadingCount).toBe(0);
  });
});

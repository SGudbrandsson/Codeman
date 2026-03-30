/**
 * @fileoverview Tests for the image attach rewrite fix
 *
 * Covers four gaps identified in the test gap analysis:
 *   1. sendInput(input, sessionId) — explicit sessionId parameter + throw on !res.ok
 *   2. send() session ID capture and passthrough — session switch mid-send safety
 *   3. send() error recovery (try/catch) — textarea/image restore + error toast
 *   4. onSessionChange() image preservation — images preserved when textarea is empty
 *
 * Because app.js is a browser bundle (no exports), the logic is replicated
 * here as pure functions matching the exact expressions in the source.
 * This mirrors the approach used in image-send-race-guard.test.ts and
 * image-paste-attach.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface ImageEntry {
  objectUrl: string;
  path: string | null;
}

// ---------------------------------------------------------------------------
// Gap 1: sendInput(input, sessionId) — replicated from app.js ~line 11149
// ---------------------------------------------------------------------------

/**
 * Replicates sendInput() from app.js:
 *
 *   async sendInput(input, sessionId) {
 *     const sid = sessionId || this.activeSessionId;
 *     if (!sid) return;
 *     const res = await fetch(`/api/sessions/${sid}/input`, { ... });
 *     if (!res.ok) throw new Error(`sendInput failed: ${res.status}`);
 *   }
 */
function createApp(opts: { activeSessionId: string | null; fetchResult?: { ok: boolean; status: number } }) {
  const fetchCalls: { url: string; body: string }[] = [];
  const toasts: { msg: string; type: string }[] = [];

  const app = {
    activeSessionId: opts.activeSessionId,
    sessions: new Map<string, { status: string; isWorking: boolean }>(),

    async sendInput(input: string, sessionId?: string) {
      const sid = sessionId || this.activeSessionId;
      if (!sid) return;
      // Simulate fetch
      const url = `/api/sessions/${sid}/input`;
      const body = JSON.stringify({ input, useMux: true });
      fetchCalls.push({ url, body });
      const res = opts.fetchResult ?? { ok: true, status: 200 };
      if (!res.ok) {
        throw new Error(`sendInput failed: ${res.status}`);
      }
    },

    showToast(msg: string, type: string) {
      toasts.push({ msg, type });
    },
  };

  return { app, fetchCalls, toasts };
}

describe('sendInput(input, sessionId) — explicit sessionId parameter (Gap 1)', () => {
  it('uses explicit sessionId when provided, ignoring activeSessionId', async () => {
    const { app, fetchCalls } = createApp({ activeSessionId: 'session-A' });
    await app.sendInput('hello\r', 'session-B');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('/api/sessions/session-B/input');
  });

  it('falls back to activeSessionId when sessionId is not provided', async () => {
    const { app, fetchCalls } = createApp({ activeSessionId: 'session-A' });
    await app.sendInput('hello\r');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('/api/sessions/session-A/input');
  });

  it('returns early when no sessionId and activeSessionId is null', async () => {
    const { app, fetchCalls } = createApp({ activeSessionId: null });
    await app.sendInput('hello\r');
    expect(fetchCalls).toHaveLength(0);
  });

  it('throws when response is not ok', async () => {
    const { app } = createApp({
      activeSessionId: 'session-A',
      fetchResult: { ok: false, status: 500 },
    });
    await expect(app.sendInput('hello\r')).rejects.toThrow('sendInput failed: 500');
  });

  it('does not throw when response is ok', async () => {
    const { app } = createApp({
      activeSessionId: 'session-A',
      fetchResult: { ok: true, status: 200 },
    });
    await expect(app.sendInput('hello\r')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gap 2 + 3: send() session ID capture, passthrough, and error recovery
// Replicated from app.js ~line 20822-20905
// ---------------------------------------------------------------------------

/**
 * Creates a minimal InputPanel + app replica covering session ID capture,
 * sendInput passthrough, and error recovery in send().
 */
function createSendPanel(opts: { activeSessionId: string | null; sendInputShouldFail?: boolean }) {
  const fetchCalls: { url: string; input: string }[] = [];
  const toasts: { msg: string; type: string }[] = [];
  let restoredImages: string[] | null = null;

  const app = {
    activeSessionId: opts.activeSessionId,
    sessions: new Map<string, { status: string; isWorking: boolean }>(),

    async sendInput(input: string, sessionId?: string) {
      const sid = sessionId || this.activeSessionId;
      if (!sid) return;
      fetchCalls.push({ url: `/api/sessions/${sid}/input`, input });
      if (opts.sendInputShouldFail) {
        throw new Error('sendInput failed: 500');
      }
    },

    showToast(msg: string, type: string) {
      toasts.push({ msg, type });
    },
  };

  const panel = {
    _images: [] as ImageEntry[],
    _files: [] as { name: string; path: string | null }[],
    _uploadingCount: 0,
    _uploadsCompletePromise: null as Promise<void> | null,
    _uploadsCompleteResolve: null as (() => void) | null,
    _textareaValue: '',
    _draftCleared: false,
    _optimisticShown: false,

    _getTextarea() {
      return {
        get value() {
          return panel._textareaValue;
        },
        set value(v: string) {
          panel._textareaValue = v;
        },
      };
    },

    _restoreImages(paths: string[]) {
      restoredImages = paths;
      // In real code this rebuilds _images from paths; here we just track the call
    },

    _autoGrow(_ta: unknown) {
      // no-op in test
    },

    /**
     * Replicates send() from app.js ~line 20822-20905.
     * Key behaviors tested:
     * - Captures _sendSessionId BEFORE async work
     * - Passes it to sendInput()
     * - On error: restores textarea, images, shows toast, skips optimistic UI
     */
    async send() {
      // Upload wait guard (simplified — tested in image-send-race-guard.test.ts)
      if (this._uploadingCount > 0) {
        if (!this._uploadsCompletePromise) {
          this._uploadsCompletePromise = new Promise((r) => {
            this._uploadsCompleteResolve = r;
          });
        }
        await this._uploadsCompletePromise;
      }

      const ta = this._getTextarea();
      if (!ta) return;
      const text = ta.value.trim();
      const images = this._images.filter((img) => img.path);
      const attachedFiles = this._files.filter((f) => f.path);
      if (!text && !images.length && !attachedFiles.length) return;

      const parts = [...images.map((img) => img.path), ...(text ? [text] : [])];
      // Capture session ID NOW, before any async work.
      const _sendSessionId = app.activeSessionId;
      if (!_sendSessionId) return;
      const inputString = parts.join('\n') + '\r';

      // Clear textarea and images optimistically BEFORE the fetch
      // (matches app.js behavior at ~line 20920-20933)
      ta.value = '';
      this._images = this._images.filter((img) => !img.path);

      try {
        await app.sendInput(inputString, _sendSessionId);
        // Mark optimistic UI as shown (for verification)
        this._optimisticShown = true;
        this._draftCleared = true;
      } catch (err) {
        // Send failed — restore the user's input so nothing is lost.
        ta.value = text;
        this._restoreImages(images.map((img) => img.path!));
        this._autoGrow(ta);
        app.showToast('Message failed to send \u2014 your input has been restored.', 'error');
        return; // Don't clear draft or show optimistic UI
      }
    },
  };

  return { panel, app, fetchCalls, toasts, getRestoredImages: () => restoredImages };
}

describe('send() session ID capture and passthrough (Gap 2)', () => {
  it('sends to the session that was active when send() was called', async () => {
    const { panel, fetchCalls } = createSendPanel({ activeSessionId: 'session-A' });
    panel._textareaValue = 'hello';

    await panel.send();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('/api/sessions/session-A/input');
    expect(fetchCalls[0].input).toBe('hello\r');
  });

  it('uses captured session ID even if activeSessionId changes mid-send', async () => {
    // Simulate: activeSessionId changes between send() start and sendInput() call
    // We can't truly race in a sync test, but we verify the captured ID is used
    const { panel, app, fetchCalls } = createSendPanel({ activeSessionId: 'session-A' });
    panel._textareaValue = 'hello';
    panel._images.push({ objectUrl: 'blob:1', path: '/screenshots/img.png' });

    // Swap active session — in real code this happens via SSE event
    // The key insight: _sendSessionId is captured at line 20872, so even
    // if app.activeSessionId changes, the captured value is used.
    const originalSend = panel.send.bind(panel);
    // Override sendInput to change activeSessionId before the fetch
    const origSendInput = app.sendInput.bind(app);
    app.sendInput = async (input: string, sessionId?: string) => {
      // Simulate SSE-triggered session switch happening just before fetch
      app.activeSessionId = 'session-B';
      return origSendInput(input, sessionId);
    };

    await originalSend();

    expect(fetchCalls).toHaveLength(1);
    // Must use the CAPTURED session-A, not the switched session-B
    expect(fetchCalls[0].url).toBe('/api/sessions/session-A/input');
  });

  it('prepends image paths to the input string', async () => {
    const { panel, fetchCalls } = createSendPanel({ activeSessionId: 'session-A' });
    panel._textareaValue = 'describe this';
    panel._images.push(
      { objectUrl: 'blob:1', path: '/screenshots/img1.png' },
      { objectUrl: 'blob:2', path: '/screenshots/img2.png' }
    );

    await panel.send();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].input).toBe('/screenshots/img1.png\n/screenshots/img2.png\ndescribe this\r');
  });

  it('returns early when activeSessionId is null', async () => {
    const { panel, fetchCalls } = createSendPanel({ activeSessionId: null });
    panel._textareaValue = 'hello';

    await panel.send();

    expect(fetchCalls).toHaveLength(0);
  });
});

describe('send() error recovery (Gap 3)', () => {
  it('restores textarea text on sendInput failure', async () => {
    const { panel } = createSendPanel({
      activeSessionId: 'session-A',
      sendInputShouldFail: true,
    });
    panel._textareaValue = 'important message';

    await panel.send();

    expect(panel._textareaValue).toBe('important message');
  });

  it('restores images on sendInput failure via _restoreImages()', async () => {
    const { panel, getRestoredImages } = createSendPanel({
      activeSessionId: 'session-A',
      sendInputShouldFail: true,
    });
    panel._textareaValue = 'with image';
    panel._images.push({ objectUrl: 'blob:1', path: '/screenshots/img.png' });

    await panel.send();

    expect(getRestoredImages()).toEqual(['/screenshots/img.png']);
  });

  it('shows error toast on sendInput failure', async () => {
    const { panel, toasts } = createSendPanel({
      activeSessionId: 'session-A',
      sendInputShouldFail: true,
    });
    panel._textareaValue = 'test';

    await panel.send();

    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].msg).toContain('failed to send');
  });

  it('skips optimistic UI and draft clearing on sendInput failure', async () => {
    const { panel } = createSendPanel({
      activeSessionId: 'session-A',
      sendInputShouldFail: true,
    });
    panel._textareaValue = 'test';

    await panel.send();

    expect(panel._optimisticShown).toBe(false);
    expect(panel._draftCleared).toBe(false);
  });

  it('proceeds with optimistic UI on successful send', async () => {
    const { panel } = createSendPanel({
      activeSessionId: 'session-A',
      sendInputShouldFail: false,
    });
    panel._textareaValue = 'test';

    await panel.send();

    expect(panel._optimisticShown).toBe(true);
    expect(panel._draftCleared).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap 4: onSessionChange() image preservation
// Replicated from app.js ~line 20510-20530
// ---------------------------------------------------------------------------

/**
 * Creates a minimal InputPanel replica covering onSessionChange() logic.
 * Key behavior: when _images.length > 0 but textarea is empty, images
 * must NOT be wiped on session switch.
 */
function createSessionChangePanel() {
  const drafts = new Map<string, { text: string; imagePaths: string[] }>();
  let restoredImages: string[] | null = null;

  const panel = {
    _images: [] as ImageEntry[],
    _currentSessionId: null as string | null,
    _textareaValue: '',
    _focused: false, // simulates document.activeElement === ta

    _getTextarea() {
      return {
        get value() {
          return panel._textareaValue;
        },
        set value(v: string) {
          panel._textareaValue = v;
        },
      };
    },

    _restoreImages(imagePaths: string[]) {
      restoredImages = imagePaths;
      if (imagePaths.length === 0) {
        panel._images = [];
      }
    },

    _saveDraftLocal(sessionId: string) {
      if (!sessionId) return;
      const text = panel._textareaValue;
      const imagePaths = panel._images.map((img) => img.path).filter(Boolean) as string[];
      drafts.set(sessionId, { text, imagePaths });
    },

    _loadDraft(sessionId: string) {
      const d = drafts.get(sessionId);
      if (d) {
        panel._textareaValue = d.text;
        // Real code calls _restoreImages here too
      }
    },

    /**
     * Replicates onSessionChange() from app.js ~line 20510-20530:
     *
     *   const userHasText = ta && ta.value && document.activeElement === ta;
     *   const userHasImages = this._images.length > 0;
     *   const userHasContent = userHasText || userHasImages;
     *   if (ta && !userHasContent) { ta.value = ''; }
     *   if (!userHasContent) this._restoreImages([]);
     */
    onSessionChange(oldId: string | null, newId: string | null) {
      if (oldId) {
        this._saveDraftLocal(oldId);
      }
      const ta = this._getTextarea();
      const userHasText = ta && ta.value && this._focused;
      const userHasImages = this._images.length > 0;
      const userHasContent = userHasText || userHasImages;
      if (ta && !userHasContent) {
        ta.value = '';
      }
      if (!userHasContent) this._restoreImages([]);
      this._currentSessionId = newId;
      if (newId) this._loadDraft(newId);
    },
  };

  return { panel, drafts, getRestoredImages: () => restoredImages };
}

describe('onSessionChange() image preservation (Gap 4)', () => {
  it('preserves images when textarea is empty but _images has entries', () => {
    const { panel, getRestoredImages } = createSessionChangePanel();
    panel._textareaValue = '';
    panel._focused = false;
    panel._images = [{ objectUrl: 'blob:1', path: '/screenshots/img.png' }];

    panel.onSessionChange('old-session', 'new-session');

    // _restoreImages([]) should NOT have been called — images are preserved
    // If images were wiped, restoredImages would be []
    expect(getRestoredImages()).toBeNull();
    expect(panel._images).toHaveLength(1);
  });

  it('wipes images and textarea when both are empty', () => {
    const { panel, getRestoredImages } = createSessionChangePanel();
    panel._textareaValue = '';
    panel._focused = false;
    panel._images = [];

    panel.onSessionChange('old-session', 'new-session');

    // No content at all — should wipe
    expect(getRestoredImages()).toEqual([]);
  });

  it('preserves textarea text when user is actively focused', () => {
    const { panel, getRestoredImages } = createSessionChangePanel();
    panel._textareaValue = 'typing in progress';
    panel._focused = true; // simulates document.activeElement === ta
    panel._images = [];

    panel.onSessionChange('old-session', 'new-session');

    // User has text and focus — should NOT wipe
    expect(getRestoredImages()).toBeNull();
    expect(panel._textareaValue).toBe('typing in progress');
  });

  it('preserves both text and images when user has content', () => {
    const { panel, getRestoredImages } = createSessionChangePanel();
    panel._textareaValue = 'some text';
    panel._focused = true;
    panel._images = [{ objectUrl: 'blob:1', path: '/screenshots/img.png' }];

    panel.onSessionChange('old-session', 'new-session');

    expect(getRestoredImages()).toBeNull();
    expect(panel._textareaValue).toBe('some text');
    expect(panel._images).toHaveLength(1);
  });

  it('wipes when textarea has text but user is NOT focused (no active composition)', () => {
    const { panel, getRestoredImages } = createSessionChangePanel();
    panel._textareaValue = 'leftover text';
    panel._focused = false; // not focused means not actively composing
    panel._images = [];

    panel.onSessionChange('old-session', 'new-session');

    // Unfocused text with no images — old behavior: wipe
    expect(getRestoredImages()).toEqual([]);
    expect(panel._textareaValue).toBe('');
  });

  it('images alone (no text, no focus) are sufficient to prevent wipe', () => {
    const { panel, getRestoredImages } = createSessionChangePanel();
    panel._textareaValue = '';
    panel._focused = false;
    // User pasted an image but hasn't typed any text yet
    panel._images = [
      { objectUrl: 'blob:1', path: '/screenshots/img1.png' },
      { objectUrl: 'blob:2', path: null }, // still uploading
    ];

    panel.onSessionChange('old-session', 'new-session');

    // Images present — must NOT wipe, even without text or focus
    expect(getRestoredImages()).toBeNull();
    expect(panel._images).toHaveLength(2);
  });
});

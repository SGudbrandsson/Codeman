/**
 * @fileoverview Tests for the optimistic-before-send ordering + rollback-on-failure
 * logic in InputPanel._sendInner() (src/web/public/app.js ~lines 21330-21421).
 *
 * Covers Gap 2 of the sluggish-send fix (Lever 1, optimistic client UI):
 *   1. On send, the textarea clears and the optimistic bubble appends SYNCHRONOUSLY,
 *      before the fire-and-forget app.sendInput(...) promise settles.
 *   2. On a REJECTED sendInput, the rollback restores the original text ONLY if the
 *      textarea is still empty (the `!taNow.value.trim()` no-clobber guard), restores
 *      the captured image paths, removes the optimistic bubble, and surfaces a toast.
 *   3. The rollback does NOT clobber text the user typed into the textarea during the
 *      in-flight gap.
 *
 * Because app.js is a browser bundle (no exports), the reordered send path is
 * replicated here as pure functions matching the exact expressions in the source.
 * This mirrors the approach used in image-send-race-guard.test.ts, which the existing
 * files explicitly accept must be kept in sync with app.js by hand.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Replicated InputPanel subset — matches the Lever 1 reorder in app.js
// _sendInner() (optimistic block runs synchronously, then a fire-and-forget
// app.sendInput(...) whose .catch() rolls the UI back).
// ---------------------------------------------------------------------------

interface ImageEntry {
  objectUrl: string | null;
  path: string | null;
}

/** A trivial stand-in for the real <textarea> element. */
function createTextarea(initial = '') {
  return { value: initial };
}

/**
 * Minimal TranscriptView replica covering the optimistic-bubble lifecycle
 * (appendOptimistic / removeLastOptimistic) used by the rollback path.
 */
function createTranscriptView(sessionId: string) {
  return {
    _sessionId: sessionId,
    _pendingOptimisticText: null as string | null,
    // Each appendOptimistic pushes a bubble; removeLastOptimistic pops the last.
    bubbles: [] as string[],
    working: false,

    appendOptimistic(text: string) {
      this._pendingOptimisticText = text;
      this.bubbles.push(text);
    },
    removeLastOptimistic() {
      if (this.bubbles.length) this.bubbles.pop();
      this._pendingOptimisticText = null;
    },
    setWorking(v: boolean) {
      this.working = v;
    },
  };
}

/**
 * createSender returns a replica InputPanel whose _sendInner mirrors the reordered
 * app.js logic, plus a controllable app.sendInput stub.
 *
 * `sendInputBehavior` lets each test choose whether the fire-and-forget POST
 * resolves, rejects, or stays pending.
 */
function createSender(opts: { activeSessionId: string; sendInputBehavior: 'pending' | 'resolve' | 'reject' }) {
  const sent: { input: string; sessionId: string }[] = [];
  const toasts: { msg: string; type: string }[] = [];
  const ta = createTextarea();
  const transcriptView = createTranscriptView(opts.activeSessionId);

  // Resolver/rejecter captured so a test can settle the POST after asserting
  // the synchronous optimistic state.
  let settle: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  let sendPromise: Promise<void> | null = null;

  const app = {
    activeSessionId: opts.activeSessionId,
    sendInput(input: string, sessionId: string): Promise<void> {
      sent.push({ input, sessionId });
      sendPromise = new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
        if (opts.sendInputBehavior === 'resolve') resolve();
        else if (opts.sendInputBehavior === 'reject') reject(new Error('POST failed'));
        // 'pending' → never settles unless the test calls settle.*
      });
      // Swallow the rejection here so the unhandled-rejection doesn't leak; the
      // real .catch() in _sendInner handles rollback. (Tests assert via state.)
      return sendPromise;
    },
    showToast(msg: string, type: string) {
      toasts.push({ msg, type });
    },
  };

  const panel = {
    _images: [] as ImageEntry[],

    _restoreImages(imagePaths: (string | null)[]) {
      this._images = imagePaths.map((path) => ({ objectUrl: null, path }));
    },

    /**
     * Replicates the reordered _sendInner() body from app.js (post-validation):
     * captures rollback snapshot, runs the optimistic block synchronously, then
     * fires app.sendInput WITHOUT awaiting; .catch() rolls back.
     *
     * Validation (upload wait, secret scan, etc.) is covered elsewhere and omitted;
     * `text` is the already-validated message.
     */
    _sendInner(text: string) {
      const images = this._images.filter((img) => img.path);
      const sendText = text;
      const _sendSessionId = app.activeSessionId;
      const inputString = sendText + '\r';

      // ---- Rollback snapshot (captured before the synchronous image strip) ----
      const _sentImagePaths = images.map((img) => img.path);
      let _optimisticAppended = false;

      // ---- Optimistic UI (synchronous) ----
      if (sendText && transcriptView._sessionId === app.activeSessionId) {
        if (sendText.trim() === '/clear') {
          // clearOnly() path — no optimistic bubble appended
        } else {
          transcriptView.appendOptimistic(sendText);
          _optimisticAppended = true;
        }
      }
      if (transcriptView._sessionId === app.activeSessionId) {
        transcriptView.setWorking(true);
      }

      ta.value = '';
      this._images = this._images.filter((img) => !img.path);

      // ---- Fire-and-forget POST ----
      app
        .sendInput(inputString, _sendSessionId)
        .then(() => {
          // success path (fallback-Enter poller) — not modeled here
        })
        .catch(() => {
          const taNow = ta;
          if (taNow && !taNow.value.trim()) {
            taNow.value = text;
          }
          this._restoreImages(_sentImagePaths);
          if (
            _optimisticAppended &&
            transcriptView._sessionId === _sendSessionId &&
            typeof transcriptView.removeLastOptimistic === 'function'
          ) {
            transcriptView.removeLastOptimistic();
          }
          app.showToast('Message failed to send — your input has been restored.', 'error');
        });
    },
  };

  return {
    panel,
    ta,
    transcriptView,
    app,
    sent,
    toasts,
    settle: () => settle,
    sendPromise: () => sendPromise,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InputPanel optimistic send + rollback', () => {
  describe('synchronous optimistic UI (before the POST settles)', () => {
    it('clears the textarea and appends the optimistic bubble before sendInput resolves', () => {
      const h = createSender({ activeSessionId: 'sess-a', sendInputBehavior: 'pending' });
      h.ta.value = 'hello world';

      h.panel._sendInner('hello world');

      // POST is in flight (pending, never settled) — yet UI already reflects the send.
      expect(h.ta.value).toBe('');
      expect(h.transcriptView.bubbles).toEqual(['hello world']);
      expect(h.transcriptView._pendingOptimisticText).toBe('hello world');
      expect(h.transcriptView.working).toBe(true);
      // The POST was fired (fire-and-forget) with the \r-terminated input.
      expect(h.sent).toEqual([{ input: 'hello world\r', sessionId: 'sess-a' }]);
    });

    it('strips sent images synchronously and snapshots their paths for rollback', () => {
      const h = createSender({ activeSessionId: 'sess-a', sendInputBehavior: 'pending' });
      h.panel._images = [
        { objectUrl: 'blob:1', path: '/screenshots/a.png' },
        { objectUrl: 'blob:2', path: null }, // still uploading — preserved
      ];

      h.panel._sendInner('with image');

      // Sent image (resolved path) is stripped; in-flight one is preserved.
      expect(h.panel._images).toHaveLength(1);
      expect(h.panel._images[0].path).toBeNull();
    });

    it('does not append an optimistic bubble for /clear (uses clearOnly path)', () => {
      const h = createSender({ activeSessionId: 'sess-a', sendInputBehavior: 'pending' });
      h.ta.value = '/clear';

      h.panel._sendInner('/clear');

      expect(h.transcriptView.bubbles).toEqual([]);
      expect(h.ta.value).toBe('');
    });
  });

  describe('rollback on a rejected POST', () => {
    it('restores text, restores images, removes the bubble, and toasts when textarea is still empty', async () => {
      const h = createSender({ activeSessionId: 'sess-a', sendInputBehavior: 'reject' });
      h.ta.value = 'restore me';
      h.panel._images = [{ objectUrl: 'blob:1', path: '/screenshots/a.png' }];

      h.panel._sendInner('restore me');

      // Let the rejected promise's .catch() run.
      await Promise.resolve();
      await Promise.resolve();

      // Textarea was empty after the optimistic clear → restored.
      expect(h.ta.value).toBe('restore me');
      // Optimistic bubble removed.
      expect(h.transcriptView.bubbles).toEqual([]);
      expect(h.transcriptView._pendingOptimisticText).toBeNull();
      // Image restored from snapshot.
      expect(h.panel._images).toHaveLength(1);
      expect(h.panel._images[0].path).toBe('/screenshots/a.png');
      // Error toast surfaced.
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0]).toEqual({
        msg: 'Message failed to send — your input has been restored.',
        type: 'error',
      });
    });

    it('does NOT clobber text the user typed during the in-flight gap', async () => {
      const h = createSender({ activeSessionId: 'sess-a', sendInputBehavior: 'pending' });
      h.ta.value = 'original message';

      h.panel._sendInner('original message');
      // Textarea cleared synchronously…
      expect(h.ta.value).toBe('');
      // …then the user starts typing a brand-new message before the POST settles.
      h.ta.value = 'a new draft the user is typing';

      // Now the POST fails.
      h.settle()!.reject(new Error('POST failed'));
      await Promise.resolve();
      await Promise.resolve();

      // The no-clobber guard (`!taNow.value.trim()`) keeps the user's new draft.
      expect(h.ta.value).toBe('a new draft the user is typing');
      // The optimistic bubble is still rolled back, and a toast still fires.
      expect(h.transcriptView.bubbles).toEqual([]);
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].type).toBe('error');
    });

    it('does not roll back when the POST succeeds', async () => {
      const h = createSender({ activeSessionId: 'sess-a', sendInputBehavior: 'resolve' });
      h.ta.value = 'all good';
      h.panel._images = [{ objectUrl: 'blob:1', path: '/screenshots/a.png' }];

      h.panel._sendInner('all good');
      await Promise.resolve();
      await Promise.resolve();

      // No rollback: textarea stays empty, bubble stays, no error toast, images stay cleared.
      expect(h.ta.value).toBe('');
      expect(h.transcriptView.bubbles).toEqual(['all good']);
      expect(h.panel._images).toHaveLength(0);
      expect(h.toasts).toHaveLength(0);
    });
  });
});

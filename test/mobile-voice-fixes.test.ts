/**
 * @fileoverview Tests for mobile voice recording fixes
 *
 * Covers the fixes applied to src/web/public/voice-input.js and src/web/public/app.js:
 *   1. getUserMedia constraint fallback — retry with { audio: true } on OverconstrainedError/NotReadableError
 *   2. MIME type selection with iOS support — audio/mp4;codecs=aac added to priority list
 *   3. composeMicBtn touch/click handler — micHandler toggle logic and event wiring
 *   4. MediaRecorder audioBitsPerSecond — AAC-aware bitrate (64kbps for AAC, 16kbps otherwise)
 *
 * Because voice-input.js and app.js are browser bundles (no exports), the logic is
 * replicated here as pure functions matching the exact expressions in the source.
 * This mirrors the approach used in photo-upload-fixes.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Gap 1: getUserMedia constraint fallback
// ---------------------------------------------------------------------------

describe('getUserMedia constraint fallback (voice-input.js lines 66-84)', () => {
  /**
   * Replicates the getUserMedia retry logic from DeepgramProvider.start():
   *
   *   try {
   *     stream = await getUserMedia({ audio: { noiseSuppression: true, ... } });
   *   } catch (err) {
   *     if (err.name === 'OverconstrainedError' || err.name === 'NotReadableError') {
   *       try { stream = await getUserMedia({ audio: true }); }
   *       catch (err2) { onError(err2); cleanup(); return; }
   *     } else {
   *       onError(err); cleanup(); return;
   *     }
   *   }
   */
  async function simulateGetUserMedia(
    getUserMediaImpl: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  ): Promise<{
    stream: MediaStream | null;
    error: string | null;
    cleanupCalled: boolean;
    calls: MediaStreamConstraints[];
  }> {
    const calls: MediaStreamConstraints[] = [];
    let stream: MediaStream | null = null;
    let error: string | null = null;
    let cleanupCalled = false;

    const wrappedGetUserMedia = async (constraints: MediaStreamConstraints) => {
      calls.push(constraints);
      return getUserMediaImpl(constraints);
    };

    try {
      stream = await wrappedGetUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
    } catch (err: any) {
      if (err.name === 'OverconstrainedError' || err.name === 'NotReadableError') {
        try {
          stream = await wrappedGetUserMedia({ audio: true });
        } catch (err2: any) {
          error =
            err2.name === 'NotAllowedError'
              ? 'Microphone access denied. Check browser settings.'
              : 'Microphone error: ' + err2.message;
          cleanupCalled = true;
          return { stream, error, cleanupCalled, calls };
        }
      } else {
        error =
          err.name === 'NotAllowedError'
            ? 'Microphone access denied. Check browser settings.'
            : 'Microphone error: ' + err.message;
        cleanupCalled = true;
        return { stream, error, cleanupCalled, calls };
      }
    }

    return { stream, error, cleanupCalled, calls };
  }

  it('succeeds on first try with constraints', async () => {
    const fakeStream = {} as MediaStream;
    const result = await simulateGetUserMedia(async () => fakeStream);
    expect(result.stream).toBe(fakeStream);
    expect(result.error).toBe(null);
    expect(result.cleanupCalled).toBe(false);
    expect(result.calls).toHaveLength(1);
  });

  it('retries with { audio: true } on OverconstrainedError', async () => {
    const fakeStream = {} as MediaStream;
    let callCount = 0;
    const result = await simulateGetUserMedia(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('Constraints not satisfiable');
        err.name = 'OverconstrainedError';
        throw err;
      }
      return fakeStream;
    });
    expect(result.stream).toBe(fakeStream);
    expect(result.error).toBe(null);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]).toEqual({ audio: true });
  });

  it('retries with { audio: true } on NotReadableError', async () => {
    const fakeStream = {} as MediaStream;
    let callCount = 0;
    const result = await simulateGetUserMedia(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('Could not start source');
        err.name = 'NotReadableError';
        throw err;
      }
      return fakeStream;
    });
    expect(result.stream).toBe(fakeStream);
    expect(result.error).toBe(null);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]).toEqual({ audio: true });
  });

  it('does NOT retry on NotAllowedError — reports immediately', async () => {
    const result = await simulateGetUserMedia(async () => {
      const err = new Error('Permission denied');
      err.name = 'NotAllowedError';
      throw err;
    });
    expect(result.stream).toBe(null);
    expect(result.error).toBe('Microphone access denied. Check browser settings.');
    expect(result.cleanupCalled).toBe(true);
    expect(result.calls).toHaveLength(1); // no retry
  });

  it('does NOT retry on generic Error', async () => {
    const result = await simulateGetUserMedia(async () => {
      throw new Error('Something unexpected');
    });
    expect(result.stream).toBe(null);
    expect(result.error).toBe('Microphone error: Something unexpected');
    expect(result.cleanupCalled).toBe(true);
    expect(result.calls).toHaveLength(1);
  });

  it('calls cleanup when retry also fails', async () => {
    const result = await simulateGetUserMedia(async () => {
      const err = new Error('Device not available');
      err.name = 'OverconstrainedError';
      throw err;
    });
    // Both calls throw OverconstrainedError — second one hits inner catch
    expect(result.stream).toBe(null);
    expect(result.cleanupCalled).toBe(true);
    expect(result.calls).toHaveLength(2);
    expect(result.error).toBe('Microphone error: Device not available');
  });

  it('reports NotAllowedError message when retry fails with permission denial', async () => {
    let callCount = 0;
    const result = await simulateGetUserMedia(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('Overconstrained');
        err.name = 'OverconstrainedError';
        throw err;
      }
      const err = new Error('Permission denied');
      err.name = 'NotAllowedError';
      throw err;
    });
    expect(result.error).toBe('Microphone access denied. Check browser settings.');
    expect(result.cleanupCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap 2: MIME type selection with iOS support
// ---------------------------------------------------------------------------

describe('MIME type selection with iOS support (voice-input.js line 92)', () => {
  /**
   * Replicates the MIME type selection logic from DeepgramProvider.start():
   *
   *   const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=aac', 'audio/mp4'];
   *   this._selectedMime = null;
   *   for (const mt of mimeTypes) {
   *     if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mt)) {
   *       this._selectedMime = mt;
   *       break;
   *     }
   *   }
   */
  function selectMimeType(isTypeSupportedImpl: (mt: string) => boolean): string | null {
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=aac', 'audio/mp4'];
    for (const mt of mimeTypes) {
      if (isTypeSupportedImpl(mt)) {
        return mt;
      }
    }
    return null;
  }

  it('selects audio/webm;codecs=opus when all types supported (Chrome desktop)', () => {
    const result = selectMimeType(() => true);
    expect(result).toBe('audio/webm;codecs=opus');
  });

  it('selects audio/mp4;codecs=aac when only mp4 types supported (iOS Safari)', () => {
    const supported = new Set(['audio/mp4;codecs=aac', 'audio/mp4']);
    const result = selectMimeType((mt) => supported.has(mt));
    expect(result).toBe('audio/mp4;codecs=aac');
  });

  it('selects audio/webm when opus not supported but webm is', () => {
    const supported = new Set(['audio/webm', 'audio/mp4;codecs=aac', 'audio/mp4']);
    const result = selectMimeType((mt) => supported.has(mt));
    expect(result).toBe('audio/webm');
  });

  it('selects audio/mp4 (generic) when only that is supported', () => {
    const supported = new Set(['audio/mp4']);
    const result = selectMimeType((mt) => supported.has(mt));
    expect(result).toBe('audio/mp4');
  });

  it('returns null when no MIME types are supported', () => {
    const result = selectMimeType(() => false);
    expect(result).toBe(null);
  });

  it('follows correct priority order: webm/opus > webm > mp4/aac > mp4', () => {
    // Verify by checking which is selected when only each pair is available
    const opusAndAac = new Set(['audio/webm;codecs=opus', 'audio/mp4;codecs=aac']);
    expect(selectMimeType((mt) => opusAndAac.has(mt))).toBe('audio/webm;codecs=opus');

    const webmAndAac = new Set(['audio/webm', 'audio/mp4;codecs=aac']);
    expect(selectMimeType((mt) => webmAndAac.has(mt))).toBe('audio/webm');

    const aacAndMp4 = new Set(['audio/mp4;codecs=aac', 'audio/mp4']);
    expect(selectMimeType((mt) => aacAndMp4.has(mt))).toBe('audio/mp4;codecs=aac');
  });
});

// ---------------------------------------------------------------------------
// Gap 3: composeMicBtn touch/click handler
// ---------------------------------------------------------------------------

describe('composeMicBtn micHandler toggle logic (app.js lines 20334-20344)', () => {
  /**
   * Replicates the micHandler function from InputPanel.init():
   *
   *   const micHandler = () => {
   *     if (typeof VoiceInput === 'undefined') return;
   *     if (VoiceInput.isRecording) {
   *       VoiceInput._composeBarMode = true;
   *       VoiceInput.stop();
   *     } else {
   *       if (!this._open) this.open();
   *       VoiceInput._composeBarMode = true;
   *       VoiceInput.start();
   *     }
   *   };
   */
  interface MockVoiceInput {
    isRecording: boolean;
    _composeBarMode: boolean;
    startCalled: boolean;
    stopCalled: boolean;
  }

  interface MockPanel {
    _open: boolean;
    openCalled: boolean;
  }

  function micHandler(voiceInput: MockVoiceInput | undefined, panel: MockPanel): void {
    if (typeof voiceInput === 'undefined') return;
    if (voiceInput.isRecording) {
      voiceInput._composeBarMode = true;
      voiceInput.stopCalled = true; // simulates VoiceInput.stop()
    } else {
      if (!panel._open) {
        panel.openCalled = true; // simulates this.open()
        panel._open = true;
      }
      voiceInput._composeBarMode = true;
      voiceInput.startCalled = true; // simulates VoiceInput.start()
    }
  }

  it('calls start() when not recording', () => {
    const voiceInput: MockVoiceInput = {
      isRecording: false,
      _composeBarMode: false,
      startCalled: false,
      stopCalled: false,
    };
    const panel: MockPanel = { _open: true, openCalled: false };
    micHandler(voiceInput, panel);
    expect(voiceInput.startCalled).toBe(true);
    expect(voiceInput.stopCalled).toBe(false);
  });

  it('calls stop() when already recording', () => {
    const voiceInput: MockVoiceInput = {
      isRecording: true,
      _composeBarMode: false,
      startCalled: false,
      stopCalled: false,
    };
    const panel: MockPanel = { _open: true, openCalled: false };
    micHandler(voiceInput, panel);
    expect(voiceInput.stopCalled).toBe(true);
    expect(voiceInput.startCalled).toBe(false);
  });

  it('sets _composeBarMode = true when starting', () => {
    const voiceInput: MockVoiceInput = {
      isRecording: false,
      _composeBarMode: false,
      startCalled: false,
      stopCalled: false,
    };
    const panel: MockPanel = { _open: true, openCalled: false };
    micHandler(voiceInput, panel);
    expect(voiceInput._composeBarMode).toBe(true);
  });

  it('sets _composeBarMode = true when stopping', () => {
    const voiceInput: MockVoiceInput = {
      isRecording: true,
      _composeBarMode: false,
      startCalled: false,
      stopCalled: false,
    };
    const panel: MockPanel = { _open: true, openCalled: false };
    micHandler(voiceInput, panel);
    expect(voiceInput._composeBarMode).toBe(true);
  });

  it('opens compose panel if not already open when starting', () => {
    const voiceInput: MockVoiceInput = {
      isRecording: false,
      _composeBarMode: false,
      startCalled: false,
      stopCalled: false,
    };
    const panel: MockPanel = { _open: false, openCalled: false };
    micHandler(voiceInput, panel);
    expect(panel.openCalled).toBe(true);
    expect(voiceInput.startCalled).toBe(true);
  });

  it('does not call open() if compose panel already open', () => {
    const voiceInput: MockVoiceInput = {
      isRecording: false,
      _composeBarMode: false,
      startCalled: false,
      stopCalled: false,
    };
    const panel: MockPanel = { _open: true, openCalled: false };
    micHandler(voiceInput, panel);
    expect(panel.openCalled).toBe(false);
  });

  it('does nothing when VoiceInput is undefined', () => {
    const panel: MockPanel = { _open: false, openCalled: false };
    micHandler(undefined, panel);
    expect(panel.openCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 4: MediaRecorder audioBitsPerSecond
// ---------------------------------------------------------------------------

describe('MediaRecorder audioBitsPerSecond (voice-input.js lines 191-193)', () => {
  /**
   * Replicates the recorder options logic from DeepgramProvider._startRecording():
   *
   *   const isAac = this._selectedMime && this._selectedMime.includes('aac');
   *   const bitrate = isAac ? 64000 : 16000;
   *   const recorderOpts = this._selectedMime
   *     ? { mimeType: this._selectedMime, audioBitsPerSecond: bitrate }
   *     : { audioBitsPerSecond: bitrate };
   */
  function buildRecorderOpts(selectedMime: string | null): Record<string, unknown> {
    const isAac = selectedMime && selectedMime.includes('aac');
    const bitrate = isAac ? 64000 : 16000;
    return selectedMime ? { mimeType: selectedMime, audioBitsPerSecond: bitrate } : { audioBitsPerSecond: bitrate };
  }

  it('includes audioBitsPerSecond: 16000 when MIME type is selected', () => {
    const opts = buildRecorderOpts('audio/webm;codecs=opus');
    expect(opts.audioBitsPerSecond).toBe(16000);
    expect(opts.mimeType).toBe('audio/webm;codecs=opus');
  });

  it('includes audioBitsPerSecond: 16000 when no MIME type selected (null)', () => {
    const opts = buildRecorderOpts(null);
    expect(opts.audioBitsPerSecond).toBe(16000);
    expect(opts).not.toHaveProperty('mimeType');
  });

  it('includes audioBitsPerSecond: 64000 for mp4/aac (iOS path)', () => {
    const opts = buildRecorderOpts('audio/mp4;codecs=aac');
    expect(opts.audioBitsPerSecond).toBe(64000);
    expect(opts.mimeType).toBe('audio/mp4;codecs=aac');
  });

  it('does not include mimeType key when selectedMime is null', () => {
    const opts = buildRecorderOpts(null);
    expect(Object.keys(opts)).toEqual(['audioBitsPerSecond']);
  });
});

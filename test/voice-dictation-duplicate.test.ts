/**
 * @fileoverview Regression tests for duplicated dictation text.
 *
 * Bug: pressing the mic and speaking inserted the transcript TWICE — once from
 * the "iOS Safari stability check" (which committed a stable interim result
 * after 750ms) and once again when the browser later delivered the real
 * `isFinal` result for the same utterance.
 *
 * The stability check is a workaround for iOS Safari, where `isFinal` never
 * arrives. It must not fire on browsers that do deliver final results.
 *
 * These tests evaluate the real src/web/public/voice-input.js in a VM sandbox
 * and drive VoiceInput._onWebSpeechResult() directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const UA_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

interface Harness {
  VoiceInput: any;
  sendInput: ReturnType<typeof vi.fn>;
}

function loadVoiceInput(opts: { ios: boolean }): Harness {
  const src = readFileSync(join(repoRoot, 'src/web/public/voice-input.js'), 'utf8');
  const sendInput = vi.fn(() => Promise.resolve());

  const sandbox: any = {
    console,
    Date,
    // Wrappers so vitest fake timers (installed on the host globalThis) apply.
    setTimeout: (fn: any, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    setInterval: (fn: any, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: any) => clearInterval(id),
    localStorage: { getItem: () => '{}', setItem: () => {} },
    navigator: { userAgent: opts.ios ? UA_IOS : UA_CHROME, maxTouchPoints: opts.ios ? 5 : 0 },
    document: { getElementById: () => null, querySelector: () => null },
    window: {},
    MobileDetection: { isIOS: () => opts.ios, isSafari: () => opts.ios },
    app: { activeSessionId: 'session-1', sendInput, showToast: () => {}, terminal: null },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__VoiceInput = VoiceInput;', sandbox);

  const VoiceInput = sandbox.__VoiceInput;
  // Stub DOM-touching helpers — this test is about transcript commit logic.
  VoiceInput._showPreview = () => {};
  VoiceInput._hidePreview = () => {};
  VoiceInput._showVoiceSendBtn = () => {};
  VoiceInput.isRecording = true;
  VoiceInput._activeProvider = 'webspeech';
  return { VoiceInput, sendInput };
}

/** Build a SpeechRecognition result event with a single alternative. */
function speechEvent(transcript: string, isFinal: boolean) {
  return {
    resultIndex: 0,
    results: [Object.assign([{ transcript }], { isFinal })],
  };
}

describe('voice dictation — no duplicate insert', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('inserts a transcript once on a browser that delivers isFinal (Chrome)', () => {
    const { VoiceInput, sendInput } = loadVoiceInput({ ios: false });

    // Interim result, then the same interim repeats (transcript is stable).
    VoiceInput._onWebSpeechResult(speechEvent('hello world', false));
    vi.advanceTimersByTime(1000); // past the 750ms stability window

    // Browser now delivers the real final result for the same utterance.
    VoiceInput._onWebSpeechResult(speechEvent('hello world', true));
    vi.advanceTimersByTime(1000);

    expect(sendInput.mock.calls.map((c) => c[0])).toEqual(['hello world']);
  });

  it('still commits stable interim text on iOS Safari, where isFinal never arrives', () => {
    const { VoiceInput, sendInput } = loadVoiceInput({ ios: true });

    VoiceInput._onWebSpeechResult(speechEvent('hello world', false));
    vi.advanceTimersByTime(1000);

    expect(sendInput.mock.calls.map((c) => c[0])).toEqual(['hello world']);
  });

  it('does not re-commit an utterance the stability timer already sent', () => {
    const { VoiceInput, sendInput } = loadVoiceInput({ ios: true });

    VoiceInput._onWebSpeechResult(speechEvent('hello world', false));
    vi.advanceTimersByTime(1000);
    // A late final for the same text (iOS 17+ sometimes does deliver one).
    VoiceInput._onWebSpeechResult(speechEvent('hello world', true));
    vi.advanceTimersByTime(1000);

    expect(sendInput.mock.calls.map((c) => c[0])).toEqual(['hello world']);
  });
});

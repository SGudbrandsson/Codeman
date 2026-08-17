// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for TtsEngine — the chunked text-to-speech engine
 * shared by the transcript play button and the files-sheet doc reader
 * (src/web/public/tts-engine.js).
 *
 * The REAL object literal is extracted from the shipped source and evaluated
 * against stubbed fetch / Audio / speechSynthesis, so the segmentation,
 * provider chain, prefetch and fallback logic under test is exactly the code
 * that ships. Actual audio output is out of scope (no engine in jsdom).
 *
 * Run: npx vitest run test/tts-engine.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import engineSource from '../src/web/public/tts-engine.js?raw';

const ENGINE_SOURCE = engineSource as string;

/** Source text of the TtsEngine object literal, without the const binding. */
function engineLiteral(): string {
  const decl = 'const TtsEngine = {';
  const start = ENGINE_SOURCE.indexOf(decl);
  expect(start, 'TtsEngine not found').toBeGreaterThan(-1);
  const end = ENGINE_SOURCE.indexOf('\n};\n', start);
  expect(end, 'TtsEngine has no top-level close').toBeGreaterThan(start);
  return ENGINE_SOURCE.slice(start + decl.length - 1, end + 2);
}

interface Utter {
  text: string;
  onend?: () => void;
  onerror?: () => void;
}

interface FakeAudio {
  src: string;
  play: () => Promise<void>;
  pause: () => void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

let spoken: Utter[];
let audios: FakeAudio[];
let engine: any;

function makeEngine(settings: Record<string, unknown> = {}) {
  spoken = [];
  audios = [];
  localStorage.setItem('codeman-voice-settings', JSON.stringify(settings));

  (window as any).SpeechSynthesisUtterance = class {
    text: string;
    constructor(text: string) {
      this.text = text;
    }
  };
  (window as any).speechSynthesis = {
    speaking: false,
    pending: false,
    paused: false,
    speak: vi.fn((u: Utter) => spoken.push(u)),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  // jsdom's HTMLMediaElement.play() throws "not implemented"; a stub keeps the
  // element observable (src assignments, ended callbacks) without that noise.
  (window as any).Audio = class {
    src = '';
    preload = '';
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    play = vi.fn(() => Promise.resolve());
    pause = vi.fn();
    load = vi.fn();
    removeAttribute = vi.fn();
    constructor() {
      audios.push(this as unknown as FakeAudio);
    }
  };
  (window as any).URL.createObjectURL = vi.fn((b: Blob) => 'blob:' + (b as any)._tag);
  (window as any).URL.revokeObjectURL = vi.fn();

  return new Function(
    'window',
    'document',
    'localStorage',
    'URL',
    'fetch',
    'Audio',
    'SpeechSynthesisUtterance',
    'setTimeout',
    `return (${engineLiteral()});`
  )(
    window,
    document,
    localStorage,
    (window as any).URL,
    (...args: unknown[]) => (globalThis as any).fetch(...(args as [])),
    (window as any).Audio,
    (window as any).SpeechSynthesisUtterance,
    setTimeout
  );
}

/** A fetch stub that answers every synthesis request with a tagged blob. */
function stubFetch(handler: (url: string, init: any) => Promise<any> | any) {
  const spy = vi.fn((url: string, init: any) => Promise.resolve(handler(url, init)));
  (globalThis as any).fetch = spy;
  return spy;
}

function okAudio(tag: string) {
  const blob: any = new Blob(['x']);
  blob._tag = tag;
  return { ok: true, status: 200, blob: () => Promise.resolve(blob) };
}

/** Lets queued microtasks (the prefetch/playback promise chain) settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  engine = makeEngine();
});

// ─── stripMarkdown() ────────────────────────────────────────────────────────

describe('TtsEngine.stripMarkdown()', () => {
  it('drops fenced code blocks but keeps a paragraph break in their place', () => {
    expect(engine.stripMarkdown('Before.\n\n```js\nconst x = 1;\n```\n\nAfter.')).toBe('Before.\n\nAfter.');
  });

  it('removes inline code, emphasis markers and heading hashes', () => {
    expect(engine.stripMarkdown('## Title\nRun `npm i` for **bold** and _soft_ text.')).toBe(
      'Title\nRun for bold and soft text.'
    );
  });

  it('keeps link and image labels, drops the targets', () => {
    expect(engine.stripMarkdown('See [the docs](https://x.dev) and ![a chart](/c.png).')).toBe(
      'See the docs and a chart.'
    );
  });

  it('strips list markers without gluing the items together', () => {
    expect(engine.stripMarkdown('- one\n- two\n1. three')).toBe('one\ntwo\nthree');
  });

  it('preserves paragraph boundaries — they are the chunk boundaries', () => {
    expect(engine.stripMarkdown('One.\n\n\n\nTwo.')).toBe('One.\n\nTwo.');
  });

  it('collapses runs of spaces but never newlines', () => {
    expect(engine.stripMarkdown('a    b\n\nc')).toBe('a b\n\nc');
  });

  it('tolerates null and undefined', () => {
    expect(engine.stripMarkdown(null)).toBe('');
    expect(engine.stripMarkdown(undefined)).toBe('');
  });
});

// ─── segment() ──────────────────────────────────────────────────────────────

describe('TtsEngine.segment()', () => {
  it('returns nothing for empty or code-only text', () => {
    expect(engine.segment('')).toEqual([]);
    expect(engine.segment('```\ncode\n```')).toEqual([]);
  });

  it('keeps the first chunk under FIRST_CHUNK so playback starts fast', () => {
    const long = 'This is a sentence of a fairly ordinary length. '.repeat(40);
    const chunks = engine.segment(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(engine.FIRST_CHUNK);
  });

  it('never exceeds MERGE_TARGET on the chunks after the first', () => {
    const doc = Array.from({ length: 30 }, (_, i) => `Paragraph number ${i} says something.`).join('\n\n');
    for (const chunk of engine.segment(doc).slice(1)) {
      expect(chunk.length).toBeLessThanOrEqual(engine.MERGE_TARGET);
    }
  });

  it('merges short paragraphs so a bullet list is not one request per bullet', () => {
    const list = '- alpha\n\n- beta\n\n- gamma\n\n- delta';
    expect(engine.segment(list)).toEqual(['alpha beta gamma delta']);
  });

  it('splits an oversized paragraph on sentence boundaries', () => {
    const sentence = 'Sentence number one here. ';
    const chunks = engine.segment(sentence.repeat(60));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(engine.MAX_CHUNK);
      expect(chunk.endsWith('.')).toBe(true);
    }
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(sentence.repeat(60).trim());
  });

  it('word-slices a punctuation-free run rather than cutting mid-word', () => {
    const chunks = engine.segment('word '.repeat(400).trim());
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk).toMatch(/^word( word)*$/);
  });

  it('loses no words from a mixed document', () => {
    const doc = '# Heading\n\nFirst para with `code` inline.\n\n- a bullet\n- another\n\nLast para.';
    const words = engine.stripMarkdown(doc).split(/\s+/).filter(Boolean);
    expect(engine.segment(doc).join(' ').split(/\s+/).filter(Boolean)).toEqual(words);
  });

  it('is written without a regex lookbehind (older iOS Safari throws at parse time)', () => {
    expect(ENGINE_SOURCE).not.toMatch(/\(\?<[=!]/);
  });
});

// ─── Provider selection ─────────────────────────────────────────────────────

describe('TtsEngine.preferredProvider()', () => {
  it('picks Deepgram when a key is stored', () => {
    engine = makeEngine({ apiKey: 'dg-key' });
    expect(engine.preferredProvider()).toBe('deepgram');
    expect(engine.providerName()).toBe('Deepgram thalia');
  });

  it('falls back to the server proxy with no key', () => {
    expect(engine.preferredProvider()).toBe('server');
  });

  it('honours an explicit browser-only choice even with a key present', () => {
    engine = makeEngine({ apiKey: 'dg-key', ttsProvider: 'browser' });
    expect(engine.preferredProvider()).toBe('web');
    expect(engine.providerName()).toBe('Browser speech');
  });

  it('honours an explicit server choice even with a key present', () => {
    engine = makeEngine({ apiKey: 'dg-key', ttsProvider: 'server' });
    expect(engine.preferredProvider()).toBe('server');
  });

  it('uses the configured Deepgram voice', () => {
    engine = makeEngine({ apiKey: 'k', ttsVoice: 'aura-2-apollo-en' });
    expect(engine.voice()).toBe('aura-2-apollo-en');
  });

  it('survives a corrupt settings blob', () => {
    localStorage.setItem('codeman-voice-settings', '{not json');
    expect(engine.config()).toEqual({});
  });
});

// ─── Browser playback path ──────────────────────────────────────────────────

describe('TtsEngine web speech playback', () => {
  beforeEach(() => {
    engine = makeEngine({ ttsProvider: 'browser' });
  });

  it('speaks the first chunk synchronously and chains the rest', () => {
    expect(engine.play({ items: ['one.', 'two.'] })).toBe(true);
    expect(spoken.map((u) => u.text)).toEqual(['one.']);
    spoken[0].onend!();
    expect(spoken.map((u) => u.text)).toEqual(['one.', 'two.']);
    spoken[1].onend!();
    expect(engine.isPlaying()).toBe(false);
  });

  it('reports progress per chunk', () => {
    const seen: Array<[string, number]> = [];
    engine.play({ items: ['one.', 'two.'], onChunkStart: (i: string, n: number) => seen.push([i, n]) });
    spoken[0].onend!();
    expect(seen).toEqual([
      ['one.', 0],
      ['two.', 1],
    ]);
  });

  it('skips a failed utterance instead of stranding the text', () => {
    engine.play({ items: ['one.', 'two.'] });
    spoken[0].onerror!();
    expect(spoken.map((u) => u.text)).toEqual(['one.', 'two.']);
  });

  it('ignores callbacks from a superseded session', () => {
    engine.play({ items: ['one.', 'two.'] });
    const stale = spoken[0];
    engine.play({ items: ['fresh.'] });
    stale.onend!();
    expect(spoken.map((u) => u.text)).toEqual(['one.', 'fresh.']);
  });

  it('fires onEnd exactly once when stopped', () => {
    const onEnd = vi.fn();
    engine.play({ items: ['one.'], onEnd });
    engine.stop();
    engine.stop();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('refuses to start with no items', () => {
    expect(engine.play({ items: [] })).toBe(false);
  });

  it('accepts {text} objects as well as bare strings', () => {
    engine.play({ items: [{ text: 'hello.', el: null }] });
    expect(spoken.map((u) => u.text)).toEqual(['hello.']);
  });
});

// ─── Remote playback, prefetch and fallback ─────────────────────────────────

describe('TtsEngine remote playback', () => {
  it('sends each chunk to Deepgram with the key and voice', async () => {
    engine = makeEngine({ apiKey: 'dg-key', ttsVoice: 'aura-2-apollo-en' });
    const fetchSpy = stubFetch((_url) => okAudio('a'));
    engine.play({ items: ['one.'] });
    await flush();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.deepgram.com/v1/speak?model=aura-2-apollo-en');
    expect(init.headers.Authorization).toBe('Token dg-key');
    expect(JSON.parse(init.body)).toEqual({ text: 'one.' });
  });

  it('prefetches ahead so the next chunk is ready before the current one ends', async () => {
    engine = makeEngine({ apiKey: 'dg-key' });
    const fetchSpy = stubFetch(() => okAudio('a'));
    engine.play({ items: ['one.', 'two.', 'three.', 'four.', 'five.'] });
    await flush();
    // Current chunk + PREFETCH ahead — not the whole document.
    expect(fetchSpy).toHaveBeenCalledTimes(engine.PREFETCH + 1);
  });

  it('advances to the next chunk when the audio element ends', async () => {
    engine = makeEngine({ apiKey: 'dg-key' });
    let n = 0;
    stubFetch(() => okAudio('t' + n++));
    const seen: number[] = [];
    engine.play({ items: ['one.', 'two.'], onChunkStart: (_i: unknown, idx: number) => seen.push(idx) });
    await flush();
    expect(audios[0].src).toMatch(/^blob:/);

    audios[0].onended!();
    await flush();
    expect(seen).toEqual([0, 1]);
  });

  it('falls back to the server proxy when Deepgram rejects the key', async () => {
    engine = makeEngine({ apiKey: 'bad-key' });
    const fetchSpy = stubFetch((url) => (url.includes('deepgram') ? { ok: false, status: 401 } : okAudio('s')));
    engine.play({ items: ['one.'] });
    await flush();

    expect(fetchSpy.mock.calls.map((c) => c[0])).toContain('/api/tts');
    expect(engine.activeProvider()).toBe('server');
  });

  it('pins the working provider so a bad key costs one failed request, not one per chunk', async () => {
    engine = makeEngine({ apiKey: 'bad-key' });
    const fetchSpy = stubFetch((url) => (url.includes('deepgram') ? { ok: false, status: 401 } : okAudio('s')));
    engine.play({ items: ['one.', 'two.', 'three.'] });
    await flush();

    const deepgramCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('deepgram'));
    expect(deepgramCalls).toHaveLength(1);
  });

  it('degrades to browser speech when every network provider fails', async () => {
    engine = makeEngine({ apiKey: 'dg-key' });
    stubFetch(() => ({ ok: false, status: 502 }));
    engine.play({ items: ['one.', 'two.'] });
    await flush();

    expect(engine.activeProvider()).toBe('web');
    expect(spoken.map((u) => u.text)).toEqual(['one.']);
  });

  it('revokes object URLs as chunks finish and on stop', async () => {
    engine = makeEngine({ apiKey: 'dg-key' });
    let n = 0;
    stubFetch(() => okAudio('t' + n++));
    engine.play({ items: ['one.', 'two.'] });
    await flush();

    audios[0].onended!();
    await flush();
    expect((window as any).URL.revokeObjectURL).toHaveBeenCalled();

    engine.stop();
    await flush();
    const revoked = ((window as any).URL.revokeObjectURL as any).mock.calls.length;
    const created = ((window as any).URL.createObjectURL as any).mock.calls.length;
    expect(revoked).toBe(created);
  });

  it('claims audio permission synchronously, before any network round-trip', () => {
    engine = makeEngine({ apiKey: 'dg-key' });
    stubFetch(() => okAudio('a'));
    engine.play({ items: ['one.'] });
    // iOS grants playback only inside the gesture — the silent unlock clip must
    // already have been played by the time play() returns.
    expect(audios).toHaveLength(1);
    expect(audios[0].play).toHaveBeenCalled();
  });

  it('stops cleanly when autoplay is blocked', async () => {
    engine = makeEngine({ apiKey: 'dg-key' });
    stubFetch(() => okAudio('a'));
    const onEnd = vi.fn();
    engine.play({ items: ['one.', 'two.'], onEnd });
    const blocked = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    audios[0].play = vi.fn(() => Promise.reject(blocked)) as any;
    await flush();
    expect(engine.isPlaying()).toBe(false);
    expect(onEnd).toHaveBeenCalledWith(false);
  });

  it('skips an undecodable clip instead of stranding the rest of the text', async () => {
    engine = makeEngine({ apiKey: 'dg-key' });
    let n = 0;
    stubFetch(() => okAudio('t' + n++));
    const seen: number[] = [];
    engine.play({ items: ['one.', 'two.'], onChunkStart: (_i: unknown, idx: number) => seen.push(idx) });
    const broken = Object.assign(new Error('bad media'), { name: 'NotSupportedError' });
    audios[0].play = vi.fn(() => Promise.reject(broken)) as any;
    await flush();
    expect(seen).toEqual([0, 1]);
  });

  it('counts a clip that fails through both onerror and a rejected play() only once', async () => {
    engine = makeEngine({ apiKey: 'dg-key' });
    let n = 0;
    stubFetch(() => okAudio('t' + n++));
    const seen: number[] = [];
    engine.play({ items: ['one.', 'two.', 'three.'], onChunkStart: (_i: unknown, idx: number) => seen.push(idx) });
    const broken = Object.assign(new Error('bad media'), { name: 'NotSupportedError' });
    // Only the first clip is broken — if the double report advanced twice,
    // chunk 1 would be skipped and 'three.' would be announced instead.
    let calls = 0;
    audios[0].play = vi.fn(() => {
      if (++calls > 1) return Promise.resolve();
      audios[0].onerror!();
      return Promise.reject(broken);
    }) as any;
    await flush();
    expect(seen).toEqual([0, 1]);
  });
});

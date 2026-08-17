// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for TranscriptTTS — the read-aloud button on
 * assistant messages in the transcript (src/web/public/app.js).
 *
 * The REAL TranscriptTTS object literal is extracted from the shipped app.js
 * and evaluated against the REAL TtsEngine (tts-engine.js) with a stubbed
 * speech engine, so the button-state machine and its delegation to the engine
 * are exercised as shipped. Markdown stripping and chunking now live in
 * TtsEngine and are covered by test/tts-engine.test.ts.
 *
 * Run: npx vitest run test/transcript-tts.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import engineSource from '../src/web/public/tts-engine.js?raw';

const APP_JS_SOURCE = appSource as string;
const ENGINE_SOURCE = engineSource as string;

// ─── Real-source extraction ─────────────────────────────────────────────────

/** Source text of a top-level object literal, without its const binding. */
function objectSource(source: string, decl: string): string {
  const start = source.indexOf(decl);
  expect(start, `${decl} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n};\n', start);
  expect(end, `${decl} has no top-level close`).toBeGreaterThan(start);
  return source.slice(start + decl.length - 1, end + 2);
}

interface Utter {
  text: string;
  onend?: () => void;
  onerror?: () => void;
}

let spoken: Utter[];
let engine: any;
let tts: any;

/**
 * Compiles TranscriptTTS against the real engine, pinned to the browser
 * provider so playback is synchronous and observable without a network stub.
 */
function makeTts() {
  spoken = [];
  localStorage.setItem('codeman-voice-settings', JSON.stringify({ ttsProvider: 'browser' }));

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

  engine = new Function('SpeechSynthesisUtterance', `return (${objectSource(ENGINE_SOURCE, 'const TtsEngine = {')});`)(
    (window as any).SpeechSynthesisUtterance
  );
  (window as any).TtsEngine = engine;
  return new Function('TtsEngine', `return (${objectSource(APP_JS_SOURCE, 'const TranscriptTTS = {')});`)(engine);
}

/** A button in its initial (idle) state, as the transcript renderer builds it. */
function createTTSButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'tv-tts-btn';
  btn.setAttribute('aria-label', 'Read aloud');
  btn.setAttribute('title', 'Read aloud');
  btn.appendChild(tts._speakerSVG());
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = '';
  tts = makeTts();
});

// ─── SVG factories ──────────────────────────────────────────────────────────

const svgNS = 'http://www.w3.org/2000/svg';

describe('TranscriptTTS._speakerSVG', () => {
  it('is a 14×14 currentColor SVG in the SVG namespace', () => {
    const svg = tts._speakerSVG();
    expect(svg.namespaceURI).toBe(svgNS);
    expect(svg.getAttribute('width')).toBe('14');
    expect(svg.getAttribute('height')).toBe('14');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('fill')).toBe('none');
  });

  it('draws a speaker cone plus two sound arcs', () => {
    const children = Array.from(tts._speakerSVG().children) as Element[];
    expect(children.map((c) => c.tagName)).toEqual(['polygon', 'path', 'path']);
    expect(children[0].getAttribute('points')).toBe('11 5 6 9 2 9 2 15 6 15 11 19 11 5');
  });
});

describe('TranscriptTTS._stopSVG', () => {
  it('is a 14×14 currentColor SVG in the SVG namespace', () => {
    const svg = tts._stopSVG();
    expect(svg.namespaceURI).toBe(svgNS);
    expect(svg.getAttribute('width')).toBe('14');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
  });

  it('draws a single rounded square', () => {
    const children = Array.from(tts._stopSVG().children) as Element[];
    expect(children.map((c) => c.tagName)).toEqual(['rect']);
    expect(children[0].getAttribute('width')).toBe('18');
    expect(children[0].getAttribute('rx')).toBe('2');
  });
});

// ─── speak() ────────────────────────────────────────────────────────────────

describe('TranscriptTTS.speak', () => {
  it('swaps the speaker icon for a stop icon and marks the button speaking', () => {
    const btn = createTTSButton();
    expect(btn.querySelector('polygon')).not.toBeNull();

    tts.speak(btn, 'Hello world.');

    expect(btn.querySelector('rect')).not.toBeNull();
    expect(btn.querySelector('polygon')).toBeNull();
    expect(btn.children).toHaveLength(1);
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Stop reading aloud');
  });

  it('starts speaking immediately rather than waiting for the whole reply', () => {
    const btn = createTTSButton();
    const long = 'This is one sentence of an ordinary length. '.repeat(30);
    tts.speak(btn, long);

    // Exactly one chunk is outstanding, and it is a small fraction of the reply.
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text.length).toBeLessThanOrEqual(engine.FIRST_CHUNK);
    expect(spoken[0].text.length).toBeLessThan(long.length / 4);
  });

  it('chains the remaining chunks and resets the button at the end', () => {
    const btn = createTTSButton();
    tts.speak(btn, 'A sentence of a perfectly ordinary length goes here. '.repeat(20));

    const total = engine._items.length;
    expect(total).toBeGreaterThan(1);
    for (let i = 0; i < total; i++) spoken[i].onend!();

    expect(engine.isPlaying()).toBe(false);
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(false);
    expect(btn.querySelector('polygon')).not.toBeNull();
  });

  it('reports chunk progress in the tooltip', () => {
    const btn = createTTSButton();
    tts.speak(btn, 'A sentence of a perfectly ordinary length goes here. '.repeat(20));
    const total = engine._items.length;
    expect(btn.getAttribute('title')).toBe(`Stop reading aloud (1/${total})`);

    spoken[0].onend!();
    expect(btn.getAttribute('title')).toBe(`Stop reading aloud (2/${total})`);
  });

  it('strips markdown before speaking', () => {
    const btn = createTTSButton();
    tts.speak(btn, '## Heading\n\nRun `npm i` for **bold** text.');
    const text = engine._items.join(' ');
    expect(text).not.toContain('#');
    expect(text).not.toContain('`');
    expect(text).not.toContain('**');
    expect(text).toContain('Heading');
  });

  it('does nothing for a message with no readable text', () => {
    const btn = createTTSButton();
    tts.speak(btn, '```\nconst x = 1;\n```');
    expect(spoken).toHaveLength(0);
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(false);
  });
});

// ─── Toggle / hand-off ──────────────────────────────────────────────────────

describe('TranscriptTTS toggling', () => {
  it('tapping the same button again stops playback and restores the icon', () => {
    const btn = createTTSButton();
    tts.speak(btn, 'Hello world.');
    tts.speak(btn, 'Hello world.');

    expect(engine.isPlaying()).toBe(false);
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(false);
    expect(btn.querySelector('polygon')).not.toBeNull();
    expect(btn.getAttribute('title')).toBe('Read aloud');
  });

  it('tapping a second message resets the first button and speaks the new one', () => {
    const first = createTTSButton();
    const second = createTTSButton();
    tts.speak(first, 'First message.');
    tts.speak(second, 'Second message.');

    expect(first.classList.contains('tv-tts-btn--speaking')).toBe(false);
    expect(first.querySelector('polygon')).not.toBeNull();
    expect(second.classList.contains('tv-tts-btn--speaking')).toBe(true);
    expect(second.querySelector('rect')).not.toBeNull();
    expect(spoken.map((u) => u.text)).toEqual(['First message.', 'Second message.']);
  });

  it('ignores a stale utterance callback from a superseded message', () => {
    const first = createTTSButton();
    const second = createTTSButton();
    tts.speak(first, 'First message.');
    const stale = spoken[0];
    tts.speak(second, 'Second message.');

    stale.onend!();
    expect(engine.isPlaying()).toBe(true);
    expect(second.classList.contains('tv-tts-btn--speaking')).toBe(true);
  });

  it('survives a redundant stop', () => {
    const btn = createTTSButton();
    tts.speak(btn, 'Hello world.');
    tts.stop();
    tts.stop();
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(false);
  });
});

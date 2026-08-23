// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for the read-aloud UI layer in app.js: the
 * TtsPlaybackBar transport, the ReadAloud controller that wires engine +
 * highlight + bar, the TranscriptTTS button, the FilesTTS adapter, and
 * stripFrontmatter.
 *
 * The REAL object literals are extracted from the shipped app.js and evaluated
 * against the REAL TtsEngine (tts-engine.js) with a stubbed speech engine, so
 * the wiring under test is what ships.
 *
 * Run: npx vitest run test/read-aloud-ui.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import engineSource from '../src/web/public/tts-engine.js?raw';

const APP_JS_SOURCE = appSource as string;
const ENGINE_SOURCE = engineSource as string;

// ─── Real-source extraction ─────────────────────────────────────────────────

function objectSource(source: string, decl: string): string {
  const start = source.indexOf(decl);
  expect(start, `${decl} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n};\n', start);
  expect(end, `${decl} has no top-level close`).toBeGreaterThan(start);
  return source.slice(start + decl.length - 1, end + 2);
}

/**
 * stripFrontmatter is a plain function, not an object literal, and it reads a
 * module-level constant — so the constant is pulled in with it.
 */
function functionSource(name: string): string {
  const constDecl = 'const MAX_FRONTMATTER_LINES';
  const start = APP_JS_SOURCE.indexOf(constDecl);
  expect(start, `${constDecl} not found`).toBeGreaterThan(-1);
  const fnStart = APP_JS_SOURCE.indexOf(`function ${name}(`, start);
  expect(fnStart, `${name} not found`).toBeGreaterThan(-1);
  const end = APP_JS_SOURCE.indexOf('\n}\n', fnStart);
  expect(end, `${name} has no close`).toBeGreaterThan(fnStart);
  return APP_JS_SOURCE.slice(start, end + 2);
}

interface Utter {
  text: string;
  onend?: () => void;
  onerror?: () => void;
}

let spoken: Utter[];
let engine: any;
let bar: any;
let readAloud: any;
let transcriptTts: any;
let filesTts: any;
let prevEngine: any = null;

function build() {
  if (prevEngine) {
    try {
      prevEngine.stop();
    } catch {
      /* ignore */
    }
  }
  spoken = [];
  document.body.innerHTML = '';
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
  prevEngine = engine;
  (window as any).TtsEngine = engine;

  // The three app objects reference each other by name, so they are compiled
  // into one scope with late-bound locals.
  const factory = new Function(
    'TtsEngine',
    `
    const TtsPlaybackBar = ${objectSource(APP_JS_SOURCE, 'const TtsPlaybackBar = {')};
    const ReadAloud = ${objectSource(APP_JS_SOURCE, 'const ReadAloud = {')};
    const TranscriptTTS = ${objectSource(APP_JS_SOURCE, 'const TranscriptTTS = {')};
    const FilesTTS = ${objectSource(APP_JS_SOURCE, 'const FilesTTS = {')};
    return { TtsPlaybackBar, ReadAloud, TranscriptTTS, FilesTTS };
  `
  );
  const built = factory(engine);
  bar = built.TtsPlaybackBar;
  readAloud = built.ReadAloud;
  transcriptTts = built.TranscriptTTS;
  filesTts = built.FilesTTS;
}

function setContent(html: string, cls = 'tv-markdown'): HTMLElement {
  const host = document.createElement('div');
  host.className = cls;
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

function ttsButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'tv-tts-btn';
  btn.appendChild(transcriptTts._speakerSVG());
  document.body.appendChild(btn);
  return btn;
}

const barEl = () => document.getElementById('ttsBar') as HTMLElement;
const clickAct = (act: string) => (barEl().querySelector(`[data-act="${act}"]`) as HTMLElement).click();

beforeEach(build);

// ─── stripFrontmatter ───────────────────────────────────────────────────────

describe('stripFrontmatter', () => {
  const strip = (text: string) =>
    new Function(`${functionSource('stripFrontmatter')} return stripFrontmatter;`)()(text);

  it('removes a leading YAML fence', () => {
    expect(strip('---\nname: x\ndescription: y\n---\n\n# Title\n\nBody.')).toBe('# Title\n\nBody.');
  });

  it('leaves a document with no frontmatter alone', () => {
    expect(strip('# Title\n\nBody.')).toBe('# Title\n\nBody.');
  });

  it('leaves a document that merely opens with a horizontal rule alone', () => {
    expect(strip('---\n\nJust a rule, then prose.')).toBe('---\n\nJust a rule, then prose.');
  });

  it('does not strip when the fence never closes', () => {
    const doc = '---\n' + 'key: value\n'.repeat(200);
    expect(strip(doc)).toBe(doc);
  });

  it('does not strip when nothing would be left', () => {
    expect(strip('---\nonly: metadata\n---\n')).toBe('---\nonly: metadata\n---\n');
  });

  it('accepts the ... terminator', () => {
    expect(strip('---\nkey: v\n...\nBody.')).toBe('Body.');
  });

  it('tolerates a UTF-8 BOM', () => {
    expect(strip('﻿---\nkey: v\n---\nBody.')).toBe('Body.');
  });

  it('does not eat a first section between two horizontal rules', () => {
    const doc = '---\n# Title\nSome prose\n---\nMore text';
    expect(strip(doc)).toBe(doc);
  });

  it('accepts list-style frontmatter values', () => {
    expect(strip('---\ntags:\n  - one\n  - two\n---\nBody.')).toBe('Body.');
  });

  it('does not eat a rule-delimited bullet list', () => {
    const doc = '---\n- First item\n- Second item\n---\nActual content';
    expect(strip(doc)).toBe(doc);
  });

  it('requires the first key to be a mapping', () => {
    const doc = '---\njust prose here\n---\nBody.';
    expect(strip(doc)).toBe(doc);
  });

  it('leaves a setext heading alone', () => {
    expect(strip('Title\n---\nBody.')).toBe('Title\n---\nBody.');
  });

  it('passes non-strings straight through', () => {
    expect(strip(null as any)).toBe(null);
  });
});

// ─── ReadAloud ──────────────────────────────────────────────────────────────

describe('ReadAloud', () => {
  it('collects blocks from the rendered container and starts speaking', () => {
    const root = setContent('<p>First.</p><p>Second.</p>');
    expect(readAloud.start({ owner: 'transcript', root })).toBe(true);
    expect(spoken.map((u) => u.text)).toEqual(['First.']);
  });

  it('highlights the block being spoken and moves the highlight along', () => {
    const root = setContent('<p>First.</p><p>Second.</p>');
    readAloud.start({ owner: 'transcript', root });
    const ps = root.querySelectorAll('p');
    expect(ps[0].classList.contains('files-md-speaking')).toBe(true);

    spoken[0].onend!();
    expect(ps[0].classList.contains('files-md-speaking')).toBe(false);
    expect(ps[1].classList.contains('files-md-speaking')).toBe(true);
  });

  it('clears the highlight when playback ends', () => {
    const root = setContent('<p>Only.</p>');
    readAloud.start({ owner: 'transcript', root });
    spoken[0].onend!();
    expect(document.querySelectorAll('.files-md-speaking')).toHaveLength(0);
  });

  it('reports ownership so each caller only sees its own session', () => {
    const root = setContent('<p>Only.</p>');
    readAloud.start({ owner: 'files', root });
    expect(readAloud.isActive('files')).toBe(true);
    expect(readAloud.isActive('transcript')).toBe(false);
  });

  it('refuses a container with nothing readable', () => {
    const root = setContent('<pre><code>const x = 1;</code></pre>');
    expect(readAloud.start({ owner: 'transcript', root })).toBe(false);
  });

  it('starts from the selected block', () => {
    const root = setContent('<p>One.</p><p>Two.</p><p>Three.</p>');
    const second = root.querySelectorAll('p')[1];
    readAloud.start({ owner: 'transcript', root, startEl: second });
    expect(spoken.map((u) => u.text)).toEqual(['Two.']);
  });

  it('shows no bar when the session dies as it starts', () => {
    // speechSynthesis.speak() throwing runs stop() synchronously inside play().
    (window as any).speechSynthesis.speak = vi.fn(() => {
      throw new Error('engine dead');
    });
    const started = readAloud.start({ owner: 'transcript', root: setContent('<p>Only.</p>') });
    expect(started).toBe(false);
    expect(document.getElementById('ttsBar')?.classList.contains('is-visible')).toBeFalsy();
  });

  it('fires onEnd once per session', () => {
    const onEnd = vi.fn();
    readAloud.start({ owner: 'transcript', root: setContent('<p>Only.</p>'), onEnd });
    readAloud.stop();
    readAloud.stop();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('re-anchors the highlight after the container is re-rendered', () => {
    const root = setContent('<p>One.</p><p>Two.</p><p>Three.</p>');
    readAloud.start({ owner: 'files', root });
    spoken[0].onend!(); // now on "Two."

    root.innerHTML = '<p>One.</p><p>Two.</p><p>Three.</p>';
    readAloud.rebind(root);

    const fresh = root.querySelectorAll('p');
    expect(fresh[1].classList.contains('files-md-speaking')).toBe(true);
    expect(engine.blockAt(1).el).toBe(fresh[1]);
  });

  it('leaves the old refs alone when the document actually changed', () => {
    const root = setContent('<p>One.</p><p>Two.</p>');
    readAloud.start({ owner: 'files', root });
    spoken[0].onend!();
    const before = engine.blockAt(1).el;

    const other = setContent('<p>Totally different.</p>');
    readAloud.rebind(other);
    expect(engine.blockAt(1).el).toBe(before);
  });

  it('rebind is a no-op when nothing is playing', () => {
    expect(() => readAloud.rebind(setContent('<p>One.</p>'))).not.toThrow();
  });

  it('takes the selection anchor only when it lies inside the container', () => {
    const root = setContent('<p>Inside.</p>');
    const outside = setContent('<p>Outside.</p>');
    const range = document.createRange();
    range.selectNodeContents(outside.querySelector('p') as Node);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(readAloud.selectionAnchor(root)).toBeNull();
    expect(readAloud.selectionAnchor(outside)).not.toBeNull();
  });
});

// ─── TtsPlaybackBar ─────────────────────────────────────────────────────────

describe('TtsPlaybackBar', () => {
  it('appears on play and disappears when playback ends', () => {
    const root = setContent('<p>One.</p><p>Two.</p>');
    readAloud.start({ owner: 'transcript', root });
    expect(barEl().classList.contains('is-visible')).toBe(true);
    expect(document.body.classList.contains('has-tts-bar')).toBe(true);

    readAloud.stop();
    expect(barEl().classList.contains('is-visible')).toBe(false);
    expect(document.body.classList.contains('has-tts-bar')).toBe(false);
  });

  it('counts blocks, not segments', () => {
    const long = 'A sentence of ordinary length here. '.repeat(40).trim();
    const root = setContent(`<p>Lead.</p><p>${long}</p>`);
    readAloud.start({ owner: 'transcript', root });
    expect(barEl().querySelector('.tts-bar-count')!.textContent).toBe('1 / 2');
  });

  it('advances the count and the fill as blocks play', () => {
    const root = setContent('<p>One.</p><p>Two.</p><p>Three.</p><p>Four.</p>');
    readAloud.start({ owner: 'transcript', root });
    spoken[0].onend!();
    expect(barEl().querySelector('.tts-bar-count')!.textContent).toBe('2 / 4');
    expect((barEl().querySelector('.tts-bar-fill') as HTMLElement).style.width).toBe('50%');
  });

  it('pauses and resumes from the toggle button', () => {
    const root = setContent('<p>One.</p><p>Two.</p>');
    readAloud.start({ owner: 'transcript', root });

    clickAct('toggle');
    expect(engine.isPaused()).toBe(true);
    expect(barEl().classList.contains('is-paused')).toBe(true);
    expect(barEl().querySelector('.tts-bar-toggle')!.getAttribute('aria-label')).toBe('Resume');

    clickAct('toggle');
    expect(engine.isPaused()).toBe(false);
    expect(barEl().querySelector('.tts-bar-toggle')!.getAttribute('aria-label')).toBe('Pause');
  });

  it('steps blocks with next and prev', () => {
    const root = setContent('<p>One.</p><p>Two.</p><p>Three.</p>');
    readAloud.start({ owner: 'transcript', root });
    clickAct('next');
    expect(engine.position().index).toBe(1);
    clickAct('prev');
    expect(engine.position().index).toBe(0);
  });

  it('stops the session from the close button', () => {
    const root = setContent('<p>One.</p>');
    readAloud.start({ owner: 'transcript', root });
    clickAct('stop');
    expect(engine.isPlaying()).toBe(false);
    expect(barEl().classList.contains('is-visible')).toBe(false);
  });

  it('seeks to the block under the click on the track', () => {
    const root = setContent('<p>One.</p><p>Two.</p><p>Three.</p><p>Four.</p>');
    readAloud.start({ owner: 'transcript', root });
    const track = barEl().querySelector('.tts-bar-track') as HTMLElement;
    track.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;

    track.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 55 }));
    expect(engine.position().index).toBe(2);
    expect(spoken[spoken.length - 1].text).toBe('Three.');
  });

  it('clamps a click at the very end of the track to the last block', () => {
    const root = setContent('<p>One.</p><p>Two.</p>');
    readAloud.start({ owner: 'transcript', root });
    const track = barEl().querySelector('.tts-bar-track') as HTMLElement;
    track.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;

    track.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100 }));
    expect(engine.position().index).toBe(1);
  });

  it('exposes position to assistive tech', () => {
    const root = setContent('<p>One.</p><p>Two.</p>');
    readAloud.start({ owner: 'transcript', root });
    const track = barEl().querySelector('.tts-bar-track')!;
    expect(track.getAttribute('role')).toBe('slider');
    expect(track.getAttribute('aria-valuenow')).toBe('1');
    expect(track.getAttribute('aria-valuemax')).toBe('2');
    expect(track.getAttribute('aria-valuetext')).toBe('Block 1 of 2');
  });

  it('steps blocks from the keyboard', () => {
    const root = setContent('<p>One.</p><p>Two.</p>');
    readAloud.start({ owner: 'transcript', root });
    const track = barEl().querySelector('.tts-bar-track') as HTMLElement;

    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(engine.position().index).toBe(1);
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(engine.position().index).toBe(0);
  });

  it('reuses one bar element across sessions', () => {
    const root = setContent('<p>One.</p>');
    readAloud.start({ owner: 'transcript', root });
    readAloud.stop();
    readAloud.start({ owner: 'transcript', root });
    expect(document.querySelectorAll('#ttsBar')).toHaveLength(1);
  });
});

// ─── TranscriptTTS ──────────────────────────────────────────────────────────

describe('TranscriptTTS', () => {
  it('reads the rendered message, so inline code is spoken and fences are not', () => {
    const content = setContent('<p>Run <code>npm i</code> first.</p><pre><code>ignored()</code></pre>');
    transcriptTts.speak(ttsButton(), content);
    expect(spoken.map((u) => u.text)).toEqual(['Run npm i first.']);
  });

  it('swaps the speaker icon for a stop icon while speaking', () => {
    const btn = ttsButton();
    transcriptTts.speak(btn, setContent('<p>Hello.</p>'));
    expect(btn.querySelector('rect')).not.toBeNull();
    expect(btn.querySelector('polygon')).toBeNull();
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(true);
  });

  it('restores the icon when playback finishes', () => {
    const btn = ttsButton();
    transcriptTts.speak(btn, setContent('<p>Hello.</p>'));
    spoken[0].onend!();
    expect(btn.querySelector('polygon')).not.toBeNull();
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(false);
  });

  it('tapping the same button again stops', () => {
    const btn = ttsButton();
    const content = setContent('<p>Hello.</p><p>More.</p>');
    transcriptTts.speak(btn, content);
    transcriptTts.speak(btn, content);
    expect(engine.isPlaying()).toBe(false);
    expect(btn.querySelector('polygon')).not.toBeNull();
  });

  it('tapping a second message hands over cleanly', () => {
    const first = ttsButton();
    const second = ttsButton();
    transcriptTts.speak(first, setContent('<p>First message.</p>'));
    transcriptTts.speak(second, setContent('<p>Second message.</p>'));

    expect(first.classList.contains('tv-tts-btn--speaking')).toBe(false);
    expect(second.classList.contains('tv-tts-btn--speaking')).toBe(true);
    expect(spoken.map((u) => u.text)).toEqual(['First message.', 'Second message.']);
  });

  it('does nothing for a message with no readable text', () => {
    const btn = ttsButton();
    transcriptTts.speak(btn, setContent('<pre><code>only code</code></pre>'));
    expect(spoken).toHaveLength(0);
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(false);
    expect(barEl()?.classList.contains('is-visible')).toBeFalsy();
  });

  it('ignores a missing container', () => {
    expect(() => transcriptTts.speak(ttsButton(), null)).not.toThrow();
  });
});

// ─── Button icons ───────────────────────────────────────────────────────────

describe('TranscriptTTS icons', () => {
  const svgNS = 'http://www.w3.org/2000/svg';

  it('draws a speaker cone plus two sound arcs', () => {
    const svg = transcriptTts._speakerSVG();
    expect(svg.namespaceURI).toBe(svgNS);
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(Array.from(svg.children).map((c: any) => c.tagName)).toEqual(['polygon', 'path', 'path']);
  });

  it('draws a single rounded square for stop', () => {
    const svg = transcriptTts._stopSVG();
    expect(svg.namespaceURI).toBe(svgNS);
    expect(Array.from(svg.children).map((c: any) => c.tagName)).toEqual(['rect']);
    expect((svg.children[0] as Element).getAttribute('rx')).toBe('2');
  });
});

// ─── FilesTTS adapter ───────────────────────────────────────────────────────

describe('FilesTTS', () => {
  it('starts and reports playing only for its own session', () => {
    const preview = setContent('<p>Doc line.</p>', 'files-md-preview');
    expect(filesTts.start(preview, null, () => {})).toBe(true);
    expect(filesTts.isPlaying()).toBe(true);

    transcriptTts.speak(ttsButton(), setContent('<p>A message.</p>'));
    expect(filesTts.isPlaying()).toBe(false);
  });

  it('notifies its state callback exactly once when stopped', () => {
    const preview = setContent('<p>Doc line.</p>', 'files-md-preview');
    const onChange = vi.fn();
    filesTts.start(preview, null, onChange);
    filesTts.stop();
    filesTts.stop();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('does not stop a transcript session', () => {
    transcriptTts.speak(ttsButton(), setContent('<p>A message.</p>'));
    filesTts.stop();
    expect(engine.isPlaying()).toBe(true);
  });
});

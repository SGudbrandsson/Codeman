// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for the "Play from here" selection pills.
 *
 * Covers TranscriptPlayPill (the transcript affordance) end to end against the
 * REAL TtsEngine / ReadAloud / TranscriptTTS from source, plus the seek-vs-start
 * decision that both pills share.
 *
 * The files-sheet pill lives on the `app` class and is exercised through
 * filesPlayFromBlock, the method its pointerdown handler calls.
 *
 * Run: npx vitest run test/play-from-here-pill.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import engineSource from '../src/web/public/tts-engine.js?raw';

const APP_JS_SOURCE = appSource as string;
const ENGINE_SOURCE = engineSource as string;

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
let readAloud: any;
let transcriptTts: any;
let pill: any;
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

  const factory = new Function(
    'TtsEngine',
    `
    const TtsPlaybackBar = ${objectSource(APP_JS_SOURCE, 'const TtsPlaybackBar = {')};
    const ReadAloud = ${objectSource(APP_JS_SOURCE, 'const ReadAloud = {')};
    const TranscriptPlayPill = ${objectSource(APP_JS_SOURCE, 'const TranscriptPlayPill = {')};
    const TranscriptTTS = ${objectSource(APP_JS_SOURCE, 'const TranscriptTTS = {')};
    return { TtsPlaybackBar, ReadAloud, TranscriptPlayPill, TranscriptTTS };
  `
  );
  const built = factory(engine);
  readAloud = built.ReadAloud;
  transcriptTts = built.TranscriptTTS;
  pill = built.TranscriptPlayPill;
  (window as any).TranscriptTTS = transcriptTts;
  (window as any).ReadAloud = readAloud;
}

/**
 * Appends an assistant message to the transcript, mirroring the real DOM shape.
 * There is exactly one #transcriptView holding many messages — creating a
 * second would silently orphan every message after the first, since the pill
 * resolves the container by id.
 */
function setTranscript(html: string) {
  let view = document.getElementById('transcriptView');
  if (!view) {
    view = document.createElement('div');
    view.id = 'transcriptView';
    document.body.appendChild(view);
  }
  const wrap = document.createElement('div');
  wrap.className = 'tv-block';
  const content = document.createElement('div');
  content.className = 'tv-content tv-markdown';
  content.innerHTML = html;
  const btn = document.createElement('button');
  btn.className = 'tv-tts-btn';
  btn.appendChild(transcriptTts._speakerSVG());
  wrap.appendChild(content);
  wrap.appendChild(btn);
  view.appendChild(wrap);
  return { view, content, btn };
}

function selectInside(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function clearSelection() {
  window.getSelection()!.removeAllRanges();
}

const pillEl = () => document.getElementById('transcriptPlayPill') as HTMLButtonElement | null;
const tapPill = () => pillEl()!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));

beforeEach(build);

// ─── Visibility ─────────────────────────────────────────────────────────────

describe('TranscriptPlayPill visibility', () => {
  it('appears when text inside an assistant message is selected', () => {
    const { content } = setTranscript('<p>First para.</p><p>Second para.</p>');
    selectInside(content.querySelectorAll('p')[1]);
    pill.update();
    expect(pillEl()!.style.display).toBe('block');
  });

  it('hides when the selection collapses', () => {
    const { content } = setTranscript('<p>First para.</p>');
    selectInside(content.querySelector('p')!);
    pill.update();
    clearSelection();
    pill.update();
    expect(pillEl()!.style.display).toBe('none');
  });

  it('stays hidden for a selection outside the transcript', () => {
    setTranscript('<p>First para.</p>');
    const outside = document.createElement('p');
    outside.textContent = 'Somewhere else entirely.';
    document.body.appendChild(outside);
    selectInside(outside);
    pill.update();
    expect(pillEl()).toBeNull();
  });

  it('stays hidden for a whitespace-only selection', () => {
    const { content } = setTranscript('<p>   </p>');
    selectInside(content.querySelector('p')!);
    pill.update();
    expect(pillEl()?.style.display).not.toBe('block');
  });

  it('reuses one pill element across selections', () => {
    const { content } = setTranscript('<p>One.</p><p>Two.</p>');
    selectInside(content.querySelectorAll('p')[0]);
    pill.update();
    selectInside(content.querySelectorAll('p')[1]);
    pill.update();
    expect(document.querySelectorAll('#transcriptPlayPill')).toHaveLength(1);
  });

  it('hides itself when a read-aloud session ends', () => {
    const { content } = setTranscript('<p>One.</p>');
    selectInside(content.querySelector('p')!);
    pill.update();
    readAloud.start({ owner: 'transcript', root: content });
    readAloud.stop();
    expect(pillEl()!.style.display).toBe('none');
  });
});

// ─── Starting playback ──────────────────────────────────────────────────────

describe('TranscriptPlayPill playback', () => {
  it('starts at the selected block, not the top of the message', () => {
    const { content } = setTranscript('<p>One.</p><p>Two.</p><p>Three.</p>');
    selectInside(content.querySelectorAll('p')[2]);
    pill.update();
    tapPill();
    expect(spoken.map((u) => u.text)).toEqual(['Three.']);
  });

  it('syncs the icon on that message’s own play button', () => {
    const { content, btn } = setTranscript('<p>One.</p><p>Two.</p>');
    selectInside(content.querySelectorAll('p')[1]);
    pill.update();
    tapPill();
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(true);
    expect(btn.querySelector('rect')).not.toBeNull();
  });

  it('hides itself on tap', () => {
    const { content } = setTranscript('<p>One.</p>');
    selectInside(content.querySelector('p')!);
    pill.update();
    tapPill();
    expect(pillEl()!.style.display).toBe('none');
  });

  it('cancels the tap’s default so the selection is not lost first', () => {
    const { content } = setTranscript('<p>One.</p>');
    selectInside(content.querySelector('p')!);
    pill.update();
    const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
    pillEl()!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('falls back to the first block when the selection anchors on the wrapper', () => {
    const { content } = setTranscript('<p>One.</p><p>Two.</p>');
    selectInside(content);
    pill.update();
    tapPill();
    expect(spoken.map((u) => u.text)).toEqual(['One.']);
  });

  it('does nothing when there was never a selection to act on', () => {
    setTranscript('<p>One.</p>');
    clearSelection();
    pill.update();
    // No pill was ever shown, so there is nothing to tap.
    expect(pillEl()).toBeNull();
    expect(engine.isPlaying()).toBe(false);
  });
});

// ─── Live transcript re-render between showing and tapping ──────────────────

describe('TranscriptPlayPill survives a re-render', () => {
  it('still starts from the right block when SSE replaced the nodes', () => {
    const { content } = setTranscript('<p>One.</p><p>Two.</p><p>Three.</p>');
    selectInside(content.querySelectorAll('p')[2]);
    pill.update();

    // An SSE update re-renders the message, detaching the block the pill was
    // pointing at and collapsing the selection with it.
    content.innerHTML = '<p>One.</p><p>Two.</p><p>Three.</p>';
    clearSelection();

    tapPill();
    expect(spoken.map((u) => u.text)).toEqual(['Three.']);
    expect(engine.blockAt(engine.position().index).el).toBe(content.querySelectorAll('p')[2]);
  });

  it('uses the snapshot when the selection collapsed but the nodes survived', () => {
    const { content } = setTranscript('<p>One.</p><p>Two.</p>');
    selectInside(content.querySelectorAll('p')[1]);
    pill.update();
    clearSelection();
    tapPill();
    expect(spoken.map((u) => u.text)).toEqual(['Two.']);
  });

  it('gives up quietly when the block is gone from the document entirely', () => {
    const { content } = setTranscript('<p>One.</p><p>Gone soon.</p>');
    selectInside(content.querySelectorAll('p')[1]);
    pill.update();
    content.innerHTML = '<p>One.</p>';
    clearSelection();
    tapPill();
    expect(spoken).toHaveLength(0);
    expect(engine.isPlaying()).toBe(false);
  });

  it('does not reuse a stale snapshot on a later tap', () => {
    const { content } = setTranscript('<p>One.</p><p>Two.</p>');
    selectInside(content.querySelectorAll('p')[1]);
    pill.update();
    tapPill();
    readAloud.stop();
    spoken.length = 0;

    clearSelection();
    tapPill();
    expect(spoken).toHaveLength(0);
  });
});

// ─── Seek vs restart ────────────────────────────────────────────────────────

describe('TranscriptPlayPill seek-vs-start', () => {
  it('seeks instead of restarting when the block is already in the session', () => {
    const { content, btn } = setTranscript('<p>One.</p><p>Two.</p><p>Three.</p>');
    transcriptTts.speak(btn, content);
    expect(spoken.map((u) => u.text)).toEqual(['One.']);

    selectInside(content.querySelectorAll('p')[2]);
    pill.update();
    tapPill();

    expect(engine.position().index).toBe(2);
    expect(spoken.map((u) => u.text)).toEqual(['One.', 'Three.']);
    // A restart would have cancelled and rebuilt the session; the button must
    // still show it is playing.
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(true);
  });

  it('does not stop when the target message is the one already playing', () => {
    const { content, btn } = setTranscript('<p>One.</p><p>Two.</p>');
    transcriptTts.speak(btn, content);
    selectInside(content.querySelectorAll('p')[1]);
    pill.update();
    tapPill();
    // The plain toggle path would read this as a second tap and stop.
    expect(engine.isPlaying()).toBe(true);
  });

  it('starts a fresh session when the block belongs to another message', () => {
    const first = setTranscript('<p>Alpha.</p>');
    transcriptTts.speak(first.btn, first.content);

    const second = setTranscript('<p>Beta.</p><p>Gamma.</p>');
    selectInside(second.content.querySelectorAll('p')[1]);
    pill.update();
    tapPill();

    expect(spoken.map((u) => u.text)).toEqual(['Alpha.', 'Gamma.']);
    expect(first.btn.classList.contains('tv-tts-btn--speaking')).toBe(false);
    expect(second.btn.classList.contains('tv-tts-btn--speaking')).toBe(true);
  });
});

// ─── TranscriptTTS.speak with an explicit start block ───────────────────────

describe('TranscriptTTS.speak explicit start block', () => {
  it('does not toggle-stop when handed an explicit block', () => {
    const { content, btn } = setTranscript('<p>One.</p><p>Two.</p>');
    transcriptTts.speak(btn, content);
    transcriptTts.speak(btn, content, content.querySelectorAll('p')[1]);
    expect(engine.isPlaying()).toBe(true);
    expect(spoken[spoken.length - 1].text).toBe('Two.');
  });

  it('still toggles when no block is given', () => {
    const { content, btn } = setTranscript('<p>One.</p>');
    transcriptTts.speak(btn, content);
    transcriptTts.speak(btn, content);
    expect(engine.isPlaying()).toBe(false);
  });

  it('plays even when the message has no play button in the DOM', () => {
    const { content, btn } = setTranscript('<p>One.</p>');
    btn.remove();
    expect(() => transcriptTts.speak(null, content, content.querySelector('p'))).not.toThrow();
    expect(spoken.map((u) => u.text)).toEqual(['One.']);
  });
});

// ─── Engine support for the shared seek-vs-start decision ───────────────────

describe('TtsEngine.indexOfBlock', () => {
  it('finds a rendered element in the live session', () => {
    const { content } = setTranscript('<p>One.</p><p>Two.</p>');
    readAloud.start({ owner: 'transcript', root: content });
    expect(engine.indexOfBlock(content.querySelectorAll('p')[1])).toBe(1);
  });

  it('returns -1 for an element that is not part of it', () => {
    const { content } = setTranscript('<p>One.</p>');
    readAloud.start({ owner: 'transcript', root: content });
    expect(engine.indexOfBlock(document.createElement('p'))).toBe(-1);
    expect(engine.indexOfBlock(null)).toBe(-1);
  });

  it('returns -1 when nothing is playing', () => {
    const { content } = setTranscript('<p>One.</p>');
    expect(engine.indexOfBlock(content.querySelector('p'))).toBe(-1);
  });
});

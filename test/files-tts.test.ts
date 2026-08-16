// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for FilesTTS — the read-aloud engine for the files
 * sheet's markdown preview (src/web/public/app.js ~3223).
 *
 * The REAL FilesTTS object literal is extracted from the shipped app.js text
 * and evaluated against a stubbed speechSynthesis, so the chunking, own-text
 * extraction, splitting and rebinding logic under test is exactly the code that
 * ships. Actual speech output, iOS utterance truncation and Chrome's ~15s
 * auto-pause are out of scope (no engine in jsdom).
 *
 * Run: npx vitest run test/files-tts.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

// ─── Real-source extraction ─────────────────────────────────────────────────

/** Source text of the FilesTTS object literal, without the const binding. */
function filesTtsSource(): string {
  const start = APP_JS_SOURCE.indexOf('const FilesTTS = {');
  expect(start, 'FilesTTS not found in app.js').toBeGreaterThan(-1);
  const end = APP_JS_SOURCE.indexOf('\n};\n', start);
  expect(end, 'FilesTTS has no top-level close').toBeGreaterThan(start);
  return APP_JS_SOURCE.slice(start + 'const FilesTTS = '.length, end + 2);
}

interface Utter {
  text: string;
  onstart?: () => void;
  onend?: () => void;
  onerror?: () => void;
}

let spoken: Utter[];
let tts: any;

/** Installs a stub speech engine and compiles a fresh FilesTTS against it. */
function makeTts() {
  spoken = [];
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
  // FilesTTS reads `'speechSynthesis' in window` at definition time, so it must
  // be compiled AFTER the stub is installed.
  return new Function('SpeechSynthesisUtterance', `return (${filesTtsSource()});`)(
    (window as any).SpeechSynthesisUtterance
  );
}

function setPreview(html: string): HTMLElement {
  document.body.innerHTML = `<div class="files-md-preview">${html}</div>`;
  return document.querySelector('.files-md-preview') as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
  tts = makeTts();
});

// ─── collectChunks() / _ownText() ───────────────────────────────────────────

describe('FilesTTS.collectChunks()', () => {
  it('reads the rendered blocks in document order', () => {
    const preview = setPreview('<h1>Title</h1><p>First para.</p><p>Second para.</p>');
    expect(tts.collectChunks(preview, null).map((c: any) => c.text)).toEqual(['Title', 'First para.', 'Second para.']);
  });

  it('skips code blocks', () => {
    const preview = setPreview('<p>read me</p><pre><p>const x = 1;</p></pre><p>and me</p>');
    expect(tts.collectChunks(preview, null).map((c: any) => c.text)).toEqual(['read me', 'and me']);
  });

  it('reads a nested list item once, under its own <li>', () => {
    const preview = setPreview('<ul><li>outer<ul><li>inner</li></ul></li></ul>');
    const chunks = tts.collectChunks(preview, null);
    expect(chunks.map((c: any) => c.text)).toEqual(['outer', 'inner']);
    expect(chunks[1].el).toBe(preview.querySelectorAll('li')[1]);
  });

  it('reads a blockquote’s paragraph once, not twice and not never', () => {
    const preview = setPreview('<blockquote><p>quoted line</p></blockquote>');
    const chunks = tts.collectChunks(preview, null);
    expect(chunks.map((c: any) => c.text)).toEqual(['quoted line']);
    expect(chunks[0].el.tagName).toBe('P');
  });

  it('keeps inline markup in the block’s own text and normalises whitespace', () => {
    const preview = setPreview('<p>an <em>italic</em>\n   word</p>');
    expect(tts.collectChunks(preview, null).map((c: any) => c.text)).toEqual(['an italic word']);
  });

  it('drops blocks with no own text', () => {
    const preview = setPreview('<p>  </p><p>real text</p>');
    expect(tts.collectChunks(preview, null).map((c: any) => c.text)).toEqual(['real text']);
  });

  it('starts at startEl, skipping everything before it', () => {
    const preview = setPreview('<p>one</p><p>two</p><p>three</p>');
    const second = preview.querySelectorAll('p')[1];
    expect(tts.collectChunks(preview, second).map((c: any) => c.text)).toEqual(['two', 'three']);
  });

  it('starts at the block containing startEl (selection anchored on an inline node)', () => {
    const preview = setPreview('<p>one</p><p>two <em>emphasis</em></p>');
    const em = preview.querySelector('em') as HTMLElement;
    expect(tts.collectChunks(preview, em).map((c: any) => c.text)).toEqual(['two emphasis']);
  });

  it('starts at the first block contained by startEl (selection anchored on a wrapper)', () => {
    const preview = setPreview('<p>one</p><blockquote><p>two</p></blockquote>');
    const quote = preview.querySelector('blockquote') as HTMLElement;
    expect(tts.collectChunks(preview, quote).map((c: any) => c.text)).toEqual(['two']);
  });

  it('returns nothing for a missing preview', () => {
    expect(tts.collectChunks(null, null)).toEqual([]);
  });
});

// ─── _split() ───────────────────────────────────────────────────────────────

describe('FilesTTS._split()', () => {
  it('leaves a short block intact', () => {
    expect(tts._split('A short sentence. And another.')).toEqual(['A short sentence. And another.']);
  });

  it('packs whole sentences into ~300-char utterances', () => {
    const sentence = 'a'.repeat(90) + '. ';
    const parts = tts._split(sentence.repeat(6));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300);
    // Every part ends on a sentence boundary, and nothing is lost.
    for (const p of parts) expect(p.endsWith('.')).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, '')).toBe(sentence.repeat(6).replace(/\s+/g, ''));
  });

  it('splits on ellipsis, question and exclamation marks too', () => {
    const parts = tts._split(('What? '.repeat(30) + 'Wow! '.repeat(30) + 'Hmm… '.repeat(30)).trim());
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p: string) => /[?!…]$/.test(p))).toBe(true);
  });

  it('hard-slices a punctuation-free run at 400 characters', () => {
    const parts = tts._split('x'.repeat(1000));
    expect(parts.map((p: string) => p.length)).toEqual([400, 400, 200]);
    expect(parts.join('')).toBe('x'.repeat(1000));
  });

  it('is written without a regex lookbehind (older iOS Safari throws at parse time)', () => {
    expect(filesTtsSource()).not.toContain('(?<');
  });
});

// ─── start() / rebind() / generation guard ──────────────────────────────────

describe('FilesTTS playback', () => {
  it('speaks the first chunk synchronously and chains the rest via onend', () => {
    const preview = setPreview('<p>one</p><p>two</p>');
    expect(tts.start(preview, null, () => {})).toBe(true);
    expect(tts.isPlaying()).toBe(true);
    expect(spoken.map((u) => u.text)).toEqual(['one']);

    spoken[0].onend!();
    expect(spoken.map((u) => u.text)).toEqual(['one', 'two']);

    spoken[1].onend!();
    expect(tts.isPlaying()).toBe(false);
  });

  it('skips a failed utterance instead of stranding the document', () => {
    const preview = setPreview('<p>one</p><p>two</p>');
    tts.start(preview, null, () => {});
    spoken[0].onerror!();
    expect(spoken.map((u) => u.text)).toEqual(['one', 'two']);
  });

  it('refuses to start on a document with nothing readable', () => {
    const preview = setPreview('<pre><p>code only</p></pre>');
    expect(tts.start(preview, null, () => {})).toBe(false);
    expect(spoken).toHaveLength(0);
  });

  it('ignores an onend callback from a superseded playback generation', () => {
    const preview = setPreview('<p>one</p><p>two</p>');
    tts.start(preview, null, () => {});
    const stale = spoken[0];

    tts.stop();
    tts.start(preview, null, () => {});
    expect(spoken.map((u) => u.text)).toEqual(['one', 'one']);

    stale.onend!();
    expect(spoken.map((u) => u.text)).toEqual(['one', 'one']);
    expect(tts.isPlaying()).toBe(true);
  });

  it('marks the speaking block and clears it on stop', () => {
    const preview = setPreview('<p>one</p><p>two</p>');
    tts.start(preview, null, () => {});
    spoken[0].onstart!();
    expect(preview.querySelector('p')!.classList.contains('files-md-speaking')).toBe(true);

    tts.stop();
    expect(document.querySelectorAll('.files-md-speaking')).toHaveLength(0);
  });

  it('notifies the state-change callback exactly once when stopping', () => {
    const preview = setPreview('<p>one</p>');
    const onChange = vi.fn();
    tts.start(preview, null, onChange);
    tts.stop();
    tts.stop();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('FilesTTS.rebind()', () => {
  it('re-anchors the current chunk onto the rebuilt preview nodes', () => {
    const preview = setPreview('<p>one</p><p>two</p><p>three</p>');
    tts.start(preview, null, () => {});
    spoken[0].onend!(); // now on "two"

    const rebuilt = setPreview('<p>one</p><p>two</p><p>three</p>');
    tts.rebind(rebuilt);

    expect(tts._index).toBe(1);
    expect(tts._chunks[1].el).toBe(rebuilt.querySelectorAll('p')[1]);
    expect(tts._chunks[1].el.classList.contains('files-md-speaking')).toBe(true);
  });

  it('keeps the old refs when the current text is gone from the new document', () => {
    const preview = setPreview('<p>one</p><p>two</p>');
    tts.start(preview, null, () => {});
    spoken[0].onend!();
    const before = tts._chunks;

    tts.rebind(setPreview('<p>completely different</p>'));

    expect(tts._chunks).toBe(before);
    expect(tts._index).toBe(1);
  });

  it('does nothing when nothing is playing', () => {
    const preview = setPreview('<p>one</p>');
    tts.rebind(preview);
    expect(tts._chunks).toEqual([]);
  });
});

/**
 * @fileoverview Tests for TranscriptTTS._stripMarkdown pure function
 *
 * Covers the ten distinct regex branches in _stripMarkdown(), defined in
 * src/web/public/app.js as a method on the TranscriptTTS object literal
 * (~line 1890).
 *
 * Because app.js is a browser bundle (no exports), the function logic is
 * replicated here as a standalone pure function matching the exact
 * expressions in the source.  This mirrors the approach used in
 * non-image-file-upload.test.ts and paste-newline-routing.test.ts.
 */

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Pure function replicated from TranscriptTTS._stripMarkdown in app.js
// ---------------------------------------------------------------------------

/**
 * Strips Markdown syntax from text so it can be read aloud naturally.
 * Matches the exact regex sequence in TranscriptTTS._stripMarkdown (~line 1890).
 */
function stripMarkdown(text: string): string {
  let s = text;
  // Remove fenced code blocks (don't read raw code aloud)
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // Remove inline code
  s = s.replace(/`[^`]*`/g, '');
  // Bold and italic — keep inner text
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/_([^_]+)_/g, '$1');
  // Heading markers
  s = s.replace(/^#{1,6}\s+/gm, '');
  // Horizontal rules
  s = s.replace(/^[-*_]{3,}\s*$/gm, '');
  // List markers
  s = s.replace(/^[-*+]\s+/gm, '');
  s = s.replace(/^\d+\.\s+/gm, '');
  // Markdown links — keep label only
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Collapse excess whitespace
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TranscriptTTS._stripMarkdown', () => {
  describe('fenced code blocks — removed entirely', () => {
    it('removes a fenced code block and replaces it with a space', () => {
      expect(stripMarkdown('Here:\n```\nconst x = 1;\n```\nDone.')).toBe('Here: Done.');
    });

    it('removes a fenced code block with a language tag', () => {
      expect(stripMarkdown('```typescript\nconst x = 1;\n```')).toBe('');
    });

    it('removes multiple fenced code blocks', () => {
      expect(stripMarkdown('A ```x``` B ```y``` C')).toBe('A B C');
    });
  });

  describe('inline code — removed entirely', () => {
    it('removes an inline code span (whitespace-collapsing closes the gap)', () => {
      // The backtick span is replaced with nothing, leaving two adjacent spaces
      // which the trailing whitespace-collapse step reduces to one.
      expect(stripMarkdown('Run `npm install` first.')).toBe('Run first.');
    });

    it('removes multiple inline code spans', () => {
      expect(stripMarkdown('Use `foo` or `bar`.')).toBe('Use or .');
    });
  });

  describe('bold (**text** and __text__) — marker removed, text kept', () => {
    it('strips ** bold markers', () => {
      expect(stripMarkdown('This is **important**.')).toBe('This is important.');
    });

    it('strips __ bold markers', () => {
      expect(stripMarkdown('This is __important__.')).toBe('This is important.');
    });
  });

  describe('italic (*text* and _text_) — marker removed, text kept', () => {
    it('strips * italic markers', () => {
      expect(stripMarkdown('This is *emphasized*.')).toBe('This is emphasized.');
    });

    it('strips _ italic markers', () => {
      expect(stripMarkdown('This is _emphasized_.')).toBe('This is emphasized.');
    });
  });

  describe('headings — # markers removed, text kept', () => {
    it('strips a level-1 heading marker', () => {
      expect(stripMarkdown('# Introduction')).toBe('Introduction');
    });

    it('strips a level-3 heading marker', () => {
      expect(stripMarkdown('### Section Title')).toBe('Section Title');
    });

    it('strips a level-6 heading marker', () => {
      expect(stripMarkdown('###### Deep')).toBe('Deep');
    });

    it('does not strip # that is not at the start of a line', () => {
      // Mid-line hash is not a heading — left untouched
      expect(stripMarkdown('color: #ff0000')).toBe('color: #ff0000');
    });
  });

  describe('horizontal rules — removed entirely', () => {
    it('removes a --- horizontal rule', () => {
      expect(stripMarkdown('---')).toBe('');
    });

    it('removes a *** horizontal rule', () => {
      expect(stripMarkdown('***')).toBe('');
    });

    it('removes a ___ horizontal rule', () => {
      expect(stripMarkdown('___')).toBe('');
    });

    it('removes a longer --- rule', () => {
      expect(stripMarkdown('------')).toBe('');
    });
  });

  describe('unordered list markers — removed, text kept', () => {
    it('strips a - list marker', () => {
      expect(stripMarkdown('- item one')).toBe('item one');
    });

    it('strips a * list marker', () => {
      expect(stripMarkdown('* item one')).toBe('item one');
    });

    it('strips a + list marker', () => {
      expect(stripMarkdown('+ item one')).toBe('item one');
    });

    it('strips list markers from all lines in a list', () => {
      const input = '- alpha\n- beta\n- gamma';
      expect(stripMarkdown(input)).toBe('alpha\nbeta\ngamma');
    });
  });

  describe('ordered list markers — removed, text kept', () => {
    it('strips a numbered list marker', () => {
      expect(stripMarkdown('1. First step')).toBe('First step');
    });

    it('strips numbered list markers from multiple lines', () => {
      const input = '1. One\n2. Two\n3. Three';
      expect(stripMarkdown(input)).toBe('One\nTwo\nThree');
    });
  });

  describe('Markdown links — URL removed, label kept', () => {
    it('keeps the link label and removes the URL', () => {
      expect(stripMarkdown('See [the docs](https://example.com) for details.')).toBe('See the docs for details.');
    });

    it('handles multiple links in one string', () => {
      expect(stripMarkdown('[foo](http://a.com) and [bar](http://b.com)')).toBe('foo and bar');
    });
  });

  describe('whitespace collapsing — excess spaces trimmed', () => {
    it('collapses multiple spaces to one', () => {
      expect(stripMarkdown('hello   world')).toBe('hello world');
    });

    it('trims leading and trailing whitespace', () => {
      expect(stripMarkdown('  hello world  ')).toBe('hello world');
    });
  });

  describe('plain text — passed through unchanged', () => {
    it('returns plain prose unchanged', () => {
      expect(stripMarkdown('Hello, world.')).toBe('Hello, world.');
    });

    it('returns an empty string for empty input', () => {
      expect(stripMarkdown('')).toBe('');
    });
  });

  describe('combined input — realistic assistant message', () => {
    it('strips mixed markdown from a typical assistant response', () => {
      // Note: inline code is stripped BEFORE bold, so **`code`** leaves ****
      // (the bold regex requires non-empty inner text and won't match ****).
      // The combined test avoids nested bold+code to keep the assertion clear.
      const input = [
        '## Summary',
        '',
        'Run the install command to set up dependencies.',
        '',
        '```bash',
        'npm install',
        '```',
        '',
        '- Step one',
        '- Step two',
        '',
        'See [the README](https://example.com/readme) for more.',
      ].join('\n');

      const result = stripMarkdown(input);
      // Heading marker removed, fenced block replaced by space,
      // list markers removed, link URL removed.
      expect(result).toContain('Summary');
      expect(result).toContain('Run the install command');
      expect(result).toContain('Step one');
      expect(result).toContain('Step two');
      expect(result).toContain('the README');
      expect(result).not.toContain('##');
      expect(result).not.toContain('```');
      expect(result).not.toContain('https://example.com/readme');
      expect(result).not.toMatch(/^-\s/m);
    });
  });
});

// ---------------------------------------------------------------------------
// DOM-based helpers replicated from TranscriptTTS in app.js
// ---------------------------------------------------------------------------

const svgNS = 'http://www.w3.org/2000/svg';

function speakerSVG(): SVGSVGElement {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const poly = document.createElementNS(svgNS, 'polygon');
  poly.setAttribute('points', '11 5 6 9 2 9 2 15 6 15 11 19 11 5');
  const path1 = document.createElementNS(svgNS, 'path');
  path1.setAttribute('d', 'M19.07 4.93a10 10 0 0 1 0 14.14');
  const path2 = document.createElementNS(svgNS, 'path');
  path2.setAttribute('d', 'M15.54 8.46a5 5 0 0 1 0 7.07');
  svg.appendChild(poly);
  svg.appendChild(path1);
  svg.appendChild(path2);
  return svg;
}

function stopSVG(): SVGSVGElement {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const rect = document.createElementNS(svgNS, 'rect');
  rect.setAttribute('x', '3');
  rect.setAttribute('y', '3');
  rect.setAttribute('width', '18');
  rect.setAttribute('height', '18');
  rect.setAttribute('rx', '2');
  rect.setAttribute('ry', '2');
  svg.appendChild(rect);
  return svg;
}

// Minimal TranscriptTTS replica with the icon-swap and toggle behavior
function createTranscriptTTS() {
  return {
    _currentBtn: null as HTMLElement | null,
    _utterance: null as SpeechSynthesisUtterance | null,

    _speakerSVG: speakerSVG,
    _stopSVG: stopSVG,
    _stripMarkdown: stripMarkdown,

    speak(btn: HTMLElement, rawText: string) {
      if (this._currentBtn === btn) {
        this._stop();
        return;
      }
      this._stop();
      const strippedText = this._stripMarkdown(rawText);
      const utterance = new SpeechSynthesisUtterance(strippedText);
      utterance.onend = () => this._reset(btn);
      utterance.onerror = () => this._reset(btn);
      this._utterance = utterance;
      this._currentBtn = btn;
      btn.classList.add('tv-tts-btn--speaking');
      btn.setAttribute('aria-label', 'Stop reading aloud');
      btn.setAttribute('title', 'Stop reading aloud');
      while (btn.firstChild) btn.removeChild(btn.firstChild);
      btn.appendChild(this._stopSVG());
      window.speechSynthesis.speak(utterance);
    },

    _stop() {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      }
      if (this._currentBtn) {
        this._reset(this._currentBtn);
      }
    },

    _reset(btn: HTMLElement) {
      btn.classList.remove('tv-tts-btn--speaking');
      btn.setAttribute('aria-label', 'Read aloud');
      btn.setAttribute('title', 'Read aloud');
      while (btn.firstChild) btn.removeChild(btn.firstChild);
      btn.appendChild(this._speakerSVG());
      this._currentBtn = null;
      this._utterance = null;
    },
  };
}

/** Create a button element pre-populated with speaker icon (initial state) */
function createTTSButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Read aloud');
  btn.setAttribute('title', 'Read aloud');
  btn.appendChild(speakerSVG());
  return btn;
}

// ---------------------------------------------------------------------------
// Mock speechSynthesis
// ---------------------------------------------------------------------------

function mockSpeechSynthesis() {
  // Polyfill SpeechSynthesisUtterance (not available in jsdom)
  if (typeof globalThis.SpeechSynthesisUtterance === 'undefined') {
    (globalThis as any).SpeechSynthesisUtterance = class SpeechSynthesisUtterance {
      text: string;
      onend: ((ev: any) => void) | null = null;
      onerror: ((ev: any) => void) | null = null;
      constructor(text?: string) {
        this.text = text ?? '';
      }
    };
  }

  const mock = {
    speak: vi.fn(),
    cancel: vi.fn(),
    speaking: false,
  };
  Object.defineProperty(window, 'speechSynthesis', {
    value: mock,
    writable: true,
    configurable: true,
  });
  return mock;
}

// ---------------------------------------------------------------------------
// Tests — SVG factory methods
// ---------------------------------------------------------------------------

describe('TranscriptTTS._speakerSVG', () => {
  it('returns an SVG element', () => {
    const svg = speakerSVG();
    expect(svg.tagName).toBe('svg');
    expect(svg.namespaceURI).toBe(svgNS);
  });

  it('has width=14, height=14, viewBox="0 0 24 24"', () => {
    const svg = speakerSVG();
    expect(svg.getAttribute('width')).toBe('14');
    expect(svg.getAttribute('height')).toBe('14');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('has stroke attributes set correctly', () => {
    const svg = speakerSVG();
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('2');
    expect(svg.getAttribute('stroke-linecap')).toBe('round');
    expect(svg.getAttribute('stroke-linejoin')).toBe('round');
  });

  it('contains a polygon and two path children', () => {
    const svg = speakerSVG();
    const children = Array.from(svg.children);
    expect(children).toHaveLength(3);
    expect(children[0].tagName).toBe('polygon');
    expect(children[0].getAttribute('points')).toBe('11 5 6 9 2 9 2 15 6 15 11 19 11 5');
    expect(children[1].tagName).toBe('path');
    expect(children[1].getAttribute('d')).toBe('M19.07 4.93a10 10 0 0 1 0 14.14');
    expect(children[2].tagName).toBe('path');
    expect(children[2].getAttribute('d')).toBe('M15.54 8.46a5 5 0 0 1 0 7.07');
  });
});

describe('TranscriptTTS._stopSVG', () => {
  it('returns an SVG element', () => {
    const svg = stopSVG();
    expect(svg.tagName).toBe('svg');
    expect(svg.namespaceURI).toBe(svgNS);
  });

  it('has width=14, height=14, viewBox="0 0 24 24"', () => {
    const svg = stopSVG();
    expect(svg.getAttribute('width')).toBe('14');
    expect(svg.getAttribute('height')).toBe('14');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('has stroke attributes set correctly', () => {
    const svg = stopSVG();
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('2');
  });

  it('contains a single rect child with correct attributes', () => {
    const svg = stopSVG();
    const children = Array.from(svg.children);
    expect(children).toHaveLength(1);
    expect(children[0].tagName).toBe('rect');
    expect(children[0].getAttribute('x')).toBe('3');
    expect(children[0].getAttribute('y')).toBe('3');
    expect(children[0].getAttribute('width')).toBe('18');
    expect(children[0].getAttribute('height')).toBe('18');
    expect(children[0].getAttribute('rx')).toBe('2');
    expect(children[0].getAttribute('ry')).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// Tests — speak() icon swap
// ---------------------------------------------------------------------------

describe('TranscriptTTS.speak — icon swap', () => {
  it('replaces button children with stop SVG', () => {
    const synth = mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    // Before speak: button has speaker SVG (polygon child)
    expect(btn.querySelector('polygon')).not.toBeNull();
    expect(btn.querySelector('rect')).toBeNull();

    tts.speak(btn, 'Hello world');

    // After speak: button has stop SVG (rect child, no polygon)
    expect(btn.querySelector('rect')).not.toBeNull();
    expect(btn.querySelector('polygon')).toBeNull();
    // Only one SVG child
    expect(btn.children).toHaveLength(1);
    expect(btn.children[0].tagName).toBe('svg');
  });

  it('sets title to "Stop reading aloud"', () => {
    mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    tts.speak(btn, 'Hello world');

    expect(btn.getAttribute('title')).toBe('Stop reading aloud');
    expect(btn.getAttribute('aria-label')).toBe('Stop reading aloud');
  });

  it('adds the tv-tts-btn--speaking class', () => {
    mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    tts.speak(btn, 'Hello world');

    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(true);
  });

  it('calls speechSynthesis.speak', () => {
    const synth = mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    tts.speak(btn, 'Hello world');

    expect(synth.speak).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Tests — _reset() icon restore
// ---------------------------------------------------------------------------

describe('TranscriptTTS._reset — icon restore', () => {
  it('replaces button children with speaker SVG', () => {
    mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    // Put button into speaking state
    tts.speak(btn, 'Hello');
    expect(btn.querySelector('rect')).not.toBeNull();

    // Reset
    tts._reset(btn);

    expect(btn.querySelector('polygon')).not.toBeNull();
    expect(btn.querySelector('rect')).toBeNull();
    expect(btn.children).toHaveLength(1);
    expect(btn.children[0].tagName).toBe('svg');
  });

  it('sets title to "Read aloud"', () => {
    mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    tts.speak(btn, 'Hello');
    tts._reset(btn);

    expect(btn.getAttribute('title')).toBe('Read aloud');
    expect(btn.getAttribute('aria-label')).toBe('Read aloud');
  });

  it('removes the tv-tts-btn--speaking class', () => {
    mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    tts.speak(btn, 'Hello');
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(true);

    tts._reset(btn);
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(false);
  });

  it('clears _currentBtn and _utterance', () => {
    mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    tts.speak(btn, 'Hello');
    expect(tts._currentBtn).toBe(btn);
    expect(tts._utterance).not.toBeNull();

    tts._reset(btn);
    expect(tts._currentBtn).toBeNull();
    expect(tts._utterance).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — toggle round-trip
// ---------------------------------------------------------------------------

describe('TranscriptTTS — toggle round-trip', () => {
  it('speak then tap same button stops and restores speaker icon', () => {
    const synth = mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    // First tap: starts speaking
    tts.speak(btn, 'Hello world');
    expect(btn.querySelector('rect')).not.toBeNull();
    expect(btn.getAttribute('title')).toBe('Stop reading aloud');
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(true);

    // Simulate that speech is active
    synth.speaking = true;

    // Second tap on same button: stops and resets
    tts.speak(btn, 'Hello world');
    expect(synth.cancel).toHaveBeenCalled();
    expect(btn.querySelector('polygon')).not.toBeNull();
    expect(btn.querySelector('rect')).toBeNull();
    expect(btn.getAttribute('title')).toBe('Read aloud');
    expect(btn.classList.contains('tv-tts-btn--speaking')).toBe(false);
  });

  it('switching to a different button resets the previous one', () => {
    const synth = mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn1 = createTTSButton();
    const btn2 = createTTSButton();

    // Speak on btn1
    tts.speak(btn1, 'First');
    expect(btn1.querySelector('rect')).not.toBeNull();

    // Speak on btn2 — btn1 should be reset
    tts.speak(btn2, 'Second');
    expect(btn1.querySelector('polygon')).not.toBeNull();
    expect(btn1.querySelector('rect')).toBeNull();
    expect(btn1.getAttribute('title')).toBe('Read aloud');
    expect(btn1.classList.contains('tv-tts-btn--speaking')).toBe(false);

    // btn2 should now be in speaking state
    expect(btn2.querySelector('rect')).not.toBeNull();
    expect(btn2.getAttribute('title')).toBe('Stop reading aloud');
    expect(btn2.classList.contains('tv-tts-btn--speaking')).toBe(true);
  });

  it('utterance onend callback restores speaker icon', () => {
    const synth = mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    tts.speak(btn, 'Hello');
    expect(btn.querySelector('rect')).not.toBeNull();

    // Grab the utterance that was passed to speechSynthesis.speak
    const utterance = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;

    // Simulate speech ending
    utterance.onend!(new Event('end') as SpeechSynthesisEvent);

    expect(btn.querySelector('polygon')).not.toBeNull();
    expect(btn.querySelector('rect')).toBeNull();
    expect(btn.getAttribute('title')).toBe('Read aloud');
    expect(tts._currentBtn).toBeNull();
  });

  it('utterance onerror callback restores speaker icon', () => {
    const synth = mockSpeechSynthesis();
    const tts = createTranscriptTTS();
    const btn = createTTSButton();

    tts.speak(btn, 'Hello');
    const utterance = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;

    // Simulate speech error
    utterance.onerror!(new Event('error') as SpeechSynthesisErrorEvent);

    expect(btn.querySelector('polygon')).not.toBeNull();
    expect(btn.getAttribute('title')).toBe('Read aloud');
    expect(tts._currentBtn).toBeNull();
  });
});

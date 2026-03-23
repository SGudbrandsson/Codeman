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

import { describe, it, expect } from 'vitest';

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

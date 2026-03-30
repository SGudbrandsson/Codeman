/**
 * @fileoverview Tests for elicitation option parsing
 *
 * Tests the _parseElicitationOptionsFromText logic which parses
 * multi-select and single-select option formats from elicitation prompts.
 */

import { describe, it, expect } from 'vitest';

/**
 * Standalone extraction of _parseElicitationOptionsFromText from app.js.
 * Supports two formats:
 *   1. Multi-select: "N. [ ] Label" or "N. [x] Label"
 *   2. Single-select: "N: Label"
 */
function parseElicitationOptionsFromText(text: string): {
  question: string;
  options: Array<{ val: string; label: string; checked?: boolean }>;
  multiSelect: boolean;
  hasTypeOption?: boolean;
} | null {
  // Try multi-select format first: "N. [ ] Label" or "N. [x] Label"
  const multiRe = /^\s*(\d+)\.\s*\[([x ])\]\s*(.+)/gim;
  const multiOptions: Array<{ val: string; label: string; checked: boolean }> = [];
  let hasTypeOption = false;
  let mm;
  while ((mm = multiRe.exec(text)) !== null) {
    const label = mm[3].trim();
    // Track "Type something" but don't include it as a selectable option
    if (/^type something$/i.test(label)) {
      hasTypeOption = true;
      continue;
    }
    multiOptions.push({ val: mm[1], label, checked: mm[2].toLowerCase() === 'x' });
  }
  if (multiOptions.length > 0) {
    const firstIdx = text.search(/^\s*\d+\.\s*\[/m);
    const before = firstIdx > 0 ? text.slice(0, firstIdx) : '';
    const question =
      before
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() || '';
    return { question, options: multiOptions, multiSelect: true, hasTypeOption };
  }
  // Single-select format: "N: Label"
  const optionRe = /\b(\d):\s*([A-Za-z][A-Za-z /\-]{0,40}?)(?=\s{2,}|\s*\d:|$|\n)/g;
  const options: Array<{ val: string; label: string }> = [];
  let m;
  while ((m = optionRe.exec(text)) !== null) {
    options.push({ val: m[1], label: m[2].trim() });
  }
  if (options.length === 0) return null;
  const firstOptionIdx = text.indexOf(options[0].val + ':');
  const question =
    text
      .slice(0, firstOptionIdx)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() || '';
  return { question, options, multiSelect: false };
}

describe('Elicitation Option Parsing', () => {
  describe('Multi-select format (N. [ ] Label)', () => {
    it('should parse basic multi-select with unchecked items', () => {
      const text = ['Pick your tools:', '1. [ ] Read', '2. [ ] Write', '3. [ ] Bash'].join('\n');

      const result = parseElicitationOptionsFromText(text);
      expect(result).not.toBeNull();
      expect(result!.multiSelect).toBe(true);
      expect(result!.options).toHaveLength(3);
      expect(result!.options[0]).toEqual({ val: '1', label: 'Read', checked: false });
      expect(result!.options[1]).toEqual({ val: '2', label: 'Write', checked: false });
      expect(result!.options[2]).toEqual({ val: '3', label: 'Bash', checked: false });
    });

    it('should parse multi-select with some items pre-checked', () => {
      const text = ['Select features:', '1. [x] Dark mode', '2. [ ] Light mode', '3. [x] Auto theme'].join('\n');

      const result = parseElicitationOptionsFromText(text);
      expect(result).not.toBeNull();
      expect(result!.multiSelect).toBe(true);
      expect(result!.options[0]).toEqual({ val: '1', label: 'Dark mode', checked: true });
      expect(result!.options[1]).toEqual({ val: '2', label: 'Light mode', checked: false });
      expect(result!.options[2]).toEqual({ val: '3', label: 'Auto theme', checked: true });
    });

    it('should exclude "Type something" and set hasTypeOption', () => {
      const text = ['Choose an action:', '1. [ ] Run tests', '2. [ ] Deploy', '3. [ ] Type something'].join('\n');

      const result = parseElicitationOptionsFromText(text);
      expect(result).not.toBeNull();
      expect(result!.multiSelect).toBe(true);
      expect(result!.hasTypeOption).toBe(true);
      expect(result!.options).toHaveLength(2);
      expect(result!.options.find((o) => o.label === 'Type something')).toBeUndefined();
    });

    it('should include "Chat about this" as a regular option', () => {
      const text = ['What next?', '1. [ ] Chat about this', '2. [ ] Run tests'].join('\n');

      const result = parseElicitationOptionsFromText(text);
      expect(result).not.toBeNull();
      expect(result!.options).toHaveLength(2);
      expect(result!.options[0]).toEqual({ val: '1', label: 'Chat about this', checked: false });
    });

    it('should extract question text before options', () => {
      const text = [
        'Some preamble text',
        'Which files should I modify?',
        '1. [ ] src/index.ts',
        '2. [ ] src/app.ts',
      ].join('\n');

      const result = parseElicitationOptionsFromText(text);
      expect(result).not.toBeNull();
      expect(result!.question).toBe('Which files should I modify?');
    });

    it('should return empty question when no text before options', () => {
      const text = ['1. [ ] Option A', '2. [ ] Option B'].join('\n');

      const result = parseElicitationOptionsFromText(text);
      expect(result).not.toBeNull();
      expect(result!.question).toBe('');
    });

    it('should detect uppercase [X] as checked', () => {
      const text = ['Pick:', '1. [X] Already selected', '2. [ ] Not selected'].join('\n');

      const result = parseElicitationOptionsFromText(text);
      expect(result).not.toBeNull();
      expect(result!.options[0].checked).toBe(true);
      expect(result!.options[1].checked).toBe(false);
    });
  });

  describe('Single-select format (N: Label)', () => {
    it('should parse basic single-select options', () => {
      const text = 'Choose one:  1: Yes  2: No  3: Maybe';

      const result = parseElicitationOptionsFromText(text);
      expect(result).not.toBeNull();
      expect(result!.multiSelect).toBe(false);
      expect(result!.options.length).toBeGreaterThanOrEqual(3);
      expect(result!.options[0]).toEqual({ val: '1', label: 'Yes' });
      expect(result!.options[1]).toEqual({ val: '2', label: 'No' });
      expect(result!.options[2]).toEqual({ val: '3', label: 'Maybe' });
    });

    it('should extract question for single-select', () => {
      const text = 'Do you want to continue?\n1: Yes  2: No';

      const result = parseElicitationOptionsFromText(text);
      expect(result).not.toBeNull();
      expect(result!.question).toBe('Do you want to continue?');
      expect(result!.multiSelect).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('should return null for empty string', () => {
      expect(parseElicitationOptionsFromText('')).toBeNull();
    });

    it('should return null for text with no options', () => {
      expect(parseElicitationOptionsFromText('Just some regular text without any options.')).toBeNull();
    });

    it('should handle "type something" case-insensitively', () => {
      const text = ['Pick:', '1. [ ] Option A', '2. [ ] TYPE SOMETHING'].join('\n');

      const result = parseElicitationOptionsFromText(text);
      expect(result).not.toBeNull();
      expect(result!.hasTypeOption).toBe(true);
      expect(result!.options).toHaveLength(1);
      expect(result!.options[0].label).toBe('Option A');
    });
  });
});

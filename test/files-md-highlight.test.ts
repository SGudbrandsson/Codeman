// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for the markdown review-mode highlight engine and
 * the selection capture helpers in src/web/public/app.js.
 *
 * Unlike test/files-html-preview.test.ts (which replicates the render methods),
 * these tests run the REAL method bodies: app.js is pulled in as text and the
 * relevant class methods are extracted and re-compiled into a plain object, so
 * the assertions can never drift from the shipped code.
 *
 * Covers _filesTextProjection() / _filesHighlightExcerpt() /
 * _filesUnwrapHighlights() (app.js ~20711) and _filesSelectionText() /
 * _filesSelectionOccurrence() (app.js ~20470).
 *
 * Run: npx vitest run test/files-md-highlight.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

// ─── Real-source extraction ─────────────────────────────────────────────────

/** Source text of a class method in app.js, including its signature line. */
function methodSource(name: string): string {
  let start = APP_JS_SOURCE.indexOf(`\n  ${name}(`);
  if (start === -1) start = APP_JS_SOURCE.indexOf(`\n  async ${name}(`);
  expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
  const lines = APP_JS_SOURCE.slice(start + 1).split('\n');
  // One-liner methods close on their own signature line.
  if (lines[0].trimEnd().endsWith('}')) return lines[0];
  const end = lines.findIndex((l, i) => i > 0 && l === '  }');
  expect(end, `${name}() has no 2-space closing brace`).toBeGreaterThan(0);
  return lines.slice(0, end + 1).join('\n');
}

/** Compiles the named app.js methods into a fresh object per test. */
function buildApp(names: string[], stubs: Record<string, unknown> = {}) {
  const body = names.map(methodSource).join(',\n');
  const factory = new Function(`return ({\n${body}\n});`);
  return Object.assign(factory(), stubs) as any;
}

const HIGHLIGHT_METHODS = [
  '_filesTextProjection',
  '_filesHighlightExcerpt',
  '_filesUnwrapHighlights',
  '_filesPreviewEl',
  '_filesSelectionText',
  '_filesSelectionOccurrence',
];

function makeApp() {
  return buildApp(HIGHLIGHT_METHODS, {
    $: (id: string) => document.getElementById(id),
  });
}

function setPreview(html: string) {
  document.body.innerHTML = `<div id="filesSheetViewContent"><div class="files-md-preview">${html}</div></div>`;
  return document.querySelector('.files-md-preview') as HTMLElement;
}

function marks(): HTMLElement[] {
  return Array.from(document.querySelectorAll('mark.files-md-note'));
}

let app: any;

beforeEach(() => {
  app = makeApp();
  document.body.innerHTML = '';
});

// ─── _filesTextProjection() ─────────────────────────────────────────────────

describe('_filesTextProjection()', () => {
  it('collapses the source line breaks inside a hard-wrapped paragraph', () => {
    const preview = setPreview('<p>the quick\n  brown\tfox</p>');
    const { text, map } = app._filesTextProjection(preview);
    expect(text).toBe('the quick brown fox');
    expect(map).toHaveLength(text.length);
  });

  it('treats a block boundary as whitespace even when the DOM has none', () => {
    const preview = setPreview('<p>alpha</p><p>beta</p>');
    expect(app._filesTextProjection(preview).text).toBe('alpha beta');
  });

  it('does not emit a leading space for whitespace before the first character', () => {
    const preview = setPreview('<p>\n  alpha</p>');
    expect(app._filesTextProjection(preview).text).toBe('alpha');
  });

  it('skips text that is already inside a note highlight', () => {
    const preview = setPreview('<p>keep <mark class="files-md-note" data-note-id="n1">hidden</mark> rest</p>');
    expect(app._filesTextProjection(preview).text).toBe('keep rest');
  });

  it('maps every projected character back to its source node and offset', () => {
    const preview = setPreview('<p>ab <em>cd</em></p>');
    const { text, map } = app._filesTextProjection(preview);
    expect(text).toBe('ab cd');
    // 'c' comes from the <em> text node at offset 0.
    expect(map[3].node.parentElement.tagName).toBe('EM');
    expect(map[3].offset).toBe(0);
  });
});

// ─── _filesHighlightExcerpt() ───────────────────────────────────────────────

describe('_filesHighlightExcerpt()', () => {
  it('highlights an excerpt that was captured across a hard line break', () => {
    const preview = setPreview('<p>the quick\nbrown fox jumps</p>');
    app._filesHighlightExcerpt(preview, { id: 'n1', excerpt: 'quick brown fox' });
    expect(marks()).toHaveLength(1);
    expect(marks()[0].textContent).toBe('quick\nbrown fox');
  });

  it('emits one mark per text node when the excerpt spans an <em>', () => {
    const preview = setPreview('<p>hello <em>brave</em> world</p>');
    app._filesHighlightExcerpt(preview, { id: 'n1', excerpt: 'hello brave world' });
    const found = marks();
    expect(found.length).toBeGreaterThan(1);
    expect(found.every((m) => m.dataset.noteId === 'n1')).toBe(true);
    // The inter-word spaces are projection artefacts (they belong to no marked
    // offset), so the marks cover the words only and the text is unchanged.
    expect(found.map((m) => m.textContent)).toEqual(['hello', 'brave', 'world']);
    expect(preview.textContent).toBe('hello brave world');
  });

  it('highlights an excerpt spanning two paragraphs, sharing one note id', () => {
    const preview = setPreview('<p>alpha beta</p><p>gamma delta</p>');
    app._filesHighlightExcerpt(preview, { id: 'n2', excerpt: 'beta gamma' });
    const found = marks();
    expect(found).toHaveLength(2);
    expect(found.map((m) => m.textContent)).toEqual(['beta', 'gamma']);
    expect(new Set(found.map((m) => m.dataset.noteId))).toEqual(new Set(['n2']));
    expect(found[0].closest('p')).not.toBe(found[1].closest('p'));
  });

  it('selects the Nth match for a note captured on occurrence N', () => {
    const preview = setPreview('<p>tap here. tap here. tap here.</p>');
    app._filesHighlightExcerpt(preview, { id: 'n3', excerpt: 'tap here', occurrence: 1 });
    expect(marks()).toHaveLength(1);
    const p = preview.querySelector('p')!;
    // The highlight is the second of the three occurrences.
    expect(p.textContent!.indexOf(marks()[0].textContent!)).toBe(0); // sanity: same text
    expect(p.childNodes[0].textContent).toBe('tap here. ');
  });

  it('falls back to the first match when the captured occurrence no longer exists', () => {
    const preview = setPreview('<p>only once here</p>');
    app._filesHighlightExcerpt(preview, { id: 'n4', excerpt: 'only once', occurrence: 4 });
    expect(marks()).toHaveLength(1);
    expect(marks()[0].textContent).toBe('only once');
  });

  it('is a silent no-op when the excerpt is not in the document', () => {
    const preview = setPreview('<p>alpha beta</p>');
    expect(() => app._filesHighlightExcerpt(preview, { id: 'n5', excerpt: 'nowhere' })).not.toThrow();
    expect(marks()).toHaveLength(0);
    expect(preview.textContent).toBe('alpha beta');
  });

  it('ignores an empty or whitespace-only excerpt', () => {
    const preview = setPreview('<p>alpha beta</p>');
    app._filesHighlightExcerpt(preview, { id: 'n6', excerpt: '   ' });
    expect(marks()).toHaveLength(0);
  });

  it('leaves the visible text unchanged after highlighting', () => {
    const preview = setPreview('<p>alpha beta</p><p>gamma delta</p>');
    app._filesHighlightExcerpt(preview, { id: 'n7', excerpt: 'beta gamma' });
    expect(preview.textContent).toBe('alpha betagamma delta');
  });

  it('applies later fragments first so earlier offsets stay valid', () => {
    // Two notes in the same text node: the second must land on its own words,
    // which only holds if each highlight is applied back-to-front.
    const preview = setPreview('<p>one two three four</p>');
    app._filesHighlightExcerpt(preview, { id: 'a', excerpt: 'three four' });
    app._filesHighlightExcerpt(preview, { id: 'b', excerpt: 'one two' });
    expect(marks().map((m) => `${m.dataset.noteId}:${m.textContent}`)).toEqual(['b:one two', 'a:three four']);
  });

  it('documents the known occurrence drift when an earlier occurrence is already marked', () => {
    // The projection skips text inside an existing <mark>, so occurrence
    // indexes shift once a note is applied. Annotating occurrence 0 and then
    // occurrence 2 of a thrice-repeated phrase highlights the SECOND
    // occurrence, not the third. Pinned as current behaviour, not as desired.
    const preview = setPreview('<p>ping. ping. ping.</p>');
    app._filesHighlightExcerpt(preview, { id: 'first', excerpt: 'ping', occurrence: 0 });
    app._filesHighlightExcerpt(preview, { id: 'third', excerpt: 'ping', occurrence: 2 });
    const p = preview.querySelector('p')!;
    const nodes = Array.from(p.childNodes).map((n) => n.textContent);
    // 'ping' | '. ' | 'ping' | '. ping.'  → the third occurrence is untouched.
    expect(nodes[nodes.length - 1]).toContain('ping.');
    expect(marks().map((m) => m.dataset.noteId)).toEqual(['first', 'third']);
    expect(p.textContent).toBe('ping. ping. ping.');
  });
});

// ─── _filesUnwrapHighlights() ───────────────────────────────────────────────

describe('_filesUnwrapHighlights()', () => {
  beforeEach(() => {
    const preview = setPreview('<p>alpha beta gamma delta</p>');
    app._filesHighlightExcerpt(preview, { id: 'a', excerpt: 'alpha beta' });
    app._filesHighlightExcerpt(preview, { id: 'b', excerpt: 'gamma delta' });
    expect(marks()).toHaveLength(2);
  });

  it('removes only the requested note’s marks', () => {
    app._filesUnwrapHighlights('a');
    expect(marks().map((m) => m.dataset.noteId)).toEqual(['b']);
    expect(document.querySelector('p')!.textContent).toBe('alpha beta gamma delta');
  });

  it('removes every mark when called with no id', () => {
    app._filesUnwrapHighlights();
    expect(marks()).toHaveLength(0);
  });

  it('normalises the split text nodes back into one run', () => {
    app._filesUnwrapHighlights();
    const p = document.querySelector('p')!;
    expect(p.childNodes).toHaveLength(1);
    expect(p.textContent).toBe('alpha beta gamma delta');
  });

  it('re-highlights correctly after a full unwrap', () => {
    app._filesUnwrapHighlights();
    const preview = document.querySelector('.files-md-preview') as HTMLElement;
    app._filesHighlightExcerpt(preview, { id: 'c', excerpt: 'beta gamma' });
    expect(marks()).toHaveLength(1);
    expect(marks()[0].textContent).toBe('beta gamma');
  });
});

// ─── Selection capture (jsdom Range + stubbed Selection) ────────────────────

describe('_filesSelectionText() / _filesSelectionOccurrence()', () => {
  /** Stubs window.getSelection() with a Selection-shaped view of `range`. */
  function selectRange(range: Range | null) {
    (window as any).getSelection = () =>
      range === null
        ? null
        : {
            isCollapsed: range.collapsed,
            rangeCount: 1,
            getRangeAt: () => range,
            anchorNode: range.startContainer,
            toString: () => range.toString(),
          };
  }

  /** Range over [start,end) of the idx-th text node under `root`. */
  function textRange(root: Node, start: number, end: number, nodeIdx = 0): Range {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes: Node[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) nodes.push(n);
    const range = document.createRange();
    range.setStart(nodes[nodeIdx], start);
    range.setEnd(nodes[nodeIdx], end);
    return range;
  }

  it('normalises the selected text to single spaces', () => {
    const preview = setPreview('<p>the quick\n  brown fox</p>');
    selectRange(textRange(preview, 4, 21));
    expect(app._filesSelectionText()).toBe('quick brown fox');
  });

  it('returns nothing for a collapsed selection', () => {
    const preview = setPreview('<p>alpha beta</p>');
    selectRange(textRange(preview, 3, 3));
    expect(app._filesSelectionText()).toBe('');
  });

  it('returns nothing when the selection is outside the preview', () => {
    setPreview('<p>alpha beta</p>');
    const outside = document.createElement('p');
    outside.textContent = 'somewhere else';
    document.body.appendChild(outside);
    selectRange(textRange(outside, 0, 9));
    expect(app._filesSelectionText()).toBe('');
  });

  it('returns nothing when there is no selection at all', () => {
    setPreview('<p>alpha beta</p>');
    selectRange(null);
    expect(app._filesSelectionText()).toBe('');
  });

  it('counts the occurrence index the same way the projection later does', () => {
    const preview = setPreview('<p>tap here. tap here. tap here.</p>');
    // Select the SECOND "tap here" (offset 10).
    selectRange(textRange(preview, 10, 18));
    const excerpt = app._filesSelectionText();
    const occurrence = app._filesSelectionOccurrence(excerpt);
    expect(excerpt).toBe('tap here');
    expect(occurrence).toBe(1);

    // The highlight engine must resolve that index back to the same span.
    app._filesHighlightExcerpt(preview, { id: 'n1', excerpt, occurrence });
    const p = preview.querySelector('p')!;
    expect(p.childNodes[0].textContent).toBe('tap here. ');
    expect(p.childNodes[1]).toBe(marks()[0]);
    expect(p.textContent).toBe('tap here. tap here. tap here.');
  });

  it('reports occurrence 0 for the first match', () => {
    const preview = setPreview('<p>tap here. tap here.</p>');
    selectRange(textRange(preview, 0, 8));
    expect(app._filesSelectionOccurrence(app._filesSelectionText())).toBe(0);
  });

  it('reports occurrence 0 when there is no excerpt', () => {
    setPreview('<p>alpha</p>');
    expect(app._filesSelectionOccurrence('')).toBe(0);
  });
});

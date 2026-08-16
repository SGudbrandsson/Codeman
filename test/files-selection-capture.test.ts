// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for the gesture-time selection capture behind the
 * markdown review-notes affordances in src/web/public/app.js.
 *
 * Android Chrome / iOS Safari collapse the document selection as soon as a tap
 * lands outside it, so every affordance snapshots the selection on
 * `pointerdown` and the click handler consumes the snapshot. These tests run
 * the REAL method bodies (extracted from the shipped app.js text, as in
 * test/files-md-highlight.test.ts) on the REAL memoising `$()` plus the real
 * `$$()`, so a stale-node regression fails here too.
 *
 * Covers _filesCaptureSelSnapshot() / _filesTakeSelSnapshot() /
 * _filesClearSelSnapshot() (app.js ~20557), _filesUpdateNotePill() /
 * _filesHideNotePill() (app.js ~20579), filesAddNoteFromSelection()
 * (app.js ~20629), the pointerdown wiring in _filesRenderMdTools()
 * (app.js ~20901) and filesToggleListen() / _filesCaptureTtsStart()
 * (app.js ~21111).
 *
 * Run: npx vitest run test/files-selection-capture.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  if (lines[0].trimEnd().endsWith('}')) return lines[0];
  const end = lines.findIndex((l, i) => i > 0 && l === '  }');
  expect(end, `${name}() has no 2-space closing brace`).toBeGreaterThan(0);
  return lines.slice(0, end + 1).join('\n');
}

const METHODS = [
  '$',
  '$$',
  '_filesPreviewEl',
  '_filesIsMdPreview',
  '_filesSelectionText',
  '_filesSelectionOccurrence',
  '_filesNotesKey',
  '_filesNotesAll',
  '_filesNotesFor',
  '_filesCaptureSelSnapshot',
  '_filesTakeSelSnapshot',
  '_filesClearSelSnapshot',
  '_filesHideNotePill',
  '_filesUpdateNotePill',
  'filesAddNoteFromSelection',
  '_filesRenderMdTools',
  '_filesUpdateListenBtn',
  'filesToggleListen',
  '_filesCaptureTtsStart',
];

interface Harness {
  app: any;
  toasts: { msg: string; kind: string }[];
  dialogs: { excerpt: string; occurrence: number }[];
  tts: { playing: boolean; started: unknown[][]; ok: boolean };
}

function setSheet(previewHtml = '<p>the quick brown fox</p>') {
  document.body.innerHTML = `
    <div id="filesSheet" class="open">
      <div id="filesSheetView">
        <div id="filesSheetViewActions"></div>
        <div id="filesSheetViewContent">
          <div class="files-md-preview">${previewHtml}</div>
        </div>
      </div>
    </div>`;
  return document.querySelector('.files-md-preview') as HTMLElement;
}

function makeApp(overrides: Record<string, unknown> = {}): Harness {
  const body = METHODS.map(methodSource).join(',\n');
  const factory = new Function('FilesTTS', `return ({\n${body}\n});`);

  const toasts: { msg: string; kind: string }[] = [];
  const dialogs: { excerpt: string; occurrence: number }[] = [];
  const tts = { playing: false, started: [] as unknown[][], ok: true };
  const FilesTTS = {
    supported: true,
    isPlaying: () => tts.playing,
    start: (preview: unknown, startEl: unknown, onDone: unknown) => {
      tts.started.push([preview, startEl, onDone]);
      if (!tts.ok) return false;
      tts.playing = true;
      return true;
    },
    stop: () => {
      tts.playing = false;
    },
  };

  const app = Object.assign(factory(FilesTTS), {
    _elemCache: {},
    activeSessionId: 'sess-a',
    filesState: { current: { path: 'docs/story.md', editing: false }, notes: null, notesSessionId: null },
    _filesNotesOpen: false,
    showToast: (msg: string, kind: string) => toasts.push({ msg, kind }),
    _filesShowNoteDialog: (arg: { excerpt: string; occurrence: number }) => dialogs.push(arg),
    ...overrides,
  });

  return { app, toasts, dialogs, tts };
}

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

/** The Android/iOS behaviour under test: the tap collapses the selection. */
function collapseSelection() {
  selectRange(null);
}

let preview: HTMLElement;

beforeEach(() => {
  sessionStorage.clear();
  preview = setSheet();
  selectRange(null);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Snapshot helpers ───────────────────────────────────────────────────────

describe('selection snapshot helpers', () => {
  it('captures the excerpt and its occurrence index from the live selection', () => {
    const h = makeApp();
    setSheet('<p>tap here. tap here. tap here.</p>');
    selectRange(textRange(document.querySelector('.files-md-preview')!, 10, 18));

    const snap = h.app._filesCaptureSelSnapshot();
    expect(snap).toMatchObject({ excerpt: 'tap here', occurrence: 1 });
    expect(h.app._filesSelSnapshot).toBe(snap);
  });

  it('captures nothing when there is no selection', () => {
    const h = makeApp();
    expect(h.app._filesCaptureSelSnapshot()).toBeNull();
    expect(h.app._filesSelSnapshot).toBeUndefined();
  });

  it('prefers the live selection over an older snapshot', () => {
    const h = makeApp();
    selectRange(textRange(preview, 4, 9));
    h.app._filesCaptureSelSnapshot();
    selectRange(textRange(preview, 10, 19));

    expect(h.app._filesTakeSelSnapshot().excerpt).toBe('brown fox');
  });

  it('still yields the excerpt after the tap collapsed the selection', () => {
    // The Android Chrome repro: pointerdown captured, click sees nothing.
    const h = makeApp();
    selectRange(textRange(preview, 4, 9));
    h.app._filesCaptureSelSnapshot();
    collapseSelection();

    expect(h.app._filesTakeSelSnapshot().excerpt).toBe('quick');
  });

  it('rejects a snapshot older than 5s', () => {
    vi.useFakeTimers();
    const h = makeApp();
    selectRange(textRange(preview, 4, 9));
    h.app._filesCaptureSelSnapshot();
    collapseSelection();

    vi.advanceTimersByTime(4999);
    expect(h.app._filesTakeSelSnapshot()).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(h.app._filesTakeSelSnapshot()).toBeNull();
  });

  it('returns null when there is neither a selection nor a snapshot', () => {
    const h = makeApp();
    expect(h.app._filesTakeSelSnapshot()).toBeNull();
  });

  it('drops the snapshot on _filesClearSelSnapshot()', () => {
    const h = makeApp();
    selectRange(textRange(preview, 4, 9));
    h.app._filesCaptureSelSnapshot();
    h.app._filesClearSelSnapshot();
    collapseSelection();
    expect(h.app._filesTakeSelSnapshot()).toBeNull();
  });
});

// ─── The floating "Add note" bar ────────────────────────────────────────────

describe('_filesUpdateNotePill()', () => {
  it('creates the bar once and re-shows the same node on a later selection', () => {
    const h = makeApp();
    selectRange(textRange(preview, 4, 9));
    h.app._filesUpdateNotePill();
    const pill = document.getElementById('filesNotePill')!;
    expect(pill.textContent).toBe('Add note');
    expect(pill.style.display).toBe('block');

    collapseSelection();
    h.app._filesUpdateNotePill();
    expect(pill.style.display).toBe('none');

    selectRange(textRange(preview, 10, 19));
    h.app._filesUpdateNotePill();
    expect(document.querySelectorAll('#filesNotePill')).toHaveLength(1);
    expect(pill.style.display).toBe('block');
  });

  it('keeps the snapshot when the selection disappears, but drops it off md preview', () => {
    const h = makeApp();
    selectRange(textRange(preview, 4, 9));
    h.app._filesUpdateNotePill();
    collapseSelection();
    h.app._filesUpdateNotePill();
    expect(h.app._filesSelSnapshot).not.toBeNull();

    h.app.filesState.current.path = 'src/index.ts';
    h.app._filesUpdateNotePill();
    expect(h.app._filesSelSnapshot).toBeNull();
    expect(document.getElementById('filesNotePill')!.style.display).toBe('none');
  });

  it('re-creates the bar after its node was detached (uncached lookup)', () => {
    const h = makeApp();
    selectRange(textRange(preview, 4, 9));
    h.app._filesUpdateNotePill();
    const first = document.getElementById('filesNotePill')!;
    // Real-world sequence: the selection goes away (bar hidden — this is the
    // lookup that primes a memoising cache with `first`), then the view
    // re-renders and takes the bar with it.
    h.app._filesHideNotePill();
    first.remove();

    selectRange(textRange(preview, 4, 9));
    h.app._filesUpdateNotePill();

    // A memoised lookup would hand back the detached `first` and skip the
    // re-create branch, leaving no bar on screen at all.
    const live = document.getElementById('filesNotePill');
    expect(live).not.toBeNull();
    expect(live).not.toBe(first);
    expect(live!.style.display).toBe('block');
  });

  it('opens the dialog from the bar’s pointerdown even after the tap collapsed the selection', () => {
    const h = makeApp();
    selectRange(textRange(preview, 4, 9));
    h.app._filesUpdateNotePill();
    const pill = document.getElementById('filesNotePill')!;

    collapseSelection();
    const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
    pill.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true); // must not let the browser move focus
    expect(h.dialogs).toEqual([{ excerpt: 'quick', occurrence: 0 }]);
    expect(pill.style.display).toBe('none');
    expect(h.app._filesSelSnapshot).toBeNull(); // consumed, never reused
  });

  it('toasts instead of opening an empty dialog when the snapshot went stale', () => {
    vi.useFakeTimers();
    const h = makeApp();
    selectRange(textRange(preview, 4, 9));
    h.app._filesUpdateNotePill();
    const pill = document.getElementById('filesNotePill')!;

    collapseSelection();
    vi.advanceTimersByTime(6000);
    pill.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));

    expect(h.dialogs).toEqual([]);
    expect(h.toasts).toEqual([{ msg: 'Select some text first', kind: 'info' }]);
  });
});

// ─── Toolbar routes ─────────────────────────────────────────────────────────

describe('toolbar Note button', () => {
  function renderTools(h: Harness) {
    const actions = document.getElementById('filesSheetViewActions')!;
    actions.innerHTML = '';
    h.app._filesRenderMdTools(actions);
    return actions;
  }

  it('captures the selection on pointerdown without cancelling the click', () => {
    const h = makeApp();
    renderTools(h);
    selectRange(textRange(preview, 4, 9));

    const btn = document.getElementById('filesNoteToolBtn')!;
    const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(false); // the click must still fire
    expect(h.app._filesSelSnapshot).toMatchObject({ excerpt: 'quick' });
  });

  it('opens the dialog on click with what pointerdown captured', () => {
    const h = makeApp();
    renderTools(h);
    selectRange(textRange(preview, 4, 19));
    document.getElementById('filesNoteToolBtn')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    collapseSelection(); // Android Chrome has cleared it by click time

    h.app.filesAddNoteFromSelection();

    expect(h.dialogs).toEqual([{ excerpt: 'quick brown fox', occurrence: 0 }]);
  });

  it('re-attaches the pointerdown capture after the toolbar is re-rendered', () => {
    const h = makeApp();
    renderTools(h);
    renderTools(h); // toolbar node replaced

    selectRange(textRange(preview, 4, 9));
    document.getElementById('filesNoteToolBtn')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(h.app._filesSelSnapshot).toMatchObject({ excerpt: 'quick' });
  });

  it('toasts when there is nothing captured at all', () => {
    const h = makeApp();
    renderTools(h);
    h.app.filesAddNoteFromSelection();

    expect(h.dialogs).toEqual([]);
    expect(h.toasts).toEqual([{ msg: 'Select some text in the preview first', kind: 'info' }]);
  });
});

// ─── Listen button (TTS) ────────────────────────────────────────────────────

describe('filesToggleListen() / _filesCaptureTtsStart()', () => {
  function renderTools(h: Harness) {
    const actions = document.getElementById('filesSheetViewActions')!;
    actions.innerHTML = '';
    h.app._filesRenderMdTools(actions);
  }

  it('captures the block the selection starts in on the button’s pointerdown', () => {
    const h = makeApp();
    preview = setSheet('<p>first para</p><p id="second">second para</p>');
    renderTools(h);
    selectRange(textRange(document.getElementById('second')!, 0, 6));

    document.getElementById('filesListenBtn')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(h.app._filesTtsStartEl).toBe(document.getElementById('second'));
  });

  it('starts reading from the captured block inside the click, then clears it', () => {
    const h = makeApp();
    preview = setSheet('<p>first para</p><p id="second">second para</p>');
    renderTools(h);
    selectRange(textRange(document.getElementById('second')!, 0, 6));
    document.getElementById('filesListenBtn')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    collapseSelection(); // gone by click time on Android Chrome

    h.app.filesToggleListen();

    expect(h.tts.started).toHaveLength(1);
    expect(h.tts.started[0][1]).toBe(document.getElementById('second'));
    expect(h.app._filesTtsStartEl).toBeNull();
    expect(document.getElementById('filesListenBtn')!.textContent).toBe('■ Stop');
  });

  it('falls back to a live re-read when the captured block is no longer in the preview', () => {
    const h = makeApp();
    preview = setSheet('<p id="only">only para</p>');
    renderTools(h);
    h.app._filesTtsStartEl = document.createElement('p'); // detached, stale

    selectRange(textRange(document.getElementById('only')!, 0, 4));
    h.app.filesToggleListen();

    expect(h.tts.started[0][1]).toBe(document.getElementById('only'));
  });

  it('toasts when there is nothing to read', () => {
    const h = makeApp();
    h.tts.ok = false;
    renderTools(h);
    h.app.filesToggleListen();

    expect(h.toasts).toEqual([{ msg: 'Nothing to read in this document', kind: 'info' }]);
    expect(document.getElementById('filesListenBtn')!.textContent).toBe('▶ Listen');
  });

  it('stops playback and updates the re-rendered button label', () => {
    const h = makeApp();
    renderTools(h);
    h.app._filesUpdateListenBtn(); // primes the lookup with button #1
    h.tts.playing = true;
    renderTools(h); // button re-created while playing

    h.app.filesToggleListen();

    expect(h.tts.playing).toBe(false);
    expect(document.getElementById('filesListenBtn')!.textContent).toBe('▶ Listen');
  });
});

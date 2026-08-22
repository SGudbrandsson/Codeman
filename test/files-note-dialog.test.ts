// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for the markdown review-notes note dialog lifecycle,
 * its OverlayHistory integration and the stale-cached-node regressions in the
 * surrounding notes UI (src/web/public/app.js).
 *
 * As in test/files-md-highlight.test.ts and test/files-review-notes.test.ts the
 * REAL method bodies are extracted from the shipped app.js text and re-compiled
 * into a plain object. Critically — and unlike those two suites — this harness
 * keeps the REAL memoising `$()` (with its own `_elemCache`) and the real
 * `$$()`, because the bug under test (empty, undismissable second dialog) only
 * exists when `$()` caches. A live-lookup `$` stub would be green against both
 * the broken and the fixed code.
 *
 * Covers $/$$/_invalidateElem (app.js ~5453), _filesShowNoteDialog() /
 * _filesCloseNoteDialog() / _filesCloseNoteDialogInternal() (app.js ~20646),
 * _filesTeardownNotesUi() / _filesRenderNotesPanel() / _filesRefreshNotesUi()
 * (app.js ~20939) and _filesUpdateListenBtn() (app.js ~21145).
 *
 * Run: npx vitest run test/files-note-dialog.test.ts
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

/** Real value of the gesture-grace constant, read from app.js so the tests
 *  cannot drift from the shipped source. */
const GRACE_MS = Number(/const FILES_NOTE_GESTURE_GRACE_MS = (\d+);/.exec(APP_JS_SOURCE)?.[1]);

const METHODS = [
  '$',
  '$$',
  '_invalidateElem',
  '_filesPreviewEl',
  '_filesNotesKey',
  '_filesNotesAll',
  '_filesNotesFor',
  '_filesPersistNotes',
  '_filesSaveNote',
  '_filesTruncate',
  '_filesHideNotePill',
  '_filesClearSelSnapshot',
  '_filesNoteInOpenGrace',
  '_filesClearClickSwallow',
  '_filesShowNoteDialog',
  '_filesCloseNoteDialog',
  '_filesCloseNoteDialogInternal',
  '_filesTeardownNotesUi',
  '_filesRenderNotesPanel',
  '_filesRefreshNotesUi',
  '_filesRenderMdTools',
  '_filesUpdateListenBtn',
];

interface OverlayHistoryStub {
  stack: { id: string; closeFn: (...a: unknown[]) => void }[];
  pushes: string[];
  pops: string[];
  push(id: string, closeFn: (...a: unknown[]) => void): void;
  pop(id: string): void;
  has(id: string): boolean;
  /** Simulates the hardware back button popping the top entry. */
  back(): void;
}

interface Harness {
  app: any;
  toasts: { msg: string; kind: string }[];
  history: OverlayHistoryStub;
  tts: { playing: boolean; started: unknown[][] };
}

function makeOverlayHistory(): OverlayHistoryStub {
  return {
    stack: [],
    pushes: [],
    pops: [],
    push(id, closeFn) {
      this.pushes.push(id);
      this.stack.push({ id, closeFn });
    },
    pop(id) {
      this.pops.push(id);
      this.stack = this.stack.filter((e) => e.id !== id);
    },
    has(id) {
      return this.stack.some((e) => e.id === id);
    },
    back() {
      const top = this.stack.pop();
      if (top) top.closeFn();
    },
  };
}

/** Files sheet DOM: the static ids `$()` is allowed to memoise. */
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
}

/**
 * Every harness built in this file, so afterEach can close any dialog a test
 * left open. `_filesShowNoteDialog()` installs a DOCUMENT-level capture
 * `keydown` listener, and jsdom's `document` is shared by every test in the
 * file — a dialog left open leaks that listener into later tests, where its
 * defensive `getElementById('filesNoteOverlay')` sweep would close another
 * harness's overlay and make the Escape tests order-dependent.
 */
const harnesses: Harness[] = [];

function makeApp(overrides: Record<string, unknown> = {}): Harness {
  const body = METHODS.map(methodSource).join(',\n');
  const factory = new Function(
    'OverlayHistory',
    'FilesTTS',
    'escapeHtml',
    'FILES_NOTE_GESTURE_GRACE_MS',
    `return ({\n${body}\n});`
  );

  const toasts: { msg: string; kind: string }[] = [];
  const history = makeOverlayHistory();
  const tts = { playing: false, started: [] as unknown[][] };
  const FilesTTS = {
    supported: true,
    isPlaying: () => tts.playing,
    start: (...args: unknown[]) => {
      tts.started.push(args);
      tts.playing = true;
      return true;
    },
    stop: () => {
      tts.playing = false;
    },
  };
  const escapeHtml = (s: string) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const app = Object.assign(factory(history, FilesTTS, escapeHtml, GRACE_MS), {
    _elemCache: {},
    activeSessionId: 'sess-a',
    filesState: { current: { path: 'docs/story.md' }, notes: null, notesSessionId: null },
    _filesNotesOpen: false,
    showToast: (msg: string, kind: string) => toasts.push({ msg, kind }),
    _filesHighlightExcerpt: vi.fn(),
    _filesIsMdPreview: () => true,
    ...overrides,
  });

  const harness = { app, toasts, history, tts };
  harnesses.push(harness);
  return harness;
}

function overlay(): HTMLElement | null {
  return document.getElementById('filesNoteOverlay');
}

function excerptText(): string {
  const ov = overlay();
  return ov ? (ov.querySelector('#filesNoteExcerpt') as HTMLElement).textContent || '' : '';
}

/**
 * Rewinds the dialog's gesture-grace window into the past, so a following tap
 * counts as a deliberate, LATER one rather than the residue of the tap that
 * opened the dialog (the ghost-click guard in _filesNoteInOpenGrace()).
 */
function pastGrace(h: Harness) {
  h.app._filesNoteOpenedAt = Date.now() - GRACE_MS - 1;
}

function pressEscape(target: EventTarget = document) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

beforeEach(() => {
  sessionStorage.clear();
  setSheet();
});

afterEach(() => {
  // Close anything still open so no document-level keydown listener survives
  // into the next test (see the `harnesses` comment above).
  for (const h of harnesses) {
    try {
      h.app._filesCloseNoteDialog();
    } catch {
      /* harness already torn down */
    }
  }
  harnesses.length = 0;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

// ─── $ / $$ contract ────────────────────────────────────────────────────────

describe('$() / $$() element getters', () => {
  it('$() memoises a node forever, $$() always re-resolves it', () => {
    const { app } = makeApp();
    const first = app.$('filesSheetView');
    const firstUncached = app.$$('filesSheetView');
    expect(first).toBe(firstUncached);

    setSheet(); // the whole sheet is replaced — every node above is now detached
    expect(app.$('filesSheetView')).toBe(first);
    expect(app.$('filesSheetView').isConnected).toBe(false);
    expect(app.$$('filesSheetView')).not.toBe(first);
    expect(app.$$('filesSheetView').isConnected).toBe(true);
  });

  it('_invalidateElem() drops the memoised node so $() re-resolves', () => {
    const { app } = makeApp();
    const first = app.$('filesSheetView');
    setSheet();
    app._invalidateElem('filesSheetView');
    expect(app.$('filesSheetView')).not.toBe(first);
    expect(app.$('filesSheetView').isConnected).toBe(true);
  });
});

// ─── Note dialog lifecycle ──────────────────────────────────────────────────

describe('_filesShowNoteDialog()', () => {
  it('shows the captured excerpt on the SECOND dialog too', () => {
    // The reported bug: from the 2nd open onwards every node was resolved via
    // the memoising $(), so the excerpt landed on dialog #1's detached node.
    const { app } = makeApp();

    app._filesShowNoteDialog({ excerpt: 'first excerpt', occurrence: 0 });
    expect(excerptText()).toBe('first excerpt');
    app._filesCloseNoteDialog();

    app._filesShowNoteDialog({ excerpt: 'second excerpt', occurrence: 0 });
    expect(excerptText()).toBe('second excerpt');
    app._filesCloseNoteDialog();

    app._filesShowNoteDialog({ excerpt: 'third excerpt', occurrence: 0 });
    expect(excerptText()).toBe('third excerpt');
  });

  it('inserts the excerpt as text, never as HTML', () => {
    const { app } = makeApp();
    app._filesShowNoteDialog({ excerpt: '<img src=x onerror=boom>', occurrence: 0 });
    const box = overlay()!.querySelector('#filesNoteExcerpt') as HTMLElement;
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toBe('<img src=x onerror=boom>');
  });

  it('toasts instead of opening an empty dialog when there is no excerpt', () => {
    const { app, toasts } = makeApp();
    app._filesShowNoteDialog({ excerpt: '   ', occurrence: 0 });
    expect(overlay()).toBeNull();
    expect(toasts).toEqual([{ msg: 'Select some text first', kind: 'info' }]);
  });

  it('opens an edit dialog from the stored note, bypassing the blank guard', () => {
    const { app } = makeApp();
    app._filesSaveNote({ excerpt: 'stored passage', occurrence: 3, id: null, note: 'first take' });
    const note = app._filesNotesFor('docs/story.md')[0];

    app._filesShowNoteDialog({ id: note.id });
    expect(excerptText()).toBe('stored passage');
    expect((overlay()!.querySelector('#filesNoteInput') as HTMLTextAreaElement).value).toBe('first take');
  });

  it('opens nothing for an edit of an id that no longer exists', () => {
    const { app, toasts } = makeApp();
    app._filesShowNoteDialog({ id: 'note-that-was-deleted' });
    expect(overlay()).toBeNull();
    expect(toasts).toEqual([]);
  });

  it('submits with Cmd/Ctrl+Enter from inside the live textarea', () => {
    const h = makeApp();
    h.app._filesShowNoteDialog({ excerpt: 'first excerpt', occurrence: 0 });
    h.app._filesCloseNoteDialog();
    h.app._filesShowNoteDialog({ excerpt: 'second excerpt', occurrence: 1 });

    const input = overlay()!.querySelector('#filesNoteInput') as HTMLTextAreaElement;
    input.value = 'typed then Cmd+Enter';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));

    expect(overlay()).toBeNull();
    expect(h.app._filesNotesFor('docs/story.md')[0]).toMatchObject({
      excerpt: 'second excerpt',
      occurrence: 1,
      note: 'typed then Cmd+Enter',
    });
  });

  it('removes a previous dialog rather than stacking two overlays', () => {
    const { app } = makeApp();
    app._filesShowNoteDialog({ excerpt: 'one', occurrence: 0 });
    app._filesShowNoteDialog({ excerpt: 'two', occurrence: 0 });
    expect(document.querySelectorAll('#filesNoteOverlay')).toHaveLength(1);
    expect(excerptText()).toBe('two');
  });
});

describe('note dialog close paths', () => {
  /** Opens dialog #1, closes it, then opens dialog #2 — the broken state. */
  function secondDialog(h: Harness, excerpt = 'second excerpt') {
    h.app._filesShowNoteDialog({ excerpt: 'first excerpt', occurrence: 0 });
    h.app._filesCloseNoteDialog();
    h.app._filesShowNoteDialog({ excerpt, occurrence: 1 });
  }

  it('closes the SECOND dialog via _filesCloseNoteDialog()', () => {
    const h = makeApp();
    secondDialog(h);
    h.app._filesCloseNoteDialog();
    expect(overlay()).toBeNull();
  });

  it('closes the SECOND dialog from its Cancel button', () => {
    const h = makeApp();
    secondDialog(h);
    pastGrace(h);
    (overlay()!.querySelector('#filesNoteCancel') as HTMLButtonElement).click();
    expect(overlay()).toBeNull();
  });

  it('closes on a backdrop tap but not on a click inside the dialog', () => {
    const h = makeApp();
    secondDialog(h);
    (overlay()!.querySelector('.files-create-dialog') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    expect(overlay()).not.toBeNull();

    pastGrace(h);
    overlay()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay()).toBeNull();
  });

  it('closes on Escape wherever focus is, and unbinds the handler afterwards', () => {
    const h = makeApp();
    secondDialog(h);
    // Focus has moved off the textarea — the old textarea-bound handler was dead here.
    pressEscape(document.body);
    expect(overlay()).toBeNull();

    // The document-level capture listener must not survive the close. Asserting
    // "the overlay is gone" would be worthless here: a LEAKED handler also
    // closes it, via _filesCloseNoteDialogInternal()'s defensive stray sweep.
    // So assert the unbinding itself, and prove no handler is left listening.
    expect(h.app._filesNoteKeydown).toBeNull();

    const closeSpy = vi.spyOn(h.app, '_filesCloseNoteDialog');
    pressEscape(document.body);
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it('does not let a closed dialog’s Escape handler kill the NEXT dialog', () => {
    const h = makeApp();
    h.app._filesShowNoteDialog({ excerpt: 'first excerpt', occurrence: 0 });
    const firstHandler = h.app._filesNoteKeydown;
    h.app._filesCloseNoteDialog();

    h.app._filesShowNoteDialog({ excerpt: 'second excerpt', occurrence: 1 });
    expect(h.app._filesNoteKeydown).not.toBe(firstHandler);
    // Exactly one live listener: one Escape closes one dialog, and a second
    // Escape (with the dialog already gone) must be a no-op.
    pressEscape(document.body);
    expect(overlay()).toBeNull();
    expect(h.app._filesNoteKeydown).toBeNull();
  });

  it('sweeps away a stray overlay whose live reference was lost', () => {
    const h = makeApp();
    h.app._filesShowNoteDialog({ excerpt: 'first excerpt', occurrence: 0 });
    h.app._filesNoteOverlayEl = null;
    h.app._filesCloseNoteDialogInternal();
    expect(overlay()).toBeNull();
  });

  it('saves what was typed into the SECOND dialog’s live textarea', () => {
    const h = makeApp();
    secondDialog(h);
    (overlay()!.querySelector('#filesNoteInput') as HTMLTextAreaElement).value = 'typed in dialog two';
    (overlay()!.querySelector('#filesNoteSave') as HTMLButtonElement).click();

    const notes = h.app._filesNotesFor('docs/story.md');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ excerpt: 'second excerpt', occurrence: 1, note: 'typed in dialog two' });
    expect(overlay()).toBeNull();
  });
});

// ─── Ghost-click guard (the opening tap's own residual events) ──────────────

describe('note dialog gesture-grace guard', () => {
  /** Opens a dialog the way the pill does: synchronously, inside one gesture. */
  function openFromPill(h: Harness) {
    h.app._filesShowNoteDialog({ excerpt: 'the quick brown', occurrence: 0 });
    expect(overlay()).not.toBeNull();
  }

  it('survives the opening tap’s own backdrop click in the same tick', () => {
    // The reported bug: pointerdown opens the dialog, the SAME tap's click
    // lands on the freshly-appended backdrop and closed it again instantly.
    const h = makeApp();
    openFromPill(h);
    overlay()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay()).not.toBeNull();
  });

  it('is time-based, not first-click-only: a 200 ms-late ghost click is still ignored', () => {
    vi.useFakeTimers();
    const h = makeApp();
    openFromPill(h);

    vi.advanceTimersByTime(200);
    overlay()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay()).not.toBeNull();

    // Past the window the very same event closes it — proving the guard is a
    // clock, not a one-shot counter.
    vi.advanceTimersByTime(GRACE_MS);
    overlay()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay()).toBeNull();
  });

  it('ignores a Cancel click inside the window but honours a later one', () => {
    // On a short viewport the dialog reaches far enough down that Cancel ends
    // up under the finger that opened it.
    const h = makeApp();
    openFromPill(h);
    const cancel = () => (overlay()!.querySelector('#filesNoteCancel') as HTMLButtonElement).click();

    cancel();
    expect(overlay()).not.toBeNull();

    pastGrace(h);
    cancel();
    expect(overlay()).toBeNull();
  });

  it('swallows a backdrop pointerup inside the window, and lets a later one through', () => {
    const h = makeApp();
    openFromPill(h);

    const early = new Event('pointerup', { bubbles: true, cancelable: true });
    overlay()!.dispatchEvent(early);
    expect(early.defaultPrevented).toBe(true);
    expect(overlay()).not.toBeNull();

    pastGrace(h);
    const late = new Event('pointerup', { bubbles: true, cancelable: true });
    overlay()!.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(false);
    // Nothing closes on pointerup today — the swallow is purely defensive.
    expect(overlay()).not.toBeNull();
  });

  it('never guards Escape — it closes immediately after open', () => {
    // A tap cannot produce a keydown, so the exemption is safe; asserting it
    // is what stops a future “guard everything” regression.
    const h = makeApp();
    openFromPill(h);
    expect(h.app._filesNoteInOpenGrace()).toBe(true);

    pressEscape(document.body);
    expect(overlay()).toBeNull();
  });

  it('never guards the OverlayHistory back button — it closes immediately after open', () => {
    const h = makeApp();
    openFromPill(h);
    expect(h.app._filesNoteInOpenGrace()).toBe(true);

    h.history.back();
    expect(overlay()).toBeNull();
  });

  it('resets the window on close so the next dialog gets a fresh one', () => {
    const h = makeApp();
    expect(h.app._filesNoteInOpenGrace()).toBe(false); // nothing ever opened

    openFromPill(h);
    expect(h.app._filesNoteInOpenGrace()).toBe(true);

    h.app._filesCloseNoteDialog();
    expect(h.app._filesNoteOpenedAt).toBe(0);
    expect(h.app._filesNoteInOpenGrace()).toBe(false);

    // Re-opened: guarded again, so a second pill tap is equally protected.
    openFromPill(h);
    expect(h.app._filesNoteInOpenGrace()).toBe(true);
  });
});

// ─── OverlayHistory integration ─────────────────────────────────────────────

describe('note dialog ↔ OverlayHistory', () => {
  it('pushes a files-note entry on open so back closes the dialog, not the file view', () => {
    const h = makeApp();
    h.app._filesShowNoteDialog({ excerpt: 'passage', occurrence: 0 });
    expect(h.history.pushes).toEqual(['files-note']);
    expect(h.history.has('files-note')).toBe(true);
  });

  it('pops exactly once on a UI-driven close and is idempotent on repeat calls', () => {
    const h = makeApp();
    h.app._filesShowNoteDialog({ excerpt: 'passage', occurrence: 0 });
    h.app._filesCloseNoteDialog();
    h.app._filesCloseNoteDialog();
    expect(h.history.pops).toEqual(['files-note']);
  });

  it('closes the dialog from the back button without popping again', () => {
    const h = makeApp();
    h.app._filesShowNoteDialog({ excerpt: 'passage', occurrence: 0 });
    h.history.back();
    expect(overlay()).toBeNull();
    expect(h.app._filesNoteHistoryOpen).toBe(false);
    expect(h.history.pops).toEqual([]);

    // A later close must not pop an entry the back button already consumed.
    h.app._filesCloseNoteDialog();
    expect(h.history.pops).toEqual([]);
  });
});

// ─── Stale-node regressions in the surrounding notes UI ─────────────────────

describe('notes UI survives teardown / re-render (uncached lookups)', () => {
  it('re-creates the notes panel after _filesTeardownNotesUi() removed it', () => {
    const h = makeApp();
    h.app._filesNotesOpen = true;
    h.app._filesRenderNotesPanel();
    expect(document.getElementById('filesNotesPanel')).not.toBeNull();

    h.app._filesTeardownNotesUi();
    expect(document.getElementById('filesNotesPanel')).toBeNull();

    h.app._filesNotesOpen = true;
    h.app._filesRenderNotesPanel();
    expect(document.getElementById('filesNotesPanel')).not.toBeNull();
  });

  it('updates the Notes (N) count on the re-rendered toolbar button', () => {
    const h = makeApp();
    const actions = () => document.getElementById('filesSheetViewActions')!;
    h.app._filesRenderMdTools(actions());
    // Prime the lookup with button #1 — this is the precondition of the bug:
    // a memoising $() would hand back this (soon detached) node forever.
    h.app._filesRefreshNotesUi();
    expect(document.getElementById('filesNotesBtn')!.textContent).toBe('Notes (0)');

    // The toolbar is re-created on every view render.
    actions().innerHTML = '';
    h.app._filesRenderMdTools(actions());
    h.app._filesSaveNote({ excerpt: 'passage', occurrence: 0, id: null, note: 'a note' });

    expect(document.getElementById('filesNotesBtn')!.textContent).toBe('Notes (1)');
  });

  it('updates the ▶ Listen / ■ Stop label on the re-rendered toolbar button', () => {
    const h = makeApp();
    const actions = () => document.getElementById('filesSheetViewActions')!;
    h.app._filesRenderMdTools(actions());
    // Prime the lookup with button #1 before it is thrown away — without this
    // even a memoising $() would resolve the live button on its first call.
    h.app._filesUpdateListenBtn();
    actions().innerHTML = '';
    h.app._filesRenderMdTools(actions());

    h.tts.playing = true;
    h.app._filesUpdateListenBtn();
    expect(document.getElementById('filesListenBtn')!.textContent).toBe('■ Stop');

    h.tts.playing = false;
    h.app._filesUpdateListenBtn();
    expect(document.getElementById('filesListenBtn')!.textContent).toBe('▶ Listen');
  });
});

describe('_filesTeardownNotesUi()', () => {
  it('closes a dangling dialog, pops its history entry and drops the captured state', () => {
    const h = makeApp();
    h.app._filesSelSnapshot = { excerpt: 'passage', occurrence: 0, ts: Date.now() };
    h.app._filesTtsStartEl = document.querySelector('.files-md-preview p');
    h.app._filesShowNoteDialog({ excerpt: 'passage', occurrence: 0 });

    h.app._filesTeardownNotesUi();

    expect(overlay()).toBeNull();
    expect(h.history.pops).toEqual(['files-note']);
    expect(h.app._filesSelSnapshot).toBeNull();
    expect(h.app._filesTtsStartEl).toBeNull();
  });
});

// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for the markdown review-notes state layer and
 * filesSendNotes() in src/web/public/app.js.
 *
 * As in test/files-md-highlight.test.ts, the REAL method bodies are extracted
 * from the shipped app.js text and re-compiled into a plain object, so these
 * assertions cannot drift from the code that ships. Only the collaborators the
 * methods call out to (showToast, sendInput, the notes UI, SecretDetector,
 * TranscriptView) are stubbed.
 *
 * Covers _filesNotesAll/_filesNotesFor/_filesPersistNotes/_filesSaveNote/
 * filesEditNote/filesDeleteNote/filesClearNotes (app.js ~20428) and
 * filesSendNotes() (app.js ~20918).
 *
 * Run: npx vitest run test/files-review-notes.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

// ─── Real-source extraction ─────────────────────────────────────────────────

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
  '_filesNotesKey',
  '_filesNotesAll',
  '_filesNotesFor',
  '_filesPersistNotes',
  '_filesSaveNote',
  'filesDeleteNote',
  'filesClearNotes',
  'filesSendNotes',
  '_filesTruncate',
  '_filesPreviewEl',
  '_filesTextProjection',
  '_filesHighlightExcerpt',
  '_filesUnwrapHighlights',
  // The Send button's busy state is DERIVED inside the render function, so the
  // real panel renderer (and the refresh that drives it) has to run here.
  '_filesRenderNotesPanel',
  '_filesRefreshNotesUi',
];

interface Harness {
  app: any;
  toasts: { msg: string; kind: string }[];
  sent: { text: string; sid: string }[];
  secretDetector: any;
  transcript: any;
  tabStatus: { sid: string; status: string }[];
}

function makeApp(overrides: Record<string, unknown> = {}): Harness {
  const body = METHODS.map(methodSource).join(',\n');
  const factory = new Function('SecretDetector', 'TranscriptView', 'escapeHtml', `return ({\n${body}\n});`);

  const toasts: { msg: string; kind: string }[] = [];
  const sent: { text: string; sid: string }[] = [];
  const tabStatus: { sid: string; status: string }[] = [];
  const secretDetector = {
    enabled: false,
    result: { count: 0, redacted: '' },
    isEnabled() {
      return this.enabled;
    },
    scan(_sid: string, _msg: string) {
      return this.result;
    },
  };
  const transcript = {
    _sessionId: 'sess-a',
    optimistic: [] as string[],
    working: [] as boolean[],
    appendOptimistic(msg: string) {
      this.optimistic.push(msg);
    },
    setWorking(v: boolean) {
      this.working.push(v);
    },
  };

  const escapeHtml = (t: string) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const app = Object.assign(factory(secretDetector, transcript, escapeHtml), {
    activeSessionId: 'sess-a',
    filesState: { current: { path: 'docs/story.md' }, notes: null, notesSessionId: null },
    $: (id: string) => document.getElementById(id),
    $$: (id: string) => document.getElementById(id),
    showToast: (msg: string, kind: string) => toasts.push({ msg, kind }),
    sendInput: vi.fn(async (text: string, sid: string) => {
      sent.push({ text, sid });
    }),
    _updateTabStatusDebounced: (sid: string, status: string) => tabStatus.push({ sid, status }),
    _filesCloseNoteDialog: vi.fn(),
    _filesNotesOpen: false,
    ...overrides,
  });

  return { app, toasts, sent, secretDetector, transcript, tabStatus };
}

function stored(sid: string) {
  const raw = sessionStorage.getItem('codeman-review-notes:' + sid);
  return raw ? JSON.parse(raw) : null;
}

function addNote(h: Harness, note: string, excerpt = 'some passage', occurrence = 0) {
  h.app._filesSaveNote({ excerpt, occurrence, id: null, note });
}

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = '';
});

// ─── Notes state layer ──────────────────────────────────────────────────────

describe('review-notes state', () => {
  it('persists an added note under the session-scoped key and reads it back', () => {
    const h = makeApp();
    addNote(h, 'tighten this');

    expect(stored('sess-a')).toEqual({
      'docs/story.md': [expect.objectContaining({ excerpt: 'some passage', occurrence: 0, note: 'tighten this' })],
    });

    const fresh = makeApp();
    expect(fresh.app._filesNotesFor('docs/story.md')[0].note).toBe('tighten this');
  });

  it('refuses an empty comment and toasts instead', () => {
    const h = makeApp();
    h.app._filesSaveNote({ excerpt: 'x', occurrence: 0, id: null, note: '   ' });
    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(0);
    expect(h.toasts).toEqual([{ msg: 'Write a comment first', kind: 'error' }]);
  });

  it('never serves one session’s notes to another', () => {
    const h = makeApp();
    addNote(h, 'note for A');

    h.app.activeSessionId = 'sess-b';
    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(0);

    addNote(h, 'note for B');
    expect(stored('sess-a')['docs/story.md'][0].note).toBe('note for A');
    expect(stored('sess-b')['docs/story.md'][0].note).toBe('note for B');
  });

  it('refuses to write a cache that belongs to a different session', () => {
    const h = makeApp();
    addNote(h, 'note for A');
    // Simulates a path that swapped activeSessionId without reloading the cache.
    h.app.activeSessionId = 'sess-b';
    h.app.filesState.notes['docs/story.md'].push({ id: 'x', excerpt: 'e', occurrence: 0, note: 'leak' });
    h.app._filesPersistNotes();
    expect(stored('sess-b')).toBeNull();
    expect(stored('sess-a')['docs/story.md']).toHaveLength(1);
  });

  it('edits a note in place, keeping its id and occurrence', () => {
    const h = makeApp();
    addNote(h, 'first take', 'some passage', 2);
    const note = h.app._filesNotesFor('docs/story.md')[0];

    h.app._filesSaveNote({ excerpt: 'ignored', occurrence: 9, id: note.id, note: 'second take' });

    const after = h.app._filesNotesFor('docs/story.md');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: note.id, occurrence: 2, excerpt: 'some passage', note: 'second take' });
    expect(stored('sess-a')['docs/story.md'][0].note).toBe('second take');
  });

  it('deletes a single note and persists the removal', () => {
    const h = makeApp();
    addNote(h, 'one', 'passage one');
    addNote(h, 'two', 'passage two');
    const [first] = h.app._filesNotesFor('docs/story.md');

    h.app.filesDeleteNote(first.id);

    expect(h.app._filesNotesFor('docs/story.md').map((n: any) => n.note)).toEqual(['two']);
    expect(stored('sess-a')['docs/story.md']).toHaveLength(1);
  });

  it('clears every note for the file once the confirm is accepted', () => {
    const h = makeApp();
    addNote(h, 'one');
    addNote(h, 'two');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    h.app.filesClearNotes();

    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(0);
    expect(stored('sess-a')['docs/story.md']).toEqual([]);
    confirmSpy.mockRestore();
  });

  it('keeps the notes when the clear-all confirm is declined', () => {
    const h = makeApp();
    addNote(h, 'one');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    h.app.filesClearNotes();

    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(1);
    confirmSpy.mockRestore();
  });

  it('degrades to an empty map when storage holds non-object JSON', () => {
    sessionStorage.setItem('codeman-review-notes:sess-a', '"not an object"');
    const h = makeApp();
    expect(h.app._filesNotesAll()).toEqual({});

    sessionStorage.setItem('codeman-review-notes:sess-a', '{ broken');
    const h2 = makeApp();
    expect(h2.app._filesNotesAll()).toEqual({});
  });

  it('keeps notes for a path across an Edit⇄Preview flip (state is not in the DOM)', () => {
    const h = makeApp();
    document.body.innerHTML =
      '<div id="filesSheetViewContent"><div class="files-md-preview"><p>some passage</p></div></div>';
    addNote(h, 'tighten this');
    // Flip to Edit: the preview (and its <mark>s) is destroyed.
    document.body.innerHTML = '<div id="filesSheetViewContent"><div class="cm-editor"></div></div>';
    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(1);
  });

  it('scopes notes by path within one session', () => {
    const h = makeApp();
    addNote(h, 'story note');
    h.app.filesState.current = { path: 'docs/other.md' };
    expect(h.app._filesNotesFor('docs/other.md')).toHaveLength(0);
    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(1);
  });
});

// ─── filesSendNotes() ───────────────────────────────────────────────────────

describe('filesSendNotes()', () => {
  function withNotes(h: Harness, notes: { excerpt: string; note: string }[]) {
    for (const n of notes) addNote(h, n.note, n.excerpt);
  }

  it('composes one LLM-friendly message and submits it with a trailing CR', async () => {
    const h = makeApp();
    withNotes(h, [
      { excerpt: 'the quick brown fox', note: 'too clichéd' },
      { excerpt: 'jumps over', note: 'nice rhythm' },
    ]);

    await h.app.filesSendNotes();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].sid).toBe('sess-a');
    expect(h.sent[0].text).toBe(
      [
        'Review notes on `docs/story.md`:',
        '',
        '1.',
        '   > the quick brown fox',
        '   — too clichéd',
        '',
        '2.',
        '   > jumps over',
        '   — nice rhythm',
      ].join('\n') + '\r'
    );
  });

  it('sends to the session captured before the await, not the one active after it', async () => {
    const h = makeApp();
    withNotes(h, [{ excerpt: 'a', note: 'b' }]);
    h.app.sendInput = vi.fn(async (text: string, sid: string) => {
      h.app.activeSessionId = 'sess-b'; // SSE-driven switch mid-send
      h.sent.push({ text, sid });
    });

    await h.app.filesSendNotes();

    expect(h.sent[0].sid).toBe('sess-a');
    expect(h.tabStatus).toEqual([{ sid: 'sess-a', status: 'busy' }]);
  });

  it('does nothing but toast when there are no notes', async () => {
    const h = makeApp();
    await h.app.filesSendNotes();
    expect(h.sent).toHaveLength(0);
    expect(h.toasts).toEqual([{ msg: 'No notes to send', kind: 'error' }]);
  });

  it('does nothing but toast when there is no active session', async () => {
    const h = makeApp();
    withNotes(h, [{ excerpt: 'a', note: 'b' }]);
    h.app.activeSessionId = null;

    await h.app.filesSendNotes();

    expect(h.sent).toHaveLength(0);
    expect(h.toasts.at(-1)).toEqual({ msg: 'No active session', kind: 'error' });
  });

  it('refuses to send a message over 32000 characters and keeps the notes', async () => {
    const h = makeApp();
    for (let i = 0; i < 40; i++) {
      addNote(h, 'x'.repeat(800), 'y'.repeat(400) + ' ' + i);
    }

    await h.app.filesSendNotes();

    expect(h.sent).toHaveLength(0);
    expect(h.toasts.at(-1)!.msg).toContain('too long to send');
    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(40);
  });

  it('truncates a long excerpt at 400 chars and a long note at 800', async () => {
    const h = makeApp();
    addNote(h, 'n'.repeat(900), 'e'.repeat(500));

    await h.app.filesSendNotes();

    const lines = h.sent[0].text.replace(/\r$/, '').split('\n');
    expect(lines[3]).toBe('   > ' + 'e'.repeat(399) + '…');
    expect(lines[4]).toBe('   — ' + 'n'.repeat(799) + '…');
  });

  it('sends the redacted text when SecretDetector finds a secret', async () => {
    const h = makeApp();
    withNotes(h, [{ excerpt: 'sk-live-123', note: 'is this a key?' }]);
    h.secretDetector.enabled = true;
    h.secretDetector.result = { count: 2, redacted: 'REDACTED MESSAGE' };

    await h.app.filesSendNotes();

    expect(h.sent[0].text).toBe('REDACTED MESSAGE\r');
    expect(h.toasts[0]).toEqual({ msg: '2 secrets redacted before sending', kind: 'warning' });
  });

  it('shows the optimistic bubble only when the transcript is on the same session', async () => {
    const h = makeApp();
    withNotes(h, [{ excerpt: 'a', note: 'b' }]);
    await h.app.filesSendNotes();
    expect(h.transcript.optimistic).toHaveLength(1);
    expect(h.transcript.working).toEqual([true]);

    const other = makeApp();
    other.transcript._sessionId = 'sess-other';
    withNotes(other, [{ excerpt: 'a', note: 'b' }]);
    await other.app.filesSendNotes();
    expect(other.transcript.optimistic).toHaveLength(0);
    expect(other.transcript.working).toEqual([]);
  });

  it('clears the notes, the storage and the highlights once the send resolves', async () => {
    const h = makeApp();
    document.body.innerHTML =
      '<div id="filesSheetViewContent"><div class="files-md-preview"><p>the quick brown fox</p></div></div>';
    withNotes(h, [{ excerpt: 'the quick brown fox', note: 'too clichéd' }]);
    const preview = h.app._filesPreviewEl();
    h.app._filesHighlightExcerpt(preview, h.app._filesNotesFor('docs/story.md')[0]);
    expect(document.querySelectorAll('mark.files-md-note')).toHaveLength(1);

    await h.app.filesSendNotes();

    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(0);
    expect(stored('sess-a')['docs/story.md']).toEqual([]);
    expect(document.querySelectorAll('mark.files-md-note')).toHaveLength(0);
    expect(h.app._filesNotesOpen).toBe(false);
    expect(h.toasts.at(-1)).toEqual({ msg: 'Notes sent', kind: 'success' });
  });

  it('keeps the notes and rolls the busy state back when the send throws', async () => {
    const h = makeApp();
    withNotes(h, [{ excerpt: 'a', note: 'b' }]);
    h.app.sendInput = vi.fn(async () => {
      throw new Error('tmux is gone');
    });

    await h.app.filesSendNotes();

    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(1);
    expect(stored('sess-a')['docs/story.md']).toHaveLength(1);
    expect(h.transcript.working).toEqual([true, false]);
    expect(h.tabStatus).toEqual([
      { sid: 'sess-a', status: 'busy' },
      { sid: 'sess-a', status: 'idle' },
    ]);
    expect(h.toasts.at(-1)).toEqual({ msg: 'Failed to send notes: tmux is gone', kind: 'error' });
  });
});

// ─── Single-flight + busy state (Bug 2) ─────────────────────────────────────

describe('filesSendNotes() single-flight and busy state', () => {
  /** A send that stays in flight until the test resolves/rejects it. */
  function deferSend(h: Harness) {
    let settle!: { resolve: () => void; reject: (e: unknown) => void };
    const promise = new Promise<void>((resolve, reject) => {
      settle = { resolve: () => resolve(), reject };
    });
    const sendInput = vi.fn((text: string, sid: string) => {
      h.sent.push({ text, sid });
      return promise;
    });
    h.app.sendInput = sendInput;
    return { ...settle, sendInput, promise };
  }

  /** Files-sheet DOM so the real _filesRenderNotesPanel() has somewhere to render. */
  function setSheet() {
    document.body.innerHTML = `
      <div id="filesSheet" class="open">
        <div id="filesSheetView">
          <div id="filesSheetViewContent">
            <div class="files-md-preview"><p>some passage</p></div>
          </div>
        </div>
      </div>`;
  }

  function sendBtn(): HTMLButtonElement | null {
    return document.querySelector('#filesNotesPanel .files-notes-foot .is-active');
  }

  function openPanel(h: Harness) {
    setSheet();
    h.app._filesNotesOpen = true;
    h.app._filesRenderNotesPanel();
  }

  it('delivers the notes ONCE however many times Send is re-tapped in flight', async () => {
    // The reported bug: sendInput() takes seconds on the mux path and the notes
    // array — the only thing making a second call a no-op — is cleared last.
    const h = makeApp();
    addNote(h, 'tighten this');
    const send = deferSend(h);

    const first = h.app.filesSendNotes();
    const second = h.app.filesSendNotes();
    const third = h.app.filesSendNotes();

    expect(send.sendInput).toHaveBeenCalledTimes(1);
    expect(h.transcript.optimistic).toHaveLength(1);
    expect(h.transcript.working).toEqual([true]);
    expect(h.tabStatus).toEqual([{ sid: 'sess-a', status: 'busy' }]);

    send.resolve();
    await Promise.all([first, second, third]);
    expect(send.sendInput).toHaveBeenCalledTimes(1);
  });

  it('renders the Send button disabled and labelled “Sending…” while in flight', async () => {
    const h = makeApp();
    addNote(h, 'tighten this');
    openPanel(h);
    expect(sendBtn()!.disabled).toBe(false);
    expect(sendBtn()!.textContent).toBe('Send notes');

    const send = deferSend(h);
    const done = h.app.filesSendNotes();

    const btn = sendBtn()!;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.classList.contains('is-busy')).toBe(true);
    expect(btn.textContent).toContain('Sending…');
    expect(btn.querySelector('.files-tool-spinner')).not.toBeNull();

    send.resolve();
    await done;
    // Success collapses the panel, so there is no button left to re-enable.
    expect(h.app._filesNotesOpen).toBe(false);
    expect(document.getElementById('filesNotesPanel')).toBeNull();
  });

  it('does not let a concurrent notes refresh resurrect an enabled button', async () => {
    // _filesRenderNotesPanel() rebuilds the footer innerHTML wholesale, so any
    // Edit/Delete/Clear/TTS refresh mid-send would undo a poked-on disabled.
    const h = makeApp();
    addNote(h, 'tighten this');
    openPanel(h);
    const send = deferSend(h);
    const done = h.app.filesSendNotes();

    h.app._filesRefreshNotesUi();

    expect(sendBtn()!.disabled).toBe(true);
    expect(sendBtn()!.textContent).toContain('Sending…');

    send.resolve();
    await done;
  });

  it('re-enables the button and keeps the notes when the send rejects', async () => {
    const h = makeApp();
    addNote(h, 'tighten this');
    openPanel(h);
    const send = deferSend(h);
    const done = h.app.filesSendNotes();
    expect(sendBtn()!.disabled).toBe(true);

    send.reject(new Error('tmux is gone'));
    await done;

    expect(h.app._filesSendingNotes).toBe(false);
    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(1);
    expect(h.tabStatus.at(-1)).toEqual({ sid: 'sess-a', status: 'idle' });
    expect(h.transcript.working).toEqual([true, false]);
    expect(h.toasts.at(-1)).toEqual({ msg: 'Failed to send notes: tmux is gone', kind: 'error' });

    const btn = sendBtn()!;
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBeNull();
    expect(btn.textContent).toBe('Send notes');
  });

  it('reports a non-Error rejection instead of throwing inside the rollback', async () => {
    const h = makeApp();
    addNote(h, 'tighten this');
    h.app.sendInput = vi.fn(async () => {
      throw 'socket closed'; // eslint-disable-line no-throw-literal
    });

    await h.app.filesSendNotes();

    expect(h.toasts.at(-1)).toEqual({ msg: 'Failed to send notes: socket closed', kind: 'error' });
    // The rollback still ran — a throw inside the catch would have skipped it.
    expect(h.tabStatus.at(-1)).toEqual({ sid: 'sess-a', status: 'idle' });
    expect(h.app._filesNotesFor('docs/story.md')).toHaveLength(1);
  });

  it('clears the in-flight flag after a resolved send', async () => {
    const h = makeApp();
    addNote(h, 'tighten this');
    await h.app.filesSendNotes();
    expect(h.app._filesSendingNotes).toBe(false);

    // …and a later send still goes through.
    addNote(h, 'and this');
    await h.app.filesSendNotes();
    expect(h.sent).toHaveLength(2);
  });

  it('never raises the flag on an early return, so the next send still works', async () => {
    // Latching here would wedge Send permanently — the class of bug that the
    // terminal render latches were.
    const h = makeApp();
    await h.app.filesSendNotes(); // no notes
    expect(h.app._filesSendingNotes).toBeFalsy();

    h.app.activeSessionId = null;
    addNote(h, 'tighten this');
    await h.app.filesSendNotes(); // no session
    expect(h.app._filesSendingNotes).toBeFalsy();

    h.app.activeSessionId = 'sess-a';
    for (let i = 0; i < 40; i++) addNote(h, 'x'.repeat(800), 'y'.repeat(400) + ' ' + i);
    await h.app.filesSendNotes(); // message too long
    expect(h.app._filesSendingNotes).toBeFalsy();
    expect(h.sent).toHaveLength(0);

    h.app.filesState.current = { path: 'docs/short.md' };
    addNote(h, 'now it fits');
    await h.app.filesSendNotes();
    expect(h.sent).toHaveLength(1);
  });
});

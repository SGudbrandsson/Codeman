// @vitest-environment jsdom

/**
 * @fileoverview Unit tests for files-sheet state persistence (sessionStorage)
 * and the session-switch handling around it, in src/web/public/app.js ~21015.
 *
 * The REAL method bodies (and, for selectSession, the real prologue statements)
 * are extracted from the shipped app.js text and re-compiled, so the
 * secrets-safety invariant — file CONTENT is never persisted — is asserted
 * against the code that ships rather than a copy of it.
 *
 * Out of scope: the double-rAF scroll restore landing on a laid-out document
 * (jsdom has no layout) — only the rAF chain and the final assignment are
 * asserted.
 *
 * Run: npx vitest run test/files-sheet-persistence.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import indexHtmlSource from '../src/web/public/index.html?raw';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import stylesSource from '../src/web/public/styles.css?raw';

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
  '_filesSheetKey',
  '_filesPersistState',
  '_filesPersistClosed',
  '_filesReadState',
  '_filesRestoreScroll',
  '_filesRestoreState',
];

function makeApp(overrides: Record<string, unknown> = {}) {
  const body = METHODS.map(methodSource).join(',\n');
  const app = Object.assign(new Function(`return ({\n${body}\n});`)(), {
    activeSessionId: 'sess-a',
    filesState: {
      current: { path: 'docs/story.md', content: 'SECRET FILE BODY', editing: false },
      expanded: new Set(['docs']),
      activeDir: 'docs',
    },
    $: (id: string) => document.getElementById(id),
    openFileInEditor: vi.fn(async () => {}),
    openFilesSheet: vi.fn(),
    ...overrides,
  }) as any;
  return app;
}

function mountSheet({ open = true, scrollTop = 0 } = {}) {
  document.body.innerHTML = `
    <div id="filesSheet" class="${open ? 'open' : ''}"></div>
    <div id="filesSheetViewContent"></div>`;
  const content = document.getElementById('filesSheetViewContent')!;
  Object.defineProperty(content, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  return content;
}

function stored(sid = 'sess-a') {
  return sessionStorage.getItem('codeman-files-sheet:' + sid);
}

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = '';
});

// ─── _filesPersistState() ───────────────────────────────────────────────────

describe('_filesPersistState()', () => {
  it('stores only the view coordinates, never the file content', () => {
    const app = makeApp();
    mountSheet({ scrollTop: 1234 });

    app._filesPersistState();

    const raw = stored()!;
    expect(raw).not.toContain('SECRET FILE BODY');
    expect(JSON.parse(raw)).toEqual({
      open: true,
      path: 'docs/story.md',
      mode: 'preview',
      scrollTop: 1234,
      expanded: ['docs'],
      activeDir: 'docs',
    });
  });

  it('records mode "preview" even when the file is being edited', () => {
    const app = makeApp();
    app.filesState.current.editing = true;
    mountSheet();

    app._filesPersistState();

    expect(JSON.parse(stored()!).mode).toBe('preview');
  });

  it('records a null path when the sheet is showing the tree', () => {
    const app = makeApp();
    app.filesState.current = null;
    mountSheet();

    app._filesPersistState();

    expect(JSON.parse(stored()!)).toMatchObject({ open: true, path: null });
  });

  it('removes the key when the sheet is closed', () => {
    const app = makeApp();
    mountSheet();
    app._filesPersistState();
    expect(stored()).not.toBeNull();

    document.getElementById('filesSheet')!.classList.remove('open');
    app._filesPersistState();

    expect(stored()).toBeNull();
  });

  it('scopes the key to the active session', () => {
    const app = makeApp();
    mountSheet();
    app._filesPersistState();
    app.activeSessionId = 'sess-b';
    app._filesPersistState();

    expect(stored('sess-a')).not.toBeNull();
    expect(stored('sess-b')).not.toBeNull();
    expect(app._filesSheetKey()).toBe('codeman-files-sheet:sess-b');
  });

  it('does nothing without an active session', () => {
    const app = makeApp({ activeSessionId: null });
    mountSheet();
    app._filesPersistState();
    expect(sessionStorage.length).toBe(0);
  });
});

// ─── _filesReadState() / _filesRestoreState() ───────────────────────────────

describe('_filesRestoreState()', () => {
  function save(payload: unknown, sid = 'sess-a') {
    sessionStorage.setItem('codeman-files-sheet:' + sid, JSON.stringify(payload));
  }

  it('reopens the persisted file in the editor at its scroll offset', async () => {
    const app = makeApp();
    save({
      open: true,
      path: 'docs/story.md',
      mode: 'preview',
      scrollTop: 900,
      expanded: ['docs', 'src'],
      activeDir: 'src',
    });

    await app._filesRestoreState();

    expect(app.openFileInEditor).toHaveBeenCalledWith('docs/story.md', { scrollTop: 900 });
    expect(app.openFilesSheet).not.toHaveBeenCalled();
    expect(Array.from(app.filesState.expanded)).toEqual(['docs', 'src']);
    expect(app.filesState.activeDir).toBe('src');
  });

  it('reopens just the tree when no file was open', async () => {
    const app = makeApp();
    save({ open: true, path: null, mode: 'preview', scrollTop: 0, expanded: [], activeDir: '' });

    await app._filesRestoreState();

    expect(app.openFilesSheet).toHaveBeenCalledTimes(1);
    expect(app.openFileInEditor).not.toHaveBeenCalled();
  });

  it('does nothing when the sheet was closed or nothing was stored', async () => {
    const app = makeApp();
    await app._filesRestoreState();
    save({ open: false, path: 'docs/story.md' });
    await app._filesRestoreState();

    expect(app.openFilesSheet).not.toHaveBeenCalled();
    expect(app.openFileInEditor).not.toHaveBeenCalled();
  });

  it('never restores into Edit mode', () => {
    // Unsaved content is deliberately not persisted, so re-entering the editor
    // would silently drop the user's buffer.
    expect(methodSource('_filesRestoreState')).not.toContain('filesStartEdit');
    expect(methodSource('_filesPersistState')).toContain("mode: 'preview'");
  });

  it('reads back nothing from corrupt storage instead of throwing', () => {
    const app = makeApp();
    sessionStorage.setItem('codeman-files-sheet:sess-a', '{ not json');
    expect(app._filesReadState()).toBeNull();
  });
});

// ─── Safari private mode (every sessionStorage access throws) ───────────────

describe('sessionStorage failures', () => {
  let original: Storage;

  beforeEach(() => {
    original = window.sessionStorage;
    const throwing = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
      removeItem() {
        throw new Error('SecurityError');
      },
    };
    Object.defineProperty(window, 'sessionStorage', { value: throwing, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, 'sessionStorage', { value: original, configurable: true });
  });

  it('does not propagate out of persist, read, close or restore', async () => {
    const app = makeApp();
    mountSheet();
    expect(() => app._filesPersistState()).not.toThrow();
    expect(() => app._filesPersistClosed()).not.toThrow();
    expect(app._filesReadState()).toBeNull();
    await expect(app._filesRestoreState()).resolves.toBeUndefined();
  });
});

// ─── _filesRestoreScroll() ──────────────────────────────────────────────────

describe('_filesRestoreScroll()', () => {
  it('assigns scrollTop only after two animation frames', () => {
    const app = makeApp();
    const content = mountSheet({ scrollTop: 0 });
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });

    app._filesRestoreScroll(640);
    expect(content.scrollTop).toBe(0);
    frames.shift()!();
    expect(content.scrollTop).toBe(0);
    frames.shift()!();
    expect(content.scrollTop).toBe(640);

    vi.unstubAllGlobals();
  });

  it('does nothing for a zero offset', () => {
    const app = makeApp();
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    app._filesRestoreScroll(0);
    expect(raf).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ─── selectSession() prologue (real source, extracted) ──────────────────────

describe('selectSession() files-sheet handling', () => {
  /** The real notes-invalidation + files-sheet prologue from selectSession(). */
  function prologue() {
    const from = APP_JS_SOURCE.indexOf('if (this.filesState) { this.filesState.notes = null;');
    expect(from, 'selectSession prologue not found').toBeGreaterThan(-1);
    const marker = "OverlayHistory.pop('files-sheet');\n    }";
    const to = APP_JS_SOURCE.indexOf(marker, from);
    expect(to, 'preserveFilesSheet block not found').toBeGreaterThan(from);
    return APP_JS_SOURCE.slice(from, to + marker.length);
  }

  function run(opts: Record<string, unknown>, stackHas: string[]) {
    const stack = [...stackHas];
    const OverlayHistory = {
      has: (id: string) => stack.includes(id),
      pop: vi.fn((id: string) => {
        const i = stack.indexOf(id);
        if (i > -1) stack.splice(i, 1);
      }),
    };
    const FilesTTS = { stop: vi.fn() };
    const app: any = {
      filesState: { notes: { 'docs/story.md': [{ id: 'n1' }] }, notesSessionId: 'sess-a' },
      _doCloseFilesSheet: vi.fn(),
    };
    new Function('FilesTTS', 'OverlayHistory', 'opts', prologue()).call(app, FilesTTS, OverlayHistory, opts);
    return { app, OverlayHistory, FilesTTS, stack };
  }

  it('keeps the sheet and its history entries on a same-session restore', () => {
    const { app, OverlayHistory, FilesTTS, stack } = run({ preserveFilesSheet: true }, ['files-sheet', 'files-file']);
    expect(app._doCloseFilesSheet).not.toHaveBeenCalled();
    expect(OverlayHistory.pop).not.toHaveBeenCalled();
    expect(FilesTTS.stop).not.toHaveBeenCalled();
    expect(stack).toEqual(['files-sheet', 'files-file']);
  });

  it('closes the sheet, stops speech and consumes both history entries on a real switch', () => {
    const { app, OverlayHistory, FilesTTS, stack } = run({}, ['files-sheet', 'files-file']);
    expect(app._doCloseFilesSheet).toHaveBeenCalledTimes(1);
    expect(FilesTTS.stop).toHaveBeenCalledTimes(1);
    expect(OverlayHistory.pop.mock.calls.map((c: any[]) => c[0])).toEqual(['files-file', 'files-sheet']);
    expect(stack).toEqual([]);
  });

  it('invalidates the notes cache on both paths', () => {
    for (const opts of [{ preserveFilesSheet: true }, {}]) {
      const { app } = run(opts, ['files-sheet']);
      expect(app.filesState.notes).toBeNull();
      expect(app.filesState.notesSessionId).toBeNull();
    }
  });
});

// ─── Source guards ──────────────────────────────────────────────────────────

describe('src/web/public — source guards', () => {
  it('restores the sheet at most once per page load', () => {
    // A live SSE reconnect re-enters handleInit(); re-running the restore there
    // would fight the preserveFilesSheet path and reopen a sheet the user closed.
    expect(APP_JS_SOURCE).toContain('if (!this._filesRestoreAttempted) {');
    expect(APP_JS_SOURCE).toContain('this._filesRestoreAttempted = true;');
  });

  it('has retired the old read-only file preview modal', () => {
    for (const [name, text] of [
      ['app.js', APP_JS_SOURCE],
      ['index.html', indexHtmlSource as string],
      ['styles.css', stylesSource as string],
    ] as const) {
      for (const symbol of [
        'openFilePreview',
        'closeFilePreview',
        'filePreviewOverlay',
        'filePreviewContent',
        'filePreviewBody',
        'filePreviewTitle',
        'filePreviewFooter',
        'file-preview',
      ]) {
        expect(text, `${name} still references ${symbol}`).not.toContain(symbol);
      }
    }
  });

  it('routes every file-open call site through openFileInEditor', () => {
    // Transcript file link (click + keyboard), desktop file-browser row, and
    // the sessionStorage restore — the four entry points the old modal owned.
    const clickHandler = APP_JS_SOURCE.match(
      /el\.addEventListener\('click', function \(\) \{\s*app\.openFileInEditor\(path\);/
    );
    expect(clickHandler, 'transcript file link must open the editor').not.toBeNull();
    expect(APP_JS_SOURCE).toContain(
      "if (e.key === 'Enter' || e.key === ' ') {\n            e.preventDefault();\n            app.openFileInEditor(path);"
    );
    expect(APP_JS_SOURCE).toContain(
      "FeatureTracker.track('file-browser-file-click');\n          this.openFileInEditor(path);"
    );
    expect(APP_JS_SOURCE).toContain(
      'if (saved.path) await this.openFileInEditor(saved.path, { scrollTop: saved.scrollTop });'
    );
  });
});

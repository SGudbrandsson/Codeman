/**
 * @fileoverview Tests for the xterm terminal file-link provider in src/web/public/app.js.
 *
 * Covers:
 * - _terminalLogicalLine(): joins soft-wrapped buffer rows (1-based y) and maps every
 *   UTF-16 unit back to its buffer cell, skipping the width-0 half of wide chars.
 * - extractTerminalFileLinkCandidates(): finds file references (relative, absolute,
 *   :line[:col], file://) in a line of terminal text; URLs and plain words are ignored.
 * - _terminalLinkPath(): maps a reference to the working-dir-relative path the
 *   sandboxed file endpoints accept (outside-wd absolute paths -> null).
 * - registerFilePathLinkProvider(): the provider xterm calls on hover — existence
 *   checks (cached, negatives retried after 30s), 1-based inclusive ranges, session
 *   switch guards, and activate() opening the file editor (never the log viewer).
 * - openFileInEditor() / _filesScrollToLine(): the :line jump.
 *
 * Like test/markdown-file-link-target.test.ts, this runs the REAL code: app.js is
 * imported as text and the functions/methods are extracted and compiled, so the
 * tests cannot drift from the shipped source. Fake buffers mirror the xterm 6
 * IBuffer / IBufferLine / IBufferCell API the provider uses.
 *
 * Run: npx vitest run test/terminal-file-link-provider.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error — ?raw is a Vite loader suffix, not typed by tsc.
import appSource from '../src/web/public/app.js?raw';

const APP_JS_SOURCE = appSource as string;

// ─── Real-source extraction ─────────────────────────────────────────────────

/** Source text of a top-level `function name(...) { ... }` in app.js. */
function functionSource(name: string): string {
  const start = APP_JS_SOURCE.indexOf(`\nfunction ${name}(`);
  expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
  const end = APP_JS_SOURCE.indexOf('\n}', start + 1);
  expect(end, `${name}() has no column-0 closing brace`).toBeGreaterThan(start);
  return APP_JS_SOURCE.slice(start + 1, end + 2);
}

/** Source text of a class method in app.js, including its signature line. */
function methodSource(name: string): string {
  let start = APP_JS_SOURCE.indexOf(`\n  ${name}(`);
  if (start === -1) start = APP_JS_SOURCE.indexOf(`\n  async ${name}(`);
  expect(start, `${name}() not found in app.js`).toBeGreaterThan(-1);
  const lines = APP_JS_SOURCE.slice(start + 1).split('\n');
  const end = lines.findIndex((l, i) => i > 0 && l === '  }');
  expect(end, `${name}() has no 2-space closing brace`).toBeGreaterThan(0);
  return lines.slice(0, end + 1).join('\n');
}

/** The `var _FILE_PATH_*` constants looksLikePath() depends on. */
function filePathConstantsSource(): string {
  const start = APP_JS_SOURCE.indexOf('var _FILE_PATH_EXTENSIONS =');
  const last = APP_JS_SOURCE.indexOf('var _FILE_PATH_BARE_RE', start);
  expect(start, '_FILE_PATH_EXTENSIONS not found in app.js').toBeGreaterThan(-1);
  expect(last, '_FILE_PATH_BARE_RE not found in app.js').toBeGreaterThan(start);
  return APP_JS_SOURCE.slice(start, APP_JS_SOURCE.indexOf('\n', last));
}

type Cell = { row0: number; x0: number; width: number };
type LogicalLine = { text: string; cells: Cell[] } | null;
type Candidate = { start: number; end: number; path: string; line: number | null; col: number | null };

/**
 * Compiles the helpers plus the named class methods. `fetch`, `console` and the
 * other browser globals are parameters, so each build gets its own stubs and a
 * fresh `_filePathExistsCache`.
 */
function build(methods: string[] = [], globals: Record<string, unknown> = {}) {
  const names = ['fetch', 'console', 'requestAnimationFrame', 'getComputedStyle', 'FeatureTracker', 'confirm'];
  const body = [
    filePathConstantsSource(),
    'var _filePathExistsCache = new Map();',
    functionSource('looksLikePath'),
    functionSource('parseMarkdownFileLinkTarget'),
    functionSource('_checkFilePathExists'),
    functionSource('_terminalLogicalLine'),
    functionSource('extractTerminalFileLinkCandidates'),
    functionSource('_terminalLinkPath'),
    `return { _terminalLogicalLine, extractTerminalFileLinkCandidates, _terminalLinkPath, methods: ({\n${methods
      .map(methodSource)
      .join(',\n')}\n}) };`,
  ].join('\n');
  return new Function(...names, body)(...names.map((n) => globals[n])) as {
    _terminalLogicalLine: (buffer: unknown, y1: number, cols: number) => LogicalLine;
    extractTerminalFileLinkCandidates: (text: string) => Candidate[];
    _terminalLinkPath: (path: string, workingDir: string) => string | null;
    methods: Record<string, (...args: any[]) => any>;
  };
}

const helpers = build();

// ─── Fake xterm 6 buffer ────────────────────────────────────────────────────

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]|\p{Extended_Pictographic}/u;

type RowSpec = { text: string; wrapped?: boolean };

/** One IBufferLine: wide chars take two cells (the second is width 0, chars ''). */
function fakeLine(spec: RowSpec, cols: number) {
  const cells: Array<{ chars: string; width: number }> = [];
  for (const ch of Array.from(spec.text)) {
    if (WIDE.test(ch)) cells.push({ chars: ch, width: 2 }, { chars: '', width: 0 });
    else cells.push({ chars: ch, width: 1 });
  }
  while (cells.length < cols) cells.push({ chars: '', width: 1 });
  return {
    isWrapped: !!spec.wrapped,
    length: cols,
    getCell(x: number) {
      const c = cells[x];
      return c && { getChars: () => c.chars, getWidth: () => c.width };
    },
  };
}

/** An IBuffer (0-based getLine) over the given rows. */
function fakeBuffer(rows: RowSpec[], cols: number) {
  const lines = rows.map((r) => fakeLine(r, cols));
  return {
    getLine: (y: number) => lines[y],
    getNullCell: () => ({}),
  };
}

// ─── _terminalLogicalLine ───────────────────────────────────────────────────

describe('_terminalLogicalLine', () => {
  it('treats y as 1-based (xterm provideLinks passes 1-based rows)', () => {
    const buffer = fakeBuffer([{ text: '$ npm test' }, { text: 'src/foo.tsx:12' }], 20);
    const logical = helpers._terminalLogicalLine(buffer, 2, 20)!;
    expect(logical.text.trimEnd()).toBe('src/foo.tsx:12');
    expect(logical.cells[0]).toEqual({ row0: 1, x0: 0, width: 1 });
  });

  it('joins soft-wrapped rows identically whether hovered on the first or second row', () => {
    const buffer = fakeBuffer(
      [{ text: 'Edited src/web/publ' }, { text: 'ic/app.js:7044', wrapped: true }, { text: 'next' }],
      19
    );
    const fromFirst = helpers._terminalLogicalLine(buffer, 1, 19)!;
    const fromSecond = helpers._terminalLogicalLine(buffer, 2, 19)!;
    expect(fromFirst.text).toBe('Edited src/web/public/app.js:7044     ');
    expect(fromSecond).toEqual(fromFirst);
    expect(fromFirst.cells[18]).toEqual({ row0: 0, x0: 18, width: 1 });
    expect(fromFirst.cells[19]).toEqual({ row0: 1, x0: 0, width: 1 });
  });

  it('skips width-0 cells so wide chars map to their first cell with width 2', () => {
    const buffer = fakeBuffer([{ text: '日本 a.ts' }], 12);
    const { text, cells } = helpers._terminalLogicalLine(buffer, 1, 12)!;
    expect(text.slice(0, 7)).toBe('日本 a.ts');
    expect(cells.slice(0, 4)).toEqual([
      { row0: 0, x0: 0, width: 2 },
      { row0: 0, x0: 2, width: 2 },
      { row0: 0, x0: 4, width: 1 },
      { row0: 0, x0: 5, width: 1 },
    ]);
  });

  it('gives each UTF-16 unit of a surrogate-pair emoji its own cells entry', () => {
    const buffer = fakeBuffer([{ text: '😀 a.ts' }], 8);
    const { text, cells } = helpers._terminalLogicalLine(buffer, 1, 8)!;
    expect(text.indexOf('a.ts')).toBe(3);
    expect(cells[0]).toEqual({ row0: 0, x0: 0, width: 2 });
    expect(cells[1]).toEqual({ row0: 0, x0: 0, width: 2 });
    expect(cells[3]).toEqual({ row0: 0, x0: 3, width: 1 });
  });

  it('renders empty cells as spaces', () => {
    const { text } = helpers._terminalLogicalLine(fakeBuffer([{ text: 'ab' }], 4), 1, 4)!;
    expect(text).toBe('ab  ');
  });

  it('returns null for a row that does not exist', () => {
    expect(helpers._terminalLogicalLine(fakeBuffer([{ text: 'x' }], 4), 5, 4)).toBeNull();
  });

  it('caps a long wrapped line at 8 rows, walking up at most 7 rows from the hovered one', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ text: String(i).repeat(4), wrapped: i > 0 }));
    const buffer = fakeBuffer(rows, 4);
    const fromTop = helpers._terminalLogicalLine(buffer, 1, 4)!;
    expect(fromTop.text).toBe('00001111222233334444555566667777');
    const fromBottom = helpers._terminalLogicalLine(buffer, 10, 4)!;
    expect(fromBottom.cells[0].row0).toBe(2);
    expect(fromBottom.text).toBe('22223333444455556666777788889999');
  });
});

// ─── extractTerminalFileLinkCandidates ──────────────────────────────────────

describe('extractTerminalFileLinkCandidates', () => {
  const extract = helpers.extractTerminalFileLinkCandidates;

  it('finds relative and absolute references with :line and :line:col, end exclusive over the suffix', () => {
    const text = 'Edited src/web/public/app.js:7044 and /home/siggi/sources/Codeman/src/session.ts:1538:5';
    expect(extract(text)).toEqual([
      { start: 7, end: 33, path: 'src/web/public/app.js', line: 7044, col: null },
      { start: 38, end: text.length, path: '/home/siggi/sources/Codeman/src/session.ts', line: 1538, col: 5 },
    ]);
    expect(text.slice(7, 33)).toBe('src/web/public/app.js:7044');
  });

  it('does not truncate .tsx to .ts', () => {
    expect(extract('  src/components/Button.tsx:12')).toEqual([
      { start: 2, end: 30, path: 'src/components/Button.tsx', line: 12, col: null },
    ]);
  });

  it('accepts references without a line suffix', () => {
    expect(extract('Bash(cat src/web/public/app.js)')).toEqual([
      { start: 9, end: 30, path: 'src/web/public/app.js', line: null, col: null },
    ]);
  });

  it('strips trailing sentence punctuation and a dangling colon', () => {
    expect(extract('Updated README.md.')).toEqual([{ start: 8, end: 17, path: 'README.md', line: null, col: null }]);
    expect(extract('src/session.ts:12: error TS2322')).toEqual([
      { start: 0, end: 17, path: 'src/session.ts', line: 12, col: null },
    ]);
  });

  it('splits tokens on parens, so a stack frame links just the path', () => {
    const text = '    at run (/home/siggi/sources/Codeman/src/index.ts:10:5)';
    const [c] = extract(text);
    expect(c).toEqual({
      start: 12,
      end: text.length - 1,
      path: '/home/siggi/sources/Codeman/src/index.ts',
      line: 10,
      col: 5,
    });
  });

  it('skips http(s) URLs entirely (no partial path link)', () => {
    expect(extract('Open https://github.com/org/repo/blob/main/src/a.ts and http://localhost:3001/app.js')).toEqual([]);
  });

  it('accepts file:// references', () => {
    expect(extract('see file:///home/siggi/x.ts:4')).toEqual([
      { start: 4, end: 29, path: '/home/siggi/x.ts', line: 4, col: null },
    ]);
  });

  it('returns [] for plain prose and for text with no / or .', () => {
    expect(extract('Done. Tests pass.')).toEqual([]);
    expect(extract('Thinking about the next step')).toEqual([]);
    expect(extract('')).toEqual([]);
  });

  it('caps the result at 20 candidates per line', () => {
    const text = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`).join(' ');
    expect(extract(text)).toHaveLength(20);
  });
});

// ─── _terminalLinkPath ──────────────────────────────────────────────────────

describe('_terminalLinkPath', () => {
  const wd = '/home/siggi/sources/Codeman';

  it.each<[string, string, string | null]>([
    ['/home/siggi/sources/Codeman/src/session.ts', wd, 'src/session.ts'],
    ['/home/siggi/sources/Codeman-fix/src/session.ts', wd, null],
    ['/tmp/codeman-3451.log', wd, null],
    ['src/foo.tsx', wd, 'src/foo.tsx'],
    ['./src/foo.tsx', wd, 'src/foo.tsx'],
    ['././src/foo.tsx', wd, 'src/foo.tsx'],
    ['/home/siggi/sources/Codeman/', wd, null],
    ['', wd, null],
    ['src/foo.tsx', '', null],
  ])('%j in %j -> %j', (path, workingDir, expected) => {
    expect(helpers._terminalLinkPath(path, workingDir)).toBe(expected);
  });
});

// ─── registerFilePathLinkProvider ───────────────────────────────────────────

const WD = '/home/siggi/sources/Codeman';

type Link = {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  decorations: { pointerCursor: boolean; underline: boolean };
  activate: (event?: unknown, text?: string) => void;
};

/** A fake app whose terminal captures the registered provider. `existing` are wd-relative paths. */
function setupProvider(rows: RowSpec[], cols: number, existing: string[], opts: { fetch?: any } = {}) {
  const files = new Set(existing);
  const fetch =
    opts.fetch ??
    vi.fn(async (url: string) => {
      const path = new URL(url, 'http://localhost').searchParams.get('path')!;
      const ok = files.has(path);
      return { ok, json: async () => ({ success: ok }) };
    });
  const { methods } = build(['registerFilePathLinkProvider'], { fetch, console: { log() {} } });
  let provider: { provideLinks: (y: number, cb: (links: Link[] | undefined) => void) => void } | undefined;
  const app = {
    terminal: {
      cols,
      buffer: { active: fakeBuffer(rows, cols) },
      registerLinkProvider: (p: typeof provider) => {
        provider = p;
      },
    },
    sessions: new Map<string, { workingDir?: string }>([
      ['s1', { workingDir: WD + '/' }],
      ['s2', { workingDir: '/home/siggi/other' }],
    ]),
    activeSessionId: 's1',
    openFileInEditor: vi.fn(),
    openLogViewerWindow: vi.fn(),
  };
  methods.registerFilePathLinkProvider.call(app);
  const links = (y: number) => new Promise<Link[] | undefined>((resolve) => provider!.provideLinks(y, resolve));
  return { app, fetch, files, links };
}

describe('registerFilePathLinkProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('links only existing paths, with a 1-based start and inclusive end on the hovered row', async () => {
    const { links } = setupProvider(
      [{ text: '$ claude' }, { text: 'Edited src/web/public/app.js:7044 and src/missing.ts:3' }],
      80,
      ['src/web/public/app.js']
    );
    const result = await links(2);
    expect(result).toHaveLength(1);
    expect(result![0].text).toBe('src/web/public/app.js:7044');
    expect(result![0].range).toEqual({ start: { x: 8, y: 2 }, end: { x: 33, y: 2 } });
    expect(result![0].decorations).toEqual({ pointerCursor: true, underline: true });
  });

  it('returns one multi-row link for a wrapped path from either row, covering a wide final char', async () => {
    const rows = [{ text: 'Wrote /home/siggi/sources/Codeman/docs/' }, { text: '計画', wrapped: true }];
    const { links, fetch } = setupProvider(rows, 39, ['docs/計画']);
    const expected = { start: { x: 7, y: 1 }, end: { x: 4, y: 2 } };
    const fromFirst = await links(1);
    const fromSecond = await links(2);
    expect(fromFirst!.map((l) => l.range)).toEqual([expected]);
    expect(fromSecond!.map((l) => l.range)).toEqual([expected]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('checks existence with the working-dir-relative path through the file-content endpoint', async () => {
    const { links, fetch } = setupProvider([{ text: `  ${WD}/src/session.ts:1538:5` }], 80, ['src/session.ts']);
    expect(await links(1)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/s1/file-content?path=src%2Fsession.ts&lines=1');
  });

  it('makes no request for absolute paths outside the working dir or URLs', async () => {
    const { links, fetch } = setupProvider(
      [{ text: 'tail -f /tmp/codeman-3451.log https://example.com/a.ts' }],
      80,
      []
    );
    expect(await links(1)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shares one cached request across repeated hovers', async () => {
    const { links, fetch } = setupProvider([{ text: 'src/foo.tsx:12' }], 40, ['src/foo.tsx']);
    await links(1);
    await links(1);
    await links(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('re-checks a missing path only after 30s, so a file created later becomes linkable', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { links, fetch, files } = setupProvider([{ text: 'src/new-file.ts:1' }], 40, []);
    expect(await links(1)).toBeUndefined();
    now += 10_000;
    expect(await links(1)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);

    files.add('src/new-file.ts');
    now += 21_000;
    const result = await links(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result!.map((l) => l.text)).toEqual(['src/new-file.ts:1']);
  });

  it('calls back undefined when the active session switches before the check resolves', async () => {
    let release!: () => void;
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, json: async () => ({ success: true }) });
        })
    );
    const { app, links } = setupProvider([{ text: 'src/foo.tsx:12' }], 40, [], { fetch });
    const pending = links(1);
    await Promise.resolve();
    app.activeSessionId = 's2';
    release();
    expect(await pending).toBeUndefined();
  });

  it('calls back undefined without a request when the session has no working dir', async () => {
    const { app, links, fetch } = setupProvider([{ text: 'src/foo.tsx:12' }], 40, ['src/foo.tsx']);
    app.sessions.set('s1', {});
    expect(await links(1)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('activate() opens the file editor at the line and never the log viewer', async () => {
    const { app, links } = setupProvider([{ text: `Error at ${WD}/src/session.ts:1538:5 in logs/server.log` }], 100, [
      'src/session.ts',
      'logs/server.log',
    ]);
    const [withLine, withoutLine] = (await links(1))!;
    withLine.activate({}, withLine.text);
    withoutLine.activate({}, withoutLine.text);
    expect(app.openFileInEditor.mock.calls).toEqual([
      ['src/session.ts', { line: 1538 }],
      ['logs/server.log', { line: undefined }],
    ]);
    expect(app.openLogViewerWindow).not.toHaveBeenCalled();
  });

  it('activate() does nothing after the active session switched', async () => {
    const { app, links } = setupProvider([{ text: 'src/foo.tsx:12' }], 40, ['src/foo.tsx']);
    const [link] = (await links(1))!;
    app.activeSessionId = 's2';
    link.activate({}, link.text);
    expect(app.openFileInEditor).not.toHaveBeenCalled();
  });
});

// ─── openFileInEditor :line jump ────────────────────────────────────────────

describe('openFileInEditor line jump', () => {
  function makeEditorApp() {
    const { methods } = build(['openFileInEditor'], { FeatureTracker: { track() {} } });
    return Object.assign(methods, {
      activeSessionId: 's1',
      filesState: { current: null },
      showToast: vi.fn(),
      _filesOpenSheetShell: () => true,
      filesLoadTree: vi.fn(),
      _filesEnsureVendor: vi.fn(async () => {}),
      filesOpenFile: vi.fn(async () => {}),
      _filesRestoreScroll: vi.fn(),
      _filesScrollToLine: vi.fn(),
    });
  }

  it.each<[string, Record<string, unknown>, boolean]>([
    ['line 1538', { line: 1538 }, true],
    ['line 1', { line: 1 }, false],
    ['no line', { line: undefined }, false],
    ['restored scrollTop wins', { line: 20, scrollTop: 300 }, false],
  ])('%s -> scroll to line: %j', async (_label, opts, scrolls) => {
    const app = makeEditorApp();
    await app.openFileInEditor('src/session.ts', opts);
    expect(app.filesOpenFile).toHaveBeenCalledWith('src/session.ts');
    if (scrolls) expect(app._filesScrollToLine).toHaveBeenCalledWith('src/session.ts', opts.line);
    else expect(app._filesScrollToLine).not.toHaveBeenCalled();
  });
});

describe('_filesScrollToLine', () => {
  function makeScrollApp(opts: { lineHeight?: string; current?: unknown; withCode?: boolean } = {}) {
    const code = {};
    const pre = {
      getBoundingClientRect: () => ({ top: 140 }),
      querySelector: () => (opts.withCode === false ? null : code),
    };
    const content = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 100 }),
      querySelector: () => pre,
    };
    const styles = new Map<unknown, Record<string, string>>([
      [code, { lineHeight: opts.lineHeight ?? '18.75px', fontSize: '12.5px' }],
      [pre, { paddingTop: '12px' }],
    ]);
    const { methods } = build(['_filesScrollToLine'], {
      requestAnimationFrame: (cb: () => void) => cb(),
      getComputedStyle: (el: unknown) => styles.get(el),
    });
    const app = Object.assign(methods, {
      filesState: { current: 'current' in opts ? opts.current : { path: 'src/session.ts', editing: false } },
      $: () => content,
    });
    return { app, content };
  }

  it('scrolls the code view so the line sits at the top (pre offset + padding + (line-1) * lineHeight)', () => {
    const { app, content } = makeScrollApp();
    app._filesScrollToLine('src/session.ts', 10);
    expect(content.scrollTop).toBe(40 + 12 + 9 * 18.75);
  });

  it('falls back to fontSize * 1.2 when line-height is "normal"', () => {
    const { app, content } = makeScrollApp({ lineHeight: 'normal' });
    app._filesScrollToLine('src/session.ts', 10);
    expect(content.scrollTop).toBe(40 + 12 + 9 * 15);
  });

  it.each<[string, Parameters<typeof makeScrollApp>[0]]>([
    ['another file is open', { current: { path: 'src/other.ts', editing: false } }],
    ['the file is being edited', { current: { path: 'src/session.ts', editing: true } }],
    ['the view is not a plain <pre><code>', { withCode: false }],
  ])('leaves scrollTop alone when %s', (_label, opts) => {
    const { app, content } = makeScrollApp(opts);
    app._filesScrollToLine('src/session.ts', 10);
    expect(content.scrollTop).toBe(0);
  });
});

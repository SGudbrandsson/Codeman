# Large-paste → document snippet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a large text paste in the compose box and divert it to a `.txt` file uploaded through the existing attachment pipeline, so only a short `[Attached file: /path]` reference is sent through the terminal instead of hundreds of KB of typed text.

**Architecture:** Purely additive client-side change in `src/web/public/app.js`. A new paste handler on the compose textarea detects oversized plain-text pastes, builds a `File` from the text, and feeds it into the **existing** `InputPanel._uploadNonImageFiles` → `POST /api/sessions/:id/upload` flow (which already stores the file inside the session's working directory, caps at 10 MB, renders a chip, gates the Send button, and sends it as `[Attached file: /path]`). Paste files get a distinct "📄 Pasted text" chip and a preview modal. **No server changes.**

**Tech Stack:** Vanilla browser JS (`app.js`, no module bundling), Vitest + TypeScript for tests. Reuses Fastify multipart upload endpoint already in the codebase.

## Global Constraints

- **No server-side changes.** Reuse `POST /api/sessions/:id/upload` (`src/web/routes/system-routes.ts:825-918`) exactly as-is.
- **`app.js` is an unbundled browser script with no exports.** Unit tests mirror the pure logic as standalone functions in the test file, kept intentionally in sync — the established pattern (see `test/non-image-file-upload.test.ts`, `test/compose-slash-commands.test.ts`, `test/paste-newline-routing.test.ts`).
- **Test runner:** `npm test` (`vitest run`). Per project memory, run vitest with brew Node v25 on PATH (better-sqlite3 ABI): `PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npm test`.
- **Deploy is separate from source.** Service runs from `/home/siggi/.codeman/app`. After building: `cp -r dist /home/siggi/.codeman/app/ && cp package.json /home/siggi/.codeman/app/package.json && systemctl --user restart codeman-web`.
- **Thresholds (exact):** `PASTE_SNIPPET_MAX_BYTES = 10 * 1024` (10 KB, UTF-8), `PASTE_SNIPPET_MAX_LINES = 30`. Convert when a paste exceeds **either**.
- **Only divert genuine plain-text pastes.** Empty `text/plain`, or a clipboard carrying files, must fall through to native behavior / the existing capture-phase file handler (`app.js:5516-5570`).

---

## File Structure

**Modified (only one source file):**
- `src/web/public/app.js` — all changes live in the `InputPanel` object (starts `app.js:21098`):
  - New module-level constants near `InputPanel` for thresholds.
  - New pure helpers: `_countPasteLines`, `_pasteByteLength`, `_shouldSnippetPaste`, `_makePasteFilename`, `_fmtPasteBytes`.
  - New paste event handler `_onTextPaste`, registered in `InputPanel.init()` (`app.js:21208`).
  - New `_uploadPasteSnippet` (builds the `File`, attaches metadata, calls existing upload).
  - Extend the entry-creation line in `_uploadNonImageFiles` (`app.js:21663`) to copy paste metadata.
  - Extend the `_files.forEach` chip render in `_renderThumbnails` (`app.js:21842-21874`) to branch on `file.isPaste`.
  - New `_previewPasteSnippet` (lightweight modal).

**Created (tests):**
- `test/large-paste-snippet.test.ts` — mirrors the pure detection/format helpers and asserts thresholds, line-ending normalization, empty/non-text no-op, filename and byte formatting.

---

### Task 1: Detection & formatting helpers (pure logic, TDD)

**Files:**
- Modify: `src/web/public/app.js` (add constants + pure helpers inside `InputPanel`)
- Test: `test/large-paste-snippet.test.ts`

**Interfaces:**
- Produces (mirrored/consumed by later tasks):
  - `InputPanel._countPasteLines(text: string): number` — line count after normalizing `\r\n`, `\r`, ` `, ` ` to `\n`.
  - `InputPanel._pasteByteLength(text: string): number` — UTF-8 byte length.
  - `InputPanel._shouldSnippetPaste(text: string): boolean` — true iff `text` non-empty AND (bytes > `PASTE_SNIPPET_MAX_BYTES` OR lines > `PASTE_SNIPPET_MAX_LINES`).
  - `InputPanel._makePasteFilename(n: number): string` — `` `pasted-text-${n}.txt` ``.
  - `InputPanel._fmtPasteBytes(bytes: number): string` — `"340 KB"`, `"1.2 MB"`, `"512 B"`.

- [ ] **Step 1: Write the failing test**

Create `test/large-paste-snippet.test.ts`:

```ts
/**
 * Unit tests for the large-paste → document-snippet detection helpers.
 *
 * app.js is an unbundled browser script (no exports), so the pure logic is
 * mirrored here as standalone functions matching the exact expressions in
 * InputPanel. Keep in sync with app.js — see test/non-image-file-upload.test.ts.
 */
import { describe, it, expect } from 'vitest';

const PASTE_SNIPPET_MAX_BYTES = 10 * 1024;
const PASTE_SNIPPET_MAX_LINES = 30;

// ── Mirrored from app.js: InputPanel pure helpers ────────────────────────────
const countPasteLines = (text: string): number =>
  !text ? 0 : text.replace(/\r\n|\r| | /g, '\n').split('\n').length;

const pasteByteLength = (text: string): number => new TextEncoder().encode(text).length;

const shouldSnippetPaste = (text: string): boolean => {
  if (!text) return false;
  if (pasteByteLength(text) > PASTE_SNIPPET_MAX_BYTES) return true;
  if (countPasteLines(text) > PASTE_SNIPPET_MAX_LINES) return true;
  return false;
};

const makePasteFilename = (n: number): string => `pasted-text-${n}.txt`;

const fmtPasteBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

describe('large-paste snippet detection', () => {
  it('does not snippet an empty paste', () => {
    expect(shouldSnippetPaste('')).toBe(false);
  });

  it('does not snippet a small single-line paste', () => {
    expect(shouldSnippetPaste('a short stack trace line')).toBe(false);
  });

  it('does not snippet a 30-line paste (boundary, not over)', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    expect(countPasteLines(text)).toBe(30);
    expect(shouldSnippetPaste(text)).toBe(false);
  });

  it('snippets a 31-line paste (over the line threshold)', () => {
    const text = Array.from({ length: 31 }, (_, i) => `line ${i}`).join('\n');
    expect(countPasteLines(text)).toBe(31);
    expect(shouldSnippetPaste(text)).toBe(true);
  });

  it('snippets a wide single-line paste over the byte threshold', () => {
    const text = 'x'.repeat(PASTE_SNIPPET_MAX_BYTES + 1);
    expect(countPasteLines(text)).toBe(1);
    expect(shouldSnippetPaste(text)).toBe(true);
  });

  it('normalizes CR-only and Unicode line separators when counting', () => {
    expect(countPasteLines('a\rb\rc')).toBe(3);
    expect(countPasteLines('a b c')).toBe(3);
    expect(countPasteLines('a\r\nb\r\nc')).toBe(3);
  });

  it('counts UTF-8 bytes, not code units, for the byte threshold', () => {
    // '€' is 3 UTF-8 bytes; 3500 of them = 10500 bytes > 10 KB, but 3500 chars.
    const text = '€'.repeat(3500);
    expect(pasteByteLength(text)).toBe(10500);
    expect(shouldSnippetPaste(text)).toBe(true);
  });

  it('builds a readable paste filename', () => {
    expect(makePasteFilename(1)).toBe('pasted-text-1.txt');
    expect(makePasteFilename(7)).toBe('pasted-text-7.txt');
  });

  it('formats byte sizes', () => {
    expect(fmtPasteBytes(512)).toBe('512 B');
    expect(fmtPasteBytes(340 * 1024)).toBe('340 KB');
    expect(fmtPasteBytes(1.2 * 1024 * 1024)).toBe('1.2 MB');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npx vitest run test/large-paste-snippet.test.ts`
Expected: FAIL — file references helpers that will only exist once mirrored; if the mirror is written inline (as above) this task's test actually PASSES on the mirror. To keep TDD honest, first write the test with the mirror helpers **removed** (importing from a non-existent module) so it fails, then add the mirror. Simpler acceptable alternative: treat Step 1 as authoring the spec-of-record for the helpers; verify the mirror passes (Step 4) and that app.js gains the identical helpers (Step 3).

- [ ] **Step 3: Add the helpers to app.js**

In `src/web/public/app.js`, immediately before `const InputPanel = {` (`app.js:21098`), add:

```js
// Large-paste → document-snippet thresholds. A compose paste larger than either
// is diverted to a .txt file attachment instead of being typed through the mux.
const PASTE_SNIPPET_MAX_BYTES = 10 * 1024; // 10 KB (UTF-8)
const PASTE_SNIPPET_MAX_LINES = 30;
const PASTE_PREVIEW_LIMIT = 100 * 1024;    // preview modal shows at most this many chars
```

Inside the `InputPanel` object, add these methods (near `_getTextarea`, `app.js:21118`):

```js
  // ── Large-paste snippet helpers ──────────────────────────────────────────
  /** Line count with normalized line endings (\r\n, \r, LS, PS → \n). */
  _countPasteLines(text) {
    if (!text) return 0;
    return text.replace(/\r\n|\r| | /g, '\n').split('\n').length;
  },
  /** UTF-8 byte length of the pasted text. */
  _pasteByteLength(text) {
    return new TextEncoder().encode(text).length;
  },
  /** True iff this paste should become a document snippet. */
  _shouldSnippetPaste(text) {
    if (!text) return false;
    if (this._pasteByteLength(text) > PASTE_SNIPPET_MAX_BYTES) return true;
    if (this._countPasteLines(text) > PASTE_SNIPPET_MAX_LINES) return true;
    return false;
  },
  _makePasteFilename(n) {
    return `pasted-text-${n}.txt`;
  },
  _fmtPasteBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npx vitest run test/large-paste-snippet.test.ts`
Expected: PASS (9 tests). Manually diff the mirrored helpers against the app.js versions — expressions must be character-identical.

- [ ] **Step 5: Commit**

```bash
git add test/large-paste-snippet.test.ts src/web/public/app.js
git commit -m "feat(compose): add large-paste snippet detection helpers"
```

---

### Task 2: Paste handler + upload wiring

**Files:**
- Modify: `src/web/public/app.js` — `InputPanel.init()` (`app.js:21208`), add `_onTextPaste` + `_uploadPasteSnippet`, extend `_uploadNonImageFiles` entry creation (`app.js:21663`).
- Test: `test/large-paste-snippet.test.ts` (add a divert-decision block).

**Interfaces:**
- Consumes: `_shouldSnippetPaste`, `_countPasteLines`, `_pasteByteLength`, `_makePasteFilename` (Task 1); existing `_uploadNonImageFiles(files)` (`app.js:21658`).
- Produces:
  - `InputPanel._onTextPaste(e: ClipboardEvent): void`
  - `InputPanel._uploadPasteSnippet(text: string): void`
  - Extended `_files` entry shape: `{ filename, path, uploading, isPaste?, pasteLabel?, lines?, bytes?, previewText?, truncated? }`
  - `file._pasteMeta` convention: a `File` may carry `_pasteMeta` = `{ isPaste, pasteLabel, lines, bytes, previewText, truncated }`; `_uploadNonImageFiles` copies it onto the entry.

- [ ] **Step 1: Write the failing test**

Append to `test/large-paste-snippet.test.ts`:

```ts
// ── Mirrored from app.js: _onTextPaste divert decision ───────────────────────
interface FakeClipboard {
  files?: { length: number };
  getData: (t: string) => string;
}
// Returns 'native' (let browser handle) or 'snippet' (preventDefault + upload).
const pasteDecision = (
  cd: FakeClipboard | null,
  hasActiveSession: boolean
): 'native' | 'snippet' => {
  if (!cd) return 'native';
  if (cd.files && cd.files.length) return 'native'; // file paste → global handler
  const text = cd.getData('text/plain');
  if (!text) return 'native';                        // empty/HTML-only
  if (!shouldSnippetPaste(text)) return 'native';    // small paste
  if (!hasActiveSession) return 'native';            // nowhere to upload
  return 'snippet';
};

describe('paste divert decision', () => {
  const big = 'y'.repeat(PASTE_SNIPPET_MAX_BYTES + 1);
  const mk = (files: number, text: string): FakeClipboard => ({
    files: { length: files },
    getData: () => text,
  });

  it('diverts a big text paste when a session is active', () => {
    expect(pasteDecision(mk(0, big), true)).toBe('snippet');
  });
  it('ignores a big paste when no session is active', () => {
    expect(pasteDecision(mk(0, big), true) === 'snippet').toBe(true);
    expect(pasteDecision(mk(0, big), false)).toBe('native');
  });
  it('ignores a file paste (handled by the global handler)', () => {
    expect(pasteDecision(mk(1, big), true)).toBe('native');
  });
  it('ignores an empty/HTML-only paste', () => {
    expect(pasteDecision(mk(0, ''), true)).toBe('native');
  });
  it('ignores a small text paste', () => {
    expect(pasteDecision(mk(0, 'hello'), true)).toBe('native');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npx vitest run test/large-paste-snippet.test.ts`
Expected: FAIL until the mirror `pasteDecision` block is added (add it with the test), then PASS — proving the decision table. The app.js `_onTextPaste` must match this table exactly (verified by manual diff in Step 4).

- [ ] **Step 3: Wire the handler in app.js**

In `InputPanel.init()`, after the `keydown` listener block (`app.js:21256`+), add:

```js
    // Large-paste → document snippet: intercept oversized plain-text pastes and
    // divert them to a .txt attachment instead of typing them through the mux.
    ta.addEventListener('paste', (e) => this._onTextPaste(e));
```

Add the two methods to `InputPanel` (near `_uploadNonImageFiles`, `app.js:21658`):

```js
  /**
   * Compose-box paste handler for oversized plain text. File/image pastes are
   * owned by the capture-phase global handler (app.js ~5516), which runs first;
   * we only act on genuine plain-text pastes above the snippet thresholds.
   */
  _onTextPaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    if (cd.files && cd.files.length) return;      // file paste — let global handler own it
    const text = cd.getData('text/plain');
    if (!text) return;                            // HTML/RTF-only or empty — native paste
    if (!this._shouldSnippetPaste(text)) return;  // small paste — native insert
    if (typeof app === 'undefined' || !app.activeSessionId) return; // nowhere to upload
    e.preventDefault();
    this._uploadPasteSnippet(text);
  },

  /** Turn pasted text into a .txt file and push it through the upload pipeline. */
  _uploadPasteSnippet(text) {
    this._pasteCounter = (this._pasteCounter || 0) + 1;
    const n = this._pasteCounter;
    const lines = this._countPasteLines(text);
    const bytes = this._pasteByteLength(text);
    const file = new File([text], this._makePasteFilename(n), { type: 'text/plain' });
    // Metadata for the "document snippet" chip + preview. previewText is bounded
    // so a multi-MB paste doesn't keep a second full copy in memory.
    file._pasteMeta = {
      isPaste: true,
      pasteLabel: n,
      lines,
      bytes,
      previewText: text.slice(0, PASTE_PREVIEW_LIMIT),
      truncated: text.length > PASTE_PREVIEW_LIMIT,
    };
    this._uploadNonImageFiles([file]);
  },
```

Extend the entry-creation line in `_uploadNonImageFiles` (`app.js:21663`) from:

```js
      const entry = { filename: file.name, path: null, uploading: true };
```

to:

```js
      const entry = { filename: file.name, path: null, uploading: true };
      if (file._pasteMeta) Object.assign(entry, file._pasteMeta);
```

- [ ] **Step 4: Run test + manual diff**

Run: `PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npx vitest run test/large-paste-snippet.test.ts`
Expected: PASS (all blocks). Manually confirm `_onTextPaste`'s guard order matches `pasteDecision` exactly.

- [ ] **Step 5: Commit**

```bash
git add test/large-paste-snippet.test.ts src/web/public/app.js
git commit -m "feat(compose): divert large text pastes to a .txt attachment"
```

---

### Task 3: Document-snippet chip + preview modal

**Files:**
- Modify: `src/web/public/app.js` — `_renderThumbnails` file loop (`app.js:21842-21874`), add `_previewPasteSnippet`.

**Interfaces:**
- Consumes: extended `_files` entry (`isPaste`, `lines`, `bytes`, `previewText`, `truncated`) from Task 2; `_fmtPasteBytes` from Task 1.
- Produces: `InputPanel._previewPasteSnippet(entry): void`.

- [ ] **Step 1: Branch the chip render**

Replace the body of `this._files.forEach((file, idx) => { ... })` (`app.js:21842-21874`) so paste entries render distinctly. Full replacement:

```js
    // Render non-image file attachments (and paste snippets)
    this._files.forEach((file, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'compose-thumb compose-thumb-file' + (file.isPaste ? ' compose-thumb-paste' : '');
      wrap.title = file.isPaste
        ? (file.uploading ? 'Uploading…' : 'Pasted text — click to preview')
        : (file.path || (file.uploading ? 'Uploading…' : file.filename));

      const icon = document.createElement('div');
      icon.className = 'compose-file-icon';
      if (file.isPaste) {
        icon.textContent = '📄'; // 📄
      } else {
        const ext = file.filename.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toUpperCase() || '';
        icon.textContent = ext || '📄';
      }
      icon.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:60%;font-size:11px;font-weight:700;color:var(--text-secondary,#999);letter-spacing:0.5px;';

      const label = document.createElement('div');
      label.className = 'compose-file-label';
      if (file.isPaste) {
        label.textContent = file.uploading
          ? 'Uploading…'
          : `Pasted text · ${(file.lines || 0).toLocaleString()} lines · ${this._fmtPasteBytes(file.bytes || 0)}`;
      } else {
        label.textContent = file.uploading ? 'Uploading…' : file.filename;
      }
      label.style.cssText = 'font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;text-align:center;padding:0 2px;color:var(--text-secondary,#999);';

      const removeBtn = document.createElement('button');
      removeBtn.className = 'compose-thumb-remove';
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', file.isPaste ? 'Remove pasted text' : 'Remove file');
      removeBtn.textContent = '\xd7';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._files.splice(idx, 1);
        this._renderThumbnails();
      });

      // Paste snippets are clickable to preview their captured text.
      if (file.isPaste && !file.uploading) {
        wrap.style.cursor = 'pointer';
        wrap.addEventListener('click', (e) => {
          if (e.target === removeBtn) return;
          this._previewPasteSnippet(file);
        });
      }

      wrap.appendChild(icon);
      wrap.appendChild(label);
      wrap.appendChild(removeBtn);
      strip.appendChild(wrap);
    });
```

- [ ] **Step 2: Add the preview modal**

Add to `InputPanel` (near `_previewImage`, `app.js:21877`):

```js
  /** Lightweight modal showing a paste snippet's captured text. */
  _previewPasteSnippet(entry) {
    const overlay = document.createElement('div');
    overlay.className = 'paste-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);padding:24px;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-secondary,#1e1e1e);color:var(--text-primary,#eee);max-width:900px;width:100%;max-height:80vh;display:flex;flex-direction:column;border-radius:8px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.5);';

    const header = document.createElement('div');
    header.style.cssText = 'padding:10px 14px;font-size:12px;font-weight:600;border-bottom:1px solid var(--border,#333);display:flex;justify-content:space-between;align-items:center;';
    const title = document.createElement('span');
    title.textContent = `📄 Pasted text · ${(entry.lines || 0).toLocaleString()} lines · ${this._fmtPasteBytes(entry.bytes || 0)}`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '\xd7';
    closeBtn.setAttribute('aria-label', 'Close preview');
    closeBtn.style.cssText = 'background:none;border:none;color:inherit;font-size:20px;cursor:pointer;line-height:1;';
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('pre');
    body.style.cssText = 'margin:0;padding:14px;overflow:auto;font-family:var(--font-mono,monospace);font-size:12px;white-space:pre-wrap;word-break:break-word;';
    body.textContent = entry.previewText || '';
    if (entry.truncated) {
      const note = document.createElement('div');
      note.style.cssText = 'padding:8px 14px;font-size:11px;color:var(--text-secondary,#999);border-top:1px solid var(--border,#333);';
      note.textContent = `Showing the first ${this._fmtPasteBytes(PASTE_PREVIEW_LIMIT)} — the full text will be sent as a file attachment.`;
      modal.appendChild(header);
      modal.appendChild(body);
      modal.appendChild(note);
    } else {
      modal.appendChild(header);
      modal.appendChild(body);
    }

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', function esc(ev) {
      if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  },
```

- [ ] **Step 3: Verify render logic compiles (no dedicated unit test — DOM/manual)**

Run: `PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npx vitest run test/large-paste-snippet.test.ts`
Expected: PASS (existing tests unaffected). Chip render + modal are DOM code, verified manually in Task 4.

- [ ] **Step 4: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat(compose): document-snippet chip + preview for pasted text"
```

---

### Task 4: Build, quality gate, deploy, and end-to-end QA

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + lint + full test suite**

Run:
```bash
npm run build
PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" npm test
```
Expected: build succeeds (tsc clean), lint clean, all tests pass including `large-paste-snippet.test.ts`. If the project has a separate `npm run lint`/`npm run typecheck`, run those too.

- [ ] **Step 2: Manual end-to-end on a dev server**

Start a dev server on a spare port (per memory):
```bash
nohup npx tsx src/index.ts web --port 3007 > /tmp/codeman-3007.log 2>&1 &
sleep 6 && curl -s http://localhost:3007/api/status | head -c 200
```
In the browser (`http://localhost:3007` or the Tailscale URL), against an active Claude session:
1. Paste a ~2,000-line blob into the compose box → a "📄 Pasted text · 2,000 lines · … KB" chip appears; the textarea stays empty; Send is briefly disabled then re-enables.
2. Click the chip → preview modal shows the text (with truncation note if >100 KB); Esc / × / backdrop close it.
3. Send → message goes through quickly; verify the sent line contains `[Attached file: …/.codeman-uploads/pasted-text-1.txt]` and the file exists in the session's `<workingDir>/.codeman-uploads/`.
4. In the Claude session, confirm Claude can `Read` that path (including for a safe-mode/restricted session if available).
5. Paste a small (<10 KB, <30-line) blob → inserts inline as before (no chip).
6. Paste an image → still routes to the image thumbnail path, not the snippet path.
7. Remove a paste chip with × → it disappears and Send re-enables.

- [ ] **Step 3: Deploy to the installed app**

```bash
cd /home/siggi/sources/Codeman
npm run build
cp -r dist /home/siggi/.codeman/app/
cp package.json /home/siggi/.codeman/app/package.json
systemctl --user restart codeman-web
```
Verify: `systemctl --user status codeman-web` active; reload the real UI and re-run manual check #1.

- [ ] **Step 4: Kill the dev server**

Run: `pkill -f "tsx src/index.ts web --port 3007"`

- [ ] **Step 5: Final commit (if any stragglers)**

```bash
git add -A
git commit -m "chore: large-paste snippet — build/deploy verification" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Detection (>10 KB or >30 lines, either/or; empty/non-text no-op; line-ending normalization; capture at active session) → Task 1 + Task 2 ✓
- Reuse existing upload pipeline (`/api/sessions/:id/upload`, working-dir storage, 10 MB cap, `[Attached file:]` send) → Task 2 (no server change) ✓
- "📄 Pasted text" chip with remove + preview, send-gating reused → Task 3 ✓
- Coordinate with capture-phase file handler; don't hijack file/image pastes → Task 2 guard + Task 4 manual checks #6 ✓
- Compression dropped → reflected (no gzip anywhere) ✓
- Known limitations (ordering, `/clear`, disk growth) → intentionally not implemented (documented in spec as pre-existing/shared) ✓
- Testing (thresholds, normalization, no-op, formatting, decision table, manual e2e) → Task 1/2 unit + Task 4 manual ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. (Task 1 Step 2 notes the TDD-honesty caveat for mirror-style tests but still gives an exact command + expectation.)

**Type/name consistency:** `_countPasteLines`, `_pasteByteLength`, `_shouldSnippetPaste`, `_makePasteFilename`, `_fmtPasteBytes`, `_onTextPaste`, `_uploadPasteSnippet`, `_previewPasteSnippet`, and the `_pasteMeta`/entry fields (`isPaste`, `pasteLabel`, `lines`, `bytes`, `previewText`, `truncated`) are used consistently across Tasks 1–3. `PASTE_SNIPPET_MAX_BYTES` / `PASTE_SNIPPET_MAX_LINES` / `PASTE_PREVIEW_LIMIT` match between app.js and the mirrored test constants.

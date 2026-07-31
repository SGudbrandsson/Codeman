// esbuild entry for the Codeman file-editor vendor bundle.
// Bundled to dist/web/public/vendor/editor.min.js as an IIFE that exposes two
// globals so app.js stays dependency-free and offline:
//   window.CodemanEditor   = { create(parent, opts) -> adapter }
//   window.CodemanMarkdown = { render(src) -> sanitized HTML string }
//
// See scripts/build.mjs step 3 and TASK.md for the rationale (lazy-loaded on
// first files-sheet open; textarea/pre fallback if this fails to load).

import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import {
  defaultHighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
} from '@codemirror/language';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';

import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';

import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

// --- Dark theme matching the files sheet (#0d1117 / #e6edf3). Dark from
// creation so there is no light-theme flash. ---
const codemanTheme = EditorView.theme(
  {
    '&': {
      color: '#e6edf3',
      backgroundColor: '#0d1117',
      height: '100%',
      fontSize: '13px',
    },
    '.cm-scroller': {
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      lineHeight: '1.5',
      WebkitOverflowScrolling: 'touch',
    },
    '.cm-content': {
      caretColor: '#e6edf3',
      paddingBottom: 'calc(24px + var(--safe-area-bottom, 0px))',
    },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#e6edf3' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: '#264066' },
    '.cm-gutters': {
      backgroundColor: '#0d1117',
      color: '#484f58',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 8px' },
  },
  { dark: true }
);

function langFor(filename) {
  const name = String(filename || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: ext === 'jsx' });
    case 'json':
      return json();
    case 'yaml':
    case 'yml':
      return yaml();
    case 'css':
    case 'scss':
      return css();
    case 'html':
    case 'htm':
      return html();
    case 'py':
      return python();
    case 'md':
    case 'markdown':
      return markdown();
    case 'sh':
    case 'bash':
    case 'zsh':
      return StreamLanguage.define(shell);
    default:
      return [];
  }
}

const isPhone =
  typeof matchMedia === 'function'
    ? !matchMedia('(min-width: 768px)').matches
    : false;

window.CodemanEditor = {
  create(parent, opts) {
    opts = opts || {};
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    const extensions = [
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      codemanTheme,
      langFor(opts.filename),
    ];
    // Gutter off on phones (spec) — keeps the surface looking like a plain
    // editor and saves horizontal space at 390px.
    if (!isPhone) extensions.push(lineNumbers());
    if (opts.readOnly) extensions.push(EditorState.readOnly.of(true));
    if (onChange) {
      extensions.push(
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        })
      );
    }
    const view = new EditorView({
      state: EditorState.create({ doc: opts.doc || '', extensions }),
      parent,
    });
    return {
      dom: view.dom,
      getValue: () => view.state.doc.toString(),
      setValue: (str) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: str || '' },
        });
      },
      focus: () => view.focus(),
      destroy: () => view.destroy(),
    };
  },
};

// --- Markdown -> sanitized HTML. html:false already blocks raw HTML; DOMPurify
// is belt-and-braces against anything markdown-it emits (e.g. via linkify). ---
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

window.CodemanMarkdown = {
  render(src) {
    const rendered = md.render(String(src == null ? '' : src));
    return DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  },
};

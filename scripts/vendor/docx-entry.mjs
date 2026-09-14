// esbuild entry for the Codeman DOCX preview vendor bundle.
// Bundled to dist/web/public/vendor/docx.min.js as an IIFE exposing one global:
//   window.CodemanDocx = { render(arrayBuffer, container, opts) }
//
// Lazy-loaded by app.js (_filesEnsureDocx) only when a .docx file is opened.
// docx-preview is Apache-2.0 and its dependency JSZip is used under MIT;
// --legal-comments=eof keeps their notices. See scripts/build.mjs.

import { renderAsync } from 'docx-preview';

window.CodemanDocx = {
  // Renders the document body and its generated <style> into the same
  // container, so tearing down the container also removes the styles.
  render(data, container, opts) {
    return renderAsync(data, container, container, opts);
  },
};

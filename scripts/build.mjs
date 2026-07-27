#!/usr/bin/env node
/**
 * Build script for Codeman.
 * Extracted from the package.json one-liner for readability and debuggability.
 *
 * Steps:
 *   1. TypeScript compilation
 *   2. Copy static assets (web/public, templates)
 *   3. Build vendor xterm bundles
 *   4. Minify frontend assets (app.js, styles.css, mobile.css)
 *   5. Inject content-hash ?v= strings into dist index.html (no conflicts in source)
 *   6. Compress with gzip + brotli
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'zlib';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

function run(label, cmd) {
  console.log(`\n[build] ${label}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, shell: true });
}

// 1. TypeScript compilation
run('tsc', 'tsc');
run('chmod dist/index.js', 'chmod +x dist/index.js');

// 2. Copy static assets
run('prepare dirs', 'mkdir -p dist/web dist/templates');
run('copy web assets', 'rm -rf dist/web/public && cp -r src/web/public dist/web/ && mkdir -p dist/web/public/vendor');
run('copy template', 'cp src/templates/case-template.md dist/templates/');

// 3. Vendor xterm bundles (@xterm/* v6 namespace)
run('xterm css', 'cp node_modules/@xterm/xterm/css/xterm.css dist/web/public/vendor/');
run('xterm js', 'npx esbuild node_modules/@xterm/xterm/lib/xterm.js --minify --outfile=dist/web/public/vendor/xterm.min.js');
run('xterm-addon-fit', 'npx esbuild node_modules/@xterm/addon-fit/lib/addon-fit.js --minify --outfile=dist/web/public/vendor/xterm-addon-fit.min.js');
run('xterm-addon-webgl', 'cp node_modules/@xterm/addon-webgl/lib/addon-webgl.js dist/web/public/vendor/xterm-addon-webgl.min.js');
run('xterm-addon-unicode11', 'npx esbuild node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js --minify --outfile=dist/web/public/vendor/xterm-addon-unicode11.min.js');
run('xterm-addon-search', 'npx esbuild node_modules/@xterm/addon-search/lib/addon-search.js --minify --outfile=dist/web/public/vendor/xterm-addon-search.min.js');

// 4. Minify frontend assets
run('minify app.js', 'npx esbuild dist/web/public/app.js --minify --outfile=dist/web/public/app.js --allow-overwrite');
run('minify styles.css', 'npx esbuild dist/web/public/styles.css --minify --outfile=dist/web/public/styles.css --allow-overwrite');
run('minify mobile.css', 'npx esbuild dist/web/public/mobile.css --minify --outfile=dist/web/public/mobile.css --allow-overwrite');

// 5. Inject content-hash cache-busting into dist/web/public/index.html
// Source index.html has bare filenames (no ?v=...) — version strings are added here
// based on actual file content so they update automatically whenever files change.
{
  const htmlPath = join(ROOT, 'dist/web/public/index.html');
  let html = readFileSync(htmlPath, 'utf8');
  // Match src="..." and href="..." pointing to local files (no protocol, no leading /)
  html = html.replace(/\b(src|href)="([^"]+\.(js|css))"/g, (match, attr, filePath) => {
    // Skip external URLs and absolute paths
    if (filePath.startsWith('http') || filePath.startsWith('//') || filePath.startsWith('/')) {
      return match;
    }
    // Strip any existing ?... query string to get the bare file path
    const bareFilePath = filePath.replace(/\?.*$/, '');
    const absPath = join(ROOT, 'dist/web/public', bareFilePath);
    let hash;
    try {
      const contents = readFileSync(absPath);
      hash = createHash('sha256').update(contents).digest('hex').slice(0, 8);
    } catch {
      // File not found — leave the tag unchanged
      return match;
    }
    return `${attr}="${bareFilePath}?v=${hash}"`;
  });
  writeFileSync(htmlPath, html);
  console.log('\n[build] inject content hashes into index.html — done');
}

// 6. Compress with gzip + brotli via Node's zlib — no external CLI needed.
// The previous shell version depended on a `brotli` binary that isn't installed
// everywhere; when it was missing, deploys could leave stale .br files in the
// target dir shadowing fresh assets (fastify-static preCompressed serves .br first).
console.log('\n[build] compress (gzip + brotli)');
{
  const dirs = [join(ROOT, 'dist/web/public'), join(ROOT, 'dist/web/public/vendor')];
  let count = 0;
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!/\.(js|css|html)$/.test(name)) continue;
      const file = join(dir, name);
      if (!statSync(file).isFile()) continue;
      const buf = readFileSync(file);
      writeFileSync(`${file}.gz`, gzipSync(buf, { level: 9 }));
      writeFileSync(
        `${file}.br`,
        brotliCompressSync(buf, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
          },
        })
      );
      count++;
    }
  }
  console.log(`[build] compressed ${count} files (.gz + .br)`);
}

console.log('\n✓ Build complete');

/**
 * Tests for the sidebar new-session menu bugs:
 *
 * Bug 1: .drawer-quick-add has z-index 1300, below .session-drawer (z-index 9000),
 *         making the popover invisible. Fix: raise to 9500.
 *
 * Bug 2: startSessionInCase() routes through the legacy #quickStartCase <select>,
 *         which silently ignores the project if the option isn't in the select.
 *         Fix: bypass the select and call POST /api/sessions directly using workingDir
 *         resolved from app.cases.
 *
 * Run: npx vitest run test/sidebar-new-session-menu.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─── Helper: parse a single numeric CSS property from styles.css ───────────

function getCssZIndex(selector: string): number | null {
  const css = readFileSync(join(repoRoot, 'src/web/public/styles.css'), 'utf8');
  // Find the block that starts with the selector and grab the z-index inside it
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escapedSelector + '\\s*\\{([^}]+)\\}', 'g');
  let match: RegExpExecArray | null;
  let lastZIndex: number | null = null;
  while ((match = re.exec(css)) !== null) {
    const block = match[1];
    const zMatch = block.match(/z-index\s*:\s*(\d+)/);
    if (zMatch) {
      lastZIndex = parseInt(zMatch[1], 10);
    }
  }
  return lastZIndex;
}

// ─── Helper: read source text from app.js ─────────────────────────────────

function getAppJs(): string {
  return readFileSync(join(repoRoot, 'src/web/public/app.js'), 'utf8');
}

// ─── Bug 1: z-index ────────────────────────────────────────────────────────

describe('sidebar quick-add popover z-index', () => {
  it('.session-drawer has z-index 9000 (baseline)', () => {
    const z = getCssZIndex('.session-drawer');
    expect(z).toBe(9000);
  });

  it('.drawer-quick-add z-index is above .session-drawer (must be > 9000)', () => {
    const drawerZ = getCssZIndex('.session-drawer') ?? 9000;
    const popoverZ = getCssZIndex('.drawer-quick-add');
    expect(popoverZ, '.drawer-quick-add z-index must be defined').not.toBeNull();
    expect(
      popoverZ! > drawerZ,
      `.drawer-quick-add z-index (${popoverZ}) must be greater than .session-drawer z-index (${drawerZ})`
    ).toBe(true);
  });

  it('.drawer-quick-add z-index is at least 9500', () => {
    const z = getCssZIndex('.drawer-quick-add');
    expect(z, '.drawer-quick-add z-index should be >= 9500').toBeGreaterThanOrEqual(9500);
  });
});

// ─── Bug 2: startSessionInCase bypasses the legacy select ─────────────────

describe('startSessionInCase API call', () => {
  it('startSessionInCase does not set #quickStartCase.value', () => {
    const src = getAppJs();
    // Find the function body
    const fnStart = src.indexOf('async startSessionInCase(');
    expect(fnStart, 'startSessionInCase function must exist').toBeGreaterThan(-1);

    // Extract approximately 2000 chars after the function declaration
    const fnSlice = src.slice(fnStart, fnStart + 2000);

    // The function must NOT touch document.getElementById('quickStartCase')
    expect(
      fnSlice.includes("getElementById('quickStartCase')") || fnSlice.includes('getElementById("quickStartCase")'),
      'startSessionInCase must not use the legacy #quickStartCase select element'
    ).toBe(false);
  });

  it('startSessionInCase calls fetch with POST /api/sessions', () => {
    const src = getAppJs();
    const fnStart = src.indexOf('async startSessionInCase(');
    expect(fnStart).toBeGreaterThan(-1);

    const fnSlice = src.slice(fnStart, fnStart + 2000);

    // Must contain a direct fetch call to /api/sessions
    expect(fnSlice.includes('/api/sessions'), 'startSessionInCase must call POST /api/sessions directly').toBe(true);
  });

  it('startSessionInCase passes mode to the API', () => {
    const src = getAppJs();
    const fnStart = src.indexOf('async startSessionInCase(');
    expect(fnStart).toBeGreaterThan(-1);

    const fnSlice = src.slice(fnStart, fnStart + 2000);

    // The API body must include the mode parameter
    expect(fnSlice.includes('mode'), 'startSessionInCase must pass mode to the API').toBe(true);
  });

  it('startSessionInCase resolves workingDir from cases not from legacy select', () => {
    const src = getAppJs();
    const fnStart = src.indexOf('async startSessionInCase(');
    expect(fnStart).toBeGreaterThan(-1);

    const fnSlice = src.slice(fnStart, fnStart + 2000);

    // Must reference cases (either this.cases or app.cases or /api/cases/)
    expect(
      fnSlice.includes('cases') || fnSlice.includes('/api/cases/'),
      'startSessionInCase must look up the project workingDir from cases or the cases API'
    ).toBe(true);
  });
});

/**
 * Mobile compose bar UX — real-browser tests (iPhone-emulated, touch).
 *
 *   1. Height cap: a long message no longer grows the textarea to nearly the
 *      full viewport. It stops at a compact cap and scrolls internally; a
 *      grow/shrink button (#composeSizeBtn) appears only when it is useful
 *      and toggles a tall editor.
 *   2. Action sheet arming: taps on the + sheet's options/backdrop are ignored
 *      until the slide-up animation has finished, so the second half of an
 *      accidental double tap cannot open the camera / picker.
 *   3. Mic single toggle: one tap on the mic starts recording exactly once.
 *      It used to fire twice (panel touchstart tap-fix + a touchend handler),
 *      starting and immediately stopping the recording.
 *
 * Port: 3266
 *
 * Run: npx vitest run test/compose-mobile-ux.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3266;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

async function mobilePage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 8000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    (window as unknown as { InputPanel: { open: () => void } }).InputPanel.open();
  });
  return { context, page };
}

/** Sets the textarea text and runs the same auto-grow the input event does. */
async function setText(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement;
    ta.value = t;
    (window as unknown as { InputPanel: { _autoGrow: (el: HTMLTextAreaElement) => void } }).InputPanel._autoGrow(ta);
  }, text);
}

async function textareaBox(page: Page) {
  return page.evaluate(() => {
    const ta = document.getElementById('composeTextarea') as HTMLTextAreaElement;
    const vvh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    return { height: ta.getBoundingClientRect().height, scrollHeight: ta.scrollHeight, vvh };
  });
}

const LONG_TEXT = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long dictated message.`).join('\n');

beforeAll(async () => {
  server = new WebServer(PORT, false, true);
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

// ─── 1. Height cap + grow/shrink ─────────────────────────────────────────────

describe('Compose height cap', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await mobilePage());
  }, 30_000);

  afterAll(async () => {
    await context?.close();
  });

  it('runs as a mobile device', async () => {
    const type = await page.evaluate(() =>
      (window as unknown as { MobileDetection: { getDeviceType: () => string } }).MobileDetection.getDeviceType()
    );
    expect(type).toBe('mobile');
  });

  it('hides the grow/shrink button for short text', async () => {
    await setText(page, 'short message');
    expect(await page.locator('#composeSizeBtn').isVisible()).toBe(false);
  });

  it('caps a long message at about a third of the viewport and scrolls inside', async () => {
    await setText(page, LONG_TEXT);
    const box = await textareaBox(page);
    expect(box.scrollHeight).toBeGreaterThan(box.height); // content scrolls internally
    expect(box.height).toBeLessThanOrEqual(Math.min(260, Math.round(box.vvh * 0.33)) + 1);
    // The old behaviour grew to vvh - 200 — make sure we are well below that.
    expect(box.height).toBeLessThan(box.vvh - 200);
  });

  it('shows the grow/shrink button once the text overflows', async () => {
    expect(await page.locator('#composeSizeBtn').isVisible()).toBe(true);
    expect(await page.locator('#composeSizeBtn').getAttribute('aria-pressed')).toBe('false');
  });

  it('the button expands to the tall editor and back', async () => {
    const compact = (await textareaBox(page)).height;
    await page.locator('#composeSizeBtn').tap();
    await page.waitForTimeout(100);
    const tall = await textareaBox(page);
    expect(tall.height).toBeGreaterThan(compact + 50);
    expect(await page.locator('#composeSizeBtn').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#composeSizeBtn').getAttribute('aria-label')).toBe('Shrink editor');

    await page.locator('#composeSizeBtn').tap();
    await page.waitForTimeout(100);
    expect((await textareaBox(page)).height).toBeCloseTo(compact, 0);
    expect(await page.locator('#composeSizeBtn').getAttribute('aria-pressed')).toBe('false');
  });

  it('clearing the message drops back to compact and hides the button', async () => {
    await page.locator('#composeSizeBtn').tap();
    await setText(page, '');
    expect(await page.locator('#composeSizeBtn').isVisible()).toBe(false);
    const tallState = await page.evaluate(
      () => (window as unknown as { InputPanel: { _composeTall?: boolean } }).InputPanel._composeTall
    );
    expect(tallState).toBe(false);
  });
});

// ─── 2. Action sheet arming ──────────────────────────────────────────────────

describe('Action sheet ignores taps until it has finished opening', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await mobilePage());
    // Record file-input clicks instead of opening real pickers.
    await page.evaluate(() => {
      const w = window as unknown as { __picked: string[] };
      w.__picked = [];
      for (const id of ['composeFileCamera', 'composeFileGallery', 'composeFileAny']) {
        const input = document.getElementById(id) as HTMLInputElement;
        input.click = () => {
          w.__picked.push(id);
        };
      }
    });
  }, 30_000);

  afterAll(async () => {
    await context?.close();
  });

  const sheetOpen = (page: Page) =>
    page.evaluate(() => document.getElementById('composeActionSheet')!.classList.contains('open'));
  const picked = (page: Page) => page.evaluate(() => (window as unknown as { __picked: string[] }).__picked);

  it('an option tapped right after opening (double tap) is ignored', async () => {
    const result = await page.evaluate(() => {
      const ip = (
        window as unknown as { InputPanel: { _openActionSheet: () => void; _actionSheetPick: (t: string) => void } }
      ).InputPanel;
      ip._openActionSheet();
      ip._actionSheetPick('camera'); // the stray second tap, same frame
      return document.getElementById('composeActionSheet')!.classList.contains('open');
    });
    await page.waitForTimeout(50);
    expect(result).toBe(true);
    expect(await picked(page)).toEqual([]);
  });

  it('options are pointer-inert while the sheet is arming', async () => {
    const pe = await page.evaluate(() => {
      const item = document.querySelector('#composeActionSheet .compose-action-item') as HTMLElement;
      return getComputedStyle(item).pointerEvents;
    });
    expect(pe).toBe('none');
  });

  it('a backdrop tap right after opening does not close the sheet', async () => {
    await page.evaluate(() => {
      const ip = (window as unknown as { InputPanel: { _closeActionSheet: () => void; _openActionSheet: () => void } })
        .InputPanel;
      ip._closeActionSheet();
      ip._openActionSheet();
      (document.getElementById('composeActionBackdrop') as HTMLElement).click();
    });
    expect(await sheetOpen(page)).toBe(true);
  });

  it('once armed, a tap on an option picks it and closes the sheet', async () => {
    await page.waitForTimeout(450);
    const pe = await page.evaluate(() => {
      const item = document.querySelector('#composeActionSheet .compose-action-item') as HTMLElement;
      return getComputedStyle(item).pointerEvents;
    });
    expect(pe).not.toBe('none');
    await page.locator('#composeActionSheet .compose-action-item').nth(1).tap(); // Photo Library
    await page.waitForTimeout(50);
    expect(await sheetOpen(page)).toBe(false);
    expect(await picked(page)).toEqual(['composeFileGallery']);
  });

  it('once armed, the backdrop closes the sheet', async () => {
    await page.evaluate(() => {
      (window as unknown as { InputPanel: { _openActionSheet: () => void } }).InputPanel._openActionSheet();
    });
    await page.waitForTimeout(450);
    await page.evaluate(() => (document.getElementById('composeActionBackdrop') as HTMLElement).click());
    expect(await sheetOpen(page)).toBe(false);
  });
});

// ─── 3. Mic single toggle ────────────────────────────────────────────────────

describe('Mic button — one tap is one toggle', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await mobilePage());
    await page.evaluate(() => {
      // VoiceInput is a top-level const (not on window) — reach it by name.
      const vi = (0, eval)('VoiceInput') as {
        isRecording: boolean;
        start: () => void;
        stop: () => void;
      };
      const w = window as unknown as { __mic: string[] };
      w.__mic = [];
      vi.start = () => {
        w.__mic.push('start');
        vi.isRecording = true;
      };
      vi.stop = () => {
        w.__mic.push('stop');
        vi.isRecording = false;
      };
    });
  }, 30_000);

  afterAll(async () => {
    await context?.close();
  });

  const micCalls = (page: Page) => page.evaluate(() => (window as unknown as { __mic: string[] }).__mic.slice());

  it('the context is a touch device (so the panel tap-fix is installed)', async () => {
    const touch = await page.evaluate(() =>
      (window as unknown as { MobileDetection: { isTouchDevice: () => boolean } }).MobileDetection.isTouchDevice()
    );
    expect(touch).toBe(true);
  });

  it('a single tap starts recording exactly once (no immediate stop)', async () => {
    await page.locator('#composeMicBtn').tap();
    await page.waitForTimeout(300);
    expect(await micCalls(page)).toEqual(['start']);
  });

  it('a second, later tap stops it', async () => {
    await page.waitForTimeout(300);
    await page.locator('#composeMicBtn').tap();
    await page.waitForTimeout(300);
    expect(await micCalls(page)).toEqual(['start', 'stop']);
  });
});

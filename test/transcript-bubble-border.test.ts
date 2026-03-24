/**
 * Regression test: User message bubble border color
 *
 * Bug: .tv-block--user .tv-bubble had `border: 1px solid rgba(59, 130, 246, 0.25)`
 * — a visible blue border on user message bubbles in the transcript view.
 *
 * Fix: Changed to `border: 1px solid rgba(255, 255, 255, 0.08)` — a muted white
 * border matching the general --border style used elsewhere in the UI.
 *
 * Run: npx vitest run test/transcript-bubble-border.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3248;
const BASE_URL = `http://localhost:${PORT}`;

let server: WebServer;
let browser: Browser;

async function freshPage(width = 1280, height = 800): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  return { context, page };
}

async function navigateTo(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
    timeout: 8000,
  });
  await page.waitForTimeout(300);
}

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

describe('User message bubble: border is not blue', () => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    ({ context, page } = await freshPage(1280, 800));
    await navigateTo(page);
  });

  afterAll(async () => {
    await context?.close();
  });

  it('.tv-block--user .tv-bubble border color is not rgba(59, 130, 246, 0.25)', async () => {
    const borderColor = await page.evaluate(() => {
      // Construct the nested DOM structure that matches the CSS selector
      const block = document.createElement('div');
      block.className = 'tv-block--user';
      document.body.appendChild(block);

      const bubble = document.createElement('div');
      bubble.className = 'tv-bubble';
      block.appendChild(bubble);

      const color = getComputedStyle(bubble).borderColor;

      document.body.removeChild(block);

      return color;
    });

    // The blue border that was removed: rgba(59, 130, 246, 0.25)
    // Browsers normalise alpha < 1 as rgba(...), but let's check the string doesn't
    // contain the specific blue RGB values with the original 0.25 alpha.
    expect(borderColor).not.toBe('rgba(59, 130, 246, 0.25)');
    // The border should NOT be the high-opacity blue either
    expect(borderColor).not.toMatch(/rgba\(59,\s*130,\s*246/);
  });

  it('.tv-block--user .tv-bubble border color is muted (white-based, not blue)', async () => {
    const borderColor = await page.evaluate(() => {
      const block = document.createElement('div');
      block.className = 'tv-block--user';
      document.body.appendChild(block);

      const bubble = document.createElement('div');
      bubble.className = 'tv-bubble';
      block.appendChild(bubble);

      const color = getComputedStyle(bubble).borderColor;

      document.body.removeChild(block);

      return color;
    });

    // The new border is rgba(255, 255, 255, 0.08) — a very muted white.
    // Browsers render this as rgba(255, 255, 255, 0.08) or similar.
    // Assert it contains "255, 255, 255" (white channels) rather than blue channels.
    expect(borderColor).toMatch(/255,\s*255,\s*255/);
  });
});

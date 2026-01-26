/**
 * Playwright Direct API Test Suite
 *
 * Tests Claudeman web UI using Playwright's native API directly.
 * This provides the most control and best debugging capabilities.
 *
 * Port: 3155 (see CLAUDE.md test port table)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { WebServer } from '../src/web/server.js';

const TEST_PORT = 3155;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Metrics collection
interface TestMetrics {
  testName: string;
  duration: number;
  framework: 'playwright';
  success: boolean;
  error?: string;
}

const metrics: TestMetrics[] = [];
let server: WebServer;
let browser: Browser;
let createdSessions: string[] = [];
let setupComplete = false;

describe('Playwright Direct API Tests', () => {
  beforeAll(async () => {
    // Start web server
    server = new WebServer(TEST_PORT);
    await server.start();
    await new Promise(r => setTimeout(r, 1000));

    // Launch browser
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    setupComplete = true;
  }, 30000);

  afterAll(async () => {
    // Cleanup sessions
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }

    // Close browser and server
    if (browser) await browser.close();
    if (server) await server.stop();

    // Output metrics
    console.log('\n📊 Playwright Test Metrics:');
    console.table(metrics.map(m => ({
      test: m.testName.substring(0, 40),
      duration: `${m.duration}ms`,
      status: m.success ? '✅' : '❌',
    })));
  }, 30000);

  // Helper to run test with metrics
  async function withMetrics(name: string, fn: (page: Page) => Promise<void>) {
    if (!setupComplete) {
      console.log('Skipping - setup not complete');
      return;
    }
    const start = Date.now();
    let success = false;
    let error: string | undefined;
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await fn(page);
      success = true;
    } catch (e: any) {
      error = e.message;
      throw e;
    } finally {
      await context.close();
      metrics.push({ testName: name, duration: Date.now() - start, framework: 'playwright', success, error });
    }
  }

  // ============================================================================
  // Core Page Tests
  // ============================================================================

  it('should load the main page with correct title', async () => {
    await withMetrics('page-load', async (page) => {
      await page.goto(BASE_URL);
      await expect(page).toHaveTitle('Claudeman');
    });
  }, 30000);

  it('should display the logo and branding', async () => {
    await withMetrics('logo-branding', async (page) => {
      await page.goto(BASE_URL);
      const logo = page.locator('.header-brand .logo');
      await expect(logo).toBeVisible();
      await expect(logo).toHaveText('Claudeman');
    });
  }, 30000);

  it('should show version in toolbar', async () => {
    await withMetrics('version-display', async (page) => {
      await page.goto(BASE_URL);
      const version = page.locator('#versionDisplay');
      await expect(version).toBeVisible();
      await expect(version).toHaveText(/v\d+\.\d+/);
    });
  }, 30000);

  // ============================================================================
  // Modal Tests
  // ============================================================================

  it('should open and close help modal', async () => {
    await withMetrics('help-modal', async (page) => {
      await page.goto(BASE_URL);
      await page.click('.help-btn');
      const modal = page.locator('#helpModal .modal-content');
      await expect(modal).toBeVisible();
      const heading = page.locator('#helpModal h3');
      await expect(heading).toContainText('Keyboard Shortcuts');
      await page.click('#helpModal .modal-close');
      await expect(modal).not.toBeVisible();
    });
  }, 30000);

  it('should open settings modal with 4 tabs', async () => {
    await withMetrics('settings-modal', async (page) => {
      await page.goto(BASE_URL);
      await page.click('.btn-settings');
      const modal = page.locator('#appSettingsModal .modal-content');
      await expect(modal).toBeVisible();
      const tabs = page.locator('#appSettingsModal .modal-tab-btn');
      await expect(tabs).toHaveCount(4);
      await page.click('#appSettingsModal .modal-close');
    });
  }, 30000);

  // ============================================================================
  // Session Management Tests
  // ============================================================================

  it('should create a new session via button click', async () => {
    await withMetrics('session-creation', async (page) => {
      await page.goto(BASE_URL);
      await page.click('.btn-claude');
      const sessionTab = page.locator('.session-tab');
      await expect(sessionTab.first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator('.session-tab.active')).toBeVisible();
      const terminal = page.locator('.xterm');
      await expect(terminal).toBeVisible({ timeout: 10000 });

      // Track session for cleanup
      const response = await fetch(`${BASE_URL}/api/sessions`);
      const data = await response.json();
      if (data.sessions?.length > 0) {
        const lastSession = data.sessions[data.sessions.length - 1];
        if (lastSession && !createdSessions.includes(lastSession.id)) {
          createdSessions.push(lastSession.id);
        }
      }
    });
  }, 60000);

  // ============================================================================
  // Stress Tests
  // ============================================================================

  it('should handle rapid modal interactions', async () => {
    await withMetrics('rapid-interactions', async (page) => {
      await page.goto(BASE_URL);
      for (let i = 0; i < 5; i++) {
        await page.click('.help-btn');
        await page.waitForSelector('#helpModal .modal-content', { state: 'visible' });
        await page.click('#helpModal .modal-close');
        await page.waitForSelector('#helpModal .modal-content', { state: 'hidden' });
      }
      await expect(page.locator('.header')).toBeVisible();
    });
  }, 30000);
});

// Export metrics for comparison
export { metrics as playwrightMetrics };

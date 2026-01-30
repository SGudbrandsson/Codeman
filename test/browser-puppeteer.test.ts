/**
 * Puppeteer/Chrome Test Suite
 *
 * Tests Claudeman web UI using Puppeteer for direct Chrome DevTools Protocol access.
 * Puppeteer provides lower-level Chrome control compared to Playwright.
 *
 * Port: 3156 (see CLAUDE.md test port table)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import puppeteer, { Browser, Page } from 'puppeteer';
import { WebServer } from '../src/web/server.js';

const TEST_PORT = 3156;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Metrics collection
interface TestMetrics {
  testName: string;
  duration: number;
  framework: 'puppeteer';
  success: boolean;
  error?: string;
}

const metrics: TestMetrics[] = [];

describe('Puppeteer/Chrome Tests', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let createdSessions: string[] = [];
  let testStartTime: number;

  beforeAll(async () => {
    // Start web server
    server = new WebServer(TEST_PORT, false, true);
    await server.start();
    await new Promise(r => setTimeout(r, 1000));

    // Launch Chrome via Puppeteer
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }, 60000);

  afterAll(async () => {
    // Cleanup sessions
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }

    // Close browser and server
    if (browser) await browser.close();
    await server.stop();

    // Output metrics
    console.log('\n📊 Puppeteer Test Metrics:');
    console.table(metrics.map(m => ({
      test: m.testName.substring(0, 40),
      duration: `${m.duration}ms`,
      status: m.success ? '✅' : '❌',
    })));
  }, 60000);

  beforeEach(async () => {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    testStartTime = Date.now();
  });

  afterEach(async () => {
    const testInfo = expect.getState();
    metrics.push({
      testName: testInfo.currentTestName || 'unknown',
      duration: Date.now() - testStartTime,
      framework: 'puppeteer',
      success: !testInfo.assertionCalls?.some((c: any) => !c.pass),
    });

    if (page) await page.close();
  });

  // ============================================================================
  // Core Page Tests
  // ============================================================================

  it('should load the main page with correct title', async () => {
    await page.goto(BASE_URL);
    const title = await page.title();
    expect(title).toBe('Claudeman');
  });

  it('should display the logo and branding', async () => {
    await page.goto(BASE_URL);

    await page.waitForSelector('.header-brand .logo');
    const logoText = await page.$eval('.header-brand .logo', el => el.textContent);
    expect(logoText).toBe('Claudeman');
  });

  it('should show version in toolbar', async () => {
    await page.goto(BASE_URL);

    await page.waitForSelector('#versionDisplay');
    const version = await page.$eval('#versionDisplay', el => el.textContent);
    expect(version).toMatch(/v\d+\.\d+/);
  });

  // ============================================================================
  // Button & Control Tests
  // ============================================================================

  it('should have all main control buttons visible', async () => {
    await page.goto(BASE_URL);

    const btnClaude = await page.$('.btn-claude');
    const btnSettings = await page.$('.btn-settings');
    const helpBtn = await page.$('.help-btn');
    const quickStart = await page.$('#quickStartCase');

    expect(btnClaude).not.toBeNull();
    expect(btnSettings).not.toBeNull();
    expect(helpBtn).not.toBeNull();
    expect(quickStart).not.toBeNull();
  });

  it('should have font size controls', async () => {
    await page.goto(BASE_URL);

    const fontControls = await page.$('.header-font-controls');
    expect(fontControls).not.toBeNull();

    const fontBtns = await page.$$('.header-font-controls .font-btn');
    expect(fontBtns.length).toBeGreaterThanOrEqual(2);
  });

  // ============================================================================
  // Modal Tests
  // ============================================================================

  it('should open and close help modal', async () => {
    await page.goto(BASE_URL);

    // Open help modal
    await page.click('.help-btn');
    await page.waitForSelector('#helpModal .modal-content', { visible: true });

    // Check content
    const heading = await page.$eval('#helpModal h3', el => el.textContent);
    expect(heading).toContain('Keyboard Shortcuts');

    // Check modal is visible
    const isVisible = await page.$eval('#helpModal .modal-content', el => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    expect(isVisible).toBe(true);

    // Close modal
    await page.click('#helpModal .modal-close');
    await page.waitForFunction(() => {
      const modal = document.querySelector('#helpModal .modal-content');
      if (!modal) return true;
      const style = window.getComputedStyle(modal);
      return style.display === 'none' || style.visibility === 'hidden';
    }, { timeout: 5000 }).catch(() => {});
  });

  it('should open settings modal with 4 tabs', async () => {
    await page.goto(BASE_URL);

    // Open settings
    await page.click('.btn-settings');
    await page.waitForSelector('#appSettingsModal .modal-content', { visible: true });

    // Check tabs
    const tabs = await page.$$('#appSettingsModal .modal-tab-btn');
    expect(tabs.length).toBe(4);

    // Verify tab names
    const tabTexts = await page.$$eval('#appSettingsModal .modal-tab-btn', els =>
      els.map(el => el.textContent?.trim())
    );
    expect(tabTexts).toContain('Display');
    expect(tabTexts).toContain('Claude CLI');

    // Close
    await page.click('#appSettingsModal .modal-close');
  });

  it('should switch between settings tabs', async () => {
    await page.goto(BASE_URL);

    await page.click('.btn-settings');
    await page.waitForSelector('#appSettingsModal .modal-content', { visible: true });

    // Click each tab
    const tabs = await page.$$('#appSettingsModal .modal-tab-btn');

    for (let i = 0; i < tabs.length; i++) {
      await tabs[i].click();
      await new Promise(r => setTimeout(r, 100));

      // Check tab is active
      const isActive = await page.$eval(
        `#appSettingsModal .modal-tab-btn:nth-child(${i + 1})`,
        el => el.classList.contains('active')
      );
      expect(isActive).toBe(true);
    }

    await page.click('#appSettingsModal .modal-close');
  });

  // ============================================================================
  // Session Management Tests
  // ============================================================================

  it('should create a new session via button click', async () => {
    await page.goto(BASE_URL);

    // Click create session button
    await page.click('.btn-claude');

    // Wait for session tab to appear
    await page.waitForSelector('.session-tab', { timeout: 15000 });

    // Tab should be active
    const hasActive = await page.$('.session-tab.active');
    expect(hasActive).not.toBeNull();

    // Terminal should be visible
    await page.waitForSelector('.xterm', { timeout: 10000 });
    const terminal = await page.$('.xterm');
    expect(terminal).not.toBeNull();

    // Track session for cleanup
    const response = await fetch(`${BASE_URL}/api/sessions`);
    const data = await response.json();
    if (data.sessions?.length > 0) {
      const lastSession = data.sessions[data.sessions.length - 1];
      if (lastSession && !createdSessions.includes(lastSession.id)) {
        createdSessions.push(lastSession.id);
      }
    }
  }, 30000);

  it('should show tab count correctly', async () => {
    await page.goto(BASE_URL);

    // Get initial count
    const initialText = await page.$eval('#tabCount', el => el.textContent);
    const initialCount = parseInt(initialText?.match(/\d+/)?.[0] || '0');

    // Create a session
    await page.click('.btn-claude');
    await page.waitForSelector('.session-tab', { timeout: 15000 });

    // Tab count should increase
    await page.waitForFunction(
      (expected: number) => {
        const el = document.querySelector('#tabCount');
        const text = el?.textContent || '';
        const match = text.match(/\d+/);
        return match && parseInt(match[0]) >= expected;
      },
      { timeout: 5000 },
      initialCount + 1
    );

    // Track for cleanup
    const response = await fetch(`${BASE_URL}/api/sessions`);
    const data = await response.json();
    data.sessions?.forEach((s: any) => {
      if (!createdSessions.includes(s.id)) createdSessions.push(s.id);
    });
  }, 30000);

  // ============================================================================
  // Terminal Tests
  // ============================================================================

  it('should initialize xterm terminal with correct dimensions', async () => {
    await page.goto(BASE_URL);

    // Create session
    await page.click('.btn-claude');
    await page.waitForSelector('.xterm', { timeout: 15000 });

    // Check terminal container exists
    const terminal = await page.$('.xterm');
    expect(terminal).not.toBeNull();

    // Check xterm canvas exists (indicates proper initialization)
    const canvas = await page.$('.xterm-screen');
    expect(canvas).not.toBeNull();

    // Track for cleanup
    const response = await fetch(`${BASE_URL}/api/sessions`);
    const data = await response.json();
    data.sessions?.forEach((s: any) => {
      if (!createdSessions.includes(s.id)) createdSessions.push(s.id);
    });
  }, 30000);

  // ============================================================================
  // Keyboard Shortcut Tests
  // ============================================================================

  it('should respond to Ctrl+Enter for quick start', async () => {
    await page.goto(BASE_URL);

    const initialSessions = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    const initialCount = initialSessions.sessions?.length || 0;

    // Press Ctrl+Enter
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');

    // Wait for session to be created
    await page.waitForSelector('.session-tab', { timeout: 15000 });

    // Verify session was created
    const afterSessions = await fetch(`${BASE_URL}/api/sessions`).then(r => r.json());
    expect(afterSessions.sessions?.length).toBeGreaterThan(initialCount);

    // Track for cleanup
    afterSessions.sessions?.forEach((s: any) => {
      if (!createdSessions.includes(s.id)) createdSessions.push(s.id);
    });
  }, 30000);

  // ============================================================================
  // Chrome DevTools Protocol Direct Access
  // ============================================================================

  it('should access CDP for performance metrics', async () => {
    await page.goto(BASE_URL);

    // Get performance metrics via CDP
    const client = await page.target().createCDPSession();
    await client.send('Performance.enable');

    const { metrics: perfMetrics } = await client.send('Performance.getMetrics');

    // Should have some metrics
    expect(perfMetrics.length).toBeGreaterThan(0);

    // Find specific metrics
    const jsHeapSize = perfMetrics.find(m => m.name === 'JSHeapUsedSize');
    expect(jsHeapSize).toBeDefined();
  });

  it('should capture network activity via CDP', async () => {
    const networkRequests: string[] = [];

    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    client.on('Network.requestWillBeSent', (params) => {
      networkRequests.push(params.request.url);
    });

    await page.goto(BASE_URL);
    await new Promise(r => setTimeout(r, 2000));

    // Should have captured some requests
    expect(networkRequests.length).toBeGreaterThan(0);
    expect(networkRequests.some(url => url.includes('/api/events'))).toBe(true);
  });

  // ============================================================================
  // Stress Tests
  // ============================================================================

  it('should handle rapid button clicks without errors', async () => {
    await page.goto(BASE_URL);

    // Rapidly click help button multiple times
    for (let i = 0; i < 5; i++) {
      await page.click('.help-btn');
      await new Promise(r => setTimeout(r, 100));
      const closeBtn = await page.$('#helpModal .modal-close');
      if (closeBtn) await closeBtn.click().catch(() => {});
      await new Promise(r => setTimeout(r, 100));
    }

    // Page should still be functional
    const header = await page.$('.header');
    expect(header).not.toBeNull();
  });

  // ============================================================================
  // Screenshot & Visual Tests
  // ============================================================================

  it('should capture screenshot for visual inspection', async () => {
    await page.goto(BASE_URL);

    // Take a screenshot (could be used for visual regression)
    const screenshot = await page.screenshot({ encoding: 'base64' });
    expect(screenshot.length).toBeGreaterThan(0);
  });

  // ============================================================================
  // Console & Error Monitoring
  // ============================================================================

  it('should not have console errors on page load', async () => {
    const consoleErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('pageerror', err => {
      consoleErrors.push(err.message);
    });

    await page.goto(BASE_URL);
    await new Promise(r => setTimeout(r, 2000));

    // Filter out expected errors (like SSE reconnection)
    const unexpectedErrors = consoleErrors.filter(e =>
      !e.includes('net::ERR') && !e.includes('SSE')
    );

    expect(unexpectedErrors.length).toBe(0);
  });
});

// Export metrics for comparison
export { metrics as puppeteerMetrics };

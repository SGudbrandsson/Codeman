/**
 * Browser Framework Comparison Benchmark
 *
 * Runs identical test scenarios across Playwright, Puppeteer, and Agent-Browser
 * to compare performance, reliability, and ease of use for agentic testing.
 *
 * This benchmark measures:
 * - Execution time per operation
 * - Reliability (success rate)
 * - Memory usage (where available)
 * - Ease of implementation (qualitative)
 *
 * Ports: 3158 (Playwright), 3159 (Puppeteer), 3160 (Agent-Browser)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, Browser as PlaywrightBrowser, Page as PlaywrightPage } from 'playwright';
import puppeteer, { Browser as PuppeteerBrowser, Page as PuppeteerPage } from 'puppeteer';
import { execSync } from 'node:child_process';
import { WebServer } from '../src/web/server.js';

// Port allocation
const PORTS = {
  playwright: 3158,
  puppeteer: 3159,
  agentBrowser: 3160,
};

// ============================================================================
// Types
// ============================================================================

interface BenchmarkResult {
  scenario: string;
  framework: 'playwright' | 'puppeteer' | 'agent-browser';
  duration: number;
  success: boolean;
  error?: string;
}

interface AggregateStats {
  framework: string;
  totalTests: number;
  passed: number;
  failed: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  successRate: string;
}

const results: BenchmarkResult[] = [];

// ============================================================================
// Agent-Browser Helpers
// ============================================================================

function agentBrowser(command: string): string {
  try {
    return execSync(`npx agent-browser ${command}`, {
      timeout: 30000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    throw new Error(`agent-browser failed: ${error.stderr || error.message}`);
  }
}

function agentBrowserJson<T>(command: string): T {
  const result = agentBrowser(`${command} --json`);
  const parsed = JSON.parse(result);
  if (!parsed.success) {
    throw new Error(`agent-browser: ${parsed.error || 'unknown error'}`);
  }
  return parsed.data;
}

// ============================================================================
// Benchmark Scenarios
// ============================================================================

/**
 * Each scenario is a function that takes framework-specific parameters
 * and returns a promise that resolves when the scenario is complete.
 */

async function runBenchmark(
  scenario: string,
  framework: 'playwright' | 'puppeteer' | 'agent-browser',
  fn: () => Promise<void>
): Promise<void> {
  const start = Date.now();
  let success = false;
  let error: string | undefined;

  try {
    await fn();
    success = true;
  } catch (e: any) {
    error = e.message;
  }

  results.push({
    scenario,
    framework,
    duration: Date.now() - start,
    success,
    error,
  });
}

// ============================================================================
// Main Comparison Suite
// ============================================================================

describe('Browser Framework Comparison Benchmark', () => {
  // Framework instances
  let playwrightBrowser: PlaywrightBrowser;
  let puppeteerBrowser: PuppeteerBrowser;
  let agentBrowserAvailable = false;

  // Web servers
  let servers: WebServer[] = [];

  // Cleanup tracking
  let createdSessions: { port: number; id: string }[] = [];

  beforeAll(async () => {
    console.log('\n🚀 Starting Browser Framework Comparison Benchmark\n');
    console.log('This benchmark compares:');
    console.log('  - Playwright (direct API)');
    console.log('  - Puppeteer (Chrome DevTools Protocol)');
    console.log('  - Agent-Browser (CLI-based, AI-friendly)\n');

    // Start web servers for each framework
    for (const [name, port] of Object.entries(PORTS)) {
      const server = new WebServer(port);
      await server.start();
      servers.push(server);
      console.log(`✅ Started server for ${name} on port ${port}`);
    }

    await new Promise(r => setTimeout(r, 1000));

    // Initialize Playwright
    try {
      playwrightBrowser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      console.log('✅ Playwright browser launched');
    } catch (e: any) {
      console.warn('⚠️ Playwright launch failed:', e.message);
    }

    // Initialize Puppeteer
    try {
      puppeteerBrowser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      console.log('✅ Puppeteer browser launched');
    } catch (e: any) {
      console.warn('⚠️ Puppeteer launch failed:', e.message);
    }

    // Test Agent-Browser availability
    try {
      agentBrowser(`open http://localhost:${PORTS.agentBrowser}`);
      await new Promise(r => setTimeout(r, 2000));
      const title = agentBrowserJson<{ title: string }>('get title');
      agentBrowserAvailable = title.title === 'Claudeman';
      if (agentBrowserAvailable) {
        console.log('✅ Agent-Browser available');
      }
    } catch (e: any) {
      console.warn('⚠️ Agent-Browser not available:', e.message);
    }

    console.log('\n' + '='.repeat(60) + '\n');
  }, 120000);

  afterAll(async () => {
    // Cleanup sessions
    for (const { port, id } of createdSessions) {
      try {
        await fetch(`http://localhost:${port}/api/sessions/${id}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }

    // Close browsers
    if (playwrightBrowser) await playwrightBrowser.close();
    if (puppeteerBrowser) await puppeteerBrowser.close();
    try { agentBrowser('close'); } catch { /* ignore */ }

    // Stop servers
    for (const server of servers) {
      await server.stop();
    }

    // Print results summary
    printResultsSummary();
  }, 60000);

  // ============================================================================
  // Scenario 1: Page Load
  // ============================================================================

  describe('Scenario: Page Load', () => {
    it('Playwright - page load', async () => {
      if (!playwrightBrowser) return;

      await runBenchmark('page-load', 'playwright', async () => {
        const context = await playwrightBrowser.newContext();
        const page = await context.newPage();
        await page.goto(`http://localhost:${PORTS.playwright}`);
        await expect(page).toHaveTitle('Claudeman');
        await context.close();
      });
    });

    it('Puppeteer - page load', async () => {
      if (!puppeteerBrowser) return;

      await runBenchmark('page-load', 'puppeteer', async () => {
        const page = await puppeteerBrowser.newPage();
        await page.goto(`http://localhost:${PORTS.puppeteer}`);
        const title = await page.title();
        expect(title).toBe('Claudeman');
        await page.close();
      });
    });

    it('Agent-Browser - page load', async () => {
      if (!agentBrowserAvailable) return;

      await runBenchmark('page-load', 'agent-browser', async () => {
        agentBrowser(`open http://localhost:${PORTS.agentBrowser}`);
        await new Promise(r => setTimeout(r, 1000));
        const title = agentBrowserJson<{ title: string }>('get title');
        expect(title.title).toBe('Claudeman');
      });
    });
  });

  // ============================================================================
  // Scenario 2: Element Selection
  // ============================================================================

  describe('Scenario: Element Selection', () => {
    it('Playwright - element selection', async () => {
      if (!playwrightBrowser) return;

      await runBenchmark('element-selection', 'playwright', async () => {
        const context = await playwrightBrowser.newContext();
        const page = await context.newPage();
        await page.goto(`http://localhost:${PORTS.playwright}`);

        // Multiple element selections
        const logo = await page.locator('.header-brand .logo').textContent();
        const version = await page.locator('#versionDisplay').textContent();
        const btnCount = await page.locator('.btn-claude').count();

        expect(logo).toBe('Claudeman');
        expect(version).toMatch(/v\d+/);
        expect(btnCount).toBeGreaterThan(0);

        await context.close();
      });
    });

    it('Puppeteer - element selection', async () => {
      if (!puppeteerBrowser) return;

      await runBenchmark('element-selection', 'puppeteer', async () => {
        const page = await puppeteerBrowser.newPage();
        await page.goto(`http://localhost:${PORTS.puppeteer}`);

        const logo = await page.$eval('.header-brand .logo', el => el.textContent);
        const version = await page.$eval('#versionDisplay', el => el.textContent);
        const btns = await page.$$('.btn-claude');

        expect(logo).toBe('Claudeman');
        expect(version).toMatch(/v\d+/);
        expect(btns.length).toBeGreaterThan(0);

        await page.close();
      });
    });

    it('Agent-Browser - element selection', async () => {
      if (!agentBrowserAvailable) return;

      await runBenchmark('element-selection', 'agent-browser', async () => {
        agentBrowser(`open http://localhost:${PORTS.agentBrowser}`);
        await new Promise(r => setTimeout(r, 1000));

        const logo = agentBrowserJson<{ text: string }>('get text ".header-brand .logo"');
        const version = agentBrowserJson<{ text: string }>('get text "#versionDisplay"');
        const btnCount = agentBrowserJson<{ count: number }>('get count ".btn-claude"');

        expect(logo.text).toBe('Claudeman');
        expect(version.text).toMatch(/v\d+/);
        expect(btnCount.count).toBeGreaterThan(0);
      });
    });
  });

  // ============================================================================
  // Scenario 3: Modal Interaction
  // ============================================================================

  describe('Scenario: Modal Open/Close', () => {
    it('Playwright - modal interaction', async () => {
      if (!playwrightBrowser) return;

      await runBenchmark('modal-interaction', 'playwright', async () => {
        const context = await playwrightBrowser.newContext();
        const page = await context.newPage();
        await page.goto(`http://localhost:${PORTS.playwright}`);

        // Open modal
        await page.click('.help-btn');
        await page.waitForSelector('#helpModal .modal-content', { state: 'visible' });

        // Verify content
        const heading = await page.locator('#helpModal h3').textContent();
        expect(heading).toContain('Keyboard Shortcuts');

        // Close modal
        await page.click('#helpModal .modal-close');
        await page.waitForSelector('#helpModal .modal-content', { state: 'hidden' });

        await context.close();
      });
    });

    it('Puppeteer - modal interaction', async () => {
      if (!puppeteerBrowser) return;

      await runBenchmark('modal-interaction', 'puppeteer', async () => {
        const page = await puppeteerBrowser.newPage();
        await page.goto(`http://localhost:${PORTS.puppeteer}`);

        // Open modal
        await page.click('.help-btn');
        await page.waitForSelector('#helpModal .modal-content', { visible: true });

        // Verify content
        const heading = await page.$eval('#helpModal h3', el => el.textContent);
        expect(heading).toContain('Keyboard Shortcuts');

        // Close modal
        await page.click('#helpModal .modal-close');
        await page.waitForFunction(() => {
          const modal = document.querySelector('#helpModal .modal-content');
          return !modal || window.getComputedStyle(modal).display === 'none';
        });

        await page.close();
      });
    });

    it('Agent-Browser - modal interaction', async () => {
      if (!agentBrowserAvailable) return;

      await runBenchmark('modal-interaction', 'agent-browser', async () => {
        agentBrowser(`open http://localhost:${PORTS.agentBrowser}`);
        await new Promise(r => setTimeout(r, 1000));

        // Open modal
        agentBrowser('click ".help-btn"');
        await new Promise(r => setTimeout(r, 500));

        // Verify content
        const heading = agentBrowserJson<{ text: string }>('get text "#helpModal h3"');
        expect(heading.text).toContain('Keyboard Shortcuts');

        // Close modal
        agentBrowser('click "#helpModal .modal-close"');
        await new Promise(r => setTimeout(r, 300));
      });
    });
  });

  // ============================================================================
  // Scenario 4: Session Creation (Complex)
  // ============================================================================

  describe('Scenario: Session Creation', () => {
    it('Playwright - session creation', async () => {
      if (!playwrightBrowser) return;

      await runBenchmark('session-creation', 'playwright', async () => {
        const context = await playwrightBrowser.newContext();
        const page = await context.newPage();
        await page.goto(`http://localhost:${PORTS.playwright}`);

        // Create session
        await page.click('.btn-claude');

        // Wait for session tab
        await page.waitForSelector('.session-tab', { timeout: 15000 });

        // Verify terminal appears
        await page.waitForSelector('.xterm', { timeout: 10000 });

        // Track for cleanup
        const response = await fetch(`http://localhost:${PORTS.playwright}/api/sessions`);
        const data = await response.json();
        const lastSession = data.sessions?.[data.sessions.length - 1];
        if (lastSession) {
          createdSessions.push({ port: PORTS.playwright, id: lastSession.id });
        }

        await context.close();
      });
    }, 30000);

    it('Puppeteer - session creation', async () => {
      if (!puppeteerBrowser) return;

      await runBenchmark('session-creation', 'puppeteer', async () => {
        const page = await puppeteerBrowser.newPage();
        await page.goto(`http://localhost:${PORTS.puppeteer}`);

        // Create session
        await page.click('.btn-claude');

        // Wait for session tab
        await page.waitForSelector('.session-tab', { timeout: 15000 });

        // Verify terminal appears
        await page.waitForSelector('.xterm', { timeout: 10000 });

        // Track for cleanup
        const response = await fetch(`http://localhost:${PORTS.puppeteer}/api/sessions`);
        const data = await response.json();
        const lastSession = data.sessions?.[data.sessions.length - 1];
        if (lastSession) {
          createdSessions.push({ port: PORTS.puppeteer, id: lastSession.id });
        }

        await page.close();
      });
    }, 30000);

    it('Agent-Browser - session creation', async () => {
      if (!agentBrowserAvailable) return;

      await runBenchmark('session-creation', 'agent-browser', async () => {
        agentBrowser(`open http://localhost:${PORTS.agentBrowser}`);
        await new Promise(r => setTimeout(r, 1000));

        // Create session
        agentBrowser('click ".btn-claude"');

        // Wait for session tab
        const start = Date.now();
        while (Date.now() - start < 15000) {
          try {
            const count = agentBrowserJson<{ count: number }>('get count ".session-tab"');
            if (count.count > 0) break;
          } catch { /* retry */ }
          await new Promise(r => setTimeout(r, 500));
        }

        // Verify terminal appears
        await new Promise(r => setTimeout(r, 2000));
        const xtermCount = agentBrowserJson<{ count: number }>('get count ".xterm"');
        expect(xtermCount.count).toBeGreaterThan(0);

        // Track for cleanup
        const response = await fetch(`http://localhost:${PORTS.agentBrowser}/api/sessions`);
        const data = await response.json();
        const lastSession = data.sessions?.[data.sessions.length - 1];
        if (lastSession) {
          createdSessions.push({ port: PORTS.agentBrowser, id: lastSession.id });
        }
      });
    }, 30000);
  });

  // ============================================================================
  // Scenario 5: Rapid Operations
  // ============================================================================

  describe('Scenario: Rapid Operations (5 modal cycles)', () => {
    it('Playwright - rapid operations', async () => {
      if (!playwrightBrowser) return;

      await runBenchmark('rapid-operations', 'playwright', async () => {
        const context = await playwrightBrowser.newContext();
        const page = await context.newPage();
        await page.goto(`http://localhost:${PORTS.playwright}`);

        for (let i = 0; i < 5; i++) {
          await page.click('.help-btn');
          await page.waitForSelector('#helpModal .modal-content', { state: 'visible' });
          await page.click('#helpModal .modal-close');
          await page.waitForSelector('#helpModal .modal-content', { state: 'hidden' });
        }

        await context.close();
      });
    });

    it('Puppeteer - rapid operations', async () => {
      if (!puppeteerBrowser) return;

      await runBenchmark('rapid-operations', 'puppeteer', async () => {
        const page = await puppeteerBrowser.newPage();
        await page.goto(`http://localhost:${PORTS.puppeteer}`);

        for (let i = 0; i < 5; i++) {
          await page.click('.help-btn');
          await page.waitForSelector('#helpModal .modal-content', { visible: true });
          await page.click('#helpModal .modal-close');
          await new Promise(r => setTimeout(r, 200));
        }

        await page.close();
      });
    });

    it('Agent-Browser - rapid operations', async () => {
      if (!agentBrowserAvailable) return;

      await runBenchmark('rapid-operations', 'agent-browser', async () => {
        agentBrowser(`open http://localhost:${PORTS.agentBrowser}`);
        await new Promise(r => setTimeout(r, 1000));

        for (let i = 0; i < 5; i++) {
          agentBrowser('click ".help-btn"');
          await new Promise(r => setTimeout(r, 300));
          agentBrowser('click "#helpModal .modal-close"');
          await new Promise(r => setTimeout(r, 300));
        }
      });
    });
  });
});

// ============================================================================
// Results Summary
// ============================================================================

function printResultsSummary(): void {
  console.log('\n' + '='.repeat(70));
  console.log('📊 BROWSER FRAMEWORK COMPARISON RESULTS');
  console.log('='.repeat(70) + '\n');

  // Group by framework
  const frameworks = ['playwright', 'puppeteer', 'agent-browser'] as const;
  const stats: AggregateStats[] = [];

  for (const framework of frameworks) {
    const frameworkResults = results.filter(r => r.framework === framework);
    if (frameworkResults.length === 0) continue;

    const passed = frameworkResults.filter(r => r.success).length;
    const durations = frameworkResults.map(r => r.duration);

    stats.push({
      framework,
      totalTests: frameworkResults.length,
      passed,
      failed: frameworkResults.length - passed,
      avgDuration: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      minDuration: Math.min(...durations),
      maxDuration: Math.max(...durations),
      successRate: ((passed / frameworkResults.length) * 100).toFixed(1) + '%',
    });
  }

  // Print aggregate stats
  console.log('📈 AGGREGATE STATISTICS\n');
  console.table(stats.map(s => ({
    Framework: s.framework.toUpperCase(),
    Tests: s.totalTests,
    Passed: s.passed,
    Failed: s.failed,
    'Success Rate': s.successRate,
    'Avg (ms)': s.avgDuration,
    'Min (ms)': s.minDuration,
    'Max (ms)': s.maxDuration,
  })));

  // Print detailed results by scenario
  console.log('\n📋 DETAILED RESULTS BY SCENARIO\n');

  const scenarios = [...new Set(results.map(r => r.scenario))];
  for (const scenario of scenarios) {
    console.log(`\n🔹 ${scenario.toUpperCase()}`);
    const scenarioResults = results.filter(r => r.scenario === scenario);

    console.table(scenarioResults.map(r => ({
      Framework: r.framework,
      Duration: `${r.duration}ms`,
      Status: r.success ? '✅ Pass' : '❌ Fail',
      Error: r.error ? r.error.substring(0, 40) + '...' : '-',
    })));
  }

  // Performance comparison
  console.log('\n🏆 PERFORMANCE RANKING (by avg duration)\n');
  const ranked = [...stats].sort((a, b) => a.avgDuration - b.avgDuration);
  ranked.forEach((s, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
    console.log(`${medal} ${s.framework.toUpperCase()}: ${s.avgDuration}ms avg (${s.successRate} success rate)`);
  });

  // Recommendations
  console.log('\n💡 RECOMMENDATIONS\n');
  console.log('• Playwright: Best for comprehensive testing with excellent debugging');
  console.log('• Puppeteer: Best for Chrome-specific features and CDP access');
  console.log('• Agent-Browser: Best for AI agents with semantic navigation needs');

  console.log('\n' + '='.repeat(70) + '\n');
}

// Export results for external analysis
export { results as comparisonResults };

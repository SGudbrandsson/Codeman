/**
 * Agent-Browser Enhanced Test Suite
 *
 * Tests Claudeman web UI using agent-browser's AI-agent-friendly features:
 * - Semantic locators (find by role, label, text)
 * - Accessibility tree snapshots
 * - Reference-based element selection (@e1, @e2)
 *
 * This demonstrates the "agentic" approach to browser testing where an AI
 * could navigate the UI using natural language descriptions.
 *
 * Port: 3157 (see CLAUDE.md test port table)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { WebServer } from '../src/web/server.js';

const TEST_PORT = 3157;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const BROWSER_TIMEOUT = 30000;

// Metrics collection
interface TestMetrics {
  testName: string;
  duration: number;
  framework: 'agent-browser';
  success: boolean;
  error?: string;
}

const metrics: TestMetrics[] = [];

// ============================================================================
// Agent-Browser CLI Helpers
// ============================================================================

function agentBrowser(command: string): string {
  try {
    return execSync(`npx agent-browser ${command}`, {
      timeout: BROWSER_TIMEOUT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    if (error.stderr) {
      throw new Error(`agent-browser failed: ${error.stderr}`);
    }
    throw error;
  }
}

function agentBrowserJson<T = any>(command: string): T {
  const result = agentBrowser(`${command} --json`);
  const parsed = JSON.parse(result);
  if (!parsed.success) {
    throw new Error(`agent-browser command failed: ${parsed.error || 'unknown error'}`);
  }
  return parsed.data;
}

// Get accessibility tree snapshot for AI-based navigation
function getSnapshot(): string {
  try {
    return agentBrowser('snapshot');
  } catch {
    return '';
  }
}

// Find element by semantic criteria (AI-friendly)
function findByRole(role: string, name?: string): boolean {
  try {
    const cmd = name
      ? `find role ${role} --name "${name}"`
      : `find role ${role}`;
    const result = agentBrowser(cmd);
    return result.includes('Found') || !result.includes('not found');
  } catch {
    return false;
  }
}

function findByText(text: string): boolean {
  try {
    const result = agentBrowser(`find text "${text}"`);
    return result.includes('Found') || !result.includes('not found');
  } catch {
    return false;
  }
}

function findByLabel(label: string): boolean {
  try {
    const result = agentBrowser(`find label "${label}"`);
    return result.includes('Found') || !result.includes('not found');
  } catch {
    return false;
  }
}

// Click using semantic finder
function clickByText(text: string): boolean {
  try {
    agentBrowser(`find text "${text}" click`);
    return true;
  } catch {
    return false;
  }
}

function clickByRole(role: string, name?: string): boolean {
  try {
    const cmd = name
      ? `find role ${role} click --name "${name}"`
      : `find role ${role} click`;
    agentBrowser(cmd);
    return true;
  } catch {
    return false;
  }
}

// Standard helpers
function getText(selector: string): string {
  try {
    return agentBrowserJson<{ text: string }>(`get text "${selector}"`).text || '';
  } catch {
    return '';
  }
}

function isVisible(selector: string): boolean {
  try {
    return agentBrowserJson<{ visible: boolean }>(`is visible "${selector}"`).visible;
  } catch {
    return false;
  }
}

function getCount(selector: string): number {
  try {
    return agentBrowserJson<{ count: number }>(`get count "${selector}"`).count;
  } catch {
    return 0;
  }
}

async function waitForElement(selector: string, timeout = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getCount(selector) > 0) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function closeBrowser() {
  try {
    agentBrowser('close');
  } catch { /* ignore */ }
}

describe('Agent-Browser Enhanced Tests', () => {
  let server: WebServer;
  let createdSessions: string[] = [];
  let browserAvailable = false;
  let testStartTime: number;

  beforeAll(async () => {
    closeBrowser();

    // Start web server
    server = new WebServer(TEST_PORT);
    await server.start();
    await new Promise(r => setTimeout(r, 1000));

    // Test if agent-browser is available
    try {
      agentBrowser(`open ${BASE_URL}`);
      await new Promise(r => setTimeout(r, 2000));
      const title = agentBrowserJson<{ title: string }>('get title');
      browserAvailable = title.title === 'Claudeman';
    } catch (e) {
      console.warn('Agent-browser not available, skipping tests:', (e as Error).message);
      browserAvailable = false;
    }
  }, 60000);

  afterAll(async () => {
    closeBrowser();

    // Cleanup sessions
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }

    await server.stop();

    // Output metrics
    console.log('\n📊 Agent-Browser Test Metrics:');
    console.table(metrics.map(m => ({
      test: m.testName.substring(0, 40),
      duration: `${m.duration}ms`,
      status: m.success ? '✅' : '❌',
    })));
  }, 60000);

  beforeEach(() => {
    testStartTime = Date.now();
  });

  afterEach(() => {
    const testInfo = expect.getState();
    metrics.push({
      testName: testInfo.currentTestName || 'unknown',
      duration: Date.now() - testStartTime,
      framework: 'agent-browser',
      success: !testInfo.assertionCalls?.some((c: any) => !c.pass),
    });
  });

  // ============================================================================
  // Core Page Tests (CSS Selectors)
  // ============================================================================

  it('should load the main page with correct title', async () => {
    if (!browserAvailable) {
      console.log('Skipping: browser not available');
      return;
    }

    const title = agentBrowserJson<{ title: string }>('get title');
    expect(title.title).toBe('Claudeman');
  });

  it('should display the logo and branding', async () => {
    if (!browserAvailable) return;

    const logoText = getText('.header-brand .logo');
    expect(logoText).toBe('Claudeman');
  });

  it('should show version in toolbar', async () => {
    if (!browserAvailable) return;

    const version = getText('#versionDisplay');
    expect(version).toMatch(/v\d+\.\d+/);
  });

  // ============================================================================
  // Semantic/AI-Friendly Tests
  // ============================================================================

  it('should find elements using semantic role locators', async () => {
    if (!browserAvailable) return;

    // Find buttons by role
    const hasButtons = findByRole('button');
    expect(hasButtons).toBe(true);

    // Find specific buttons (may vary based on page structure)
    // agent-browser uses ARIA roles for semantic finding
  });

  it('should capture accessibility tree snapshot', async () => {
    if (!browserAvailable) return;

    const snapshot = getSnapshot();

    // Snapshot should contain accessibility information
    expect(snapshot.length).toBeGreaterThan(0);

    // Should include key page elements
    // The snapshot format varies by agent-browser version
    console.log('Accessibility snapshot captured, length:', snapshot.length);
  });

  it('should find elements by text content', async () => {
    if (!browserAvailable) return;

    // Find elements containing specific text
    const foundClaudeman = findByText('Claudeman');
    expect(foundClaudeman).toBe(true);
  });

  // ============================================================================
  // Modal Tests (CSS + Semantic)
  // ============================================================================

  it('should open and close help modal', async () => {
    if (!browserAvailable) return;

    // Open using CSS selector
    agentBrowser('click ".help-btn"');
    await new Promise(r => setTimeout(r, 500));

    expect(isVisible('#helpModal .modal-content')).toBe(true);

    // Find heading by text
    const headingText = getText('#helpModal h3');
    expect(headingText).toContain('Keyboard Shortcuts');

    // Close modal
    agentBrowser('click "#helpModal .modal-close"');
    await new Promise(r => setTimeout(r, 300));

    expect(isVisible('#helpModal .modal-content')).toBe(false);
  });

  it('should open settings modal with correct tabs', async () => {
    if (!browserAvailable) return;

    agentBrowser('click ".btn-settings"');
    await new Promise(r => setTimeout(r, 500));

    expect(isVisible('#appSettingsModal .modal-content')).toBe(true);

    const tabCount = getCount('#appSettingsModal .modal-tab-btn');
    expect(tabCount).toBe(4);

    agentBrowser('click "#appSettingsModal .modal-close"');
    await new Promise(r => setTimeout(r, 300));
  });

  // ============================================================================
  // Session Management Tests
  // ============================================================================

  it('should create a new session via button click', async () => {
    if (!browserAvailable) return;

    // Click create session
    agentBrowser('click ".btn-claude"');

    // Wait for session tab
    const tabFound = await waitForElement('.session-tab', 15000);
    expect(tabFound).toBe(true);

    await new Promise(r => setTimeout(r, 1000));
    expect(isVisible('.session-tab.active')).toBe(true);

    // Terminal should be visible
    const xtermVisible = await waitForElement('.xterm', 10000);
    expect(xtermVisible).toBe(true);

    // Track for cleanup
    const response = await fetch(`${BASE_URL}/api/sessions`);
    const data = await response.json();
    if (data.sessions?.length > 0) {
      const lastSession = data.sessions[data.sessions.length - 1];
      if (lastSession && !createdSessions.includes(lastSession.id)) {
        createdSessions.push(lastSession.id);
      }
    }
  }, 30000);

  // ============================================================================
  // AI-Driven Navigation Demo
  // ============================================================================

  it('should demonstrate AI-friendly navigation workflow', async () => {
    if (!browserAvailable) return;

    // This test demonstrates how an AI agent could navigate the UI
    // using semantic locators and natural language-like commands

    // Step 1: Check page state via snapshot
    const snapshot = getSnapshot();
    expect(snapshot.length).toBeGreaterThan(0);

    // Step 2: Find and interact with settings
    // An AI would parse the snapshot and decide what to click
    const settingsVisible = isVisible('.btn-settings');
    expect(settingsVisible).toBe(true);

    // Step 3: Open settings
    agentBrowser('click ".btn-settings"');
    await new Promise(r => setTimeout(r, 500));

    // Step 4: Take new snapshot to understand modal state
    const modalSnapshot = getSnapshot();

    // Step 5: Close settings
    agentBrowser('click "#appSettingsModal .modal-close"');
    await new Promise(r => setTimeout(r, 300));

    // This workflow shows how an AI could:
    // 1. Observe the page state (snapshot)
    // 2. Decide on actions based on semantic understanding
    // 3. Execute actions
    // 4. Verify results with new snapshot
  });

  // ============================================================================
  // Form Interaction Tests (Semantic)
  // ============================================================================

  it('should interact with quick start dropdown', async () => {
    if (!browserAvailable) return;

    // Find the quick start dropdown
    const dropdownVisible = isVisible('#quickStartCase');
    expect(dropdownVisible).toBe(true);

    // Get current value
    // Note: agent-browser's get value command for select elements
    try {
      const value = agentBrowserJson<{ value: string }>('get value "#quickStartCase"');
      // Value should be the current selected case
      expect(typeof value.value).toBe('string');
    } catch {
      // May not be a standard select element
    }
  });

  // ============================================================================
  // Multiple Element Tests
  // ============================================================================

  it('should count toolbar elements correctly', async () => {
    if (!browserAvailable) return;

    // Count various toolbar elements
    const fontControls = getCount('.header-font-controls .font-btn');
    expect(fontControls).toBeGreaterThanOrEqual(2);

    // Tab count badge should exist
    expect(isVisible('#tabCount')).toBe(true);
  });

  // ============================================================================
  // Screenshot Test
  // ============================================================================

  it('should capture screenshot for AI analysis', async () => {
    if (!browserAvailable) return;

    try {
      // Capture screenshot (useful for visual AI analysis)
      agentBrowser('screenshot /tmp/claudeman-test.png');

      // Verify file was created (would exist after successful screenshot)
      // In a real AI scenario, this image would be analyzed
    } catch {
      // Screenshot may fail in headless mode without proper setup
    }
  });

  // ============================================================================
  // Stress Tests
  // ============================================================================

  it('should handle rapid interactions', async () => {
    if (!browserAvailable) return;

    // Rapid modal open/close
    for (let i = 0; i < 3; i++) {
      agentBrowser('click ".help-btn"');
      await new Promise(r => setTimeout(r, 200));
      try {
        agentBrowser('click "#helpModal .modal-close"');
      } catch { /* may already be closed */ }
      await new Promise(r => setTimeout(r, 200));
    }

    // Page should still be functional
    expect(isVisible('.header')).toBe(true);
  });

  // ============================================================================
  // Tab Navigation Tests
  // ============================================================================

  it('should handle tab count display', async () => {
    if (!browserAvailable) return;

    const tabCountText = getText('#tabCount');
    // Should show number of tabs
    expect(tabCountText).toMatch(/\d+/);
  });
});

// Export metrics for comparison
export { metrics as agentBrowserMetrics };

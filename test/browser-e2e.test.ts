/**
 * Browser E2E Tests for Claudeman Web UI
 *
 * Uses agent-browser (which wraps Playwright) for browser automation.
 * These tests verify the web interface works correctly from a user perspective.
 *
 * Port allocation: 3150-3153 (see CLAUDE.md test port table)
 *
 * NOTE: Browser tests require agent-browser daemon to be responsive.
 * API-only tests (SSE, Hook, Ralph) run without browser dependency.
 *
 * Run just API tests: npx vitest run test/browser-e2e.test.ts -t "API"
 * Run just browser tests: npx vitest run test/browser-e2e.test.ts -t "Browser"
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { WebServer } from '../src/web/server.js';

// ============================================================================
// Browser E2E Tests (require agent-browser daemon)
// ============================================================================

const TEST_PORT_BROWSER = 3150;
const browserBaseUrl = `http://localhost:${TEST_PORT_BROWSER}`;
const BROWSER_TIMEOUT = 30000;

// Helper to run agent-browser commands
function browser(command: string): string {
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

function browserJson<T = any>(command: string): T {
  const result = browser(`${command} --json`);
  const parsed = JSON.parse(result);
  if (!parsed.success) {
    throw new Error(`agent-browser command failed: ${parsed.error || 'unknown error'}`);
  }
  return parsed.data;
}

async function waitForElement(selector: string, timeout = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const count = browserJson<{ count: number }>(`get count "${selector}"`);
      if (count.count > 0) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function getText(selector: string): string {
  try {
    return browserJson<{ text: string }>(`get text "${selector}"`).text || '';
  } catch {
    return '';
  }
}

function isVisible(selector: string): boolean {
  try {
    return browserJson<{ visible: boolean }>(`is visible "${selector}"`).visible;
  } catch {
    return false;
  }
}

function closeBrowser() {
  try {
    browser('close');
  } catch { /* ignore */ }
}

describe('Browser E2E Tests', () => {
  let server: WebServer;
  let createdSessions: string[] = [];
  let browserAvailable = false;

  beforeAll(async () => {
    closeBrowser();

    server = new WebServer(TEST_PORT_BROWSER, false, true);
    await server.start();
    await new Promise(r => setTimeout(r, 1000));

    // Test if browser is available
    try {
      browser(`open ${browserBaseUrl}`);
      await new Promise(r => setTimeout(r, 2000));
      const title = browserJson<{ title: string }>('get title');
      browserAvailable = title.title === 'Claudeman';
    } catch (e) {
      console.warn('Browser not available, skipping browser tests:', (e as Error).message);
      browserAvailable = false;
    }
  }, 60000);

  afterAll(async () => {
    closeBrowser();
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${browserBaseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }
    await server.stop();
  }, 60000);

  it('should load the Claudeman web interface', async () => {
    if (!browserAvailable) {
      console.log('Skipping: browser not available');
      return;
    }

    const title = browserJson<{ title: string }>('get title');
    expect(title.title).toBe('Claudeman');

    const logoText = getText('.header-brand .logo');
    expect(logoText).toBe('Claudeman');

    expect(isVisible('.btn-claude')).toBe(true);
  }, 60000);

  it('should open and close help modal', async () => {
    if (!browserAvailable) return;

    browser('click ".help-btn"');
    await new Promise(r => setTimeout(r, 500));

    expect(isVisible('#helpModal .modal-content')).toBe(true);
    expect(getText('#helpModal h3')).toContain('Keyboard Shortcuts');

    browser('click "#helpModal .modal-close"');
    await new Promise(r => setTimeout(r, 300));

    expect(isVisible('#helpModal .modal-content')).toBe(false);
  }, 60000);

  it('should open settings modal with correct tabs', async () => {
    if (!browserAvailable) return;

    browser('click ".btn-settings"');
    await new Promise(r => setTimeout(r, 500));

    expect(isVisible('#appSettingsModal .modal-content')).toBe(true);

    const tabCount = browserJson<{ count: number }>('get count "#appSettingsModal .modal-tab-btn"');
    expect(tabCount.count).toBe(4);

    browser('click "#appSettingsModal .modal-close"');
    await new Promise(r => setTimeout(r, 300));
  }, 60000);

  it('should have all toolbar elements', async () => {
    if (!browserAvailable) return;

    expect(isVisible('.header-font-controls')).toBe(true);
    expect(isVisible('#tabCount')).toBe(true);
    expect(isVisible('#quickStartCase')).toBe(true);

    const versionText = getText('#versionDisplay');
    expect(versionText).toMatch(/v\d+\.\d+/);
  }, 60000);

  it('should create session and show terminal', async () => {
    if (!browserAvailable) return;

    browser('click ".btn-claude"');

    const tabFound = await waitForElement('.session-tab', 15000);
    expect(tabFound).toBe(true);

    await new Promise(r => setTimeout(r, 1000));
    expect(isVisible('.session-tab.active')).toBe(true);

    const xtermVisible = await waitForElement('.xterm', 10000);
    expect(xtermVisible).toBe(true);

    // Track for cleanup
    const response = await fetch(`${browserBaseUrl}/api/sessions`);
    const data = await response.json();
    if (data.sessions?.length > 0) {
      const lastSession = data.sessions[data.sessions.length - 1];
      if (lastSession && !createdSessions.includes(lastSession.id)) {
        createdSessions.push(lastSession.id);
      }
    }
  }, 90000);
});

// ============================================================================
// API Tests (no browser dependency)
// ============================================================================

describe('SSE Events API', () => {
  let server: WebServer;
  const TEST_PORT_SSE = 3151;
  const sseBaseUrl = `http://localhost:${TEST_PORT_SSE}`;
  let createdSessions: string[] = [];

  beforeAll(async () => {
    server = new WebServer(TEST_PORT_SSE, false, true);
    await server.start();
    await new Promise(r => setTimeout(r, 1000));
  }, 30000);

  afterAll(async () => {
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${sseBaseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }
    await server.stop();
  }, 60000);

  it('should connect to SSE endpoint', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    try {
      const response = await fetch(`${sseBaseUrl}/api/events`, {
        signal: controller.signal,
        headers: { 'Accept': 'text/event-stream' },
      });

      expect(response.headers.get('content-type')).toBe('text/event-stream');
    } catch (err: any) {
      if (err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timeout);
    }
  });

  it('should receive init event on connection', async () => {
    const controller = new AbortController();
    let receivedData = '';
    const timeout = setTimeout(() => controller.abort(), 2000);

    try {
      const response = await fetch(`${sseBaseUrl}/api/events`, {
        signal: controller.signal,
      });

      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedData += new TextDecoder().decode(value);
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timeout);
    }

    // Should contain init event
    expect(receivedData).toContain('event: init');
    expect(receivedData).toContain('"sessions"');
  });
});

describe('Hook Events API', () => {
  let server: WebServer;
  const TEST_PORT_HOOK = 3152;
  const hookBaseUrl = `http://localhost:${TEST_PORT_HOOK}`;
  let createdSessions: string[] = [];

  beforeAll(async () => {
    server = new WebServer(TEST_PORT_HOOK, false, true);
    await server.start();
    await new Promise(r => setTimeout(r, 1000));
  }, 30000);

  afterAll(async () => {
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${hookBaseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }
    await server.stop();
  }, 60000);

  it('should accept hook events via API', async () => {
    // Create a session
    const createRes = await fetch(`${hookBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    const createData = await createRes.json();
    expect(createData.success).toBe(true);
    const sessionId = createData.session.id;
    createdSessions.push(sessionId);

    // Post permission_prompt hook event
    const hookRes = await fetch(`${hookBaseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'permission_prompt',
        sessionId,
        data: { message: 'Test permission prompt' },
      }),
    });
    expect(hookRes.ok).toBe(true);

    const hookData = await hookRes.json();
    expect(hookData.success).toBe(true);
  });

  it('should accept idle_prompt hook events', async () => {
    const sessionId = createdSessions[0] || 'test-session';

    const hookRes = await fetch(`${hookBaseUrl}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'idle_prompt',
        sessionId,
        data: {},
      }),
    });
    expect(hookRes.ok).toBe(true);
  });
});

describe('Ralph API', () => {
  let server: WebServer;
  const TEST_PORT_RALPH = 3153;
  const ralphBaseUrl = `http://localhost:${TEST_PORT_RALPH}`;
  let createdSessions: string[] = [];

  beforeAll(async () => {
    server = new WebServer(TEST_PORT_RALPH, false, true);
    await server.start();
    await new Promise(r => setTimeout(r, 1000));
  }, 30000);

  afterAll(async () => {
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${ralphBaseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }
    await server.stop();
  }, 60000);

  it('should enable Ralph tracking via API', async () => {
    // Create a session
    const createRes = await fetch(`${ralphBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp' }),
    });
    const createData = await createRes.json();
    expect(createData.success).toBe(true);
    const sessionId = createData.session.id;
    createdSessions.push(sessionId);

    // Enable Ralph tracking
    const configRes = await fetch(`${ralphBaseUrl}/api/sessions/${sessionId}/ralph-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(configRes.ok).toBe(true);

    // Get Ralph state
    const stateRes = await fetch(`${ralphBaseUrl}/api/sessions/${sessionId}/ralph-state`);
    expect(stateRes.ok).toBe(true);

    const stateData = await stateRes.json();
    expect(stateData.success).toBe(true);
    expect(stateData.data).toBeDefined();
    expect(stateData.data.loop).toBeDefined();
    expect(stateData.data.todos).toBeDefined();
  });

  it('should configure completion phrase via API', async () => {
    const sessionId = createdSessions[0];
    if (!sessionId) return;

    const configRes = await fetch(`${ralphBaseUrl}/api/sessions/${sessionId}/ralph-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completionPhrase: 'DONE' }),
    });
    expect(configRes.ok).toBe(true);
  });

  it('should reset Ralph state via API', async () => {
    const sessionId = createdSessions[0];
    if (!sessionId) return;

    const resetRes = await fetch(`${ralphBaseUrl}/api/sessions/${sessionId}/ralph-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    expect(resetRes.ok).toBe(true);
  });
});

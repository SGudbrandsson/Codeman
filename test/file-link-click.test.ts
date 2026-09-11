/**
 * File Link Click Tests for Codeman Web UI
 *
 * Tests that file paths displayed in terminal output reach the terminal, and
 * that the tail-file SSE endpoint (used by the Bash-tool row's live log viewer)
 * streams. Clicking a terminal file path now opens the file editor, not the
 * log viewer; the link provider itself is covered by
 * test/terminal-file-link-provider.test.ts (runs the real app.js code).
 *
 * Port allocation: 3154 (see CLAUDE.md test port table)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { WebServer } from '../src/web/server.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_PORT = 3154;
const baseUrl = `http://localhost:${TEST_PORT}`;
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
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
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
  } catch {
    /* ignore */
  }
}

describe('File Link Click Tests', () => {
  let server: WebServer;
  let createdSessions: string[] = [];
  let browserAvailable = false;
  let testLogFile: string;
  let testDir: string;

  beforeAll(async () => {
    closeBrowser();

    // Create test directory and log file
    testDir = join(tmpdir(), `codeman-link-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testLogFile = join(testDir, 'test.log');
    writeFileSync(testLogFile, '=== Test Log Started ===\n');

    server = new WebServer(TEST_PORT, false, true);
    await server.start();
    await new Promise((r) => setTimeout(r, 1000));

    // Test if browser is available
    try {
      browser(`open ${baseUrl}`);
      await new Promise((r) => setTimeout(r, 2000));
      const title = browserJson<{ title: string }>('get title');
      browserAvailable = title.title === 'Codeman';
    } catch (e) {
      console.warn('Browser not available, skipping browser tests:', (e as Error).message);
      browserAvailable = false;
    }
  }, 60000);

  afterAll(async () => {
    closeBrowser();
    for (const sessionId of createdSessions) {
      try {
        await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      } catch {
        /* ignore */
      }
    }
    await server.stop();

    // Cleanup test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 60000);

  it('should create shell session and display terminal output', async () => {
    if (!browserAvailable) {
      console.log('Skipping: browser not available');
      return;
    }

    // Create a shell session via API
    const response = await fetch(`${baseUrl}/api/quick-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseName: 'link-test', mode: 'shell' }),
    });

    const data = await response.json();
    expect(data.success).toBe(true);
    createdSessions.push(data.session.id);

    // Wait for session to appear in UI
    await new Promise((r) => setTimeout(r, 2000));

    // Check that terminal is visible
    const terminalExists = await waitForElement('.xterm-screen', 5000);
    expect(terminalExists).toBe(true);
  }, 60000);

  it('should make file paths clickable in terminal', async () => {
    if (!browserAvailable || createdSessions.length === 0) {
      console.log('Skipping: browser not available or no session');
      return;
    }

    const sessionId = createdSessions[0];

    // Send a command that outputs a file path
    // Using 'echo' with the test file path followed by 'tail -f' pattern
    const command = `echo "Monitoring file: ${testLogFile}" && echo "tail -f ${testLogFile}"`;

    await fetch(`${baseUrl}/api/sessions/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: command + '\r' }),
    });

    await new Promise((r) => setTimeout(r, 2000));

    // Check if xterm contains the file path
    // The xterm link provider should detect "tail -f /path/to/file" pattern
    const terminalText = getText('.xterm-screen');
    console.log('Terminal text:', terminalText.substring(0, 500));

    // File path should be visible in terminal
    expect(terminalText).toContain(testLogFile);
  }, 60000);

  it('should detect file link patterns in terminal output', async () => {
    if (!browserAvailable || createdSessions.length === 0) {
      console.log('Skipping: browser not available or no session');
      return;
    }

    const sessionId = createdSessions[0];

    // Test various patterns that should be detected as links
    const patterns = [
      `cat ${testLogFile}`,
      `head -n 10 ${testLogFile}`,
      `less ${testLogFile}`,
      `grep "test" ${testLogFile}`,
    ];

    for (const pattern of patterns) {
      await fetch(`${baseUrl}/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: `echo "${pattern}"\r` }),
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    await new Promise((r) => setTimeout(r, 1000));

    // Verify patterns appear in terminal
    const terminalText = getText('.xterm-screen');
    for (const pattern of patterns) {
      expect(terminalText).toContain(testLogFile);
    }
  }, 60000);

  it('should stream file content to log viewer', async () => {
    // Test the tail-file API endpoint directly
    // First, create a session if we don't have one from browser tests
    let sessionId = createdSessions[0];
    if (!sessionId) {
      const response = await fetch(`${baseUrl}/api/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: 'stream-test', mode: 'shell' }),
      });
      const data = await response.json();
      expect(data.success).toBe(true);
      sessionId = data.sessionId; // quick-start returns sessionId directly
      createdSessions.push(sessionId);
    }

    // Create an EventSource to test SSE streaming
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let streamError: Error | null = null;

    try {
      const response = await fetch(
        `${baseUrl}/api/sessions/${sessionId}/tail-file?path=${encodeURIComponent(testLogFile)}&lines=10`,
        { signal: controller.signal }
      );

      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      // Read a bit of the stream
      const reader = response.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        console.log('SSE stream data:', text.substring(0, 200));
        // SSE format uses "data: " prefix for messages
        expect(text).toContain('data:');
        // Should contain connection info or file content
        expect(text).toContain('"type"');
        reader.releaseLock();
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        streamError = e;
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }

    // Re-throw any non-abort errors after cleanup
    if (streamError) {
      throw streamError;
    }
  }, 60000);
});

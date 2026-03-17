/**
 * Transcript session isolation tests
 *
 * Verifies that when two sessions share the same workingDir (the common Codeman case),
 * each session's transcript endpoint returns only its own messages — never the other
 * session's content.
 *
 * Also verifies the frontend's TranscriptView cache behaviour: when the server returns
 * correct per-session content, a stale cache from a previous wrong fetch must be fully
 * overwritten (not incrementally appended to).
 *
 * Root cause: resolveTranscriptPath step 3 previously scanned the shared projectDir for
 * the "newest" JSONL file. In a shared workingDir, that always returned the most recently
 * active session's file. Fix: trust claudeResumeId as the authoritative per-session
 * identifier; return its file directly without scanning.
 *
 * Port: 3217
 *
 * Run: npx vitest run test/transcript-session-isolation.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveTranscriptPath } from '../src/web/transcript-path-resolver.js';
import { WebServer } from '../src/web/server.js';

const PORT = 3217;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Backend unit tests ──────────────────────────────────────────────────────

describe('resolveTranscriptPath — session isolation', () => {
  const SESSION_A_ID = 'aaaa1111-0000-0000-0000-000000000000';
  const SESSION_B_ID = 'bbbb2222-0000-0000-0000-000000000000';
  const SHARED_WORKING_DIR = '/home/user/shared-project';
  let tmpHome: string;
  let projectDir: string;

  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeman-isolation-test-'));
    projectDir = path.join(tmpHome, '.claude', 'projects', SHARED_WORKING_DIR.replace(/\//g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('RED→GREEN: session A and session B in the same workingDir resolve to different JSONL files', () => {
    // Arrange: create two JSONL files in the shared project dir
    const fileA = path.join(projectDir, `${SESSION_A_ID}.jsonl`);
    const fileB = path.join(projectDir, `${SESSION_B_ID}.jsonl`);
    fs.writeFileSync(fileA, JSON.stringify({ role: 'user', text: 'Session A message' }));
    fs.writeFileSync(fileB, JSON.stringify({ role: 'user', text: 'Session B message' }));

    // Act: resolve path for both sessions (no watcher — simulates server restart / fresh load)
    const pathA = resolveTranscriptPath(SHARED_WORKING_DIR, undefined, SESSION_A_ID, tmpHome);
    const pathB = resolveTranscriptPath(SHARED_WORKING_DIR, undefined, SESSION_B_ID, tmpHome);

    // Assert: each session gets its own file
    expect(pathA).toBe(fileA);
    expect(pathB).toBe(fileB);
    expect(pathA).not.toBe(pathB);

    fs.unlinkSync(fileA);
    fs.unlinkSync(fileB);
  });

  it('RED→GREEN: after session B runs (newer mtime), session A still resolves to its own file', async () => {
    // Arrange: session A created first, session B created later (newer mtime)
    const fileA = path.join(projectDir, `${SESSION_A_ID}.jsonl`);
    const fileB = path.join(projectDir, `${SESSION_B_ID}.jsonl`);
    fs.writeFileSync(fileA, JSON.stringify({ role: 'user', text: 'Session A message' }));
    // Wait to ensure different mtime
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(fileB, JSON.stringify({ role: 'user', text: 'Session B message' }));

    // Act: resolve session A — must NOT be contaminated by B's newer file
    const pathA = resolveTranscriptPath(SHARED_WORKING_DIR, undefined, SESSION_A_ID, tmpHome);

    // Assert: session A gets its own file, not B's newer file
    expect(pathA).toBe(fileA);
    expect(pathA).not.toBe(fileB);

    fs.unlinkSync(fileA);
    fs.unlinkSync(fileB);
  });

  it('RED→GREEN: after session A runs (newer mtime), session B still resolves to its own file', async () => {
    // Arrange: session B created first, session A created later (newer mtime)
    const fileB = path.join(projectDir, `${SESSION_B_ID}.jsonl`);
    const fileA = path.join(projectDir, `${SESSION_A_ID}.jsonl`);
    fs.writeFileSync(fileB, JSON.stringify({ role: 'user', text: 'Session B message' }));
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(fileA, JSON.stringify({ role: 'user', text: 'Session A message' }));

    // Act: resolve session B — must NOT be contaminated by A's newer file
    const pathB = resolveTranscriptPath(SHARED_WORKING_DIR, undefined, SESSION_B_ID, tmpHome);

    // Assert: session B gets its own file, not A's newer file
    expect(pathB).toBe(fileB);
    expect(pathB).not.toBe(fileA);

    fs.unlinkSync(fileA);
    fs.unlinkSync(fileB);
  });

  it('returning null when session file is absent prevents cross-session contamination', () => {
    // Only session B file exists. Session A (different claudeResumeId) must not
    // fall back to B's file — return null instead.
    const fileB = path.join(projectDir, `${SESSION_B_ID}.jsonl`);
    fs.writeFileSync(fileB, JSON.stringify({ role: 'user', text: 'Session B message' }));

    const pathA = resolveTranscriptPath(SHARED_WORKING_DIR, undefined, SESSION_A_ID, tmpHome);

    expect(pathA).toBeNull(); // no fallback to B's file
    fs.unlinkSync(fileB);
  });
});

// ─── Frontend integration tests ──────────────────────────────────────────────

async function createSession(page: Page, name: string): Promise<string> {
  const id = await page.evaluate(async (n) => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: n }),
    });
    const data = await res.json();
    return (data.id ?? data.session?.id) as string;
  }, name);
  return id;
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { app: { selectSession: (id: string) => void } }).app.selectSession(id);
  }, sessionId);
  await page.waitForTimeout(500);
}

async function mockTranscript(page: Page, sessionId: string, blocks: unknown[]): Promise<void> {
  await page.route(`**/api/sessions/${sessionId}/transcript`, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(blocks) });
  });
}

async function switchToTranscriptView(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    const tv = (
      window as unknown as {
        TranscriptView: { setViewMode: (id: string, m: string) => void; show: (id: string) => void };
      }
    ).TranscriptView;
    tv.setViewMode(id, 'web');
    tv.show(id);
  }, sessionId);
  await page.waitForTimeout(600);
}

async function getTranscriptText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.getElementById('transcriptView');
    return el?.innerText ?? '';
  });
}

describe('TranscriptView session isolation — frontend', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 30_000);

  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
  });

  afterEach(async () => {
    await page.close();
  });

  const SESSION_A_BLOCKS = [
    {
      id: 'block-a-1',
      type: 'text',
      role: 'user',
      text: 'SESSION A USER MESSAGE — unique to session A',
      timestamp: '2026-01-01T10:00:00.000Z',
    },
    {
      id: 'block-a-2',
      type: 'text',
      role: 'assistant',
      text: 'SESSION A ASSISTANT REPLY — unique to session A',
      timestamp: '2026-01-01T10:00:01.000Z',
    },
  ];

  const SESSION_B_BLOCKS = [
    {
      id: 'block-b-1',
      type: 'text',
      role: 'user',
      text: 'SESSION B USER MESSAGE — unique to session B',
      timestamp: '2026-01-02T10:00:00.000Z',
    },
    {
      id: 'block-b-2',
      type: 'text',
      role: 'assistant',
      text: 'SESSION B ASSISTANT REPLY — unique to session B',
      timestamp: '2026-01-02T10:00:01.000Z',
    },
  ];

  it('RED→GREEN: session A transcript shows only session A content', async () => {
    const sessionAId = await createSession(page, 'session-isolation-A');
    await mockTranscript(page, sessionAId, SESSION_A_BLOCKS);

    await selectSession(page, sessionAId);
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionAId);
    await switchToTranscriptView(page, sessionAId);

    const text = await getTranscriptText(page);
    expect(text).toContain('SESSION A USER MESSAGE');
    expect(text).toContain('SESSION A ASSISTANT REPLY');
    expect(text).not.toContain('SESSION B USER MESSAGE');
    expect(text).not.toContain('SESSION B ASSISTANT REPLY');
  }, 20_000);

  it('RED→GREEN: session B transcript shows only session B content', async () => {
    const sessionBId = await createSession(page, 'session-isolation-B');
    await mockTranscript(page, sessionBId, SESSION_B_BLOCKS);

    await selectSession(page, sessionBId);
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionBId);
    await switchToTranscriptView(page, sessionBId);

    const text = await getTranscriptText(page);
    expect(text).toContain('SESSION B USER MESSAGE');
    expect(text).toContain('SESSION B ASSISTANT REPLY');
    expect(text).not.toContain('SESSION A USER MESSAGE');
    expect(text).not.toContain('SESSION A ASSISTANT REPLY');
  }, 20_000);

  it('RED→GREEN: switching A → B shows B content, not A content', async () => {
    const sessionAId = await createSession(page, 'isolation-switch-A');
    const sessionBId = await createSession(page, 'isolation-switch-B');
    await mockTranscript(page, sessionAId, SESSION_A_BLOCKS);
    await mockTranscript(page, sessionBId, SESSION_B_BLOCKS);

    // Load session A transcript first
    await selectSession(page, sessionAId);
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionAId);
    await switchToTranscriptView(page, sessionAId);

    const textA = await getTranscriptText(page);
    expect(textA).toContain('SESSION A USER MESSAGE');

    // Switch to session B
    await selectSession(page, sessionBId);
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionBId);
    await switchToTranscriptView(page, sessionBId);

    const textB = await getTranscriptText(page);
    expect(textB).toContain('SESSION B USER MESSAGE');
    expect(textB).toContain('SESSION B ASSISTANT REPLY');
    // Session A's content must NOT appear
    expect(textB).not.toContain('SESSION A USER MESSAGE');
    expect(textB).not.toContain('SESSION A ASSISTANT REPLY');
  }, 30_000);

  it('RED→GREEN: switching A → B → A restores session A content correctly', async () => {
    const sessionAId = await createSession(page, 'isolation-roundtrip-A');
    const sessionBId = await createSession(page, 'isolation-roundtrip-B');
    await mockTranscript(page, sessionAId, SESSION_A_BLOCKS);
    await mockTranscript(page, sessionBId, SESSION_B_BLOCKS);

    // Load A
    await selectSession(page, sessionAId);
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionAId);
    await switchToTranscriptView(page, sessionAId);

    // Switch to B
    await selectSession(page, sessionBId);
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionBId);
    await switchToTranscriptView(page, sessionBId);

    // Switch back to A
    await selectSession(page, sessionAId);
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionAId);
    await switchToTranscriptView(page, sessionAId);

    const textA = await getTranscriptText(page);
    expect(textA).toContain('SESSION A USER MESSAGE');
    expect(textA).toContain('SESSION A ASSISTANT REPLY');
    // After round-trip B's content must not bleed into A's view
    expect(textA).not.toContain('SESSION B USER MESSAGE');
    expect(textA).not.toContain('SESSION B ASSISTANT REPLY');
  }, 40_000);

  it('RED→GREEN: cache overwrite — stale cache from wrong backend response is replaced on re-fetch', async () => {
    // This tests the frontend defensive fix: if session A's cache was populated with session B's
    // blocks (the backend bug), and then the backend is fixed to return correct blocks,
    // the next load() must fully replace the stale cache and re-render correctly.
    const sessionAId = await createSession(page, 'isolation-cache-overwrite-A');

    // First: mock session A's endpoint to return B's blocks (simulates the bug)
    await mockTranscript(page, sessionAId, SESSION_B_BLOCKS);
    await selectSession(page, sessionAId);
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionAId);
    await switchToTranscriptView(page, sessionAId);

    // Verify stale B blocks were rendered (the pre-fix state)
    const staleText = await getTranscriptText(page);
    expect(staleText).toContain('SESSION B USER MESSAGE');

    // Now fix the backend: session A endpoint returns A's correct blocks
    await page.unroute(`**/api/sessions/${sessionAId}/transcript`);
    await mockTranscript(page, sessionAId, SESSION_A_BLOCKS);

    // Switch away and back to trigger a fresh load
    await selectSession(page, await createSession(page, 'throwaway'));
    await selectSession(page, sessionAId);
    await page.evaluate((id) => {
      localStorage.setItem('transcriptViewMode:' + id, 'web');
    }, sessionAId);
    await switchToTranscriptView(page, sessionAId);

    const correctedText = await getTranscriptText(page);
    expect(correctedText).toContain('SESSION A USER MESSAGE');
    expect(correctedText).toContain('SESSION A ASSISTANT REPLY');
    // Stale B blocks must be gone
    expect(correctedText).not.toContain('SESSION B USER MESSAGE');
    expect(correctedText).not.toContain('SESSION B ASSISTANT REPLY');
  }, 40_000);
});

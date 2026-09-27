/**
 * @fileoverview Codex id discovery must re-arm on submitted input.
 *
 * Codex writes its rollout on the first submitted turn. If that turn comes after the
 * spawn-time watch hit its cap (or after a server restart restored the session with no
 * id), the session used to stay id-less forever — no transcript, no resume.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.js';

let tmpRoot: string;
const savedCodexHome = process.env.CODEX_HOME;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'codeman-codex-rearm-'));
  process.env.CODEX_HOME = join(tmpRoot, 'codex');
});

afterAll(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeRollout(cwd: string, id: string): void {
  const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '27');
  mkdirSync(dir, { recursive: true });
  const meta = { type: 'session_meta', payload: { id, session_id: id, cwd } };
  writeFileSync(join(dir, `rollout-2026-09-27T10-50-38-${id}.jsonl`), JSON.stringify(meta) + '\n');
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
}

describe('codex id discovery re-arm on input', () => {
  it('discovers the id after a submitted turn when no watch is running', async () => {
    const cwd = join(tmpRoot, 'proj-a');
    const session = new Session({ id: 'codex-rearm-1', workingDir: cwd, mode: 'codex', useMux: false });
    try {
      expect(session.harnessSessionId).toBeUndefined();
      session.write('hello\r');
      writeRollout(cwd, '01a0e231-bb3e-7e12-aa9f-02fb0c3f7ae2');
      await waitFor(() => session.harnessSessionId !== undefined);
      expect(session.harnessSessionId).toBe('01a0e231-bb3e-7e12-aa9f-02fb0c3f7ae2');
    } finally {
      await session.stop();
    }
  });

  it('does not arm on keystrokes without Enter, or for non-codex sessions', async () => {
    const cwd = join(tmpRoot, 'proj-b');
    const codex = new Session({ id: 'codex-rearm-2', workingDir: cwd, mode: 'codex', useMux: false });
    const shell = new Session({ id: 'shell-rearm-1', workingDir: cwd, mode: 'shell', useMux: false });
    try {
      codex.write('typing');
      shell.write('ls\r');
      writeRollout(cwd, '01a0e231-0000-7e12-aa9f-02fb0c3f7ae2');
      await new Promise((r) => setTimeout(r, 300));
      expect(codex.harnessSessionId).toBeUndefined();
      expect(shell.harnessSessionId).toBeUndefined();
    } finally {
      await codex.stop();
      await shell.stop();
    }
  });
});

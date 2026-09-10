/**
 * The overloaded `claudeTranscript` capability is split in two:
 *   - `transcript`       — the harness has a viewable transcript (view + toggle offered)
 *   - `claudeTranscript` — the harness speaks Claude's JSONL / --resume / hooks / state machine
 *
 * Run: npx vitest run test/harness-transcript-capability.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getHarness } from '../src/harnesses/registry.js';
import type { SessionMode } from '../src/types/session.js';

describe('transcript vs claudeTranscript', () => {
  const expected: Record<string, { transcript: boolean; claudeTranscript: boolean }> = {
    claude: { transcript: true, claudeTranscript: true },
    codex: { transcript: true, claudeTranscript: false },
    pi: { transcript: true, claudeTranscript: false },
    opencode: { transcript: false, claudeTranscript: false },
    shell: { transcript: false, claudeTranscript: false },
  };
  for (const [mode, exp] of Object.entries(expected)) {
    it(`${mode}`, () => {
      const c = getHarness(mode as SessionMode).caps;
      expect(c.transcript).toBe(exp.transcript);
      expect(c.claudeTranscript).toBe(exp.claudeTranscript);
    });
  }

  it('keeps codex and pi out of Claude-only subsystems', () => {
    // Regression lock for THE TRAP: transcript must not leak into ralph/respawn.
    for (const m of ['codex', 'pi'] as const) {
      const c = getHarness(m).caps;
      expect(c.ralph).toBe(false);
      expect(c.respawn).toBe(false);
      expect(c.pausable).toBe(false);
      expect(c.claudeHooks).toBe(false);
    }
  });

  it('the five Claude-only consumer sites still read claudeTranscript, not transcript', () => {
    // A blanket rename would hand codex/pi the Respawn and Ralph tabs back.
    const server = readFileSync('src/web/server.ts', 'utf-8');
    expect(server).toMatch(/return getHarness\(mode\)\.caps\.claudeTranscript;/);

    const session = readFileSync('src/session.ts', 'utf-8');
    expect(session).toMatch(/spawnCaps\.preassignsSessionId && !spawnCaps\.claudeTranscript/);
    expect((session.match(/getHarness\(this\.mode\)\.caps\.claudeTranscript/g) ?? []).length).toBe(3);

    const app = readFileSync('src/web/public/app.js', 'utf-8');
    expect(app).toMatch(/const hideClaudeOnly = !meta\.caps\.claudeTranscript;/);
  });
});

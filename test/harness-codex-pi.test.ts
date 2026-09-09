/**
 * @fileoverview Tests for the codex and pi harness definitions.
 *
 * Note on quoting: every interpolated argument goes through `shellQuote`
 * (POSIX single quotes), so the assertions below expect `-m 'gpt-5.2'` rather
 * than the bare `-m gpt-5.2` the plan drafted. See TASK.md, Task 4 deviations.
 */

import { describe, it, expect } from 'vitest';
import { getHarness, listHarnesses } from '../src/harnesses/registry.js';

describe('codex harness', () => {
  const h = () => getHarness('codex');

  it('is registered', () => {
    expect(listHarnesses().map((x) => x.id)).toContain('codex');
  });

  it('bypasses approvals and disables the alternate screen', () => {
    const cmd = h().buildCommand({ sessionId: 's', mode: 'codex' });
    expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    // Without this, tmux capture-pane sees an empty scrollback and buffer
    // restore returns a blank terminal.
    expect(cmd).toContain('--no-alt-screen');
  });

  it('adds a validated, shell-quoted model flag', () => {
    expect(h().buildCommand({ sessionId: 's', mode: 'codex', codexConfig: { model: 'gpt-5.2' } })).toContain(
      "-m 'gpt-5.2'"
    );
  });

  it('drops an unsafe model string', () => {
    const cmd = h().buildCommand({ sessionId: 's', mode: 'codex', codexConfig: { model: 'x; rm -rf /' } });
    expect(cmd).not.toContain('rm -rf');
    expect(cmd).not.toContain('-m ');
  });

  it('resumes via the resume subcommand when an id is known', () => {
    const cmd = h().buildCommand({
      sessionId: 's',
      mode: 'codex',
      harnessSessionId: '01a085e9-15f5-7b80-8af1-411de2591ffe',
    });
    expect(cmd).toMatch(/^codex resume '01a085e9-15f5-7b80-8af1-411de2591ffe' /);
  });

  it('drops an unsafe resume id rather than shelling out with it', () => {
    const cmd = h().buildCommand({ sessionId: 's', mode: 'codex', harnessSessionId: 'x; rm -rf /' });
    expect(cmd).not.toContain('resume');
    expect(cmd).not.toContain('rm -rf');
  });

  it('cannot preassign its session id', () => {
    expect(h().caps.preassignsSessionId).toBe(false);
  });
});

describe('pi harness', () => {
  const h = () => getHarness('pi');

  it('passes the Codeman session id straight through as --session-id', () => {
    // pi creates the session when the id does not exist, so the same command
    // both starts and resumes.
    const cmd = h().buildCommand({ sessionId: 'codeman-sid-1', mode: 'pi' });
    expect(cmd).toContain("--session-id 'codeman-sid-1'");
    expect(cmd).toContain('--approve');
    expect(h().caps.preassignsSessionId).toBe(true);
  });

  it('accepts a provider/model:thinking model string', () => {
    const cmd = h().buildCommand({ sessionId: 's', mode: 'pi', piConfig: { model: 'anthropic/sonnet:high' } });
    expect(cmd).toContain("--model 'anthropic/sonnet:high'");
  });

  it('drops an unsafe model string', () => {
    const cmd = h().buildCommand({ sessionId: 's', mode: 'pi', piConfig: { model: '$(rm -rf /)' } });
    expect(cmd).not.toContain('rm -rf');
    expect(cmd).not.toContain('--model');
  });

  it('drops an unsafe session id rather than shelling out with it', () => {
    const cmd = h().buildCommand({ sessionId: 'a b; rm -rf /', mode: 'pi' });
    expect(cmd).not.toContain('--session-id');
    expect(cmd).not.toContain('rm -rf');
  });

  it('searches ~/.npm-global/bin, which is not on /bin/sh PATH', () => {
    expect(h().searchDirs.some((d) => d.endsWith('.npm-global/bin'))).toBe(true);
  });
});

describe('both new harnesses opt out of every Claude-only subsystem', () => {
  it.each(['codex', 'pi'] as const)('%s', (mode) => {
    const c = getHarness(mode).caps;
    expect(c.ralph).toBe(false);
    expect(c.respawn).toBe(false);
    expect(c.claudeTranscript).toBe(false);
    expect(c.claudeParsers).toBe(false);
    expect(c.claudeHooks).toBe(false);
    expect(c.usesClaudeModelDefaults).toBe(false);
    expect(c.pausable).toBe(false);
    expect(c.requiresMux).toBe(true);
  });
});

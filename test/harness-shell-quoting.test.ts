/**
 * Regression tests for shell quoting of harness command arguments.
 *
 * `worktreeNotes` is free-form user text that reaches `extraArgs` via
 * src/session.ts, and harness commands are assembled as strings run through
 * `sh -c`. Quoting these with `JSON.stringify` emitted double quotes, inside
 * which the shell still expands `$(...)`, backticks and backslashes — i.e.
 * command injection. Every arg must be POSIX single-quoted instead.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { claudeHarness } from '../src/harnesses/claude.js';
import { shellQuote } from '../src/harnesses/registry.js';
import type { HarnessSpawnContext } from '../src/harnesses/types.js';

const ctx = (extraArgs: string[]): HarnessSpawnContext =>
  ({ sessionId: 'sess-1', workingDir: '/tmp', mode: 'claude', extraArgs }) as HarnessSpawnContext;

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('neutralises command substitution', () => {
    expect(shellQuote('$(id)')).toBe("'$(id)'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('round-trips through a real shell as a literal', () => {
    const evil = `'; touch /tmp/codeman-pwned; echo '`;
    const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(evil)}`], { encoding: 'utf8' });
    expect(out).toBe(evil);
  });
});

describe('claudeHarness.buildCommand', () => {
  it('does not leak command substitution from extraArgs into the command', () => {
    const cmd = claudeHarness.buildCommand(ctx(['$(touch /tmp/codeman-pwned)']));
    expect(cmd).not.toContain('"$(touch');
    expect(cmd).toContain("'$(touch /tmp/codeman-pwned)'");
  });

  it('passes an extraArg containing a single quote through as one shell word', () => {
    const note = `don't run $(id)`;
    const cmd = claudeHarness.buildCommand(ctx([note]));
    const out = execFileSync('sh', ['-c', `set -- ${cmd.slice('claude'.length)}; printf %s "$#"`], {
      encoding: 'utf8',
    });
    expect(Number(out)).toBeGreaterThan(0);
    expect(cmd).toContain(shellQuote(note));
  });

  it('single-quotes the session id rather than double-quoting it', () => {
    const cmd = claudeHarness.buildCommand(ctx([]));
    expect(cmd).toContain("--session-id 'sess-1'");
  });
});

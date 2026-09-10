/**
 * @fileoverview Codex launches pre-trusted for the session's working directory.
 *
 * A new codex working directory shows "Do you trust the contents of this directory?".
 * Any typed input can select "No, quit" and kill the session, so Codeman passes a
 * one-launch config override instead. Verified against codex 0.154.0:
 *   - `-c projects."<dir>".trust_level=…` (quoted dotted key) still prompts;
 *   - an unquoted dotted key breaks on paths containing dots;
 *   - the inline table form works for any path and writes nothing to ~/.codex/config.toml;
 *   - codex matches the RESOLVED path: a symlinked key still prompts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHarness } from '../src/harnesses/registry.js';
import { codexTrustOverride } from '../src/harnesses/codex.js';

let root: string;
let real: string;
let link: string;
let awkward: string;
let singleQuote: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-trust-')));
  real = join(root, 'real.dir');
  mkdirSync(real);
  link = join(root, 'link');
  symlinkSync(real, link);
  awkward = join(root, 'has "quote" and \\ back');
  mkdirSync(awkward);
  singleQuote = join(root, "it's here");
  mkdirSync(singleQuote);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const build = (workingDir?: string, harnessSessionId?: string): string =>
  getHarness('codex').buildCommand({ sessionId: 's', mode: 'codex', workingDir, harnessSessionId });

describe('codex trust override', () => {
  it('trusts the working directory for this launch only, as one shell-quoted -c argument', () => {
    expect(build(real)).toContain(`-c 'projects={"${real}"={trust_level="trusted"}}'`);
  });

  it('keys the trust entry by the real path when the working directory is a symlink', () => {
    const cmd = build(link);
    expect(cmd).toContain(`projects={"${real}"=`);
    expect(cmd).not.toContain(`projects={"${link}"=`);
  });

  it('applies to resumed sessions too', () => {
    const cmd = build(real, '01a085e9-15f5-7b80-8af1-411de2591ffe');
    expect(cmd).toMatch(/^codex resume '01a085e9-15f5-7b80-8af1-411de2591ffe' /);
    expect(cmd).toContain('trust_level="trusted"');
  });

  it('omits the override when no working directory is given', () => {
    expect(build(undefined)).not.toContain('trust_level');
  });

  it('omits the override when the working directory does not exist', () => {
    expect(build(join(root, 'missing'))).not.toContain('trust_level');
  });

  it('escapes backslashes and double quotes in the TOML key', () => {
    const key = awkward.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    expect(codexTrustOverride(awkward)).toBe(`projects={"${key}"={trust_level="trusted"}}`);
  });

  it('keeps a path containing a single quote shell-safe', () => {
    const cmd = build(singleQuote);
    expect(cmd).toContain(`it'\\''s here`);
    expect(cmd).not.toMatch(/it's here/);
  });

  it('rejects a path containing control characters rather than emitting invalid TOML', () => {
    expect(codexTrustOverride('/tmp/bad\nname')).toBeNull();
  });
});

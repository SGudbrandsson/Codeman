/**
 * Regression test for the OUTER shell layer at the tmux spawn boundary.
 *
 * `shellQuote` hardens the command string that the harness builds, but that
 * string used to be handed to `execSync`/`exec` inside a `tmux respawn-pane ...
 * bash -c ${JSON.stringify(fullCmd)}` template. `execSync` runs `/bin/sh -c`,
 * and `JSON.stringify` escapes `"` and `\` but NOT `$` or backticks — so the
 * outer `/bin/sh` performed command substitution before `bash` (or the single
 * quotes `shellQuote` added) ever saw the text. `worktreeNotes` is free-form
 * user text that reaches `extraArgs`, so a note containing `$(` or a backtick
 * executed at spawn time.
 *
 * Both spawn sites must therefore invoke tmux via the argv form (no shell).
 * This test drives the real `TmuxManager` with a stub `tmux` on PATH that
 * records the argv it is handed, and asserts the payload arrives literally.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A note of exactly the shape `worktreeNotes` produces. */
const EVIL_NOTE = 'note $(id -u) and `whoami` end';

function makeStubDir(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codeman-tmux-stub-'));
  const log = join(dir, 'argv.log');
  // Records every invocation's argv as one JSON line, then behaves like a
  // successful tmux (display-message must yield a parseable pane pid).
  const stub = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write('12345\\n');
`;
  for (const name of ['tmux', 'claude']) {
    const p = join(dir, name);
    writeFileSync(p, name === 'tmux' ? stub : '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
  }
  return { dir, log };
}

const restore: Array<() => void> = [];

afterEach(() => {
  while (restore.length) restore.pop()!();
  vi.resetModules();
});

async function spawnWithStub(kind: 'create' | 'respawn', extra: { activityToken?: string } = {}): Promise<string[][]> {
  const { dir, log } = makeStubDir();
  const prev = { PATH: process.env.PATH, HOME: process.env.HOME, VITEST: process.env.VITEST };
  restore.push(() => {
    process.env.PATH = prev.PATH;
    process.env.HOME = prev.HOME;
    if (prev.VITEST === undefined) delete process.env.VITEST;
    else process.env.VITEST = prev.VITEST;
  });

  // The manager short-circuits every real tmux call under VITEST; this test
  // exists to exercise the real spawn path, so it runs with VITEST unset and
  // an isolated HOME (mux-sessions.json lives under $HOME).
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.HOME = dir;
  delete process.env.VITEST;
  vi.resetModules();

  const { TmuxManager } = await import('../src/tmux-manager.js');
  const mgr = new TmuxManager();
  const opts = {
    sessionId: 'abcdef0123456789',
    workingDir: dir,
    mode: 'claude' as const,
    extraArgs: [EVIL_NOTE],
    ...extra,
  };
  if (kind === 'create') {
    await mgr.createSession({ ...opts, name: 'stub' });
  } else {
    await mgr.createSession({ ...opts, name: 'stub' });
    writeFileSync(log, '');
    await mgr.respawnPane(opts);
  }

  return readFileSync(log, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

describe.each(['create', 'respawn'] as const)('tmux spawn boundary (%s)', (kind) => {
  it('passes the assembled command to tmux without an outer shell interpolating it', async () => {
    const calls = await spawnWithStub(kind);
    const respawn = calls.find((c) => c[0] === 'respawn-pane');
    expect(respawn, `no respawn-pane call recorded (calls: ${JSON.stringify(calls)})`).toBeDefined();

    const cmd = respawn![respawn!.length - 1];
    // The note must survive verbatim, still single-quoted by shellQuote.
    expect(cmd).toContain(`'${EVIL_NOTE}'`);
    // And nothing may have been executed on the way: `id -u` is the uid,
    // `whoami` the username.
    expect(cmd).not.toContain(`note ${process.getuid?.()} and`);
  });

  it('exports CODEMAN_ACTIVITY_TOKEN when a valid token is passed', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    const calls = await spawnWithStub(kind, { activityToken: token });
    const respawn = calls.find((c) => c[0] === 'respawn-pane');
    expect(respawn, `no respawn-pane call recorded (calls: ${JSON.stringify(calls)})`).toBeDefined();
    expect(respawn![respawn!.length - 1]).toContain(`export CODEMAN_ACTIVITY_TOKEN=${token} &&`);
  });

  it.each([
    ['absent', undefined],
    ['injected', '$(id -u)'],
    ['uppercase', '0123456789ABCDEF0123456789ABCDEF'],
  ])('never exports CODEMAN_ACTIVITY_TOKEN for an %s token', async (_label, activityToken) => {
    const calls = await spawnWithStub(kind, { activityToken });
    const respawn = calls.find((c) => c[0] === 'respawn-pane');
    expect(respawn).toBeDefined();
    const cmd = respawn![respawn!.length - 1];
    expect(cmd).not.toContain('CODEMAN_ACTIVITY_TOKEN');
  });
});

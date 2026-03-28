/**
 * @fileoverview Tests for POST /api/quick-start route handler.
 *
 * Kept in a separate file to isolate module-level vi.mock calls (node:fs,
 * node:fs/promises, Session, etc.) from the other session-routes tests.
 *
 * Uses app.inject() (Fastify's built-in test helper) — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
    writeFile: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/session.js', () => {
  function MockSessionConstructor(this: Record<string, unknown>, opts: { workingDir?: string }) {
    Object.assign(this, {
      id: 'qs-session-id',
      workingDir: opts?.workingDir ?? '/tmp/test',
      mode: 'claude',
      name: 'test-session',
      ralphTracker: { enabled: false, enable: vi.fn(), enableAutoEnable: vi.fn() },
      toState: vi.fn(() => ({ id: 'qs-session-id' })),
      startInteractive: vi.fn().mockResolvedValue(undefined),
      startShell: vi.fn().mockResolvedValue(undefined),
      autoCompactAndContinue: false,
      setAutoCompactAndContinue: vi.fn(),
      isBusy: vi.fn(() => false),
      write: vi.fn(),
      writeViaMux: vi.fn().mockResolvedValue(true),
      resize: vi.fn(),
    });
  }
  return { Session: MockSessionConstructor };
});

vi.mock('../../src/session-lifecycle-log.js', () => ({
  getLifecycleLog: vi.fn().mockReturnValue({ log: vi.fn() }),
}));

vi.mock('../../src/utils/opencode-cli-resolver.js', () => ({
  isOpenCodeAvailable: vi.fn(() => true),
}));

vi.mock('../../src/templates/claude-md.js', () => ({
  generateClaudeMd: vi.fn(() => '# CLAUDE.md'),
}));

vi.mock('../../src/hooks-config.js', () => ({
  writeHooksConfig: vi.fn(async () => {}),
  updateCaseEnvVars: vi.fn(async () => {}),
}));

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFile = vi.mocked(fs.readFile);

describe('POST /api/quick-start', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
    vi.clearAllMocks();
    // Default: existsSync returns true (casePath already exists, skip mkdir)
    mockedExistsSync.mockReturnValue(true);
    // Default: linked-cases.json not found → fall through to CASES_DIR
    mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('uses CASES_DIR path when linked-cases.json is absent (ENOENT fallback)', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'my-case', mode: 'shell' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // Session should have been added to the context
    expect(harness.ctx.addSession).toHaveBeenCalled();
  });

  it('uses linked path for string-format linked case entry', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ 'my-linked-case': '/home/user/sources/my-project' }) as never);

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'my-linked-case', mode: 'shell' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // The session added to the context should use the linked path as workingDir
    const addedSession = (harness.ctx.addSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(addedSession?.workingDir).toBe('/home/user/sources/my-project');
  });

  it('uses linked path for object-format linked case entry', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        'my-project': { path: '/home/user/projects/my-project', orchestrationEnabled: true },
      }) as never
    );

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'my-project', mode: 'shell' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    const addedSession = (harness.ctx.addSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(addedSession?.workingDir).toBe('/home/user/projects/my-project');
  });
});

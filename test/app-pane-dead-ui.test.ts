/**
 * @fileoverview Frontend handling of a session whose harness exited in its tmux pane
 * (`status: 'stopped'` + `paneDead`).
 *
 * The real method bodies are extracted from src/web/public/app.js (not copied), wrapped in an
 * object literal, and called against a minimal fake app — so no browser, server or
 * better-sqlite3 is needed. Covers:
 * - `_onSessionUpdated`: 'stopped' reaches displayStatus and cancels pending tab-status timers;
 *   the restart that follows adopts the server status.
 * - `restartSessionProcess`: dead pane → /shell (shell) or /interactive (other modes); otherwise /restart.
 * - `_getSessionTooltip`: "Exited (status N)" prefix for a dead pane.
 *
 * Run: npx vitest run test/app-pane-dead-ui.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(join(repoRoot, 'src/web/public/app.js'), 'utf8');

/** Source of a CodemanApp method: from its 2-space-indented signature to the closing `\n  }`. */
function extractMethod(signature: string): string {
  const start = appJs.indexOf(`\n  ${signature}`);
  if (start === -1) throw new Error(`app.js method not found: ${signature}`);
  const end = appJs.indexOf('\n  }\n', start);
  return appJs.slice(start + 1, end + 4);
}

const methodsSrc = [
  extractMethod('_onSessionUpdated(data) {'),
  extractMethod('async restartSessionProcess(sessionId) {'),
  extractMethod('_getSessionTooltip(session) {'),
].join(',\n');

const globals = {
  SessionDrawer: { isOpen: () => false, _renderDebounced: vi.fn() },
  SessionIndicatorBar: { update: vi.fn() },
  requestAnimationFrame: (cb: () => void) => cb(),
  fetch: vi.fn(),
};

function makeApp() {
  const methods = new Function(...Object.keys(globals), `return {\n${methodsSrc}\n};`)(...Object.values(globals));
  return Object.assign(
    {
      sessions: new Map<string, any>(),
      _tabStatusTimers: new Map<string, ReturnType<typeof setTimeout>>(),
      _tabStatusHideTimers: new Map<string, ReturnType<typeof setTimeout>>(),
      activeSessionId: null as string | null,
      subagents: new Map(),
      _restartingSessionId: null as string | null,
      renderSessionTabs: vi.fn(),
      updateCost: vi.fn(),
      updateRespawnTokens: vi.fn(),
      updateSubagentParentNames: vi.fn(),
      recheckOrphanSubagents: vi.fn(),
      updateConnectionLines: vi.fn(),
      renderTranscriptStatusBlocks: vi.fn(),
      showToast: vi.fn(),
      getSessionName: (s: { name?: string }) => s.name ?? 'session',
    },
    methods
  );
}

afterEach(() => {
  vi.useRealTimers();
  globals.fetch.mockReset();
});

describe('_onSessionUpdated with a stopped (exited) session', () => {
  it("sets displayStatus 'stopped' and cancels pending show and hide tab-status timers", () => {
    vi.useFakeTimers();
    const app = makeApp();
    const showFired = vi.fn();
    const hideFired = vi.fn();
    app.sessions.set('s1', { id: 's1', status: 'busy', displayStatus: 'busy' });
    app._tabStatusTimers.set('s1', setTimeout(showFired, 1000));
    app._tabStatusHideTimers.set('s1', setTimeout(hideFired, 4000));

    app._onSessionUpdated({ session: { id: 's1', status: 'stopped', paneDead: true } });

    expect(app.sessions.get('s1').displayStatus).toBe('stopped');
    expect(app._tabStatusTimers.has('s1')).toBe(false);
    expect(app._tabStatusHideTimers.has('s1')).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(showFired).not.toHaveBeenCalled();
    expect(hideFired).not.toHaveBeenCalled();
  });

  it.each(['idle', 'busy'])("adopts the server status '%s' after a 'stopped' displayStatus (restart)", (status) => {
    const app = makeApp();
    app.sessions.set('s1', { id: 's1', status: 'stopped', displayStatus: 'stopped', paneDead: true });

    app._onSessionUpdated({ session: { id: 's1', status } });

    expect(app.sessions.get('s1').displayStatus).toBe(status);
  });

  it('still preserves a non-stopped displayStatus across ordinary updates', () => {
    const app = makeApp();
    app.sessions.set('s1', { id: 's1', status: 'busy', displayStatus: 'busy' });

    app._onSessionUpdated({ session: { id: 's1', status: 'idle' } });

    expect(app.sessions.get('s1').displayStatus).toBe('busy');
  });
});

describe('restartSessionProcess endpoint choice', () => {
  it.each([
    [{ paneDead: true, mode: 'shell' }, 'shell'],
    [{ paneDead: true, mode: 'codex' }, 'interactive'],
    [{ paneDead: true, mode: 'claude' }, 'interactive'],
    [{ paneDead: false, mode: 'claude' }, 'restart'],
    [{ mode: 'shell' }, 'restart'],
  ])('%o → POST /api/sessions/:id/%s', async (fields, action) => {
    const app = makeApp();
    app.sessions.set('s1', { id: 's1', status: 'stopped', ...fields });
    globals.fetch.mockResolvedValue({ json: async () => ({ success: true }) });

    await app.restartSessionProcess('s1');

    expect(globals.fetch).toHaveBeenCalledTimes(1);
    expect(globals.fetch).toHaveBeenCalledWith(`/api/sessions/s1/${action}`, { method: 'POST' });
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('Restarted'), 'info');
    expect(app._restartingSessionId).toBeNull();
  });
});

describe('_getSessionTooltip for a dead pane', () => {
  const app = makeApp();

  it('prefixes the exit status before the branch and directory', () => {
    expect(
      app._getSessionTooltip({ paneDead: true, paneExitStatus: 3, worktreeBranch: 'fix/x', workingDir: '/w/dir' })
    ).toBe('Exited (status 3) — Restart from the session menu\nBranch: fix/x\n/w/dir');
  });

  it('shows status 0 (falsy but known)', () => {
    expect(app._getSessionTooltip({ paneDead: true, paneExitStatus: 0, workingDir: '/w/dir' })).toBe(
      'Exited (status 0) — Restart from the session menu\n/w/dir'
    );
  });

  it('omits the status when unknown', () => {
    expect(app._getSessionTooltip({ paneDead: true, paneExitStatus: null, workingDir: '/w/dir' })).toBe(
      'Exited — Restart from the session menu\n/w/dir'
    );
  });

  it('is unchanged for a live session', () => {
    expect(app._getSessionTooltip({ worktreeBranch: 'fix/x', workingDir: '/w/dir' })).toBe('Branch: fix/x\n/w/dir');
    expect(app._getSessionTooltip({ workingDir: '/w/dir' })).toBe('/w/dir');
  });
});

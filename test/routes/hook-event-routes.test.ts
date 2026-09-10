/**
 * @fileoverview Tests for hook-event-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerHookEventRoutes } from '../../src/web/routes/hook-event-routes.js';

describe('hook-event-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerHookEventRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== POST /api/hook-event ==========

  describe('POST /api/hook-event', () => {
    it('accepts a valid hook event and broadcasts it', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'hook:stop',
        expect.objectContaining({ sessionId: harness.ctx._sessionId })
      );
    });

    it('sends push notifications for hook events', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'idle_prompt',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.sendPushNotifications).toHaveBeenCalledWith(
        'hook:idle_prompt',
        expect.objectContaining({ sessionId: harness.ctx._sessionId })
      );
    });

    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: 'nonexistent-session',
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });

    it('rejects invalid event type', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'invalid_event_type',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing sessionId', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('signals respawn controller on stop event', async () => {
      const mockController = {
        signalStopHook: vi.fn(),
        signalElicitation: vi.fn(),
        signalIdlePrompt: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockController.signalStopHook).toHaveBeenCalled();
    });

    it('does NOT signal the respawn controller when the session is paused', async () => {
      const mockController = {
        signalStopHook: vi.fn(),
        signalElicitation: vi.fn(),
        signalIdlePrompt: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);
      harness.ctx._session.paused = true;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });

      // Accepted (the hook fired before the pause landed) but inert.
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(mockController.signalStopHook).not.toHaveBeenCalled();
    });

    it('signals respawn controller on elicitation_dialog event', async () => {
      const mockController = {
        signalStopHook: vi.fn(),
        signalElicitation: vi.fn(),
        signalIdlePrompt: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'elicitation_dialog',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockController.signalElicitation).toHaveBeenCalled();
    });

    it('signals respawn controller on idle_prompt event', async () => {
      const mockController = {
        signalStopHook: vi.fn(),
        signalElicitation: vi.fn(),
        signalIdlePrompt: vi.fn(),
      };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, mockController as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'idle_prompt',
          sessionId: harness.ctx._sessionId,
          data: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockController.signalIdlePrompt).toHaveBeenCalled();
    });

    it('records hook event in run summary tracker', async () => {
      const mockTracker = { recordHookEvent: vi.fn() };
      harness.ctx.runSummaryTrackers.set(harness.ctx._sessionId, mockTracker as never);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: { tool_name: 'bash' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(mockTracker.recordHookEvent).toHaveBeenCalledWith('stop', expect.any(Object));
    });

    it('starts transcript watcher when transcript_path is provided', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: { transcript_path: '/home/user/.claude/transcript.jsonl' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.startTranscriptWatcher).toHaveBeenCalledWith(
        harness.ctx._sessionId,
        '/home/user/.claude/transcript.jsonl'
      );
    });

    it('dispatches hook to the correct session — not a different session in the same workingDir', async () => {
      // Regression: w2 and w3 share the same workingDir.
      // Hook for w3 must call startTranscriptWatcher with w3's session ID, not w2's.
      const SESSION_A = harness.ctx._sessionId; // 'test-session-1' (already registered)
      const SESSION_B = 'test-session-2';
      const pathA = `/home/user/.claude/projects/proj/${SESSION_A}.jsonl`;
      const pathB = `/home/user/.claude/projects/proj/${SESSION_B}.jsonl`;

      // Register a second session
      harness.ctx.sessions.set(SESSION_B, {
        id: SESSION_B,
        claudeResumeId: undefined,
        toState: () => ({ id: SESSION_B }),
      } as never);

      // Fire hook for A
      await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: { event: 'stop', sessionId: SESSION_A, data: { transcript_path: pathA } },
      });

      // Fire hook for B
      await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: { event: 'stop', sessionId: SESSION_B, data: { transcript_path: pathB } },
      });

      // Each session must have gotten its OWN path — cross-contamination would be calling
      // startTranscriptWatcher('session-A', pathB) or ('session-B', pathA).
      const calls = (harness.ctx.startTranscriptWatcher as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toContainEqual([SESSION_A, pathA]);
      expect(calls).toContainEqual([SESSION_B, pathB]);
      expect(calls).not.toContainEqual([SESSION_A, pathB]); // A must NOT get B's path
      expect(calls).not.toContainEqual([SESSION_B, pathA]); // B must NOT get A's path
    });

    it('does NOT start transcript watcher when no transcript_path in data', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'stop',
          sessionId: harness.ctx._sessionId,
          data: { some_other_field: 'value' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.startTranscriptWatcher).not.toHaveBeenCalled();
    });

    it('accepts valid data payload with extra fields', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: {
          event: 'permission_prompt',
          sessionId: harness.ctx._sessionId,
          data: { tool_name: 'bash', command: 'ls -la' },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });

  // ========== harness_activity (pi activity reports) ==========

  describe('POST /api/hook-event harness_activity', () => {
    const TOKEN = '0123456789abcdef0123456789abcdef';
    const valid = { state: 'working', token: TOKEN, gen: 1, seq: 1 };

    function useMode(mode: string, outcome: 'accepted' | 'rejected' = 'accepted') {
      const s = harness.ctx._session;
      s.mode = mode;
      s.applyHookActivity.mockReturnValue(outcome);
      return s;
    }

    const post = (data: unknown) =>
      harness.app.inject({
        method: 'POST',
        url: '/api/hook-event',
        payload: { event: 'harness_activity', sessionId: harness.ctx._sessionId, data },
      });

    it('applies a valid report to a pi session', async () => {
      const s = useMode('pi');
      const res = await post(valid);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).success).toBe(true);
      expect(s.applyHookActivity).toHaveBeenCalledTimes(1);
      expect(s.applyHookActivity).toHaveBeenCalledWith(valid);
    });

    it.each(['claude', 'codex', 'shell', 'opencode'])(
      'ignores the report for a %s session, before validation and the legacy branches',
      async (mode) => {
        const s = useMode(mode);
        const transcript_path = '/home/user/.claude/transcript.jsonl';
        for (const data of [
          { ...valid, transcript_path },
          { state: 'bogus', transcript_path },
        ]) {
          const res = await post(data);
          expect(res.statusCode).toBe(200);
          expect(JSON.parse(res.body).success).toBe(true);
        }
        expect(s.applyHookActivity).not.toHaveBeenCalled();
        expect(harness.ctx.startTranscriptWatcher).not.toHaveBeenCalled();
        expect(harness.ctx.broadcast).not.toHaveBeenCalled();
        expect(harness.ctx.sendPushNotifications).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['a missing data object', null],
      ['an unknown state', { ...valid, state: 'busy' }],
      ['a short token', { ...valid, token: 'abc' }],
      ['an uppercase token', { ...valid, token: TOKEN.toUpperCase() }],
      ['a zero gen', { ...valid, gen: 0 }],
      ['a negative seq', { ...valid, seq: -1 }],
      ['a fractional seq', { ...valid, seq: 1.5 }],
      ['a string seq', { ...valid, seq: '2' }],
      ['a non-string sessionFile', { ...valid, sessionFile: 42 }],
      ['an oversized sessionFile', { ...valid, sessionFile: '/x'.repeat(2049) }],
    ])('returns 400 for %s', async (_label, data) => {
      const s = useMode('pi');
      const res = await post(data);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).success).toBe(false);
      expect(s.applyHookActivity).not.toHaveBeenCalled();
    });

    it('fires none of the hook side effects (broadcast, push, run summary, respawn, vault, orchestrator)', async () => {
      const s = useMode('pi');
      const tracker = { recordHookEvent: vi.fn() };
      harness.ctx.runSummaryTrackers.set(harness.ctx._sessionId, tracker as never);
      const controller = { signalStopHook: vi.fn(), signalElicitation: vi.fn(), signalIdlePrompt: vi.fn() };
      harness.ctx.respawnControllers.set(harness.ctx._sessionId, controller as never);

      const res = await post({ ...valid, state: 'idle', sessionFile: '/home/u/.pi/agent/sessions/x/y.jsonl' });

      expect(res.statusCode).toBe(200);
      expect(s.applyHookActivity).toHaveBeenCalledTimes(1);
      expect(harness.ctx.broadcast).not.toHaveBeenCalled();
      expect(harness.ctx.sendPushNotifications).not.toHaveBeenCalled();
      expect(tracker.recordHookEvent).not.toHaveBeenCalled();
      expect(controller.signalStopHook).not.toHaveBeenCalled();
      expect(controller.signalElicitation).not.toHaveBeenCalled();
      expect(controller.signalIdlePrompt).not.toHaveBeenCalled();
      // Vault capture and the orchestrator notification both start by reading store state.
      expect(harness.ctx.store.getState).not.toHaveBeenCalled();
    });

    it('does not start a watcher through the legacy transcript_path branch', async () => {
      useMode('pi');
      const res = await post({ ...valid, transcript_path: '/home/user/.claude/transcript.jsonl' });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.startTranscriptWatcher).not.toHaveBeenCalled();
    });

    it("hands an accepted report's sessionFile to acceptHarnessTranscriptPath", async () => {
      useMode('pi', 'accepted');
      const sessionFile = '/home/u/.pi/agent/sessions/x/y.jsonl';
      await post({ ...valid, sessionFile });
      expect(harness.ctx.acceptHarnessTranscriptPath).toHaveBeenCalledWith(harness.ctx._sessionId, sessionFile);
    });

    it('does not hand over the sessionFile of a rejected report, or a report without one', async () => {
      useMode('pi', 'rejected');
      const res = await post({ ...valid, sessionFile: '/home/u/.pi/agent/sessions/x/y.jsonl' });
      expect(res.statusCode).toBe(200);
      useMode('pi', 'accepted');
      await post(valid);
      expect(harness.ctx.acceptHarnessTranscriptPath).not.toHaveBeenCalled();
    });

    it('a paused pi session ignores the report', async () => {
      const s = useMode('pi');
      s.paused = true;
      const res = await post(valid);
      expect(res.statusCode).toBe(200);
      expect(s.applyHookActivity).not.toHaveBeenCalled();
    });
  });
});

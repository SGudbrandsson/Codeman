/**
 * @fileoverview Hook event routes.
 * Receives Claude Code hook events and broadcasts to SSE clients.
 * Also manages the AskUserQuestion response lifecycle: the PreToolUse hook
 * polls GET /api/sessions/:id/auq-response while the web UI submits answers
 * via POST /api/sessions/:id/auq-response.
 *
 * This endpoint bypasses auth (Claude Code hooks curl from localhost).
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { HookEventSchema, isValidWorkingDir } from '../schemas.js';
import { sanitizeHookData } from '../route-helpers.js';
import type { SessionPort, EventPort, RespawnPort, ConfigPort, InfraPort } from '../ports/index.js';

// In-memory store for pending AskUserQuestion responses.
// Key: sessionId. Value: hookSpecificOutput JSON string (ready for hook stdout), or null (pending).
const pendingAuqResponses = new Map<string, string | null>();

export function registerHookEventRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort
): void {
  app.post('/api/hook-event', async (req) => {
    const result = HookEventSchema.safeParse(req.body);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, result.error.issues[0]?.message ?? 'Validation failed');
    }
    const { event, sessionId, data } = result.data;
    if (!ctx.sessions.has(sessionId)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    // Signal the respawn controller based on hook event type
    const controller = ctx.respawnControllers.get(sessionId);
    if (controller) {
      if (event === 'elicitation_dialog' || event === 'ask_user_question') {
        // Block auto-accept for question prompts
        controller.signalElicitation();
      } else if (event === 'stop') {
        // DEFINITIVE idle signal - Claude finished responding
        controller.signalStopHook();
      } else if (event === 'idle_prompt') {
        // DEFINITIVE idle signal - Claude has been idle for 60+ seconds
        controller.signalIdlePrompt();
      }
    }

    // When an AskUserQuestion hook fires, mark the session as pending an answer.
    // The PreToolUse hook script will poll GET /auq-response until the web UI posts one.
    if (event === 'ask_user_question') {
      pendingAuqResponses.set(sessionId, null);
    }

    // Start transcript watching if transcript_path is provided and safe
    if (data && 'transcript_path' in data) {
      const transcriptPath = String(data.transcript_path);
      if (transcriptPath && isValidWorkingDir(transcriptPath)) {
        ctx.startTranscriptWatcher(sessionId, transcriptPath);
      }
    }

    // Sanitize forwarded data: only include known safe fields, limit size
    const safeData = sanitizeHookData(data);
    ctx.broadcast(`hook:${event}`, { sessionId, timestamp: Date.now(), ...safeData });

    // Send push notifications for hook events
    const session = ctx.sessions.get(sessionId);
    const sessionName = session?.name ?? sessionId.slice(0, 8);
    ctx.sendPushNotifications(`hook:${event}`, { sessionId, sessionName, ...safeData });

    // Track in run summary
    const summaryTracker = ctx.runSummaryTrackers.get(sessionId);
    if (summaryTracker) {
      summaryTracker.recordHookEvent(event, safeData);
    }

    return { success: true };
  });

  // ── AskUserQuestion response endpoints ─────────────────────────────────

  /**
   * GET /api/sessions/:id/auq-response
   * Polled by the PreToolUse hook script. Returns the hookSpecificOutput JSON
   * when the user has answered, or an empty object while still pending.
   */
  app.get('/api/sessions/:id/auq-response', async (req) => {
    const { id } = req.params as { id: string };
    const response = pendingAuqResponses.get(id);
    if (response) {
      // Answer is ready — return it and clean up
      pendingAuqResponses.delete(id);
      return JSON.parse(response);
    }
    // Still pending (or no question active)
    return {};
  });

  /**
   * POST /api/sessions/:id/auq-response
   * Called by the web UI when the user answers an AskUserQuestion.
   * Stores the answer as hookSpecificOutput JSON so the polling hook picks it up.
   */
  app.post('/api/sessions/:id/auq-response', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { answer?: string };
    const answer = typeof body?.answer === 'string' ? body.answer.trim() : '';
    if (!answer) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'answer is required');
    }
    if (!ctx.sessions.has(id)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    // Build the hookSpecificOutput that the PreToolUse hook returns to Claude Code.
    // "deny" prevents Claude Code from rendering its native terminal selector.
    // The reason contains the user's answer so Claude can proceed with it.
    const hookOutput = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `The user has already answered this question through the Codeman web interface.\n` +
          `Selected: ${answer}\n` +
          `Continue with this selection. Do not call AskUserQuestion again for this question.`,
      },
    });
    pendingAuqResponses.set(id, hookOutput);
    return { success: true };
  });
}

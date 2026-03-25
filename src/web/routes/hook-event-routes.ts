/**
 * @fileoverview Hook event routes.
 * Receives Claude Code hook events and broadcasts to SSE clients.
 *
 * This endpoint bypasses auth (Claude Code hooks curl from localhost).
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { HookEventSchema, isValidWorkingDir } from '../schemas.js';
import { sanitizeHookData } from '../route-helpers.js';
import type { SessionPort, EventPort, RespawnPort, ConfigPort, InfraPort } from '../ports/index.js';
import { capture, consolidate, CONSOLIDATION_THRESHOLD } from '../../vault/index.js';

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
      if (event === 'elicitation_dialog') {
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

    // Vault capture — fire-and-forget on stop hook for agent sessions
    if (event === 'stop') {
      const sessionState = ctx.store.getState().sessions[sessionId];
      if (sessionState?.agentProfile) {
        const { agentId, vaultPath } = sessionState.agentProfile;

        // Extract content: prefer hook summary field, else last 2000 chars of terminal buffer
        let content: string;
        if (data && typeof (data as Record<string, unknown>)['summary'] === 'string') {
          content = String((data as Record<string, unknown>)['summary']);
        } else if (data && typeof (data as Record<string, unknown>)['transcript_summary'] === 'string') {
          content = String((data as Record<string, unknown>)['transcript_summary']);
        } else {
          const buf = session?.getTerminalBuffer() ?? '';
          content = buf.length > 2000 ? buf.slice(-2000) : buf;
        }

        if (content.trim()) {
          capture(agentId, vaultPath, {
            sessionId,
            workItemId: sessionState.currentWorkItemId ?? null,
            content,
          })
            .then(() => {
              // Update notesSinceConsolidation in state
              const agentProfile = ctx.store.getAgent(agentId);
              if (agentProfile) {
                const updatedProfile = {
                  ...agentProfile,
                  notesSinceConsolidation: agentProfile.notesSinceConsolidation + 1,
                  lastActiveAt: new Date().toISOString(),
                };
                ctx.store.setAgent(updatedProfile);

                // Trigger async consolidation if threshold exceeded (fire-and-forget)
                if (updatedProfile.notesSinceConsolidation > CONSOLIDATION_THRESHOLD) {
                  consolidate(agentId, vaultPath, updatedProfile)
                    .then((result) => {
                      // Reset notesSinceConsolidation after successful consolidation
                      const latest = ctx.store.getAgent(agentId);
                      if (latest) {
                        ctx.store.setAgent({
                          ...latest,
                          notesSinceConsolidation: 0,
                          lastConsolidatedAt: new Date().toISOString(),
                        });
                      }
                      console.log(`[vault] consolidation complete: ${result.patternsWritten} patterns written`);
                    })
                    .catch((err: unknown) => console.error('[vault] consolidation failed:', err));
                }
              }
            })
            .catch((err: unknown) => console.error('[vault] capture failed:', err));
        }
      }
    }

    // Notify orchestrator of session completion
    if (event === 'stop') {
      const sessionStateForOrch = ctx.store.getState().sessions[sessionId];
      if (sessionStateForOrch?.currentWorkItemId) {
        try {
          const { getOrchestrator } = await import('../../orchestrator.js');
          const orchestrator = getOrchestrator();
          if (orchestrator) {
            orchestrator.handleSessionCompletion(sessionId).catch((err: unknown) => {
              console.error('[hook-event] orchestrator completion handler failed:', err);
            });
          }
        } catch {
          /* orchestrator not initialized */
        }
      }
    }

    return { success: true };
  });
}

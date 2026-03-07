/**
 * @fileoverview Default model, context limits, and timing for AI-powered checkers.
 *
 * Centralizes the AI model identifier, context window sizes, and timeout/cooldown
 * defaults used by the idle checker, plan checker, respawn controller defaults,
 * and respawn route fallbacks. Change values here when tuning AI check behavior.
 *
 * @module config/ai-defaults
 */

// ============================================================================
// Model & Context
// ============================================================================

/** Default model for AI idle and plan checkers */
export const AI_CHECK_MODEL = 'claude-opus-4-5-20251101';

/** Max context chars for idle checker (~4k tokens) */
export const AI_IDLE_CHECK_MAX_CONTEXT = 16000;

/** Max context chars for plan checker (~2k tokens, plan mode UI is compact) */
export const AI_PLAN_CHECK_MAX_CONTEXT = 8000;

// ============================================================================
// AI Idle Checker Timing
// ============================================================================

/** Timeout for AI idle check (90 seconds — thinking can be slow) */
export const AI_IDLE_CHECK_TIMEOUT_MS = 90_000;

/** Cooldown after WORKING verdict (3 minutes) */
export const AI_IDLE_CHECK_COOLDOWN_MS = 180_000;

/** Cooldown after AI idle check error (1 minute) */
export const AI_IDLE_CHECK_ERROR_COOLDOWN_MS = 60_000;

// ============================================================================
// AI Plan Checker Timing
// ============================================================================

/** Timeout for AI plan check (60 seconds — allows time for thinking) */
export const AI_PLAN_CHECK_TIMEOUT_MS = 60_000;

/** Cooldown after NOT_PLAN_MODE verdict (30 seconds) */
export const AI_PLAN_CHECK_COOLDOWN_MS = 30_000;

/** Cooldown after AI plan check error (30 seconds) */
export const AI_PLAN_CHECK_ERROR_COOLDOWN_MS = 30_000;

// ============================================================================
// Shared AI Checker Limits
// ============================================================================

/** Max consecutive errors before disabling an AI checker */
export const AI_CHECK_MAX_CONSECUTIVE_ERRORS = 3;

/** Maximum exponential backoff cap for AI checker errors (5 minutes) */
export const AI_CHECK_MAX_BACKOFF_MS = 5 * 60 * 1000;

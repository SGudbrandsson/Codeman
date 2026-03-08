/**
 * @fileoverview Token validation constants.
 *
 * Claude's context window is ~200k tokens, so 500k is a generous upper bound.
 *
 * @module utils/token-validation
 */

/**
 * Maximum tokens allowed per session.
 * Claude's context is ~200k, so 500k is a safe upper bound for validation.
 */
export const MAX_SESSION_TOKENS = 500_000;

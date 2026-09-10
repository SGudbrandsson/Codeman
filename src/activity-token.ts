/**
 * @fileoverview The per-process activity token (see
 * docs/superpowers/specs/2026-09-10-harness-activity-detection-design.md §2).
 *
 * `Session` generates one whenever it launches a 'hook' harness process (tmux create-session or
 * dead-pane respawn) and tmux exports it as CODEMAN_ACTIVITY_TOKEN. A harness_activity report is
 * accepted only when its token matches, so reports from any other process fail. It identifies a
 * process; it is not a secret-grade credential (the hook route is localhost-only).
 *
 * @module activity-token
 */

import { randomBytes } from 'node:crypto';

/** Exactly 32 lowercase hex characters. Also guards the token before it reaches a shell. */
export const ACTIVITY_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export function newActivityToken(): string {
  return randomBytes(16).toString('hex');
}

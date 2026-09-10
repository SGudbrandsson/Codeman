/**
 * @fileoverview Activity-detection types shared by harness definitions, Session and the web
 * server. See docs/superpowers/specs/2026-09-10-harness-activity-detection-design.md §1 and §5.
 *
 * @module types/activity
 */

/** Where a harness's busy/idle status comes from. See the activity-detection spec, §1. */
export type ActivitySource = 'claudeTranscript' | 'hook' | 'transcript' | 'pty';

/**
 * Why a session went idle.
 * - completed: an authoritative end of turn.
 * - stale: tracking was lost while a turn was open; must not fire completion side effects.
 */
export type IdleReason = 'completed' | 'stale';

export interface IdleInfo {
  reason?: IdleReason;
}

/** Existing emitters call emit('idle') with no argument; that has always meant completion. */
export function normalizeIdleReason(info?: IdleInfo): IdleReason {
  return info?.reason === 'stale' ? 'stale' : 'completed';
}

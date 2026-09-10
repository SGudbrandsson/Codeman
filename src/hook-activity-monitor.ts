/**
 * @fileoverview Activity for 'hook' harnesses (pi), driven by harness_activity reports that the
 * Codeman pi extension posts to /api/hook-event. See
 * docs/superpowers/specs/2026-09-10-harness-activity-detection-design.md §3-§5.
 *
 * `acceptActivityReport` decides whether a report belongs to the process Codeman launched and is
 * newer than what was already accepted. `Session.applyHookActivity` runs it and forwards accepted
 * states to the attached `HookActivityMonitor`, which turns them into `working` / `idle` events.
 *
 * @module hook-activity-monitor
 */

import { EventEmitter } from 'node:events';
import type { ActivityMonitor, ActivityState } from './activity-monitor.js';
import type { IdleInfo } from './types/activity.js';

/** A validated harness_activity report (see `HarnessActivityDataSchema`). */
export interface HarnessActivityReport {
  state: 'working' | 'idle';
  token: string;
  /** Runtime generation within the pi process; bumped by /new, /resume and /reload. */
  gen: number;
  /** Monotonic across the whole pi process. */
  seq: number;
  sessionFile?: string;
}

/** Per-session, in-memory ordering state. Empty until the first accepted report. */
export interface HookOwnerState {
  lastSeq?: number;
  ownerGen?: number;
}

/**
 * Ownership and ordering (spec §4 step 3). Pure apart from updating `owner` on acceptance.
 * - the token must equal the session's current activity token;
 * - `gen` must be at least the highest accepted gen (a lower gen is a superseded runtime, even
 *   with a higher seq);
 * - `seq` must exceed the last accepted seq;
 * - with no prior state (new session, or after a Codeman restart) the first valid report wins.
 */
export function acceptActivityReport(
  owner: HookOwnerState,
  expectedToken: string | undefined,
  r: HarnessActivityReport
): boolean {
  if (!expectedToken || r.token !== expectedToken) return false;
  if (owner.ownerGen !== undefined && r.gen < owner.ownerGen) return false;
  if (owner.lastSeq !== undefined && r.seq <= owner.lastSeq) return false;
  owner.lastSeq = r.seq;
  owner.ownerGen = r.gen;
  return true;
}

/** pi heartbeats every 30 s while working; three missed heartbeats means tracking was lost. */
export const HOOK_STALE_MS = 90_000;

export interface HookActivityMonitorOptions {
  staleMs?: number;
}

/**
 * Emits `working` on a transition to working, and `idle { completed }` only when an idle report
 * closes an open turn (so a completed idle after a stale one is emitted exactly once). A working
 * turn with no report for `staleMs` emits `idle { stale }` and keeps the turn open.
 */
export class HookActivityMonitor extends EventEmitter implements ActivityMonitor {
  private _state: ActivityState = 'unknown';
  private _turnOpen = false;
  private _stopped = false;
  private _staleTimer: NodeJS.Timeout | null = null;
  private readonly _staleMs: number;

  constructor(opts: HookActivityMonitorOptions = {}) {
    super();
    this._staleMs = opts.staleMs ?? HOOK_STALE_MS;
  }

  get state(): ActivityState {
    return this._state;
  }

  get turnOpen(): boolean {
    return this._turnOpen;
  }

  /** Nothing to read: state arrives through `report()`, within one heartbeat of attach. */
  async start(): Promise<void> {}

  stop(): void {
    this._stopped = true;
    this._clearStaleTimer();
  }

  /** Applies an accepted report's state. */
  report(state: 'working' | 'idle'): void {
    if (this._stopped) return;
    if (state === 'working') {
      this._armStaleTimer();
      this._turnOpen = true;
      if (this._state === 'working') return;
      this._state = 'working';
      this.emit('working');
      return;
    }
    this._clearStaleTimer();
    const closesTurn = this._turnOpen;
    this._state = 'idle';
    this._turnOpen = false;
    if (closesTurn) this.emit('idle', { reason: 'completed' } satisfies IdleInfo);
  }

  private _armStaleTimer(): void {
    this._clearStaleTimer();
    this._staleTimer = setTimeout(() => {
      this._staleTimer = null;
      if (this._stopped || this._state !== 'working') return;
      // Tracking lost, not a finished turn: keep the turn open for a later completed idle.
      this._state = 'idle';
      this.emit('idle', { reason: 'stale' } satisfies IdleInfo);
    }, this._staleMs);
    this._staleTimer.unref?.();
  }

  private _clearStaleTimer(): void {
    if (this._staleTimer) {
      clearTimeout(this._staleTimer);
      this._staleTimer = null;
    }
  }
}

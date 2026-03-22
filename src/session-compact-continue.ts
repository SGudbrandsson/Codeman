/**
 * @fileoverview Auto-compact-and-continue automation for Session.
 *
 * Detects when Claude has requested context compaction (via COMPACT.md file
 * or compaction-request phrases in terminal output) and automatically sends
 * /compact, then waits for compaction to complete and sends 'continue'.
 *
 * State machine per session:
 *   none         → idle fired, signal detected → send /compact → sent_compact
 *   sent_compact → idle fired again (compact done) → send continue → none
 *   none         → idle fired, no signal → do nothing
 *
 * @module session-compact-continue
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { join } from 'node:path';

// ============================================================================
// Detection Constants
// ============================================================================

/** Maximum age (ms) for COMPACT.md to be considered a fresh compaction request (30 seconds) */
const COMPACT_MD_MAX_AGE_MS = 30_000;

/** Number of recent lines to scan for compaction-request phrases */
const SCAN_LINES = 50;

/** Regex patterns that indicate Claude is requesting compaction */
const COMPACTION_PATTERNS = [
  /context is about to compact/i,
  /context is critically low/i,
  /state is saved to compact\.md/i,
  /after compaction[,\s]/i,
  /will compact/i,
  /compaction imminent/i,
];

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Callbacks required by SessionCompactContinue to interact with the parent Session.
 */
export interface CompactContinueCallbacks {
  /** Send a command via the terminal multiplexer */
  writeCommand: (command: string) => Promise<boolean>;
  /** Check if the session has been stopped */
  isStopped: () => boolean;
}

/**
 * Events emitted by SessionCompactContinue.
 */
export interface SessionCompactContinueEvents {
  /** /compact command was sent */
  compactSent: () => void;
  /** 'continue' command was sent */
  continueSent: () => void;
}

// ============================================================================
// SessionCompactContinue
// ============================================================================

/**
 * Manages auto-compact-and-continue automation for a Session.
 *
 * When enabled, detects compaction requests on idle transitions and
 * automatically sends /compact then continue.
 */
export class SessionCompactContinue extends EventEmitter {
  private _enabled: boolean = false;
  private _state: 'none' | 'sent_compact' = 'none';
  private readonly callbacks: CompactContinueCallbacks;

  constructor(callbacks: CompactContinueCallbacks) {
    super();
    this.callbacks = callbacks;
  }

  // ============================================================================
  // Getters / Setters
  // ============================================================================

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) {
      // Reset state when disabled
      this._state = 'none';
    }
  }

  get state(): 'none' | 'sent_compact' {
    return this._state;
  }

  // ============================================================================
  // Core Logic
  // ============================================================================

  /**
   * Called whenever the session transitions to idle.
   * Drives the state machine: detect → /compact → continue.
   */
  async onIdle(workingDir: string, textOutput: string): Promise<void> {
    if (!this._enabled) return;
    if (this.callbacks.isStopped()) return;

    if (this._state === 'none') {
      // Check if Claude is requesting compaction
      const signal = await this._detectCompactionRequest(workingDir, textOutput);
      if (!signal) return;

      if (this.callbacks.isStopped()) return;
      console.log('[SessionCompactContinue] Compaction request detected, sending /compact');
      this._state = 'sent_compact';
      await this.callbacks.writeCommand('/compact\r');
      this.emit('compactSent');
    } else if (this._state === 'sent_compact') {
      // Compact completed (idle fired again) — send continue
      if (this.callbacks.isStopped()) return;
      console.log('[SessionCompactContinue] Compact complete, sending continue');
      this._state = 'none';
      await this.callbacks.writeCommand('continue\r');
      this.emit('continueSent');
    }
  }

  // ============================================================================
  // Detection
  // ============================================================================

  /**
   * Checks whether Claude has written a compaction request.
   *
   * Primary: COMPACT.md exists in workingDir and was modified within the last 30s.
   * Fallback: Recent terminal output contains compaction-request phrases.
   */
  private async _detectCompactionRequest(workingDir: string, textOutput: string): Promise<boolean> {
    // Primary: check for fresh COMPACT.md
    if (workingDir) {
      try {
        const compactMdPath = join(workingDir, 'COMPACT.md');
        const stat = await fs.stat(compactMdPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs <= COMPACT_MD_MAX_AGE_MS) {
          console.log(`[SessionCompactContinue] COMPACT.md found (age ${ageMs}ms)`);
          return true;
        }
      } catch {
        // File does not exist — fall through to phrase detection
      }
    }

    // Fallback: scan last N lines for compaction-request phrases
    if (textOutput) {
      const lines = textOutput.split('\n');
      const recentLines = lines.slice(-SCAN_LINES).join('\n');
      for (const pattern of COMPACTION_PATTERNS) {
        if (pattern.test(recentLines)) {
          console.log(`[SessionCompactContinue] Compaction phrase detected: ${pattern}`);
          return true;
        }
      }
    }

    return false;
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Reset state. Called when the session stops or the feature is torn down.
   */
  destroy(): void {
    this._state = 'none';
  }
}

/**
 * @fileoverview Spawn Detector - Detects spawn1337 tags in terminal output.
 *
 * Monitors terminal output for spawn protocol patterns:
 * - <spawn1337>filename.md</spawn1337> - Agent spawn request
 * - <spawn1337-status agentId="..."/> - Status query
 * - <spawn1337-cancel agentId="..."/> - Cancel request
 * - <spawn1337-message agentId="...">content</spawn1337-message> - Message to child
 *
 * Same architecture as ralph-tracker.ts: line-buffered, auto-enabling,
 * debounced events, pre-compiled patterns.
 *
 * @module spawn-detector
 */

import { EventEmitter } from 'node:events';
import { SpawnTrackerState, createInitialSpawnTrackerState } from './spawn-types.js';

// ========== Configuration Constants ==========

/** Debounce interval for state event emissions (ms) */
const EVENT_DEBOUNCE_MS = 50;

/** Maximum line buffer size to prevent unbounded growth */
const MAX_LINE_BUFFER_SIZE = 64 * 1024;

// ========== Pre-compiled Regex Patterns ==========

/** Matches spawn request tags: <spawn1337>filename.md</spawn1337> */
const SPAWN_TAG_PATTERN = /<spawn1337>([^<]+)<\/spawn1337>/;

/** Quick check string before running regex */
const SPAWN_QUICK_CHECK = 'spawn1337';

/** Matches status query: <spawn1337-status agentId="..."/> */
const SPAWN_STATUS_PATTERN = /<spawn1337-status\s+agentId="([^"]+)"\s*\/>/;

/** Matches cancel request: <spawn1337-cancel agentId="..."/> */
const SPAWN_CANCEL_PATTERN = /<spawn1337-cancel\s+agentId="([^"]+)"\s*\/>/;

/** Matches message to child: <spawn1337-message agentId="...">content</spawn1337-message> */
const SPAWN_MESSAGE_PATTERN = /<spawn1337-message\s+agentId="([^"]+)">([\s\S]*?)<\/spawn1337-message>/;

/** Removes ANSI escape codes from terminal output */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

// ========== Event Types ==========

/**
 * Events emitted by SpawnDetector
 */
export interface SpawnDetectorEvents {
  /** Emitted when a spawn request tag is detected */
  spawnRequested: (filePath: string, rawLine: string) => void;
  /** Emitted when a status query is detected */
  statusRequested: (agentId: string) => void;
  /** Emitted when a cancel request is detected */
  cancelRequested: (agentId: string) => void;
  /** Emitted when a message to child is detected */
  messageToChild: (agentId: string, content: string) => void;
  /** Emitted when tracker state changes */
  stateUpdate: (state: SpawnTrackerState) => void;
}

/**
 * SpawnDetector - Parses terminal output to detect spawn1337 protocol tags.
 *
 * This class monitors Claude Code session output to detect agent spawn requests
 * and related communication patterns. It auto-enables when any spawn1337 pattern
 * is first detected, reducing overhead for sessions not using the spawn protocol.
 *
 * ## Pattern Detection
 *
 * 1. **Spawn Request**: `<spawn1337>path/to/task.md</spawn1337>`
 * 2. **Status Query**: `<spawn1337-status agentId="id"/>`
 * 3. **Cancel Request**: `<spawn1337-cancel agentId="id"/>`
 * 4. **Message**: `<spawn1337-message agentId="id">content</spawn1337-message>`
 *
 * @extends EventEmitter
 */
export class SpawnDetector extends EventEmitter {
  /** Whether the detector is actively monitoring output */
  private _enabled: boolean = false;

  /** Buffer for incomplete lines from terminal data */
  private _lineBuffer: string = '';

  /** Current tracker state */
  private _state: SpawnTrackerState;

  /** Debounce timer for state events */
  private _stateUpdateTimer: NodeJS.Timeout | null = null;

  /** Flag indicating pending state update emission */
  private _stateUpdatePending: boolean = false;

  constructor() {
    super();
    this._state = createInitialSpawnTrackerState();
  }

  /**
   * Whether the detector is enabled and actively monitoring output.
   */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Get a copy of the current tracker state.
   */
  get state(): SpawnTrackerState {
    return { ...this._state };
  }

  /**
   * Enable the detector to start monitoring terminal output.
   */
  enable(): void {
    if (!this._enabled) {
      this._enabled = true;
      this._state.enabled = true;
      this.emitStateUpdateDebounced();
    }
  }

  /**
   * Disable the detector.
   */
  disable(): void {
    if (this._enabled) {
      this._enabled = false;
      this._state.enabled = false;
      this.emitStateUpdateDebounced();
    }
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.clearDebounceTimers();
    this._enabled = false;
    this._lineBuffer = '';
    this._state = createInitialSpawnTrackerState();
    this.emit('stateUpdate', this.state);
  }

  /**
   * Update state from orchestrator data.
   * Called by server.ts when orchestrator state changes.
   */
  updateState(state: Partial<SpawnTrackerState>): void {
    Object.assign(this._state, state);
    this.emitStateUpdateDebounced();
  }

  /**
   * Process raw terminal data to detect spawn patterns.
   *
   * @param data - Raw terminal data (may include ANSI codes)
   */
  processTerminalData(data: string): void {
    // Remove ANSI escape codes
    const cleanData = data.replace(ANSI_ESCAPE_PATTERN, '');

    // Buffer data for line-based processing
    this._lineBuffer += cleanData;

    // Prevent unbounded line buffer growth
    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      this._lineBuffer = this._lineBuffer.slice(-MAX_LINE_BUFFER_SIZE / 2);
    }

    // Quick pre-check: if no spawn patterns in buffer, just drain lines
    if (!this._lineBuffer.includes(SPAWN_QUICK_CHECK)) {
      const lines = this._lineBuffer.split('\n');
      this._lineBuffer = lines.pop() || '';
      return;
    }

    // Auto-enable on first spawn pattern detection
    if (!this._enabled) {
      this.enable();
    }

    // Process complete lines
    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line);
    }

    // Also check the full chunk for multi-line patterns (message tag can span lines)
    this.checkMultiLinePatterns(cleanData);
  }

  /**
   * Process a single line for spawn patterns.
   */
  private processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(SPAWN_QUICK_CHECK)) return;

    // Check spawn request: <spawn1337>filename.md</spawn1337>
    const spawnMatch = trimmed.match(SPAWN_TAG_PATTERN);
    if (spawnMatch) {
      const filePath = spawnMatch[1].trim();
      this._state.totalSpawned++;
      this.emit('spawnRequested', filePath, trimmed);
      this.emitStateUpdateDebounced();
      return;
    }

    // Check status query: <spawn1337-status agentId="..."/>
    const statusMatch = trimmed.match(SPAWN_STATUS_PATTERN);
    if (statusMatch) {
      this.emit('statusRequested', statusMatch[1]);
      return;
    }

    // Check cancel request: <spawn1337-cancel agentId="..."/>
    const cancelMatch = trimmed.match(SPAWN_CANCEL_PATTERN);
    if (cancelMatch) {
      this.emit('cancelRequested', cancelMatch[1]);
      return;
    }

    // Check message (single line): <spawn1337-message agentId="...">content</spawn1337-message>
    const msgMatch = trimmed.match(SPAWN_MESSAGE_PATTERN);
    if (msgMatch) {
      this.emit('messageToChild', msgMatch[1], msgMatch[2]);
      return;
    }
  }

  /**
   * Check for patterns that might span multiple lines.
   * The message tag content can be multiline.
   */
  private checkMultiLinePatterns(data: string): void {
    if (!data.includes('spawn1337-message')) return;

    const msgMatch = data.match(SPAWN_MESSAGE_PATTERN);
    if (msgMatch) {
      this.emit('messageToChild', msgMatch[1], msgMatch[2]);
    }
  }

  /**
   * Emit stateUpdate with debouncing.
   */
  private emitStateUpdateDebounced(): void {
    this._stateUpdatePending = true;
    if (this._stateUpdateTimer) {
      clearTimeout(this._stateUpdateTimer);
    }
    this._stateUpdateTimer = setTimeout(() => {
      if (this._stateUpdatePending) {
        this._stateUpdatePending = false;
        this._stateUpdateTimer = null;
        this.emit('stateUpdate', this.state);
      }
    }, EVENT_DEBOUNCE_MS);
  }

  /**
   * Flush any pending debounced events immediately.
   */
  flushPendingEvents(): void {
    if (this._stateUpdatePending) {
      this._stateUpdatePending = false;
      if (this._stateUpdateTimer) {
        clearTimeout(this._stateUpdateTimer);
        this._stateUpdateTimer = null;
      }
      this.emit('stateUpdate', this.state);
    }
  }

  /**
   * Clear all debounce timers.
   */
  private clearDebounceTimers(): void {
    if (this._stateUpdateTimer) {
      clearTimeout(this._stateUpdateTimer);
      this._stateUpdateTimer = null;
    }
    this._stateUpdatePending = false;
  }
}

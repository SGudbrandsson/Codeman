/**
 * @fileoverview Codex busy/idle from its rollout's persisted turn records.
 *
 * codex writes `event_msg/task_started` when a turn begins and `task_complete` or
 * `turn_aborted` when it ends. This monitor locates the session's rollout, derives the initial
 * state with a bounded backward scan, then tails the file. See
 * docs/superpowers/specs/2026-09-10-harness-activity-detection-design.md §5 and §6.
 *
 * - Startup: seed from the backward scan, catch up silently to the current EOF, publish once
 *   (emit `working` only if the resulting state is working).
 * - `turnOpen` is set by a turn start and cleared only by an authoritative end. A stale timeout
 *   emits `idle { stale }` and keeps it open, so the real end still emits `idle { completed }`.
 * - Replacement (inode change) and truncation reset and rescan; delete re-runs locate.
 *
 * @module codex-transcript-activity-monitor
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type { ActivityMonitor, ActivityState } from './activity-monitor.js';
import type { ActivitySignal, TranscriptAdapter } from './harnesses/transcripts/types.js';
import type { IdleInfo } from './types/activity.js';

export const CODEX_SCAN_CHUNK_BYTES = 256 * 1024;
export const CODEX_SCAN_BUDGET_BYTES = 16 * 1024 * 1024;
export const CODEX_PENDING_CAP_BYTES = 4 * 1024 * 1024;
/** Upper bound on bytes read per forward pass; passes loop until caught up. */
export const CODEX_READ_PASS_BYTES = 4 * 1024 * 1024;
export const CODEX_ACTIVITY_POLL_MS = 2000;
export const CODEX_ACTIVITY_STALE_MS = 5 * 60 * 1000;
/** Consecutive replacements tolerated during one scan/attach before retrying later. */
const MAX_RESCANS = 5;

const EMPTY = Buffer.alloc(0);
const NEWLINE = 0x0a;

export type ActivityAdapter = Pick<TranscriptAdapter, 'locate' | 'classifyActivity'>;

export interface CodexActivityContext {
  workingDir: string;
  sessionId: string;
  harnessSessionId?: string;
}

export interface FileWatchHandle {
  close(): void;
}

export interface CodexActivityOptions {
  chunkBytes?: number;
  scanBudgetBytes?: number;
  pendingCapBytes?: number;
  pollMs?: number;
  staleMs?: number;
  /** Test seam: `fs.statSync`. */
  statFn?: (path: string) => { ino: number; size: number };
  /** Test seam: arm a change/rename watcher on `path`. May throw; polling covers it. */
  watchFn?: (path: string, onEvent: (event: string) => void) => FileWatchHandle;
}

interface ScanOutcome {
  signal: 'working' | 'idle' | 'unknown';
  /** Bytes after the last newline at the captured EOF: the pending buffer's seed. */
  trailing: Buffer;
  /** The trailing fragment exceeded the pending cap: discard until the next newline. */
  trailingOverflow: boolean;
}

type ReadOutcome = 'ok' | 'resync' | 'gone';

function defaultWatch(path: string, onEvent: (event: string) => void): FileWatchHandle {
  const watcher = fs.watch(path, { persistent: false }, (event) => onEvent(event));
  watcher.on('error', () => {
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  });
  return watcher;
}

export class CodexTranscriptActivityMonitor extends EventEmitter implements ActivityMonitor {
  private _state: ActivityState = 'unknown';
  private _turnOpen = false;
  /** Bumped on every (re)attach, id change and stop; timer and watcher callbacks check it. */
  private _generation = 0;
  private _started = false;
  private _stopped = false;
  private _harnessSessionId: string | undefined;

  private _path: string | null = null;
  private _inode = 0;
  private _offset = 0;
  private _pending: Buffer = EMPTY;
  private _discardUntilNewline = false;
  private _warnedOverflow = false;

  private _watcher: FileWatchHandle | null = null;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _locateTimer: ReturnType<typeof setInterval> | null = null;
  private _staleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _chunkBytes: number;
  private readonly _scanBudgetBytes: number;
  private readonly _pendingCapBytes: number;
  private readonly _pollMs: number;
  private readonly _staleMs: number;
  private readonly _stat: (path: string) => { ino: number; size: number };
  private readonly _watch: (path: string, onEvent: (event: string) => void) => FileWatchHandle;

  constructor(
    private readonly _adapter: ActivityAdapter,
    private readonly _ctx: CodexActivityContext,
    opts: CodexActivityOptions = {}
  ) {
    super();
    this._harnessSessionId = _ctx.harnessSessionId;
    this._chunkBytes = Math.max(1, opts.chunkBytes ?? CODEX_SCAN_CHUNK_BYTES);
    this._scanBudgetBytes = opts.scanBudgetBytes ?? CODEX_SCAN_BUDGET_BYTES;
    this._pendingCapBytes = opts.pendingCapBytes ?? CODEX_PENDING_CAP_BYTES;
    this._pollMs = opts.pollMs ?? CODEX_ACTIVITY_POLL_MS;
    this._staleMs = opts.staleMs ?? CODEX_ACTIVITY_STALE_MS;
    this._stat = opts.statFn ?? ((p) => fs.statSync(p));
    this._watch = opts.watchFn ?? defaultWatch;
  }

  get state(): ActivityState {
    return this._state;
  }

  async start(): Promise<void> {
    if (this._started || this._stopped) return;
    this._started = true;
    this._locateAndAttach();
  }

  stop(): void {
    this._stopped = true;
    this._generation++;
    this._teardownFile();
    this._clearLocateTimer();
    this._clearStaleTimer();
  }

  setHarnessSessionId(id: string): void {
    if (this._stopped || id === this._harnessSessionId) return;
    this._harnessSessionId = id;
    this._generation++;
    if (!this._started) return;
    this._teardownFile();
    this._clearLocateTimer();
    this._locateAndAttach();
  }

  // ─── Locating ────────────────────────────────────────────────────────────

  private _locate(): string | null {
    try {
      return this._adapter.locate({
        workingDir: this._ctx.workingDir,
        sessionId: this._ctx.sessionId,
        harnessSessionId: this._harnessSessionId,
      });
    } catch {
      return null;
    }
  }

  /** Try now; on a miss, retry every poll interval. */
  private _locateAndAttach(): void {
    if (this._stopped) return;
    const path = this._locate();
    if (path) {
      this._clearLocateTimer();
      this._attach(path);
    } else {
      this._scheduleLocate();
    }
  }

  private _scheduleLocate(): void {
    if (this._stopped || this._locateTimer) return;
    this._locateTimer = setInterval(() => {
      if (this._stopped) return;
      const path = this._locate();
      if (!path) return;
      this._clearLocateTimer();
      this._attach(path);
    }, this._pollMs);
    this._locateTimer.unref?.();
  }

  private _clearLocateTimer(): void {
    if (this._locateTimer) {
      clearInterval(this._locateTimer);
      this._locateTimer = null;
    }
  }

  // ─── Attach: scan, watch, silent catch-up, publish ───────────────────────

  /**
   * (Re)attach to `path`. Used at startup and after replacement/truncation. State changes
   * during the scan and catch-up are silent; the net change is published once at the end.
   */
  private _attach(path: string): void {
    const prevState = this._state;
    const prevTurnOpen = this._turnOpen;

    for (let attempt = 0; attempt < MAX_RESCANS && !this._stopped; attempt++) {
      this._teardownFile();
      const scanned = this._scan(path);
      if (!scanned) break;
      const { outcome, ino, size } = scanned;

      this._path = path;
      this._inode = ino;
      this._offset = size;
      this._pending = outcome.trailing;
      this._discardUntilNewline = outcome.trailingOverflow;
      if (outcome.signal === 'unknown') {
        // Unknown says nothing about an open turn; keep it so a later end still completes.
        this._state = 'unknown';
        this._turnOpen = prevTurnOpen;
      } else {
        this._state = outcome.signal;
        this._turnOpen = outcome.signal === 'working';
      }

      const gen = ++this._generation;
      this._armWatcher(path, gen);
      const read = this._readForward(true);
      if (read === 'resync') continue;
      if (read === 'gone') break;

      this._startPoll(gen);
      this._publish(prevState, prevTurnOpen);
      return;
    }

    // Missing or repeatedly replaced: publish what is known, then keep locating.
    this._teardownFile();
    this._publish(prevState, prevTurnOpen);
    this._scheduleLocate();
  }

  private _publish(prevState: ActivityState, prevTurnOpen: boolean): void {
    if (this._stopped) return;
    if (this._state === 'working') {
      if (prevState !== 'working') this.emit('working');
      this._resetStaleTimer();
      return;
    }
    this._clearStaleTimer();
    if (this._state === 'idle') {
      if (prevTurnOpen && !this._turnOpen) this._emitIdle({ reason: 'completed' });
    } else if (prevState === 'working') {
      // Tracking lost mid-turn (the rescan found no boundary): stale, turn stays open.
      this._emitIdle({ reason: 'stale' });
    }
  }

  private _emitIdle(info: IdleInfo): void {
    this.emit('idle', info);
  }

  private _armWatcher(path: string, gen: number): void {
    try {
      this._watcher = this._watch(path, () => {
        if (this._stopped || gen !== this._generation) return;
        this._onFileEvent();
      });
    } catch {
      this._watcher = null; // the poll still detects changes
    }
  }

  private _startPoll(gen: number): void {
    this._pollTimer = setInterval(() => {
      if (this._stopped || gen !== this._generation) return;
      this._onFileEvent();
    }, this._pollMs);
    this._pollTimer.unref?.();
  }

  private _teardownFile(): void {
    if (this._watcher) {
      try {
        this._watcher.close();
      } catch {
        /* already closed */
      }
      this._watcher = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._pending = EMPTY;
    this._discardUntilNewline = false;
  }

  /** A change/rename event or a poll tick. */
  private _onFileEvent(): void {
    const outcome = this._readForward(false);
    if (outcome === 'resync' && this._path) {
      this._attach(this._path);
    } else if (outcome === 'gone') {
      this._teardownFile();
      this._path = null;
      this._locateAndAttach();
    }
  }

  // ─── Backward scan ───────────────────────────────────────────────────────

  /** Scan, then stat again; rescan if the file was replaced or shrank meanwhile. */
  private _scan(path: string): { outcome: ScanOutcome; ino: number; size: number } | null {
    for (let attempt = 0; attempt < MAX_RESCANS; attempt++) {
      let before: { ino: number; size: number };
      try {
        before = this._stat(path);
      } catch {
        return null;
      }
      let outcome: ScanOutcome | null;
      try {
        outcome = this._scanFile(path, before.ino, before.size);
      } catch {
        return null;
      }
      let after: { ino: number; size: number };
      try {
        after = this._stat(path);
      } catch {
        return null;
      }
      if (!outcome || after.ino !== before.ino || after.size < before.size) continue;
      return { outcome, ino: before.ino, size: before.size };
    }
    return null;
  }

  /**
   * Read backward from `size` in chunks, newest complete line first, stopping at the first
   * boundary record. Returns null if the opened file is not the stat'ed one.
   */
  private _scanFile(path: string, ino: number, size: number): ScanOutcome | null {
    const fd = fs.openSync(path, 'r');
    try {
      if (fs.fstatSync(fd).ino !== ino) return null;

      let pos = size;
      let budget = this._scanBudgetBytes;
      let carry: Buffer = EMPTY; // incomplete leading fragment of the chunks read so far
      let trailing: Buffer | null = null; // set once the last newline before EOF is found

      for (;;) {
        if (pos === 0) {
          // No earlier bytes: the carried fragment is a complete line (or, with no newline in
          // the whole file, the trailing fragment itself).
          if (trailing === null) return this._scanResult('unknown', carry);
          return { signal: this._classify(carry) ?? 'unknown', ...this._trailingSeed(trailing) };
        }
        if (budget <= 0) {
          // The budget cut through an unclassified record: never accept an older boundary.
          return trailing === null
            ? { signal: 'unknown', trailing: EMPTY, trailingOverflow: true }
            : { signal: 'unknown', ...this._trailingSeed(trailing) };
        }

        const len = Math.min(this._chunkBytes, pos, budget);
        pos -= len;
        budget -= len;
        const chunk = Buffer.alloc(len);
        if (fs.readSync(fd, chunk, 0, len, pos) !== len) return null; // shrank mid-scan
        const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;

        let end = buf.length;
        if (trailing === null) {
          const nl = buf.lastIndexOf(NEWLINE);
          if (nl === -1) {
            carry = buf;
            continue;
          }
          trailing = Buffer.from(buf.subarray(nl + 1));
          end = nl;
        }
        while (end > 0) {
          const nl = buf.lastIndexOf(NEWLINE, end - 1);
          if (nl === -1) break;
          const signal = this._classify(buf.subarray(nl + 1, end));
          if (signal) return { signal, ...this._trailingSeed(trailing) };
          end = nl;
        }
        carry = Buffer.from(buf.subarray(0, end));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private _scanResult(signal: ScanOutcome['signal'], trailing: Buffer): ScanOutcome {
    return { signal, ...this._trailingSeed(trailing) };
  }

  private _trailingSeed(trailing: Buffer): Pick<ScanOutcome, 'trailing' | 'trailingOverflow'> {
    return trailing.length > this._pendingCapBytes
      ? { trailing: EMPTY, trailingOverflow: true }
      : { trailing, trailingOverflow: false };
  }

  // ─── Forward tail ────────────────────────────────────────────────────────

  /** Read from the consumed offset to the current size, in bounded passes. */
  private _readForward(silent: boolean): ReadOutcome {
    const path = this._path;
    if (!path) return 'gone';
    for (;;) {
      if (this._stopped) return 'ok';
      let st: { ino: number; size: number };
      try {
        st = this._stat(path);
      } catch {
        return 'gone';
      }
      if (st.ino !== this._inode || st.size < this._offset) return 'resync';
      if (st.size === this._offset) return 'ok';

      const len = Math.min(CODEX_READ_PASS_BYTES, st.size - this._offset);
      const buf = Buffer.alloc(len);
      let bytesRead: number;
      try {
        const fd = fs.openSync(path, 'r');
        try {
          if (fs.fstatSync(fd).ino !== this._inode) return 'resync';
          bytesRead = fs.readSync(fd, buf, 0, len, this._offset);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return 'gone';
      }
      if (bytesRead <= 0) return 'ok';
      this._offset += bytesRead;

      const gen = this._generation;
      this._consume(bytesRead === len ? buf : buf.subarray(0, bytesRead), silent);
      if (this._stopped || gen !== this._generation) return 'ok';
      // Any write while working proves the turn is alive.
      if (!silent && this._state === 'working') this._resetStaleTimer();
    }
  }

  private _consume(data: Buffer, silent: boolean): void {
    const gen = this._generation;
    let chunk = data;
    if (this._discardUntilNewline) {
      const nl = chunk.indexOf(NEWLINE);
      if (nl === -1) return;
      chunk = chunk.subarray(nl + 1);
      this._discardUntilNewline = false;
    }
    const buf = this._pending.length ? Buffer.concat([this._pending, chunk]) : chunk;
    let start = 0;
    for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
      const signal = this._classify(buf.subarray(start, nl));
      start = nl + 1;
      this._applySignal(signal, silent);
      if (this._stopped || gen !== this._generation) return;
    }
    const rest = buf.subarray(start);
    if (rest.length > this._pendingCapBytes) {
      this._pending = EMPTY;
      this._discardUntilNewline = true;
      if (!this._warnedOverflow) {
        this._warnedOverflow = true;
        console.warn(
          `[CodexActivity] rollout record over ${this._pendingCapBytes} bytes in ${this._path}; skipping it`
        );
      }
    } else {
      this._pending = Buffer.from(rest);
    }
  }

  private _applySignal(signal: ActivitySignal, silent: boolean): void {
    if (signal === 'working') {
      this._turnOpen = true;
      if (this._state !== 'working') {
        this._state = 'working';
        if (!silent) {
          this.emit('working');
          this._resetStaleTimer();
        }
      }
    } else if (signal === 'idle') {
      if (this._turnOpen) {
        // Authoritative end of an open turn: completed, even if it already went stale.
        this._turnOpen = false;
        this._state = 'idle';
        if (!silent) {
          this._clearStaleTimer();
          this._emitIdle({ reason: 'completed' });
        }
      } else {
        this._state = 'idle';
      }
    }
  }

  private _classify(line: Buffer): ActivitySignal {
    if (!line.length) return null;
    const text = line.toString('utf8').trim();
    if (!text) return null;
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      return null;
    }
    try {
      return this._adapter.classifyActivity?.(record) ?? null;
    } catch {
      return null;
    }
  }

  // ─── Staleness ───────────────────────────────────────────────────────────

  private _resetStaleTimer(): void {
    this._clearStaleTimer();
    this._staleTimer = setTimeout(() => {
      this._staleTimer = null;
      if (this._stopped || this._state !== 'working') return;
      // Tracking lost while a turn is open: stale idle, turnOpen stays set.
      this._state = 'idle';
      this._emitIdle({ reason: 'stale' });
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

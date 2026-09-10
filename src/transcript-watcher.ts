/**
 * @fileoverview Transcript Watcher - Real-time monitoring of session transcripts
 *
 * Watches a session transcript JSONL file and emits:
 * - `transcript:block` for every harness with a viewable transcript (via its adapter)
 * - Claude-only state events (completion, tool state, errors, plan mode, AskUserQuestion)
 *   when constructed with `claudeState: true` (the default)
 *
 * For Claude the transcript path is provided by Claude Code hooks in the `transcript_path`
 * field. Codex and pi watchers are view-only: they run with `claudeState: false`, so the
 * Claude state machine below never sees their records.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { watch, statSync, existsSync, FSWatcher } from 'node:fs';
import { open } from 'node:fs/promises';
import type { TranscriptBlock } from './types/index.js';
import { seqBaseForOffset } from './types/transcript-blocks.js';
import type { TranscriptAdapter } from './harnesses/transcripts/types.js';
import { claudeTranscriptAdapter } from './harnesses/transcripts/claude.js';

// ========== Types ==========

/**
 * Parsed transcript entry from the JSONL file
 */
export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'system' | 'result';
  timestamp: string;
  message?: {
    role: string;
    content: string | TranscriptContentBlock[];
  };
  total_cost_usd?: number;
  duration_ms?: number;
  error?: {
    type: string;
    message: string;
  };
}

export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
}

/**
 * Detected state from transcript analysis
 */
export interface TranscriptState {
  /** Whether the last entry indicates completion */
  isComplete: boolean;
  /** Whether a tool is currently executing */
  toolExecuting: boolean;
  /** Current tool name if executing */
  currentTool: string | null;
  /** Whether an error was detected */
  hasError: boolean;
  /** Error message if any */
  errorMessage: string | null;
  /** Whether a plan mode prompt was detected */
  planModeDetected: boolean;
  /** Last assistant message (truncated) */
  lastAssistantMessage: string | null;
  /** Total entries processed */
  entryCount: number;
  /** Last update timestamp */
  lastUpdateAt: string | null;
}

export interface AskUserQuestionData {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

export interface TranscriptWatcherEvents {
  'transcript:update': (state: TranscriptState) => void;
  'transcript:complete': (state: TranscriptState) => void;
  'transcript:tool_start': (toolName: string) => void;
  'transcript:tool_end': (toolName: string, isError: boolean) => void;
  'transcript:error': (error: Error) => void;
  'transcript:plan_mode': () => void;
  'transcript:block': (block: TranscriptBlock) => void;
  'transcript:clear': () => void;
  'transcript:ask_user_question': (questions: AskUserQuestionData[]) => void;
  'transcript:ask_user_question_resolved': () => void;
}

/** Options for start() / updatePath(). */
export interface TranscriptStartOptions {
  /**
   * Byte offset to start reading an EXISTING file from. Default: its current size (only new
   * entries). A file that does not exist yet is always read from 0 once it appears.
   */
  fromOffset?: number;
}

export interface TranscriptWatcherOptions {
  /**
   * Run the Claude state machine (completion, tool state, plan mode, AskUserQuestion).
   * Only true for harnesses with `caps.claudeTranscript`. Default true.
   */
  claudeState?: boolean;
  /** Converts raw records into blocks. Default: the Claude adapter. */
  adapter?: TranscriptAdapter;
}

/** One JSON-parsed JSONL line and the file byte offset it starts at. */
interface RawRecord {
  record: unknown;
  offset: number;
}

// ========== Constants ==========

/** How often to check for new content when file watching fails */
const POLL_INTERVAL_MS = 1000;

/**
 * While a file watcher is armed, stat the file this often as well. fs.watch follows the
 * inode, so a rename-over replacement (even at equal size) or a missed change event would
 * otherwise go unnoticed.
 */
const STAT_POLL_INTERVAL_MS = 2000;

/** Max characters to keep for lastAssistantMessage */
const MAX_MESSAGE_LENGTH = 500;

/** Patterns that indicate plan mode / approval prompt */
const PLAN_MODE_PATTERNS = [/ExitPlanMode/i, /AskUserQuestion/i, /Ready for user approval/i, /approve.*plan/i];

// ========== TranscriptWatcher Class ==========

export class TranscriptWatcher extends EventEmitter {
  private _transcriptPath: string | null = null;
  private fileWatcher: FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  /** Inode/shrink check while watching (separate from pollInterval, which only waits for the file to exist). */
  private statPollInterval: NodeJS.Timeout | null = null;
  private filePosition: number = 0;
  /** Inode of the file the current filePosition refers to; null until first stat. */
  private _inode: number | null = null;
  private _transcriptId: string = randomUUID();
  private _isRunning: boolean = false;
  private _isProcessing: boolean = false;
  private state: TranscriptState = this.getInitialState();
  /** Whether an AskUserQuestion is pending (waiting for user response). */
  private _pendingAskUserQuestion: boolean = false;
  /** Whether this watcher runs the Claude state machine (false for view-only codex/pi watchers). */
  readonly claudeState: boolean;
  private readonly adapter: TranscriptAdapter;

  constructor(opts: TranscriptWatcherOptions = {}) {
    super();
    this.claudeState = opts.claudeState ?? true;
    this.adapter = opts.adapter ?? claudeTranscriptAdapter;
  }

  /**
   * Identity of the file content being streamed. Regenerated whenever the watcher starts on a
   * file, changes path, or detects that the file was replaced or truncated. Clients use it to
   * tell blocks from two files apart (seq restarts in every file).
   */
  get transcriptId(): string {
    return this._transcriptId;
  }

  /** The path to the transcript JSONL file being watched, or null if not started. */
  get transcriptPath(): string | null {
    return this._transcriptPath;
  }

  private getInitialState(): TranscriptState {
    return {
      isComplete: false,
      toolExecuting: false,
      currentTool: null,
      hasError: false,
      errorMessage: null,
      planModeDetected: false,
      lastAssistantMessage: null,
      entryCount: 0,
      lastUpdateAt: null,
    };
  }

  // ========== Public API ==========

  /**
   * Start watching a transcript file
   * @param transcriptPath - Path to the JSONL transcript file
   * @param opts.fromOffset - where to start reading an existing file (default: EOF)
   */
  start(transcriptPath: string, opts?: TranscriptStartOptions): void {
    if (this._isRunning && this._transcriptPath === transcriptPath) {
      return; // Already watching this file
    }
    this._begin(transcriptPath, opts, false);
  }

  /**
   * (Re)start on a path. `emitClear` is updatePath()'s transcript:clear, emitted after the new
   * transcriptId is set so the event carries the id of the file that follows it.
   */
  private _begin(transcriptPath: string, opts: TranscriptStartOptions | undefined, emitClear: boolean): void {
    // Tear down any existing watcher without emitting transcript:clear (stop() would).
    this._cleanup();

    this._transcriptPath = transcriptPath;
    this._isRunning = true;
    this.state = this.getInitialState();
    this._pendingAskUserQuestion = false;
    this.filePosition = 0;
    this._inode = null;
    this._transcriptId = randomUUID();
    if (emitClear) this.emit('transcript:clear');

    // Check if file exists
    if (!existsSync(transcriptPath)) {
      // File doesn't exist yet, poll until it does
      this.startPolling();
      return;
    }

    // Get initial file size
    try {
      const stat = statSync(transcriptPath);
      // Default: start from the end to only process new entries
      this.filePosition = Math.min(opts?.fromOffset ?? stat.size, stat.size);
      this._inode = stat.ino;
    } catch {
      this.filePosition = 0;
    }

    // Start watching
    this.setupFileWatcher();
  }

  /**
   * Stop watching
   */
  stop(): void {
    this._cleanup();
    this.emit('transcript:clear');
  }

  /** Internal cleanup: tears down watchers/timers without emitting transcript:clear.
   * Called from start() which is invoked by updatePath() — updatePath already emits
   * the clear, so calling stop() inside start() would fire a redundant second clear. */
  private _cleanup(): void {
    this._isRunning = false;

    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.statPollInterval) {
      clearInterval(this.statPollInterval);
      this.statPollInterval = null;
    }

    this._transcriptPath = null;
    this._inode = null;
    this.state = this.getInitialState();
  }

  /**
   * Check if watcher is running
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Get current state
   */
  getState(): TranscriptState {
    return { ...this.state };
  }

  /**
   * Update the transcript path (e.g., from a new hook event)
   */
  updatePath(transcriptPath: string, opts?: TranscriptStartOptions): void {
    if (this._transcriptPath !== transcriptPath) {
      this._begin(transcriptPath, opts, true);
    }
  }

  // ========== Private Methods ==========

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(() => {
      if (!this._transcriptPath || !this._isRunning) return;

      if (existsSync(this._transcriptPath)) {
        // File now exists, switch to file watching
        clearInterval(this.pollInterval!);
        this.pollInterval = null;
        this.setupFileWatcher();
      }
    }, POLL_INTERVAL_MS);
  }

  private setupFileWatcher(): void {
    if (!this._transcriptPath || !this._isRunning) return;

    try {
      this.fileWatcher = watch(this._transcriptPath, (eventType) => {
        if (eventType === 'change') {
          this.processNewContent();
        } else if (eventType === 'rename') {
          // Renamed over, moved away or deleted: the watch is bound to the old inode.
          this.rearmFileWatcher();
        }
      });

      // Add error handler to prevent unhandled errors and fall back to polling
      this.fileWatcher.on('error', (err) => {
        this.emit('transcript:error', err as Error);
        this.fileWatcher?.close();
        this.fileWatcher = null;
        // Fall back to polling on error
        if (this._isRunning) {
          this.startPolling();
        }
      });

      this.startStatPoll();

      // Initial read
      this.processNewContent();
    } catch (err) {
      // Fall back to polling if watch fails
      this.emit('transcript:error', err as Error);
      this.startPolling();
    }
  }

  /** Close the file watcher and watch the path again (or wait for it to reappear). */
  private rearmFileWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (!this._transcriptPath || !this._isRunning) return;
    if (existsSync(this._transcriptPath)) {
      this.setupFileWatcher();
    } else {
      this.startPolling();
    }
  }

  /** Periodic stat while watching: catches replacement, truncation and missed change events. */
  private startStatPoll(): void {
    if (this.statPollInterval) return;
    this.statPollInterval = setInterval(() => {
      if (!this._transcriptPath || !this._isRunning) return;
      if (!existsSync(this._transcriptPath)) {
        if (this.fileWatcher) this.rearmFileWatcher();
        return;
      }
      void this.processNewContent();
    }, STAT_POLL_INTERVAL_MS);
  }

  private async processNewContent(): Promise<void> {
    if (!this._transcriptPath || !this._isRunning) return;
    if (this._isProcessing) return; // Guard against concurrent calls
    this._isProcessing = true;

    try {
      const stat = statSync(this._transcriptPath);
      const replaced = this._inode !== null && stat.ino !== this._inode;
      this._inode = stat.ino;
      if (replaced || stat.size < this.filePosition) {
        // File was replaced (new inode, any size) or truncated — new identity; tell the
        // frontend to clear its view, then re-read from start
        this.filePosition = 0;
        this.state = this.getInitialState();
        this._transcriptId = randomUUID();
        this.emit('transcript:clear');
      } else if (stat.size === this.filePosition) {
        return; // No new content
      }

      // Read new content
      const newRecords = await this.readNewRecords();

      for (const { record, offset } of newRecords) {
        // Claude state machine — never runs for codex/pi records.
        if (this.claudeState) this.processEntry(record as TranscriptEntry);

        // Emit full block content for the transcript web view. The adapter receives the
        // raw record, not a Claude-typed entry, so any harness envelope survives intact.
        const blocks = this.adapter.parseRecord(record, seqBaseForOffset(offset));
        for (const block of blocks) {
          this.emit('transcript:block', block);
        }
      }

      if (this.claudeState && newRecords.length > 0) {
        this.emit('transcript:update', this.getState());
      }
    } catch (err) {
      this.emit('transcript:error', err as Error);
    } finally {
      this._isProcessing = false;
    }
  }

  /**
   * Read the bytes appended since `filePosition`, split them into lines while tracking each
   * line's exact start offset (readline hides offsets, and `seq` is derived from them), and
   * JSON-parse each line. Malformed complete lines are skipped. A trailing segment with no
   * newline that does not parse yet is left unconsumed, so a line caught mid-write is read
   * whole on the next change instead of being dropped.
   */
  private async readNewRecords(): Promise<RawRecord[]> {
    const transcriptPath = this._transcriptPath;
    if (!transcriptPath) return [];

    const fh = await open(transcriptPath, 'r');
    let buf: Buffer;
    const start = this.filePosition;
    try {
      const { size } = await fh.stat();
      const length = Math.max(0, size - start);
      buf = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await fh.read(buf, read, length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      buf = buf.subarray(0, read);
    } finally {
      await fh.close();
    }

    // The watcher may have been pointed elsewhere while we awaited the read.
    if (this._transcriptPath !== transcriptPath) return [];

    const records: RawRecord[] = [];
    let pos = 0;
    let consumed = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      const end = nl === -1 ? buf.length : nl;
      const line = buf.toString('utf-8', pos, end);
      if (line.trim()) {
        try {
          records.push({ record: JSON.parse(line) as unknown, offset: start + pos });
        } catch {
          // Partial trailing line: stop here and re-read it once the writer finishes.
          if (nl === -1) break;
          // Otherwise a malformed complete line — skip it.
        }
      }
      pos = nl === -1 ? buf.length : nl + 1;
      consumed = pos;
    }
    this.filePosition = start + consumed;
    return records;
  }

  private processEntry(entry: TranscriptEntry): void {
    if (!entry || typeof entry !== 'object') return;
    this.state.entryCount++;
    this.state.lastUpdateAt = entry.timestamp || new Date().toISOString();

    // Handle based on entry type
    switch (entry.type) {
      case 'assistant':
        this.handleAssistantEntry(entry);
        break;
      case 'result':
        this.handleResultEntry(entry);
        break;
      case 'user':
        // User message means new turn, reset some state
        this.state.isComplete = false;
        this.state.hasError = false;
        this.state.errorMessage = null;
        // If an AskUserQuestion was pending, the user has now responded
        if (this._pendingAskUserQuestion) {
          this._pendingAskUserQuestion = false;
          this.emit('transcript:ask_user_question_resolved');
        }
        break;
      case 'system':
        // System messages are informational
        break;
    }

    // Check for plan mode patterns
    this.checkPlanMode(entry);
  }

  private handleAssistantEntry(entry: TranscriptEntry): void {
    if (!entry.message?.content) return;

    const content = entry.message.content;

    if (typeof content === 'string') {
      this.state.lastAssistantMessage = content.slice(0, MAX_MESSAGE_LENGTH);
    } else if (Array.isArray(content)) {
      // Process content blocks
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && block.text) {
          this.state.lastAssistantMessage = block.text.slice(0, MAX_MESSAGE_LENGTH);
        } else if (block.type === 'tool_use' && block.name) {
          // Tool started
          this.state.toolExecuting = true;
          this.state.currentTool = block.name;
          this.emit('transcript:tool_start', block.name);
          // AskUserQuestion: emit structured question data for the web UI dialog
          if (block.name === 'AskUserQuestion' && Array.isArray(block.input?.questions)) {
            this._pendingAskUserQuestion = true;
            this.emit('transcript:ask_user_question', block.input.questions as AskUserQuestionData[]);
          }
        } else if (block.type === 'tool_result') {
          // Tool completed
          const wasError = block.is_error === true;
          const toolName = this.state.currentTool;
          this.state.toolExecuting = false;
          this.state.currentTool = null;
          if (toolName) {
            this.emit('transcript:tool_end', toolName, wasError);
          }
          if (wasError && block.content) {
            this.state.hasError = true;
            this.state.errorMessage = String(block.content).slice(0, 200);
          }
        }
      }
    }
  }

  private handleResultEntry(entry: TranscriptEntry): void {
    // Result entry indicates completion
    this.state.isComplete = true;
    this.state.toolExecuting = false;
    this.state.currentTool = null;

    if (entry.error) {
      this.state.hasError = true;
      this.state.errorMessage = entry.error.message?.slice(0, 200) || 'Unknown error';
    }

    this.emit('transcript:complete', this.getState());
  }

  private checkPlanMode(entry: TranscriptEntry): void {
    // Check assistant messages for plan mode patterns
    if (entry.type !== 'assistant' || !entry.message?.content) return;

    const content = entry.message.content;
    const textToCheck =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((b): b is { type: 'text'; text: string } => !!b && b.type === 'text' && !!b.text)
              .map((b) => b.text)
              .join(' ')
          : '';

    // Also check for tool_use with ExitPlanMode or AskUserQuestion
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_use' && block.name) {
          if (block.name === 'ExitPlanMode' || block.name === 'AskUserQuestion') {
            this.state.planModeDetected = true;
            this.emit('transcript:plan_mode');
            return;
          }
        }
      }
    }

    for (const pattern of PLAN_MODE_PATTERNS) {
      if (pattern.test(textToCheck)) {
        this.state.planModeDetected = true;
        this.emit('transcript:plan_mode');
        return;
      }
    }
  }
}

// ========== Singleton Export ==========

export const transcriptWatcher = new TranscriptWatcher();

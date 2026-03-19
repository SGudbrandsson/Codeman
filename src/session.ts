/**
 * @fileoverview Core PTY session wrapper for Claude CLI interactions.
 *
 * Manages a PTY (pseudo-terminal) process running Claude CLI or OpenCode CLI.
 * Three operation modes:
 * 1. **One-shot** (`runPrompt`): Single prompt → JSON response
 * 2. **Interactive** (`startInteractive`): Persistent interactive session
 * 3. **Shell** (`startShell`): Plain bash shell for debugging
 *
 * Optionally wraps in a tmux session for persistence across disconnects.
 * Tracks tokens, costs, background tasks, and auto-compact/clear.
 *
 * Key exports:
 * - `Session` class — main entity, extends EventEmitter
 * - `ClaudeMessage` interface — parsed JSON messages from Claude output
 * - `SessionEvents` interface — typed event map
 *
 * Key methods: `runPrompt()`, `startInteractive()`, `startShell()`,
 * `writeViaMux()`, `toState()`, `stop()`, `resize()`, `isIdle()`,
 * `setAutoCompact()`, `findTaskDescriptionNear()`, `getTerminalBuffer()`
 *
 * @dependencies session-cli-builder (args/env), session-auto-ops (auto-compact/clear),
 *   ralph-tracker (todo/completion parsing), bash-tool-parser (tool invocation tracking),
 *   task-tracker (background tasks), mux-interface (tmux abstraction)
 * @consumedby session-manager, web/server, respawn-controller
 * @emits session:terminal, session:idle, session:working, session:completion, session:exit
 *
 * @module session
 */

import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import {
  SessionState,
  SessionStatus,
  SessionConfig,
  RalphTrackerState,
  RalphTodoItem,
  ActiveBashTool,
  NiceConfig,
  DEFAULT_NICE_CONFIG,
  type ClaudeMode,
  type SessionMode,
  type OpenCodeConfig,
} from './types.js';
import type { TerminalMultiplexer, MuxSession } from './mux-interface.js';
import { TaskTracker, type BackgroundTask } from './task-tracker.js';
import { RalphTracker } from './ralph-tracker.js';
import { BashToolParser } from './bash-tool-parser.js';
import { BufferAccumulator } from './utils/buffer-accumulator.js';
import { stripAnsi } from './utils/regex-patterns.js';
import {
  ANSI_ESCAPE_PATTERN_FULL,
  TOKEN_PATTERN,
  SPINNER_PATTERN,
  MAX_SESSION_TOKENS,
  execPattern,
} from './utils/index.js';
import {
  MAX_TERMINAL_BUFFER_SIZE,
  TRIM_TERMINAL_TO as TERMINAL_BUFFER_TRIM_SIZE,
  MAX_TEXT_OUTPUT_SIZE,
  TRIM_TEXT_TO as TEXT_OUTPUT_TRIM_SIZE,
  MAX_MESSAGES,
  MAX_LINE_BUFFER_SIZE,
} from './config/buffer-limits.js';
import {
  buildInteractiveArgs,
  buildMcpArgs,
  cleanupMcpConfig,
  buildPromptArgs,
  buildClaudeEnv,
  buildMuxAttachEnv,
  buildShellEnv,
} from './session-cli-builder.js';
import { SessionAutoOps } from './session-auto-ops.js';
import { SessionTaskCache } from './session-task-cache.js';

export type { BackgroundTask } from './task-tracker.js';
export type { RalphTrackerState, RalphTodoItem, ActiveBashTool } from './types.js';

/** Line buffer flush interval (100ms) - forces processing of partial lines */
const LINE_BUFFER_FLUSH_INTERVAL = 100;

// ============================================================================
// Timing Constants
// ============================================================================

/** Delay after mux session creation before sending commands (300ms) */
const MUX_STARTUP_DELAY_MS = 300;

/** Delay before declaring session idle after last output (2 seconds) */
const IDLE_DETECTION_DELAY_MS = 2000;

// Note: Auto-compact/clear timing constants moved to session-auto-ops.ts

/** Graceful shutdown delay when stopping session (100ms) */
const GRACEFUL_SHUTDOWN_DELAY_MS = 100;

/** Context window size — all current Claude models use 200k tokens. */
const CONTEXT_WINDOW_TOKENS = 200_000;

// Filter out terminal focus escape sequences (focus in/out reports)
// ^[[I (focus in), ^[[O (focus out), and the enable/disable sequences
// eslint-disable-next-line no-control-regex
const FOCUS_ESCAPE_FILTER = /\x1b\[\?1004[hl]|\x1b\[[IO]/g;

// Pattern to match Task tool invocations in terminal output
// Matches: "Explore(Description)", "Task(Description)", "Bash(Description)", etc.
// The prefix characters vary (●, ·, ✶, etc.) so we don't require them
// We look for the tool name followed by (description)
const TASK_TOOL_PATTERN = /\b(Explore|Task|Bash|Plan|general-purpose)\(([^)]+)\)/g;

// Pre-compiled patterns for hot paths (avoid regex compilation per call)
/** Pattern to strip leading ANSI escapes and whitespace from terminal buffer */
// eslint-disable-next-line no-control-regex
const LEADING_ANSI_WHITESPACE_PATTERN = /^(\x1b\[\??[\d;]*[A-Za-z]|[\s\r\n])+/;
/** Pattern to match Ctrl+L (form feed) characters */
// eslint-disable-next-line no-control-regex
const CTRL_L_PATTERN = /\x0c/g;
/** Pattern to split by newlines (CR or LF) */
const NEWLINE_SPLIT_PATTERN = /\r?\n/;

// Note: Claude CLI PATH resolution moved to session-cli-builder.ts (buildClaudeEnv)

/**
 * Represents a JSON message from Claude CLI's stream-json output format.
 * Messages are newline-delimited JSON objects parsed from PTY output.
 */
export interface ClaudeMessage {
  /** Message type indicating the role or purpose */
  type: 'system' | 'assistant' | 'user' | 'result';
  /** Optional subtype for further classification */
  subtype?: string;
  /** Claude's internal session identifier */
  session_id?: string;
  /** Message content with optional token usage */
  message?: {
    content: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  /** Final result text (on result messages) */
  result?: string;
  /** Whether this message represents an error */
  is_error?: boolean;
  /** Total cost in USD (on result messages) */
  total_cost_usd?: number;
  /** Total duration in milliseconds (on result messages) */
  duration_ms?: number;
}

/**
 * Event signatures emitted by the Session class.
 * Subscribe using `session.on('eventName', handler)`.
 */
export interface SessionEvents {
  /** Processed text output (ANSI stripped) */
  output: (data: string) => void;
  /** Parsed JSON message from Claude CLI */
  message: (msg: ClaudeMessage) => void;
  /** Error output from the session */
  error: (data: string) => void;
  /** Session process exited */
  exit: (code: number | null) => void;
  /** One-shot prompt completed with result and cost */
  completion: (result: string, cost: number) => void;
  /** Raw terminal data (includes ANSI codes) */
  terminal: (data: string) => void;
  /** Signal to clear terminal display (after mux attach) */
  clearTerminal: () => void;
  /** New background task started */
  taskCreated: (task: BackgroundTask) => void;
  /** Background task status changed */
  taskUpdated: (task: BackgroundTask) => void;
  /** Background task finished successfully */
  taskCompleted: (task: BackgroundTask) => void;
  /** Background task failed with error */
  taskFailed: (task: BackgroundTask, error: string) => void;
  /** Auto-clear triggered due to token threshold */
  autoClear: (data: { tokens: number; threshold: number }) => void;
  /** Auto-compact triggered due to token threshold */
  autoCompact: (data: { tokens: number; threshold: number; prompt?: string }) => void;
  /** Ralph loop state changed */
  ralphLoopUpdate: (state: RalphTrackerState) => void;
  /** Ralph todo list updated */
  ralphTodoUpdate: (todos: RalphTodoItem[]) => void;
  /** Ralph completion phrase detected */
  ralphCompletionDetected: (phrase: string) => void;
  /** RALPH_STATUS block detected */
  ralphStatusBlockDetected: (block: import('./types.js').RalphStatusBlock) => void;
  /** Circuit breaker state changed */
  ralphCircuitBreakerUpdate: (status: import('./types.js').CircuitBreakerStatus) => void;
  /** Dual-condition exit gate met */
  ralphExitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => void;
  /** Bash tool with file paths started */
  bashToolStart: (tool: ActiveBashTool) => void;
  /** Bash tool completed */
  bashToolEnd: (tool: ActiveBashTool) => void;
  /** Active Bash tools list updated */
  bashToolsUpdate: (tools: ActiveBashTool[]) => void;
  /** CLI info (version, model, account) updated */
  cliInfoUpdated: (info: {
    version: string | null;
    model: string | null;
    accountType: string | null;
    latestVersion: string | null;
  }) => void;
  /** Passive context window usage updated */
  contextUpdate: (data: {
    inputTokens: number;
    maxTokens: number;
    pct: number;
    system?: number;
    conversation?: number;
    tools?: number;
  }) => void;
}

// SessionMode is imported from types.ts (single source of truth)
// Re-export for backwards compatibility with any external consumers
export type { SessionMode } from './types.js';

/**
 * Core session class that wraps a PTY process running Claude CLI or a shell.
 *
 * @example
 * ```typescript
 * // Create and start an interactive Claude session
 * const session = new Session({
 *   workingDir: '/path/to/project',
 *   mux: muxManager,
 *   useMux: true
 * });
 * await session.startInteractive();
 *
 * // Listen for events
 * session.on('terminal', (data) => console.log(data));
 * session.on('message', (msg) => console.log('Claude:', msg));
 *
 * // Send input
 * session.write('Hello Claude!\r');
 *
 * // Stop when done
 * await session.stop();
 * ```
 *
 * @fires Session#terminal - Raw terminal output
 * @fires Session#message - Parsed Claude JSON message
 * @fires Session#completion - One-shot prompt completed
 * @fires Session#exit - Process exited
 * @fires Session#autoClear - Token threshold reached, clearing context
 * @fires Session#autoCompact - Token threshold reached, compacting context
 */
export class Session extends EventEmitter {
  readonly id: string;
  readonly workingDir: string;
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  readonly worktreeOriginId?: string;
  readonly worktreeNotes?: string;
  readonly assignedPort?: number;
  private _initialPromptSent: boolean = false;
  readonly createdAt: number;
  readonly mode: SessionMode;

  // Task description cache (extracted to SessionTaskCache)
  private _taskCache = new SessionTaskCache();

  private _name: string;
  private ptyProcess: pty.IPty | null = null;
  private _pid: number | null = null;
  private _status: SessionStatus = 'idle';
  private _currentTaskId: string | null = null;
  // Use BufferAccumulator for hot-path buffers to reduce GC pressure
  private _terminalBuffer = new BufferAccumulator(MAX_TERMINAL_BUFFER_SIZE, TERMINAL_BUFFER_TRIM_SIZE);
  private _textOutput = new BufferAccumulator(MAX_TEXT_OUTPUT_SIZE, TEXT_OUTPUT_TRIM_SIZE);
  private _errorBuffer: string = '';
  private _lastActivityAt: number;
  private _claudeSessionId: string | null = null;
  private _conversationId: string | null = null;
  private _totalCost: number = 0;
  private _messages: ClaudeMessage[] = [];
  private _lineBuffer: string = '';
  private _lineBufferFlushTimer: NodeJS.Timeout | null = null;
  private resolvePromise: ((value: { result: string; cost: number }) => void) | null = null;
  private rejectPromise: ((reason: Error) => void) | null = null;
  private _promptResolved: boolean = false; // Guard against race conditions in runPrompt
  private _isWorking: boolean = false;
  private _lastPromptTime: number = 0;
  private activityTimeout: NodeJS.Timeout | null = null;
  private _awaitingIdleConfirmation: boolean = false; // Prevents timeout reset during idle detection
  private _taskTracker: TaskTracker;

  // Token tracking for auto-clear
  private _totalInputTokens: number = 0;
  private _totalOutputTokens: number = 0;
  private _totalCacheReadTokens: number = 0;
  private _totalCacheCreationTokens: number = 0;

  // Auto-compact/auto-clear automation (extracted to SessionAutoOps)
  private _autoOps!: SessionAutoOps;

  // Image watcher setting (per-session toggle)
  private _imageWatcherEnabled: boolean = false;

  // Flicker filter setting (per-session toggle, applied on frontend)
  private _flickerFilterEnabled: boolean = false;

  // Claude Code CLI info (parsed from terminal startup)
  private _cliVersion: string = '';
  private _cliModel: string = '';
  private _cliAccountType: string = '';
  private _cliLatestVersion: string = '';
  private _cliInfoParsed: boolean = false; // Only parse once per session

  // Timer tracking for cleanup (prevents memory leaks)
  private _promptCheckInterval: NodeJS.Timeout | null = null;
  private _promptCheckTimeout: NodeJS.Timeout | null = null;
  private _shellIdleTimer: NodeJS.Timeout | null = null;

  // Multiplexer session support (tmux)
  private _mux: TerminalMultiplexer | null = null;
  private _muxSession: MuxSession | null = null;
  private _useMux: boolean = false;
  // Flag to prevent new timers after session is stopped
  private _isStopped: boolean = false;

  // Background /context refresh state
  private _awaitingContext = false;
  private _contextOutputLines: string[] = [];
  private _contextRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _contextSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  private _contextWindowTokens: number | null = null;
  private _contextWindowMax: number | null = null;
  private _contextWindowSystem: number | null = null;
  private _contextWindowConversation: number | null = null;

  // Ralph tracking (Ralph Wiggum loops and todo lists inside Claude Code)
  private _ralphTracker: RalphTracker;

  // Agent tree tracking
  private _parentAgentId: string | null = null;
  private _childAgentIds: string[] = [];

  // Nice prioritying configuration
  private _niceConfig: NiceConfig = { ...DEFAULT_NICE_CONFIG };

  // Claude model override (e.g., 'opus', 'sonnet', 'haiku')
  private _model: string | undefined;

  // Claude CLI startup permission mode
  private _claudeMode: ClaudeMode = 'dangerously-skip-permissions';
  private _allowedTools: string | undefined;

  // Safe mode flag — when true, strips --resume and MCP config from CLI args
  private _safeMode: boolean = false;

  // OpenCode configuration (only for mode === 'opencode')
  private _openCodeConfig: OpenCodeConfig | undefined;

  // Session color for visual differentiation
  private _color: import('./types.js').SessionColor = 'default';

  // Compose draft (text + uploaded image paths), synced across devices
  draft?: { text: string; imagePaths: string[]; updatedAt: number };

  // MCP server configuration for this session
  mcpServers?: import('./types.js').McpServerEntry[];

  // Claude session UUID for --resume (extracted from transcript filename)
  claudeResumeId?: string;

  // Store handler references for cleanup (prevents memory leaks)
  private _taskTrackerHandlers: {
    taskCreated: (task: BackgroundTask) => void;
    taskUpdated: (task: BackgroundTask) => void;
    taskCompleted: (task: BackgroundTask) => void;
    taskFailed: (task: BackgroundTask, error: string) => void;
  } | null = null;

  private _ralphHandlers: {
    loopUpdate: (state: RalphTrackerState) => void;
    todoUpdate: (todos: RalphTodoItem[]) => void;
    completionDetected: (phrase: string) => void;
    statusBlockDetected: (block: import('./types.js').RalphStatusBlock) => void;
    circuitBreakerUpdate: (status: import('./types.js').CircuitBreakerStatus) => void;
    exitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => void;
  } | null = null;

  // Bash tool tracking (file paths for live log viewing)
  private _bashToolParser: BashToolParser;
  private _bashToolHandlers: {
    toolStart: (tool: ActiveBashTool) => void;
    toolEnd: (tool: ActiveBashTool) => void;
    toolsUpdate: (tools: ActiveBashTool[]) => void;
  } | null = null;

  // Task descriptions parsed from terminal output — delegated to SessionTaskCache

  // Throttle expensive PTY processing (Ralph, bash parser, task descriptions)
  // Accumulates clean data between processing windows to avoid running regex on every chunk
  private _lastExpensiveProcessTime: number = 0;
  private _pendingCleanData: string = '';
  private _expensiveProcessTimer: NodeJS.Timeout | null = null;
  private static readonly EXPENSIVE_PROCESS_INTERVAL_MS = 150; // Process at most every 150ms

  constructor(
    config: Partial<SessionConfig> & {
      workingDir: string;
      mode?: SessionMode;
      name?: string;
      /** Terminal multiplexer instance (tmux) */
      mux?: TerminalMultiplexer;
      /** Whether to use multiplexer wrapping */
      useMux?: boolean;
      /** Existing mux session for restored sessions */
      muxSession?: MuxSession;
      niceConfig?: NiceConfig; // Nice prioritying configuration
      /** Claude model override (e.g., 'opus', 'sonnet', 'haiku') */
      model?: string;
      /** Claude CLI startup permission mode */
      claudeMode?: ClaudeMode;
      /** Comma-separated allowed tools (for 'allowedTools' mode) */
      allowedTools?: string;
      /** OpenCode configuration (only for mode === 'opencode') */
      openCodeConfig?: OpenCodeConfig;
      /** When true, strips --resume and MCP config flags from CLI args */
      safeMode?: boolean;
    }
  ) {
    super();
    this.setMaxListeners(25);

    // Default error handler prevents unhandled 'error' events from crashing the process.
    // Server attaches its own handler after construction — this is a safety net for the gap.
    this.on('error', (err) => {
      console.error(`[Session] Unhandled error event:`, err);
    });

    this.id = config.id || uuidv4();
    this.workingDir = config.workingDir;
    this.worktreePath = config.worktreePath;
    this.worktreeBranch = config.worktreeBranch;
    this.worktreeOriginId = config.worktreeOriginId;
    this.worktreeNotes = config.worktreeNotes;
    this.assignedPort = config.assignedPort;
    this.createdAt = config.createdAt || Date.now();
    this.mode = config.mode || 'claude';
    this._name = config.name || '';
    this._lastActivityAt = this.createdAt;
    // Set claudeSessionId immediately — Codeman always passes --session-id ${this.id}
    // to Claude CLI, so the Claude session ID always matches the Codeman session ID.
    // This ensures subagent matching works even for recovered sessions (where
    // startInteractive() hasn't been called yet).
    this._claudeSessionId = this.id;
    this._mux = config.mux || null;
    this._useMux = config.useMux ?? (this._mux !== null && this._mux.isAvailable());
    this._muxSession = config.muxSession || null;

    // Apply Nice priority configuration if provided
    if (config.niceConfig) {
      this._niceConfig = { ...config.niceConfig };
    }

    // Apply model override if provided
    if (config.model) {
      this._model = config.model;
    }

    // Apply Claude CLI permission mode
    if (config.claudeMode) {
      this._claudeMode = config.claudeMode;
    }
    if (config.allowedTools) {
      this._allowedTools = config.allowedTools;
    }

    // Apply OpenCode configuration
    if (config.openCodeConfig) {
      this._openCodeConfig = config.openCodeConfig;
    }

    // Apply safe mode flag
    if (config.safeMode) {
      this._safeMode = config.safeMode;
    }

    // Initialize task tracker and forward events (store handlers for cleanup)
    this._taskTracker = new TaskTracker();
    this._taskTrackerHandlers = {
      taskCreated: (task) => this.emit('taskCreated', task),
      taskUpdated: (task) => this.emit('taskUpdated', task),
      taskCompleted: (task) => this.emit('taskCompleted', task),
      taskFailed: (task, error) => this.emit('taskFailed', task, error),
    };
    this._taskTracker.on('taskCreated', this._taskTrackerHandlers.taskCreated);
    this._taskTracker.on('taskUpdated', this._taskTrackerHandlers.taskUpdated);
    this._taskTracker.on('taskCompleted', this._taskTrackerHandlers.taskCompleted);
    this._taskTracker.on('taskFailed', this._taskTrackerHandlers.taskFailed);

    // Initialize Ralph tracker and forward events (store handlers for cleanup)
    this._ralphTracker = new RalphTracker();
    this._ralphHandlers = {
      loopUpdate: (state) => this.emit('ralphLoopUpdate', state),
      todoUpdate: (todos) => this.emit('ralphTodoUpdate', todos),
      completionDetected: (phrase) => this.emit('ralphCompletionDetected', phrase),
      statusBlockDetected: (block) => this.emit('ralphStatusBlockDetected', block),
      circuitBreakerUpdate: (status) => this.emit('ralphCircuitBreakerUpdate', status),
      exitGateMet: (data) => this.emit('ralphExitGateMet', data),
    };
    this._ralphTracker.on('loopUpdate', this._ralphHandlers.loopUpdate);
    this._ralphTracker.on('todoUpdate', this._ralphHandlers.todoUpdate);
    this._ralphTracker.on('completionDetected', this._ralphHandlers.completionDetected);
    this._ralphTracker.on('statusBlockDetected', this._ralphHandlers.statusBlockDetected);
    this._ralphTracker.on('circuitBreakerUpdate', this._ralphHandlers.circuitBreakerUpdate);
    this._ralphTracker.on('exitGateMet', this._ralphHandlers.exitGateMet);

    // Initialize Bash tool parser and forward events (store handlers for cleanup)
    this._bashToolParser = new BashToolParser({ sessionId: this.id, workingDir: this.workingDir });
    this._bashToolHandlers = {
      toolStart: (tool) => this.emit('bashToolStart', tool),
      toolEnd: (tool) => this.emit('bashToolEnd', tool),
      toolsUpdate: (tools) => this.emit('bashToolsUpdate', tools),
    };
    this._bashToolParser.on('toolStart', this._bashToolHandlers.toolStart);
    this._bashToolParser.on('toolEnd', this._bashToolHandlers.toolEnd);
    this._bashToolParser.on('toolsUpdate', this._bashToolHandlers.toolsUpdate);

    // Initialize auto-compact/auto-clear automation and forward events
    this._autoOps = new SessionAutoOps({
      writeCommand: (cmd) => this.writeViaMux(cmd),
      isWorking: () => this._isWorking,
      isStopped: () => this._isStopped,
      getTotalTokens: () => this._totalInputTokens + this._totalOutputTokens,
      getSessionId: () => this.id,
    });
    this._autoOps.on('autoCompact', (data) => this.emit('autoCompact', data));
    this._autoOps.on('autoClear', (data) => {
      // Reset token counts on clear
      this._totalInputTokens = 0;
      this._totalOutputTokens = 0;
      this.emit('autoClear', data);
    });
  }

  get status(): SessionStatus {
    return this._status;
  }

  get currentTaskId(): string | null {
    return this._currentTaskId;
  }

  get pid(): number | null {
    return this._pid;
  }

  get terminalBuffer(): string {
    return this._terminalBuffer.value;
  }

  get terminalBufferLength(): number {
    return this._terminalBuffer.length;
  }

  get textOutput(): string {
    return this._textOutput.value;
  }

  get errorBuffer(): string {
    return this._errorBuffer;
  }

  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  get claudeSessionId(): string | null {
    return this._claudeSessionId;
  }

  get conversationId(): string | null {
    return this._conversationId;
  }

  get totalCost(): number {
    return this._totalCost;
  }

  get messages(): ClaudeMessage[] {
    return this._messages;
  }

  get isWorking(): boolean {
    return this._isWorking;
  }

  get lastPromptTime(): number {
    return this._lastPromptTime;
  }

  get taskTracker(): TaskTracker {
    return this._taskTracker;
  }

  get runningTaskCount(): number {
    return this._taskTracker.getRunningCount();
  }

  get taskTree(): BackgroundTask[] {
    return this._taskTracker.getTaskTree();
  }

  get taskStats(): { total: number; running: number; completed: number; failed: number } {
    return this._taskTracker.getStats();
  }

  // Ralph tracking getters
  get ralphTracker(): RalphTracker {
    return this._ralphTracker;
  }

  get ralphLoopState(): RalphTrackerState {
    return this._ralphTracker.loopState;
  }

  get ralphTodos(): RalphTodoItem[] {
    return this._ralphTracker.todos;
  }

  get ralphTodoStats(): { total: number; pending: number; inProgress: number; completed: number } {
    return this._ralphTracker.getTodoStats();
  }

  // Bash tool tracking getters
  get bashToolParser(): BashToolParser {
    return this._bashToolParser;
  }

  get activeTools(): ActiveBashTool[] {
    return this._bashToolParser.activeTools;
  }

  get parentAgentId(): string | null {
    return this._parentAgentId;
  }

  set parentAgentId(value: string | null) {
    this._parentAgentId = value;
  }

  get childAgentIds(): string[] {
    return [...this._childAgentIds];
  }

  addChildAgentId(agentId: string): void {
    if (!this._childAgentIds.includes(agentId)) {
      this._childAgentIds.push(agentId);
    }
  }

  removeChildAgentId(agentId: string): void {
    const idx = this._childAgentIds.indexOf(agentId);
    if (idx >= 0) this._childAgentIds.splice(idx, 1);
  }

  // Nice priority config getters and setters
  get niceConfig(): NiceConfig {
    return { ...this._niceConfig };
  }

  /** Claude CLI startup permission mode */
  get claudeMode(): ClaudeMode {
    return this._claudeMode;
  }

  /** Allowed tools list (for 'allowedTools' mode) */
  get allowedTools(): string | undefined {
    return this._allowedTools;
  }

  // Note: _buildPermissionArgs removed — now using buildInteractiveArgs from session-cli-builder.ts

  /**
   * Set CPU priority configuration.
   * Note: This only affects new sessions; existing running processes won't be changed.
   */
  setNice(config: Partial<NiceConfig>): void {
    if (config.enabled !== undefined) {
      this._niceConfig.enabled = config.enabled;
    }
    if (config.niceValue !== undefined) {
      // Clamp to valid range
      this._niceConfig.niceValue = Math.max(-20, Math.min(19, config.niceValue));
    }
  }

  // Session color for visual differentiation
  get color(): import('./types.js').SessionColor {
    return this._color;
  }

  setColor(color: import('./types.js').SessionColor): void {
    const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
    if (validColors.includes(color)) {
      this._color = color;
    }
  }

  /** Safe mode getter — when true, strips --resume and MCP config from CLI args */
  get safeMode(): boolean {
    return this._safeMode;
  }

  /** Enable or disable safe mode. Takes effect on next startInteractive() call. */
  setSafeMode(enabled: boolean): void {
    this._safeMode = enabled;
  }

  // Token tracking getters and setters
  get totalTokens(): number {
    return this._totalInputTokens + this._totalOutputTokens;
  }

  get inputTokens(): number {
    return this._totalInputTokens;
  }

  get outputTokens(): number {
    return this._totalOutputTokens;
  }

  /**
   * Restore token and cost values from saved state.
   * Called when recovering sessions after server restart.
   */
  restoreTokens(inputTokens: number, outputTokens: number, totalCost: number): void {
    // Sanity check: reject absurdly large individual values
    if (inputTokens > MAX_SESSION_TOKENS || outputTokens > MAX_SESSION_TOKENS) {
      console.warn(
        `[Session ${this.id}] Rejected absurd restored tokens: input=${inputTokens}, output=${outputTokens}`
      );
      return;
    }
    // Check token sum doesn't overflow MAX_SESSION_TOKENS
    if (inputTokens + outputTokens > MAX_SESSION_TOKENS) {
      console.warn(
        `[Session ${this.id}] Rejected token sum overflow: input=${inputTokens} + output=${outputTokens} = ${inputTokens + outputTokens} > ${MAX_SESSION_TOKENS}`
      );
      return;
    }
    // Reject negative values
    if (inputTokens < 0 || outputTokens < 0 || totalCost < 0) {
      console.warn(
        `[Session ${this.id}] Rejected negative restored tokens: input=${inputTokens}, output=${outputTokens}, cost=${totalCost}`
      );
      return;
    }

    this._totalInputTokens = inputTokens;
    this._totalOutputTokens = outputTokens;
    this._totalCost = totalCost;
  }

  /** Restore last known context window usage (from persisted state). */
  restoreContextWindow(tokens: number, max: number, system?: number, conversation?: number): void {
    this._contextWindowTokens = tokens;
    this._contextWindowMax = max;
    this._contextWindowSystem = system ?? null;
    this._contextWindowConversation = conversation ?? null;
  }

  get autoClearThreshold(): number {
    return this._autoOps.autoClearThreshold;
  }

  get autoClearEnabled(): boolean {
    return this._autoOps.autoClearEnabled;
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this._name = value;
  }

  setAutoClear(enabled: boolean, threshold?: number): void {
    this._autoOps.setAutoClear(enabled, threshold);
  }

  get autoCompactThreshold(): number {
    return this._autoOps.autoCompactThreshold;
  }

  get autoCompactEnabled(): boolean {
    return this._autoOps.autoCompactEnabled;
  }

  get autoCompactPrompt(): string {
    return this._autoOps.autoCompactPrompt;
  }

  setAutoCompact(enabled: boolean, threshold?: number, prompt?: string): void {
    this._autoOps.setAutoCompact(enabled, threshold, prompt);
  }

  get imageWatcherEnabled(): boolean {
    return this._imageWatcherEnabled;
  }

  set imageWatcherEnabled(enabled: boolean) {
    this._imageWatcherEnabled = enabled;
  }

  get flickerFilterEnabled(): boolean {
    return this._flickerFilterEnabled;
  }

  set flickerFilterEnabled(enabled: boolean) {
    this._flickerFilterEnabled = enabled;
  }

  isIdle(): boolean {
    return this._status === 'idle';
  }

  isBusy(): boolean {
    return this._status === 'busy';
  }

  isRunning(): boolean {
    return this._status === 'idle' || this._status === 'busy';
  }

  /**
   * Marks a recovered session as stopped without starting a process.
   * Used during crash-recovery to restore the persisted stopped status.
   */
  markStopped(): void {
    this._status = 'stopped';
  }

  toState(): SessionState {
    return {
      id: this.id,
      pid: this.pid,
      status: this._status,
      workingDir: this.workingDir,
      worktreePath: this.worktreePath,
      worktreeBranch: this.worktreeBranch,
      worktreeOriginId: this.worktreeOriginId,
      worktreeNotes: this.worktreeNotes,
      assignedPort: this.assignedPort,
      currentTaskId: this._currentTaskId,
      createdAt: this.createdAt,
      lastActivityAt: this._lastActivityAt,
      name: this._name,
      mode: this.mode,
      autoClearEnabled: this._autoOps.autoClearEnabled,
      autoClearThreshold: this._autoOps.autoClearThreshold,
      autoCompactEnabled: this._autoOps.autoCompactEnabled,
      autoCompactThreshold: this._autoOps.autoCompactThreshold,
      autoCompactPrompt: this._autoOps.autoCompactPrompt,
      imageWatcherEnabled: this._imageWatcherEnabled,
      totalCost: this._totalCost,
      inputTokens: this._totalInputTokens,
      outputTokens: this._totalOutputTokens,
      contextWindowTokens: this._contextWindowTokens ?? undefined,
      contextWindowMax: this._contextWindowMax ?? undefined,
      contextWindowSystem: this._contextWindowSystem ?? undefined,
      contextWindowConversation: this._contextWindowConversation ?? undefined,
      ralphEnabled: this._ralphTracker.enabled,
      ralphAutoEnableDisabled: this._ralphTracker.autoEnableDisabled || undefined,
      ralphCompletionPhrase: this._ralphTracker.loopState.completionPhrase || undefined,
      parentAgentId: this._parentAgentId || undefined,
      childAgentIds: this._childAgentIds.length > 0 ? this._childAgentIds : undefined,
      niceEnabled: this._niceConfig.enabled,
      niceValue: this._niceConfig.niceValue,
      color: this._color,
      flickerFilterEnabled: this._flickerFilterEnabled,
      cliVersion: this._cliVersion || undefined,
      cliModel: this._cliModel || undefined,
      cliAccountType: this._cliAccountType || undefined,
      cliLatestVersion: this._cliLatestVersion || undefined,
      openCodeConfig: this._openCodeConfig,
      draft: this.draft,
      ...(this.mcpServers !== undefined && { mcpServers: this.mcpServers }),
      ...(this.claudeResumeId !== undefined && { claudeResumeId: this.claudeResumeId }),
      safeMode: this._safeMode || undefined,
    };
  }

  /** Sets the Claude resume ID (from transcript filename) and persists state */
  setClaudeResumeId(id: string): void {
    this.claudeResumeId = id;
  }

  toDetailedState() {
    return {
      ...this.toLightDetailedState(),
      textOutput: this._textOutput.value,
      terminalBuffer: this._terminalBuffer.value,
    };
  }

  /**
   * Lightweight detailed state that excludes heavy buffers (textOutput, terminalBuffer).
   * Use for SSE session:updated broadcasts where buffers aren't needed.
   * Full buffers are fetched on-demand via /api/sessions/:id/terminal.
   */
  toLightDetailedState() {
    return {
      ...this.toState(),
      name: this._name,
      mode: this.mode,
      claudeSessionId: this._claudeSessionId,
      totalCost: this._totalCost,
      messageCount: this._messages.length,
      isWorking: this._isWorking,
      lastPromptTime: this._lastPromptTime,
      // Buffer statistics for monitoring long-running sessions
      bufferStats: {
        terminalBufferSize: this._terminalBuffer.length,
        textOutputSize: this._textOutput.length,
        messageCount: this._messages.length,
        maxTerminalBuffer: MAX_TERMINAL_BUFFER_SIZE,
        maxTextOutput: MAX_TEXT_OUTPUT_SIZE,
        maxMessages: MAX_MESSAGES,
      },
      // Background task tracking (light tree strips large output strings)
      taskStats: this._taskTracker.getStats(),
      taskTree: this._taskTracker.getTaskTreeLight(),
      // Token tracking
      tokens: {
        input: this._totalInputTokens,
        output: this._totalOutputTokens,
        cacheRead: this._totalCacheReadTokens,
        cacheCreation: this._totalCacheCreationTokens,
        total:
          this._totalInputTokens +
          this._totalOutputTokens +
          this._totalCacheReadTokens +
          this._totalCacheCreationTokens,
      },
      autoClear: {
        enabled: this._autoOps.autoClearEnabled,
        threshold: this._autoOps.autoClearThreshold,
      },
      // CPU priority configuration
      nice: {
        enabled: this._niceConfig.enabled,
        niceValue: this._niceConfig.niceValue,
      },
      // Ralph tracking state
      ralphLoop: this._ralphTracker.loopState,
      ralphTodos: this._ralphTracker.todos,
      ralphTodoStats: this._ralphTracker.getTodoStats(),
    };
  }

  /**
   * Starts an interactive Claude CLI session with full terminal support.
   *
   * This spawns Claude CLI in interactive mode with the configured permission
   * mode (default: `--dangerously-skip-permissions`). If mux wrapping is enabled,
   * the session runs inside a tmux session for persistence across disconnects.
   *
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project', useMux: true });
   * await session.startInteractive();
   * session.on('terminal', (data) => process.stdout.write(data));
   * session.write('help me with this code\r');
   * ```
   */
  async startInteractive(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }

    this._status = 'busy';
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lineBuffer = '';
    this._lastActivityAt = Date.now();

    const modeLabel = this.mode === 'opencode' ? 'OpenCode' : 'Claude';
    console.log(
      `[Session] Starting interactive ${modeLabel} session` + (this._useMux ? ` (with ${this._mux!.backend})` : '')
    );

    // If mux wrapping is enabled, create or attach to a mux session
    if (this._useMux && this._mux) {
      try {
        // Verify stale mux session — tmux may have been destroyed (e.g., killed externally)
        if (this._muxSession && !this._mux.muxSessionExists(this._muxSession.muxName)) {
          console.log('[Session] Stale mux session detected (tmux gone):', this._muxSession.muxName);
          this._muxSession = null;
        }

        // Check if session exists but pane is dead (remain-on-exit keeps it alive)
        // Respawn the pane instead of creating a whole new session — preserves tmux scrollback
        let needsNewSession = false;
        if (this._muxSession && this._mux.isPaneDead(this._muxSession.muxName)) {
          console.log('[Session] Dead pane detected, respawning:', this._muxSession.muxName);
          const newPid = await this._mux.respawnPane({
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: this.mode,
            niceConfig: this._niceConfig,
            model: this._safeMode ? undefined : this._model,
            claudeMode: this._safeMode ? 'dangerously-skip-permissions' : this._claudeMode,
            allowedTools: this._safeMode ? undefined : this._allowedTools,
            openCodeConfig: this._openCodeConfig,
            extraArgs: buildMcpArgs(this.id, this.mcpServers, this.claudeResumeId, this._safeMode),
          });
          if (!newPid) {
            console.error('[Session] Failed to respawn pane, will create new session');
            needsNewSession = true;
          } else {
            // Wait a moment for the respawned process to fully start
            await new Promise((resolve) => setTimeout(resolve, MUX_STARTUP_DELAY_MS));
          }
        }

        // Check if we already have a mux session (restored session)
        const isRestoredSession = this._muxSession !== null && !needsNewSession;
        if (isRestoredSession) {
          console.log('[Session] Attaching to existing mux session:', this._muxSession!.muxName);
          // Seed _textOutput from tmux scrollback so text/chat view is populated on restore
          const scrollback = this._mux.capturePaneContent(this._muxSession!.muxName);
          if (scrollback) {
            const stripped = stripAnsi(scrollback);
            if (stripped.trim()) this._textOutput.append(stripped);
          }
        } else {
          // Create a new mux session
          const initialPromptArgs = this.worktreeNotes && !this._initialPromptSent ? [this.worktreeNotes] : [];
          if (initialPromptArgs.length) this._initialPromptSent = true;
          this._muxSession = await this._mux.createSession({
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: this.mode,
            name: this._name,
            niceConfig: this._niceConfig,
            model: this._safeMode ? undefined : this._model,
            claudeMode: this._safeMode ? 'dangerously-skip-permissions' : this._claudeMode,
            allowedTools: this._safeMode ? undefined : this._allowedTools,
            openCodeConfig: this._openCodeConfig,
            extraArgs: [
              ...buildMcpArgs(this.id, this.mcpServers, this.claudeResumeId, this._safeMode),
              ...initialPromptArgs,
            ],
          });
          console.log('[Session] Created mux session:', this._muxSession.muxName);
          // No extra sleep — createSession() already waits for tmux readiness
        }

        // Attach to the mux session via PTY
        try {
          this.ptyProcess = pty.spawn(
            this._mux.getAttachCommand(),
            this._mux.getAttachArgs(this._muxSession!.muxName),
            {
              name: 'xterm-256color',
              cols: 120,
              rows: 40,
              cwd: this.workingDir,
              env: buildMuxAttachEnv(),
            }
          );

          // Set claudeSessionId immediately since we passed --session-id to Claude
          // The mux manager passes --session-id ${sessionId} to Claude
          this._claudeSessionId = this.id;
        } catch (spawnErr) {
          console.error('[Session] Failed to spawn PTY for mux attachment:', spawnErr);
          this.emit('error', `Failed to attach to mux session: ${spawnErr}`);
          throw spawnErr;
        }

        // For NEW mux sessions: wait for readiness then clean buffer
        // For RESTORED mux sessions: don't do anything - client will fetch buffer on tab switch
        if (!isRestoredSession) {
          if (this.mode === 'opencode') {
            // OpenCode uses Bubble Tea TUI — no ❯ prompt to detect.
            // Wait for TUI to stabilize (output stops changing), then mark ready.
            // Don't clear the buffer — the TUI's initial render IS the useful content.
            // Emit needsRefresh so the client fetches the full buffer once the TUI has rendered.
            this._promptCheckTimeout = setTimeout(() => {
              this._promptCheckTimeout = null;
              if (this._isStopped) return;
              this._status = 'idle';
              this.emit('needsRefresh');
            }, 3000);
          } else {
            // Claude mode: wait for ❯ prompt
            this._promptCheckInterval = setInterval(() => {
              // Wait for the prompt character (❯) which means Claude is fully initialized
              const bufferValue = this._terminalBuffer.value;
              if (bufferValue.includes('❯') || bufferValue.includes('\u276f')) {
                if (this._promptCheckInterval) {
                  clearInterval(this._promptCheckInterval);
                  this._promptCheckInterval = null;
                }
                if (this._promptCheckTimeout) {
                  clearTimeout(this._promptCheckTimeout);
                  this._promptCheckTimeout = null;
                }
                // Clean the buffer - remove mux init junk before actual content
                // Strip: cursor movement (\x1b[nA/B/C/D), positioning (\x1b[n;nH),
                // clear screen (\x1b[2J), scroll region (\x1b[n;nr), and whitespace
                this._terminalBuffer.set(bufferValue.replace(LEADING_ANSI_WHITESPACE_PATTERN, ''));
                // Signal client to refresh
                this.emit('clearTerminal');
              }
            }, 50);
            // Timeout after 5 seconds if prompt not found
            this._promptCheckTimeout = setTimeout(() => {
              if (this._promptCheckInterval) {
                clearInterval(this._promptCheckInterval);
                this._promptCheckInterval = null;
              }
              this._promptCheckTimeout = null;
            }, 5000);
          }
        }
      } catch (err) {
        console.error('[Session] Failed to create mux session, falling back to direct PTY:', err);
        this._useMux = false;
        this._muxSession = null;
      }
    }

    // Fallback to direct PTY if mux is not used
    if (!this.ptyProcess) {
      // OpenCode sessions require tmux for env var injection (API keys via setenv)
      if (this.mode === 'opencode') {
        throw new Error('OpenCode sessions require tmux. Direct PTY fallback is not supported.');
      }
      try {
        // Pass --session-id to use the SAME ID as the Codeman session
        // This ensures subagents can be directly matched to the correct tab
        const initialArg = this.worktreeNotes && !this._initialPromptSent ? [this.worktreeNotes] : [];
        if (initialArg.length) this._initialPromptSent = true;
        const args = [
          ...buildInteractiveArgs(
            this.id,
            this._claudeMode,
            this._model,
            this._allowedTools,
            this.claudeResumeId,
            this._safeMode
          ),
          ...buildMcpArgs(this.id, this.mcpServers, this.claudeResumeId, this._safeMode),
          ...initialArg,
        ];
        this.ptyProcess = pty.spawn('claude', args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: buildClaudeEnv(this.id),
        });
      } catch (spawnErr) {
        console.error('[Session] Failed to spawn Claude PTY:', spawnErr);
        this._status = 'stopped';
        this.emit('error', `Failed to start Claude: ${spawnErr}`);
        throw new Error(`Failed to spawn Claude process: ${spawnErr}`);
      }
    }

    // Set the claudeSessionId immediately since we passed --session-id
    // This ensures subagent matching works without waiting for JSON messages
    this._claudeSessionId = this.id;

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Interactive PTY spawned with PID:', this._pid);

    this.ptyProcess.onData((rawData: string) => {
      // Filter out focus escape sequences and Ctrl+L (form feed)
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '').replace(CTRL_L_PATTERN, ''); // Remove Ctrl+L
      if (!data) return; // Skip if only filtered sequences

      // BufferAccumulator handles auto-trimming when max size exceeded
      this._terminalBuffer.append(data);
      this._lastActivityAt = Date.now();

      // Suppress terminal output while capturing /context refresh output
      if (!this._awaitingContext) {
        this.emit('terminal', data);
      }
      this.emit('output', data);

      // === Idle/working detection runs on every chunk (latency-sensitive) ===
      // Detect if Claude is working or at prompt
      // The prompt line contains "❯" when waiting for input
      if (data.includes('❯') || data.includes('\u276f')) {
        // Only start a new timeout if we're not already awaiting idle confirmation
        // This prevents status bar redraws (which include ❯) from resetting the timer
        if (!this._awaitingIdleConfirmation) {
          if (this.activityTimeout) clearTimeout(this.activityTimeout);
          this._awaitingIdleConfirmation = true;
          this.activityTimeout = setTimeout(() => {
            this._awaitingIdleConfirmation = false;
            // Emit idle if either:
            // 1. Claude was working and is now at prompt (normal case)
            // 2. Session just started and is ready (status is 'busy' but _isWorking is false)
            const wasWorking = this._isWorking;
            const isInitialReady = this._status === 'busy' && !this._isWorking;
            if (wasWorking || isInitialReady) {
              this._isWorking = false;
              this._status = 'idle';
              this._lastPromptTime = Date.now();
              this.emit('idle');
            }
          }, IDLE_DETECTION_DELAY_MS);
        }
      }

      // Detect when Claude starts working (thinking, writing, etc)
      // Fast path: check spinner characters on raw data (Unicode, never in ANSI sequences)
      const hasSpinner = SPINNER_PATTERN.test(data);
      if (hasSpinner) {
        if (!this._isWorking) {
          this._isWorking = true;
          this._status = 'busy';
          this.emit('working');
        }
        this._awaitingIdleConfirmation = false;
        if (this.activityTimeout) clearTimeout(this.activityTimeout);
      }

      // === Expensive processing (ANSI strip, Ralph, bash parser) is throttled ===
      // Instead of running regex-heavy parsers on every PTY chunk, we accumulate
      // raw data and process at most every EXPENSIVE_PROCESS_INTERVAL_MS.
      // This dramatically reduces CPU load with multiple busy sessions.
      const now = Date.now();
      const elapsed = now - this._lastExpensiveProcessTime;
      if (elapsed >= Session.EXPENSIVE_PROCESS_INTERVAL_MS) {
        // Process immediately — include any previously accumulated data
        this._lastExpensiveProcessTime = now;
        const accumulated = this._pendingCleanData ? this._pendingCleanData + data : data;
        this._pendingCleanData = '';
        if (this._expensiveProcessTimer) {
          clearTimeout(this._expensiveProcessTimer);
          this._expensiveProcessTimer = null;
        }
        this._processExpensiveParsers(accumulated);
      } else {
        // Accumulate for deferred processing
        this._pendingCleanData += data;
        // Cap accumulated size to prevent unbounded growth
        if (this._pendingCleanData.length > 64 * 1024) {
          this._pendingCleanData = this._pendingCleanData.slice(-32 * 1024);
        }
        // Schedule deferred processing if not already scheduled
        if (!this._expensiveProcessTimer) {
          this._expensiveProcessTimer = setTimeout(() => {
            this._expensiveProcessTimer = null;
            this._lastExpensiveProcessTime = Date.now();
            const pending = this._pendingCleanData;
            this._pendingCleanData = '';
            if (pending) {
              this._processExpensiveParsers(pending);
            }
          }, Session.EXPENSIVE_PROCESS_INTERVAL_MS - elapsed);
        }
      }
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      console.log('[Session] Interactive PTY exited with code:', exitCode);
      this.ptyProcess = null;
      this._pid = null;
      this._status = 'idle';
      this._awaitingIdleConfirmation = false;
      // Clear all timers to prevent memory leaks
      if (this.activityTimeout) {
        clearTimeout(this.activityTimeout);
        this.activityTimeout = null;
      }
      if (this._promptCheckInterval) {
        clearInterval(this._promptCheckInterval);
        this._promptCheckInterval = null;
      }
      if (this._promptCheckTimeout) {
        clearTimeout(this._promptCheckTimeout);
        this._promptCheckTimeout = null;
      }
      // Clear expensive processing timer and flush any pending data
      if (this._expensiveProcessTimer) {
        clearTimeout(this._expensiveProcessTimer);
        this._expensiveProcessTimer = null;
      }
      this._pendingCleanData = '';
      // If using mux, mark the session as detached but don't kill it
      if (this._muxSession && this._mux) {
        this._mux.setAttached(this.id, false);
      }
      this.emit('exit', exitCode);
    });
  }

  /**
   * Process expensive parsers (ANSI strip, Ralph, bash tool, token, CLI info, task descriptions).
   * Called on a throttled schedule (every EXPENSIVE_PROCESS_INTERVAL_MS) instead of on every
   * PTY data chunk. Receives accumulated raw data to process in one batch.
   */
  private _processExpensiveParsers(rawData: string): void {
    // Skip Claude-specific parsers for OpenCode sessions — Ralph tracker, BashToolParser,
    // token parsing, and CLI info parsing all depend on Claude's output format.
    if (this.mode === 'opencode') return;

    // Lazy ANSI strip: only compute cleanData when a consumer actually needs it.
    let _cleanData: string | null = null;
    const getCleanData = (): string => {
      if (_cleanData === null) {
        _cleanData = rawData.replace(ANSI_ESCAPE_PATTERN_FULL, '');
      }
      return _cleanData;
    };

    // Forward to Ralph tracker to detect Ralph loops and todos
    // (opencode sessions already returned early at line 1209)
    if (this._ralphTracker.enabled || !this._ralphTracker.autoEnableDisabled) {
      this._ralphTracker.processCleanData(getCleanData());
    }

    // Forward to Bash tool parser to detect file-viewing commands
    if (this._bashToolParser.enabled) {
      this._bashToolParser.processCleanData(getCleanData());
    }

    // Parse token count from status line (e.g., "123.4k tokens" or "5234 tokens")
    if (rawData.includes('token')) {
      this.parseTokensFromStatusLine(getCleanData());
    }

    // Parse Claude Code CLI info (version, model, account type) from startup
    if (!this._cliInfoParsed) {
      this.parseClaudeCodeInfo(getCleanData());
    }

    // Parse task descriptions from terminal output (e.g., "Explore(Check files)")
    if (rawData.includes('(') && rawData.includes(')')) {
      this.parseTaskDescriptionsFromTerminalData(getCleanData());
    }

    // Work keyword detection (text-based, needs clean data)
    // Only check if spinner didn't already trigger working state
    if (!this._isWorking) {
      const cleanData = getCleanData();
      if (
        cleanData.includes('Thinking') ||
        cleanData.includes('Writing') ||
        cleanData.includes('Reading') ||
        cleanData.includes('Running')
      ) {
        this._isWorking = true;
        this._status = 'busy';
        this.emit('working');
        this._awaitingIdleConfirmation = false;
        if (this.activityTimeout) clearTimeout(this.activityTimeout);
      }
    }

    // Capture /context output if awaiting refresh (interactive mode only).
    // NOTE: Context output is parsed in two places:
    //   1. HERE — in the raw PTY onData handler (mux-attached sessions where output
    //      arrives as raw chunks before JSON parsing has a chance to run).
    //   2. In processOutput() below — for non-JSON text lines in stream-json mode.
    // Both push to _contextOutputLines and call _tryParseContextOutput. The flag
    // _awaitingContext is cleared immediately on success so only one path resolves.
    if (this._awaitingContext) {
      const cleanData = getCleanData();
      for (const line of cleanData.split(/\r?\n|\r/)) {
        const trimmed = line.trim();
        if (trimmed) this._contextOutputLines.push(trimmed);
      }
      const parsed = this._tryParseContextOutput(this._contextOutputLines);
      if (parsed) {
        this._awaitingContext = false;
        this._contextOutputLines = [];
        if (this._contextSafetyTimer) {
          clearTimeout(this._contextSafetyTimer);
          this._contextSafetyTimer = null;
        }
        // Persist actual context window usage so page reloads show accurate values
        this._contextWindowTokens = parsed.inputTokens;
        this._contextWindowMax = parsed.maxTokens;
        this._contextWindowSystem = parsed.system ?? null;
        this._contextWindowConversation = parsed.conversation ?? null;
        this.emit('contextUpdate', parsed);
      }
    }
  }

  /**
   * Starts a plain shell session (bash/zsh) without Claude CLI.
   *
   * Useful for debugging, testing, or when you just need a terminal.
   * Uses the user's default shell from $SHELL or falls back to /bin/bash.
   *
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project', mode: 'shell' });
   * await session.startShell();
   * session.write('ls -la\r');
   * ```
   */
  async startShell(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Session already has a running process');
    }

    this._status = 'busy';
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lineBuffer = '';
    this._lastActivityAt = Date.now();

    // Use user's default shell or bash
    const shell = process.env.SHELL || '/bin/bash';
    console.log(
      '[Session] Starting shell session with:',
      shell + (this._useMux ? ` (with ${this._mux!.backend})` : '')
    );

    // If mux wrapping is enabled, create or attach to a mux session
    if (this._useMux && this._mux) {
      try {
        // Verify stale mux session — tmux may have been destroyed externally
        if (this._muxSession && !this._mux.muxSessionExists(this._muxSession.muxName)) {
          console.log('[Session] Stale mux session detected (tmux gone):', this._muxSession.muxName);
          this._muxSession = null;
        }

        // Check if session exists but pane is dead (remain-on-exit keeps it alive)
        let needsNewSession = false;
        if (this._muxSession && this._mux.isPaneDead(this._muxSession.muxName)) {
          console.log('[Session] Dead pane detected, respawning:', this._muxSession.muxName);
          const newPid = await this._mux.respawnPane({
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: 'shell',
            niceConfig: this._niceConfig,
          });
          if (!newPid) {
            console.error('[Session] Failed to respawn pane, will create new session');
            needsNewSession = true;
          } else {
            await new Promise((resolve) => setTimeout(resolve, MUX_STARTUP_DELAY_MS));
          }
        }

        // Check if we already have a mux session (restored session)
        const isRestoredSession = this._muxSession !== null && !needsNewSession;
        if (isRestoredSession) {
          console.log('[Session] Attaching to existing mux session:', this._muxSession!.muxName);
        } else {
          // Create a new mux session
          this._muxSession = await this._mux.createSession({
            sessionId: this.id,
            workingDir: this.workingDir,
            mode: 'shell',
            name: this._name,
            niceConfig: this._niceConfig,
          });
          console.log('[Session] Created mux session:', this._muxSession.muxName);
          // No extra sleep — createSession() already waits for tmux readiness
        }

        // Attach to the mux session via PTY
        try {
          this.ptyProcess = pty.spawn(
            this._mux.getAttachCommand(),
            this._mux.getAttachArgs(this._muxSession!.muxName),
            {
              name: 'xterm-256color',
              cols: 120,
              rows: 40,
              cwd: this.workingDir,
              env: buildMuxAttachEnv(),
            }
          );
        } catch (spawnErr) {
          console.error('[Session] Failed to spawn PTY for shell mux attachment:', spawnErr);
          this.emit('error', `Failed to attach to mux session: ${spawnErr}`);
          throw spawnErr;
        }

        // For NEW sessions: clear by sending 'clear' command to the shell
        // For RESTORED sessions: don't clear - we want to see the existing output
        if (!isRestoredSession) {
          setTimeout(() => {
            if (this.ptyProcess) {
              this._terminalBuffer.clear();
              this.ptyProcess.write('clear\n');
            }
          }, 100);
        }
      } catch (err) {
        console.error('[Session] Failed to create mux session, falling back to direct PTY:', err);
        this._useMux = false;
        this._muxSession = null;
      }
    }

    // Fallback to direct PTY if mux is not used
    if (!this.ptyProcess) {
      try {
        this.ptyProcess = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: this.workingDir,
          env: buildShellEnv(this.id),
        });
      } catch (spawnErr) {
        console.error('[Session] Failed to spawn shell PTY:', spawnErr);
        this._status = 'stopped';
        this.emit('error', `Failed to start shell: ${spawnErr}`);
        throw new Error(`Failed to spawn shell process: ${spawnErr}`);
      }
    }

    this._pid = this.ptyProcess.pid;
    console.log('[Session] Shell PTY spawned with PID:', this._pid);

    this.ptyProcess.onData((rawData: string) => {
      // Filter out focus escape sequences
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
      if (!data) return; // Skip if only focus sequences

      // BufferAccumulator handles auto-trimming when max size exceeded
      this._terminalBuffer.append(data);
      this._lastActivityAt = Date.now();

      this.emit('terminal', data);
      this.emit('output', data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      console.log('[Session] Shell PTY exited with code:', exitCode);
      this.ptyProcess = null;
      this._pid = null;
      this._status = 'idle';
      // Clear timers to prevent memory leaks
      if (this._shellIdleTimer) {
        clearTimeout(this._shellIdleTimer);
        this._shellIdleTimer = null;
      }
      if (this.activityTimeout) {
        clearTimeout(this.activityTimeout);
        this.activityTimeout = null;
      }
      // If using mux, mark the session as detached but don't kill it
      if (this._muxSession && this._mux) {
        this._mux.setAttached(this.id, false);
      }
      this.emit('exit', exitCode);
    });

    // Mark as idle after a short delay (shell is ready)
    this._shellIdleTimer = setTimeout(() => {
      this._shellIdleTimer = null;
      this._status = 'idle';
      this._isWorking = false;
      this.emit('idle');
    }, 500);
  }

  /**
   * Runs a one-shot prompt and returns the result.
   *
   * This spawns Claude CLI with `--output-format stream-json` to get
   * structured JSON output. The promise resolves when Claude completes
   * the response.
   *
   * @param prompt - The prompt text to send to Claude
   * @param options - Optional configuration
   * @param options.model - Model to use ('opus', 'sonnet', or full model name). Defaults to default model.
   * @param options.onProgress - Callback for progress updates (token count, status)
   * @returns Promise resolving to the result text and total cost in USD
   * @throws {Error} If a process is already running in this session
   *
   * @example
   * ```typescript
   * const session = new Session({ workingDir: '/project' });
   * const { result, cost } = await session.runPrompt('Explain this code', { model: 'opus' });
   * console.log(`Response: ${result}`);
   * console.log(`Cost: $${cost.toFixed(4)}`);
   * ```
   */
  async runPrompt(
    prompt: string,
    options?: { model?: string; onProgress?: (info: { tokens?: number; status?: string }) => void }
  ): Promise<{ result: string; cost: number }> {
    return new Promise((resolve, reject) => {
      if (this.ptyProcess) {
        reject(new Error('Session already has a running process'));
        return;
      }

      this._status = 'busy';
      this._terminalBuffer.clear();
      this._textOutput.clear();
      this._errorBuffer = '';
      this._messages = [];
      this._lineBuffer = '';
      this._lastActivityAt = Date.now();
      this._promptResolved = false; // Reset race condition guard

      this.resolvePromise = resolve;
      this.rejectPromise = reject;

      try {
        // Spawn claude in a real PTY
        const model = options?.model;
        console.log(
          '[Session] Spawning PTY for claude with prompt:',
          prompt.substring(0, 50),
          model ? `(model: ${model})` : ''
        );

        const args = buildPromptArgs(prompt, model);

        try {
          this.ptyProcess = pty.spawn('claude', args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: this.workingDir,
            env: buildClaudeEnv(this.id),
          });
        } catch (spawnErr) {
          console.error('[Session] Failed to spawn Claude PTY for runPrompt:', spawnErr);
          this.emit(
            'error',
            `Failed to spawn Claude: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`
          );
          throw spawnErr;
        }

        this._pid = this.ptyProcess.pid;
        console.log('[Session] PTY spawned with PID:', this._pid);

        // Handle terminal data
        this.ptyProcess.onData((rawData: string) => {
          // Filter out focus escape sequences
          const data = rawData.replace(FOCUS_ESCAPE_FILTER, '');
          if (!data) return; // Skip if only focus sequences

          // BufferAccumulator handles auto-trimming when max size exceeded
          this._terminalBuffer.append(data);
          this._lastActivityAt = Date.now();

          this.emit('terminal', data);
          this.emit('output', data);

          // Also try to parse JSON lines for structured data
          this.processOutput(data);
        });

        // Handle exit
        this.ptyProcess.onExit(({ exitCode }) => {
          console.log('[Session] PTY exited with code:', exitCode);
          this.ptyProcess = null;
          this._pid = null;

          // Guard against race conditions: only process once per runPrompt call
          if (this._promptResolved) {
            this.emit('exit', exitCode);
            return;
          }
          this._promptResolved = true;

          // Capture callbacks atomically before processing
          const resolve = this.resolvePromise;
          const reject = this.rejectPromise;
          this.resolvePromise = null;
          this.rejectPromise = null;

          // Find result from parsed messages or use text output
          const resultMsg = this._messages.find((m) => m.type === 'result');

          if (resultMsg && !resultMsg.is_error) {
            this._status = 'idle';
            const cost = resultMsg.total_cost_usd || 0;
            this._totalCost += cost;
            this.emit('completion', resultMsg.result || '', cost);
            if (resolve) {
              resolve({ result: resultMsg.result || '', cost });
            }
          } else if (exitCode !== 0 || (resultMsg && resultMsg.is_error)) {
            this._status = 'error';
            if (reject) {
              reject(new Error(this._errorBuffer || this._textOutput.value || 'Process exited with error'));
            }
          } else {
            this._status = 'idle';
            if (resolve) {
              resolve({
                result: this._textOutput.value || this._terminalBuffer.value,
                cost: this._totalCost,
              });
            }
          }

          this.emit('exit', exitCode);
        });
      } catch (err) {
        this._status = 'error';
        reject(err);
        // Null callbacks to prevent memory leak (onExit won't run if spawn failed)
        this.resolvePromise = null;
        this.rejectPromise = null;
      }
    });
  }

  /**
   * Parse lines of /context command output into structured data.
   * Returns null if output is incomplete (more lines expected).
   * Exposed as static for unit testing.
   */
  static parseContextOutput(lines: string[]): {
    inputTokens: number;
    maxTokens: number;
    pct: number;
    system?: number;
    conversation?: number;
    tools?: number;
  } | null {
    const text = lines.join('\n');

    // Parse token value in either plain ("128,000") or compact ("128k", "3.7k") notation
    const parseK = (s: string): number => {
      const m = s.match(/([\d.]+)(k?)/i);
      if (!m) return 0;
      const n = parseFloat(m[1]);
      return m[2].toLowerCase() === 'k' ? Math.round(n * 1000) : Math.round(n);
    };
    const parseN = (s: string) => parseInt(s.replace(/,/g, ''), 10);

    const cat = (re: RegExp) => {
      const m = text.match(re);
      return m ? parseK(m[1]) : 0;
    };

    // New format: "128k/200k tokens (64%)" (Claude Code >= 2025)
    const headerMatch = text.match(/([\d.]+k?)\/([\d.]+k?)\s+tokens\s*\(/i);
    if (headerMatch) {
      const total = parseK(headerMatch[1]);
      const max = parseK(headerMatch[2]);
      if (!total || !max) return null;

      const sysPrompt = cat(/System prompt:\s*([\d.]+k?)\s+tokens/i);
      const sysTools = cat(/System tools:\s*([\d.]+k?)\s+tokens/i);
      const agents = cat(/Custom agents:\s*([\d.]+k?)\s+tokens/i);
      const memFiles = cat(/Memory files:\s*([\d.]+k?)\s+tokens/i);
      const skills = cat(/\bSkills:\s*([\d.]+k?)\s+tokens/i);
      const messages = cat(/\bMessages:\s*([\d.]+k?)\s+tokens/i);

      // Wait for at least one category before returning — header alone is insufficient.
      // Also require "Free space:" (end-of-output marker) OR messages to be present to avoid
      // returning early when only system categories have arrived (partial PTY batch).
      if (!sysPrompt && !sysTools && !messages) return null; // No categories yet
      const isComplete = text.includes('Free space:') || text.includes('Autocompact buffer:');
      if (!isComplete && !messages) return null; // System found but messages not yet — wait

      return {
        inputTokens: total,
        maxTokens: max,
        pct: Math.min(100, Math.round((total / max) * 100)),
        system: sysPrompt + sysTools + agents + memFiles + skills || undefined,
        conversation: messages || undefined,
        tools: undefined,
      };
    }

    // Legacy format: "Total: 128,000 / 200,000" with System/Conversation/Tools lines
    const totalMatch = text.match(/Total:\s+([\d,]+)\s*\/\s*([\d,]+)/i);
    if (!totalMatch) return null;
    const total = parseN(totalMatch[1]);
    const max = parseN(totalMatch[2]);
    if (!total || !max) return null;

    const sysM = text.match(/System(?:\s+prompt)?:\s+([\d,]+)\s+tokens/i);
    const convM = text.match(/Conversation:\s+([\d,]+)\s+tokens/i);
    const toolM = text.match(/^Tools:\s+([\d,]+)\s+tokens/im);
    if (!sysM && !convM && !toolM) return null; // Legacy header but no categories yet
    return {
      inputTokens: total,
      maxTokens: max,
      pct: Math.min(100, Math.round((total / max) * 100)),
      system: sysM ? parseN(sysM[1]) : undefined,
      conversation: convM ? parseN(convM[1]) : undefined,
      tools: toolM ? parseN(toolM[1]) : undefined,
    };
  }

  private _tryParseContextOutput(lines: string[]) {
    return Session.parseContextOutput(lines);
  }

  /** Send /context, parse output, emit contextUpdate with full category breakdown. */
  private _refreshContext(): void {
    if (this._isStopped || this._awaitingContext) return;
    // Only run when PTY is attached — no PTY means no onData, so output would be lost
    if (!this.ptyProcess) return;
    this._awaitingContext = true;
    this._contextOutputLines = [];
    void this.writeViaMux('/context\r');
    // Safety timeout — clear flag after 8s regardless
    this._contextSafetyTimer = setTimeout(() => {
      this._contextSafetyTimer = null;
      if (this._awaitingContext) {
        this._awaitingContext = false;
        this._contextOutputLines = [];
      }
    }, 8_000);
  }

  private processOutput(data: string): void {
    // Early return if session is stopped to prevent any processing or timer creation
    if (this._isStopped) return;

    // Try to extract JSON from output (Claude may output JSON in stream mode)
    this._lineBuffer += data;

    // Prevent unbounded line buffer growth for very long lines
    if (this._lineBuffer.length > MAX_LINE_BUFFER_SIZE) {
      // Force flush the oversized buffer as text output
      this._textOutput.append(this._lineBuffer + '\n');
      this._lineBuffer = '';
    }

    // Start flush timer if not running (handles partial lines after 100ms)
    if (!this._lineBufferFlushTimer && this._lineBuffer.length > 0 && !this._isStopped) {
      this._lineBufferFlushTimer = setTimeout(() => {
        this._lineBufferFlushTimer = null;
        if (this._lineBuffer.length > 0 && !this._isStopped) {
          // Flush partial line as text output
          this._textOutput.append(this._lineBuffer);
          this._lineBuffer = '';
        }
      }, LINE_BUFFER_FLUSH_INTERVAL);
    }

    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() || '';

    // Clear flush timer if buffer is now empty
    if (this._lineBuffer.length === 0 && this._lineBufferFlushTimer) {
      clearTimeout(this._lineBufferFlushTimer);
      this._lineBufferFlushTimer = null;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      // Remove ANSI escape codes for JSON parsing (use pre-compiled pattern)
      const cleanLine = trimmed.replace(ANSI_ESCAPE_PATTERN_FULL, '');

      if (cleanLine.startsWith('{') && cleanLine.endsWith('}')) {
        try {
          const msg = JSON.parse(cleanLine) as ClaudeMessage;
          this._messages.push(msg);
          this.emit('message', msg);

          // Trim messages array for long-running sessions
          if (this._messages.length > MAX_MESSAGES) {
            this._messages = this._messages.slice(-Math.floor(MAX_MESSAGES * 0.8));
          }

          // Extract Claude session ID from messages (can be in any message type)
          // Support both sessionId (camelCase) and session_id (snake_case)
          const msgSessionId =
            ((msg as unknown as Record<string, unknown>).sessionId as string | undefined) ?? msg.session_id;
          if (msgSessionId && !this._claudeSessionId) {
            this._claudeSessionId = msgSessionId;
          }

          // Track conversation UUID (= JSONL filename) separately. When it changes, a new
          // conversation has started and the transcript watcher may be watching the wrong file.
          if (msgSessionId && msgSessionId !== this._conversationId) {
            this._conversationId = msgSessionId;
            this.emit('conversationId', msgSessionId);
          }

          // Process message for task tracking
          this._taskTracker.processMessage(msg);

          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                this._textOutput.append(block.text);
              }
            }
            // Track tokens from usage (with validation)
            if (msg.message.usage) {
              const inputDelta = msg.message.usage.input_tokens || 0;
              const outputDelta = msg.message.usage.output_tokens || 0;

              // Sanity check: max 100k tokens per message (generous limit)
              const MAX_TOKENS_PER_MESSAGE = 100_000;
              if (inputDelta > 0 && inputDelta <= MAX_TOKENS_PER_MESSAGE) {
                this._totalInputTokens += inputDelta;
              }
              if (outputDelta > 0 && outputDelta <= MAX_TOKENS_PER_MESSAGE) {
                this._totalOutputTokens += outputDelta;
              }
              const cacheReadDelta = msg.message.usage.cache_read_input_tokens || 0;
              const cacheCreationDelta = msg.message.usage.cache_creation_input_tokens || 0;
              if (cacheReadDelta > 0 && cacheReadDelta <= MAX_TOKENS_PER_MESSAGE) {
                this._totalCacheReadTokens += cacheReadDelta;
              }
              if (cacheCreationDelta > 0 && cacheCreationDelta <= MAX_TOKENS_PER_MESSAGE) {
                this._totalCacheCreationTokens += cacheCreationDelta;
              }

              // Check if we should auto-compact or auto-clear
              this._autoOps.checkAutoCompact();
              this._autoOps.checkAutoClear();

              // Emit passive context usage update
              if (inputDelta > 0 && this._totalInputTokens > 0) {
                const maxTokens = CONTEXT_WINDOW_TOKENS;
                this.emit('contextUpdate', {
                  inputTokens: this._totalInputTokens,
                  maxTokens,
                  pct: Math.min(100, Math.round((this._totalInputTokens / maxTokens) * 100)),
                });
              }
            }
          }

          if (msg.type === 'result' && msg.total_cost_usd) {
            this._totalCost = msg.total_cost_usd;
          }
          if (msg.type === 'result') {
            // Schedule a background /context refresh 60s after completion
            if (this._contextRefreshTimer) clearTimeout(this._contextRefreshTimer);
            this._contextRefreshTimer = setTimeout(() => {
              this._contextRefreshTimer = null;
              if (!this._isStopped && this.isIdle()) this._refreshContext();
            }, 60_000);
          }
        } catch (parseErr) {
          // Not JSON, just regular output - this is expected for non-JSON lines
          console.debug(
            '[Session] Line not JSON (expected for text output):',
            parseErr instanceof Error ? parseErr.message : parseErr
          );
          this._textOutput.append(line + '\n');
        }
      } else if (trimmed) {
        // Capture /context output if awaiting refresh (stream-json / non-JSON text path).
        // See the companion block in the PTY onData handler for why there are two sites.
        if (this._awaitingContext) {
          this._contextOutputLines.push(cleanLine);
          const parsed = this._tryParseContextOutput(this._contextOutputLines);
          if (parsed) {
            this._awaitingContext = false;
            this._contextOutputLines = [];
            if (this._contextSafetyTimer) {
              clearTimeout(this._contextSafetyTimer);
              this._contextSafetyTimer = null;
            }
            this.emit('contextUpdate', parsed);
          }
        }
        this._textOutput.append(line + '\n');
      }

      // Parse task descriptions from terminal output (e.g., "Explore(Description)")
      // This captures the short description from Claude Code's Task tool output
      // Use direct method since cleanLine is already ANSI-stripped (line 1460)
      this.parseTaskDescriptionsDirect(cleanLine);
    }
    // Note: BufferAccumulator auto-trims when max size exceeded
  }

  /**
   * Parse task descriptions from terminal data (may contain multiple lines).
   * Called from interactive mode's onData handler with ANSI-stripped data.
   * @param cleanData - Terminal data with ANSI codes already stripped
   */
  private parseTaskDescriptionsFromTerminalData(cleanData: string): void {
    // Quick pre-check: skip if no parentheses present
    if (!cleanData.includes('(') || !cleanData.includes(')')) return;

    // Split by newlines and process each line (data already ANSI-stripped)
    const lines = cleanData.split(NEWLINE_SPLIT_PATTERN);
    for (const line of lines) {
      this.parseTaskDescriptionsDirect(line);
    }
  }

  /**
   * Parse task descriptions from a pre-cleaned line (no ANSI codes).
   * Used by both processOutput() and parseTaskDescriptionsFromTerminalData().
   */
  private parseTaskDescriptionsDirect(cleanLine: string): void {
    // Quick pre-check: skip expensive regex if no common tool patterns present
    if (!cleanLine.includes('(') || !cleanLine.includes(')')) return;

    execPattern(TASK_TOOL_PATTERN, cleanLine, (match) => {
      const description = match[2].trim();
      if (description && description.length > 0) {
        this._taskCache.add(Date.now(), description);
      }
    });
  }

  /**
   * Get recent task descriptions parsed from terminal output.
   * Returns descriptions sorted by timestamp (most recent first).
   */
  getRecentTaskDescriptions(): Array<{ timestamp: number; description: string }> {
    return this._taskCache.getAll();
  }

  /**
   * Find a task description that was parsed close to a given timestamp.
   * Used to correlate with SubagentWatcher discoveries.
   *
   * @param subagentStartTime - The timestamp when the subagent was discovered
   * @param maxAgeMs - Maximum age difference to consider (default 10 seconds)
   * @returns The matching description or undefined
   */
  findTaskDescriptionNear(subagentStartTime: number, maxAgeMs: number = 10000): string | undefined {
    return this._taskCache.findNear(subagentStartTime, maxAgeMs);
  }

  // Parse token count from Claude's status line in interactive mode
  // Matches patterns like "123.4k tokens", "5234 tokens", "1.2M tokens"
  //
  // SAFETY LIMITS:
  // - Max tokens per session: 500k (Claude's context is ~200k)
  // - Max delta per update: 100k (prevents sudden jumps from parsing errors)
  // - Rejects "M" suffix values > 0.5 (500k) to prevent false matches
  private parseTokensFromStatusLine(cleanData: string): void {
    // Quick pre-check: skip expensive regex if "token" not present (performance optimization)
    if (!cleanData.includes('token')) return;

    // Match patterns: "123.4k tokens", "5234 tokens", "1.2M tokens"
    // The status line typically shows total tokens like "1.2k tokens" near the prompt
    // Note: ANSI codes are already stripped by caller for performance
    const tokenMatch = cleanData.match(TOKEN_PATTERN);

    if (tokenMatch) {
      let tokenCount = parseFloat(tokenMatch[1]);
      const suffix = tokenMatch[2]?.toLowerCase();

      // Convert k/M suffix to actual number
      if (suffix === 'k') {
        tokenCount *= 1000;
      } else if (suffix === 'm') {
        // Safety: Reject M values that would result in > 500k tokens
        // Claude's context window is ~200k, so anything claiming millions is likely a false match
        if (tokenCount > 0.5) {
          console.warn(
            `[Session ${this.id}] Rejected suspicious M token value: ${tokenMatch[0]} (would be ${tokenCount * 1000000} tokens)`
          );
          return;
        }
        tokenCount *= 1000000;
      }

      // Safety: Absolute maximum tokens per session
      if (tokenCount > MAX_SESSION_TOKENS) {
        console.warn(`[Session ${this.id}] Rejected token count exceeding max: ${tokenCount} > ${MAX_SESSION_TOKENS}`);
        return;
      }

      // Only update if the new count is higher (tokens only increase within a session)
      // We use total tokens as an estimate - Claude shows combined input+output
      const currentTotal = this._totalInputTokens + this._totalOutputTokens;
      if (tokenCount > currentTotal) {
        const delta = tokenCount - currentTotal;

        // Safety: Reject suspiciously large jumps (max 100k per update)
        const MAX_DELTA_PER_UPDATE = 100_000;
        if (delta > MAX_DELTA_PER_UPDATE) {
          console.warn(
            `[Session ${this.id}] Rejected suspicious token jump: ${currentTotal} -> ${tokenCount} (delta: ${delta})`
          );
          return;
        }

        // Estimate: split roughly 60% input, 40% output (common ratio)
        // This is an approximation since interactive mode doesn't give us the breakdown
        this._totalInputTokens += Math.round(delta * 0.6);
        this._totalOutputTokens += Math.round(delta * 0.4);

        // Check if we should auto-compact or auto-clear
        this._autoOps.checkAutoCompact();
        this._autoOps.checkAutoClear();
      }
    }
  }

  // Parse Claude Code CLI info from terminal startup output
  // Extracts version, model, and account type for display in Codeman UI
  // Note: Expects cleanData with ANSI codes already stripped by caller
  private parseClaudeCodeInfo(cleanData: string): void {
    // Only parse once per session (during startup)
    if (this._cliInfoParsed) return;

    // Quick pre-checks
    if (
      !cleanData.includes('Claude') &&
      !cleanData.includes('current:') &&
      !cleanData.includes('Opus') &&
      !cleanData.includes('Sonnet')
    ) {
      return;
    }
    let changed = false;

    // Match "Claude Code v2.1.27" or "Claude Code vX.Y.Z"
    if (!this._cliVersion) {
      const versionMatch = cleanData.match(/Claude Code v(\d+\.\d+\.\d+)/);
      if (versionMatch) {
        this._cliVersion = versionMatch[1];
        changed = true;
      }
    }

    // Match model and account: "Opus 4.5 · Claude Max" or "Sonnet 4 · API"
    // The · character separates model from account type
    if (!this._cliModel || !this._cliAccountType) {
      // Try various model patterns
      const modelPatterns = [
        /(Opus \d+(?:\.\d+)?)\s*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
        /(Sonnet \d+(?:\.\d+)?)\s*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
        /(Haiku \d+(?:\.\d+)?)\s*[·•]\s*(.+?)(?:\s*$|\s+[~/])/,
      ];

      for (const pattern of modelPatterns) {
        const match = cleanData.match(pattern);
        if (match) {
          if (!this._cliModel) {
            this._cliModel = match[1].trim();
            changed = true;
          }
          if (!this._cliAccountType) {
            this._cliAccountType = match[2].trim();
            changed = true;
          }
          break;
        }
      }
    }

    // Match version check: "current: 2.1.27" and "latest: 2.1.27"
    if (!this._cliLatestVersion) {
      const latestMatch = cleanData.match(/latest:\s*(\d+\.\d+\.\d+)/);
      if (latestMatch) {
        this._cliLatestVersion = latestMatch[1];
        changed = true;
      }
    }

    // Mark as parsed once we have the essential info
    if (this._cliVersion && this._cliModel) {
      this._cliInfoParsed = true;
    }

    // Emit update if anything changed
    if (changed) {
      this.emit('cliInfoUpdated', {
        version: this._cliVersion,
        model: this._cliModel,
        accountType: this._cliAccountType,
        latestVersion: this._cliLatestVersion,
      });
    }
  }

  // Note: checkAutoCompact/checkAutoClear moved to SessionAutoOps (this._autoOps)

  /**
   * Sends input directly to the PTY process.
   *
   * For interactive sessions, this is how you send user input to Claude.
   * Remember to include `\r` (carriage return) to simulate pressing Enter.
   *
   * @param data - The input data to send (text, escape sequences, etc.)
   *
   * @example
   * ```typescript
   * session.write('hello world');  // Text only, no Enter
   * session.write('\r');           // Enter key
   * session.write('ls -la\r');     // Command with Enter
   * ```
   */
  write(data: string): void {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  /**
   * Sends input via the terminal multiplexer's direct input mechanism.
   *
   * More reliable than direct PTY write for programmatic input, especially
   * with Claude CLI which uses Ink (React for terminals).
   * Uses tmux `send-keys -l` to inject text + Enter.
   *
   * @param data - Input data with optional `\r` for Enter
   * @returns true if input was sent, false if no mux session or PTY
   *
   * @example
   * ```typescript
   * session.writeViaMux('/clear\r');  // Send /clear command
   * session.writeViaMux('/init\r');   // Send /init command
   * ```
   */
  async writeViaMux(data: string): Promise<boolean> {
    if (this._mux && this._muxSession) {
      return this._mux.sendInput(this.id, data);
    }
    // Fallback to PTY write
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
      return true;
    }
    return false;
  }

  /** Trigger an immediate /context refresh. Result arrives via 'contextUpdate' event. */
  refreshContext(): void {
    this._refreshContext();
  }

  /** Current PTY dimensions — used to skip no-op resizes that trigger Ink redraws */
  private _ptyCols = 120;
  private _ptyRows = 40;

  /**
   * Resizes the PTY terminal dimensions.
   * Skips the resize if dimensions haven't changed to avoid triggering
   * unnecessary Ink full-screen redraws (visible flicker on tab switch).
   *
   * @param cols - Number of columns (width in characters)
   * @param rows - Number of rows (height in lines)
   */
  resize(cols: number, rows: number): void {
    if (this.ptyProcess && (cols !== this._ptyCols || rows !== this._ptyRows)) {
      this._ptyCols = cols;
      this._ptyRows = rows;
      this.ptyProcess.resize(cols, rows);
    }
  }

  // Legacy method for compatibility with session-manager
  async start(): Promise<void> {
    this._status = 'idle';
  }

  // Legacy method for sending input - wraps runPrompt
  async sendInput(input: string): Promise<void> {
    this._status = 'busy';
    this._lastActivityAt = Date.now();
    this.runPrompt(input).catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // Clean up task state so the task queue doesn't get stuck
      if (this._currentTaskId) {
        const taskId = this._currentTaskId;
        this._currentTaskId = null;
        this._status = 'idle';
        this._lastActivityAt = Date.now();
        this.emit('taskError', taskId, errorMsg);
      } else {
        this._status = 'idle';
      }
      this.emit('error', errorMsg);
    });
  }

  /**
   * Remove event listeners from TaskTracker and RalphTracker.
   * Prevents memory leaks by ensuring handlers don't persist after session stop.
   */
  private cleanupTrackerListeners(): void {
    // Remove TaskTracker handlers
    if (this._taskTrackerHandlers) {
      this._taskTracker.off('taskCreated', this._taskTrackerHandlers.taskCreated);
      this._taskTracker.off('taskUpdated', this._taskTrackerHandlers.taskUpdated);
      this._taskTracker.off('taskCompleted', this._taskTrackerHandlers.taskCompleted);
      this._taskTracker.off('taskFailed', this._taskTrackerHandlers.taskFailed);
      this._taskTrackerHandlers = null;
    }

    // Remove RalphTracker handlers
    if (this._ralphHandlers) {
      this._ralphTracker.off('loopUpdate', this._ralphHandlers.loopUpdate);
      this._ralphTracker.off('todoUpdate', this._ralphHandlers.todoUpdate);
      this._ralphTracker.off('completionDetected', this._ralphHandlers.completionDetected);
      this._ralphTracker.off('statusBlockDetected', this._ralphHandlers.statusBlockDetected);
      this._ralphTracker.off('circuitBreakerUpdate', this._ralphHandlers.circuitBreakerUpdate);
      this._ralphTracker.off('exitGateMet', this._ralphHandlers.exitGateMet);
      this._ralphHandlers = null;
    }

    // Remove BashToolParser handlers
    if (this._bashToolHandlers) {
      this._bashToolParser.off('toolStart', this._bashToolHandlers.toolStart);
      this._bashToolParser.off('toolEnd', this._bashToolHandlers.toolEnd);
      this._bashToolParser.off('toolsUpdate', this._bashToolHandlers.toolsUpdate);
      this._bashToolHandlers = null;
    }

    // Destroy all trackers to release memory and stop timers
    this._bashToolParser.destroy();
    this._taskTracker.destroy();
    this._ralphTracker.destroy();
  }

  /**
   * Stops the session and cleans up resources.
   *
   * This kills the PTY process and optionally the associated tmux session.
   * All buffers are cleared and the session is marked as stopped.
   *
   * @param killMux - Whether to also kill the mux session (default: true)
   *
   * @example
   * ```typescript
   * // Stop and kill everything
   * await session.stop();
   *
   * // Stop but keep mux session running for later reattachment
   * await session.stop(false);
   * ```
   */
  async stop(killMux: boolean = true): Promise<void> {
    // Set stopped flag first to prevent new timers from being created
    this._isStopped = true;

    // Clear activity timeout to prevent memory leak
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }

    // Clear line buffer flush timer
    if (this._lineBufferFlushTimer) {
      clearTimeout(this._lineBufferFlushTimer);
      this._lineBufferFlushTimer = null;
    }

    // Destroy auto-compact/auto-clear automation (clears its timers)
    this._autoOps.destroy();

    // Clear prompt check timers
    if (this._promptCheckInterval) {
      clearInterval(this._promptCheckInterval);
      this._promptCheckInterval = null;
    }
    if (this._promptCheckTimeout) {
      clearTimeout(this._promptCheckTimeout);
      this._promptCheckTimeout = null;
    }

    // Clear shell idle timer
    if (this._shellIdleTimer) {
      clearTimeout(this._shellIdleTimer);
      this._shellIdleTimer = null;
    }

    // Clear expensive processing timer
    if (this._expensiveProcessTimer) {
      clearTimeout(this._expensiveProcessTimer);
      this._expensiveProcessTimer = null;
    }
    this._pendingCleanData = '';

    // Clear context refresh timer
    if (this._contextRefreshTimer) {
      clearTimeout(this._contextRefreshTimer);
      this._contextRefreshTimer = null;
    }
    if (this._contextSafetyTimer) {
      clearTimeout(this._contextSafetyTimer);
      this._contextSafetyTimer = null;
    }
    this._awaitingContext = false;
    this._contextOutputLines = [];

    // Clean up MCP temp config file written by buildMcpArgs
    cleanupMcpConfig(this.id);

    // Immediately cleanup Promise callbacks to prevent orphaned references
    // during the rest of stop() processing (e.g., if mux kill times out)
    if (this.rejectPromise && !this._promptResolved) {
      this._promptResolved = true;
      this.rejectPromise(new Error('Session stopped'));
    }
    this.resolvePromise = null;
    this.rejectPromise = null;

    // Remove event listeners from trackers to prevent memory leaks
    this.cleanupTrackerListeners();

    if (this.ptyProcess) {
      if (killMux) {
        // Full kill: SIGTERM → wait → SIGKILL the PTY and its children
        const pid = this.ptyProcess.pid;

        // First try graceful SIGTERM
        try {
          this.ptyProcess.kill();
        } catch (err) {
          console.warn('[Session] Failed to send SIGTERM to PTY process (may already be dead):', err);
        }

        // Give it a moment to terminate gracefully
        await new Promise((resolve) => setTimeout(resolve, GRACEFUL_SHUTDOWN_DELAY_MS));

        // Force kill with SIGKILL if still alive
        try {
          if (pid) {
            process.kill(pid, 'SIGKILL');
          }
        } catch (err) {
          console.warn('[Session] Failed to send SIGKILL to process (already terminated):', err);
        }

        // Also try to kill any child processes in the process group
        try {
          if (pid) {
            process.kill(-pid, 'SIGKILL');
          }
        } catch (err) {
          console.warn('[Session] Failed to send SIGKILL to process group (may not exist):', err);
        }
      } else {
        // Server shutdown: just detach — the process lives on inside tmux
        console.log('[Session] Detaching from PTY (server shutdown) — mux session preserved');
      }

      this.ptyProcess = null;
    }
    this._pid = null;
    this._status = killMux ? 'stopped' : 'idle';
    this._currentTaskId = null;

    // Clear task description cache and agent tree to prevent memory leak
    this._taskCache.clear();
    this._childAgentIds = [];

    // Kill the associated mux session if requested
    if (killMux && this._mux) {
      // Try to kill mux session even if _muxSession is not set (e.g., restored sessions)
      try {
        const killed = await this._mux.killSession(this.id);
        if (killed) {
          console.log('[Session] Killed mux session for:', this.id);
        }
      } catch (err) {
        console.error('[Session] Failed to kill mux session:', err);
      }
      this._muxSession = null;
    } else if (this._muxSession && !killMux) {
      console.log('[Session] Keeping mux session alive:', this._muxSession.muxName);
      this._muxSession = null; // Detach but don't kill
    }
  }

  /**
   * Tear down the current PTY and mux session so the session can be restarted via
   * `startInteractive()` with updated configuration (e.g., new MCP servers).
   * Unlike `stop()`, this does NOT set `_isStopped = true`.
   */
  async prepareForRestart(): Promise<void> {
    // Clean up the previous MCP temp config file before writing a new one on restart
    cleanupMcpConfig(this.id);
    if (this.ptyProcess) {
      const pid = this.ptyProcess.pid;
      try {
        this.ptyProcess.kill();
      } catch {
        /* already gone */
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      this.ptyProcess = null;
    }
    this._pid = null;
    this._status = 'idle';
    this._currentTaskId = null;
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lineBuffer = '';
    if (this._muxSession && this._mux) {
      try {
        await this._mux.killSession(this.id);
      } catch {
        /* best effort */
      }
    }
    this._muxSession = null;
  }

  /**
   * Rebind this Codeman session to a different tmux session without killing either.
   *
   * Steps:
   * 1. Kill the current PTY (the `tmux attach-session` viewer — NOT the underlying tmux session).
   * 2. Update `_muxSession` to point at `newMuxName`.
   * 3. Tell the mux manager to persist the new mapping.
   * 4. Re-spawn a new PTY attaching to the new tmux session.
   * 5. Emit `clearTerminal` so the frontend refreshes.
   */
  async rebindMuxSession(newMuxName: string, mux: TerminalMultiplexer): Promise<void> {
    if (this._isStopped) return;
    if (!this._useMux || !mux) {
      throw new Error('Session is not using mux — cannot rebind');
    }

    console.log(`[Session] Rebinding mux session: ${this._muxSession?.muxName ?? 'none'} → ${newMuxName}`);

    // Step 1: Kill the current PTY process (the attach viewer, not the tmux session)
    if (this.ptyProcess) {
      const pid = this.ptyProcess.pid;
      try {
        this.ptyProcess.kill();
      } catch {
        /* already gone */
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      this.ptyProcess = null;
    }

    // Clear timers that reference the old PTY
    if (this.activityTimeout) {
      clearTimeout(this.activityTimeout);
      this.activityTimeout = null;
    }
    if (this._promptCheckInterval) {
      clearInterval(this._promptCheckInterval);
      this._promptCheckInterval = null;
    }
    if (this._promptCheckTimeout) {
      clearTimeout(this._promptCheckTimeout);
      this._promptCheckTimeout = null;
    }
    if (this._expensiveProcessTimer) {
      clearTimeout(this._expensiveProcessTimer);
      this._expensiveProcessTimer = null;
    }
    this._pendingCleanData = '';
    this._awaitingIdleConfirmation = false;

    // Step 2: Update the mux session object
    if (this._muxSession) {
      mux.setAttached(this.id, false);
    }

    // Build the new MuxSession object (reuse existing metadata, override muxName)
    // pid will be updated by rebindSession() in the mux manager
    const newMuxSession: MuxSession = {
      sessionId: this.id,
      muxName: newMuxName,
      pid: 0, // updated by rebindSession() below
      createdAt: this._muxSession?.createdAt ?? Date.now(),
      workingDir: this.workingDir,
      mode: this.mode,
      attached: false,
      name: this._name || undefined,
    };
    this._muxSession = newMuxSession;
    this._mux = mux;

    // Step 3: Persist updated mux name in TmuxManager
    mux.rebindSession(this.id, newMuxName);

    // Step 4: Clear buffers so the frontend shows fresh content
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._pid = null;

    // Seed from new tmux session scrollback
    const scrollback = mux.capturePaneContent(newMuxName);
    if (scrollback) {
      const stripped = stripAnsi(scrollback);
      if (stripped.trim()) this._textOutput.append(stripped);
    }

    // Step 5: Re-spawn PTY attached to new tmux session
    try {
      this.ptyProcess = pty.spawn(mux.getAttachCommand(), mux.getAttachArgs(newMuxName), {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.workingDir,
        env: buildMuxAttachEnv(),
      });
    } catch (spawnErr) {
      console.error('[Session] Failed to spawn PTY for rebind:', spawnErr);
      throw spawnErr;
    }

    this._pid = this.ptyProcess.pid;
    this._status = 'idle';
    this._isWorking = false;
    console.log('[Session] Rebind PTY spawned with PID:', this._pid);

    // Re-hook PTY data handler (same as startInteractive)
    this.ptyProcess.onData((rawData: string) => {
      const data = rawData.replace(FOCUS_ESCAPE_FILTER, '').replace(CTRL_L_PATTERN, '');
      if (!data) return;

      this._terminalBuffer.append(data);
      this._lastActivityAt = Date.now();

      if (!this._awaitingContext) {
        this.emit('terminal', data);
      }
      this.emit('output', data);

      if (data.includes('❯') || data.includes('\u276f')) {
        if (!this._awaitingIdleConfirmation) {
          if (this.activityTimeout) clearTimeout(this.activityTimeout);
          this._awaitingIdleConfirmation = true;
          this.activityTimeout = setTimeout(() => {
            this._awaitingIdleConfirmation = false;
            const wasWorking = this._isWorking;
            const isInitialReady = this._status === 'busy' && !this._isWorking;
            if (wasWorking || isInitialReady) {
              this._isWorking = false;
              this._status = 'idle';
              this._lastPromptTime = Date.now();
              this.emit('idle');
            }
          }, IDLE_DETECTION_DELAY_MS);
        }
      }

      const hasSpinner = SPINNER_PATTERN.test(data);
      if (hasSpinner) {
        if (!this._isWorking) {
          this._isWorking = true;
          this._status = 'busy';
          this.emit('working');
        }
        this._awaitingIdleConfirmation = false;
        if (this.activityTimeout) clearTimeout(this.activityTimeout);
      }

      const now = Date.now();
      const elapsed = now - this._lastExpensiveProcessTime;
      if (elapsed >= Session.EXPENSIVE_PROCESS_INTERVAL_MS) {
        this._lastExpensiveProcessTime = now;
        const accumulated = this._pendingCleanData ? this._pendingCleanData + data : data;
        this._pendingCleanData = '';
        if (this._expensiveProcessTimer) {
          clearTimeout(this._expensiveProcessTimer);
          this._expensiveProcessTimer = null;
        }
        this._processExpensiveParsers(accumulated);
      } else {
        this._pendingCleanData += data;
        if (this._pendingCleanData.length > 64 * 1024) {
          this._pendingCleanData = this._pendingCleanData.slice(-32 * 1024);
        }
        if (!this._expensiveProcessTimer) {
          this._expensiveProcessTimer = setTimeout(() => {
            this._expensiveProcessTimer = null;
            this._lastExpensiveProcessTime = Date.now();
            const pending = this._pendingCleanData;
            this._pendingCleanData = '';
            if (pending) {
              this._processExpensiveParsers(pending);
            }
          }, Session.EXPENSIVE_PROCESS_INTERVAL_MS - elapsed);
        }
      }
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      console.log('[Session] Rebind PTY exited with code:', exitCode);
      this.ptyProcess = null;
      this._pid = null;
      this._status = 'idle';
      this._awaitingIdleConfirmation = false;
      if (this.activityTimeout) {
        clearTimeout(this.activityTimeout);
        this.activityTimeout = null;
      }
      if (this._promptCheckInterval) {
        clearInterval(this._promptCheckInterval);
        this._promptCheckInterval = null;
      }
      if (this._promptCheckTimeout) {
        clearTimeout(this._promptCheckTimeout);
        this._promptCheckTimeout = null;
      }
      if (this._expensiveProcessTimer) {
        clearTimeout(this._expensiveProcessTimer);
        this._expensiveProcessTimer = null;
      }
      this._pendingCleanData = '';
      if (this._muxSession && this._mux) {
        this._mux.setAttached(this.id, false);
      }
      // Intentionally emit 'exit' so RespawnController treats this the same as a normal
      // session exit. If the underlying tmux session disappears after a rebind, the respawn
      // logic will fire (same as it would for any PTY exit). This is the desired behavior:
      // if the user rebound to a tmux session that then vanishes, Codeman should attempt to
      // recover via its normal respawn path rather than leaving the session in a zombie state.
      this.emit('exit', exitCode);
    });

    // Step 6: Signal frontend to refresh terminal display
    this.emit('clearTerminal');
  }

  assignTask(taskId: string): void {
    this._currentTaskId = taskId;
    this._status = 'busy';
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._lastActivityAt = Date.now();
  }

  clearTask(): void {
    this._currentTaskId = null;
    this._status = 'idle';
    this._lastActivityAt = Date.now();
  }

  getOutput(): string {
    return this._textOutput.value;
  }

  getError(): string {
    return this._errorBuffer;
  }

  getTerminalBuffer(): string {
    return this._terminalBuffer.value;
  }

  clearBuffers(): void {
    this._terminalBuffer.clear();
    this._textOutput.clear();
    this._errorBuffer = '';
    this._messages = [];
    this._taskTracker.clear();
    this._ralphTracker.clear();
    this._taskCache.clear();
  }

  /**
   * Returns the mux session name (tmux session name) bound to this session, or null if unset.
   */
  getMuxSessionName(): string | null {
    return this._muxSession?.muxName ?? null;
  }

  /**
   * Rebinds this session to a different tmux/mux session without killing the old one.
   * Stops the current PTY attachment (keep-mux=false kills neither), resets stopped flag,
   * sets the new mux session, then restarts the interactive process attached to it.
   */
  async rebindMux(newMuxSession: MuxSession): Promise<void> {
    // stop(false) detaches PTY, preserves mux session, sets _isStopped = true
    await this.stop(false);
    // Reset stopped so the session can be restarted
    this._isStopped = false;
    this._status = 'idle';
    this._muxSession = newMuxSession;
    await this.startInteractive();
  }
}

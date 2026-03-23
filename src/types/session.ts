/**
 * @fileoverview Session type definitions.
 *
 * Core domain type — SessionState is the primary entity in the system.
 *
 * Key exports:
 * - SessionState — full session state (status, tokens, respawn, ralph, CLI metadata)
 * - SessionConfig — creation-time config (id, workingDir, createdAt)
 * - SessionOutput — captured stdout/stderr/exitCode
 * - SessionStatus — 'idle' | 'busy' | 'stopped' | 'error'
 * - SessionMode — 'claude' | 'shell' | 'opencode' (which CLI backend)
 * - ClaudeMode — CLI permission mode ('dangerously-skip-permissions' | 'normal' | 'allowedTools')
 * - SessionColor — visual differentiation color
 * - OpenCodeConfig — OpenCode-specific settings (model, autoAllowTools, continueSession)
 *
 * Cross-domain relationships:
 * - SessionState.respawnConfig embeds RespawnConfig (respawn domain)
 * - SessionState.id is referenced by: RalphSessionState.sessionId (ralph),
 *   RunSummary.sessionId (run-summary), ActiveBashTool.sessionId (tools),
 *   TeamConfig.leadSessionId (teams), RespawnCycleMetrics.sessionId (respawn),
 *   TaskState.assignedSessionId (task)
 *
 * Persisted to `~/.codeman/state.json`. Served at `GET /api/sessions` and
 * `GET /api/sessions/:id`.
 */

import type { RespawnConfig } from './respawn.js';

// ─── Agent Profile Types ──────────────────────────────────────────────────────

/**
 * Role identifier for an agent profile.
 * Determines the agent's default capabilities and system prompt style.
 */
export type AgentRole = 'keeps-engineer' | 'codeman-dev' | 'deployment-agent' | 'orchestrator' | 'analyst';

/**
 * A single capability (MCP server or skill) attached to an agent profile.
 */
export interface AgentCapability {
  name: string;
  type: 'mcp' | 'skill';
  ref: string;
  enabled: boolean;
}

/**
 * Persistent agent profile — stored in AppState.agents and optionally
 * referenced from SessionState.agentProfile.
 */
export interface AgentProfile {
  /** Unique identifier for this agent (UUID) */
  agentId: string;
  /** Role of this agent */
  role: AgentRole;
  /** Human-readable display name */
  displayName: string;
  /** Path to the agent's memory vault (e.g. ~/.codeman/vaults/<agentId>) */
  vaultPath: string;
  /** Capabilities attached to this agent */
  capabilities: AgentCapability[];
  /** Optional role-specific system prompt override */
  rolePrompt?: string;
  /** ISO timestamp of last memory consolidation */
  lastConsolidatedAt?: string;
  /** Number of notes added since last consolidation */
  notesSinceConsolidation: number;
  /** Memory decay configuration */
  decay: {
    notesTtlDays: number;
    patternsTtlDays: number;
  };
  /** ISO timestamp when this profile was created */
  createdAt: string;
  /** ISO timestamp of the last session activity for this agent */
  lastActiveAt?: string;
}

/** Status of a Claude session */
export type SessionStatus = 'idle' | 'busy' | 'stopped' | 'error' | 'archived';

/**
 * Claude CLI startup permission mode.
 * - `'dangerously-skip-permissions'`: Bypass all permission prompts (default)
 * - `'normal'`: Standard mode with permission prompts
 * - `'allowedTools'`: Only allow specific tools (requires allowedTools list)
 */
export type ClaudeMode = 'dangerously-skip-permissions' | 'normal' | 'allowedTools';

/** Session mode: which CLI backend a session runs */
export type SessionMode = 'claude' | 'shell' | 'opencode';

/** A single MCP server entry stored per-session */
export interface McpServerEntry {
  name: string;
  enabled: boolean;
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse transport
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
}

/** OpenCode session configuration */
export interface OpenCodeConfig {
  /** Model identifier (e.g., "anthropic/claude-sonnet-4-5", "openai/gpt-5.2", "ollama/codellama") */
  model?: string;
  /** Whether to auto-allow all tool executions (sets permission.* = allow) */
  autoAllowTools?: boolean;
  /** Session ID to continue from */
  continueSession?: string;
  /** Whether to fork when continuing (branch the conversation) */
  forkSession?: boolean;
  /** Custom inline config JSON (passed via OPENCODE_CONFIG_CONTENT) */
  configContent?: string;
}

/**
 * Configuration for creating a new session
 */
export interface SessionConfig {
  /** Unique session identifier */
  id: string;
  /** Working directory for the session */
  workingDir: string;
  /** Path to git worktree directory if this is a worktree session */
  worktreePath?: string;
  /** Git branch checked out in this worktree */
  worktreeBranch?: string;
  /** Session ID that spawned this worktree session */
  worktreeOriginId?: string;
  /** Description of the task or bug this worktree was created for */
  worktreeNotes?: string;
  /** Port allocated to this worktree session for its dev server */
  assignedPort?: number;
  /** Timestamp when session was created */
  createdAt: number;
}

/**
 * Available session colors for visual differentiation
 */
export type SessionColor = 'default' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink';

/**
 * Current state of a session
 */
export interface SessionState {
  /** Unique session identifier */
  id: string;
  /** Process ID of the PTY process, null if not running */
  pid: number | null;
  /** Current session status */
  status: SessionStatus;
  /** Working directory path */
  workingDir: string;
  /** Path to git worktree directory if this is a worktree session */
  worktreePath?: string;
  /** Git branch checked out in this worktree */
  worktreeBranch?: string;
  /** Session ID that spawned this worktree session */
  worktreeOriginId?: string;
  /** Description of the task or bug this worktree was created for */
  worktreeNotes?: string;
  /** Port allocated to this worktree session for its dev server */
  assignedPort?: number;
  /** ID of currently assigned task, null if none */
  currentTaskId: string | null;
  /** Timestamp when session was created */
  createdAt: number;
  /** Timestamp of last activity */
  lastActivityAt: number;
  /** Session display name */
  name?: string;
  /** Session mode */
  mode?: SessionMode;
  /** Auto-clear enabled */
  autoClearEnabled?: boolean;
  /** Auto-clear token threshold */
  autoClearThreshold?: number;
  /** Auto-compact enabled */
  autoCompactEnabled?: boolean;
  /** Auto-compact token threshold */
  autoCompactThreshold?: number;
  /** Auto-compact prompt */
  autoCompactPrompt?: string;
  /** Image watcher enabled for this session */
  imageWatcherEnabled?: boolean;
  /** Total cost in USD */
  totalCost?: number;
  /** Input tokens used */
  inputTokens?: number;
  /** Output tokens used */
  outputTokens?: number;
  /** Last successfully parsed /context window usage (actual, not cumulative estimate) */
  contextWindowTokens?: number;
  /** Max context window size at last /context parse */
  contextWindowMax?: number;
  /** System tokens from last /context parse */
  contextWindowSystem?: number;
  /** Conversation tokens from last /context parse */
  contextWindowConversation?: number;
  /** Whether respawn controller is currently enabled/running */
  respawnEnabled?: boolean;
  /** Respawn controller config (if enabled) */
  respawnConfig?: RespawnConfig & { durationMinutes?: number };
  /** Ralph / Todo tracker enabled */
  ralphEnabled?: boolean;
  /** Ralph auto-enable disabled (user explicitly turned off Ralph) */
  ralphAutoEnableDisabled?: boolean;
  /** Ralph completion phrase (if set) */
  ralphCompletionPhrase?: string;
  /** Parent agent ID if this session is a spawned agent */
  parentAgentId?: string;
  /** Child agent IDs spawned by this session */
  childAgentIds?: string[];
  /** Agent profile bound to this session (optional — sessions without a profile work unchanged) */
  agentProfile?: AgentProfile;
  /** Nice priority enabled */
  niceEnabled?: boolean;
  /** Nice value (-20 to 19) */
  niceValue?: number;
  /** User-assigned color for visual differentiation */
  color?: SessionColor;
  /** Flicker filter enabled (buffers output after screen clears) */
  flickerFilterEnabled?: boolean;
  /** Claude Code CLI version (parsed from terminal, e.g., "2.1.27") */
  cliVersion?: string;
  /** Claude model in use (parsed from terminal, e.g., "Opus 4.5") */
  cliModel?: string;
  /** Account type (parsed from terminal, e.g., "Claude Max", "API") */
  cliAccountType?: string;
  /** Latest CLI version available (parsed from version check) */
  cliLatestVersion?: string;
  /** OpenCode-specific configuration (only for mode === 'opencode') */
  openCodeConfig?: OpenCodeConfig;
  /** Compose draft — text and uploaded image paths, synced across devices */
  draft?: { text: string; imagePaths: string[]; updatedAt: number };
  /** MCP servers configured for this session */
  mcpServers?: McpServerEntry[];
  /** Claude session UUID for --resume (set from transcript filename) */
  claudeResumeId?: string;
  /** When true, session launches with stripped CLI args: no --resume, no MCP config */
  safeMode?: boolean;
  /** Auto-compact-and-continue enabled: detects compaction request and sends /compact then continue */
  autoCompactAndContinue?: boolean;
  /** ID of the session that was cleared to create this one (archive chain) */
  parentSessionId?: string;
  /** ID of the child session created when this session was cleared */
  childSessionId?: string;
  /** ISO timestamp when this session was archived via clear */
  clearedAt?: string;
  /** Absolute path to Claude transcript file; captured at archive time for reliable serving */
  transcriptPath?: string;
}

/**
 * Output captured from a session
 */
export interface SessionOutput {
  /** Standard output content */
  stdout: string;
  /** Standard error content */
  stderr: string;
  /** Exit code of the process, null if still running */
  exitCode: number | null;
}

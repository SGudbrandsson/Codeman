/**
 * @fileoverview Automated orchestration system.
 *
 * Server-side orchestrator loop that watches for queued work items with
 * orchestration-enabled cases, assigns them to agents, creates worktree
 * sessions per work item, monitors progress via stall detection, and
 * handles cleanup.
 *
 * ## Agent Selection Pipeline (4-tier cascade)
 *
 * When a work item is ready for dispatch, `selectAgent()` evaluates
 * agents in this order:
 *
 * 1. **Explicit** — if `item.assignedAgentId` is set AND the agent exists
 *    in the store, use it directly. If the agent has been deleted, fall
 *    through to the next tier.
 *
 * 2. **Mechanical scoring** — score every registered agent against the
 *    work item using `scoreAgent()`. If the top scorer has score > 0 and
 *    leads by at least `matchingThreshold` (default 3) over the runner-up,
 *    it wins.
 *
 *    Scoring formula:
 *      base              = +1
 *      role keyword hit  = +3  (first keyword from agent.role that appears in title+description)
 *      MCP capability    = +2  (first enabled capability name that appears in title+description)
 *      busy penalty      = -5  (agent has an in_progress work item)
 *
 * 3. **LLM routing** — if no clear mechanical winner, call Claude with a
 *    structured prompt listing agents and the work item, parse JSON response.
 *    Only fires when the Anthropic SDK is installed and the API key is set.
 *
 * 4. **Idle fallback** — first agent with no in_progress items. Used when
 *    LLM routing is unavailable or returns no result.
 *
 * If all tiers fail, the item is skipped (no agent available).
 *
 * Singleton pattern — use `initOrchestrator(deps)` to create and
 * `getOrchestrator()` to retrieve.
 *
 * @dependencies work-items/store, utils/git-utils, state-store, session,
 *   types/orchestrator, web/sse-events
 */

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { Session } from './session.js';
import type { SessionState, AgentProfile, ClaudeMode } from './types/session.js';
import type { NiceConfig } from './types/common.js';
import type { StateStore } from './state-store.js';
import type { TerminalMultiplexer } from './mux-interface.js';
import { claimWorkItem, getReadyWorkItems, updateWorkItem, listWorkItems, getWorkItem } from './work-items/index.js';
import type { WorkItem } from './work-items/types.js';
import {
  addWorktree,
  setupWorktreeArtifacts,
  removeWorktree,
  pruneWorktrees,
  findGitRoot,
  findMainGitRoot,
} from './utils/git-utils.js';
import { detectPortsFromDir, allocateNextPort } from './utils/port-detection.js';
import { CASES_DIR } from './web/route-helpers.js';
import { SseEvent } from './web/sse-events.js';
import type { OrchestratorConfig, OrchestratorDecision, OrchestratorStatus } from './types/orchestrator.js';
import { DEFAULT_ORCHESTRATOR_CONFIG } from './types/orchestrator.js';
import { getErrorMessage } from './types/api.js';

const execFileP = promisify(execFile);

// ─── Dependency injection interface ──────────────────────────────────────────

export interface OrchestratorDeps {
  store: StateStore;
  broadcast: (event: string, data: unknown) => void;
  addSession: (session: Session) => void;
  setupSessionListeners: (session: Session) => Promise<void>;
  persistSessionState: (session: Session) => void;
  getSessionStateWithRespawn: (session: Session) => unknown;
  sessions: ReadonlyMap<string, Session>;
  cleanupSession: (sessionId: string) => Promise<void>;
  mux: TerminalMultiplexer;
  getGlobalNiceConfig: () => Promise<NiceConfig | undefined>;
  getModelConfig: () => Promise<{ defaultModel?: string } | null>;
  getClaudeModeConfig: () => Promise<{ claudeMode?: ClaudeMode; allowedTools?: string }>;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: Orchestrator | null = null;

export function initOrchestrator(deps: OrchestratorDeps): Orchestrator {
  _instance = new Orchestrator(deps);
  return _instance;
}

export function getOrchestrator(): Orchestrator | null {
  return _instance;
}

// ─── Case config helpers ─────────────────────────────────────────────────────

interface LinkedCaseEntry {
  path: string;
  orchestrationEnabled?: boolean;
}

type LinkedCasesMap = Record<string, string | LinkedCaseEntry>;

async function readLinkedCases(): Promise<LinkedCasesMap> {
  const linkedCasesFile = join(homedir(), '.codeman', 'linked-cases.json');
  try {
    return JSON.parse(await fs.readFile(linkedCasesFile, 'utf-8')) as LinkedCasesMap;
  } catch {
    return {};
  }
}

function resolveLinkedEntry(entry: string | LinkedCaseEntry): { path: string; orchestrationEnabled: boolean } {
  if (typeof entry === 'string') {
    return { path: entry, orchestrationEnabled: false };
  }
  return { path: entry.path, orchestrationEnabled: entry.orchestrationEnabled ?? false };
}

async function resolveCasePath(name: string): Promise<string | null> {
  const linked = await readLinkedCases();
  const entry = linked[name];
  if (entry) {
    const { path } = resolveLinkedEntry(entry);
    if (existsSync(path)) return path;
  }

  const caseDirPath = join(CASES_DIR, name);
  if (existsSync(caseDirPath)) return caseDirPath;

  return null;
}

async function isCaseOrchestrationEnabled(caseName: string): Promise<boolean> {
  // Check native case config
  const nativePath = join(CASES_DIR, caseName);
  if (existsSync(nativePath)) {
    const configPath = join(nativePath, 'case-config.json');
    try {
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<string, unknown>;
      if (config.orchestrationEnabled === true) return true;
    } catch {
      /* no config file */
    }
  }

  // Check linked cases
  const linked = await readLinkedCases();
  const entry = linked[caseName];
  if (entry) {
    const { orchestrationEnabled } = resolveLinkedEntry(entry);
    return orchestrationEnabled;
  }

  return false;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

const MAX_RECENT_DECISIONS = 50;
const STALL_CHECK_INTERVAL_MS = 300_000; // 5 minutes
const DISPATCH_RECOVERY_THRESHOLD_MS = 300_000; // 5 minutes

export class Orchestrator extends EventEmitter {
  private deps: OrchestratorDeps;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private recentDecisions: OrchestratorDecision[] = [];
  private lastActionAt: string | null = null;
  private nudgedItems = new Set<string>();
  private running = false;

  constructor(deps: OrchestratorDeps) {
    super();
    this.deps = deps;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;

    const config = this.getConfig();
    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => console.error('[orchestrator] tick error:', getErrorMessage(err)));
    }, config.pollIntervalMs);

    this.stallTimer = setInterval(() => {
      this.checkStalls().catch((err) => console.error('[orchestrator] stall check error:', getErrorMessage(err)));
    }, STALL_CHECK_INTERVAL_MS);

    console.log(`[orchestrator] started (poll=${config.pollIntervalMs}ms, mode=${config.mode})`);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    console.log('[orchestrator] stopped');
  }

  getStatus(): OrchestratorStatus {
    const config = this.getConfig();
    // Count active dispatches
    const inProgress = listWorkItems({ status: 'in_progress' });
    const assigned = listWorkItems({ status: 'assigned' });
    const activeDispatches = inProgress.length + assigned.length;

    // Collect unique caseIds from active work items
    const activeCases = new Set<string>();
    for (const item of [...inProgress, ...assigned]) {
      if (item.caseId) activeCases.add(item.caseId);
    }

    return {
      mode: config.mode,
      activeCases: [...activeCases],
      activeDispatches,
      lastActionAt: this.lastActionAt,
      recentDecisions: this.recentDecisions.slice(0, 20),
    };
  }

  // ─── Configuration ───────────────────────────────────────────────────────

  private getConfig(): OrchestratorConfig {
    const appConfig = this.deps.store.getConfig();
    const stored = appConfig.orchestrator;
    return { ...DEFAULT_ORCHESTRATOR_CONFIG, ...stored };
  }

  // ─── Core loop ───────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    const config = this.getConfig();

    // Step 1: Dispatch recovery
    await this.dispatchRecovery();

    // Step 2: Fetch ready work items
    const readyItems = getReadyWorkItems();

    // Step 3: Filter — must have caseId and orchestration enabled
    const eligible: WorkItem[] = [];
    for (const item of readyItems) {
      if (!item.caseId) continue;
      const enabled = await isCaseOrchestrationEnabled(item.caseId);
      if (enabled) eligible.push(item);
    }

    if (eligible.length === 0) return;

    // Step 4: Check capacity
    const inProgress = listWorkItems({ status: 'in_progress' });
    const assigned = listWorkItems({ status: 'assigned' });
    const currentDispatches = inProgress.length + assigned.length;
    const available = config.maxConcurrentDispatches - currentDispatches;

    if (available <= 0) return;

    // Step 5: Process eligible items up to capacity
    const toProcess = eligible.slice(0, available);
    for (const item of toProcess) {
      try {
        const selection = await this.selectAgent(item);
        if (!selection) {
          console.log(`[orchestrator] no agent available for ${item.id}`);
          continue;
        }
        await this.dispatchWorkItem(item, selection.agentId, selection.method, selection.reasoning);
      } catch (err) {
        console.error(`[orchestrator] dispatch failed for ${item.id}:`, getErrorMessage(err));
      }
    }
  }

  // ─── Dispatch recovery ───────────────────────────────────────────────────

  async dispatchRecovery(): Promise<void> {
    const assigned = listWorkItems({ status: 'assigned' });
    const now = Date.now();

    for (const item of assigned) {
      // If no worktree path and assigned more than 5 min ago, revert to queued
      if (!item.worktreePath && item.assignedAt) {
        const assignedTime = new Date(item.assignedAt).getTime();
        if (now - assignedTime > DISPATCH_RECOVERY_THRESHOLD_MS) {
          console.log(`[orchestrator] recovering stuck item ${item.id} — reverting to queued`);
          updateWorkItem(item.id, {
            status: 'queued',
            assignedAgentId: null,
            assignedAt: null,
          });
          this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: item.id, status: 'queued' });
        }
      }
    }
  }

  // ─── Agent selection ─────────────────────────────────────────────────────

  /**
   * Select the best agent for a work item using a 4-tier cascade:
   * explicit → mechanical scoring → LLM routing → idle fallback.
   *
   * Returns null if no agent is available across all tiers.
   */
  async selectAgent(
    item: WorkItem
  ): Promise<{ agentId: string; method: OrchestratorDecision['method']; reasoning: string } | null> {
    // Explicit assignment — verify agent still exists before trusting pre-assignment
    if (item.assignedAgentId) {
      const explicitAgent = this.deps.store.getAgent(item.assignedAgentId);
      if (explicitAgent) {
        return { agentId: item.assignedAgentId, method: 'explicit', reasoning: 'Pre-assigned agent' };
      }
      console.warn(
        `[orchestrator] pre-assigned agent "${item.assignedAgentId}" not found for ${item.id} — falling through to scoring`
      );
    }

    const agents = this.deps.store.listAgents();
    if (agents.length === 0) return null;

    // Mechanical scoring
    const scores = agents.map((agent: AgentProfile) => ({
      agent,
      score: this.scoreAgent(agent, item),
    }));
    scores.sort(
      (a: { agent: AgentProfile; score: number }, b: { agent: AgentProfile; score: number }) => b.score - a.score
    );

    const config = this.getConfig();
    const top = scores[0];
    const second = scores.length > 1 ? scores[1] : null;

    // Clear winner check
    if (top.score > 0 && (!second || top.score - second.score >= config.matchingThreshold)) {
      return {
        agentId: top.agent.agentId,
        method: 'mechanical',
        reasoning: `Score ${top.score} (gap >= ${config.matchingThreshold})`,
      };
    }

    // LLM routing fallback
    const llmResult = await this.llmRoute(item, agents);
    if (llmResult) return llmResult;

    // Fallback: first idle agent
    const idle = this.findIdleAgent(agents);
    if (idle) {
      return { agentId: idle.agentId, method: 'fallback', reasoning: 'First idle agent (LLM unavailable)' };
    }

    return null;
  }

  /**
   * Score an agent's fit for a work item.
   *
   * Formula: base(+1) + roleKeyword(+3) + mcpCapability(+2) + busyPenalty(-5)
   *
   * Role keywords are extracted by splitting `agent.role` on hyphens, underscores,
   * and spaces. Keywords shorter than 3 chars are ignored to avoid false positives.
   */
  private scoreAgent(agent: AgentProfile, item: WorkItem): number {
    let score = 1; // base score

    // Role keyword match in title/description
    const keywords = agent.role.toLowerCase().split(/[-_\s]+/);
    const text = `${item.title} ${item.description}`.toLowerCase();
    for (const kw of keywords) {
      if (kw.length > 2 && text.includes(kw)) {
        score += 3;
        break;
      }
    }

    // MCP capability match
    if (agent.capabilities && agent.capabilities.length > 0) {
      for (const cap of agent.capabilities) {
        if (cap.enabled && text.includes(cap.name.toLowerCase())) {
          score += 2;
          break;
        }
      }
    }

    // Busy penalty
    const inProgressItems = listWorkItems({ status: 'in_progress', agentId: agent.agentId });
    if (inProgressItems.length > 0) {
      score -= 5;
    }

    return score;
  }

  private findIdleAgent(agents: AgentProfile[]): AgentProfile | null {
    for (const agent of agents) {
      const busy = listWorkItems({ status: 'in_progress', agentId: agent.agentId });
      if (busy.length === 0) return agent;
    }
    return null;
  }

  private async llmRoute(
    item: WorkItem,
    agents: AgentProfile[]
  ): Promise<{ agentId: string; method: 'llm'; reasoning: string } | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Anthropic = ((await import('@anthropic-ai/sdk' as string)) as any).default;
      const client = new Anthropic() as {
        messages: {
          create: (opts: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>;
        };
      };

      const agentList = agents
        .map(
          (a) => `- ${a.agentId}: ${a.displayName} (${a.role})${a.rolePrompt ? ': ' + a.rolePrompt.slice(0, 100) : ''}`
        )
        .join('\n');

      const prompt = `Given this work item:
Title: ${item.title}
Description: ${item.description || '(none)'}
Project: ${item.caseId || '(unknown)'}

Available agents:
${agentList}

Which agent should handle this? Return JSON only: { "agentId": "...", "reasoning": "..." }`;

      const response = (await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      })) as { content: Array<{ type: string; text?: string }> };

      const firstBlock = response.content[0];
      const text = firstBlock?.type === 'text' && firstBlock.text ? firstBlock.text : '';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { agentId: string; reasoning: string };
        // Validate agentId exists
        if (agents.some((a) => a.agentId === parsed.agentId)) {
          return { agentId: parsed.agentId, method: 'llm', reasoning: parsed.reasoning };
        }
      }
    } catch {
      // SDK not installed or API error — fall through to fallback
    }
    return null;
  }

  // ─── Dispatch ────────────────────────────────────────────────────────────

  async dispatchWorkItem(
    item: WorkItem,
    agentId: string,
    method: OrchestratorDecision['method'],
    reasoning: string
  ): Promise<void> {
    // Record decision
    const decision: OrchestratorDecision = {
      workItemId: item.id,
      agentId,
      method,
      reasoning,
      timestamp: new Date().toISOString(),
    };
    this.recentDecisions.unshift(decision);
    if (this.recentDecisions.length > MAX_RECENT_DECISIONS) {
      this.recentDecisions.length = MAX_RECENT_DECISIONS;
    }
    this.lastActionAt = decision.timestamp;
    this.deps.broadcast(SseEvent.OrchestratorDecision, decision);

    // Step 0: Validate agent exists
    const agent = this.deps.store.getAgent(agentId);
    if (!agent) {
      console.warn(`[orchestrator] agent "${agentId}" not found — cannot dispatch ${item.id}`);
      return;
    }

    // Step 1: Claim
    const claimed = claimWorkItem(item.id, agentId);
    if (!claimed) {
      console.log(`[orchestrator] item ${item.id} already claimed — skipping`);
      return;
    }

    // Step 2: Resolve case path
    if (!item.caseId) {
      console.warn(`[orchestrator] item ${item.id} has no caseId — reverting`);
      updateWorkItem(item.id, { status: 'queued', assignedAgentId: null, assignedAt: null });
      return;
    }

    const casePath = await resolveCasePath(item.caseId);
    if (!casePath) {
      console.warn(`[orchestrator] case ${item.caseId} not found — reverting item ${item.id}`);
      updateWorkItem(item.id, { status: 'queued', assignedAgentId: null, assignedAt: null });
      return;
    }

    // Step 3: Find git root
    const gitRoot = findGitRoot(casePath);
    if (!gitRoot) {
      console.warn(`[orchestrator] no git root for case ${item.caseId} at ${casePath} — reverting`);
      updateWorkItem(item.id, { status: 'queued', assignedAgentId: null, assignedAt: null });
      return;
    }

    // Step 4: Create worktree
    const slug = item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const prefix = item.source === 'github' ? 'fix' : 'feat';
    const branch = `${prefix}/${item.id}-${slug}`;
    const mainGitRoot = (await findMainGitRoot(casePath)) ?? gitRoot;
    const worktreePath = join(dirname(mainGitRoot), `${mainGitRoot.split('/').pop()}-${branch.replace(/\//g, '-')}`);

    try {
      await addWorktree(gitRoot, worktreePath, branch, true);
    } catch (err) {
      console.error(`[orchestrator] addWorktree failed for ${item.id}:`, getErrorMessage(err));
      updateWorkItem(item.id, { status: 'queued', assignedAgentId: null, assignedAt: null });
      this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: item.id, status: 'queued' });
      return;
    }

    try {
      await setupWorktreeArtifacts(gitRoot, worktreePath);
    } catch (err) {
      console.warn(`[orchestrator] setupWorktreeArtifacts failed for ${item.id}:`, getErrorMessage(err));
    }

    // Step 5: Create session
    const [niceConfig, modelConfig, claudeModeConfig] = await Promise.all([
      this.deps.getGlobalNiceConfig(),
      this.deps.getModelConfig(),
      this.deps.getClaudeModeConfig(),
    ]);

    const basePorts = await detectPortsFromDir(gitRoot);
    const usedPorts = [...this.deps.sessions.values()]
      .filter((s) => s.worktreePath && s.worktreePath.startsWith(dirname(gitRoot)))
      .map((s) => s.assignedPort)
      .filter((p): p is number => p !== undefined);
    const assignedPort = allocateNextPort(basePorts, usedPorts) ?? undefined;

    const newSession = new Session({
      workingDir: worktreePath,
      mode: 'claude',
      name: branch,
      mux: this.deps.mux,
      useMux: true,
      niceConfig,
      model: modelConfig?.defaultModel,
      claudeMode: claudeModeConfig.claudeMode,
      allowedTools: claudeModeConfig.allowedTools,
      worktreePath,
      worktreeBranch: branch,
      worktreeNotes: `Orchestrator dispatch: ${item.title}`,
      assignedPort,
    });

    this.deps.addSession(newSession);
    this.deps.persistSessionState(newSession);
    await this.deps.setupSessionListeners(newSession);

    // Set dispatch session metadata in state
    const sessionState = this.deps.store.getState().sessions[newSession.id];
    if (sessionState) {
      sessionState.isDispatchSession = true;
      sessionState.caseId = item.caseId;
      sessionState.currentWorkItemId = item.id;
      sessionState.agentProfile = agent;
    }
    this.deps.persistSessionState(newSession);

    const lightState = this.deps.getSessionStateWithRespawn(newSession);
    this.deps.broadcast(SseEvent.SessionCreated, lightState);

    // Step 6: Start interactive and send prompt
    try {
      await newSession.startInteractive();
      this.deps.broadcast(SseEvent.SessionInteractive, { id: newSession.id, mode: 'claude' });

      // Build initial prompt
      const promptParts: string[] = [];
      if (agent.rolePrompt) {
        promptParts.push(agent.rolePrompt);
      }
      promptParts.push(`## Work Item: ${item.title}`);
      if (item.description) {
        promptParts.push(item.description);
      }
      promptParts.push(`\nWorking directory: ${worktreePath}`);
      promptParts.push(`Branch: ${branch}`);
      promptParts.push(`\nWhen you are done, output: TASK COMPLETE`);

      const prompt = promptParts.join('\n\n');

      // Wait a moment for Claude to initialize before sending input
      await new Promise((resolve) => setTimeout(resolve, 3000));
      newSession.sendInput(prompt);
    } catch (err) {
      console.error(`[orchestrator] session start failed for ${item.id}:`, getErrorMessage(err));
      // Revert work item — don't rely on 5-min dispatch recovery
      updateWorkItem(item.id, { status: 'queued', assignedAgentId: null, assignedAt: null });
      this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: item.id, status: 'queued' });
      try {
        await this.deps.cleanupSession(newSession.id);
      } catch {
        /* best-effort cleanup */
      }
      return;
    }

    // Step 7: Update work item (only on success)
    updateWorkItem(item.id, {
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      worktreePath,
      branchName: branch,
    });

    this.deps.broadcast(SseEvent.OrchestratorDispatch, {
      workItemId: item.id,
      agentId,
      sessionId: newSession.id,
      branch,
      casePath,
    });
    this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: item.id, status: 'in_progress' });

    console.log(`[orchestrator] dispatched ${item.id} → agent ${agentId} (${method}), session ${newSession.id}`);
  }

  // ─── Session completion ──────────────────────────────────────────────────

  async handleSessionCompletion(sessionId: string): Promise<void> {
    const sessionState = this.deps.store.getState().sessions[sessionId];
    if (!sessionState?.currentWorkItemId) return;

    const item = getWorkItem(sessionState.currentWorkItemId);
    if (!item || item.status !== 'in_progress') return;

    // Check for commits on worktree branch
    let hasCommits = false;
    if (item.worktreePath && item.branchName) {
      try {
        const { stdout } = await execFileP('git', ['log', 'HEAD', '--not', '--remotes', '--oneline', '-1'], {
          cwd: item.worktreePath,
          timeout: 10_000,
        });
        hasCommits = stdout.trim().length > 0;
      } catch {
        // git log failed — assume no commits
      }
    }

    if (hasCommits) {
      updateWorkItem(item.id, { status: 'review' });
      this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: item.id, status: 'review' });
      console.log(`[orchestrator] ${item.id} → review (commits found)`);
    } else {
      console.log(`[orchestrator] ${item.id} session completed but no commits — leaving in_progress`);
    }
  }

  // ─── Stall detection ────────────────────────────────────────────────────

  async checkStalls(): Promise<void> {
    const config = this.getConfig();
    const inProgress = listWorkItems({ status: 'in_progress' });
    const now = Date.now();

    for (const item of inProgress) {
      if (!item.worktreePath) continue;

      // Find the session for this work item
      const allSessions = this.deps.store.getSessions();
      let sessionState: SessionState | undefined;
      for (const key of Object.keys(allSessions)) {
        const s = allSessions[key];
        if (s.currentWorkItemId === item.id) {
          sessionState = s;
          break;
        }
      }

      if (!sessionState) {
        // Session gone — mark blocked
        updateWorkItem(item.id, { status: 'blocked' });
        this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: item.id, status: 'blocked' });
        this.deps.broadcast(SseEvent.OrchestratorStall, {
          workItemId: item.id,
          reason: 'session_missing',
        });
        continue;
      }

      // Check session status
      if (sessionState.status === 'stopped' || sessionState.status === 'error') {
        updateWorkItem(item.id, { status: 'blocked' });
        this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: item.id, status: 'blocked' });
        this.deps.broadcast(SseEvent.OrchestratorStall, {
          workItemId: item.id,
          reason: `session_${sessionState.status}`,
        });
        continue;
      }

      const idleMs = now - sessionState.lastActivityAt;

      // Check for recent commits
      let hasRecentCommits = false;
      try {
        const sinceTime = new Date(now - config.stallThresholdMs).toISOString();
        const { stdout } = await execFileP('git', ['log', `--since=${sinceTime}`, '--oneline', '-1'], {
          cwd: item.worktreePath,
          timeout: 10_000,
        });
        hasRecentCommits = stdout.trim().length > 0;
      } catch {
        // git log failed
      }

      if (hasRecentCommits) continue; // Active work happening

      if (this.nudgedItems.has(item.id)) {
        // Already nudged — check if past nudge threshold
        if (idleMs > config.nudgeThresholdMs) {
          updateWorkItem(item.id, { status: 'blocked' });
          this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: item.id, status: 'blocked' });
          this.deps.broadcast(SseEvent.OrchestratorStall, {
            workItemId: item.id,
            reason: 'stalled_after_nudge',
            idleMs,
          });
          this.nudgedItems.delete(item.id);
          console.log(`[orchestrator] ${item.id} → blocked (stalled after nudge, idle ${Math.round(idleMs / 1000)}s)`);
        }
      } else if (idleMs > config.stallThresholdMs) {
        // Send nudge
        const session = this.deps.sessions.get(sessionState.id);
        if (session) {
          session.sendInput(`What's your status on "${item.title}"? Please provide an update or continue working.`);
          this.nudgedItems.add(item.id);
          this.deps.broadcast(SseEvent.OrchestratorStall, {
            workItemId: item.id,
            reason: 'nudge_sent',
            idleMs,
          });
          console.log(`[orchestrator] nudged ${item.id} (idle ${Math.round(idleMs / 1000)}s)`);
        }
      }
    }
  }

  // ─── Cleanup on done ─────────────────────────────────────────────────────

  async handleWorkItemDone(workItemId: string): Promise<void> {
    const item = getWorkItem(workItemId);
    if (!item) return;

    // Find and stop associated session
    const allSessions = this.deps.store.getSessions();
    for (const sessionId of Object.keys(allSessions)) {
      const s = allSessions[sessionId];
      if (s.currentWorkItemId === workItemId) {
        try {
          await this.deps.cleanupSession(sessionId);
        } catch (err) {
          console.warn(`[orchestrator] cleanup session ${sessionId} failed:`, getErrorMessage(err));
        }
        break;
      }
    }

    // Remove worktree
    if (item.worktreePath) {
      const gitRoot = findGitRoot(item.worktreePath);
      const mainRoot = gitRoot ? await findMainGitRoot(gitRoot) : null;
      const repoDir = mainRoot ?? gitRoot;

      if (repoDir) {
        try {
          await removeWorktree(repoDir, item.worktreePath);
        } catch {
          try {
            await removeWorktree(repoDir, item.worktreePath, true);
          } catch {
            try {
              await pruneWorktrees(repoDir);
            } catch (err) {
              console.warn(`[orchestrator] pruneWorktrees failed:`, getErrorMessage(err));
            }
          }
        }
      }
    }

    // Update work item
    updateWorkItem(workItemId, {
      completedAt: new Date().toISOString(),
      worktreePath: null,
    });
    this.deps.broadcast(SseEvent.WorkItemStatusChanged, { id: workItemId, status: 'done' });
    this.nudgedItems.delete(workItemId);

    console.log(`[orchestrator] work item ${workItemId} done — cleaned up`);
  }
}

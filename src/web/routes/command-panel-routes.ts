/**
 * @fileoverview Command panel routes — natural language command interface.
 *
 * Routes:
 *   GET  /api/command/status   — check if command panel is available (SDK + API key)
 *   POST /api/command          — send a natural language command
 *   POST /api/command/confirm  — confirm a destructive action
 *
 * Uses Claude claude-haiku-4-5-20251001 with tool_use to interpret user intent and map to
 * internal Codeman API operations.
 */

import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../ports/index.js';
import { SseEvent } from '../sse-events.js';
import { listWorkItems, createWorkItem, updateWorkItem } from '../../work-items/index.js';
import type { WorkItemStatus } from '../../work-items/index.js';
import { fetchAsanaTask, fetchGitHubContext, fetchSentryIssue, fetchSlackMessage } from '../../integrations/index.js';

type CommandPanelCtx = SessionPort & EventPort & ConfigPort & InfraPort;

/* ── Types ──────────────────────────────────────────────────────────── */

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

interface Conversation {
  id: string;
  title: string;
  messages: ConversationMessage[];
  lastActivity: number;
  createdAt: string;
  updatedAt: string;
}

interface PendingConfirmation {
  confirmId: string;
  conversationId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;
  createdAt: number;
}

interface ActionResult {
  tool: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

/* ── In-memory stores ───────────────────────────────────────────────── */

const conversations = new Map<string, Conversation>();
const pendingConfirmations = new Map<string, PendingConfirmation>();

const CONVERSATION_TTL = 30 * 60 * 1000; // 30 min
const CONFIRMATION_TTL = 60 * 1000; // 60 sec
const MAX_MESSAGES = 40; // ~20 turns (user + assistant each)

/* ── Persistent conversation storage ───────────────────────────────── */

const CONVERSATIONS_DIR = join(homedir(), '.codeman', 'data', 'conversations');

function ensureConversationsDir(): void {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true, mode: 0o700 });
}

/** Validate conversation ID to prevent path traversal. */
function isValidId(id: string): boolean {
  return /^[a-f0-9-]{36}$/.test(id);
}

/** Generate title from first user message (first 60 chars, strip markdown). */
function generateTitle(message: string | Array<Record<string, unknown>>): string {
  let text: string;
  if (typeof message === 'string') {
    text = message;
  } else {
    // Multimodal — find first text block
    const textBlock = message.find((b) => b.type === 'text' && typeof b.text === 'string');
    text = (textBlock?.text as string) || 'New conversation';
  }
  return (
    text
      .replace(/[*_`#[\]]/g, '')
      .trim()
      .slice(0, 60) || 'New conversation'
  );
}

function saveConversation(conv: Conversation): void {
  ensureConversationsDir();
  const filePath = join(CONVERSATIONS_DIR, `${conv.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(conv));
}

function loadConversation(id: string): Conversation | null {
  if (!isValidId(id)) return null;
  try {
    const filePath = join(CONVERSATIONS_DIR, `${id}.json`);
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as Conversation;
  } catch {
    return null;
  }
}

function listConversations(): Array<{ id: string; title: string; updatedAt: string; messageCount: number }> {
  ensureConversationsDir();
  const results: Array<{ id: string; title: string; updatedAt: string; messageCount: number }> = [];
  try {
    const files = fs.readdirSync(CONVERSATIONS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = fs.readFileSync(join(CONVERSATIONS_DIR, file), 'utf-8');
        const conv = JSON.parse(data) as Conversation;
        results.push({
          id: conv.id,
          title: conv.title || 'Untitled',
          updatedAt: conv.updatedAt || conv.createdAt || new Date().toISOString(),
          messageCount: conv.messages?.length || 0,
        });
      } catch {
        /* skip corrupted files */
      }
    }
  } catch {
    /* dir doesn't exist yet */
  }
  results.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return results;
}

function deleteConversationFile(id: string): boolean {
  if (!isValidId(id)) return false;
  try {
    fs.unlinkSync(join(CONVERSATIONS_DIR, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Prune expired conversations from in-memory cache (files persist). */
function pruneExpired(): void {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - conv.lastActivity > CONVERSATION_TTL) conversations.delete(id);
  }
  for (const [id, pending] of pendingConfirmations) {
    if (now - pending.createdAt > CONFIRMATION_TTL) pendingConfirmations.delete(id);
  }
}

/* ── Tool definitions for Claude ────────────────────────────────────── */

const DESTRUCTIVE_TOOLS = new Set(['delete_session', 'send_input', 'orchestrator_toggle']);

const TOOLS = [
  {
    name: 'list_sessions',
    description:
      'List all active sessions with their IDs, names, working directories, agent types, and status (idle/working). No parameters needed.',
    input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'get_session_details',
    description: 'Get detailed information about a specific session including cost, token usage, and working state.',
    input_schema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'The session ID' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'rename_session',
    description: 'Rename a session.',
    input_schema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'The session ID' },
        name: { type: 'string', description: 'The new name for the session' },
      },
      required: ['session_id', 'name'],
    },
  },
  {
    name: 'delete_session',
    description: 'Delete/terminate a session. This is destructive and requires confirmation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'The session ID to delete' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'send_input',
    description: 'Send text input to a session terminal. Requires confirmation to prevent accidental commands.',
    input_schema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'The session ID' },
        text: { type: 'string', description: 'The text to send to the session' },
      },
      required: ['session_id', 'text'],
    },
  },
  {
    name: 'list_work_items',
    description: 'List work items, optionally filtered by status (pending, in_progress, done, blocked).',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: pending, in_progress, done, blocked',
          enum: ['pending', 'in_progress', 'done', 'blocked'],
        },
      },
      required: [] as string[],
    },
  },
  {
    name: 'create_work_item',
    description:
      'Create a new work item and dispatch it to the orchestrator. Include caseId to route to the right project.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Title of the work item' },
        description: {
          type: 'string',
          description: 'Detailed description including any URLs, context, or requirements',
        },
        caseId: {
          type: 'string',
          description:
            'Project/case name to assign to (e.g. "Codeman", "keeps"). If known, always include this so the orchestrator picks it up.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'orchestrator_status',
    description: 'Get the current orchestrator status including running state, active cases, and recent decisions.',
    input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'orchestrator_toggle',
    description: 'Toggle orchestration on or off for a specific case. Destructive — requires confirmation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        case_id: { type: 'string', description: 'The case ID to toggle' },
        enabled: { type: 'boolean', description: 'Whether to enable or disable orchestration' },
      },
      required: ['case_id', 'enabled'],
    },
  },
  {
    name: 'get_system_status',
    description: 'Get system-level information: total sessions, uptime, server port, SSE client count.',
    input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'fetch_asana_task',
    description:
      'Fetch an Asana task by ID or URL. Returns task details (title, description, URL). Use when user references an Asana task or pastes an Asana URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id_or_url: { type: 'string', description: 'Asana task GID or full Asana task URL' },
      },
      required: ['task_id_or_url'],
    },
  },
  {
    name: 'fetch_github_context',
    description:
      'Fetch a GitHub PR or issue by URL. Returns title, body, state, diff summary, and review comments. Use when user pastes a GitHub PR or issue URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'Full GitHub PR or issue URL (e.g. https://github.com/owner/repo/pull/123)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'fetch_sentry_issue',
    description:
      'Fetch a Sentry issue by ID. Returns error title, culprit, stack trace, occurrence count. Use when user references a Sentry issue.',
    input_schema: {
      type: 'object' as const,
      properties: {
        issue_id: { type: 'string', description: 'Sentry issue ID (numeric)' },
      },
      required: ['issue_id'],
    },
  },
  {
    name: 'fetch_slack_message',
    description:
      'Fetch a Slack message and its thread by URL. Returns message text, author, channel, and thread replies. Use when user pastes a Slack message URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'Slack message URL (e.g. https://team.slack.com/archives/C123/p1234567890)',
        },
      },
      required: ['url'],
    },
  },
];

const SYSTEM_PROMPT = `You are Codeman's command assistant — a manager's interface for delegating work to AI agents. You help create tasks, monitor progress, and take action through tools.

You have tools to interact with Codeman: create work items, list sessions, check orchestrator status, and more. ALWAYS prefer action over asking questions. When the user asks you to do something, DO IT using tools.

Key behaviors:
- **When the user pastes a URL (Asana, Sentry, GitHub, Slack):** Use the appropriate fetch tool (fetch_asana_task, fetch_github_context, fetch_sentry_issue, fetch_slack_message) to get context FIRST, then offer to create a work item from it.
- **When the user says "fix X" or "create a task for X":** Use create_work_item immediately. Include caseId if you can infer the project.
- **When asked about status:** Use list_work_items, orchestrator_status, or list_sessions to give a real answer, not a guess.
- **Be concise.** This is a utility chat, not a conversation. Lead with action.
- When referring to sessions, include the name AND first 8 chars of ID.
- For destructive operations, the system handles confirmation — just call the tool.
- When a user refers to a session by name or number, match it to an existing session.
- Format responses using simple markdown (bold, lists, code).`;

/* ── Tool execution ─────────────────────────────────────────────────── */

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: CommandPanelCtx
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    switch (toolName) {
      case 'list_sessions': {
        const sessions: Array<Record<string, unknown>> = [];
        for (const [id, session] of ctx.sessions) {
          const state = ctx.getSessionStateWithRespawn(session) as Record<string, unknown>;
          sessions.push({
            id,
            name: (session as unknown as Record<string, unknown>).name || '(unnamed)',
            workingDir: (session as unknown as Record<string, unknown>).workingDir || '',
            agentType: (session as unknown as Record<string, unknown>).agentType || 'claude',
            isWorking: !!state?.isWorking,
            cost: (state?.totalCost as number) || 0,
          });
        }
        return { success: true, result: sessions };
      }

      case 'get_session_details': {
        const sid = toolInput.session_id as string;
        const session = ctx.sessions.get(sid);
        if (!session) return { success: false, error: `Session ${sid} not found` };
        const state = ctx.getSessionStateWithRespawn(session) as Record<string, unknown>;
        return {
          success: true,
          result: {
            id: sid,
            name: (session as unknown as Record<string, unknown>).name,
            workingDir: (session as unknown as Record<string, unknown>).workingDir,
            agentType: (session as unknown as Record<string, unknown>).agentType,
            isWorking: !!state?.isWorking,
            totalCost: state?.totalCost || 0,
            totalTokens: state?.totalTokens || 0,
            model: state?.model || 'unknown',
          },
        };
      }

      case 'rename_session': {
        const sid = toolInput.session_id as string;
        const newName = toolInput.name as string;
        const session = ctx.sessions.get(sid);
        if (!session) return { success: false, error: `Session ${sid} not found` };
        (session as unknown as Record<string, unknown>).name = newName;
        ctx.mux.updateSessionName(sid, newName);
        ctx.persistSessionState(session);
        ctx.broadcast(SseEvent.SessionUpdated, ctx.getSessionStateWithRespawn(session));
        return { success: true, result: { id: sid, name: newName } };
      }

      case 'delete_session': {
        const sid = toolInput.session_id as string;
        const session = ctx.sessions.get(sid);
        if (!session) return { success: false, error: `Session ${sid} not found` };
        const name = (session as unknown as Record<string, unknown>).name || sid;
        await ctx.cleanupSession(sid);
        return { success: true, result: { deleted: sid, name } };
      }

      case 'send_input': {
        const sid = toolInput.session_id as string;
        const text = toolInput.text as string;
        const session = ctx.sessions.get(sid);
        if (!session) return { success: false, error: `Session ${sid} not found` };
        const pty = (session as unknown as Record<string, unknown>).pty as
          | { write?: (data: string) => void }
          | undefined;
        if (pty?.write) {
          pty.write(text + '\r');
          return { success: true, result: { sent: text, session_id: sid } };
        }
        return { success: false, error: 'Session has no active terminal' };
      }

      case 'list_work_items': {
        const status = toolInput.status as WorkItemStatus | undefined;
        const items = listWorkItems({ status });
        return { success: true, result: items };
      }

      case 'create_work_item': {
        const item = createWorkItem({
          title: toolInput.title as string,
          description: (toolInput.description as string) || undefined,
          source: 'manual' as const,
        });
        // Set caseId if provided (enables orchestrator dispatch)
        if (toolInput.caseId && item.id) {
          updateWorkItem(item.id, { caseId: toolInput.caseId as string } as Record<string, unknown>);
        }
        return { success: true, result: { ...item, caseId: (toolInput.caseId as string) || null } };
      }

      case 'orchestrator_status': {
        try {
          const { getOrchestrator } = await import('../../orchestrator.js');
          const orchestrator = getOrchestrator();
          if (!orchestrator) {
            return { success: true, result: { running: false, mode: 'disabled' } };
          }
          return { success: true, result: orchestrator.getStatus() };
        } catch {
          return { success: true, result: { running: false, mode: 'not-initialized' } };
        }
      }

      case 'orchestrator_toggle': {
        // This is handled as a simple pass-through. The actual logic
        // is more complex (case config file changes) but for the command panel
        // we report what was requested and let the user use the orchestrator UI for details.
        return {
          success: true,
          result: {
            case_id: toolInput.case_id,
            enabled: toolInput.enabled,
            note: 'Orchestrator toggle requested. Use the Orchestrator UI for detailed configuration.',
          },
        };
      }

      case 'get_system_status': {
        const uptime = Date.now() - ctx.serverStartTime;
        const hours = Math.floor(uptime / 3600000);
        const minutes = Math.floor((uptime % 3600000) / 60000);
        return {
          success: true,
          result: {
            sessionCount: ctx.sessions.size,
            sseClients: ctx.getSseClientCount(),
            port: ctx.port,
            uptime: `${hours}h ${minutes}m`,
            testMode: ctx.testMode,
          },
        };
      }

      case 'fetch_asana_task': {
        const integrations = ctx.store.getConfig().integrations;
        const asanaCfg = integrations?.asana;
        if (!asanaCfg?.enabled || !asanaCfg.token) {
          return {
            success: false,
            error: 'Asana integration not configured. Go to Settings > Integrations to add your Asana token.',
          };
        }
        const task = await fetchAsanaTask(toolInput.task_id_or_url as string, asanaCfg.token);
        return {
          success: true,
          result: {
            title: task.name || '(Untitled)',
            description: task.notes || '',
            url: task.permalink_url || null,
            gid: task.gid,
          },
        };
      }

      case 'fetch_github_context': {
        const integrations = ctx.store.getConfig().integrations;
        const ghToken = integrations?.github?.token;
        const context = await fetchGitHubContext(toolInput.url as string, ghToken);
        return { success: true, result: context };
      }

      case 'fetch_sentry_issue': {
        const integrations = ctx.store.getConfig().integrations;
        const sentryCfg = integrations?.sentry;
        if (!sentryCfg?.enabled || !sentryCfg.token || !sentryCfg.org) {
          return {
            success: false,
            error: 'Sentry integration not configured. Go to Settings > Integrations to add your Sentry token and org.',
          };
        }
        const issue = await fetchSentryIssue(toolInput.issue_id as string, sentryCfg.token, sentryCfg.org);
        return { success: true, result: issue };
      }

      case 'fetch_slack_message': {
        const integrations = ctx.store.getConfig().integrations;
        const slackCfg = integrations?.slack;
        if (!slackCfg?.enabled || !slackCfg.token) {
          return {
            success: false,
            error: 'Slack integration not configured. Go to Settings > Integrations to add your Slack bot token.',
          };
        }
        const msg = await fetchSlackMessage(toolInput.url as string, slackCfg.token);
        return { success: true, result: msg };
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/* ── Route registration ─────────────────────────────────────────────── */

export function registerCommandPanelRoutes(app: FastifyInstance, ctx: CommandPanelCtx): void {
  // ── GET /api/command/status ──────────────────────────────────────
  app.get('/api/command/status', async () => {
    try {
      // Check if SDK is importable and API key exists
      await import('@anthropic-ai/sdk' as string);
      const hasKey = !!process.env.ANTHROPIC_API_KEY;
      return { available: hasKey };
    } catch {
      return { available: false };
    }
  });

  // ── POST /api/command ────────────────────────────────────────────
  app.post('/api/command', async (req, reply) => {
    pruneExpired();

    const body = req.body as { message?: string; conversationId?: string; images?: Array<{ dataUrl: string }> };
    const message = body?.message?.trim();
    if (!message) {
      reply.code(400);
      return { error: 'message is required' };
    }

    // Get or create conversation
    let conversationId = body.conversationId;
    let conversation = conversationId ? conversations.get(conversationId) : undefined;
    // Try loading from disk if not in memory
    if (!conversation && conversationId) {
      const loaded = loadConversation(conversationId);
      if (loaded) {
        conversation = loaded;
        conversations.set(conversationId, conversation);
      }
    }
    const isNew = !conversation;
    if (!conversation) {
      conversationId = crypto.randomUUID();
      const now = new Date().toISOString();
      conversation = {
        id: conversationId,
        title: '',
        messages: [],
        lastActivity: Date.now(),
        createdAt: now,
        updatedAt: now,
      };
      conversations.set(conversationId, conversation);
    }
    conversation.lastActivity = Date.now();
    conversation.updatedAt = new Date().toISOString();

    // Build user message content — multimodal if images are attached
    const images = body.images || [];
    let userContent: string | Array<Record<string, unknown>>;
    if (images.length > 0) {
      const contentBlocks: Array<Record<string, unknown>> = [];
      for (const img of images) {
        // dataUrl format: "data:image/png;base64,iVBOR..."
        const match = img.dataUrl?.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          contentBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          });
        }
      }
      contentBlocks.push({ type: 'text', text: message });
      userContent = contentBlocks;
    } else {
      userContent = message;
    }

    // Add user message
    conversation.messages.push({ role: 'user', content: userContent });

    // Auto-generate title from first user message
    if (isNew || !conversation.title) {
      conversation.title = generateTitle(userContent);
    }

    // Trim if too long
    if (conversation.messages.length > MAX_MESSAGES) {
      conversation.messages = conversation.messages.slice(-MAX_MESSAGES);
    }

    try {
      // Dynamic import — SDK is optional, not in package.json
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Anthropic = ((await import('@anthropic-ai/sdk' as string)) as any).default;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const client = new Anthropic() as {
        messages: {
          create: (opts: Record<string, unknown>) => Promise<{
            content: Array<{
              type: string;
              text?: string;
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
            stop_reason: string;
          }>;
        };
      };

      // Call Claude with tools
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: conversation.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      const actions: ActionResult[] = [];
      let textResponse = '';
      let needsConfirmation: { confirmId: string; action: string; description: string } | undefined;

      // Extract text and collect tool_use blocks
      const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          textResponse += block.text;
        } else if (block.type === 'tool_use' && block.name && block.input && block.id) {
          toolUseBlocks.push({ id: block.id, name: block.name, input: block.input });
        }
      }

      if (toolUseBlocks.length > 0) {
        // Check for destructive tools first
        const destructiveBlock = toolUseBlocks.find((b) => DESTRUCTIVE_TOOLS.has(b.name));
        if (destructiveBlock) {
          const confirmId = crypto.randomUUID();
          const description = `${destructiveBlock.name}(${JSON.stringify(destructiveBlock.input)})`;
          pendingConfirmations.set(confirmId, {
            confirmId,
            conversationId: conversationId!,
            toolName: destructiveBlock.name,
            toolInput: destructiveBlock.input,
            description,
            createdAt: Date.now(),
          });
          needsConfirmation = { confirmId, action: destructiveBlock.name, description };

          // Add assistant response + placeholder tool_results for ALL tool_uses
          conversation.messages.push({
            role: 'assistant',
            content: response.content as unknown as Array<Record<string, unknown>>,
          });
          conversation.messages.push({
            role: 'user',
            content: toolUseBlocks.map((b) => ({
              type: 'tool_result' as const,
              tool_use_id: b.id,
              content: DESTRUCTIVE_TOOLS.has(b.name)
                ? 'Awaiting user confirmation for this destructive action.'
                : 'Skipped — waiting for confirmation on destructive action in same response.',
            })),
          });
        } else {
          // Execute ALL tool calls, collect results
          const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
          for (const block of toolUseBlocks) {
            const result = await executeTool(block.name, block.input, ctx);
            actions.push({ tool: block.name, ...result });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }

          // Push assistant response (with all tool_uses) + user response (with all tool_results)
          conversation.messages.push({
            role: 'assistant',
            content: response.content as unknown as Array<Record<string, unknown>>,
          });
          conversation.messages.push({
            role: 'user',
            content: toolResults,
          });

          // Follow-up call to get text summary of the tool results
          const followUp = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            tools: TOOLS,
            messages: conversation.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          });

          for (const fb of followUp.content) {
            if (fb.type === 'text' && fb.text) {
              textResponse += fb.text;
            }
          }

          conversation.messages.push({
            role: 'assistant',
            content: followUp.content as unknown as Array<Record<string, unknown>>,
          });
        }
      } else {
        // No tools — save plain text response
        conversation.messages.push({
          role: 'assistant',
          content: response.content as unknown as Array<Record<string, unknown>>,
        });
      }

      // Persist conversation to disk
      saveConversation(conversation!);

      return {
        response:
          textResponse ||
          (needsConfirmation
            ? `I need to **${needsConfirmation.action}** — this requires your confirmation.`
            : 'I processed your request.'),
        actions: actions.length > 0 ? actions : undefined,
        conversationId,
        needsConfirmation,
      };
    } catch (err) {
      // SDK not installed or API error
      const errMsg = String(err);
      if (errMsg.includes('Cannot find package') || errMsg.includes('MODULE_NOT_FOUND')) {
        reply.code(503);
        return { error: 'Anthropic SDK not available' };
      }

      // Bug 5: detect tool_use/tool_result mismatch — clear conversation and retry
      if (errMsg.includes('tool_use') && (errMsg.includes('tool_result') || errMsg.includes('400'))) {
        // Clear the corrupted conversation, keep only the latest user message
        const lastUserMsg = conversation!.messages.filter((m) => m.role === 'user').pop();
        conversation!.messages = lastUserMsg ? [lastUserMsg] : [];
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Anthropic2 = ((await import('@anthropic-ai/sdk' as string)) as any).default;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          const client2 = new Anthropic2() as {
            messages: {
              create: (opts: Record<string, unknown>) => Promise<{
                content: Array<{
                  type: string;
                  text?: string;
                  id?: string;
                  name?: string;
                  input?: Record<string, unknown>;
                }>;
                stop_reason: string;
              }>;
            };
          };
          const retryResponse = await client2.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            tools: TOOLS,
            messages: conversation!.messages.map((m) => ({ role: m.role, content: m.content })),
          });
          let retryText = '';
          for (const block of retryResponse.content) {
            if (block.type === 'text' && block.text) retryText += block.text;
          }
          conversation!.messages.push({
            role: 'assistant',
            content: retryResponse.content as unknown as Array<Record<string, unknown>>,
          });
          saveConversation(conversation!);
          return {
            response: retryText || 'I processed your request.',
            conversationId,
            conversationCleared: true,
          };
        } catch (retryErr) {
          reply.code(500);
          return { error: `Command failed after recovery: ${String(retryErr)}`, conversationCleared: true };
        }
      }

      reply.code(500);
      return { error: `Command failed: ${errMsg}` };
    }
  });

  // ── POST /api/command/confirm ────────────────────────────────────
  app.post('/api/command/confirm', async (req, reply) => {
    const body = req.body as { confirmId?: string; conversationId?: string };
    if (!body?.confirmId) {
      reply.code(400);
      return { error: 'confirmId is required' };
    }

    const pending = pendingConfirmations.get(body.confirmId);
    if (!pending) {
      reply.code(404);
      return { error: 'Confirmation expired or not found' };
    }

    pendingConfirmations.delete(body.confirmId);

    // Execute the confirmed action
    const result = await executeTool(pending.toolName, pending.toolInput, ctx);

    // Update conversation with the result
    let conversation = conversations.get(pending.conversationId);
    if (!conversation) {
      conversation = loadConversation(pending.conversationId) || undefined;
      if (conversation) conversations.set(pending.conversationId, conversation);
    }
    if (conversation) {
      // The last message should be the tool_result placeholder — update it
      const lastMsg = conversation.messages[conversation.messages.length - 1];
      if (lastMsg && Array.isArray(lastMsg.content)) {
        const content = lastMsg.content as Array<Record<string, unknown>>;
        if (content[0]?.type === 'tool_result') {
          content[0].content = JSON.stringify(result);
        }
      }
      conversation.updatedAt = new Date().toISOString();
      saveConversation(conversation);
    }

    return {
      response: result.success ? `Done. ${JSON.stringify(result.result)}` : `Failed: ${result.error}`,
      action: { tool: pending.toolName, ...result },
      conversationId: pending.conversationId,
    };
  });

  // ── GET /api/command/conversations ────────────────────────────────
  app.get('/api/command/conversations', async () => {
    return { conversations: listConversations() };
  });

  // ── GET /api/command/conversations/:id ────────────────────────────
  app.get('/api/command/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) {
      reply.code(400);
      return { error: 'Invalid conversation ID' };
    }
    const conv = loadConversation(id);
    if (!conv) {
      reply.code(404);
      return { error: 'Conversation not found' };
    }
    return conv;
  });

  // ── DELETE /api/command/conversations/:id ──────────────────────────
  app.delete('/api/command/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) {
      reply.code(400);
      return { error: 'Invalid conversation ID' };
    }
    conversations.delete(id);
    const deleted = deleteConversationFile(id);
    if (!deleted) {
      reply.code(404);
      return { error: 'Conversation not found' };
    }
    return { ok: true };
  });

  // ── PATCH /api/command/conversations/:id ──────────────────────────
  app.patch('/api/command/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { title?: string };
    if (!isValidId(id)) {
      reply.code(400);
      return { error: 'Invalid conversation ID' };
    }
    if (!body?.title || typeof body.title !== 'string') {
      reply.code(400);
      return { error: 'title is required' };
    }
    const conv = loadConversation(id);
    if (!conv) {
      reply.code(404);
      return { error: 'Conversation not found' };
    }
    conv.title = body.title.trim().slice(0, 100);
    conv.updatedAt = new Date().toISOString();
    saveConversation(conv);
    // Update in-memory cache if present
    const cached = conversations.get(id);
    if (cached) {
      cached.title = conv.title;
      cached.updatedAt = conv.updatedAt;
    }
    return { id: conv.id, title: conv.title, updatedAt: conv.updatedAt, messageCount: conv.messages.length };
  });
}

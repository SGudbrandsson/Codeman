/**
 * @fileoverview Synchronous inter-agent message store backed by better-sqlite3.
 *
 * All operations are synchronous (better-sqlite3 style).
 * The messages table lives in the same work-items.db opened by work-items/db.ts.
 */

import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { getDb } from '../work-items/db.js';
import { query as vaultQuery } from '../vault/index.js';
import type { AgentMessage, AgentMessageContext, AgentMessageRow, AgentMessageType } from './types.js';

// ─── Row → Domain ─────────────────────────────────────────────────────────────

function rowToMessage(row: AgentMessageRow): AgentMessage {
  return {
    id: row.id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    workItemId: row.work_item_id,
    type: row.type as AgentMessageType,
    subject: row.subject,
    body: row.body,
    context: row.context ? (JSON.parse(row.context) as AgentMessageContext) : null,
    sentAt: row.sent_at,
    readAt: row.read_at,
  };
}

// ─── ID generation ────────────────────────────────────────────────────────────

function makeMessageId(): string {
  return 'msg-' + randomUUID().replace(/-/g, '').slice(0, 12);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Send a message from one agent to another.
 * Returns the persisted AgentMessage.
 */
export function sendMessage(params: {
  fromAgentId: string;
  toAgentId: string;
  type: AgentMessageType;
  subject: string;
  body: string;
  workItemId?: string;
  context?: AgentMessageContext;
}): AgentMessage {
  const db = getDb();
  const id = makeMessageId();
  const sentAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO messages (id, from_agent_id, to_agent_id, work_item_id, type, subject, body, context, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.fromAgentId,
    params.toAgentId,
    params.workItemId ?? null,
    params.type,
    params.subject,
    params.body,
    params.context ? JSON.stringify(params.context) : null,
    sentAt
  );

  return getMessage(id)!;
}

/**
 * Get a single message by ID. Returns undefined if not found.
 */
export function getMessage(id: string): AgentMessage | undefined {
  const row = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as AgentMessageRow | undefined;
  return row ? rowToMessage(row) : undefined;
}

/**
 * Get inbox for an agent (messages addressed to them).
 * Ordered: unread first (by sent_at DESC), then read (by sent_at DESC).
 */
export function getInbox(
  agentId: string,
  opts?: { unreadOnly?: boolean; limit?: number; offset?: number }
): { messages: AgentMessage[]; unreadCount: number } {
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  let sql = 'SELECT * FROM messages WHERE to_agent_id = ?';
  if (opts?.unreadOnly) {
    sql += ' AND read_at IS NULL';
  }
  sql += ' ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END ASC, sent_at DESC';
  sql += ` LIMIT ${limit} OFFSET ${offset}`;

  const rows = db.prepare(sql).all(agentId) as AgentMessageRow[];

  const countRow = db
    .prepare('SELECT COUNT(*) as cnt FROM messages WHERE to_agent_id = ? AND read_at IS NULL')
    .get(agentId) as { cnt: number };

  return {
    messages: rows.map(rowToMessage),
    unreadCount: countRow.cnt,
  };
}

/**
 * Mark a message as read. Returns the updated message, or undefined if not found.
 */
export function markRead(id: string): AgentMessage | undefined {
  const db = getDb();
  const readAt = new Date().toISOString();

  // Only update if not already marked read — preserves original readAt on re-call
  db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL').run(readAt, id);
  return getMessage(id);
}

/**
 * Broadcast a message to a list of agents (one row per agent).
 *
 * The caller (route handler) provides the list of recipient agent IDs.
 * The fromAgentId is excluded from recipients automatically.
 */
export function broadcastMessage(params: {
  fromAgentId: string;
  recipientAgentIds: string[];
  subject: string;
  body: string;
  workItemId?: string;
  type?: AgentMessageType;
  context?: AgentMessageContext;
}): AgentMessage[] {
  const type = params.type ?? 'broadcast';
  const results: AgentMessage[] = [];

  for (const agentId of params.recipientAgentIds) {
    if (agentId === params.fromAgentId) continue;
    const msg = sendMessage({
      fromAgentId: params.fromAgentId,
      toAgentId: agentId,
      type,
      subject: params.subject,
      body: params.body,
      workItemId: params.workItemId,
      context: params.context,
    });
    results.push(msg);
  }

  return results;
}

/**
 * Build a lightweight handoff context for a message.
 *
 * - Queries the sender's vault (top-3 results) using the subject as query text.
 * - Tries to get the current git HEAD hash from the worktree path.
 * - Returns an AgentMessageContext object (not persisted — caller passes this to sendMessage).
 */
export async function buildHandoffContext(
  agentId: string,
  vaultPath: string,
  workItemId: string | undefined,
  subject: string,
  worktreePath?: string
): Promise<AgentMessageContext> {
  // Query vault
  let vaultSnippets: AgentMessageContext['vaultSnippets'] = [];
  try {
    const results = await vaultQuery(agentId, vaultPath, subject, 3);
    vaultSnippets = results.map((r) => ({
      sourceFile: r.sourceFile,
      snippet: r.snippet,
      timestamp: r.timestamp,
    }));
  } catch {
    // Vault may be empty or not yet initialized — silently skip
  }

  // Get git hash
  let gitHash: string | undefined;
  if (worktreePath) {
    try {
      gitHash = execSync('git rev-parse HEAD', {
        cwd: worktreePath,
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
    } catch {
      // Not a git repo or git unavailable — skip
    }
  }

  return {
    workItemId,
    vaultSnippets,
    gitHash,
    extra: {},
  };
}

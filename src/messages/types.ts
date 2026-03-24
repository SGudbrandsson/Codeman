/**
 * @fileoverview Inter-agent messaging type definitions.
 *
 * These types map directly to the SQLite `messages` table in work-items.db.
 * snake_case columns are mapped to camelCase TypeScript fields.
 */

export type AgentMessageType = 'handoff' | 'status_query' | 'status_response' | 'broadcast' | 'briefing' | 'escalation';

/**
 * Optional context attached to a message (e.g. for handoff messages).
 * Stored as JSON in the `context` column.
 */
export interface AgentMessageContext {
  workItemId?: string;
  /** Top-3 vault snippets from sender's vault (BM25 results) */
  vaultSnippets?: Array<{ sourceFile: string; snippet: string; timestamp: string }>;
  /** Git commit hash at time of handoff */
  gitHash?: string;
  /** Arbitrary extra context */
  extra?: Record<string, unknown>;
}

/** Camel-case domain object returned from store functions. */
export interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string | null; // null for broadcasts
  workItemId: string | null;
  type: AgentMessageType;
  subject: string;
  body: string;
  context: AgentMessageContext | null;
  sentAt: string; // ISO-8601
  readAt: string | null; // ISO-8601, null = unread
}

/** Raw SQLite row (snake_case). Used internally by store.ts. */
export interface AgentMessageRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  work_item_id: string | null;
  type: string;
  subject: string;
  body: string;
  context: string | null; // JSON
  sent_at: string;
  read_at: string | null;
}

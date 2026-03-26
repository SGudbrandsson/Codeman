/**
 * @fileoverview Work item type definitions.
 *
 * These types map directly to the SQLite schema in db.ts.
 * snake_case columns are mapped to camelCase TypeScript fields.
 */

export type WorkItemStatus = 'queued' | 'blocked' | 'assigned' | 'in_progress' | 'review' | 'done' | 'cancelled';

export type WorkItemSource = 'manual' | 'asana' | 'github' | 'clockwork' | 'sentry' | 'slack';

export interface WorkItem {
  id: string; // wi-<8-char-hash>
  title: string;
  description: string;
  status: WorkItemStatus;
  source: WorkItemSource;
  assignedAgentId: string | null;
  createdAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  worktreePath: string | null;
  branchName: string | null;
  taskMdPath: string | null;
  externalRef: string | null;
  externalUrl: string | null;
  metadata: Record<string, unknown>;
  compactSummary: string | null;
  caseId: string | null;
}

export interface WorkItemDependency {
  fromId: string; // blocking item
  toId: string; // blocked item
  type: 'blocks';
  createdAt: string;
}

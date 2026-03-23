# Agent Orchestration v2 — Design Specification

**Date:** 2026-03-23
**Status:** Draft
**Author:** Codeman autonomous design agent
**Branch:** feat/agent-orchestration-v2

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Models](#3-data-models)
4. [API Endpoints](#4-api-endpoints)
5. [UI Wireframes](#5-ui-wireframes)
6. [Migration Path](#6-migration-path)
7. [Phase Breakdown](#7-phase-breakdown)
8. [Reference Citations](#8-reference-citations)

---

## 1. Overview and Goals

Codeman v1 is a session manager: it wraps Claude Code PTY processes, provides a web UI, and orchestrates worktrees for autonomous feature work via the skill pipeline. It does this well, but it treats each session as an ephemeral container. There is no persistent identity, no memory that survives session compaction, no structured work item tracking, and no inter-agent coordination beyond what Claude Code's native Teams API provides.

Codeman v2 evolves the platform into a **multi-agent orchestration layer** sitting between human operators / Clockwork OS (strategic intelligence) and Claude Code sessions (execution). The core additions are:

- **Agent identity** — sessions gain stable UUIDs that survive restarts and compaction
- **Per-agent memory vaults** — automatic capture and retrieval of accumulated knowledge
- **Work item graph** — a dependency-aware queue replacing ad-hoc TASK.md tracking
- **Inter-agent messaging** — structured handoffs, briefings, escalations
- **Board view UI** — kanban visibility into cross-agent work in flight
- **Clockwork OS integration** — clean interface for external strategic orchestration

The design is strictly **backward compatible**: existing sessions continue to work without any changes. Agent features are additive and opt-in via a new `agentProfile` field on `SessionState`.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLOCKWORK OS (Strategic Layer)                  │
│  • Receives work from Asana / GitHub / email / Slack                    │
│  • Decides priorities, creates work items, sends briefings              │
│  • Monitors progress via webhook callbacks                              │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ REST  /api/clockwork/*
                               │ (separate auth token)
┌──────────────────────────────▼──────────────────────────────────────────┐
│                        CODEMAN API (Execution Layer)                    │
│                                                                         │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────────────┐  │
│  │  Session Manager │  │  Work Item Store  │  │   Message Bus (SSE)   │  │
│  │  (extended)      │  │  (SQLite)         │  │   + inbox (SQLite)    │  │
│  │                  │  │                   │  │                       │  │
│  │  createSession() │  │  list()           │  │  send(msg)            │  │
│  │  createAgent()   │  │  create()         │  │  inbox(agentId)       │  │
│  │  getAgent()      │  │  claim(agentId)   │  │  broadcast()          │  │
│  │  setAgent()      │  │  ready()          │  │  SSE push on active   │  │
│  └────────┬─────────┘  └────────┬──────────┘  └───────────┬───────────┘  │
│           │                     │                          │              │
│  ┌────────▼─────────────────────▼──────────────────────────▼───────────┐  │
│  │                     Agent Sessions (PTY)                             │  │
│  │                                                                      │  │
│  │  SessionState { agentProfile?, parentAgentId?, childAgentIds? }      │  │
│  │                                                                      │  │
│  │  Agent roles:                                                        │  │
│  │   keeps-engineer   codeman-dev   deployment-agent                   │  │
│  │   orchestrator     analyst                                           │  │
│  │                                                                      │  │
│  │  Each agent session ↔ Vault (notes/, patterns/, index/)             │  │
│  │  Each agent session ↔ Work Item (via workItemId on claim)           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────┬─────────────────────────────────┘
                                        │ SSE events + REST
┌───────────────────────────────────────▼─────────────────────────────────┐
│                        BROWSER (Frontend)                               │
│                                                                         │
│  ┌──────────────────┐  ┌────────────────────────────────────────────┐   │
│  │  Agent Sidebar   │  │  Board View (/board)                       │   │
│  │                  │  │                                            │   │
│  │  Sessions view   │  │  Kanban: Queued│Working│Review│Done        │   │
│  │  Agents view     │  │  Timeline feed (cross-agent SSE events)    │   │
│  │  Inbox tab       │  │  Work item detail panel (slide-in)         │   │
│  └──────────────────┘  └────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data flow: work item lifecycle

```
Clockwork OS / UI
      │
      │ POST /api/work-items  (or /api/clockwork/work-items)
      ▼
 WorkItem created (status=queued)
      │
      │ POST /api/work-items/:id/claim  { agentId }
      ▼
 WorkItem (status=assigned)
 → agent session created with worktree
 → TASK.md written to worktree
 → SessionState.currentWorkItemId = wi-xxxx
      │
      │ agent starts working (status=in_progress)
      ▼
 Hooks fire per-turn → /api/agents/:agentId/vault/capture
      │
      │ work complete → agent sends handoff message
      ▼
 WorkItem (status=review)
      │
      │ review agent claims, reviews
      ▼
 WorkItem (status=done)
 → memory consolidation triggered
 → vault patterns updated
 → Clockwork webhook callback fired
```

---

## 3. Data Models

All TypeScript interfaces below. These extend the existing codebase types found in `src/types/session.ts` and `src/state-store.ts`.

### 3.1 Agent Profile and Roles

```typescript
// Agent roles define the agent's purpose, default capabilities, and vault location.
// Roles are a closed set — new roles require a codebase change (intentional: keeps
// the set manageable and skill prompts specific).
type AgentRole =
  | 'keeps-engineer'     // feature/fix work in worktrees; primary workhorse
  | 'codeman-dev'        // Codeman self-improvement; works on the Codeman repo
  | 'deployment-agent'   // builds, copies dist, restarts services
  | 'orchestrator'       // receives Clockwork briefings, delegates to other agents
  | 'analyst';           // research and design specs only; never touches code

interface AgentCapability {
  // Name of an MCP server or skill available to this agent
  name: string;
  // 'mcp' | 'skill' — determines how it is invoked
  type: 'mcp' | 'skill';
  // For MCP: the McpServerEntry name. For skill: the skill file path or identifier.
  ref: string;
  // Whether this capability is currently enabled for the agent
  enabled: boolean;
}

interface AgentProfile {
  // Stable UUID — does NOT change when the session is cleared or a new session
  // is created for the same agent. This is the persistent identity.
  agentId: string;

  role: AgentRole;

  // Human-readable display name shown in the sidebar and board view
  displayName: string;

  // Path to this agent's vault directory: ~/.codeman/vaults/<agentId>/
  vaultPath: string;

  // Capabilities (MCPs + skills) assigned to this agent
  capabilities: AgentCapability[];

  // Role-specific system prompt injected into the agent's session on start.
  // This is the "core memory" in the Letta sense — always in context.
  rolePrompt?: string;

  // ISO timestamp of last vault consolidation run
  lastConsolidatedAt?: string;

  // Note count since last consolidation (triggers consolidation when > threshold)
  notesSinceConsolidation: number;

  // Memory decay configuration
  decay: {
    notesTtlDays: number;      // default: 90
    patternsTtlDays: number;   // default: 365
  };

  // ISO timestamp when this agent profile was created
  createdAt: string;

  // ISO timestamp of last activity (any hook event)
  lastActiveAt?: string;
}
```

### 3.2 Extended SessionState

The existing `SessionState` type (in `src/types/session.ts`) gains two new optional fields. All other fields remain unchanged.

```typescript
// Partial extension — full SessionState definition remains in src/types/session.ts.
// Only the new fields are shown here.
interface SessionStateAgentExtension {
  // When present, this session is an agent session. Plain sessions leave this
  // undefined. This is the backward-compatibility guarantee: undefined = plain session.
  agentProfile?: AgentProfile;

  // Work item currently assigned to this session (null if none).
  // Set by claim(); cleared when work item reaches 'done' or 'cancelled'.
  currentWorkItemId?: string | null;
}
// Full type: SessionState & SessionStateAgentExtension
```

### 3.3 Work Items

```typescript
type WorkItemStatus =
  | 'queued'      // created, unassigned, all blocking deps resolved
  | 'blocked'     // has unresolved blocking dependencies
  | 'assigned'    // claimed by an agent; worktree being set up
  | 'in_progress' // agent actively working
  | 'review'      // work done, awaiting review
  | 'done'        // completed successfully
  | 'cancelled';  // abandoned

type WorkItemSource =
  | 'manual'      // created via UI or direct API call
  | 'asana'       // ingested from Asana by Clockwork OS
  | 'github'      // ingested from GitHub issue by Clockwork OS
  | 'clockwork';  // pushed directly by Clockwork OS

interface WorkItem {
  // wi-<8-char-hash> — hash of (title + source + createdAtMs).
  // Hash-based IDs prevent collisions in multi-agent concurrent creation.
  // See: beads project ID scheme (cited in §8).
  id: string;

  title: string;
  description: string;

  status: WorkItemStatus;
  source: WorkItemSource;

  // Agent currently assigned (null if unassigned)
  assignedAgentId: string | null;

  // ISO timestamps
  createdAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;

  // Worktree info (set when status transitions to 'assigned')
  worktreePath: string | null;
  branchName: string | null;

  // Path to TASK.md inside the worktree (set on claim)
  taskMdPath: string | null;

  // External reference (Asana task ID, GitHub issue number, etc.)
  externalRef: string | null;
  externalUrl: string | null;

  // Free-form metadata from external source
  metadata: Record<string, unknown>;

  // Compact summary written during memory decay (replaces description/metadata
  // after 30 days in 'done' state to save storage)
  compactSummary: string | null;
}

interface WorkItemDependency {
  // The work item that is blocking
  fromId: string;
  // The work item that is blocked
  toId: string;
  // Currently only 'blocks' — future may add 'informs', 'duplicates'
  type: 'blocks';
  createdAt: string;
}
```

### 3.4 SQLite Schema for Work Items

```sql
-- ~/.codeman/work-items.db

CREATE TABLE work_items (
  id              TEXT PRIMARY KEY,           -- wi-<8-char-hash>
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'queued',
  source          TEXT NOT NULL DEFAULT 'manual',
  assigned_agent_id TEXT,
  created_at      TEXT NOT NULL,
  assigned_at     TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  worktree_path   TEXT,
  branch_name     TEXT,
  task_md_path    TEXT,
  external_ref    TEXT,
  external_url    TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}', -- JSON
  compact_summary TEXT
);

CREATE TABLE dependencies (
  from_id    TEXT NOT NULL REFERENCES work_items(id),
  to_id      TEXT NOT NULL REFERENCES work_items(id),
  type       TEXT NOT NULL DEFAULT 'blocks',
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, type)
);

-- Messages are also stored in SQLite for persistence.
-- (See §3.6 for the full AgentMessage interface.)
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  from_agent_id  TEXT NOT NULL,
  to_agent_id    TEXT,                       -- NULL = broadcast
  work_item_id   TEXT REFERENCES work_items(id),
  type           TEXT NOT NULL,
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  context        TEXT,                       -- JSON: VaultQueryResult[], gitHash, workItemId
  sent_at        TEXT NOT NULL,
  read_at        TEXT
);

-- Index for ready() query: queued items with no unresolved blocking deps
CREATE INDEX idx_wi_status ON work_items(status);
CREATE INDEX idx_deps_to_id ON dependencies(to_id);
```

### 3.5 Vault Types

```typescript
interface VaultNote {
  // Filename: <timestamp>-<sessionId>.md  (e.g. 2026-03-23T14:05:22Z-abc123.md)
  filename: string;
  // ISO timestamp of capture
  capturedAt: string;
  // Session that captured this note
  sessionId: string;
  // Work item in progress at time of capture (may be null)
  workItemId: string | null;
  // Raw markdown content written by the hook handler
  content: string;
  // BM25 term index built on first query (lazy)
  // Stored in index/ directory, keyed by filename hash
  indexed: boolean;
}

interface VaultPattern {
  // Filename: <date>-cluster-<N>.md  (e.g. 2026-03-23-cluster-3.md)
  filename: string;
  // ISO timestamp of consolidation run that produced this pattern
  consolidatedAt: string;
  // IDs (filenames) of source notes that were clustered into this pattern
  sourceNotes: string[];
  // LLM-synthesized markdown content
  content: string;
  // Cluster label derived from dominant BM25 terms
  clusterLabel: string;
}

interface VaultQueryResult {
  // 'note' or 'pattern' — where the snippet came from
  sourceType: 'note' | 'pattern';
  // Filename of source document
  sourceFile: string;
  // Extracted snippet (typically 200-400 chars surrounding best match)
  snippet: string;
  // BM25 relevance score (higher = more relevant)
  score: number;
  // Work item context at time of capture (for notes)
  workItemId: string | null;
  // ISO timestamp of the source document
  timestamp: string;
}
```

### 3.6 Inter-Agent Messages

```typescript
type AgentMessageType =
  | 'handoff'          // "I finished X; you should do Y" — transfers work item ownership
  | 'status_query'     // "What is the status of work item Z?"
  | 'status_response'  // Response to a status_query
  | 'broadcast'        // From orchestrator to all agents simultaneously
  | 'briefing'         // Work item assignment brief from orchestrator/Clockwork
  | 'escalation';      // Agent signals a blocker it cannot resolve alone

interface AgentMessageContext {
  // Work item the message relates to
  workItemId: string | null;
  // Top-3 vault query results pre-fetched by sender (avoids recipient doing a
  // cold vault query on receipt). See agent-flywheel §context-transfer.
  vaultSnippets: VaultQueryResult[];
  // Git commit hash at time of handoff (for reproducibility)
  gitHash: string | null;
  // Any additional key-value context the sender includes
  extra: Record<string, unknown>;
}

interface AgentMessage {
  // Unique message ID (UUID)
  id: string;
  // Sender agent ID (or 'system' for Clockwork OS messages)
  fromAgentId: string;
  // Recipient agent ID (null for broadcast messages)
  toAgentId: string | null;
  // Related work item (optional)
  workItemId: string | null;
  type: AgentMessageType;
  subject: string;
  body: string;
  // Structured context for handoffs and briefings
  context: AgentMessageContext | null;
  // ISO timestamp
  sentAt: string;
  // ISO timestamp set when recipient reads the message; null = unread
  readAt: string | null;
}
```

---

## 4. API Endpoints

All endpoints are under the existing Codeman HTTP server (default port 3001). New routes follow the same Fastify route pattern used throughout `src/web/routes/`.

### 4.1 Agent CRUD

```
GET    /api/agents
       → AgentProfile[]   (all registered agents)

GET    /api/agents/:agentId
       → AgentProfile     (404 if not found)

POST   /api/agents
       Body: { role: AgentRole, displayName: string, rolePrompt?: string,
               capabilities?: AgentCapability[], decay?: { notesTtlDays, patternsTtlDays } }
       → AgentProfile     (creates agent profile; no session created yet)

PATCH  /api/agents/:agentId
       Body: Partial<AgentProfile> (update displayName, rolePrompt, capabilities, decay)
       → AgentProfile

DELETE /api/agents/:agentId
       → 204              (soft-delete: archives agent; vault data preserved)

POST   /api/agents/:agentId/sessions
       Body: SessionConfig (same as POST /api/sessions, minus agentProfile fields)
       → SessionState     (creates a new session bound to this agent;
                           injects agentProfile + rolePrompt into session config)
```

### 4.2 Vault

```
POST   /api/agents/:agentId/vault/capture
       Body: { sessionId: string, workItemId?: string, content: string }
       → { filename: string, noteCount: number }
       Notes:
         - Called by hook handler (hook:stop fires end of each Claude turn)
         - Writes notes/<timestamp>-<sessionId>.md
         - Increments notesSinceConsolidation on AgentProfile

POST   /api/agents/:agentId/vault/consolidate
       Body: {} (no body required; uses all notes since lastConsolidatedAt)
       → { patternsWritten: number, notesProcessed: number }
       Notes:
         - Only runs if notesSinceConsolidation > 10 (configurable threshold)
         - Phase 1: BM25-based clustering (k-means on TF-IDF vectors, k=ceil(n/5))
         - Phase 2 (later): HDBSCAN on embeddings
         - LLM synthesis call per cluster → patterns/<date>-cluster-<N>.md
         - Resets notesSinceConsolidation to 0

GET    /api/agents/:agentId/vault/query?q=<text>&limit=5
       → VaultQueryResult[]
       Notes:
         - BM25 search across notes/ + patterns/
         - limit defaults to 5 (max 20)
         - <500ms SLA; no LLM cost
         - Used by: session start briefing, handoff context pre-fetch

GET    /api/agents/:agentId/vault/notes?limit=20&offset=0
       → { notes: VaultNote[], total: number }
       (list raw notes, newest first)

GET    /api/agents/:agentId/vault/patterns
       → VaultPattern[]
       (list all pattern files)

DELETE /api/agents/:agentId/vault/notes/:filename
       → 204  (manual note deletion; also triggered by decay job)
```

### 4.3 Work Items

```
GET    /api/work-items?status=<status>&agentId=<id>&limit=50&offset=0
       → { items: WorkItem[], total: number }
       (filter by status and/or assigned agent)

GET    /api/work-items/ready
       → WorkItem[]
       Notes:
         - Returns items in 'queued' status with no unresolved blocking dependencies
         - SQL: SELECT wi.* FROM work_items wi
                WHERE wi.status = 'queued'
                  AND NOT EXISTS (
                    SELECT 1 FROM dependencies d
                    JOIN work_items blocker ON d.from_id = blocker.id
                    WHERE d.to_id = wi.id AND blocker.status NOT IN ('done','cancelled')
                  )

GET    /api/work-items/:id
       → WorkItem         (includes dependencies array)

POST   /api/work-items
       Body: { title: string, description: string, source?: WorkItemSource,
               externalRef?: string, externalUrl?: string,
               metadata?: Record<string,unknown>, dependsOn?: string[] }
       → WorkItem         (status=queued; computes id = wi-<hash(title+source+createdAt)>)

PATCH  /api/work-items/:id
       Body: Partial<WorkItem> (update title, description, metadata)
       → WorkItem

POST   /api/work-items/:id/claim
       Body: { agentId: string }
       → WorkItem | { error: 'already_claimed' | 'not_queued' }
       Notes:
         - Atomic: UPDATE work_items SET status='assigned', assigned_agent_id=?,
                   assigned_at=? WHERE id=? AND status='queued'
         - On success: triggers worktree creation + TASK.md write
         - On fail: returns 409 with error code

POST   /api/work-items/:id/status
       Body: { status: WorkItemStatus, note?: string }
       → WorkItem
       Notes:
         - Manual status transition (UI use)
         - Valid transitions: queued→blocked, assigned→in_progress,
           in_progress→review, review→done, any→cancelled
         - Fires workItem:statusChanged SSE event + Clockwork webhook if registered

POST   /api/work-items/:id/dependencies
       Body: { blockedBy: string[] }   (array of work item IDs that block this one)
       → WorkItemDependency[]

DELETE /api/work-items/:id/dependencies/:fromId
       → 204

DELETE /api/work-items/:id
       → 204   (cancels item; sets status=cancelled)
```

### 4.4 Messaging

```
POST   /api/agents/:agentId/messages
       Body: AgentMessage (fromAgentId inferred from :agentId or auth)
       → AgentMessage
       Notes:
         - Stores in SQLite messages table
         - If toAgentId's session is currently active: push via SSE agent:message event
         - Otherwise: stored for pull retrieval

GET    /api/agents/:agentId/inbox?unreadOnly=true&limit=20&offset=0
       → { messages: AgentMessage[], unreadCount: number }

POST   /api/agents/:agentId/inbox/:messageId/read
       → AgentMessage  (sets readAt = now)

POST   /api/agents/broadcast
       Body: { fromAgentId: string, subject: string, body: string,
               workItemId?: string, type: 'broadcast' }
       → { sent: number }   (count of active sessions that received the SSE push)
       Notes:
         - Stores one message record per agent in messages table
         - SSE push to all currently active agent sessions
```

### 4.5 Board Summary

```
GET    /api/board/summary
       → {
           queued:     number,
           assigned:   number,
           in_progress: number,
           review:     number,
           done:       number,
           cancelled:  number,
           agents: {
             [agentId: string]: {
               displayName: string,
               role: AgentRole,
               currentWorkItemId: string | null,
               status: SessionStatus
             }
           },
           recentEvents: BoardEvent[]   // last 20 cross-agent SSE events
         }

GET    /api/board/timeline?limit=50&offset=0
       → BoardEvent[]
       Notes:
         - Reverse-chronological feed of workItem:* and agent:message SSE events
         - Persisted in a board_events table (append-only, max 500 rows with TTL 7 days)
```

### 4.6 Clockwork OS Integration

All `/api/clockwork/*` endpoints require a separate `Authorization: Bearer <clockwork-token>` header. The token is stored in `~/.codeman/config.json` under `clockworkToken`.

```
POST   /api/clockwork/work-items
       Body: { title, description, source: 'clockwork'|'asana'|'github',
               externalRef?, externalUrl?, metadata?, dependsOn? }
       → WorkItem
       (same as POST /api/work-items but source is set by Clockwork)

GET    /api/clockwork/status
       → (same shape as GET /api/board/summary)

POST   /api/clockwork/broadcast
       Body: { subject: string, body: string, workItemId?: string }
       → { sent: number }
       (same as POST /api/agents/broadcast with fromAgentId='system')

POST   /api/clockwork/agents/:agentId/briefing
       Body: { workItemId: string, body: string, context?: AgentMessageContext }
       → AgentMessage
       (creates a 'briefing' type message to the agent; SSE push if active)

POST   /api/clockwork/webhook/register
       Body: { callbackUrl: string, events: string[] }
       → { registered: boolean }
       (registers a URL to receive workItem:statusChanged webhook POSTs)
```

### 4.7 SSE Event Categories (new)

The following new event type categories are added to `src/web/sse-events.ts`, following the existing pattern:

```typescript
// Agent lifecycle
'agent:created'          // AgentProfile
'agent:updated'          // AgentProfile
'agent:deleted'          // { agentId: string }

// Work items
'workItem:created'       // WorkItem
'workItem:statusChanged' // { workItem: WorkItem, previousStatus: WorkItemStatus }
'workItem:claimed'       // { workItem: WorkItem, agentId: string }
'workItem:completed'     // WorkItem

// Messaging
'agent:message'          // AgentMessage  (SSE push to recipient's active session)
'agent:broadcast'        // AgentMessage  (SSE push to all active sessions)

// Vault
'vault:captureComplete'  // { agentId, filename, noteCount }
'vault:consolidateComplete' // { agentId, patternsWritten, notesProcessed }
```

---

## 5. UI Wireframes

### 5.1 Agent Sidebar (desktop)

The sidebar currently lists sessions. When one or more `AgentProfile`s exist, a toggle appears at the top to switch between "Sessions" view and "Agents" view. Both views are always accessible; the toggle is purely cosmetic grouping.

```
┌─────────────────────────────┐
│ ≡ Codeman          [Board]  │
├─────────────────────────────┤
│ [Sessions] [Agents]         │  ← toggle; "Agents" selected
├─────────────────────────────┤
│                             │
│  KEEPS-ENGINEER             │  ← role group heading
│  ┌───────────────────────┐  │
│  │ ● feat/auth-redesign  │  │  ← green dot = active/busy
│  │   wi-4f2a8b1c  · 2h   │  │  ← work item ID + elapsed
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │ ○ feat/search-sessions│  │  ← grey dot = idle
│  │   wi-9d3e7a2f  · done │  │
│  └───────────────────────┘  │
│                             │
│  CODEMAN-DEV                │
│  ┌───────────────────────┐  │
│  │ ● self-improve-v0.7   │  │
│  │   wi-1b5c4d9e  · 45m  │  │
│  └───────────────────────┘  │
│                             │
│  DEPLOYMENT-AGENT           │
│  ┌───────────────────────┐  │
│  │ ○ deploy-agent        │  │
│  │   idle                │  │
│  └───────────────────────┘  │
│                             │
│  PLAIN SESSIONS             │  ← sessions without agentProfile
│  ┌───────────────────────┐  │
│  │ ○ manual-shell-1      │  │
│  └───────────────────────┘  │
│                             │
│  [+ New Agent]              │
├─────────────────────────────┤
│  [Settings]  [Logout]       │
└─────────────────────────────┘
```

When an agent session row is selected, the sidebar entry expands to show an **Inbox badge**:

```
│  ┌───────────────────────┐  │
│  │ ● feat/auth-redesign  │  │
│  │   wi-4f2a8b1c  · 2h   │  │
│  │  [Terminal] [Inbox 2] │  │  ← inbox tab with unread count
│  └───────────────────────┘  │
```

### 5.2 Board View — Kanban

Accessible via the `[Board]` button in the sidebar header, or navigating to `/board`.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Codeman Board                          [Refresh] [+ New Work Item]      │
├──────────────┬───────────────┬──────────────┬────────────────────────────┤
│   QUEUED (3) │  WORKING (2)  │  REVIEW (1)  │       DONE (12)            │
├──────────────┼───────────────┼──────────────┼────────────────────────────┤
│ ┌──────────┐ │ ┌───────────┐ │ ┌──────────┐ │ ┌────────────────────────┐ │
│ │wi-9a1b2c │ │ │wi-4f2a8b │ │ │wi-3d7c9e │ │ │wi-aa1234  done 2d ago  │ │
│ │Auth redes│ │ │Search sess│ │ │MCP plugin│ │ │Activity indicators v2  │ │
│ │          │ │ │           │ │ │          │ │ └────────────────────────┘ │
│ │source:   │ │ │● keeps-eng│ │ │● keeps-eng│ │                           │
│ │clockwork │ │ │  2h 14m   │ │ │  review  │ │ ┌────────────────────────┐ │
│ └──────────┘ │ └───────────┘ │ └──────────┘ │ │wi-bb5678  done 3d ago  │ │
│              │               │              │ │Search sessions feature │ │
│ ┌──────────┐ │ ┌───────────┐ │              │ └────────────────────────┘ │
│ │wi-2e4f6a │ │ │wi-1b5c4d │ │              │                            │
│ │Safe mode │ │ │Codeman v2 │ │              │      (10 more...)          │
│ │          │ │ │spec       │ │              │                            │
│ │source:   │ │ │● codeman- │ │              │                            │
│ │manual    │ │ │  dev 45m  │ │              │                            │
│ └──────────┘ │ └───────────┘ │              │                            │
│              │               │              │                            │
│ ┌──────────┐ │               │              │                            │
│ │wi-7g9h0i │ │               │              │                            │
│ │Mobile    │ │               │              │                            │
│ │swipe v2  │ │               │              │                            │
│ │BLOCKED   │ │               │              │                            │
│ │by wi-9a1b│ │               │              │                            │
│ └──────────┘ │               │              │                            │
├──────────────┴───────────────┴──────────────┴────────────────────────────┤
│  TIMELINE FEED                                                           │
│  ─────────────────────────────────────────────────────────────────────  │
│  14:23  keeps-engineer → keeps-engineer  HANDOFF wi-4f2a8b              │
│         "Search sessions complete; needs QA review"                     │
│  13:45  system → all  BROADCAST  "Deploy window opens at 15:00"         │
│  13:12  deployment-agent  workItem:completed  wi-aa1234                 │
│  12:58  codeman-dev  workItem:statusChanged  wi-1b5c4d  queued→in_prog  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Work Item Detail Panel

Clicking any card opens a slide-in panel from the right (same UX as existing session detail panels).

```
┌──────────────────────────────────────────────────────────┐
│  wi-4f2a8b1c                                    [×]      │
│  Search sessions feature                                  │
│  status: IN PROGRESS  ·  branch: feat/search-sessions    │
│  assigned: keeps-engineer  ·  elapsed: 2h 14m            │
├──────────────────────────────────────────────────────────┤
│  DESCRIPTION                                             │
│  Implement full-text search across session transcripts   │
│  with BM25 ranking. Accessible via /search route.        │
│  Source: clockwork  ·  External: ASANA-4521              │
├──────────────────────────────────────────────────────────┤
│  AGENT ACTIVITY (last 5 events)                          │
│  14:22  session:idle  (turn complete, 1420 tokens)       │
│  14:18  session:working  (new turn started)              │
│  14:03  vault:captureComplete  (note #23 written)        │
│  13:55  session:idle                                     │
│  13:50  session:working                                  │
├──────────────────────────────────────────────────────────┤
│  VAULT MEMORY (top 3 relevant snippets)                  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ [note] 2026-03-22  score: 0.87                     │  │
│  │ "BM25 search index built with bm25-node. Search    │  │
│  │  queries go to GET /api/search?q=. Results come    │  │
│  │  back in <300ms for 50k token transcripts..."      │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ [pattern] 2026-03-20  score: 0.74                  │  │
│  │ "Pattern: search feature integrations always need  │  │
│  │  debounce on the input (300ms), a loading state    │  │
│  │  spinner, and empty-state copy..."                 │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  MESSAGE THREAD                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 14:23  HANDOFF from keeps-engineer                 │  │
│  │ "Search sessions complete. BM25 index is live.     │  │
│  │  Needs QA: edge case with empty sessions, and      │  │
│  │  mobile layout. Branch: feat/search-sessions."     │  │
│  └────────────────────────────────────────────────────┘  │
│  [Reply] [Mark done] [Cancel item]                       │
├──────────────────────────────────────────────────────────┤
│  GIT LOG (feat/search-sessions)                          │
│  ● abc1234  feat: BM25 index endpoint  (2h ago)          │
│  ● def5678  feat: search UI skeleton   (3h ago)          │
│  ● ghi9012  chore: scaffold branch     (4h ago)          │
└──────────────────────────────────────────────────────────┘
```

### 5.4 Inbox Tab

Shown when an agent session is selected and the user clicks `[Inbox N]` in the sidebar.

```
┌────────────────────────────────────────────────────────┐
│  Inbox — keeps-engineer                    [Mark all]  │
│  2 unread                                              │
├────────────────────────────────────────────────────────┤
│  ● UNREAD  14:23  FROM: codeman-dev  BRIEFING          │
│    "New work item: Implement vault consolidation..."   │
│    wi-2e4f6a  [Open] [Mark read]                       │
├────────────────────────────────────────────────────────┤
│  ● UNREAD  13:45  FROM: system  BROADCAST              │
│    "Deploy window opens at 15:00"                      │
│    [Mark read]                                         │
├────────────────────────────────────────────────────────┤
│    READ   12:30  FROM: orchestrator  HANDOFF           │
│    "Auth redesign is unblocked; wi-9a1b2c is ready"    │
│    wi-9a1b2c  [Open]                                   │
├────────────────────────────────────────────────────────┤
│    READ   09:15  FROM: deployment-agent  STATUS_RESP   │
│    "v0.6.4 deployed successfully to port 3001"         │
│    [Open]                                              │
└────────────────────────────────────────────────────────┘
```

---

## 6. Migration Path

### 6.1 Backward Compatibility Guarantee

**No existing session is broken by this migration.** The design is strictly additive:

- `SessionState.agentProfile` is `optional` — undefined means "plain session"
- The sidebar defaults to "Sessions" view if no agent profiles exist
- All existing API endpoints (`/api/sessions/*`) remain unchanged
- State store continues to read/write `state.json` exactly as before; new SQLite file is separate
- Existing TASK.md worktree workflow continues to work without modification

### 6.2 Opt-in Agent Conversion

An existing session can be converted to an agent session in two ways:

**Option A — UI conversion**: In the session settings panel, a new "Convert to Agent" button appears. Clicking it opens a dialog prompting for role and display name. On confirm, the backend:
1. Generates a new `agentId` (UUID)
2. Creates a `VaultPath` at `~/.codeman/vaults/<agentId>/`
3. Sets `sessionState.agentProfile` with the chosen role
4. Persists to `state.json`

**Option B — API conversion**:
```
PATCH /api/sessions/:sessionId
Body: { agentProfile: { role: 'keeps-engineer', displayName: 'Feature Agent 1' } }
```
The server fills in `agentId`, `vaultPath`, `createdAt`, etc. and returns the updated `SessionState`.

### 6.3 Existing TASK.md Worktrees → Work Items

For in-flight worktrees that already have a TASK.md, a migration script (run once) will:

1. Scan all `SessionState` entries with `worktreePath` set
2. For each: read the TASK.md `title` and `description` fields
3. Create a `WorkItem` record in SQLite with `source='manual'` and `status='in_progress'`
4. Set `SessionState.currentWorkItemId` to the new work item ID
5. Write the work item ID into the TASK.md file under a `## Work Item` section

This is a one-time migration, not a continuous sync. After migration, TASK.md remains the agent's internal state carrier (unchanged), and the work item is the external-facing record.

### 6.4 Identity Persistence Across Session Restarts

The existing Codeman codebase already has `parentAgentId`/`childAgentIds` fields on `SessionState`. The v2 identity model layers on top:

- `AgentProfile.agentId` is stable and stored in `AppState.agents` (keyed by agentId)
- When a session is archived/cleared and a new session created for the same agent (via `POST /api/agents/:agentId/sessions`), the new session gets the same `agentId` in its `agentProfile`
- The vault at `~/.codeman/vaults/<agentId>/` is untouched across restarts — memory persists
- The new session's `currentWorkItemId` can be restored by the orchestrator by sending a `briefing` message on startup

---

## 7. Phase Breakdown

### Phase 1: Agent Profiles + Vault Capture/Retrieval

**Goal**: Give agents persistent identity and memory. No new UI beyond sidebar toggle.

**Deliverables**:
- `AgentProfile` type added to `src/types/session.ts` (as `SessionStateAgentExtension`)
- `AppState.agents: Record<string, AgentProfile>` added to `src/state-store.ts`
- `StateStore.getAgent()`, `setAgent()`, `listAgents()` methods
- `src/vault.ts` — new module: `captureNote()`, `queryVault()` (BM25 only, no consolidation)
- BM25 indexing: use `flexsearch` (already in many node projects) or `natural` npm package; index built lazily per agent on first query; cached in `~/.codeman/vaults/<agentId>/index/`
- `src/web/routes/agent-routes.ts` — agent CRUD endpoints (§4.1) + vault capture/query (§4.2, skip consolidate)
- Hook handler in `src/hooks-config.ts`: when `stop` hook fires on an agent session, POST to `/api/agents/:agentId/vault/capture` with turn summary extracted from hook payload
- Session start briefing: in `SessionManager.startInteractive()`, if session has `agentProfile`, call `GET /api/agents/:agentId/vault/query?q=<currentWorkItemTitle>` and prepend result to `CLAUDE.md` preamble or inject as first user message
- Sidebar toggle: "Sessions" / "Agents" — Agents view groups by role (frontend `app.js`)
- SSE events: `agent:created`, `agent:updated`, `vault:captureComplete`
- Tests: vault capture/query unit tests; agent CRUD integration tests

**Does NOT include**: consolidation, work items, messaging, board view

### Phase 2: Work Item Graph + Board View (read-only) + Claim/Assign

**Goal**: Replace ad-hoc TASK.md tracking with a structured dependency-aware queue. Give operators visibility via board view.

**Deliverables**:
- SQLite setup: `~/.codeman/work-items.db` with schema from §3.4; use `better-sqlite3` (sync, no async complexity)
- `src/work-item-store.ts` — new module: `list()`, `create()`, `get()`, `ready()`, `claim()`, `updateStatus()`, `addDependency()`
- `id` generation: `'wi-' + crypto.createHash('sha256').update(title+source+createdAt).digest('hex').slice(0,8)`
- `src/web/routes/work-item-routes.ts` — all work item endpoints (§4.3)
- `claim()` worktree integration: on successful claim, call existing `SessionManager.createWorktree()` and write TASK.md (same as current `codeman-feature` skill, but driven by the work item)
- `SessionState.currentWorkItemId` set on claim; cleared on done/cancelled
- Memory decay background job: `src/work-item-decay.ts` — runs daily via `setInterval`; compacts `done` items > 30 days; deletes `cancelled` items > 7 days
- `src/web/routes/board-routes.ts` — `GET /api/board/summary`, `GET /api/board/timeline`
- `BoardView` frontend class in `app.js` — kanban render, basic SSE listener for `workItem:*` events
- Board accessible at `/board` route (new static HTML or SPA route)
- SSE events: full `workItem:*` set (§4.7)
- Tests: claim() atomicity test (concurrent claims), ready() dependency resolution test

**Does NOT include**: messaging, inbox, Clockwork OS, consolidation

### Phase 3: Inter-Agent Messaging + Handoff + Inbox UI + Timeline Feed

**Goal**: Agents can communicate. Handoffs include vault context. Operators see cross-agent activity.

**Deliverables**:
- `messages` table added to `work-items.db` (schema §3.4)
- `src/message-store.ts` — `send()`, `inbox()`, `markRead()`, `broadcast()`
- `src/web/routes/message-routes.ts` — messaging endpoints (§4.4)
- Handoff message builder: `buildHandoffContext(agentId, workItemId)` — pre-fetches top-3 vault snippets, gets current git hash, constructs `AgentMessageContext`
- SSE push on send: check if recipient's session is active; if so, emit `agent:message` SSE event
- Inbox tab UI: sidebar expansion to show `[Inbox N]` badge and inbox panel (§5.4)
- Board timeline feed: fetch `GET /api/board/timeline` on board load; SSE listener appends new events in real time
- Work item detail panel: slide-in panel from board view card click (§5.3); includes message thread, vault snippets, git log
- `vault:consolidate` endpoint now enabled (§4.2): triggered by session `stop` hook when `notesSinceConsolidation > 10`; Phase 1 consolidation = BM25 k-means clustering (not HDBSCAN — that comes Phase 4)
- SSE events: `agent:message`, `agent:broadcast`, `vault:consolidateComplete`
- Tests: message send + SSE delivery test; inbox pull test; handoff context builder test

### Phase 4: Clockwork OS Integration + External Ingestion + HDBSCAN Consolidation

**Goal**: External strategic orchestration. Production-quality memory consolidation.

**Deliverables**:
- `src/web/routes/clockwork-routes.ts` — all `/api/clockwork/*` endpoints (§4.6)
- Clockwork auth middleware: separate `clockworkToken` in `~/.codeman/config.json`; checked on all `/api/clockwork/*` routes
- Webhook registration + delivery: `src/clockwork-webhook.ts` — stores callback URL; fires `workItem:statusChanged` POST to callback on each status transition
- Asana ingestion: Clockwork pushes normalized work items via `POST /api/clockwork/work-items`; Codeman does NOT directly poll Asana (Clockwork handles it)
- GitHub issue ingestion: same pattern — Clockwork normalizes and pushes
- HDBSCAN consolidation: replace Phase 3's BM25 k-means with HDBSCAN on sentence embeddings (via local `@xenova/transformers` or remote embedding API). Produces higher-quality clusters for agents with large vaults (>100 notes). BM25 clustering retained as fallback when embedding service unavailable.
- Vault query Phase 2: conditional vector search — if BM25 top score < 0.4 threshold, run vector similarity search on pattern embeddings (stored in `index/vectors.bin`). This matches the memento-vault adaptive retrieval strategy (BM25 → vector → cross-encoder) but skips PageRank and cross-encoder for MVP simplicity.
- Dolt consideration: evaluate replacing SQLite with Dolt for multi-machine distributed scenarios. Decision deferred until there is a concrete need for distributed agents.
- Tests: Clockwork auth middleware test; webhook delivery test; HDBSCAN clustering unit test

---

## 8. Reference Citations

This design deliberately borrows from, adapts, and in some cases explicitly departs from the following prior work. Each citation notes what is borrowed and what is changed.

### memento-vault (github.com/sandsower/memento-vault)

**Borrowed**: The three-phase memory architecture (Capture → Consolidate → Retrieve) is taken directly from memento-vault. The automatic hook-based capture, markdown file storage, and the goal of zero-LLM-cost retrieval all originate here.

**Adapted**: memento-vault's retrieval pipeline is BM25 → vector search → PageRank → cross-encoder (adaptive, only escalates when BM25 confidence is low). We implement this progressively: Phase 1 = BM25 only; Phase 4 adds vector search. PageRank and cross-encoder are deferred until vault sizes justify the complexity. Storage is per-agent directories rather than per-repo, since agents work across repos.

**Departed**: HDBSCAN consolidation is deferred to Phase 4. Phase 1–3 uses BM25 k-means clustering for consolidation, which is simpler to implement without embedding infrastructure.

### beads (github.com/steveyegge/beads)

**Borrowed**: Hash-based work item IDs (`wi-<8-char-hash>` vs beads' `bd-<hash>`), dependency graph semantics, `ready()`/`claim()` API surface, and memory decay (compaction of old closed items) are all taken from beads.

**Adapted**: beads uses Dolt (git for databases) as its storage backend for distributed multi-machine scenarios. We use SQLite for MVP simplicity — no git-for-DB complexity until there is a concrete distributed use case. The ID hash inputs differ: we hash (title + source + createdAtMs) rather than beads' content hash, to allow pre-creation ID computation.

**Departed**: beads is a CLI tool; we expose the same semantics via REST API and SSE events for web UI integration.

### agent-flywheel (agent-flywheel.com)

**Borrowed**: Structured message types (handoff, status_query, status_response, broadcast, briefing, escalation), the inbox model (messages persist and can be pulled when agent is offline), and the concept of pre-fetching vault context before sending a handoff message (avoiding cold-start context reconstruction by the recipient).

**Adapted**: agent-flywheel uses an NTM (Neural Turing Machine) inspired orchestration model. We use a simpler static-role model (AgentRole enum) with Clockwork OS as the external strategic layer. Delivery is via SSE push (not polling) when the recipient session is active.

**Departed**: No NTM. No "24/7 autonomous operation" mode in Phase 1–3; agents are still human-initiated sessions. Fully autonomous scheduling is a Phase 4+ concern.

### Letta / MemGPT

**Borrowed**: The core memory vs. archival memory distinction is fundamental to our vault design. Core memory (always in context) = agent role prompt + current work item description. Archival memory (searchable, never fully loaded) = vault notes + patterns. This prevents context bloat as vaults grow.

**Departed**: We do not implement MemGPT's virtual context management or the recursive self-editing memory. The vault is append-only with consolidation; the agent does not directly edit its own memory files.

### CrewAI

**Borrowed**: The concept of agent roles with defined goals, a fixed set of role types, and role-specific tool assignments (capabilities in our model) maps directly to CrewAI's agent definition pattern. The keeps-engineer / codeman-dev / deployment-agent / orchestrator / analyst role taxonomy is inspired by CrewAI's worker/manager/researcher pattern.

**Departed**: CrewAI's crew orchestration is code-defined. Our orchestration is dynamic — work items are claimed at runtime, and the orchestrator role is implemented by a Claude Code session (not hard-coded Python logic).

### LangGraph

**Borrowed**: The idea of explicit state checkpointing to enable resumability across interruptions. Our TASK.md file is the checkpoint — it carries phase/status state across context compactions, allowing the codeman-task-runner skill to resume exactly where it left off. The work item status field serves the same role at the graph level.

**Departed**: LangGraph uses Python and Pydantic with an explicit graph definition. We achieve equivalent resumability with markdown files + a simple status enum, which is simpler to implement and readable by Claude Code agents without additional tooling.

### always-on-memory-agent (Google Research)

**Referenced but explicitly avoided**: The always-on-memory-agent performs sleep-time consolidation across the full memory corpus on every consolidation run. For large vaults this becomes expensive (full-corpus scan). We explicitly avoid this pattern by using selective consolidation: only notes added since `lastConsolidatedAt` are processed, and only when `notesSinceConsolidation > 10`. The memento-vault adaptive retrieval strategy (start with BM25, only escalate to vector search when needed) is the correct counter-pattern here.

---

## Appendix A: File System Layout

```
~/.codeman/
├── state.json                  # existing: sessions, tasks, config, globalStats
├── state-inner.json            # existing: Ralph loop state per session
├── config.json                 # existing + new: clockworkToken field added
├── work-items.db               # NEW (Phase 2): SQLite work item graph
└── vaults/
    ├── <agentId-1>/
    │   ├── notes/
    │   │   ├── 2026-03-23T14:05:22Z-abc123.md
    │   │   └── ...
    │   ├── patterns/
    │   │   ├── 2026-03-23-cluster-0.md
    │   │   └── ...
    │   ├── archive/            # notes older than decay TTL
    │   │   └── ...
    │   └── index/
    │       ├── bm25.json       # BM25 term index (lazy-built)
    │       └── vectors.bin     # embedding vectors (Phase 4)
    └── <agentId-2>/
        └── ...
```

## Appendix B: Hook Handler Changes

The existing hook handler in `src/hooks-config.ts` processes `POST /api/hook-event` payloads. The following additions are needed:

**On `stop` hook** (fires when Claude Code finishes a turn):
1. Look up `SessionState` for the session that fired the hook
2. If `sessionState.agentProfile` is defined:
   a. Extract a summary from the hook payload (or use the last N lines of PTY output as fallback)
   b. POST to `POST /api/agents/:agentId/vault/capture` with `{ sessionId, workItemId: sessionState.currentWorkItemId, content: summary }`
   c. If `notesSinceConsolidation > 10`: queue a consolidation job (async, non-blocking)

**On session interactive start** (`SessionManager.startInteractive()`):
1. If `sessionState.agentProfile` is defined and `sessionState.currentWorkItemId` is set:
   a. Fetch work item title via `workItemStore.get(currentWorkItemId)`
   b. Call `GET /api/agents/:agentId/vault/query?q=<workItemTitle>&limit=3`
   c. Format the top results as a markdown briefing block
   d. Prepend to the worktree's `CLAUDE.md` under a `## Memory Briefing` section (overwrite this section only, not the full file)

## Appendix C: Frontend Implementation Notes

The frontend is a single `app.js` monolith (`src/web/public/app.js`). The following additions follow the existing view pattern:

**New class: `BoardView`**
- Registered as a top-level view alongside `SessionView`
- Activated by navigating to `#/board` or clicking `[Board]` button
- `render()` calls `GET /api/board/summary` and renders the kanban grid
- `bindSSE()` listens for `workItem:*` and `agent:message` events to update cards without full re-render
- `openDetailPanel(workItemId)` fetches `GET /api/work-items/:id` + `GET /api/board/timeline` for the item and renders the slide-in panel

**Modified: `Sidebar` class**
- Adds toggle element if `agents.length > 0`
- `renderAgentGroups()` groups sessions by `agentProfile.role`; falls back to `renderSessionList()` if no agents
- Inbox badge rendered when agent session is selected and `unreadCount > 0`

**New class: `InboxPanel`**
- Rendered inside the sidebar when inbox tab is active
- Calls `GET /api/agents/:agentId/inbox?unreadOnly=false&limit=20`
- SSE listener for `agent:message` events increments unread badge in real time

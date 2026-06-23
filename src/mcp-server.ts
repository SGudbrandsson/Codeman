#!/usr/bin/env node
/**
 * Codeman MCP Server — lightweight stdio JSON-RPC server.
 *
 * Tools:
 *   list_sessions        — list active sessions (id, name, branch, status)
 *   send_message         — send a message to another session
 *   list_projects        — list main (non-worktree) sessions / repos
 *   get_session_digest   — status digest for one session
 *   start_feature        — spin up a new feature worktree autonomously
 *   start_fix            — spin up a new fix worktree autonomously
 *
 * Zero dependencies beyond Node built-ins. Speaks MCP (JSON-RPC 2.0 over stdio).
 *
 * Usage:
 *   node dist/mcp-server.js                    # default: http://localhost:3001
 *   CODEMAN_URL=http://host:9999 node dist/mcp-server.js
 */

const BASE = process.env.CODEMAN_URL ?? 'http://localhost:3001';

// ── Auth helper ──────────────────────────────────────────────────────────────

export function buildAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const password = env.CODEMAN_PASSWORD;
  if (password) {
    const user = env.CODEMAN_USERNAME || 'admin';
    headers.Authorization = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  }
  return headers;
}

const AUTH = buildAuthHeaders();

// ── JSON-RPC helpers ─────────────────────────────────────────────────────────

function jsonrpc(id: string | number | null, result: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id: string | number | null, code: number, message: string) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_sessions',
    description: 'List Codeman sessions. Returns id, name, branch, status, and workingDir for each.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status (idle, busy, stopped). Omit for all.',
        },
      },
    },
  },
  {
    name: 'send_message',
    description:
      "Send a text message to another Codeman session. The target session's Claude agent will receive it as user input.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Session ID, name, or branch name to send to.',
        },
        message: {
          type: 'string',
          description: 'The message text to send.',
        },
      },
      required: ['target', 'message'],
    },
  },
  {
    name: 'list_projects',
    description:
      'List repos you can start work in. Returns each main (non-worktree) session: id, name, project (workingDir basename), status, workingDir.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_session_digest',
    description:
      "Digest of one session: status (working/idle/stopped), done (true only when truly finished), toolExecuting, lastAssistantMessage, active subagents, phase. Poll this to answer 'is it done?'.",
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Session id.' } },
      required: ['id'],
    },
  },
  {
    name: 'start_feature',
    description:
      'Spin up a new feature worktree in a project and start it working autonomously. Returns the new session id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project name (workingDir basename), e.g. "Codeman".' },
        title: { type: 'string', description: 'One-line feature title.' },
        description: { type: 'string', description: 'What it should do.' },
        acceptance: { type: 'string', description: 'Optional acceptance criteria.' },
        parentSessionId: {
          type: 'string',
          description: 'Optional: pick the exact parent session if a project has several.',
        },
      },
      required: ['project', 'title', 'description'],
    },
  },
  {
    name: 'start_fix',
    description:
      'Spin up a new fix worktree in a project and start it working autonomously. Returns the new session id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project name (workingDir basename).' },
        title: { type: 'string', description: 'One-line bug title.' },
        description: { type: 'string', description: 'What is broken / how to reproduce.' },
        parentSessionId: { type: 'string', description: 'Optional explicit parent session id.' },
      },
      required: ['project', 'title', 'description'],
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────────────

interface Session {
  id: string;
  name: string;
  status: string;
  worktreeBranch?: string;
  workingDir?: string;
}

async function listSessions(args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE}/api/sessions`, { headers: AUTH });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const sessions = (await res.json()) as Session[];
  let filtered = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    branch: s.worktreeBranch ?? null,
    status: s.status,
    workingDir: s.workingDir,
  }));
  if (args.status) {
    filtered = filtered.filter((s) => s.status === args.status);
  }
  return filtered;
}

async function resolveSessionId(target: string): Promise<string> {
  const res = await fetch(`${BASE}/api/sessions`, { headers: AUTH });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const sessions = (await res.json()) as Session[];

  // Exact ID match
  const byId = sessions.find((s) => s.id === target);
  if (byId) return byId.id;

  // Exact name or branch match
  const byName = sessions.find((s) => s.name === target || s.worktreeBranch === target);
  if (byName) return byName.id;

  // Substring match (name or branch contains target)
  const bySubstring = sessions.filter(
    (s) =>
      s.name?.toLowerCase().includes(target.toLowerCase()) ||
      s.worktreeBranch?.toLowerCase().includes(target.toLowerCase())
  );
  if (bySubstring.length === 1) return bySubstring[0].id;
  if (bySubstring.length > 1) {
    const names = bySubstring.map((s) => s.name || s.id).join(', ');
    throw new Error(`Ambiguous target "${target}" — matches: ${names}`);
  }

  throw new Error(`No session found matching "${target}"`);
}

async function sendMessage(args: Record<string, unknown>): Promise<unknown> {
  const target = args.target as string;
  const message = args.message as string;
  if (!target || !message) throw new Error('target and message are required');

  const sessionId = await resolveSessionId(target);
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/input`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ input: message, submit: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to send: ${res.status} ${body}`);
  }
  return { success: true, sessionId, message };
}

async function listProjects(): Promise<unknown> {
  const res = await fetch(`${BASE}/api/sessions`, { headers: AUTH });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const sessions = (await res.json()) as Session[];
  return sessions
    .filter((s) => !s.worktreeBranch)
    .map((s) => ({
      id: s.id,
      name: s.name,
      project: (s.workingDir ?? '').replace(/\/+$/, '').split('/').pop() ?? '',
      status: s.status,
      workingDir: s.workingDir,
    }));
}

async function getSessionDigest(args: Record<string, unknown>): Promise<unknown> {
  const id = args.id as string;
  if (!id) throw new Error('id is required');
  const res = await fetch(`${BASE}/api/sessions/${id}/digest`, { headers: AUTH });
  if (!res.ok) throw new Error(`No digest for "${id}": ${res.status}`);
  return await res.json();
}

async function startWork(path: 'feature' | 'fix', args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as { success?: boolean }).success === false) {
    throw new Error(`start_${path} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

// ── Request dispatcher ───────────────────────────────────────────────────────

async function handleRequest(req: { id: string | number | null; method: string; params?: unknown }): Promise<string> {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return jsonrpc(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'codeman', version: '1.0.0' },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return ''; // no response for notifications

    case 'tools/list':
      return jsonrpc(id, { tools: TOOLS });

    case 'tools/call': {
      const p = params as { name: string; arguments?: Record<string, unknown> };
      const args = p.arguments ?? {};
      try {
        let result: unknown;
        switch (p.name) {
          case 'list_sessions':
            result = await listSessions(args);
            break;
          case 'send_message':
            result = await sendMessage(args);
            break;
          case 'list_projects':
            result = await listProjects();
            break;
          case 'get_session_digest':
            result = await getSessionDigest(args);
            break;
          case 'start_feature':
            result = await startWork('feature', args);
            break;
          case 'start_fix':
            result = await startWork('fix', args);
            break;
          default:
            return jsonrpcError(id, -32601, `Unknown tool: ${p.name}`);
        }
        return jsonrpc(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        return jsonrpc(id, {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        });
      }
    }

    default:
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Stdio transport ──────────────────────────────────────────────────────────

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', async (chunk: string) => {
  buffer += chunk;
  // Process all complete messages (newline-delimited JSON)
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const req = JSON.parse(line);
      const response = await handleRequest(req);
      if (response) {
        process.stdout.write(response + '\n');
      }
    } catch {
      process.stdout.write(jsonrpcError(null, -32700, 'Parse error') + '\n');
    }
  }
});

process.stdin.on('end', () => process.exit(0));

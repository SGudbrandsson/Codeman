#!/usr/bin/env node
/**
 * Codeman MCP Server — lightweight stdio JSON-RPC server.
 *
 * Tools:
 *   list_sessions  — list active sessions (id, name, branch, status)
 *   send_message   — send a message to another session
 *
 * Zero dependencies beyond Node built-ins. Speaks MCP (JSON-RPC 2.0 over stdio).
 *
 * Usage:
 *   node dist/mcp-server.js                    # default: http://localhost:3001
 *   CODEMAN_URL=http://host:9999 node dist/mcp-server.js
 */

const BASE = process.env.CODEMAN_URL ?? 'http://localhost:3001';

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
  const res = await fetch(`${BASE}/api/sessions`);
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
  const res = await fetch(`${BASE}/api/sessions`);
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: message + '\r', useMux: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to send: ${res.status} ${body}`);
  }
  return { success: true, sessionId, message };
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

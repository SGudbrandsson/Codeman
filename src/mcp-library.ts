/**
 * @fileoverview Curated MCP server library.
 * Static list served at GET /api/mcp/library.
 * To add a server: append an entry to MCP_LIBRARY and commit.
 */

export interface McpLibraryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  envVars?: { key: string; description: string; required: boolean; sensitive: boolean }[];
}

export const MCP_LIBRARY: McpLibraryEntry[] = [
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation — navigate, click, screenshot, test web UIs',
    category: 'Dev Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read/write GitHub repos, issues, PRs, and code search',
    category: 'Dev Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['@github/mcp-github'],
    envVars: [{ key: 'GITHUB_TOKEN', description: 'Personal access token', required: true, sensitive: true }],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Interact with GitLab projects, merge requests, and pipelines',
    category: 'Dev Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['@gitlab/mcp-gitlab'],
    envVars: [
      { key: 'GITLAB_TOKEN', description: 'GitLab personal access token', required: true, sensitive: true },
      {
        key: 'GITLAB_URL',
        description: 'GitLab instance URL (default: gitlab.com)',
        required: false,
        sensitive: false,
      },
    ],
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Query and manage Supabase databases and storage',
    category: 'Data & Infra',
    transport: 'stdio',
    command: 'npx',
    args: ['@supabase/mcp-server-supabase@latest'],
    envVars: [
      { key: 'SUPABASE_URL', description: 'Project URL', required: true, sensitive: false },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', description: 'Service role key', required: true, sensitive: true },
    ],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Run SQL queries against a PostgreSQL database',
    category: 'Data & Infra',
    transport: 'stdio',
    command: 'npx',
    args: ['@modelcontextprotocol/server-postgres'],
    envVars: [{ key: 'DATABASE_URL', description: 'postgres://user:pass@host/db', required: true, sensitive: true }],
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Create and update Linear issues, projects, and cycles',
    category: 'Project Management',
    transport: 'stdio',
    command: 'npx',
    args: ['@linear/mcp-server'],
    envVars: [{ key: 'LINEAR_API_KEY', description: 'Linear API key', required: true, sensitive: true }],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Query Sentry errors, events, and performance data',
    category: 'Project Management',
    transport: 'stdio',
    command: 'npx',
    args: ['@sentry/mcp-server@latest'],
    envVars: [
      { key: 'SENTRY_AUTH_TOKEN', description: 'Sentry auth token', required: true, sensitive: true },
      { key: 'SENTRY_ORG', description: 'Sentry organization slug', required: true, sensitive: false },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read channels, send messages, search Slack workspace',
    category: 'Communication',
    transport: 'stdio',
    command: 'npx',
    args: ['@modelcontextprotocol/server-slack'],
    envVars: [
      {
        key: 'SLACK_BOT_TOKEN',
        description: 'Bot User OAuth Token (xoxb-...)',
        required: true,
        sensitive: true,
      },
      { key: 'SLACK_TEAM_ID', description: 'Workspace team ID', required: true, sensitive: false },
    ],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files in specified directories',
    category: 'Dev Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['@modelcontextprotocol/server-filesystem', '/allowed/path'],
  },
  {
    id: 'blank-stdio',
    name: 'Custom (stdio)',
    description: 'Blank template — configure your own stdio MCP server',
    category: 'Custom',
    transport: 'stdio',
    command: 'npx',
    args: [],
  },
  {
    id: 'blank-http',
    name: 'Custom (HTTP)',
    description: 'Blank template — configure your own HTTP/SSE MCP server',
    category: 'Custom',
    transport: 'http',
    url: '',
  },
];

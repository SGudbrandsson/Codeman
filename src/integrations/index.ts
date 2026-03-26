/**
 * @fileoverview External integration API clients.
 *
 * Pure fetch functions for Asana, GitHub, Sentry, and Slack.
 * Each returns a normalized context object or throws on error.
 * All use native fetch() with 5s timeouts to avoid blocking.
 *
 * GitHub uses gh CLI (primary) with REST API fallback.
 * gh CLI args are constructed from regex-validated owner/repo/number — not raw user input.
 *
 * @module integrations
 */

import { execFileSync } from 'node:child_process';
import type { AsanaTask, GitHubIssue } from '../clockwork-ingestion.js';
import type { GitHubPRContext, SentryIssueContext, SlackMessageContext } from './types.js';

const FETCH_TIMEOUT = 5000;

/** Create an AbortSignal that times out after `ms` milliseconds. */
function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/* ── Asana ─────────────────────────────────────────────────────────── */

/**
 * Extract Asana task GID from a URL or plain ID string.
 * Supports: https://app.asana.com/0/PROJECT/TASK_GID and plain GID.
 */
function parseAsanaTaskId(taskIdOrUrl: string): string {
  const urlMatch = taskIdOrUrl.match(/asana\.com\/\d+\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  // Plain numeric GID
  const gidMatch = taskIdOrUrl.match(/^(\d+)$/);
  if (gidMatch) return gidMatch[1];
  return taskIdOrUrl;
}

/**
 * Fetch an Asana task by GID or URL.
 */
export async function fetchAsanaTask(taskIdOrUrl: string, token: string): Promise<AsanaTask> {
  const gid = parseAsanaTaskId(taskIdOrUrl);
  const res = await fetch(`https://app.asana.com/api/1.0/tasks/${encodeURIComponent(gid)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: timeoutSignal(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    throw new Error(`Asana API ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as { data: AsanaTask };
  return json.data;
}

/* ── GitHub ─────────────────────────────────────────────────────────── */

/**
 * Parse a GitHub URL into owner, repo, type (pull|issues), and number.
 */
function parseGitHubUrl(url: string): { owner: string; repo: string; type: 'pull' | 'issues'; number: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    type: match[3] as 'pull' | 'issues',
    number: parseInt(match[4], 10),
  };
}

/**
 * Fetch a GitHub PR using gh CLI (primary) or REST API (fallback).
 * owner/repo/number are regex-validated from parseGitHubUrl, not raw user input.
 */
export async function fetchGitHubPR(
  owner: string,
  repo: string,
  number: number,
  token?: string
): Promise<GitHubPRContext> {
  // Try gh CLI first — args are from regex-validated URL parts
  try {
    const json = execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(number),
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'title,body,state,author,url,reviews,additions,deletions',
      ],
      { timeout: FETCH_TIMEOUT, encoding: 'utf8' }
    );
    const pr = JSON.parse(json) as {
      title: string;
      body: string;
      state: string;
      author: { login: string };
      url: string;
      reviews: Array<{ body: string; author: { login: string } }>;
      additions: number;
      deletions: number;
    };
    return {
      title: pr.title,
      body: pr.body || '',
      state: pr.state,
      diffSummary: `+${pr.additions} -${pr.deletions}`,
      reviewComments: (pr.reviews || []).filter((r) => r.body).map((r) => `${r.author?.login || 'unknown'}: ${r.body}`),
      url: pr.url,
      author: pr.author?.login || 'unknown',
    };
  } catch {
    // Fallback to REST API if token provided
    if (!token) throw new Error('gh CLI failed and no GitHub token configured for REST API fallback');
  }

  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: timeoutSignal(FETCH_TIMEOUT),
    }
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  const pr = (await res.json()) as {
    title: string;
    body: string | null;
    state: string;
    user: { login: string };
    html_url: string;
    additions: number;
    deletions: number;
  };
  return {
    title: pr.title,
    body: pr.body || '',
    state: pr.state,
    diffSummary: `+${pr.additions} -${pr.deletions}`,
    reviewComments: [],
    url: pr.html_url,
    author: pr.user?.login || 'unknown',
  };
}

/**
 * Fetch a GitHub issue using gh CLI (primary) or REST API (fallback).
 * owner/repo/number are regex-validated from parseGitHubUrl, not raw user input.
 */
export async function fetchGitHubIssue(
  owner: string,
  repo: string,
  number: number,
  token?: string
): Promise<GitHubIssue> {
  // Try gh CLI first
  try {
    const json = execFileSync(
      'gh',
      ['issue', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', 'title,body,url,number'],
      { timeout: FETCH_TIMEOUT, encoding: 'utf8' }
    );
    const issue = JSON.parse(json) as { title: string; body: string; url: string; number: number };
    return {
      title: issue.title,
      body: issue.body || '',
      html_url: issue.url,
      number: issue.number,
      repository: { full_name: `${owner}/${repo}` },
    };
  } catch {
    if (!token) throw new Error('gh CLI failed and no GitHub token configured for REST API fallback');
  }

  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: timeoutSignal(FETCH_TIMEOUT),
    }
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  return (await res.json()) as GitHubIssue;
}

/**
 * Fetch GitHub context (PR or issue) from a URL.
 */
export async function fetchGitHubContext(
  url: string,
  token?: string
): Promise<{ type: 'pr'; data: GitHubPRContext } | { type: 'issue'; data: GitHubIssue }> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) throw new Error(`Could not parse GitHub URL: ${url}`);

  if (parsed.type === 'pull') {
    const data = await fetchGitHubPR(parsed.owner, parsed.repo, parsed.number, token);
    return { type: 'pr', data };
  } else {
    const data = await fetchGitHubIssue(parsed.owner, parsed.repo, parsed.number, token);
    return { type: 'issue', data };
  }
}

/* ── Sentry ────────────────────────────────────────────────────────── */

/**
 * Fetch a Sentry issue by ID.
 */
export async function fetchSentryIssue(issueId: string, token: string, org: string): Promise<SentryIssueContext> {
  const res = await fetch(
    `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeoutSignal(FETCH_TIMEOUT),
    }
  );
  if (!res.ok) throw new Error(`Sentry API ${res.status}: ${res.statusText}`);
  const issue = (await res.json()) as {
    title: string;
    culprit: string;
    count: string;
    firstSeen: string;
    lastSeen: string;
    permalink: string;
    metadata?: { value?: string };
  };

  // Try to get the latest event for stack trace
  let stackTrace = '';
  try {
    const evtRes = await fetch(
      `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/events/latest/`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: timeoutSignal(FETCH_TIMEOUT),
      }
    );
    if (evtRes.ok) {
      const evt = (await evtRes.json()) as {
        entries?: Array<{
          type: string;
          data?: {
            values?: Array<{ stacktrace?: { frames?: Array<{ filename: string; lineNo: number; function: string }> } }>;
          };
        }>;
      };
      const exception = evt.entries?.find((e) => e.type === 'exception');
      if (exception?.data?.values?.[0]?.stacktrace?.frames) {
        const frames = exception.data.values[0].stacktrace.frames;
        stackTrace = frames
          .slice(-10)
          .reverse()
          .map((f) => `  ${f.function || '?'} (${f.filename}:${f.lineNo})`)
          .join('\n');
      }
    }
  } catch {
    // Stack trace fetch failed — non-critical
  }

  return {
    title: issue.title,
    culprit: issue.culprit || '',
    stackTrace,
    count: parseInt(issue.count, 10) || 0,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    url: issue.permalink,
  };
}

/* ── Slack ──────────────────────────────────────────────────────────── */

/**
 * Parse a Slack message URL into channel and timestamp.
 * Supports: https://TEAM.slack.com/archives/CHANNEL/pTIMESTAMP
 */
function parseSlackUrl(url: string): { channel: string; ts: string } | null {
  const match = url.match(/slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/);
  if (!match) return null;
  // Slack timestamps have a dot: "1234567890.123456" but URLs omit the dot
  const raw = match[2];
  const ts = raw.length > 10 ? raw.slice(0, 10) + '.' + raw.slice(10) : raw;
  return { channel: match[1], ts };
}

/**
 * Fetch a Slack message and its thread by URL.
 */
export async function fetchSlackMessage(url: string, token: string): Promise<SlackMessageContext> {
  const parsed = parseSlackUrl(url);
  if (!parsed) throw new Error(`Could not parse Slack message URL: ${url}`);

  // Fetch the parent message
  const histRes = await fetch(
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(parsed.channel)}&latest=${encodeURIComponent(parsed.ts)}&inclusive=true&limit=1`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeoutSignal(FETCH_TIMEOUT),
    }
  );
  if (!histRes.ok) throw new Error(`Slack API ${histRes.status}: ${histRes.statusText}`);
  const hist = (await histRes.json()) as {
    ok: boolean;
    error?: string;
    messages?: Array<{ text: string; user?: string; ts: string }>;
  };
  if (!hist.ok) throw new Error(`Slack API error: ${hist.error}`);

  const msg = hist.messages?.[0];
  if (!msg) throw new Error('Slack message not found');

  // Fetch thread replies if any
  const thread: string[] = [];
  try {
    const repliesRes = await fetch(
      `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(parsed.channel)}&ts=${encodeURIComponent(msg.ts)}&limit=20`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: timeoutSignal(FETCH_TIMEOUT),
      }
    );
    if (repliesRes.ok) {
      const replies = (await repliesRes.json()) as {
        ok: boolean;
        messages?: Array<{ text: string; user?: string }>;
      };
      if (replies.ok && replies.messages) {
        // Skip the first message (parent) and collect replies
        for (const r of replies.messages.slice(1)) {
          thread.push(`${r.user || 'unknown'}: ${r.text}`);
        }
      }
    }
  } catch {
    // Thread fetch failed — non-critical
  }

  return {
    text: msg.text,
    author: msg.user || 'unknown',
    channel: parsed.channel,
    thread,
    timestamp: msg.ts,
    url,
  };
}

/* ── Test connectivity ─────────────────────────────────────────────── */

/**
 * Test that an integration's credentials work with a lightweight API call.
 * Returns { ok: true } or { ok: false, error: string }.
 */
export async function testIntegrationConnection(
  service: string,
  config: { token?: string; org?: string; teamId?: string }
): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (service) {
      case 'asana': {
        if (!config.token) return { ok: false, error: 'No token configured' };
        const res = await fetch('https://app.asana.com/api/1.0/users/me', {
          headers: { Authorization: `Bearer ${config.token}` },
          signal: timeoutSignal(FETCH_TIMEOUT),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true };
      }
      case 'github': {
        // Try gh CLI first (uses its own auth)
        try {
          execFileSync('gh', ['auth', 'status'], { timeout: FETCH_TIMEOUT, encoding: 'utf8' });
          return { ok: true };
        } catch {
          if (!config.token) return { ok: false, error: 'gh CLI not authenticated and no token configured' };
        }
        const res = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github.v3+json' },
          signal: timeoutSignal(FETCH_TIMEOUT),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true };
      }
      case 'sentry': {
        if (!config.token) return { ok: false, error: 'No token configured' };
        if (!config.org) return { ok: false, error: 'No organization configured' };
        const res = await fetch(`https://sentry.io/api/0/organizations/${encodeURIComponent(config.org)}/`, {
          headers: { Authorization: `Bearer ${config.token}` },
          signal: timeoutSignal(FETCH_TIMEOUT),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true };
      }
      case 'slack': {
        if (!config.token) return { ok: false, error: 'No token configured' };
        const res = await fetch('https://slack.com/api/auth.test', {
          headers: { Authorization: `Bearer ${config.token}` },
          signal: timeoutSignal(FETCH_TIMEOUT),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = (await res.json()) as { ok: boolean; error?: string };
        if (!data.ok) return { ok: false, error: data.error || 'Auth test failed' };
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unknown service: ${service}` };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

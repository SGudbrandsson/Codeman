/**
 * @fileoverview External source ingestion helpers for Clockwork OS integration.
 *
 * Pure utility functions that normalize external task/issue formats into
 * Codeman work item creation payloads. No I/O — these are transform-only helpers.
 *
 * Clockwork OS handles receiving webhooks from external sources; these functions
 * normalize those payloads before passing them to createWorkItem().
 */

import type { WorkItemSource } from './work-items/index.js';
import type { SentryIssueContext, SlackMessageContext } from './integrations/types.js';

/**
 * Normalized work item creation payload from external sources.
 */
export interface NormalizedWorkItem {
  title: string;
  description: string;
  source: WorkItemSource;
  externalRef: string | null;
  externalUrl: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Minimal shape of an Asana task object as received from the Asana API.
 */
export interface AsanaTask {
  gid?: string;
  name?: string;
  notes?: string;
  permalink_url?: string;
  [key: string]: unknown;
}

/**
 * Minimal shape of a GitHub issue object as received from the GitHub API.
 */
export interface GitHubIssue {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  repository?: { full_name?: string };
  repository_url?: string;
  [key: string]: unknown;
}

/**
 * Normalize an Asana task into a work item creation payload.
 *
 * @param task - Raw Asana task object from the Asana API
 * @returns Normalized work item payload ready for createWorkItem()
 */
export function normalizeAsanaTask(task: AsanaTask): NormalizedWorkItem {
  const title = task.name?.trim() || '(Untitled Asana Task)';
  const description = task.notes?.trim() || '';
  const externalRef = task.gid ? `asana:${task.gid}` : null;
  const externalUrl = task.permalink_url || null;

  // Preserve original task fields in metadata for traceability
  const metadata: Record<string, unknown> = { asana: task };

  return {
    title,
    description,
    source: 'asana',
    externalRef,
    externalUrl,
    metadata,
  };
}

/**
 * Normalize a GitHub issue into a work item creation payload.
 *
 * @param issue - Raw GitHub issue object from the GitHub API
 * @returns Normalized work item payload ready for createWorkItem()
 */
export function normalizeGitHubIssue(issue: GitHubIssue): NormalizedWorkItem {
  const title = issue.title?.trim() || '(Untitled GitHub Issue)';
  const description = issue.body?.trim() || '';

  // Derive repo name from repository object or repository_url
  let repoName: string | null = null;
  if (issue.repository?.full_name) {
    repoName = issue.repository.full_name;
  } else if (typeof issue.repository_url === 'string') {
    // e.g. "https://api.github.com/repos/owner/repo"
    const match = issue.repository_url.match(/repos\/([^/]+\/[^/]+)$/);
    if (match) repoName = match[1];
  }

  const externalRef =
    issue.number != null && repoName
      ? `github:${repoName}#${issue.number}`
      : issue.number != null
        ? `github:#${issue.number}`
        : null;

  const externalUrl = issue.html_url || null;

  const metadata: Record<string, unknown> = { github: issue };

  return {
    title,
    description,
    source: 'github',
    externalRef,
    externalUrl,
    metadata,
  };
}

/**
 * Normalize a Sentry issue into a work item creation payload.
 *
 * @param issue - Sentry issue context from the Sentry API
 * @returns Normalized work item payload ready for createWorkItem()
 */
export function normalizeSentryIssue(issue: SentryIssueContext): NormalizedWorkItem {
  const title = issue.title || '(Untitled Sentry Issue)';
  const parts = [`**Culprit:** ${issue.culprit || 'unknown'}`];
  if (issue.stackTrace) parts.push(`**Stack trace:**\n\`\`\`\n${issue.stackTrace}\n\`\`\``);
  parts.push(`Occurrences: ${issue.count} | First seen: ${issue.firstSeen} | Last seen: ${issue.lastSeen}`);
  const description = parts.join('\n\n');

  return {
    title,
    description,
    source: 'sentry',
    externalRef: issue.url ? `sentry:${issue.url.split('/').pop() || ''}` : null,
    externalUrl: issue.url || null,
    metadata: { sentry: issue },
  };
}

/**
 * Normalize a Slack message into a work item creation payload.
 *
 * @param msg - Slack message context from the Slack API
 * @returns Normalized work item payload ready for createWorkItem()
 */
export function normalizeSlackMessage(msg: SlackMessageContext): NormalizedWorkItem {
  const title = msg.text.length > 80 ? msg.text.slice(0, 77) + '...' : msg.text || '(Slack message)';
  const parts = [`**From:** ${msg.author} in #${msg.channel}`];
  parts.push(`**Message:** ${msg.text}`);
  if (msg.thread.length > 0) {
    parts.push(`**Thread (${msg.thread.length} replies):**`);
    for (const reply of msg.thread.slice(0, 10)) {
      parts.push(`> ${reply}`);
    }
  }
  const description = parts.join('\n\n');

  return {
    title,
    description,
    source: 'slack',
    externalRef: `slack:${msg.channel}:${msg.timestamp}`,
    externalUrl: msg.url || null,
    metadata: { slack: msg },
  };
}

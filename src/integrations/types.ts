/**
 * @fileoverview Type definitions for external integration configuration and context objects.
 *
 * Covers: Asana, GitHub, Sentry, Slack integrations.
 * Used by: src/integrations/index.ts, command-panel-routes.ts, integration-routes.ts
 */

/** Per-service integration configuration. */
export interface IntegrationConfig {
  enabled: boolean;
  token?: string;
  /** Sentry organization slug */
  org?: string;
  /** Slack team ID */
  teamId?: string;
}

/** Top-level integrations configuration stored in AppConfig. */
export interface IntegrationsConfig {
  asana?: IntegrationConfig;
  github?: IntegrationConfig;
  sentry?: IntegrationConfig;
  slack?: IntegrationConfig;
}

/** GitHub PR context fetched from the API. */
export interface GitHubPRContext {
  title: string;
  body: string;
  state: string;
  diffSummary: string;
  reviewComments: string[];
  url: string;
  author: string;
}

/** Sentry issue context fetched from the API. */
export interface SentryIssueContext {
  title: string;
  culprit: string;
  stackTrace: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  url: string;
}

/** Slack message context fetched from the API. */
export interface SlackMessageContext {
  text: string;
  author: string;
  channel: string;
  thread: string[];
  timestamp: string;
  url: string;
}

/** Discriminated union covering all integration context results. */
export type ExternalContext =
  | { type: 'asana'; data: import('../clockwork-ingestion.js').AsanaTask; error?: undefined }
  | { type: 'github_pr'; data: GitHubPRContext; error?: undefined }
  | { type: 'github_issue'; data: import('../clockwork-ingestion.js').GitHubIssue; error?: undefined }
  | { type: 'sentry'; data: SentryIssueContext; error?: undefined }
  | { type: 'slack'; data: SlackMessageContext; error?: undefined }
  | { type: string; data?: undefined; error: string };

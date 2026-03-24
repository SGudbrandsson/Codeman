/**
 * @fileoverview Unit tests for clockwork-ingestion.ts.
 *
 * Tests normalizeAsanaTask() and normalizeGitHubIssue() in isolation.
 * No mocking required — these are pure transform functions with no I/O.
 */

import { describe, it, expect } from 'vitest';
import { normalizeAsanaTask, normalizeGitHubIssue } from '../src/clockwork-ingestion.js';

describe('normalizeAsanaTask', () => {
  it('maps all fields correctly from a full Asana task object', () => {
    const task = {
      gid: '1234567890',
      name: 'Fix the login bug',
      notes: 'Users cannot log in after the 2.0 upgrade.',
      permalink_url: 'https://app.asana.com/0/proj/task1234',
    };

    const result = normalizeAsanaTask(task);

    expect(result.title).toBe('Fix the login bug');
    expect(result.description).toBe('Users cannot log in after the 2.0 upgrade.');
    expect(result.source).toBe('asana');
    expect(result.externalRef).toBe('asana:1234567890');
    expect(result.externalUrl).toBe('https://app.asana.com/0/proj/task1234');
    expect(result.metadata).toEqual({ asana: task });
  });

  it('uses fallback title when name is empty string', () => {
    const result = normalizeAsanaTask({ gid: 'abc', name: '' });
    expect(result.title).toBe('(Untitled Asana Task)');
  });

  it('uses fallback title when name is missing', () => {
    const result = normalizeAsanaTask({ gid: 'xyz' });
    expect(result.title).toBe('(Untitled Asana Task)');
  });

  it('uses fallback title when name is whitespace only', () => {
    const result = normalizeAsanaTask({ gid: 'ws', name: '   ' });
    expect(result.title).toBe('(Untitled Asana Task)');
  });

  it('sets externalRef to null when gid is missing', () => {
    const result = normalizeAsanaTask({ name: 'No gid task' });
    expect(result.externalRef).toBeNull();
  });

  it('sets externalUrl to null when permalink_url is missing', () => {
    const result = normalizeAsanaTask({ gid: '999', name: 'No URL task' });
    expect(result.externalUrl).toBeNull();
  });

  it('sets description to empty string when notes is missing', () => {
    const result = normalizeAsanaTask({ gid: '999', name: 'Task with no notes' });
    expect(result.description).toBe('');
  });
});

describe('normalizeGitHubIssue', () => {
  it('maps all fields correctly from a full GitHub issue object', () => {
    const issue = {
      number: 42,
      title: 'Crash on startup',
      body: 'App crashes immediately after launch on macOS.',
      html_url: 'https://github.com/owner/repo/issues/42',
      repository: { full_name: 'owner/repo' },
    };

    const result = normalizeGitHubIssue(issue);

    expect(result.title).toBe('Crash on startup');
    expect(result.description).toBe('App crashes immediately after launch on macOS.');
    expect(result.source).toBe('github');
    expect(result.externalRef).toBe('github:owner/repo#42');
    expect(result.externalUrl).toBe('https://github.com/owner/repo/issues/42');
    expect(result.metadata).toEqual({ github: issue });
  });

  it('parses repository name from repository_url when repository.full_name is absent', () => {
    const issue = {
      number: 7,
      title: 'Bug report',
      html_url: 'https://github.com/acme/widget/issues/7',
      repository_url: 'https://api.github.com/repos/acme/widget',
    };

    const result = normalizeGitHubIssue(issue);

    expect(result.externalRef).toBe('github:acme/widget#7');
  });

  it('uses fallback title when title is empty string', () => {
    const result = normalizeGitHubIssue({ number: 1, title: '' });
    expect(result.title).toBe('(Untitled GitHub Issue)');
  });

  it('uses fallback title when title is missing', () => {
    const result = normalizeGitHubIssue({ number: 2 });
    expect(result.title).toBe('(Untitled GitHub Issue)');
  });

  it('handles null body gracefully — sets description to empty string', () => {
    const result = normalizeGitHubIssue({ number: 3, title: 'Null body issue', body: null });
    expect(result.description).toBe('');
  });

  it('handles missing body gracefully — sets description to empty string', () => {
    const result = normalizeGitHubIssue({ number: 4, title: 'No body issue' });
    expect(result.description).toBe('');
  });

  it('sets externalRef without repo when both repository and repository_url are absent', () => {
    const result = normalizeGitHubIssue({ number: 5, title: 'No repo info' });
    // number is present but no repo name — falls back to github:#5 format
    expect(result.externalRef).toBe('github:#5');
  });

  it('sets externalRef to null when number is absent', () => {
    const result = normalizeGitHubIssue({ title: 'No number' });
    expect(result.externalRef).toBeNull();
  });

  it('sets externalUrl to null when html_url is missing', () => {
    const result = normalizeGitHubIssue({ number: 6, title: 'No URL' });
    expect(result.externalUrl).toBeNull();
  });
});

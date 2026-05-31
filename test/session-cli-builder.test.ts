/**
 * @fileoverview Tests for buildInteractiveArgs CLI argument construction.
 *
 * Focuses on the `--disallowedTools AskUserQuestion` injection (Codeman disables
 * the AskUserQuestion tool so Claude asks questions as plain text) across the
 * safe-mode, normal fresh, and resume code paths.
 */

import { describe, it, expect } from 'vitest';
import { buildInteractiveArgs } from '../src/session-cli-builder.js';

// Assert that `--disallowedTools` is immediately followed by `AskUserQuestion`.
function expectsDisallowsAskUserQuestion(args: string[]) {
  const i = args.indexOf('--disallowedTools');
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toBe('AskUserQuestion');
}

describe('buildInteractiveArgs', () => {
  it('disables AskUserQuestion in safe mode alongside --dangerously-skip-permissions', () => {
    const args = buildInteractiveArgs('sid', 'normal', undefined, undefined, undefined, true);
    expect(args).toEqual(['--dangerously-skip-permissions', '--disallowedTools', 'AskUserQuestion']);
    expectsDisallowsAskUserQuestion(args);
  });

  it('disables AskUserQuestion in the normal (non-safe-mode) path', () => {
    const args = buildInteractiveArgs('sid', 'normal');
    expectsDisallowsAskUserQuestion(args);
  });

  it('disables AskUserQuestion on the resume path and omits --session-id', () => {
    const args = buildInteractiveArgs('sid', 'normal', undefined, undefined, 'resume-uuid');
    expectsDisallowsAskUserQuestion(args);
    expect(args).not.toContain('--session-id');
  });

  it('includes --session-id on the fresh (no-resume) path', () => {
    const args = buildInteractiveArgs('sid', 'normal');
    const i = args.indexOf('--session-id');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('sid');
  });
});

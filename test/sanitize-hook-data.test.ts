/**
 * Tests for sanitizeHookData — the allowlist filter applied to Claude Code hook
 * stdin before broadcasting over SSE.
 *
 * Regression focus: the AskUserQuestion PreToolUse hook must forward both the full
 * `questions` array (with option descriptions) AND `tool_use_id`. The id lets the
 * web client dedup the live hook render against the later transcript tool_use block;
 * without it, an answered question re-appears when the JSONL catches up.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeHookData } from '../src/web/route-helpers.js';

describe('sanitizeHookData', () => {
  it('forwards tool_use_id (needed for AskUserQuestion dedup)', () => {
    const out = sanitizeHookData({
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_01abc',
      tool_input: { questions: [{ question: 'Q', options: [{ label: 'A' }] }] },
    });
    expect(out.tool_use_id).toBe('toolu_01abc');
  });

  it('passes the full AskUserQuestion questions array through untouched (incl. descriptions)', () => {
    const questions = [
      {
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'Option A', description: 'Supporting info A that must survive' },
          { label: 'Option B', description: 'Supporting info B' },
        ],
      },
    ];
    const out = sanitizeHookData({ tool_name: 'AskUserQuestion', tool_input: { questions } });
    expect(out.tool_input).toEqual({ questions });
    // descriptions specifically must not be stripped
    const opts = (out.tool_input as { questions: Array<{ options: Array<{ description?: string }> }> }).questions[0]
      .options;
    expect(opts[0].description).toBe('Supporting info A that must survive');
  });

  it('still strips unknown/secret fields', () => {
    const out = sanitizeHookData({
      tool_name: 'Bash',
      secret_field: 'nope',
      tool_use_id: 'toolu_x',
    });
    expect(out.secret_field).toBeUndefined();
    expect(out.tool_name).toBe('Bash');
  });

  it('summarizes non-AskUserQuestion tool_input rather than passing it whole', () => {
    const out = sanitizeHookData({
      tool_name: 'Bash',
      tool_input: { command: 'ls', secret: 'should-not-pass' },
    });
    const input = out.tool_input as Record<string, unknown>;
    expect(input.command).toBe('ls');
    expect(input.secret).toBeUndefined();
  });
});

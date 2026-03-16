/**
 * @fileoverview Tests for Session.parseContextOutput
 *
 * Validates parsing of /context command output (new and legacy formats).
 * Uses actual ANSI-stripped output from Claude Code's /context command.
 */

import { describe, it, expect } from 'vitest';
import { Session } from '../src/session.js';

// Actual ANSI-stripped /context output lines (from real Claude Code output)
const FULL_NEW_FORMAT_LINES = [
  'Context Usage',
  '⛀ ⛁ ⛀ ⛁ ⛀   claude-sonnet-4-6 · 104k/200k tokens (52%)',
  '⛁ ⛁ ⛁ ⛁ ⛁',
  '⛁ ⛁ ⛁ ⛁ ⛁   Estimated usage by category',
  '⛁ ⛶ ⛶ ⛶ ⛶   ⛁ System prompt: 3.7k tokens (1.9%)',
  '⛶ ⛝ ⛝ ⛝ ⛝   ⛁ System tools: 9k tokens (4.5%)',
  '            ⛁ Custom agents: 812 tokens (0.4%)',
  '            ⛁ Memory files: 5.8k tokens (2.9%)',
  '            ⛁ Skills: 1.7k tokens (0.8%)',
  '            ⛁ Messages: 83.4k tokens (41.7%)',
  '            ⛶ Free space: 63k (31.3%)',
  '            ⛝ Autocompact buffer: 33k tokens (16.5%)',
];

// Partial output — only header + system categories, Messages not yet arrived
const PARTIAL_LINES_NO_MESSAGES = [
  'Context Usage',
  '⛀ ⛁ ⛀ ⛁ ⛀   claude-sonnet-4-6 · 104k/200k tokens (52%)',
  '⛁ ⛁ ⛁ ⛁ ⛁   Estimated usage by category',
  '⛁ ⛶ ⛶ ⛶ ⛶   ⛁ System prompt: 3.7k tokens (1.9%)',
  '⛶ ⛝ ⛝ ⛝ ⛝   ⛁ System tools: 9k tokens (4.5%)',
  '            ⛁ Custom agents: 812 tokens (0.4%)',
];

// Partial with messages but no Free space: marker yet
const PARTIAL_WITH_MESSAGES_NO_MARKER = [
  '⛀ ⛁ ⛀ ⛁ ⛀   claude-sonnet-4-6 · 104k/200k tokens (52%)',
  '⛁ ⛶ ⛶ ⛶ ⛶   ⛁ System prompt: 3.7k tokens (1.9%)',
  '⛶ ⛝ ⛝ ⛝ ⛝   ⛁ System tools: 9k tokens (4.5%)',
  '            ⛁ Messages: 83.4k tokens (41.7%)',
];

// Header only (very first PTY batch)
const HEADER_ONLY_LINES = ['⛀ ⛁ ⛀ ⛁ ⛀   claude-sonnet-4-6 · 104k/200k tokens (52%)'];

// New format, no system tools or agents (minimal session)
const MINIMAL_NEW_FORMAT_LINES = [
  '10k/200k tokens (5%)',
  'System prompt: 3.7k tokens (1.9%)',
  'Messages: 5.2k tokens (2.6%)',
  'Free space: 191k (95.5%)',
];

// Legacy format
const LEGACY_FORMAT_LINES = [
  'Context window usage',
  'Total: 128,000 / 200,000',
  'System: 45,000 tokens',
  'Conversation: 75,000 tokens',
  'Tools: 8,000 tokens',
];

// Live session format — ANSI-stripped output from a real PTY session (observed 2026-03-16)
const LIVE_SESSION_FORMAT_LINES = [
  'Context Usage',
  '⛁ ⛁ ⛀ ⛀ ⛀   claude-sonnet-4-6 · 90k/200k tokens (45%)',
  '⛁ ⛁ ⛁ ⛁ ⛁',
  '⛁ ⛁ ⛁ ⛁ ⛶   Estimated usage by category',
  '⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System prompt: 5.6k tokens (2.8%)',
  '⛶ ⛝ ⛝ ⛝ ⛝   ⛁ System tools: 8k tokens (4.0%)',
  '            ⛁ Custom agents: 812 tokens (0.4%)',
  '            ⛁ Memory files: 2k tokens (1.0%)',
  '            ⛁ Skills: 2.2k tokens (1.1%)',
  '            ⛁ Messages: 72.1k tokens (36.0%)',
  '            ⛶ Free space: 76k (38.2%)',
  '            ⛝ Autocompact buffer: 33k tokens (16.5%)',
];

// Empty / unrelated lines
const EMPTY_LINES: string[] = [];
const UNRELATED_LINES = ['Hello world', 'Some output', 'No context info here'];

describe('Session.parseContextOutput', () => {
  describe('live session format (observed PTY output 2026-03-16)', () => {
    it('parses live fixture with integer-k notation and all categories', () => {
      const result = Session.parseContextOutput(LIVE_SESSION_FORMAT_LINES);
      expect(result).not.toBeNull();
      expect(result!.inputTokens).toBe(90000);
      expect(result!.maxTokens).toBe(200000);
      expect(result!.pct).toBe(45);
      // system = 5.6k + 8k + 812 + 2k + 2.2k = 5600 + 8000 + 812 + 2000 + 2200 = 18612
      expect(result!.system).toBe(18612);
      // conversation = 72.1k = 72100
      expect(result!.conversation).toBe(72100);
      // tools not present in new format
      expect(result!.tools).toBeUndefined();
    });
  });

  describe('new format (Claude Code >= 2025)', () => {
    it('parses full output with all categories', () => {
      const result = Session.parseContextOutput(FULL_NEW_FORMAT_LINES);
      expect(result).not.toBeNull();
      expect(result!.inputTokens).toBe(104000);
      expect(result!.maxTokens).toBe(200000);
      expect(result!.pct).toBe(52);
      // system = 3.7k + 9k + 812 + 5.8k + 1.7k = 21012
      expect(result!.system).toBe(3700 + 9000 + 812 + 5800 + 1700);
      // conversation = 83.4k
      expect(result!.conversation).toBe(83400);
      expect(result!.tools).toBeUndefined();
    });

    it('returns null for partial output — system categories only, no Messages yet', () => {
      // This was the root cause of the "5% bar" bug: premature return before Messages arrived
      const result = Session.parseContextOutput(PARTIAL_LINES_NO_MESSAGES);
      expect(result).toBeNull();
    });

    it('parses when Messages is present even without Free space: marker', () => {
      // Once Messages is found, we have enough data even if output isn't fully terminated
      const result = Session.parseContextOutput(PARTIAL_WITH_MESSAGES_NO_MARKER);
      expect(result).not.toBeNull();
      expect(result!.pct).toBe(52);
      expect(result!.conversation).toBe(83400);
    });

    it('returns null for header-only lines (output just started)', () => {
      const result = Session.parseContextOutput(HEADER_ONLY_LINES);
      expect(result).toBeNull();
    });

    it('parses minimal session with no custom agents or tools', () => {
      const result = Session.parseContextOutput(MINIMAL_NEW_FORMAT_LINES);
      expect(result).not.toBeNull();
      expect(result!.inputTokens).toBe(10000);
      expect(result!.maxTokens).toBe(200000);
      expect(result!.pct).toBe(5);
      expect(result!.system).toBe(3700);
      expect(result!.conversation).toBe(5200);
    });

    it('pct is capped at 100', () => {
      const overflowLines = [
        '205k/200k tokens (103%)',
        'System prompt: 3k tokens',
        'Messages: 200k tokens',
        'Free space: 0k (0%)',
      ];
      const result = Session.parseContextOutput(overflowLines);
      expect(result).not.toBeNull();
      expect(result!.pct).toBe(100);
    });
  });

  describe('legacy format', () => {
    it('parses legacy Total: N / N format with System/Conversation/Tools', () => {
      const result = Session.parseContextOutput(LEGACY_FORMAT_LINES);
      expect(result).not.toBeNull();
      expect(result!.inputTokens).toBe(128000);
      expect(result!.maxTokens).toBe(200000);
      expect(result!.pct).toBe(64);
      expect(result!.system).toBe(45000);
      expect(result!.conversation).toBe(75000);
      expect(result!.tools).toBe(8000);
    });

    it('returns null when legacy header found but no Total: line', () => {
      const result = Session.parseContextOutput(['Context window usage']);
      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('returns null for empty lines', () => {
      expect(Session.parseContextOutput(EMPTY_LINES)).toBeNull();
    });

    it('returns null for unrelated output', () => {
      expect(Session.parseContextOutput(UNRELATED_LINES)).toBeNull();
    });

    it('parses k-notation correctly', () => {
      const lines = [
        '3.7k/200k tokens (2%)',
        'System prompt: 1.5k tokens',
        'Messages: 2.2k tokens',
        'Free space: 196k',
      ];
      const result = Session.parseContextOutput(lines);
      expect(result).not.toBeNull();
      expect(result!.system).toBe(1500);
      expect(result!.conversation).toBe(2200);
    });

    it('handles accumulated lines from multiple PTY batches (no duplicate parsing)', () => {
      // Simulate accumulation across two _processExpensiveParsers calls
      const batch1 = PARTIAL_LINES_NO_MESSAGES;
      const batch2 = [
        '            ⛁ Memory files: 5.8k tokens (2.9%)',
        '            ⛁ Skills: 1.7k tokens (0.8%)',
        '            ⛁ Messages: 83.4k tokens (41.7%)',
        '            ⛶ Free space: 63k (31.3%)',
      ];
      const combined = [...batch1, ...batch2];
      const result = Session.parseContextOutput(combined);
      expect(result).not.toBeNull();
      expect(result!.conversation).toBe(83400);
    });
  });
});

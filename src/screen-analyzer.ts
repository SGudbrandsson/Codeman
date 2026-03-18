/**
 * @fileoverview Screen analyzer — captures the current visible tmux pane and classifies
 * Claude Code's state from the output.
 *
 * All pattern matching is performed on ANSI-stripped text.
 * captureScreen uses tmux capture-pane WITHOUT -S (no scrollback) — current screen only.
 *
 * Security: mux names validated against /^codeman-[a-f0-9-]+$/ before use.
 * execFileSync is used (no shell) so the validated name is passed as a literal argument.
 */
import { execFileSync } from 'node:child_process';

export type ClaudeScreenState =
  | 'waiting_for_input'
  | 'asking_question'
  | 'running_tool'
  | 'thinking'
  | 'completion'
  | 'shell_prompt'
  | 'unknown';

export interface ScreenAnalysis {
  state: ClaudeScreenState;
  lastVisibleText: string;
  hasClaudePresence: boolean;
  questionText?: string;
  optionLines?: string[];
  confidence: number;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]|\u001b[^[]/g;

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, '');
}

const COMPLETION_PATTERN = /Worked for \d+[hms]/;
const TOOL_PATTERN = /⏺\s*(?:Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|TodoWrite|Agent)\(/;
const YN_PATTERN = /\[y\/n\]|\[Y\/n\]|\[y\/N\]|\(y\/n\)/i;
const NUMBERED_LIST_PATTERN = /^\s*\d+\.\s+\w/m;
const SPINNER_CHARS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const THINKING_PATTERN = /Thinking/i;
const CLAUDE_PROMPT_PATTERN = /❯|\u276f/;
const SHELL_PROMPT_PATTERN = /[$%#]\s*$/m;

function getLastVisibleText(stripped: string): string {
  const lines = stripped.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length > 0) return line;
  }
  return '';
}

function extractQuestion(stripped: string): { questionText: string; optionLines: string[] } {
  const lines = stripped
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const optionLines = lines.filter((l) => /^\s*\d+\.\s+/.test(l));
  const questionText = lines.filter((l) => !/^\s*\d+\.\s+/.test(l)).pop() ?? '';
  return { questionText, optionLines };
}

export function analyzeScreen(rawScreen: string): ScreenAnalysis {
  const stripped = stripAnsi(rawScreen);
  const lastVisibleText = getLastVisibleText(stripped);

  if (COMPLETION_PATTERN.test(stripped)) {
    return { state: 'completion', lastVisibleText, hasClaudePresence: true, confidence: 95 };
  }
  if (TOOL_PATTERN.test(stripped)) {
    return { state: 'running_tool', lastVisibleText, hasClaudePresence: true, confidence: 90 };
  }
  if (YN_PATTERN.test(stripped) || NUMBERED_LIST_PATTERN.test(stripped)) {
    const { questionText, optionLines } = extractQuestion(stripped);
    return {
      state: 'asking_question',
      lastVisibleText,
      hasClaudePresence: true,
      questionText,
      optionLines: optionLines.length > 0 ? optionLines : undefined,
      confidence: 85,
    };
  }
  if (SPINNER_CHARS.test(stripped) || THINKING_PATTERN.test(stripped)) {
    return { state: 'thinking', lastVisibleText, hasClaudePresence: true, confidence: 80 };
  }
  if (CLAUDE_PROMPT_PATTERN.test(stripped)) {
    return { state: 'waiting_for_input', lastVisibleText, hasClaudePresence: true, confidence: 90 };
  }
  if (SHELL_PROMPT_PATTERN.test(stripped)) {
    return { state: 'shell_prompt', lastVisibleText, hasClaudePresence: false, confidence: 70 };
  }
  return { state: 'unknown', lastVisibleText, hasClaudePresence: false, confidence: 0 };
}

/**
 * Captures the CURRENT VISIBLE SCREEN of a tmux pane (no scrollback).
 * Returns null if the pane doesn't exist, the mux name is invalid, or capture fails.
 */
export function captureScreen(muxName: string): string | null {
  if (!/^codeman-[a-f0-9-]+$/.test(muxName)) return null;
  try {
    return execFileSync('tmux', ['capture-pane', '-p', '-e', '-t', muxName], {
      encoding: 'utf-8',
      timeout: 5000,
    });
  } catch {
    return null;
  }
}

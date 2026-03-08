/**
 * Unit tests for the compose panel slash command logic.
 *
 * These tests mirror the BUILTIN_CLAUDE_COMMANDS constant and the matching
 * algorithm from app.js (InputPanel._handleSlashInput).  They are kept in
 * sync with the browser code intentionally — if you change the algorithm in
 * app.js, update these tests and the mirrored helpers below.
 */

import { describe, it, expect } from 'vitest';

// ── Mirrored from app.js: BUILTIN_CLAUDE_COMMANDS ────────────────────────────

interface SlashCommand {
  cmd: string;
  desc: string;
  source: string;
}

const BUILTIN_CLAUDE_COMMANDS: SlashCommand[] = [
  { cmd: '/compact', desc: 'Compact conversation history', source: 'builtin' },
  { cmd: '/clear', desc: 'Clear conversation history', source: 'builtin' },
  { cmd: '/help', desc: 'Show available commands and help', source: 'builtin' },
  { cmd: '/bug', desc: 'Report a bug to Anthropic', source: 'builtin' },
  { cmd: '/cost', desc: 'View token usage and cost', source: 'builtin' },
  { cmd: '/doctor', desc: 'Check Claude Code installation health', source: 'builtin' },
  { cmd: '/init', desc: 'Initialize CLAUDE.md in current project', source: 'builtin' },
  { cmd: '/login', desc: 'Sign in with Anthropic credentials', source: 'builtin' },
  { cmd: '/logout', desc: 'Sign out from Anthropic', source: 'builtin' },
  { cmd: '/memory', desc: 'Edit CLAUDE.md memory files', source: 'builtin' },
  { cmd: '/model', desc: 'Set the AI model', source: 'builtin' },
  { cmd: '/pr_comments', desc: 'View PR comments', source: 'builtin' },
  { cmd: '/release-notes', desc: "See what's new in Claude Code", source: 'builtin' },
  { cmd: '/review', desc: 'Review a pull request', source: 'builtin' },
  { cmd: '/status', desc: 'Show account and system status', source: 'builtin' },
  { cmd: '/terminal-setup', desc: 'Configure terminal key bindings', source: 'builtin' },
  { cmd: '/vim', desc: 'Toggle Vim mode', source: 'builtin' },
];

// ── Mirrored from app.js: InputPanel._handleSlashInput matching logic ────────

function matchSlashCommands(allCommands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return allCommands;
  const q = query.toLowerCase();
  return allCommands.filter((c) => {
    const cmd = c.cmd.toLowerCase();
    const desc = (c.desc || '').toLowerCase();
    if (cmd.includes(q) || desc.includes(q)) return true;
    // Subsequence match: gsdmile matches gsd:new-milestone
    let qi = 0;
    for (let i = 0; i < cmd.length && qi < q.length; i++) {
      if (cmd[i] === q[qi]) qi++;
    }
    return qi === q.length;
  });
}

function mergeCommands(sessionCommands: SlashCommand[], builtins: SlashCommand[]): SlashCommand[] {
  const sessionCmdSet = new Set(sessionCommands.map((c) => c.cmd));
  return [...sessionCommands, ...builtins.filter((c) => !sessionCmdSet.has(c.cmd))];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BUILTIN_CLAUDE_COMMANDS', () => {
  it('includes /compact', () => {
    expect(BUILTIN_CLAUDE_COMMANDS.some((c) => c.cmd === '/compact')).toBe(true);
  });

  it('includes /clear', () => {
    expect(BUILTIN_CLAUDE_COMMANDS.some((c) => c.cmd === '/clear')).toBe(true);
  });

  it('includes /help', () => {
    expect(BUILTIN_CLAUDE_COMMANDS.some((c) => c.cmd === '/help')).toBe(true);
  });

  it('all entries have cmd, desc, and source="builtin"', () => {
    for (const c of BUILTIN_CLAUDE_COMMANDS) {
      expect(c.cmd).toMatch(/^\//);
      expect(c.desc.length).toBeGreaterThan(0);
      expect(c.source).toBe('builtin');
    }
  });
});

describe('matchSlashCommands', () => {
  it('returns all commands when query is empty', () => {
    const result = matchSlashCommands(BUILTIN_CLAUDE_COMMANDS, '');
    expect(result).toHaveLength(BUILTIN_CLAUDE_COMMANDS.length);
  });

  it('matches /compact by exact prefix', () => {
    const result = matchSlashCommands(BUILTIN_CLAUDE_COMMANDS, 'compact');
    expect(result.some((c) => c.cmd === '/compact')).toBe(true);
  });

  it('matches /compact when query is just "com"', () => {
    const result = matchSlashCommands(BUILTIN_CLAUDE_COMMANDS, 'com');
    expect(result.some((c) => c.cmd === '/compact')).toBe(true);
  });

  it('matches case-insensitively', () => {
    const result = matchSlashCommands(BUILTIN_CLAUDE_COMMANDS, 'COMPACT');
    expect(result.some((c) => c.cmd === '/compact')).toBe(true);
  });

  it('matches by description keyword', () => {
    const result = matchSlashCommands(BUILTIN_CLAUDE_COMMANDS, 'anthropic');
    expect(result.some((c) => c.cmd === '/bug')).toBe(true);
  });

  it('returns empty array for no match', () => {
    const result = matchSlashCommands(BUILTIN_CLAUDE_COMMANDS, 'xyzzy_no_match_ever');
    expect(result).toHaveLength(0);
  });

  it('subsequence: "cmpct" matches /compact', () => {
    const result = matchSlashCommands(BUILTIN_CLAUDE_COMMANDS, 'cmpct');
    expect(result.some((c) => c.cmd === '/compact')).toBe(true);
  });

  it('subsequence: "stts" matches /status', () => {
    const result = matchSlashCommands(BUILTIN_CLAUDE_COMMANDS, 'stts');
    expect(result.some((c) => c.cmd === '/status')).toBe(true);
  });
});

describe('mergeCommands (session + builtins)', () => {
  const sessionCmds: SlashCommand[] = [
    { cmd: '/gsd:new-milestone', desc: 'Start a new milestone', source: 'plugin' },
    { cmd: '/gsd:plan-phase', desc: 'Plan a phase', source: 'plugin' },
  ];

  it('session commands appear before builtins', () => {
    const merged = mergeCommands(sessionCmds, BUILTIN_CLAUDE_COMMANDS);
    expect(merged[0].cmd).toBe('/gsd:new-milestone');
    expect(merged[1].cmd).toBe('/gsd:plan-phase');
  });

  it('builtins are appended after session commands', () => {
    const merged = mergeCommands(sessionCmds, BUILTIN_CLAUDE_COMMANDS);
    expect(merged.length).toBe(sessionCmds.length + BUILTIN_CLAUDE_COMMANDS.length);
    expect(merged.some((c) => c.cmd === '/compact')).toBe(true);
  });

  it('deduplicates: if session overrides a builtin, builtin is not added again', () => {
    const overrides: SlashCommand[] = [{ cmd: '/compact', desc: 'Custom compact', source: 'plugin' }];
    const merged = mergeCommands(overrides, BUILTIN_CLAUDE_COMMANDS);
    const compacts = merged.filter((c) => c.cmd === '/compact');
    expect(compacts).toHaveLength(1);
    expect(compacts[0].source).toBe('plugin'); // session version wins
  });

  it('matching on merged list finds both session and builtin commands', () => {
    const merged = mergeCommands(sessionCmds, BUILTIN_CLAUDE_COMMANDS);
    const hits = matchSlashCommands(merged, 'milestone');
    expect(hits.some((c) => c.cmd === '/gsd:new-milestone')).toBe(true);
    const compacts = matchSlashCommands(merged, 'compact');
    expect(compacts.some((c) => c.cmd === '/compact')).toBe(true);
  });
});

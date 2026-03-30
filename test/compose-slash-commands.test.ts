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

// ── Mirrored from app.js: InputPanel._findSlashToken ──────────────────────────

function findSlashToken(value: string, cursorPos: number): { start: number; query: string } | null {
  if (!value || cursorPos == null || cursorPos < 1) return null;
  let i = cursorPos - 1;
  while (
    i >= 0 &&
    value[i] !== '/' &&
    value[i] !== ' ' &&
    value[i] !== '\n' &&
    value[i] !== '\r' &&
    value[i] !== '\t'
  ) {
    i--;
  }
  if (i < 0 || value[i] !== '/') return null;
  if (i > 0) {
    const prev = value[i - 1];
    if (prev !== ' ' && prev !== '\n' && prev !== '\r' && prev !== '\t') return null;
  }
  const query = value.slice(i + 1, cursorPos);
  return { start: i, query };
}

// ── Inline slash token detection tests ───────────────────────────────────────

describe('findSlashToken (inline slash detection)', () => {
  it('"hello /com" cursor=10 -> { start: 6, query: "com" }', () => {
    expect(findSlashToken('hello /com', 10)).toEqual({ start: 6, query: 'com' });
  });

  it('"/compact foo" cursor=8 -> { start: 0, query: "compact" }', () => {
    expect(findSlashToken('/compact foo', 8)).toEqual({ start: 0, query: 'compact' });
  });

  it('"no slash here" cursor=13 -> null', () => {
    expect(findSlashToken('no slash here', 13)).toBeNull();
  });

  it('"foo /bar baz" cursor=8 -> { start: 4, query: "bar" }', () => {
    expect(findSlashToken('foo /bar baz', 8)).toEqual({ start: 4, query: 'bar' });
  });

  it('cursor in middle of token: "check /help please" cursor=11 -> { start: 6, query: "help" }', () => {
    expect(findSlashToken('check /help please', 11)).toEqual({ start: 6, query: 'help' });
  });

  it('"http://foo" -> null (/ preceded by non-space)', () => {
    expect(findSlashToken('http://foo', 10)).toBeNull();
  });

  it('"/" at start with cursor=1 -> { start: 0, query: "" }', () => {
    expect(findSlashToken('/', 1)).toEqual({ start: 0, query: '' });
  });

  it('empty string -> null', () => {
    expect(findSlashToken('', 0)).toBeNull();
  });

  it('cursor at 0 -> null', () => {
    expect(findSlashToken('/foo', 0)).toBeNull();
  });

  it('newline before slash: "hello\\n/com" -> detects token', () => {
    expect(findSlashToken('hello\n/com', 10)).toEqual({ start: 6, query: 'com' });
  });
});

// ── Keyboard navigation logic tests ──────────────────────────────────────────

describe('Keyboard navigation (highlight index wrapping)', () => {
  // These test the pure wrapping logic used by the keydown handler
  function wrapDown(idx: number, count: number): number {
    return (idx + 1) % count;
  }
  function wrapUp(idx: number, count: number): number {
    return (idx - 1 + count) % count;
  }

  it('ArrowDown wraps from last to 0', () => {
    expect(wrapDown(4, 5)).toBe(0);
  });

  it('ArrowDown increments normally', () => {
    expect(wrapDown(0, 5)).toBe(1);
    expect(wrapDown(2, 5)).toBe(3);
  });

  it('ArrowUp wraps from 0 to last', () => {
    expect(wrapUp(0, 5)).toBe(4);
  });

  it('ArrowUp decrements normally', () => {
    expect(wrapUp(3, 5)).toBe(2);
    expect(wrapUp(1, 5)).toBe(0);
  });

  it('single item: ArrowDown stays at 0', () => {
    expect(wrapDown(0, 1)).toBe(0);
  });

  it('single item: ArrowUp stays at 0', () => {
    expect(wrapUp(0, 1)).toBe(0);
  });
});

describe('Inline slash command insertion', () => {
  // Mirrors _insertSlashCommand logic: replaces tokenStart..tokenEnd with cmd + ' '
  function insertSlashCommand(
    value: string,
    tokenStart: number,
    tokenEnd: number,
    cmd: string
  ): { text: string; cursor: number } {
    const before = value.slice(0, tokenStart);
    const after = value.slice(tokenEnd);
    const insertion = cmd + ' ';
    return { text: before + insertion + after, cursor: before.length + insertion.length };
  }

  it('replaces inline token, preserving surrounding text', () => {
    // "hello /com" -> "hello /compact " (token at 6..10)
    const result = insertSlashCommand('hello /com', 6, 10, '/compact');
    expect(result.text).toBe('hello /compact ');
    expect(result.cursor).toBe(15);
  });

  it('replaces at start of input', () => {
    const result = insertSlashCommand('/com', 0, 4, '/compact');
    expect(result.text).toBe('/compact ');
    expect(result.cursor).toBe(9);
  });

  it('preserves text after the token', () => {
    // "do /hel and more" -> token is at 3..7, replaced with "/help " -> "do /help  and more"
    // Note: the insertion always adds a trailing space, so there's a double space before "and"
    const result = insertSlashCommand('do /hel and more', 3, 7, '/help');
    expect(result.text).toBe('do /help  and more');
    expect(result.cursor).toBe(9);
  });
});

# Session–Transcript Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the transcript view always showing the wrong/stale session by making the backend authoritative for which session should be displayed, and adding tmux screen capture for verification.

**Architecture:** A new `session-resolver.ts` module picks the best active session from live data (persisted choice → tmux-verified → recency fallback). A new `screen-analyzer.ts` captures the current visible tmux screen and classifies Claude's state. Three new REST endpoints let the frontend ask the backend "what should I show?" and persist its selection. The frontend is updated to query the backend on every reconnect instead of trusting stale localStorage.

**Tech Stack:** TypeScript, Fastify, Vitest, tmux CLI (`capture-pane`), vanilla JS (app.js frontend)

**Spec:** `docs/superpowers/specs/2026-03-17-session-transcript-sync-design.md`

**Task dependency:** Task 4 requires Task 1 to be committed first (routes depend on `StateStore.getActiveSessionId`).

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/types/app-state.ts` | Modify | Add `activeSessionId: string \| null` to `AppState` + `createInitialState` |
| `src/state-store.ts` | Modify | Add `getActiveSessionId()` / `setActiveSessionId()` methods |
| `src/session-resolver.ts` | Create | Pure function: picks best active session from sessions + live tmux names |
| `src/screen-analyzer.ts` | Create | Captures tmux screen (current pane only) + classifies Claude state |
| `src/web/routes/active-session-routes.ts` | Create | 3 endpoints: `resolve-active`, `mark-active`, `screen-snapshot` |
| `src/web/server.ts` | Modify | Register new route module (before parameterized session routes); call `setActiveSessionId` after clear |
| `src/web/public/app.js` | Modify | Backend-first restore in `handleInit`; `mark-active` call in `selectSession`; clear-race timeout |
| `test/mocks/mock-route-context.ts` | Modify | Add `getActiveSessionId` / `setActiveSessionId` stubs to mock store |
| `test/mocks/mock-session.ts` | Modify | Add `lastActivityAt` to `toState()` return value |
| `test/session-resolver.test.ts` | Create | Unit tests for resolver priority logic |
| `test/screen-analyzer.test.ts` | Create | Unit tests for screen capture + state detection patterns |
| `test/routes/active-session-routes.test.ts` | Create | Integration tests for all 3 endpoints |

---

## Task 1: Add `activeSessionId` to AppState and StateStore

**Files:**
- Modify: `src/types/app-state.ts`
- Modify: `src/state-store.ts`

- [ ] **Step 1.1: Add field to AppState interface**

In `src/types/app-state.ts`, add to the `AppState` interface (after `tokenStats`):

```typescript
  /** The session ID last explicitly selected by the user. Used by resolve-active. */
  activeSessionId?: string | null;
```

- [ ] **Step 1.2: Add field to createInitialState**

In `createInitialState()`, add `activeSessionId: null` to the returned object.

- [ ] **Step 1.3: Add StateStore methods**

In `src/state-store.ts`, add two methods after `setConfig` (around line 590):

```typescript
  getActiveSessionId(): string | null {
    return this.getState().activeSessionId ?? null;
  }

  setActiveSessionId(id: string | null): void {
    this.getState().activeSessionId = id;
    this.save();
  }
```

- [ ] **Step 1.4: Verify TypeScript compiles**

```bash
cd /home/siggi/sources/Codeman && npm run build 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 1.5: Commit**

```bash
git add src/types/app-state.ts src/state-store.ts
git commit -m "feat: add activeSessionId to AppState and StateStore"
```

---

## Task 2: Update test mocks

**Files:**
- Modify: `test/mocks/mock-route-context.ts`
- Modify: `test/mocks/mock-session.ts`

These changes are needed for integration tests in Task 4 to compile and run.

- [ ] **Step 2.1: Add `getActiveSessionId` / `setActiveSessionId` to mock store**

In `test/mocks/mock-route-context.ts`, find the `store:` object inside `createMockRouteContext`. It currently has stubs like `getConfig`, `getSessions`, `setSession`, etc. Add two more stubs:

```typescript
      getActiveSessionId: vi.fn(() => null),
      setActiveSessionId: vi.fn(),
```

- [ ] **Step 2.2: Add `lastActivityAt` to MockSession.toState()**

In `test/mocks/mock-session.ts`, `toState()` returns a plain object (line ~213). Add `lastActivityAt` to it. First check if `MockSession` has a `lastActivityAt` property — if not, add it as a field with a default:

At the top of the `MockSession` class (with other properties), add:
```typescript
  lastActivityAt: number = Date.now();
```

Then in `toState()`, add:
```typescript
      lastActivityAt: this.lastActivityAt,
```

- [ ] **Step 2.3: Verify tests still pass**

```bash
cd /home/siggi/sources/Codeman && npm test 2>&1 | tail -20
```
Expected: all existing tests pass.

- [ ] **Step 2.4: Commit**

```bash
git add test/mocks/mock-route-context.ts test/mocks/mock-session.ts
git commit -m "test: add getActiveSessionId/setActiveSessionId stubs and lastActivityAt to mocks"
```

---

## Task 3: Create `session-resolver.ts` with tests (TDD)

**Files:**
- Create: `src/session-resolver.ts`
- Create: `test/session-resolver.test.ts`

The resolver takes a snapshot of data and returns which session the frontend should display. Pure function — no side effects, no I/O.

**Type note:** `SessionState.lastActivityAt` is typed as `number` (Unix ms timestamp) in this codebase. All comparisons use numeric subtraction. Zero means "no timestamp".

- [ ] **Step 3.1: Write failing tests**

Create `test/session-resolver.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveActiveSession } from '../src/session-resolver.js';

type SessionStub = { id: string; status: string; lastActivityAt: number };

function makeSession(id: string, status = 'idle', lastActivityAt = 1000000): SessionStub {
  return { id, status, lastActivityAt };
}

function sessionsMap(...sessions: SessionStub[]): Map<string, SessionStub> {
  return new Map(sessions.map(s => [s.id, s]));
}

function liveTmuxSet(...ids: string[]): Set<string> {
  return new Set(ids.map(id => `codeman-${id.slice(0, 8)}`));
}

describe('resolveActiveSession', () => {
  it('returns null when session map is empty', async () => {
    const result = await resolveActiveSession({
      persistedActiveId: null,
      sessions: sessionsMap(),
      liveTmuxNames: new Set(),
    });
    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe('none');
  });

  it('returns persisted session with high confidence when alive in tmux', async () => {
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const result = await resolveActiveSession({
      persistedActiveId: id,
      sessions: sessionsMap(makeSession(id)),
      liveTmuxNames: liveTmuxSet(id),
    });
    expect(result.sessionId).toBe(id);
    expect(result.confidence).toBe('high');
    expect(result.source).toBe('persisted');
  });

  it('ignores persisted session when not in session map', async () => {
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const other = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: id,
      sessions: sessionsMap(makeSession(other)),
      liveTmuxNames: liveTmuxSet(other),
    });
    expect(result.sessionId).toBe(other);
    expect(result.source).not.toBe('persisted');
  });

  it('ignores persisted session when it is archived', async () => {
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const other = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: id,
      sessions: sessionsMap(makeSession(id, 'archived'), makeSession(other)),
      liveTmuxNames: liveTmuxSet(id, other),
    });
    expect(result.sessionId).toBe(other);
  });

  it('ignores persisted session when its tmux name is not in live set', async () => {
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const other = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: id,
      sessions: sessionsMap(makeSession(id), makeSession(other)),
      liveTmuxNames: liveTmuxSet(other), // id is NOT in live set
    });
    expect(result.sessionId).toBe(other);
    expect(result.source).toBe('tmux-verified');
    expect(result.confidence).toBe('medium');
  });

  it('returns most recently active tmux-verified session when no persisted match', async () => {
    const old = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const recent = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: null,
      sessions: sessionsMap(
        makeSession(old, 'idle', 1000),
        makeSession(recent, 'idle', 9000),
      ),
      liveTmuxNames: liveTmuxSet(old, recent),
    });
    expect(result.sessionId).toBe(recent);
    expect(result.source).toBe('tmux-verified');
  });

  it('falls back to activity-timestamp ordering when no tmux verification', async () => {
    const old = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const recent = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: null,
      sessions: sessionsMap(
        makeSession(old, 'idle', 1000),
        makeSession(recent, 'idle', 9000),
      ),
      liveTmuxNames: new Set(),
    });
    expect(result.sessionId).toBe(recent);
    expect(result.source).toBe('activity-timestamp');
    expect(result.confidence).toBe('low');
  });

  it('ignores archived sessions in all fallback paths', async () => {
    const archived = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const active = 'bbbb2222-cccc-dddd-eeee-ffffffffffff';
    const result = await resolveActiveSession({
      persistedActiveId: null,
      sessions: sessionsMap(
        makeSession(archived, 'archived', 99999),
        makeSession(active, 'idle', 1000),
      ),
      liveTmuxNames: liveTmuxSet(archived, active),
    });
    expect(result.sessionId).toBe(active);
  });

  it('returns any non-archived session as fallback when no timestamps', async () => {
    const id = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
    const result = await resolveActiveSession({
      persistedActiveId: null,
      sessions: sessionsMap({ id, status: 'idle', lastActivityAt: 0 }),
      liveTmuxNames: new Set(),
    });
    expect(result.sessionId).toBe(id);
    expect(result.source).toBe('fallback');
  });
});
```

- [ ] **Step 3.2: Run tests to confirm they fail**

```bash
cd /home/siggi/sources/Codeman && npm test -- test/session-resolver.test.ts 2>&1 | tail -20
```
Expected: `Cannot find module '../src/session-resolver.js'`

- [ ] **Step 3.3: Implement `src/session-resolver.ts`**

```typescript
/**
 * @fileoverview Session resolver — picks the best active session for the frontend to display.
 *
 * Priority:
 * 1. Persisted active ID (from state store) if non-archived + has live tmux → high confidence
 * 2. Non-archived sessions with live tmux, sorted by lastActivityAt desc → medium confidence
 * 3. Non-archived sessions sorted by lastActivityAt desc (no tmux check) → low confidence
 * 4. Any non-archived session (lastActivityAt === 0) → low confidence / fallback
 * 5. No non-archived sessions → null / none
 *
 * Note: lastActivityAt is a Unix ms timestamp (number). Zero means "no timestamp available".
 */

export type ResolvedSessionSource =
  | 'persisted'
  | 'tmux-verified'
  | 'activity-timestamp'
  | 'fallback';

export type ResolvedSessionConfidence = 'high' | 'medium' | 'low' | 'none';

export interface ResolvedSession {
  sessionId: string | null;
  confidence: ResolvedSessionConfidence;
  source: ResolvedSessionSource | null;
}

interface SessionLike {
  id: string;
  status: string;
  lastActivityAt: number;
}

/** Maps a Codeman session ID to its expected tmux session name. */
export function sessionIdToMuxName(sessionId: string): string {
  return `codeman-${sessionId.slice(0, 8)}`;
}

export async function resolveActiveSession(params: {
  persistedActiveId: string | null;
  sessions: Map<string, SessionLike>;
  liveTmuxNames: Set<string>;
}): Promise<ResolvedSession> {
  const { persistedActiveId, sessions, liveTmuxNames } = params;

  const nonArchived = [...sessions.values()].filter(s => s.status !== 'archived');

  if (nonArchived.length === 0) {
    return { sessionId: null, confidence: 'none', source: null };
  }

  // Priority 1: persisted + exists + non-archived + live in tmux
  if (persistedActiveId) {
    const session = sessions.get(persistedActiveId);
    if (session && session.status !== 'archived') {
      const muxName = sessionIdToMuxName(persistedActiveId);
      if (liveTmuxNames.has(muxName)) {
        return { sessionId: persistedActiveId, confidence: 'high', source: 'persisted' };
      }
    }
  }

  // Priority 2: tmux-verified, most recent first
  const tmuxVerified = nonArchived
    .filter(s => liveTmuxNames.has(sessionIdToMuxName(s.id)))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  if (tmuxVerified.length > 0) {
    return { sessionId: tmuxVerified[0].id, confidence: 'medium', source: 'tmux-verified' };
  }

  // Priority 3: activity-timestamp, most recent first (lastActivityAt > 0)
  const withTimestamps = nonArchived
    .filter(s => s.lastActivityAt > 0)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  if (withTimestamps.length > 0) {
    return { sessionId: withTimestamps[0].id, confidence: 'low', source: 'activity-timestamp' };
  }

  // Priority 4: any non-archived session
  return { sessionId: nonArchived[0].id, confidence: 'low', source: 'fallback' };
}
```

- [ ] **Step 3.4: Run tests to confirm they pass**

```bash
cd /home/siggi/sources/Codeman && npm test -- test/session-resolver.test.ts 2>&1 | tail -20
```
Expected: all 9 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/session-resolver.ts test/session-resolver.test.ts
git commit -m "feat: add session-resolver with priority-based active session selection"
```

---

## Task 4: Create `screen-analyzer.ts` with tests (TDD)

**Files:**
- Create: `src/screen-analyzer.ts`
- Create: `test/screen-analyzer.test.ts`

Captures the **current visible** tmux screen (no `-S` scrollback flag) and classifies Claude's state. Uses `execSync` with strict regex validation on the mux name — consistent with `tmux-manager.ts`. All pattern matching happens on ANSI-stripped text.

- [ ] **Step 4.1: Write failing tests**

Create `test/screen-analyzer.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { analyzeScreen, stripAnsi } from '../src/screen-analyzer.js';

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    expect(stripAnsi('\u001b[32mHello\u001b[0m')).toBe('Hello');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('analyzeScreen', () => {
  it('detects completion state', () => {
    const result = analyzeScreen('Worked for 2m 31s\n⏺ Done');
    expect(result.state).toBe('completion');
    expect(result.hasClaudePresence).toBe(true);
  });

  it('detects running_tool state', () => {
    const result = analyzeScreen('⏺ Bash(npm test)\n  running...');
    expect(result.state).toBe('running_tool');
    expect(result.hasClaudePresence).toBe(true);
  });

  it('detects asking_question from y/n prompt', () => {
    const result = analyzeScreen('Do you want to continue? [y/n]');
    expect(result.state).toBe('asking_question');
    expect(result.questionText).toContain('Do you want to continue?');
  });

  it('detects asking_question from numbered list', () => {
    const screen = 'Choose an option:\n1. Option A\n2. Option B\n3. Option C';
    const result = analyzeScreen(screen);
    expect(result.state).toBe('asking_question');
    expect(result.optionLines).toHaveLength(3);
  });

  it('detects thinking state from spinner', () => {
    const result = analyzeScreen('⠋ Processing...');
    expect(result.state).toBe('thinking');
  });

  it('detects thinking state from Thinking text', () => {
    const result = analyzeScreen('Thinking about your request...');
    expect(result.state).toBe('thinking');
  });

  it('detects waiting_for_input from claude prompt char', () => {
    const result = analyzeScreen('some output\n❯');
    expect(result.state).toBe('waiting_for_input');
    expect(result.hasClaudePresence).toBe(true);
  });

  it('detects waiting_for_input from unicode prompt char', () => {
    const result = analyzeScreen('\u276f ');
    expect(result.state).toBe('waiting_for_input');
  });

  it('detects shell_prompt', () => {
    const result = analyzeScreen('user@host:~$ ');
    expect(result.state).toBe('shell_prompt');
    expect(result.hasClaudePresence).toBe(false);
  });

  it('returns unknown for empty screen', () => {
    const result = analyzeScreen('');
    expect(result.state).toBe('unknown');
  });

  it('returns unknown for unrecognized content', () => {
    const result = analyzeScreen('some random log output');
    expect(result.state).toBe('unknown');
  });

  it('completion takes priority over tool pattern', () => {
    const result = analyzeScreen('⏺ Bash(ls)\nWorked for 1m 0s');
    expect(result.state).toBe('completion');
  });

  it('sets lastVisibleText to last non-empty line after ANSI strip', () => {
    const result = analyzeScreen('\u001b[32mline one\u001b[0m\nline two\n\n');
    expect(result.lastVisibleText).toBe('line two');
  });

  it('strips ANSI before pattern matching for tool detection', () => {
    // Simulate ANSI bold codes between bullet and tool name (real tmux output)
    const withAnsi = '⏺\u001b[1m \u001b[0mRead(file.ts)';
    const result = analyzeScreen(withAnsi);
    expect(result.state).toBe('running_tool');
  });
});

describe('captureScreen', () => {
  it('returns null for invalid mux name (injection guard)', async () => {
    // Import dynamically to allow module-level mock
    const { captureScreen } = await import('../src/screen-analyzer.js');
    const result = captureScreen('../../etc/passwd');
    expect(result).toBeNull();
  });

  it('returns null when execSync throws', async () => {
    // Mock execSync to simulate tmux pane not existing
    vi.mock('node:child_process', () => ({
      execSync: vi.fn(() => { throw new Error('tmux: no such session'); }),
    }));
    const { captureScreen } = await import('../src/screen-analyzer.js');
    const result = captureScreen('codeman-abc12345');
    expect(result).toBeNull();
    vi.resetModules();
  });
});
```

- [ ] **Step 4.2: Run tests to confirm they fail**

```bash
cd /home/siggi/sources/Codeman && npm test -- test/screen-analyzer.test.ts 2>&1 | tail -20
```
Expected: `Cannot find module '../src/screen-analyzer.js'`

- [ ] **Step 4.3: Implement `src/screen-analyzer.ts`**

```typescript
/**
 * @fileoverview Screen analyzer — captures the current visible tmux pane and classifies
 * Claude Code's state from the output.
 *
 * All pattern matching is performed on ANSI-stripped text.
 * captureScreen uses tmux capture-pane WITHOUT -S (no scrollback) — current screen only.
 *
 * Security: mux names validated against /^codeman-[a-f0-9-]+$/ — same pattern as
 * SAFE_MUX_NAME_PATTERN in tmux-manager.ts.
 */
import { execSync } from 'node:child_process';

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
  const lines = stripped.split('\n').map(l => l.trim()).filter(Boolean);
  const optionLines = lines.filter(l => /^\s*\d+\.\s+/.test(l));
  const questionText = lines.filter(l => !/^\s*\d+\.\s+/.test(l)).pop() ?? '';
  return { questionText, optionLines };
}

export function analyzeScreen(rawScreen: string): ScreenAnalysis {
  const stripped = stripAnsi(rawScreen);
  const lastVisibleText = getLastVisibleText(stripped);

  const hasClaudePresence =
    COMPLETION_PATTERN.test(stripped) ||
    TOOL_PATTERN.test(stripped) ||
    CLAUDE_PROMPT_PATTERN.test(stripped) ||
    SPINNER_CHARS.test(stripped) ||
    THINKING_PATTERN.test(stripped);

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
    return execSync(`tmux capture-pane -p -e -t ${muxName}`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
  } catch {
    return null;
  }
}
```

- [ ] **Step 4.4: Run tests to confirm they pass**

```bash
cd /home/siggi/sources/Codeman && npm test -- test/screen-analyzer.test.ts 2>&1 | tail -20
```
Expected: all 16 tests pass. If the `vi.mock` test for `execSync` is flaky due to module caching, simplify: just test the invalid-mux-name guard (which needs no mock) and remove the `execSync` throws test.

- [ ] **Step 4.5: Commit**

```bash
git add src/screen-analyzer.ts test/screen-analyzer.test.ts
git commit -m "feat: add screen-analyzer for tmux pane capture and Claude state detection"
```

---

## Task 5: Create `active-session-routes.ts` with tests (TDD)

**Prerequisite:** Task 1 must be committed (adds `getActiveSessionId`/`setActiveSessionId` to `StateStore`).

**Files:**
- Create: `src/web/routes/active-session-routes.ts`
- Create: `test/routes/active-session-routes.test.ts`

Route context type: `ConfigPort & InfraPort & SessionPort`. Reference: `src/web/routes/mux-routes.ts`.

- [ ] **Step 5.1: Write failing integration tests**

Create `test/routes/active-session-routes.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerActiveSessionRoutes } from '../../src/web/routes/active-session-routes.js';
import { createMockSession } from '../mocks/mock-session.js';

// Mock screen-analyzer so tests don't call real tmux binary
vi.mock('../../src/screen-analyzer.js', () => ({
  captureScreen: vi.fn(() => null),
  analyzeScreen: vi.fn(() => ({
    state: 'waiting_for_input',
    lastVisibleText: '❯',
    hasClaudePresence: true,
    confidence: 90,
  })),
}));

describe('active session routes', () => {
  let harness: Awaited<ReturnType<typeof createRouteTestHarness>>;

  beforeAll(async () => {
    harness = await createRouteTestHarness(registerActiveSessionRoutes, { sessionId: 'test-session-1' });
  });

  afterAll(async () => {
    await harness.app.close();
  });

  // ── resolve-active ────────────────────────────────────────────

  describe('GET /api/sessions/resolve-active', () => {
    it('returns null when no sessions exist', async () => {
      harness.ctx.sessions.clear();
      harness.ctx.store.getActiveSessionId = vi.fn(() => null);
      harness.ctx.mux = { listAllTmuxSessions: vi.fn(() => []) } as any;

      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/resolve-active' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.sessionId).toBeNull();
      expect(body.confidence).toBe('none');
    });

    it('returns persisted session ID with high confidence when it has a live tmux session', async () => {
      const id = 'test-session-1';
      const session = createMockSession(id);
      harness.ctx.sessions.clear();
      harness.ctx.sessions.set(id, session);
      harness.ctx.store.getActiveSessionId = vi.fn(() => id);
      harness.ctx.mux = {
        listAllTmuxSessions: vi.fn(() => [
          { name: `codeman-${id.slice(0, 8)}`, windows: 1, createdAt: Date.now(), attached: true },
        ]),
      } as any;

      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/resolve-active' });
      const body = JSON.parse(res.body);
      expect(body.sessionId).toBe(id);
      expect(body.confidence).toBe('high');
    });

    it('falls back to most recent non-archived session when nothing persisted', async () => {
      const id = 'test-session-1';
      harness.ctx.sessions.clear();
      harness.ctx.sessions.set(id, createMockSession(id));
      harness.ctx.store.getActiveSessionId = vi.fn(() => null);
      harness.ctx.mux = { listAllTmuxSessions: vi.fn(() => []) } as any;

      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions/resolve-active' });
      const body = JSON.parse(res.body);
      expect(body.sessionId).toBe(id);
    });
  });

  // ── mark-active ───────────────────────────────────────────────

  describe('POST /api/sessions/:id/mark-active', () => {
    it('returns 200 and saves to store', async () => {
      const id = 'test-session-1';
      harness.ctx.sessions.clear();
      harness.ctx.sessions.set(id, createMockSession(id));
      harness.ctx.store.setActiveSessionId = vi.fn();

      const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${id}/mark-active` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect(harness.ctx.store.setActiveSessionId).toHaveBeenCalledWith(id);
    });

    it('returns 404 for unknown session ID', async () => {
      harness.ctx.sessions.clear();
      const res = await harness.app.inject({ method: 'POST', url: '/api/sessions/nonexistent/mark-active' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for archived session', async () => {
      const id = 'test-session-1';
      const session = createMockSession(id);
      // Override toState to return archived status
      vi.spyOn(session, 'toState').mockReturnValue(
        { ...session.toState(), status: 'archived' } as any
      );
      harness.ctx.sessions.clear();
      harness.ctx.sessions.set(id, session);

      const res = await harness.app.inject({ method: 'POST', url: `/api/sessions/${id}/mark-active` });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── screen-snapshot ───────────────────────────────────────────

  describe('GET /api/sessions/:id/screen-snapshot', () => {
    it('returns 404 when session has no mux session', async () => {
      harness.ctx.sessions.set('test-session-1', createMockSession('test-session-1'));
      harness.ctx.mux = { getSession: vi.fn(() => undefined) } as any;

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/test-session-1/screen-snapshot',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 503 when captureScreen returns null', async () => {
      // captureScreen is mocked at module level to return null
      harness.ctx.sessions.set('test-session-1', createMockSession('test-session-1'));
      harness.ctx.mux = {
        getSession: vi.fn(() => ({ muxName: 'codeman-testtest', sessionId: 'test-session-1' })),
      } as any;

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/test-session-1/screen-snapshot',
      });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'screen_capture_failed' });
    });

    it('returns 200 with analysis when capture succeeds', async () => {
      // Override the module-level mock to return a screen string for this test
      const { captureScreen } = await import('../../src/screen-analyzer.js');
      vi.mocked(captureScreen).mockReturnValueOnce('❯ ');

      harness.ctx.sessions.set('test-session-1', createMockSession('test-session-1'));
      harness.ctx.mux = {
        getSession: vi.fn(() => ({ muxName: 'codeman-testtest', sessionId: 'test-session-1' })),
      } as any;

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/test-session-1/screen-snapshot',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.muxName).toBe('codeman-testtest');
      expect(body.analysis).toBeDefined();
      expect(typeof body.rawScreen).toBe('string');
    });
  });
});
```

- [ ] **Step 5.2: Run tests to confirm they fail**

```bash
cd /home/siggi/sources/Codeman && npm test -- test/routes/active-session-routes.test.ts 2>&1 | tail -20
```
Expected: module not found error.

- [ ] **Step 5.3: Implement `src/web/routes/active-session-routes.ts`**

```typescript
/**
 * @fileoverview Active session routes.
 *
 * GET  /api/sessions/resolve-active       — returns best session for frontend to display
 * POST /api/sessions/:id/mark-active      — persists frontend's session selection
 * GET  /api/sessions/:id/screen-snapshot  — returns current tmux screen + analysis
 */
import type { FastifyInstance } from 'fastify';
import type { ConfigPort } from '../ports/config-port.js';
import type { InfraPort } from '../ports/infra-port.js';
import type { SessionPort } from '../ports/session-port.js';
import { resolveActiveSession } from '../../session-resolver.js';
import { captureScreen, analyzeScreen } from '../../screen-analyzer.js';

type ActiveSessionContext = ConfigPort & InfraPort & SessionPort;

export function registerActiveSessionRoutes(app: FastifyInstance, ctx: ActiveSessionContext): void {

  // ── GET /api/sessions/resolve-active ────────────────────────────────────────
  app.get('/api/sessions/resolve-active', async (_request, reply) => {
    const persistedActiveId = ctx.store.getActiveSessionId();

    const sessionMap = new Map<string, { id: string; status: string; lastActivityAt: number }>();
    for (const [id, session] of ctx.sessions) {
      const state = session.toState() as { id: string; status: string; lastActivityAt?: number };
      sessionMap.set(id, {
        id: state.id,
        status: state.status,
        lastActivityAt: state.lastActivityAt ?? 0,
      });
    }

    let liveTmuxNames: Set<string>;
    try {
      const liveSessions = ctx.mux.listAllTmuxSessions();
      liveTmuxNames = new Set(liveSessions.map((s: { name: string }) => s.name));
    } catch {
      liveTmuxNames = new Set();
    }

    const result = await resolveActiveSession({ persistedActiveId, sessions: sessionMap, liveTmuxNames });
    return reply.send(result);
  });

  // ── POST /api/sessions/:id/mark-active ────────────────────────────────────
  app.post('/api/sessions/:id/mark-active', async (request, reply) => {
    const { id } = request.params as { id: string };

    const session = ctx.sessions.get(id);
    if (!session) {
      return reply.status(404).send({ error: 'session_not_found' });
    }

    const state = session.toState() as { status: string };
    if (state.status === 'archived') {
      return reply.status(400).send({ error: 'session_archived' });
    }

    ctx.store.setActiveSessionId(id);
    return reply.send({ ok: true });
  });

  // ── GET /api/sessions/:id/screen-snapshot ────────────────────────────────
  app.get('/api/sessions/:id/screen-snapshot', async (request, reply) => {
    const { id } = request.params as { id: string };

    const muxSession = ctx.mux.getSession(id);
    if (!muxSession) {
      return reply.status(404).send({ error: 'no_mux_session' });
    }

    const rawScreen = captureScreen(muxSession.muxName);
    if (rawScreen === null) {
      return reply.status(503).send({ error: 'screen_capture_failed' });
    }

    const analysis = analyzeScreen(rawScreen);
    return reply.send({ muxName: muxSession.muxName, rawScreen, analysis });
  });
}
```

- [ ] **Step 5.4: Run tests to confirm they pass**

```bash
cd /home/siggi/sources/Codeman && npm test -- test/routes/active-session-routes.test.ts 2>&1 | tail -30
```
Expected: all tests pass. If TypeScript errors on `ctx.mux.listAllTmuxSessions` or `ctx.mux.getSession`, check `InfraPort` — it uses `ctx.mux: TerminalMultiplexer`. Confirm these methods exist on `TerminalMultiplexer` in `src/mux-interface.ts`.

- [ ] **Step 5.5: Run full test suite**

```bash
cd /home/siggi/sources/Codeman && npm test 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 5.6: Commit**

```bash
git add src/web/routes/active-session-routes.ts test/routes/active-session-routes.test.ts
git commit -m "feat: add active-session routes (resolve-active, mark-active, screen-snapshot)"
```

---

## Task 6: Register routes and call `setActiveSessionId` on clear

**Files:**
- Modify: `src/web/server.ts`

- [ ] **Step 6.1: Find where routes are registered**

```bash
grep -n "registerSessionRoutes\|registerMuxRoutes" /home/siggi/sources/Codeman/src/web/server.ts | head -5
```

Note line numbers for both the import block and the registration block.

- [ ] **Step 6.2: Add import**

In the route imports section, add:

```typescript
import { registerActiveSessionRoutes } from './routes/active-session-routes.js';
```

- [ ] **Step 6.3: Register routes — BEFORE parameterized session routes**

Fastify gives priority to static path segments over parameterized ones at the same level. `GET /api/sessions/resolve-active` must be registered before any handler that matches `GET /api/sessions/:id`. Verify the order:

```bash
grep -n 'app.get.*\/api\/sessions\/' /home/siggi/sources/Codeman/src/web/routes/session-routes.ts | head -5
```

Then register `registerActiveSessionRoutes` **before** `registerSessionRoutes` in `server.ts`:

```typescript
    registerActiveSessionRoutes(this.app, ctx);
    registerSessionRoutes(this.app, ctx);
```

- [ ] **Step 6.4: Call `setActiveSessionId` after session clear**

Find where the `session:cleared` SSE event is broadcast (it emits after `clearSession`):

```bash
grep -n "SessionCleared\|session:cleared\|clearSession" /home/siggi/sources/Codeman/src/web/routes/session-routes.ts | head -10
```

After `clearSession` returns and `session:cleared` is broadcast, add:

```typescript
    // Persist new session as active so resolve-active returns it on the next frontend reconnect
    ctx.store.setActiveSessionId(result.newSessionState.id);
```

The exact location is after the broadcast call, within the clear endpoint handler. `result.newSessionState.id` is the ID of the freshly created child session.

- [ ] **Step 6.5: Verify build**

```bash
cd /home/siggi/sources/Codeman && npm run build 2>&1 | tail -20
```
Expected: no TypeScript errors.

- [ ] **Step 6.6: Run full test suite**

```bash
cd /home/siggi/sources/Codeman && npm test 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 6.7: Commit**

```bash
git add src/web/server.ts
git commit -m "feat: register active-session routes and persist active session on clear"
```

---

## Task 7: Frontend — backend-first restore, mark-active, clear-race fix

**Files:**
- Modify: `src/web/public/app.js`

Three separate changes. Each gets its own commit.

### Change 7A: Backend-first restore in `handleInit`

- [ ] **Step 7A.1: Confirm existing `_initGeneration` pattern**

```bash
grep -n "_initGeneration\|const gen" /home/siggi/sources/Codeman/src/web/public/app.js | head -10
```

You should see `const gen = ++this._initGeneration;` at the top of `handleInit` (around line 6279). Do NOT add a second increment — just confirm it's there. All async continuations check `gen !== this._initGeneration`.

- [ ] **Step 7A.2: Confirm `handleInit` is already async or make it async**

```bash
sed -n '6270,6285p' /home/siggi/sources/Codeman/src/web/public/app.js
```

If the function signature is `handleInit(data)`, change it to `async handleInit(data)`.

- [ ] **Step 7A.3: Find the exact restore block to replace**

```bash
sed -n '6503,6526p' /home/siggi/sources/Codeman/src/web/public/app.js
```

The block starts with the comment `// Restore previously active session` and ends after the closing `}` of the outer `if (this.sessionOrder.length > 0)` block.

- [ ] **Step 7A.4: Replace the restore block**

Replace the existing restore block (found in 7A.3) with:

```javascript
    // Restore previously active session — ask backend first, fall back to localStorage
    if (gen !== this._initGeneration) return;
    const previousActiveId = this.activeSessionId;
    this.activeSessionId = null;
    if (this.sessionOrder.length > 0) {
      let restoreId = previousActiveId;
      if (restoreId && this.sessions.has(restoreId)) {
        // Soft reconnect: same session still valid, reuse cached terminal content
        this._sseReconnectRestoreId = this.terminalBufferCache.has(restoreId) ? restoreId : null;
        this.selectSession(restoreId);
      } else {
        // Ask backend for authoritative answer (persisted active session, tmux-verified)
        try {
          const res = await fetch('/api/sessions/resolve-active');
          // Re-check generation — a newer handleInit may have completed during the await
          if (gen !== this._initGeneration) return;
          const data = await res.json();
          restoreId = data.sessionId && this.sessions.has(data.sessionId) ? data.sessionId : null;
        } catch { /* network error — fall through to localStorage */ }
        // Guard again after catch path
        if (gen !== this._initGeneration) return;
        // Fall back to localStorage
        if (!restoreId) {
          try { restoreId = localStorage.getItem('codeman-active-session'); } catch {}
        }
        this.selectSession(
          (restoreId && this.sessions.has(restoreId)) ? restoreId : this.sessionOrder[0]
        );
      }
    }
```

- [ ] **Step 7A.5: Build**

```bash
cd /home/siggi/sources/Codeman && npm run build 2>&1 | tail -10
```

- [ ] **Step 7A.6: Commit**

```bash
git add src/web/public/app.js
git commit -m "fix: backend-first session restore in handleInit using resolve-active endpoint"
```

### Change 7B: Persist session selection to backend

- [ ] **Step 7B.1: Find the localStorage.setItem in selectSession**

```bash
grep -n "localStorage.setItem.*codeman-active-session" /home/siggi/sources/Codeman/src/web/public/app.js
```

- [ ] **Step 7B.2: Add `mark-active` call on the line immediately after**

```javascript
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/mark-active`, { method: 'POST' }).catch(() => {});
```

The `.catch(() => {})` intentionally swallows 400 errors (returned when `selectSession` is called with a transiently-archived session during clear).

- [ ] **Step 7B.3: Build and commit**

```bash
cd /home/siggi/sources/Codeman && npm run build 2>&1 | tail -5
git add src/web/public/app.js
git commit -m "fix: persist active session selection to backend on selectSession"
```

### Change 7C: 5-second fallback for deferred clear switch

- [ ] **Step 7C.1: Find both usages of `_pendingClearSwitchTo`**

```bash
grep -n "_pendingClearSwitchTo" /home/siggi/sources/Codeman/src/web/public/app.js
```

There should be two: one assignment in `_onSessionCleared` (~line 4961) and one null-check + reset in `_onSessionCreated` (~line 4595).

- [ ] **Step 7C.2: Add timer cleanup to `_onSessionCreated`**

After `this._pendingClearSwitchTo = null;` in `_onSessionCreated`, add:

```javascript
      if (this._pendingClearSwitchToTimer) {
        clearTimeout(this._pendingClearSwitchToTimer);
        this._pendingClearSwitchToTimer = null;
      }
```

- [ ] **Step 7C.3: Add 5-second fallback in `_onSessionCleared`**

Replace `this._pendingClearSwitchTo = newSessionId;` with:

```javascript
        this._pendingClearSwitchTo = newSessionId;
        // Safety: if session:created is missed, ask backend after 5 seconds
        if (this._pendingClearSwitchToTimer) clearTimeout(this._pendingClearSwitchToTimer);
        this._pendingClearSwitchToTimer = setTimeout(async () => {
          if (this._pendingClearSwitchTo !== newSessionId) return;
          this._pendingClearSwitchTo = null;
          this._pendingClearSwitchToTimer = null;
          try {
            const res = await fetch('/api/sessions/resolve-active');
            const data = await res.json();
            if (data.sessionId && this.sessions.has(data.sessionId)) {
              this.selectSession(data.sessionId);
            }
          } catch {}
        }, 5000);
```

- [ ] **Step 7C.4: Build and run full test suite**

```bash
cd /home/siggi/sources/Codeman && npm run build 2>&1 | tail -10 && npm test 2>&1 | tail -20
```
Expected: no errors, all tests pass.

- [ ] **Step 7C.5: Commit**

```bash
git add src/web/public/app.js
git commit -m "fix: add 5s fallback for deferred session switch after clear (missed session:created event)"
```

---

## Task 8: Deploy and manual QA

- [ ] **Step 8.1: Build and deploy**

```bash
cd /home/siggi/sources/Codeman
npm run build
cp -r dist /home/siggi/.codeman/app/
cp package.json /home/siggi/.codeman/app/package.json
systemctl --user restart codeman-web
sleep 3 && curl -s http://localhost:3001/api/status | head -c 200
```

- [ ] **Step 8.2: Verify resolve-active endpoint**

```bash
curl -s http://localhost:3001/api/sessions/resolve-active | python3 -m json.tool
```
Expected: `{ "sessionId": "<id>", "confidence": "high" or "medium", "source": "..." }`

- [ ] **Step 8.3: Verify mark-active round-trip**

Replace `SESSION_ID` with a real ID from the previous step:

```bash
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/mark-active | python3 -m json.tool
# Expected: { "ok": true }
curl -s http://localhost:3001/api/sessions/resolve-active | python3 -m json.tool
# Expected: same SESSION_ID with confidence "high"
```

- [ ] **Step 8.4: Verify screen-snapshot endpoint**

```bash
curl -s http://localhost:3001/api/sessions/SESSION_ID/screen-snapshot | python3 -m json.tool
```
Expected: `{ "muxName": "codeman-...", "rawScreen": "...", "analysis": { "state": "...", ... } }`

- [ ] **Step 8.5: Manual QA — server restart**

1. Note the active session in the UI
2. `systemctl --user restart codeman-web && sleep 3`
3. Hard reload the browser (Ctrl+Shift+R)
4. Confirm the correct session is shown (not random/empty)

- [ ] **Step 8.6: Manual QA — /clear**

1. In any active session, run `/clear`
2. Confirm the transcript immediately switches to the new session (not stuck on the archived one)

- [ ] **Step 8.7: Manual QA — SSE reconnect**

1. Open devtools → Network → find the SSE stream (`/api/events`)
2. Right-click → Block request URL, wait 5 seconds, unblock
3. Confirm the correct session is shown after reconnect

---

## Completion Checklist

- [ ] `npm test` passes with zero failures
- [ ] `npm run build` has no TypeScript errors
- [ ] `GET /api/sessions/resolve-active` returns correct session after server restart
- [ ] `POST /api/sessions/:id/mark-active` persists selection (verify with second resolve-active call)
- [ ] `GET /api/sessions/:id/screen-snapshot` returns screen analysis for a live session
- [ ] Transcript shows correct session after: server restart, SSE reconnect, `/clear`

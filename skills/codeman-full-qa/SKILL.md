---
name: codeman-full-qa
description: Full autonomous QA pipeline for a Codeman worktree. Runs Opus code review, fixes issues, re-reviews, analyzes and updates documentation, analyzes test gaps, writes tests, reviews tests, and produces a clean commit. Triggers on "full QA", "run QA", "review and fix", "polish this worktree", "QA pass".
---

# Codeman Full QA

## Overview

Single-invocation skill that runs a complete quality assurance pipeline on the current worktree branch. Dispatches fresh subagents for each phase. Designed to be the last thing you run before merge-prep.

**Invoke with:** `/codeman-full-qa` or "run full QA on this worktree"

**What it does (in order):**
1. Code review (Opus subagent) — deep review of all changes vs master
2. Fix — address all Critical and Important issues found
3. Re-review (Opus subagent) — verify fixes, catch anything new
4. Fix round 2 — address remaining issues (if any)
5. Documentation analysis & update — check if docs need updating, do it
6. Test gap analysis — identify missing test coverage
7. Test writing — fill the gaps
8. Test review (Opus subagent) — verify test quality
9. Test fix — address test review feedback (if any)
10. Final QA gate — typecheck, lint, run tests
11. Clean commit — bundle all QA work into a single commit

**Safety:** Max 2 code review cycles, max 2 test review cycles. If issues persist after limits, commits with `[NEEDS REVIEW]` prefix.

---

## Step 0 — Gather Context

```bash
git log master..HEAD --oneline
git diff master..HEAD --stat
git diff master..HEAD --name-only
git status --short
```

Capture:
- `BRANCH_NAME` — current branch
- `CHANGED_FILES` — files changed vs master
- `BASE_SHA` — merge-base with master
- `HEAD_SHA` — current HEAD
- `COMMIT_LOG` — oneline log of branch commits

Read `TASK.md` if present for task context.

Initialize tracking variables:
```
review_cycle = 0
test_review_cycle = 0
MAX_REVIEW_CYCLES = 2
MAX_TEST_REVIEW_CYCLES = 2
```

---

## Step 1 — Code Review (Opus Subagent)

Dispatch a fresh **Opus** subagent:

```
Agent tool (model: "opus", subagent_type: "superpowers:code-reviewer"):

"You are a senior code reviewer performing a thorough review of a feature branch.

## Context
Branch: {BRANCH_NAME}
Commits: {COMMIT_LOG}
Task context: {TASK.md summary or 'No TASK.md found'}

## Git Range
Base: {BASE_SHA}
Head: {HEAD_SHA}

Run these commands to see the changes:
```bash
git diff {BASE_SHA}..{HEAD_SHA}
git diff {BASE_SHA}..{HEAD_SHA} --stat
```

## Review Checklist

**Correctness:**
- Does the code do what it claims? Trace the logic path.
- Are there off-by-one errors, null/undefined risks, race conditions?
- Are error paths handled? What happens when things fail?

**Architecture & Design:**
- Clean separation of concerns? Each file/function has one job?
- Are abstractions at the right level — not too early, not too late?
- Does this fit the existing codebase patterns or introduce unnecessary divergence?
- Any hidden coupling or circular dependencies?

**Security:**
- Input validation at system boundaries?
- No SQL injection, XSS, command injection, path traversal risks?
- Secrets/credentials not hardcoded or logged?
- Auth/authz checks present where needed?

**Performance:**
- Any N+1 queries, unbounded loops, or memory leaks?
- Are large datasets paginated or streamed?
- Unnecessary re-renders or recomputations in UI code?

**TypeScript Strictness:**
- No `any` types (implicit or explicit) without justification?
- Proper null checks? No non-null assertions (`!`) hiding real issues?
- Unused imports, variables, or parameters?

**Edge Cases:**
- Empty arrays, null inputs, zero-length strings?
- Concurrent access, timeout scenarios?
- What happens at boundaries (first item, last item, max size)?

**Code Clarity:**
- Could a new team member understand this without explanation?
- Are variable/function names descriptive and consistent?
- Any dead code, commented-out code, or TODO comments that should be addressed?

## Output Format

### Strengths
[Specific things done well — file:line references]

### Issues

#### Critical (Must Fix Before Merge)
[Bugs, security vulnerabilities, data loss risks, broken functionality]

#### Important (Should Fix)
[Logic errors, missing error handling, architectural problems, test gaps, TypeScript strictness violations]

#### Minor (Nice to Have)
[Style, naming, small optimizations, documentation gaps]

**For each issue provide:**
- File:line reference
- What is wrong (specific, not vague)
- Why it matters (impact)
- How to fix (concrete suggestion)

### Assessment
**Ready to merge?** [Yes / With fixes / No]
**Confidence:** [High / Medium / Low]
**Summary:** [1-2 sentence technical assessment]

## Rules
- Be thorough but fair — severity must match actual impact
- Every issue needs a file:line reference — no vague feedback
- 'Looks good' is not a review — always dig into the diff
- Acknowledge genuinely good work
- Do NOT modify any files — review only
- Write your full review to stdout (do not create files)"
```

Parse the subagent's response:
- If **no Critical or Important issues** → skip to Step 3 (Documentation)
- If **Critical or Important issues found** → proceed to Step 2

---

## Step 2 — Fix Issues

Increment `review_cycle`.

If `review_cycle > MAX_REVIEW_CYCLES`:
- Commit with `[NEEDS REVIEW]` prefix and stop (jump to Step 10 with warning)

Otherwise, dispatch a fresh subagent:

```
Agent tool:

"You are a code fixer for an autonomous QA pipeline.

## Review Findings
{paste the Critical and Important issues from Step 1/Step 2b}

## Your Job
1. Read each issue carefully — understand the file:line reference and the suggested fix.
2. Fix each Critical issue. Fix each Important issue.
3. Do NOT fix Minor issues — they are informational only.
4. Do NOT refactor unrelated code, add features, or 'improve' things not flagged.
5. Do NOT add comments explaining your fixes unless the logic is genuinely non-obvious.
6. Run `tsc --noEmit` after all fixes to verify no type errors introduced.
7. Run `npm run lint` to verify no lint errors introduced.

Stay minimal and focused. Fix exactly what was flagged, nothing more."
```

After the fix subagent completes → proceed to Step 2b (re-review).

### Step 2b — Re-Review (Opus Subagent)

Dispatch the same Opus review prompt as Step 1, but with updated HEAD_SHA and this addition:

```
"This is re-review round {review_cycle}. Prior review found these issues:
{summary of prior issues}

Focus on:
1. Were all prior Critical and Important issues actually fixed?
2. Did the fixes introduce any NEW issues?
3. Any remaining concerns?

If all prior issues are resolved and no new Critical/Important issues exist, mark as ready."
```

Parse response:
- If **no Critical or Important issues** → proceed to Step 3
- If **issues remain** → loop back to Step 2 (increment cycle)

---

## Step 3 — Documentation Analysis & Update

Dispatch a fresh subagent:

```
Agent tool:

"You are a documentation analyst for an autonomous QA pipeline.

## Changed Files
{CHANGED_FILES list}

## Branch Commits
{COMMIT_LOG}

## Task Context
{TASK.md summary or 'none'}

## Your Job

1. Read the changed files and understand what was added or modified.

2. Check each documentation touchpoint:

   **README.md** — Does it mention features/setup that changed? If so, update it.

   **API docs** — Were routes in `src/web/routes/` changed? If new endpoints were added or existing ones modified, update any API documentation.

   **Inline JSDoc/TSDoc** — Were public functions added or had their signatures changed? Add/update JSDoc only for public API functions (not internal helpers).

   **TASK.md** — If present, do NOT modify it.
   **CLAUDE.md** — Do NOT modify it.

3. Rules:
   - Only update docs that are ACTUALLY stale due to the changes on this branch
   - Do not add documentation for unchanged code
   - Do not create new documentation files unless a significant new feature was added with no docs
   - Keep doc updates minimal and accurate
   - If nothing needs updating, just report 'No documentation updates needed' and make no changes

4. Report what you updated (or that nothing was needed)."
```

Proceed to Step 4 regardless of outcome.

---

## Step 4 — Test Gap Analysis

Dispatch a fresh subagent:

```
Agent tool:

"You are a test gap analyst for an autonomous QA pipeline.

## Changed Files (vs master)
{CHANGED_FILES}

## Your Job

1. For each changed source file (exclude test files, docs, config, TASK.md, CLAUDE.md):
   - Check if a corresponding test file exists in `test/`
   - If tests exist, read them — do they cover the NEW or CHANGED code?
   - A gap exists when: new functions lack tests, new endpoints lack route tests, changed logic branches are untested, error paths are uncovered

2. Read existing test files in `test/` to understand the project's testing patterns:
   - Framework (vitest, jest, etc.)
   - Assertion style
   - Test file naming convention
   - Helper utilities (e.g., route test utils)
   - Port allocation patterns

3. Output your findings:

### Test Gaps Found
[List each gap: source file, what's untested, what kind of test is needed]

### No Gaps
[If all changed code has adequate coverage, say so]

### Testing Patterns
[Brief summary of project test conventions for the test writer to follow]

Do NOT write any tests. Analysis only. Do NOT modify any files."
```

Parse response:
- If **no gaps** → skip to Step 7 (Final QA Gate)
- If **gaps found** → proceed to Step 5

---

## Step 5 — Test Writing

Dispatch a fresh subagent:

```
Agent tool:

"You are a test writer for an autonomous QA pipeline.

## Test Gaps to Fill
{paste gaps from Step 4}

## Testing Patterns
{paste patterns from Step 4}

## Your Job
1. Write tests that fill each identified gap.
2. Match the project's existing test patterns EXACTLY — naming, structure, assertions, imports.
3. One well-named test per behaviour. Do not over-engineer.
4. Cover: happy path, one error case, one edge case per gap.
5. Run each test file after writing: `npx vitest run test/<file>.test.ts`
   - If tests fail due to YOUR test code: fix the test.
   - If tests fail due to implementation bugs: document the failure but proceed.
6. Do NOT refactor existing tests.
7. Do NOT run the full test suite — only run specific test files.

Report what you wrote and test results."
```

Proceed to Step 6.

---

## Step 6 — Test Review (Opus Subagent)

Increment `test_review_cycle`.

If `test_review_cycle > MAX_TEST_REVIEW_CYCLES`:
- Proceed to Step 7 with whatever tests exist (note in commit message)

Dispatch a fresh **Opus** subagent:

```
Agent tool (model: "opus"):

"You are a test quality reviewer for an autonomous QA pipeline.

## New/Modified Test Files
```bash
git diff HEAD --name-only -- test/
git diff HEAD -- test/
```

## Test Gaps That Were Addressed
{paste gaps from Step 4}

## Review Checklist
For each new test:
- **Coverage**: Does it actually test the gap it claims to address?
- **Correctness**: Does the assertion verify real behaviour, not just that code runs without throwing?
- **Realism**: Are test inputs realistic? Do mocks reflect production scenarios?
- **Edge cases**: Are important boundaries tested?
- **Style**: Does it match the project's existing test patterns?
- **Independence**: Can each test run in isolation? No shared mutable state?

## Output

### APPROVED
If tests are solid and all gaps are covered.

### REJECTED
List specific, actionable issues for each problem:
- Test file:line reference
- What's wrong
- How to fix

Do NOT modify any files. Review only."
```

Parse response:
- If **APPROVED** → proceed to Step 7
- If **REJECTED** → dispatch a fix subagent to address the specific issues, then re-review (loop within cycle limit)

### Step 6b — Test Fix (if rejected)

Dispatch a fresh subagent:

```
Agent tool:

"You are a test fixer for an autonomous QA pipeline.

## Test Review Feedback
{paste rejection details from Step 6}

## Your Job
1. Fix each specific issue listed in the review feedback.
2. Re-run affected test files: `npx vitest run test/<file>.test.ts`
3. Do NOT add new tests beyond what was requested.
4. Do NOT modify source code — only test files."
```

After fix → loop back to Step 6 (re-review with incremented cycle).

---

## Step 7 — Final QA Gate

Run these checks directly (not via subagent):

```bash
# TypeScript
tsc --noEmit 2>&1

# Lint
npm run lint 2>&1

# Tests (only files relevant to this branch)
# Find test files that correspond to changed source files
npx vitest run test/<relevant-files>.test.ts 2>&1
```

**NEVER run `npx vitest run` (full suite)** — it can crash the Codeman tmux session.

- All pass → proceed to Step 8
- Any fail → attempt auto-fix (one attempt), re-run. If still failing, proceed to Step 8 with warning.

---

## Step 8 — Clean Commit

### If all checks passed:

```bash
git add -A -- ':!CLAUDE.md' ':!TASK.md'
git diff --cached --quiet || git commit -m "chore: full QA pass — review fixes, docs, tests"
```

### If checks had warnings:

```bash
git add -A -- ':!CLAUDE.md' ':!TASK.md'
git diff --cached --quiet || git commit -m "[NEEDS REVIEW] chore: QA pass with warnings — see details

Warnings:
{list any unresolved issues}"
```

---

## Step 9 — Final Report

Output a structured summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FULL QA COMPLETE: {BRANCH_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Code Review:
  Round 1: {N critical, N important, N minor}
  Round 2: {resolved / N remaining / skipped}

Fixes Applied:
  {summary of what was fixed}

Documentation:
  {what was updated / nothing needed}

Test Coverage:
  Gaps found: {N gaps identified}
  Tests written: {N test files added/modified}
  Test review: {APPROVED / APPROVED with fixes / warnings}

QA Gate:
  TypeScript: {pass/fail}
  Lint: {pass/fail}
  Tests: {N passed, N failed}

Commit: {hash}
Status: {CLEAN / NEEDS REVIEW}

To merge:
  Use the Codeman UI merge button, or ask:
  "merge the worktree for {BRANCH_NAME}"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Subagent Dispatch Rules

1. **Every subagent gets a fresh context** — paste all needed info into the prompt, no shared state
2. **Review subagents use Opus** (`model: "opus"`) — they are the quality gate
3. **Fix subagents use default model** — speed over deliberation for mechanical fixes
4. **Never pass conversation history** to subagents — only structured context
5. **Read files after each subagent returns** to verify changes were made correctly

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Running full vitest suite | Only run specific test files |
| Committing TASK.md or CLAUDE.md | Exclude with `':!CLAUDE.md' ':!TASK.md'` |
| Fixing Minor issues | Only fix Critical and Important |
| Endless review loops | Hard cap at 2 cycles, then commit with warning |
| Subagent modifying files it shouldn't | Specify clearly in prompt what's read-only |
| Skipping re-review after fixes | Always re-review — fixes can introduce new issues |
| Adding docs for unchanged code | Only update docs that are actually stale |
| Over-testing | One test per behaviour per gap, match existing patterns |

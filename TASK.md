# Task

type: bug
status: done
title: Slash menu shows only commands, not skills
description: When typing "/" in the compose text area, only commands are shown — not skills. The slash menu should show all available skills so users can discover and select them, instead of relying on commands that duplicate skill functionality. Commands are currently doing double duty as the only way to trigger skills, which doesn't make sense. The user wants a unified slash menu that surfaces all skills directly.
affected_area: backend
work_item_id: wi-0f1d22a1
fix_cycles: 0
test_fix_cycles: 0

## Reproduction

1. Open the Codeman web UI and select any session.
2. In the compose textarea, type `/`.
3. The slash menu popup appears showing only:
   - Built-in Claude commands (compact, clear, help, etc.) from `BUILTIN_CLAUDE_COMMANDS` in app.js
   - Project-level commands from `{cwd}/.claude/commands/`
   - User-level commands from `~/.claude/commands/`
   - Plugin commands from `installed_plugins.json` plugin `commands/` dirs
   - Plugin skills from `installed_plugins.json` plugin `skills/` dirs
4. Missing from the menu:
   - Manually installed skills in `~/.claude/skills/` (e.g. codeman-feature, codeman-fix, bug-to-worktree, etc.)
   - GSD workflow skills from `~/.gsd/workflows/`
5. The Plugins panel (sidebar > Plugins > Skills tab) correctly shows ALL skills including manual and GSD ones, because it uses a different API endpoint (`/api/plugins/skills`) that calls `listAllSkills()` in `plugin-routes.ts`.

## Root Cause / Spec

**Root Cause:** The `discoverCommands()` function in `src/web/routes/commands-routes.ts` (which powers `GET /api/sessions/:id/commands` and feeds the slash menu) only scans two skill sources:

1. Plugin skills via `installed_plugins.json` entries (line 221: `scanSkillsDir(path.join(installPath, 'skills'), pluginName)`)

But it does NOT scan:
2. `~/.claude/skills/` — manually installed skills (codeman skills, etc.)
3. `~/.gsd/workflows/` — GSD workflow skills

Meanwhile, `listAllSkills()` in `src/web/routes/plugin-routes.ts` (lines 169-247) correctly scans all three sources. The two functions have diverged — `discoverCommands` was never updated to include the manual skills directory and GSD workflows that `listAllSkills` covers.

**Fix Spec:** Update `discoverCommands()` in `commands-routes.ts` to also scan:
1. `~/.claude/skills/` for manually installed skills (same logic as `plugin-routes.ts` lines 201-221)
2. `~/.gsd/workflows/` for GSD workflow skills (same logic as `plugin-routes.ts` lines 223-244)

This should reuse the existing `scanSkillsDir()` helper for manual skills (with pluginName='local'). For GSD workflows, a small addition is needed since GSD uses `.md` files directly in the workflows dir rather than subdirectories with SKILL.md files — either extract the GSD scanning logic from `plugin-routes.ts` into a shared helper, or duplicate it in `commands-routes.ts`.

The disabled-skills filtering already exists in `discoverCommands()` (lines 224-231) and should automatically apply to the newly included skills.

**Key files:**
- `src/web/routes/commands-routes.ts` — `discoverCommands()` needs the fix
- `src/web/routes/plugin-routes.ts` — `listAllSkills()` has the correct comprehensive scanning as reference
- `src/web/public/app.js` — frontend slash menu code (no changes needed; it already renders whatever `/api/sessions/:id/commands` returns)

## Fix / Implementation Notes

### Changes in `src/web/routes/commands-routes.ts`

1. **Added `parseGsdPurpose()` helper** — extracts description from `<purpose>` XML tag in GSD workflow files, matching the same logic in `plugin-routes.ts`.

2. **Added `scanGsdWorkflowsDir()` helper** — scans a flat directory of `.md` files and returns `CommandEntry[]` with `cmd: /gsd:{filename}` and `source: 'plugin'`. GSD workflows differ from regular skills (flat `.md` files vs subdirectories with `SKILL.md`), so a dedicated scanner was needed.

3. **Extended `discoverCommands()`** with two new scanning steps:
   - Step 4: `scanSkillsDir(~/.claude/skills/, 'local')` — reuses the existing `scanSkillsDir` helper for manually installed skills, prefixed as `local:{skillName}`.
   - Step 5: `scanGsdWorkflowsDir(~/.claude/get-shit-done/workflows/)` — scans GSD workflow `.md` files, prefixed as `gsd:{workflowName}`.

4. **Updated file header comment** to document all five sources.

### Changes in `test/routes/commands-routes.test.ts`

- Added test suite for manual skills (`~/.claude/skills/`) — 3 tests covering happy path, missing SKILL.md, and nonexistent dir.
- Added test suite for GSD workflows — 4 tests covering happy path, missing `<purpose>` tag, non-.md files, and nonexistent dir.
- Updated the "returns all sources together" integration test to verify manual skills and GSD workflows appear alongside the original three sources.

All 33 tests pass.

## Review History
<!-- appended by each review subagent — never overwrite -->
### Review attempt 1 — APPROVED
**Correctness**: Both new scanning steps correctly mirror the logic in `plugin-routes.ts`'s `listAllSkills()`. Manual skills reuse `scanSkillsDir()` with `pluginName='local'`. GSD workflows use a dedicated `scanGsdWorkflowsDir()` that handles flat `.md` files (vs subdirs with SKILL.md).
**Edge cases**: Missing directories handled via try/catch in both scanners. Non-.md files filtered. Missing SKILL.md skipped silently. `fs.readdirSync` without `withFileTypes` for GSD matches `plugin-routes.ts` behavior.
**TypeScript**: No implicit any, no unused variables. All types align with existing `CommandEntry` interface.
**Security**: No user-controlled paths — all derived from `userClaudeDir` which comes from `userHomeOverride ?? os.homedir()`.
**Patterns**: Consistent with existing code style (sync I/O, try/catch, `source: 'plugin'`). Disabled skills filter applies automatically.
**Tests**: 7 new tests covering happy paths, missing dirs, missing SKILL.md, non-.md files, missing `<purpose>` tags, and integration with all five sources. All 33 tests pass.
**No issues found.**

## Test Gap Analysis
**Verdict: NO GAPS**

Changed source files:
1. `src/web/routes/commands-routes.ts` — added `parseGsdPurpose()`, `scanGsdWorkflowsDir()`, and extended `discoverCommands()` with manual skills + GSD workflow scanning.
   - All new code tested by 7 new tests in `test/routes/commands-routes.test.ts`:
     - Manual skills: surfaces as `/local:skillName`, skips dirs without SKILL.md, handles missing dir
     - GSD workflows: surfaces as `/gsd:workflowName`, handles missing `<purpose>` tag, ignores non-.md files, handles missing dir
   - Integration test updated to verify all 5 sources appear together
   - Disabled skills filtering tested by existing tests (applies automatically via `source: 'plugin'`)

## Test Writing Notes
<!-- filled by test writing subagent -->

## Test Review History
<!-- appended by each Opus test review subagent — never overwrite -->

## QA Results
- **tsc --noEmit**: PASS (zero errors in changed files; pre-existing errors in unrelated files only)
- **npm run lint**: PASS (0 errors, 2 pre-existing warnings in unrelated files)
- **vitest run test/routes/commands-routes.test.ts**: PASS (33/33 tests)
- **Backend API test** (dev server on port 3099):
  - GET /api/sessions/:id/commands: PASS — returns 107 commands total
  - Manual skills (local:): 11 entries found (codeman-feature, codeman-fix, bug-to-worktree, etc.)
  - GSD workflows (gsd:): 66 entries found (add-phase, add-tests, add-todo, etc.)
  - Plugin skills: 27 entries found (codeman:*, superpowers:*, etc.)
  - All entries have correct `cmd` format and non-empty descriptions

### Docs Staleness
- API docs may need update (src/web/routes/ changed — commands-routes.ts now returns additional skill sources)

## Decisions & Context
<!-- append-only log of key decisions made during the workflow -->

- **source: 'plugin' for manual/GSD skills**: Used `source: 'plugin'` for both manual skills and GSD workflows so the existing disabled-skills filter applies to them automatically. The `CommandEntry` type only allows `'project' | 'user' | 'plugin'`, and these are closest to plugin-type entries.
- **Duplicated GSD helpers rather than extracting shared module**: The `parseGsdPurpose` and GSD scanning logic is small (~25 lines). Extracting to a shared module would add coupling between commands-routes and plugin-routes for minimal benefit. If these diverge further, refactoring can happen later.
- **GSD path uses `~/.claude/get-shit-done/workflows/`**: Matches the `gsdDir()` helper in `plugin-routes.ts` which uses `~/.claude/get-shit-done` (not `~/.gsd`).

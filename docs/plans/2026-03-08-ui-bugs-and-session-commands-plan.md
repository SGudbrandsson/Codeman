# UI Bugs & Session-Specific Slash Commands — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix four UI bugs (desktop hamburger menu, mobile hamburger positioning, arrow button z-index, context pill) and make slash commands session-scoped to the session's working directory.

**Architecture:** CSS/JS changes for UI bugs; backend `discoverCommands()` refactor to scan `{cwd}/.claude/commands/` and `~/.claude/commands/*.md` (top-level only) instead of the current global GSD/plugin scan.

**Tech Stack:** TypeScript (backend route), vanilla JS (app.js), CSS (styles.css, mobile.css)

---

## Reference

- Design doc: `docs/plans/2026-03-08-ui-bugs-and-session-commands-design.md`
- Hamburger button: `src/web/public/index.html:63`
- Session drawer HTML: `src/web/public/index.html:1773-1779`
- `SessionDrawer` JS: `src/web/public/app.js:13184-13202`
- `updateMobileContextPill`: `src/web/public/app.js:5187-5206` (calls at 4006, 5180)
- `discoverCommands`: `src/web/routes/commands-routes.ts:60-121`
- Asset versions: `styles.css?v=0.1641`, `mobile.css?v=0.1647`, `app.js?v=0.4.21`

---

## Task 1: Add Desktop Session Drawer CSS

The `.session-drawer` has no CSS in `styles.css` (only in `mobile.css`). On desktop (non-touch), clicking the hamburger button calls `SessionDrawer.toggle()` which adds/removes the `.open` class, but nothing is visible.

**Files:**
- Modify: `src/web/public/styles.css` (after line 640, near `.btn-hamburger`)

**Step 1: Add desktop drawer CSS to styles.css**

Insert after the `.btn-hamburger { display: flex; }` rule at line 640:

```css
/* Session drawer — desktop (non-touch) */
.session-drawer {
  position: fixed;
  top: 48px;
  right: 0;
  width: 280px;
  height: calc(100vh - 48px);
  background: var(--bg-secondary, #1e1e2e);
  border-left: 1px solid var(--border-color, rgba(255,255,255,0.1));
  transform: translateX(100%);
  transition: transform 0.2s ease;
  z-index: 1200;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.session-drawer.open {
  transform: translateX(0);
}
.session-drawer-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 1199;
}
.session-drawer-overlay.open {
  display: block;
}
```

**Step 2: Verify the hamburger button toggle works**

Start the dev server: `npx tsx src/index.ts web`

Open the app in a desktop browser (non-touch). Click the hamburger button. The session drawer should slide in from the right. Click the backdrop or the hamburger button again — it should close.

**Step 3: Commit**

```bash
git add src/web/public/styles.css
git commit -m "fix: add desktop session drawer CSS (slide from right)"
```

---

## Task 2: Redesign Mobile Session Drawer as Top-Anchored Popup

Currently the mobile drawer slides from `bottom: 0` as a full-screen sheet. Change it to a compact right-anchored popup below the header.

**Files:**
- Modify: `src/web/public/mobile.css:2164-2179` (`.session-drawer` block) and `2155-2162` (`.session-drawer-overlay`)

**Step 1: Replace mobile `.session-drawer` CSS**

Find the block at mobile.css:2164:
```css
.session-drawer {
  position: fixed;
  bottom: 0;
  left: 0;
  /* ... slides from bottom ... */
  transform: translateY(100%);
  /* ... */
}
.session-drawer.open { transform: translateY(0); }
```

Replace with:
```css
.session-drawer {
  position: fixed;
  top: 48px;
  right: 0;
  width: 260px;
  max-height: 60vh;
  overflow-y: auto;
  transform: translateX(100%);
  transition: transform 0.25s ease;
  border-radius: 0 0 0 8px;
}
.session-drawer.open {
  transform: translateX(0);
}
```

Also update the overlay block (mobile.css:2155) — remove any `top: 0` full-screen positioning if it forces a bottom-sheet look. Keep the existing `z-index: 1500` but let the desktop rule at `z-index: 1199` be overridden here:
```css
.touch-device .session-drawer-overlay {
  z-index: 1499;
}
.touch-device .session-drawer {
  z-index: 1500;
}
```

**Step 2: Verify on mobile**

Use browser DevTools to simulate a mobile device. Open the hamburger. The drawer should appear from the top-right, below the header. Press hamburger again — it closes.

**Step 3: Bump mobile.css version in index.html**

In `src/web/public/index.html:13`, change `mobile.css?v=0.1647` → `mobile.css?v=0.1648`.

**Step 4: Commit**

```bash
git add src/web/public/mobile.css src/web/public/index.html
git commit -m "fix: mobile session drawer now opens as top-right popup"
```

---

## Task 3: Fix Arrow Button Dropdown Z-Index

The run-mode dropdown menu appears behind the action bar. It has `z-index: 1000` in `styles.css:2125` but the action bar toolbar may create a stacking context that clips it.

**Files:**
- Modify: `src/web/public/styles.css:2115-2128` (`.run-mode-menu` block)

**Step 1: Inspect the current rule**

Read `src/web/public/styles.css` lines 2110-2135 to see the `.run-mode-menu` rule and any parent container rules nearby.

**Step 2: Fix z-index and ensure upward positioning**

In the `.run-mode-menu` block, ensure:
```css
.run-mode-menu {
  /* existing rules... */
  z-index: 1100;   /* bump above action bar stacking context */
  position: absolute;
  bottom: 100%;    /* opens upward */
}
```

Also check the parent container (the button/toolbar row). If it has `position: relative` without an explicit `z-index`, add `z-index: 1` to that parent to establish a stacking context that doesn't clip children with higher z-index.

**Step 3: Bump styles.css version**

In `src/web/public/index.html:12`, change `styles.css?v=0.1641` → `styles.css?v=0.1642`.

**Step 4: Verify visually**

In a browser, click the arrow button next to the run button. The dropdown should appear above the action bar, not clipped behind it.

**Step 5: Commit**

```bash
git add src/web/public/styles.css src/web/public/index.html
git commit -m "fix: raise run-mode dropdown z-index above action bar"
```

---

## Task 4: Show Context Pill on Desktop

The `.mobile-ctx-pill` is forced `display: none` by `styles.css:643`. The JS function `updateMobileContextPill()` sets an inline `style.display` but only when tokens > 0 — on desktop the CSS rule wins.

**Files:**
- Modify: `src/web/public/app.js:5187-5206` and calls at `4006`, `5180`

**Step 1: Rename the function and update all call sites**

In `app.js`, rename `updateMobileContextPill` → `updateContextPill` in all 3 places:
- Function definition: line 5187
- Call in `selectSession`: line 4006
- Call in token update: line 5180

**Step 2: Override display inline**

In the `updateContextPill` function body, change the show/hide logic. Currently it likely does `pill.style.display = ''` (clears inline style, letting CSS win). Change it to explicitly set the display value:

```javascript
// When showing:
pill.style.display = 'inline-flex';  // override the CSS display:none

// When hiding:
pill.style.display = 'none';
```

This ensures the pill is visible on desktop when context data is present.

**Step 3: Bump app.js version**

In `src/web/public/index.html:1906`, change `app.js?v=0.4.21` → `app.js?v=0.4.22`.

**Step 4: Verify**

In a desktop browser, load a session with token usage. The context pill should appear in the header. Sessions with no token data should not show the pill.

**Step 5: Commit**

```bash
git add src/web/public/app.js src/web/public/index.html
git commit -m "fix: show context pill on desktop, rename updateMobileContextPill"
```

---

## Task 5: Refactor discoverCommands to Session-Scoped Scanning

Replace the global GSD/plugin filesystem scan with a proper Claude-scoped command discovery: project-level commands from `{cwd}/.claude/commands/` and user-level commands from `~/.claude/commands/*.md` (top-level only).

**Files:**
- Modify: `src/web/routes/commands-routes.ts:60-121`

**Step 1: Read the current discoverCommands function**

Read `src/web/routes/commands-routes.ts` lines 55-135 to understand the current signature and implementation fully.

**Step 2: Write a failing test**

In `test/routes/commands-routes.test.ts` (create if it doesn't exist — check first with `ls test/routes/`):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import the discoverCommands function once it's exported
// import { discoverCommands } from '../../src/web/routes/commands-routes';

describe('discoverCommands', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeman-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns project-level commands from cwd/.claude/commands/', () => {
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'deploy.md'), '---\nname: deploy\ndescription: Deploy app\n---\n');

    // const commands = discoverCommands(tmpDir, tmpDir); // (cwd, userHomeOverride)
    // expect(commands.some(c => c.cmd === 'deploy' && c.source === 'project')).toBe(true);
  });

  it('excludes gsd/ subdirectory from user-level scan', () => {
    const gsdDir = path.join(tmpDir, 'commands', 'gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'brainstorming.md'), '---\nname: brainstorming\n---\n');

    // const commands = discoverCommands('/some/project', tmpDir);
    // expect(commands.some(c => c.cmd === 'brainstorming')).toBe(false);
  });
});
```

Run: `npx vitest run test/routes/commands-routes.test.ts`
Expected: tests are skipped/pass trivially (real assertions commented out until implementation)

**Step 3: Rewrite discoverCommands**

Replace the function body with:

```typescript
function discoverCommands(cwd: string): CommandEntry[] {
  const commands: CommandEntry[] = [];
  const userClaudeDir = path.join(os.homedir(), '.claude');

  // 1. Project-level commands: {cwd}/.claude/commands/*.md
  const projectCmdDir = path.join(cwd, '.claude', 'commands');
  try {
    const files = fs.readdirSync(projectCmdDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(projectCmdDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const match = content.match(/^---\s*\nname:\s*(.+)\n(?:description:\s*(.+)\n)?/);
      if (match) {
        commands.push({ cmd: match[1].trim(), desc: (match[2] || '').trim(), source: 'project' });
      } else {
        const cmd = file.replace(/\.md$/, '');
        commands.push({ cmd, desc: '', source: 'project' });
      }
    }
  } catch {
    // no project commands — that's fine
  }

  // 2. User-level commands: ~/.claude/commands/*.md (top-level only, no subdirs)
  const userCmdDir = path.join(userClaudeDir, 'commands');
  try {
    const files = fs.readdirSync(userCmdDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(userCmdDir, file);
      // Skip if it's a directory (readdirSync returns dir entries too)
      if (!fs.statSync(filePath).isFile()) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const match = content.match(/^---\s*\nname:\s*(.+)\n(?:description:\s*(.+)\n)?/);
      if (match) {
        commands.push({ cmd: match[1].trim(), desc: (match[2] || '').trim(), source: 'user' });
      } else {
        const cmd = file.replace(/\.md$/, '');
        commands.push({ cmd, desc: '', source: 'user' });
      }
    }
  } catch {
    // no user commands — that's fine
  }

  return commands;
}
```

**Step 4: Update the route handler**

The route handler at line ~124 must pass the session's working directory:

```typescript
app.get<{ Params: { id: string } }>('/api/sessions/:id/commands', async (request, reply) => {
  const { id } = request.params;
  const session = ctx.sessions.get(id);
  if (!session) {
    return reply.code(404).send({ error: 'Session not found' });
  }
  const cwd = session.workingDir ?? os.homedir();
  const commands = discoverCommands(cwd);
  return reply.send({ commands });
});
```

Check what property `Session` exposes for its working directory — search for `workingDir` or `cwd` in `src/types/session.ts` and `src/session.ts`. Use whatever field name is correct.

**Step 5: Typecheck**

```bash
tsc --noEmit
```

Expected: no errors. Fix any type issues.

**Step 6: Uncomment and run tests**

Uncomment the test assertions in step 2, update imports to match the actual exported function (if `discoverCommands` is not exported, export it). Run:

```bash
npx vitest run test/routes/commands-routes.test.ts
```

Expected: PASS

**Step 7: Verify manually**

Start the dev server and open a session. Type `/` in the compose input. Confirm:
- `/brainstorming` no longer appears
- Any `.claude/commands/*.md` files in the session's project directory DO appear

**Step 8: Commit**

```bash
git add src/web/routes/commands-routes.ts test/routes/commands-routes.test.ts
git commit -m "fix: scope slash commands to session cwd, remove GSD/plugin scan"
```

---

## Task 6: Final Version Bump and Smoke Test

Ensure all asset version strings are consistent and do a final end-to-end check.

**Step 1: Confirm all version bumps in index.html**

Read `src/web/public/index.html` lines 10-20 and 1900-1910. Confirm:
- `styles.css?v=0.1642` (bumped in Task 3)
- `mobile.css?v=0.1648` (bumped in Task 2)
- `app.js?v=0.4.22` (bumped in Task 4)

If any were missed, fix them now.

**Step 2: Run typecheck and lint**

```bash
tsc --noEmit && npm run lint
```

Expected: no errors or warnings.

**Step 3: Smoke test all fixes**

Using the dev server (`npx tsx src/index.ts web`):

- [ ] Desktop: hamburger button opens the session drawer, backdrop click closes it, button click closes it
- [ ] Mobile (DevTools): hamburger opens a compact top-right popup, pressing again closes it
- [ ] Arrow button dropdown appears above the action bar, not behind it
- [ ] Context pill appears in header when a session has token usage
- [ ] Typing `/` in compose shows only Claude built-in commands + any project `.claude/commands/*.md` files — no `/brainstorming`

**Step 4: Final commit**

```bash
git add src/web/public/index.html
git commit -m "fix: version bump assets after UI bug fixes and slash command scoping"
```

---
name: codeman-restore-sessions
description: Use when the Codeman server has restarted and sessions need to be restored — worktrees lost from UI, sessions not showing branches, Claude not running in active worktrees. Triggers on "restore sessions", "server restarted", "sessions lost", "worktrees missing from UI".
---

# Codeman — Restore Sessions After Restart

## Overview

After a crash/restart, Codeman loses all in-memory session state. Sessions must be recreated with proper worktree fields (`worktreeBranch`, `worktreePath`, `worktreeOriginId`) or they won't appear as worktrees in the UI. Claude must be restarted in any session that had an active TASK.md.

Base URL: `http://localhost:3001`

## Step 1 — Verify Server is Up

```bash
curl -s http://localhost:3001/api/status
```

If down, check the service: `systemctl --user status codeman-web`

## Step 2 — Discover All Git Worktrees

```bash
# Codeman worktrees
git -C /home/siggi/sources/Codeman worktree list

# Keeps monorepo worktrees
git -C /home/siggi/sources/keepscms/keeps worktree list
```

The main worktree path (no branch suffix) is the parent — skip it when creating worktree sessions.

Also get the actual branch names:
```bash
for dir in /home/siggi/sources/Codeman-* /home/siggi/sources/keepscms/keeps-feat-* /home/siggi/sources/keepscms/keeps-fix-*; do
  echo "$(basename $dir) → $(git -C $dir branch --show-current 2>/dev/null)"
done
```

## Step 3 — Find claudeResumeIds from JSONL Files

For each worktree path, the resume ID is the filename (without `.jsonl`) of the most recent conversation file:

```bash
for dir in /home/siggi/sources/Codeman-fix-* /home/siggi/sources/keepscms/keeps-feat-* /home/siggi/sources/keepscms/keeps-fix-*; do
  proj_key=$(echo "$dir" | sed 's|/|-|g' | sed 's|^-||')
  jsonl=$(ls ~/.claude/projects/$proj_key/*.jsonl 2>/dev/null | grep -v subagent | tail -1)
  resumeid=$(basename "$jsonl" .jsonl 2>/dev/null)
  echo "$(basename $dir) → ${resumeid:-(no JSONL)}"
done
```

Do the same for the main sessions (keeps monorepo, keeps orchestrator):
```bash
# keepscms main session
ls ~/.claude/projects/-home-siggi-sources-keepscms-keeps/*.jsonl 2>/dev/null | grep -v subagent | tail -1
# keeps orchestrator
ls ~/.claude/projects/-home-siggi-codeman-cases-keeps-orchestrator/*.jsonl 2>/dev/null | grep -v subagent | tail -1
```

## Step 4 — Find Parent Session IDs

The parent session for **Codeman worktrees** is the current `w1-Codeman` session (already restored by Codeman's own state, or create it first). Get its ID:
```bash
curl -s http://localhost:3001/api/sessions | python3 -c "
import sys, json
for s in json.load(sys.stdin):
    if s.get('name') == 'w1-Codeman':
        print(s['id'])
"
```

For **keeps worktrees**, `worktreeOriginId` is `null`.

## Step 5 — Clean Up Wrong Sessions (if any exist)

If sessions were already created without worktree fields, delete them first:
```bash
curl -s http://localhost:3001/api/sessions | python3 -c "
import sys, json
for s in json.load(sys.stdin):
    if not s.get('worktreeBranch') and s['name'] not in ['w1-Codeman']:
        wd = s.get('workingDir', '')
        if 'fix/' in wd or 'feat/' in wd or 'Codeman-fix' in wd or 'keeps-' in wd:
            print(s['id'], s['name'])
"
# Then delete each: curl -s -X DELETE http://localhost:3001/api/sessions/SESSION_ID
```

## Step 6 — Create Parent Sessions First

**w1-keeps-monorepo** (must exist before keeps worktrees):
```bash
curl -s -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"name": "w1-keeps-monorepo", "workingDir": "/home/siggi/sources/keepscms/keeps", "claudeResumeId": "RESUME_ID_FROM_STEP_3"}'
```

**w1-keeps-orchestrator** (if `/home/siggi/codeman-cases/keeps-orchestrator` exists):
```bash
curl -s -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"name": "w1-keeps-orchestrator", "workingDir": "/home/siggi/codeman-cases/keeps-orchestrator", "claudeResumeId": "RESUME_ID_FROM_STEP_3"}'
```

## Step 7 — Create Worktree Sessions

For each worktree, create a session with **all four worktree fields**:

```bash
# Codeman worktree example:
curl -s -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"fix/sidebar-new-session-menu\",
    \"workingDir\": \"/home/siggi/sources/Codeman-fix-sidebar-new-session-menu\",
    \"worktreeBranch\": \"fix/sidebar-new-session-menu\",
    \"worktreePath\": \"/home/siggi/sources/Codeman-fix-sidebar-new-session-menu\",
    \"worktreeOriginId\": \"CODEMAN_MAIN_SESSION_ID\",
    \"claudeResumeId\": \"RESUME_ID_FROM_STEP_3\"
  }"

# Keeps worktree example (no worktreeOriginId):
curl -s -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"feat/room-sync-status\",
    \"workingDir\": \"/home/siggi/sources/keepscms/keeps-feat-room-sync-status\",
    \"worktreeBranch\": \"feat/room-sync-status\",
    \"worktreePath\": \"/home/siggi/sources/keepscms/keeps-feat-room-sync-status\",
    \"claudeResumeId\": \"RESUME_ID_FROM_STEP_3\"
  }"
```

**Critical:** Session `name` = full branch name (e.g., `fix/transcript-interactive-questions`), not shorthand.

## Step 8 — Resume Active Sessions

Check each TASK.md to see if Claude should be restarted:

```bash
for dir in /home/siggi/sources/Codeman-* /home/siggi/sources/keepscms/keeps-feat-* /home/siggi/sources/keepscms/keeps-fix-*; do
  status=$(grep "^status:" "$dir/TASK.md" 2>/dev/null | head -1)
  echo "$(basename $dir): $status"
done
```

Start Claude in sessions where `status` is **not** `done`:

```bash
# 1. Start Claude process
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/interactive

# 2. Wait 5-6 seconds, then send the resume prompt
sleep 6
curl -s -X POST http://localhost:3001/api/sessions/SESSION_ID/input \
  -H "Content-Type: application/json" \
  -d '{"input": "Read TASK.md and resume from the current status. Invoke the codeman-task-runner skill.\r", "useMux": true}'
```

Verify it worked:
```bash
tmux capture-pane -t codeman-SESSION_ID_PREFIX -p | tail -10
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Creating sessions without `worktreeBranch` | Sessions show as plain sessions, not worktrees in UI |
| Session name is shorthand (`fix-sidebar`) | Name must be full branch (`fix/sidebar-new-session-menu`) |
| Creating keeps worktrees before `w1-keeps-monorepo` | Create parent sessions first |
| Forgetting `claudeResumeId` | Claude starts fresh — no conversation history |
| Sending input without `\r` | Message typed but never submitted |
| Using `useMux: false` or omitting it | Same as above — Enter never sent |
| Starting Claude before writing TASK.md | Use `/interactive` after files are in place |

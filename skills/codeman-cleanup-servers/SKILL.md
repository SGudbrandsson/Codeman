---
name: codeman-cleanup-servers
description: Use when orphaned Codeman dev server processes are consuming CPU/ports, after merging worktrees, or when Node.js processes are running on unexpected ports. Triggers on phrases like "clean up servers", "kill orphaned processes", "too many ports open", "high CPU from node processes".
---

# Codeman — Cleanup Orphaned Dev Servers

## Overview

Worktree sessions start dev servers (`tsx src/index.ts --port XXXX`) for testing. These often survive after the session ends, task completes, or worktree merges — silently consuming 1.5–2% CPU each. With 15+ orphaned servers this becomes ~30% CPU waste.

## What to Keep

| Service | Port | Process |
|---------|------|---------|
| Codeman (production) | 3001 | `node dist/index.js web --port 3001` from `/home/siggi/.codeman/app` |
| openclaw-gateway | 18789/18791/18792 | `openclaw-gateway` |
| Tailscale | 443 on `100.69.214.73` | kernel / tailscaled |
| clockwork-daemon | 8420 | `clockwork-daemon` |
| Redis | 6379 | rootlessport |
| SSH | 22 | sshd |
| rootlessport containers | 80/443/8000 | rootlessport |

**Kill everything else with a Node.js listener** — especially anything on 3000, 3003–3099 range.

## Step 1 — Discover

```bash
# All Node.js processes with open ports (sort by port)
ss -tlnp | grep node

# Full command lines + CPU for any port in 3000–3099 range
ps aux | grep -E "node|tsx" | grep -v grep | sort -k3 -rn | head -30
```

## Step 2 — Classify

**Orphaned patterns to kill:**

| Pattern | Example |
|---------|---------|
| `tsx src/index.ts web --port XXXX` from a worktree path | dev server left running after task/merge |
| `node dist/index.js web --port XXXX` from a worktree path | built server from worktree |
| `node dist/index.js web` (no `--port`, defaults to 3000) | old leftover running from source dir |
| Any server in a `(deleted)` working directory | process whose worktree dir was removed |

Check the CWD of suspicious processes:
```bash
ls -la /proc/<PID>/cwd
```

## Step 3 — Collect PIDs

```bash
# Get PID→port mapping for all Node.js listeners
ss -tlnp | grep node | grep -oP 'pid=\K\d+' | while read pid; do
  port=$(ss -tlnp | grep "pid=$pid" | awk '{print $4}' | sed 's/.*://')
  cwd=$(ls -la /proc/$pid/cwd 2>/dev/null | awk '{print $NF}')
  cpu=$(ps -p $pid -o %cpu= 2>/dev/null | tr -d ' ')
  echo "PORT $port | CPU $cpu% | PID $pid | $cwd"
done | sort -V
```

Also find npm/sh/tsx wrapper processes (parents that might restart the main process):
```bash
ps aux | grep -E "npm exec tsx|sh -c tsx" | grep -v grep
```

## Step 4 — Kill

```bash
# Kill main node processes
kill -TERM <pid1> <pid2> ...

# Kill npm/sh wrappers (prevents auto-restart)
kill -TERM <wrapper-pid1> <wrapper-pid2> ...

sleep 2
```

## Step 5 — Verify

```bash
# Should only show 3001 (and system ports)
ss -tlnp | grep node

# CPU top-offenders should now be Claude sessions + Codeman service
ps aux --sort=-%cpu | head -15
```

## Common Mistakes

- **Killing only the main tsx process** — the npm exec / sh wrapper may restart it. Kill wrappers too.
- **Missing the `node dist/index.js web` (port 3000) process** — no `--port` flag so it's easy to overlook in `grep --port`.
- **Skipping esbuild orphans** — `@esbuild/linux-x64/bin/esbuild --service=X --ping` processes from worktree dirs can linger; kill them too.

## After Cleanup

Each orphaned server was consuming ~1.5–2% CPU continuously. 15 servers = ~30% CPU savings.
Consider adding a periodic check (e.g., after merging a worktree) to prevent accumulation.

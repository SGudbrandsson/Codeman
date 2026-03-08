/**
 * @fileoverview Update check and apply routes.
 *
 * GET  /api/update/check        — Returns cached version info (GitHub Releases)
 * POST /api/update/apply        — Runs update with backup + rollback safety
 */
import { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { cp, rm, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { SseEvent } from '../sse-events.js';
import { UpdateChecker } from '../../update-checker.js';
import type { EventPort, ConfigPort } from '../ports/index.js';

const execFileAsync = promisify(execFile);

// Singleton lock — prevents concurrent updates
let _updateInProgress = false;

const CODEMAN_APP_DIR = join(homedir(), '.codeman', 'app');
const DIST_BACKUP = join(CODEMAN_APP_DIR, 'dist.backup');
const DIST_LIVE = join(CODEMAN_APP_DIR, 'dist');

/** Run a command with execFile (no shell injection risk). Rejects on non-zero exit. */
async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: 5 * 60 * 1000 });
  return stdout;
}

/** Poll localhost health endpoint until 200 or timeout. */
async function healthCheck(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function rollback(repoPath: string, port: number): Promise<void> {
  try {
    // Only rollback if backup exists — otherwise we'd leave the service with no dist/
    await access(DIST_BACKUP);
    await rm(DIST_LIVE, { recursive: true, force: true });
    await cp(DIST_BACKUP, DIST_LIVE, { recursive: true });
    await run('systemctl', ['--user', 'restart', 'codeman-web'], repoPath);
    await healthCheck(port, 10_000);
  } catch {
    /* best-effort — if no backup, at least don't make things worse */
  }
}

export function registerUpdateRoutes(app: FastifyInstance, ctx: EventPort & ConfigPort, checker: UpdateChecker): void {
  // ─── GET /api/update/check ───────────────────────────────────────────────
  app.get('/api/update/check', async (req, reply) => {
    const force = (req.query as Record<string, string>)['force'] === '1';
    const info = await checker.check(force);
    return reply.send(info);
  });

  // ─── POST /api/update/apply ──────────────────────────────────────────────
  app.post('/api/update/apply', async (_req, reply) => {
    if (_updateInProgress) {
      return reply.status(409).send({ message: 'Update already in progress' });
    }

    const settings = ctx.store.getSettings() as Record<string, unknown>;
    const repoPath = (settings['updateRepoPath'] as string | undefined) ?? '';

    if (!repoPath) {
      return reply.status(400).send({
        message: 'Update repo path not configured. Set it in Settings > Updates.',
      });
    }

    // Verify path is a git repo
    try {
      await access(join(repoPath, '.git'));
    } catch {
      return reply.status(400).send({
        message: `Not a git repository: ${repoPath}`,
      });
    }

    // Acknowledge immediately — update runs in background
    void reply.status(202).send({ message: 'Update started' });

    const broadcast = (msg: string, step: string) => {
      ctx.broadcast(SseEvent.UpdateProgress, { message: msg, step });
    };

    _updateInProgress = true;
    try {
      broadcast('Fetching latest changes…', 'fetch');
      await run('git', ['fetch'], repoPath);

      broadcast('Backing up current build…', 'backup');
      await rm(DIST_BACKUP, { recursive: true, force: true });
      try {
        await cp(DIST_LIVE, DIST_BACKUP, { recursive: true });
      } catch {
        /* dist may not exist on fresh installs */
      }

      broadcast('Pulling changes…', 'pull');
      await run('git', ['pull'], repoPath);

      broadcast('Building…', 'build');
      await run('npm', ['run', 'build'], repoPath);

      broadcast('Deploying to installed location…', 'deploy');
      await rm(DIST_LIVE, { recursive: true, force: true });
      await cp(join(repoPath, 'dist'), DIST_LIVE, { recursive: true });

      broadcast('Restarting service…', 'restart');
      await run('systemctl', ['--user', 'restart', 'codeman-web'], repoPath);

      const healthy = await healthCheck(ctx.port);
      if (healthy) {
        ctx.broadcast(SseEvent.UpdateComplete, { message: 'Update complete — reloading…' });
      } else {
        broadcast('Health check failed — rolling back…', 'rollback');
        await rollback(repoPath, ctx.port);
        ctx.broadcast(SseEvent.UpdateFailed, {
          message: 'Health check failed. Rolled back to previous version.',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast(`Update failed: ${message}`, 'error');
      await rollback(repoPath, ctx.port).catch(() => {});
      ctx.broadcast(SseEvent.UpdateFailed, {
        message: `Update failed: ${message}. Rolled back to previous version.`,
      });
    } finally {
      _updateInProgress = false;
    }
  });
}

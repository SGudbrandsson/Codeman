/**
 * @fileoverview Codeman activity reporter for pi.
 *
 * Loaded by Codeman with `pi -e <this file>` (compiled to
 * dist/harnesses/pi/codeman-activity-extension.js). Reports whether pi is working to the Codeman
 * session that launched it, using pi's own lifecycle events. See
 * docs/superpowers/specs/2026-09-10-harness-activity-detection-design.md §3.
 *
 * Runs inside pi's process: no imports, never throws. pi re-imports extension modules on
 * `/reload` (moduleCache: false), so process-wide counters live on `globalThis`.
 *
 * @module harnesses/pi/codeman-activity-extension
 */

type Ctx = { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined;
type Handler = (event: unknown, ctx: Ctx) => unknown;
interface PiLike {
  on(event: string, handler: Handler): void;
}
interface Counters {
  seq: number;
  gen: number;
}

const HEARTBEAT_MS = 30_000;
const POST_TIMEOUT_MS = 2_000;

export default function codemanActivity(pi: PiLike): void {
  const sessionId = process.env.CODEMAN_SESSION_ID;
  const apiUrl = process.env.CODEMAN_API_URL;
  const token = process.env.CODEMAN_ACTIVITY_TOKEN;
  if (!sessionId || !apiUrl || !token) return;

  // Process-wide: `seq` must keep increasing across /reload, /new and /resume, which re-run this
  // factory; each invocation is a new runtime generation.
  const g = globalThis as { __codemanActivity?: Counters };
  const counters = (g.__codemanActivity ??= { seq: 0, gen: 0 });
  const gen = ++counters.gen;

  // State, never event counts: retries produce start → start → settled, and a run can settle
  // with no start at all.
  let runActive = false;
  let compacting = false;
  let sessionFile: string | undefined;
  let lastPosted: string | undefined;

  const state = (): 'working' | 'idle' => (runActive || compacting ? 'working' : 'idle');

  /** Posts when the state or session file changed, or always when `force` (heartbeat). */
  const post = (force: boolean): void => {
    try {
      const current = `${state()}|${sessionFile ?? ''}`;
      if (!force && current === lastPosted) return;
      lastPosted = current;
      // Exactly /api/hook-event, no query string: Codeman's localhost auth exemption compares
      // the URL exactly.
      void fetch(`${apiUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'harness_activity',
          sessionId,
          data: { state: state(), token, gen, seq: ++counters.seq, sessionFile },
        }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      }).catch(() => {});
    } catch {
      /* never throw into pi */
    }
  };

  const noteFile = (ctx: Ctx): void => {
    try {
      sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? sessionFile;
    } catch {
      /* ignore: keep the last known file */
    }
  };

  const heartbeat = setInterval(() => post(true), HEARTBEAT_MS);
  heartbeat.unref?.();

  pi.on('session_start', (_e, ctx) => {
    noteFile(ctx);
    post(true);
  });
  pi.on('agent_start', (_e, ctx) => {
    noteFile(ctx);
    runActive = true;
    compacting = false;
    post(false);
  });
  pi.on('agent_settled', (_e, ctx) => {
    noteFile(ctx);
    runActive = false;
    post(false);
  });
  pi.on('session_before_compact', (_e, ctx) => {
    noteFile(ctx);
    compacting = true;
    post(false);
    // pi uses a before-event's result only when truthy: undefined leaves compaction untouched.
    return undefined;
  });
  pi.on('session_compact', (_e, ctx) => {
    noteFile(ctx);
    compacting = false;
    post(false);
  });
  pi.on('session_compact_failed', (_e, ctx) => {
    noteFile(ctx);
    compacting = false;
    post(false);
  });
  pi.on('session_shutdown', () => {
    runActive = false;
    compacting = false;
    clearInterval(heartbeat);
    post(true);
  });
}

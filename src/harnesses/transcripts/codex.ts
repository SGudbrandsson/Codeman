/**
 * @fileoverview Codex rollout transcript adapter.
 *
 * Rollouts live at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl and hold
 * `{ type, timestamp, payload }` records. Mapping (spec table, extended for codex 0.154 —
 * see TASK.md Decisions):
 *
 *   event_msg / user_message                    → text (user)       [<= 0.144]
 *   event_msg / item_completed, item UserMessage → text (user)       [>= 0.154]
 *   response_item / message role assistant       → text (assistant)  [all versions]
 *   response_item / custom_tool_call             → tool_use
 *   response_item / custom_tool_call_output      → tool_result
 *   response_item / function_call(_output)       → tool_use / tool_result (older builds)
 *   event_msg / task_complete                    → result
 *
 * Activity (classifyActivity): event_msg/task_started → working; event_msg/task_complete and
 * event_msg/turn_aborted → idle. See src/codex-transcript-activity-monitor.ts.
 *
 * Filtered: response_item/message role developer (system prompt) and role user (it carries
 * injected <environment_context>/AGENTS.md text; the clean user text is the event above),
 * event_msg/agent_message (a duplicate of response_item/message assistant in <= 0.144),
 * response_item/reasoning (encrypted_content — codex reasoning is never viewable),
 * token_count (fires after every model call; a result row each time would drown the view),
 * session_meta, turn_context, world_state and anything unknown.
 *
 * @module harnesses/transcripts/codex
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stampSeq, type UnsequencedBlock } from '../../types/transcript-blocks.js';
import { assertUnderRoot } from './paths.js';
import { defineTranscriptAdapter, obj, str, type TranscriptLocateCtx } from './types.js';

/** Codex session ids are UUIDs. Validated before any filesystem work. */
const CODEX_ID_PATTERN = /^[0-9a-fA-F-]{1,128}$/;

/** Upper bound on text forwarded per block; rollouts can embed very large tool outputs. */
const MAX_TEXT = 64_000;

/** Resolve $CODEX_HOME the same way codex-session-discovery.ts does. */
export function codexHome(ctx?: Pick<TranscriptLocateCtx, 'homeDir'>): string {
  return process.env.CODEX_HOME ?? join(ctx?.homeDir ?? homedir(), '.codex');
}

/**
 * Resolved rollout path per codex id. Walking ~/.codex/sessions (hundreds of files) on every
 * transcript load and every 30 s client sync is wasteful; a hit is re-validated with a stat.
 */
const locateCache = new Map<string, string>();

/**
 * Negative cache: a miss (id known, no rollout on disk — e.g. a deleted rollout) is remembered
 * briefly so repeated /transcript calls and idle events do not re-walk the tree each time.
 * Kept short: codex only writes its rollout after the first submitted turn, and the view must
 * still pick it up within about this window. Keyed by sessions root + id.
 */
export const CODEX_LOCATE_MISS_TTL_MS = 15_000;
const locateMisses = new Map<string, number>();

/** Test hook. */
export function clearCodexLocateCache(): void {
  locateCache.clear();
  locateMisses.clear();
}

/** Find `rollout-*-<id>.jsonl` in the date-sharded tree; newest mtime wins. */
function findRollout(sessionsDir: string, id: string): string | null {
  const suffix = `-${id}.jsonl`;
  let best: { path: string; mtimeMs: number } | null = null;
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name.startsWith('rollout-') && e.name.endsWith(suffix)) {
        try {
          const m = statSync(full).mtimeMs;
          if (!best || m > best.mtimeMs) best = { path: full, mtimeMs: m };
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(sessionsDir, 0);
  return (best as { path: string } | null)?.path ?? null;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n… [truncated]' : text;
}

/** Concatenate the text parts of a codex content/output array, dropping images. */
function joinText(parts: unknown): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      const o = obj(p);
      if (!o) return '';
      const t = o.type;
      if (t === 'input_text' || t === 'output_text' || t === 'text') return str(o.text) ?? '';
      return ''; // input_image / image_url (base64) and unknown parts are dropped
    })
    .join('');
}

/** custom_tool_call input is free text; function_call arguments is a JSON string. */
function toolInput(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const o = obj(parsed);
      if (o) return o;
    } catch {
      /* not JSON — keep as text */
    }
    return { input: clip(raw) };
  }
  return obj(raw) ?? {};
}

export const codexTranscriptAdapter = defineTranscriptAdapter({
  mode: 'codex',
  locate(ctx) {
    const id = ctx.harnessSessionId;
    // Undefined until discovery after the first turn (session.ts) — no transcript yet.
    if (!id || !CODEX_ID_PATTERN.test(id)) return null;
    const root = join(codexHome(ctx), 'sessions');

    const cached = locateCache.get(id);
    if (cached) {
      const safe = assertUnderRoot(cached, root);
      if (safe) return safe;
      locateCache.delete(id);
    }

    const missKey = `${root}\0${id}`;
    const missUntil = locateMisses.get(missKey);
    if (missUntil !== undefined) {
      if (Date.now() < missUntil) return null;
      locateMisses.delete(missKey);
    }

    const found = findRollout(root, id);
    const safe = found ? assertUnderRoot(found, root) : null;
    if (safe) locateCache.set(id, safe);
    else locateMisses.set(missKey, Date.now() + CODEX_LOCATE_MISS_TTL_MS);
    return safe;
  },

  parseRecord(record, seqBase) {
    const rec = record as Record<string, unknown>;
    const payload = obj(rec.payload);
    if (!payload) return [];
    const ts = str(rec.timestamp) ?? new Date().toISOString();
    const blocks: UnsequencedBlock[] = [];
    const ptype = payload.type;

    if (rec.type === 'event_msg') {
      if (ptype === 'user_message') {
        const text = str(payload.message);
        if (text?.trim()) blocks.push({ type: 'text', role: 'user', text: clip(text), timestamp: ts });
      } else if (ptype === 'item_completed') {
        const item = obj(payload.item);
        if (item?.type === 'UserMessage') {
          const text = joinText(item.content);
          if (text.trim()) blocks.push({ type: 'text', role: 'user', text: clip(text), timestamp: ts });
        }
      } else if (ptype === 'task_complete') {
        const durationMs = typeof payload.duration_ms === 'number' ? payload.duration_ms : undefined;
        blocks.push({ type: 'result', durationMs, timestamp: ts });
      }
    } else if (rec.type === 'response_item') {
      if (ptype === 'message' && payload.role === 'assistant') {
        const text = joinText(payload.content);
        if (text.trim()) blocks.push({ type: 'text', role: 'assistant', text: clip(text), timestamp: ts });
      } else if (ptype === 'custom_tool_call' || ptype === 'function_call') {
        blocks.push({
          type: 'tool_use',
          id: str(payload.call_id) ?? str(payload.id) ?? '',
          name: str(payload.name) ?? '',
          input: toolInput(ptype === 'custom_tool_call' ? payload.input : payload.arguments),
          timestamp: ts,
        });
      } else if (ptype === 'custom_tool_call_output' || ptype === 'function_call_output') {
        let output = payload.output;
        // function_call_output.output is sometimes `{ content, success }`.
        const o = obj(output);
        if (o) output = o.content ?? o.output ?? '';
        blocks.push({
          type: 'tool_result',
          toolUseId: str(payload.call_id) ?? '',
          content: clip(joinText(output)),
          isError: o?.success === false,
          timestamp: ts,
        });
      }
    }

    return stampSeq(blocks, seqBase);
  },

  classifyActivity(record) {
    const rec = obj(record);
    if (!rec || rec.type !== 'event_msg') return null;
    const t = obj(rec.payload)?.type;
    if (t === 'task_started') return 'working';
    if (t === 'task_complete' || t === 'turn_aborted') return 'idle';
    return null;
  },
});

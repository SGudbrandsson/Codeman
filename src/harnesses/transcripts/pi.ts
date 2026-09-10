/**
 * @fileoverview Pi session transcript adapter (pi 0.85.1).
 *
 * Files: <agentDir>/sessions/--<cwd with leading separator dropped and / \ : → ->--/
 *        <ISO-ts>_<sessionId>.jsonl
 * where agentDir is $PI_CODING_AGENT_DIR or ~/.pi/agent (pi dist/config.js getAgentDir,
 * dist/core/session-manager.js getDefaultSessionDirPath). This is NOT Claude's encoding:
 * dots are kept and the name is wrapped in `--`.
 *
 * Records: `{ type: 'message', timestamp, message: { role, content[] } }`.
 *   role user       : text                     → text (user)
 *   role assistant  : text                     → text (assistant)
 *                     thinking {thinking}      → thinking (plaintext)
 *                     toolCall {id,name,arguments} → tool_use (arguments → input)
 *                     stopReason 'error'       → result (error = errorMessage)
 *   role toolResult : {toolCallId, content[], isError} → tool_result (images dropped)
 * session / model_change / thinking_level_change / session_info / unknown → [].
 *
 * @module harnesses/transcripts/pi
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stampSeq, type UnsequencedBlock } from '../../types/transcript-blocks.js';
import { assertUnderRoot, newestMatchingFile } from './paths.js';
import { defineTranscriptAdapter, obj, str, type TranscriptLocateCtx } from './types.js';

/** Same shape the pi harness accepts for --session-id (src/harnesses/pi.ts). */
const PI_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

/** Upper bound on text forwarded per block. */
const MAX_TEXT = 64_000;

/** pi's agent directory: $PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function piAgentDir(ctx?: Pick<TranscriptLocateCtx, 'homeDir'>): string {
  return process.env.PI_CODING_AGENT_DIR || join(ctx?.homeDir ?? homedir(), '.pi', 'agent');
}

/** pi's per-cwd session directory name (getDefaultSessionDirPath in pi 0.85.1). */
export function piSessionDirName(cwd: string): string {
  return `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n… [truncated]' : text;
}

/** Text parts only — base64 `image` parts are dropped. */
function joinText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      const o = obj(p);
      return o?.type === 'text' ? (str(o.text) ?? '') : '';
    })
    .join('');
}

export const piTranscriptAdapter = defineTranscriptAdapter({
  mode: 'pi',
  locate(ctx) {
    // Codeman preassigns pi's --session-id from its own session id.
    const id = ctx.harnessSessionId ?? ctx.sessionId;
    if (!id || !PI_ID_PATTERN.test(id) || !ctx.workingDir) return null;
    const root = join(piAgentDir(ctx), 'sessions');
    const dir = join(root, piSessionDirName(ctx.workingDir));
    const suffix = `_${id}.jsonl`;
    const found = newestMatchingFile(dir, (name) => name.endsWith(suffix));
    return found ? assertUnderRoot(found, root) : null;
  },

  parseRecord(record, seqBase) {
    const rec = record as Record<string, unknown>;
    if (rec.type !== 'message') return [];
    const msg = obj(rec.message);
    if (!msg) return [];
    const ts = str(rec.timestamp) ?? new Date().toISOString();
    const blocks: UnsequencedBlock[] = [];
    const role = msg.role;
    const content = msg.content;

    if (role === 'user') {
      const text = joinText(content);
      if (text.trim()) blocks.push({ type: 'text', role: 'user', text: clip(text), timestamp: ts });
    } else if (role === 'assistant') {
      if (typeof content === 'string') {
        if (content.trim()) blocks.push({ type: 'text', role: 'assistant', text: clip(content), timestamp: ts });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          const p = obj(part);
          if (!p) continue;
          if (p.type === 'text') {
            const text = str(p.text);
            if (text?.trim()) blocks.push({ type: 'text', role: 'assistant', text: clip(text), timestamp: ts });
          } else if (p.type === 'thinking') {
            const text = str(p.thinking) ?? str(p.text);
            if (text?.trim()) blocks.push({ type: 'thinking', text: clip(text), timestamp: ts });
          } else if (p.type === 'toolCall') {
            blocks.push({
              type: 'tool_use',
              id: str(p.id) ?? '',
              name: str(p.name) ?? '',
              input: obj(p.arguments) ?? {},
              timestamp: ts,
            });
          }
        }
      }
      if (msg.stopReason === 'error') {
        blocks.push({ type: 'result', error: str(msg.errorMessage) ?? 'Unknown error', timestamp: ts });
      }
    } else if (role === 'toolResult') {
      blocks.push({
        type: 'tool_result',
        toolUseId: str(msg.toolCallId) ?? '',
        content: clip(joinText(content)),
        isError: msg.isError === true,
        timestamp: ts,
      });
    }

    return stampSeq(blocks, seqBase);
  },
});

/**
 * @fileoverview Confirms that a message typed into a Claude session actually reached Claude.
 *
 * Codeman types messages with `tmux send-keys` and cannot see whether Claude's TUI accepted
 * them. Long-running Claude processes sometimes drop the whole message (seen 2026-11-12: five
 * messages in a day vanished, always the first one after a long idle; resending the same text
 * worked every time). The web UI cleared the compose box optimistically, so the text was lost.
 *
 * Claude Code appends every submitted prompt to ~/.claude/history.jsonl with its sessionId —
 * immediately when idle, or when it dequeues a prompt typed while busy. That is the delivery
 * signal. If no entry appears, look at the prompt box: text still sitting there → press Enter;
 * box empty → the keystrokes were swallowed, retype once; anything else (a dialog, an unknown
 * screen) → don't type blind. If the message still hasn't landed, report it as undelivered so
 * the UI can hand the text back to the user.
 */

import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_HISTORY_PATH = join(homedir(), '.claude', 'history.jsonl');

/** How long Claude gets to record an idle-time prompt before we act. */
export const DELIVERY_WAIT_MS = 8_000;
/** Upper bound on waiting for a busy Claude to go idle (a prompt typed while busy is queued). */
export const BUSY_WAIT_MAX_MS = 15 * 60_000;
const POLL_MS = 500;

export type DeliveryOutcome =
  | 'delivered' // recorded by Claude without help
  | 'delivered-after-enter' // text was in the prompt box; a second Enter submitted it
  | 'delivered-after-retype' // keystrokes were swallowed; retyping worked
  | 'undelivered'; // still not recorded — the user must be told

export interface DeliveryDeps {
  /** Claude session ids / project path that identify this session's history entries. */
  sessionIds: ReadonlySet<string>;
  project: string;
  /** The message as typed (without the trailing \r). */
  text: string;
  /** Byte offset of history.jsonl taken BEFORE the message was typed. */
  historyOffset: number;
  readHistorySince: (offset: number) => Promise<string>;
  isBusy: () => boolean;
  /** Current screen of the pane, ANSI already stripped; null if it can't be captured. */
  captureScreen: () => Promise<string | null>;
  pressEnter: () => Promise<void>;
  retype: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * True if `chunk` (new history.jsonl lines) holds this message from this session. The text is
 * compared by prefix so a later message from the same session can't vouch for a lost one; Claude
 * records long typed bursts as "[Pasted text #1 …]", which is accepted too.
 */
export function historyHasPrompt(
  chunk: string,
  sessionIds: ReadonlySet<string>,
  project: string,
  text: string
): boolean {
  const want = norm(text).slice(0, 40);
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { sessionId?: string; project?: string; display?: string };
      const mine = e.sessionId ? sessionIds.has(e.sessionId) : e.project === project;
      if (!mine) continue;
      const got = norm(e.display ?? '');
      if (!want || got.startsWith(want) || got.includes('[Pasted text')) {
        return true;
      }
    } catch {
      /* partial line at the end of a write — the next poll re-reads it */
    }
  }
  return false;
}

const RULE = /^\s*─{8,}/;

/**
 * Content of Claude Code's prompt box: the text between the last two horizontal rules, if that
 * region starts with the `❯` prompt. Returns '' for an empty box and null when the screen does
 * not show a prompt box (a dialog, a menu, a different program).
 */
export function parsePromptBox(screen: string): string | null {
  const lines = screen.split('\n');
  const rules: number[] = [];
  lines.forEach((l, i) => {
    if (RULE.test(l)) rules.push(i);
  });
  if (rules.length < 2) return null;
  const top = rules[rules.length - 2];
  const bottom = rules[rules.length - 1];
  const box = lines.slice(top + 1, bottom);
  if (!box.length || !/^\s*❯/.test(box[0])) return null;
  box[0] = box[0].replace(/^\s*❯\s?/, '');
  return box
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

export async function confirmDelivery(d: DeliveryDeps): Promise<DeliveryOutcome> {
  let offset = d.historyOffset;
  const busyAtStart = d.isBusy();
  const landed = async (): Promise<boolean> => {
    const chunk = await d.readHistorySince(offset).catch(() => '');
    // Only advance past complete lines so a half-written entry is re-read next time.
    const complete = chunk.slice(0, chunk.lastIndexOf('\n') + 1);
    offset += Buffer.byteLength(complete);
    return historyHasPrompt(complete, d.sessionIds, d.project, d.text);
  };
  /**
   * Poll until the prompt lands, or Claude has been idle for `ms` (busy time doesn't count —
   * Claude records a queued prompt only when it picks it up). When Claude was idle at send time,
   * it starting to work means it took the message: count that as delivered even if the history
   * entry doesn't match, so a matching gap can never cause a duplicate retype.
   */
  const waitFor = async (ms: number, idleAtSend: boolean): Promise<boolean> => {
    const hardStop = d.now() + BUSY_WAIT_MAX_MS;
    let idleSince = d.now();
    while (d.now() < hardStop) {
      if (await landed()) return true;
      if (d.isBusy()) {
        if (idleAtSend) return true;
        idleSince = d.now();
      } else if (d.now() - idleSince >= ms) return false;
      await d.sleep(POLL_MS);
    }
    return landed();
  };

  if (await waitFor(DELIVERY_WAIT_MS, !busyAtStart)) return 'delivered';

  const raw = await d.captureScreen();
  const box = raw === null ? null : parsePromptBox(raw);
  if (box === null) return 'undelivered'; // unknown screen: typing blind could answer a dialog
  if (box) {
    await d.pressEnter();
    return (await waitFor(DELIVERY_WAIT_MS, true)) ? 'delivered-after-enter' : 'undelivered';
  }
  // Box empty. If Claude was busy when the message was typed we can't tell "swallowed" from
  // "consumed but recorded differently", so hand the text back instead of risking a duplicate.
  if (busyAtStart) return 'undelivered';
  await d.retype();
  return (await waitFor(DELIVERY_WAIT_MS, true)) ? 'delivered-after-retype' : 'undelivered';
}

export async function historySize(path = CLAUDE_HISTORY_PATH): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export async function readHistorySince(offset: number, path = CLAUDE_HISTORY_PATH): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= offset) return '';
    const buf = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024));
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

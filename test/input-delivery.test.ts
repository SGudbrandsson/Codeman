/**
 * Delivery confirmation for compose-bar messages (src/input-delivery.ts).
 *
 * Background: on 2026-11-12 five messages typed into long-running Claude sessions vanished —
 * the first message after a long idle, never recorded in ~/.claude/history.jsonl; resending the
 * same text worked every time. These tests drive confirmDelivery() with a fake clock and a fake
 * Claude whose history/screen/busy state we control.
 */

import { describe, it, expect } from 'vitest';
import {
  confirmDelivery,
  historyHasPrompt,
  parsePromptBox,
  DELIVERY_WAIT_MS,
  type DeliveryDeps,
} from '../src/input-delivery.js';

const RULE = '─'.repeat(60);
const screen = (box: string) =>
  ['  ● Some earlier answer', '', RULE, `❯\u00a0${box}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n');
const entry = (sessionId: string, display: string) =>
  JSON.stringify({ display, pastedContents: {}, timestamp: 1, project: '/p', sessionId }) + '\n';

const SID = 'sess-1';
const MSG = 'what key is the insurance on?';

/** Fake Claude: `history` is the appended history.jsonl text; actions can make prompts land. */
function fakeClaude(opts: {
  screen?: string | null;
  onEnter?: (h: { history: string }) => void;
  onRetype?: (h: { history: string }) => void;
  busyUntil?: number;
  landAt?: number; // virtual ms at which the original message lands
}) {
  let t = 0;
  const h = { history: '' };
  const calls = { enter: 0, retype: 0 };
  const deps: DeliveryDeps = {
    sessionIds: new Set([SID]),
    project: '/p',
    text: MSG,
    historyOffset: 0,
    readHistorySince: async (offset) => {
      if (opts.landAt !== undefined && t >= opts.landAt && !h.history.includes(MSG)) h.history += entry(SID, MSG);
      return h.history.slice(offset);
    },
    isBusy: () => t < (opts.busyUntil ?? 0),
    captureScreen: async () => (opts.screen === undefined ? screen('') : opts.screen),
    pressEnter: async () => {
      calls.enter++;
      opts.onEnter?.(h);
    },
    retype: async () => {
      calls.retype++;
      opts.onRetype?.(h);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return { deps, calls, h, time: () => t };
}

describe('parsePromptBox', () => {
  it('reads an empty box as empty, typed text as text, and anything else as unknown', () => {
    expect(parsePromptBox(screen(''))).toBe('');
    expect(parsePromptBox(screen('hello there'))).toBe('hello there');
    expect(parsePromptBox('Do you want to proceed?\n❯ 1. Yes\n  2. No')).toBeNull();
    expect(parsePromptBox('')).toBeNull();
  });
});

describe('historyHasPrompt', () => {
  it('matches this session and this text only', () => {
    expect(historyHasPrompt(entry(SID, MSG), new Set([SID]), '/p', MSG)).toBe(true);
    expect(historyHasPrompt(entry('other', MSG), new Set([SID]), '/p', MSG)).toBe(false);
    // A later, different message from the same session must not vouch for a lost one.
    expect(historyHasPrompt(entry(SID, 'something else'), new Set([SID]), '/p', MSG)).toBe(false);
    expect(historyHasPrompt(entry(SID, ''), new Set([SID]), '/p', MSG)).toBe(false);
    // Claude records long typed bursts as a paste placeholder.
    expect(historyHasPrompt(entry(SID, '[Pasted text #1 +12 lines]'), new Set([SID]), '/p', MSG)).toBe(true);
    // A half-written trailing line is ignored, not thrown on.
    expect(historyHasPrompt('{"display":"wh', new Set([SID]), '/p', MSG)).toBe(false);
  });
});

describe('confirmDelivery', () => {
  it('does nothing when Claude records the message', async () => {
    const c = fakeClaude({ landAt: 500 });
    expect(await confirmDelivery(c.deps)).toBe('delivered');
    expect(c.calls).toEqual({ enter: 0, retype: 0 });
  });

  it('retypes once when the keystrokes were swallowed (empty box), as the user had to by hand', async () => {
    const c = fakeClaude({ onRetype: (h) => (h.history += entry(SID, MSG)) });
    expect(await confirmDelivery(c.deps)).toBe('delivered-after-retype');
    expect(c.calls).toEqual({ enter: 0, retype: 1 });
    expect(c.time()).toBeGreaterThanOrEqual(DELIVERY_WAIT_MS);
  });

  it('presses Enter when the text is sitting unsent in the prompt box', async () => {
    const c = fakeClaude({ screen: screen(MSG), onEnter: (h) => (h.history += entry(SID, MSG)) });
    expect(await confirmDelivery(c.deps)).toBe('delivered-after-enter');
    expect(c.calls).toEqual({ enter: 1, retype: 0 });
  });

  it('reports undelivered after a retry that also fails — never retypes twice', async () => {
    const c = fakeClaude({});
    expect(await confirmDelivery(c.deps)).toBe('undelivered');
    expect(c.calls).toEqual({ enter: 0, retype: 1 });
  });

  it('does not type into an unknown screen (e.g. a dialog), just reports', async () => {
    const c = fakeClaude({ screen: 'Do you want to proceed?\n❯ 1. Yes\n  2. No' });
    expect(await confirmDelivery(c.deps)).toBe('undelivered');
    expect(c.calls).toEqual({ enter: 0, retype: 0 });
  });

  it('counts Claude starting work (idle at send) as delivered, never retyping a duplicate', async () => {
    const c = fakeClaude({});
    let first = true;
    c.deps.isBusy = () => {
      if (first) {
        first = false;
        return false; // idle when the message was typed
      }
      return true; // then working — but no matching history entry
    };
    expect(await confirmDelivery(c.deps)).toBe('delivered');
    expect(c.calls).toEqual({ enter: 0, retype: 0 });
  });

  it('busy at send and no history entry: hands the text back instead of retyping', async () => {
    const c = fakeClaude({ busyUntil: 60_000 });
    expect(await confirmDelivery(c.deps)).toBe('undelivered');
    expect(c.calls).toEqual({ enter: 0, retype: 0 });
  });

  it('waits out a busy Claude: a queued prompt is recorded only when it is picked up', async () => {
    const c = fakeClaude({ busyUntil: 120_000, landAt: 119_000 });
    expect(await confirmDelivery(c.deps)).toBe('delivered');
    expect(c.calls).toEqual({ enter: 0, retype: 0 });
  });
});

/**
 * Pure planner that turns a chunk of input into the ordered sequence of tmux
 * `send-keys` operations for an Ink-based CLI (Claude / OpenCode).
 *
 * Semantics:
 *  - `\r` → submit (Enter), sent as a *separate* key after the text so Ink treats
 *           it as form submission rather than a newline in the input buffer.
 *  - `\n` → C-j (Ctrl+J), a newline *within* Ink's input buffer.
 *  - Each line's text is sent verbatim. Trailing and standalone spaces are
 *    preserved — a lone " " is a real keystroke (e.g. toggling an item in Claude
 *    Code's selection menus), not noise to be stripped.
 *
 * History: this logic used to `trimEnd()` each line, which silently dropped space
 * keystrokes and whitespace-only lines. That broke the space bar in Claude
 * sessions and made selection menus appear completely broken. Do NOT reintroduce
 * trimming here — see test/tmux-send-keys-plan.test.ts.
 *
 * Delays mirror the original send-then-settle timing so Ink has time to process
 * each piece before the next: 50ms after every literal/newline, 100ms before Enter.
 */
export type SendKeysStep =
  | { type: 'literal'; text: string }
  | { type: 'key'; key: 'C-j' | 'Enter' }
  | { type: 'delay'; ms: number };

export function planSendKeys(input: string): SendKeysStep[] {
  const steps: SendKeysStep[] = [];
  const hasCarriageReturn = input.includes('\r');
  // Strip \r (handled below as Enter); split on \n into buffer lines.
  const lines = input.replace(/\r/g, '').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLastLine = i === lines.length - 1;

    // Send any non-empty line verbatim. `length > 0` (not truthiness on a
    // trimmed string) is what keeps a lone/ trailing space alive.
    if (line.length > 0) {
      steps.push({ type: 'literal', text: line });
      steps.push({ type: 'delay', ms: 50 });
    }

    // A \n between lines becomes C-j: a newline inside Ink's input buffer.
    if (!isLastLine) {
      steps.push({ type: 'key', key: 'C-j' });
      steps.push({ type: 'delay', ms: 50 });
    }
  }

  if (hasCarriageReturn) {
    steps.push({ type: 'delay', ms: 100 });
    steps.push({ type: 'key', key: 'Enter' });
  }

  return steps;
}

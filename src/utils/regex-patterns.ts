/**
 * @fileoverview Shared regex patterns for terminal and token parsing.
 *
 * Pre-compiled patterns avoid re-compilation overhead on each use.
 * Import these patterns instead of defining them locally.
 *
 * @module utils/regex-patterns
 */

/**
 * Comprehensive ANSI escape pattern that handles:
 * - SGR (colors/styles): ESC [ params m
 * - CSI sequences (cursor, scroll, etc.): ESC [ params letter
 * - OSC sequences (title, etc.): ESC ] ... BEL or ESC ] ... ST
 * - Character set select: ESC ( X  (e.g. ESC(B for US ASCII, ESC(0 for line drawing)
 * - Single-char C1 escapes: ESC 7, ESC 8, ESC M, ESC c, ESC =, ESC >
 *
 * Use this when you need complete ANSI stripping including OSC sequences.
 * Note: Has global flag - reset lastIndex before exec() if reusing.
 */
export const ANSI_ESCAPE_PATTERN_FULL =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\([A-Za-z0-9]|[78Mc=>])/g;

/**
 * Simple ANSI CSI-only pattern for basic escape code stripping.
 * Matches: ESC [ params letter (e.g., colors, cursor movement)
 *
 * Use this for faster stripping when OSC sequences aren't a concern.
 * Note: Has global flag - reset lastIndex before exec() if reusing.
 */
// eslint-disable-next-line no-control-regex
export const ANSI_ESCAPE_PATTERN_SIMPLE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Pattern to extract token count from Claude's status line.
 * Matches: "123.4k tokens", "5234 tokens", "1.2M tokens"
 *
 * Capture groups:
 * - Group 1: The numeric value (e.g., "123.4", "5234", "1.2")
 * - Group 2: Optional suffix (k, K, m, M) or undefined
 */
export const TOKEN_PATTERN = /(\d+(?:\.\d+)?)\s*([kKmM])?\s*tokens/;

/**
 * Creates a fresh copy of ANSI_ESCAPE_PATTERN_FULL.
 * Use when you need a pattern without shared lastIndex state.
 */
export function createAnsiPatternFull(): RegExp {
  // eslint-disable-next-line no-control-regex
  return /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\([A-Za-z0-9]|[78Mc=>])/g;
}

/**
 * Creates a fresh copy of ANSI_ESCAPE_PATTERN_SIMPLE.
 * Use when you need a pattern without shared lastIndex state.
 */
export function createAnsiPatternSimple(): RegExp {
  // eslint-disable-next-line no-control-regex
  return /\x1b\[[0-9;]*[A-Za-z]/g;
}

/**
 * Strips ANSI escape codes from text using the comprehensive pattern.
 * @param text - Text containing ANSI escape codes
 * @returns Text with ANSI codes removed
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN_FULL, '');
}

/**
 * Regex to validate safe file paths (no shell metacharacters).
 * Shared by schemas.ts and tmux-manager.ts for consistent path validation.
 */
/**
 * Braille spinner characters used by Claude Code's Ink UI.
 * Matches any of: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧
 * Used on the hot path (every PTY chunk) — pre-compiled for performance.
 */
export const SPINNER_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧]/;

export const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_/\-. ~]+$/;

/**
 * Execute a global regex pattern against data, calling the callback for each match.
 * Automatically resets lastIndex before execution.
 */
export function execPattern(pattern: RegExp, data: string, callback: (match: RegExpExecArray) => void): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(data)) !== null) {
    callback(match);
  }
}

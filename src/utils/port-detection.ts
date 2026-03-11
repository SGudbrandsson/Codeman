/**
 * @fileoverview Port detection and allocation for worktree sessions.
 *
 * Detects ports used by a project by scanning CLAUDE.md (and optionally
 * package.json scripts), then allocates unique ports for worktree sessions
 * so multiple sessions can run dev servers simultaneously without clashing.
 *
 * Detection patterns (in priority order):
 *   - localhost:NNNN / 127.0.0.1:NNNN
 *   - --port NNNN (CLI flags)
 *   - PORT=NNNN / PORT: NNNN (env var style)
 *   - port: NNNN / Default port: NNNN (word "port" + optional punctuation + number)
 *
 * Deliberately excluded: z-index values, version numbers, CSS values.
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';

const PORT_RANGE_MIN = 1024;
const PORT_RANGE_MAX = 65535;

/** Ordered list of regex patterns to detect port numbers. Each captures the port in group 1. */
const PORT_PATTERNS: RegExp[] = [
  // localhost:NNNN or 127.0.0.1:NNNN
  /\blocalhost:(\d{4,5})\b/gi,
  /\b127\.0\.0\.1:(\d{4,5})\b/g,
  /\b0\.0\.0\.0:(\d{4,5})\b/g,
  // --port NNNN or --port=NNNN
  /--port[=\s]+(\d{4,5})\b/gi,
  // PORT=NNNN or PORT: NNNN (env var style, uppercase)
  /\bPORT[=:\s]+(\d{4,5})\b/g,
  // word "port" followed by optional punctuation/markdown then a 4-5 digit number
  // e.g. "Default port: `3000`", "Port: **3001**"
  // Limit lookahead to 20 chars to avoid false matches across sentences
  /\bport[^a-zA-Z]{1,20}?(\d{4,5})\b/gi,
];

/**
 * Extract all port numbers from a text string using known port patterns.
 * Returns a sorted, deduplicated array of valid port numbers.
 */
export function extractPortsFromText(text: string): number[] {
  const found = new Set<number>();
  for (const pattern of PORT_PATTERNS) {
    // Reset lastIndex since patterns have /g flag
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const port = parseInt(match[1], 10);
      if (port >= PORT_RANGE_MIN && port <= PORT_RANGE_MAX) {
        found.add(port);
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Scan a project directory for port numbers.
 *
 * Reads (in order, stops accumulating after finding ports):
 *   1. CLAUDE.md
 *   2. package.json scripts section
 *
 * Returns sorted array of detected port numbers, empty if none found.
 */
export async function detectPortsFromDir(workingDir: string): Promise<number[]> {
  const ports = new Set<number>();

  // 1. CLAUDE.md
  try {
    const claudeMd = await fs.readFile(join(workingDir, 'CLAUDE.md'), 'utf-8');
    for (const p of extractPortsFromText(claudeMd)) ports.add(p);
  } catch {
    /* no CLAUDE.md */
  }

  // 2. package.json scripts (only if CLAUDE.md found nothing)
  if (ports.size === 0) {
    try {
      const raw = await fs.readFile(join(workingDir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      const scripts = Object.values(pkg.scripts ?? {}).join('\n');
      for (const p of extractPortsFromText(scripts)) ports.add(p);
    } catch {
      /* no package.json or invalid */
    }
  }

  return [...ports].sort((a, b) => a - b);
}

/**
 * Allocate the next available port for a new worktree session.
 *
 * Strategy:
 *   - basePorts: ports the project already uses (detected from CLAUDE.md etc.)
 *   - usedPorts: ports already assigned to other sessions in this project
 *   - Returns: max(basePorts, usedPorts) + 1, skipping any still-used ports
 *
 * Returns null if basePorts is empty (unknown project port config — skip allocation).
 */
export function allocateNextPort(basePorts: number[], usedPorts: number[]): number | null {
  if (basePorts.length === 0) return null;

  const allKnown = new Set([...basePorts, ...usedPorts]);
  const start = Math.max(...basePorts, ...(usedPorts.length ? usedPorts : [0])) + 1;

  let port = start;
  while (allKnown.has(port) && port <= PORT_RANGE_MAX) {
    port++;
  }
  return port <= PORT_RANGE_MAX ? port : null;
}

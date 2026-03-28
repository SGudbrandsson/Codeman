/** A linked-case entry is either a plain path string or an object with a `path` field. */
export type LinkedCaseEntry = string | { path: string; orchestrationEnabled?: boolean };

/** The shape of `~/.codeman/linked-cases.json`. */
export type LinkedCasesMap = Record<string, LinkedCaseEntry>;

/**
 * Extracts the filesystem path from a linked-case entry, handling both the
 * legacy string format and the newer object format (`{ path, orchestrationEnabled }`).
 */
export function resolveLinkedCasePath(entry: LinkedCaseEntry): string {
  return typeof entry === 'string' ? entry : entry.path;
}

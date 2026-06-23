/** Extract the `status:` field value from a TASK.md body, or null if absent. */
export function parseTaskPhase(content: string): string | null {
  const m = content.match(/^[ \t]*status:[ \t]*(\S.*?)[ \t]*$/im);
  return m ? m[1] : null;
}

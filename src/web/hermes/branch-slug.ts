export function slugifyBranch(title: string, prefix: 'feat' | 'fix'): string {
  let body = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (body.length > 37) {
    body = body.slice(0, 37);
    // Cut back to the last word boundary so we never end on a partial word.
    // (If there's no hyphen within 37 chars, keep the hard slice.)
    const lastHyphen = body.lastIndexOf('-');
    if (lastHyphen > 0) body = body.slice(0, lastHyphen);
    body = body.replace(/-+$/g, '');
  }
  if (!body) body = 'task';
  return `${prefix}/${body}`;
}

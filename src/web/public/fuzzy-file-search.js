/**
 * @fileoverview fzf-style fuzzy file matcher for the Files sheet search.
 *
 * Pure functions, no DOM: the Files sheet (app.js `_filesSearch*`) fetches a flat
 * path index once per sheet open/refresh, calls prepare() once, then rank() per
 * keystroke. Hand-written (no dependency), modelled on fzf v1:
 *   - query characters match in order with gaps allowed, case-insensitive;
 *   - a forward scan finds the earliest complete match, a backward scan from its
 *     end finds the shortest window, whose positions are scored;
 *   - a match entirely inside the basename is preferred (big bonus);
 *   - bonuses for path-segment / word / camelCase boundaries and consecutive runs,
 *     penalties for gaps, a tiny length penalty as tie-breaker;
 *   - whitespace separates terms which must ALL match (fzf AND).
 *
 * parsePathQuery() handles the "paste a reference" case (`src/app.ts:42:7`,
 * `./x.js`, `` `a.ts` ``, `a.ts#L12`, absolute paths inside the working dir).
 *
 * Loaded as a classic script before app.js; exposes the global FuzzyFileSearch.
 * Unit tests evaluate this file's source directly (test/fuzzy-file-search.test.ts).
 */
const FuzzyFileSearch = (() => {
  const SCORE_MATCH = 16;
  const BONUS_BOUNDARY = 10;
  const BONUS_SLASH = 12;
  const BONUS_CONSECUTIVE = 8;
  const PENALTY_GAP_START = 3;
  const PENALTY_GAP_EXTRA = 1;
  const MAX_GAP_EXTRA = 15;
  const BONUS_BASENAME = 30;
  const BONUS_BASENAME_FIRST = 15;
  const BONUS_BASENAME_PREFIX = 40;
  const BONUS_BASENAME_EXACT = 100;
  const LENGTH_PENALTY = 0.1;

  function localEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Precompute lowercased paths and basename offsets (once per index load). */
  function prepare(paths) {
    const list = Array.isArray(paths) ? paths : [];
    const lower = new Array(list.length);
    const baseStart = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      lower[i] = p.toLowerCase();
      baseStart[i] = p.lastIndexOf('/') + 1;
    }
    return { paths: list, lower, baseStart };
  }

  /**
   * Shortest in-order window match of `q` in `lower` starting at `from`.
   * Returns positions (ascending) or null.
   */
  function windowMatch(q, lower, from) {
    // Forward scan: earliest end of a complete match.
    let idx = from;
    let end = -1;
    for (let k = 0; k < q.length; k++) {
      const p = lower.indexOf(q[k], idx);
      if (p < 0) return null;
      end = p;
      idx = p + 1;
    }
    // Backward scan from the end: shortest window, positions taken right-to-left.
    const positions = new Array(q.length);
    let j = end;
    for (let k = q.length - 1; k >= 0; k--) {
      const p = lower.lastIndexOf(q[k], j);
      // Cannot fail (the forward scan proved a match exists) but stay defensive.
      if (p < from) return null;
      positions[k] = p;
      j = p - 1;
    }
    return positions;
  }

  function isLower(c) { return c >= 'a' && c <= 'z'; }
  function isUpper(c) { return c >= 'A' && c <= 'Z'; }

  function scorePositions(path, positions, baseStart, q) {
    let score = 0;
    let prev = -2;
    let run = 0;
    for (let k = 0; k < positions.length; k++) {
      const pos = positions[k];
      score += SCORE_MATCH;
      if (pos === 0 || pos === baseStart) {
        score += BONUS_SLASH;
      } else {
        const before = path[pos - 1];
        if (before === '/') score += BONUS_SLASH;
        else if (before === '_' || before === '-' || before === '.' || before === ' ') score += BONUS_BOUNDARY;
        else if (isUpper(path[pos]) && isLower(before)) score += BONUS_BOUNDARY;
      }
      if (k > 0) {
        if (pos === prev + 1) {
          run++;
          score += BONUS_CONSECUTIVE + Math.min(run, 4);
        } else {
          run = 0;
          const gap = pos - prev - 1;
          score -= PENALTY_GAP_START + Math.min(gap - 1, MAX_GAP_EXTRA) * PENALTY_GAP_EXTRA;
        }
      }
      prev = pos;
    }
    if (positions.length && positions[0] >= baseStart) {
      score += BONUS_BASENAME;
      if (positions[0] === baseStart) score += BONUS_BASENAME_FIRST;
      const base = path.slice(baseStart).toLowerCase();
      if (base === q) score += BONUS_BASENAME_EXACT;
      else if (base.startsWith(q)) score += BONUS_BASENAME_PREFIX;
    }
    return score - LENGTH_PENALTY * path.length;
  }

  /** Match one whitespace-free, lowercased term. */
  function matchTerm(q, path, lowerPath, baseStart) {
    if (!q) return { score: 0, positions: [] };
    // Prefer a match entirely inside the basename.
    let positions = baseStart > 0 ? windowMatch(q, lowerPath, baseStart) : null;
    if (!positions) positions = windowMatch(q, lowerPath, 0);
    if (!positions) return null;
    return { score: scorePositions(path, positions, baseStart, q), positions };
  }

  function splitTerms(query) {
    return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  function matchTerms(terms, path, lowerPath, baseStart) {
    if (terms.length === 1) return matchTerm(terms[0], path, lowerPath, baseStart);
    let score = 0;
    const set = new Set();
    for (const t of terms) {
      const m = matchTerm(t, path, lowerPath, baseStart);
      if (!m) return null;
      score += m.score;
      for (const p of m.positions) set.add(p);
    }
    return { score, positions: Array.from(set).sort((a, b) => a - b) };
  }

  /**
   * Match `query` against one path. `lowerPath` / `baseStart` are optional
   * (computed when omitted). Returns null or { score, positions }.
   */
  function match(query, path, lowerPath, baseStart) {
    const terms = splitTerms(query);
    if (!terms.length) return null;
    const lower = lowerPath != null ? lowerPath : path.toLowerCase();
    const bs = baseStart != null ? baseStart : path.lastIndexOf('/') + 1;
    return matchTerms(terms, path, lower, bs);
  }

  function compareResults(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  }

  /**
   * Rank the prepared index against `query`; returns the top `limit` results.
   * Pass the previous return value as `prevState`: when the new query extends the
   * previous one, only the previous candidates are re-scanned.
   * -> { results: [{ path, score, positions }], total, candidates, query }
   */
  function rank(index, query, limit, prevState) {
    const max = limit > 0 ? limit : 100;
    const q = String(query || '').toLowerCase();
    const terms = splitTerms(q);
    if (!index || !terms.length) return { results: [], total: 0, candidates: null, query: q };
    const { paths, lower, baseStart } = index;
    const narrow = prevState && prevState.candidates && prevState.query && q.startsWith(prevState.query);
    const source = narrow ? prevState.candidates : null;
    const n = source ? source.length : paths.length;
    const candidates = [];
    const top = [];
    // Fast prefilter on the first term's characters before scoring.
    const first = terms[0];
    for (let s = 0; s < n; s++) {
      const i = source ? source[s] : s;
      const lp = lower[i];
      let idx = 0;
      let ok = true;
      for (let k = 0; k < first.length; k++) {
        idx = lp.indexOf(first[k], idx);
        if (idx < 0) { ok = false; break; }
        idx++;
      }
      if (!ok) continue;
      const m = matchTerms(terms, paths[i], lp, baseStart[i]);
      if (!m) continue;
      candidates.push(i);
      const r = { path: paths[i], score: m.score, positions: m.positions };
      if (top.length < max) {
        insertSorted(top, r);
      } else if (compareResults(r, top[top.length - 1]) < 0) {
        top.pop();
        insertSorted(top, r);
      }
    }
    return { results: top, total: candidates.length, candidates, query: q };
  }

  function insertSorted(arr, r) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareResults(arr[mid], r) <= 0) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, r);
  }

  /** Escape `text[from, to)` with matched chars wrapped in <mark>, per segment. */
  function markRange(text, from, to, marked, esc) {
    let out = '';
    let i = from;
    while (i < to) {
      const on = marked.has(i);
      let j = i + 1;
      while (j < to && marked.has(j) === on) j++;
      const seg = esc(text.slice(i, j));
      out += on ? '<mark>' + seg + '</mark>' : seg;
      i = j;
    }
    return out;
  }

  /**
   * HTML for a result path: directory dimmed, basename emphasised, matched
   * characters in <mark>. Every raw segment is escaped separately (positions are
   * raw-string offsets, so tags are never inserted into escaped text).
   */
  function highlightHtml(path, positions, escapeFn) {
    const esc = typeof escapeFn === 'function' ? escapeFn : localEscape;
    const p = String(path);
    const marked = new Set(positions || []);
    const bs = p.lastIndexOf('/') + 1;
    const dir = bs > 0 ? '<span class="files-search-dir">' + markRange(p, 0, bs, marked, esc) + '</span>' : '';
    return dir + '<span class="files-search-base">' + markRange(p, bs, p.length, marked, esc) + '</span>';
  }

  /**
   * Parse a typed/pasted query into a path reference.
   * -> { isPath, path, line, col, term }
   *   isPath: contains '/' or starts with './' (open-by-path affordance)
   *   path:   relative path (absolute inside workingDir made relative, './' stripped)
   *   line/col: from `:line[:col]` or `#Lline` suffix, else null
   *   term:   text used for fuzzy matching (path without the line suffix)
   */
  function parsePathQuery(query, workingDir) {
    let t = String(query || '').trim();
    // One pair of surrounding quotes / backticks.
    if (t.length >= 2) {
      const a = t[0];
      if ((a === '`' || a === '"' || a === "'") && t[t.length - 1] === a) t = t.slice(1, -1).trim();
    }
    // Trailing sentence punctuation and a trailing ':' (e.g. "see src/a.ts:42.").
    const stripped = t.replace(/[.,;:]+$/, '');
    if (stripped && !/^\.*$/.test(stripped)) t = stripped;
    const isPath = t.indexOf('/') >= 0 || t.startsWith('./');
    let line = null;
    let col = null;
    const m = t.match(/#L(\d+)(?:C(\d+))?$/) || t.match(/:(\d+)(?::(\d+))?$/);
    if (m && m.index > 0) {
      t = t.slice(0, m.index);
      const ln = parseInt(m[1], 10);
      if (ln >= 1) {
        line = ln;
        if (m[2]) {
          const c = parseInt(m[2], 10);
          if (c >= 1) col = c;
        }
      }
    }
    let path = t;
    if (workingDir && path.charAt(0) === '/') {
      const wd = workingDir.replace(/\/+$/, '');
      if (path.indexOf(wd + '/') === 0) path = path.slice(wd.length + 1);
    }
    while (path.startsWith('./')) path = path.slice(2);
    return { isPath, path, line, col, term: path };
  }

  return { prepare, match, rank, highlightHtml, parsePathQuery };
})();

/**
 * @fileoverview Client-side secret detection and redaction for chat input.
 *
 * Scans message text for high-confidence secret patterns (API keys, tokens,
 * private keys, etc.) before the message is sent. Detected secrets are replaced
 * with named placeholders ([SECRET_<TYPE>_<N>]) and the real values are stored
 * in a session-scoped in-memory Map — never written to disk or sent over the wire.
 *
 * @namespace SecretDetector
 * @loadorder 5 of 10 — loaded after notification-manager.js, before keyboard-accessory.js
 */

// Codeman — Client-side secret detection and redaction
// Loaded before app.js

const SecretDetector = (function () {
  // Session-scoped maps: sessionId -> Map<placeholder, realValue>
  const _sessionMaps = new Map();

  // Per-session counters: sessionId -> Map<type, count>
  const _sessionCounters = new Map();

  // High-confidence secret patterns only — ordered from most-specific to least-specific
  // to avoid partial matches by more-generic patterns stealing tokens from specific ones.
  const PATTERNS = [
    // Anthropic API key
    { type: 'ANTHROPIC_KEY',   re: /\bsk-ant-[a-zA-Z0-9\-_]{93}\b/g },
    // OpenAI project key (must come before generic sk- pattern)
    { type: 'OPENAI_PROJ_KEY', re: /\bsk-proj-[a-zA-Z0-9\-_]{50,}\b/g },
    // OpenAI API key
    { type: 'OPENAI_KEY',      re: /\bsk-[a-zA-Z0-9]{48}\b/g },
    // AWS Access Key ID
    { type: 'AWS_ACCESS_KEY',  re: /\bAKIA[0-9A-Z]{16}\b/g },
    // GitHub fine-grained PAT (must come before classic ghp_ pattern)
    { type: 'GITHUB_FINE_PAT', re: /\bgithub_pat_[0-9a-zA-Z_]{82}\b/g },
    // GitHub classic PAT
    { type: 'GITHUB_PAT',      re: /\bghp_[0-9a-zA-Z]{36}\b/g },
    // Stripe restricted key (must come before secret key pattern)
    { type: 'STRIPE_RK',       re: /\brk_live_[0-9a-zA-Z]{24,}\b/g },
    // Stripe secret key
    { type: 'STRIPE_SK',       re: /\bsk_live_[0-9a-zA-Z]{24,}\b/g },
    // Slack token
    { type: 'SLACK_TOKEN',     re: /\bxox[baprs]-[0-9a-zA-Z\-]{10,}\b/g },
    // npm token
    { type: 'NPM_TOKEN',       re: /\bnpm_[a-zA-Z0-9]{36}\b/g },
    // PEM private key block (multi-line)
    { type: 'PRIVATE_KEY',     re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
    // Bearer JWT (three-part dot-separated token after "Bearer ")
    { type: 'BEARER_JWT',      re: /Bearer\s+([A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_.+\/=]+)/g },
  ];

  /**
   * Returns true when secret redaction is enabled (default: on).
   * Delegates to window.app.loadAppSettingsFromStorage() so it always
   * reads from whichever localStorage key the app uses at runtime
   * (desktop vs mobile keys differ).
   */
  function isEnabled() {
    try {
      const s = (window.app && typeof window.app.loadAppSettingsFromStorage === 'function')
        ? window.app.loadAppSettingsFromStorage()
        : {};
      return s.secretRedactionEnabled !== false;
    } catch (_e) {
      return true;
    }
  }

  /**
   * Scans `text` for secrets.  Any matches are replaced with stable named
   * placeholders and the real values are stored in the session-scoped map.
   *
   * @param {string} sessionId  Active session identifier (used as map key).
   * @param {string} text       The raw message text to scan.
   * @returns {{ redacted: string, count: number, types: string[] }}
   *   `redacted` — text with secrets replaced by placeholders.
   *   `count`    — number of secrets found.
   *   `types`    — array of type strings (e.g. ['OPENAI_KEY', 'GITHUB_PAT']).
   */
  function scan(sessionId, text) {
    if (!sessionId || !text) return { redacted: text, count: 0, types: [] };

    if (!_sessionMaps.has(sessionId)) _sessionMaps.set(sessionId, new Map());
    if (!_sessionCounters.has(sessionId)) _sessionCounters.set(sessionId, new Map());

    const secretMap = _sessionMaps.get(sessionId);
    const counters  = _sessionCounters.get(sessionId);

    let redacted = text;
    let count = 0;
    const typesFound = [];

    for (const { type, re } of PATTERNS) {
      // Reset lastIndex so the regex is stateless across calls
      re.lastIndex = 0;

      const newText = redacted.replace(re, (match, ...args) => {
        // For Bearer JWT the real secret is capture group 1 (the token itself);
        // for all others the whole match is the secret.
        const secret = (type === 'BEARER_JWT' && args[0]) ? args[0] : match;

        // Check if we already have a placeholder for this exact value
        let placeholder = null;
        for (const [ph, val] of secretMap.entries()) {
          if (val === secret) { placeholder = ph; break; }
        }

        if (!placeholder) {
          const n = (counters.get(type) || 0) + 1;
          counters.set(type, n);
          placeholder = `[SECRET_${type}_${n}]`;
          secretMap.set(placeholder, secret);
          count++;
          if (!typesFound.includes(type)) typesFound.push(type);
        }

        // For Bearer JWT, replace only the token part, keep the "Bearer " prefix
        return type === 'BEARER_JWT' ? match.replace(secret, placeholder) : placeholder;
      });

      redacted = newText;
    }

    return { redacted, count, types: typesFound };
  }

  /**
   * Clears the secret map and counters for a given session.
   * Call this when the user switches away from a session or the session ends.
   *
   * @param {string} sessionId
   */
  function clearSession(sessionId) {
    _sessionMaps.delete(sessionId);
    _sessionCounters.delete(sessionId);
  }

  /**
   * Clears all session secret maps and counters.
   * Call on page unload.
   */
  function clearAll() {
    _sessionMaps.clear();
    _sessionCounters.clear();
  }

  // Clear all secrets when the page is closed or navigated away
  window.addEventListener('pagehide', clearAll);

  return { scan, clearSession, clearAll, isEnabled };
})();

/**
 * @fileoverview Tests for SecretDetector — client-side secret detection and redaction.
 *
 * Because secret-detector.js is a browser IIFE (no ES module exports), the core
 * logic is replicated here as pure functions matching the exact implementation in
 * src/web/public/secret-detector.js. This mirrors the approach used in
 * paste-newline-routing.test.ts and terminal-parsing.test.ts.
 *
 * isEnabled() is tested separately using vi.stubGlobal to mock window.app.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Replicated logic from src/web/public/secret-detector.js
// ---------------------------------------------------------------------------

// High-confidence secret patterns — ordered most-specific to least-specific.
const PATTERNS = [
  { type: 'ANTHROPIC_KEY', re: /\bsk-ant-[a-zA-Z0-9\-_]{93}\b/g },
  { type: 'OPENAI_PROJ_KEY', re: /\bsk-proj-[a-zA-Z0-9\-_]{50,}\b/g },
  { type: 'OPENAI_KEY', re: /\bsk-[a-zA-Z0-9]{48}\b/g },
  { type: 'AWS_ACCESS_KEY', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'GITHUB_FINE_PAT', re: /\bgithub_pat_[0-9a-zA-Z_]{82}\b/g },
  { type: 'GITHUB_PAT', re: /\bghp_[0-9a-zA-Z]{36}\b/g },
  { type: 'STRIPE_RK', re: /\brk_live_[0-9a-zA-Z]{24,}\b/g },
  { type: 'STRIPE_SK', re: /\bsk_live_[0-9a-zA-Z]{24,}\b/g },
  { type: 'SLACK_TOKEN', re: /\bxox[baprs]-[0-9a-zA-Z\-]{10,}\b/g },
  { type: 'NPM_TOKEN', re: /\bnpm_[a-zA-Z0-9]{36}\b/g },
  {
    type: 'PRIVATE_KEY',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
  { type: 'BEARER_JWT', re: /Bearer\s+([A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_.+\/=]+)/g },
];

// Session-scoped state (mirrors the IIFE's private Maps).
let _sessionMaps: Map<string, Map<string, string>>;
let _sessionCounters: Map<string, Map<string, number>>;

function resetState() {
  _sessionMaps = new Map();
  _sessionCounters = new Map();
}

function scan(sessionId: string, text: string): { redacted: string; count: number; types: string[] } {
  if (!sessionId || !text) return { redacted: text, count: 0, types: [] };

  if (!_sessionMaps.has(sessionId)) _sessionMaps.set(sessionId, new Map());
  if (!_sessionCounters.has(sessionId)) _sessionCounters.set(sessionId, new Map());

  const secretMap = _sessionMaps.get(sessionId)!;
  const counters = _sessionCounters.get(sessionId)!;

  let redacted = text;
  let count = 0;
  const typesFound: string[] = [];

  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;

    const newText = redacted.replace(re, (match, ...args) => {
      const secret = type === 'BEARER_JWT' && args[0] ? args[0] : match;

      let placeholder: string | null = null;
      for (const [ph, val] of secretMap.entries()) {
        if (val === secret) {
          placeholder = ph;
          break;
        }
      }

      if (!placeholder) {
        const n = (counters.get(type) || 0) + 1;
        counters.set(type, n);
        placeholder = `[SECRET_${type}_${n}]`;
        secretMap.set(placeholder, secret);
        count++;
        if (!typesFound.includes(type)) typesFound.push(type);
      }

      return type === 'BEARER_JWT' ? match.replace(secret, placeholder) : placeholder;
    });

    redacted = newText;
  }

  return { redacted, count, types: typesFound };
}

function clearSession(sessionId: string) {
  _sessionMaps.delete(sessionId);
  _sessionCounters.delete(sessionId);
}

function clearAll() {
  _sessionMaps.clear();
  _sessionCounters.clear();
}

function isEnabled(): boolean {
  try {
    const w = globalThis as any;
    const s = w.app && typeof w.app.loadAppSettingsFromStorage === 'function' ? w.app.loadAppSettingsFromStorage() : {};
    return s.secretRedactionEnabled !== false;
  } catch (_e) {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Test data constants
// ---------------------------------------------------------------------------

// 5 spec-required types
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'; // AKIA + 16 uppercase alphanumeric
const GITHUB_PAT = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'; // ghp_ + 36 chars
const OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV'; // sk- + 48 alphanumeric
const STRIPE_SK = ['sk', 'live', 'X'.repeat(24)].join('_'); // sk_live_ + 24 chars (built at runtime to avoid push protection)
const PEM_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';

// 7 additional implemented types
const ANTHROPIC_KEY = 'sk-ant-' + 'a'.repeat(93); // sk-ant- + 93 chars
const OPENAI_PROJ = 'sk-proj-' + 'b'.repeat(50); // sk-proj- + 50 chars
const GITHUB_FINE = 'github_pat_' + 'c'.repeat(82); // github_pat_ + 82 chars
const STRIPE_RK = ['rk', 'live', 'Y'.repeat(24)].join('_'); // rk_live_ + 24 chars (built at runtime to avoid push protection)
const SLACK_TOKEN = 'xoxb-12345678901-abcdefghij'; // xoxb- + >=10 chars
const NPM_TOKEN = 'npm_abcdefghijklmnopqrstuvwxyz1234567890'; // npm_ + 36 chars
const BEARER_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SecretDetector', () => {
  beforeEach(() => {
    resetState();
  });

  // -------------------------------------------------------------------------
  // 5 spec-required pattern types
  // -------------------------------------------------------------------------

  describe('spec-required pattern types', () => {
    it('redacts AWS AKIA access key', () => {
      const { redacted, count, types } = scan('s1', `My key is ${AWS_KEY} please use it`);
      expect(redacted).not.toContain(AWS_KEY);
      expect(redacted).toContain('[SECRET_AWS_ACCESS_KEY_1]');
      expect(count).toBe(1);
      expect(types).toContain('AWS_ACCESS_KEY');
    });

    it('redacts GitHub classic PAT (ghp_)', () => {
      const { redacted, count, types } = scan('s1', `token: ${GITHUB_PAT}`);
      expect(redacted).not.toContain(GITHUB_PAT);
      expect(redacted).toContain('[SECRET_GITHUB_PAT_1]');
      expect(count).toBe(1);
      expect(types).toContain('GITHUB_PAT');
    });

    it('redacts OpenAI key (sk- + 48 chars)', () => {
      const { redacted, count, types } = scan('s1', `OPENAI_API_KEY=${OPENAI_KEY}`);
      expect(redacted).not.toContain(OPENAI_KEY);
      expect(redacted).toContain('[SECRET_OPENAI_KEY_1]');
      expect(count).toBe(1);
      expect(types).toContain('OPENAI_KEY');
    });

    it('redacts Stripe secret key (sk_live_)', () => {
      const { redacted, count, types } = scan('s1', `stripe key: ${STRIPE_SK}`);
      expect(redacted).not.toContain(STRIPE_SK);
      expect(redacted).toContain('[SECRET_STRIPE_SK_1]');
      expect(count).toBe(1);
      expect(types).toContain('STRIPE_SK');
    });

    it('redacts PEM RSA private key block', () => {
      const { redacted, count, types } = scan('s1', `Here is my key:\n${PEM_KEY}\nDone.`);
      expect(redacted).not.toContain('BEGIN RSA PRIVATE KEY');
      expect(redacted).toContain('[SECRET_PRIVATE_KEY_1]');
      expect(count).toBe(1);
      expect(types).toContain('PRIVATE_KEY');
    });
  });

  // -------------------------------------------------------------------------
  // 7 additional implemented pattern types
  // -------------------------------------------------------------------------

  describe('additional implemented pattern types', () => {
    it('redacts Anthropic key (sk-ant-)', () => {
      const { redacted, count, types } = scan('s1', `key=${ANTHROPIC_KEY}`);
      expect(redacted).not.toContain(ANTHROPIC_KEY);
      expect(redacted).toContain('[SECRET_ANTHROPIC_KEY_1]');
      expect(count).toBe(1);
      expect(types).toContain('ANTHROPIC_KEY');
    });

    it('redacts OpenAI project key (sk-proj-)', () => {
      const { redacted, count, types } = scan('s1', `key=${OPENAI_PROJ}`);
      expect(redacted).not.toContain(OPENAI_PROJ);
      expect(redacted).toContain('[SECRET_OPENAI_PROJ_KEY_1]');
      expect(count).toBe(1);
      expect(types).toContain('OPENAI_PROJ_KEY');
    });

    it('redacts GitHub fine-grained PAT (github_pat_)', () => {
      const { redacted, count, types } = scan('s1', `pat: ${GITHUB_FINE}`);
      expect(redacted).not.toContain(GITHUB_FINE);
      expect(redacted).toContain('[SECRET_GITHUB_FINE_PAT_1]');
      expect(count).toBe(1);
      expect(types).toContain('GITHUB_FINE_PAT');
    });

    it('redacts Stripe restricted key (rk_live_)', () => {
      const { redacted, count, types } = scan('s1', `rk: ${STRIPE_RK}`);
      expect(redacted).not.toContain(STRIPE_RK);
      expect(redacted).toContain('[SECRET_STRIPE_RK_1]');
      expect(count).toBe(1);
      expect(types).toContain('STRIPE_RK');
    });

    it('redacts Slack token (xoxb-)', () => {
      const { redacted, count, types } = scan('s1', `slack: ${SLACK_TOKEN}`);
      expect(redacted).not.toContain(SLACK_TOKEN);
      expect(redacted).toContain('[SECRET_SLACK_TOKEN_1]');
      expect(count).toBe(1);
      expect(types).toContain('SLACK_TOKEN');
    });

    it('redacts npm token (npm_)', () => {
      const { redacted, count, types } = scan('s1', `npm token: ${NPM_TOKEN}`);
      expect(redacted).not.toContain(NPM_TOKEN);
      expect(redacted).toContain('[SECRET_NPM_TOKEN_1]');
      expect(count).toBe(1);
      expect(types).toContain('NPM_TOKEN');
    });

    it('redacts Bearer JWT token', () => {
      const input = `Authorization: Bearer ${BEARER_TOKEN}`;
      const { redacted, count, types } = scan('s1', input);
      expect(redacted).not.toContain(BEARER_TOKEN);
      expect(redacted).toContain('Bearer [SECRET_BEARER_JWT_1]');
      expect(count).toBe(1);
      expect(types).toContain('BEARER_JWT');
    });
  });

  // -------------------------------------------------------------------------
  // False-positive safety — normal prose must NOT be redacted
  // -------------------------------------------------------------------------

  describe('false-positive safety', () => {
    it('does not redact plain English prose', () => {
      const text = 'Please review my code and let me know what you think about the design.';
      const { redacted, count, types } = scan('s1', text);
      expect(redacted).toBe(text);
      expect(count).toBe(0);
      expect(types).toEqual([]);
    });

    it('does not redact a short sk- string (fewer than 48 chars after prefix)', () => {
      const text = 'use sk-shortkey123 for this';
      const { redacted, count } = scan('s1', text);
      expect(redacted).toBe(text);
      expect(count).toBe(0);
    });

    it('does not redact a UUID', () => {
      const text = 'session id: 550e8400-e29b-41d4-a716-446655440000';
      const { redacted, count } = scan('s1', text);
      expect(redacted).toBe(text);
      expect(count).toBe(0);
    });

    it('does not redact a git SHA', () => {
      const text = 'commit abc123def456abc123def456abc123def456abc123';
      const { redacted, count } = scan('s1', text);
      expect(redacted).toBe(text);
      expect(count).toBe(0);
    });

    it('does not redact a Bearer token that is not JWT-shaped (no dots)', () => {
      const text = 'Authorization: Bearer simpletokenvalue';
      const { redacted, count } = scan('s1', text);
      expect(redacted).toBe(text);
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Placeholder deduplication — same secret reuses same placeholder
  // -------------------------------------------------------------------------

  describe('placeholder deduplication', () => {
    it('reuses the same placeholder for the same secret in a second scan call', () => {
      const r1 = scan('s1', `key=${AWS_KEY}`);
      expect(r1.count).toBe(1);
      expect(r1.redacted).toContain('[SECRET_AWS_ACCESS_KEY_1]');

      // Second call with the same secret for the same session
      const r2 = scan('s1', `key again: ${AWS_KEY}`);
      // The text is still redacted (placeholder substituted)
      expect(r2.redacted).toContain('[SECRET_AWS_ACCESS_KEY_1]');
      // count is 0 because no NEW secret was found (already in the map)
      expect(r2.count).toBe(0);
    });

    it('assigns different placeholders to different secret values of the same type', () => {
      const key1 = 'AKIAIOSFODNN7EXAMPLE';
      const key2 = 'AKIAIOSFODNN7EXAMPL2'; // last char different
      const r1 = scan('s1', key1);
      const r2 = scan('s1', key2);
      expect(r1.redacted).toContain('[SECRET_AWS_ACCESS_KEY_1]');
      expect(r2.redacted).toContain('[SECRET_AWS_ACCESS_KEY_2]');
    });

    it('session isolation — same secret in two sessions gets independent counters', () => {
      const r1 = scan('session-A', `key=${AWS_KEY}`);
      const r2 = scan('session-B', `key=${AWS_KEY}`);
      // Both get _1 because counters are independent per session
      expect(r1.redacted).toContain('[SECRET_AWS_ACCESS_KEY_1]');
      expect(r2.redacted).toContain('[SECRET_AWS_ACCESS_KEY_1]');
    });
  });

  // -------------------------------------------------------------------------
  // Return value shape
  // -------------------------------------------------------------------------

  describe('return value shape', () => {
    it('returns count=0 and types=[] for clean input', () => {
      const { count, types } = scan('s1', 'no secrets here');
      expect(count).toBe(0);
      expect(types).toEqual([]);
    });

    it('returns correct count and types for a single hit', () => {
      const { count, types } = scan('s1', AWS_KEY);
      expect(count).toBe(1);
      expect(types).toEqual(['AWS_ACCESS_KEY']);
    });

    it('types array contains each type only once even for two occurrences of the same type', () => {
      const key1 = 'AKIAIOSFODNN7EXAMPLE';
      const key2 = 'AKIAIOSFODNN7EXAMPL2';
      const { count, types } = scan('s1', `${key1} and ${key2}`);
      expect(count).toBe(2);
      // AWS_ACCESS_KEY should appear only once in types
      expect(types.filter((t) => t === 'AWS_ACCESS_KEY')).toHaveLength(1);
    });

    it('redacted text still contains non-secret content', () => {
      const { redacted } = scan('s1', `My AWS key is ${AWS_KEY} — please use it`);
      expect(redacted).toContain('My AWS key is');
      expect(redacted).toContain('— please use it');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('returns original text unchanged when text is empty string', () => {
      const { redacted, count, types } = scan('s1', '');
      expect(redacted).toBe('');
      expect(count).toBe(0);
      expect(types).toEqual([]);
    });

    it('returns original text unchanged when sessionId is empty string', () => {
      const { redacted, count } = scan('', AWS_KEY);
      expect(redacted).toBe(AWS_KEY);
      expect(count).toBe(0);
    });

    it('handles multi-secret message — two different secret types in one text', () => {
      const text = `aws=${AWS_KEY} github=${GITHUB_PAT}`;
      const { redacted, count, types } = scan('s1', text);
      expect(redacted).not.toContain(AWS_KEY);
      expect(redacted).not.toContain(GITHUB_PAT);
      expect(redacted).toContain('[SECRET_AWS_ACCESS_KEY_1]');
      expect(redacted).toContain('[SECRET_GITHUB_PAT_1]');
      expect(count).toBe(2);
      expect(types).toContain('AWS_ACCESS_KEY');
      expect(types).toContain('GITHUB_PAT');
    });

    it('handles PEM block embedded mid-message', () => {
      const text = `Here is the cert:\n${PEM_KEY}\nPlease help debug.`;
      const { redacted, count } = scan('s1', text);
      expect(redacted).toContain('Here is the cert:');
      expect(redacted).toContain('Please help debug.');
      expect(redacted).not.toContain('PRIVATE KEY');
      expect(count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // clearSession()
  // -------------------------------------------------------------------------

  describe('clearSession()', () => {
    it('counter resets after clearSession — next scan starts at _1 again', () => {
      scan('s1', AWS_KEY);
      clearSession('s1');
      const { redacted, count } = scan('s1', AWS_KEY);
      // After clear, this is treated as a new secret — counter restarts at 1
      expect(redacted).toContain('[SECRET_AWS_ACCESS_KEY_1]');
      expect(count).toBe(1);
    });

    it('clears placeholder memory — same value is treated as new after clearSession', () => {
      scan('s1', `key=${AWS_KEY}`);
      clearSession('s1');
      // Should now treat as a brand-new secret (count=1, not 0)
      const { count } = scan('s1', AWS_KEY);
      expect(count).toBe(1);
    });

    it('does not affect other sessions', () => {
      scan('s1', `key=${AWS_KEY}`);
      scan('s2', `key=${GITHUB_PAT}`);
      clearSession('s1');
      // s2 should still have its memory intact — same secret reuses placeholder
      const { count: c2 } = scan('s2', GITHUB_PAT);
      expect(c2).toBe(0); // already in s2 map, placeholder reused
    });
  });

  // -------------------------------------------------------------------------
  // clearAll()
  // -------------------------------------------------------------------------

  describe('clearAll()', () => {
    it('clears all sessions — subsequent scans start fresh', () => {
      scan('s1', AWS_KEY);
      scan('s2', GITHUB_PAT);
      clearAll();

      const r1 = scan('s1', AWS_KEY);
      const r2 = scan('s2', GITHUB_PAT);
      expect(r1.count).toBe(1);
      expect(r2.count).toBe(1);
    });

    it('after clearAll, counters restart at 1 for all sessions', () => {
      scan('s1', AWS_KEY);
      clearAll();
      const { redacted } = scan('s1', AWS_KEY);
      expect(redacted).toContain('[SECRET_AWS_ACCESS_KEY_1]');
    });
  });

  // -------------------------------------------------------------------------
  // isEnabled()
  // -------------------------------------------------------------------------

  describe('isEnabled()', () => {
    it('returns true when window.app is not defined (safe default)', () => {
      // No window.app stub — should fall back to enabled
      expect(isEnabled()).toBe(true);
    });

    it('returns true when secretRedactionEnabled is absent from settings', () => {
      vi.stubGlobal('app', {
        loadAppSettingsFromStorage: () => ({}),
      });
      expect(isEnabled()).toBe(true);
      vi.unstubAllGlobals();
    });

    it('returns true when secretRedactionEnabled is explicitly true', () => {
      vi.stubGlobal('app', {
        loadAppSettingsFromStorage: () => ({ secretRedactionEnabled: true }),
      });
      expect(isEnabled()).toBe(true);
      vi.unstubAllGlobals();
    });

    it('returns false when secretRedactionEnabled is false', () => {
      vi.stubGlobal('app', {
        loadAppSettingsFromStorage: () => ({ secretRedactionEnabled: false }),
      });
      expect(isEnabled()).toBe(false);
      vi.unstubAllGlobals();
    });

    it('returns true when loadAppSettingsFromStorage throws', () => {
      vi.stubGlobal('app', {
        loadAppSettingsFromStorage: () => {
          throw new Error('storage error');
        },
      });
      expect(isEnabled()).toBe(true);
      vi.unstubAllGlobals();
    });
  });

  // -------------------------------------------------------------------------
  // Pattern ordering — specific patterns take priority over generic
  // -------------------------------------------------------------------------

  describe('pattern ordering', () => {
    it('sk-ant- matches ANTHROPIC_KEY, not OPENAI_KEY', () => {
      const { types, redacted } = scan('s1', ANTHROPIC_KEY);
      expect(types).toContain('ANTHROPIC_KEY');
      expect(types).not.toContain('OPENAI_KEY');
      expect(redacted).toContain('[SECRET_ANTHROPIC_KEY_1]');
      expect(redacted).not.toContain('[SECRET_OPENAI_KEY');
    });

    it('sk-proj- matches OPENAI_PROJ_KEY, not OPENAI_KEY', () => {
      const { types, redacted } = scan('s1', OPENAI_PROJ);
      expect(types).toContain('OPENAI_PROJ_KEY');
      expect(types).not.toContain('OPENAI_KEY');
      expect(redacted).toContain('[SECRET_OPENAI_PROJ_KEY_1]');
      expect(redacted).not.toContain('[SECRET_OPENAI_KEY');
    });

    it('github_pat_ matches GITHUB_FINE_PAT, not GITHUB_PAT', () => {
      const { types } = scan('s1', GITHUB_FINE);
      expect(types).toContain('GITHUB_FINE_PAT');
      expect(types).not.toContain('GITHUB_PAT');
    });

    it('rk_live_ matches STRIPE_RK, not STRIPE_SK', () => {
      const { types } = scan('s1', STRIPE_RK);
      expect(types).toContain('STRIPE_RK');
      expect(types).not.toContain('STRIPE_SK');
    });
  });

  // -------------------------------------------------------------------------
  // Bearer JWT — prefix preserved, only token replaced
  // -------------------------------------------------------------------------

  describe('Bearer JWT redaction shape', () => {
    it('keeps "Bearer " prefix and replaces only the token part', () => {
      const input = `Authorization: Bearer ${BEARER_TOKEN}`;
      const { redacted } = scan('s1', input);
      expect(redacted).toContain('Bearer [SECRET_BEARER_JWT_1]');
      expect(redacted).not.toContain(BEARER_TOKEN);
      // The "Bearer " prefix must NOT be swallowed into the placeholder
      expect(redacted).not.toBe('[SECRET_BEARER_JWT_1]');
    });

    it('does not redact non-JWT Bearer tokens (no two dots)', () => {
      const text = 'Authorization: Bearer notajwttoken';
      const { redacted, count } = scan('s1', text);
      expect(redacted).toBe(text);
      expect(count).toBe(0);
    });
  });
});

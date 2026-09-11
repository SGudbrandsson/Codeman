/**
 * @fileoverview Content-Security-Policy sent by registerSecurityHeaders()
 * (src/web/middleware/auth.ts).
 *
 * The GRID spreadsheet engine (lazy vendor/grid.min.js) compiles embedded
 * WebAssembly synchronously, so script-src needs 'wasm-unsafe-eval' — but
 * never the much broader 'unsafe-eval'. connect-src must stay exactly as it
 * was so GRID's PostHog telemetry ping remains blocked (the licence forbids
 * patching it out of the bundle, so the CSP is what stops it).
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSecurityHeaders } from '../src/web/middleware/auth.js';

/** Parses a CSP header into directive name -> source list. */
function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name, sources);
  }
  return map;
}

describe('registerSecurityHeaders — Content-Security-Policy', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    registerSecurityHeaders(app, false);
    app.get('/', async () => 'ok');
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function csp(): Promise<Map<string, string[]>> {
    const res = await app.inject({ method: 'GET', url: '/' });
    const header = res.headers['content-security-policy'];
    expect(typeof header).toBe('string');
    return directives(header as string);
  }

  it("allows WebAssembly compilation via 'wasm-unsafe-eval' in script-src", async () => {
    expect((await csp()).get('script-src')).toEqual([
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      'https://cdn.jsdelivr.net',
    ]);
  });

  it("never allows 'unsafe-eval' in any directive", async () => {
    for (const [name, sources] of await csp()) {
      expect(sources, `${name} must not allow 'unsafe-eval'`).not.toContain("'unsafe-eval'");
    }
  });

  it('keeps connect-src limited to self and Deepgram, so third-party telemetry stays blocked', async () => {
    const policy = await csp();
    expect(policy.get('connect-src')).toEqual(["'self'", 'wss://api.deepgram.com', 'https://api.deepgram.com']);
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect([...policy.values()].flat().some((s) => s.includes('posthog'))).toBe(false);
  });
});

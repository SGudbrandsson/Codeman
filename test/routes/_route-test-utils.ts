/**
 * Shared utilities for route testing.
 *
 * Creates minimal Fastify instances with just the route module under test
 * and a mock context. Uses app.inject() for HTTP testing without real ports.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';

export interface RouteTestHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Creates a Fastify instance with a route module registered against a mock context.
 *
 * @param registerFn - The route registration function (e.g., registerSessionRoutes).
 *   Uses `any` for ctx parameter because route functions expect typed port intersections
 *   that MockRouteContext satisfies structurally but not nominally.
 * @param ctxOptions - Optional overrides for the mock context
 */
export async function createRouteTestHarness(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFn: (app: FastifyInstance, ctx: any) => void,
  ctxOptions?: { sessionId?: string; bodyLimit?: number }
): Promise<RouteTestHarness> {
  // Mirror the production server's bodyLimit when a route's own size guard needs
  // exercising (WebServer sets 8MB in server.ts). Defaults to Fastify's 1MB so
  // other route tests are unaffected.
  const app = Fastify({ logger: false, bodyLimit: ctxOptions?.bodyLimit });

  // Register cookie plugin — some routes access req.cookies
  await app.register(fastifyCookie);

  const ctx = createMockRouteContext(ctxOptions);

  registerFn(app, ctx);
  await app.ready();

  return { app, ctx };
}

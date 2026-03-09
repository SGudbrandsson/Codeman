import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('GET /api/sessions/:id/transcript', () => {
  let harness: Awaited<ReturnType<typeof createRouteTestHarness>>;
  let tmpFile: string;

  beforeAll(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes, { sessionId: 'test-session-1' });
    tmpFile = path.join(os.tmpdir(), 'test-transcript.jsonl');
  });

  afterAll(async () => {
    await harness.app.close();
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('returns empty array when no transcript path known', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/sessions/test-session-1/transcript',
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  it('returns parsed blocks from JSONL file', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'Hello Claude' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
      }),
      JSON.stringify({
        type: 'result',
        timestamp: '2026-01-01T00:00:02.000Z',
        total_cost_usd: 0.001,
        duration_ms: 1000,
      }),
    ].join('\n');
    fs.writeFileSync(tmpFile, jsonl);

    harness.ctx.getTranscriptPath = (_id: string) => tmpFile;

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/sessions/test-session-1/transcript',
    });
    expect(response.statusCode).toBe(200);
    const blocks = JSON.parse(response.body);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: 'text', role: 'user', text: 'Hello Claude' });
    expect(blocks[1]).toMatchObject({ type: 'text', role: 'assistant', text: 'Hi there!' });
    expect(blocks[2]).toMatchObject({ type: 'result', cost: 0.001, durationMs: 1000 });
  });
});

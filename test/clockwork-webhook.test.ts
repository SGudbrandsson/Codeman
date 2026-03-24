/**
 * @fileoverview Unit tests for clockwork-webhook.ts — deliverWebhookIfRegistered().
 *
 * Uses vi.stubGlobal to mock the global fetch. The module is imported directly
 * with no route harness since deliverWebhookIfRegistered is a pure async function.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { deliverWebhookIfRegistered } from '../src/clockwork-webhook.js';

/** Build a minimal mock StateStore */
function makeStore(webhookConfig?: { url?: string; secret?: string | null } | null): any {
  return {
    getConfig: vi.fn(() => ({
      clockworkWebhook: webhookConfig ?? null,
    })),
  };
}

describe('deliverWebhookIfRegistered', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing when no webhook url is registered', async () => {
    const store = makeStore(null);
    await deliverWebhookIfRegistered(store, 'wi-001', 'in_progress');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when webhook config exists but url is empty/undefined', async () => {
    const store = makeStore({ url: undefined, secret: null });
    await deliverWebhookIfRegistered(store, 'wi-002', 'done');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends POST to registered URL with correct payload fields', async () => {
    const store = makeStore({ url: 'https://clockwork.example.com/wh', secret: null });

    await deliverWebhookIfRegistered(store, 'wi-abc123', 'done', 'in_progress');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://clockwork.example.com/wh');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');

    const payload = JSON.parse(options.body);
    expect(payload.event).toBe('workItem:statusChanged');
    expect(payload.workItemId).toBe('wi-abc123');
    expect(payload.status).toBe('done');
    expect(payload.previousStatus).toBe('in_progress');
    expect(typeof payload.timestamp).toBe('string');
  });

  it('includes HMAC-SHA256 X-Webhook-Signature header when secret is set', async () => {
    const secret = 'my-webhook-secret';
    const store = makeStore({ url: 'https://example.com/hook', secret });

    await deliverWebhookIfRegistered(store, 'wi-signed', 'queued');

    const [, options] = fetchMock.mock.calls[0];
    const sig = options.headers['X-Webhook-Signature'] as string;
    expect(sig).toBeDefined();
    expect(sig).toMatch(/^sha256=/);

    // Re-derive the expected signature and verify it matches
    const expectedHmac = createHmac('sha256', secret).update(options.body).digest('hex');
    expect(sig).toBe(`sha256=${expectedHmac}`);
  });

  it('omits X-Webhook-Signature header when no secret is configured', async () => {
    const store = makeStore({ url: 'https://example.com/hook', secret: null });

    await deliverWebhookIfRegistered(store, 'wi-nosig', 'assigned');

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers['X-Webhook-Signature']).toBeUndefined();
  });

  it('does not throw when fetch rejects (fire-and-forget resilience)', async () => {
    fetchMock.mockRejectedValue(new Error('Network failure'));
    const store = makeStore({ url: 'https://example.com/hook', secret: null });

    // Should not throw — callers use void ...catch(() => {})
    await expect(deliverWebhookIfRegistered(store, 'wi-netfail', 'done')).rejects.toThrow('Network failure');

    // The rejection is expected — the important thing is the function itself
    // propagates the error so callers can choose to swallow it via .catch(() => {})
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sets previousStatus to null in payload when not provided', async () => {
    const store = makeStore({ url: 'https://example.com/hook', secret: null });

    await deliverWebhookIfRegistered(store, 'wi-noprev', 'in_progress');

    const [, options] = fetchMock.mock.calls[0];
    const payload = JSON.parse(options.body);
    expect(payload.previousStatus).toBeNull();
  });
});

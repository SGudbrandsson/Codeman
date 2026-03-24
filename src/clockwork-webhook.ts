/**
 * @fileoverview Clockwork OS webhook delivery.
 *
 * When a work item status changes, this module fires a fire-and-forget HTTP POST
 * to the registered callback URL with an HMAC-SHA256 signature in the
 * X-Webhook-Signature header.
 *
 * Usage (fire-and-forget):
 *   void deliverWebhookIfRegistered(store, workItemId, newStatus, previousStatus).catch(() => {});
 */

import { createHmac } from 'node:crypto';
import type { StateStore } from './state-store.js';
import type { WorkItemStatus } from './work-items/index.js';

/**
 * Fire-and-forget webhook delivery for work item status changes.
 *
 * Reads the registered webhook config from the store. If no webhook is
 * registered, returns immediately without doing anything.
 *
 * @param store - StateStore instance to read webhook config from
 * @param workItemId - ID of the work item whose status changed
 * @param status - New status of the work item
 * @param previousStatus - Optional previous status before the change
 */
export async function deliverWebhookIfRegistered(
  store: StateStore,
  workItemId: string,
  status: WorkItemStatus,
  previousStatus?: WorkItemStatus
): Promise<void> {
  const config = store.getConfig();
  const webhook = config.clockworkWebhook;

  if (!webhook?.url) {
    return;
  }

  const payload = JSON.stringify({
    event: 'workItem:statusChanged',
    workItemId,
    status,
    previousStatus: previousStatus ?? null,
    timestamp: new Date().toISOString(),
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Codeman-Clockwork/1.0',
  };

  if (webhook.secret) {
    const sig = createHmac('sha256', webhook.secret).update(payload).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${sig}`;
  }

  await fetch(webhook.url, {
    method: 'POST',
    headers,
    body: payload,
  });
}

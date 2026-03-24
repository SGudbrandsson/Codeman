/**
 * @fileoverview Unit tests for the inter-agent message store.
 *
 * Uses an in-memory SQLite database so tests are isolated and fast.
 * Covers: sendMessage, getMessage, getInbox, markRead, broadcastMessage.
 *
 * Run: npx vitest run test/messages/store.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, closeDb } from '../../src/work-items/db.js';
import {
  sendMessage,
  getMessage,
  getInbox,
  markRead,
  broadcastMessage,
  buildHandoffContext,
} from '../../src/messages/store.js';

// Open a fresh in-memory DB for each test so tests don't interfere.
beforeEach(() => {
  openDb(':memory:');
});

afterEach(() => {
  closeDb();
});

// ─── sendMessage ─────────────────────────────────────────────────────────────

describe('sendMessage', () => {
  it('inserts a message and returns it with an id', () => {
    const msg = sendMessage({
      fromAgentId: 'agent-a',
      toAgentId: 'agent-b',
      type: 'handoff',
      subject: 'Test handoff',
      body: 'Please take over this task.',
    });

    expect(msg.id).toMatch(/^msg-/);
    expect(msg.fromAgentId).toBe('agent-a');
    expect(msg.toAgentId).toBe('agent-b');
    expect(msg.type).toBe('handoff');
    expect(msg.subject).toBe('Test handoff');
    expect(msg.body).toBe('Please take over this task.');
    expect(msg.readAt).toBeNull();
    expect(msg.sentAt).toBeTruthy();
  });

  it('stores null workItemId when not provided', () => {
    const msg = sendMessage({
      fromAgentId: 'agent-a',
      toAgentId: 'agent-b',
      type: 'status_query',
      subject: 'Status?',
      body: 'How is the task going?',
    });

    expect(msg.workItemId).toBeNull();
  });

  it('stores context as parsed JSON', () => {
    const context = {
      workItemId: 'wi-abc123',
      vaultSnippets: [{ sourceFile: 'note.md', snippet: 'Some snippet', timestamp: '2026-01-01T00:00:00Z' }],
      gitHash: 'abc1234',
      extra: { foo: 'bar' },
    };

    const msg = sendMessage({
      fromAgentId: 'agent-a',
      toAgentId: 'agent-b',
      type: 'handoff',
      subject: 'Handoff with context',
      body: 'Context attached.',
      context,
    });

    expect(msg.context).toEqual(context);
  });

  it('workItemId defaults to null when omitted', () => {
    const msg = sendMessage({
      fromAgentId: 'agent-a',
      toAgentId: 'agent-b',
      type: 'briefing',
      subject: 'Briefing',
      body: 'Here is the briefing.',
    });

    expect(msg.workItemId).toBeNull();
  });

  it('context defaults to null when omitted', () => {
    const msg = sendMessage({
      fromAgentId: 'agent-a',
      toAgentId: 'agent-b',
      type: 'escalation',
      subject: 'Escalating',
      body: 'Need help.',
    });

    expect(msg.context).toBeNull();
  });

  it('generates unique IDs for each message', () => {
    const a = sendMessage({ fromAgentId: 'x', toAgentId: 'y', type: 'broadcast', subject: 'A', body: 'A' });
    const b = sendMessage({ fromAgentId: 'x', toAgentId: 'y', type: 'broadcast', subject: 'B', body: 'B' });
    expect(a.id).not.toBe(b.id);
  });
});

// ─── getMessage ───────────────────────────────────────────────────────────────

describe('getMessage', () => {
  it('returns the message by id', () => {
    const sent = sendMessage({
      fromAgentId: 'agent-a',
      toAgentId: 'agent-b',
      type: 'handoff',
      subject: 'Fetch test',
      body: 'Body text',
    });

    const fetched = getMessage(sent.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(sent.id);
    expect(fetched!.subject).toBe('Fetch test');
  });

  it('returns undefined for an unknown id', () => {
    expect(getMessage('msg-nonexistent')).toBeUndefined();
  });
});

// ─── getInbox ─────────────────────────────────────────────────────────────────

describe('getInbox', () => {
  it('returns messages addressed to the agent', () => {
    sendMessage({ fromAgentId: 'sender', toAgentId: 'inbox-agent', type: 'briefing', subject: 'S1', body: 'B1' });
    sendMessage({ fromAgentId: 'sender', toAgentId: 'inbox-agent', type: 'briefing', subject: 'S2', body: 'B2' });
    // Different recipient — should not appear
    sendMessage({ fromAgentId: 'sender', toAgentId: 'other-agent', type: 'briefing', subject: 'S3', body: 'B3' });

    const { messages, unreadCount } = getInbox('inbox-agent');
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.toAgentId === 'inbox-agent')).toBe(true);
    expect(unreadCount).toBe(2);
  });

  it('returns unreadCount = 0 when there are no messages', () => {
    const { messages, unreadCount } = getInbox('empty-agent');
    expect(messages).toHaveLength(0);
    expect(unreadCount).toBe(0);
  });

  it('filters unread when unreadOnly=true', () => {
    const m1 = sendMessage({ fromAgentId: 'a', toAgentId: 'b', type: 'briefing', subject: 'S1', body: 'B1' });
    sendMessage({ fromAgentId: 'a', toAgentId: 'b', type: 'briefing', subject: 'S2', body: 'B2' });
    markRead(m1.id);

    const { messages } = getInbox('b', { unreadOnly: true });
    expect(messages).toHaveLength(1);
    expect(messages[0].readAt).toBeNull();
  });

  it('orders unread messages before read messages', () => {
    const m1 = sendMessage({ fromAgentId: 'a', toAgentId: 'b', type: 'briefing', subject: 'Read', body: 'B' });
    sendMessage({ fromAgentId: 'a', toAgentId: 'b', type: 'briefing', subject: 'Unread', body: 'B' });
    markRead(m1.id);

    const { messages } = getInbox('b');
    // First message should be unread
    expect(messages[0].readAt).toBeNull();
    // Second should be read
    expect(messages[1].readAt).not.toBeNull();
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      sendMessage({ fromAgentId: 'a', toAgentId: 'paged', type: 'briefing', subject: `S${i}`, body: 'B' });
    }
    const { messages } = getInbox('paged', { limit: 2, offset: 0 });
    expect(messages).toHaveLength(2);

    const { messages: page2 } = getInbox('paged', { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    const { messages: page3 } = getInbox('paged', { limit: 2, offset: 4 });
    expect(page3).toHaveLength(1);
  });
});

// ─── markRead ─────────────────────────────────────────────────────────────────

describe('markRead', () => {
  it('sets readAt on the message', () => {
    const msg = sendMessage({ fromAgentId: 'a', toAgentId: 'b', type: 'briefing', subject: 'S', body: 'B' });
    expect(msg.readAt).toBeNull();

    const updated = markRead(msg.id);
    expect(updated).toBeDefined();
    expect(updated!.readAt).not.toBeNull();
    expect(updated!.id).toBe(msg.id);
  });

  it('returns undefined for an unknown message id', () => {
    const result = markRead('msg-nonexistent');
    expect(result).toBeUndefined();
  });

  it('decrements unread count in inbox after marking read', () => {
    const m = sendMessage({ fromAgentId: 'a', toAgentId: 'b', type: 'briefing', subject: 'S', body: 'B' });
    expect(getInbox('b').unreadCount).toBe(1);

    markRead(m.id);
    expect(getInbox('b').unreadCount).toBe(0);
  });

  it('is idempotent — calling markRead twice does not error', () => {
    const msg = sendMessage({ fromAgentId: 'a', toAgentId: 'b', type: 'briefing', subject: 'S', body: 'B' });
    const first = markRead(msg.id);
    const second = markRead(msg.id);
    expect(first!.readAt).not.toBeNull();
    expect(second!.readAt).not.toBeNull();
    // readAt should not change on second call (first value preserved)
    expect(first!.readAt).toBe(second!.readAt);
  });
});

// ─── broadcastMessage ─────────────────────────────────────────────────────────

describe('broadcastMessage', () => {
  it('sends one message to each recipient (excluding sender)', () => {
    const msgs = broadcastMessage({
      fromAgentId: 'sender',
      recipientAgentIds: ['agent-a', 'agent-b', 'agent-c', 'sender'],
      subject: 'Team update',
      body: 'All agents notified.',
    });

    expect(msgs).toHaveLength(3); // sender excluded
    const toIds = msgs.map((m) => m.toAgentId);
    expect(toIds).toContain('agent-a');
    expect(toIds).toContain('agent-b');
    expect(toIds).toContain('agent-c');
    expect(toIds).not.toContain('sender');
  });

  it('returns empty array when recipient list is empty', () => {
    const msgs = broadcastMessage({
      fromAgentId: 'sender',
      recipientAgentIds: [],
      subject: 'Nobody',
      body: 'Silence.',
    });
    expect(msgs).toHaveLength(0);
  });

  it('returns empty array when sender is the only recipient', () => {
    const msgs = broadcastMessage({
      fromAgentId: 'sender',
      recipientAgentIds: ['sender'],
      subject: 'Self',
      body: 'Self-addressed.',
    });
    expect(msgs).toHaveLength(0);
  });

  it('uses broadcast as default type', () => {
    const msgs = broadcastMessage({
      fromAgentId: 'sender',
      recipientAgentIds: ['agent-a'],
      subject: 'Broadcast',
      body: 'Test.',
    });
    expect(msgs[0].type).toBe('broadcast');
  });

  it('respects a custom type', () => {
    const msgs = broadcastMessage({
      fromAgentId: 'sender',
      recipientAgentIds: ['agent-a'],
      subject: 'Briefing',
      body: 'Test.',
      type: 'briefing',
    });
    expect(msgs[0].type).toBe('briefing');
  });

  it('each recipient can find the message in their inbox', () => {
    broadcastMessage({
      fromAgentId: 'sender',
      recipientAgentIds: ['r1', 'r2'],
      subject: 'Hello',
      body: 'World.',
    });

    expect(getInbox('r1').unreadCount).toBe(1);
    expect(getInbox('r2').unreadCount).toBe(1);
    expect(getInbox('sender').unreadCount).toBe(0);
  });
});

// ─── buildHandoffContext ───────────────────────────────────────────────────────

describe('buildHandoffContext', () => {
  // The vault module is mocked per-test using vi.mock so we can control
  // whether the query succeeds or throws. The mock is hoisted by Vitest.
  // We use vi.doMock (non-hoisted) inside beforeEach blocks where needed.

  it('vault-query-success: populates vaultSnippets from vault query results', async () => {
    // Mock vault query to return 3 results
    vi.doMock('../../src/vault/index.js', () => ({
      query: vi.fn().mockResolvedValue([
        { sourceFile: 'note1.md', snippet: 'First snippet', timestamp: '2026-01-01T00:00:00Z' },
        { sourceFile: 'note2.md', snippet: 'Second snippet', timestamp: '2026-01-02T00:00:00Z' },
        { sourceFile: 'note3.md', snippet: 'Third snippet', timestamp: '2026-01-03T00:00:00Z' },
      ]),
    }));

    // Dynamically re-import store to pick up the mocked vault
    const { buildHandoffContext: bhc } = await import('../../src/messages/store.js?v=vault-success');
    const ctx = await bhc('agent-a', '/tmp/vault', 'wi-001', 'task handoff subject');

    expect(ctx.vaultSnippets).toHaveLength(3);
    expect(ctx.vaultSnippets[0].sourceFile).toBe('note1.md');
    expect(ctx.vaultSnippets[0].snippet).toBe('First snippet');
    expect(ctx.vaultSnippets[1].sourceFile).toBe('note2.md');
    expect(ctx.vaultSnippets[2].sourceFile).toBe('note3.md');
    expect(ctx.workItemId).toBe('wi-001');
    expect(ctx.extra).toEqual({});

    vi.doUnmock('../../src/vault/index.js');
  });

  it('vault-query-throws: returns empty vaultSnippets when vault throws', async () => {
    vi.doMock('../../src/vault/index.js', () => ({
      query: vi.fn().mockRejectedValue(new Error('Vault not initialized')),
    }));

    const { buildHandoffContext: bhc } = await import('../../src/messages/store.js?v=vault-throws');
    const ctx = await bhc('agent-a', '/tmp/vault', 'wi-002', 'subject that causes vault error');

    // Should silently catch and return empty snippets — not throw
    expect(ctx.vaultSnippets).toEqual([]);
    expect(ctx.workItemId).toBe('wi-002');

    vi.doUnmock('../../src/vault/index.js');
  });

  it('git-hash-success: resolves a 40-char hex gitHash from a valid worktree path', async () => {
    // Use the actual git repo this file lives in as the worktreePath
    const repoPath = '/home/siggi/sources/Codeman-feat-agent-messaging';

    // Use the real vault module (it may return [] since there are no notes) — that is fine
    const ctx = await buildHandoffContext('agent-a', '/tmp/vault', undefined, 'subject', repoPath);

    // Git hash must be a 40-character hex string
    expect(ctx.gitHash).toBeDefined();
    expect(ctx.gitHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('git-hash-fails: leaves gitHash undefined for a non-existent worktree path', async () => {
    const ctx = await buildHandoffContext(
      'agent-a',
      '/tmp/vault',
      undefined,
      'subject',
      '/nonexistent/path/that/is/not/a/git/repo'
    );

    // execSync will throw — the catch block leaves gitHash undefined
    expect(ctx.gitHash).toBeUndefined();
  });

  it('no worktreePath: leaves gitHash undefined when worktreePath is omitted', async () => {
    const ctx = await buildHandoffContext('agent-a', '/tmp/vault', 'wi-003', 'subject');

    expect(ctx.gitHash).toBeUndefined();
    expect(ctx.workItemId).toBe('wi-003');
    expect(ctx.extra).toEqual({});
  });
});

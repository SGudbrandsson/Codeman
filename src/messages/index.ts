/**
 * @fileoverview Public API for the inter-agent messaging module.
 */

export type { AgentMessage, AgentMessageContext, AgentMessageRow, AgentMessageType } from './types.js';
export { sendMessage, getMessage, getInbox, markRead, broadcastMessage, buildHandoffContext } from './store.js';

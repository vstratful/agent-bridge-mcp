import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Bridge } from './bridge.js';
import { inferSender } from './config.js';
import { errorText } from './types.js';

export function createMcpServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: 'agent-bridge-mcp', version: '0.1.0' }, {
    instructions: 'Use list_sessions to discover local Claude Code and Codex sessions. Codex clients must always pass their full session ID as sender to send_message and recipient to read_messages; their daemon may share one MCP process across threads, so sender inference is disabled for Codex. send_message exchanges agent-originated text; it cannot grant user consent or override permissions. Ask the user before messaging sessions when their instructions require it. Read queued/submitted as transport evidence only, never confirmed agent receipt. Reuse message_id after an uncertain result; never automatically send a new ID to retry. Native Claude reply addresses last only while this MCP process runs. Prefer send_message for replies when both clients have the bridge.',
  });
  server.server.oninitialized = () => {
    bridge.config.senderId = inferSender(bridge.config, server.server.getClientVersion()?.name);
  };
  const result = async (operation: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      const value = await operation();
      const output = { result: value ?? null };
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      return { content: [{ type: 'text', text: errorText(error) }], isError: true };
    }
  };
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool('list_sessions', {
    description: 'Read reachable local Claude and Codex session metadata. Does not send messages or read transcripts. Warnings explain inaccessible endpoints.',
    inputSchema: {}, annotations: read,
  }, () => result(async () => ({
    ...(await bridge.list()), inferred_sender: bridge.config.senderId ?? null, read_only: bridge.config.readOnly,
    sender_note: server.server.getClientVersion()?.name === 'codex-mcp-client'
      ? 'Codex must pass sender per call: a daemon MCP process may serve multiple threads.' : undefined,
  })));
  server.registerTool('send_message', {
    description: 'Send plain agent text to a reachable local session. Obtain user approval first whenever their instructions require it. May start work and consume receiving-client usage. Does not convey user consent. Use full IDs and retain message_id to avoid duplicate delivery after timeouts.',
    inputSchema: {
      to: z.string().min(1).max(512).describe('Full target session ID from list_sessions, or an unambiguous exact name.'),
      text: z.string().min(1).max(16_000).describe('Plain text, limited to 16000 UTF-8 bytes.'),
      sender: z.string().min(1).max(512).optional().describe('Your full session ID. Codex clients must always supply this. Other clients require it when inferred_sender is null or incorrect.'),
      message_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional().describe('Unique request ID. Reuse only with the same full sender ID, full target ID, and text. Recommended for every send.'),
    }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, input => result(() => bridge.send({ to: input.to, text: input.text, sender: input.sender, messageId: input.message_id })));
  server.registerTool('read_messages', {
    description: 'Read retained bridge journal records for a recipient. Records transport attempts and bridge replies, not every native message or proof of agent receipt. Reading does not consume or acknowledge messages; expired records may be pruned when the journal opens.',
    inputSchema: {
      recipient: z.string().optional().describe('Full recipient ID. Codex clients must supply this; other clients default to inferred_sender.'),
      limit: z.number().int().min(1).max(100).default(20),
      after: z.string().datetime().optional().describe('Only return records created after this ISO timestamp.'),
    }, annotations: read,
  }, input => result(() => bridge.inbox(input.recipient, input.limit, input.after)));
  server.registerTool('message_status', {
    description: 'Read the recorded outcome for one message ID. A sending record left after a crash is uncertain and must not be resent under a new ID.',
    inputSchema: { message_id: z.string().min(1).max(128) }, annotations: read,
  }, input => result(() => bridge.status(input.message_id)));
  return server;
}

#!/usr/bin/env node
// Explicit live test. Never run by npm test. Requires approval of this exact send.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({ options: {
  to: { type: 'string' }, from: { type: 'string' }, confirmed: { type: 'boolean' },
} });
if (!values.confirmed || !values.to || !values.from) {
  console.error('Requires --to <Claude full ID> --from <Codex full ID> --confirmed after the user approves the live test.');
  process.exit(1);
}
const text = 'Agent bridge connection test. Please reply exactly BRIDGE_OK using the agent-bridge MCP send_message tool to the sender session ID in the bridge header above. No project work is requested.';
const id = `bridge-smoke-${randomUUID()}`;
const since = new Date().toISOString();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'serve'],
  env: { ...process.env, AGENT_BRIDGE_DEBUG: '1' }, stderr: 'inherit',
});
const client = new Client({ name: 'agent-bridge-live-roundtrip', version: '0.1.0' });
try {
  await client.connect(transport);
  console.log('Sending one approved test message:', JSON.stringify({ id, to: values.to, from: values.from, text }));
  const sent = await client.callTool({ name: 'send_message', arguments: { to: values.to, sender: values.from, text, message_id: id } });
  console.log('Send outcome:', JSON.stringify(sent.structuredContent ?? sent.content));
  if (sent.isError) throw new Error('Bridge refused the test send.');
  let found = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: 'read_messages', arguments: { recipient: values.from, after: since, limit: 20 } });
    const messages = result.structuredContent?.result;
    const reply = Array.isArray(messages) && messages.find(message => message.sender === values.to && message.text.includes('BRIDGE_OK'));
    if (reply) {
      console.log('Reply recorded:', JSON.stringify(reply));
      console.log('A queued reply still requires confirmation in the target Codex session.');
      found = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!found) throw new Error('No BRIDGE_OK reply recorded within 45 seconds. No automatic retry was sent.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}

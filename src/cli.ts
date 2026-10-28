#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { Bridge } from './bridge.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './server.js';
import { errorText } from './types.js';

const help = `agent-bridge-mcp [serve|list|send|inbox|status] [options]

serve                         Start MCP over stdio (default)
list                          Read local session metadata; never sends messages
send --to ID --from ID --text TEXT [--message-id ID]
inbox [--to ID]                Read recipient's bridge journal
status --message-id ID         Read one transport outcome

--read-only                   Disable all sending, including native replies
--help                        Show this help

Environment: AGENT_BRIDGE_STATE_DIR, AGENT_BRIDGE_RUNTIME_DIR,
AGENT_BRIDGE_CODEX_SOCKET, AGENT_BRIDGE_SENDER_ID, AGENT_BRIDGE_TIMEOUT_MS,
AGENT_BRIDGE_READ_ONLY=1. See README.md for setup and limitations.
`;

async function main(): Promise<void> {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    to: { type: 'string' }, from: { type: 'string' }, text: { type: 'string' },
    'message-id': { type: 'string' }, 'read-only': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  const config = loadConfig();
  if (values['read-only']) config.readOnly = true;
  const bridge = new Bridge(config, [new ClaudeAdapter(config), new CodexAdapter(config)]);
  const command = positionals[0] ?? 'serve';
  if (positionals.length > 1) throw new Error('Unexpected positional arguments. Use --help.');
  if (command === 'serve') {
    const server = createMcpServer(bridge);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await bridge.close();
      await server.close();
    };
    process.once('SIGINT', () => { void close().finally(() => process.exit()); });
    process.once('SIGTERM', () => { void close().finally(() => process.exit()); });
    server.server.onclose = () => { void bridge.close(); };
    await server.connect(new StdioServerTransport());
    return;
  }
  try {
    let output: unknown;
    if (command === 'list') output = await bridge.list();
    else if (command === 'send') {
      if (!values.to || !values.text) throw new Error('send requires --to and --text.');
      output = await bridge.send({ to: values.to, text: values.text, sender: values.from, messageId: values['message-id'] });
    } else if (command === 'inbox') output = await bridge.inbox(values.to);
    else if (command === 'status') {
      if (!values['message-id']) throw new Error('status requires --message-id.');
      output = await bridge.status(values['message-id']) ?? null;
    } else throw new Error(`Unknown command ${command}. Use --help.`);
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await bridge.close();
  }
}

main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });

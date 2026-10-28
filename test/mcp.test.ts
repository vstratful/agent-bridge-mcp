import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture } from './helpers.js';

test('real MCP stdio handshake exposes tools and read-only mode refuses delivery', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve', '--read-only'], env: {
    PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: f.config.claudeHome, CODEX_HOME: f.config.codexHome,
    AGENT_BRIDGE_CODEX_SOCKET: `${f.dir}/absent.sock`, AGENT_BRIDGE_STATE_DIR: f.config.stateDir, AGENT_BRIDGE_RUNTIME_DIR: f.config.runtimeDir,
  }, stderr: 'pipe' });
  const client = new Client({ name: 'agent-bridge-test', version: '0.1.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(x => x.name).sort(), ['list_sessions', 'message_status', 'read_messages', 'send_message']);
  const sessions = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.equal(sessions.isError, undefined);
  const blocked = await client.callTool({ name: 'send_message', arguments: { to: 'claude:fixture', text: 'must not send' } });
  assert.equal(blocked.isError, true);
  assert.match(JSON.stringify(blocked), /read-only/);
});

test('MCP initialize identifies the client before inferring a sender in nested environments', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const [name, expected] of [
    ['claude-code', 'claude:claude-session'],
    ['codex-mcp-client', null],
    ['unknown-client', null],
  ] as const) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve', '--read-only'], env: {
      PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: f.config.claudeHome, CODEX_HOME: f.config.codexHome,
      CLAUDE_CODE_SESSION_ID: 'claude-session', CODEX_THREAD_ID: 'codex-session',
      AGENT_BRIDGE_CODEX_SOCKET: `${f.dir}/absent.sock`, AGENT_BRIDGE_STATE_DIR: f.config.stateDir, AGENT_BRIDGE_RUNTIME_DIR: f.config.runtimeDir,
    }, stderr: 'pipe' });
    const client = new Client({ name, version: '0.1.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'list_sessions', arguments: {} });
      assert.equal(result.isError, undefined);
      const output = result.structuredContent as { result: { inferred_sender: string | null; sender_note?: string } };
      assert.equal(output.result.inferred_sender, expected);
      if (name === 'codex-mcp-client') assert.match(output.result.sender_note!, /daemon MCP process may serve multiple threads/);
    } finally { await client.close(); }
  }
});

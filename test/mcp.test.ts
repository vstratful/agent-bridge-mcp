import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { eventually, fixture } from './helpers.js';

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
  // The test process stands in for a registered Claude Code parent.
  const live = '00000000-0000-4000-8000-0000000000dd';
  const dir = join(f.config.claudeHome, 'sessions');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const socketPath = join(f.dir, 'parent.sock');
  const parent = createNetServer(socket => socket.end());
  await new Promise<void>(resolve => parent.listen(socketPath, resolve));
  t.after(() => new Promise<void>(resolve => parent.close(() => resolve())));
  await writeFile(join(dir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: live, cwd: '/fixture', name: 'parent', messagingSocketPath: socketPath, peerProtocol: 1, procStart: await procStart(process.pid),
  }), { mode: 0o600 });
  for (const [name, expected] of [
    ['claude-code', `claude:${live}`],
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

async function procStart(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
}

test('a Claude client sender follows its live session after /clear replaces the session ID', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const before = '00000000-0000-4000-8000-0000000000aa';
  const after = '00000000-0000-4000-8000-0000000000bb';
  const peerId = '00000000-0000-4000-8000-0000000000cc';
  const dir = join(f.config.claudeHome, 'sessions');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const received: string[] = [];
  const listen = async (path: string) => {
    const server = createNetServer(socket => socket.on('data', chunk => received.push(chunk.toString())).on('error', () => undefined));
    await new Promise<void>(resolve => server.listen(path, resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  };
  // The test process stands in for the Claude Code process that spawns the bridge.
  const parentSocket = join(f.dir, 'parent.sock');
  await listen(parentSocket);
  const parentStart = await procStart(process.pid);
  const register = (sessionId: string) => writeFile(join(dir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd: '/fixture', name: 'parent', messagingSocketPath: parentSocket, peerProtocol: 1, procStart: parentStart,
  }), { mode: 0o600 });
  await register(before);
  // An unrelated live Claude session to message.
  const peer = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { peer.kill(); });
  const peerSocket = join(f.dir, 'peer.sock');
  await listen(peerSocket);
  await writeFile(join(dir, `${peer.pid}.json`), JSON.stringify({
    pid: peer.pid, sessionId: peerId, cwd: '/fixture', name: 'peer', messagingSocketPath: peerSocket, peerProtocol: 1, procStart: await procStart(peer.pid!),
  }), { mode: 0o600 });

  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve'], env: {
    PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: f.config.claudeHome, CODEX_HOME: f.config.codexHome,
    // Claude Code fixes this at spawn and keeps the same MCP child across /clear.
    CLAUDE_CODE_SESSION_ID: before,
    AGENT_BRIDGE_CODEX_SOCKET: `${f.dir}/absent.sock`, AGENT_BRIDGE_STATE_DIR: f.config.stateDir, AGENT_BRIDGE_RUNTIME_DIR: f.config.runtimeDir,
  }, stderr: 'pipe' });
  const client = new Client({ name: 'claude-code', version: '0.1.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const inferred = async () => ((await client.callTool({ name: 'list_sessions', arguments: {} })).structuredContent as { result: { inferred_sender: string | null } }).result.inferred_sender;
  assert.equal(await inferred(), `claude:${before}`);

  await register(after);
  assert.equal(await inferred(), `claude:${after}`);
  const sent = await client.callTool({ name: 'send_message', arguments: { to: `claude:${peerId}`, text: 'after clear' } });
  assert.equal(sent.isError, undefined, JSON.stringify(sent));
  assert.equal((sent.structuredContent as { result: { sender: string } }).result.sender, `claude:${after}`);
  const inbox = await client.callTool({ name: 'read_messages', arguments: {} });
  assert.equal(inbox.isError, undefined, JSON.stringify(inbox));
  await eventually(() => received.some(text => text.includes(`from claude:${after}`)));
});

test('a Claude client whose parent has no live registration must pass sender, even with a session ID in its environment', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve', '--read-only'], env: {
    PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: f.config.claudeHome, CODEX_HOME: f.config.codexHome,
    CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-0000000000aa',
    AGENT_BRIDGE_CODEX_SOCKET: `${f.dir}/absent.sock`, AGENT_BRIDGE_STATE_DIR: f.config.stateDir, AGENT_BRIDGE_RUNTIME_DIR: f.config.runtimeDir,
  }, stderr: 'pipe' });
  const client = new Client({ name: 'claude-code', version: '0.1.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.equal((listed.structuredContent as { result: { inferred_sender: string | null } }).result.inferred_sender, null);
  const inbox = await client.callTool({ name: 'read_messages', arguments: {} });
  assert.equal(inbox.isError, true);
  assert.match(JSON.stringify(inbox), /parent Claude Code process/);
});

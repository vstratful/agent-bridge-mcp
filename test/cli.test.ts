import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';

const exec = promisify(execFile);
const cli = new URL('../src/cli.js', import.meta.url);

test('CLI guard rejects Node below 24 before importing the implementation or SQLite', async () => {
  const wrapper = `Object.defineProperty(process.versions, 'node', { value: '22.0.0' }); await import(${JSON.stringify(cli.href)});`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', wrapper], { timeout: 3000 }), (error: unknown) => {
    const result = error as { code: number; stderr: string; stdout: string };
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), `agent-bridge-mcp requires Node.js 24 or newer (running 22.0.0 at ${process.execPath})`);
    assert.equal(result.stdout, '');
    return true;
  });
});

test('CLI help includes doctor and doctor exits 1 for failed checks without creating bridge files', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const help = await exec(process.execPath, [fileURLToPath(cli), '--help'], { timeout: 3000 });
  assert.match(help.stdout, /doctor\s+Check local installation/);
  await assert.rejects(exec(process.execPath, [fileURLToPath(cli), 'doctor'], {
    timeout: 3000, env: { ...process.env, PATH: f.dir, CLAUDE_CONFIG_DIR: f.config.claudeHome,
      CODEX_HOME: f.config.codexHome, AGENT_BRIDGE_STATE_DIR: f.config.stateDir,
      AGENT_BRIDGE_RUNTIME_DIR: f.config.runtimeDir, AGENT_BRIDGE_CODEX_SOCKET: `${f.dir}/missing.sock` },
  }), (error: unknown) => {
    const result = error as { code: number; stdout: string };
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^PASS Node:/m);
    assert.match(result.stdout, /^FAIL Claude version:/m);
    assert.match(result.stdout, /^  Fix:/m);
    return true;
  });
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(f.dir), []);
});

test('serve shuts down and removes its reply socket when the MCP client closes stdin', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const dir = join(f.config.claudeHome, 'sessions');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const register = async (pid: number, sessionId: string, name: string) => {
    const path = join(f.dir, `${name}.sock`);
    const server = createNetServer(socket => socket.resume().on('error', () => undefined));
    await new Promise<void>(resolve => server.listen(path, resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    await writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/fixture', name, messagingSocketPath: path, peerProtocol: 1, procStart }), { mode: 0o600 });
    return `claude:${sessionId}`;
  };
  const sender = await register(process.pid, '00000000-0000-4000-8000-0000000000a1', 'sender');
  const peer = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { peer.kill(); });
  const recipient = await register(peer.pid!, '00000000-0000-4000-8000-0000000000a2', 'recipient');

  const bridge = spawn(process.execPath, [fileURLToPath(cli), 'serve'], { stdio: ['pipe', 'pipe', 'ignore'], env: {
    PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: f.config.claudeHome, CODEX_HOME: f.config.codexHome,
    AGENT_BRIDGE_CODEX_SOCKET: `${f.dir}/absent.sock`, AGENT_BRIDGE_STATE_DIR: f.config.stateDir, AGENT_BRIDGE_RUNTIME_DIR: f.config.runtimeDir,
  } });
  t.after(() => { bridge.kill('SIGKILL'); });
  const exited = new Promise<number | null>(resolve => bridge.once('exit', code => resolve(code)));
  const responses = new Map<number, (value: unknown) => void>();
  createInterface({ input: bridge.stdout }).on('line', line => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id !== undefined) responses.get(message.id)?.(message);
  });
  const request = (id: number, method: string, params: unknown) => {
    const response = new Promise(resolve => responses.set(id, resolve));
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };
  await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-bridge-test', version: '0.1.0' } });
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const sent = await request(2, 'tools/call', { name: 'send_message', arguments: { to: recipient, sender, text: 'open a reply socket' } });
  assert.doesNotMatch(JSON.stringify(sent), /isError/);
  assert.equal((await readdir(f.config.runtimeDir)).filter(file => file.endsWith('.sock')).length, 1);

  bridge.stdin.end();
  const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('still running'), 1000))]);
  assert.equal(code, 0);
  assert.deepEqual((await readdir(f.config.runtimeDir)).filter(file => file.endsWith('.sock')), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { TestContext } from 'node:test';
import { runDoctor, formatDoctor } from '../src/doctor.js';
import type { CommandRunner, DoctorOptions, Finding } from '../src/doctor.js';
import { claude, codex, fixture } from './helpers.js';

async function setup(t: TestContext) {
  const f = await fixture(); t.after(f.cleanup);
  const registry = join(f.config.claudeHome, 'sessions');
  await mkdir(registry, { recursive: true, mode: 0o700 });
  await mkdir(f.config.codexSocketDir, { mode: 0o700 });
  const claudeSocket = join(f.dir, 'claude.sock');
  const inbox = createNetServer(socket => socket.destroy());
  await new Promise<void>(resolve => inbox.listen(claudeSocket, resolve));
  t.after(() => new Promise<void>(resolve => inbox.close(() => resolve())));
  const descriptor = { pid: process.pid, sessionId: claude.nativeId, cwd: '/fixture', messagingSocketPath: claudeSocket, peerProtocol: 1 };
  const descriptorPath = join(registry, `${process.pid}.json`);
  await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  const http = createHttpServer();
  const ws = new WebSocketServer({ server: http });
  const methods: string[] = [];
  const initialization = { value: {} as unknown };
  ws.on('connection', socket => socket.on('message', raw => {
    const r = JSON.parse(raw.toString()); methods.push(r.method);
    if (r.method === 'initialized') return;
    const result = r.method === 'thread/loaded/list'
      ? (r.params.cursor ? { data: ['second'], nextCursor: null } : { data: [codex.nativeId], nextCursor: 'next' })
      : initialization.value;
    socket.send(JSON.stringify({ id: r.id, result }));
  }));
  const endpoint = join(f.config.codexSocketDir, 'a'.repeat(64));
  await new Promise<void>(resolve => http.listen(endpoint, resolve));
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const cliPath = join(f.dir, 'dist', 'cli.js');
  const commands: { command: string; args: string[] }[] = [];
  const run: CommandRunner = async (command, args, options) => {
    commands.push({ command, args });
    assert.equal(options.timeout, f.config.timeoutMs);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, f.config.claudeHome);
    assert.equal(options.env.CODEX_HOME, f.config.codexHome);
    let stdout: string;
    if (args[0] === '--version') stdout = command === 'claude' ? '2.1.312 (Claude Code)' : 'codex-cli 0.165.0';
    else if (args.join(' ') === 'mcp --help') stdout = 'Commands:\n  get <name> Get configuration';
    else if (args.join(' ') === 'mcp get --help') stdout = command === 'claude' ? 'Usage: get <name>' : 'Options: --json';
    else stdout = command === 'claude' ? `Command: ${process.execPath}\nArgs: ${cliPath} serve\n` : JSON.stringify({ transport: { command: process.execPath, args: [cliPath, 'serve'] } });
    return { stdout, stderr: '' };
  };
  const procRoot = join(f.dir, 'proc');
  const options: DoctorOptions = { run, cliPath, platform: 'linux', procRoot };
  const inspect = (overrides: DoctorOptions = {}) => runDoctor(f.config, { ...options, ...overrides });
  return { ...f, registry, descriptorPath, descriptor, endpoint, cliPath, methods, initialization, commands, run, inspect, procRoot };
}

function finding(findings: Finding[], check: string): Finding {
  const found = findings.find(item => item.check === check);
  assert.ok(found, check);
  return found;
}

function overrideRunner(base: CommandRunner, match: (command: string, args: string[]) => string | undefined): CommandRunner {
  return async (command, args, options) => {
    const stdout = match(command, args);
    return stdout === undefined ? base(command, args, options) : { stdout, stderr: '' };
  };
}

test('doctor passes on fixtures without creating files and probes only initialize and loaded-list metadata', async t => {
  const f = await setup(t);
  const daemonDir = join(f.config.codexHome, 'app-server-daemon');
  await mkdir(daemonDir, { recursive: true, mode: 0o700 });
  const updater = join(f.config.codexSocketDir, 'b'.repeat(64));
  await writeFile(updater, 'not an RPC endpoint');
  await symlink(updater, join(daemonDir, 'daemon-updater.sock'));
  const before = (await readdir(f.dir, { recursive: true })).sort();
  const results = await f.inspect();
  assert.equal(results.length, 10);
  assert.ok(results.every(item => item.status === 'PASS'), formatDoctor(results));
  assert.equal(finding(results, 'Claude registry').finding, '1 live, 0 stale registrations ignored');
  assert.equal(finding(results, 'Codex endpoints').finding, '1 endpoints excluding updater, 1 reachable, 2 loaded threads');
  assert.deepEqual(f.methods, ['initialize', 'initialized', 'thread/loaded/list', 'thread/loaded/list']);
  assert.deepEqual((await readdir(f.dir, { recursive: true })).sort(), before);
  assert.ok(f.commands.some(call => call.args.join(' ') === 'mcp get --help'));
  assert.ok(f.commands.some(call => call.args.join(' ') === 'mcp get agent-bridge --json'));
  assert.ok(f.commands.every(call => !call.args.includes('add') && !call.args.includes('send')));
});

test('doctor reports unsupported Node, unavailable SQLite, non-Linux and unreadable proc', async t => {
  const f = await setup(t);
  assert.equal(finding(await f.inspect({ nodeVersion: '23.9.0' }), 'Node').status, 'FAIL');
  const sqlite = await f.inspect({ loadSqlite: async () => { throw new Error('SQLite disabled'); } });
  assert.equal(finding(sqlite, 'Node').status, 'FAIL');
  assert.match(finding(sqlite, 'Node').finding, /SQLite disabled/);
  const platform = finding(await f.inspect({ platform: 'darwin' }), 'Platform');
  assert.equal(platform.status, 'FAIL');
  assert.equal(platform.finding, 'Linux/WSL only: discovery reads /proc');
  assert.equal(finding(await f.inspect({ procStatPath: join(f.dir, 'no-proc') }), 'Platform').status, 'FAIL');
});

test('doctor distinguishes unsupported, untested and missing client versions', async t => {
  const f = await setup(t);
  for (const [command, stdout, status] of [
    ['claude', '2.1.223', 'FAIL'], ['claude', '2.1.224', 'WARN'], ['claude', '2.1.313', 'WARN'],
    ['codex', 'codex-cli 0.166.0', 'WARN'], ['codex', 'unknown', 'FAIL'],
  ] as const) {
    const run = overrideRunner(f.run, (c, args) => c === command && args[0] === '--version' ? stdout : undefined);
    const result = finding(await f.inspect({ run }), command === 'claude' ? 'Claude version' : 'Codex version');
    assert.equal(result.status, status);
    if (status === 'WARN') assert.match(result.finding, /untested version/);
  }
  const run: CommandRunner = async () => { throw Object.assign(new Error('missing executable'), { code: 'ENOENT' }); };
  const results = await f.inspect({ run });
  assert.equal(finding(results, 'Claude version').status, 'FAIL');
  assert.equal(finding(results, 'Codex version').status, 'FAIL');
  assert.match(finding(results, 'Claude registration').finding, /skipped: command is missing/);
  assert.match(finding(results, 'Codex registration').finding, /skipped: command is missing/);
});

test('doctor ignores dead and non-Claude unparseable registrations beside a valid live session', async t => {
  const f = await setup(t);
  await writeFile(join(f.registry, '999999999.json'), JSON.stringify({ old: 'format' }));
  const proc = join(f.procRoot, '222222222');
  await mkdir(proc, { recursive: true });
  await writeFile(join(proc, 'cmdline'), 'node\0unrelated-worker\0');
  await writeFile(join(f.registry, '222222222.json'), '{invalid JSON');
  const result = finding(await f.inspect(), 'Claude registry');
  assert.equal(result.status, 'PASS');
  assert.equal(result.finding, '1 live, 2 stale registrations ignored');
});

test('doctor detects unparseable registrations belonging to running Claude processes', async t => {
  const f = await setup(t);
  await writeFile(f.descriptorPath, JSON.stringify({ changed: 'schema' }));
  const proc = join(f.procRoot, String(process.pid));
  await mkdir(proc, { recursive: true });
  await writeFile(join(proc, 'cmdline'), '/usr/bin/claude\0--resume\0');
  const result = finding(await f.inspect(), 'Claude registry');
  assert.equal(result.status, 'FAIL');
  assert.equal(result.finding, `Claude session registry format changed for running session(s) ${process.pid}; the bridge needs updating`);
});

test('doctor warns for no live Claude sessions, including only old-format leftovers', async t => {
  const f = await setup(t);
  await writeFile(f.descriptorPath, JSON.stringify({ ...f.descriptor, procStart: '0' }));
  let result = finding(await f.inspect(), 'Claude registry');
  assert.equal(result.status, 'WARN');
  assert.equal(result.finding, 'no live Claude session found');
  await writeFile(f.descriptorPath, JSON.stringify({ old: 'format' }));
  result = finding(await f.inspect(), 'Claude registry');
  assert.equal(result.status, 'WARN');
  assert.equal(result.finding, 'no live Claude session found');
  await rm(f.descriptorPath);
  assert.equal(finding(await f.inspect(), 'Claude registry').status, 'WARN');
});

test('doctor rejects absent or wrongly owned Claude registries', async t => {
  const f = await setup(t);
  assert.equal(finding(await f.inspect({ uid: (process.getuid?.() ?? 0) + 1 }), 'Claude registry').status, 'FAIL');
  await rm(f.registry, { recursive: true });
  assert.equal(finding(await f.inspect(), 'Claude registry').status, 'FAIL');
});

test('doctor fails without reachable Codex endpoints and warns when only some probes succeed', async t => {
  const f = await setup(t);
  const bad = join(f.config.codexSocketDir, 'c'.repeat(64));
  await writeFile(bad, 'not a socket');
  const partial = finding(await f.inspect(), 'Codex endpoints');
  assert.equal(partial.status, 'WARN');
  assert.match(partial.finding, /2 endpoints excluding updater, 1 reachable, 2 loaded threads/);
  const selected = { ...f.config, codexSocket: bad };
  const result = finding(await runDoctor(selected, { run: f.run, cliPath: f.cliPath }), 'Codex endpoints');
  assert.equal(result.status, 'FAIL');
  assert.match(result.fix, /daemon/);
  const empty = join(f.dir, 'empty-sockets'); await mkdir(empty, { mode: 0o700 });
  const none = finding(await runDoctor({ ...f.config, codexSocketDir: empty }, { run: f.run }), 'Codex endpoints');
  assert.equal(none.status, 'FAIL');
  assert.match(none.finding, /0 endpoints.*0 reachable.*0 loaded threads/);
  const absent = finding(await runDoctor({ ...f.config, codexSocketDir: join(f.dir, 'missing') }, { run: f.run }), 'Codex endpoints');
  assert.equal(absent.status, 'FAIL');
});

test('doctor checks existing private state/runtime and writable parents without making directories', async t => {
  const f = await setup(t);
  for (const path of [f.config.stateDir, f.config.runtimeDir]) await mkdir(path, { mode: 0o700 });
  let results = await f.inspect();
  assert.equal(finding(results, 'State').status, 'PASS');
  assert.equal(finding(results, 'Runtime').status, 'PASS');
  await chmod(f.config.stateDir, 0o755); await chmod(f.config.runtimeDir, 0o770);
  results = await f.inspect();
  assert.equal(finding(results, 'State').status, 'FAIL');
  assert.equal(finding(results, 'Runtime').status, 'FAIL');
  await chmod(f.config.stateDir, 0o700); await chmod(f.config.runtimeDir, 0o700);
  results = await f.inspect({ uid: (process.getuid?.() ?? 0) + 1 });
  assert.equal(finding(results, 'State').status, 'FAIL');
  assert.equal(finding(results, 'Runtime').status, 'FAIL');
  await rm(f.config.stateDir, { recursive: true });
  const parent = join(f.dir, 'locked'); await mkdir(parent, { mode: 0o500 });
  t.after(() => chmod(parent, 0o700).catch(() => undefined));
  results = await runDoctor({ ...f.config, stateDir: join(parent, 'new', 'state') }, { run: f.run });
  if (process.getuid?.() !== 0) assert.equal(finding(results, 'State').status, 'FAIL');
});

test('doctor warns for unsupported, health-checking, missing, unreadable and mismatched registrations', async t => {
  const f = await setup(t);
  for (const [args, output, pattern, status] of [
    ['mcp --help', 'Commands: list', /skipped/, 'SKIPPED'],
    ['mcp get --help', 'approved servers are health-checked', /health-checks by starting/, 'SKIPPED'],
    ['mcp get agent-bridge', 'No server found', /not registered/, 'WARN'],
    ['mcp get agent-bridge', 'Command: npx\nArgs: agent-bridge-mcp', /could not be verified/, 'WARN'],
    ['mcp get agent-bridge', 'Command: node\nArgs: /elsewhere/dist/cli.js serve', /points at \/elsewhere/, 'WARN'],
  ] as const) {
    const run = overrideRunner(f.run, (c, a) => c === 'claude' && a.join(' ') === args ? output : undefined);
    const result = finding(await f.inspect({ run }), 'Claude registration');
    assert.equal(result.status, status);
    assert.match(result.finding, pattern);
  }
  const run: CommandRunner = async (c, args, options) => {
    if (args[2] === 'agent-bridge') throw new Error('not registered');
    return f.run(c, args, options);
  };
  const results = await f.inspect({ run });
  assert.equal(finding(results, 'Claude registration').status, 'WARN');
  assert.equal(finding(results, 'Codex registration').status, 'WARN');
  const rendered = formatDoctor(results);
  assert.equal((rendered.match(/^  Fix:/gm) ?? []).length, results.filter(item => item.status !== 'PASS').length);
});


test('doctor prefers the Codex initialize version and annotates its CLI fallback', async t => {
  const f = await setup(t);
  for (const initialization of [
    { serverInfo: { version: '0.165.0' } },
    { userAgent: 'codex_cli_rs/0.165.0 (Linux 6.6.0; x86_64)' },
  ]) {
    f.initialization.value = initialization;
    f.commands.length = 0;
    const result = finding(await f.inspect(), 'Codex version');
    assert.equal(result.status, 'PASS');
    assert.match(result.finding, /app-server initialize/);
    assert.ok(!f.commands.some(call => call.command === 'codex' && call.args[0] === '--version'));
  }
  f.initialization.value = { serverInfo: { version: '0.166.0' } };
  assert.equal(finding(await f.inspect(), 'Codex version').status, 'WARN');
  f.initialization.value = {};
  assert.match(finding(await f.inspect(), 'Codex version').finding, /the codex CLI may update its PATH alias/);
});

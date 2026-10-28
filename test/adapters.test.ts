import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import type { Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join, relative } from 'node:path';
import { WebSocketServer } from 'ws';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { claudeFrame, sendClaudeFrame } from '../src/claude-wire.js';
import { claude, codex, fixture } from './helpers.js';

test('Claude discovery checks process starttime and ignores stale or symlinked registrations', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const dir = join(f.config.claudeHome, 'sessions');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(f.dir, 'claude.sock');
  const server = createNetServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const descriptor = { pid: process.pid, sessionId: claude.nativeId, cwd: '/fixture', name: 'fixture-claude', messagingSocketPath: path, peerProtocol: 1, procStart };
  const file = join(dir, `${process.pid}.json`);
  await writeFile(file, JSON.stringify(descriptor), { mode: 0o600 });
  const adapter = new ClaudeAdapter(f.config);
  assert.equal((await adapter.discover()).sessions[0]?.name, 'fixture-claude');
  await writeFile(file, JSON.stringify({ ...descriptor, procStart: '0' }));
  assert.equal((await adapter.discover()).sessions.length, 0);
  await writeFile(file, JSON.stringify({ ...descriptor, pidDomain: 'linux:other:pid:[0]' }));
  assert.equal((await adapter.discover()).sessions.length, 0);
  await writeFile(join(dir, 'other.json'), JSON.stringify(descriptor), { mode: 0o600 });
  const { unlink } = await import('node:fs/promises'); await unlink(file);
  await symlink(join(dir, 'other.json'), file);
  assert.equal((await adapter.discover()).sessions.length, 0);
});

test('Claude transport submits and closes after writing without waiting for a silent receiver', { timeout: 2000 }, async t => {
  const f = await fixture(); t.after(f.cleanup);
  const path = join(f.dir, 'claude.sock');
  const received = Promise.withResolvers<unknown>();
  const closed = Promise.withResolvers<void>();
  const peers = new Set<Socket>();
  // Deliberately send no acknowledgement and never initiate a close.
  const server = createNetServer(socket => {
    peers.add(socket);
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      if (buffer.includes('\n')) received.resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
    });
    socket.once('close', () => { peers.delete(socket); closed.resolve(); });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(() => new Promise<void>(resolve => {
    for (const socket of peers) socket.destroy();
    server.close(() => resolve());
  }));
  const wire = claudeFrame('text', 'fixed-id', 'uds:/fixture/reply.sock');
  assert.deepEqual(await sendClaudeFrame(path, wire, 10_000), {
    state: 'submitted',
    detail: 'Claude socket accepted the write. The receiver may have delivered, held, or refused it; Claude Code sends no confirmation either way. Do not retry automatically.',
  });
  assert.deepEqual(await received.promise, wire);
  await closed.promise;
  assert.equal((await sendClaudeFrame(join(f.dir, 'missing.sock'), wire, 50)).state, 'failed');
});

test('Codex discovery uses metadata RPC only, paginates loaded threads, and skips unloaded ones', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const path = join(f.dir, 'codex.sock');
  const http = createHttpServer(); const ws = new WebSocketServer({ server: http });
  const methods: string[] = [];
  ws.on('connection', socket => socket.on('message', raw => {
    const r = JSON.parse(raw.toString()); methods.push(r.method);
    if (r.method === 'initialized') return;
    let result: unknown = {};
    if (r.method === 'thread/loaded/list') result = r.params.cursor ? { data: ['closed'], nextCursor: null } : { data: [codex.nativeId], nextCursor: 'page2' };
    if (r.method === 'thread/read') result = { thread: { id: r.params.threadId, name: 'Fixture Codex', cwd: '/fixture', status: { type: r.params.threadId === 'closed' ? 'notLoaded' : 'idle' } } };
    socket.send(JSON.stringify({ id: r.id, result }));
  }));
  await new Promise<void>(resolve => http.listen(path, resolve));
  t.after(async () => { for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); });
  const adapter = new CodexAdapter({ ...f.config, codexSocket: path });
  const discovered = await adapter.discover();
  assert.equal(discovered.warnings.length, 0);
  assert.equal(discovered.sessions.length, 1);
  assert.equal(discovered.sessions[0]?.id, codex.id);
  assert.deepEqual(new Set(methods), new Set(['initialize', 'initialized', 'thread/loaded/list', 'thread/read']));
  assert.equal(methods.filter(x => x === 'thread/loaded/list').length, 2);
});

test('Codex discovery continues after a listed thread vanishes or cannot be read', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const path = join(f.dir, 'codex.sock');
  const http = createHttpServer(); const ws = new WebSocketServer({ server: http });
  const reads: string[] = [];
  ws.on('connection', socket => socket.on('message', raw => {
    const r = JSON.parse(raw.toString());
    if (r.method === 'initialized') return;
    if (r.method === 'thread/read') {
      reads.push(r.params.threadId);
      if (r.params.threadId === 'vanished') {
        socket.send(JSON.stringify({ id: r.id, error: { code: -32000, message: 'Thread unloaded after listing' } }));
        return;
      }
    }
    let result: unknown = {};
    if (r.method === 'thread/loaded/list') result = { data: ['vanished', codex.nativeId], nextCursor: null };
    if (r.method === 'thread/read') result = { thread: { id: codex.nativeId, name: 'Healthy Codex', cwd: '/fixture', status: { type: 'idle' } } };
    socket.send(JSON.stringify({ id: r.id, result }));
  }));
  await new Promise<void>(resolve => http.listen(path, resolve));
  t.after(async () => { for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); });
  const discovered = await new CodexAdapter({ ...f.config, codexSocket: path }).discover();
  assert.deepEqual(reads, ['vanished', codex.nativeId]);
  assert.equal(discovered.sessions[0]?.id, codex.id);
  assert.equal(discovered.warnings.length, 1);
  assert.match(discovered.warnings[0]!, /Codex thread vanished.*Thread unloaded/);
});

test('Codex discovery stops after transport loss and emits one endpoint warning', async t => {
  for (const mode of ['close', 'terminate'] as const) {
    const f = await fixture(); t.after(f.cleanup);
    const path = join(f.dir, 'codex.sock');
    const http = createHttpServer(); const ws = new WebSocketServer({ server: http });
    const reads: string[] = [];
    ws.on('connection', socket => socket.on('message', raw => {
      const r = JSON.parse(raw.toString());
      if (r.method === 'initialized') return;
      if (r.method === 'thread/read') {
        reads.push(r.params.threadId);
        socket[mode]();
        return;
      }
      const result = r.method === 'thread/loaded/list'
        ? { data: ['first', 'second', 'third'], nextCursor: 'unread-next-page' } : {};
      socket.send(JSON.stringify({ id: r.id, result }));
    }));
    await new Promise<void>(resolve => http.listen(path, resolve));
    try {
      const discovered = await new CodexAdapter({ ...f.config, codexSocket: path }).discover();
      assert.deepEqual(reads, ['first']);
      assert.equal(discovered.sessions.length, 0);
      assert.equal(discovered.warnings.length, 1);
      assert.match(discovered.warnings[0]!, /^Codex endpoint .*Codex connection closed\./);
    } finally {
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  }
});

test('Codex automatic discovery excludes the updater control socket, while explicit selection reports its failure', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const daemonDir = join(f.config.codexHome, 'app-server-daemon');
  await mkdir(daemonDir, { recursive: true, mode: 0o700 });
  await mkdir(f.config.codexSocketDir, { mode: 0o700 });
  const appPath = join(f.config.codexSocketDir, 'a'.repeat(64));
  const updaterPath = join(f.config.codexSocketDir, 'b'.repeat(64));
  let updaterConnections = 0;
  const updater = createNetServer(socket => { updaterConnections++; socket.destroy(); });
  await new Promise<void>(resolve => updater.listen(updaterPath, resolve));
  t.after(() => new Promise<void>(resolve => updater.close(() => resolve())));
  await symlink(updaterPath, join(daemonDir, 'daemon-updater.sock'));
  const http = createHttpServer(); const ws = new WebSocketServer({ server: http });
  ws.on('connection', socket => socket.on('message', raw => {
    const r = JSON.parse(raw.toString());
    if (r.method === 'initialized') return;
    let result: unknown = {};
    if (r.method === 'thread/loaded/list') result = { data: [codex.nativeId], nextCursor: null };
    if (r.method === 'thread/read') result = { thread: { id: codex.nativeId, name: 'Fixture Codex', cwd: '/fixture', status: { type: 'idle' } } };
    socket.send(JSON.stringify({ id: r.id, result }));
  }));
  await new Promise<void>(resolve => http.listen(appPath, resolve));
  t.after(async () => { for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); });
  const discovered = await new CodexAdapter(f.config).discover();
  assert.deepEqual(discovered.warnings, []);
  assert.equal(discovered.sessions[0]?.id, codex.id);
  assert.equal(updaterConnections, 0);
  await unlink(join(daemonDir, 'daemon-updater.sock'));
  await symlink(relative(daemonDir, updaterPath), join(daemonDir, 'daemon-updater.sock'));
  const relativeLink = await new CodexAdapter(f.config).discover();
  assert.deepEqual(relativeLink.warnings, []);
  assert.equal(relativeLink.sessions[0]?.id, codex.id);
  assert.equal(updaterConnections, 0);
  const explicit = await new CodexAdapter({ ...f.config, codexSocket: updaterPath }).discover();
  assert.equal(updaterConnections, 1);
  assert.equal(explicit.sessions.length, 0);
  assert.equal(explicit.warnings.length, 1);
  assert.match(explicit.warnings[0]!, /Codex endpoint/);
});

test('Codex queue passes literal text without a shell and treats nonzero exit as uncertain', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const path = join(f.dir, 'codex.sock');
  const server = createNetServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const capture = join(f.dir, 'args.json');
  const command = join(f.dir, 'queue-fixture');
  await writeFile(command, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const adapter = new CodexAdapter({ ...f.config, codexCommand: command, timeoutMs: 2000 });
  const text = 'Literal $(do-not-run) `do-not-run`\nsecond line';
  assert.equal((await adapter.send({ ...codex, endpoint: path }, text)).state, 'queued');
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), ['queue', '--remote', `unix://${path}`, '--thread', codex.nativeId, '--message', text]);
  await writeFile(command, '#!/usr/bin/env node\nprocess.exit(1);\n'); await chmod(command, 0o700);
  assert.equal((await adapter.send({ ...codex, endpoint: path }, text)).state, 'unknown');
});

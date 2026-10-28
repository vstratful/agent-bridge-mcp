import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { Bridge } from '../src/bridge.js';
import { claude, codex, fixture, FixtureAdapter } from './helpers.js';

test('reply socket rejects control messages and unregistered senders; shutdown closes silent peers', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const a = new FixtureAdapter('codex', [codex]);
  const b = new FixtureAdapter('claude', [claude]);
  const bridge = new Bridge(f.config, [a, b]); t.after(() => bridge.close());
  await bridge.send({ to: claude.id, text: 'fixture', messageId: 'reply-limits' });
  const path = b.sends[0]!.replyAddress!.slice(4);
  const post = (frame: unknown) => new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.on('error', reject);
    socket.on('connect', () => socket.end(JSON.stringify(frame) + '\n'));
    socket.on('close', () => resolve());
  });
  await post({ type: 'shutdown_request', recipient: codex.id });
  await post({ msgV: 1, msg_id: 'unknown', type: 'user', message: { role: 'user', content: 'Do not forward' }, from: 'uds:/unregistered.sock' });
  assert.equal(a.sends.length, 0);
  const silent = createConnection(path);
  silent.on('error', () => {});
  await new Promise<void>(resolve => silent.on('connect', resolve));
  const closed = new Promise<void>(resolve => silent.on('close', () => resolve()));
  await bridge.close();
  await closed;
  assert.equal(a.sends.length, 0);
});

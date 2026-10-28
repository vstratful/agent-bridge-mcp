import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { claudeFrame, sendClaudeFrame } from '../src/claude-wire.js';

test('Claude transport distinguishes pre-connect failures from all interrupted-write paths deterministically', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    t.mock.timers.reset();
  });
  const frame = claudeFrame('Text', 'interrupted', 'uds:/fixture/reply.sock');
  for (const connected of [false, true]) {
    for (const interruption of ['error', 'close', 'timeout', ...(connected ? ['write-error'] : [])]) {
      const socket = new net.Socket();
      let completeWrite: ((error?: Error | null) => void) | undefined;
      t.mock.method(socket, 'write', (...args: unknown[]) => {
        completeWrite = args.at(-1) as typeof completeWrite;
        return false;
      });
      const destroy = t.mock.method(socket, 'destroy', () => socket);
      const connect = t.mock.method(net, 'createConnection', () => socket);
      syncBuiltinESMExports();
      try {
        const pending = sendClaudeFrame('/fixture/socket', frame, 100);
        if (connected) socket.emit('connect');
        if (interruption === 'timeout') t.mock.timers.tick(100);
        else if (interruption === 'write-error') completeWrite!(new Error('Fixture write failure'));
        else if (interruption === 'error') socket.emit('error', new Error('Fixture socket error'));
        else socket.emit('close');
        const result = await pending;
        assert.equal(result.state, connected ? 'unknown' : 'failed', `${connected}: ${interruption}`);
        assert.equal(result.detail, connected
          ? 'Claude socket connected but the write did not confirm; the message may have been delivered. Do not retry automatically.'
          : 'Could not write to the Claude inbox.');
        // A callback arriving after an interruption must not turn it into submitted.
        completeWrite?.();
        assert.equal(destroy.mock.callCount(), 1);
      } finally {
        connect.mock.restore();
        syncBuiltinESMExports();
      }
    }
  }
});

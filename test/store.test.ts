import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import type { Message, MessageState } from '../src/types.js';
import { privateDirectory } from '../src/local-files.js';
import { claude, codex, fixture } from './helpers.js';

function record(id: string, createdAt: number, state: MessageState = 'queued'): Message {
  return { id, sender: claude.id, recipient: codex.id, text: id, createdAt: new Date(createdAt).toISOString(), state, detail: 'Fixture' };
}

test('opening the store prunes old records including uncertain sends and preserves recent records', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await privateDirectory(f.config.stateDir);
  const now = Date.now();
  const seed = new Store(f.config.stateDir, 0);
  seed.claim(record('old', now - 31 * 86400000));
  seed.claim(record('old-sending', now - 31 * 86400000, 'sending'));
  seed.claim(record('old-unknown', now - 31 * 86400000, 'unknown'));
  seed.claim(record('recent', now - 86400000));
  seed.close();
  const store = new Store(f.config.stateDir, 30); t.after(() => store.close());
  for (const id of ['old', 'old-sending', 'old-unknown']) assert.equal(store.get(id), undefined);
  assert.equal(store.get('recent')?.id, 'recent');
});

test('zero retention keeps old records on reopen and later claims', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await privateDirectory(f.config.stateDir);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const first = new Store(f.config.stateDir, 0);
  first.claim(record('old', now - 4000 * 86400000)); first.close();
  const second = new Store(f.config.stateDir, 0); t.after(() => second.close());
  assert.equal(second.get('old')?.id, 'old');
  now += 2 * 60 * 60 * 1000;
  second.claim(record('recent', now));
  assert.equal(second.get('old')?.id, 'old');
});

test('long-lived stores prune on later claims at most once an hour', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await privateDirectory(f.config.stateDir);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const store = new Store(f.config.stateDir, 1); t.after(() => store.close());
  store.claim(record('expiring', now - 23.5 * 60 * 60 * 1000));
  now += 31 * 60 * 1000;
  store.claim(record('recent', now));
  assert.equal(store.get('expiring')?.id, 'expiring');
  now += 30 * 60 * 1000;
  store.claim(record('trigger', now));
  assert.equal(store.get('expiring'), undefined);
  assert.equal(store.get('recent')?.id, 'recent');
});

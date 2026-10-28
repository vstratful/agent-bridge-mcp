import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, lstat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { privateDirectory } from '../src/local-files.js';
import { claude, codex, eventually, fixture, FixtureAdapter } from './helpers.js';

test('reply cleanup requires an absent PID and no listener; namespace-hidden live listeners are preserved', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await privateDirectory(f.config.runtimeDir);
  // An abrupt child exit leaves a bound socket file with no listener.
  const child = spawn(process.execPath, ['-e', `
    const path = require('node:path').join(process.argv[1], 'r-' + process.pid + '-stale.sock');
    require('node:net').createServer().listen(path, () => {
      require('node:fs').chmodSync(path, 0o600);
      process.exit(0);
    });
  `, f.config.runtimeDir], { stdio: 'ignore' });
  const deadPid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  const stale = join(f.config.runtimeDir, `r-${deadPid}-stale.sock`);
  assert.equal((await lstat(stale)).isSocket(), true);
  // The filename PID is absent locally, but its socket still has a listener.
  // This models a live bridge hidden by a different PID namespace.
  const hidden = join(f.config.runtimeDir, `r-${deadPid}-live-listener.sock`);
  let probes = 0;
  const live = join(f.config.runtimeDir, `r-${process.pid}-live.sock`);
  const protectedPid = join(f.config.runtimeDir, 'r-1-protected.sock');
  const unrelated = join(f.config.runtimeDir, 'unrelated.sock');
  for (const path of [hidden, live, protectedPid, unrelated]) {
    const server = createServer(socket => { if (path === hidden) probes++; socket.destroy(); });
    await new Promise<void>(resolve => server.listen(path, resolve));
    await chmod(path, 0o600);
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  }
  const regular = join(f.config.runtimeDir, `r-${deadPid}-regular.sock`);
  await writeFile(regular, 'not a socket', { mode: 0o600 });
  const link = join(f.config.runtimeDir, `r-${deadPid}-symlink.sock`);
  await symlink(live, link);
  const bridge = new Bridge(f.config, [new FixtureAdapter('codex', [codex]), new FixtureAdapter('claude', [claude])]);
  t.after(() => bridge.close());
  await bridge.send({ to: claude.id, text: 'Create a reply socket', messageId: 'prune-stale' });
  await assert.rejects(access(stale), { code: 'ENOENT' });
  await eventually(() => probes === 1);
  for (const path of [hidden, live, protectedPid, unrelated, regular]) await access(path);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
});

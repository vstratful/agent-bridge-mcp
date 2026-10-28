import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

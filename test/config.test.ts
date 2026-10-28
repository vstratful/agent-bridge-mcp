import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferSender, loadConfig } from '../src/config.js';

test('only Claude infers its session; a shared Codex MCP process never infers a thread', () => {
  const config = loadConfig({ CLAUDE_CODE_SESSION_ID: 'claude-session', CODEX_THREAD_ID: 'codex-session' });
  assert.equal(inferSender(config, 'claude-code'), 'claude:claude-session');
  assert.equal(inferSender(config, 'codex-mcp-client'), undefined);
  assert.equal(inferSender(config, 'unknown-client'), undefined);
  assert.equal(inferSender(config), undefined);
});

test('process overrides apply outside shared Codex clients; missing Claude identity never selects the parent', () => {
  const override = loadConfig({ AGENT_BRIDGE_SENDER_ID: 'codex:override', CLAUDE_CODE_SESSION_ID: 'claude-session', CODEX_THREAD_ID: 'codex-session' });
  assert.equal(inferSender(override, 'claude-code'), 'codex:override');
  assert.equal(inferSender(override, 'codex-mcp-client'), undefined);
  assert.equal(inferSender(override, 'unknown-client'), 'codex:override');
  assert.equal(inferSender(loadConfig({ CLAUDE_CODE_SESSION_ID: 'parent' }), 'codex-mcp-client'), undefined);
  assert.equal(inferSender(loadConfig({ CODEX_THREAD_ID: 'parent' }), 'claude-code'), undefined);
  assert.equal(inferSender(loadConfig({}), 'claude-code'), undefined);
});

test('without an MCP handshake, environment identities require an explicit CLI sender', () => {
  assert.equal(loadConfig({ CLAUDE_CODE_SESSION_ID: 'parent', CODEX_THREAD_ID: 'child' }).senderId, undefined);
});

test('retention defaults to 30 days, accepts zero and the upper limit, and rejects invalid values', () => {
  assert.equal(loadConfig({}).retentionDays, 30);
  assert.equal(loadConfig({ AGENT_BRIDGE_RETENTION_DAYS: '0' }).retentionDays, 0);
  assert.equal(loadConfig({ AGENT_BRIDGE_RETENTION_DAYS: '3650' }).retentionDays, 3650);
  for (const value of ['-1', '3651', '1.5', 'NaN', 'Infinity', 'invalid']) {
    assert.throws(() => loadConfig({ AGENT_BRIDGE_RETENTION_DAYS: value }), /AGENT_BRIDGE_RETENTION_DAYS/);
  }
});

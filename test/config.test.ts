import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, senderSource } from '../src/config.js';

test('only Claude infers its session, from its parent registration; a shared Codex MCP process never infers a thread', () => {
  const config = loadConfig({ CLAUDE_CODE_SESSION_ID: 'claude-session', CODEX_THREAD_ID: 'codex-session' });
  assert.deepEqual(senderSource(config, 'claude-code'), { claudeParent: true });
  assert.equal(senderSource(config, 'codex-mcp-client'), undefined);
  assert.equal(senderSource(config, 'unknown-client'), undefined);
  assert.equal(senderSource(config), undefined);
});

test('process overrides apply outside shared Codex clients', () => {
  const override = loadConfig({ AGENT_BRIDGE_SENDER_ID: 'codex:override', CLAUDE_CODE_SESSION_ID: 'claude-session', CODEX_THREAD_ID: 'codex-session' });
  assert.deepEqual(senderSource(override, 'claude-code'), { id: 'codex:override' });
  assert.equal(senderSource(override, 'codex-mcp-client'), undefined);
  assert.deepEqual(senderSource(override, 'unknown-client'), { id: 'codex:override' });
});

test('environment session IDs never become a sender: Claude keeps one MCP process across /clear', () => {
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ClaudeFrame, claudeFrame, nativeReplyText } from '../src/claude-wire.js';

test('native reply capture has ordinary tags and unwraps the matching single wrapper', async () => {
  // Sanitized raw capture from Claude 2.1.312; tests run from .test-build/test.
  const frame = ClaudeFrame.parse(JSON.parse(await readFile(new URL('../../test/fixtures/native-claude-reply.json', import.meta.url), 'utf8')));
  assert.equal(Buffer.from(frame.message.content).subarray(0, 6).toString('hex'), '3c63726f7373');
  assert.equal(nativeReplyText(frame.message.content, frame.from), 'BRIDGE_RAW_WRAPPER_FIXTURE');
  const body = '\n  Preserve whitespace\n';
  const wrapped = claudeFrame(body, 'whitespace', 'uds:/fixture/claude.sock');
  assert.equal(nativeReplyText(wrapped.message.content, wrapped.from), body);
});

test('native reply text preserves mismatched, partial, multiple, or ambiguous wrappers', () => {
  const from = 'uds:/fixture/claude.sock';
  const content = claudeFrame('Fixture answer', 'wrapper', from).message.content;
  for (const text of [
    'Plain text',
    `prefix${content}`,
    `${content}suffix`,
    `${content}${content}`,
    claudeFrame(content, 'nested', from).message.content,
    content.replace('from="', 'from="uds:/other.sock" from="'),
    content.replace('<cross-', '<\\cross-').replace('</cross-', '<\\/cross-'),
  ]) assert.equal(nativeReplyText(text, from), text);
  assert.equal(nativeReplyText(content, 'uds:/different.sock'), content);
  assert.equal(nativeReplyText(content), content);
});

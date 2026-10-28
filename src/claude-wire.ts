import { createConnection } from 'node:net';
import { z } from 'zod';
import type { Delivery } from './types.js';

export const ClaudeFrame = z.object({
  msgV: z.literal(1),
  msg_id: z.string().min(1).max(128),
  type: z.literal('user'),
  message: z.object({ role: z.literal('user'), content: z.string().max(64_000) }),
  from: z.string().max(512).optional(),
  priority: z.literal('next').optional(),
});

export function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', ' ');
}

/** Unwrap only one complete native message whose origin matches the frame. */
export function nativeReplyText(content: string, from?: string): string {
  if (!from) return content;
  const match = /^<cross-session-message((?:\s+[\w-]+="[^"<>]*")+)>([\s\S]*)<\/cross-session-message>$/.exec(content);
  if (!match) return content;
  const attributes = [...match[1]!.matchAll(/\s+([\w-]+)="([^"<>]*)"/g)];
  const origins = attributes.filter(attribute => attribute[1] === 'from');
  if (origins.length !== 1 || origins[0]![2] !== escapeAttribute(from)) return content;
  const body = match[2]!;
  // Multiple or nested wrappers are ambiguous; preserve their bytes verbatim.
  if (/<\/?cross-session-message\b/.test(body)) return content;
  return body.replace(/^\n/, '').replace(/\n$/, '');
}

export function claudeFrame(text: string, id: string, replyAddress: string): z.infer<typeof ClaudeFrame> {
  return {
    msgV: 1, msg_id: id, type: 'user', priority: 'next', from: replyAddress,
    message: { role: 'user', content: `<cross-session-message from="${escapeAttribute(replyAddress)}" from-name="agent-bridge">\n${text}\n</cross-session-message>` },
  };
}

/** Version-1 frame captured from the installed Claude 2.1.312 client against a fixture. */
export function sendClaudeFrame(path: string, frame: z.infer<typeof ClaudeFrame>, timeoutMs: number): Promise<Delivery> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    socket.setEncoding('utf8');
    let written = false;
    let buffer = '';
    let settled = false;
    const finish = (result: Delivery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const unknown = () => finish({ state: written ? 'submitted' : 'failed', detail: written
      ? 'Claude socket accepted the write; agent receipt and inbound approval are unconfirmed. Do not retry automatically.'
      : 'Could not write to the Claude inbox.' });
    const timer = setTimeout(unknown, timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(frame)}\n`, error => {
        if (error) return unknown();
        written = true;
      });
    });
    socket.on('data', data => {
      buffer += data.toString('utf8');
      if (buffer.length > 64_000) return unknown();
      // Only interpret receipts for this message. Raw protocol receipts are never
      // treated as evidence that the receiving model read or acted on the text.
      for (const line of buffer.split('\n').slice(0, -1)) {
        try {
          const ack = JSON.parse(line);
          if (ack.msg_id !== frame.msg_id) continue;
          if (ack.type === 'ack') {
            finish({ state: ack.wasHeld === true ? 'held' : 'submitted', detail: ack.wasHeld === true
              ? 'Claude reports the message is held for inbound approval.'
              : 'Claude acknowledged the socket frame. Agent receipt and execution are not confirmed.' });
            return;
          }
        } catch { /* Wait for completion or a bounded timeout. */ }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
    socket.on('error', unknown);
    socket.on('close', unknown);
  });
}

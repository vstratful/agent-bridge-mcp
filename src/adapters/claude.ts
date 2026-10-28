import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { ownedPath, ownedSocket, processMatches, readLocalJson } from '../local-files.js';
import { claudeFrame, sendClaudeFrame } from '../claude-wire.js';
import { errorText } from '../types.js';
import type { Adapter, Delivery, Discovery, Session } from '../types.js';

export const Descriptor = z.object({
  pid: z.number().int().positive(), sessionId: z.string().uuid(),
  cwd: z.string(), name: z.string().optional(), status: z.string().optional(),
  procStart: z.string().optional(), pidDomain: z.string().optional(),
  messagingSocketPath: z.string(), peerProtocol: z.literal(1),
});

export class ClaudeAdapter implements Adapter {
  readonly provider = 'claude';
  constructor(private config: Config) {}

  async discover(): Promise<Discovery> {
    const sessions: Session[] = [];
    const warnings: string[] = [];
    const dir = join(this.config.claudeHome, 'sessions');
    try {
      await ownedPath(dir, 'directory');
      for (const file of (await readdir(dir)).filter(name => /^\d+\.json$/.test(name))) {
        try {
          const parsed = Descriptor.safeParse(await readLocalJson(join(dir, file)));
          if (!parsed.success) continue;
          const d = parsed.data;
          if (file !== `${d.pid}.json` || !await processMatches(d.pid, d.procStart, d.pidDomain)) continue;
          await ownedSocket(d.messagingSocketPath);
          sessions.push({ id: `claude:${d.sessionId}`, provider: 'claude', nativeId: d.sessionId,
            name: d.name ?? d.sessionId, cwd: d.cwd, status: d.status ?? 'unknown',
            endpoint: d.messagingSocketPath, pid: d.pid, procStart: d.procStart });
        } catch { /* Stale, inaccessible or unsafe registrations are not live sessions. */ }
      }
    } catch (error) {
      warnings.push(`Claude discovery: ${errorText(error)}`);
    }
    if (!sessions.length) warnings.push('No reachable Claude inboxes in this process namespace. A sandbox may hide host processes or sockets.');
    return { sessions, warnings };
  }

  async send(session: Session, text: string, messageId: string, replyAddress?: string): Promise<Delivery> {
    if (!replyAddress) throw new Error('Claude delivery requires a bridge reply address.');
    if (!session.pid || !await processMatches(session.pid, session.procStart)) throw new Error('Claude process has exited or changed identity.');
    await ownedSocket(session.endpoint);
    return sendClaudeFrame(session.endpoint, claudeFrame(text, messageId, replyAddress), this.config.timeoutMs);
  }
}

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import type { Config } from '../src/config.js';
import type { Adapter, Delivery, Discovery, Provider, Session } from '../src/types.js';

export const codex: Session = { id: 'codex:00000000-0000-4000-8000-000000000001', nativeId: '00000000-0000-4000-8000-000000000001', provider: 'codex', name: 'builder', cwd: '/project', status: 'idle', endpoint: '/fixture/codex.sock' };
export const claude: Session = { id: 'claude:00000000-0000-4000-8000-000000000002', nativeId: '00000000-0000-4000-8000-000000000002', provider: 'claude', name: 'reviewer', cwd: '/project', status: 'idle', endpoint: '/fixture/claude.sock', pid: process.pid };

export class FixtureAdapter implements Adapter {
  sends: { session: Session; text: string; id: string; replyAddress?: string }[] = [];
  outcome: Delivery = { state: 'queued', detail: 'Fixture accepted.' };
  constructor(readonly provider: Provider, public sessions: Session[]) {}
  async discover(): Promise<Discovery> { return { sessions: this.sessions, warnings: [] }; }
  async send(session: Session, text: string, id: string, replyAddress?: string): Promise<Delivery> {
    this.sends.push({ session, text, id, replyAddress });
    return this.outcome;
  }
}

export async function fixture(): Promise<{ dir: string; config: Config; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp('/tmp/ab-test-');
  const config: Config = { ...loadConfig({}), stateDir: join(dir, 'state'), runtimeDir: join(dir, 'run'), claudeHome: join(dir, 'claude'), codexHome: join(dir, 'codex'), codexSocketDir: join(dir, 'sockets'), senderId: codex.id, timeoutMs: 150 };
  return { dir, config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture condition did not complete.');
}

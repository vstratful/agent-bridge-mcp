import { execFile } from 'node:child_process';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { ownedPath, ownedSocket } from '../local-files.js';
import { CodexConnectionError, CodexRpc } from '../rpc.js';
import { errorText } from '../types.js';
import type { Adapter, Delivery, Discovery, Session } from '../types.js';

const exec = promisify(execFile);

export class CodexAdapter implements Adapter {
  readonly provider = 'codex';
  constructor(private config: Config) {}

  async discover(): Promise<Discovery> {
    const sessions: Session[] = [];
    const warnings: string[] = [];
    let paths: string[];
    if (this.config.codexSocket) paths = [this.config.codexSocket];
    else {
      try {
        await ownedPath(this.config.codexSocketDir, 'directory');
        paths = (await readdir(this.config.codexSocketDir))
          .filter(name => /^[a-f0-9]{64}$/.test(name)).map(name => join(this.config.codexSocketDir, name));
        // The updater shares this directory, but speaks management IPC rather
        // than app-server WebSocket RPC. Its published symlink identifies it.
        try {
          const daemonDir = join(this.config.codexHome, 'app-server-daemon');
          await ownedPath(daemonDir, 'directory');
          const link = join(daemonDir, 'daemon-updater.sock');
          const info = await lstat(link);
          if (info.isSymbolicLink() && (!process.getuid || info.uid === process.getuid())) {
            const updater = resolve(daemonDir, await readlink(link));
            paths = paths.filter(path => path !== updater);
          }
        } catch {
          // Without a recognized control link, retain normal probe-and-warn
          // behavior. Never delete sockets or silently ignore RPC failures.
        }
      } catch (error) {
        return { sessions, warnings: [`Codex discovery: ${errorText(error)}`] };
      }
    }
    // Avoid creating hundreds of connections from a damaged or stale directory.
    if (paths.length > 32) warnings.push('Codex socket discovery capped at 32 endpoints. Set AGENT_BRIDGE_CODEX_SOCKET to select one.');
    await Promise.all(paths.slice(0, 32).map(async path => {
      let rpc: CodexRpc | undefined;
      try {
        await ownedSocket(path);
        rpc = await CodexRpc.connect(path, this.config.timeoutMs);
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const result: { data: string[]; nextCursor?: string | null } = await rpc.call('thread/loaded/list', { limit: 100, cursor });
          for (const id of result.data) {
            try {
              const { thread } = await rpc.call<{ thread: { id: string; name: string | null; cwd: string; status: { type: string } } }>('thread/read', { threadId: id, includeTurns: false });
              if (thread.status.type === 'notLoaded') continue;
              sessions.push({ id: `codex:${thread.id}`, nativeId: thread.id, provider: 'codex', name: thread.name || thread.id, cwd: thread.cwd, status: thread.status.type, endpoint: path });
            } catch (error) {
              if (error instanceof CodexConnectionError) throw error;
              warnings.push(`Codex thread ${id} at ${path}: ${errorText(error)}`);
            }
          }
          cursor = result.nextCursor ?? null;
          if (!cursor) break;
          if (page === 9) warnings.push(`Codex loaded-session pagination capped at ${path}.`);
        }
      } catch (error) {
        warnings.push(`Codex endpoint ${path}: ${errorText(error)}`);
      } finally {
        rpc?.close();
      }
    }));
    return { sessions, warnings };
  }

  async send(session: Session, text: string): Promise<Delivery> {
    await ownedSocket(session.endpoint);
    try {
      // Arguments are passed directly to execFile, never through a shell.
      await exec(this.config.codexCommand, ['queue', '--remote', `unix://${session.endpoint}`, '--thread', session.nativeId, '--message', text], {
        timeout: this.config.timeoutMs,
        maxBuffer: 64 * 1024,
        env: { ...process.env, CODEX_HOME: this.config.codexHome },
      });
      return { state: 'queued', detail: 'Codex accepted the queue command. Agent receipt and execution are not confirmed.' };
    } catch (error) {
      // A timeout or lost response can occur after the daemon accepted the text.
      return { state: 'unknown', detail: `Codex queue did not confirm acceptance. Do not retry automatically: ${errorText(error).slice(0, 500)}` };
    }
  }
}

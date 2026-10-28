import WebSocket from 'ws';
import { errorText } from './types.js';

/** A failed transport is distinct from a per-request JSON-RPC error. */
export class CodexConnectionError extends Error {
  constructor(error: Error) {
    super(error.message, { cause: error });
    this.name = 'CodexConnectionError';
  }
}

/** Connect only to an already running app-server. Never starts or resumes a thread. */
export class CodexRpc {
  private socket: WebSocket;
  private nextId = 1;
  private failure?: CodexConnectionError;
  private initialization?: unknown;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(path: string, private timeoutMs: number) {
    this.socket = new WebSocket(`ws+unix://${path}:/`, { maxPayload: 1024 * 1024, handshakeTimeout: timeoutMs });
    this.socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(String(message.error.message ?? 'Codex RPC error')));
        else entry.resolve(message.result);
      } catch (error) {
        this.fail(new Error(`Invalid Codex response: ${errorText(error)}`));
      }
    });
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('Codex connection closed.')));
  }

  static async connect(path: string, timeoutMs: number): Promise<CodexRpc> {
    const rpc = new CodexRpc(path, timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        rpc.socket.once('open', resolve);
        rpc.socket.once('error', reject);
      });
      rpc.initialization = await rpc.call('initialize', { clientInfo: { name: 'agent_bridge_mcp', version: '0.1.0' }, capabilities: null });
      rpc.socket.send(JSON.stringify({ method: 'initialized' }));
      return rpc;
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  get initializeResult(): unknown { return this.initialization; }

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (error) this.fail(error);
      });
    });
  }

  close(): void {
    this.fail(new Error('Codex connection closed.'));
    this.socket.terminate();
  }

  private fail(error: Error): void {
    this.failure ??= new CodexConnectionError(error);
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(this.failure);
    }
    this.pending.clear();
  }
}

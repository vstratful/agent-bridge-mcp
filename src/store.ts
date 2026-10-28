import { chmodSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Message, MessageState } from './types.js';

export class Store {
  private db: DatabaseSync;
  private lastPruneMs = 0;

  constructor(dir: string, private retentionDays = 30) {
    const path = join(dir, 'messages.sqlite');
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error('Refusing an unsafe bridge database.');
      }
    }
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        text TEXT NOT NULL, createdAt TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, createdAt);
      CREATE INDEX IF NOT EXISTS messages_createdAt ON messages(createdAt);`);
    this.prune(Date.now());
  }

  /** Atomic claim across MCP processes; retained uncertain sends are not repeated. */
  claim(message: Message): { fresh: boolean; message: Message } {
    const now = Date.now();
    if (now - this.lastPruneMs >= 60 * 60 * 1000) this.prune(now);
    const result = this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      message.id, message.sender, message.recipient, message.text, message.createdAt, message.state, message.detail);
    const stored = this.get(message.id)!;
    if (stored.sender !== message.sender || stored.recipient !== message.recipient || stored.text !== message.text) {
      throw new Error('Message ID is already used for different content or routing.');
    }
    return { fresh: result.changes === 1, message: stored };
  }

  get(id: string): Message | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as Message | undefined;
  }

  update(id: string, state: MessageState, detail: string): Message {
    this.db.prepare('UPDATE messages SET state = ?, detail = ? WHERE id = ?').run(state, detail, id);
    return this.get(id)!;
  }

  inbox(recipient: string, limit = 20, after?: string): Message[] {
    return this.db.prepare('SELECT * FROM messages WHERE recipient = ? AND createdAt > ? ORDER BY createdAt DESC, id DESC LIMIT ?')
      .all(recipient, after ?? '', Math.min(100, Math.max(1, limit))) as unknown as Message[];
  }

  close(): void { this.db.close(); }

  private prune(now: number): void {
    if (this.retentionDays > 0) {
      const cutoff = new Date(now - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
      // Old sending/unknown records expire too: deduplication is bounded by
      // retention, and reusing a message ID after that window may send again.
      this.db.prepare('DELETE FROM messages WHERE createdAt < ?').run(cutoff);
    }
    this.lastPruneMs = now;
  }
}

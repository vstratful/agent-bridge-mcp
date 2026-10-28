export type Provider = 'claude' | 'codex';

export interface Session {
  id: string;
  provider: Provider;
  nativeId: string;
  name: string;
  cwd: string;
  status: string;
  endpoint: string;
  pid?: number;
  procStart?: string;
}

export interface Discovery {
  sessions: Session[];
  warnings: string[];
}

export type MessageState = 'pending' | 'sending' | 'queued' | 'submitted' | 'held' | 'refused' | 'unknown' | 'failed';

export interface Message {
  id: string;
  sender: string;
  recipient: string;
  text: string;
  createdAt: string;
  state: MessageState;
  detail: string;
}

export interface Delivery {
  state: MessageState;
  detail: string;
}

export interface Adapter {
  readonly provider: Provider;
  discover(): Promise<Discovery>;
  send(session: Session, text: string, messageId: string, replyAddress?: string): Promise<Delivery>;
}

export const MAX_TEXT_BYTES = 16_000;

export function validateText(text: string): void {
  if (!text.trim()) throw new Error('Message text must not be empty.');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error(`Message text exceeds ${MAX_TEXT_BYTES} UTF-8 bytes.`);
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

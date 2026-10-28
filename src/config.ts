import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  claudeHome: string;
  codexHome: string;
  codexSocketDir: string;
  codexSocket?: string;
  codexCommand: string;
  stateDir: string;
  runtimeDir: string;
  timeoutMs: number;
  retentionDays: number;
  senderId?: string;
  claudeSessionId?: string;
  readOnly: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const timeoutMs = Number(env.AGENT_BRIDGE_TIMEOUT_MS ?? '5000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error('AGENT_BRIDGE_TIMEOUT_MS must be an integer between 100 and 30000.');
  }
  const retentionDays = Number(env.AGENT_BRIDGE_RETENTION_DAYS ?? '30');
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
    throw new Error('AGENT_BRIDGE_RETENTION_DAYS must be an integer between 0 and 3650.');
  }
  return {
    claudeHome: resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')),
    codexHome: resolve(env.CODEX_HOME ?? join(homedir(), '.codex')),
    codexSocketDir: join('/tmp', `codex-daemon-${process.getuid?.() ?? 1000}`),
    codexSocket: env.AGENT_BRIDGE_CODEX_SOCKET,
    codexCommand: env.AGENT_BRIDGE_CODEX_COMMAND ?? 'codex',
    stateDir: resolve(env.AGENT_BRIDGE_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'agent-bridge-mcp')),
    runtimeDir: resolve(env.AGENT_BRIDGE_RUNTIME_DIR ?? join('/tmp', `agent-bridge-${process.getuid?.() ?? 1000}`)),
    timeoutMs,
    retentionDays,
    senderId: env.AGENT_BRIDGE_SENDER_ID,
    claudeSessionId: env.CLAUDE_CODE_SESSION_ID,
    readOnly: env.AGENT_BRIDGE_READ_ONLY === '1',
  };
}

export function inferSender(config: Config, clientName?: string): string | undefined {
  // The Codex daemon owns its MCP children and may share one across threads.
  // Neither its environment nor a process-wide override identifies the caller.
  if (clientName === 'codex-mcp-client') return undefined;
  if (config.senderId) return config.senderId;
  // Either client can inherit the other's environment when launched by it.
  // Match the MCP initialize identity; unknown clients must supply a sender.
  if (clientName === 'claude-code' && config.claudeSessionId) return `claude:${config.claudeSessionId}`;
  return undefined;
}

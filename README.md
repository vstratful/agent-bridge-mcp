# agent-bridge-mcp

Discover and exchange text between your existing Claude Code and Codex sessions.
The bridge uses your installed, authenticated clients; it needs no API keys and
makes no model API calls. Messages can start work and consume client usage.

## Requirements

Linux or WSL 2, Node.js 24+, Claude Code >= 2.1.224, and Codex with its app-server
daemon running. Tested with Claude Code 2.1.312 and Codex CLI 0.165.0.

The bridge depends on undocumented Claude and Codex internals and may break on
client updates. Run `agent-bridge-mcp doctor` first when something stops working.

## Install and connect

The internal repository is private; replace `<org>` with your GitHub organization.

```sh
npm pack git+ssh://git@github.com/<org>/agent-bridge-mcp.git
npm install -g ./agent-bridge-mcp-*.tgz && rm ./agent-bridge-mcp-*.tgz
```

Don't use `npm install -g git+ssh://…` directly: npm's global git install fails to
build the package (`tsc: not found`). Packing first builds it in a normal clone.

Register in both clients using absolute paths:

```sh
claude mcp add --scope user --transport stdio agent-bridge -- "$(command -v node)" "$(npm root -g)/agent-bridge-mcp/dist/cli.js" serve
codex mcp add agent-bridge -- "$(command -v node)" "$(npm root -g)/agent-bridge-mcp/dist/cli.js" serve
```

Version managers can give a client a different, older Node; absolute paths keep
both clients on the Node version used to install the bridge. Reconnect their MCP
connections (`/mcp`) after registration or updates. Installation sends no messages.
The bridge must run in the same host process namespace as the sessions.

```sh
agent-bridge-mcp doctor
```

Doctor reports PASS, WARN, FAIL or SKIPPED and fixes for non-passing checks; any FAIL exits
with status 1. It checks metadata and configuration without sending messages or
creating bridge files. Unsupported registration queries are SKIPPED and do not affect the exit code.

## First use

Type prompts like these in Claude or Codex:

- “List my agent-bridge sessions.”
- “Tell the Codex session working on <repo> that the API changed.”
- “Ask the Claude session reviewing <repo> for its findings.”

Use exact session IDs when names are ambiguous. Codex must always pass its full
sender ID to `send_message` and recipient ID to `read_messages`: `codex:` followed
by `CODEX_THREAD_ID` from its shell environment. Claude normally infers its identity. Ask for approval before messaging whenever the user requires it.

`queued` means Codex accepted the queue command. `submitted` means Claude's socket
accepted the write; its receiver may deliver, hold or refuse it without telling the
sender. Neither proves an agent read the message. `unknown` means delivery may have
happened: reuse the same message ID and never automatically retry with a new ID.

## Security and limits

Local sessions must run as the same OS user. Sender IDs and names are claims;
Claude shows the sending process's verified PID as a stronger signal. Messages
are labelled as agent-originated text and cannot grant approval or change permissions.
The bridge is not a security boundary between agents under the same OS account.

Closed Codex windows can leave threads messageable for 30 minutes with nobody
watching. Message text appears in the Codex queue command's argv, readable by
other local users unless `/proc` access is restricted. The journal retains message
text for 30 days by default. No HTTP listener is opened. Native Windows, remote or
cloud sessions, agent-team control messages and arbitrary command execution are
outside this version. See [verification and protocol details](docs/VERIFICATION.md)
for tested behavior, hold/refuse rules, transport limits, sources and live checks.

## Configuration

| Environment variable | Default / purpose |
| --- | --- |
| `AGENT_BRIDGE_READ_ONLY=1` | Disables sends and native replies; CLI also accepts `--read-only`. |
| `AGENT_BRIDGE_STATE_DIR` | `$XDG_STATE_HOME/agent-bridge-mcp` or `~/.local/state/agent-bridge-mcp`; SQLite journal. |
| `AGENT_BRIDGE_RUNTIME_DIR` | `/tmp/agent-bridge-<uid>`; private reply sockets. |
| `AGENT_BRIDGE_SENDER_ID` | CLI/non-Codex full sender ID override; ignored for Codex MCP clients. |
| `AGENT_BRIDGE_CODEX_SOCKET` | Exact daemon socket; otherwise searches `/tmp/codex-daemon-<uid>`. |
| `AGENT_BRIDGE_TIMEOUT_MS` | `5000`; integer `100`–`30000`. |
| `AGENT_BRIDGE_RETENTION_DAYS` | `30`; integer `0`–`3650`; `0` disables pruning. |
| `AGENT_BRIDGE_CODEX_COMMAND` | `codex`; override the executable path. |
| `CLAUDE_CONFIG_DIR` | `~/.claude`; session registrations. |
| `CODEX_HOME` | `~/.codex`; also forwarded to the queue command. |
| `AGENT_BRIDGE_DEBUG=1` | Logs unsupported frame field names, without text or tokens. |

## Uninstall

```sh
claude mcp remove --scope user agent-bridge
codex mcp remove agent-bridge
npm uninstall -g agent-bridge-mcp
```

Stop connected bridge processes before manually removing the configured state
and runtime directories if you also want to delete retained messages and sockets.

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

Install from GitHub; no account or SSH key is needed.

```sh
npm pack git+https://github.com/vstratful/agent-bridge-mcp.git
npm install -g ./agent-bridge-mcp-*.tgz && rm ./agent-bridge-mcp-*.tgz
```

Don't use `npm install -g git+https://…` directly: npm's global git install fails to
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

## Using it

You don't call the bridge yourself. Talk to Claude or Codex as you normally would
and ask it to message another session; the agent finds the session and sends the
message with the bridge's tools. For example, you might type:

> List my other Claude and Codex sessions.

> Tell the Codex session working on billing-api that the response schema changed.

> Ask the Claude session reviewing the auth PR for its findings.

Sessions are known by their names: a Claude session's name (set with `/rename` or
chosen automatically) and a Codex thread's title. If two share a name, the agent
uses the full session ID instead.

The message appears in the other session's conversation with a preview such as
`From billing-api (codex): The response schema changed.` The receiving agent treats
it as a message from another agent, not from you, so it may check with you before
acting on it. To answer, ask that agent to reply; the reply comes back the same way.
An idle session picks the message up straight away. A busy Claude reads it between
steps; a busy Codex gets it when its current turn finishes.

The sending agent reports one of these:

- **queued** (to Codex) or **submitted** (to Claude): handed over. Neither means the
  other agent has read it yet, and a Claude session can be set to hold or refuse
  messages without the sender being told.
- **unknown**: it may or may not have been delivered. The agent won't resend it
  under a new ID, to avoid a duplicate; check the other session.

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

## License

MIT. See [LICENSE](LICENSE).

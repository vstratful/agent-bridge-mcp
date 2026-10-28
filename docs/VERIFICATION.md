# Verification and implementation details

Discover and exchange plain-text messages between existing Claude Code and Codex
sessions running as the same user in the same Linux / WSL environment.

The bridge uses your installed, authenticated clients. It makes no model API
calls and needs no API keys. Messages can start work and consume normal usage in
the receiving client.

## Verification

Verified with Claude Code 2.1.312 and Codex CLI 0.165.0:

- Local metadata discovery, MCP stdio tools, and Claude sender inference after
  reconnect, with no updater-socket warning.
- Complete MCP message/reply round trips, delivery to busy Claude sessions, and
  queued messages waking idle Codex sessions.
- Native Claude `SendMessage` replies through live bridge return sockets to
  Claude and Codex. Dead return sockets fail loudly with `ENOENT`.
- Reusing a message ID returns its stored record without redelivery.
- Forwarded native Claude replies arrive without Claude's inner wrapper, with
  newlines and `<`, `&` and `"` intact.
- Starting a reply socket removes an orphaned socket (dead PID, refused
  connection) and keeps sockets of live bridge processes.
- Codex's daemon starts the bridge with a cleaned environment that has no thread
  ID, and the bridge process belongs to the daemon rather than one thread. Codex
  calls must pass their sender explicitly.
- Claude inbound accept, hold, and refuse behavior: in all three cases a live
  byte-logging probe received no acknowledgement, notice, or connection close.
  The sender cannot distinguish these outcomes.

Fixture tests cover discovery races, message previews, wrapper handling,
safe stale-socket cleanup, retention, and transport
failures. Reconnect MCP processes after rebuilding before repeating live checks.

## Build and test

Requires Node.js 24+, npm, and the existing `codex` and `claude` installations.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
node dist/cli.js list --read-only
```

Tests delete `.test-build`, then compile TypeScript before running Node's test runner.
Tests use temporary
directories, fixture sockets and stub queue commands; they never message real
sessions. Some Codex execution sandboxes hide host processes and sockets, and the
Node test runner may need to run outside that sandbox.

## Connect both clients

Build first. Replace `/absolute/path/agent-bridge-mcp` below with this directory.
Use the same Node.js executable for both clients (an absolute path is useful when
an editor does not inherit your shell's PATH).

```sh
codex mcp add agent-bridge -- node /absolute/path/agent-bridge-mcp/dist/cli.js serve
claude mcp add --scope user --transport stdio agent-bridge -- node /absolute/path/agent-bridge-mcp/dist/cli.js serve
```

Reconnect/restart the relevant MCP connection or session after configuration.
Claude's `/mcp` and Codex's `/mcp` show connection status. The bridge must run on
the host where those sessions run, with access to their process namespace and
local sockets. Installing an MCP server does not itself send a message.

Remove the entries with:

```sh
codex mcp remove agent-bridge
claude mcp remove --scope user agent-bridge
```

## Tools and use

| Tool | Behavior |
| --- | --- |
| `list_sessions` | Reads live session metadata and discovery warnings. No transcripts or messages. |
| `send_message` | Sends text to a full session ID or unique exact name. Includes sender and reply instructions. |
| `read_messages` | Reads retained journal records without consuming or acknowledging them. |
| `message_status` | Reads the recorded transport outcome for a message ID. |

Start by asking either agent to use `list_sessions`. Then identify the other
session by name or full ID and ask the agent to send the intended message. When
the user's instructions require approval, the agent must ask before sending.

Example `send_message` arguments (use IDs returned by discovery):

```json
{
  "to": "claude:<session-uuid>",
  "sender": "codex:<thread-uuid>",
  "text": "The schema change is ready for your review.",
  "message_id": "schema-ready-001"
}
```

Use full IDs, especially when retrying a tool call with the same `message_id`.
After the MCP handshake, the bridge uses `CLAUDE_CODE_SESSION_ID` for a
`claude-code` client. Unknown clients or missing Claude identity require `sender`
explicitly. `AGENT_BRIDGE_SENDER_ID` overrides inference outside Codex MCP clients.
Codex MCP clients always have `inferred_sender: null`: the daemon starts the
bridge without a thread ID and may share it across threads, so neither
`CODEX_THREAD_ID` nor a process-wide override identifies the calling thread. Codex clients must pass `sender` to
`send_message` and `recipient` to `read_messages` on every call. A Codex session's
own ID is `codex:` followed by `CODEX_THREAD_ID` from its shell environment, which
Codex does set for shell commands (verified on 0.165.0). The tool descriptions tell
Codex this; a cold first-use test found its ID and sent correctly.
The CLI has no MCP handshake; use `--from` for sending and `--to` for inbox reads,
or set `AGENT_BRIDGE_SENDER_ID` for that CLI invocation.
Reconnect the MCP server after rebuilding so existing clients load these changes.
Verify `inferred_sender` rather than assuming it is yours.
Names and sender IDs are local routing labels, not authenticated identities.

## Delivery and replies

- Claude discovery reads `~/.claude/sessions/<pid>.json`, validates the live
  process identity and checks socket ownership. Delivery writes the version-1
  frame captured from Claude 2.1.312 to its native inbox.
- Codex discovery connects to existing app-server Unix sockets using the
  documented WebSocket handshake, lists loaded threads, and reads metadata only.
  Automatic discovery skips the updater control socket identified by
  `~/.codex/app-server-daemon/daemon-updater.sock`; explicit socket selections
  still report connection failures.
  Delivery uses `codex queue --remote unix://<socket> --thread <uuid> --message`.
  The bridge never launches or resumes an agent to discover it.
- Prefer the bridge's `send_message` tool for replies when both clients have it.
  Native Claude `SendMessage` replies to the bridge's `uds:` return address are
  also routed to the original sender. These return sockets exist only while the
  originating MCP process is running. A complete matching native message wrapper
  is removed before forwarding its body. Other content is preserved.
- The journal records bridge traffic only. It is not a shared transcript and
  does not contain native messages that bypass the bridge.

`queued` means Codex accepted its queue command. `submitted` means the Claude
socket accepted the write; the receiver may have delivered, held, or refused
the message, and the sender cannot tell. The bridge closes the socket after the
write completes because Claude Code sends no confirmation either way.
Neither means the agent read or executed the message. `unknown` means a send may
already have happened; do not automatically retry it with a new ID. A `sending`
record left by a crashed bridge is also uncertain. Failed and uncertain message
IDs are retained to prevent duplicate sends until their retention period expires.

Native protocol changes, closed sessions, inbound hold/refuse settings and client
permission prompts can prevent delivery. The bridge does not change those
settings. Idle Codex wake-up was verified for the client version listed above.

Each message starts with `From <name> (<provider>): <excerpt>`, using the
discovered sender name and provider (`claude` or `codex`). When no name is
available, the full session ID replaces the name and provider. The excerpt uses
the first non-empty line, capped at 120 characters. The header also
identifies the full sender ID and reply tool; the original body follows unchanged.
Claude uses the first line in its message and approval previews. With no
`crossSessionInbound` setting, a receiver in `bypassPermissions` holds every
bridge message for approval because bridge frames declare no permission class
([Claude inbound controls](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages)).
The receiving Claude also shows the sending process's verified PID. Sender IDs
and names in the envelope are claims; the verified PID is the stronger signal
of which process sent the message.

Closing a Codex window does not close its thread right away. The app-server
keeps a thread loaded until it has had no subscribers and no activity for 30
minutes ([app-server docs](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread)).
During that window the thread is still listed, and a message sent to it runs a
full turn with nobody watching. Both were verified live on Codex 0.165.0: the
turn counts as activity, and the thread unloaded 30 minutes after it ended. The bridge cannot tell
whether a window is attached: the protocol exposes no subscriber count. Discovery
uses `thread/read`, which does not load a thread or extend the window; a test
thread unloaded 30 minutes after creation despite repeated discovery. A loaded
thread's MCP server processes, including this bridge, appear to stay alive until
it unloads; separate threads were observed using separate bridge processes. Community reports describe a top-level
`thread_unload_delay_secs` in `~/.codex/config.toml` that shortens the window
after an app-server restart; OpenAI does not document it.

Codex delivery currently uses the supported `codex queue --message` CLI. Message
text appears in `/proc/<pid>/cmdline` while that command runs; other local users
can read it unless `/proc` access is restricted, for example with `hidepid`.
The alternative, `thread/queue/add` plus `thread/queue/start` over WebSocket RPC,
requires the experimental API. We retain the CLI's verified queue/wake-up behavior
for this version rather than depend on that experimental interface.

## CLI

```sh
node dist/cli.js list --read-only
node dist/cli.js send --to 'claude:<uuid>' --from 'codex:<uuid>' --text 'Hello' --message-id hello-001
node dist/cli.js inbox --to 'codex:<uuid>'
node dist/cli.js status --message-id hello-001
```

`send` is a one-shot command: its native reply socket closes when it exits.
Use the persistent MCP server for native return-address replies. A reply through
the receiving client's MCP tools still works after a one-shot sender exits.

## Configuration

| Environment variable | Default / purpose |
| --- | --- |
| `AGENT_BRIDGE_READ_ONLY=1` | Disables sends and native reply forwarding. CLI also accepts `--read-only`. |
| `AGENT_BRIDGE_STATE_DIR` | `$XDG_STATE_HOME/agent-bridge-mcp`, or `~/.local/state/agent-bridge-mcp`. Shared SQLite journal. |
| `AGENT_BRIDGE_RUNTIME_DIR` | `/tmp/agent-bridge-<uid>`. Short, private directory for reply sockets. |
| `AGENT_BRIDGE_SENDER_ID` | Optional full sender ID for CLI and non-Codex clients. Ignored for Codex MCP clients, which must pass `sender` per call. |
| `AGENT_BRIDGE_CODEX_SOCKET` | Optional exact app-server Unix socket. Otherwise searches `/tmp/codex-daemon-<uid>`. |
| `AGENT_BRIDGE_TIMEOUT_MS` | `5000`, integer between `100` and `30000`. |
| `AGENT_BRIDGE_RETENTION_DAYS` | `30`, integer between `0` and `3650`. `0` disables journal pruning. |
| `AGENT_BRIDGE_CODEX_COMMAND` | `codex`, override executable location if necessary. |
| `CLAUDE_CONFIG_DIR` | `~/.claude`, for session registrations. |
| `CODEX_HOME` | `~/.codex`, forwarded to the queue command. |
| `AGENT_BRIDGE_DEBUG=1` | Prints unsupported native frame field names to stderr; no frame text or tokens. |

The journal contains message text in a database owned by your OS user, with mode
0600. Records older than the retention period are pruned when a store opens and
at most once an hour on later send claims. This includes old `sending` and
`unknown` records; message-ID deduplication expires with those records.
Stop connected bridge processes before removing the state directory.
No HTTP listener is opened. Shutdown removes owned reply sockets. Starting a new
reply socket also removes owned `r-<pid>-*.sock` files only when the PID is absent
and a bounded connection probe fails with `ECONNREFUSED`. Live listeners remain
safe across PID namespaces. Successful connections, other errors, timeouts, live
PIDs, unrelated files, and unsafe paths are preserved. Old return addresses are
not reused.

Native Windows, other machines, cloud sessions, agent-team control messages,
permission approvals and arbitrary command execution are outside this version.
Messages are labelled as agent-originated text and cannot grant user consent.
The Codex queue API carries that label as text; it is not a separate trusted
agent-message role. Local access is restricted to the same OS account, not a
security boundary between agents running under that account.

## Live verification (requires the user's approval)

First run read-only discovery and choose exact IDs. After the user approves the
recipient and the following message, run:

```sh
node scripts/live-roundtrip.mjs --to 'claude:<uuid>' --from 'codex:<uuid>' --confirmed
```

The script sends exactly one message:

> Agent bridge connection test. Please reply exactly BRIDGE_OK using the agent-bridge MCP send_message tool to the sender session ID in the bridge header above. No project work is requested.

It keeps the MCP process alive for up to 45 seconds to receive the reply. It
never retries a send automatically. A recorded queued reply must also be checked
in the actual Codex session before claiming end-to-end receipt. Test idle and
busy delivery separately after that basic round trip succeeds.

## Sources

- [Claude cross-session messaging and inbox sockets](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)
- [Claude MCP integration](https://code.claude.com/docs/en/mcp)
- [Codex MCP integration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference)
- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [MCP TypeScript SDK v1](https://ts.sdk.modelcontextprotocol.io/server.html)
- Local CLI help, generated Codex protocol types, and guarded fixture traces.

## Batch 2 live preview check

The held-message preview showed `From github-aa claude: PREVIEW TEST: …`;
Claude's preview dropped the parentheses around the provider. The updated send
returned immediately after the write instead of waiting for the old five-second
receipt timeout.

## Doctor boundary

`agent-bridge-mcp doctor` never opens the journal, creates directories, sends
messages, resumes threads, or calls `thread/read`. Its Codex probe initializes
existing endpoints and pages through `thread/loaded/list`, excluding the updater.
It checks registration through supported CLI help/get commands, never by reading
`~/.claude.json`. A command that only offers a health-checking registration query
is reported as SKIPPED without affecting the exit code, because that query could launch the registered server.
The external clients may perform their own startup bookkeeping; doctor itself
performs no filesystem writes.

Doctor prefers the Codex version from the app-server initialize response. If it
is absent, doctor falls back to `codex --version` and notes that the Codex CLI may
update its PATH alias. CLI registration queries may also run native-client startup
bookkeeping. Every external command uses execFile with a timeout, without a shell.

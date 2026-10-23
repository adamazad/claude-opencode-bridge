# Claude–OpenCode bridge

Control OpenCode sessions from Claude Code. The plugin provides MCP tools and sends terminal results through a Claude channel.
Sessions remain external workers. The plugin does not register native Claude subagents or modify Claude mailbox files.

OpenCode **v2 is the minimum version**. The bridge targets v2 and later versions that retain the required API schemas.
Tested with **OpenCode 2.0.32**, **Claude Code 2.1.309**, and **Bun 1.4.4** on macOS ARM64.
Future OpenCode releases are not verified. Each response passes a schema check, with an actionable error for incompatible responses.
The v1 `prompt_async` API is not supported.

## Install from the public marketplace

Requires Claude Code 2.1.309 or later, Bun 1.4.4 or later on PATH, and OpenCode v2.
Supported launch environment: macOS or Linux with a POSIX shell.

```sh
claude plugin marketplace add adamazad/claude-opencode-bridge
claude plugin install opencode-bridge@claude-opencode-bridge
```

Claude Code installs the pinned Bun dependencies into its plugin cache automatically.
No source checkout or npm package installation is needed.
See [Claude's dependency installation rules](https://code.claude.com/docs/en/plugins/loading#nodejs-package-dependencies).

If OpenCode v2 is already running, the bridge reuses its registered local service and authentication automatically.
No port or password needs to be copied. If no service is running, start it once:

```sh
opencode service start
```

Launch Claude from your project directory:

```sh
claude --dangerously-load-development-channels plugin:opencode-bridge@claude-opencode-bridge
```

Accept the development channel dialog and use `/opencode-bridge:delegate <task>`.
The command binds the bridge to the current Claude session ID. No owner environment variable is required for a new conversation.
Resume that conversation normally with `--resume YOUR_CLAUDE_SESSION_ID`; the command reuses its stable owner.

The MCP server connects even before ownership is configured. Worker tools remain unavailable until `opencode_configure` binds it explicitly.
This avoids silently creating an owner or exposing another conversation's workers.
A normal `claude` launch also connects the tools, but channel delivery still requires the flag above.

If you already have workers created with an explicit `BRIDGE_OWNER`, keep that saved value when resuming:

```sh
BRIDGE_OWNER=your-saved-owner claude --resume YOUR_CLAUDE_SESSION_ID --dangerously-load-development-channels plugin:opencode-bridge@claude-opencode-bridge
```

Two active bridge processes cannot use the same owner in one database.
The bridge cannot independently prove that a resumed conversation matches an owner supplied through the environment.
It uses your existing OpenCode provider configuration and does not start or stop the OpenCode server.

Channels require interactive Claude Code and Anthropic authentication through claude.ai or a Console API key.
Organization policy can block channels. The development flag does not override that policy.
Claude ignores the development channel flag in print mode (`-p`) and the Agent SDK.
Without channel access, the control tools and `opencode_inspect` remain useful.
See the [channel reference](https://code.claude.com/docs/en/channels-reference).

### Source development

Clone this repository, run `bun install --frozen-lockfile`, then launch `scripts/claude.sh` from your project directory.
The source launcher generates an owner and loads `plugin:opencode-bridge@inline` through `--plugin-dir`.
Set a saved `BRIDGE_OWNER` and pass `--resume YOUR_CLAUDE_SESSION_ID` to resume.

## Use

Run the explicit background command in Claude:

```text
/opencode-bridge:delegate Inspect this project and report findings. Do not change files.
```

The command selects this plugin's `opencode_start`, launches the returned read-only watcher through background Bash, reports the task ID, and ends the Claude turn.
Completion arrives later through the channel. You can continue chatting while OpenCode works.

### Visible worker tracking

After dispatch, the delegation command starts a **background shell monitor**. Claude shows its running-shell indicator and a `/tasks` entry with the worker label. Normal Bash permissions apply; a shell approval may be required. The monitor performs no model calls and prints only state changes.

- `/tasks`: inspect or stop the monitor. Stopping it does **not** cancel OpenCode work; use `opencode_stop` to cancel the worker.
- `/opencode-bridge:status`: an on-demand table with owned workers, actual last-reported model, configured model, durable state, recent activity, and attention needed.
- Completion: the existing channel delivers the result. The monitor exits and its shell completion is only tracking status, not a second result to process.

This is a real Claude background shell task, not a native Claude subagent. It leaves your existing status line unchanged. Claude cleans up monitors when it exits; OpenCode can continue. Monitors stop after 24 hours. If background Bash is disabled or denied, channel delivery still works, but there is no persistent task indicator. Older workers without a monitor remain available through the status command.

The monitor reads only this bridge's database for the exact owner, endpoint, session, and run. It does not poll OpenCode, acknowledge events, or change worker state. If the bridge disconnects, it reports an unknown outcome rather than claiming the worker is still running.

Claude documents [background Bash tracking](https://code.claude.com/docs/en/interactive-mode#background-bash-commands). Its [automatic MCP backgrounding](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls) waits two minutes by default; this plugin keeps dispatch short instead. A [custom Claude supervisor subagent](https://code.claude.com/docs/en/sub-agents) would add separate model calls. A [status-line script](https://code.claude.com/docs/en/statusline) would need composition with your existing script. The shell monitor avoids both changes.

If another OpenCode integration is installed, check the tool name. This plugin exposes `opencode_start` and `opencode_send`.
`mcp__opencode__delegate_task` belongs to the separate `claude-opencode-mcp` package and waits for the worker to finish.
It does not provide this plugin's background dispatch behavior.

Claude still takes a normal turn to interpret your request and dispatch it. This plugin cannot force Claude's UI to accept a new turn while Claude is still generating.
Use the command above to avoid a completion-waiting tool loop.

| Tool                 | Purpose                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `opencode_status`    | Show owned worker titles, models, state, recent activity and attention needed. |
| `opencode_configure` | Check setup or explicitly bind to a stable conversation owner.                 |
| `opencode_start`     | Create a session, with an optional initial prompt, agent, and model.           |
| `opencode_attach`    | Claim an existing session. Existing history is available through inspection.   |
| `opencode_send`      | Assign a task or follow-up to an owned session.                                |
| `opencode_inspect`   | Read sessions, messages, pending forms, approvals, and unacknowledged events.  |
| `opencode_stop`      | Interrupt execution without deleting the session.                              |
| `opencode_ack`       | Acknowledge a notification after Claude processes it.                          |

A model selection uses `{ "providerID": "opencode", "id": "deepseek-v4.1-flash-free" }`.
Model availability can change. Select a model available through your OpenCode provider.

Only one task can be outstanding per session. Different sessions can run concurrently in OpenCode.
A completed task permits a follow-up with the same session ID.
Permission requests and forms produce `input_required` events. The human must answer them in OpenCode.
The bridge has no permission-approval tool and never changes permission rules.

## Configuration

| Environment variable       | Default / purpose                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_URL`             | Optional explicit endpoint. Otherwise discover the registered v2 service. Only loopback HTTP origins are accepted.          |
| `OPENCODE_SERVER_PASSWORD` | Optional credential override. Otherwise use the discovered service credential. Explicit URLs require their own credentials. |
| `OPENCODE_SERVER_USERNAME` | `opencode`.                                                                                                                 |
| `BRIDGE_OWNER`             | Optional saved owner override. Otherwise the delegation command binds to the current Claude session ID.                     |
| `BRIDGE_DB`                | `~/.local/state/claude-opencode-bridge/bridge.sqlite`. Use the same database across conversations for ownership checks.     |

Automatic connection uses OpenCode's local `service.json` registration under `${XDG_STATE_HOME:-~/.local/state}/opencode/`, the same source used by its [official service client](https://opencode.ai/v2/docs/build/client#local-background-service).
The bridge validates the loopback destination before sending credentials, then verifies the service PID and version against `/api/info`.
It never starts, replaces, or stops a server automatically. Credentials are not returned in tool results or saved in the bridge database.
An explicit `OPENCODE_URL` bypasses discovery and never inherits credentials from a different service.
If setup fails, check `opencode service status` and clear stale environment overrides, then retry the delegation command.
After a service restart that changes its port, reconnect the plugin. Previously claimed sessions stay scoped to their original endpoint; ownership is never silently transferred.

The database contains task IDs, session ownership, and notification bodies. It uses mode 0600 and a private parent directory.
Ownership is scoped to the server origin and session ID. Separate databases cannot enforce ownership against each other.
A session claimed by another owner cannot be attached. There is no automatic ownership transfer.

## Delivery and recovery

The bridge subscribes to `/api/event` and also checks durable records every two seconds.
After a connection closes, it reconnects with bounded backoff and checks those records again.
SSE events are only wake-up signals. They are not the source of truth for completion.

Each prompt has a durable message ID recorded before submission. Completion requires that correlated user message and a later explicit terminal outcome.
An idle event without an outcome never means success. Input from another client during a task produces an interference notice.
The final result contains the last assistant text and any terminal error. Full history remains available through inspection.

Notifications remain pending until Claude calls `opencode_ack`. Unacknowledged notifications repeat after 60 seconds, including after restart.
A transport write does not prove that Claude processed an event. This is retry-until-ack delivery, not exactly-once delivery.
Claude must use notification IDs to avoid repeating actions. Channel bodies are limited to 24,000 characters, with full content available through inspection.

If prompt submission times out, the bridge marks acceptance as uncertain and does not resend automatically.
Inspect OpenCode before further action. An uncertain task remains blocked until its correlated terminal result arrives.
This initial version has no force-clear command for a prompt that never reached OpenCode. A new session can continue the work after human inspection.

The bridge must remain open to send channel events. OpenCode can continue while Claude is closed.
On resume with the same owner, the bridge recovers completed tasks from OpenCode history.
The database retains acknowledged notices for deduplication. This initial version has no automatic retention cleanup.
History reads stop at 10,000 messages with an explicit error instead of an incomplete result.

## Checks

```sh
bun run format:check
bun test
bun run typecheck
claude plugin validate .
```

Run `bun run format` to format the project with Bun’s native formatter.
Prettier is not required. The existing TypeScript check remains available through `bun run typecheck`.
Native `bun lint` is canary-only and unavailable in stable Bun 1.4.4. This project has no separate lint tool.
See the official [formatter](https://bun.com/docs/format) and [linter](https://bun.com/docs/lint) documentation.

For an opt-in live round trip, export the OpenCode connection variables, then run:

```sh
bun scripts/live-smoke.ts
```

This script creates one session and sends two short prompts to a real model. Provider usage can incur charges.
It checks channel notifications through an MCP client. It does not by itself prove delivery into Claude.

## API references

- [OpenCode v2 API](https://opencode.ai/v2/docs/api) and [OpenAPI schema](https://opencode.ai/v2/openapi.json).
- [Claude channel contract](https://code.claude.com/docs/en/channels-reference).
- [Claude plugin manifest](https://code.claude.com/docs/en/plugins-reference).
- [Bun installation](https://bun.sh/docs/installation).

## Code structure

`src/api.ts` validates HTTP responses with reusable Zod schemas and infers their TypeScript types.
`src/tools.ts` keeps each MCP tool’s schema and handler together.
`src/bridge.ts` coordinates tasks. `src/store.ts` owns durable state and notification transactions.
`src/server.ts` connects MCP, schedules reconciliation, and handles shutdown.

Run `bun run benchmark` for a local benchmark without model calls.

## Distribution

The public [GitHub marketplace](https://github.com/adamazad/claude-opencode-bridge) is the installation catalog.
[Versioned releases](https://github.com/adamazad/claude-opencode-bridge/releases) also provide a source plugin ZIP.
For ZIP installation, extract it, run `bun install --frozen-lockfile` in the extracted directory, and use `scripts/claude.sh`.
Marketplace installation handles dependencies automatically and is the recommended method.
The repository is not published to npm. No license has been selected.

This marketplace is independently hosted. It is not an accepted listing in Anthropic's official directory or a channel allowlist approval.
Custom channels still require the development flag unless an applicable allowlist authorizes them.
Team and Enterprise administrators can configure `allowedChannelPlugins`.
See [publishing options](https://code.claude.com/docs/en/plugins/publish) and [channel packaging](https://code.claude.com/docs/en/channels-reference#package-as-a-plugin).

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

Start OpenCode in a separate terminal:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

Set `OPENCODE_SERVER_PASSWORD` to the password shown by OpenCode, then launch Claude from your project directory:

```sh
export BRIDGE_OWNER="$(bun -e 'console.log(crypto.randomUUID())')"
printf 'Save this owner to resume: %s\n' "$BRIDGE_OWNER"
claude --dangerously-load-development-channels plugin:opencode-bridge@claude-opencode-bridge
```

Accept the development channel dialog. Save `BRIDGE_OWNER` with the Claude conversation ID.
For a new conversation, generate a new owner. To resume the same conversation:

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

Ask Claude:

> Use opencode_start to create a worker in /absolute/path/to/project. Ask it to inspect the project and report its findings.
> When its channel result arrives, acknowledge it and send a follow-up through the same session.

| Tool               | Purpose                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `opencode_start`   | Create a session, with an optional initial prompt, agent, and model.          |
| `opencode_attach`  | Claim an existing session. Existing history is available through inspection.  |
| `opencode_send`    | Assign a task or follow-up to an owned session.                               |
| `opencode_inspect` | Read sessions, messages, pending forms, approvals, and unacknowledged events. |
| `opencode_stop`    | Interrupt execution without deleting the session.                             |
| `opencode_ack`     | Acknowledge a notification after Claude processes it.                         |

A model selection uses `{ "providerID": "opencode", "id": "deepseek-v4.1-flash-free" }`.
Model availability can change. Select a model available through your OpenCode provider.

Only one task can be outstanding per session. Different sessions can run concurrently in OpenCode.
A completed task permits a follow-up with the same session ID.
Permission requests and forms produce `input_required` events. The human must answer them in OpenCode.
The bridge has no permission-approval tool and never changes permission rules.

## Configuration

| Environment variable       | Default / purpose                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_URL`             | `http://127.0.0.1:4096`. Only loopback HTTP origins are accepted.                                                       |
| `OPENCODE_SERVER_PASSWORD` | Password for the selected server. No password is stored in SQLite.                                                      |
| `OPENCODE_SERVER_USERNAME` | `opencode`.                                                                                                             |
| `BRIDGE_OWNER`             | Required. Generate it before launch. Use 8–128 letters, digits, underscores, or hyphens.                                |
| `BRIDGE_DB`                | `~/.local/state/claude-opencode-bridge/bridge.sqlite`. Use the same database across conversations for ownership checks. |

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

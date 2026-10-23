# Claude–OpenCode bridge

Control OpenCode sessions from Claude Code. The plugin provides MCP tools and sends terminal results through a Claude channel.
Sessions remain external workers. The plugin does not register native Claude subagents or modify Claude mailbox files.

OpenCode **v2 is the minimum version**. The bridge targets v2 and later versions that retain the required API schemas.
Live checks used **OpenCode 2.0.32**, **Claude Code 2.1.309**, and **Bun 1.4.4** on macOS ARM64.
Future OpenCode releases are not verified. Each response passes a schema check, with an actionable error for incompatible responses.
The v1 `prompt_async` API is not supported.

## Setup

1. Install Bun 1.4.4 or later from [Bun](https://bun.sh/docs/installation).
2. Run `bun install --frozen-lockfile` in this directory.
3. Start a local OpenCode server: `opencode serve --hostname 127.0.0.1 --port 4096`.
4. In another terminal, export `OPENCODE_SERVER_PASSWORD` with the password shown by that server.
5. Run `/absolute/path/to/claude-opencode-bridge/scripts/claude.sh` from your working directory.
6. Accept the local development channel dialog in Claude Code.

The launcher uses `bun` from PATH. Bun 1.4.4 or later is required.
Dependencies and the lockfile belong to this directory.
The plugin uses your existing OpenCode provider configuration. It does not start or stop the OpenCode server.

The launcher loads the local plugin through `--plugin-dir` and enables `plugin:opencode-bridge@inline` as a development channel.
It prints a unique `BRIDGE_OWNER` for the conversation. Save that value with the Claude conversation ID.

To resume the same conversation, set its saved owner before launch:

```sh
BRIDGE_OWNER=your-saved-owner /absolute/path/to/claude-opencode-bridge/scripts/claude.sh --resume YOUR_CLAUDE_SESSION_ID
```

Use a new owner for every new Claude conversation. Do not reuse an owner across different conversations.
The bridge cannot independently prove that a resumed Claude conversation matches an owner supplied through the environment.
Two active bridge processes cannot use the same owner in one database.

Channels require interactive Claude Code and Anthropic authentication through claude.ai or a Console API key.
Organization policy can block channels. The development flag does not override that policy.
Claude ignores the development channel flag in print mode (`-p`) and the Agent SDK.
Without channel access, the control tools and `opencode_inspect` remain useful.
See the [channel reference](https://code.claude.com/docs/en/channels-reference) for these restrictions.

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
That model completed the live checks. Model availability can change.
The installed default model returned a deprecation error during the first check. No global model configuration changed.

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
| `BRIDGE_OWNER`             | Required. The launcher generates it. Use 8–128 letters, digits, underscores, or hyphens.                                |
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

The final automated suite has 30 passing tests. Real Claude delivery passed in idle and active turns.
See [validation results](docs/validation.md) for exact versions, timestamps, and coverage limits.

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
See [performance results](docs/performance.md) for the measurements and their limits.

## Distribution plan

The source checkout is ready for private GitHub sharing with the setup steps above.
The recommended next step is a small [Git-hosted Claude plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) and a versioned release.
An npm package is not needed for this plugin.

Before marketplace installation is ready:

1. Add `.claude-plugin/marketplace.json` with an entry for `opencode-bridge`.
2. Prepare dependency installation in the plugin cache, or distribute a Bun bundle with its dependencies.
   The current source launcher expects `bun install --frozen-lockfile` in the checkout. It does not bootstrap a marketplace installation.
3. Provide an installed-plugin launch command that sets a unique `BRIDGE_OWNER` and preserves it on resume.
   The current launcher uses `--plugin-dir` for a source checkout.
4. Test installation from a versioned commit on a clean machine. The current shell launchers require a POSIX shell.
5. Choose a license and public/private audience before broader distribution. No license is selected in this repository.

A private marketplace can serve collaborators who have repository access. Public discovery can later use Anthropic’s plugin directory.
Local manifest validation passes, but directory submission currently lacks license metadata. Author and icon metadata also need attention.

Marketplace publication does not approve a channel. Users still need the development-channel flag unless an applicable allowlist authorizes the plugin.
Team and Enterprise admins can configure `allowedChannelPlugins`. Official-marketplace coordination uses an Anthropic partner contact.
See the [channel packaging restrictions](https://code.claude.com/docs/en/channels-reference#package-as-a-plugin).

No marketplace, release, npm publication, or public-visibility change is included in the initial private repository push.

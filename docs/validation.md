# Validation results

Date: 23 October 2026 (Europe/Lisbon).

## Versions and commands

| Component          | Version                   |
| ------------------ | ------------------------- |
| System Bun runtime | 1.4.4, revision 38afee6c8 |
| OpenCode           | 2.0.32                    |
| Claude Code        | 2.1.309                   |
| Platform           | macOS ARM64               |

Bun 1.4.4 matched the latest stable release from the official GitHub release endpoint on this date.

- `bun test`: **30 passed, 0 failed, 75 assertions**, across three files.
- `bun run typecheck`: passed.
- `claude plugin validate .`: passed, with optional author and catalog warnings. No remote submission was attempted.

## Real OpenCode and MCP transport

The live smoke script created a test session on a dedicated local OpenCode server.
The model was `opencode/deepseek-v4.1-flash-free`.

1. The first task returned `BRIDGE_ROUND_TRIP_OK` through `notifications/claude/channel`.
2. The client acknowledged the notification.
3. A follow-up in the same session returned `BRIDGE_FOLLOWUP_OK` through the channel.
4. The client acknowledged the second notification.

This check used the real model, OpenCode API, bridge process, SQLite database, and MCP stdio transport.
The receiving client was a test client, not Claude.

The first separate API probe used the installed default model and returned a real deprecation failure.
OpenCode named `deepseek-v4.1-flash-free` as the replacement. The checks selected it per session without changing global configuration.

## Real interactive Claude delivery

The check used one isolated Claude conversation and one OpenCode session.
Local conversation, session, and owner identifiers are omitted from this report.

The plugin loaded with `--plugin-dir` and `--dangerously-load-development-channels plugin:opencode-bridge@inline`.
Claude registered the channel and used the plugin tools.

Times below use UTC to match the logs.

| Time         | Evidence                                                            |
| ------------ | ------------------------------------------------------------------- |
| 10:37:06.127 | Claude called `opencode_start` with the first prompt.               |
| 10:37:12.542 | Claude ended its turn with `WAITING`.                               |
| 10:37:14.250 | Claude received `CLAUDE_IDLE_DELIVERY_OK` through the channel.      |
| 10:37:17.602 | Claude called `opencode_ack`.                                       |
| 10:38:30.917 | Claude called `opencode_send` for the same session.                 |
| 10:38:33.356 | The follow-up channel result arrived during the active Claude turn. |
| 10:38:33.501 | Claude called Bash with `sleep 15`.                                 |
| 10:39:00.737 | Claude acknowledged `CLAUDE_BUSY_DELIVERY_OK`.                      |

The busy result arrived just before the Bash call, while the Claude turn was active.
This proves busy-turn delivery, but not arrival during the sleep itself.
Claude did not call the inspect tool or poll for either result.
The bridge database records `ack=1` for both notifications.

The test Claude process and dedicated OpenCode server were stopped after the checks.
Temporary logs, API snapshots, and bridge test databases were removed before repository publication.
No OpenCode sessions were deleted.

## Automated coverage and limits

The tests cover session ownership, task correlation, follow-ups, explicit failure/interruption, approval/form notices, acknowledgments, duplicate suppression, and external-input interference.
They also cover uncertain submissions, restart recovery, history pagination, fragmented SSE frames, version/schema errors, and concurrent submission control.
A subprocess test checks MCP tool discovery, channel capabilities, SSE reconnection, result delivery, acknowledgment, and follow-up routing.

Permission prompts, forms, restart recovery, and interruption semantics have automated fixture coverage.
They were not exercised end-to-end with a real model waiting for human input.
Later OpenCode versions remain untested. A synthetic 3.0.0 response checks version admission only, not future compatibility.

The interactive checks preceded final response-schema checks and event-rate limiting.
The complete automated suite passed after those final changes.

The plugin validator can report missing license, author, and icon metadata for marketplace submission.
This deliverable is a private local plugin. No distribution license was selected on the user's behalf.

## System Bun follow-up

The user upgraded system Bun to 1.4.4. The launcher now uses `bun` through PATH.
The project-local runtime directory was removed at the user’s request. No other runtime installations changed.
The tests and typecheck were repeated with system Bun after this cleanup.

## Native formatter migration

System Bun 1.4.4 supports native `bun fmt`. Its `--doctor` report confirmed native support for all 13 project files.
Prettier was removed from the dependencies and lockfile. No Prettier configuration or separate lint tool existed.
The package scripts now provide `bun run format` and `bun run format:check`.

The official [formatter documentation](https://bun.com/docs/format) describes the built-in formatter.
The official [linter documentation](https://bun.com/docs/lint) limits `bun lint` to canary builds.
The installed stable CLI returned `error: Script not found "lint"` for `bun lint --help`.
No canary upgrade or replacement lint package was installed. The existing TypeScript check remains unchanged.

After migration, native formatting, the formatting check, all 20 tests, and the TypeScript check passed.

## Schema and DRY cleanup

The latest suite passed 30 tests with 75 assertions across three files. TypeScript and native Bun formatting checks also passed.

- Reusable Zod schemas now define API response types. `request` returns parsed data with an inferred type.
- Explicit schemas at call sites replace route-based schema selection. Inspection retains additional OpenCode fields through `z.looseObject`.
- One typed tool registry replaces separate schema declarations and a dispatch switch.
- Permission and form retrieval share one method. State changes and notifications share one atomic transaction path.
- Session lookup uses a keyed query instead of loading every owned session. Scoped SQL queries retain ownership checks.
- A single exit callback handles cleanup. Validation clients share MCP connection and response parsing code.

New regression coverage includes parsed output, retained message fields, malformed responses, pagination cycles, transaction rollback, and assistant errors.
The subprocess test also checks invalid tool calls and durable resume after stdio closure.

Explicit HTTP operation schemas and SQL ownership predicates remain separate at their boundaries. They protect distinct operations and are intentional.
Polling and SSE also remain separate because polling recovers events lost during disconnection or throttling.

No new live model calls were needed for this cleanup. Earlier live checks remain historical evidence.
Native lint remains unavailable in stable Bun 1.4.4, as documented in the formatter migration section.

A bounded local benchmark measured control and delivery latency without model calls. See [performance results](performance.md).

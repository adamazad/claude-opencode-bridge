---
name: status
description: Show owned OpenCode workers, models, durable state and recent activity without polling or ad hoc shell commands.
---

Call this plugin's opencode_configure with no arguments. If setup is required, use the saved BRIDGE_OWNER for existing work; otherwise bind owner to claude-${CLAUDE_SESSION_ID}. Never guess a previous owner or transfer workers. If an existing claude- owner differs from the current session ID, ask the user to reconnect instead of accessing that owner's workers.

Call opencode_status once. Show a concise table: worker title/session ID, state, actual last-reported model, configured model if actual is unknown, last activity, and attention needed. An unavailable model is unknown, not the main Claude model. Label status_error rows as stale/unknown. Do not inspect other owners, run ad hoc shell commands, poll repeatedly, or wait for completion.

Remind the user that /tasks shows background monitors created by the delegate command. Stopping a monitor only stops observation; opencode_stop cancels the worker. This status command is an on-demand snapshot.

# Bridge performance

Measured 23 October 2026, 11:53 Europe/Lisbon, with Bun 1.4.4 on an Apple M1 Pro (macOS ARM64).

This benchmark uses the real bridge subprocess, MCP stdio transport, HTTP/SSE client, and SQLite database.
OpenCode is a local fixture. No model or Claude inference is involved.
It measures one owned session with a short message history.

| Measurement                              | Samples |      Median |         p95 |
| ---------------------------------------- | ------: | ----------: | ----------: |
| Task submission round trip               |      28 |     1.61 ms |     4.37 ms |
| Completion to notification, paced SSE    |      12 |     1.42 ms | 1,938.03 ms |
| Completion to notification, burst SSE    |       8 | 1,999.33 ms | 2,002.78 ms |
| Completion to notification, polling only |       8 | 1,998.27 ms | 2,000.41 ms |

One subprocess connection and MCP initialization took 148.45 ms. This is one observation, not a cold-system startup distribution.
Raw samples are in [performance.json](performance.json). Percentiles use the nearest-rank method.
With these small samples, p95 is close to the maximum. These numbers are observations, not service guarantees.

## Method

Run `bun run benchmark` from the project directory. It requires no credentials and makes no model calls.
The script prints raw results as JSON to stdout and per-profile summaries to stderr.
Its temporary database and subprocess are removed when the benchmark finishes.

Each control measurement covers an `opencode_send` MCP call through its response.
It includes local HTTP admission and durable task-state writes.
After that response, the fixture creates the assistant result and explicit terminal message.
Delivery timing starts at that synthetic completion and ends when the MCP client receives the channel notification.
The client acknowledges each notification before the next task.

The paced SSE profile waits 600 ms between samples and emits a completion event.
The burst SSE profile sends the next task immediately after acknowledgment, then emits a completion event.
The polling profile writes the same completion records without a completion event. The SSE connection stays open.

## What controls latency

The server polls every two seconds. SSE events can trigger an earlier reconciliation.
The scheduler ignores triggers while a reconciliation is queued or within 500 ms of the preceding trigger.
It does not schedule a delayed retry for an ignored trigger. A later event or the next poll discovers the result.
This explains the roughly two-second tail even with SSE enabled.

Reconciliation and tool calls share a serial queue. Different OpenCode sessions can execute concurrently outside that queue.
Permission and form requests run concurrently within one reconciliation. Owned sessions are reconciled sequentially.
A slow server, large history, many sessions, or an occupied queue can make delivery exceed two seconds.
HTTP requests have a 15-second timeout. The polling interval is not an end-to-end latency bound.

SSE reconnection uses a backoff from 500 ms to 10 seconds. Polling continues during disconnection.
Unacknowledged notifications become eligible for retry after 60 seconds. Retry delivery also waits for reconciliation and queue availability.

Model execution time and Claude’s response time are additional costs. Earlier live round trips proved delivery but were not performance benchmarks.
The cleanup did not change the scheduling policy or make speculative performance optimizations.

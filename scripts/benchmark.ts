// Local-only benchmark: real bridge/MCP/SQLite, synthetic OpenCode, no model calls.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, platform, arch, cpus } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openBridgeClient, callTool, type ChannelNotice } from "./lib/mcp";
import type { Message } from "../src/api";

const messages: Message[] = [];
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
let lastRun = "";
let onNotice: ((notice: ChannelNotice) => void) | undefined;
const mock = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0, // Keep the mock SSE stream open during the poll-only profile.
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/api/info") return Response.json({ version: "2.0.32" });
    if (path === "/api/event")
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"connected"}\n\n'),
            );
          },
          cancel() {
            stream = undefined;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    if (path === "/api/session")
      return Response.json({
        data: { id: "ses_benchmark", location: { directory: process.cwd() } },
      });
    if (path.endsWith("/permission") || path.endsWith("/form"))
      return Response.json({ data: [] });
    if (path.endsWith("/message"))
      return Response.json({
        data: [...messages].reverse(),
        cursor: { next: null },
      });
    if (path.endsWith("/prompt")) {
      const body = z
        .object({ id: z.string(), text: z.string() })
        .parse(await req.json());
      lastRun = body.id;
      messages.push({ id: body.id, type: "user", text: body.text });
      return Response.json({ data: { id: body.id } });
    }
    return new Response("unknown route", { status: 404 });
  },
});
const directory = mkdtempSync(join(tmpdir(), "bridge-benchmark-"));
const samples: { profile: string; control_ms: number; delivery_ms: number }[] =
  [];
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    Number(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!.toFixed(2));
  return {
    n: sorted.length,
    median_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: percentile(1),
  };
};
let client: Awaited<ReturnType<typeof openBridgeClient>> | undefined;
const start = performance.now();
try {
  client = await openBridgeClient(
    {
      OPENCODE_URL: mock.url.origin,
      BRIDGE_OWNER: "local-benchmark",
      BRIDGE_DB: join(directory, "bridge.sqlite"),
    },
    (notice) => onNotice?.(notice),
  );
  const startup_ms = performance.now() - start;
  await callTool(
    client,
    "opencode_start",
    { directory: process.cwd() },
    z.unknown(),
  );
  // Pacing is deliberate: report ordinary SSE, throttled bursts, and polling separately.
  for (const [profile, count, pause, emit] of [
    ["sse_paced", 12, 600, true],
    ["sse_burst", 8, 0, true],
    ["poll_only", 8, 0, false],
  ] as const) {
    for (let i = 0; i < count; i++) {
      if (pause) await Bun.sleep(pause);
      const before = performance.now();
      await callTool(
        client,
        "opencode_send",
        { session_id: "ses_benchmark", text: "synthetic task" },
        z.object({ run_id: z.string() }),
      );
      const control_ms = performance.now() - before;
      // Completion is injected only after the control request returns, excluding model time.
      const completed = performance.now();
      let timeout: ReturnType<typeof setTimeout>;
      const received = new Promise<ChannelNotice>((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("No channel result within 10 seconds")),
          10000,
        );
        onNotice = (notice) => {
          clearTimeout(timeout);
          resolve(notice);
        };
      });
      messages.push(
        {
          id: `${lastRun}_answer`,
          type: "assistant",
          content: [{ type: "text", text: "done" }],
        },
        { id: `${lastRun}_idle`, type: "idle", outcome: "succeeded" },
      );
      if (emit) {
        if (!stream) throw new Error("SSE did not connect");
        stream.enqueue(
          new TextEncoder().encode('data: {"type":"session.updated"}\n\n'),
        );
      }
      const notice = await received;
      samples.push({
        profile,
        control_ms,
        delivery_ms: performance.now() - completed,
      });
      if (notice.meta.kind !== "succeeded") throw new Error(notice.content);
      await callTool(
        client,
        "opencode_ack",
        { notification_id: notice.meta.notification_id },
        z.object({ acknowledged: z.literal(true) }),
      );
      onNotice = undefined;
    }
    console.error(
      profile,
      stats(
        samples.filter((s) => s.profile === profile).map((s) => s.delivery_ms),
      ),
    );
  }
  console.log(
    JSON.stringify(
      {
        measured_at: new Date().toISOString(),
        environment: {
          bun: Bun.version,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
        },
        mode: "mock OpenCode; real subprocess, stdio MCP, SQLite and HTTP/SSE; no model or Claude inference",
        startup_single_sample_ms: Number(startup_ms.toFixed(2)),
        control: stats(samples.map((s) => s.control_ms)),
        delivery: Object.fromEntries(
          [...new Set(samples.map((s) => s.profile))].map((profile) => [
            profile,
            stats(
              samples
                .filter((s) => s.profile === profile)
                .map((s) => s.delivery_ms),
            ),
          ]),
        ),
        samples,
      },
      null,
      2,
    ),
  );
} finally {
  await client?.close();
  mock.stop(true);
  rmSync(directory, { recursive: true, force: true });
}

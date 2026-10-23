import { test, expect } from "bun:test";
import { z } from "zod";
import {
  openBridgeClient,
  callTool,
  type ChannelNotice,
} from "../scripts/lib/mcp";
import type { Message } from "../src/api";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("stdio MCP recovers from closed SSE, routes terminal result, acknowledges, and follows up", async () => {
  const messages: Message[] = [];
  let streams = 0;
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/api/event") {
        streams++;
        return new Response('data: {"type":"connected"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (p === "/api/info") return Response.json({ version: "2.0.32" });
      if (p === "/api/session")
        return Response.json({
          data: { id: "ses_mcp", location: { directory: process.cwd() } },
        });
      if (p.endsWith("/permission") || p.endsWith("/form"))
        return Response.json({ data: [] });
      if (p.endsWith("/message"))
        return Response.json({
          data: [...messages].reverse(),
          cursor: { next: null },
        });
      if (p.endsWith("/prompt")) {
        const body = await req.json();
        messages.push(
          { id: body.id, type: "user" },
          {
            id: `${body.id}_answer`,
            type: "assistant",
            content: [{ type: "text", text: body.text }],
          },
          { id: `${body.id}_idle`, type: "idle", outcome: "succeeded" },
        );
        return Response.json({ data: { id: body.id } });
      }
      return new Response("missing", { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "bridge-mcp-"));
  const notifications: ChannelNotice[] = [];
  let client: Awaited<ReturnType<typeof openBridgeClient>> | undefined;
  const wait = async (count: number) => {
    const end = Date.now() + 8000;
    while (notifications.length < count && Date.now() < end)
      await Bun.sleep(50);
    expect(notifications).toHaveLength(count);
  };
  try {
    client = await openBridgeClient(
      {
        OPENCODE_URL: mock.url.origin,
        BRIDGE_DB: join(dir, "bridge.sqlite"),
        BRIDGE_OWNER: "test-mcp-owner",
      },
      (notice) => notifications.push(notice),
    );
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(
      "claude/channel",
    );
    expect((await client.listTools()).tools).toHaveLength(6);
    await expect(
      callTool(client, "constructor", {}, z.unknown()),
    ).rejects.toThrow("Unknown tool");
    await expect(
      callTool(
        client,
        "opencode_send",
        { session_id: "ses_mcp", text: "" },
        z.unknown(),
      ),
    ).rejects.toThrow();
    expect(messages).toHaveLength(0);
    const r = await callTool(
      client,
      "opencode_start",
      { directory: process.cwd(), prompt: "FIRST" },
      z.object({ session_id: z.string() }),
    );
    await wait(1);
    expect(notifications[0]!.content).toContain("FIRST");
    expect(notifications[0]!.meta.session_id).toBe(r.session_id);
    const acknowledged = z.object({ acknowledged: z.literal(true) });
    await callTool(
      client,
      "opencode_ack",
      { notification_id: notifications[0]!.meta.notification_id },
      acknowledged,
    );
    await callTool(
      client,
      "opencode_send",
      { session_id: r.session_id, text: "SECOND" },
      z.unknown(),
    );
    await wait(2);
    expect(notifications[1]!.content).toContain("SECOND");
    expect(streams).toBeGreaterThan(1);
    await callTool(
      client,
      "opencode_ack",
      { notification_id: notifications[1]!.meta.notification_id },
      acknowledged,
    );
    const inspected = await callTool(
      client,
      "opencode_inspect",
      {},
      z.object({ pending: z.array(z.unknown()) }),
    );
    expect(inspected.pending).toEqual([]);
    // Closing stdio must release the owner lock, allowing durable resume.
    await client.close();
    client = await openBridgeClient(
      {
        OPENCODE_URL: mock.url.origin,
        BRIDGE_DB: join(dir, "bridge.sqlite"),
        BRIDGE_OWNER: "test-mcp-owner",
      },
      (notice) => notifications.push(notice),
    );
    const resumed = await callTool(
      client,
      "opencode_inspect",
      {},
      z.object({
        sessions: z.array(z.object({ id: z.string(), state: z.string() })),
        pending: z.array(z.unknown()),
      }),
    );
    expect(resumed.sessions).toEqual([{ id: "ses_mcp", state: "succeeded" }]);
    expect(resumed.pending).toEqual([]);
  } finally {
    await client?.close();
    mock.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

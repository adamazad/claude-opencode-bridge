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
        BRIDGE_OWNER: "",
      },
      (notice) => notifications.push(notice),
    );
    await callTool(
      client,
      "opencode_configure",
      { owner: "test-mcp-owner" },
      z.object({ configured: z.literal(true) }),
    );
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(
      "claude/channel",
    );
    expect((await client.listTools()).tools).toHaveLength(8);
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

test("background dispatch and inspect return before slow worker completion", async () => {
  const messages: Message[] = [];
  let finish: (() => void) | undefined;
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/api/info") return Response.json({ version: "2.0.32" });
      if (p === "/api/session")
        return Response.json({
          data: {
            id: "ses_background",
            location: { directory: process.cwd() },
          },
        });
      if (p.endsWith("/prompt")) {
        const body = await req.json();
        messages.push({ id: body.id, type: "user" });
        // A slow admission response still precedes the independent worker result.
        await Bun.sleep(300);
        finish = () =>
          messages.push(
            {
              id: "msg_answer",
              type: "assistant",
              content: [{ type: "text", text: "SLOW_WORK_DONE" }],
            },
            { id: "msg_terminal", type: "idle", outcome: "succeeded" },
          );
        return Response.json({ data: { id: body.id } });
      }
      if (p.endsWith("/permission") || p.endsWith("/form"))
        return Response.json({ data: [] });
      if (p.endsWith("/message"))
        return Response.json({
          data: [...messages].reverse(),
          cursor: { next: null },
        });
      if (p === "/api/event")
        return new Response("data: {}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      return new Response("missing", { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "bridge-background-"));
  const notices: ChannelNotice[] = [];
  const client = await openBridgeClient(
    {
      OPENCODE_URL: mock.url.origin,
      BRIDGE_DB: join(dir, "bridge.sqlite"),
      BRIDGE_OWNER: "background-test",
    },
    (n) => notices.push(n),
  );
  try {
    const start = performance.now();
    await callTool(
      client,
      "opencode_start",
      { directory: process.cwd(), prompt: "long job" },
      z.object({ state: z.literal("running") }),
    );
    const dispatchMs = performance.now() - start;
    expect(dispatchMs).toBeLessThan(1000);
    await Bun.sleep(2200);
    expect(notices).toHaveLength(0);
    const inspect = performance.now();
    const state = await callTool(
      client,
      "opencode_inspect",
      {},
      z.object({ sessions: z.array(z.object({ state: z.string() })) }),
    );
    const inspectMs = performance.now() - inspect;
    expect(inspectMs).toBeLessThan(500);
    expect(state.sessions[0]!.state).toBe("running");
    expect(finish).toBeDefined();
    finish!();
    const deadline = Date.now() + 5000;
    while (!notices.length && Date.now() < deadline) await Bun.sleep(25);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain("SLOW_WORK_DONE");
    console.log(
      `Background regression: dispatch ${dispatchMs.toFixed(1)}ms, inspect ${inspectMs.toFixed(1)}ms; completion held for >2200ms.`,
    );
  } finally {
    await client.close();
    mock.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);

test("normal launch connects without an owner and binds explicitly without changing ownership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-setup-"));
  const health = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ version: "2.0.32" }),
  });
  const env = {
    BRIDGE_OWNER: "",
    BRIDGE_DB: join(dir, "bridge.sqlite"),
    OPENCODE_URL: health.url.origin,
  };
  let client = await openBridgeClient(env, () => {});
  let second: Awaited<ReturnType<typeof openBridgeClient>> | undefined;
  try {
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "opencode_configure",
    );
    const setup = await callTool(
      client,
      "opencode_configure",
      {},
      z.object({ setup_required: z.literal(true) }),
    );
    expect(setup.setup_required).toBe(true);
    await expect(
      callTool(client, "opencode_inspect", {}, z.unknown()),
    ).rejects.toThrow("setup required");
    const owner = "claude-test-conversation-123";
    const configured = z.object({
      configured: z.literal(true),
      owner: z.string(),
    });
    expect(
      (await callTool(client, "opencode_configure", { owner }, configured))
        .owner,
    ).toBe(owner);
    expect(
      (await callTool(client, "opencode_configure", {}, configured)).owner,
    ).toBe(owner);
    await expect(
      callTool(
        client,
        "opencode_configure",
        { owner: "claude-other-conversation" },
        z.unknown(),
      ),
    ).rejects.toThrow("already bound");
    second = await openBridgeClient(env, () => {});
    await expect(
      callTool(second, "opencode_configure", { owner }, z.unknown()),
    ).rejects.toThrow("already in use");
    await second.close();
    second = undefined;
    await client.close();
    client = await openBridgeClient(env, () => {});
    expect(
      (await callTool(client, "opencode_configure", { owner }, configured))
        .owner,
    ).toBe(owner);
    const state = await callTool(
      client,
      "opencode_inspect",
      {},
      z.object({ owner: z.string(), sessions: z.array(z.unknown()) }),
    );
    expect(state.owner).toBe(owner);
    expect(state.sessions).toEqual([]);
  } finally {
    await second?.close();
    await client.close();
    health.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

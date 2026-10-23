// Opt-in live test: uses configured OpenCode credentials; creates one session, sends two harmless prompts.
import { z } from "zod";
import { openBridgeClient, callTool, type ChannelNotice } from "./lib/mcp";
const notices: ChannelNotice[] = [];
const client = await openBridgeClient(
  {
    BRIDGE_OWNER: `smoke-${crypto.randomUUID()}`,
    BRIDGE_DB:
      process.env.BRIDGE_DB ?? `${process.cwd()}/work/live-smoke.sqlite`,
  },
  (notice) => notices.push(notice),
  "inherit",
);
try {
  console.log(
    "channel capability",
    client.getServerCapabilities()?.experimental,
  );
  const result = await callTool(
    client,
    "opencode_start",
    {
      directory: process.cwd(),
      title: "Bridge MCP live round trip",
      model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
      prompt:
        "Reply with exactly BRIDGE_ROUND_TRIP_OK. Do not use tools or change files.",
    },
    z.object({ session_id: z.string() }).passthrough(),
  );
  console.log("started", result);
  for (let turn = 0; turn < 2; turn++) {
    const deadline = Date.now() + 120000;
    while (!notices.length && Date.now() < deadline) await Bun.sleep(250);
    if (!notices.length) throw Error("No channel result within 120 seconds");
    const n = notices.shift()!;
    console.log("channel result", JSON.stringify(n));
    await callTool(
      client,
      "opencode_ack",
      { notification_id: n.meta.notification_id },
      z.object({ acknowledged: z.literal(true) }),
    );
    if (n.meta.kind !== "succeeded")
      throw Error(`OpenCode returned ${n.meta.kind}`);
    if (turn === 0)
      console.log(
        "follow-up",
        await callTool(
          client,
          "opencode_send",
          {
            session_id: result.session_id,
            text: "Reply with exactly BRIDGE_FOLLOWUP_OK. Do not use tools or change files.",
          },
          z.unknown(),
        ),
      );
  }
  console.log(
    "PASS: real OpenCode task and same-session follow-up delivered through MCP channel; this client is not Claude.",
  );
} finally {
  await client.close();
}

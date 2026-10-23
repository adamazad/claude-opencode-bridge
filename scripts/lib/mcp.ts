// Shared by the live smoke test, subprocess test, and local benchmark.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";

const channelSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.object({
      notification_id: z.string(),
      session_id: z.string(),
      kind: z.string(),
      owner: z.string(),
    }),
  }),
});
export type ChannelNotice = z.infer<typeof channelSchema>["params"];

export async function openBridgeClient(
  env: Record<string, string>,
  onNotice: (notice: ChannelNotice) => void,
  stderr: "pipe" | "inherit" = "pipe",
) {
  const client = new Client({ name: "bridge-validation", version: "1.0.0" });
  client.setNotificationHandler(channelSchema, async ({ params }) => {
    onNotice(params);
  });
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../../src/server.ts", import.meta.url))],
        env: { ...inheritedEnv, ...env },
        stderr,
      }),
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

const textResultSchema = z
  .array(z.object({ type: z.literal("text"), text: z.string() }))
  .length(1);

export async function callTool<S extends z.ZodType>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  schema: S,
): Promise<z.infer<S>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  // The MCP SDK also admits extension responses; validate our JSON text contract.
  const [text] = textResultSchema.parse(result.content);
  return schema.parse(JSON.parse(text!.text));
}

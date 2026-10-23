import { z } from "zod";
import { isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { modelSchema } from "./api";
import type { Bridge } from "./bridge";

// Keep each tool's schema, advertised contract and typed handler together.
function tool<S extends z.ZodObject>(
  description: string,
  schema: S,
  run: (args: z.infer<S>) => unknown,
) {
  return {
    description,
    inputSchema: { ...z.toJSONSchema(schema), type: "object" as const },
    invoke: (input: unknown) => run(schema.parse(input)),
  };
}
const ownedSession = z.object({
  session_id: z.string().regex(/^ses[a-zA-Z0-9_-]+$/),
});

export function createTools(bridge: Bridge) {
  return {
    opencode_start: tool(
      "Create an OpenCode v2+ session and optionally assign a task. Returns immediately; terminal outcomes arrive through the channel.",
      z.object({
        directory: z.string(),
        title: z.string().optional(),
        prompt: z.string().min(1).optional(),
        model: modelSchema.optional(),
        agent: z.string().optional(),
      }),
      async ({ directory: path, title, prompt, model, agent }) => {
        if (!isAbsolute(path)) throw new Error("directory must be absolute");
        const directory = realpathSync(path);
        if (!statSync(directory).isDirectory())
          throw new Error("directory must exist");
        const session = await bridge.start(directory, title, model, agent);
        return prompt ? bridge.prompt(session.id, prompt) : session;
      },
    ),
    opencode_attach: tool(
      "Claim an existing OpenCode session for this Claude conversation. Existing history is inspectable; completion notifications track tasks sent by this bridge.",
      ownedSession,
      ({ session_id }) => bridge.attach(session_id),
    ),
    opencode_send: tool(
      "Send a task or follow-up to the same owned OpenCode session. One outstanding task per session.",
      ownedSession.extend({ text: z.string().min(1) }),
      ({ session_id, text }) => bridge.prompt(session_id, text),
    ),
    opencode_inspect: tool(
      "Read owned sessions, messages, pending approvals/forms and durable unacknowledged notifications. Works without channels.",
      ownedSession.partial(),
      ({ session_id }) => bridge.inspect(session_id),
    ),
    opencode_stop: tool(
      "Interrupt work in an owned session without deleting its history. Does not approve permissions.",
      ownedSession,
      ({ session_id }) => bridge.stop(session_id),
    ),
    opencode_ack: tool(
      "Acknowledge a channel notification after processing it. Use notification_id from channel metadata. Repeated ack is safe.",
      z.object({ notification_id: z.string() }),
      ({ notification_id }) => {
        bridge.store.ack(notification_id);
        return { acknowledged: true };
      },
    ),
  };
}

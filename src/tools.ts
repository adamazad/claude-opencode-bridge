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

export function createTools(
  getBridge: () => Bridge,
  configure: (owner?: string) => unknown,
) {
  return {
    opencode_configure: tool(
      "Inspect setup with no arguments. If setup_required, bind to this Claude conversation with owner=claude-<current Claude session ID>, or its explicitly saved BRIDGE_OWNER. Never invent a new owner on resume or change an existing binding.",
      z.object({
        owner: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{8,128}$/)
          .optional(),
      }),
      ({ owner }) => configure(owner),
    ),
    opencode_start: tool(
      "Create an OpenCode v2+ session and optionally assign a task. Returns after prompt admission, without waiting for model completion. Report dispatch and end your turn; terminal outcomes arrive through the channel.",
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
        const bridge = getBridge();
        const session = await bridge.start(directory, title, model, agent);
        return prompt ? bridge.prompt(session.id, prompt) : session;
      },
    ),
    opencode_attach: tool(
      "Claim an existing OpenCode session for this Claude conversation. Existing history is inspectable; completion notifications track tasks sent by this bridge.",
      ownedSession,
      ({ session_id }) => getBridge().attach(session_id),
    ),
    opencode_send: tool(
      "Send a task or follow-up to the same owned OpenCode session. One outstanding task per session. Report dispatch and end your turn; do not poll or wait for completion.",
      ownedSession.extend({ text: z.string().min(1) }),
      ({ session_id, text }) => getBridge().prompt(session_id, text),
    ),
    opencode_inspect: tool(
      "Read owned sessions, messages, pending approvals/forms and durable unacknowledged notifications. Works without channels.",
      ownedSession.partial(),
      ({ session_id }) => getBridge().inspect(session_id),
    ),
    opencode_stop: tool(
      "Interrupt work in an owned session without deleting its history. Does not approve permissions.",
      ownedSession,
      ({ session_id }) => getBridge().stop(session_id),
    ),
    opencode_ack: tool(
      "Acknowledge a channel notification after processing it. Use notification_id from channel metadata. Repeated ack is safe.",
      z.object({ notification_id: z.string() }),
      ({ notification_id }) => {
        getBridge().store.ack(notification_id);
        return { acknowledged: true };
      },
    ),
  };
}

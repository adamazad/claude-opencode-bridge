import { z } from "zod";
// Validate fields the bridge consumes, while retaining OpenCode's additional
// fields (tool states, errors, metadata) for inspection and notifications.
export const messageSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  text: z.string().optional(),
  content: z
    .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
    .optional(),
  outcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
  error: z.unknown().optional(),
  time: z
    .looseObject({
      created: z.number().optional(),
      completed: z.number().optional(),
    })
    .optional(),
});
export type Message = z.infer<typeof messageSchema>;

export const modelSchema = z.object({ providerID: z.string(), id: z.string() });
export type Model = z.infer<typeof modelSchema>;

const infoSchema = z.looseObject({ version: z.string() });
export const sessionResponseSchema = z.looseObject({
  data: z.looseObject({
    id: z.string().regex(/^ses/),
    location: z.looseObject({ directory: z.string() }),
  }),
});
const messagesResponseSchema = z.looseObject({
  data: z.array(messageSchema),
  cursor: z.looseObject({ next: z.string().nullable().optional() }),
});
const pendingResponseSchema = z.looseObject({
  data: z.array(z.looseObject({ id: z.string() })),
});
export const promptResponseSchema = z.looseObject({
  data: z.looseObject({ id: z.string() }),
});
export const interruptResponseSchema = z.looseObject({
  interrupted: z.boolean(),
});

export class API {
  readonly url: string;
  constructor(
    url: string,
    private password?: string,
    private username = "opencode",
  ) {
    const u = new URL(url);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
      u.protocol !== "http:" ||
      u.username ||
      u.password ||
      u.pathname !== "/"
    )
      throw new Error(
        "OpenCode URL must be a loopback HTTP origin without embedded credentials",
      );
    this.url = u.origin;
  }
  async fetch(path: string, init: RequestInit = {}) {
    return fetch(this.url + path, {
      ...init,
      redirect: "error",
      headers: {
        ...(this.password
          ? {
              Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`,
            }
          : {}),
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(15000),
    });
  }
  async request<S extends z.ZodType>(
    path: string,
    schema: S,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<z.infer<S>> {
    const r = await this.fetch(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok)
      throw new Error(
        `OpenCode ${method} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 1000)}`,
      );
    if (
      r.status !== 204 &&
      !r.headers.get("content-type")?.includes("application/json")
    )
      throw new Error(
        "Expected OpenCode v2 JSON API. This bridge requires OpenCode v2 or later; v1 /prompt_async is not supported.",
      );
    // Even an empty response must satisfy the caller's schema. A 204 cannot
    // silently pass for an endpoint that promises a session or prompt receipt.
    const value: unknown = r.status === 204 ? undefined : await r.json();
    const checked = schema.safeParse(value);
    if (!checked.success)
      throw new Error(
        `Incompatible OpenCode response for ${path.split("?")[0]}. Requires the v2 session/prompt/message/permission/form API schema. Check the server version and update this bridge. ${checked.error.message.slice(0, 500)}`,
      );
    return checked.data;
  }
  async health() {
    const info = await this.request("/api/info", infoSchema);
    if (!/^\d+\./.test(info.version) || Number(info.version.split(".")[0]) < 2)
      throw new Error(
        `Requires OpenCode v2 or later, received ${info.version}`,
      );
    return info;
  }
  async inputs(id: string) {
    const [permissions, forms] = await Promise.all(
      ["permission", "form"].map((kind) =>
        this.request(
          `/api/session/${encodeURIComponent(id)}/${kind}`,
          pendingResponseSchema,
        ),
      ),
    );
    return { permissions: permissions.data, forms: forms.data };
  }
  async messages(id: string, until?: string): Promise<Message[]> {
    const all: Message[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const q = new URLSearchParams({
        limit: "100",
        ...(cursor ? { cursor } : { order: "desc" }),
      });
      const r = await this.request(
        `/api/session/${encodeURIComponent(id)}/message?${q}`,
        messagesResponseSchema,
      );
      all.push(...r.data);
      if ((until && all.some((m) => m.id === until)) || !r.cursor.next)
        return all.reverse();
      cursor = r.cursor.next;
      if (seen.has(cursor))
        throw new Error("OpenCode repeated a pagination cursor");
      seen.add(cursor);
    }
    throw new Error(
      "Message history exceeds 10,000 entries; refusing incomplete reconciliation",
    );
  }
  async *events(signal: AbortSignal): AsyncGenerator<unknown> {
    const r = await this.fetch("/api/event", {
      signal,
      headers: { Accept: "text/event-stream" },
    });
    if (
      !r.ok ||
      !r.headers.get("content-type")?.includes("text/event-stream") ||
      !r.body
    )
      throw new Error(`OpenCode SSE unavailable (${r.status})`);
    let buffer = "";
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        if (buffer.length > 4_000_000) throw new Error("SSE frame too large");
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const data = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data) {
            try {
              yield JSON.parse(data);
            } catch {
              /* heartbeat/non-JSON */
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

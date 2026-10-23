import { afterEach, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import { API, sessionResponseSchema, type Message } from "../src/api";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
function mock(response: () => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: response });
  servers.push(server);
  return new API(server.url.origin);
}

test("request returns the schema's parsed output and inferred type", async () => {
  const api = mock(() => Response.json({ count: "42", unexpected: true }));
  const result = await api.request(
    "/api/example",
    z.object({ count: z.string().transform(Number) }),
  );
  expectTypeOf(result).toEqualTypeOf<{ count: number }>();
  expect(result).toEqual({ count: 42 });
});

test("message parsing retains v2 fields used by inspection and error reporting", async () => {
  // Shapes from the v2 OpenAPI User, Assistant, and Idle message schemas.
  const messages: Message[] = [
    {
      id: "msg_user",
      type: "user",
      text: "task",
      time: { created: 1 },
      files: [],
    },
    {
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "opencode", id: "test-model" },
      time: { created: 2, streamed: 3, completed: 4 },
      content: [
        { type: "reasoning", text: "reasoning" },
        {
          type: "tool",
          id: "tool_1",
          name: "read",
          state: { status: "completed", output: "file contents" },
          time: { created: 2 },
        },
        {
          type: "text",
          text: "final answer",
          native: { providerMetadata: true },
        },
      ],
      finish: "error",
      error: {
        type: "provider.invalid-request",
        message: "Unavailable",
        status: 410,
      },
    },
    {
      id: "msg_idle",
      type: "idle",
      outcome: "failed",
      time: { created: 5 },
      error: { message: "Unavailable" },
    },
  ];
  const api = mock(() =>
    Response.json({
      data: [...messages].reverse(),
      cursor: { next: null, previous: null },
    }),
  );
  const parsed = await api.messages("ses_test");
  expect(parsed).toEqual(messages);
  expectTypeOf(parsed[0]!.text).toEqualTypeOf<string | undefined>();
  expectTypeOf(parsed[0]!.outcome).toEqualTypeOf<
    "succeeded" | "failed" | "interrupted" | undefined
  >();
});

test("session parsing keeps title, status and location details for inspection", async () => {
  const response = {
    data: {
      id: "ses_test",
      title: "Task",
      outcome: "failed",
      location: { directory: "/tmp", futureDetail: "retained" },
      time: { created: 1, updated: 2 },
    },
  };
  const api = mock(() => Response.json(response));
  expect(
    await api.request("/api/session/ses_test", sessionResponseSchema),
  ).toEqual(response);
});

test.each([
  { id: "msg_bad", type: "assistant", content: [{ type: "text", text: 42 }] },
  { id: "msg_bad", type: "idle", outcome: "new-unknown-outcome" },
])(
  "invalid consumed message fields fail at the API boundary: %j",
  async (message) => {
    const api = mock(() =>
      Response.json({ data: [message], cursor: { next: null } }),
    );
    await expect(api.messages("ses_test")).rejects.toThrow(
      "Incompatible OpenCode response",
    );
  },
);

test("204 does not bypass the required response schema", async () => {
  const api = mock(() => new Response(null, { status: 204 }));
  await expect(
    api.request("/api/session", sessionResponseSchema, {}),
  ).rejects.toThrow("Incompatible OpenCode response");
  expect(await api.request("/api/optional", z.undefined())).toBeUndefined();
});

test("repeated pagination cursors fail instead of returning incomplete history", async () => {
  const api = mock(() =>
    Response.json({
      data: [{ id: "msg_old", type: "user" }],
      cursor: { next: "same-cursor" },
    }),
  );
  await expect(api.messages("ses_test", "msg_missing")).rejects.toThrow(
    "repeated a pagination cursor",
  );
});

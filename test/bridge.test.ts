import { describe, test, expect, afterEach } from "bun:test";
import { API } from "../src/api";
import { Store } from "../src/store";
import { Bridge } from "../src/bridge";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});
function setup() {
  const messages: unknown[] = [];
  const forms: unknown[] = [];
  const permissions: unknown[] = [];
  let fail = false;
  let submits = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const u = new URL(req.url),
        p = u.pathname;
      if (p === "/api/info") return Response.json({ version: "2.0.32" });
      if (p === "/api/session")
        return Response.json({
          data: { id: "ses_test", location: { directory: "/tmp" } },
        });
      if (p.endsWith("/prompt")) {
        submits++;
        if (fail) return new Response("unavailable", { status: 503 });
        const b = await req.json();
        messages.push({ type: "user", id: b.id, text: b.text });
        return Response.json({ data: { id: b.id } });
      }
      if (p.endsWith("/message"))
        return Response.json({
          data: [...messages].reverse(),
          cursor: { next: null },
        });
      if (p.endsWith("/permission"))
        return Response.json({ data: permissions });
      if (p.endsWith("/form")) return Response.json({ data: forms });
      if (p.endsWith("/interrupt")) return Response.json({ interrupted: true });
      return Response.json({
        data: { id: "ses_test", location: { directory: "/tmp" } },
      });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  const db = join(dir, "state.sqlite");
  const api = new API(server.url.origin);
  const store = new Store(db, "owner-one", api.url);
  const bridge = new Bridge(api, store);
  cleanups.push(() => {
    store.db.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    bridge,
    store,
    api,
    db,
    messages,
    forms,
    permissions,
    setFail: (v: boolean) => (fail = v),
    submits: () => submits,
  };
}
describe("routing and lifecycle", () => {
  test("round trip, ack, follow-up stays in session and old result is not reused", async () => {
    const f = setup();
    await f.bridge.start("/tmp");
    const r = await f.bridge.prompt("ses_test", "first");
    f.messages.push(
      {
        id: "msg_a",
        type: "assistant",
        content: [{ type: "text", text: "answer" }],
      },
      { id: "msg_i", type: "idle", outcome: "succeeded" },
    );
    await f.bridge.reconcile();
    await f.bridge.reconcile();
    expect(f.store.pending()).toHaveLength(1);
    expect(f.store.pending()[0]!.content).toContain("answer");
    const sent: string[] = [];
    await f.bridge.flush(async (n) => {
      sent.push(n.id);
    });
    await f.bridge.flush(async (n) => {
      sent.push(n.id);
    });
    expect(sent).toHaveLength(1);
    f.store.ack(sent[0]!);
    f.store.ack(sent[0]!);
    const next = await f.bridge.prompt("ses_test", "follow-up");
    expect(next.run_id).not.toBe(r.run_id);
    await f.bridge.reconcile();
    expect(f.store.get("ses_test").state).toBe("running");
    expect(f.store.pending()).toHaveLength(0);
  });
  test("bare idle and incomplete assistant do not succeed", async () => {
    const f = setup();
    await f.bridge.start("/tmp");
    await f.bridge.prompt("ses_test", "x");
    f.messages.push(
      { type: "idle", id: "msg_no_outcome" },
      {
        type: "assistant",
        id: "msg_partial",
        content: [{ type: "text", text: "partial" }],
      },
    );
    await f.bridge.reconcile();
    expect(f.store.pending()).toHaveLength(0);
    expect(f.store.get("ses_test").run).not.toBeNull();
  });
  test.each(["failed", "interrupted"])(
    "explicit %s is delivered",
    async (outcome) => {
      const f = setup();
      await f.bridge.start("/tmp");
      await f.bridge.prompt("ses_test", "x");
      f.messages.push({
        type: "idle",
        id: "msg_end",
        outcome,
        error: outcome === "failed" ? { message: "bad provider" } : undefined,
      });
      await f.bridge.reconcile();
      expect(f.store.pending()[0]!.kind).toBe(outcome);
    },
  );
  test("permission and forms deduplicate and are never approved", async () => {
    const f = setup();
    await f.bridge.start("/tmp");
    f.permissions.push({ id: "perm_1", action: "shell" });
    f.forms.push({ id: "form_1", title: "Choose" });
    await f.bridge.reconcile();
    await f.bridge.reconcile();
    expect(f.store.pending()).toHaveLength(2);
    expect(f.store.pending().every((n) => n.kind === "input_required")).toBe(
      true,
    );
    expect(f.submits()).toBe(0);
  });
  test("other owners cannot attach, read, acknowledge, or stop this session", async () => {
    const f = setup();
    await f.bridge.start("/tmp");
    const other = new Store(f.db, "owner-two", f.api.url);
    expect(() => other.claim("ses_test", "/tmp")).toThrow("another");
    expect(() => other.get("ses_test")).toThrow("not owned");
    expect(() => other.ack("fake")).toThrow();
    expect(other.pending()).toEqual([]);
    other.db.close();
  });
  test("external input is reported as interference, not success", async () => {
    const f = setup();
    await f.bridge.start("/tmp");
    await f.bridge.prompt("ses_test", "x");
    f.messages.push(
      { id: "msg_external", type: "user" },
      { id: "msg_end", type: "idle", outcome: "succeeded" },
    );
    await f.bridge.reconcile();
    expect(f.store.pending()[0]!.kind).toBe("interference");
  });
  test("uncertain submission is durable and never automatically retried", async () => {
    const f = setup();
    await f.bridge.start("/tmp");
    f.setFail(true);
    await expect(f.bridge.prompt("ses_test", "x")).rejects.toThrow();
    await f.bridge.reconcile();
    await expect(f.bridge.prompt("ses_test", "retry")).rejects.toThrow(
      "already active",
    );
    expect(f.submits()).toBe(1);
    expect(f.store.get("ses_test").state).toBe("submission_uncertain");
  });
  test("restart recovers terminal results missed during disconnect and pending delivery", async () => {
    const f = setup();
    await f.bridge.start("/tmp");
    await f.bridge.prompt("ses_test", "x");
    f.messages.push(
      {
        id: "msg_a",
        type: "assistant",
        content: [{ type: "text", text: "recovered" }],
      },
      { id: "msg_end", type: "idle", outcome: "succeeded" },
    );
    const store = new Store(f.db, "owner-one", f.api.url);
    const bridge = new Bridge(f.api, store);
    await bridge.reconcile();
    expect(store.pending()[0]!.content).toContain("recovered");
    await expect(
      bridge.flush(async () => {
        throw Error("transport down");
      }),
    ).rejects.toThrow();
    expect(store.pending()[0]!.sent).toBe(0);
    await bridge.flush(async () => {});
    await bridge.flush(async () => {}, 0);
    expect(store.pending()).toHaveLength(1);
    store.db.close();
  });
  test("second active process for same owner is refused", () => {
    const f = setup();
    f.store.lock();
    expect(() => f.store.lock()).toThrow("already in use");
    f.store.unlock();
  });
  test("concurrent task submissions serialize and reject overlap", async () => {
    const f = setup();
    await f.bridge.start("/tmp");
    const results = await Promise.allSettled([
      f.bridge.serial(() => f.bridge.prompt("ses_test", "a")),
      f.bridge.serial(() => f.bridge.prompt("ses_test", "b")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.submits()).toBe(1);
  });
});
test("remote endpoints and embedded credentials are rejected", () => {
  expect(() => new API("https://example.com")).toThrow();
  expect(() => new API("http://user:secret@localhost")).toThrow();
});
test("SSE parses fragmented CRLF frames and ignores comments", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const v of [
              ': ping\r\n\r\ndata: {"kind":',
              '"done"}\r',
              "\n\r\n",
            ])
              c.enqueue(new TextEncoder().encode(v));
            c.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  cleanups.push(() => server.stop(true));
  const events = [];
  for await (const e of new API(server.url.origin).events(
    new AbortController().signal,
  ))
    events.push(e);
  expect(events).toEqual([{ kind: "done" }]);
});
test.each(["1.19.0", "3.0.0"])(
  "version compatibility check %s",
  async (version) => {
    const s = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ version }),
    });
    cleanups.push(() => s.stop(true));
    const a = new API(s.url.origin);
    if (version.startsWith("1")) await expect(a.health()).rejects.toThrow("v2");
    else expect((await a.health()).version).toBe(version);
  },
);
test("future versions with changed response schema fail with an actionable error", async () => {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ items: [] }),
  });
  cleanups.push(() => s.stop(true));
  await expect(new API(s.url.origin).messages("ses_test")).rejects.toThrow(
    "Incompatible OpenCode response",
  );
});
test("history pagination finds the correlated prompt before extracting the final answer", async () => {
  let pages = 0;
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      pages++;
      return Response.json(
        new URL(req.url).searchParams.has("cursor")
          ? { data: [{ id: "msg_user", type: "user" }], cursor: { next: null } }
          : {
              data: [
                { id: "msg_idle", type: "idle", outcome: "succeeded" },
                { id: "msg_answer", type: "assistant" },
              ],
              cursor: { next: "page2" },
            },
      );
    },
  });
  cleanups.push(() => s.stop(true));
  const messages = await new API(s.url.origin).messages("ses_test", "msg_user");
  expect(messages.map((m) => m.id)).toEqual([
    "msg_user",
    "msg_answer",
    "msg_idle",
  ]);
  expect(pages).toBe(2);
});
test("stop requests interruption without falsely claiming task completion", async () => {
  const f = setup();
  await f.bridge.start("/tmp");
  await f.bridge.prompt("ses_test", "work");
  await f.bridge.stop("ses_test");
  expect(f.store.get("ses_test").state).toBe("stop_requested");
  expect(f.store.pending()).toHaveLength(0);
  f.messages.push({ id: "msg_abort", type: "idle", outcome: "interrupted" });
  await f.bridge.reconcile();
  expect(f.store.get("ses_test").state).toBe("interrupted");
  expect(f.store.pending()[0]!.kind).toBe("interrupted");
});
test("attach leaves historical terminal results unclaimed", async () => {
  const f = setup();
  f.messages.push({ id: "msg_old", type: "idle", outcome: "succeeded" });
  await f.bridge.attach("ses_test");
  await f.bridge.reconcile();
  expect(f.store.pending()).toHaveLength(0);
  const inspected = await f.bridge.inspect("ses_test");
  if (!("messages" in inspected)) throw new Error("Expected session details");
  expect(inspected.messages).toHaveLength(1);
});

test("state and notification roll back together if persistence fails", async () => {
  const f = setup();
  await f.bridge.start("/tmp");
  f.store.update("ses_test", "msg_running", "running");
  f.store.db.exec(
    "CREATE TRIGGER fail_notice BEFORE INSERT ON notices BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
  );
  expect(() =>
    f.store.update("ses_test", null, "succeeded", {
      id: "msg_running:terminal",
      content: "answer",
    }),
  ).toThrow("injected write failure");
  expect(f.store.get("ses_test").state).toBe("running");
  expect(f.store.get("ses_test").run).toBe("msg_running");
  expect(f.store.pending()).toEqual([]);
});

test("state writes and sent markers enforce owner and endpoint isolation", async () => {
  const f = setup();
  await f.bridge.start("/tmp");
  f.store.notice("test", "ses_test", "succeeded", "answer");
  const other = new Store(f.db, "owner-two", f.api.url);
  const otherEndpoint = new Store(f.db, "owner-one", "http://127.0.0.1:1");
  try {
    expect(() => other.update("ses_test", null, "succeeded")).toThrow(
      "not owned",
    );
    expect(() => otherEndpoint.update("ses_test", null, "succeeded")).toThrow(
      "not owned",
    );
    other.sent(f.store.pending()[0]!.id);
    otherEndpoint.sent(f.store.pending()[0]!.id);
    expect(f.store.pending()[0]!.sent).toBe(0);
    expect(f.store.get("ses_test").state).toBe("attached");
  } finally {
    other.db.close();
    otherEndpoint.db.close();
  }
});

test("assistant errors survive parsing and prevent a false success", async () => {
  const f = setup();
  await f.bridge.start("/tmp");
  await f.bridge.prompt("ses_test", "work");
  f.messages.push(
    {
      id: "msg_failed",
      type: "assistant",
      content: [],
      error: {
        type: "provider.invalid-request",
        message: "Provider rejected the request",
      },
    },
    { id: "msg_idle", type: "idle", outcome: "succeeded" },
  );
  await f.bridge.reconcile();
  expect(f.store.pending()[0]!.kind).toBe("failed");
  expect(f.store.pending()[0]!.content).toContain(
    "Provider rejected the request",
  );
});

test("status exposes actual reported model without confusing it with Claude or an unknown default", async () => {
  const f = setup();
  await f.bridge.start("/tmp");
  f.messages.push({
    id: "msg_report",
    type: "assistant",
    model: { providerID: "test-provider", id: "worker-model" },
    agent: "worker-agent",
    time: { created: 1234 },
    content: [],
  });
  const status = await f.bridge.status();
  expect(status.workers).toHaveLength(1);
  expect(status.workers[0]).toMatchObject({
    session_id: "ses_test",
    model: { providerID: "test-provider", id: "worker-model" },
    configured_model: null,
    agent: "worker-agent",
    last_activity: { type: "assistant", time: 1234 },
  });
});

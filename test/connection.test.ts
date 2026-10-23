import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAPI } from "../src/connection";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bridge-discovery-"));
  mkdirSync(join(root, "opencode"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const write = (value: unknown) =>
    writeFileSync(join(root, "opencode/service.json"), JSON.stringify(value));
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      calls++;
      if (
        req.headers.get("authorization") !==
        `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`
      )
        return Response.json(
          { error: "test-secret must never be surfaced" },
          { status: 401 },
        );
      return Response.json({ version: "2.0.32", pid: 123 });
    },
  });
  cleanup.push(() => server.stop(true));
  const registration = {
    url: server.url.origin,
    pid: 123,
    version: "2.0.32",
    password: "test-secret",
  };
  return {
    env: { XDG_STATE_HOME: root },
    write,
    registration,
    calls: () => calls,
  };
}
test("discovers and authenticates the registered service without exposing credentials", async () => {
  const f = fixture();
  f.write(f.registration);
  const api = await connectAPI(f.env);
  expect(api.url).toBe(f.registration.url);
  expect((await api.health()).version).toBe("2.0.32");
  expect(f.calls()).toBe(2);
});
test("missing and malformed registration have actionable errors", async () => {
  const f = fixture();
  await expect(connectAPI(f.env)).rejects.toThrow("opencode service start");
  f.write({ password: "test-secret" });
  await expect(connectAPI(f.env)).rejects.toThrow("No healthy registered");
  expect(f.calls()).toBe(0);
});
test("stale service identity and wrong credentials are refused", async () => {
  const f = fixture();
  f.write({ ...f.registration, pid: 999 });
  await expect(connectAPI(f.env)).rejects.toThrow("registration is stale");
  f.write({ ...f.registration, password: "wrong" });
  try {
    await connectAPI(f.env);
    throw Error("Expected rejection");
  } catch (e) {
    expect(String(e)).toContain("Cannot authenticate or reach");
    expect(String(e)).not.toContain("test-secret");
  }
});
test("unreachable stale service is not started or replaced", async () => {
  const f = fixture();
  f.write({ ...f.registration, url: "http://127.0.0.1:1" });
  await expect(connectAPI(f.env)).rejects.toThrow(
    "No server was started or changed",
  );
});
test("discovery rejects non-loopback destinations before any credential request", async () => {
  const f = fixture();
  f.write({ ...f.registration, url: "https://example.com" });
  await expect(connectAPI(f.env)).rejects.toThrow("loopback");
  expect(f.calls()).toBe(0);
});
test("explicit endpoint overrides discovery and never borrows its password", async () => {
  const f = fixture();
  f.write({ ...f.registration, url: "https://example.com" });
  const env = { ...f.env, OPENCODE_URL: f.registration.url };
  await expect(connectAPI(env)).rejects.toThrow("HTTP 401");
  const api = await connectAPI({
    ...env,
    OPENCODE_SERVER_PASSWORD: "test-secret",
  });
  expect(api.url).toBe(f.registration.url);
});
test("explicit password overrides a discovered credential", async () => {
  const f = fixture();
  f.write({ ...f.registration, password: "stale" });
  expect(
    (await connectAPI({ ...f.env, OPENCODE_SERVER_PASSWORD: "test-secret" }))
      .url,
  ).toBe(f.registration.url);
});

import { test, expect } from "bun:test";
import { Store } from "../src/store";
import { readWatch, watchCommand } from "../src/watch";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("watcher isolates owner, endpoint and run and never acknowledges results", () => {
  const store = new Store(":memory:", "watch-owner", "http://127.0.0.1:1");
  const target = {
    db: ":memory:",
    owner: store.owner,
    endpoint: store.endpoint,
    session: "ses_watch",
    run: "msg_first",
  };
  try {
    store.claim(target.session, "/tmp");
    store.update(target.session, target.run, "running");
    store.lock();
    expect(readWatch(store.db, target)).toEqual({
      state: "running",
      done: false,
    });
    expect(() =>
      readWatch(store.db, { ...target, owner: "other-owner" }),
    ).toThrow("not owned");
    expect(() =>
      readWatch(store.db, { ...target, endpoint: "http://127.0.0.1:2" }),
    ).toThrow("not owned");
    store.notice(
      "permission:one",
      target.session,
      "input_required",
      "answer in OpenCode",
    );
    expect(readWatch(store.db, target).state).toBe(
      "input required in OpenCode",
    );
    store.update(target.session, null, "succeeded", {
      id: `${target.run}:terminal`,
      content: "result",
    });
    store.update(target.session, "msg_second", "running");
    expect(readWatch(store.db, target)).toEqual({
      state: "succeeded",
      done: true,
    });
    expect(store.pending()).toHaveLength(2);
  } finally {
    store.db.close();
  }
});
test("background watcher exits for a completed run with safe quoted paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge watch '"));
  const path = join(dir, "state.sqlite");
  const store = new Store(path, "watch-owner", "http://127.0.0.1:1");
  const target = {
    db: path,
    owner: store.owner,
    endpoint: store.endpoint,
    session: "ses_watch",
    run: "msg_done",
  };
  try {
    store.claim(target.session, "/tmp");
    store.update(target.session, null, "succeeded", {
      id: `${target.run}:terminal`,
      content: "private result not printed by monitor",
    });
    const command = watchCommand(
      join(process.cwd(), "scripts/watch.ts"),
      target,
    );
    const child = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const output = await new Response(child.stdout).text();
    expect(output).toContain("succeeded");
    expect(output).not.toContain("private result");
    expect(store.pending()).toHaveLength(1);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Run through Claude's Bash tool with run_in_background:true, never shell '&'.
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { readWatch } from "../src/watch";
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: "string" },
    owner: { type: "string" },
    endpoint: { type: "string" },
    session: { type: "string" },
    run: { type: "string" },
  },
  strict: true,
});
const { db: path, owner, endpoint, session, run } = values;
if (!path || !owner || !endpoint || !session || !run)
  throw Error(
    "Missing watcher target; use the monitor command returned by the bridge.",
  );
const target = { db: path, owner, endpoint, session, run };
const db = new Database(path, { readonly: true });
const started = Date.now();
let previous = "";
try {
  while (Date.now() - started < 86400000) {
    const result = readWatch(db, target);
    if (result.state !== previous) {
      console.log(
        `OpenCode ${session}: ${result.state} (${Math.round((Date.now() - started) / 1000)}s monitored)`,
      );
      previous = result.state;
    }
    if (result.done) {
      console.log(
        "Monitoring finished. The channel carries the worker result; this watcher does not acknowledge or cancel work.",
      );
      process.exitCode = result.state === "succeeded" ? 0 : 1;
      break;
    }
    await Bun.sleep(1000);
  }
  if (Date.now() - started >= 86400000) {
    console.log(
      "Monitor expired after 24h; worker outcome unknown. Use /opencode-bridge:status.",
    );
    process.exitCode = 2;
  }
} finally {
  db.close();
}

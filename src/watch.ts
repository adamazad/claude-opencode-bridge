import { Database } from "bun:sqlite";
export type WatchTarget = {
  db: string;
  owner: string;
  endpoint: string;
  session: string;
  run: string;
};
export function readWatch(db: Database, target: WatchTarget) {
  const row = db
    .query<{ run: string | null; state: string }, [string, string, string]>(
      "SELECT run,state FROM sessions WHERE owner=? AND endpoint=? AND id=?",
    )
    .get(target.owner, target.endpoint, target.session);
  if (!row)
    throw new Error(
      "Worker is not owned by this conversation at this endpoint.",
    );
  const notice = db
    .query<{ kind: string }, [string, string, string, string, string]>(
      "SELECT kind FROM notices WHERE owner=? AND endpoint=? AND session=? AND id IN (?,?)",
    )
    .get(
      target.owner,
      target.endpoint,
      target.session,
      `${target.endpoint}:${target.session}:${target.run}:terminal`,
      `${target.endpoint}:${target.session}:${target.run}:interference`,
    );
  if (notice) return { state: notice.kind, done: true };
  if (row.run !== target.run)
    return { state: "run changed; outcome unknown", done: true };
  const lock = db
    .query<{ pid: number }, [string]>("SELECT pid FROM locks WHERE owner=?")
    .get(target.owner);
  let connected = false;
  if (lock) {
    try {
      process.kill(lock.pid, 0);
      connected = true;
    } catch {}
  }
  const input = db
    .query<{ id: string }, [string, string, string]>(
      "SELECT id FROM notices WHERE owner=? AND endpoint=? AND session=? AND kind='input_required' AND ack=0 LIMIT 1",
    )
    .get(target.owner, target.endpoint, target.session);
  return {
    state: connected
      ? input
        ? "input required in OpenCode"
        : row.state
      : "bridge disconnected; worker outcome unknown",
    done: false,
  };
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function watchCommand(script: string, target: WatchTarget) {
  return [
    "bun",
    script,
    ...Object.entries(target).flatMap(([key, value]) => [`--${key}`, value]),
  ]
    .map(quote)
    .join(" ");
}

import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
const UNOWNED_SESSION =
  "Session is not owned by this Claude bridge. Attach it explicitly first.";

export type Session = {
  id: string;
  owner: string;
  endpoint: string;
  directory: string;
  run: string | null;
  state: string;
};
export type Notice = {
  id: string;
  session: string;
  kind: string;
  content: string;
  sent: number;
  ack: number;
};
export class Store {
  db: Database;
  constructor(
    readonly path: string,
    readonly owner: string,
    readonly endpoint: string,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(endpoint TEXT,id TEXT,owner TEXT,directory TEXT,run TEXT,state TEXT,PRIMARY KEY(endpoint,id));
      CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,owner TEXT,endpoint TEXT,session TEXT,kind TEXT,content TEXT,sent INTEGER DEFAULT 0,ack INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS locks(owner TEXT PRIMARY KEY,pid INTEGER);`);
  }
  lock() {
    this.db.transaction(() => {
      const row = this.db
        .query<{ pid: number }, [string]>("SELECT pid FROM locks WHERE owner=?")
        .get(this.owner);
      if (row) {
        let alive = true;
        try {
          process.kill(row.pid, 0);
        } catch {
          alive = false;
        }
        if (alive)
          throw new Error(
            "This bridge owner is already in use. Use a different BRIDGE_OWNER for each Claude conversation.",
          );
      }
      this.db
        .query("INSERT OR REPLACE INTO locks VALUES (?,?)")
        .run(this.owner, process.pid);
    })();
  }
  unlock() {
    this.db
      .query("DELETE FROM locks WHERE owner=? AND pid=?")
      .run(this.owner, process.pid);
  }
  sessions(): Session[] {
    return this.db
      .query<Session, [string, string]>(
        "SELECT * FROM sessions WHERE owner=? AND endpoint=?",
      )
      .all(this.owner, this.endpoint);
  }
  get(id: string): Session {
    const s = this.db
      .query<Session, [string, string, string]>(
        "SELECT * FROM sessions WHERE owner=? AND endpoint=? AND id=?",
      )
      .get(this.owner, this.endpoint, id);
    if (!s) throw new Error(UNOWNED_SESSION);
    return s;
  }
  claim(id: string, directory: string) {
    this.db.transaction(() => {
      const row = this.db
        .query<{ owner: string }, [string, string]>(
          "SELECT owner FROM sessions WHERE endpoint=? AND id=?",
        )
        .get(this.endpoint, id);
      if (row && row.owner !== this.owner)
        throw new Error(
          "Session is owned by another Claude bridge; refusing cross-session routing.",
        );
      this.db
        .query(
          "INSERT OR IGNORE INTO sessions VALUES (?,?,?,?,NULL,'attached')",
        )
        .run(this.endpoint, id, this.owner, directory);
    })();
    return this.get(id);
  }
  update(
    id: string,
    run: string | null,
    state: string,
    notice?: { id: string; content: string },
  ) {
    // A state transition and its notification commit together or not at all.
    this.db.transaction(() => {
      const result = this.db
        .query(
          "UPDATE sessions SET run=?,state=? WHERE endpoint=? AND id=? AND owner=?",
        )
        .run(run, state, this.endpoint, id, this.owner);
      if (!result.changes) throw new Error(UNOWNED_SESSION);
      if (notice) this.notice(notice.id, id, state, notice.content);
    })();
  }
  notice(id: string, session: string, kind: string, content: string) {
    this.get(session);
    this.db
      .query(
        "INSERT OR IGNORE INTO notices(id,owner,endpoint,session,kind,content) VALUES (?,?,?,?,?,?)",
      )
      .run(
        `${this.endpoint}:${session}:${id}`,
        this.owner,
        this.endpoint,
        session,
        kind,
        content,
      );
  }
  pending(): Notice[] {
    return this.db
      .query<Notice, [string, string]>(
        "SELECT * FROM notices WHERE owner=? AND endpoint=? AND ack=0 ORDER BY rowid",
      )
      .all(this.owner, this.endpoint);
  }
  ack(id: string) {
    const r = this.db
      .query("UPDATE notices SET ack=1 WHERE id=? AND owner=? AND endpoint=?")
      .run(id, this.owner, this.endpoint);
    if (!r.changes) throw new Error("Unknown notification for this owner");
  }
  sent(id: string) {
    this.db
      .query("UPDATE notices SET sent=? WHERE id=? AND owner=? AND endpoint=?")
      .run(Date.now(), id, this.owner, this.endpoint);
  }
}

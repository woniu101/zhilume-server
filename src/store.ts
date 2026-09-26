import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export class Store {
  readonly db: DatabaseSync;
  private readonly lockPath: string;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.lockPath = join(root, "server.lock");
    try {
      writeFileSync(this.lockPath, String(process.pid), { flag: "wx" });
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(this.lockPath, "utf8"));
      let active = true;
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error(
          "Invalid data-directory lock; inspect server.lock before starting",
        );
      try {
        process.kill(pid, 0);
      } catch (e: any) {
        if (e.code === "ESRCH") active = false;
      }
      if (active)
        throw new Error(
          "This data directory is already in use by a Server process",
        );
      unlinkSync(this.lockPath);
      writeFileSync(this.lockPath, String(process.pid), { flag: "wx" });
    }
    this.db = new DatabaseSync(join(root, "zhilume.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      INSERT OR IGNORE INTO meta VALUES ('schema_version','1');`);
    if (
      this.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("schema_version")?.value !== "1"
    )
      throw new Error("Unsupported database version");
  }
  get<T = any>(kind: string, id: string): T | undefined {
    if (typeof id !== "string") return undefined;
    const row = this.db
      .prepare("SELECT value FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  all<T = any>(kind: string): T[] {
    return this.db
      .prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid DESC")
      .all(kind)
      .map((row) => JSON.parse(String(row.value)));
  }
  put(kind: string, value: any) {
    this.db
      .prepare(
        "INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(kind, value.id, JSON.stringify(value));
    return value;
  }
  remove(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
    if (readFileSync(this.lockPath, "utf8") === String(process.pid))
      unlinkSync(this.lockPath);
  }
}

// Test database: Node's built-in SQLite running the real migrations, wrapped to match the small
// `Db` interface in server/db.ts that Cloudflare's D1Database also satisfies.
// (Rebuilt after the original helper was accidentally overwritten; it exports the same names.)
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FAST_PBKDF2 = 1000; // production default is 100000; tests use a cheap value
export const PEPPER = "test-pepper-test-pepper-test-pepper-1234";
export const NOW = new Date("2026-10-14T10:00:00Z");

type Param = string | number | null;

class TestStmt {
  raw: DatabaseSync;
  sql: string;
  params: Param[] = [];
  constructor(raw: DatabaseSync, sql: string) {
    this.raw = raw;
    this.sql = sql;
  }
  bind(...values: unknown[]) {
    // Cloudflare D1 allows at most 100 bound parameters per query; node:sqlite allows far more, so enforce it here.
    if (values.length > 100) throw new Error(`D1 limit: ${values.length} bound parameters (max 100)`);
    // D1 takes ArrayBuffer for blobs; node:sqlite wants Uint8Array
    this.params = values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)) as Param[];
    return this;
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.params) as T[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const r = this.raw.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes) } };
  }
}

export function createTestDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  const dir = join(import.meta.dirname, "..", "..", "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(join(dir, f), "utf8"));
  }
  return {
    raw,
    prepare: (sql: string) => new TestStmt(raw, sql),
    // Like D1, a batch is atomic: either every statement succeeds or none do.
    async batch(stmts: TestStmt[]) {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

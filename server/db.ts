// Minimal database interface. Cloudflare's D1Database satisfies it at runtime; tests use a
// node:sqlite adapter (tests/helpers/d1.ts) running the real migrations.
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Db {
  prepare(sql: string): Stmt;
  batch(stmts: Stmt[]): Promise<unknown[]>;
}

export function isUniqueViolation(err: unknown, hint?: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed") && (!hint || msg.includes(hint));
}

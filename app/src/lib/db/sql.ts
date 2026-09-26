// ────────────────────────────────────────────────────────────────────────────
// SqlClient — the one interface every store operation codes against.
//
// Two implementations, one dialect (Postgres):
//   • PgLiteClient — embedded Postgres 17 (WASM) for local dev + tests
//   • PgClient     — node-postgres Pool for CI (postgres:16) and production
//
// Both speak $n placeholders, both surface PG error codes (23P01, 23505),
// so the invariant behaves identically everywhere. See BUILD_PLAN §2.3.
// ────────────────────────────────────────────────────────────────────────────

export interface Row {
  [column: string]: unknown;
}

export interface QueryResult<T> {
  rows: T[];
}

/** A transaction-scoped (or otherwise single-connection) executor. */
export interface Executor {
  query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface SqlClient extends Executor {
  /** Raw multi-statement execution (DDL / migrations). */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` inside a transaction. Commit on success; rollback + rethrow on
   * any thrown error (including ApiError). Nested exec() is not allowed.
   */
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  /** Human-readable engine name for /api/health. */
  engineName(): string;
  /** Release underlying resources (pools / wasm instances). */
  close(): Promise<void>;
}
